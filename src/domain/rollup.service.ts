/**
 * RollupService (G3) — job diario que materializa rollups a partir del ledger y del
 * event store, para que el dashboard responda en O(días) (sin full-scan del ledger)
 * y el forecasting consuma series limpias.
 *
 * Produce tres rollups por día (UTC):
 *   - DailyInventorySnapshot: on-hand por SKU y estado (posición de inventario).
 *   - DailyDemand: unidades despachadas + nº de órdenes por SKU (serie de demanda).
 *   - DailyMetricRollup: los 5 indicadores operativos del dashboard por seller.
 *
 * REPRODUCIBLE: cada fila tiene id determinístico y se persiste con upsert, así que
 * re-ejecutar el job para las mismas fechas da exactamente el mismo resultado.
 */
import {
  Clock,
  EventRepository,
  MovementRepository,
  OrderRepository,
  RollupRepository,
  SellerRepository,
} from './ports';
import {
  DailyDemand,
  DailyInventorySnapshot,
  DailyMetricRollup,
  DomainEvent,
  MovementType,
  StockMovement,
  StockState,
} from './types';

const DAY = 86400000;

/** 'YYYY-MM-DD' (UTC) de un instante. */
export function dayKey(iso: string | number): string {
  return new Date(iso).toISOString().slice(0, 10);
}

export class RollupService {
  constructor(
    private readonly movements: MovementRepository,
    private readonly sellers: SellerRepository,
    private readonly rollups: RollupRepository,
    private readonly clock: Clock,
    private readonly events?: EventRepository,
    private readonly orders?: OrderRepository,
  ) {}

  /** Corre el rollup de UN día para una operación (o todas). */
  async runDailyRollup(dateIso: string, operationId?: string): Promise<{ days: number; sellers: number }> {
    const date = dayKey(dateIso);
    return this.runRange(date, date, operationId);
  }

  /**
   * Corre el rollup para el rango [fromDate, toDate] inclusive (fechas YYYY-MM-DD).
   * Carga el ledger y los eventos de cada seller UNA vez y acumula por día.
   */
  async runRange(fromDate: string, toDate: string, operationId?: string): Promise<{ days: number; sellers: number }> {
    const sellerIds = await this.sellerScope(operationId);
    const days = this.enumerateDays(fromDate, toDate);
    for (const sid of sellerIds) {
      await this.rollupSeller(sid, days);
    }
    return { days: days.length, sellers: sellerIds.length };
  }

  /**
   * Backfill histórico: descubre el rango real de actividad del ledger y materializa
   * todos los días hasta hoy. Idempotente.
   */
  async backfill(operationId?: string): Promise<{ days: number; sellers: number; from: string | null; to: string | null }> {
    const sellerIds = await this.sellerScope(operationId);
    let min: string | null = null;
    let max: string | null = null;
    for (const sid of sellerIds) {
      const movs = await this.movements.find({ sellerId: sid });
      for (const m of movs) {
        const d = dayKey(m.occurredAt);
        if (!min || d < min) min = d;
        if (!max || d > max) max = d;
      }
    }
    const today = dayKey(this.clock.now());
    if (!max || today > max) max = today;
    if (!min) return { days: 0, sellers: sellerIds.length, from: null, to: null };
    const res = await this.runRange(min, max, operationId);
    return { ...res, from: min, to: max };
  }

  /** Lectura: serie de demanda diaria por SKU (para forecasting). */
  listDemand(sellerId: string, opts?: { sku?: string | null; fromDate?: string; toDate?: string }): Promise<DailyDemand[]> {
    return this.rollups.listDemand(sellerId, opts);
  }

  /** Lectura: snapshots de inventario diarios por SKU/estado. */
  listInventorySnapshots(sellerId: string, opts?: { sku?: string | null; fromDate?: string; toDate?: string }): Promise<DailyInventorySnapshot[]> {
    return this.rollups.listInventorySnapshots(sellerId, opts);
  }

  // ---- interno --------------------------------------------------------------

  private async sellerScope(operationId?: string): Promise<string[]> {
    if (operationId) return (await this.sellers.list(operationId)).map((s) => s.id);
    // Sin operación: todos los sellers de todas las operaciones no es enumerable por
    // el puerto; el llamador debe pasar operationId. Devolvemos vacío defensivamente.
    return [];
  }

  private enumerateDays(fromDate: string, toDate: string): string[] {
    const out: string[] = [];
    let t = Date.parse(`${fromDate}T00:00:00.000Z`);
    const end = Date.parse(`${toDate}T00:00:00.000Z`);
    if (Number.isNaN(t) || Number.isNaN(end) || end < t) return out;
    while (t <= end) { out.push(dayKey(t)); t += DAY; }
    return out;
  }

  private async rollupSeller(sellerId: string, days: string[]): Promise<void> {
    if (!days.length) return;
    const movs = (await this.movements.find({ sellerId })).slice().sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
    // Eventos (para conteos de órdenes/recepciones y demanda por nº de órdenes).
    let orderEvents: DomainEvent[] = [];
    let receiptEvents: DomainEvent[] = [];
    if (this.events) {
      [orderEvents, receiptEvents] = await Promise.all([
        this.events.query({ sellerIds: [sellerId], entityType: 'ORDER' }),
        this.events.query({ sellerIds: [sellerId], entityType: 'RECEIPT' }),
      ]);
    }

    const daySet = new Set(days);
    const snapRows: DailyInventorySnapshot[] = [];
    const demandRows: DailyDemand[] = [];
    const metricRows: DailyMetricRollup[] = [];

    // Demanda "despachada": en este modelo el stock sale por PICK y el DESPACHO queda
    // como evento SHIPPED de la orden. Las unidades despachadas por SKU/día se toman de
    // las LÍNEAS de las órdenes cuyo evento SHIPPED cae ese día.
    const demandByDaySku = new Map<string, Map<string, { units: number; orders: Set<string> }>>();
    if (this.orders) {
      const ordersById = new Map<string, any>();
      for (const o of await this.orders.list(sellerId)) ordersById.set(o.id, o);
      for (const e of orderEvents) {
        if (e.type !== 'SHIPPED') continue;
        const d = dayKey(e.at);
        if (!daySet.has(d)) continue;
        const order = ordersById.get(e.entityId);
        if (!order) continue;
        let bySku = demandByDaySku.get(d);
        if (!bySku) { bySku = new Map(); demandByDaySku.set(d, bySku); }
        for (const line of order.lines || []) {
          const cell = bySku.get(line.sku) || { units: 0, orders: new Set<string>() };
          cell.units += line.qty;
          cell.orders.add(order.id);
          bySku.set(line.sku, cell);
        }
      }
    }

    // Índice de movimientos por día (sólo del rango solicitado) para métricas/demanda.
    const movsByDay = new Map<string, StockMovement[]>();
    for (const m of movs) {
      const d = dayKey(m.occurredAt);
      if (daySet.has(d)) {
        const arr = movsByDay.get(d) || [];
        arr.push(m);
        movsByDay.set(d, arr);
      }
    }

    // Posición de inventario por (sku|state) AL CIERRE de cada día: acumulamos los
    // movimientos en orden cronológico avanzando día a día (una sola pasada).
    const onHand = new Map<string, number>();
    let mi = 0;
    for (const day of days) {
      const dayEndMs = Date.parse(`${day}T00:00:00.000Z`) + DAY;
      // Aplica todos los movimientos ocurridos antes del cierre de este día.
      while (mi < movs.length && Date.parse(movs[mi].occurredAt) < dayEndMs) {
        const m = movs[mi];
        onHand.set(`${m.sku}::${m.state}`, (onHand.get(`${m.sku}::${m.state}`) || 0) + m.qtyDelta);
        mi++;
      }
      // Snapshot: on-hand por SKU y estado al cierre del día.
      const bySku = new Map<string, DailyInventorySnapshot>();
      for (const [key, qty] of onHand) {
        if (qty === 0) continue;
        const [sku, state] = key.split('::');
        let row = bySku.get(sku);
        if (!row) {
          row = { id: `${sellerId}:${sku}:${day}`, sellerId, sku, date: day, available: 0, reserved: 0, quarantine: 0, damaged: 0, inTransit: 0, total: 0 };
          bySku.set(sku, row);
        }
        if (state === StockState.AVAILABLE) row.available += qty;
        else if (state === StockState.RESERVED) row.reserved += qty;
        else if (state === StockState.QUARANTINE) row.quarantine += qty;
        else if (state === StockState.DAMAGED) row.damaged += qty;
        else if (state === StockState.IN_TRANSIT) row.inTransit += qty;
        row.total += qty;
      }
      for (const row of bySku.values()) snapRows.push(row);

      // Métricas del día (sólo movimientos de ese día).
      const dayMovs = movsByDay.get(day) || [];
      let unitsPrepared = 0, unitsReceived = 0, movements = 0;
      for (const m of dayMovs) {
        movements += 1;
        if (m.type === MovementType.PICK) unitsPrepared += Math.abs(m.qtyDelta);
        else if (m.type === MovementType.RECEIPT) unitsReceived += m.qtyDelta;
      }
      const inDay = (iso: string) => dayKey(iso) === day;
      const ordersPrepared = new Set(orderEvents.filter((e) => e.type === 'PICKED' && inDay(e.at)).map((e) => e.entityId)).size;
      const ordersReceived = new Set(receiptEvents.filter((e) => e.type.indexOf('RECEPCIÓN') === 0 && inDay(e.at)).map((e) => e.entityId)).size;
      metricRows.push({ id: `${sellerId}:${day}`, sellerId, date: day, ordersPrepared, unitsPrepared, ordersReceived, unitsReceived, movements });

      // Demanda despachada del día (por SKU) desde las órdenes SHIPPED.
      const dem = demandByDaySku.get(day);
      if (dem) {
        for (const [sku, cell] of dem) {
          demandRows.push({ id: `${sellerId}:${sku}:${day}`, sellerId, sku, date: day, unitsShipped: cell.units, orders: cell.orders.size });
        }
      }
    }

    await this.rollups.saveInventorySnapshots(snapRows);
    await this.rollups.saveMetricRollups(metricRows);
    await this.rollups.saveDemand(demandRows);
  }
}
