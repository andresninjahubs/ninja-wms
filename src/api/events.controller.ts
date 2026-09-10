import { Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { actorOperation, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Event store consultable (G2+G6): línea de tiempo por orden, tiempos entre
 * estados, backfill histórico y verificación de paridad viejo(JSON) vs nuevo(tabla).
 */
@Controller('events')
export class EventsController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Línea de tiempo de una orden (por id interno o n° externo). */
  @Get('timeline/:sellerId/:orderRef')
  @RequirePermission('stock:read')
  timeline(@Param('sellerId') sellerId: string, @Param('orderRef') orderRef: string) {
    return this.wms.getOrderTimeline(sellerId, orderRef);
  }

  /** Verifica que las métricas viejas (JSON) y nuevas (tabla) coincidan. */
  @Get('parity')
  @RequirePermission('operation:manage')
  parity(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.verifyEventParity(actorOperation(user, operationId));
  }

  /** Backfill histórico: promueve los historiales existentes al event store. */
  @Post('backfill')
  @RequirePermission('operation:manage')
  backfill(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.backfillEvents(operationId ? actorOperation(user, operationId) : undefined);
  }
}
