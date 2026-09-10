import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { OpsReadDto, SendOpsMessageDto } from './dto';
import { actorOperation, CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { ROLE_PERMISSIONS, User } from '../domain/types';
import { WMS_FACADE } from './tokens';

/** ¿El usuario tiene rango de administración del canal (ve todos los hilos)? */
function isChannelAdmin(user: User | null): boolean {
  if (!user) return true; // modo demo: acceso total
  return ROLE_PERMISSIONS[user.role]?.includes('chat:manage') ?? false;
}

/**
 * Canal de voz/mensaje operador↔administrador de la operación.
 *  - Operador: deja mensajes (voz o texto) en SU hilo y ve solo su hilo.
 *  - Administrador (chat:manage): ve todos los hilos, reproduce el audio, responde,
 *    y consulta estadísticas + insights de tópicos generados por el agente IA.
 */
@Controller('ops-channel')
export class OpsChannelController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Envía un mensaje (voz o texto). El operador queda atado a su propio hilo. */
  @Post('messages')
  @RequirePermission('stock:read')
  send(@Body() dto: SendOpsMessageDto, @CurrentUser() user: User | null) {
    const operationId = actorOperation(user, dto.operationId);
    const admin = isChannelAdmin(user);
    const senderId = user?.id ?? 'system';
    const senderName = user?.name ?? 'Operador';
    const senderRole = (user?.role as string) ?? 'OPERATOR';
    // El admin responde a un hilo indicado; el operador solo puede escribir en el suyo.
    const threadUserId = admin ? (dto.threadUserId || senderId) : senderId;
    return this.wms.sendOpsMessage(operationId, {
      threadUserId,
      senderId,
      senderName,
      senderRole,
      kind: dto.kind,
      text: dto.text ?? null,
      note: dto.note ?? null,
      audioBase64: dto.audioBase64 ?? null,
      audioMime: dto.audioMime ?? null,
      durationSec: dto.durationSec ?? null,
    });
  }

  /** Lista mensajes. El operador ve solo su hilo; el admin puede filtrar por hilo. */
  @Get('messages')
  @RequirePermission('stock:read')
  async list(
    @CurrentUser() user: User | null,
    @Query('operationId') operationId?: string,
    @Query('threadUserId') threadUserId?: string,
  ) {
    const op = actorOperation(user, operationId);
    const admin = isChannelAdmin(user);
    const filterThread = admin ? (threadUserId || undefined) : user?.id;
    return this.wms.listOpsMessages(op, filterThread ? { threadUserId: filterThread } : undefined);
  }

  /** Audio (base64) de un mensaje de voz, para reproducir. */
  @Get('audio/:audioId')
  @RequirePermission('stock:read')
  async audio(
    @Param('audioId') audioId: string,
    @CurrentUser() user: User | null,
    @Query('operationId') operationId?: string,
  ) {
    const op = actorOperation(user, operationId);
    const blob = await this.wms.getOpsAudio(op, audioId);
    return blob ? { mime: blob.mime, dataBase64: blob.dataBase64 } : { mime: null, dataBase64: null };
  }

  /** Estado de lectura de un hilo (para el "visto"). */
  @Get('read')
  @RequirePermission('stock:read')
  getRead(
    @CurrentUser() user: User | null,
    @Query('operationId') operationId?: string,
    @Query('threadUserId') threadUserId?: string,
  ) {
    const op = actorOperation(user, operationId);
    const admin = isChannelAdmin(user);
    const thread = admin ? (threadUserId || user?.id || '') : (user?.id || '');
    return this.wms.getOpsRead(op, thread);
  }

  /** Marca el hilo como leído por el lado del usuario actual (admin u operador). */
  @Post('read')
  @RequirePermission('stock:read')
  markRead(@Body() dto: OpsReadDto, @CurrentUser() user: User | null) {
    const op = actorOperation(user, dto.operationId);
    const admin = isChannelAdmin(user);
    const thread = admin ? (dto.threadUserId || user?.id || '') : (user?.id || '');
    return this.wms.markOpsRead(op, thread, admin ? 'ADMIN' : 'OPERATOR');
  }

  /** Estadísticas del canal (solo administración). */
  @Get('stats')
  @RequirePermission('chat:manage')
  stats(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.opsChannelStats(actorOperation(user, operationId));
  }

  /** Insights de mejora generados por el agente IA (solo administración). */
  @Get('insights')
  @RequirePermission('chat:manage')
  insights(@CurrentUser() user: User | null, @Query('operationId') operationId?: string) {
    return this.wms.opsChannelInsights(actorOperation(user, operationId));
  }
}
