import { CanActivate, ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnauthorizedError } from '../../domain/errors';
import { Permission } from '../../domain/types';
import { WmsFacade } from '../../app/wms.facade';
import { WMS_FACADE } from '../tokens';
import { PERMISSION_KEY } from './permissions.decorator';

/**
 * Guard de identidad + autorización.
 *
 * Resuelve el usuario desde `Authorization: Bearer <token>` o `x-user-id`
 * (skeleton: el token es el id o email del usuario) y lo adjunta a la request.
 *
 * Si el endpoint declara @RequirePermission, exige que el usuario lo tenga
 * y respete la frontera de su seller (param :sellerId).
 *
 * Modo:
 *  - AUTH_REQUIRED=true  -> todo endpoint protegido exige token válido (producción).
 *  - AUTH_REQUIRED!=true -> sin token, la acción corre como 'system' (demo/dev).
 *    Con token presente, SIEMPRE se aplica la autorización (para poder demostrarla).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(WMS_FACADE) private readonly wms: WmsFacade,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    const token = this.extractToken(req);
    const authRequired = process.env.AUTH_REQUIRED === 'true';
    // Resuelve por JWT (login real) y, en modo demo, acepta el id/email como token.
    const user = token ? await this.wms.resolveToken(token, !authRequired) : null;
    req.user = user;

    const permission = this.reflector.get<Permission>(PERMISSION_KEY, ctx.getHandler());

    if (!permission) return true; // endpoint público (health, login)

    if (!user) {
      if (authRequired) throw new UnauthorizedError('Falta token de usuario válido');
      return true; // modo demo: corre como 'system'
    }

    const targetSellerId: string | null = req.params?.sellerId ?? null;
    const targetOperationId: string | null = req.params?.operationId ?? null;
    // Frontera de operación + seller. Async: puede resolver la operación desde el seller.
    await this.wms.authorize(user, permission, {
      sellerId: targetSellerId,
      operationId: targetOperationId,
    }); // lanza ForbiddenError si no procede
    return true;
  }

  private extractToken(req: any): string | null {
    const auth = req.headers?.authorization as string | undefined;
    if (auth && auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
    const xUser = req.headers?.['x-user-id'];
    return typeof xUser === 'string' && xUser ? xUser : null;
  }
}
