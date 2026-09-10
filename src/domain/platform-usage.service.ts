/**
 * PlatformUsageService — "Panel de uso" de la plataforma (solo PLATFORM_ADMIN).
 *
 * Mide, para una ventana temporal [ahora - spanDays, ahora), el nivel de uso de
 * CADA operación (tenant) y un consolidado de toda la plataforma, SIEMPRE con el
 * comparativo % contra el MISMO período anterior (p. ej. últimos 30 días vs. los
 * 30 días previos). Todo se deriva de los repositorios (auditable): eventos de
 * login, ledger de movimientos, eventos de órdenes/recepciones y facturas.
 *
 * Métricas por operación (cada una con { current, previous, pct }):
 *   - logins y usuarios activos únicos (usuarios distintos que iniciaron sesión)
 *   - tasa de adopción = usuarios activos ÷ usuarios totales de la operación
 *   - movimientos de inventario (asientos del ledger)
 *   - órdenes despachadas (SHIPPED) y creadas (CREATED)
 *   - recepciones procesadas (evento cuyo type empieza con 'RECEPCIÓN')
 *   - facturas emitidas (BillingInvoice.createdAt en la ventana)
 * Instantáneas (sin comparativo): totales de clientes/usuarios, última actividad,
 * y la marca de operación dormida (sin actividad en la ventana actual).
 */
import {
  BillingRepository,
  Clock,
  IdGenerator,
  LoginEventRepository,
  MovementRepository,
  OperationRepository,
  OrderRepository,
  ReceiptOrderRepository,
  SellerRepository,
  UserRepository,
} from './ports';
import { LoginEvent } from './types';

const DAY = 86400000;

/** Un indicador con su valor actual, el del período anterior equivalente y la variación %. */
export interface Metric {
  current: number;
  previous: number;
  pct: number | null; // null cuando el período anterior fue 0 (sin base de comparación)
}

export interface OperationUsage {
  operationId: string;
  operationName: string;
  logins: Metric;
  activeUsers: Metric;
  adoptionRate: Metric; // % activos/totales (current/previous en puntos porcentuales)
  movements: Metric;
  ordersCreated: Metric;
  ordersShipped: Metric;
  receipts: Metric;
  invoices: Metric;
  totalUsers: number; // instantánea
  totalSellers: number; // instantánea
  lastActivity: string | null; // ISO — máximo timestamp de actividad conocido
  dormant: boolean; // true si NO hubo actividad en la ventana ACTUAL
}

export interface PlatformTotals {
  operations: number;
  activeOperations: number;
  logins: Metric;
  activeUsers: Metric;
  adoptionRate: Metric;
  movements: Metric;
  ordersCreated: Metric;
  ordersShipped: Metric;
  receipts: Metric;
  invoices: Metric;
  totalUsers: number;
  totalSellers: number;
}

export interface PlatformUsage {
  generatedAt: string;
  spanDays: number;
  totals: PlatformTotals;
  operations: OperationUsage[];
}

function mk(current: number, previous: number): Metric {
  const pct = previous > 0 ? Math.round(((current - previous) / previous) * 1000) / 10 : null;
  return { current, previous, pct };
}
function inRange(t: number, a: number, b: number): boolean {
  return t >= a && t < b;
}
function countIn(times: number[], a: number, b: number): number {
  let n = 0;
  for (const t of times) if (inRange(t, a, b)) n += 1;
  return n;
}

export class PlatformUsageService {
  constructor(
    private readonly operations: OperationRepository,
    private readonly sellers: SellerRepository,
    private readonly users: UserRepository,
    private readonly movements: MovementRepository,
    private readonly orders: OrderRepository,
    private readonly receipts: ReceiptOrderRepository,
    private readonly billing: BillingRepository,
    private readonly logins: LoginEventRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /** Registra un login exitoso (append-only). `at` por defecto = reloj del sistema. */
  async recordLogin(userId: string, operationId: string | null, at?: string): Promise<void> {
    const event: LoginEvent = {
      id: this.ids.next(),
      userId,
      operationId: operationId ?? null,
      at: at ?? this.clock.now(),
    };
    await this.logins.append(event);
  }

  /**
   * Última conexión (login) por usuario de una operación. Señal de presencia/actividad
   * reciente — insumo para saber quién está "activo" al asignar tareas.
   */
  async lastLoginByOperation(operationId: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const ev of await this.logins.list()) {
      if (ev.operationId !== operationId) continue;
      if (!out[ev.userId] || ev.at > out[ev.userId]) out[ev.userId] = ev.at;
    }
    return out;
  }

  /**
   * Nivel de uso de la plataforma para la ventana [ahora - spanDays, ahora), con el
   * comparativo contra el período anterior equivalente [ahora - 2·span, ahora - span).
   */
  async usage(spanDays: number, range?: { from: string; to: string }): Promise<PlatformUsage> {
    let days: number, now: number, span: number, curFrom: number, prevFrom: number;
    if (range) {
      const from = Date.parse(range.from);
      const to = Date.parse(range.to);
      if (!(to > from)) throw new Error('Rango de fechas inválido');
      now = to; span = to - from; curFrom = from; prevFrom = from - span;
      days = Math.max(1, Math.round(span / DAY));
    } else {
      days = Math.max(1, Math.floor(spanDays));
      now = Date.parse(this.clock.now());
      span = days * DAY;
      // Ventana actual y período anterior equivalente.
      curFrom = now - span;
      prevFrom = now - 2 * span;
    }
    const ms = (iso: string | null | undefined): number | null => {
      if (!iso) return null;
      const t = Date.parse(iso);
      return Number.isNaN(t) ? null : t;
    };

    const ops = await this.operations.list();
    const allLogins = await this.logins.list();

    // Índice de logins por operación (los del PLATFORM_ADMIN tienen operationId null).
    const loginsByOp = new Map<string, LoginEvent[]>();
    for (const ev of allLogins) {
      if (!ev.operationId) continue;
      const arr = loginsByOp.get(ev.operationId) ?? [];
      arr.push(ev);
      loginsByOp.set(ev.operationId, arr);
    }

    const operations: OperationUsage[] = [];
    for (const op of ops) {
      // Recolecta timestamps (una vez) y calcula ambas ventanas a partir de ellos.
      const opLogins = (loginsByOp.get(op.id) ?? []).map((e) => ({ t: ms(e.at), userId: e.userId })).filter((x) => x.t != null) as Array<{ t: number; userId: string }>;
      const movTimes: number[] = [];
      const createdTimes: number[] = [];
      const shippedTimes: number[] = [];
      const receiptTimes: number[] = [];
      const invoiceTimes: number[] = [];
      let last: number | null = null;
      const bump = (t: number | null) => {
        if (t != null && (last == null || t > last)) last = t;
      };
      opLogins.forEach((l) => bump(l.t));

      const sellers = await this.sellers.list(op.id);
      for (const s of sellers) {
        const movs = await this.movements.find({ sellerId: s.id });
        for (const m of movs) {
          const t = ms(m.occurredAt);
          if (t != null) { movTimes.push(t); bump(t); }
        }
        const ords = await this.orders.list(s.id);
        for (const o of ords) {
          for (const e of o.events || []) {
            const t = ms(e.at);
            if (t == null) continue;
            bump(t);
            if (e.type === 'CREATED') createdTimes.push(t);
            else if (e.type === 'SHIPPED') shippedTimes.push(t);
          }
        }
        const recs = await this.receipts.list(s.id);
        for (const r of recs) {
          for (const e of r.events || []) {
            const t = ms(e.at);
            if (t == null) continue;
            bump(t);
            if (typeof e.type === 'string' && e.type.indexOf('RECEPCIÓN') === 0) receiptTimes.push(t);
          }
        }
        const invs = await this.billing.listInvoices(s.id);
        for (const inv of invs) {
          const t = ms(inv.createdAt);
          if (t != null) { invoiceTimes.push(t); bump(t); }
        }
      }

      const totalUsers = (await this.users.list(op.id)).length;
      // Usuarios activos únicos por ventana.
      const activeCur = new Set(opLogins.filter((l) => inRange(l.t, curFrom, now)).map((l) => l.userId)).size;
      const activePrev = new Set(opLogins.filter((l) => inRange(l.t, prevFrom, curFrom)).map((l) => l.userId)).size;
      const rate = (active: number) => (totalUsers > 0 ? Math.round((active / totalUsers) * 1000) / 10 : 0);

      const loginsCur = countIn(opLogins.map((l) => l.t), curFrom, now);
      const movCur = countIn(movTimes, curFrom, now);
      const createdCur = countIn(createdTimes, curFrom, now);
      const shippedCur = countIn(shippedTimes, curFrom, now);
      const receiptCur = countIn(receiptTimes, curFrom, now);

      operations.push({
        operationId: op.id,
        operationName: op.name || op.id,
        logins: mk(loginsCur, countIn(opLogins.map((l) => l.t), prevFrom, curFrom)),
        activeUsers: mk(activeCur, activePrev),
        adoptionRate: mk(rate(activeCur), rate(activePrev)),
        movements: mk(movCur, countIn(movTimes, prevFrom, curFrom)),
        ordersCreated: mk(createdCur, countIn(createdTimes, prevFrom, curFrom)),
        ordersShipped: mk(shippedCur, countIn(shippedTimes, prevFrom, curFrom)),
        receipts: mk(receiptCur, countIn(receiptTimes, prevFrom, curFrom)),
        invoices: mk(countIn(invoiceTimes, curFrom, now), countIn(invoiceTimes, prevFrom, curFrom)),
        totalUsers,
        totalSellers: sellers.length,
        lastActivity: last == null ? null : new Date(last).toISOString(),
        dormant: loginsCur === 0 && movCur === 0 && createdCur === 0 && shippedCur === 0 && receiptCur === 0,
      });
    }

    // Orden: primero las más activas (logins actuales desc, luego actividad reciente).
    operations.sort((a, b) => {
      if (b.logins.current !== a.logins.current) return b.logins.current - a.logins.current;
      const ta = a.lastActivity ? Date.parse(a.lastActivity) : 0;
      const tb = b.lastActivity ? Date.parse(b.lastActivity) : 0;
      return tb - ta;
    });

    return { generatedAt: new Date(now).toISOString(), spanDays: days, totals: this.aggregate(operations), operations };
  }

  /** Consolida los totales de plataforma sumando actual y anterior sobre las operaciones. */
  private aggregate(ops: OperationUsage[]): PlatformTotals {
    const sum = (pick: (o: OperationUsage) => Metric): Metric => {
      let c = 0;
      let p = 0;
      for (const o of ops) {
        c += pick(o).current;
        p += pick(o).previous;
      }
      return mk(c, p);
    };
    const totalUsers = ops.reduce((a, o) => a + o.totalUsers, 0);
    const activeUsers = sum((o) => o.activeUsers);
    const rateOf = (active: number) => (totalUsers > 0 ? Math.round((active / totalUsers) * 1000) / 10 : 0);
    return {
      operations: ops.length,
      activeOperations: ops.filter((o) => !o.dormant).length,
      logins: sum((o) => o.logins),
      activeUsers,
      adoptionRate: mk(rateOf(activeUsers.current), rateOf(activeUsers.previous)),
      movements: sum((o) => o.movements),
      ordersCreated: sum((o) => o.ordersCreated),
      ordersShipped: sum((o) => o.ordersShipped),
      receipts: sum((o) => o.receipts),
      invoices: sum((o) => o.invoices),
      totalUsers,
      totalSellers: ops.reduce((a, o) => a + o.totalSellers, 0),
    };
  }
}
