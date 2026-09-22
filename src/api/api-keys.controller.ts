import { Body, Controller, Delete, Get, Inject, Param, Post } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { CurrentUser, actorOf } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { UnauthorizedError } from '../domain/errors';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Llaves de API del usuario autenticado (para clientes MCP e integraciones).
 *
 * Cada quien administra SOLO las suyas: no hay ruta para ver ni revocar las de
 * otro, ni siquiera siendo administrador. Una llave es una credencial personal,
 * como una contraseña, y quien quiera cortarle el acceso a alguien lo desactiva
 * como usuario —eso invalida sus llaves de inmediato— en vez de hurguetearle las
 * credenciales.
 */
@Controller('me/api-keys')
export class ApiKeysController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  private yo(user: User | null): string {
    if (!user) throw new UnauthorizedError('Necesitas iniciar sesión para administrar tus llaves');
    return user.id;
  }

  @Get()
  @RequirePermission('stock:read')
  list(@CurrentUser() user: User | null) {
    return this.wms.listApiKeys(this.yo(user));
  }

  /** Emite una llave. El secreto viaja en esta respuesta y en ninguna otra. */
  @Post()
  @RequirePermission('stock:read')
  create(@Body() dto: { label: string; scope?: 'read' | 'write'; diasVigencia?: number | null; operationId?: string | null }, @CurrentUser() user: User | null) {
    return this.wms.createApiKey(this.yo(user), { label: dto?.label, scope: dto?.scope, diasVigencia: dto?.diasVigencia ?? null, operationId: dto?.operationId ?? null }, actorOf(user));
  }

  @Delete(':id')
  @RequirePermission('stock:read')
  revoke(@Param('id') id: string, @CurrentUser() user: User | null) {
    return this.wms.revokeApiKey(this.yo(user), id);
  }
}
