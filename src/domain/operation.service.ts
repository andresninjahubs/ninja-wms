/**
 * OperationService — administra las OPERACIONES, el tenant de más alto nivel.
 * Solo el PLATFORM_ADMIN (Ninja Hubs) crea y lista operaciones; cada operación
 * es un mundo aislado (sus bodegas, sellers, usuarios e inventario).
 */
import { NotFoundError, ValidationError } from './errors';
import { IdGenerator, OperationRepository } from './ports';
import { DeadlineConfig } from './deadline';
import { Operation } from './types';

export class OperationService {
  constructor(
    private readonly operations: OperationRepository,
    private readonly ids: IdGenerator,
  ) {}

  async create(input: { id?: string; name: string; track?: 'brand' | 'operator' | null; selfServe?: boolean; planId?: string | null; trialPlan?: string | null; trialEndsAt?: string | null; contactName?: string | null; contactEmail?: string | null; contactPhone?: string | null; leadSource?: string | null; contactWebsite?: string | null; businessAbout?: string | null; createdAt?: string | null }): Promise<Operation> {
    if (!input.name || !input.name.trim()) throw new ValidationError('La operación necesita un nombre');
    const id = input.id ?? this.ids.next();
    if (await this.operations.findById(id)) throw new ValidationError(`Ya existe la operación ${id}`);
    const operation: Operation = {
      id,
      name: input.name.trim(),
      active: true,
      track: input.track ?? null,
      selfServe: input.selfServe ?? false,
      planId: input.planId ?? null,
      trialPlan: input.trialPlan ?? null,
      trialEndsAt: input.trialEndsAt ?? null,
      contactName: input.contactName ?? null,
      contactEmail: input.contactEmail ?? null,
      contactPhone: input.contactPhone ?? null,
      leadSource: input.leadSource ?? null,
      contactWebsite: input.contactWebsite ?? null,
      businessAbout: input.businessAbout ?? null,
      createdAt: input.createdAt ?? null,
    };
    await this.operations.save(operation);
    return operation;
  }

  /** Cambia el plan de una operación (grant manual del super-admin; sin pagos aún). */
  async setPlan(operationId: string, planId: string): Promise<Operation> {
    const op = await this.operations.findById(operationId);
    if (!op) throw new NotFoundError(`Operación no encontrada: ${operationId}`);
    // Fijar un plan pagado cierra cualquier trial vigente.
    const updated: Operation = { ...op, planId, trialPlan: null, trialEndsAt: null };
    await this.operations.save(updated);
    return updated;
  }

  async setAssignmentMode(operationId: string, mode: 'advisory' | 'strict'): Promise<Operation> {
    const op = await this.operations.findById(operationId);
    if (!op) throw new NotFoundError(`Operación no encontrada: ${operationId}`);
    const updated: Operation = { ...op, assignmentMode: mode };
    await this.operations.save(updated);
    return updated;
  }

  async setOperatorSelfPickup(operationId: string, on: boolean): Promise<Operation> {
    const op = await this.operations.findById(operationId);
    if (!op) throw new NotFoundError(`Operación no encontrada: ${operationId}`);
    const updated: Operation = { ...op, operatorSelfPickup: on };
    await this.operations.save(updated);
    return updated;
  }
  async setAutoBalance(operationId: string, on: boolean): Promise<Operation> {
    const op = await this.operations.findById(operationId);
    if (!op) throw new NotFoundError(`Operación no encontrada: ${operationId}`);
    const updated: Operation = { ...op, autoBalance: on };
    await this.operations.save(updated);
    return updated;
  }

  async get(operationId: string): Promise<Operation | null> {
    return this.operations.findById(operationId);
  }

  /**
   * Actualiza nombre, estado y datos de contacto de una operación.
   *
   * El contacto se corrige con `''` para borrarlo y con `undefined` para dejarlo como
   * está: si no se distinguieran, editar solo el nombre desde el panel borraría el
   * teléfono sin que nadie lo pidiera.
   */
  async update(operationId: string, patch: { name?: string; active?: boolean; contactName?: string | null; contactEmail?: string | null; contactPhone?: string | null; contactWebsite?: string | null; businessAbout?: string | null }): Promise<Operation> {
    const op = await this.operations.findById(operationId);
    if (!op) throw new NotFoundError(`Operación no encontrada: ${operationId}`);
    const texto = (v: string | null | undefined, actual: string | null | undefined): string | null =>
      v === undefined ? (actual ?? null) : (String(v).trim() || null);
    const updated: Operation = {
      ...op,
      name: patch.name != null && patch.name.trim() ? patch.name.trim() : op.name,
      active: patch.active != null ? patch.active : op.active,
      contactName: texto(patch.contactName, op.contactName),
      contactEmail: texto(patch.contactEmail, op.contactEmail),
      contactPhone: texto(patch.contactPhone, op.contactPhone),
      contactWebsite: texto(patch.contactWebsite, op.contactWebsite),
      businessAbout: texto(patch.businessAbout, op.businessAbout),
    };
    await this.operations.save(updated);
    return updated;
  }

  /**
   * Guarda la configuración de deadlines de preparación (cortes de courier, ventana de
   * riesgo y desfase horario de la bodega). Ver `domain/deadline.ts`.
   */
  async setDeadlineConfig(operationId: string, cfg: DeadlineConfig): Promise<Operation> {
    const op = await this.operations.findById(operationId);
    if (!op) throw new NotFoundError(`Operación no encontrada: ${operationId}`);
    const cortes = (cfg.cortes || [])
      .filter((c) => c && String(c.courier || '').trim() && /^\d{1,2}:\d{2}$/.test(String(c.hora || '').trim()))
      .map((c) => ({
        courier: String(c.courier).trim(),
        hora: String(c.hora).trim(),
        dias: Array.isArray(c.dias) && c.dias.length ? c.dias.map((d) => Number(d)).filter((d) => d >= 0 && d <= 6) : undefined,
      }));
    // Calendario y reglas por cliente: si no vienen en este guardado se CONSERVAN las
    // actuales (el modal de cortes no las conoce y no debe borrarlas).
    const prev = (op.deadlineConfig || {}) as DeadlineConfig;
    const diasHabiles = Array.isArray(cfg.diasHabiles)
      ? Array.from(new Set(cfg.diasHabiles.map((d) => Number(d)).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))).sort()
      : prev.diasHabiles;
    const feriados = Array.isArray(cfg.feriados)
      ? Array.from(new Set(cfg.feriados.map((f) => String(f).trim().slice(0, 10)).filter((f) => /^\d{4}-\d{2}-\d{2}$/.test(f)))).sort()
      : prev.feriados;
    const clientes = cfg.clientes !== undefined ? cfg.clientes : prev.clientes;
    const limpia: DeadlineConfig = {
      ...(cfg.offsetHoras == null ? (prev.offsetHoras == null ? {} : { offsetHoras: prev.offsetHoras }) : { offsetHoras: Number(cfg.offsetHoras) }),
      ...(cfg.riesgoHoras == null ? (prev.riesgoHoras == null ? {} : { riesgoHoras: prev.riesgoHoras }) : { riesgoHoras: Math.max(0, Number(cfg.riesgoHoras)) }),
      cortes: cfg.cortes === undefined ? (prev.cortes || []) : cortes,
      ...(diasHabiles ? { diasHabiles } : {}),
      ...(feriados ? { feriados } : {}),
      ...(clientes ? { clientes } : {}),
    };
    const updated: Operation = { ...op, deadlineConfig: limpia };
    await this.operations.save(updated);
    return updated;
  }

  async mustGet(operationId: string): Promise<Operation> {
    const op = await this.operations.findById(operationId);
    if (!op) throw new NotFoundError(`Operación no encontrada: ${operationId}`);
    if (!op.active) throw new ValidationError(`Operación inactiva: ${operationId}`);
    return op;
  }

  /** Marca el alta como revisada por la plataforma (no vuelve a aparecer en el popup). */
  async markReviewed(operationId: string, by: string, at: string): Promise<Operation> {
    const op = await this.operations.findById(operationId);
    if (!op) throw new NotFoundError(`Operación no encontrada: ${operationId}`);
    const updated: Operation = { ...op, reviewedAt: at, reviewedBy: by };
    await this.operations.save(updated);
    return updated;
  }

  /** Operaciones vigentes (sin las eliminadas). Con `includeDeleted` trae todas. */
  async list(opts?: { includeDeleted?: boolean }): Promise<Operation[]> {
    const all = await this.operations.list();
    return opts?.includeDeleted ? all : all.filter((o) => !o.deletedAt);
  }

  /** Borrado lógico: se oculta y se desactiva. Los datos quedan para restaurar o auditar. */
  async softDelete(operationId: string, by: string, at: string): Promise<Operation> {
    const op = await this.operations.findById(operationId);
    if (!op) throw new NotFoundError(`Operación no encontrada: ${operationId}`);
    if (op.deletedAt) throw new ValidationError(`La operación ${op.name || op.id} ya está eliminada.`);
    const updated: Operation = { ...op, active: false, deletedAt: at, deletedBy: by };
    await this.operations.save(updated);
    return updated;
  }

  /** Deshace el borrado lógico: vuelve a aparecer y queda activa. */
  async restore(operationId: string): Promise<Operation> {
    const op = await this.operations.findById(operationId);
    if (!op) throw new NotFoundError(`Operación no encontrada: ${operationId}`);
    if (!op.deletedAt) throw new ValidationError(`La operación ${op.name || op.id} no está eliminada.`);
    const updated: Operation = { ...op, active: true, deletedAt: null, deletedBy: null };
    await this.operations.save(updated);
    return updated;
  }
}
