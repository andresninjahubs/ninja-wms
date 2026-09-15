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
 *   - todo va prefijado con DEMO- para reconocerlo de un vistazo;
 *   - el administrador de la operación la crea cuando quiere mostrar el agente.
 *
 * Cada bloque de abajo existe para activar algo concreto del agente; el comentario
 * dice qué. Si mañana se agrega una acción nueva al agente, acá va su escenario.
 */
import { WmsFacade } from './wms.facade';
import { OrderType, UserRole, ZoneType } from '../domain/types';

export interface DemoSeedResult {
  sellerId: string;
  sellerName: string;
  productos: number;
  ubicaciones: number;
  ordenes: number;
  porEstado: Record<string, number>;
  deadlines: { vencidas: number; criticas: number; enRiesgo: number; holgadas: number; sinDeadline: number };
  tareasPendientes: Record<string, number>;
  operarios: string[];
  avisos: string[];
}

/** Productos del sandbox: 5 SKUs con código de barras y rotación distinta. */
const PRODUCTOS = [
  { sku: 'DEMO-POL-BL', description: 'Polera algodón blanca M', barcode: '7801000000015' },
  { sku: 'DEMO-ZAP-42', description: 'Zapatilla urbana talla 42', barcode: '7801000000022' },
  { sku: 'DEMO-TAZ-CE', description: 'Taza cerámica 350 ml', barcode: '7801000000039' },
  { sku: 'DEMO-CRE-50', description: 'Crema facial 50 g (con vencimiento)', barcode: '7801000000046' },
  { sku: 'DEMO-AUD-BT', description: 'Audífonos bluetooth', barcode: '7801000000053' },
];

/** 10 ubicaciones: 1 recepción, 5 almacenaje, 2 picking, 1 cuarentena, 1 devoluciones. */
const UBICACIONES: Array<{ code: string; zoneType: ZoneType; capacity: number; pickRank: number }> = [
  { code: 'DEMO-RECV', zoneType: ZoneType.RECEIVING, capacity: 0, pickRank: 99 },
  { code: 'DEMO-A-01', zoneType: ZoneType.STORAGE, capacity: 400, pickRank: 10 },
  { code: 'DEMO-A-02', zoneType: ZoneType.STORAGE, capacity: 400, pickRank: 11 },
  { code: 'DEMO-A-03', zoneType: ZoneType.STORAGE, capacity: 400, pickRank: 12 },
  { code: 'DEMO-B-01', zoneType: ZoneType.STORAGE, capacity: 300, pickRank: 20 },
  { code: 'DEMO-B-02', zoneType: ZoneType.STORAGE, capacity: 300, pickRank: 21 },
  { code: 'DEMO-P-01', zoneType: ZoneType.PICKING, capacity: 120, pickRank: 1 },
  { code: 'DEMO-P-02', zoneType: ZoneType.PICKING, capacity: 120, pickRank: 2 },
  { code: 'DEMO-QA-01', zoneType: ZoneType.QUARANTINE, capacity: 100, pickRank: 90 },
  { code: 'DEMO-DEV-01', zoneType: ZoneType.RECEIVING, capacity: 100, pickRank: 95 },
];

/**
 * Siembra el sandbox. `nowIso` es el reloj de la operación: todos los deadlines
 * se calculan relativos a él, así la demo siempre se ve "hoy".
 */
export async function seedAgentSandbox(facade: WmsFacade, operationId: string, actor: string): Promise<DemoSeedResult> {
  const avisos: string[] = [];
  const nowIso = (facade as any).clockNow ? (facade as any).clockNow() : new Date().toISOString();
  const now = Date.parse(nowIso);
  const enHoras = (h: number) => new Date(now + h * 3600000).toISOString();

  // Un cliente nuevo por corrida: la demo nunca toca clientes reales.
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

  // ---- Ubicaciones y productos ---------------------------------------------
  const locs: Record<string, string> = {};
  for (const u of UBICACIONES) {
    const l = await facade.createLocation({ operationId, code: u.code, zoneType: u.zoneType, capacity: u.capacity, pickRank: u.pickRank });
    locs[u.code] = l.id;
  }
  for (const p of PRODUCTOS) await facade.createSku(sellerId, p as any, actor);

  // ---- Stock ----------------------------------------------------------------
  // Lo que se guarda en almacenaje/picking es reservable; lo que queda en el dock
  // de recepción NO lo es: eso genera las tareas de GUARDADO y explica faltantes.
  const guardado: Array<[string, number, string]> = [
    ['DEMO-POL-BL', 260, 'DEMO-A-01'],
    ['DEMO-ZAP-42', 90, 'DEMO-A-02'],
    ['DEMO-TAZ-CE', 150, 'DEMO-P-01'],
    ['DEMO-AUD-BT', 40, 'DEMO-B-01'],
  ];
  for (const [sku, qty, code] of guardado) {
    await facade.receive(sellerId, { sku, qty, locationId: locs['DEMO-RECV'], reference: 'DEMO-INICIAL', actor });
    await facade.putaway(sellerId, { sku, qty, fromLocationId: locs['DEMO-RECV'], toLocationId: locs[code], reference: 'DEMO-INICIAL', actor });
  }
  // Regla lote_por_vencer: un lote de crema que vence en 5 días.
  await facade.receive(sellerId, { sku: 'DEMO-CRE-50', qty: 60, locationId: locs['DEMO-RECV'], lot: 'L-DEMO-VENCE', expiry: new Date(now + 5 * 86400000).toISOString(), reference: 'DEMO-LOTE', actor });
  await facade.putaway(sellerId, { sku: 'DEMO-CRE-50', qty: 60, fromLocationId: locs['DEMO-RECV'], toLocationId: locs['DEMO-A-03'], lot: 'L-DEMO-VENCE', reference: 'DEMO-LOTE', actor } as any);
  // Tareas de GUARDADO pendientes: stock que se quedó en el dock.
  await facade.receive(sellerId, { sku: 'DEMO-POL-BL', qty: 48, locationId: locs['DEMO-RECV'], reference: 'DEMO-POR-GUARDAR', actor });
  await facade.receive(sellerId, { sku: 'DEMO-AUD-BT', qty: 24, locationId: locs['DEMO-RECV'], reference: 'DEMO-POR-GUARDAR', actor });

  // ---- Insumos de embalaje ----------------------------------------------------
  // Con stock MÍNIMO configurado: así el bloque de reposición del panel tiene de qué
  // hablar (dos bajo el mínimo, uno al límite y dos holgados).
  const EMBALAJE = [
    { sku: 'DEMO-CAJA-G', name: 'Caja grande 40×30×20 (demo)', unitPrice: 900, minStock: 150, stock: 85 },
    { sku: 'DEMO-CINTA', name: 'Cinta de embalaje, rollo (demo)', unitPrice: 1200, minStock: 20, stock: 9 },
    { sku: 'DEMO-PRECINTO', name: 'Precinto de seguridad (demo)', unitPrice: 120, minStock: 300, stock: 315 },
    { sku: 'DEMO-BOLSA-2', name: 'Bolsa courier N°2 (demo)', unitPrice: 240, minStock: 400, stock: 620 },
    { sku: 'DEMO-BURBUJA', name: 'Papel burbuja, rollo (demo)', unitPrice: 3500, minStock: 8, stock: 14 },
  ];
  for (const e of EMBALAJE) {
    try {
      await facade.createPackaging(operationId, { sku: e.sku, name: e.name, unitPrice: e.unitPrice, minStock: e.minStock });
      await facade.receivePackagingStock(operationId, e.sku, e.stock, actor, 'DEMO-INICIAL', Math.round(e.unitPrice * 0.6));
    } catch { /* ya existe de una corrida anterior */ }
  }

  // ---- Operarios -------------------------------------------------------------
  // Tres perfiles a propósito: uno cargado, uno ocioso (reasignar_ociosidad) y uno
  // que nunca se conecta pero tiene tareas abiertas (liberar_inactivos).
  const operarios = [`demo-op-a-${n}`, `demo-op-b-${n}`, `demo-op-c-${n}`];
  const nombres = ['Demo Ana (cargada)', 'Demo Beto (ocioso)', 'Demo Caro (inactiva)'];
  for (let i = 0; i < operarios.length; i++) {
    await facade.createUser({ id: operarios[i], name: nombres[i], email: `${operarios[i]}@demo.local`, role: UserRole.OPERATOR, operationId, password: 'demo1234' } as any).catch(() => { /* ya existe */ });
  }

  // ---- Órdenes ---------------------------------------------------------------
  // 20 órdenes repartidas por estado y por urgencia de deadline. `due` en horas
  // desde ahora: negativo = vencida, null = sin compromiso.
  type Plan = { ref: string; estado: string; due: number | null; courier: string; lineas: Array<[string, number]>; viejaHoras?: number };
  const planes: Plan[] = [
    // Vencidas y críticas: es lo que el agente debe empujar primero.
    { ref: 'DEMO-001', estado: 'ALLOCATED', due: -2, courier: 'Starken', lineas: [['DEMO-POL-BL', 4]] },
    { ref: 'DEMO-002', estado: 'ALLOCATED', due: -0.5, courier: 'Chilexpress', lineas: [['DEMO-TAZ-CE', 6]] },
    { ref: 'DEMO-003', estado: 'RECEIVED', due: 0.75, courier: 'Chilexpress', lineas: [['DEMO-ZAP-42', 2]] },
    { ref: 'DEMO-004', estado: 'PICKING', due: 1, courier: 'Blue Express', lineas: [['DEMO-POL-BL', 3], ['DEMO-TAZ-CE', 2]] },
    { ref: 'DEMO-005', estado: 'PICKED', due: 1.5, courier: 'Chilexpress', lineas: [['DEMO-AUD-BT', 2]] },
    // En riesgo (dentro de la ventana) — el agente avisa antes de incumplir.
    { ref: 'DEMO-006', estado: 'ALLOCATED', due: 3, courier: 'Starken', lineas: [['DEMO-ZAP-42', 1]] },
    { ref: 'DEMO-007', estado: 'RECEIVED', due: 3.5, courier: 'Starken', lineas: [['DEMO-TAZ-CE', 10]] },
    { ref: 'DEMO-008', estado: 'PACKED', due: 2, courier: 'Chilexpress', lineas: [['DEMO-POL-BL', 2]] },
    // Holgadas: el agente NO debería tocarlas.
    { ref: 'DEMO-009', estado: 'ALLOCATED', due: 20, courier: 'Blue Express', lineas: [['DEMO-CRE-50', 4]] },
    { ref: 'DEMO-010', estado: 'RECEIVED', due: 26, courier: 'Starken', lineas: [['DEMO-POL-BL', 5]] },
    { ref: 'DEMO-011', estado: 'ALLOCATED', due: 30, courier: 'Chilexpress', lineas: [['DEMO-TAZ-CE', 3]] },
    // Sin compromiso: material para fijar_deadline_orden.
    { ref: 'DEMO-012', estado: 'RECEIVED', due: null, courier: 'Rapiboy', lineas: [['DEMO-AUD-BT', 1]] },
    { ref: 'DEMO-013', estado: 'ALLOCATED', due: null, courier: 'Rapiboy', lineas: [['DEMO-POL-BL', 2]] },
    // Estancadas: creadas hace 30 h (regla orden_estancada).
    { ref: 'DEMO-014', estado: 'RECEIVED', due: null, courier: 'Starken', lineas: [['DEMO-TAZ-CE', 2]], viejaHoras: 30 },
    { ref: 'DEMO-015', estado: 'ALLOCATED', due: null, courier: 'Starken', lineas: [['DEMO-ZAP-42', 1]], viejaHoras: 28 },
    // Empacada hace 14 h sin despachar (regla sla_despacho).
    { ref: 'DEMO-016', estado: 'PACKED', due: null, courier: 'Blue Express', lineas: [['DEMO-TAZ-CE', 4]], viejaHoras: 14 },
    // Cerradas: dan historial para métricas y facturación.
    { ref: 'DEMO-017', estado: 'SHIPPED', due: null, courier: 'Chilexpress', lineas: [['DEMO-POL-BL', 3]], viejaHoras: 40 },
    { ref: 'DEMO-018', estado: 'SHIPPED', due: null, courier: 'Starken', lineas: [['DEMO-TAZ-CE', 5]], viejaHoras: 36 },
    // Cancelada después de pickear: deja una tarea de REPOSICIÓN pendiente.
    { ref: 'DEMO-019', estado: 'CANCELADA_PICKEADA', due: null, courier: 'Chilexpress', lineas: [['DEMO-POL-BL', 2]] },
    // Sin stock suficiente: queda RECEIVED y explica el faltante (quiebre).
    { ref: 'DEMO-020', estado: 'RECEIVED', due: 5, courier: 'Chilexpress', lineas: [['DEMO-ZAP-42', 500]] },
  ];

  const porEstado: Record<string, number> = {};
  const creadas: Array<{ id: string; ref: string; estado: string }> = [];
  for (const p of planes) {
    const o = await facade.createOrder(sellerId, {
      externalOrderId: p.ref,
      salesChannel: 'demo',
      orderType: OrderType.B2C,
      carrier: p.courier,
      priority: p.due != null && p.due < 0 ? 'alta' : 'normal',
      dueAt: p.due == null ? null : enHoras(p.due),
      dueSource: p.due == null ? null : 'oms',
      shipTo: { name: `Cliente demo ${p.ref}` },
      lines: p.lineas.map(([sku, qty]) => ({ sku, qty })),
    }, actor);
    let estadoFinal = 'RECEIVED';
    try {
      if (p.estado !== 'RECEIVED') {
        await facade.allocateOrder(sellerId, o.id, actor);
        estadoFinal = 'ALLOCATED';
      }
      if (p.estado === 'PICKING') { await facade.startPicking(sellerId, o.id, actor); estadoFinal = 'PICKING'; }
      if (p.estado === 'PICKED' || p.estado === 'PACKED' || p.estado === 'SHIPPED' || p.estado === 'CANCELADA_PICKEADA') {
        await facade.confirmPick(sellerId, o.id, actor); estadoFinal = 'PICKED';
      }
      if (p.estado === 'PACKED' || p.estado === 'SHIPPED') {
        // Se empaca consumiendo embalaje y VERIFICANDO la salida: de esa verificación
        // sale la precisión de preparación del panel. DEMO-016 sale con una diferencia
        // a propósito, para que la métrica no sea siempre 100%.
        const verify = p.lineas.map(([sku, qty]) => ({ sku, qty: p.ref === 'DEMO-016' ? Math.max(0, qty - 1) : qty }));
        await facade.packOrder(sellerId, o.id, {
          bultos: 1,
          materials: [{ sku: 'DEMO-CAJA-G', qty: 1 }, { sku: 'DEMO-CINTA', qty: 1 }],
          verify,
        } as any, actor);
        estadoFinal = 'PACKED';
      }
      if (p.estado === 'SHIPPED') {
        await facade.shipOrder(sellerId, o.id, { carrier: p.courier, trackingNumber: `DEMO-TRK-${p.ref}` } as any, actor);
        estadoFinal = 'SHIPPED';
      }
      if (p.estado === 'CANCELADA_PICKEADA') {
        await facade.cancelOrder(sellerId, o.id, actor); estadoFinal = 'CANCELLED';
      }
    } catch (e: any) {
      // Una orden que no alcanza a reservarse es parte del guion (DEMO-020).
      avisos.push(`${p.ref}: quedó en ${estadoFinal} — ${(e && e.message) || 'no se pudo avanzar'}`);
    }
    // Las órdenes "sin compromiso" del guion: la operación les asigna deadline por corte
    // o por SLA al ingresar, así que hay que quitárselo a propósito para tener ese caso.
    if (p.due == null) await facade.setOrderDueAt(sellerId, o.id, null, null, actor).catch(() => {});
    if (p.viejaHoras) await facade.backdateOrderForDemo(sellerId, o.id, p.viejaHoras).catch(() => {});
    porEstado[estadoFinal] = (porEstado[estadoFinal] || 0) + 1;
    creadas.push({ id: o.id, ref: p.ref, estado: estadoFinal });
  }

  // ---- Recepción abierta (tarea RECEIVE) y conteo (tarea COUNT) --------------
  await facade.createReceipt(sellerId, {
    externalRef: 'DEMO-ASN-01', supplier: 'Proveedor Demo',
    lines: [{ sku: 'DEMO-ZAP-42', qty: 120 }, { sku: 'DEMO-AUD-BT', qty: 60 }],
  } as any, actor).catch((e: any) => avisos.push(`recepción demo: ${e?.message || 'no se pudo crear'}`));

  // ---- Asignaciones desbalanceadas a propósito -------------------------------
  // Ana se lleva varias tareas; Beto queda ocioso; Caro (inactiva) queda con una
  // tarea abierta. Así el agente tiene algo real que balancear, reasignar y liberar.
  const asignables = creadas.filter((c) => c.estado === 'ALLOCATED').slice(0, 4);
  for (let i = 0; i < asignables.length; i++) {
    const destino = i < 3 ? operarios[0] : operarios[2];
    await facade.assignTask(operationId, {
      type: 'PICK', entityId: asignables[i].id, entityRef: asignables[i].ref, sellerId,
      operator: destino, unitsEstimate: 4, by: actor, skipOperatorCheck: true, note: 'sandbox de demostración',
    }).catch((e: any) => avisos.push(`asignación ${asignables[i].ref}: ${e?.message || 'no se pudo'}`));
  }

  // La tercera operaria queda DESACTIVADA con una tarea abierta: ese es el escenario
  // de la regla operario_inactivo y de la acción liberar_inactivos del agente.
  await facade.deactivateUser(operarios[2]).catch(() => { avisos.push('no se pudo desactivar a la operaria inactiva'); });

  // ---- Resumen para el panel --------------------------------------------------
  const pend: Record<string, number> = {};
  for (const tipo of ['PICK', 'PACK', 'SHIP', 'RECEIVE', 'PUTAWAY', 'RESTOCK', 'COUNT', 'RESLOT']) {
    pend[tipo] = (await facade.getTaskPool(operationId, tipo as any, { onlyUnassigned: true }).catch(() => [])).length;
  }
  const due = await facade.getOrdersDueSoon(operationId, { sellerId, withinHours: 999 }).catch(() => ({ items: [] as any[] }));
  const nivel = (l: string) => due.items.filter((i: any) => i.nivel === l).length;

  return {
    sellerId, sellerName,
    productos: PRODUCTOS.length,
    ubicaciones: UBICACIONES.length,
    ordenes: creadas.length,
    porEstado,
    deadlines: {
      vencidas: nivel('vencido'), criticas: nivel('critico'), enRiesgo: nivel('riesgo'), holgadas: nivel('ok'),
      sinDeadline: creadas.length - due.items.length,
    },
    tareasPendientes: pend,
    operarios: nombres,
    avisos,
  };
}
