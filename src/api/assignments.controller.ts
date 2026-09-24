import { Body, Controller, Get, Inject, Post, Put, Query } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { actorOf, actorOperation, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { ForbiddenError } from '../domain/errors';
import { ROLE_PERMISSIONS, User, UserRole, WorkTaskType } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Asignación de tareas a operarios (balanceo de carga, Camino B). Las lecturas son
 * del personal de bodega (stock:read + no ser cliente); asignar/reasignar/balancear
 * requiere supervisión (master:manage). Un operario ve SUS tareas en /assignments/mine.
 */
@Controller('assignments')
export class AssignmentsController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /**
   * El piso de bodega es del personal, no de los clientes.
   *
   * `stock:read` lo tiene también el rol CLIENT —lo necesita para ver SU stock— y
   * estos endpoints no reciben :sellerId, así que el guard no puede aplicar la
   * frontera de seller: sin esta comprobación un cliente leía el pool, la carga y
   * las bandejas de TODA la operación, incluidas las órdenes de los demás clientes.
   */
  private soloPersonal(user: User | null): void {
    if (user && user.role === UserRole.CLIENT) {
      throw new ForbiddenError('El detalle de tareas de bodega es interno de la operación.');
    }
  }

  /**
   * Bandeja ajena = supervisión.
   *
   * Cada uno ve la suya sin pedir permiso; mirar la de otro es una vista de jefatura
   * y exige master:manage. Devuelve el operario que corresponde consultar.
   */
  private operarioConsultado(user: User | null, pedido?: string): string {
    const propio = actorOf(user);
    if (!pedido || pedido === propio) return propio;
    const puede = user ? (ROLE_PERMISSIONS[user.role]?.includes('master:manage') ?? false) : true;
    if (!puede) throw new ForbiddenError('Solo un supervisor o administrador puede ver la bandeja de otro operario.');
    return pedido;
  }

  /** Pool de tareas pendientes de un tipo (PICK|PUTAWAY|COUNT). */
  @Get('pool')
  @RequirePermission('stock:read')
  pool(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('type') type?: string, @Query('onlyUnassigned') onlyUnassigned?: string, @Query('limit') limit?: string) {
    this.soloPersonal(user);
    return this.wms.getTaskPool(actorOperation(user, operationId), (type as WorkTaskType) || 'PICK', { onlyUnassigned: onlyUnassigned === 'true', limit: limit ? parseInt(limit, 10) : undefined });
  }

  /** Carga de trabajo por operario + pendientes sin asignar. */
  @Get('load')
  @RequirePermission('stock:read')
  load(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    this.soloPersonal(user);
    return this.wms.operatorLoad(actorOperation(user, operationId));
  }

  /** "Mis tareas": las asignaciones abiertas del operario autenticado (o de `operator`). */
  @Get('mine')
  @RequirePermission('stock:read')
  mine(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('operator') operator?: string) {
    this.soloPersonal(user);
    return this.wms.getOperatorTasks(actorOperation(user, operationId), this.operarioConsultado(user, operator));
  }

  /** Actividades de un operario (vista "por operario"): asignadas, en ejecución o pendientes. */
  @Get('operator')
  @RequirePermission('stock:read')
  operator(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('operator') operator?: string) {
    this.soloPersonal(user);
    return this.wms.operatorActivities(actorOperation(user, operationId), this.operarioConsultado(user, operator));
  }

  /** Historial de asignaciones. */
  @Get()
  @RequirePermission('stock:read')
  history(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('type') type?: string, @Query('limit') limit?: string) {
    this.soloPersonal(user);
    return this.wms.listAssignments(actorOperation(user, operationId), { type: (type as WorkTaskType) || undefined, limit: limit ? parseInt(limit, 10) : 200 });
  }

  /** Asigna (o reasigna) una tarea a un operario. */
  @Post('assign')
  @RequirePermission('master:manage')
  assign(@CurrentUser() user: User | null, @Body() body: { operationId?: string; type: WorkTaskType; entityId: string; entityRef?: string | null; sellerId?: string | null; operator: string; unitsEstimate?: number; linesEstimate?: number; note?: string | null }) {
    return this.wms.assignTask(actorOperation(user, body?.operationId), { type: body.type, entityId: body.entityId, entityRef: body.entityRef ?? null, sellerId: body.sellerId ?? null, operator: body.operator, linesEstimate: body.linesEstimate, unitsEstimate: body.unitsEstimate, by: actorOf(user), note: body.note ?? null });
  }

  /** Asignación masiva. */
  @Post('bulk')
  @RequirePermission('master:manage')
  bulk(@CurrentUser() user: User | null, @Body() body: { operationId?: string; items: Array<{ type: WorkTaskType; entityId: string; entityRef?: string | null; sellerId?: string | null; unitsEstimate?: number; linesEstimate?: number; operator: string }> }) {
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
    this.soloPersonal(user);
    return this.wms.operatorBoard(actorOperation(user, operationId), this.operarioConsultado(user, operator));
  }
  /** El operario toma una tarea disponible (si el admin lo permite). */
  @Post('take')
  @RequirePermission('stock:read')
  take(@CurrentUser() user: User | null, @Body() body: { operationId?: string; type: WorkTaskType; entityId: string }) {
    this.soloPersonal(user);
    return this.wms.takeTask(actorOperation(user, body?.operationId), actorOf(user), { type: body.type, entityId: body.entityId });
  }
  /** El operario inicia una tarea de su bandeja. */
  @Post('start')
  @RequirePermission('stock:read')
  start(@CurrentUser() user: User | null, @Body() body: { operationId?: string; type: WorkTaskType; entityId: string; clientAt?: string | null }) {
    this.soloPersonal(user);
    return this.wms.startTask(actorOperation(user, body?.operationId), actorOf(user), { type: body.type, entityId: body.entityId, clientAt: body?.clientAt ?? null });
  }

  // ---- Auditoría de ejecución (libro de eventos de tarea) --------------------
  /**
   * La historia completa de una tarea, con sus tres tiempos separados: cuánto esperó
   * en cola, cuánto tardó el operario en arrancarla, y cuánto duró la ejecución.
   *
   * Es una vista de supervisión: mirar cuánto se demoró cada persona no es algo que
   * deba poder hacer cualquiera con acceso de lectura.
   */
  @Get('history')
  @RequirePermission('master:manage')
  taskHistory(@CurrentUser() user: User | null, @Query('taskId') taskId: string, @Query('operationId') operationId?: string) {
    return this.wms.taskHistory(actorOperation(user, operationId), taskId);
  }

  /** La historia de una entidad (una orden y todas sus etapas), etapa por etapa. */
  @Get('history/entity')
  @RequirePermission('master:manage')
  entityHistory(@CurrentUser() user: User | null, @Query('entityId') entityId: string, @Query('stage') stage?: string, @Query('operationId') operationId?: string) {
    return this.wms.entityHistory(actorOperation(user, operationId), entityId, { stage: stage || null });
  }

  /**
   * Qué hizo una persona en una ventana de tiempo.
   *
   * Cada uno puede ver la suya; mirar la de otro exige supervisión, igual que la
   * bandeja ajena. La diferencia importa: esto es un registro minuto a minuto del
   * turno de alguien, no un contador.
   */
  @Get('timeline')
  @RequirePermission('stock:read')
  timeline(@CurrentUser() user: User | null, @Query('operator') operator?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('limit') limit?: string, @Query('operationId') operationId?: string) {
    this.soloPersonal(user);
    const quien = this.operarioConsultado(user, operator);
    const n = limit ? parseInt(limit, 10) : undefined;
    return this.wms.operatorTimeline(actorOperation(user, operationId), quien, { from, to, limit: n && !Number.isNaN(n) ? n : undefined });
  }

  /** Eventos de tarea en crudo, para auditoría y exportación. */
  @Get('events')
  @RequirePermission('master:manage')
  events(@CurrentUser() user: User | null, @Query('actor') actor?: string, @Query('stage') stage?: string, @Query('type') type?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('limit') limit?: string, @Query('operationId') operationId?: string) {
    const n = limit ? parseInt(limit, 10) : undefined;
    return this.wms.taskEventLog(actorOperation(user, operationId), {
      actor: actor || null, stage: stage || null, type: (type as any) || null,
      from, to, limit: n && !Number.isNaN(n) ? n : undefined,
    });
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
