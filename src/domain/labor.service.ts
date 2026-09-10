/**
 * LaborService (G4) — productividad de mano de obra (LaborTask).
 *
 * Arranca DERIVANDO tareas del ledger (movimientos PICK: actor + occurredAt) sin
 * necesidad de instrumentar todo, y admite tareas CAPTURADAS por la PWA del operario
 * con inicio/fin reales. Expone productividad por operador y por tipo de tarea
 * (unidades/hora) y una serie diaria lista como input del forecast de mano de obra.
 */
import { Clock, IdGenerator, LaborTaskRepository, MovementRepository, SellerRepository } from './ports';
import { LaborTask, LaborTaskType, MovementType } from './types';

const H = 3600000;
function day(iso: string): string { return new Date(iso).toISOString().slice(0, 10); }

/** Horas trabajadas de un conjunto de tareas, agrupando por día: usa la duración real
 *  (tareas capturadas) o, en su defecto, el span de la sesión (tareas derivadas). */
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
    // Tareas CAPTURADAS (con inicio/fin reales): la hora trabajada es la suma de sus
    // duraciones — así unidades/hora refleja la velocidad real del operario.
    const captured = arr.filter((t) => Date.parse(t.endAt) > Date.parse(t.startAt));
    if (captured.length) {
      hours += captured.reduce((s, t) => s + (Date.parse(t.endAt) - Date.parse(t.startAt)) / H, 0);
    } else {
      // Sólo tareas derivadas del ledger (un timestamp): se estima por el span de la sesión.
      const starts = arr.map((t) => Date.parse(t.startAt));
      hours += (Math.max(...starts) - Math.min(...starts)) / H;
    }
  }
  return hours;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

export class LaborService {
  constructor(
    private readonly movements: MovementRepository,
    private readonly sellers: SellerRepository,
    private readonly laborTasks: LaborTaskRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /**
   * Deriva LaborTasks desde el ledger (movimientos PICK). Idempotente: el id es
   * `PICK:${movementId}`, así que re-derivar no duplica.
   */
  async deriveFromLedger(operationId: string): Promise<{ derived: number }> {
    const sellerIds = (await this.sellers.list(operationId)).map((s) => s.id);
    const tasks: LaborTask[] = [];
    for (const sid of sellerIds) {
      const movs = await this.movements.find({ sellerId: sid });
      for (const m of movs) {
        if (m.type !== MovementType.PICK) continue;
        tasks.push({
          id: `PICK:${m.id}`,
          operationId,
          sellerId: sid,
          operator: m.actor || 'system',
          type: 'PICK',
          startAt: m.occurredAt,
          endAt: m.occurredAt, // el ledger sólo tiene un timestamp
          units: Math.abs(m.qtyDelta),
          orderRef: m.reference ?? null,
          locationId: m.locationId ?? null,
          source: 'ledger',
        });
      }
    }
    await this.laborTasks.append(tasks);
    return { derived: tasks.length };
  }

  /** Registra una tarea CAPTURADA por la PWA (inicio/fin reales). */
  async capture(input: {
    operationId: string; sellerId?: string | null; operator: string; type: LaborTaskType;
    startAt: string; endAt: string; units: number; orderRef?: string | null; locationId?: string | null;
  }): Promise<LaborTask> {
    const task: LaborTask = {
      id: `labor:${this.ids.next()}`,
      operationId: input.operationId,
      sellerId: input.sellerId ?? null,
      operator: input.operator,
      type: input.type,
      startAt: input.startAt,
      endAt: input.endAt,
      units: Math.max(0, Math.round(input.units || 0)),
      orderRef: input.orderRef ?? null,
      locationId: input.locationId ?? null,
      source: 'captured',
    };
    await this.laborTasks.append([task]);
    return task;
  }

  /**
   * Reporte de productividad por operador (y por tipo de tarea) en una ventana.
   * unidades/hora usa la duración real cuando existe (capturado) y el span de sesión
   * diaria cuando la tarea viene derivada del ledger.
   */
  async productivityByOperator(
    operationId: string,
    opts?: { from?: string; to?: string; operator?: string | null },
  ): Promise<{
    window: { from: string | null; to: string | null };
    operators: Array<{
      operator: string;
      tasks: number;
      units: number;
      hoursWorked: number;
      unitsPerHour: number | null;
      byType: Array<{ type: string; tasks: number; units: number; hoursWorked: number; unitsPerHour: number | null }>;
    }>;
  }> {
    const tasks = await this.laborTasks.list(operationId, { from: opts?.from, to: opts?.to, operator: opts?.operator ?? null });
    const byOperator = new Map<string, LaborTask[]>();
    for (const t of tasks) {
      const a = byOperator.get(t.operator) || [];
      a.push(t);
      byOperator.set(t.operator, a);
    }
    const operators = [...byOperator.entries()].map(([operator, list]) => {
      const units = list.reduce((s, t) => s + t.units, 0);
      const hoursWorked = hoursFor(list);
      const byTypeMap = new Map<string, LaborTask[]>();
      for (const t of list) { const a = byTypeMap.get(t.type) || []; a.push(t); byTypeMap.set(t.type, a); }
      const byType = [...byTypeMap.entries()].map(([type, tl]) => {
        const u = tl.reduce((s, t) => s + t.units, 0);
        const h = hoursFor(tl);
        return { type, tasks: tl.length, units: u, hoursWorked: r1(h), unitsPerHour: h > 0 ? r1(u / h) : null };
      }).sort((a, b) => b.units - a.units);
      return {
        operator,
        tasks: list.length,
        units,
        hoursWorked: r1(hoursWorked),
        unitsPerHour: hoursWorked > 0 ? r1(units / hoursWorked) : null,
        byType,
      };
    }).sort((a, b) => b.units - a.units);
    return { window: { from: opts?.from ?? null, to: opts?.to ?? null }, operators };
  }

  /**
   * Serie diaria (por operador) lista como input del forecast de mano de obra:
   * unidades y horas trabajadas por día.
   */
  async laborSeries(
    operationId: string,
    opts?: { from?: string; to?: string; operator?: string | null },
  ): Promise<Array<{ date: string; operator: string; tasks: number; units: number; hoursWorked: number; unitsPerHour: number | null }>> {
    const tasks = await this.laborTasks.list(operationId, { from: opts?.from, to: opts?.to, operator: opts?.operator ?? null });
    const byKey = new Map<string, LaborTask[]>();
    for (const t of tasks) {
      const key = `${day(t.startAt)}::${t.operator}`;
      const a = byKey.get(key) || [];
      a.push(t);
      byKey.set(key, a);
    }
    const rows = [...byKey.entries()].map(([key, list]) => {
      const [date, operator] = key.split('::');
      const units = list.reduce((s, t) => s + t.units, 0);
      const h = hoursFor(list);
      return { date, operator, tasks: list.length, units, hoursWorked: r1(h), unitsPerHour: h > 0 ? r1(units / h) : null };
    });
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.operator < b.operator ? -1 : 1));
    return rows;
  }
}
