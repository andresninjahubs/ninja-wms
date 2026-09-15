import { Body, Controller, Get, Inject, Post, Put, Query } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { actorOf, actorOperation, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User, WorkTaskType } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Asignación de tareas a operarios (balanceo de carga, Camino B). Las lecturas son
 * para todos (stock:read); asignar/reasignar/balancear requiere supervisión
 * (master:manage). Un operario ve SUS tareas en /assignments/mine.
 */
@Controller('assignments')
export class AssignmentsController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Pool de tareas pendientes de un tipo (PICK|PUTAWAY|COUNT). */
  @Get('pool')
  @RequirePermission('stock:read')
  pool(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('type') type?: string, @Query('onlyUnassigned') onlyUnassigned?: string, @Query('limit') limit?: string) {
    return this.wms.getTaskPool(actorOperation(user, operationId), (type as WorkTaskType) || 'PICK', { onlyUnassigned: onlyUnassigned === 'true', limit: limit ? parseInt(limit, 10) : undefined });
  }

  /** Carga de trabajo por operario + pendientes sin asignar. */
  @Get('load')
  @RequirePermission('stock:read')
  load(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.operatorLoad(actorOperation(user, operationId));
  }

  /** "Mis tareas": las asignaciones abiertas del operario autenticado (o de `operator`). */
  @Get('mine')
  @RequirePermission('stock:read')
  mine(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('operator') operator?: string) {
    return this.wms.getOperatorTasks(actorOperation(user, operationId), operator || actorOf(user));
  }

  /** Actividades de un operario (vista "por operario"): asignadas, en ejecución o pendientes. */
  @Get('operator')
  @RequirePermission('stock:read')
  operator(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('operator') operator?: string) {
    return this.wms.operatorActivities(actorOperation(user, operationId), operator || actorOf(user));
  }

  /** Historial de asignaciones. */
  @Get()
  @RequirePermission('stock:read')
  history(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('type') type?: string, @Query('limit') limit?: string) {
    return this.wms.listAssignments(actorOperation(user, operationId), { type: (type as WorkTaskType) || undefined, limit: limit ? parseInt(limit, 10) : 200 });
  }

  /** Asigna (o reasigna) una tarea a un operario. */
  @Post('assign')
  @RequirePermission('master:manage')
  assign(@CurrentUser() user: User | null, @Body() body: { operationId?: string; type: WorkTaskType; entityId: string; entityRef?: string | null; sellerId?: string | null; operator: string; unitsEstimate?: number; note?: string | null }) {
    return this.wms.assignTask(actorOperation(user, body?.operationId), { type: body.type, entityId: body.entityId, entityRef: body.entityRef ?? null, sellerId: body.sellerId ?? null, operator: body.operator, unitsEstimate: body.unitsEstimate, by: actorOf(user), note: body.note ?? null });
  }

  /** Asignación masiva. */
  @Post('bulk')
  @RequirePermission('master:manage')
  bulk(@CurrentUser() user: User | null, @Body() body: { operationId?: string; items: Array<{ type: WorkTaskType; entityId: string; entityRef?: string | null; sellerId?: string | null; unitsEstimate?: number; operator: string }> }) {
    return this.wms.bulkAssign(actorOperation(user, body?.operationId), body?.items || [], actorOf(user));
  }

  /** Libera una asignación (vuelve al pool). */
  @Post('release')
  @RequirePermission('master:manage')
  release(@CurrentUser() user: User | null, @Body() body: { operationId?: string; type: WorkTaskType; entityId: string }) {
    return this.wms.releaseAssignment(actorOperation(user, body?.operationId), body.entityId, body.type, actorOf(user));
  }

  /** Auto-balanceo: reparte las tareas pendientes por tiempo proyectado. */
  @Post('auto-balance')
  @RequirePermission('master:manage')
  autoBalance(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('type') type?: string, @Query('execute') execute?: string, @Query('limit') limit?: string) {
    return this.wms.autoBalance(actorOperation(user, operationId), { type: (type as WorkTaskType) || 'PICK', execute: execute === 'true', by: actorOf(user), limit: limit ? parseInt(limit, 10) : undefined });
  }

  /** Reasignación automática por ociosidad (work-stealing): mueve tareas asignadas
   *  pero no iniciadas desde el operario más cargado al menos cargado. */
  @Post('rebalance-load')
  @RequirePermission('master:manage')
  rebalanceLoad(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('execute') execute?: string, @Query('maxGapHours') maxGapHours?: string) {
    return this.wms.rebalanceLoad(actorOperation(user, operationId), { execute: execute !== 'false', maxGapHours: maxGapHours ? parseFloat(maxGapHours) : undefined });
  }

  /** Modo de asignación de la operación. */
  @Get('mode')
  @RequirePermission('stock:read')
  async getMode(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return { assignmentMode: await this.wms.getAssignmentMode(actorOperation(user, operationId)) };
  }

  @Put('mode')
  @RequirePermission('master:manage')
  setMode(@CurrentUser() user: User | null, @Body() body: { operationId?: string; mode: 'advisory' | 'strict' }) {
    return this.wms.setAssignmentMode(actorOperation(user, body?.operationId), body?.mode === 'strict' ? 'strict' : 'advisory');
  }

  /** Tablero del operario (PWA): sus tareas en orden de ejecución + disponibles para tomar. */
  @Get('board')
  @RequirePermission('stock:read')
  board(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('operator') operator?: string) {
    return this.wms.operatorBoard(actorOperation(user, operationId), operator || actorOf(user));
  }
  /** El operario toma una tarea disponible (si el admin lo permite). */
  @Post('take')
  @RequirePermission('stock:read')
  take(@CurrentUser() user: User | null, @Body() body: { operationId?: string; type: WorkTaskType; entityId: string }) {
    return this.wms.takeTask(actorOperation(user, body?.operationId), actorOf(user), { type: body.type, entityId: body.entityId });
  }
  /** El operario inicia una tarea de su bandeja. */
  @Post('start')
  @RequirePermission('stock:read')
  start(@CurrentUser() user: User | null, @Body() body: { operationId?: string; type: WorkTaskType; entityId: string }) {
    return this.wms.startTask(actorOperation(user, body?.operationId), actorOf(user), { type: body.type, entityId: body.entityId });
  }
  /** ¿Pueden los operarios tomar tareas disponibles desde la app? (configurable por el admin) */
  @Get('self-pickup')
  @RequirePermission('stock:read')
  async getSelfPickup(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return { operatorSelfPickup: await this.wms.getOperatorSelfPickup(actorOperation(user, operationId)) };
  }
  @Put('self-pickup')
  @RequirePermission('master:manage')
  setSelfPickup(@CurrentUser() user: User | null, @Body() body: { operationId?: string; on: boolean }) {
    return this.wms.setOperatorSelfPickup(actorOperation(user, body?.operationId), !!body?.on);
  }

  /** Auto-balanceo continuo: estado y activación. */
  @Get('continuous')
  @RequirePermission('stock:read')
  async getContinuous(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return { autoBalance: await this.wms.getAutoBalanceEnabled(actorOperation(user, operationId)) };
  }

  @Put('continuous')
  @RequirePermission('master:manage')
  setContinuous(@CurrentUser() user: User | null, @Body() body: { operationId?: string; on: boolean }) {
    return this.wms.setAutoBalanceContinuous(actorOperation(user, body?.operationId), !!body?.on);
  }
}
