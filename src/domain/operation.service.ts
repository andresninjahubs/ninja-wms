/**
 * OperationService — administra las OPERACIONES, el tenant de más alto nivel.
 * Solo el PLATFORM_ADMIN (Ninja Hubs) crea y lista operaciones; cada operación
 * es un mundo aislado (sus bodegas, sellers, usuarios e inventario).
 */
import { NotFoundError, ValidationError } from './errors';
import { IdGenerator, OperationRepository } from './ports';
import { Operation } from './types';

export class OperationService {
  constructor(
    private readonly operations: OperationRepository,
    private readonly ids: IdGenerator,
  ) {}

  async create(input: { id?: string; name: string; track?: 'brand' | 'operator' | null; selfServe?: boolean; planId?: string | null; trialPlan?: string | null; trialEndsAt?: string | null }): Promise<Operation> {
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

  /** Actualiza nombre y/o estado (activar/desactivar) de una operación. */
  async update(operationId: string, patch: { name?: string; active?: boolean }): Promise<Operation> {
    const op = await this.operations.findById(operationId);
    if (!op) throw new NotFoundError(`Operación no encontrada: ${operationId}`);
    const updated: Operation = {
      ...op,
      name: patch.name != null && patch.name.trim() ? patch.name.trim() : op.name,
      active: patch.active != null ? patch.active : op.active,
    };
    await this.operations.save(updated);
    return updated;
  }

  async mustGet(operationId: string): Promise<Operation> {
    const op = await this.operations.findById(operationId);
    if (!op) throw new NotFoundError(`Operación no encontrada: ${operationId}`);
    if (!op.active) throw new ValidationError(`Operación inactiva: ${operationId}`);
    return op;
  }

  async list(): Promise<Operation[]> {
    return this.operations.list();
  }
}
