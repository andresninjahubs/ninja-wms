/**
 * CostingService — costeo por actividad (ABC) + estándar/real y rentabilidad.
 *
 * Modelo world-class de un 3PL: el costo sigue a las mismas actividades que se facturan.
 * La mano de obra (el costo directo dominante) se calcula de dos formas para poder
 * GESTIONAR LA EFICIENCIA:
 *   - ESTÁNDAR: unidades ÷ estándar u/h × tarifa estándar (lo que "debería" costar).
 *   - REAL: horas efectivas del LaborTask × tarifa cargada del operario (lo que costó).
 * La diferencia es la varianza de eficiencia — la palanca de gestión a nivel C-level.
 *
 * Almacenaje, embalaje y overhead completan el costo total. Ingreso (facturación) menos
 * costo = margen; se entrega margen ESTÁNDAR (objetivo) y REAL (efectivo) por cliente.
 */
import { duracionConfiable } from './labor.service';
import { BillingService } from './billing.service';
import { PackagingService } from './packaging.service';
import {
  Clock,
  CostRepository,
  LaborTaskRepository,
  MovementRepository,
  RollupRepository,
  SellerRepository,
  UserRepository,
} from './ports';
import {
  CostBreakdown,
  CostRateCard,
  LaborEfficiencyRow,
  LaborTask,
  SellerProfitability,
} from './types';

const H = 3600000;
const DAYS_PER_MONTH = 30;
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);
const r0 = (n: number) => Math.round(n);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** Estándares por defecto de unidades/hora por tipo de tarea (ingeniería de métodos). */
const DEFAULT_UPH: Record<string, number> = { PICK: 80, PUTAWAY: 60, PACK: 50, RECEIVE: 70, COUNT: 120, OTHER: 60 };

/** Tarjeta de costos por defecto (editable en el panel). Cifras placeholder en CLP. */
export function defaultCostCard(operationId: string, at: string): CostRateCard {
  return {
    operationId,
    currency: 'CLP',
    standardLaborRatePerHour: 4500, // tarifa cargada estándar (sueldo + leyes) por hora
    laborCostByRole: { OPERATOR: 4500, SUPERVISOR: 7000, ADMIN: 9000 },
    laborCostByOperator: {},
    standardUph: { ...DEFAULT_UPH },
    storageCostPerUnitMonth: 40, // costo de almacenaje por unidad-mes
    packagingCostRatio: 0.6, // el insumo cuesta ~60% de lo que se cobra
    monthlyOverhead: 0, // por defecto sin overhead hasta que el CD lo configure
    overheadDriver: 'laborHours',
    updatedAt: at,
    updatedBy: null,
  };
}

/** Horas trabajadas de un conjunto de tareas (misma lógica que LaborService.hoursFor). */
function hoursFor(tasks: LaborTask[]): number {
  const byDay = new Map<string, LaborTask[]>();
  for (const t of tasks) {
    const d = day(t.startAt);
    const a = byDay.get(d) || [];
    a.push(t);
    byDay.set(d, a);
  }
  let hours = 0;
  for (const arr of byDay.values()) {
    // El mismo criterio que LaborService: una duración con el reloj corrido no puede
    // entrar en la varianza de eficiencia, que es lo que después se factura.
    const captured = arr.filter(duracionConfiable);
    if (captured.length) {
      hours += captured.reduce((s, t) => s + (Date.parse(t.endAt) - Date.parse(t.startAt)) / H, 0);
    } else {
      const starts = arr.map((t) => Date.parse(t.startAt));
      hours += (Math.max(...starts) - Math.min(...starts)) / H;
    }
  }
  return hours;
}

export class CostingService {
  constructor(
    private readonly costs: CostRepository,
    private readonly sellers: SellerRepository,
    private readonly users: UserRepository,
    private readonly billing: BillingService,
    private readonly movements: MovementRepository,
    private readonly laborTasks: LaborTaskRepository,
    private readonly clock: Clock,
    private readonly rollups?: RollupRepository,
    private readonly packaging?: PackagingService,
  ) {}

  private now(): string {
    return this.clock ? this.clock.now() : new Date().toISOString();
  }

  async getCard(operationId: string): Promise<CostRateCard> {
    const c = await this.costs.getCard(operationId);
    return c ?? defaultCostCard(operationId, this.now());
  }

  async setCard(operationId: string, patch: Partial<CostRateCard>, by?: string): Promise<CostRateCard> {
    const cur = await this.getCard(operationId);
    const merged: CostRateCard = {
      ...cur,
      currency: patch.currency ?? cur.currency,
      standardLaborRatePerHour: num(patch.standardLaborRatePerHour, cur.standardLaborRatePerHour),
      laborCostByRole: { ...cur.laborCostByRole, ...(patch.laborCostByRole || {}) },
      laborCostByOperator: { ...cur.laborCostByOperator, ...(patch.laborCostByOperator || {}) },
      standardUph: { ...cur.standardUph, ...(patch.standardUph || {}) },
      storageCostPerUnitMonth: num(patch.storageCostPerUnitMonth, cur.storageCostPerUnitMonth),
      packagingCostRatio: clamp01(num(patch.packagingCostRatio, cur.packagingCostRatio)),
      monthlyOverhead: num(patch.monthlyOverhead, cur.monthlyOverhead),
      overheadDriver: patch.overheadDriver ?? cur.overheadDriver,
      operationId,
      updatedAt: this.now(),
      updatedBy: by ?? cur.updatedBy ?? null,
    };
    return this.costs.saveCard(merged);
  }

  /** Costo/hora efectivo de un operario: override por operario → por rol → estándar. */
  private rateOf(op: string, card: CostRateCard, roleByOp: Map<string, string>): number {
    if (card.laborCostByOperator[op] != null) return card.laborCostByOperator[op];
    const role = roleByOp.get(op);
    if (role && card.laborCostByRole[role] != null) return card.laborCostByRole[role];
    return card.laborCostByRole['OPERATOR'] ?? card.standardLaborRatePerHour;
  }

  private uph(type: string, card: CostRateCard): number {
    return card.standardUph[type] ?? DEFAULT_UPH[type] ?? DEFAULT_UPH.OTHER;
  }

  /** Horas estándar de un conjunto de tareas: Σ unidades_por_tipo ÷ estándar u/h del tipo. */
  private standardHoursOf(tasks: LaborTask[], card: CostRateCard): number {
    let h = 0;
    for (const t of tasks) h += t.units / this.uph(t.type, card);
    return h;
  }

  /** Unidades-mes de almacenaje de un cliente en la ventana (snapshots; fallback: on-hand actual). */
  private async storageUnitMonths(sellerId: string, from: string, to: string, windowDays: number): Promise<number> {
    if (this.rollups) {
      try {
        const snaps = await this.rollups.listInventorySnapshots(sellerId, { fromDate: day(from), toDate: day(to) });
        if (snaps.length) {
          const unitDays = snaps.reduce((s, x) => s + (x.total || 0), 0); // un snapshot por día por SKU
          if (unitDays > 0) return unitDays / DAYS_PER_MONTH;
        }
      } catch { /* sin snapshots: fallback */ }
    }
    // Fallback: on-hand físico actual × meses de la ventana.
    const bal = await this.movements.balances({ sellerId, includeZeros: false });
    const onHand = bal.reduce((s, b) => s + Math.max(0, b.qty), 0);
    return onHand * (windowDays / DAYS_PER_MONTH);
  }

  /**
   * Rentabilidad por cliente en un período: ingreso (facturación) vs. costo (ABC),
   * con costo de mano de obra estándar y real (varianza de eficiencia).
   */
  async profitability(operationId: string, fromISO: string, toISO: string): Promise<{
    window: { from: string; to: string; days: number };
    currency: string;
    sellers: SellerProfitability[];
    totals: {
      revenue: number; laborStandard: number; laborReal: number; laborVariance: number;
      storage: number; packaging: number; overhead: number;
      totalStandard: number; totalReal: number; marginStandard: number; marginReal: number;
      marginPctStandard: number | null; marginPctReal: number | null;
    };
  }> {
    const card = await this.getCard(operationId);
    const from = Date.parse(fromISO);
    const to = Date.parse(toISO);
    const windowDays = Math.max(1, (to - from) / (24 * H));
    const monthsInWindow = windowDays / DAYS_PER_MONTH;

    const sellers = await this.sellers.list(operationId);
    const users = await this.users.list(operationId);
    const roleByOp = new Map<string, string>();
    for (const u of users) { roleByOp.set(u.id, u.role); if (u.email) roleByOp.set(u.email, u.role); }

    // Tareas de mano de obra de la operación en la ventana (una sola lectura).
    const allTasks = await this.laborTasks.list(operationId, { from: fromISO, to: toISO });
    const tasksBySeller = new Map<string, LaborTask[]>();
    for (const t of allTasks) {
      const sid = t.sellerId || '';
      const a = tasksBySeller.get(sid) || [];
      a.push(t);
      tasksBySeller.set(sid, a);
    }

    // --- Pasada 1: costo directo por cliente + acumular drivers para prorratear overhead.
    type Row = { seller: typeof sellers[number]; revenue: number; laborStandard: number; laborReal: number; storage: number; packaging: number; laborHours: number; unitMonths: number };
    const rows: Row[] = [];
    for (const seller of sellers) {
      let revenue = 0;
      try { revenue = (await this.billing.computeInvoice(seller.id, fromISO, toISO)).total; } catch { revenue = 0; }

      const tasks = tasksBySeller.get(seller.id) || [];
      const byOp = new Map<string, LaborTask[]>();
      for (const t of tasks) { const a = byOp.get(t.operator) || []; a.push(t); byOp.set(t.operator, a); }
      let laborReal = 0;
      let laborHours = 0;
      for (const [op, list] of byOp) {
        const h = hoursFor(list);
        laborHours += h;
        laborReal += h * this.rateOf(op, card, roleByOp);
      }
      const standardHours = this.standardHoursOf(tasks, card);
      const laborStandard = standardHours * card.standardLaborRatePerHour;

      const unitMonths = await this.storageUnitMonths(seller.id, fromISO, toISO, windowDays);
      const storage = unitMonths * card.storageCostPerUnitMonth;

      let packaging = 0;
      if (this.packaging) {
        try {
          // Costo real (PMP registrado en cada reposición) cuando existe; si los consumos no
          // tienen costo (histórico), se estima como % de lo cobrado (packagingCostRatio).
          const real = await this.packaging.consumptionCost(operationId, seller.id, fromISO, toISO);
          if (real.cost > 0) packaging = real.cost;
          else {
            const emb = await this.packaging.consumptionForBilling(operationId, seller.id, fromISO, toISO);
            packaging = emb.reduce((s, e) => s + e.amount, 0) * card.packagingCostRatio;
          }
        } catch { packaging = 0; }
      }
      rows.push({ seller, revenue, laborStandard, laborReal, storage, packaging, laborHours, unitMonths });
    }

    // --- Overhead: pool del período prorrateado por el driver elegido.
    const overheadPool = Math.max(0, card.monthlyOverhead) * monthsInWindow;
    const driverVal = (r: Row) => card.overheadDriver === 'unitMonths' ? r.unitMonths : card.overheadDriver === 'orders' ? r.unitMonths : r.laborHours;
    const driverTotal = rows.reduce((s, r) => s + driverVal(r), 0);

    // --- Pasada 2: armar rentabilidad por cliente.
    const out: SellerProfitability[] = rows.map((r) => {
      const overhead = driverTotal > 0 ? overheadPool * (driverVal(r) / driverTotal) : overheadPool / Math.max(1, rows.length);
      const cost: CostBreakdown = {
        laborStandard: r0(r.laborStandard),
        laborReal: r0(r.laborReal),
        laborVariance: r0(r.laborReal - r.laborStandard),
        storage: r0(r.storage),
        packaging: r0(r.packaging),
        overhead: r0(overhead),
        totalStandard: r0(r.laborStandard + r.storage + r.packaging + overhead),
        totalReal: r0(r.laborReal + r.storage + r.packaging + overhead),
      };
      const marginStandard = r0(r.revenue - cost.totalStandard);
      const marginReal = r0(r.revenue - cost.totalReal);
      return {
        sellerId: r.seller.id,
        sellerName: r.seller.name,
        currency: card.currency,
        revenue: r0(r.revenue),
        cost,
        marginStandard,
        marginReal,
        marginPctStandard: r.revenue > 0 ? r1((marginStandard / r.revenue) * 100) : null,
        marginPctReal: r.revenue > 0 ? r1((marginReal / r.revenue) * 100) : null,
      };
    }).sort((a, b) => a.marginReal - b.marginReal); // los de peor margen primero (los que hay que gestionar)

    const sum = (f: (s: SellerProfitability) => number) => out.reduce((s, x) => s + f(x), 0);
    const revenue = sum((s) => s.revenue);
    const laborStandard = sum((s) => s.cost.laborStandard);
    const laborReal = sum((s) => s.cost.laborReal);
    const storage = sum((s) => s.cost.storage);
    const packaging = sum((s) => s.cost.packaging);
    const overhead = sum((s) => s.cost.overhead);
    const totalStandard = laborStandard + storage + packaging + overhead;
    const totalReal = laborReal + storage + packaging + overhead;
    const marginStandard = revenue - totalStandard;
    const marginReal = revenue - totalReal;

    return {
      window: { from: fromISO, to: toISO, days: Math.round(windowDays) },
      currency: card.currency,
      sellers: out,
      totals: {
        revenue: r0(revenue), laborStandard: r0(laborStandard), laborReal: r0(laborReal), laborVariance: r0(laborReal - laborStandard),
        storage: r0(storage), packaging: r0(packaging), overhead: r0(overhead),
        totalStandard: r0(totalStandard), totalReal: r0(totalReal),
        marginStandard: r0(marginStandard), marginReal: r0(marginReal),
        marginPctStandard: revenue > 0 ? r1((marginStandard / revenue) * 100) : null,
        marginPctReal: revenue > 0 ? r1((marginReal / revenue) * 100) : null,
      },
    };
  }

  /**
   * Eficiencia de mano de obra estándar vs. real, agrupada por operario o por tipo de
   * tarea. Es el tablero de gestión: dónde se está por sobre o bajo el estándar.
   */
  async laborEfficiency(operationId: string, fromISO: string, toISO: string, groupBy: 'operator' | 'type' = 'operator'): Promise<{
    window: { from: string; to: string };
    currency: string;
    groupBy: 'operator' | 'type';
    rows: LaborEfficiencyRow[];
    totals: { units: number; realHours: number; standardHours: number; efficiencyPct: number | null; realCost: number; standardCost: number; variance: number };
  }> {
    const card = await this.getCard(operationId);
    const users = await this.users.list(operationId);
    const roleByOp = new Map<string, string>();
    const nameByOp = new Map<string, string>();
    for (const u of users) { roleByOp.set(u.id, u.role); if (u.email) roleByOp.set(u.email, u.role); nameByOp.set(u.id, u.name); if (u.email) nameByOp.set(u.email, u.name); }

    const tasks = await this.laborTasks.list(operationId, { from: fromISO, to: toISO });
    const groups = new Map<string, LaborTask[]>();
    for (const t of tasks) {
      const key = groupBy === 'operator' ? t.operator : t.type;
      const a = groups.get(key) || [];
      a.push(t);
      groups.set(key, a);
    }

    const rows: LaborEfficiencyRow[] = [...groups.entries()].map(([key, list]) => {
      const units = list.reduce((s, t) => s + t.units, 0);
      const standardHours = this.standardHoursOf(list, card);
      let realHours: number;
      let realCost: number;
      if (groupBy === 'operator') {
        realHours = hoursFor(list);
        realCost = realHours * this.rateOf(key, card, roleByOp);
      } else {
        // Por tipo: sumar sobre operarios para respetar la tarifa de cada uno.
        const byOp = new Map<string, LaborTask[]>();
        for (const t of list) { const a = byOp.get(t.operator) || []; a.push(t); byOp.set(t.operator, a); }
        realHours = 0; realCost = 0;
        for (const [op, l] of byOp) { const h = hoursFor(l); realHours += h; realCost += h * this.rateOf(op, card, roleByOp); }
      }
      const standardCost = standardHours * card.standardLaborRatePerHour;
      return {
        key,
        label: groupBy === 'operator' ? (nameByOp.get(key) || key) : key,
        units,
        realHours: r1(realHours),
        standardHours: r1(standardHours),
        efficiencyPct: realHours > 0 ? r1((standardHours / realHours) * 100) : null,
        realCost: r0(realCost),
        standardCost: r0(standardCost),
        variance: r0(realCost - standardCost),
      };
    }).sort((a, b) => b.variance - a.variance); // mayor sobrecosto primero

    const units = rows.reduce((s, r) => s + r.units, 0);
    const realHours = rows.reduce((s, r) => s + r.realHours, 0);
    const standardHours = rows.reduce((s, r) => s + r.standardHours, 0);
    const realCost = rows.reduce((s, r) => s + r.realCost, 0);
    const standardCost = rows.reduce((s, r) => s + r.standardCost, 0);
    return {
      window: { from: fromISO, to: toISO },
      currency: card.currency,
      groupBy,
      rows,
      totals: {
        units,
        realHours: r1(realHours),
        standardHours: r1(standardHours),
        efficiencyPct: realHours > 0 ? r1((standardHours / realHours) * 100) : null,
        realCost: r0(realCost),
        standardCost: r0(standardCost),
        variance: r0(realCost - standardCost),
      },
    };
  }
}

function num(v: number | undefined, fallback: number): number {
  return typeof v === 'number' && isFinite(v) && v >= 0 ? v : fallback;
}
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
