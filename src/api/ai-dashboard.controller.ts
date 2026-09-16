/**
 * Dashboard AI: tableros a medida que el administrador arma conversando con el LLM.
 * Solo administración (`dashboard:ai`): el supervisor y el operario no lo ven.
 * Cada tablero es del usuario que lo creó, dentro de su operación.
 */
import { Body, Controller, Delete, Get, Inject, Param, Patch, Post, Query } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { AiDashboardChatDto, AiDashboardPatchDto, CreateAiDashboardDto } from './dto';
import { actorOf, CurrentUser, actorOperation } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User } from '../domain/types';
import { WMS_FACADE } from './tokens';

@Controller('ai-dashboards')
export class AiDashboardController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** El dueño del tablero es siempre quien pide: nadie ve los tableros de otro. */
  private owner(user: User | null): string { return actorOf(user); }

  /** Qué puede y qué no puede pedirle el usuario al tablero (sale del catálogo real). */
  @Get('capacidades')
  @RequirePermission('dashboard:ai')
  capacidades() {
    return this.wms.aiDashboardCapacidades();
  }

  @Get()
  @RequirePermission('dashboard:ai')
  list(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.listAiDashboards(actorOperation(user, operationId), this.owner(user));
  }

  @Post()
  @RequirePermission('dashboard:ai')
  create(@Body() dto: CreateAiDashboardDto, @CurrentUser() user: User | null) {
    return this.wms.createAiDashboard(actorOperation(user, dto.operationId), this.owner(user), dto.nombre, dto.sellerId ?? null);
  }

  @Get(':id')
  @RequirePermission('dashboard:ai')
  get(@Param('id') id: string, @CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.getAiDashboard(id, actorOperation(user, operationId), this.owner(user));
  }

  /** Datos en vivo de los widgets. La pantalla lo llama cada 30 s. */
  @Get(':id/data')
  @RequirePermission('dashboard:ai')
  data(@Param('id') id: string, @CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('sellerId') sellerId?: string) {
    return this.wms.aiDashboardData(id, actorOperation(user, operationId), this.owner(user), sellerId || user?.sellerId || null);
  }

  /** Cambios hechos a mano en el editor (mover, redimensionar, crear, borrar). */
  @Patch(':id')
  @RequirePermission('dashboard:ai')
  patch(@Param('id') id: string, @Body() dto: AiDashboardPatchDto, @CurrentUser() user: User | null) {
    return this.wms.patchAiDashboard(id, actorOperation(user, dto.operationId), this.owner(user), dto.ops || []);
  }

  /** Le pide al LLM crear o modificar el tablero. El servidor valida antes de guardar. */
  @Post(':id/chat')
  @RequirePermission('dashboard:ai')
  chat(@Param('id') id: string, @Body() dto: AiDashboardChatDto, @CurrentUser() user: User | null) {
    return this.wms.aiDashboardChat(
      id, actorOperation(user, dto.operationId), this.owner(user),
      dto.sellerId || user?.sellerId || null, dto.prompt || '', dto.historial || [],
      user?.role || null,
    );
  }

  @Delete(':id')
  @RequirePermission('dashboard:ai')
  remove(@Param('id') id: string, @CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.deleteAiDashboard(id, actorOperation(user, operationId), this.owner(user));
  }
}
