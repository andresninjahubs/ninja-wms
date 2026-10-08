import { Body, Controller, Inject, Post } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { actorOf, actorOperation, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Picking por ruta (app del operario): un pedido o un lote de pedidos recorridos
 * por ubicación. En lote se pickea todo junto y se separa en empaque.
 */
@Controller('picking')
export class PickingController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Ruta consolidada: paradas en orden de recorrido con lo que se toma en cada una. */
  @Post('route')
  @RequirePermission('stock:read')
  route(@CurrentUser() user: User | null, @Body() body: { operationId?: string; orders: Array<{ sellerId: string; orderId: string }> }) {
    return this.wms.pickRoute(actorOperation(user, body?.operationId), Array.isArray(body?.orders) ? body.orders : []);
  }

  /** Toma N unidades de un producto en una ubicación y las reparte entre los pedidos. */
  @Post('pick')
  @RequirePermission('order:fulfill')
  pick(@CurrentUser() user: User | null, @Body() body: { operationId?: string; sellerId: string; sku: string; locationId: string; lot?: string | null; qty: number; orderIds: string[] }) {
    return this.wms.pickConsolidated(actorOperation(user, body?.operationId), {
      sellerId: body.sellerId, sku: body.sku, locationId: body.locationId, lot: body.lot ?? null, qty: body.qty, orderIds: Array.isArray(body.orderIds) ? body.orderIds : [],
    }, actorOf(user));
  }

  /** Faltante: deja lo pendiente en el pedido y avisa al supervisor con una alerta. */
  @Post('shortage')
  @RequirePermission('order:fulfill')
  shortage(@CurrentUser() user: User | null, @Body() body: { operationId?: string; sellerId: string; sku: string; locationId: string; lot?: string | null; qty: number; orderIds: string[]; nota?: string | null }) {
    return this.wms.reportPickShortage(actorOperation(user, body?.operationId), {
      sellerId: body.sellerId, sku: body.sku, locationId: body.locationId, lot: body.lot ?? null, qty: body.qty, orderIds: Array.isArray(body.orderIds) ? body.orderIds : [], nota: body.nota ?? null,
    }, actorOf(user) || 'operario');
  }
}
