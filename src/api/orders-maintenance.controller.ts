import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { actorOperation, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Mantención de idempotencia de órdenes (G1): auditar y consolidar duplicados
 * por (sellerId, externalOrderId). Solo administración de operación / plataforma.
 */
@Controller('maintenance/orders')
export class OrdersMaintenanceController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Lista los grupos de órdenes duplicadas por referencia externa. */
  @Get('duplicates')
  @RequirePermission('operation:manage')
  duplicates(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.auditDuplicateOrders(actorOperation(user, operationId));
  }

  /** Consolida los duplicados: conserva el más antiguo y elimina el resto. */
  @Post('consolidate-duplicates')
  @RequirePermission('operation:manage')
  consolidate(@CurrentUser() user: User | null, @Body() body: { operationId?: string }) {
    return this.wms.consolidateDuplicateOrders(actorOperation(user, body?.operationId));
  }
}
