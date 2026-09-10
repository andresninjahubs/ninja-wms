/**
 * ChatService — chat interno entre el CLIENTE (seller) y el EQUIPO DE OPERACIONES.
 *
 * Una conversación por cliente. Los mensajes son append-only (auditables). El equipo
 * de operaciones (admin/supervisor) ve la bandeja de todos sus clientes y sabe qué
 * cliente y qué usuario está escribiendo. Los "no leídos" se calculan con un marcador
 * de "leído hasta" por lado (cliente / operaciones).
 */
import { NotFoundError, ValidationError } from './errors';
import { ChatRepository, Clock, IdGenerator, SellerRepository } from './ports';
import { ChatMessage, ChatSide, User, UserRole } from './types';

const MAX_LEN = 2000;

export interface ChatSender {
  id: string;
  name: string;
  role: string;
}
export interface ChatThread {
  sellerId: string;
  messages: ChatMessage[];
  unread: number; // no leídos para el lado del que consulta
}
export interface ChatSummaryItem {
  sellerId: string;
  sellerName: string;
  unread: number; // mensajes del cliente sin leer por operaciones
  total: number;
  last: { body: string; at: string; senderName: string; senderRole: string; side: ChatSide } | null;
}

export class ChatService {
  constructor(
    private readonly chat: ChatRepository,
    private readonly sellers: SellerRepository,
    private readonly clock: Clock,
  ) {}

  private sideOf(role: string): ChatSide {
    return role === UserRole.CLIENT ? 'CLIENT' : 'OPS';
  }

  /** Envía un mensaje. El lado se deriva del rol del emisor. */
  async send(sellerId: string, sender: ChatSender, body: string): Promise<ChatMessage> {
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw new NotFoundError(`Cliente no encontrado: ${sellerId}`);
    const text = (body || '').trim();
    if (!text) throw new ValidationError('El mensaje no puede estar vacío');
    if (text.length > MAX_LEN) throw new ValidationError(`El mensaje supera ${MAX_LEN} caracteres`);
    const side = this.sideOf(sender.role);
    const message: ChatMessage = {
      id: this.chatId(),
      sellerId,
      senderId: sender.id || 'system',
      senderName: sender.name || sender.id || 'Usuario',
      senderRole: sender.role,
      side,
      body: text,
      at: this.clock.now(),
    };
    await this.chat.append(message);
    // Quien envía, obviamente ya "leyó" su propio lado hasta ahora.
    await this.chat.setReadState(sellerId, side, message.at);
    return message;
  }

  private chatId(): string {
    return 'MSG-' + Math.random().toString(36).slice(2, 10).toUpperCase();
  }

  /** Hilo de una conversación + no leídos para el lado del usuario que consulta. */
  async thread(sellerId: string, viewerRole: string): Promise<ChatThread> {
    const messages = await this.chat.list(sellerId);
    const unread = await this.unread(sellerId, this.sideOf(viewerRole), messages);
    return { sellerId, messages, unread };
  }

  /** Marca la conversación como leída hasta ahora para el lado del usuario. */
  async markRead(sellerId: string, viewerRole: string): Promise<void> {
    await this.chat.setReadState(sellerId, this.sideOf(viewerRole), this.clock.now());
  }

  private async unread(sellerId: string, side: ChatSide, msgs?: ChatMessage[]): Promise<number> {
    const messages = msgs ?? (await this.chat.list(sellerId));
    const read = await this.chat.getReadState(sellerId);
    // No leídos = mensajes del OTRO lado posteriores al marcador propio.
    const otherSide: ChatSide = side === 'OPS' ? 'CLIENT' : 'OPS';
    const readAt = side === 'OPS' ? read?.opsReadAt : read?.clientReadAt;
    const readMs = readAt ? Date.parse(readAt) : 0;
    return messages.filter((m) => m.side === otherSide && Date.parse(m.at) > readMs).length;
  }

  /** No leídos del cliente (para su badge). */
  clientUnread(sellerId: string): Promise<number> {
    return this.unread(sellerId, 'CLIENT');
  }

  /**
   * Bandeja del equipo de operaciones: una fila por cliente CON conversación, con el
   * último mensaje (y quién lo escribió) y los no leídos por operaciones. Ordenada por
   * actividad reciente. Así operaciones sabe qué cliente y qué usuario está hablando.
   */
  async summary(operationId: string): Promise<ChatSummaryItem[]> {
    const sellers = await this.sellers.list(operationId);
    const items: ChatSummaryItem[] = [];
    for (const s of sellers) {
      const messages = await this.chat.list(s.id);
      if (!messages.length) continue;
      const last = messages[messages.length - 1];
      const unread = await this.unread(s.id, 'OPS', messages);
      items.push({
        sellerId: s.id,
        sellerName: s.name,
        unread,
        total: messages.length,
        last: { body: last.body, at: last.at, senderName: last.senderName, senderRole: last.senderRole, side: last.side },
      });
    }
    items.sort((a, b) => (a.last && b.last ? (a.last.at < b.last.at ? 1 : -1) : 0));
    return items;
  }
}

/** Deriva un ChatSender desde el usuario autenticado (o 'system' en modo demo). */
export function senderOf(user: User | null): ChatSender {
  if (!user) return { id: 'system', name: 'Sistema', role: 'OPERATOR' };
  return { id: user.id, name: user.name, role: user.role };
}
