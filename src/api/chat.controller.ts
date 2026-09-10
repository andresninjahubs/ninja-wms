import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { WmsFacade } from '../app/wms.facade';
import { SendChatMessageDto } from './dto';
import { CurrentUser } from './auth/current-user.decorator';
import { RequirePermission } from './auth/permissions.decorator';
import { User } from '../domain/types';
import { senderOf } from '../domain/chat.service';
import { WMS_FACADE } from './tokens';

/**
 * Chat interno de un cliente (seller) con el equipo de operaciones.
 * - El cliente (chat:use) conversa en su propio hilo (frontera de seller por el guard).
 * - El staff (chat:use) responde; ve la bandeja de la operación con `chat:manage`.
 */
@Controller('sellers/:sellerId/chat')
export class ChatController {
  constructor(@Inject(WMS_FACADE) private readonly wms: WmsFacade) {}

  /** Hilo de la conversación + no leídos para el lado de quien consulta. */
  @Get()
  @RequirePermission('chat:use')
  thread(@Param('sellerId') sellerId: string, @CurrentUser() user: User | null) {
    return this.wms.chatThread(sellerId, user?.role ?? 'ADMIN');
  }

  /** Envía un mensaje al hilo (el lado se deriva del rol del emisor). */
  @Post()
  @RequirePermission('chat:use')
  send(@Param('sellerId') sellerId: string, @Body() dto: SendChatMessageDto, @CurrentUser() user: User | null) {
    return this.wms.chatSend(sellerId, senderOf(user), dto.body);
  }

  /** Marca la conversación como leída hasta ahora para el lado del usuario. */
  @Post('read')
  @RequirePermission('chat:use')
  async read(@Param('sellerId') sellerId: string, @CurrentUser() user: User | null) {
    await this.wms.chatMarkRead(sellerId, user?.role ?? 'ADMIN');
    return { ok: true };
  }
}
