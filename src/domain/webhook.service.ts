/**
 * WebhookService — suscripciones de webhook configurables por evento.
 *
 * Cada usuario configura webhooks dentro de SU alcance:
 *   - CLIENT      → scope SELLER    (su propio sellerId), solo si el admin lo habilitó.
 *   - ADMIN/SUP.  → scope OPERATION (su operationId).
 *   - PLATFORM    → scope PLATFORM  (global; recibe todos los eventos).
 *
 * Cuando ocurre un evento para el seller S (operación O), se entrega a TODAS las
 * suscripciones activas suscritas a ese evento cuyo scope matchee: SELLER==S,
 * OPERATION==O y PLATFORM (todas). Cada intento queda registrado como WebhookDelivery.
 *
 * El disparo firma el body con HMAC-SHA256(secret) en el header X-Ninja-Signature.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { ForbiddenError, NotFoundError, ValidationError } from './errors';
import { Clock, IdGenerator, SellerRepository, WebhookRepository, WebhookSender } from './ports';
import {
  Seller,
  User,
  UserRole,
  Webhook,
  WebhookDelivery,
  WebhookEventType,
  WebhookScope,
} from './types';

/** Eventos soportados (v1). El create valida contra esta lista. */
export const SUPPORTED_WEBHOOK_EVENTS: WebhookEventType[] = [
  'order.allocated',
  'order.picking',
  'order.picked',
  'order.packed',
  'order.shipped',
  'order.cancelled',
  'reception.received',
];

export interface CreateWebhookInput {
  url: string;
  events: WebhookEventType[];
}
export interface UpdateWebhookInput {
  url?: string;
  events?: WebhookEventType[];
  active?: boolean;
}

/** Alcance efectivo de un usuario para sus webhooks. */
interface Scope {
  scope: WebhookScope;
  scopeId: string | null;
}

function normalizeUrl(raw: string): string {
  const u = (raw || '').trim();
  if (!u) throw new ValidationError('El webhook debe llevar una URL de destino');
  if (!/^https?:\/\//i.test(u)) throw new ValidationError('La URL debe ser http/https válida');
  try {
    // eslint-disable-next-line no-new
    new URL(u);
  } catch {
    throw new ValidationError('La URL de destino no es válida');
  }
  return u;
}

function validateEvents(events: WebhookEventType[] | undefined): WebhookEventType[] {
  if (!Array.isArray(events) || events.length === 0) {
    throw new ValidationError('Debes suscribir el webhook a al menos un evento');
  }
  const unique = [...new Set(events)];
  for (const e of unique) {
    if (!SUPPORTED_WEBHOOK_EVENTS.includes(e)) {
      throw new ValidationError(`Evento no soportado: ${e}`);
    }
  }
  return unique;
}

export class WebhookService {
  constructor(
    private readonly repo: WebhookRepository,
    private readonly sellers: SellerRepository,
    private readonly sender: WebhookSender,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
  ) {}

  /** Alcance del usuario según su rol (dónde vive y qué ve). */
  scopeOf(user: User): Scope {
    if (user.role === UserRole.PLATFORM_ADMIN) return { scope: 'PLATFORM', scopeId: null };
    if (user.role === UserRole.CLIENT) return { scope: 'SELLER', scopeId: user.sellerId };
    // ADMIN / SUPERVISOR / (OPERATOR no tiene el permiso) → operación
    return { scope: 'OPERATION', scopeId: user.operationId };
  }

  /**
   * Si el usuario es CLIENT, exige que su seller tenga habilitado el panel de webhooks.
   * Para el resto de roles no aplica (no lanza).
   */
  async assertClientAccess(user: User): Promise<void> {
    if (user.role !== UserRole.CLIENT) return;
    if (!user.sellerId) throw new ForbiddenError('El cliente no tiene un seller asociado');
    const seller = await this.sellers.findById(user.sellerId);
    if (!seller) throw new NotFoundError(`Seller no encontrado: ${user.sellerId}`);
    if (!seller.webhooksClientEnabled) {
      throw new ForbiddenError('Tu operador no ha habilitado el panel de webhooks para tu cuenta');
    }
  }

  /** Genera un secreto de firma legible: whsec_<hex>. */
  private genSecret(): string {
    return 'whsec_' + randomBytes(24).toString('hex');
  }

  /** Crea una suscripción en el alcance del usuario. */
  async create(user: User, input: CreateWebhookInput): Promise<Webhook> {
    await this.assertClientAccess(user);
    const { scope, scopeId } = this.scopeOf(user);
    if (scope !== 'PLATFORM' && !scopeId) {
      throw new ValidationError('No se pudo resolver el alcance del webhook para este usuario');
    }
    const webhook: Webhook = {
      id: 'WH-' + this.ids.next().replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toUpperCase(),
      scope,
      scopeId: scope === 'PLATFORM' ? null : scopeId,
      url: normalizeUrl(input.url),
      secret: this.genSecret(),
      events: validateEvents(input.events),
      active: true,
      createdAt: this.clock.now(),
      createdBy: user.id || 'system',
    };
    await this.repo.save(webhook);
    return webhook;
  }

  /** Las suscripciones del alcance del usuario. */
  async list(user: User): Promise<Webhook[]> {
    await this.assertClientAccess(user);
    const { scope, scopeId } = this.scopeOf(user);
    const all = await this.repo.list();
    return all.filter((w) => w.scope === scope && (scope === 'PLATFORM' || w.scopeId === scopeId));
  }

  /** ¿El webhook pertenece al alcance del usuario? El PLATFORM_ADMIN puede con cualquiera. */
  private ownsOrThrow(user: User, w: Webhook): void {
    if (user.role === UserRole.PLATFORM_ADMIN) return;
    const { scope, scopeId } = this.scopeOf(user);
    if (w.scope !== scope || (scope !== 'PLATFORM' && w.scopeId !== scopeId)) {
      throw new ForbiddenError('Este webhook no pertenece a tu alcance');
    }
  }

  private async mustOwn(user: User, id: string): Promise<Webhook> {
    await this.assertClientAccess(user);
    const w = await this.repo.findById(id);
    if (!w) throw new NotFoundError(`Webhook no encontrado: ${id}`);
    this.ownsOrThrow(user, w);
    return w;
  }

  async update(user: User, id: string, patch: UpdateWebhookInput): Promise<Webhook> {
    const w = await this.mustOwn(user, id);
    if (patch.url != null) w.url = normalizeUrl(patch.url);
    if (patch.events != null) w.events = validateEvents(patch.events);
    if (patch.active != null) w.active = !!patch.active;
    await this.repo.save(w);
    return w;
  }

  async remove(user: User, id: string): Promise<{ ok: true; id: string }> {
    const w = await this.mustOwn(user, id);
    await this.repo.delete(w.id);
    return { ok: true, id: w.id };
  }

  /** Historial de entregas de un webhook del alcance del usuario. */
  async deliveries(user: User, id: string): Promise<WebhookDelivery[]> {
    const w = await this.mustOwn(user, id);
    return this.repo.listDeliveries(w.id);
  }

  /**
   * Dispara un evento a TODAS las suscripciones activas que lo matcheen (SELLER==sellerId,
   * OPERATION==operationId, PLATFORM). Firma el body y registra cada entrega.
   * NUNCA lanza (captura todo). Devuelve el nº de entregas registradas.
   */
  async dispatch(
    event: WebhookEventType,
    sellerId: string,
    operationId: string | null,
    payload: object,
  ): Promise<number> {
    let count = 0;
    try {
      const all = await this.repo.list();
      const targets = all.filter((w) => {
        if (!w.active) return false;
        if (!w.events.includes(event)) return false;
        if (w.scope === 'PLATFORM') return true;
        if (w.scope === 'SELLER') return w.scopeId === sellerId;
        if (w.scope === 'OPERATION') return operationId != null && w.scopeId === operationId;
        return false;
      });
      for (const w of targets) {
        await this.deliverTo(w, event, sellerId, payload);
        count += 1;
      }
    } catch {
      /* dispatch es fire-and-forget: nunca propaga errores al flujo de negocio */
    }
    return count;
  }

  /** Arma, firma, envía y registra una entrega a un webhook concreto. Nunca lanza. */
  private async deliverTo(
    w: Webhook,
    event: WebhookEventType,
    sellerId: string,
    payload: object,
  ): Promise<void> {
    const at = this.clock.now();
    const body = JSON.stringify({ event, at, sellerId, data: payload });
    const signature = 'sha256=' + createHmac('sha256', w.secret).update(body).digest('hex');
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Ninja-Signature': signature,
      'X-Ninja-Event': event,
    };
    let status: number | null = null;
    let ok = false;
    let error: string | null = null;
    try {
      const res = await this.sender.send(w.url, body, headers);
      ok = res.ok;
      status = res.status;
      error = res.error ?? null;
    } catch (e) {
      ok = false;
      status = null;
      error = (e as Error)?.message || 'Error de envío';
    }
    const delivery: WebhookDelivery = {
      id: 'WHD-' + this.ids.next().replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toUpperCase(),
      webhookId: w.id,
      event,
      status: ok ? 'DELIVERED' : 'FAILED',
      httpStatus: status,
      error: ok ? null : error,
      at,
      payloadSummary: `${event} · seller ${sellerId}`,
    };
    await this.repo.appendDelivery(delivery);
  }

  /**
   * Dispara un evento sintético de prueba (order.shipped) SOLO a este webhook,
   * para validar la conexión. Registra la entrega como cualquier evento real.
   */
  async test(user: User, id: string): Promise<WebhookDelivery> {
    const w = await this.mustOwn(user, id);
    const sellerId = w.scope === 'SELLER' && w.scopeId ? w.scopeId : 'test-seller';
    await this.deliverTo(w, 'order.shipped', sellerId, {
      test: true,
      message: 'Evento de prueba de Ninja Hubs WMS',
      at: this.clock.now(),
    });
    const list = await this.repo.listDeliveries(w.id);
    return list[0];
  }

  // ---- Mantenedor del administrador: acceso de clientes al panel -------------

  /** Activa/desactiva el panel de webhooks para un cliente (flag por seller). */
  async setClientAccess(sellerId: string, enabled: boolean): Promise<Seller> {
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw new NotFoundError(`Seller no encontrado: ${sellerId}`);
    const updated: Seller = { ...seller, webhooksClientEnabled: !!enabled };
    await this.sellers.save(updated);
    return updated;
  }

  /** Clientes de una operación con su flag de acceso al panel de webhooks. */
  async listClientsAccess(operationId: string): Promise<Array<{ id: string; name: string; webhooksClientEnabled: boolean; active: boolean }>> {
    const sellers = await this.sellers.list(operationId);
    return sellers.map((s) => ({
      id: s.id,
      name: s.name,
      webhooksClientEnabled: !!s.webhooksClientEnabled,
      active: s.active,
    }));
  }
}
