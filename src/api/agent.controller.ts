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

  /**
   * Alertas del agente. El barrido ya NO lo dispara el panel: corre en el servidor con su
   * propio reloj (agent-scheduler). `?sweep=1` fuerza uno (compatibilidad).
   */
  @Get('alerts')
  @RequirePermission('stock:read')
  alerts(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('recent') recent?: string, @Query('sweep') sweep?: string) {
    return this.wms.agentAlerts(actorOperation(user, operationId), { sweep: sweep === '1' || sweep === 'true', includeRecent: recent ? parseInt(recent, 10) : undefined });
  }

  /** Corre un ciclo completo del agente a demanda ("Evaluar ahora"). */
  @Post('sweep')
  @RequirePermission('stock:read')
  sweep(@CurrentUser() user: User | null, @Body() body: { operationId?: string }) {
    return this.wms.runAgentCycle(actorOperation(user, body?.operationId), { force: true, by: actorOf(user) });
  }

  /** Estado del agente: ajustes efectivos, último ciclo, scheduler, presupuesto LLM. */
  @Get('status')
  @RequirePermission('stock:read')
  status(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.agentStatus(actorOperation(user, operationId));
  }

  /** Ajustes del agente: nivel de autonomía, sombra, pausa, límites, notificaciones, LLM. */
  @Get('settings')
  @RequirePermission('stock:read')
  settings(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.agentSettings(actorOperation(user, operationId));
  }
  @Patch('settings')
  @RequirePermission('master:manage')
  updateSettings(@CurrentUser() user: User | null, @Body() body: { operationId?: string; actionMode?: 'confirm' | 'direct'; autonomyLevel?: number; shadowMode?: boolean; paused?: boolean; maxActionsPerCycle?: number; maxActionsPerHour?: number; notifyEmail?: string | null; notifyWebhookUrl?: string | null; llmPlanning?: boolean; llmEveryMin?: number; maxLlmCallsPerDay?: number }) {
    const { operationId, ...patch } = body || {};
    return this.wms.updateAgentSettings(actorOperation(user, operationId), patch as any, actorOf(user));
  }

  /** Diario del agente (memoria): ciclos, decisiones, instrucciones, resultados. */
  @Get('journal')
  @RequirePermission('stock:read')
  journal(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('kind') kind?: string, @Query('limit') limit?: string) {
    return this.wms.agentJournalList(actorOperation(user, operationId), { kind: (kind as any) || null, limit: limit ? parseInt(limit, 10) : 60 });
  }

  /** Instrucciones vigentes del administrador para el agente. */
  @Get('instructions')
  @RequirePermission('stock:read')
  instructions(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.agentInstructions(actorOperation(user, operationId));
  }
  @Post('instructions')
  @RequirePermission('seller:config')
  addInstruction(@CurrentUser() user: User | null, @Body() body: { operationId?: string; texto: string; diasVigencia?: number }) {
    return this.wms.addAgentInstruction(actorOperation(user, body?.operationId), body?.texto, body?.diasVigencia ?? 0, actorOf(user));
  }
  @Post('instructions/:id/retire')
  @RequirePermission('seller:config')
  retireInstruction(@Param('id') id: string, @CurrentUser() user: User | null, @Body() body: { operationId?: string }) {
    return this.wms.retireAgentInstruction(actorOperation(user, body?.operationId), id, actorOf(user));
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
