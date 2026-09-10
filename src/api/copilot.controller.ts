import { Body, Controller, Delete, Get, Inject, Post, Put, Query } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { CopilotAskDto, AiConfigDto, CopilotConfirmActionDto, CopilotSettingsDto } from './dto';
import { actorOperation, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User, UserRole } from '../domain/types';
import { WMS_FACADE } from './tokens';

/**
 * Copiloto del WMS (Fase 1): insights proactivos + preguntas en lenguaje natural,
 * SIEMPRE con datos reales (grounded) y acotado al tenant del usuario.
 *  - CLIENT (seller): solo su propio seller.
 *  - Staff de operación: toda su operación.
 */
@Controller('copilot')
export class CopilotController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Alcance de seller según el rol (aislamiento por tenant). */
  private sellerScope(user: User | null): string | null {
    if (user && user.role === UserRole.CLIENT) return user.sellerId || null;
    return null; // staff → toda la operación
  }

  /** Tarjeta de insights proactivos (el "aha"). */
  @Get('insights')
  @RequirePermission('stock:read')
  insights(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('sellerId') sellerId?: string) {
    const op = actorOperation(user, operationId);
    const scoped = this.sellerScope(user) || (sellerId || null);
    return this.wms.copilotInsights(op, scoped);
  }

  /** Pregunta en lenguaje natural, respondida con datos reales. */
  @Post('ask')
  @RequirePermission('stock:read')
  ask(@Body() dto: CopilotAskDto, @CurrentUser() user: User | null) {
    const op = actorOperation(user, dto.operationId);
    const scoped = this.sellerScope(user) || (dto.sellerId || null);
    const actor = user ? { id: user.id, role: user.role } : null;
    return this.wms.copilotAsk(op, scoped, dto.question || '', dto.history, actor);
  }

  /** Confirma y ejecuta una acción de escritura propuesta por el copiloto (modo 'confirm'). */
  @Post('confirm-action')
  @RequirePermission('stock:read')
  confirmAction(@Body() dto: CopilotConfirmActionDto, @CurrentUser() user: User | null) {
    const op = actorOperation(user, dto.operationId);
    const scoped = this.sellerScope(user) || (dto.sellerId || null);
    const actor = user ? { id: user.id, role: user.role } : null;
    return this.wms.copilotConfirmAction(op, scoped, actor, { orden: dto.orden, accion: dto.accion });
  }

  /** Modo de acciones del copiloto para la operación ('confirm' | 'direct'). */
  @Get('settings')
  @RequirePermission('stock:read')
  async settings(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    const op = actorOperation(user, operationId);
    const actionMode = await this.wms.getCopilotActionMode(op);
    const canManage = !!user && [UserRole.PLATFORM_ADMIN, UserRole.ADMIN, UserRole.SUPERVISOR].includes(user.role);
    return { actionMode, canManage };
  }

  /** Actualiza el modo de acciones del copiloto (solo administradores). */
  @Put('settings')
  @RequirePermission('master:manage')
  setSettings(@Body() dto: CopilotSettingsDto, @CurrentUser() user: User | null) {
    const op = actorOperation(user, dto.operationId);
    return this.wms.setCopilotActionMode(op, dto.actionMode);
  }

  /** Alcance donde el usuario CONFIGURA su IA: un CLIENT en su seller; el staff a nivel operación. */
  private configScope(user: User | null, bodySellerId?: string): string | null {
    if (user && user.role === UserRole.CLIENT) return user.sellerId || null;
    return bodySellerId || null; // staff: operación (null) o un seller indicado
  }

  /** Catálogo de proveedores soportados (para poblar el formulario). */
  @Get('ai-providers')
  @RequirePermission('stock:read')
  aiProviders() {
    return this.wms.aiProviders();
  }

  /** Estado de la conexión de IA (sin exponer la clave). */
  @Get('ai-config')
  @RequirePermission('stock:read')
  aiStatus(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('sellerId') sellerId?: string) {
    const op = actorOperation(user, operationId);
    return this.wms.getAiConfigStatus(op, this.configScope(user, sellerId));
  }

  /** Conecta/actualiza la clave LLM del tenant. */
  @Put('ai-config')
  @RequirePermission('stock:read')
  aiSet(@Body() dto: AiConfigDto, @CurrentUser() user: User | null) {
    const op = actorOperation(user, dto.operationId);
    return this.wms.setAiConfig(op, this.configScope(user, dto.sellerId), {
      provider: dto.provider, baseUrl: dto.baseUrl, chatModel: dto.chatModel, apiKey: dto.apiKey,
    });
  }

  /** Prueba la conexión de IA (ping) y devuelve el motivo si falla. */
  @Post('ai-test')
  @RequirePermission('stock:read')
  aiTest(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('sellerId') sellerId?: string) {
    const op = actorOperation(user, operationId);
    return this.wms.testAiConfig(op, this.configScope(user, sellerId));
  }

  /** Vista previa del contexto de datos que recibe el LLM. */
  @Get('ai-context-preview')
  @RequirePermission('stock:read')
  aiContext(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('sellerId') sellerId?: string) {
    const op = actorOperation(user, operationId);
    return this.wms.copilotContextPreview(op, this.sellerScope(user) || (sellerId || null));
  }

  /** Lista los modelos disponibles para la cuenta conectada. */
  @Get('ai-models')
  @RequirePermission('stock:read')
  aiModels(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('sellerId') sellerId?: string) {
    const op = actorOperation(user, operationId);
    return this.wms.listAiModels(op, this.configScope(user, sellerId));
  }

  /** Desconecta la clave LLM del tenant. */
  @Delete('ai-config')
  @RequirePermission('stock:read')
  aiDelete(@CurrentUser() user: User | null, @Query('operationId') operationId?: string, @Query('sellerId') sellerId?: string) {
    const op = actorOperation(user, operationId);
    return this.wms.deleteAiConfig(op, this.configScope(user, sellerId));
  }
}
