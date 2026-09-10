/** Errores del dominio. Se mapean a códigos HTTP en la capa API. */

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
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
  constructor(message: string) {
    super('INSUFFICIENT_STOCK', message);
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
