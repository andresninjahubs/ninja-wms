import { Body, Controller, Get, Inject, Put, Query } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { actorOf, actorOperation, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { CostRateCard, User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Costos y rentabilidad (costeo por actividad + estándar/real). El tarifario de costos
 * y la rentabilidad son información de gestión: leer requiere `billing:read`; editar el
 * tarifario requiere supervisión (`master:manage`).
 */
@Controller('costs')
export class CostsController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Tarjeta de costos de la operación (con defaults si aún no se configuró). */
  @Get('rates')
  @RequirePermission('billing:manage')
  getRates(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.getCostRates(actorOperation(user, operationId));
  }

  /** Edita el tarifario de costos. */
  @Put('rates')
  @RequirePermission('master:manage')
  setRates(@CurrentUser() user: User | null, @Body() body: { operationId?: string } & Partial<CostRateCard>) {
    const { operationId, ...patch } = body || {};
    return this.wms.setCostRates(actorOperation(user, operationId), patch, actorOf(user));
  }

  /** Rentabilidad por cliente para un mes (year, month 1-12): ingreso vs. costo. */
  @Get('profitability')
  @RequirePermission('billing:manage')
  profitability(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('year') year?: string, @Query('month') month?: string, @Query('from') from?: string, @Query('to') to?: string) {
    const op = actorOperation(user, operationId);
    if (from && to) return this.wms.profitabilityRange(op, from, to);
    const now = new Date();
    const y = year ? parseInt(year, 10) : now.getUTCFullYear();
    const m = month ? parseInt(month, 10) : now.getUTCMonth() + 1;
    return this.wms.profitability(op, y, m);
  }

  /** Eficiencia de mano de obra estándar vs. real (por operario o por tipo de tarea). */
  @Get('efficiency')
  @RequirePermission('billing:manage')
  efficiency(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('year') year?: string, @Query('month') month?: string, @Query('groupBy') groupBy?: string) {
    const op = actorOperation(user, operationId);
    const now = new Date();
    const y = year ? parseInt(year, 10) : now.getUTCFullYear();
    const m = month ? parseInt(month, 10) : now.getUTCMonth() + 1;
    return this.wms.laborEfficiency(op, y, m, groupBy === 'type' ? 'type' : 'operator');
  }
}
