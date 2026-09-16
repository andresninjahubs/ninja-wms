/**
 * Panel de control consolidado de la OPERACIÓN.
 * ---------------------------------------------------------------------------
 * El dashboard histórico era por cliente; este mira toda la operación (con el
 * cliente como filtro opcional) y arma, en UNA sola llamada, todo lo que la
 * pantalla necesita: actividad con comparativo, productividad, pre-facturación,
 * cumplimiento de deadlines, precisión de preparación, tiempos, ocupación,
 * carga por cliente, cola por courier, órdenes por estado, reposición de
 * embalaje y excepciones abiertas.
 *
 * Una sola llamada porque la pantalla se refresca sola: pedir catorce endpoints
 * cada refresco es catorce veces más para desincronizarse y para pagar.
 *
 * Todo sale de datos reales. Lo que el sistema no mide todavía se devuelve como
 * null con su motivo, en vez de inventar un número (ver `faltantes`).
 */
import { OrderStatus, SalesOrder } from '../domain/types';
import { WmsFacade } from './wms.facade';

export type DashboardWindow = '24h' | '7d' | '30d' | '90d';

export interface OperationDashboardOpts {
  sellerId?: string | null;
  window?: DashboardWindow;
  from?: string | null;
  to?: string | null;
}

const WIN_DAYS: Record<DashboardWindow, number> = { '24h': 1, '7d': 7, '30d': 30, '90d': 90 };
const ABIERTAS = [OrderStatus.RECEIVED, OrderStatus.ALLOCATED, OrderStatus.PICKING, OrderStatus.PICKED, OrderStatus.PACKED];

function pct(part: number, total: number): number | null {
  return total > 0 ? Math.round((part / total) * 1000) / 10 : null;
}
function delta(cur: number, prev: number) {
  return { valor: cur, anterior: prev, cambioPct: prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null };
}

export async function buildOperationDashboard(facade: WmsFacade, operationId: string, opts: OperationDashboardOpts = {}) {
  const ventana: DashboardWindow = opts.window || '24h';
  const nowIso = (facade as any).clockNow ? (facade as any).clockNow() : new Date().toISOString();
  const now = Date.parse(nowIso);
  const faltantes: string[] = [];

  const sellersAll = await facade.listSellers(operationId);
  const sellers = opts.sellerId ? sellersAll.filter((s) => s.id === opts.sellerId) : sellersAll;
  const nombre = new Map(sellersAll.map((s) => [s.id, s.name] as const));

  // Todas las órdenes del alcance, una sola vez: casi todos los bloques las usan.
  const ordersBySeller = new Map<string, SalesOrder[]>();
  for (const s of sellers) ordersBySeller.set(s.id, await facade.listOrders(s.id).catch(() => [] as SalesOrder[]));
  const allOrders: Array<SalesOrder & { _seller: string }> = [];
  for (const [sid, list] of ordersBySeller) for (const o of list) allOrders.push(Object.assign({ _seller: sid }, o));

  // ---- 1. Actividad operativa (suma de los clientes del alcance) --------------
  const actividad = await (async () => {
    const acc = {
      ordenesPreparadas: { valor: 0, anterior: 0 }, unidadesPreparadas: { valor: 0, anterior: 0 },
      ordenesRecibidas: { valor: 0, anterior: 0 }, unidadesRecibidas: { valor: 0, anterior: 0 },
      movimientos: { valor: 0, anterior: 0 },
    };
    const custom = !!(opts.from && opts.to);
    // OJO: MetricValue se llama { current, previous, pct }. Leer `.value` devolvía
    // undefined y dejaba TODO este bloque en cero — el panel mostraba 0 y −100 %.
    for (const s of sellers) {
      try {
        if (custom) {
          const r: any = await facade.dashboardMetricsRange(s.id, opts.from as string, opts.to as string);
          const w = r.windows ? r.windows[0] : r;
          acc.ordenesPreparadas.valor += w.ordersPrepared?.current ?? 0; acc.ordenesPreparadas.anterior += w.ordersPrepared?.previous ?? 0;
          acc.unidadesPreparadas.valor += w.unitsPrepared?.current ?? 0; acc.unidadesPreparadas.anterior += w.unitsPrepared?.previous ?? 0;
          acc.ordenesRecibidas.valor += w.ordersReceived?.current ?? 0; acc.ordenesRecibidas.anterior += w.ordersReceived?.previous ?? 0;
          acc.unidadesRecibidas.valor += w.unitsReceived?.current ?? 0; acc.unidadesRecibidas.anterior += w.unitsReceived?.previous ?? 0;
          acc.movimientos.valor += w.movements?.current ?? 0; acc.movimientos.anterior += w.movements?.previous ?? 0;
        } else {
          const r: any = await facade.dashboardMetrics(s.id);
          const w = (r.windows || []).find((x: any) => x.window === ventana);
          if (!w) continue;
          acc.ordenesPreparadas.valor += w.ordersPrepared?.current ?? 0; acc.ordenesPreparadas.anterior += w.ordersPrepared?.previous ?? 0;
          acc.unidadesPreparadas.valor += w.unitsPrepared?.current ?? 0; acc.unidadesPreparadas.anterior += w.unitsPrepared?.previous ?? 0;
          acc.ordenesRecibidas.valor += w.ordersReceived?.current ?? 0; acc.ordenesRecibidas.anterior += w.ordersReceived?.previous ?? 0;
          acc.unidadesRecibidas.valor += w.unitsReceived?.current ?? 0; acc.unidadesRecibidas.anterior += w.unitsReceived?.previous ?? 0;
          acc.movimientos.valor += w.movements?.current ?? 0; acc.movimientos.anterior += w.movements?.previous ?? 0;
        }
      } catch { /* un cliente sin datos no rompe el panel */ }
    }
    return {
      ordenesPreparadas: delta(acc.ordenesPreparadas.valor, acc.ordenesPreparadas.anterior),
      unidadesPreparadas: delta(acc.unidadesPreparadas.valor, acc.unidadesPreparadas.anterior),
      ordenesRecibidas: delta(acc.ordenesRecibidas.valor, acc.ordenesRecibidas.anterior),
      unidadesRecibidas: delta(acc.unidadesRecibidas.valor, acc.unidadesRecibidas.anterior),
      movimientos: delta(acc.movimientos.valor, acc.movimientos.anterior),
    };
  })();

  // ---- 2. Productividad de bodega --------------------------------------------
  const productividad = await (async () => {
    try {
      const desde = new Date(now - WIN_DAYS[ventana] * 86400000).toISOString();
      // Las tareas de trabajo se derivan del ledger bajo demanda. Sin esto el
      // bloque salía vacío salvo que alguien llamara antes a /analytics/labor/derive.
      // Es idempotente (el id es PICK:<movimiento>), así que re-derivar no duplica.
      await facade.deriveLaborFromLedger(operationId).catch(() => null);
      const r: any = await facade.laborProductivity(operationId, { from: desde, to: nowIso });
      const users = await facade.listUsers(operationId).catch(() => [] as any[]);
      const nm = new Map((users || []).map((u: any) => [u.id, u.name] as const));
      // El ledger solo guarda UN timestamp por movimiento, así que las tareas
      // derivadas de él no tienen duración: unidades/hora solo sale de las tareas
      // que captura la PWA (inicio y fin reales). Se dice, no se inventa.
      const ops = r.operators || [];
      if (ops.length && ops.every((o: any) => !(o.hoursWorked > 0))) {
        faltantes.push('productividad-horas: unidades/hora necesita tareas cronometradas desde la app del operario');
      }
      return ops.slice(0, 8).map((o: any) => ({
        operario: o.operator,
        nombre: nm.get(o.operator) || o.operator,
        unidades: o.units,
        horas: o.hoursWorked,
        unidadesPorHora: o.unitsPerHour,
        // El PDF habla de min/orden: cada tarea de picking es una orden.
        minPorTarea: o.tasks > 0 && o.hoursWorked > 0 ? Math.round((o.hoursWorked * 60 / o.tasks) * 10) / 10 : null,
        tareas: o.tasks,
      }));
    } catch { faltantes.push('productividad'); return []; }
  })();

  // ---- 3. Pre-facturación acumulada del mes en curso --------------------------
  const prefacturacion = await (async () => {
    const d = new Date(now);
    const year = d.getUTCFullYear(), month = d.getUTCMonth() + 1;
    const porCliente: Array<{ sellerId: string; nombre: string; monto: number }> = [];
    let moneda = 'CLP';
    for (const s of sellers) {
      try {
        const inv: any = await facade.previewInvoice(s.id, year, month);
        moneda = inv.currency || moneda;
        porCliente.push({ sellerId: s.id, nombre: s.name, monto: inv.total || 0 });
      } catch { /* cliente sin tarifario configurado */ }
    }
    porCliente.sort((a, b) => b.monto - a.monto);
    return { periodo: `${year}-${String(month).padStart(2, '0')}`, moneda, total: porCliente.reduce((t, x) => t + x.monto, 0), porCliente };
  })();

  // ---- 4. Cumplimiento del deadline de preparación ----------------------------
  const abiertas = allOrders.filter((o) => ABIERTAS.includes(o.status as OrderStatus));
  const conDeadline = abiertas.filter((o) => !!o.dueAt);
  const atrasadas = conDeadline.filter((o) => Date.parse(o.dueAt as string) < now);
  const despacho = {
    aTiempo: conDeadline.length - atrasadas.length,
    atrasadas: atrasadas.length,
    conCompromiso: conDeadline.length,
    abiertasTotal: abiertas.length,
    sinCompromiso: abiertas.length - conDeadline.length,
  };

  // ---- 5. Precisión de preparación (verificación al empacar) -------------------
  const precision = (() => {
    const desde = now - 30 * 86400000;
    const verificadas = allOrders.filter((o) => {
      const v = (o.packing as any)?.verification;
      return v && Date.parse(v.at) >= desde;
    });
    const conError = verificadas.filter((o) => !(o.packing as any).verification.ok);
    const empacadas = allOrders.filter((o) => o.packing && Date.parse((o.packing as any).packedAt) >= desde);
    if (!verificadas.length) faltantes.push('precision-preparacion: todavía no hay pedidos verificados al empacar');
    return {
      pct: pct(verificadas.length - conError.length, verificadas.length),
      pedidosVerificados: verificadas.length,
      pedidosConError: conError.length,
      empacadosEnVentana: empacadas.length,
      coberturaPct: pct(verificadas.length, empacadas.length), // cuántos empaques se verifican
      ventanaDias: 30,
    };
  })();

  // ---- 6. Tiempo de preparación, separado B2B / B2C ---------------------------
  const tiempos = (() => {
    const mins: Record<string, number[]> = { b2b: [], b2c: [] };
    const desde = now - 30 * 86400000;
    for (const o of allOrders) {
      const evs = o.events || [];
      const ini = evs.find((e) => e.type === 'ALLOCATED');
      const fin = evs.find((e) => e.type === 'PACKED');
      if (!ini || !fin) continue;
      const t = Date.parse(fin.at);
      if (t < desde) continue;
      const m = (t - Date.parse(ini.at)) / 60000;
      if (m < 0 || m > 60 * 24 * 30) continue;
      (String(o.orderType).toLowerCase() === 'b2b' ? mins.b2b : mins.b2c).push(m);
    }
    const avg = (a: number[]) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
    return { b2bMin: avg(mins.b2b), b2cMin: avg(mins.b2c), muestrasB2B: mins.b2b.length, muestrasB2C: mins.b2c.length, ventanaDias: 30 };
  })();

  // ---- 7. Ocupación de bodega (en unidades: la capacidad se define así) --------
  const ocupacion = await (async () => {
    const locs = await facade.listLocations(operationId).catch(() => [] as any[]);
    const occ: Record<string, number> = {};
    for (const s of sellers) for (const b of await facade.getStock({ sellerId: s.id }).catch(() => [] as any[])) occ[b.locationId] = (occ[b.locationId] || 0) + b.qty;
    let usado = 0, capacidad = 0;
    const porZona: Record<string, { usado: number; capacidad: number }> = {};
    for (const l of locs as any[]) {
      const u = occ[l.id] || 0;
      const z = porZona[l.zoneType] || { usado: 0, capacidad: 0 };
      z.usado += u; z.capacidad += l.capacity || 0; porZona[l.zoneType] = z;
      usado += u; capacidad += l.capacity || 0;
    }
    return { unidad: 'unidades' as const, usado, capacidad, pct: pct(usado, capacidad), porZona, ubicaciones: (locs as any[]).length };
  })();

  // ---- 8, 9, 10. Carga por cliente, cola por courier y órdenes por estado ------
  const cargaPorCliente = sellers.map((s) => {
    const list = (ordersBySeller.get(s.id) || []).filter((o) => ABIERTAS.includes(o.status as OrderStatus));
    return {
      sellerId: s.id, nombre: s.name, ordenes: list.length,
      unidades: list.reduce((t, o) => t + (o.lines || []).reduce((a, l) => a + l.qty, 0), 0),
    };
  }).filter((x) => x.ordenes > 0).sort((a, b) => b.unidades - a.unidades);

  const colaPorCourier = (() => {
    const map = new Map<string, number>();
    for (const o of allOrders) {
      if (o.status !== OrderStatus.ALLOCATED && o.status !== OrderStatus.PICKING) continue;
      const c = (o.carrier || 'Sin courier').trim();
      map.set(c, (map.get(c) || 0) + 1);
    }
    return [...map.entries()].map(([courier, ordenes]) => ({ courier, ordenes })).sort((a, b) => b.ordenes - a.ordenes);
  })();

  const ordenesPorEstado = (() => {
    const out: Record<string, number> = {};
    for (const o of allOrders) out[o.status] = (out[o.status] || 0) + 1;
    return out;
  })();

  // ---- 11. Reposición de material de embalaje ---------------------------------
  const embalaje = await (async () => {
    try {
      const materials: any[] = await facade.listPackaging(operationId);
      const movimientos: any[] = await facade.listPackagingMovements(operationId);
      const stock: Record<string, number> = {};
      const consumo30: Record<string, number> = {};
      const desde = now - 30 * 86400000;
      for (const mv of movimientos) {
        stock[mv.materialSku] = (stock[mv.materialSku] || 0) + mv.qtyDelta;
        if (mv.qtyDelta < 0 && Date.parse(mv.occurredAt) >= desde) consumo30[mv.materialSku] = (consumo30[mv.materialSku] || 0) + Math.abs(mv.qtyDelta);
      }
      const sinMinimo = materials.filter((m) => m.active !== false && !(m.minStock > 0)).length;
      if (sinMinimo) faltantes.push(`embalaje: ${sinMinimo} insumo(s) sin stock mínimo configurado`);
      return materials.filter((m) => m.active !== false).map((m) => {
        const s = stock[m.sku] || 0;
        const min = m.minStock || 0;
        const c30 = consumo30[m.sku] || 0;
        // Sugerencia: llegar al mínimo, o cubrir un mes de consumo si no hay mínimo.
        const objetivo = min > 0 ? min * 2 : Math.ceil(c30);
        const sugerido = s < (min || c30) ? Math.max(0, objetivo - s) : 0;
        const estado = min > 0 ? (s < min ? 'critico' : s < min * 1.2 ? 'bajo' : 'ok') : (c30 > 0 && s < c30 ? 'bajo' : 'ok');
        return { sku: m.sku, nombre: m.name, stock: s, minStock: min, consumo30: c30, sugerido, estado };
      }).sort((a, b) => (a.estado === b.estado ? a.nombre.localeCompare(b.nombre) : a.estado === 'critico' ? -1 : b.estado === 'critico' ? 1 : a.estado === 'bajo' ? -1 : 1));
    } catch { faltantes.push('embalaje'); return []; }
  })();

  // ---- 12. Excepciones que requieren atención ---------------------------------
  const excepciones = await (async () => {
    try {
      const r = await facade.agentAlerts(operationId);
      return (r.abiertas || []).slice(0, 12).map((a: any) => ({
        severidad: a.severity, titulo: a.title, detalle: a.detail, accion: a.action,
        cliente: a.sellerId ? (nombre.get(a.sellerId) || a.sellerId) : 'General',
        regla: a.ruleKey, link: a.link, desde: a.createdAt,
        minutos: Math.max(0, Math.round((now - Date.parse(a.createdAt)) / 60000)),
      }));
    } catch { faltantes.push('excepciones'); return []; }
  })();

  return {
    generadoEn: nowIso,
    alcance: { operationId, sellerId: opts.sellerId || null, clientes: sellers.length, consolidado: !opts.sellerId },
    ventana: opts.from && opts.to ? { tipo: 'personalizado', desde: opts.from, hasta: opts.to } : { tipo: ventana, dias: WIN_DAYS[ventana] },
    actividad, productividad, prefacturacion, despacho, precision, tiempos, ocupacion,
    cargaPorCliente, colaPorCourier, ordenesPorEstado, embalaje, excepciones,
    faltantes,
  };
}
