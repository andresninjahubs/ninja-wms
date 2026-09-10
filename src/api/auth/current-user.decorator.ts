import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { User } from '../../domain/types';
import { ValidationError } from '../../domain/errors';

/** Inyecta el usuario autenticado (o null en modo demo sin token). */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): User | null => {
    return ctx.switchToHttp().getRequest().user ?? null;
  },
);

/** actor para el ledger: el id del usuario autenticado, o 'system' en modo demo. */
export const actorOf = (user: User | null): string => user?.id ?? 'system';

/**
 * Operación sobre la que se crea un recurso (seller, ubicación).
 * - Staff de una operación: se usa SU operación (no puede elegir otra).
 * - PLATFORM_ADMIN (sin operación): debe indicar operationId en el cuerpo.
 * - Modo demo sin usuario: se acepta operationId del cuerpo.
 */
export const actorOperation = (user: User | null, bodyOperationId?: string): string => {
  if (user && user.operationId) return user.operationId; // atado a su operación
  if (bodyOperationId) return bodyOperationId; // plataforma / demo
  throw new ValidationError('Falta operationId: indica la operación destino');
};
