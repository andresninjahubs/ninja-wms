import { Body, Controller, Get, Inject, Param, Patch } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { WebhookAccessDto } from './dto';
import { RequirePermission } from './auth/permissions.decorator';
import { WMS_FACADE } from './tokens';

/**
 * Mantenedor del administrador: habilita/deshabilita, POR CLIENTE, el acceso al
 * panel de webhooks. Las rutas llevan :operationId/:sellerId para que el guard
 * valide la frontera de operación (un ADMIN solo actúa sobre su operación; el
 * PLATFORM_ADMIN sobre cualquiera). Exige el permiso webhook:admin.
 */
@Controller()
export class WebhooksAdminController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Clientes de la operación con su flag de acceso al panel de webhooks. */
  @Get('operations/:operationId/webhook-clients')
  @RequirePermission('webhook:admin')
  listClients(@Param('operationId') operationId: string) {
    return this.wms.listWebhookClients(operationId);
  }

  /** Activa/desactiva el acceso del cliente (seller) al panel de webhooks. */
  @Patch('sellers/:sellerId/webhooks-access')
  @RequirePermission('webhook:admin')
  setAccess(@Param('sellerId') sellerId: string, @Body() dto: WebhookAccessDto) {
    return this.wms.setSellerWebhooksAccess(sellerId, dto.enabled);
  }
}
