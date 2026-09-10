import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { actorOf, actorOperation, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { LaborTaskType, User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Rollups diarios (G3) y productividad de mano de obra (G4). Los jobs de rollup y la
 * derivación de labor los dispara un cron (o el admin); las lecturas alimentan el
 * dashboard y el forecasting.
 */
@Controller()
export class AnalyticsController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  // ---- G3: rollups --------------------------------------------------------

  /** Corre el job de rollup diario (o rango). Lo llama el cron o el admin. */
  @Post('rollups/run')
  @RequirePermission('operation:manage')
  runRollups(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('date') date?: string, @Query('fromDate') fromDate?: string, @Query('toDate') toDate?: string) {
    return this.wms.runRollups(actorOperation(user, operationId), { date, fromDate, toDate });
  }

  /** Backfill de rollups desde todo el historial del ledger. */
  @Post('rollups/backfill')
  @RequirePermission('operation:manage')
  backfillRollups(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.backfillRollups(actorOperation(user, operationId));
  }

  /** Serie de demanda diaria por SKU — input directo del forecasting. */
  @Get('sellers/:sellerId/demand')
  @RequirePermission('stock:read')
  demand(@Param('sellerId') sellerId: string, @Query('sku') sku?: string, @Query('fromDate') fromDate?: string, @Query('toDate') toDate?: string) {
    return this.wms.getDemandSeries(sellerId, { sku: sku || null, fromDate, toDate });
  }

  /** Snapshots diarios de inventario por SKU/estado. */
  @Get('sellers/:sellerId/inventory-snapshots')
  @RequirePermission('stock:read')
  snapshots(@Param('sellerId') sellerId: string, @Query('sku') sku?: string, @Query('fromDate') fromDate?: string, @Query('toDate') toDate?: string) {
    return this.wms.getInventorySnapshots(sellerId, { sku: sku || null, fromDate, toDate });
  }

  /** Vista consolidada de TODOS los clientes de la operación (operativo + comercial). */
  @Get('clients-overview')
  @RequirePermission('billing:manage')
  clientsOverview(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('year') year?: string, @Query('month') month?: string) {
    return this.wms.clientsOverview(actorOperation(user, operationId), { year: year ? parseInt(year, 10) : undefined, month: month ? parseInt(month, 10) : undefined });
  }

  // ---- G4: productividad --------------------------------------------------

  /** Deriva LaborTasks desde el ledger (arranque sin instrumentar). */
  @Post('labor/derive')
  @RequirePermission('operation:manage')
  deriveLabor(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.deriveLaborFromLedger(actorOperation(user, operationId));
  }

  /** Captura una tarea con inicio/fin reales (desde la PWA del operario). */
  @Post('labor/capture')
  @RequirePermission('order:fulfill')
  captureLabor(@CurrentUser() user: User | null, @Body() body: { operationId: string; sellerId?: string | null; operator?: string; type: LaborTaskType; startAt: string; endAt: string; units: number; orderRef?: string | null; locationId?: string | null }) {
    return this.wms.captureLaborTask({
      operationId: actorOperation(user, body?.operationId),
      sellerId: body?.sellerId ?? null,
      operator: body?.operator || actorOf(user),
      type: body?.type || 'PICK',
      startAt: body?.startAt,
      endAt: body?.endAt,
      units: body?.units,
      orderRef: body?.orderRef ?? null,
      locationId: body?.locationId ?? null,
    });
  }

  /** Reporte de productividad por operador (unidades/hora, por tipo de tarea). */
  @Get('labor/productivity')
  @RequirePermission('stock:read')
  productivity(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('operator') operator?: string) {
    return this.wms.laborProductivity(actorOperation(user, operationId), { from, to, operator: operator || null });
  }

  /** Serie diaria de mano de obra — input del forecast de personal. */
  @Get('labor/series')
  @RequirePermission('stock:read')
  laborSeries(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('operator') operator?: string) {
    return this.wms.laborSeries(actorOperation(user, operationId), { from, to, operator: operator || null });
  }

  // ---- G5: auditoría de IA ------------------------------------------------

  /** Panel de auditoría: acciones ejecutadas por agentes. */
  @Get('ai-audit/actions')
  @RequirePermission('master:manage') // admin/supervisor de la operación (antes solo plataforma: la página quedaba vacía)
  aiActions(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('agent') agent?: string, @Query('limit') limit?: string) {
    return this.wms.listAgentActions(actorOperation(user, operationId), { agent: agent || null, limit: limit ? parseInt(limit, 10) : 200 });
  }

  /** Panel de auditoría: recomendaciones de IA. */
  @Get('ai-audit/recommendations')
  @RequirePermission('master:manage') // admin/supervisor de la operación (antes solo plataforma: la página quedaba vacía)
  aiRecs(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('type') type?: string, @Query('limit') limit?: string) {
    return this.wms.listAiRecommendations(actorOperation(user, operationId), { type: type || null, limit: limit ? parseInt(limit, 10) : 200 });
  }

  /** Resumen de gobernanza: % de sugerencias aceptadas y su efecto. */
  @Get('ai-audit/summary')
  @RequirePermission('master:manage') // admin/supervisor de la operación (antes solo plataforma: la página quedaba vacía)
  aiSummary(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.wms.aiAuditSummary(actorOperation(user, operationId), { from, to });
  }

  // ---- G7: geometría + ABC ------------------------------------------------

  /** Fija las coordenadas (geometría) de una ubicación. */
  @Post('locations/:locationId/geometry')
  @RequirePermission('master:manage')
  setGeometry(@CurrentUser() user: User | null, @Param('locationId') locationId: string, @Body() body: { operationId?: string; x: number | null; y: number | null }) {
    return this.wms.setLocationGeometry(actorOperation(user, body?.operationId), locationId, { x: body?.x ?? null, y: body?.y ?? null });
  }

  /** Recalcula la clase ABC de los SKU desde la velocidad real del ledger. */
  @Post('abc/recompute')
  @RequirePermission('operation:manage')
  recomputeAbc(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('days') days?: string) {
    return this.wms.recomputeAbc(actorOperation(user, operationId), { days: days ? parseInt(days, 10) : undefined });
  }

  // ---- Actionables (valor operativo/gerencial) ----------------------------

  /** Riesgo de quiebre de stock por SKU (días de cobertura + reposición sugerida). */
  @Get('actionables/stockout-risk')
  @RequirePermission('stock:read')
  stockoutRisk(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('sellerId') sellerId?: string, @Query('coverDays') coverDays?: string, @Query('windowDays') windowDays?: string, @Query('limit') limit?: string) {
    return this.wms.getStockoutRisk(actorOperation(user, operationId), { sellerId: sellerId || null, coverDays: coverDays ? parseInt(coverDays, 10) : undefined, windowDays: windowDays ? parseInt(windowDays, 10) : undefined, limit: limit ? parseInt(limit, 10) : undefined });
  }

  /** Órdenes atascadas / en riesgo (detenidas más de N horas en su estado). */
  @Get('actionables/orders-at-risk')
  @RequirePermission('stock:read')
  ordersAtRisk(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('sellerId') sellerId?: string, @Query('maxHours') maxHours?: string, @Query('limit') limit?: string) {
    return this.wms.getOrdersAtRisk(actorOperation(user, operationId), { sellerId: sellerId || null, maxHours: maxHours ? parseInt(maxHours, 10) : undefined, limit: limit ? parseInt(limit, 10) : undefined });
  }

  /** Brief ejecutivo de la operación para gerencia. */
  @Get('actionables/executive-brief')
  @RequirePermission('stock:read')
  executiveBrief(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('sellerId') sellerId?: string) {
    return this.wms.getExecutiveBrief(actorOperation(user, operationId), { sellerId: sellerId || null });
  }
}
