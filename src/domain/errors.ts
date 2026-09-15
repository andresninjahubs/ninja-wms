/** Errores del dominio. Se mapean a códigos HTTP en la capa API. */

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    /** Datos estructurados del error, para que la interfaz pueda mostrarlo bien. */
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

/** El recurso no existe o no pertenece al seller (aislamiento multi-tenant). */
export class NotFoundError extends DomainError {
  constructor(message: string) {
    super('NOT_FOUND', message);
  }
}

/** Intento de dejar un bucket en negativo: se prohíbe siempre. */
export class InsufficientStockError extends DomainError {
  constructor(message: string, data?: unknown) {
    super('INSUFFICIENT_STOCK', message, data);
  }
}

/** Un producto que falta para poder reservar una orden. */
export interface StockShortage {
  sku: string;
  descripcion: string | null;
  lot: string | null;
  requerido: number;      // unidades que pide la orden
  reservable: number;     // unidades disponibles en almacenaje/picking
  falta: number;          // requerido - reservable
  enRecepcion: number;    // unidades en el dock de recepción, aún sin guardar
  enOtrasZonas: number;   // cuarentena, despacho u otras zonas no reservables
  /** Qué recepciones trajeron lo que hoy está en el dock, y cuánto de cada una. */
  recepciones?: Array<{ id: string; referencia: string | null; proveedor: string | null; fecha: string; cantidad: number }>;
}

/**
 * La orden no se puede reservar porque falta stock. A diferencia de un error suelto,
 * lleva TODOS los productos que faltan (no solo el primero) y de dónde salió el número,
 * para que la pantalla pueda decir qué hacer: casi siempre, guardar lo que está en recepción.
 */
export class StockShortageError extends InsufficientStockError {
  constructor(
    message: string,
    public readonly faltantes: StockShortage[],
    public readonly orden: string | null = null,
  ) {
    super(message, { orden, faltantes });
  }
}

/** Datos inválidos (cantidades <= 0, estados incompatibles, etc). */
export class ValidationError extends DomainError {
  constructor(message: string) {
    super('VALIDATION', message);
  }
}

/** Violación de la frontera entre sellers. */
export class TenantViolationError extends DomainError {
  constructor(message: string) {
    super('TENANT_VIOLATION', message);
  }
}

/** No autenticado: falta identidad de usuario válida. */
export class UnauthorizedError extends DomainError {
  constructor(message: string) {
    super('UNAUTHORIZED', message);
  }
}

/** Autenticado pero sin permiso para la acción (rol insuficiente o fuera de su seller). */
export class ForbiddenError extends DomainError {
  constructor(message: string) {
    super('FORBIDDEN', message);
  }
}

/**
 * La acción excede el plan de la cuenta (límite de uso alcanzado o feature no incluido).
 * Se mapea a HTTP 402 para que el front la distinga y ofrezca mejorar de plan.
 */
export class PlanLimitError extends DomainError {
  constructor(message: string) {
    super('PLAN_LIMIT', message);
  }
}
