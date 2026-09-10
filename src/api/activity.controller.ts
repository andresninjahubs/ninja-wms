import { Controller, Get, Inject, Query } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { actorOperation, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Registro de actividad por usuario (auditoría operativa).
 * Solo administradores y supervisores (master:manage). El PLATFORM_ADMIN puede
 * consultar cualquier operación indicando operationId; ADMIN/SUPERVISOR quedan
 * atados a su propia operación.
 */
@Controller('activity')
export class ActivityController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Feed cronológico + productividad por operador, filtrable por usuario y rango de fechas. */
  @Get()
  @RequirePermission('master:manage')
  activity(
    @CurrentUser() user: User | null,
    @Query('operationId') operationId?: string,
    @Query('userId') userId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const op = actorOperation(user, operationId);
    const fromMs = from ? Date.parse(from) : null;
    const toMs = to ? Date.parse(to) : null;
    const lim = limit ? parseInt(limit, 10) : undefined;
    return this.wms.userActivity(op, {
      userId: userId || null,
      from: fromMs != null && !Number.isNaN(fromMs) ? fromMs : null,
      to: toMs != null && !Number.isNaN(toMs) ? toMs : null,
      limit: lim && !Number.isNaN(lim) ? lim : undefined,
    });
  }
}
