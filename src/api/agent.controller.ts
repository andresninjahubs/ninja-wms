import { Body, Controller, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { actorOf, actorOperation, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User, AgentRuleSeverity } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Agente proactivo (Nivel 3, Fase 1). El panel de Reglas lee el catálogo, ajusta cada
 * regla y ve las alertas activas. Leer es para todo el staff (stock:read); configurar
 * reglas requiere supervisión (seller:config).
 */
@Controller('agent')
export class AgentController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Catálogo de reglas con su configuración efectiva. */
  @Get('rules')
  @RequirePermission('stock:read')
  rules(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.agentRules(actorOperation(user, operationId));
  }

  /** Ajusta una regla: encendido, umbral, enfriamiento, severidad, alcance por cliente. */
  @Patch('rules/:key')
  @RequirePermission('seller:config')
  updateRule(
    @Param('key') key: string,
    @Body() body: { operationId?: string; enabled?: boolean; threshold?: number; cooldownMin?: number; severity?: AgentRuleSeverity; sellerId?: string | null; actionType?: 'alert' | 'execute'; actionMode?: 'confirmar' | 'directo' },
    @CurrentUser() user: User | null,
  ) {
    return this.wms.updateAgentRule(actorOperation(user, body?.operationId), key, {
      enabled: body.enabled, threshold: body.threshold, cooldownMin: body.cooldownMin, severity: body.severity, sellerId: body.sellerId,
      actionType: body.actionType, actionMode: body.actionMode,
    }, actorOf(user));
  }

  /** Alertas del agente. Corre el barrido en vivo (para el auto-refresco del panel). */
  @Get('alerts')
  @RequirePermission('stock:read')
  alerts(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('recent') recent?: string) {
    return this.wms.agentAlerts(actorOperation(user, operationId), { sweep: true, includeRecent: recent ? parseInt(recent, 10) : undefined });
  }

  /** Corre el barrido a demanda ("Evaluar ahora"). */
  @Post('sweep')
  @RequirePermission('stock:read')
  sweep(@CurrentUser() user: User | null, @Body() body: { operationId?: string }) {
    return this.wms.runAgentSweep(actorOperation(user, body?.operationId));
  }

  /** Marca una alerta como vista/descartada. */
  @Post('alerts/:id/ack')
  @RequirePermission('stock:read')
  ack(@Param('id') id: string, @CurrentUser() user: User | null, @Body() body: { operationId?: string }) {
    return this.wms.ackAgentAlert(actorOperation(user, body?.operationId), id, actorOf(user));
  }

  /** Ejecuta la acción propuesta de una alerta (confirmar y ejecutar). Requiere permiso operativo. */
  @Post('alerts/:id/execute')
  @RequirePermission('order:fulfill')
  execute(@Param('id') id: string, @CurrentUser() user: User | null, @Body() body: { operationId?: string }) {
    return this.wms.executeAgentAlertAction(actorOperation(user, body?.operationId), id, actorOf(user));
  }
}
