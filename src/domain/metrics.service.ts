/**
 * MetricsService — métricas operativas del dashboard, por cliente (seller).
 *
 * Calcula, para las últimas 24 h / 7 d / 30 d / 90 d, cinco indicadores:
 *   - órdenes preparadas (pedidos que llegaron a PICKED en la ventana)
 *   - unidades preparadas (unidades pickeadas — movimientos PICK)
 *   - órdenes recibidas (recepciones con evento de RECEPCIÓN en la ventana)
 *   - unidades recibidas (movimientos RECEIPT)
 *   - movimientos (todos los asientos del ledger)
 *
 * Cada indicador incluye el valor del período anterior equivalente y la variación %
 * (últimas 24 h vs. las 24 h previas, últimos 7 d vs. los 7 d previos, etc.).
 * Todo se deriva del ledger inmutable y de los eventos de órdenes/recepciones — auditable.
 */
import { Clock, EventRepository, MovementRepository, OrderRepository, ReceiptOrderRepository, RollupRepository } from './ports';
import { MovementType, DomainEvent, DailyMetricRollup } from './types';

const DAY = 86400000;

export interface MetricValue {
  current: number;
  previous: number;
  pct: number | null; // null cuando el período anterior fue 0 (sin base de comparación)
}
export interface WindowMetrics {
  window: '24h' | '7d' | '30d' | '90d' | 'custom';
  spanDays: number;
  from?: string;
  to?: string;
  ordersPrepared: MetricValue;
  unitsPrepared: MetricValue;
  ordersReceived: MetricValue;
  unitsReceived: MetricValue;
  movements: MetricValue;
}
export interface DashboardMetrics {
  sellerId: string;
  generatedAt: string;
  windows: WindowMetrics[];
}

interface RawCounts {
  ordersPrepared: number;
  unitsPrepared: number;
  ordersReceived: number;
  unitsReceived: number;
  movements: number;
}

export class MetricsService {
  constructor(
    private readonly movements: MovementRepository,
    private readonly orders: OrderRepository,
    private readonly receipts: ReceiptOrderRepository,
    private readonly clock: Clock,
    private readonly events?: EventRepository,
    private readonly rollups?: RollupRepository,
  ) {}

  /** Suma los rollups diarios cuya fecha (UTC) cae en [fromMs, toMs). O(días). */
  private countFromRollups(rows: DailyMetricRollup[], fromMs: number, toMs: number): RawCounts {
    const fromDate = new Date(fromMs).toISOString().slice(0, 10);
    const toDate = new Date(toMs).toISOString().slice(0, 10);
    const acc: RawCounts = { ordersPrepared: 0, unitsPrepared: 0, ordersReceived: 0, unitsReceived: 0, movements: 0 };
    for (const r of rows) {
      if (r.date >= fromDate && r.date < toDate) {
        acc.ordersPrepared += r.ordersPrepared;
        acc.unitsPrepared += r.unitsPrepared;
        acc.ordersReceived += r.ordersReceived;
        acc.unitsReceived += r.unitsReceived;
        acc.movements += r.movements;
      }
    }
    return acc;
  }

  async forSeller(sellerId: string): Promise<DashboardMetrics> {
    const now = Date.parse(this.clock.now());

    // G3: si hay rollups materializados, el dashboard responde sumando días (O(días))
    // en vez de escanear el ledger completo.
    if (this.rollups) {
      const rollupRows = await this.rollups.listMetricRollups(sellerId);
      if (rollupRows.length) {
        const WIN: Array<{ window: WindowMetrics['window']; spanDays: number }> = [
          { window: '24h', spanDays: 1 }, { window: '7d', spanDays: 7 }, { window: '30d', spanDays: 30 }, { window: '90d', spanDays: 90 },
        ];
        const windows = WIN.map(({ window, spanDays }) => {
          const span = spanDays * DAY;
          const cur = this.countFromRollups(rollupRows, now - span, now);
          const prev = this.countFromRollups(rollupRows, now - 2 * span, now - span);
          return {
            window, spanDays,
            ordersPrepared: mv(cur.ordersPrepared, prev.ordersPrepared),
            unitsPrepared: mv(cur.unitsPrepared, prev.unitsPrepared),
            ordersReceived: mv(cur.ordersReceived, prev.ordersReceived),
            unitsReceived: mv(cur.unitsReceived, prev.unitsReceived),
            movements: mv(cur.movements, prev.movements),
          };
        });
        return { sellerId, generatedAt: new Date(now).toISOString(), windows };
      }
    }

    const movs = await this.movements.find({ sellerId });
    const orders = await this.orders.list(sellerId);
    const receipts = await this.receipts.list(sellerId);
    // G2+G6: los conteos de órdenes/recepciones se basan en el event store consultable.
    // Hidratamos `events` desde la tabla (una consulta indexada por tipo de entidad),
    // así el cálculo es idéntico al histórico pero alimentado desde la fuente nueva —
    // y funciona aunque el SalesOrder no persista su historial en la cabecera.
    if (this.events) {
      const group = (rows: DomainEvent[]) => {
        const m = new Map<string, any[]>();
        for (const e of rows) {
          const a = m.get(e.entityId) || [];
          a.push({ type: e.type, at: e.at, actor: e.actor, detail: e.detail });
          m.set(e.entityId, a);
        }
        return m;
      };
      const [oEv, rEv] = await Promise.all([
        this.events.query({ sellerIds: [sellerId], entityType: 'ORDER' }),
        this.events.query({ sellerIds: [sellerId], entityType: 'RECEIPT' }),
      ]);
      const og = group(oEv);
      const rg = group(rEv);
      for (const o of orders as any[]) if (og.has(o.id)) o.events = og.get(o.id);
      for (const r of receipts as any[]) if (rg.has(r.id)) r.events = rg.get(r.id);
    }

    const WINDOWS: Array<{ window: WindowMetrics['window']; spanDays: number }> = [
      { window: '24h', spanDays: 1 },
      { window: '7d', spanDays: 7 },
      { window: '30d', spanDays: 30 },
      { window: '90d', spanDays: 90 },
    ];

    const windows = WINDOWS.map(({ window, spanDays }) => {
      const span = spanDays * DAY;
      const cur = this.count(movs, orders, receipts, now - span, now);
      const prev = this.count(movs, orders, receipts, now - 2 * span, now - span);
      return {
        window,
        spanDays,
        ordersPrepared: mv(cur.ordersPrepared, prev.ordersPrepared),
        unitsPrepared: mv(cur.unitsPrepared, prev.unitsPrepared),
        ordersReceived: mv(cur.ordersReceived, prev.ordersReceived),
        unitsReceived: mv(cur.unitsReceived, prev.unitsReceived),
        movements: mv(cur.movements, prev.movements),
      };
    });

    return { sellerId, generatedAt: new Date(now).toISOString(), windows };
  }

  /** Métricas para un rango personalizado [fromIso, toIso), con comparativo contra el período previo equivalente. */
  async forSellerRange(sellerId: string, fromIso: string, toIso: string): Promise<DashboardMetrics> {
    const from = Date.parse(fromIso);
    const to = Date.parse(toIso);
    if (!(to > from)) throw new Error('Rango de fechas inválido');
    const span = to - from;
    // G3: camino por rollups (sin full-scan) cuando están materializados.
    if (this.rollups) {
      const rollupRows = await this.rollups.listMetricRollups(sellerId);
      if (rollupRows.length) {
        const cur = this.countFromRollups(rollupRows, from, to);
        const prev = this.countFromRollups(rollupRows, from - span, from);
        const w: WindowMetrics = {
          window: 'custom', spanDays: Math.max(1, Math.round(span / DAY)),
          from: new Date(from).toISOString(), to: new Date(to).toISOString(),
          ordersPrepared: mv(cur.ordersPrepared, prev.ordersPrepared),
          unitsPrepared: mv(cur.unitsPrepared, prev.unitsPrepared),
          ordersReceived: mv(cur.ordersReceived, prev.ordersReceived),
          unitsReceived: mv(cur.unitsReceived, prev.unitsReceived),
          movements: mv(cur.movements, prev.movements),
        };
        return { sellerId, generatedAt: new Date(Date.parse(this.clock.now())).toISOString(), windows: [w] };
      }
    }
    const movs = await this.movements.find({ sellerId });
    const orders = await this.orders.list(sellerId);
    const receipts = await this.receipts.list(sellerId);
    const cur = this.count(movs, orders, receipts, from, to);
    const prev = this.count(movs, orders, receipts, from - span, from);
    const w: WindowMetrics = {
      window: 'custom',
      spanDays: Math.max(1, Math.round(span / DAY)),
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      ordersPrepared: mv(cur.ordersPrepared, prev.ordersPrepared),
      unitsPrepared: mv(cur.unitsPrepared, prev.unitsPrepared),
      ordersReceived: mv(cur.ordersReceived, prev.ordersReceived),
      unitsReceived: mv(cur.unitsReceived, prev.unitsReceived),
      movements: mv(cur.movements, prev.movements),
    };
    return { sellerId, generatedAt: new Date(Date.parse(this.clock.now())).toISOString(), windows: [w] };
  }

  /** Cuenta los cinco indicadores en el intervalo [from, to). */
  private count(movs: any[], orders: any[], receipts: any[], from: number, to: number): RawCounts {
    const inWin = (iso: string) => {
      const t = Date.parse(iso);
      return t >= from && t < to;
    };
    let unitsPrepared = 0;
    let unitsReceived = 0;
    let movements = 0;
    for (const m of movs) {
      if (!inWin(m.occurredAt)) continue;
      movements += 1;
      if (m.type === MovementType.PICK) unitsPrepared += Math.abs(m.qtyDelta);
      else if (m.type === MovementType.RECEIPT) unitsReceived += m.qtyDelta;
    }
    const ordersPrepared = orders.filter((o) => (o.events || []).some((e: any) => e.type === 'PICKED' && inWin(e.at))).length;
    const ordersReceived = receipts.filter((r) =>
      (r.events || []).some((e: any) => typeof e.type === 'string' && e.type.indexOf('RECEPCIÓN') === 0 && inWin(e.at)),
    ).length;
    return { ordersPrepared, unitsPrepared, ordersReceived, unitsReceived, movements };
  }
}

function mv(current: number, previous: number): MetricValue {
  const pct = previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;
  return { current, previous, pct };
}
