/**
 * Sandbox de demostración del AGENTE.
 * ---------------------------------------------------------------------------
 * Siembra, dentro de una operación real, un cliente de juguete con todo lo que
 * el agente necesita para tener trabajo que proponer y ejecutar: productos,
 * ubicaciones, stock, órdenes en TODOS los estados con deadlines variados
 * (vencidos, críticos, en riesgo, holgados y sin compromiso), tareas pendientes
 * de los siete tipos, operarios con carga desbalanceada y un lote por vencer.
 *
 * Es data de VITRINA, no de producción:
 *   - vive en un cliente nuevo por corrida (`demo-sandbox-N`), así no se mezcla
 *     nunca con los clientes reales ni pisa nada existente;
 *   - las ubicaciones llevan el número de la corrida en el código
 *     (`DEMO-2-A-01`), así dos ciclos no dejan códigos repetidos en la bodega;
 *   - todo va prefijado con DEMO- para reconocerlo de un vistazo;
 *   - el administrador de la operación elige cuántas órdenes, productos y
 *     ubicaciones quiere, y puede montar ciclos nuevos las veces que necesite.
 *
 * LA REGLA QUE MANDA: cualquiera sea el tamaño pedido, la semilla tiene que
 * dejar material para que el agente pueda ejecutar acciones de valor inmediato.
 * Por eso los escenarios se reparten por PRIORIDAD (primero los que le dan
 * trabajo al agente) y el resultado informa, escenario por escenario, si quedó
 * cubierto o no — en vez de sembrar algo bonito con lo que no se puede hacer nada.
 */
import { WmsFacade } from './wms.facade';
import { OrderType, UserRole, ZoneType } from '../domain/types';

export interface DemoSeedOptions {
  /** Cuántos SKUs crear (def. 5). */
  productos?: number;
  /** Cuántas ubicaciones crear, incluido el dock de recepción (def. 10). */
  ubicaciones?: number;
  /** Cuántas órdenes de salida generar (def. 20). */
  ordenes?: number;
}

export interface DemoSeedResult {
  sellerId: string;
  sellerName: string;
  productos: number;
  ubicaciones: number;
  ordenes: number;
  embalajes: number;
  solicitado: Required<DemoSeedOptions>;
  ajustes: string[];
  porEstado: Record<string, number>;
  deadlines: { vencidas: number; criticas: number; enRiesgo: number; holgadas: number; sinDeadline: number };
  tareasPendientes: Record<string, number>;
  operarios: string[];
  /** Qué puede hacer el agente con esta semilla, y qué no. */
  garantias: Array<{ escenario: string; cubierto: boolean; accionDelAgente: string; cantidad: number }>;
  avisos: string[];
}

// ---- Límites -----------------------------------------------------------------
// Los mínimos no son caprichos: con menos de 3 ubicaciones no hay dock + almacenaje
// + picking y no se puede armar un flujo; con menos de 2 productos no hay variedad
// para que las órdenes se vean como órdenes; con menos de 6 órdenes no alcanzan los
// escenarios que le dan trabajo al agente.
const LIMITES = {
  productos: { min: 2, max: 60, def: 5 },
  ubicaciones: { min: 3, max: 200, def: 10 },
  ordenes: { min: 6, max: 400, def: 20 },
};
/** Insumos de embalaje: siempre 5, como pidió el negocio. */
const EMBALAJES_FIJOS = 5;

function acotar(v: unknown, l: { min: number; max: number; def: number }, nombre: string, ajustes: string[]): number {
  if (v == null || v === '') return l.def;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) { ajustes.push(`${nombre}: "${v}" no es un número, se usó ${l.def}.`); return l.def; }
  if (n < l.min) { ajustes.push(`${nombre}: ${n} es muy poco para armar un escenario completo, se subió a ${l.min}.`); return l.min; }
  if (n > l.max) { ajustes.push(`${nombre}: ${n} supera el tope del sandbox, se bajó a ${l.max}.`); return l.max; }
  return n;
}

/** Catálogo base de productos demo. Si piden más, se generan derivados. */
const CATALOGO = [
  { sku: 'POL-BL', description: 'Polera algodón blanca M' },
  { sku: 'ZAP-42', description: 'Zapatilla urbana talla 42' },
  { sku: 'TAZ-CE', description: 'Taza cerámica 350 ml' },
  { sku: 'CRE-50', description: 'Crema facial 50 g (con vencimiento)' },
  { sku: 'AUD-BT', description: 'Audífonos bluetooth' },
  { sku: 'MOC-NE', description: 'Mochila 20 L negra' },
  { sku: 'BOT-75', description: 'Botella térmica 750 ml' },
  { sku: 'CAL-DE', description: 'Calcetines deportivos pack 3' },
  { sku: 'GOR-UN', description: 'Gorro urbano unisex' },
  { sku: 'CAR-US', description: 'Cargador USB-C 30 W' },
  { sku: 'LIB-A5', description: 'Libreta A5 tapa dura' },
  { sku: 'PER-30', description: 'Perfume 30 ml (con vencimiento)' },
];

const COURIERS = ['Chilexpress', 'Starken', 'Blue Express', 'Rapiboy'];

/**
 * Escenarios de orden, ordenados por VALOR PARA EL AGENTE. El reparto llena
 * primero uno de cada uno de arriba hacia abajo, y recién después reparte el
 * resto por peso. Así, con 6 órdenes o con 300, el agente siempre tiene qué hacer.
 */
type EscenarioId = 'vencida' | 'critica' | 'estancada' | 'packed_sin_despachar' | 'sin_stock'
  | 'sin_compromiso' | 'en_riesgo' | 'por_reponer' | 'holgada' | 'despachada';

const ESCENARIOS: Array<{
  id: EscenarioId; peso: number; accion: string;
  estado: string; due: number | null | 'rango'; rango?: [number, number]; viejaHoras?: number;
}> = [
  { id: 'vencida', peso: 3, accion: 'Priorizar y balancear: ya incumplió el compromiso', estado: 'ALLOCATED', due: 'rango', rango: [-6, -0.25] },
  { id: 'critica', peso: 3, accion: 'Empujar antes del corte del courier', estado: 'ALLOCATED', due: 'rango', rango: [0.25, 1.5] },
  { id: 'estancada', peso: 2, accion: 'Destrabar: lleva más de un día en el mismo estado', estado: 'RECEIVED', due: null, viejaHoras: 30 },
  { id: 'packed_sin_despachar', peso: 2, accion: 'Despachar: está empacada y el courier ya pasó', estado: 'PACKED', due: null, viejaHoras: 14 },
  { id: 'sin_stock', peso: 1, accion: 'Avisar quiebre y gestionar reposición', estado: 'SIN_STOCK', due: 'rango', rango: [4, 8] },
  { id: 'sin_compromiso', peso: 2, accion: 'Fijar el deadline que le falta', estado: 'RECEIVED', due: null },
  { id: 'en_riesgo', peso: 3, accion: 'Vigilar: entra en la ventana de riesgo', estado: 'ALLOCATED', due: 'rango', rango: [2, 4] },
  { id: 'por_reponer', peso: 1, accion: 'Reponer a ubicación de picking lo que quedó suelto', estado: 'CANCELADA_PICKEADA', due: null },
  { id: 'holgada', peso: 3, accion: 'No tocarla: tiene tiempo de sobra', estado: 'ALLOCATED', due: 'rango', rango: [20, 40] },
  { id: 'despachada', peso: 2, accion: 'Historial para métricas, precisión y facturación', estado: 'SHIPPED', due: null, viejaHoras: 40 },
];

/** Reparte `total` órdenes: una de cada escenario (por prioridad) y el resto por peso. */
function repartirEscenarios(total: number): EscenarioId[] {
  const out: EscenarioId[] = [];
  for (const e of ESCENARIOS) { if (out.length >= total) break; out.push(e.id); }
  const pesoTotal = ESCENARIOS.reduce((t, e) => t + e.peso, 0);
  let i = 0;
  while (out.length < total) {
    // Rueda por peso: cada escenario aparece proporcionalmente a su peso.
    const e = ESCENARIOS[i % ESCENARIOS.length];
    const cuantas = Math.max(1, Math.round((e.peso / pesoTotal) * 3));
    for (let k = 0; k < cuantas && out.length < total; k++) out.push(e.id);
    i++;
  }
  return out;
}

/**
 * Siembra el sandbox. `nowIso` es el reloj de la operación: todos los deadlines
 * se calculan relativos a él, así la demo siempre se ve "hoy".
 */
export async function seedAgentSandbox(
  facade: WmsFacade, operationId: string, actor: string, opts: DemoSeedOptions = {},
): Promise<DemoSeedResult> {
  const avisos: string[] = [];
  const ajustes: string[] = [];
  const nProductos = acotar(opts.productos, LIMITES.productos, 'Productos', ajustes);
  const nUbic = acotar(opts.ubicaciones, LIMITES.ubicaciones, 'Ubicaciones', ajustes);
  const nOrdenes = acotar(opts.ordenes, LIMITES.ordenes, 'Órdenes', ajustes);

  const nowIso = (facade as any).clockNow ? (facade as any).clockNow() : new Date().toISOString();
  const now = Date.parse(nowIso);
  const enHoras = (h: number) => new Date(now + h * 3600000).toISOString();

  // Un cliente nuevo por corrida: la demo nunca toca clientes reales y se puede
  // montar un ciclo nuevo cuantas veces haga falta.
  const existentes = await facade.listSellers(operationId).catch(() => [] as Array<{ id: string }>);
  const n = existentes.filter((s) => s.id.startsWith('demo-sandbox')).length + 1;
  const sellerId = `demo-sandbox-${n}`;
  const sellerName = `Demo sandbox ${n} (agente)`;
  // slaHoras: los couriers sin corte configurado caen a esta promesa de 6 h.
  await facade.createSeller({ id: sellerId, operationId, name: sellerName, slaHoras: 6, courierPriority: ['Chilexpress'] });

  // Cortes de courier: dan deadlines realistas a las órdenes que entren después.
  const cfgActual = await facade.getDeadlineConfig(operationId).catch(() => ({} as any));
  if (!cfgActual.cortes || !cfgActual.cortes.length) {
    await facade.setDeadlineConfig(operationId, {
      offsetHoras: cfgActual.offsetHoras ?? -3,
      riesgoHoras: cfgActual.riesgoHoras ?? 4,
      cortes: [
        { courier: 'Chilexpress', hora: '14:00', dias: [1, 2, 3, 4, 5] },
        { courier: 'Starken', hora: '17:00', dias: [1, 2, 3, 4, 5] },
        { courier: 'Blue Express', hora: '12:30', dias: [1, 2, 3, 4, 5] },
      ],
    });
    avisos.push('Se configuraron horas de corte de courier (no había ninguna).');
  }

  // ---- Ubicaciones ----------------------------------------------------------
  // Siempre 1 dock de recepción. Del resto: ~1 de cada 4 es picking (donde se
  // reserva y se pickea rápido) y el resto almacenaje. Con 5 o más entra una de
  // cuarentena; con 6 o más, una de devoluciones.
  const dockCode = `DEMO-${n}-RECV`;
  const plantillaUbic: Array<{ code: string; zoneType: ZoneType; capacity: number; pickRank: number }> = [
    { code: dockCode, zoneType: ZoneType.RECEIVING, capacity: 0, pickRank: 99 },
  ];
  let extras = 0;
  if (nUbic >= 5) { plantillaUbic.push({ code: `DEMO-${n}-QA-01`, zoneType: ZoneType.QUARANTINE, capacity: 100, pickRank: 90 }); extras++; }
  if (nUbic >= 6) { plantillaUbic.push({ code: `DEMO-${n}-DEV-01`, zoneType: ZoneType.RECEIVING, capacity: 100, pickRank: 95 }); extras++; }
  const operativas = nUbic - 1 - extras;
  const nPicking = Math.max(1, Math.round(operativas / 4));
  const nStorage = Math.max(1, operativas - nPicking);
  const picking: string[] = [];
  const storage: string[] = [];
  for (let i = 0; i < nPicking; i++) {
    const code = `DEMO-${n}-P-${String(i + 1).padStart(2, '0')}`;
    plantillaUbic.push({ code, zoneType: ZoneType.PICKING, capacity: 150, pickRank: i + 1 });
    picking.push(code);
  }
  for (let i = 0; i < nStorage; i++) {
    const letra = String.fromCharCode(65 + Math.floor(i / 9)); // A, B, C…
    const code = `DEMO-${n}-${letra}-${String((i % 9) + 1).padStart(2, '0')}`;
    plantillaUbic.push({ code, zoneType: ZoneType.STORAGE, capacity: 400, pickRank: 10 + i });
    storage.push(code);
  }
  const locs: Record<string, string> = {};
  for (const u of plantillaUbic) {
    const l = await facade.createLocation({ operationId, code: u.code, zoneType: u.zoneType, capacity: u.capacity, pickRank: u.pickRank });
    locs[u.code] = l.id;
  }
  const reservables = [...picking, ...storage]; // solo picking y almacenaje son reservables

  // ---- Productos ------------------------------------------------------------
  const productos: Array<{ sku: string; description: string; barcode: string }> = [];
  for (let i = 0; i < nProductos; i++) {
    const base = CATALOGO[i % CATALOGO.length];
    const vuelta = Math.floor(i / CATALOGO.length);
    productos.push({
      sku: `DEMO-${base.sku}${vuelta ? '-' + (vuelta + 1) : ''}`,
      description: base.description + (vuelta ? ` (v${vuelta + 1})` : ''),
      barcode: `78010000${String(10000 + i).slice(-5)}`,
    });
  }
  for (const p of productos) await facade.createSku(sellerId, p as any, actor);
  // El último producto es el ESCASO a propósito: es el que provoca el quiebre.
  const skuEscaso = productos[productos.length - 1].sku;
  const skuConVencimiento = productos[Math.min(3, productos.length - 1)].sku;

  // ---- Stock ----------------------------------------------------------------
  // Lo que se guarda en almacenaje/picking es reservable; lo que queda en el dock
  // NO lo es: eso genera las tareas de GUARDADO y explica los faltantes.
  for (let i = 0; i < productos.length; i++) {
    const sku = productos[i].sku;
    if (sku === skuEscaso) continue; // el escaso se siembra aparte, casi sin stock
    const destino = reservables[i % reservables.length];
    const qty = 180 + (i % 5) * 40;
    await facade.receive(sellerId, { sku, qty, locationId: locs[dockCode], reference: 'DEMO-INICIAL', actor });
    await facade.putaway(sellerId, { sku, qty, fromLocationId: locs[dockCode], toLocationId: locs[destino], reference: 'DEMO-INICIAL', actor });
  }
  // El escaso: 3 unidades. Alcanza para existir en el catálogo y no para las órdenes grandes.
  await facade.receive(sellerId, { sku: skuEscaso, qty: 3, locationId: locs[dockCode], reference: 'DEMO-ESCASO', actor });
  await facade.putaway(sellerId, { sku: skuEscaso, qty: 3, fromLocationId: locs[dockCode], toLocationId: locs[reservables[0]], reference: 'DEMO-ESCASO', actor });

  // Regla lote_por_vencer: un lote que vence en 5 días.
  await facade.receive(sellerId, { sku: skuConVencimiento, qty: 60, locationId: locs[dockCode], lot: `L-DEMO-${n}-VENCE`, expiry: new Date(now + 5 * 86400000).toISOString(), reference: 'DEMO-LOTE', actor });
  await facade.putaway(sellerId, { sku: skuConVencimiento, qty: 60, fromLocationId: locs[dockCode], toLocationId: locs[storage[0] || reservables[0]], lot: `L-DEMO-${n}-VENCE`, reference: 'DEMO-LOTE', actor } as any);

  // Tareas de GUARDADO pendientes: stock que se quedó en el dock (siempre al menos dos).
  for (let i = 0; i < Math.min(2, productos.length); i++) {
    await facade.receive(sellerId, { sku: productos[i].sku, qty: 24 + i * 12, locationId: locs[dockCode], reference: 'DEMO-POR-GUARDAR', actor });
  }

  // ---- Insumos de embalaje (siempre 5) ---------------------------------------
  // Con stock MÍNIMO configurado: dos bajo el mínimo (el agente tiene que avisar),
  // uno al límite y dos holgados.
  const EMBALAJE = [
    { sku: `DEMO-${n}-CAJA-G`, name: 'Caja grande 40×30×20 (demo)', unitPrice: 900, minStock: 150, stock: 85 },
    { sku: `DEMO-${n}-CINTA`, name: 'Cinta de embalaje, rollo (demo)', unitPrice: 1200, minStock: 20, stock: 9 },
    { sku: `DEMO-${n}-PRECINTO`, name: 'Precinto de seguridad (demo)', unitPrice: 120, minStock: 300, stock: 315 },
    { sku: `DEMO-${n}-BOLSA-2`, name: 'Bolsa courier N°2 (demo)', unitPrice: 240, minStock: 400, stock: 620 },
    { sku: `DEMO-${n}-BURBUJA`, name: 'Papel burbuja, rollo (demo)', unitPrice: 3500, minStock: 8, stock: 14 },
  ];
  for (const e of EMBALAJE) {
    try {
      await facade.createPackaging(operationId, { sku: e.sku, name: e.name, unitPrice: e.unitPrice, minStock: e.minStock });
      await facade.receivePackagingStock(operationId, e.sku, e.stock, actor, 'DEMO-INICIAL', Math.round(e.unitPrice * 0.6));
    } catch (err: any) { avisos.push(`insumo ${e.sku}: ${err?.message || 'no se pudo crear'}`); }
  }

  // ---- Operarios -------------------------------------------------------------
  // Tres perfiles a propósito: uno cargado, uno ocioso (operario_ocioso) y uno
  // que nunca se conecta pero tiene tareas abiertas (operario_inactivo).
  const operarios = [`demo-op-a-${n}`, `demo-op-b-${n}`, `demo-op-c-${n}`];
  const nombres = [`Demo Ana ${n} (cargada)`, `Demo Beto ${n} (ocioso)`, `Demo Caro ${n} (inactiva)`];
  for (let i = 0; i < operarios.length; i++) {
    await facade.createUser({ id: operarios[i], name: nombres[i], email: `${operarios[i]}@demo.local`, role: UserRole.OPERATOR, operationId, password: 'demo1234' } as any).catch(() => { /* ya existe */ });
  }

  // ---- Órdenes ---------------------------------------------------------------
  const reparto = repartirEscenarios(nOrdenes);
  const porEscenario: Record<string, number> = {};
  const porEstado: Record<string, number> = {};
  const creadas: Array<{ id: string; ref: string; estado: string; escenario: EscenarioId }> = [];
  const cubierto = new Set<EscenarioId>();
  // Contador de empaques verificados. La diferencia NO puede depender del índice
  // general de la orden: si no, según el tamaño pedido podía no tocarle a ninguna
  // orden empacada y la precisión salía siempre 100 %, que no enseña nada.
  let empacadas = 0;

  for (let idx = 0; idx < reparto.length; idx++) {
    const id = reparto[idx];
    const def = ESCENARIOS.find((e) => e.id === id)!;
    const ref = `DEMO-${n}-${String(idx + 1).padStart(3, '0')}`;
    const courier = COURIERS[idx % COURIERS.length];
    // Dentro del rango del escenario, repartido para que no salgan todas iguales.
    const due = def.due === 'rango'
      ? def.rango![0] + ((idx * 0.37) % 1) * (def.rango![1] - def.rango![0])
      : null;
    // Líneas: el escenario de quiebre pide MUCHO del producto escaso; el resto,
    // cantidades normales de productos con stock.
    // El SKU escaso se reserva EXCLUSIVAMENTE para el escenario de quiebre: si se
    // colara en una orden normal, esa orden fallaría al reservar por una razón
    // que no es la del guion y el resumen se llenaría de avisos confusos.
    const conStock = productos.filter((pr) => pr.sku !== skuEscaso);
    const surtido = conStock.length ? conStock : productos;
    const lineas: Array<[string, number]> = def.id === 'sin_stock'
      ? [[skuEscaso, 500]]
      : [[surtido[idx % surtido.length].sku, 1 + (idx % 4)]];
    if (def.id !== 'sin_stock' && surtido.length > 1 && idx % 3 === 0) {
      lineas.push([surtido[(idx + 1) % surtido.length].sku, 1 + (idx % 3)]);
    }

    const o = await facade.createOrder(sellerId, {
      externalOrderId: ref,
      salesChannel: 'demo',
      orderType: idx % 7 === 0 ? OrderType.B2B : OrderType.B2C,
      carrier: courier,
      priority: due != null && due < 0 ? 'alta' : 'normal',
      dueAt: due == null ? null : enHoras(due),
      dueSource: due == null ? null : 'oms',
      shipTo: { name: `Cliente demo ${ref}` },
      lines: lineas.map(([sku, qty]) => ({ sku, qty })),
    }, actor);

    let estadoFinal = 'RECEIVED';
    try {
      const objetivo = def.estado;
      if (objetivo !== 'RECEIVED' && objetivo !== 'SIN_STOCK') {
        await facade.allocateOrder(sellerId, o.id, actor);
        estadoFinal = 'ALLOCATED';
      }
      if (objetivo === 'SIN_STOCK') {
        // Se intenta reservar a propósito: falla por falta de stock y queda el faltante.
        await facade.allocateOrder(sellerId, o.id, actor);
        estadoFinal = 'ALLOCATED';
      }
      if (objetivo === 'PACKED' || objetivo === 'SHIPPED' || objetivo === 'CANCELADA_PICKEADA') {
        await facade.confirmPick(sellerId, o.id, actor); estadoFinal = 'PICKED';
      }
      if (objetivo === 'PACKED' || objetivo === 'SHIPPED') {
        // Se empaca consumiendo embalaje y VERIFICANDO la salida: de esa verificación
        // sale la precisión de preparación del panel. Una de cada cinco sale con
        // diferencia a propósito, para que la métrica no sea siempre 100 %.
        empacadas++;
        // La primera sale limpia y desde la segunda una de cada tres lleva
        // diferencia: así la precisión nunca es 100 % ni 0 %.
        const conDiferencia = empacadas >= 2 && empacadas % 3 === 2;
        const verify = lineas.map(([sku, qty]) => ({ sku, qty: conDiferencia ? Math.max(0, qty - 1) : qty }));
        await facade.packOrder(sellerId, o.id, {
          bultos: 1,
          materials: [{ sku: EMBALAJE[0].sku, qty: 1 }, { sku: EMBALAJE[1].sku, qty: 1 }],
          verify,
        } as any, actor);
        estadoFinal = 'PACKED';
      }
      if (objetivo === 'SHIPPED') {
        await facade.shipOrder(sellerId, o.id, { carrier: courier, trackingNumber: `DEMO-TRK-${ref}` } as any, actor);
        estadoFinal = 'SHIPPED';
      }
      if (objetivo === 'CANCELADA_PICKEADA') {
        await facade.cancelOrder(sellerId, o.id, actor); estadoFinal = 'CANCELLED';
      }
    } catch (e: any) {
      // Que una orden no alcance a reservarse es parte del guion (el quiebre).
      if (def.id !== 'sin_stock') avisos.push(`${ref}: quedó en ${estadoFinal} — ${(e && e.message) || 'no se pudo avanzar'}`);
    }
    // Las órdenes "sin compromiso" del guion: la operación les asigna deadline por
    // corte o por SLA al ingresar, así que hay que quitárselo a propósito.
    if (due == null && def.id !== 'despachada') await facade.setOrderDueAt(sellerId, o.id, null, null, actor).catch(() => {});
    if (def.viejaHoras) await facade.backdateOrderForDemo(sellerId, o.id, def.viejaHoras).catch(() => {});

    porEstado[estadoFinal] = (porEstado[estadoFinal] || 0) + 1;
    porEscenario[id] = (porEscenario[id] || 0) + 1;
    cubierto.add(id);
    creadas.push({ id: o.id, ref, estado: estadoFinal, escenario: id });
  }

  // ---- Recepción abierta (tarea RECEIVE) --------------------------------------
  await facade.createReceipt(sellerId, {
    externalRef: `DEMO-${n}-ASN-01`, supplier: 'Proveedor Demo',
    lines: productos.slice(0, Math.min(2, productos.length)).map((p, i) => ({ sku: p.sku, qty: 120 - i * 60 })),
  } as any, actor).catch((e: any) => avisos.push(`recepción demo: ${e?.message || 'no se pudo crear'}`));

  // ---- Asignaciones desbalanceadas a propósito -------------------------------
  // Ana se lleva varias tareas; Beto queda ocioso; Caro (inactiva) queda con una
  // tarea abierta. Así el agente tiene algo real que balancear, reasignar y liberar.
  const asignables = creadas.filter((c) => c.estado === 'ALLOCATED');
  const aAna = Math.min(3, Math.max(1, asignables.length - 1));
  for (let i = 0; i < Math.min(aAna + 1, asignables.length); i++) {
    const destino = i < aAna ? operarios[0] : operarios[2];
    await facade.assignTask(operationId, {
      type: 'PICK', entityId: asignables[i].id, entityRef: asignables[i].ref, sellerId,
      operator: destino, unitsEstimate: 4, by: actor, skipOperatorCheck: true, note: 'sandbox de demostración',
    }).catch((e: any) => avisos.push(`asignación ${asignables[i].ref}: ${e?.message || 'no se pudo'}`));
  }

  // La tercera operaria queda DESACTIVADA con una tarea abierta: ese es el escenario
  // de la regla operario_inactivo y de la acción liberar_inactivos del agente.
  await facade.deactivateUser(operarios[2]).catch(() => { avisos.push('no se pudo desactivar a la operaria inactiva'); });

  // ---- Resumen y garantías ----------------------------------------------------
  const pend: Record<string, number> = {};
  for (const tipo of ['PICK', 'PACK', 'SHIP', 'RECEIVE', 'PUTAWAY', 'RESTOCK', 'COUNT', 'RESLOT']) {
    pend[tipo] = (await facade.getTaskPool(operationId, tipo as any, { onlyUnassigned: true }).catch(() => [])).length;
  }
  const due = await facade.getOrdersDueSoon(operationId, { sellerId, withinHours: 999 }).catch(() => ({ items: [] as any[] }));
  const nivel = (l: string) => due.items.filter((i: any) => i.nivel === l).length;

  const garantias = ESCENARIOS.map((e) => ({
    escenario: e.id,
    cubierto: cubierto.has(e.id),
    accionDelAgente: e.accion,
    cantidad: porEscenario[e.id] || 0,
  }));
  const sinCubrir = garantias.filter((g) => !g.cubierto);
  if (sinCubrir.length) {
    avisos.push(`Con ${nOrdenes} órdenes no alcanzó para: ${sinCubrir.map((g) => g.escenario).join(', ')}. Con ${ESCENARIOS.length} o más quedan todos cubiertos.`);
  }

  return {
    sellerId, sellerName,
    productos: productos.length,
    ubicaciones: plantillaUbic.length,
    ordenes: creadas.length,
    embalajes: EMBALAJES_FIJOS,
    solicitado: { productos: nProductos, ubicaciones: nUbic, ordenes: nOrdenes },
    ajustes,
    porEstado,
    deadlines: {
      vencidas: nivel('vencido'), criticas: nivel('critico'), enRiesgo: nivel('riesgo'), holgadas: nivel('ok'),
      // Solo entre las ABIERTAS: contar las despachadas y canceladas como "sin
      // compromiso" inflaba el número y no significaba nada.
      sinDeadline: creadas.filter((c) => c.estado !== 'SHIPPED' && c.estado !== 'CANCELLED').length - due.items.length,
    },
    tareasPendientes: pend,
    operarios: nombres,
    garantias,
    avisos,
  };
}
