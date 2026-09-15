/**
 * WmsFacade — fachada de aplicación.
 * Orquesta el dominio (InventoryService) y los maestros (seller/sku/location).
 * Es lo que consumen los controllers HTTP. Aquí crecerán, en fases siguientes,
 * la reserva (allocation), el picking y el despacho.
 */
import { InventoryService, PutawayCommand, ReceiveCommand } from '../domain/inventory.service';
import { AttachLabelsInput, CreateOrderInput, OrderService } from '../domain/order.service';
import { CreateReceiptInput, ReceiptCountInput, ReceiptOrderService } from '../domain/receipt.service';
import { parseGs1 } from '../domain/gs1';
import { CreateReturnInput, ProcessReturnInput, ReturnService } from '../domain/return.service';
import { PackagingService } from '../domain/packaging.service';
import { OpsChannelService, SendOpsMessageInput } from '../domain/ops-channel.service';
import { ProductInput, ProductPatch, ProductService } from '../domain/product.service';
import { AttachTaxDocInput, BillingService, RatePatch } from '../domain/billing.service';
import { MetricsService } from '../domain/metrics.service';
import { RollupService } from '../domain/rollup.service';
import { LaborService } from '../domain/labor.service';
import { AbcService } from '../domain/abc.service';
import { CostingService } from '../domain/costing.service';
import { PlatformUsageService } from '../domain/platform-usage.service';
import { AnnouncementInput, AnnouncementPatch, AnnouncementService } from '../domain/announcement.service';
import { CreateWebhookInput, UpdateWebhookInput, WebhookService } from '../domain/webhook.service';
import { WebhookEventType } from '../domain/types';
import { ChatSender, ChatService } from '../domain/chat.service';
import { PutawayAdvisor } from '../domain/putaway.advisor';
import { CycleCountService } from '../domain/cyclecount.service';
import { CreateUserInput, UpdateUserInput, UserService } from '../domain/user.service';
import { OperationService } from '../domain/operation.service';
import { BarcodeService, RegisterPackInput } from '../domain/barcode.service';
import { ForbiddenError, NotFoundError, PlanLimitError, ValidationError } from '../domain/errors';
import { CORE_FEATURE, LIMIT_KEYS, MODULE_CATALOG, PLAN_CATALOG, PlanConfig, PlanDef, PlanFeature, PlanId, PlanLimits, defaultPlanConfig, effectivePlanId, mergeCatalog, planDef, trialStateOf } from '../domain/plans';
import { looksLikeJwt, signToken, verifyToken } from './auth-token';
import { toDomainEvents } from '../domain/domain-events';

/** Elimina el hash de contraseña antes de exponer un usuario por la API. */
function safeUser(u: User): User {
  const { passwordHash, ...rest } = u;
  void passwordHash;
  return rest as User;
}
import {
  LocationRepository,
  SellerRepository,
  SerialRepository,
  BrandingRepository,
  ShippingLabelProvider,
  SkuRepository,
  StockQuery,
} from '../domain/ports';
import { randomBytes } from 'crypto';
import {
  AuthToken,
  AuthTokenKind,
  CountLine,
  CountResult,
  CycleCountStrategy,
  CycleCountTask,
  Location,
  MovementType,
  LaborTaskType,
  WorkAssignment,
  WorkTaskType,
  WorkTask,
  WorkTaskStage,
  WorkTaskState,
  AgentRuleConfig,
  AgentAlert,
  AgentRuleSeverity,
  CostRateCard,
  AiRecommendation,
  AgentAction,
  Operation,
  OrderEvent,
  OrderStatus,
  PackConfig,
  Permission,
  PickingStrategy,
  PickTask,
  PutawaySuggestion,
  RotationClass,
  ReceiptOrder,
  ReceiptOrderStatus,
  ReturnOrder,
  SalesOrder,
  Serial,
  OperationBranding,
  OpsMessage,
  OpsAudioBlob,
  OpsInsights,
  OpsThreadRead,
  Seller,
  Sku,
  ScanResult,
  StockBalance,
  StockMovement,
  StockState,
  User,
  ZoneType,
} from '../domain/types';
import { AiConfigRepository, AiCredential, AuthTokenRepository, Clock, CopilotSettingsRepository, CountAuditRepository, EmailSender, EventRepository, IdGenerator, LotRepository, PlanConfigRepository, AiAuditRepository, WorkAssignmentRepository, WorkTaskRepository, AgentRuleConfigRepository, AgentAlertRepository, AgentJournalRepository, AgentJournalEntry, CopilotSettings } from '../domain/ports';
import { ACTION_POLICIES, decidePolicy, describePolicy, effectiveAgentSettings } from '../domain/agent-policy';
import { AGENT_RULES, AgentRuleDef, agentRuleDef } from '../domain/agent-rules';
import { ROLE_PERMISSIONS, UserRole } from '../domain/types';
import {
  buildInsights,
  parseCopilotIntent,
  CopilotAnswer,
  CopilotAnswerItem,
  CopilotPendingAction,
  CopilotInsight,
  COPILOT_SUGGESTIONS,
  InsightSnapshot,
  ReplenishItem,
} from '../domain/copilot';
import { askCopilotAgent, askCopilotChat, askCopilotLlmDetailed, listModels as listLlmModels, PROVIDER_DEFAULTS as COPILOT_PROVIDERS } from '../domain/copilot-llm';
import { COPILOT_TOOLS, COPILOT_ACTION_TOOLS } from '../domain/copilot-tools';

export interface CreateSkuInput {
  sku: string;
  description: string;
  barcode?: string | null;
  lotControlled?: boolean;
  serialControlled?: boolean;
  expiryControlled?: boolean;
  rotationClass?: RotationClass;
}

export interface CreateLocationInput {
  operationId: string;
  code: string;
  zoneType: ZoneType;
  warehouseId?: string;
  capacity?: number;
  pickRank?: number;
  x?: number | null;
  y?: number | null;
}

export class WmsFacade {
  constructor(
    private readonly inventory: InventoryService,
    private readonly orders: OrderService,
    private readonly receipts: ReceiptOrderService,
    private readonly products: ProductService,
    private readonly billing: BillingService,
    private readonly sellers: SellerRepository,
    private readonly skus: SkuRepository,
    private readonly locations: LocationRepository,
    private readonly ids: IdGenerator,
    private readonly putawayAdvisor: PutawayAdvisor,
    private readonly cycleCounts: CycleCountService,
    private readonly usersService: UserService,
    private readonly barcodes: BarcodeService,
    private readonly operationsService: OperationService,
    private readonly metrics: MetricsService,
    private readonly chat: ChatService,
    private readonly platformUsageService: PlatformUsageService,
    private readonly announcements: AnnouncementService,
    private readonly webhooks: WebhookService,
    private readonly shippingLabels: ShippingLabelProvider,
    private readonly returnsService: ReturnService,
    private readonly serials?: SerialRepository,
    private readonly packaging?: PackagingService,
    private readonly branding?: BrandingRepository,
    private readonly opsChannel?: OpsChannelService,
    private readonly clock?: Clock,
    private readonly lots?: LotRepository,
    private readonly aiConfig?: AiConfigRepository,
    private readonly copilotSettings?: CopilotSettingsRepository,
    private readonly authTokens?: AuthTokenRepository,
    private readonly emailSender?: EmailSender,
    private readonly planConfig?: PlanConfigRepository,
    private readonly countAudits?: CountAuditRepository,
    private readonly events?: EventRepository,
    private readonly rollupService?: RollupService,
    private readonly laborService?: LaborService,
    private readonly aiAudit?: AiAuditRepository,
    private readonly abcService?: AbcService,
    private readonly assignments?: WorkAssignmentRepository,
    private readonly costing?: CostingService,
    private readonly taskLedger?: WorkTaskRepository,
    private readonly agentRuleConfig?: AgentRuleConfigRepository,
    private readonly agentAlertRepo?: AgentAlertRepository,
    private readonly agentJournal?: AgentJournalRepository,
  ) {}

  /** Ahora en ISO — usa el reloj inyectado (tests deterministas) o la hora real. */
  private clockNow(): string { return this.clock ? this.clock.now() : new Date().toISOString(); }

  // ---- Canal de voz operador↔admin -----------------------------------------
  /** Operador o admin envía un mensaje (voz o texto) a un hilo de la operación. */
  async sendOpsMessage(operationId: string, input: SendOpsMessageInput): Promise<OpsMessage> {
    if (!this.opsChannel) throw new ValidationError('Canal de voz no disponible');
    await this.assertFeature(operationId, 'voice_channel', 'El canal de voz operativo');
    return this.opsChannel.send(operationId, input);
  }
  /** Lista mensajes del canal (todos, o de un hilo/operador puntual). */
  async listOpsMessages(operationId: string, filter?: { threadUserId?: string }): Promise<OpsMessage[]> {
    if (!this.opsChannel) return [];
    return this.opsChannel.listMessages(operationId, filter);
  }
  /** Recupera el audio (base64) de un mensaje de voz para reproducción. */
  async getOpsAudio(operationId: string, audioId: string): Promise<OpsAudioBlob | null> {
    if (!this.opsChannel) return null;
    return this.opsChannel.getAudio(operationId, audioId);
  }
  /** Marca un hilo como leído por un lado (para el "visto" estilo WhatsApp). */
  async markOpsRead(operationId: string, threadUserId: string, side: 'ADMIN' | 'OPERATOR'): Promise<OpsThreadRead | null> {
    if (!this.opsChannel) return null;
    await this.opsChannel.markRead(operationId, threadUserId, side);
    return this.opsChannel.getRead(operationId, threadUserId);
  }
  /** Estado de lectura de un hilo (hasta cuándo leyó cada lado). */
  async getOpsRead(operationId: string, threadUserId: string): Promise<OpsThreadRead> {
    const empty: OpsThreadRead = { operationId, threadUserId, adminReadAt: null, operatorReadAt: null };
    if (!this.opsChannel) return empty;
    return (await this.opsChannel.getRead(operationId, threadUserId)) ?? empty;
  }
  /** Estadísticas del canal: volumen y distribución por tópico y por operador. */
  async opsChannelStats(operationId: string) {
    if (!this.opsChannel) return { total: 0, voice: 0, text: 0, byCategory: [], byOperator: [] };
    return this.opsChannel.stats(operationId);
  }
  /** Insights de mejora sobre el historial del canal (IA real o heurística). */
  async opsChannelInsights(operationId: string): Promise<OpsInsights> {
    if (!this.opsChannel) {
      return { summary: 'Canal no disponible.', topTopics: [], suggestions: [], generatedBy: 'heuristic', totalMessages: 0 };
    }
    return this.opsChannel.insights(operationId);
  }

  // ---- Copiloto del WMS (Fase 1: preguntar + insights, grounded) -----------
  /** SellerIds en alcance: el seller indicado, o todos los de la operación. */
  private async copilotScope(operationId: string, sellerId?: string | null): Promise<string[]> {
    if (sellerId) return [sellerId];
    const sellers = await this.sellers.list(operationId);
    return sellers.map((s) => s.id);
  }
  /** On-hand por SKU (suma de saldos) para un seller. */
  private async onHandBySku(sellerId: string): Promise<Record<string, number>> {
    const balances = await this.inventory.getStock({ sellerId, includeZeros: true });
    const acc: Record<string, number> = {};
    for (const b of balances) acc[b.sku] = (acc[b.sku] || 0) + b.qty;
    return acc;
  }
  /** Insights proactivos (la tarjeta "aha") para la operación o un seller. */
  async copilotInsights(operationId: string, sellerId?: string | null): Promise<{ insights: CopilotInsight[] }> {
    const scope = await this.copilotScope(operationId, sellerId);
    const now = Date.parse(this.clockNow());
    const DAY = 86400000;
    const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
    const snap: InsightSnapshot = { lowStock: [], agingOrders: [], pendingPick: 0, toAllocate: 0, shippedToday: 0 };
    for (const sid of scope) {
      const [orders, skus, onHand, demand30] = await Promise.all([
        this.orders.listOrders(sid), this.skus.list(sid), this.onHandBySku(sid), this.skuDemand(sid, now - 30 * DAY),
      ]);
      // Reabastecimiento por SKU: según la demanda (salidas) de los últimos 30 días.
      for (const sk of skus) {
        if (sk.active === false) continue;
        const oh = onHand[sk.sku] || 0;
        const d = demand30[sk.sku] || 0;
        if (d > 0 && oh < d) {
          const coverageDays = Math.floor(oh / (d / 30));
          snap.lowStock.push({ sku: sk.sku, name: sk.description || sk.sku, onHand: oh, demand: d, windowDays: 30, coverageDays, reorder: Math.max(0, d - oh) });
        }
      }
      for (const o of orders) {
        if (o.status === 'SHIPPED') {
          const ev = (o.events || []).find((e) => e.type === 'SHIPPED');
          if (ev && Date.parse(ev.at) >= startToday.getTime()) snap.shippedToday += 1;
          continue;
        }
        if (o.status === 'CANCELLED') continue;
        if (o.status === 'RECEIVED') snap.toAllocate += 1;
        if (o.status === 'ALLOCATED' || o.status === 'PICKING') snap.pendingPick += 1;
        const days = Math.floor((now - Date.parse(o.createdAt)) / DAY);
        if (days > 2) snap.agingOrders.push({ id: o.id, ref: o.externalOrderId || o.id, days, status: o.status });
      }
    }
    snap.lowStock.sort((a, b) => a.coverageDays - b.coverageDays);
    snap.agingOrders.sort((a, b) => b.days - a.days);
    // Lotes por vencer (FEFO): buckets con saldo cruzados con la metadata de lote.
    snap.expiringLots = [];
    for (const sid of scope) snap.expiringLots.push(...await this.expiringLots(sid, now));
    snap.expiringLots.sort((a, b) => a.days - b.days);
    // Insumos de embalaje por agotarse (nivel operación).
    snap.packagingLow = await this.packagingLow(operationId);
    // Anomalías de consumo (despachos) por cliente vs semana previa.
    snap.anomalies = await this.consumptionAnomalies(scope, now);
    return { insights: buildInsights(snap) };
  }
  /** Lotes con saldo cuyo vencimiento está próximo (≤14 días) o ya pasó. */
  private async expiringLots(sellerId: string, now: number): Promise<{ sku: string; lot: string; days: number; qty: number }[]> {
    if (!this.lots) return [];
    const DAY = 86400000;
    const balances = (await this.inventory.getStock({ sellerId })).filter((b) => b.qty > 0 && b.lot);
    const byLot: Record<string, number> = {};
    for (const b of balances) { const k = `${b.sku}||${b.lot}`; byLot[k] = (byLot[k] || 0) + b.qty; }
    const out: { sku: string; lot: string; days: number; qty: number }[] = [];
    for (const k of Object.keys(byLot)) {
      const [sku, lot] = k.split('||');
      const meta = await this.lots.get(sellerId, sku, lot);
      if (!meta || !meta.expiryDate) continue;
      const days = Math.floor((Date.parse(meta.expiryDate) - now) / DAY);
      if (days <= 14) out.push({ sku, lot, days, qty: byLot[k] });
    }
    return out;
  }
  /** Demanda (unidades de salida) por SKU desde `sinceMs`, a partir de los PICK del ledger. */
  private async skuDemand(sellerId: string, sinceMs: number): Promise<Record<string, number>> {
    const movs = await this.listMovements(sellerId, 1_000_000);
    const acc: Record<string, number> = {};
    for (const m of movs) {
      if (m.type !== 'PICK') continue; // PICK = salida real de la ubicación (demanda servida)
      if (Date.parse(m.occurredAt) < sinceMs) continue;
      const out = Math.max(0, -m.qtyDelta);
      if (out) acc[m.sku] = (acc[m.sku] || 0) + out;
    }
    return acc;
  }
  /**
   * Insumos de embalaje a reabastecer según el CONSUMO de los últimos 14 días.
   * Alerta cuando el saldo no cubre las próximas 2 semanas al ritmo observado.
   */
  private async packagingLow(operationId: string): Promise<ReplenishItem[]> {
    if (!this.packaging) return [];
    const now = Date.parse(this.clockNow());
    const since = now - 14 * 86400000;
    const materials = await this.listPackaging(operationId);
    const movements = await this.listPackagingMovements(operationId);
    const onHand: Record<string, number> = {};
    const demand14: Record<string, number> = {};
    for (const mv of movements) {
      onHand[mv.materialSku] = (onHand[mv.materialSku] || 0) + mv.qtyDelta;
      if ((mv.type === 'CONSUMPTION' || mv.qtyDelta < 0) && Date.parse(mv.occurredAt) >= since) {
        demand14[mv.materialSku] = (demand14[mv.materialSku] || 0) + Math.max(0, -mv.qtyDelta);
      }
    }
    const out: ReplenishItem[] = [];
    for (const m of materials as any[]) {
      if (m.active === false) continue;
      const oh = onHand[m.sku] || 0;
      const d = demand14[m.sku] || 0;
      if (d > 0 && oh < d) {
        const coverageDays = Math.floor(oh / (d / 14));
        out.push({ sku: m.sku, name: m.name, onHand: oh, demand: d, windowDays: 14, coverageDays, reorder: Math.max(0, d - oh) });
      }
    }
    return out.sort((a, b) => a.coverageDays - b.coverageDays);
  }
  /** Anomalías: despachos de los últimos 7 días vs. los 7 previos, por cliente. */
  private async consumptionAnomalies(scope: string[], now: number): Promise<{ sellerName: string; metric: string; changePct: number; from: number; to: number }[]> {
    const DAY = 86400000;
    const curFrom = now - 7 * DAY, prevFrom = now - 14 * DAY;
    const out: { sellerName: string; metric: string; changePct: number; from: number; to: number }[] = [];
    for (const sid of scope) {
      const orders = await this.orders.listOrders(sid);
      let cur = 0, prev = 0;
      for (const o of orders) {
        const ev = (o.events || []).find((e) => e.type === 'SHIPPED');
        if (!ev) continue;
        const t = Date.parse(ev.at);
        if (t >= curFrom) cur += 1; else if (t >= prevFrom) prev += 1;
      }
      if (prev + cur < 5) continue; // volumen bajo: no es señal confiable
      const base = prev === 0 ? 1 : prev;
      const changePct = Math.round(((cur - prev) / base) * 100);
      if (Math.abs(changePct) >= 40) {
        const name = (await this.sellers.findById(sid))?.name || sid;
        out.push({ sellerName: name, metric: 'despachos 7d', changePct, from: prev, to: cur });
      }
    }
    return out.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
  }
  /** Responde una pregunta en lenguaje natural con datos reales (read-only). */
  async copilotAsk(operationId: string, sellerId: string | null, question: string, history?: { role: 'user' | 'assistant'; content: string }[], actor?: { id?: string; role?: string } | null): Promise<CopilotAnswer> {
    const parsed = parseCopilotIntent(question || '');
    const scope = await this.copilotScope(operationId, sellerId);
    // Si es un seguimiento en una conversación en curso y hay IA conectada, respondemos
    // SIEMPRE con el LLM (con el hilo completo) para que la conversación fluya natural.
    if (history && history.length > 0) {
      const cred = await this.resolveAiCredential(operationId, sellerId);
      if (cred) return this.copilotLlmAnswer(operationId, sellerId, question, history, cred, actor);
    }
    const link = (pg: string) => pg;

    // Detección de SKU real: valida el candidato contra el catálogo del alcance.
    let skuMatch: { sellerId: string; sku: Sku } | null = null;
    if (parsed.skuGuess) {
      for (const sid of scope) {
        const list = await this.skus.list(sid);
        const hit = list.find((s) => s.sku.toUpperCase() === parsed.skuGuess || (s.barcode || '').toUpperCase() === parsed.skuGuess);
        if (hit) { skuMatch = { sellerId: sid, sku: hit }; break; }
      }
    }
    const intent = skuMatch ? 'sku_stock' : parsed.intent;

    if (intent === 'sku_stock' && skuMatch) {
      const onHand = await this.onHandBySku(skuMatch.sellerId);
      const total = onHand[skuMatch.sku.sku] || 0;
      const balances = (await this.inventory.getStock({ sellerId: skuMatch.sellerId, sku: skuMatch.sku.sku })).filter((b) => b.qty > 0);
      const locs = await this.locations.listByOperation(operationId);
      const codeOf = (id: string) => { const l = locs.find((x) => x.id === id); return l ? l.code : id; };
      const items = balances.map((b) => ({ label: codeOf(b.locationId) + (b.lot ? ` · lote ${b.lot}` : ''), value: String(b.qty) }));
      return {
        intent: 'sku_stock',
        answer: `${skuMatch.sku.sku} (${skuMatch.sku.description || ''}) tiene ${total} unidad(es) en stock` + (items.length ? ` en ${items.length} ubicación(es).` : ' (sin ubicaciones con saldo).'),
        items, link: link('inventory'),
      };
    }

    if (intent === 'low_stock') {
      const now = Date.parse(this.clockNow());
      const low: ReplenishItem[] = [];
      for (const sid of scope) {
        const [skus, onHand, demand30] = await Promise.all([this.skus.list(sid), this.onHandBySku(sid), this.skuDemand(sid, now - 30 * 86400000)]);
        for (const sk of skus) {
          if (sk.active === false) continue;
          const oh = onHand[sk.sku] || 0; const d = demand30[sk.sku] || 0;
          if (d > 0 && oh < d) low.push({ sku: sk.sku, name: sk.description || sk.sku, onHand: oh, demand: d, windowDays: 30, coverageDays: Math.floor(oh / (d / 30)), reorder: Math.max(0, d - oh) });
        }
      }
      low.sort((a, b) => a.coverageDays - b.coverageDays);
      return {
        intent, link: link('inventory'),
        answer: low.length ? `${low.length} SKU(s) requieren reabastecimiento (saldo no cubre la demanda de 30 días). Prioridad por cobertura:` : 'Ningún SKU requiere reabastecimiento: el saldo cubre la demanda del último mes. 👍',
        items: low.slice(0, 10).map((x) => ({ label: `${x.sku} · demanda ${x.demand}/mes`, value: `quedan ${x.onHand} · ~${x.coverageDays}d · reponer ${x.reorder}` })),
      };
    }

    if (intent === 'pending_pick') {
      let n = 0; const items: CopilotAnswerItem[] = [];
      for (const sid of scope) { const q = await this.getPickingQueue(sid); n += q.length; for (const o of q.slice(0, 8)) items.push({ label: `${o.externalOrderId || o.id}`, value: `#${o.queuePosition} · ${o.carrier || 's/courier'}` }); }
      return { intent, link: link('pickqueue'), answer: n ? `Hay ${n} orden(es) en la cola de preparación (orden por prioridad de courier y FIFO):` : 'La cola de preparación está vacía.', items: items.slice(0, 10) };
    }

    if (intent === 'shipped') {
      const now = Date.parse(this.clockNow());
      const span = parsed.window === 'month' ? 30 : parsed.window === 'week' ? 7 : 1;
      const from = parsed.window === 'today' ? (() => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime(); })() : now - span * 86400000;
      let n = 0;
      for (const sid of scope) { const orders = await this.orders.listOrders(sid); for (const o of orders) { const ev = (o.events || []).find((e) => e.type === 'SHIPPED'); if (ev && Date.parse(ev.at) >= from) n += 1; } }
      const wlabel = parsed.window === 'month' ? 'este mes' : parsed.window === 'week' ? 'en los últimos 7 días' : 'hoy';
      return { intent, link: link('orders'), answer: `Se despacharon ${n} orden(es) ${wlabel}.` };
    }

    if (intent === 'open_orders') {
      const byStatus: Record<string, number> = {}; let total = 0;
      for (const sid of scope) { const orders = await this.orders.listOrders(sid); for (const o of orders) { if (o.status === 'SHIPPED' || o.status === 'CANCELLED') continue; byStatus[o.status] = (byStatus[o.status] || 0) + 1; total += 1; } }
      const label: Record<string, string> = { RECEIVED: 'Ingresadas', ALLOCATED: 'Reservadas', PICKING: 'En picking', PICKED: 'Pickeadas', PACKED: 'Empacadas' };
      return { intent, link: link('orders'), answer: total ? `Tienes ${total} orden(es) abiertas (sin despachar):` : 'No tienes órdenes abiertas: todo despachado o cancelado.', items: Object.keys(byStatus).map((k) => ({ label: label[k] || k, value: String(byStatus[k]) })) };
    }

    if (intent === 'billing_month') {
      const d = new Date(Date.parse(this.clockNow()));
      const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
      let total = 0; let currency = 'CLP'; const items: CopilotAnswerItem[] = [];
      for (const sid of scope) {
        try {
          const inv = await this.previewInvoice(sid, y, m);
          const sub = (inv.lines || []).reduce((a: number, l: any) => a + (l.amount || 0), 0);
          currency = inv.currency || currency; total += sub;
          const sellerName = (await this.sellers.findById(sid))?.name || sid;
          if (sub > 0) items.push({ label: sellerName, value: sub.toLocaleString('es-CL') });
        } catch { /* seller sin tarifario */ }
      }
      return { intent, link: link('billing'), answer: `Consumo estimado del mes en curso: ${currency} ${total.toLocaleString('es-CL')} (pre-factura, según tarifario).`, items };
    }

    if (intent === 'expiring') {
      const now = Date.parse(this.clockNow());
      const all: { sku: string; lot: string; days: number; qty: number }[] = [];
      for (const sid of scope) all.push(...await this.expiringLots(sid, now));
      all.sort((a, b) => a.days - b.days);
      return {
        intent, link: link('inventory'),
        answer: all.length ? `Hay ${all.length} lote(s) por vencer (≤14 días) o vencidos. Los más urgentes:` : 'No hay lotes por vencer en los próximos 14 días. 👍',
        items: all.slice(0, 10).map((l) => ({ label: `${l.sku} · lote ${l.lot}`, value: (l.days < 0 ? 'vencido' : `${l.days}d`) + ` · ${l.qty}u` })),
      };
    }

    if (intent === 'packaging_low') {
      const low = await this.packagingLow(operationId);
      return {
        intent, link: link('packaging'),
        answer: low.length ? `${low.length} insumo(s) de embalaje requieren reabastecimiento (consumo de 14 días > saldo). Prioridad por cobertura:` : 'Los insumos de embalaje cubren el consumo de las próximas 2 semanas. 👍',
        items: low.slice(0, 10).map((p) => ({ label: `${p.sku} · ${p.name} · consumo ${p.demand}/14d`, value: `quedan ${p.onHand} · ~${p.coverageDays}d · reponer ${p.reorder}` })),
      };
    }

    if (intent === 'anomalies') {
      const now = Date.parse(this.clockNow());
      const an = await this.consumptionAnomalies(scope, now);
      return {
        intent, link: link('reports'),
        answer: an.length ? `Detecté ${an.length} anomalía(s) de consumo (despachos 7d vs. semana previa):` : 'Sin anomalías de consumo relevantes esta semana.',
        items: an.slice(0, 10).map((a) => ({ label: a.sellerName, value: `${a.changePct > 0 ? '▲ +' : '▼ '}${Math.abs(a.changePct)}% (${a.from}→${a.to})` })),
      };
    }

    // help / no reconocida: si el tenant conectó su LLM, respondemos libre PERO grounded
    // (con un resumen de datos reales); si no, devolvemos sugerencias deterministas.
    const cred = await this.resolveAiCredential(operationId, sellerId);
    if (cred) return this.copilotLlmAnswer(operationId, sellerId, question, history || [], cred, actor);
    return {
      intent: 'help',
      answer: 'Puedo responder sobre tu operación con datos en vivo. Prueba con una de estas:',
      suggestions: COPILOT_SUGGESTIONS,
    };
  }
  /** Respuesta conversacional con el LLM del tenant, grounded en el contexto completo. */
  private async copilotLlmAnswer(operationId: string, sellerId: string | null, question: string, history: { role: 'user' | 'assistant'; content: string }[], cred: AiCredential, actor?: { id?: string; role?: string } | null): Promise<CopilotAnswer> {
    const ctx = await this.copilotContext(operationId, sellerId);
    let sys = [
      'Eres el copiloto de Ninja WMS: hablas como un colega experto de bodega, cercano y claro.',
      'Responde SIEMPRE en español (Chile), en tono natural y conversacional, como si le hablaras a un compañero — NO como un reporte.',
      'Escribe en prosa breve: 1 a 4 frases. Parte por la respuesta o cifra clave y, si suma, agrega un comentario útil o una recomendación corta.',
      'MUY IMPORTANTE: escribe TODOS los datos numéricos en negrita usando **markdown** (cantidades, montos, porcentajes, días, conteos). Ej: "Tienes **23.728** unidades". Los miles con punto (23.728).',
      'NO uses tablas, NO uses encabezados (#, ##), NO uses listas con viñetas salvo que el usuario lo pida explícitamente; si enumeras pocas cosas, hazlo dentro de una frase separadas por comas.',
      'Cuando propongas un siguiente paso, hazlo como una pregunta u ofrecimiento natural (ej: "¿Quieres que revise…?") para invitar a continuar la conversación.',
      'Tienes HERRAMIENTAS para consultar datos en vivo del WMS (kardex, línea de tiempo de órdenes, facturación, canal de voz, etc.). Úsalas cuando necesites un dato que no esté en el resumen. Responde SOLO con datos reales (del resumen o de las herramientas); nunca inventes cifras.',
    ].join(' ');
    const canWrite = this.copilotCanWrite(actor?.role);
    const settings = await this.agentSettings(operationId);
    const mode = settings.actionMode;
    if (canWrite) {
      sys += ' Además puedes EJECUTAR acciones sobre órdenes con la herramienta avanzar_estado_orden (reservar, pickear, empacar, despachar), CREAR una recepción nueva (crear_recepcion) o una orden de salida nueva reservando su stock si te lo piden (crear_orden), asignar CUALQUIER tipo de tarea que ejecuta un operario —PICK, PACK, SHIP, PUTAWAY, RECEIVE, RESLOT o COUNT— (asignar_tarea), balancear la carga (balancear_carga), y CONFIGURAR LOS AUTOMATISMOS de la bodega: activar/desactivar el auto-balanceo continuo (activar_auto_balanceo), fijar el modo de asignación advisory/estricto (fijar_modo_asignacion) y disparar la reasignación por ociosidad (reasignar_ociosidad). Cuando el administrador te da una directriz para "operar en automático" (ej. "mantén el equipo balanceado solo", "que nadie quede ocioso"), traduce esa intención a estas herramientas de automatismo. Para crear órdenes o recepciones, si no sabes el id del cliente usa clientes_operacion y si no conoces los SKU usa catalogo_productos antes de crear.';
      sys += mode === 'confirm'
        ? ' El modo es CONFIRMACIÓN: las acciones que la política no permite ejecutar directamente NO se ejecutan al invocar la herramienta; quedan PROPUESTAS para que el usuario confirme (el resultado de la herramienta te dirá si se ejecutó o quedó propuesta). Si el usuario pide avanzar VARIAS órdenes (ej. "despacha las 3 que están listas"), invoca la herramienta UNA VEZ POR CADA orden en este mismo turno, para dejarlas TODAS propuestas. Nunca digas que algo se ejecutó si la herramienta respondió que quedó propuesto. No inventes órdenes: usa las herramientas de consulta (listar_ordenes) para saber cuáles corresponden.'
        : ' El modo es DIRECTO: la acción se ejecuta al invocar la herramienta salvo que la política de autonomía la deje propuesta (la herramienta te lo dirá). Si el usuario pide varias órdenes, invoca la herramienta una vez por cada una y confírmale lo realizado.';
      sys += ' Con guardar_instruccion puedes anotar directrices del administrador para el agente (ej. "hoy priorizar Chilexpress") y quedan vigentes en los próximos ciclos.';
      sys += ' POLÍTICA DEL AGENTE: ' + describePolicy(settings);
    }
    sys += `\n\n=== RESUMEN DE LA OPERACIÓN (punto de partida; usa herramientas para profundizar) ===\n${ctx}`;
    const tools = canWrite ? [...COPILOT_TOOLS, ...COPILOT_ACTION_TOOLS] : COPILOT_TOOLS;
    // Recolectamos TODAS las acciones propuestas en el turno (el LLM puede pedir varias).
    const pendingActions: CopilotPendingAction[] = [];
    const exec = async (name: string, args: any) => {
      // Herramientas de ACCIÓN (escritura): se resuelven en copilotExecAction, un
      // método directamente testeable. Si no es una acción, cae a las de lectura.
      const r = await this.copilotExecAction(name, args, { operationId, sellerId, mode, canWrite, question, actor: actor ?? null, pendingActions, settings });
      return r !== undefined ? r : this.runCopilotTool(name, args, operationId, sellerId);
    };
    // Historial acotado (últimos 12 turnos) + la pregunta actual.
    const turns = [...(history || []).slice(-12), { role: 'user' as const, content: question }];
    const res = await askCopilotAgent(cred, sys, turns, tools, exec);
    // Auditoría de LECTURAS: qué consultó el copiloto y sobre qué alcance (una entrada por turno).
    if (res.toolsUsed && res.toolsUsed.length) await this.journal(operationId, 'tools', actor?.id || 'copiloto', `Consultó: ${res.toolsUsed.join(', ')} (alcance ${sellerId || 'operación'})`, { toolsUsed: res.toolsUsed, sellerId });
    if (res.text) return { intent: 'help', answer: res.text, link: null, toolsUsed: res.toolsUsed, pendingAction: pendingActions[0] || undefined, pendingActions: pendingActions.length ? pendingActions : undefined };
    return {
      intent: 'help',
      answer: `La IA (${((COPILOT_PROVIDERS as any)[cred.provider] || {}).label || cred.provider}) no pudo responder — ${res.error || 'error desconocido'}. Mientras tanto puedes usar estas preguntas:`,
      suggestions: COPILOT_SUGGESTIONS,
    };
  }

  /**
   * Ejecuta una herramienta de ACCIÓN del copiloto (escritura). Devuelve el resultado
   * de la acción, o `undefined` si `name` no es una acción (para que el caller caiga a
   * las herramientas de lectura). Extraído del closure para poder testearlo sin LLM.
   */
  private async copilotExecAction(
    name: string,
    args: any,
    ctx: { operationId: string; sellerId: string | null; mode: 'confirm' | 'direct'; canWrite: boolean; question: string; actor?: { id?: string; role?: string } | null; pendingActions: CopilotPendingAction[]; settings?: Required<CopilotSettings>; autonomous?: boolean; confirmed?: boolean; usage?: { cycle: number; hour: number } },
  ): Promise<any | undefined> {
    const { operationId, sellerId, canWrite, question, actor, pendingActions } = ctx;
    const isAction = ACTION_POLICIES.some((p) => p.tool === name);
    if (!isAction) return undefined; // no es una acción → el caller usa las herramientas de lectura
    if (!canWrite) return { error: 'No tienes permisos para ejecutar acciones.' };
    const settings = ctx.settings ?? await this.agentSettings(operationId);
    const pol = decidePolicy({ tool: name, settings, autonomous: !!ctx.autonomous, confirmed: !!ctx.confirmed, usage: ctx.usage });
    if (pol.decision === 'deny') return { error: `Acción no permitida: ${pol.reason}.` };
    // Toda acción que la política deja PROPUESTA (salvo avanzar_estado_orden, que tiene su
    // propio flujo por orden) queda como propuesta genérica {tool, args} para confirmar.
    if (pol.decision === 'propose' && name !== 'avanzar_estado_orden') {
      const label = pol.policy?.label || name;
      const resumen = `${label}: ${this.describeActionArgs(name, args)}`;
      if (!pendingActions.some((p) => p.tool === name && JSON.stringify(p.args || {}) === JSON.stringify(args || {}))) {
        pendingActions.push({ orden: '', orderId: '', sellerId: sellerId || '', accion: name, from: '', to: '', tool: name, args: args || {}, resumen });
        await this.recordRecommendation({ operationId, sellerId: sellerId || null, type: 'copilot_action', input: question, output: resumen, score: null, taken: null, outcome: null, actor: actor?.id || (ctx.autonomous ? 'agente' : 'copiloto') });
      }
      return { requiresConfirmation: true, resumen: `Propuesta registrada (${pol.reason}): ${resumen}. Un humano la confirmará; NO la des por ejecutada.` };
    }
    const mode: 'confirm' | 'direct' = pol.decision === 'execute' ? 'direct' : 'confirm';
    if (name === 'guardar_instruccion') {
      const texto = String(args?.texto ?? args?.instruccion ?? '').trim();
      if (!texto) return { error: 'Falta el texto de la instrucción.' };
      const dias = Number(args?.diasVigencia ?? 0);
      const expiresAt = dias > 0 ? new Date(Date.parse(this.clockNow()) + dias * 86400000).toISOString() : null;
      const id = await this.journal(operationId, 'instruction', actor?.id || 'copiloto', texto, { sellerId: sellerId || null }, expiresAt);
      await this.recordAgentAction({ operationId, sellerId: sellerId || null, agent: 'copilot', decision: `instrucción: ${texto.slice(0, 80)}`, actor: actor?.id || 'copiloto', orderRef: null, result: 'ok', recommendationId: null });
      return { ok: true, id, instruccion: texto, vigencia: expiresAt ? `hasta ${expiresAt.slice(0, 10)}` : 'hasta que se retire' };
    }
    if (name === 'avanzar_estado_orden') {
      const resolved = await this.copilotResolveOrder(operationId, sellerId, args?.orden);
      if (!resolved) return { error: 'Orden no encontrada.' };
      const plan = this.copilotPlanAction(resolved.order, args?.accion);
      if ('error' in plan) return { error: plan.error };
      const ordenRefD = resolved.order.externalOrderId || resolved.order.id;
      if (mode === 'direct') {
        // G5: en modo directo la IA ejecuta; queda como recomendación TOMADA + acción.
        const recId = await this.recordRecommendation({ operationId, sellerId: resolved.sellerId, type: 'copilot_action', input: question, output: `${args.accion} ${ordenRefD}`, score: null, taken: true, outcome: null, actor: actor?.id || 'copiloto' });
        try {
          const o = await this.copilotRunOrderAction(resolved.sellerId, resolved.order.id, args.accion, actor?.id || 'copiloto');
          await this.recordAgentAction({ operationId, sellerId: resolved.sellerId, agent: 'copilot', decision: args.accion, actor: actor?.id || 'copiloto', orderRef: o.externalOrderId || o.id, result: `ok: ${o.status}`, recommendationId: recId });
          return { ok: true, orden: o.externalOrderId || o.id, nuevoEstado: o.status };
        } catch (e: any) {
          const msg = (e && e.message) || 'no se pudo ejecutar';
          await this.recordAgentAction({ operationId, sellerId: resolved.sellerId, agent: 'copilot', decision: args.accion, actor: actor?.id || 'copiloto', orderRef: ordenRefD, result: `error: ${msg}`, recommendationId: recId });
          return { error: msg };
        }
      }
      const ordenRef = ordenRefD;
      // Evita proponer dos veces la misma orden+acción en un mismo turno.
      if (!pendingActions.some((p) => p.orderId === resolved.order.id && p.accion === args.accion)) {
        pendingActions.push({ orden: ordenRef, orderId: resolved.order.id, sellerId: resolved.sellerId, accion: args.accion, from: plan.from, to: plan.to });
        // G5: registra la propuesta (aún no tomada) para medir aceptación.
        await this.recordRecommendation({ operationId, sellerId: resolved.sellerId, type: 'copilot_action', input: question, output: `${args.accion} ${ordenRef}`, score: null, taken: null, outcome: null, actor: actor?.id || 'copiloto' });
      }
      return { requiresConfirmation: true, resumen: `Propuesta registrada: ${args.accion} la orden ${ordenRef} (${plan.from} → ${plan.to}). El usuario la confirmará; NO la des por ejecutada. Puedes proponer más órdenes si corresponde.` };
    }
    // Asignación de tareas (Camino B): son reversibles (reasignar/liberar), así que
    // la IA las ejecuta directo y quedan auditadas. Soporta los 7 tipos de tarea.
    if (name === 'asignar_tarea') {
      if (!canWrite) return { error: 'No tienes permisos para asignar tareas.' };
      const tipo = (args?.tipo || 'PICK') as WorkTaskType;
      const operario = String(args?.operario || '').trim();
      if (!operario) return { error: 'Falta el operario.' };
      let entityId = String(args?.entidad || '');
      let entityRef: string | null = entityId;
      let units = 0;
      let sid: string | null = null;
      if (tipo === 'PICK' || tipo === 'PACK' || tipo === 'SHIP') {
        // Tareas ligadas a una orden: se resuelven por n° de orden.
        const resolved = await this.copilotResolveOrder(operationId, sellerId, args?.entidad);
        if (!resolved) return { error: 'Orden no encontrada para asignar.' };
        entityId = resolved.order.id; entityRef = resolved.order.externalOrderId || resolved.order.id;
        units = (resolved.order.lines || []).reduce((s, l) => s + l.qty, 0); sid = resolved.sellerId;
      } else {
        // RECEIVE/PUTAWAY/RESLOT/COUNT: resuelve la tarea desde el pool por id o referencia
        // para completar unidades (peso del balanceo) y cliente (aislamiento por tenant).
        const pool = await this.getTaskPool(operationId, tipo).catch(() => [] as Awaited<ReturnType<WmsFacade['getTaskPool']>>);
        const key = String(args?.entidad || '').trim();
        const match = pool.find((p) => p.entityId === key || p.entityRef === key || (p.entityRef || '').toLowerCase() === key.toLowerCase());
        if (match) { entityId = match.entityId; entityRef = match.entityRef; units = match.unidades; sid = match.sellerId; }
        else if (!key) return { error: `Falta la tarea a asignar. Usa tareas_pendientes (tipo ${tipo}) para ver los pendientes.` };
      }
      try {
        await this.assignTask(operationId, { type: tipo, entityId, entityRef, sellerId: sid, operator: operario, unitsEstimate: units, by: actor?.id || 'copiloto', note: 'asignada por copiloto' });
        await this.recordAgentAction({ operationId, sellerId: sid, agent: 'copilot', decision: `asignar ${tipo} ${entityRef} → ${operario}`, actor: actor?.id || 'copiloto', orderRef: entityRef, result: 'ok', recommendationId: null });
        return { ok: true, asignada: entityRef, tipo, operario };
      } catch (e: any) { return { error: (e && e.message) || 'no se pudo asignar' }; }
    }
    if (name === 'balancear_carga') {
      if (!canWrite) return { error: 'No tienes permisos para balancear.' };
      const tipo = (args?.tipo || 'PICK') as WorkTaskType;
      try {
        const r = await this.autoBalance(operationId, { type: tipo, execute: true, by: actor?.id || 'copiloto' });
        await this.recordAgentAction({ operationId, sellerId: null, agent: 'copilot', decision: `balancear carga (${tipo})`, actor: actor?.id || 'copiloto', orderRef: null, result: `ok: ${r.asignadas} tareas repartidas`, recommendationId: null });
        return { ok: true, asignadas: r.asignadas, porOperario: r.porOperario };
      } catch (e: any) { return { error: (e && e.message) || 'no se pudo balancear' }; }
    }
    if (name === 'activar_auto_balanceo') {
      if (!canWrite) return { error: 'No tienes permisos para configurar automatismos.' };
      try {
        const on = args?.activar !== false && args?.activar !== 'false';
        const r = await this.setAutoBalanceContinuous(operationId, on);
        await this.recordAgentAction({ operationId, sellerId: null, agent: 'copilot', decision: `auto-balanceo continuo ${on ? 'ON' : 'OFF'}`, actor: actor?.id || 'copiloto', orderRef: null, result: 'ok', recommendationId: null });
        return { ok: true, autoBalanceo: on ? 'activado' : 'desactivado', asignadasInicial: (r as any)?.asignadasInicial ?? 0 };
      } catch (e: any) { return { error: (e && e.message) || 'no se pudo cambiar el auto-balanceo' }; }
    }
    if (name === 'fijar_modo_asignacion') {
      if (!canWrite) return { error: 'No tienes permisos para configurar automatismos.' };
      try {
        const modo = args?.modo === 'strict' || args?.modo === 'estricto' ? 'strict' : 'advisory';
        await this.setAssignmentMode(operationId, modo);
        await this.recordAgentAction({ operationId, sellerId: null, agent: 'copilot', decision: `modo asignación ${modo}`, actor: actor?.id || 'copiloto', orderRef: null, result: 'ok', recommendationId: null });
        return { ok: true, modoAsignacion: modo };
      } catch (e: any) { return { error: (e && e.message) || 'no se pudo fijar el modo' }; }
    }
    if (name === 'reasignar_ociosidad') {
      if (!canWrite) return { error: 'No tienes permisos para reasignar.' };
      try {
        const r = await this.rebalanceLoad(operationId, { execute: true });
        const n = (r?.movimientos || []).length;
        await this.recordAgentAction({ operationId, sellerId: null, agent: 'copilot', decision: 'reasignación por ociosidad', actor: actor?.id || 'copiloto', orderRef: null, result: `ok: ${n} movimientos`, recommendationId: null });
        return { ok: true, movimientos: n, detalle: (r?.movimientos || []).slice(0, 8) };
      } catch (e: any) { return { error: (e && e.message) || 'no se pudo reasignar' }; }
    }
    // Crear una RECEPCIÓN (inbound). Queda pendiente para cotejo/recepción por un operario.
    if (name === 'crear_recepcion') {
      if (!canWrite) return { error: 'No tienes permisos para crear recepciones.' };
      const sid = await this.copilotResolveSeller(operationId, sellerId, args?.sellerId ?? args?.cliente);
      if (!sid) return { error: 'No pude identificar el cliente. Usa clientes_operacion para ver los clientes y pásame su id en sellerId.' };
      const lines = this.copilotParseLines(args?.lineas, true);
      if (!lines.length) return { error: 'Faltan las líneas (SKU y cantidad esperada). Ej: [{ "sku": "CAM", "qty": 100 }].' };
      try {
        const rec = await this.createReceipt(sid, { supplier: args?.proveedor ?? null, reference: args?.referencia ?? null, notes: args?.notas ?? null, lines }, actor?.id || 'copiloto');
        const ref = rec.reference || rec.id;
        await this.recordAgentAction({ operationId, sellerId: sid, agent: 'copilot', decision: `crear recepción ${ref}`, actor: actor?.id || 'copiloto', orderRef: ref, result: `ok: ${(rec.lines || []).length} líneas`, recommendationId: null });
        return { ok: true, recepcion: ref, id: rec.id, cliente: sid, estado: rec.status, lineas: (rec.lines || []).length, unidadesEsperadas: (rec.lines || []).reduce((s, l) => s + (l.expectedQty || 0), 0) };
      } catch (e: any) { return { error: (e && e.message) || 'no se pudo crear la recepción' }; }
    }
    // Crear una ORDEN de salida nueva y, si se pide, reservar su stock.
    if (name === 'crear_orden') {
      if (!canWrite) return { error: 'No tienes permisos para crear órdenes.' };
      const sid = await this.copilotResolveSeller(operationId, sellerId, args?.sellerId ?? args?.cliente);
      if (!sid) return { error: 'No pude identificar el cliente. Usa clientes_operacion para ver los clientes y pásame su id en sellerId.' };
      const lines = this.copilotParseLines(args?.lineas, false);
      if (!lines.length) return { error: 'Faltan las líneas (SKU y cantidad). Ej: [{ "sku": "CAM", "qty": 2 }].' };
      const dest = args?.destinatario || {};
      const nombre = String(dest?.nombre ?? dest?.name ?? args?.destinatarioNombre ?? '').trim();
      if (!nombre) return { error: 'Falta el nombre del destinatario (a quién se despacha el pedido).' };
      const shipTo = { name: nombre, phone: dest?.telefono ?? dest?.phone ?? null, email: dest?.email ?? null, address: dest?.direccion ?? dest?.address ?? null, comuna: dest?.comuna ?? null, region: dest?.region ?? null };
      // Ref generada robusta: Date.now() solo colisiona si se crean dos órdenes en el mismo
      // milisegundo, y la idempotencia por externalOrderId devolvería la orden equivocada.
      const ref = String(args?.referencia ?? args?.externalOrderId ?? '').trim() || `IA-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
      const reservar = args?.reservar === true || args?.reservar === 'true';
      let order: SalesOrder;
      try {
        order = await this.createOrder(sid, { externalOrderId: ref, salesChannel: String(args?.canal || 'copiloto'), carrier: args?.courier ?? null, shipTo, lines }, actor?.id || 'copiloto');
      } catch (e: any) { return { error: (e && e.message) || 'no se pudo crear la orden' }; }
      const ordenRef = order.externalOrderId || order.id;
      await this.recordAgentAction({ operationId, sellerId: sid, agent: 'copilot', decision: `crear orden ${ordenRef}`, actor: actor?.id || 'copiloto', orderRef: ordenRef, result: `ok: ${order.status}`, recommendationId: null });
      // Si el cliente tiene reserva inmediata, createOrder ya la dejó ALLOCATED.
      if (order.status === OrderStatus.ALLOCATED) return { ok: true, orden: ordenRef, id: order.id, cliente: sid, estado: order.status, reservada: true, nota: 'el cliente reserva al ingresar (automático)' };
      if (!reservar) return { ok: true, orden: ordenRef, id: order.id, cliente: sid, estado: order.status, lineas: (order.lines || []).length };
      // Reserva de stock: en modo directo se ejecuta; en confirmación queda PROPUESTA
      // (reusa el flujo de confirmación existente para 'reservar').
      if (mode === 'direct') {
        try {
          const o = await this.copilotRunOrderAction(sid, order.id, 'reservar', actor?.id || 'copiloto');
          await this.recordAgentAction({ operationId, sellerId: sid, agent: 'copilot', decision: 'reservar', actor: actor?.id || 'copiloto', orderRef: o.externalOrderId || o.id, result: `ok: ${o.status}`, recommendationId: null });
          return { ok: true, orden: ordenRef, id: order.id, cliente: sid, estado: o.status, reservada: o.status === OrderStatus.ALLOCATED };
        } catch (e: any) { return { ok: true, orden: ordenRef, id: order.id, cliente: sid, estado: order.status, reservada: false, avisoReserva: (e && e.message) || 'no se pudo reservar el stock' }; }
      }
      const plan = this.copilotPlanAction(order, 'reservar');
      if (!('error' in plan) && !pendingActions.some((p) => p.orderId === order.id && p.accion === 'reservar')) {
        pendingActions.push({ orden: ordenRef, orderId: order.id, sellerId: sid, accion: 'reservar', from: plan.from, to: plan.to });
        await this.recordRecommendation({ operationId, sellerId: sid, type: 'copilot_action', input: question, output: `reservar ${ordenRef}`, score: null, taken: null, outcome: null, actor: actor?.id || 'copiloto' });
      }
      return { ok: true, orden: ordenRef, id: order.id, cliente: sid, estado: order.status, requiresConfirmation: true, resumen: `Orden ${ordenRef} creada (${order.status}). La RESERVA de stock quedó PROPUESTA para que el usuario la confirme; NO la des por reservada.` };
    }
    return undefined; // no es una acción → el caller usa las herramientas de lectura
  }

  /** Descripción corta y legible de los argumentos de una acción (para propuestas y diario). */
  private describeActionArgs(name: string, args: any): string {
    const a = args || {};
    switch (name) {
      case 'asignar_tarea': return `${a.tipo || 'PICK'} ${a.entidad || '?'} → ${a.operario || '?'}`;
      case 'balancear_carga': return `repartir tareas ${a.tipo || 'PICK'}`;
      case 'reasignar_ociosidad': return 'mover tareas del más cargado al más libre';
      case 'activar_auto_balanceo': return a.activar === false || a.activar === 'false' ? 'desactivar auto-balanceo' : 'activar auto-balanceo';
      case 'fijar_modo_asignacion': return `modo ${a.modo || 'advisory'}`;
      case 'crear_recepcion': return `recepción ${a.referencia || ''} ${(a.lineas || []).length} línea(s)${a.sellerId ? ' cliente ' + a.sellerId : ''}`.trim();
      case 'crear_orden': return `orden ${a.referencia || ''} ${(a.lineas || []).length} línea(s) para ${a.destinatario?.nombre || '?'}`.trim();
      case 'avanzar_estado_orden': return `${a.accion || '?'} orden ${a.orden || '?'}`;
      case 'guardar_instruccion': return String(a.texto || a.instruccion || '').slice(0, 80);
      default: return JSON.stringify(a).slice(0, 120);
    }
  }
  /** Confirma y ejecuta una propuesta genérica {tool, args} (botón confirmar del panel/voz). */
  async copilotConfirmTool(operationId: string, sellerScope: string | null, actor: { id?: string; role?: string } | null, input: { tool: string; args: any }): Promise<any> {
    if (!this.copilotCanWrite(actor?.role)) return { ok: false, error: 'No tienes permisos para ejecutar acciones.' };
    const settings = await this.agentSettings(operationId);
    const r = await this.copilotExecAction(input.tool, input.args || {}, { operationId, sellerId: sellerScope, mode: 'direct', canWrite: true, question: `confirmación: ${input.tool}`, actor, pendingActions: [], settings, confirmed: true });
    if (r === undefined) return { ok: false, error: 'Acción no reconocida.' };
    if (r && r.error) return { ok: false, error: r.error };
    // Marca la recomendación como tomada (aceptación medible).
    try {
      const out = `${ACTION_POLICIES.find((p) => p.tool === input.tool)?.label || input.tool}: ${this.describeActionArgs(input.tool, input.args)}`;
      const recs = this.aiAudit ? await this.aiAudit.listRecommendations(operationId, { type: 'copilot_action', limit: 200 }) : [];
      const rec = recs.find((x) => x.taken == null && x.output === out);
      if (rec && this.aiAudit) await this.aiAudit.updateRecommendation(rec.id, { taken: true });
    } catch { /* best-effort */ }
    return { ok: true, ...r };
  }
  /** Resuelve el seller objetivo de una acción por id o nombre, dentro del alcance del usuario. */
  private async copilotResolveSeller(operationId: string, sellerScope: string | null, arg?: string | null): Promise<string | null> {
    if (sellerScope) return sellerScope; // usuario acotado a su propio cliente
    const key = String(arg ?? '').trim();
    const sellers = await this.sellers.list(operationId);
    if (!key) return sellers.length === 1 ? sellers[0].id : null;
    const n = key.toLowerCase();
    const hit = sellers.find((s) => s.id === key || s.id.toLowerCase() === n || (s.name || '').toLowerCase() === n);
    return hit ? hit.id : null;
  }

  /** Normaliza las líneas que propone el LLM (array u objeto/JSON string) para crear órdenes/recepciones. */
  private copilotParseLines(raw: any, isReceipt: boolean): Array<{ sku: string; qty: number; lot?: string | null; expiry?: string | null }> {
    let arr: any = raw;
    if (typeof raw === 'string') { try { arr = JSON.parse(raw); } catch { arr = []; } }
    if (arr && !Array.isArray(arr)) arr = [arr];
    if (!Array.isArray(arr)) return [];
    const out: Array<{ sku: string; qty: number; lot?: string | null; expiry?: string | null }> = [];
    for (const it of arr) {
      const sku = String(it?.sku ?? it?.SKU ?? it?.codigo ?? '').trim();
      const qty = Number(it?.qty ?? it?.cantidad ?? it?.cant ?? 0);
      if (!sku || !(qty > 0)) continue;
      const line: { sku: string; qty: number; lot?: string | null; expiry?: string | null } = { sku, qty };
      const lot = it?.lot ?? it?.lote;
      if (lot != null && String(lot).trim()) line.lot = String(lot).trim();
      if (isReceipt) { const exp = it?.expiry ?? it?.vencimiento; if (exp != null && String(exp).trim()) line.expiry = String(exp).trim(); }
      out.push(line);
    }
    return out;
  }
  /** Prueba la conexión de IA con un ping mínimo. Devuelve el motivo si falla. */
  async testAiConfig(operationId: string, sellerId: string | null): Promise<{ ok: boolean; error?: string }> {
    const cred = await this.resolveAiCredential(operationId, sellerId);
    if (!cred) return { ok: false, error: 'No hay una IA conectada.' };
    const res = await askCopilotLlmDetailed(cred, 'Responde solo con: OK', 'ping');
    return res.text ? { ok: true } : { ok: false, error: res.error || 'sin respuesta' };
  }
  /**
   * Ejecuta una herramienta del copiloto (tool-calling), SIEMPRE de solo lectura y
   * acotada al tenant: si el usuario es de un seller, se ignora cualquier sellerId
   * que proponga el LLM y se fuerza el suyo. Nunca lanza (devuelve {error} si falla).
   */
  async runCopilotTool(name: string, args: any, operationId: string, sellerScope: string | null): Promise<any> {
    try {
      const a = args || {};
      // Resuelve el/los seller objetivo respetando el aislamiento por tenant.
      const scopeSellers = await this.copilotScope(operationId, sellerScope);
      const pickSeller = (s?: string) => sellerScope ? sellerScope : (s && scopeSellers.includes(s) ? s : null);
      const now = Date.parse(this.clockNow());
      const DAY = 86400000;

      switch (name) {
        case 'clientes_operacion': {
          const sellers = await this.sellers.list(operationId);
          return { clientes: sellers.map((s) => ({ id: s.id, nombre: s.name })) };
        }
        case 'stock_de_sku': {
          const targets = pickSeller(a.sellerId) ? [pickSeller(a.sellerId)!] : scopeSellers;
          const found: any[] = [];
          for (const sid of targets) {
            const bal = (await this.inventory.getStock({ sellerId: sid, sku: a.sku })).filter((b) => b.qty !== 0);
            if (!bal.length) continue;
            const locs = await this.locations.listByOperation(operationId);
            const code = (id: string) => (locs.find((l) => l.id === id)?.code) || id;
            found.push({ sellerId: sid, total: bal.reduce((x, b) => x + b.qty, 0), ubicaciones: bal.map((b) => ({ ubicacion: code(b.locationId), lote: b.lot, estado: b.state, qty: b.qty })) });
          }
          return found.length ? { sku: a.sku, resultados: found } : { sku: a.sku, mensaje: 'sin saldo registrado' };
        }
        case 'inventario_resumen': {
          const targets = pickSeller(a.sellerId) ? [pickSeller(a.sellerId)!] : scopeSellers;
          const out: any[] = [];
          for (const sid of targets) {
            const bal = await this.inventory.getStock({ sellerId: sid, includeZeros: true });
            const onHand: Record<string, number> = {}; const byState: Record<string, number> = {};
            for (const b of bal) { onHand[b.sku] = (onHand[b.sku] || 0) + b.qty; byState[b.state] = (byState[b.state] || 0) + b.qty; }
            const top = Object.keys(onHand).map((k) => ({ sku: k, onHand: onHand[k] })).sort((x, y) => y.onHand - x.onHand).slice(0, 15);
            out.push({ sellerId: sid, total: Object.values(onHand).reduce((x, y) => x + y, 0), porEstado: byState, topSkus: top });
          }
          return { inventario: out };
        }
        case 'operarios': {
          return await this.operatorsDirectory(operationId);
        }
        case 'alertas_activas': {
          const r = await this.agentAlerts(operationId, { sweep: true });
          return { total: r.abiertas.length, alertas: r.abiertas.map((a) => ({ id: a.id, severidad: a.severity, titulo: a.title, detalle: a.detail, sugerencia: a.action, regla: a.ruleKey, creada: a.createdAt })) };
        }
        case 'tareas_de_orden': {
          const targets = pickSeller(a.sellerId) ? [pickSeller(a.sellerId)!] : scopeSellers;
          for (const sid of targets) {
            const tasks = await this.orderTasks(sid, a.orden);
            if (tasks.length) {
              return { orden: a.orden, sellerId: sid, tareas: tasks.map((t) => ({ id: t.id, tipo: t.type, estado: t.state, operario: t.operator, unidades: t.unitsEstimate, creada: t.createdAt, iniciada: t.startedAt, completada: t.completedAt })) };
            }
          }
          return { mensaje: 'sin tareas registradas para esa orden', orden: a.orden };
        }
        case 'linear_tiempo_orden':
        case 'linea_tiempo_orden': {
          const targets = pickSeller(a.sellerId) ? [pickSeller(a.sellerId)!] : scopeSellers;
          for (const sid of targets) {
            const orders = await this.orders.listOrders(sid);
            const o = orders.find((x) => x.id === a.orden || x.externalOrderId === a.orden);
            if (!o) continue;
            // G2+G6: la línea de tiempo se lee del event store (indexado por entidad),
            // no del JSON de la orden. Fallback al JSON si el store no está disponible.
            const evs = await this.timelineOf(o.id, o.events);
            const linea = evs.map((e, i) => {
              const prev = i > 0 ? Date.parse(e.at) - Date.parse(evs[i - 1].at) : 0;
              return { estado: e.type, fecha: e.at, hrsDesdeAnterior: i > 0 ? Math.round(prev / 3600000 * 10) / 10 : 0, detalle: e.detail || null, actor: e.actor };
            });
            const totalHrs = evs.length > 1 ? Math.round((Date.parse(evs[evs.length - 1].at) - Date.parse(evs[0].at)) / 3600000 * 10) / 10 : 0;
            return { orden: o.externalOrderId || o.id, sellerId: sid, estadoActual: o.status, courier: o.carrier, lineaTiempo: linea, horasTotales: totalHrs };
          }
          return { mensaje: 'orden no encontrada', orden: a.orden };
        }
        case 'listar_ordenes': {
          const targets = pickSeller(a.sellerId) ? [pickSeller(a.sellerId)!] : scopeSellers;
          const lim = Math.min(Number(a.limite) || 30, 100);
          const rows: any[] = [];
          for (const sid of targets) {
            for (const o of await this.orders.listOrders(sid)) {
              if (a.estado && o.status !== String(a.estado).toUpperCase()) continue;
              rows.push({ id: o.externalOrderId || o.id, sellerId: sid, estado: o.status, courier: o.carrier, creada: o.createdAt, lineas: (o.lines || []).length });
            }
          }
          rows.sort((x, y) => (x.creada < y.creada ? 1 : -1));
          return { total: rows.length, ordenes: rows.slice(0, lim) };
        }
        case 'kardex_sku': {
          const targets = pickSeller(a.sellerId) ? [pickSeller(a.sellerId)!] : scopeSellers;
          const lim = Math.min(Number(a.limite) || 40, 120);
          const locs = await this.locations.listByOperation(operationId);
          const code = (id: string) => (locs.find((l) => l.id === id)?.code) || id;
          const movs: any[] = [];
          for (const sid of targets) {
            for (const m of await this.listMovements(sid, 100000)) {
              if (m.sku !== a.sku) continue;
              movs.push({ fecha: m.occurredAt, tipo: m.type, delta: m.qtyDelta, ubicacion: code(m.locationId), lote: m.lot, estado: m.state, actor: m.actor });
            }
          }
          movs.sort((x, y) => (x.fecha < y.fecha ? 1 : -1));
          return { sku: a.sku, total: movs.length, movimientos: movs.slice(0, lim) };
        }
        case 'facturacion_cliente': {
          const sid = pickSeller(a.sellerId) || a.sellerId;
          if (!sid || !scopeSellers.includes(sid)) return { error: 'cliente fuera de alcance' };
          const rate = await this.getBillingRate(sid).catch(() => null);
          const invs = (await this.listInvoices(sid).catch(() => []) as any[]).slice(0, Math.min(Number(a.limite) || 12, 24));
          let mes = 0, currency = 'CLP';
          try { const inv = await this.previewInvoice(sid, new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1); mes = (inv.lines || []).reduce((x: number, l: any) => x + (l.amount || 0), 0); currency = inv.currency || currency; } catch { /* sin tarifario */ }
          return { sellerId: sid, tarifario: rate, estimadoMesActual: mes, moneda: currency, facturas: invs.map((i: any) => ({ numero: i.number || i.id, periodo: i.periodFrom, estado: i.status, total: (i.lines || []).reduce((x: number, l: any) => x + (l.amount || 0), 0) })) };
        }
        case 'insumos_embalaje': {
          const materials = await this.listPackaging(operationId);
          const movs = await this.listPackagingMovements(operationId);
          const onHand: Record<string, number> = {};
          for (const m of movs) onHand[m.materialSku] = (onHand[m.materialSku] || 0) + m.qtyDelta;
          const low = await this.packagingLow(operationId);
          return { insumos: (materials as any[]).map((m) => ({ sku: m.sku, nombre: m.name, saldo: onHand[m.sku] || 0 })), porReabastecer: low };
        }
        case 'lotes_por_vencer': {
          const targets = pickSeller(a.sellerId) ? [pickSeller(a.sellerId)!] : scopeSellers;
          const out: any[] = [];
          for (const sid of targets) for (const l of await this.expiringLots(sid, now)) out.push({ sellerId: sid, ...l });
          out.sort((x, y) => x.days - y.days);
          return { lotes: out };
        }
        case 'uso_plataforma': {
          const dias = [1, 7, 30, 90].includes(Number(a.dias)) ? Number(a.dias) : 7;
          return await this.platformUsage(dias);
        }
        case 'canal_voz': {
          const [stats, insights, msgs] = await Promise.all([
            this.opsChannelStats(operationId), this.opsChannelInsights(operationId), this.listOpsMessages(operationId),
          ]);
          const lim = Math.min(Number(a.limiteMensajes) || 15, 40);
          const recientes = (msgs || []).slice(-lim).map((m) => ({ de: m.senderName, rol: m.senderRole, tipo: m.kind, texto: m.text || m.note, categoria: m.category, at: m.at }));
          return { estadisticas: stats, insights, mensajesRecientes: recientes };
        }
        case 'armados_kit': {
          const targets = pickSeller(a.sellerId) ? [pickSeller(a.sellerId)!] : scopeSellers;
          const out: any[] = [];
          for (const sid of targets) { const list = await this.listAssemblies(sid).catch(() => []); for (const r of (list as any[]).slice(-30)) out.push({ sellerId: sid, ...r }); }
          return { armados: out };
        }
        case 'metricas_dashboard': {
          const sid = pickSeller(a.sellerId) || scopeSellers[0];
          if (!sid) return { error: 'sin cliente' };
          return { sellerId: sid, metricas: await this.dashboardMetrics(sid) };
        }
        case 'recepciones': {
          const targets = pickSeller(a.sellerId) ? [pickSeller(a.sellerId)!] : scopeSellers;
          const lim = Math.min(Number(a.limite) || 30, 80);
          const out: any[] = [];
          for (const sid of targets) for (const r of await this.listReceipts(sid)) out.push({ sellerId: sid, id: r.id, estado: r.status, creada: r.createdAt, lineas: (r.lines || []).length });
          out.sort((x, y) => (x.creada < y.creada ? 1 : -1));
          return { recepciones: out.slice(0, lim) };
        }
        case 'tiempos_preparacion': {
          const targets = pickSeller(a.sellerId) ? [pickSeller(a.sellerId)!] : scopeSellers;
          const lim = Math.min(Number(a.limite) || 100, 300);
          const prep = await this.prepTimes(targets, lim);
          return { ordenesAnalizadas: prep.ordersAnalyzed, transiciones: prep.transitions };
        }
        case 'riesgo_quiebre': {
          const sid = pickSeller(a.sellerId);
          return this.getStockoutRisk(operationId, {
            sellerId: sid, coverDays: Number(a.diasCobertura) || undefined,
            windowDays: Number(a.ventanaDias) || undefined, limit: Number(a.limite) || undefined,
          });
        }
        case 'ordenes_en_riesgo': {
          const sid = pickSeller(a.sellerId);
          return this.getOrdersAtRisk(operationId, {
            sellerId: sid, maxHours: Number(a.maxHoras) || undefined, limit: Number(a.limite) || undefined,
          });
        }
        case 'brief_ejecutivo': {
          const sid = pickSeller(a.sellerId);
          return this.getExecutiveBrief(operationId, { sellerId: sid });
        }
        case 'carga_operarios': {
          return this.operatorLoad(operationId);
        }
        case 'rentabilidad': {
          if (!this.costing) return { error: 'módulo de costos no disponible' };
          const now = new Date();
          const y = Number(a.year) || now.getUTCFullYear();
          const m = Number(a.month) || (now.getUTCMonth() + 1);
          return this.profitability(operationId, y, m);
        }
        case 'eficiencia_costos': {
          if (!this.costing) return { error: 'módulo de costos no disponible' };
          const nowD = new Date();
          const y = Number(a.year) || nowD.getUTCFullYear();
          const m = Number(a.month) || (nowD.getUTCMonth() + 1);
          return this.laborEfficiency(operationId, y, m, a.agrupar === 'tipo' ? 'type' : 'operator');
        }
        case 'contexto_operativo': {
          // Snapshot integral de la operación para que el LLM se alimente de todo el sistema.
          const nowD = new Date(); const Y = nowD.getUTCFullYear(); const Mo = nowD.getUTCMonth() + 1;
          const [ejecutivo, exactitud, carga, prod, ai] = await Promise.all([
            this.getExecutiveBrief(operationId, { sellerId: sellerScope }).catch(() => null),
            this.getInventoryAccuracy(operationId, { sellerId: sellerScope }).catch(() => null),
            this.operatorLoad(operationId).catch(() => null),
            this.laborProductivity(operationId).catch(() => null),
            this.aiAuditSummary(operationId).catch(() => null),
          ]);
          let rentabilidad: any = null;
          try { rentabilidad = (await this.profitability(operationId, Y, Mo)); } catch { rentabilidad = null; }
          const abc: Record<string, number> = {};
          for (const sid of scopeSellers) for (const s of await this.skus.list(sid)) { const c = (s.rotationClass as string) || '—'; abc[c] = (abc[c] || 0) + 1; }
          return {
            operacion: operationId,
            alcance: sellerScope ? { seller: sellerScope } : { clientes: scopeSellers.length },
            ejecutivo,
            rentabilidad: rentabilidad ? { totales: rentabilidad.totals, peoresMargenes: (rentabilidad.sellers || []).slice(0, 3).map((s: any) => ({ cliente: s.sellerName, margenRealPct: s.marginPctReal })) } : null,
            exactitudInventario: exactitud,
            productividad: prod ? (prod.operators || []).slice(0, 8) : null,
            carga: carga ? { operarios: carga.operarios, pendientesSinAsignar: carga.pendientesSinAsignar } : null,
            clasificacionABC: abc,
            auditoriaIA: ai,
          };
        }
        case 'devoluciones': {
          const targets = pickSeller(a.sellerId) ? [pickSeller(a.sellerId)!] : scopeSellers;
          const out: any[] = [];
          for (const sid of targets) {
            const rets = await this.listReturns(sid).catch(() => []);
            if (!rets.length) continue;
            const porEstado: Record<string, number> = {};
            for (const r of rets) porEstado[r.status] = (porEstado[r.status] || 0) + 1;
            out.push({ sellerId: sid, total: rets.length, porEstado, recientes: rets.slice(0, 10).map((r: any) => ({ id: r.id, estado: r.status, ordenOrigen: r.originalOrderId ?? null, creada: r.createdAt })) });
          }
          return { devoluciones: out };
        }
        case 'conteo_exactitud': {
          const sid = pickSeller(a.sellerId);
          const acc = await this.getInventoryAccuracy(operationId, { sellerId: sid });
          let pendientes = 0;
          for (const s of (sid ? [sid] : scopeSellers)) pendientes += (await this.planCounts(s).catch(() => [])).length;
          return { exactitud: acc, tareasConteoPropuestas: pendientes };
        }
        case 'catalogo_productos': {
          const targets = pickSeller(a.sellerId) ? [pickSeller(a.sellerId)!] : scopeSellers;
          const out: any[] = [];
          for (const sid of targets) {
            const skus = await this.skus.list(sid);
            const porClase: Record<string, number> = {};
            for (const s of skus) { const c = (s.rotationClass as string) || '—'; porClase[c] = (porClase[c] || 0) + 1; }
            const filtro = a.buscar ? String(a.buscar).toLowerCase() : null;
            const muestra = skus.filter((s: any) => !filtro || (s.sku + ' ' + (s.description || '')).toLowerCase().includes(filtro)).slice(0, 30)
              .map((s: any) => ({ sku: s.sku, descripcion: s.description, activo: s.active !== false, clase: s.rotationClass || null, kit: s.isKit ? (s.kitMode || 'KIT') : null, lote: !!s.lotControlled, vence: !!s.expiryControlled, serie: !!s.serialControlled }));
            out.push({ sellerId: sid, totalSkus: skus.length, activos: skus.filter((s: any) => s.active !== false).length, porClase, muestra });
          }
          return { catalogo: out };
        }
        case 'productividad_operarios': {
          return this.laborProductivity(operationId, { from: a.desde || undefined, to: a.hasta || undefined, operator: a.operario || null });
        }
        case 'clasificacion_abc': {
          const targets = pickSeller(a.sellerId) ? [pickSeller(a.sellerId)!] : scopeSellers;
          const dist: Record<string, number> = {};
          const porCliente: any[] = [];
          for (const sid of targets) {
            const skus = await this.skus.list(sid);
            const c: Record<string, number> = {};
            for (const s of skus) { const k = (s.rotationClass as string) || '—'; dist[k] = (dist[k] || 0) + 1; c[k] = (c[k] || 0) + 1; }
            porCliente.push({ sellerId: sid, porClase: c });
          }
          return { distribucion: dist, porCliente };
        }
        case 'demanda_sku': {
          const sid = pickSeller(a.sellerId) || scopeSellers[0];
          if (!sid) return { mensaje: 'sin cliente en alcance' };
          return this.getDemandSeries(sid, { sku: a.sku || null, fromDate: a.desde || undefined, toDate: a.hasta || undefined });
        }
        case 'auditoria_ia': {
          return this.aiAuditSummary(operationId, { from: a.desde || undefined, to: a.hasta || undefined });
        }
        case 'ocupacion_ubicaciones': {
          const locs = await this.locations.listByOperation(operationId);
          const occ: Record<string, number> = {};
          for (const sid of scopeSellers) for (const b of await this.inventory.getStock({ sellerId: sid })) occ[b.locationId] = (occ[b.locationId] || 0) + b.qty;
          const byZone: Record<string, { ubicaciones: number; ocupado: number; capacidad: number }> = {};
          for (const l of locs) { const z = l.zoneType; const e = byZone[z] || { ubicaciones: 0, ocupado: 0, capacidad: 0 }; e.ubicaciones += 1; e.ocupado += occ[l.id] || 0; e.capacidad += l.capacity || 0; byZone[z] = e; }
          const top = locs.map((l) => ({ codigo: l.code, zona: l.zoneType, ocupado: occ[l.id] || 0, capacidad: l.capacity || null }))
            .sort((x, y) => y.ocupado - x.ocupado).slice(0, 20);
          return { totalUbicaciones: locs.length, porZona: byZone, masOcupadas: top };
        }
        case 'mensajes_clientes': {
          return this.chatSummary(operationId);
        }
        case 'tareas_pendientes': {
          // Pool de tareas asignables por tipo (PICK/PUTAWAY/RECEIVE/RESLOT/COUNT) con su
          // id, referencia legible, cliente, unidades y a quién está asignada (si lo está).
          const tipo = (String(a.tipo || 'PUTAWAY').toUpperCase()) as WorkTaskType;
          const soloSin = a.soloSinAsignar === true || a.soloSinAsignar === 'true';
          const lim = Math.min(Number(a.limite) || 40, 100);
          const pool = await this.getTaskPool(operationId, tipo, { onlyUnassigned: soloSin, limit: lim }).catch(() => [] as Awaited<ReturnType<WmsFacade['getTaskPool']>>);
          const scoped = sellerScope ? pool.filter((t) => t.sellerId === sellerScope) : pool;
          return {
            tipo,
            total: scoped.length,
            tareas: scoped.map((t) => ({ id: t.entityId, ref: t.entityRef, cliente: t.sellerId, unidades: t.unidades, asignadoA: t.asignadoA, nota: t.note ?? null })),
          };
        }
        default:
          return { error: `herramienta desconocida: ${name}` };
      }
    } catch (e: any) {
      return { error: (e && e.message) || 'fallo al ejecutar la herramienta' };
    }
  }

  // ---- Acciones del copiloto (escritura, con permisos y modo por operación) ----
  /** ¿Un rol puede ejecutar acciones de fulfillment (avanzar órdenes)? */
  private copilotCanWrite(role?: string | null): boolean {
    // Sin usuario solo se permite escribir en modo demo (AUTH_REQUIRED distinto de 'true').
    // En producción una petición sin identidad NUNCA obtiene permisos de escritura.
    if (!role) return process.env.AUTH_REQUIRED !== 'true';
    return ROLE_PERMISSIONS[role as UserRole]?.includes('order:fulfill') ?? false;
  }
  /** Ajustes efectivos del agente (política de autonomía, sombra, límites, notificaciones). */
  async agentSettings(operationId: string): Promise<Required<CopilotSettings>> {
    const s = this.copilotSettings ? await this.copilotSettings.get(operationId).catch(() => null) : null;
    return effectiveAgentSettings(s, operationId);
  }
  async updateAgentSettings(operationId: string, patch: Partial<Omit<CopilotSettings, 'operationId'>>, actor?: string): Promise<Required<CopilotSettings>> {
    if (!this.copilotSettings) throw new ValidationError('Ajustes no disponibles');
    const cur = await this.agentSettings(operationId);
    const lvl = patch.autonomyLevel != null ? Math.max(0, Math.min(3, Math.round(patch.autonomyLevel))) as 0 | 1 | 2 | 3 : cur.autonomyLevel;
    const next: CopilotSettings = {
      ...cur,
      actionMode: patch.actionMode === 'direct' ? 'direct' : patch.actionMode === 'confirm' ? 'confirm' : cur.actionMode,
      autonomyLevel: lvl,
      shadowMode: patch.shadowMode != null ? !!patch.shadowMode : cur.shadowMode,
      paused: patch.paused != null ? !!patch.paused : cur.paused,
      maxActionsPerCycle: patch.maxActionsPerCycle != null && patch.maxActionsPerCycle >= 0 ? Math.round(patch.maxActionsPerCycle) : cur.maxActionsPerCycle,
      maxActionsPerHour: patch.maxActionsPerHour != null && patch.maxActionsPerHour >= 0 ? Math.round(patch.maxActionsPerHour) : cur.maxActionsPerHour,
      notifyEmail: patch.notifyEmail !== undefined ? (patch.notifyEmail ? String(patch.notifyEmail).trim() : null) : cur.notifyEmail,
      notifyWebhookUrl: patch.notifyWebhookUrl !== undefined ? (patch.notifyWebhookUrl ? String(patch.notifyWebhookUrl).trim() : null) : cur.notifyWebhookUrl,
      llmPlanning: patch.llmPlanning != null ? !!patch.llmPlanning : cur.llmPlanning,
      llmEveryMin: patch.llmEveryMin != null && patch.llmEveryMin >= 1 ? Math.round(patch.llmEveryMin) : cur.llmEveryMin,
      maxLlmCallsPerDay: patch.maxLlmCallsPerDay != null && patch.maxLlmCallsPerDay >= 0 ? Math.round(patch.maxLlmCallsPerDay) : cur.maxLlmCallsPerDay,
    };
    await this.copilotSettings.save(next);
    await this.journal(operationId, 'note', actor || 'admin', `Ajustes del agente actualizados: nivel ${next.autonomyLevel}, sombra ${next.shadowMode ? 'ON' : 'OFF'}, pausa ${next.paused ? 'ON' : 'OFF'}, modo ${next.actionMode}.`, null);
    return effectiveAgentSettings(next, operationId);
  }
  /** Escribe una entrada en el diario del agente (best-effort). */
  private async journal(operationId: string, kind: AgentJournalEntry['kind'], actor: string, text: string, data: Record<string, unknown> | null, expiresAt: string | null = null): Promise<string | null> {
    if (!this.agentJournal) return null;
    const id = this.ids.next();
    try { await this.agentJournal.append({ id, operationId, at: this.clockNow(), kind, actor, text: String(text).slice(0, 600), data, expiresAt, active: true }); } catch { return null; }
    return id;
  }
  /** Acciones ejecutadas por el agente autónomo en la última hora (para los límites). */
  private async agentActionsLastHour(operationId: string): Promise<number> {
    if (!this.aiAudit) return 0;
    const from = new Date(Date.parse(this.clockNow()) - 3600000).toISOString();
    try {
      const acts = await this.aiAudit.listActions(operationId, { from, limit: 1000 });
      return acts.filter((a) => a.actor === 'agente' && String(a.result || '').startsWith('ok')).length;
    } catch { return 0; }
  }
  /** Modo de acciones del copiloto para una operación: 'confirm' (def) o 'direct'. */
  async getCopilotActionMode(operationId: string): Promise<'confirm' | 'direct'> {
    if (!this.copilotSettings) return 'confirm';
    const s = await this.copilotSettings.get(operationId);
    return s?.actionMode === 'direct' ? 'direct' : 'confirm';
  }
  async setCopilotActionMode(operationId: string, mode: 'confirm' | 'direct'): Promise<{ actionMode: 'confirm' | 'direct' }> {
    if (!this.copilotSettings) throw new ValidationError('Ajustes no disponibles');
    const actionMode = mode === 'direct' ? 'direct' : 'confirm';
    await this.copilotSettings.save({ operationId, actionMode });
    return { actionMode };
  }
  /** Busca una orden por id o referencia externa dentro del alcance del usuario. */
  private async copilotResolveOrder(operationId: string, sellerScope: string | null, orden: string): Promise<{ sellerId: string; order: SalesOrder } | null> {
    const scope = await this.copilotScope(operationId, sellerScope);
    for (const sid of scope) {
      const list = await this.orders.listOrders(sid);
      const o = list.find((x) => x.id === orden || x.externalOrderId === orden);
      if (o) return { sellerId: sid, order: o };
    }
    return null;
  }
  /** Valida una transición pedida y devuelve estados origen/destino, o un error legible. */
  private copilotPlanAction(order: SalesOrder, accion: string): { from: string; to: string } | { error: string } {
    const st = order.status;
    switch (accion) {
      case 'reservar': return st === 'RECEIVED' ? { from: st, to: 'ALLOCATED' } : { error: `solo se puede reservar una orden RECEIVED (está ${st})` };
      case 'iniciar_picking': return st === 'ALLOCATED' ? { from: st, to: 'PICKING' } : (st === 'PICKING' ? { from: st, to: 'PICKING' } : { error: `solo se puede iniciar el picking de una orden ALLOCATED (está ${st})` });
      case 'pickear': return (st === 'ALLOCATED' || st === 'PICKING') ? { from: st, to: 'PICKED' } : { error: `solo se puede pickear una orden ALLOCATED/PICKING (está ${st})` };
      case 'empacar': return st === 'PICKED' ? { from: st, to: 'PACKED' } : { error: `solo se puede empacar una orden PICKED (está ${st})` };
      case 'despachar': return st === 'PACKED' ? { from: st, to: 'SHIPPED' } : { error: `solo se puede despachar una orden PACKED (está ${st})` };
      default: return { error: `acción no reconocida: ${accion}` };
    }
  }
  /** Ejecuta la transición contra el dominio (con sus validaciones). */
  private async copilotRunOrderAction(sellerId: string, orderId: string, accion: string, actor: string): Promise<SalesOrder> {
    switch (accion) {
      case 'reservar': return this.allocateOrder(sellerId, orderId, actor);
      case 'iniciar_picking': return this.startPicking(sellerId, orderId, actor);
      case 'pickear': return this.confirmPick(sellerId, orderId, actor);
      case 'empacar': return this.packOrder(sellerId, orderId, { bultos: 1, materials: [] }, actor);
      case 'despachar': return this.shipOrder(sellerId, orderId, {}, actor);
      default: throw new ValidationError(`acción no reconocida: ${accion}`);
    }
  }
  /** Confirma y ejecuta una acción propuesta por el copiloto (modo 'confirm'). */
  async copilotConfirmAction(operationId: string, sellerScope: string | null, actor: { id?: string; role?: string } | null, input: { orden: string; accion: string }): Promise<{ ok: boolean; error?: string; orden?: string; nuevoEstado?: string }> {
    if (!this.copilotCanWrite(actor?.role)) return { ok: false, error: 'No tienes permisos para modificar órdenes.' };
    const resolved = await this.copilotResolveOrder(operationId, sellerScope, input.orden);
    if (!resolved) return { ok: false, error: 'Orden no encontrada.' };
    const plan = this.copilotPlanAction(resolved.order, input.accion);
    if ('error' in plan) return { ok: false, error: plan.error };
    const ordenRef = resolved.order.externalOrderId || resolved.order.id;
    // G5: marca como ACEPTADA la propuesta del copiloto correspondiente (si existe).
    const recId = await this.markCopilotProposalTaken(operationId, ordenRef, input.accion);
    try {
      const o = await this.copilotRunOrderAction(resolved.sellerId, resolved.order.id, input.accion, actor?.id || 'copiloto');
      await this.recordAgentAction({ operationId, sellerId: resolved.sellerId, agent: 'copilot', decision: input.accion, actor: actor?.id || 'copiloto', orderRef: o.externalOrderId || o.id, result: `ok: ${o.status}`, recommendationId: recId });
      if (recId) { try { await this.aiAudit?.updateRecommendation(recId, { outcome: `ejecutada → ${o.status}` }); } catch { /* best-effort */ } }
      return { ok: true, orden: o.externalOrderId || o.id, nuevoEstado: o.status };
    } catch (e: any) {
      const msg = (e && e.message) || 'no se pudo ejecutar la acción';
      await this.recordAgentAction({ operationId, sellerId: resolved.sellerId, agent: 'copilot', decision: input.accion, actor: actor?.id || 'copiloto', orderRef: ordenRef, result: `error: ${msg}`, recommendationId: recId });
      return { ok: false, error: msg };
    }
  }

  /** Busca la propuesta 'copilot_action' pendiente que coincide con (orden, acción) y la marca aceptada. */
  private async markCopilotProposalTaken(operationId: string, ordenRef: string, accion: string): Promise<string | null> {
    if (!this.aiAudit) return null;
    try {
      const recs = await this.aiAudit.listRecommendations(operationId, { type: 'copilot_action', limit: 200 });
      const hit = recs.find((r) => r.taken == null && r.output.includes(accion) && r.output.includes(ordenRef));
      if (hit) { await this.aiAudit.updateRecommendation(hit.id, { taken: true }); return hit.id; }
    } catch { /* best-effort */ }
    return null;
  }

  /** Vista previa del contexto que recibe el LLM (transparencia/depuración). */
  async copilotContextPreview(operationId: string, sellerId: string | null): Promise<{ context: string; chars: number }> {
    const ctx = await this.copilotContext(operationId, sellerId);
    return { context: ctx, chars: ctx.length };
  }
  /** Lista los modelos disponibles para la cuenta conectada (para elegir uno válido). */
  async listAiModels(operationId: string, sellerId: string | null): Promise<{ models: string[]; error?: string }> {
    const cred = await this.resolveAiCredential(operationId, sellerId);
    if (!cred) return { models: [], error: 'No hay una IA conectada.' };
    const r = await listLlmModels(cred);
    return { models: r.models, error: r.error || undefined };
  }
  /**
   * Contexto COMPLETO de la operación para el LLM (grounding). Reúne stock, inventario
   * por SKU, ubicaciones, órdenes por estado, demanda, lotes, embalaje y facturación.
   * Se acota con topes generosos para no exceder el presupuesto de tokens del proveedor.
   */
  private async copilotDetailContext(operationId: string, sellerId: string | null, caps: { skus: number; locs: number }, missing: string[]): Promise<string> {
    const now = Date.parse(this.clockNow());
    const DAY = 86400000;
    const startToday = new Date(now); startToday.setHours(0, 0, 0, 0);
    const scope = await this.copilotScope(operationId, sellerId);
    const L: string[] = [];

    // Ubicaciones + ocupación (cross-seller).
    try {
      const locs = await this.locations.listByOperation(operationId);
      L.push(`\n== UBICACIONES (${locs.length}) ==`);
      // Ocupación por ubicación sumando todos los sellers.
      const occ: Record<string, number> = {};
      for (const sid of scope) for (const b of await this.inventory.getStock({ sellerId: sid })) occ[b.locationId] = (occ[b.locationId] || 0) + b.qty;
      const byZone: Record<string, number> = {};
      for (const l of locs) byZone[l.zoneType] = (byZone[l.zoneType] || 0) + 1;
      L.push('Zonas: ' + Object.keys(byZone).map((z) => `${z}=${byZone[z]}`).join(', '));
      const occLines = locs.slice(0, caps.locs).map((l) => `${l.code}[${l.zoneType}] ocup ${occ[l.id] || 0}${l.capacity ? '/' + l.capacity : ''}`);
      L.push(occLines.join(' · ') + (locs.length > caps.locs ? ` … (+${locs.length - caps.locs} ubicaciones)` : ''));
    } catch { missing.push('ubicaciones'); }

    let opStockTotal = 0;
    const abcDist: Record<string, number> = {};
    for (const sid of scope) {
      const seller = await this.sellers.findById(sid);
      const sname = seller?.name || sid;
      const [orders, skus, balances, demand30, lots, receipts, returns] = await Promise.all([
        this.orders.listOrders(sid), this.skus.list(sid), this.inventory.getStock({ sellerId: sid, includeZeros: true }),
        this.skuDemand(sid, now - 30 * DAY), this.expiringLots(sid, now), this.listReceipts(sid), this.listReturns(sid),
      ]);
      // Stock por SKU y por estado.
      const onHand: Record<string, number> = {}; const byState: Record<string, number> = {};
      for (const b of balances) { onHand[b.sku] = (onHand[b.sku] || 0) + b.qty; byState[b.state] = (byState[b.state] || 0) + b.qty; }
      const total = Object.values(onHand).reduce((a, b) => a + b, 0); opStockTotal += total;
      // Órdenes por estado + ventanas.
      const st: Record<string, number> = {}; let shippedToday = 0, shipped7 = 0, shipped30 = 0, aging = 0;
      for (const o of orders) {
        st[o.status] = (st[o.status] || 0) + 1;
        const ev = (o.events || []).find((e) => e.type === 'SHIPPED');
        if (ev) { const t = Date.parse(ev.at); if (t >= startToday.getTime()) shippedToday++; if (t >= now - 7 * DAY) shipped7++; if (t >= now - 30 * DAY) shipped30++; }
        if (o.status !== 'SHIPPED' && o.status !== 'CANCELLED' && (now - Date.parse(o.createdAt)) / DAY > 2) aging++;
      }
      let month = 0, currency = 'CLP';
      try { const inv = await this.previewInvoice(sid, new Date(now).getUTCFullYear(), new Date(now).getUTCMonth() + 1); month = (inv.lines || []).reduce((a: number, x: any) => a + (x.amount || 0), 0); currency = inv.currency || currency; } catch { /* sin tarifario */ }

      L.push(`\n== CLIENTE: ${sname} (id ${sid}) ==`);
      L.push(`Stock total on-hand: ${total} un. Por estado: ${Object.keys(byState).map((s) => `${s}=${byState[s]}`).join(', ') || '—'}.`);
      L.push(`SKUs activos: ${skus.filter((s) => s.active !== false).length} de ${skus.length}.`);
      for (const s of skus) { const c = (s.rotationClass as string) || '—'; abcDist[c] = (abcDist[c] || 0) + 1; }
      // Inventario por SKU (on-hand + demanda 30d + cobertura): primero los de mayor demanda.
      const ranked = [...skus].sort((a, b) => (demand30[b.sku] || 0) - (demand30[a.sku] || 0));
      const skuLines = ranked.slice(0, caps.skus).map((s) => {
        const oh = onHand[s.sku] || 0; const d = demand30[s.sku] || 0;
        const cov = d > 0 ? Math.floor(oh / (d / 30)) + 'd' : '—';
        return `${s.sku} "${s.description || ''}" on-hand ${oh}, demanda30 ${d}, cobertura ${cov}${s.lotControlled ? ' [lote]' : ''}${s.expiryControlled ? ' [vence]' : ''}${s.serialControlled ? ' [serie]' : ''}`;
      });
      L.push('Inventario por SKU (los de mayor demanda; usa stock_de_sku / catalogo_productos para el resto):\n' + skuLines.join('\n') + (skus.length > caps.skus ? `\n… (+${skus.length - caps.skus} SKUs más)` : ''));
      L.push(`Órdenes: total ${orders.length}. Por estado: ${Object.keys(st).map((k) => `${k}=${st[k]}`).join(', ') || '—'}. En riesgo(>2d) ${aging}. Despachadas hoy ${shippedToday}, 7d ${shipped7}, 30d ${shipped30}.`);
      const q = await this.getPickingQueue(sid).catch(() => []);
      L.push(`Cola de preparación: ${q.length} orden(es).`);
      if (lots.length) L.push('Lotes por vencer (≤14d): ' + lots.slice(0, 40).map((l) => `${l.sku}·${l.lot} ${l.days < 0 ? 'vencido' : l.days + 'd'} (${l.qty}u)`).join(', '));
      L.push(`Recepciones registradas: ${receipts.length}. Devoluciones: ${returns.length}.`);
      L.push(`Facturación estimada mes en curso: ${currency} ${month.toLocaleString('es-CL')}.`);
    }
    L.push(`\n== TOTAL OPERACIÓN == Stock on-hand consolidado: ${opStockTotal} un.`);

    // Embalaje (nivel operación) con consumo 14d.
    try {
      const pk = await this.packagingLow(operationId); // ya trae onHand/demanda/cobertura de los bajos
      const materials = await this.listPackaging(operationId);
      const movs = await this.listPackagingMovements(operationId);
      const oh: Record<string, number> = {};
      for (const m of movs) oh[m.materialSku] = (oh[m.materialSku] || 0) + m.qtyDelta;
      L.push(`\n== EMBALAJE (${materials.length} insumos) ==`);
      L.push(materials.slice(0, 80).map((m: any) => `${m.sku} "${m.name}" saldo ${oh[m.sku] || 0}`).join(' · '));
      if (pk.length) L.push('Por reabastecer (consumo14>saldo): ' + pk.map((p) => `${p.sku} quedan ${p.onHand} cobertura ${p.coverageDays}d reponer ${p.reorder}`).join(', '));
    } catch { missing.push('embalaje'); }

    // Clasificación ABC (G7): distribución de SKUs por clase de rotación.
    if (Object.keys(abcDist).length) {
      L.push(`\n== CLASIFICACIÓN ABC == ` + Object.keys(abcDist).sort().map((c) => `${c}=${abcDist[c]}`).join(', ') + ' (SKUs por clase de rotación).');
    }

    // Exactitud de inventario (G8): KPI de conteos cíclicos.
    try {
      const acc = await this.getInventoryAccuracy(operationId);
      if (acc && acc.accuracyPct != null) L.push(`\n== EXACTITUD DE INVENTARIO == ${acc.accuracyPct}% sobre ${acc.countsConsidered} conteos (${acc.linesAccurate}/${acc.linesCounted} líneas exactas).`);
    } catch { missing.push('exactitud de inventario'); }

    // Conteo cíclico pendiente por cliente.
    try {
      let pendCounts = 0;
      for (const sid of scope) pendCounts += (await this.planCounts(sid).catch(() => [])).length;
      if (pendCounts) L.push(`Tareas de conteo cíclico propuestas: ${pendCounts}.`);
    } catch { /* ignore */ }

    // Productividad de mano de obra (G4): u/h por operario.
    try {
      const prod: any = await this.laborProductivity(operationId);
      if (prod && prod.operators && prod.operators.length) {
        L.push(`\n== PRODUCTIVIDAD (u/h por operario) == ` + prod.operators.slice(0, 10).map((o: any) => `${o.operator} ${o.unitsPerHour ?? '—'}u/h (${o.units}u/${o.hoursWorked}h)`).join(' · '));
      }
    } catch { missing.push('productividad'); }

    // Carga / asignaciones (Camino B): horas estimadas y pendientes.
    try {
      const load: any = await this.operatorLoad(operationId);
      if (load && load.operarios && load.operarios.length) {
        const busy = load.operarios.slice(0, 12).map((o: any) => `${o.operario} ${o.tareasAbiertas}t/${o.horasEstimadas ?? 0}h`).join(' · ');
        const pend = load.pendientesSinAsignar || {};
        const pendStr = Object.keys(pend).map((k) => `${k}=${pend[k]}`).join(', ') || '—';
        L.push(`\n== CARGA DE OPERARIOS == ${busy}. Sin asignar: ${pendStr}.`);
      }
    } catch { /* sin asignaciones */ }

    // Rentabilidad / costos (mes en curso, v61): ingreso vs. costo, margen y varianza.
    try {
      const Y = new Date(now).getUTCFullYear(); const Mo = new Date(now).getUTCMonth() + 1;
      const pr: any = await this.profitability(operationId, Y, Mo);
      const t = pr.totals || {};
      const cl = (n: number) => Math.round(n || 0).toLocaleString('es-CL');
      L.push(`\n== RENTABILIDAD (mes en curso, ${pr.currency}) == Ingreso ${cl(t.revenue)}, costo real ${cl(t.totalReal)}, margen real ${cl(t.marginReal)} (${t.marginPctReal ?? '—'}%), margen objetivo ${t.marginPctStandard ?? '—'}%, varianza mano de obra ${cl(t.laborVariance)}.`);
      const worst = (pr.sellers || []).slice(0, 3).map((s: any) => `${s.sellerName} ${s.marginPctReal ?? '—'}%`).join(', ');
      if (worst) L.push(`Clientes a vigilar (peor margen real): ${worst}.`);
    } catch { missing.push('rentabilidad'); }

    // Auditoría IA (G5): gobernanza de recomendaciones y acciones de agentes.
    try {
      const ai: any = await this.aiAuditSummary(operationId);
      if (ai && (ai.recommendations?.total || ai.actions?.total)) {
        L.push(`\n== AUDITORÍA IA == recomendaciones ${ai.recommendations.total} (aceptación ${ai.recommendations.acceptanceRate ?? '—'}%), acciones de agentes ${ai.actions.total} (ok ${ai.actions.ok}).`);
      }
    } catch { /* sin auditoría */ }

    // Mensajes internos con clientes (bandeja de operaciones).
    try {
      const cs: any = await this.chatSummary(operationId);
      const unread = cs && (cs.totalUnread ?? cs.unread ?? (Array.isArray(cs.threads) ? cs.threads.reduce((s: number, t: any) => s + (t.unread || 0), 0) : 0));
      if (unread) L.push(`\n== MENSAJES == ${unread} mensaje(s) de clientes sin leer.`);
    } catch { /* sin chat */ }

    return L.join('\n');
  }

  // ---- Contexto en capas para el LLM y el agente (Fase 1 agente autónomo) ----------------

  private profileCache = new Map<string, { at: number; text: string }>();
  /** Invalida el perfil cacheado (al cambiar clientes, ubicaciones, usuarios o ajustes). */
  private invalidateAgentProfile(operationId: string): void { this.profileCache.delete(operationId); }

  /**
   * CAPA 1 — Perfil del tenant: estable, cacheado 5 minutos. Quién es la operación, sus
   * clientes y políticas, zonas y capacidad, equipo, y las reglas de negocio que el modelo
   * debe respetar (hoy solo vivían en el código).
   */
  async agentProfileContext(operationId: string): Promise<string> {
    const now = Date.parse(this.clockNow());
    const c = this.profileCache.get(operationId);
    if (c && now - c.at < 5 * 60000) return c.text;
    const L: string[] = [];
    const op = await this.operationsService.get(operationId);
    L.push(`== PERFIL DE LA OPERACIÓN ==`);
    L.push(`Operación: ${op?.name || operationId} (id ${operationId}). Modo de asignación: ${op?.assignmentMode || 'advisory'}. Auto-balanceo continuo: ${op?.autoBalance ? 'ON' : 'OFF'}.`);
    try {
      const sellers = await this.listSellers(operationId);
      L.push(`Clientes (${sellers.length}): ` + sellers.map((x) => `${x.name} [id ${x.id}] picking ${x.pickingStrategy}${x.consolidateByLocation ? ', consolida por ubicación' : ''}${x.autoAllocateOnIngest ? ', auto-reserva al ingresar' : ''}${(x.courierPriority || []).length ? ', couriers ' + (x.courierPriority || []).join('>') : ''}${x.active === false ? ', INACTIVO' : ''}`).join(' · '));
    } catch { L.push('Clientes: (no disponible)'); }
    try {
      const locs = await this.locations.listByOperation(operationId);
      const byZone: Record<string, { n: number; cap: number }> = {};
      for (const l of locs) { const z = byZone[l.zoneType] || { n: 0, cap: 0 }; z.n += l.active === false ? 0 : 1; z.cap += l.capacity || 0; byZone[l.zoneType] = z; }
      L.push(`Ubicaciones activas por zona: ` + Object.keys(byZone).map((z) => `${z}=${byZone[z].n}${byZone[z].cap ? ' (cap ' + byZone[z].cap + ' un)' : ''}`).join(', ') + '.');
    } catch { L.push('Ubicaciones: (no disponible)'); }
    try {
      const users = await this.listUsers(operationId);
      const ops = users.filter((u) => u.active && u.role === 'OPERATOR');
      const staff = users.filter((u) => u.active && (u.role === 'ADMIN' || u.role === 'SUPERVISOR'));
      L.push(`Equipo: ${ops.length} operario(s) (${ops.slice(0, 15).map((u) => u.name || u.email).join(', ')}${ops.length > 15 ? '…' : ''}); staff: ${staff.map((u) => `${u.name || u.email} (${u.role})`).join(', ') || '—'}.`);
    } catch { L.push('Equipo: (no disponible)'); }
    L.push('Reglas de negocio que debes respetar: el stock recién recibido queda en la zona de RECEPCIÓN y NO es reservable hasta guardarse (putaway) en almacenaje/picking; la reserva es todo-o-nada por orden (si falta stock para una línea no se reserva nada); FIFO usa la fecha de recepción del lote y FEFO el vencimiento; una orden pickeada, empacada o despachada ya no se cancela; recibir, pickear y despachar se confirman con la evidencia del operario (escaneo/registro), tú cierras el paso administrativo; picking, despacho y embalaje se facturan en el mes del despacho; las ubicaciones DEV-MERMA y DEV-CUARENTENA no son pickeables.');
    const text = L.join('\n');
    this.profileCache.set(operationId, { at: now, text });
    return text;
  }

  private lastStateSnapshot = new Map<string, Record<string, number>>();
  /**
   * CAPA 2 — Estado operativo compacto: contadores y LISTAS ACCIONABLES con identificadores,
   * más deltas respecto del ciclo anterior. Es lo que el agente necesita para decidir; el
   * detalle se obtiene con herramientas.
   */
  async agentStateContext(operationId: string, sellerId: string | null): Promise<string> {
    const now = Date.parse(this.clockNow());
    const L: string[] = [];
    const missing: string[] = [];
    const counters: Record<string, number> = {};
    const scope = await this.copilotScope(operationId, sellerId);
    const sname = new Map<string, string>();
    try { for (const x of await this.listSellers(operationId)) sname.set(x.id, x.name); } catch { /* ignore */ }
    const nm = (sid: string) => sname.get(sid) || sid;
    L.push(`== ESTADO OPERATIVO (${new Date(now).toISOString().replace('T', ' ').slice(0, 16)} UTC) ==`);
    // Órdenes por estado + en riesgo con IDs.
    try {
      const st: Record<string, number> = {}; let open = 0;
      for (const sid of scope) for (const o of await this.orders.listOrders(sid)) { st[o.status] = (st[o.status] || 0) + 1; if (o.status !== 'SHIPPED' && o.status !== 'CANCELLED') open++; }
      counters.ordenesAbiertas = open;
      L.push(`Órdenes abiertas ${open}: ` + Object.keys(st).filter((k) => k !== 'SHIPPED' && k !== 'CANCELLED').map((k) => `${k}=${st[k]}`).join(', ') + ` (despachadas ${st.SHIPPED || 0}, canceladas ${st.CANCELLED || 0}).`);
      const risk = await this.getOrdersAtRisk(operationId, { sellerId, maxHours: 12, limit: 25 });
      counters.ordenesEnRiesgo = risk.enRiesgo;
      if (risk.items.length) L.push(`Órdenes detenidas +12 h (${risk.enRiesgo}): ` + risk.items.map((i) => `${i.orden} [${i.estado} ${i.horasDetenida}h, ${nm(i.sellerId)}${i.courier ? ', ' + i.courier : ''}]`).join('; ') + (risk.enRiesgo > risk.items.length ? ' …' : ''));
    } catch { missing.push('órdenes'); }
    // Tareas sin asignar por tipo (con refs) y carga de operarios.
    try {
      const parts: string[] = [];
      for (const t of ['PICK', 'PUTAWAY', 'RECEIVE', 'COUNT', 'RESLOT'] as WorkTaskType[]) {
        const pool = await this.getTaskPool(operationId, t, { onlyUnassigned: true, limit: 200 }).catch(() => [] as Awaited<ReturnType<WmsFacade['getTaskPool']>>);
        const mine = sellerId ? pool.filter((x) => x.sellerId === sellerId) : pool;
        counters[`sinAsignar_${t}`] = mine.length;
        if (mine.length) parts.push(`${t}=${mine.length} (${mine.slice(0, 8).map((x) => x.entityRef || x.entityId).join(', ')}${mine.length > 8 ? '…' : ''})`);
      }
      L.push(`Tareas sin asignar: ${parts.join(' · ') || 'ninguna'}.`);
      const load = await this.operatorLoad(operationId);
      const dir = await this.operatorsDirectory(operationId);
      const act = new Map(dir.operarios.map((o) => [o.id, o.activo]));
      counters.operariosActivos = dir.activos;
      L.push(`Operarios: ${dir.activos} activo(s), ${dir.inactivos} inactivo(s). Carga: ` + (load.operarios.slice(0, 12).map((o) => `${o.nombre || o.operario}${act.get(o.operario) === false ? ' (inactivo)' : ''} ${o.tareasAbiertas}t/${o.horasEstimadas ?? 0}h`).join(' · ') || '—') + '.');
    } catch { missing.push('tareas y operarios'); }
    // Recepciones abiertas.
    try {
      const rec: string[] = []; let n = 0;
      for (const sid of scope) for (const r of await this.listReceipts(sid)) if (r.status === 'PENDING' || r.status === 'PARTIAL') { n++; if (rec.length < 10) rec.push(`${r.reference || r.id} [${r.status}, ${nm(sid)}]`); }
      counters.recepcionesAbiertas = n;
      L.push(`Recepciones abiertas ${n}${rec.length ? ': ' + rec.join('; ') + (n > rec.length ? ' …' : '') : ''}.`);
    } catch { missing.push('recepciones'); }
    // Quiebres, lotes por vencer, embalaje bajo.
    try {
      const so = await this.getStockoutRisk(operationId, { sellerId, coverDays: 7, limit: 10 });
      counters.quiebres = so.enRiesgo;
      if (so.enRiesgo) L.push(`Quiebre inminente (${so.enRiesgo} SKU, cobertura < 7 d): ` + so.items.map((i) => `${i.sku} ${i.diasCobertura}d (${nm(i.sellerId)})`).join(', ') + '.');
    } catch { missing.push('quiebres'); }
    try {
      const lots: string[] = []; let n = 0;
      for (const sid of scope) for (const l of await this.expiringLots(sid, now)) { n++; if (lots.length < 10) lots.push(`${l.sku}·${l.lot} ${l.days < 0 ? 'VENCIDO' : l.days + 'd'} (${l.qty}u, ${nm(sid)})`); }
      counters.lotesPorVencer = n;
      if (n) L.push(`Lotes por vencer/vencidos (${n}): ${lots.join(', ')}${n > lots.length ? ' …' : ''}.`);
    } catch { missing.push('lotes'); }
    try {
      const pk = await this.packagingLow(operationId);
      counters.insumosBajos = pk.length;
      if (pk.length) L.push(`Insumos de embalaje bajo mínimo (${pk.length}): ` + pk.slice(0, 8).map((p) => `${p.sku} quedan ${p.onHand} (${p.coverageDays}d)`).join(', ') + '.');
    } catch { missing.push('embalaje'); }
    // Alertas abiertas del agente.
    try {
      const alerts = this.agentAlertRepo ? await this.agentAlertRepo.listOpen(operationId) : [];
      counters.alertasAbiertas = alerts.length;
      if (alerts.length) L.push(`Alertas abiertas del agente (${alerts.length}): ` + alerts.slice(0, 12).map((a) => `[${a.severity}] ${a.title}${a.actionStatus === 'proposed' ? ' (acción propuesta: ' + a.actionLabel + ')' : ''}`).join('; ') + (alerts.length > 12 ? ' …' : '') + '.');
    } catch { missing.push('alertas'); }
    // Deltas respecto del ciclo anterior.
    const key = `${operationId}:${sellerId || '*'}`;
    const prev = this.lastStateSnapshot.get(key);
    if (prev) {
      const d = Object.keys(counters).filter((k) => prev[k] !== undefined && prev[k] !== counters[k]).map((k) => `${k} ${prev[k]}→${counters[k]}`);
      L.push(`Cambios desde el ciclo anterior: ${d.length ? d.join(', ') : 'sin cambios'}.`);
    }
    this.lastStateSnapshot.set(key, counters);
    if (missing.length) L.push(`(No disponible en este ciclo: ${missing.join(', ')}.)`);
    return L.join('\n');
  }

  /** CAPA 4 — Memoria del agente: instrucciones vigentes, últimas decisiones y resultados. */
  async agentMemoryContext(operationId: string): Promise<string> {
    if (!this.agentJournal) return '';
    const L: string[] = [];
    const now = this.clockNow();
    try {
      const ins = await this.agentJournal.listInstructions(operationId, now);
      L.push(`== INSTRUCCIONES VIGENTES DEL ADMINISTRADOR (${ins.length}) ==`);
      L.push(ins.length ? ins.map((i) => `- ${i.text}${i.expiresAt ? ' (hasta ' + i.expiresAt.slice(0, 10) + ')' : ''}`).join('\n') : '- (ninguna)');
      const recent = (await this.agentJournal.listRecent(operationId, { limit: 40 })).filter((e) => e.kind !== 'tools' && e.kind !== 'instruction').slice(0, 15);
      if (recent.length) {
        L.push(`== DIARIO RECIENTE DEL AGENTE ==`);
        L.push(recent.map((e) => `${e.at.replace('T', ' ').slice(5, 16)} [${e.kind}] ${e.text}`).join('\n'));
      }
    } catch { L.push('(diario no disponible)'); }
    return L.join('\n');
  }

  /**
   * Contexto completo para el LLM, compuesto por capas con PRIORIDAD: si hay que recortar,
   * se recortan primero las capas de detalle y nunca lo accionable. Las secciones que fallan
   * se declaran como "no disponible" en vez de desaparecer en silencio.
   */
  private async copilotContext(operationId: string, sellerId: string | null): Promise<string> {
    const now = Date.parse(this.clockNow());
    const missing: string[] = [];
    const settings = await this.agentSettings(operationId);
    const head = `Fecha actual: ${new Date(now).toISOString().slice(0, 10)}. Alcance: ${sellerId ? 'cliente ' + sellerId : 'toda la operación'}. Política: ${describePolicy(settings)}`;
    const sections: Array<{ name: string; prio: number; text: string }> = [{ name: 'cabecera', prio: 0, text: head }];
    const push = async (name: string, prio: number, fn: () => Promise<string>) => { try { const t = await fn(); if (t) sections.push({ name, prio, text: t }); } catch { missing.push(name); } };
    await push('perfil', 1, () => this.agentProfileContext(operationId));
    await push('estado', 1, () => this.agentStateContext(operationId, sellerId));
    await push('memoria', 1, () => this.agentMemoryContext(operationId));
    await push('detalle', 3, () => this.copilotDetailContext(operationId, sellerId, { skus: 80, locs: 60 }, missing));
    const CAP = 48000;
    let total = sections.reduce((a, x) => a + x.text.length + 2, 0);
    for (const prio of [3, 2]) {
      for (const sec of sections.filter((x) => x.prio === prio)) {
        if (total <= CAP) break;
        const room = Math.max(0, sec.text.length - (total - CAP));
        sec.text = room > 400 ? sec.text.slice(0, room) + `\n… (${sec.name} recortado)` : `(${sec.name} omitido por tamaño)`;
        total = sections.reduce((a, x) => a + x.text.length + 2, 0);
      }
    }
    if (missing.length) sections.push({ name: 'faltantes', prio: 0, text: `(Secciones no disponibles: ${missing.join(', ')}.)` });
    return sections.map((x) => x.text).join('\n\n');
  }

  // ---- Credenciales de IA por tenant (para el copiloto) --------------------
  /** Conecta/actualiza la clave LLM de una operación (sellerId=null) o de un seller. */
  async setAiConfig(operationId: string, sellerId: string | null, input: { provider?: string; baseUrl?: string; chatModel?: string; apiKey: string }): Promise<{ connected: boolean }> {
    await this.assertFeature(operationId, 'ai_copilot', 'El copiloto con IA');
    if (!this.aiConfig) throw new ValidationError('Configuración de IA no disponible');
    if (!input.apiKey || !input.apiKey.trim()) throw new ValidationError('Falta la API key');
    const providerKey = (input.provider || 'openai').trim().toLowerCase();
    const def = (COPILOT_PROVIDERS as any)[providerKey] || COPILOT_PROVIDERS.openai;
    const baseUrl = (input.baseUrl && input.baseUrl.trim()) || def.baseUrl;
    const chatModel = (input.chatModel && input.chatModel.trim()) || def.model;
    if (def.needsBaseUrl && !baseUrl) throw new ValidationError('Este proveedor requiere una Base URL');
    if (!chatModel) throw new ValidationError('Indica el modelo a usar');
    const cred: AiCredential = {
      operationId, sellerId,
      provider: providerKey,
      baseUrl, chatModel,
      apiKey: input.apiKey.trim(),
      active: true,
      updatedAt: this.clockNow(),
    };
    await this.aiConfig.save(cred);
    return { connected: true };
  }
  /** Catálogo de proveedores soportados (para poblar el formulario del front). */
  aiProviders() { return COPILOT_PROVIDERS; }
  /** Estado de la conexión de IA (SIN exponer la clave: solo últimos 4 + metadatos). */
  async getAiConfigStatus(operationId: string, sellerId: string | null): Promise<{ connected: boolean; scope: 'seller' | 'operation' | 'none'; provider?: string; providerLabel?: string; baseUrl?: string; chatModel?: string; last4?: string; updatedAt?: string }> {
    if (!this.aiConfig) return { connected: false, scope: 'none' };
    const own = sellerId ? await this.aiConfig.get(operationId, sellerId) : null;
    const opLevel = await this.aiConfig.get(operationId, null);
    const eff = (own && own.active) ? own : (opLevel && opLevel.active ? opLevel : null);
    if (!eff) return { connected: false, scope: 'none' };
    const label = ((COPILOT_PROVIDERS as any)[eff.provider] || {}).label || eff.provider;
    return {
      connected: true,
      scope: eff.sellerId ? 'seller' : 'operation',
      provider: eff.provider, providerLabel: label, baseUrl: eff.baseUrl, chatModel: eff.chatModel,
      last4: eff.apiKey.slice(-4), updatedAt: eff.updatedAt,
    };
  }
  /** Desconecta la clave (a nivel operación o del seller). */
  async deleteAiConfig(operationId: string, sellerId: string | null): Promise<{ connected: boolean }> {
    if (this.aiConfig) await this.aiConfig.delete(operationId, sellerId);
    return { connected: false };
  }
  /** Resuelve la credencial efectiva: la del seller manda; si no, la de la operación. */
  private async resolveAiCredential(operationId: string, sellerId: string | null): Promise<AiCredential | null> {
    if (!this.aiConfig) return null;
    if (sellerId) { const s = await this.aiConfig.get(operationId, sellerId); if (s && s.active) return s; }
    const op = await this.aiConfig.get(operationId, null);
    return op && op.active ? op : null;
  }

  // ---- Marca / white-label por operación -----------------------------------
  private emptyBranding(operationId: string): OperationBranding {
    return { operationId, companyName: null, legalName: null, taxId: null, address: null, email: null, phone: null, website: null, primaryColor: null, logoDataUri: null };
  }
  async getOperationBranding(operationId: string): Promise<OperationBranding> {
    if (!this.branding) return this.emptyBranding(operationId);
    const b = await this.branding.get(operationId);
    return b ?? this.emptyBranding(operationId);
  }
  async setOperationBranding(
    operationId: string,
    patch: Partial<Omit<OperationBranding, 'operationId'>>,
  ): Promise<OperationBranding> {
    if (!this.branding) throw new ValidationError('Marca no disponible');
    await this.assertFeature(operationId, 'white_label', 'La marca personalizada (white-label)');
    if (patch.logoDataUri && patch.logoDataUri.length > 400_000) {
      throw new ValidationError('El logo es muy grande (máx ~280 KB). Sube una imagen más liviana.');
    }
    if (patch.primaryColor && !/^#[0-9a-fA-F]{6}$/.test(patch.primaryColor)) {
      throw new ValidationError('El color debe ser un hex como #0E9F6E');
    }
    const cur = await this.getOperationBranding(operationId);
    const next: OperationBranding = { ...cur, ...patch, operationId };
    await this.branding.save(next);
    return next;
  }

  /** Trazabilidad por número de serie: lista las series de un seller (opcionalmente por SKU). */
  async listSerials(sellerId: string, sku?: string): Promise<Serial[]> {
    if (!this.serials) return [];
    return this.serials.list(sellerId, sku);
  }
  /** Busca un número de serie puntual (traza: lote, vencimiento, recepción, estado). */
  async getSerial(sellerId: string, sku: string, serial: string): Promise<Serial | null> {
    if (!this.serials) return null;
    return this.serials.get(sellerId, sku, serial);
  }

  // ---- Operaciones (tenant superior; solo PLATFORM_ADMIN) -------------------
  createOperation(input: { id?: string; name: string; track?: 'brand' | 'operator' | null; selfServe?: boolean }): Promise<Operation> {
    return this.operationsService.create(input);
  }
  getOperation(operationId: string): Promise<Operation | null> {
    return this.operationsService.get(operationId);
  }
  listOperations(): Promise<Operation[]> {
    return this.operationsService.list();
  }
  /** Edita nombre/estado de una operación (solo PLATFORM_ADMIN vía guard). */
  updateOperation(operationId: string, patch: { name?: string; active?: boolean }): Promise<Operation> {
    return this.operationsService.update(operationId, patch);
  }
  listSellers(operationId: string): Promise<Seller[]> {
    return this.sellers.list(operationId);
  }

  // ---- Planes y entitlements (PLG · Fase 1) --------------------------------
  private planNow(): number { return this.clock ? Date.parse(this.clock.now()) : Date.now(); }
  private readonly LIMIT_LABEL: Record<keyof PlanLimits, string> = {
    ordersPerMonth: 'órdenes este mes', sellers: 'clientes', users: 'usuarios', warehouses: 'ubicaciones',
  };

  /** Catálogo EFECTIVO: defaults del código con los overrides del super-admin aplicados. */
  private async resolveCatalog(): Promise<Record<PlanId, PlanDef>> {
    if (!this.planConfig) return PLAN_CATALOG;
    const overrides = await this.planConfig.list();
    return overrides.length ? mergeCatalog(overrides) : PLAN_CATALOG;
  }

  /** Plan efectivo (definición) de una operación. Sin operación o sin planId => 'internal'. */
  private async effectivePlan(operationId: string | null): Promise<PlanDef> {
    const catalog = await this.resolveCatalog();
    if (!operationId) return catalog.internal;
    const op = await this.operationsService.get(operationId);
    if (!op) return catalog.internal;
    return catalog[effectivePlanId(op, this.planNow())];
  }

  /** ¿La operación tiene cierto feature según su plan efectivo? */
  async hasFeature(operationId: string | null, feature: PlanFeature): Promise<boolean> {
    return (await this.effectivePlan(operationId)).features.includes(feature);
  }

  /** Exige un feature; lanza PlanLimitError (HTTP 402) si el plan no lo incluye. */
  private async assertFeature(operationId: string | null, feature: PlanFeature, label: string): Promise<void> {
    if (!operationId) return; // plataforma/demo sin operación
    const plan = await this.effectivePlan(operationId);
    if (plan.id === 'internal') return;
    if (!plan.features.includes(feature)) {
      throw new PlanLimitError(`${label} no está incluido en tu plan ${plan.name}. Mejora tu plan para habilitarlo.`);
    }
  }

  private monthStartMs(nowMs: number): number {
    const d = new Date(nowMs);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }

  /** Uso actual por recurso en la operación (órdenes del mes en curso, clientes, usuarios, ubicaciones). */
  private async usageFor(operationId: string): Promise<Record<keyof PlanLimits, number>> {
    const sellers = await this.sellers.list(operationId);
    const users = (await this.usersService.listUsers(operationId)).length;
    const locs = await this.locations.listByOperation(operationId);
    const from = this.monthStartMs(this.planNow());
    let orders = 0;
    for (const s of sellers) {
      const list = await this.orders.listOrders(s.id);
      for (const o of list) if (Date.parse(o.createdAt) >= from) orders += 1;
    }
    return { ordersPerMonth: orders, sellers: sellers.length, users, warehouses: locs.length };
  }

  /** Verifica que sumar `add` de un recurso no exceda el plan. Lanza PlanLimitError si sí. */
  private async assertQuota(operationId: string | null, kind: keyof PlanLimits, add = 1): Promise<void> {
    if (!operationId) return;
    const op = await this.operationsService.get(operationId);
    if (!op) return;
    const plan = (await this.resolveCatalog())[effectivePlanId(op, this.planNow())];
    if (plan.id === 'internal') return;
    const limit = plan.limits[kind];
    if (limit == null) return; // ilimitado
    const usage = await this.usageFor(operationId);
    if (usage[kind] + add > limit) {
      throw new PlanLimitError(`Alcanzaste el límite de tu plan ${plan.name}: ${limit} ${this.LIMIT_LABEL[kind]}. Mejora tu plan para seguir.`);
    }
  }

  /** Resuelve la operación de un seller y aplica una cuota (para acciones scoped por seller). */
  private async assertQuotaBySeller(sellerId: string, kind: keyof PlanLimits, add = 1): Promise<void> {
    const seller = await this.sellers.findById(sellerId);
    if (seller) await this.assertQuota(seller.operationId, kind, add);
  }

  /** Estado completo del plan de una operación (para la UI: plan, trial, uso vs límite). */
  async getPlanState(operationId: string): Promise<any> {
    const op = await this.operationsService.get(operationId);
    const nowMs = this.planNow();
    const catalog = await this.resolveCatalog();
    const plan = op ? catalog[effectivePlanId(op, nowMs)] : catalog.internal;
    const base = catalog[(op?.planId as PlanId) in catalog ? (op!.planId as PlanId) : 'internal'];
    const trial = op ? trialStateOf(op, nowMs) : { active: false, plan: null, endsAt: null, daysLeft: 0 };
    const usage = op ? await this.usageFor(operationId) : { ordersPerMonth: 0, sellers: 0, users: 0, warehouses: 0 };
    const row = (k: keyof PlanLimits) => ({ used: usage[k], limit: plan.limits[k] });
    return {
      plan: { id: plan.id, name: plan.name, prices: plan.prices, blurb: plan.blurb, features: plan.features },
      basePlan: { id: base.id, name: base.name },
      trial,
      usage: { ordersPerMonth: row('ordersPerMonth'), sellers: row('sellers'), users: row('users'), warehouses: row('warehouses') },
      selfServe: !!op?.selfServe,
    };
  }

  /** Catálogo público de planes (efectivo) para el comparador de precios. */
  async planCatalog(): Promise<PlanDef[]> {
    const catalog = await this.resolveCatalog();
    return (['free', 'growth', 'scale', 'enterprise'] as PlanId[]).map((id) => catalog[id]);
  }

  /** Grant manual de plan por el super-admin (sin pagos aún). */
  async setOperationPlan(operationId: string, planId: string): Promise<Operation> {
    if (!(planId in PLAN_CATALOG)) throw new ValidationError(`Plan inválido: ${planId}`);
    return this.operationsService.setPlan(operationId, planId);
  }

  // ---- Mantenedor de empaquetado: matriz módulo × plan (super-admin) --------
  /** Cuántas operaciones están HOY en cada plan efectivo (transparencia antes de editar). */
  private async planAccountCounts(): Promise<Record<string, number>> {
    const ops = await this.operationsService.list();
    const nowMs = this.planNow();
    const counts: Record<string, number> = {};
    for (const op of ops) {
      const id = effectivePlanId(op, nowMs);
      counts[id] = (counts[id] || 0) + 1;
    }
    return counts;
  }

  /**
   * Estado de la matriz de empaquetado para el super-admin: catálogo efectivo (con
   * overrides aplicados), lista de módulos y límites (las filas), y cuántas cuentas
   * hay en cada plan (para dimensionar el impacto de un cambio).
   */
  async getPackagingMatrix(): Promise<{
    plans: Array<{ id: PlanId; name: string; prices: { usd: number | null; clp: number | null }; blurb: string; limits: PlanLimits; features: PlanFeature[] }>;
    modules: Array<{ key: PlanFeature; label: string; description: string }>;
    limits: Array<{ key: string; label: string }>;
    coreFeature: PlanFeature;
    accountCounts: Record<string, number>;
  }> {
    const catalog = await this.resolveCatalog();
    const ids: PlanId[] = ['free', 'growth', 'scale', 'enterprise'];
    return {
      plans: ids.map((id) => {
        const p = catalog[id];
        return { id, name: p.name, prices: p.prices, blurb: p.blurb, limits: p.limits, features: p.features };
      }),
      modules: MODULE_CATALOG,
      limits: LIMIT_KEYS.map((l) => ({ key: String(l.key), label: l.label })),
      coreFeature: CORE_FEATURE,
      accountCounts: await this.planAccountCounts(),
    };
  }

  /** Actualiza la config de UN plan (módulos + límites + display). Núcleo siempre incluido. */
  async updatePlanConfig(planId: string, patch: { name?: string; prices?: { usd?: number | null; clp?: number | null }; blurb?: string; limits?: Partial<PlanLimits>; features?: string[] }): Promise<PlanConfig> {
    if (!this.planConfig) throw new ValidationError('Mantenedor de planes no disponible');
    const pid = planId as PlanId;
    if (!(pid in PLAN_CATALOG) || pid === 'internal') throw new ValidationError(`Plan no editable: ${planId}`);
    const current = (await this.planConfig.get(pid)) || defaultPlanConfig(pid);
    const validModules = new Set<string>(MODULE_CATALOG.map((m) => m.key));
    let features = patch.features
      ? patch.features.filter((f) => validModules.has(f)) as PlanFeature[]
      : current.features;
    features = Array.from(new Set([CORE_FEATURE, ...features]));
    const limits: PlanLimits = { ...current.limits, ...(patch.limits || {}) } as PlanLimits;
    // Normaliza límites: número >= 0 o null (ilimitado).
    for (const k of Object.keys(limits) as (keyof PlanLimits)[]) {
      const v = limits[k];
      limits[k] = v == null || (v as any) === '' ? null : Math.max(0, Math.floor(Number(v)));
      if (Number.isNaN(limits[k] as any)) limits[k] = null;
    }
    // Precios: número >= 0 o null (a medida). Se acepta patch parcial (solo usd o solo clp).
    const cleanPrice = (v: any, fallback: number | null): number | null => {
      if (v === undefined) return fallback;
      if (v === null || v === '') return null;
      const n = Math.max(0, Math.round(Number(v)));
      return Number.isNaN(n) ? fallback : n;
    };
    const prices = {
      usd: cleanPrice(patch.prices?.usd, current.prices?.usd ?? null),
      clp: cleanPrice(patch.prices?.clp, current.prices?.clp ?? null),
    };
    const next: PlanConfig = {
      planId: pid,
      name: (patch.name ?? current.name).toString().slice(0, 60) || current.name,
      prices,
      blurb: (patch.blurb ?? current.blurb).toString().slice(0, 200),
      limits,
      features,
    };
    await this.planConfig.save(next);
    return next;
  }

  /** Restaura toda la matriz a los valores por defecto del código. */
  async resetPackaging(): Promise<{ reset: boolean }> {
    if (!this.planConfig) throw new ValidationError('Mantenedor de planes no disponible');
    await this.planConfig.clear();
    return { reset: true };
  }

  // ---- Onboarding y activación (PLG · Fase 2) ------------------------------
  /**
   * Estado de puesta en marcha de una operación: un checklist DERIVADO de los datos
   * reales (no flags almacenados) que empuja hacia el "aha": despachar la 1ª orden.
   * `emailVerified` lo completa la capa API con el usuario actual.
   */
  async getOnboardingState(operationId: string): Promise<{
    track: 'brand' | 'operator';
    activated: boolean;
    steps: Array<{ key: string; label: string; done: boolean; link: string | null }>;
    done: number; total: number;
  }> {
    const op = await this.operationsService.get(operationId);
    const track: 'brand' | 'operator' = (op?.track as 'brand' | 'operator') || 'brand';
    const sellers = await this.sellers.list(operationId);
    const locs = await this.locations.listByOperation(operationId);
    let hasSku = false, hasReceipt = false, hasOrder = false, hasShipped = false;
    for (const s of sellers) {
      if (!hasSku && (await this.skus.list(s.id)).length) hasSku = true;
      if (!hasReceipt) {
        const movs = await this.listMovements(s.id, 50);
        if (movs.some((m) => m.type === MovementType.RECEIPT || m.type === MovementType.PUTAWAY)) hasReceipt = true;
      }
      if (!hasOrder || !hasShipped) {
        const orders = await this.orders.listOrders(s.id);
        if (orders.length) hasOrder = true;
        if (orders.some((o) => o.status === 'SHIPPED')) hasShipped = true;
      }
    }
    const steps: Array<{ key: string; label: string; done: boolean; link: string | null }> = [];
    steps.push({ key: 'verify_email', label: 'Verifica tu email', done: false, link: null }); // lo resuelve la API
    if (track === 'operator') {
      steps.push({ key: 'create_client', label: 'Crea tu primer cliente', done: sellers.length > 0, link: 'clients' });
    }
    steps.push({ key: 'create_location', label: 'Crea tu primera ubicación', done: locs.length > 0, link: 'locations' });
    steps.push({ key: 'create_product', label: 'Crea tu primer producto', done: hasSku, link: 'products' });
    steps.push({ key: 'receive_stock', label: 'Ingresa stock a bodega', done: hasReceipt, link: 'inbound' });
    steps.push({ key: 'create_order', label: 'Crea tu primera orden', done: hasOrder, link: 'orders' });
    steps.push({ key: 'ship_order', label: 'Despacha tu primera orden', done: hasShipped, link: 'orders' });
    const done = steps.filter((s) => s.done).length;
    return { track, activated: hasShipped, steps, done, total: steps.length };
  }

  /**
   * Carga un set de datos de ejemplo en la cuenta (marca/operador): ubicaciones,
   * productos con stock y órdenes en estados variados —incluida una despachada—,
   * para que la persona vea el flujo completo antes de cargar su inventario real.
   * Solo puebla si el seller destino está vacío (no duplica).
   */
  async loadSampleData(operationId: string, actor?: string): Promise<{ loaded: boolean; reason?: string; sellerId?: string }> {
    await this.operationsService.mustGet(operationId);
    const by = actor || 'ejemplo';
    let sellers = await this.sellers.list(operationId);
    let sellerId: string;
    if (sellers.length) sellerId = sellers[0].id;
    else sellerId = (await this.createSeller({ operationId, name: 'Cliente Demo' })).id;
    if ((await this.skus.list(sellerId)).length) return { loaded: false, reason: 'already', sellerId };
    // Ubicaciones (si no existen).
    const existingLocs = await this.locations.listByOperation(operationId);
    const recv = existingLocs.find((l) => l.zoneType === ZoneType.RECEIVING)
      || await this.createLocation({ operationId, code: 'RECV-01', zoneType: ZoneType.RECEIVING });
    const stg = existingLocs.find((l) => l.zoneType === ZoneType.STORAGE)
      || await this.createLocation({ operationId, code: 'A-01-1-A', zoneType: ZoneType.STORAGE, capacity: 1000, pickRank: 1 });
    // Productos con stock.
    const DEMO: Array<[string, string]> = [
      ['POL-NEG-M', 'Polera negra talla M'],
      ['POL-BLA-L', 'Polera blanca talla L'],
      ['JEA-AZU-32', 'Jeans azul 32'],
      ['ZAP-CAF-42', 'Zapatilla café 42'],
      ['GOR-VER-U', 'Gorro verde único'],
    ];
    for (const [sku, description] of DEMO) {
      await this.createSku(sellerId, { sku, description }, by);
      await this.receive(sellerId, { sku, qty: 100, locationId: recv.id, actor: by });
      await this.putaway(sellerId, { sku, qty: 100, fromLocationId: recv.id, toLocationId: stg.id, actor: by });
    }
    // Órdenes en estados variados (la última despachada → activa la cuenta).
    const CITIES = ['Santiago', 'Providencia', 'Viña del Mar', 'Concepción', 'La Serena', 'Temuco'];
    for (let i = 0; i < 6; i++) {
      const sku = DEMO[i % DEMO.length][0];
      const ord = await this.createOrder(sellerId, {
        externalOrderId: `DEMO-${1001 + i}`,
        salesChannel: 'web',
        shipTo: { name: `Cliente ${i + 1} (${CITIES[i % CITIES.length]})` } as any,
        lines: [{ sku, qty: 2 }],
      }, by);
      try {
        if (i >= 1) await this.allocateOrder(sellerId, ord.id, by);
        if (i >= 2) await this.confirmPick(sellerId, ord.id, by);
        if (i >= 3) await this.packOrder(sellerId, ord.id, { bultos: 1, materials: [] }, by);
        if (i >= 4) await this.shipOrder(sellerId, ord.id, { carrier: 'Chilexpress', trackingNumber: `TRK${100000 + i}` }, by);
      } catch { /* si una transición no cuadra, la orden queda en su estado y seguimos */ }
    }
    return { loaded: true, sellerId };
  }

  listLocations(operationId: string): Promise<Location[]> {
    return this.locations.listByOperation(operationId);
  }
  getLocation(locationId: string): Promise<Location | null> {
    return this.locations.findById(locationId);
  }
  /** Maestro de SKUs de un seller (para poblar formularios como el de recepción). */
  listSkus(sellerId: string): Promise<Sku[]> {
    return this.skus.list(sellerId);
  }
  /**
   * Edita una ubicación (capacidad, cercanía a picking, zona, bodega, estado).
   * Respeta la frontera de operación: un usuario atado a una operación no puede
   * editar ubicaciones de otra (el PLATFORM_ADMIN sí puede en cualquiera).
   */
  async updateLocation(
    locationId: string,
    patch: { code?: string; zoneType?: ZoneType; warehouseId?: string; capacity?: number; pickRank?: number; active?: boolean },
    actor?: User | null,
  ): Promise<Location> {
    const loc = await this.locations.findById(locationId);
    if (!loc) throw new NotFoundError(`Ubicación no encontrada: ${locationId}`);
    if (actor && actor.operationId && actor.operationId !== loc.operationId) {
      throw new ForbiddenError('No puedes editar ubicaciones de otra operación');
    }
    const updated: Location = {
      ...loc,
      code: patch.code != null && patch.code.trim() ? patch.code.trim() : loc.code,
      zoneType: patch.zoneType ?? loc.zoneType,
      warehouseId: patch.warehouseId != null && patch.warehouseId.trim() ? patch.warehouseId.trim() : loc.warehouseId,
      capacity: patch.capacity != null ? patch.capacity : loc.capacity,
      pickRank: patch.pickRank != null ? patch.pickRank : loc.pickRank,
      active: patch.active != null ? patch.active : loc.active,
    };
    await this.locations.save(updated);
    return updated;
  }

  /**
   * Elimina una ubicación. Solo se permite si NUNCA tuvo movimientos de stock
   * (de ningún cliente) y ninguna recepción abierta apunta a ella. Si tuvo
   * historia, la respuesta correcta es desactivarla (el kardex la referencia).
   */
  async deleteLocation(locationId: string, actor?: User | null): Promise<{ ok: true; id: string; code: string }> {
    const loc = await this.locations.findById(locationId);
    if (!loc) throw new NotFoundError(`Ubicación no encontrada: ${locationId}`);
    if (actor && actor.operationId && actor.operationId !== loc.operationId) {
      throw new ForbiddenError('No puedes eliminar ubicaciones de otra operación');
    }
    if (await this.inventory.locationHasHistory(locationId)) {
      throw new ValidationError(`La ubicación ${loc.code} tiene movimientos de stock registrados y no se puede eliminar. Desactívala para que deje de usarse.`);
    }
    const sellers = await this.listSellers(loc.operationId);
    for (const s of sellers) {
      const open = (await this.receipts.list(s.id)).filter((r) => r.locationId === locationId && r.status !== ReceiptOrderStatus.CANCELLED);
      if (open.length) {
        throw new ValidationError(`La ubicación ${loc.code} está asociada a ${open.length} recepción(es) del cliente ${s.name}. Cancélalas o cambia su ubicación antes de eliminarla.`);
      }
    }
    await this.locations.delete(locationId);
    return { ok: true, id: locationId, code: loc.code };
  }

  // ---- Códigos de barra y unidades de medida --------------------------------
  registerPack(sellerId: string, input: RegisterPackInput, actor?: string): Promise<PackConfig> {
    return this.products.registerPack(sellerId, input, actor);
  }
  listPacks(sellerId: string, sku: string): Promise<PackConfig[]> {
    return this.barcodes.listPacks(sellerId, sku);
  }
  resolveBarcode(sellerId: string, barcode: string): Promise<PackConfig> {
    return this.barcodes.resolve(sellerId, barcode);
  }

  /**
   * Interpreta un código escaneado para RECEPCIÓN. Si es GS1, extrae GTIN, lote,
   * vencimiento y serie; resuelve el SKU por el GTIN (o por el código plano). Es
   * no destructivo: si no es GS1, intenta resolverlo como código normal.
   */
  async parseScannedCode(
    sellerId: string,
    code: string,
  ): Promise<{ isGs1: boolean; sku: string | null; gtin: string | null; lot: string | null; expiry: string | null; serial: string | null; qty: number | null }> {
    const gs1 = parseGs1(code);
    const lookupCodes: string[] = [];
    if (gs1?.gtin) {
      lookupCodes.push(gs1.gtin);
      // Muchos GTIN se registran sin el 0 inicial de relleno a 14 dígitos.
      lookupCodes.push(gs1.gtin.replace(/^0+/, ''));
    }
    lookupCodes.push(String(code || '').trim()); // fallback: el código tal cual
    let sku: string | null = null;
    for (const c of lookupCodes) {
      if (!c) continue;
      try {
        const pack = await this.barcodes.resolve(sellerId, c);
        sku = pack.sku;
        break;
      } catch {
        /* sigue probando */
      }
    }
    return {
      isGs1: !!gs1,
      sku,
      gtin: gs1?.gtin ?? null,
      lot: gs1?.lot ?? null,
      expiry: gs1?.expiry ?? null,
      serial: gs1?.serial ?? null,
      qty: gs1?.qty ?? null,
    };
  }
  /**
   * Recepción por escaneo: traduce el código + Nº de packs a unidades base
   * (múltiplos del EAN) y las ingresa al inventario.
   */
  async scanInbound(
    sellerId: string,
    input: {
      barcode: string;
      packCount: number;
      locationId?: string; // por id...
      locationCode?: string; // ...o por código de bin (lo que pistolea la PWA)
      lot?: string | null;
      expiry?: string | null;
      reference?: string | null;
      actor?: string;
    },
  ): Promise<{ scan: ScanResult; movement: StockMovement }> {
    const scan = await this.barcodes.toBaseUnits(sellerId, input.barcode, input.packCount);
    const opId = await this.operationOfSeller(sellerId);
    const locationId = input.locationId ?? (await this.mustLocationByCode(opId, input.locationCode ?? '')).id;
    const movement = await this.inventory.receive(sellerId, {
      sku: scan.sku,
      qty: scan.baseQty,
      locationId,
      lot: input.lot ?? null,
      expiry: input.expiry ?? null,
      reference: input.reference ?? `SCAN ${scan.packCount}x${scan.code} (${input.barcode})`,
      actor: input.actor,
    });
    return { scan, movement };
  }

  /**
   * Guardado por escaneo: pistolear producto + ubicación origen/destino.
   * El nivel (EAN/DUN) y la conversión a unidades base salen automáticos del código.
   */
  async scanPutaway(
    sellerId: string,
    input: {
      productBarcode: string;
      packCount: number;
      fromLocationCode: string;
      toLocationCode: string;
      lot?: string | null;
      actor?: string;
    },
  ): Promise<{ scan: ScanResult; movements: StockMovement[] }> {
    const scan = await this.barcodes.toBaseUnits(sellerId, input.productBarcode, input.packCount);
    const opId = await this.operationOfSeller(sellerId);
    const from = await this.mustLocationByCode(opId, input.fromLocationCode);
    const to = await this.mustLocationByCode(opId, input.toLocationCode);
    const movements = await this.inventory.putaway(sellerId, {
      sku: scan.sku,
      qty: scan.baseQty,
      fromLocationId: from.id,
      toLocationId: to.id,
      lot: input.lot ?? null,
      reference: `SCAN-PUTAWAY ${scan.packCount}x${scan.code}`,
      actor: input.actor,
    });
    // G5: ¿se siguió la recomendación de guardado para este SKU?
    await this.markPutawayRecommendationTaken(opId, sellerId, scan.sku, to.id, to.code);
    // Camino B: cierra la asignación de guardado o de re-slotting (según origen).
    await this.completeAssignments('PUTAWAY', [`${sellerId}:${scan.sku}:${from.id}`], input.actor || 'system');
    await this.completeAssignments('RESLOT', [`${sellerId}:${scan.sku}:${from.id}`], input.actor || 'system');
    await this.continuousHook(opId, 'PUTAWAY', null); await this.continuousHook(opId, 'RESLOT', null);
    return { scan, movements };
  }

  /**
   * Picking por escaneo: pistolear la ubicación y el producto para confirmar la toma.
   * Retira del RESERVED las unidades base equivalentes al código escaneado.
   */
  async scanPick(
    sellerId: string,
    input: {
      productBarcode: string;
      packCount: number;
      locationCode: string;
      lot?: string | null;
      actor?: string;
    },
  ): Promise<{ scan: ScanResult; movement: StockMovement }> {
    const scan = await this.barcodes.toBaseUnits(sellerId, input.productBarcode, input.packCount);
    const loc = await this.mustLocationByCode(await this.operationOfSeller(sellerId), input.locationCode);
    const movement = await this.inventory.pick(sellerId, {
      sku: scan.sku,
      qty: scan.baseQty,
      locationId: loc.id,
      lot: input.lot ?? null,
      reference: `SCAN-PICK ${scan.packCount}x${scan.code}`,
      actor: input.actor,
    });
    return { scan, movement };
  }

  private async mustLocationByCode(operationId: string, code: string): Promise<Location> {
    const loc = await this.locations.findByCode(operationId, code);
    if (!loc) throw new NotFoundError(`Ubicación no reconocida: ${code}`);
    return loc;
  }

  /** Operación a la que pertenece un seller (para resolver bins por código). */
  private async operationOfSeller(sellerId: string): Promise<string> {
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw new NotFoundError(`Seller no encontrado: ${sellerId}`);
    return seller.operationId;
  }

  // ---- Usuarios, roles y autorización ---------------------------------------
  async createUser(input: CreateUserInput): Promise<User> {
    await this.assertQuota(input.operationId ?? null, 'users');
    return safeUser(await this.usersService.createUser(input));
  }
  async updateUser(userId: string, patch: UpdateUserInput): Promise<User> {
    return safeUser(await this.usersService.updateUser(userId, patch));
  }
  async deactivateUser(userId: string): Promise<User> {
    return safeUser(await this.usersService.deactivateUser(userId));
  }
  async getUser(userId: string): Promise<User | null> {
    const u = await this.usersService.getUser(userId);
    return u ? safeUser(u) : null;
  }
  async listUsers(operationId?: string | null): Promise<User[]> {
    return (await this.usersService.listUsers(operationId)).map(safeUser);
  }

  // ---- Autenticación real (email + contraseña -> JWT) -----------------------
  /** Login con email y contraseña. Devuelve el JWT firmado y el usuario (sin hash). */
  async loginWithPassword(email: string, password: string): Promise<{ authenticated: boolean; token?: string; user?: User }> {
    const user = await this.usersService.authenticateWithPassword(email, password);
    if (!user) return { authenticated: false };
    return { authenticated: true, token: signToken(user), user: safeUser(user) };
  }
  /** Fija/reemplaza la contraseña de un usuario (reset por admin o alta por invitación). */
  async setUserPassword(userId: string, password: string): Promise<User> {
    return safeUser(await this.usersService.setPassword(userId, password));
  }
  /** El propio usuario cambia su contraseña (verifica la actual). */
  async changePassword(userId: string, current: string, next: string): Promise<User> {
    return safeUser(await this.usersService.changePassword(userId, current, next));
  }
  /**
   * Resuelve la identidad a partir del token de la request.
   *  - Si es un JWT válido: usa su `sub` para cargar el usuario.
   *  - Si `allowDemo` (modo demo/dev): acepta el token como id/email del usuario.
   */
  async resolveToken(token: string, allowDemo: boolean): Promise<User | null> {
    if (looksLikeJwt(token)) {
      const payload = verifyToken(token);
      if (!payload) return null;
      const user = await this.usersService.getUser(payload.sub);
      return user && user.active ? user : null;
    }
    if (allowDemo) return this.usersService.authenticate(token);
    return null;
  }
  /** Compat: login skeleton por id/email (solo modo demo). */
  authenticate(token: string): Promise<User | null> {
    return this.usersService.authenticate(token);
  }

  // ---- Registro self-serve (PLG · Fase 0) ----------------------------------
  private appUrl(): string { return (process.env.APP_URL || '').replace(/\/$/, ''); }
  private newSecret(): string { return randomBytes(24).toString('hex'); }
  private nowIso(): string { return this.clock ? this.clock.now() : new Date().toISOString(); }
  private isProd(): boolean { return process.env.NODE_ENV === 'production'; }

  /**
   * Alta self-serve: crea la operación (tenant), su admin y —según la pista— un seller
   * por defecto; emite el token de verificación, envía el correo y devuelve un JWT para
   * aterrizar dentro del producto de inmediato. El email nace SIN verificar.
   */
  async registerSelfServe(input: { companyName: string; name: string; email: string; password: string; track: 'brand' | 'operator' }): Promise<{ token: string; user: User; operationId: string; sellerId: string | null; verification: { sent: boolean; devToken?: string } }> {
    const companyName = (input.companyName || '').trim();
    const name = (input.name || '').trim();
    const email = (input.email || '').trim().toLowerCase();
    const track: 'brand' | 'operator' = input.track === 'operator' ? 'operator' : 'brand';
    if (!companyName) throw new ValidationError('El nombre de la empresa es obligatorio');
    if (!name) throw new ValidationError('Tu nombre es obligatorio');
    if (!email.includes('@')) throw new ValidationError('Ingresa un email válido');
    if (!input.password || input.password.length < 6) throw new ValidationError('La contraseña debe tener al menos 6 caracteres');
    const existing = await this.usersService.findByEmail(email);
    if (existing) throw new ValidationError('Ya existe una cuenta con ese email. Inicia sesión o recupera tu contraseña.');
    // 1) Operación (tenant) con su pista de onboarding y reverse-trial:
    //    parte en Free, pero con 14 días de Growth para que el valor se sienta antes del paywall.
    const trialEndsAt = new Date(this.planNow() + 14 * 24 * 3600 * 1000).toISOString();
    const operation = await this.operationsService.create({
      name: companyName, track, selfServe: true,
      planId: 'free', trialPlan: 'growth', trialEndsAt,
    });
    // 2) Admin de la operación (email sin verificar todavía).
    const user = await this.usersService.createUser({
      name, email, role: UserRole.ADMIN, operationId: operation.id, password: input.password, emailVerified: false,
    });
    // 3) Marca -> un seller por defecto (ella misma). Operador 3PL -> sin sellers (invita clientes luego).
    let sellerId: string | null = null;
    if (track === 'brand') {
      const seller = await this.createSeller({ operationId: operation.id, name: companyName });
      sellerId = seller.id;
    }
    // 4) Verificación por correo.
    const verification = await this.issueVerification(user);
    // 5) Auto-login.
    return { token: signToken(user), user: safeUser(user), operationId: operation.id, sellerId, verification };
  }

  private async issueVerification(user: User): Promise<{ sent: boolean; devToken?: string }> {
    if (!this.authTokens) return { sent: false };
    const now = this.nowIso();
    await this.authTokens.invalidateForUser(user.id, 'verify', now);
    const token = this.newSecret();
    const expiresAt = new Date(Date.parse(now) + 3 * 24 * 3600 * 1000).toISOString(); // 3 días
    await this.authTokens.create({ id: this.ids.next(), userId: user.id, kind: 'verify', token, createdAt: now, expiresAt, usedAt: null });
    const link = `${this.appUrl()}/admin/?verify=${token}`;
    const sent = await this.sendMail(user.email, 'Verifica tu cuenta en Ninja WMS',
      `Hola ${user.name},\n\nConfirma tu email para activar tu cuenta de Ninja WMS:\n${link}\n\nEl enlace vence en 3 días. Si no creaste esta cuenta, ignora este correo.`);
    return { sent, devToken: this.isProd() ? undefined : token };
  }

  /** Canjea el token de verificación y marca el email como verificado. */
  async verifyEmail(token: string): Promise<{ ok: boolean; error?: string }> {
    const r = await this.consumeAuthToken(token, 'verify');
    if ('error' in r) return { ok: false, error: r.error };
    await this.usersService.setEmailVerified(r.token.userId, true);
    return { ok: true };
  }

  /** Reenvía la verificación. Respuesta genérica (no filtra existencia ni estado). */
  async resendVerification(email: string): Promise<{ ok: boolean; verification?: { sent: boolean; devToken?: string } }> {
    const user = await this.usersService.findByEmail((email || '').trim().toLowerCase());
    if (!user || user.emailVerified) return { ok: true };
    const verification = await this.issueVerification(user);
    return { ok: true, verification };
  }

  /** Solicita reset de contraseña. Respuesta genérica para no revelar si el email existe. */
  async requestPasswordReset(email: string): Promise<{ ok: boolean; devToken?: string }> {
    const user = await this.usersService.findByEmail((email || '').trim().toLowerCase());
    if (!user || !this.authTokens) return { ok: true };
    const now = this.nowIso();
    await this.authTokens.invalidateForUser(user.id, 'reset', now);
    const token = this.newSecret();
    const expiresAt = new Date(Date.parse(now) + 60 * 60 * 1000).toISOString(); // 1 hora
    await this.authTokens.create({ id: this.ids.next(), userId: user.id, kind: 'reset', token, createdAt: now, expiresAt, usedAt: null });
    const link = `${this.appUrl()}/admin/?reset=${token}`;
    await this.sendMail(user.email, 'Restablece tu contraseña · Ninja WMS',
      `Hola ${user.name},\n\nPara elegir una nueva contraseña entra aquí:\n${link}\n\nEl enlace vence en 1 hora. Si no lo pediste, ignora este correo.`);
    return { ok: true, devToken: this.isProd() ? undefined : token };
  }

  /** Canjea el token de reset y fija la nueva contraseña. */
  async resetPassword(token: string, newPassword: string): Promise<{ ok: boolean; error?: string }> {
    if (!newPassword || newPassword.length < 6) return { ok: false, error: 'La contraseña debe tener al menos 6 caracteres' };
    const r = await this.consumeAuthToken(token, 'reset');
    if ('error' in r) return { ok: false, error: r.error };
    await this.usersService.setPassword(r.token.userId, newPassword);
    return { ok: true };
  }

  /** Valida y consume (marca usado) un token de un solo uso; error legible si no procede. */
  private async consumeAuthToken(token: string, kind: AuthTokenKind): Promise<{ token: AuthToken } | { error: string }> {
    if (!this.authTokens) return { error: 'Servicio no disponible' };
    const t = await this.authTokens.findByToken((token || '').trim());
    if (!t || t.kind !== kind) return { error: 'El enlace no es válido.' };
    if (t.usedAt) return { error: 'Este enlace ya fue usado.' };
    if (Date.parse(t.expiresAt) < Date.parse(this.nowIso())) return { error: 'El enlace venció. Solicita uno nuevo.' };
    await this.authTokens.markUsed(t.id, this.nowIso());
    return { token: t };
  }

  private async sendMail(to: string, subject: string, text: string): Promise<boolean> {
    if (!this.emailSender) return false;
    try { const r = await this.emailSender.send({ to, subject, text }); return r.delivered; }
    catch { return false; }
  }

  /**
   * Verifica permiso + fronteras de operación y seller. Async porque puede resolver
   * la operación a partir del seller objetivo. Lanza ForbiddenError si no procede.
   */
  async authorize(
    user: User,
    permission: Permission,
    target: { sellerId?: string | null; operationId?: string | null } = {},
  ): Promise<void> {
    let operationId = target.operationId ?? null;
    if (operationId == null && target.sellerId) {
      const seller = await this.sellers.findById(target.sellerId);
      operationId = seller ? seller.operationId : null;
    }
    this.usersService.authorize(user, permission, { operationId, sellerId: target.sellerId ?? null });
  }

  // ---- Maestros -------------------------------------------------------------
  async createSeller(input: {
    id?: string;
    operationId: string;
    name: string;
    pickingStrategy?: PickingStrategy;
    cycleCountStrategy?: CycleCountStrategy;
    consolidateByLocation?: boolean;
    courierPriority?: string[];
    autoAllocateOnIngest?: boolean;
  }): Promise<Seller> {
    await this.operationsService.mustGet(input.operationId); // la operación debe existir y estar activa
    await this.assertQuota(input.operationId, 'sellers');
    const seller: Seller = {
      id: input.id ?? this.ids.next(),
      operationId: input.operationId,
      name: input.name,
      pickingStrategy: input.pickingStrategy ?? PickingStrategy.FIFO,
      cycleCountStrategy: input.cycleCountStrategy ?? CycleCountStrategy.ABC,
      consolidateByLocation: input.consolidateByLocation ?? false,
      courierPriority: input.courierPriority ?? [],
      autoAllocateOnIngest: input.autoAllocateOnIngest ?? false,
      active: true,
      // El acceso del cliente al panel de webhooks nace apagado; lo activa el admin.
      webhooksClientEnabled: false,
    };
    await this.sellers.save(seller);
    return seller;
  }

  /** Actualiza la política operativa del seller (estrategias de picking y conteo). */
  async updateSellerPolicy(
    sellerId: string,
    input: { pickingStrategy?: PickingStrategy; cycleCountStrategy?: CycleCountStrategy; consolidateByLocation?: boolean; courierPriority?: string[]; autoAllocateOnIngest?: boolean },
  ): Promise<Seller> {
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw new Error(`Seller no encontrado: ${sellerId}`);
    const updated: Seller = {
      ...seller,
      pickingStrategy: input.pickingStrategy ?? seller.pickingStrategy,
      cycleCountStrategy: input.cycleCountStrategy ?? seller.cycleCountStrategy,
      consolidateByLocation: input.consolidateByLocation ?? seller.consolidateByLocation,
      courierPriority: input.courierPriority ?? seller.courierPriority,
      autoAllocateOnIngest: input.autoAllocateOnIngest ?? seller.autoAllocateOnIngest,
    };
    await this.sellers.save(updated);
    return updated;
  }

  /**
   * Mantenedor de clientes: edita nombre, estrategias y estado del seller.
   * Respeta la frontera de operación (un ADMIN solo edita clientes de su operación).
   */
  async updateSeller(
    sellerId: string,
    input: { name?: string; pickingStrategy?: PickingStrategy; cycleCountStrategy?: CycleCountStrategy; consolidateByLocation?: boolean; courierPriority?: string[]; autoAllocateOnIngest?: boolean; active?: boolean },
    actor?: User | null,
  ): Promise<Seller> {
    const seller = await this.sellers.findById(sellerId);
    if (!seller) throw new NotFoundError(`Seller no encontrado: ${sellerId}`);
    if (actor && actor.operationId && actor.operationId !== seller.operationId) {
      throw new ForbiddenError('No puedes editar clientes de otra operación');
    }
    const updated: Seller = {
      ...seller,
      name: input.name != null && input.name.trim() ? input.name.trim() : seller.name,
      pickingStrategy: input.pickingStrategy ?? seller.pickingStrategy,
      cycleCountStrategy: input.cycleCountStrategy ?? seller.cycleCountStrategy,
      consolidateByLocation: input.consolidateByLocation ?? seller.consolidateByLocation,
      courierPriority: input.courierPriority ?? seller.courierPriority,
      autoAllocateOnIngest: input.autoAllocateOnIngest ?? seller.autoAllocateOnIngest,
      active: input.active != null ? input.active : seller.active,
    };
    await this.sellers.save(updated);
    return updated;
  }

  // ---- Conteo cíclico -------------------------------------------------------
  planCounts(sellerId: string): Promise<CycleCountTask[]> {
    return this.cycleCounts.planCounts(sellerId);
  }

  async performCount(
    sellerId: string,
    locationId: string,
    counted: CountLine[],
    actor = 'cyclecount',
  ): Promise<CountResult> {
    const opId = await this.operationOfSeller(sellerId).catch(() => null);
    await this.assertFeature(opId, 'cycle_count', 'El conteo cíclico');
    if (opId) await this.assertAssignmentAllowed(opId, 'COUNT', `${sellerId}:${locationId}`, actor);
    const res = await this.cycleCounts.performCount(sellerId, locationId, counted, actor);
    // Camino B: cierra la asignación de conteo por ubicación.
    if (opId) { await this.completeAssignments('COUNT', [`${sellerId}:${locationId}`], actor); await this.continuousHook(opId, 'COUNT', null); }
    return res;
  }

  /**
   * Exactitud de inventario (KPI) y su tendencia, a partir de los conteos registrados (G8).
   * accuracy = líneas exactas / líneas contadas, ponderado por conteo. Devuelve el valor
   * global de la ventana, la tendencia por conteo y los últimos conteos.
   */
  async getInventoryAccuracy(
    operationId: string,
    opts?: { sellerId?: string | null; limit?: number },
  ): Promise<{
    accuracyPct: number | null;
    countsConsidered: number;
    linesCounted: number;
    linesAccurate: number;
    trend: Array<{ at: string; accuracyPct: number; linesCounted: number; sellerId: string; locationId: string }>;
  }> {
    if (!this.countAudits) return { accuracyPct: null, countsConsidered: 0, linesCounted: 0, linesAccurate: 0, trend: [] };
    const limit = Math.max(1, Math.min(opts?.limit ?? 60, 500));
    const audits = await this.countAudits.list(operationId, { sellerId: opts?.sellerId ?? null, limit });
    let linesCounted = 0;
    let linesAccurate = 0;
    for (const a of audits) { linesCounted += a.linesCounted; linesAccurate += a.linesAccurate; }
    // Tendencia del más viejo al más nuevo (para dibujar de izquierda a derecha).
    const trend = audits
      .slice()
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      .map((a) => ({ at: a.at, accuracyPct: a.accuracyPct, linesCounted: a.linesCounted, sellerId: a.sellerId, locationId: a.locationId }));
    return {
      accuracyPct: linesCounted > 0 ? linesAccurate / linesCounted : null,
      countsConsidered: audits.length,
      linesCounted,
      linesAccurate,
      trend,
    };
  }

  // ---- Event store consultable (G2+G6) --------------------------------------

  /**
   * Línea de tiempo de una entidad: leída del event store (indexado por entidad),
   * con fallback al JSON append-only si el store no está disponible. Ordenada por `at`.
   */
  private async timelineOf(entityId: string, fallback?: OrderEvent[]): Promise<OrderEvent[]> {
    if (this.events) {
      const rows = await this.events.listByEntity(entityId);
      if (rows.length) {
        return rows
          .map((r) => ({ type: r.type, at: r.at, actor: r.actor, detail: r.detail }))
          .sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
      }
    }
    return (fallback || []).slice().sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
  }

  /**
   * Tiempos entre estados (transiciones consecutivas) de las órdenes de uno o más
   * sellers. Lee del event store con una sola consulta indexada (sin cargar las
   * órdenes completas); fallback al JSON si el store no está.
   */
  private async prepTimes(
    sellerIds: string[],
    limit: number,
  ): Promise<{ ordersAnalyzed: number; transitions: Record<string, { promedioHrs: number; muestras: number }> }> {
    const byOrder = new Map<string, OrderEvent[]>();
    if (this.events) {
      const rows = await this.events.query({ sellerIds, entityType: 'ORDER' });
      for (const r of rows) {
        const arr = byOrder.get(r.entityId) || [];
        arr.push({ type: r.type, at: r.at, actor: r.actor, detail: r.detail });
        byOrder.set(r.entityId, arr);
      }
    } else {
      for (const sid of sellerIds) {
        for (const o of await this.orders.listOrders(sid)) byOrder.set(o.id, (o.events || []).slice());
      }
    }
    const pares: Record<string, number[]> = {};
    let count = 0;
    for (const evsRaw of byOrder.values()) {
      if (count >= limit) break;
      const evs = evsRaw.slice().sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
      for (let i = 1; i < evs.length; i++) {
        const key = `${evs[i - 1].type}→${evs[i].type}`;
        const h = (Date.parse(evs[i].at) - Date.parse(evs[i - 1].at)) / 3600000;
        if (h >= 0 && h < 24 * 60) (pares[key] = pares[key] || []).push(h);
      }
      count++;
    }
    const transitions: Record<string, { promedioHrs: number; muestras: number }> = {};
    for (const k of Object.keys(pares)) {
      const arr = pares[k];
      transitions[k] = { promedioHrs: Math.round((arr.reduce((x, y) => x + y, 0) / arr.length) * 10) / 10, muestras: arr.length };
    }
    return { ordersAnalyzed: count, transitions };
  }

  /**
   * Línea de tiempo pública de una orden (para el dashboard/API): eventos + horas
   * entre estados. `entityId` es el id interno; devuelve null si no hay historial.
   */
  async getOrderTimeline(sellerId: string, orderRef: string): Promise<{
    orden: string; sellerId: string; estadoActual: string | null; lineaTiempo: Array<{ estado: string; fecha: string; hrsDesdeAnterior: number; detalle: string | null; actor: string }>; horasTotales: number;
  } | null> {
    const orders = await this.orders.listOrders(sellerId);
    const o = orders.find((x) => x.id === orderRef || x.externalOrderId === orderRef);
    if (!o) return null;
    const evs = await this.timelineOf(o.id, o.events);
    const lineaTiempo = evs.map((e, i) => ({
      estado: e.type,
      fecha: e.at,
      hrsDesdeAnterior: i > 0 ? Math.round(((Date.parse(e.at) - Date.parse(evs[i - 1].at)) / 3600000) * 10) / 10 : 0,
      detalle: e.detail ?? null,
      actor: e.actor,
    }));
    const horasTotales = evs.length > 1 ? Math.round(((Date.parse(evs[evs.length - 1].at) - Date.parse(evs[0].at)) / 3600000) * 10) / 10 : 0;
    return { orden: o.externalOrderId || o.id, sellerId, estadoActual: o.status, lineaTiempo, horasTotales };
  }

  /**
   * Verificación de paridad (criterio de aceptación G2): calcula las transiciones
   * entre estados de las órdenes de una operación por el camino VIEJO (JSON en la
   * orden) y por el NUEVO (event store), y confirma que coinciden.
   */
  async verifyEventParity(operationId: string): Promise<{
    ok: boolean; ordersJson: number; ordersTable: number; transitionsChecked: number; mismatches: string[];
  }> {
    const sellers = (await this.listSellers(operationId)).map((s) => s.id);
    const jsonPairs: Record<string, number> = {};
    let ordersJson = 0;
    for (const sid of sellers) {
      for (const o of await this.orders.listOrders(sid)) {
        const evs = (o.events || []).slice().sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
        for (let i = 1; i < evs.length; i++) { const k = `${evs[i - 1].type}→${evs[i].type}`; jsonPairs[k] = (jsonPairs[k] || 0) + 1; }
        ordersJson++;
      }
    }
    const tablePairs: Record<string, number> = {};
    let ordersTable = 0;
    if (this.events) {
      const rows = await this.events.query({ sellerIds: sellers, entityType: 'ORDER' });
      const byOrder = new Map<string, OrderEvent[]>();
      for (const r of rows) { const arr = byOrder.get(r.entityId) || []; arr.push({ type: r.type, at: r.at, actor: r.actor, detail: r.detail }); byOrder.set(r.entityId, arr); }
      for (const evsRaw of byOrder.values()) {
        const evs = evsRaw.slice().sort((x, y) => Date.parse(x.at) - Date.parse(y.at));
        for (let i = 1; i < evs.length; i++) { const k = `${evs[i - 1].type}→${evs[i].type}`; tablePairs[k] = (tablePairs[k] || 0) + 1; }
        ordersTable++;
      }
    }
    const keys = new Set([...Object.keys(jsonPairs), ...Object.keys(tablePairs)]);
    const mismatches: string[] = [];
    for (const k of keys) if ((jsonPairs[k] || 0) !== (tablePairs[k] || 0)) mismatches.push(`${k}: json=${jsonPairs[k] || 0} tabla=${tablePairs[k] || 0}`);
    return { ok: mismatches.length === 0, ordersJson, ordersTable, transitionsChecked: keys.size, mismatches };
  }

  /**
   * Backfill (G2): promueve al event store los historiales de las órdenes,
   * recepciones y devoluciones ya existentes. Idempotente — re-ejecutar no duplica.
   */
  async backfillEvents(operationId?: string): Promise<{ entities: number; events: number }> {
    if (!this.events) return { entities: 0, events: 0 };
    const ops = operationId ? [operationId] : (await this.listOperations()).map((o) => o.id);
    let entities = 0;
    let evCount = 0;
    for (const opId of ops) {
      for (const s of await this.listSellers(opId)) {
        for (const o of await this.orders.listOrders(s.id)) {
          const evs = toDomainEvents('ORDER', o.id, o.externalOrderId, s.id, o.events);
          if (evs.length) { await this.events.append(evs); entities++; evCount += evs.length; }
        }
        for (const r of await this.listReceipts(s.id)) {
          const evs = toDomainEvents('RECEIPT', r.id, r.reference ?? null, s.id, r.events);
          if (evs.length) { await this.events.append(evs); entities++; evCount += evs.length; }
        }
        for (const d of await this.listReturns(s.id)) {
          const evs = toDomainEvents('RETURN', d.id, d.originalOrderRef ?? null, s.id, d.events);
          if (evs.length) { await this.events.append(evs); entities++; evCount += evs.length; }
        }
      }
    }
    return { entities, events: evCount };
  }

  // ---- Rollups diarios (G3) -------------------------------------------------

  /** Corre el job de rollup para un día (o rango) de una operación. */
  async runRollups(operationId: string, opts?: { date?: string; fromDate?: string; toDate?: string }): Promise<{ days: number; sellers: number }> {
    if (!this.rollupService) return { days: 0, sellers: 0 };
    await this.assertFeature(operationId, 'advanced_analytics', 'La analítica avanzada');
    if (opts?.fromDate && opts?.toDate) return this.rollupService.runRange(opts.fromDate, opts.toDate, operationId);
    const date = opts?.date || new Date(this.clockNow()).toISOString().slice(0, 10);
    return this.rollupService.runDailyRollup(date, operationId);
  }

  /** Backfill de rollups desde el ledger (todo el historial). */
  async backfillRollups(operationId: string): Promise<{ days: number; sellers: number; from: string | null; to: string | null }> {
    if (!this.rollupService) return { days: 0, sellers: 0, from: null, to: null };
    return this.rollupService.backfill(operationId);
  }

  /**
   * Materialización inicial (G3+G4): backfill de rollups y derivación de LaborTasks
   * para todas las operaciones. Idempotente — pensado para correr al arrancar y tras
   * el seed. Best-effort: nunca bloquea el arranque.
   */
  async bootstrapAnalytics(): Promise<{ operations: number }> {
    if (!this.rollupService && !this.laborService) return { operations: 0 };
    const ops = await this.listOperations();
    // ¿Ya hay analítica materializada? Si no, backfill completo (una vez); si sí,
    // sólo refrescamos los últimos días para no re-escanear todo en cada arranque
    // (el cron diario mantiene el resto al día).
    let rollupsEmpty = true;
    let laborEmpty = true;
    try { rollupsEmpty = (await (this.rollupService as any)?.rollups?.countAll?.())?.metrics === 0; } catch { /* n/a */ }
    try { laborEmpty = ((await (this.laborService as any)?.laborTasks?.count?.()) ?? 0) === 0; } catch { /* n/a */ }
    const today = new Date(this.clockNow()).toISOString().slice(0, 10);
    const twoDaysAgo = new Date(Date.parse(`${today}T00:00:00.000Z`) - 2 * 86400000).toISOString().slice(0, 10);
    for (const op of ops) {
      try {
        if (rollupsEmpty) await this.backfillRollups(op.id);
        else await this.runRollups(op.id, { fromDate: twoDaysAgo, toDate: today });
      } catch { /* best-effort */ }
      try {
        if (laborEmpty) await this.deriveLaborFromLedger(op.id);
      } catch { /* best-effort */ }
      // G7: reclasifica ABC desde la velocidad real observada.
      try { await this.recomputeAbc(op.id); } catch { /* best-effort */ }
    }
    return { operations: ops.length };
  }

  /** Serie de demanda diaria por SKU — la consume el forecasting directamente. */
  async getDemandSeries(sellerId: string, opts?: { sku?: string | null; fromDate?: string; toDate?: string }) {
    if (!this.rollupService) return [];
    return this.rollupService.listDemand(sellerId, opts);
  }

  /** Posición de inventario diaria por SKU/estado (sin escanear el ledger). */
  async getInventorySnapshots(sellerId: string, opts?: { sku?: string | null; fromDate?: string; toDate?: string }) {
    if (!this.rollupService) return [];
    return this.rollupService.listInventorySnapshots(sellerId, opts);
  }

  // ---- Productividad de mano de obra (G4) -----------------------------------

  /** Deriva LaborTasks desde el ledger (movimientos PICK). */
  async deriveLaborFromLedger(operationId: string): Promise<{ derived: number }> {
    if (!this.laborService) return { derived: 0 };
    return this.laborService.deriveFromLedger(operationId);
  }

  /** Registra una tarea de trabajo capturada por la PWA (inicio/fin reales). */
  async captureLaborTask(input: { operationId: string; sellerId?: string | null; operator: string; type: LaborTaskType; startAt: string; endAt: string; units: number; orderRef?: string | null; locationId?: string | null }) {
    if (!this.laborService) throw new ValidationError('Módulo de productividad no disponible');
    return this.laborService.capture(input);
  }

  /** Reporte de productividad por operador (unidades/hora, por tipo de tarea). */
  async laborProductivity(operationId: string, opts?: { from?: string; to?: string; operator?: string | null }) {
    if (!this.laborService) return { window: { from: null, to: null }, operators: [] };
    return this.laborService.productivityByOperator(operationId, opts);
  }

  /** Serie diaria de mano de obra — input del forecast de personal. */
  async laborSeries(operationId: string, opts?: { from?: string; to?: string; operator?: string | null }) {
    if (!this.laborService) return [];
    return this.laborService.laborSeries(operationId, opts);
  }

  // ---- Persistencia + auditoría de IA (G5) ----------------------------------

  private aiId(prefix: string): string { return `${prefix}:${this.ids.next()}`; }

  /** Registra una recomendación de agente/IA. Best-effort (nunca rompe el flujo). */
  private async recordRecommendation(rec: Omit<AiRecommendation, 'id' | 'at'> & { id?: string; at?: string }): Promise<string | null> {
    if (!this.aiAudit) return null;
    const id = rec.id || this.aiId('rec');
    try {
      await this.aiAudit.saveRecommendation({ ...rec, id, at: rec.at || this.clockNow() } as AiRecommendation);
      return id;
    } catch { return null; }
  }

  /** Registra una acción ejecutada por un agente. Best-effort. */
  private async recordAgentAction(a: Omit<AgentAction, 'id' | 'at'> & { at?: string }): Promise<void> {
    if (!this.aiAudit) return;
    try { await this.aiAudit.saveAction({ ...a, id: this.aiId('act'), at: a.at || this.clockNow() } as AgentAction); } catch { /* best-effort */ }
  }

  /** Lista de acciones de agente (panel de auditoría). */
  async listAgentActions(operationId: string, opts?: { agent?: string | null; from?: string; to?: string; limit?: number }): Promise<AgentAction[]> {
    if (!this.aiAudit) return [];
    return this.aiAudit.listActions(operationId, opts);
  }

  /** Lista de recomendaciones de IA (panel de auditoría). */
  async listAiRecommendations(operationId: string, opts?: { type?: string | null; from?: string; to?: string; limit?: number }): Promise<AiRecommendation[]> {
    if (!this.aiAudit) return [];
    return this.aiAudit.listRecommendations(operationId, opts);
  }

  /**
   * Métricas de gobernanza de IA (G5): % de sugerencias aceptadas y su efecto,
   * más el conteo de acciones de agente por resultado.
   */
  async aiAuditSummary(operationId: string, opts?: { from?: string; to?: string }): Promise<{
    recommendations: { total: number; accepted: number; rejected: number; pending: number; acceptanceRate: number | null; byType: Array<{ type: string; total: number; accepted: number; acceptanceRate: number | null }> };
    actions: { total: number; ok: number; error: number; byAgent: Array<{ agent: string; total: number; ok: number }> };
  }> {
    if (!this.aiAudit) return { recommendations: { total: 0, accepted: 0, rejected: 0, pending: 0, acceptanceRate: null, byType: [] }, actions: { total: 0, ok: 0, error: 0, byAgent: [] } };
    const recs = await this.aiAudit.listRecommendations(operationId, { from: opts?.from, to: opts?.to, limit: 5000 });
    const acts = await this.aiAudit.listActions(operationId, { from: opts?.from, to: opts?.to, limit: 5000 });
    const accepted = recs.filter((r) => r.taken === true).length;
    const rejected = recs.filter((r) => r.taken === false).length;
    const pending = recs.filter((r) => r.taken == null).length;
    const decided = accepted + rejected;
    const byTypeMap = new Map<string, { total: number; accepted: number; decided: number }>();
    for (const r of recs) {
      const e = byTypeMap.get(r.type) || { total: 0, accepted: 0, decided: 0 };
      e.total += 1;
      if (r.taken === true) { e.accepted += 1; e.decided += 1; }
      else if (r.taken === false) e.decided += 1;
      byTypeMap.set(r.type, e);
    }
    const byType = [...byTypeMap.entries()].map(([type, e]) => ({ type, total: e.total, accepted: e.accepted, acceptanceRate: e.decided > 0 ? Math.round((e.accepted / e.decided) * 1000) / 10 : null }));
    const okCount = acts.filter((a) => a.result === 'ok' || a.result?.startsWith('ok')).length;
    const byAgentMap = new Map<string, { total: number; ok: number }>();
    for (const a of acts) { const e = byAgentMap.get(a.agent) || { total: 0, ok: 0 }; e.total += 1; if (a.result === 'ok' || a.result?.startsWith('ok')) e.ok += 1; byAgentMap.set(a.agent, e); }
    const byAgent = [...byAgentMap.entries()].map(([agent, e]) => ({ agent, total: e.total, ok: e.ok }));
    return {
      recommendations: { total: recs.length, accepted, rejected, pending, acceptanceRate: decided > 0 ? Math.round((accepted / decided) * 1000) / 10 : null, byType },
      actions: { total: acts.length, ok: okCount, error: acts.length - okCount, byAgent },
    };
  }

  // ---- Rotación ABC desde velocidad real (G7) -------------------------------

  /** Recalcula la clase ABC de cada SKU desde la velocidad real del ledger. */
  async recomputeAbc(operationId: string, opts?: { days?: number }): Promise<{ updated: number; considered: number; byClass: Record<string, number> }> {
    if (!this.abcService) return { updated: 0, considered: 0, byClass: {} };
    const res = await this.abcService.recompute(operationId, opts);
    await this.recordAgentAction({ operationId, sellerId: null, agent: 'abc_job', decision: `reclasificación ABC (${opts?.days ?? 90}d)`, actor: 'system', orderRef: null, result: `ok: ${res.updated} SKU reclasificados`, recommendationId: null });
    return res;
  }

  // ---- Actionables del copiloto (valor operativo/gerencial) -----------------

  /**
   * Riesgo de quiebre de stock: cruza la demanda diaria (rollups DailyDemand, o el
   * PICK del ledger como respaldo) con el disponible actual por SKU, calcula los días
   * de cobertura y sugiere una reposición. El insight de mayor retorno para gerencia.
   */
  async getStockoutRisk(
    operationId: string,
    opts?: { sellerId?: string | null; coverDays?: number; windowDays?: number; targetDays?: number; limit?: number },
  ): Promise<{ ventanaDias: number; umbralDias: number; objetivoDias: number; enRiesgo: number; items: Array<{ sellerId: string; sku: string; descripcion: string | null; disponible: number; demandaDiaria: number; diasCobertura: number; reposicionSugerida: number }> }> {
    const coverDays = opts?.coverDays ?? 7;
    const windowDays = Math.max(1, opts?.windowDays ?? 30);
    const targetDays = opts?.targetDays ?? 30;
    const limit = Math.min(opts?.limit ?? 50, 500);
    const sellers = opts?.sellerId ? [opts.sellerId] : (await this.listSellers(operationId)).map((s) => s.id);
    const nowMs = Date.parse(this.clockNow());
    const items: Array<{ sellerId: string; sku: string; descripcion: string | null; disponible: number; demandaDiaria: number; diasCobertura: number; reposicionSugerida: number }> = [];
    for (const sid of sellers) {
      // Demanda diaria por SKU en la ventana: preferir rollups, si no el PICK del ledger.
      const windowTotal = new Map<string, number>();
      let usedRollups = false;
      if (this.rollupService) {
        const fromDate = new Date(nowMs - windowDays * 86400000).toISOString().slice(0, 10);
        const dem = await this.rollupService.listDemand(sid, { fromDate });
        if (dem.length) { usedRollups = true; for (const d of dem) windowTotal.set(d.sku, (windowTotal.get(d.sku) || 0) + d.unitsShipped); }
      }
      if (!usedRollups) {
        const dem = await this.skuDemand(sid, nowMs - windowDays * 86400000);
        for (const sku of Object.keys(dem)) windowTotal.set(sku, dem[sku]);
      }
      // Disponible (estado AVAILABLE) por SKU.
      const avail = new Map<string, number>();
      for (const b of await this.inventory.getStock({ sellerId: sid })) {
        if (b.state === StockState.AVAILABLE && b.qty > 0) avail.set(b.sku, (avail.get(b.sku) || 0) + b.qty);
      }
      const nameOf = new Map((await this.skus.list(sid)).map((s) => [s.sku, s.description] as [string, string]));
      for (const [sku, total] of windowTotal) {
        const avgDaily = total / windowDays;
        if (avgDaily <= 0) continue;
        const disponible = avail.get(sku) || 0;
        const cover = disponible / avgDaily;
        if (cover >= coverDays) continue; // no está en riesgo
        items.push({
          sellerId: sid, sku, descripcion: nameOf.get(sku) ?? null,
          disponible, demandaDiaria: Math.round(avgDaily * 10) / 10, diasCobertura: Math.round(cover * 10) / 10,
          reposicionSugerida: Math.max(0, Math.ceil(avgDaily * targetDays - disponible)),
        });
      }
    }
    items.sort((a, b) => a.diasCobertura - b.diasCobertura);
    return { ventanaDias: windowDays, umbralDias: coverDays, objetivoDias: targetDays, enRiesgo: items.length, items: items.slice(0, limit) };
  }

  /**
   * Órdenes en riesgo / atascadas: órdenes no terminadas (no despachadas ni canceladas)
   * que llevan demasiado tiempo detenidas en su estado actual. Prioriza la intervención.
   */
  async getOrdersAtRisk(
    operationId: string,
    opts?: { sellerId?: string | null; maxHours?: number; limit?: number },
  ): Promise<{ umbralHoras: number; enRiesgo: number; porEstado: Record<string, number>; items: Array<{ orden: string; sellerId: string; estado: string; horasDetenida: number; creada: string; courier: string | null; unidades: number }> }> {
    const maxHours = opts?.maxHours ?? 24;
    const limit = Math.min(opts?.limit ?? 50, 500);
    const sellers = opts?.sellerId ? [opts.sellerId] : (await this.listSellers(operationId)).map((s) => s.id);
    const nowMs = Date.parse(this.clockNow());
    const TERMINAL = new Set(['SHIPPED', 'CANCELLED']);
    const items: Array<{ orden: string; sellerId: string; estado: string; horasDetenida: number; creada: string; courier: string | null; unidades: number }> = [];
    const porEstado: Record<string, number> = {};
    for (const sid of sellers) {
      for (const o of await this.orders.listOrders(sid)) {
        if (TERMINAL.has(o.status)) continue;
        const evs = o.events || [];
        const lastAt = evs.length ? evs[evs.length - 1].at : o.createdAt;
        const hrs = (nowMs - Date.parse(lastAt)) / 3600000;
        if (hrs < maxHours) continue;
        porEstado[o.status] = (porEstado[o.status] || 0) + 1;
        items.push({
          orden: o.externalOrderId || o.id, sellerId: sid, estado: o.status,
          horasDetenida: Math.round(hrs * 10) / 10, creada: o.createdAt, courier: o.carrier ?? null,
          unidades: (o.lines || []).reduce((s, l) => s + l.qty, 0),
        });
      }
    }
    items.sort((a, b) => b.horasDetenida - a.horasDetenida);
    return { umbralHoras: maxHours, enRiesgo: items.length, porEstado, items: items.slice(0, limit) };
  }

  /**
   * Vista consolidada de TODOS los clientes de una operación — una fila por cliente que
   * combina lo operativo (órdenes por estado, en riesgo, recepciones pendientes, quiebres,
   * stock) y lo comercial (facturación del mes). Pensada para que el administrador vea la
   * operación completa sin saltar de cliente en cliente.
   */
  async clientsOverview(operationId: string, opts?: { year?: number; month?: number }): Promise<{
    periodo: { year: number; month: number };
    clientes: Array<{
      sellerId: string; nombre: string;
      ordenesAbiertas: number; enProceso: number; porDespachar: number; enRiesgo: number;
      recepcionesPendientes: number; quiebres: number; stockOnHand: number;
      facturacionMes: number; currency: string;
    }>;
    totales: {
      clientes: number; ordenesAbiertas: number; enProceso: number; porDespachar: number; enRiesgo: number;
      recepcionesPendientes: number; quiebres: number; stockOnHand: number; facturacionMes: number; currency: string;
    };
  }> {
    const now = new Date(Date.parse(this.clockNow()));
    const year = opts?.year || now.getUTCFullYear();
    const month = opts?.month || (now.getUTCMonth() + 1);
    const nowMs = now.getTime();
    const RISK_H = 48; // órdenes abiertas detenidas > 2 días
    const TERMINAL = new Set(['SHIPPED', 'CANCELLED']);
    const sellers = await this.listSellers(operationId);

    // Quiebres por cliente: una sola pasada de riesgo de quiebre para toda la operación.
    const quiebresBy: Record<string, number> = {};
    try {
      const sr = await this.getStockoutRisk(operationId, { limit: 100000 });
      for (const it of sr.items) quiebresBy[it.sellerId] = (quiebresBy[it.sellerId] || 0) + 1;
    } catch { /* sin demanda aún */ }

    const clientes: any[] = [];
    for (const s of sellers) {
      const sid = s.id;
      const orders = await this.orders.listOrders(sid);
      let ordenesAbiertas = 0, enProceso = 0, porDespachar = 0, enRiesgo = 0;
      for (const o of orders) {
        if (TERMINAL.has(o.status)) continue;
        ordenesAbiertas++;
        if (o.status === 'ALLOCATED' || o.status === 'PICKING') enProceso++;
        if (o.status === 'PICKED' || o.status === 'PACKED') porDespachar++;
        const evs = o.events || [];
        const lastAt = evs.length ? evs[evs.length - 1].at : o.createdAt;
        if ((nowMs - Date.parse(lastAt)) / 3600000 >= RISK_H) enRiesgo++;
      }
      let recepcionesPendientes = 0;
      try { for (const r of await this.listReceipts(sid)) if (r.status === 'PENDING' || r.status === 'PARTIAL') recepcionesPendientes++; } catch { /* */ }
      let stockOnHand = 0;
      try { for (const b of await this.inventory.getStock({ sellerId: sid })) stockOnHand += Math.max(0, b.qty); } catch { /* */ }
      let facturacionMes = 0, currency = 'CLP';
      try { const inv = await this.previewInvoice(sid, year, month); facturacionMes = (inv.lines || []).reduce((a: number, l: any) => a + (l.amount || 0), 0); currency = inv.currency || currency; } catch { /* sin tarifario */ }
      clientes.push({ sellerId: sid, nombre: s.name, ordenesAbiertas, enProceso, porDespachar, enRiesgo, recepcionesPendientes, quiebres: quiebresBy[sid] || 0, stockOnHand, facturacionMes, currency });
    }
    // Los que más requieren atención primero (riesgo, luego facturación).
    clientes.sort((a, b) => (b.enRiesgo - a.enRiesgo) || (b.facturacionMes - a.facturacionMes));
    const sum = (f: (c: any) => number) => clientes.reduce((s, c) => s + f(c), 0);
    const currency = clientes[0]?.currency || 'CLP';
    return {
      periodo: { year, month },
      clientes,
      totales: {
        clientes: clientes.length,
        ordenesAbiertas: sum((c) => c.ordenesAbiertas), enProceso: sum((c) => c.enProceso), porDespachar: sum((c) => c.porDespachar), enRiesgo: sum((c) => c.enRiesgo),
        recepcionesPendientes: sum((c) => c.recepcionesPendientes), quiebres: sum((c) => c.quiebres), stockOnHand: sum((c) => c.stockOnHand),
        facturacionMes: sum((c) => c.facturacionMes), currency,
      },
    };
  }

  /**
   * Brief ejecutivo: resumen de una operación para la plana gerencial — throughput y
   * su variación, exactitud de inventario, top operarios, quiebres inminentes y
   * órdenes en riesgo. Todo derivado de la data que ya vive en el sistema.
   */
  async getExecutiveBrief(operationId: string, opts?: { sellerId?: string | null }): Promise<any> {
    const sellers = opts?.sellerId ? [opts.sellerId] : (await this.listSellers(operationId)).map((s) => s.id);
    const nowMs = Date.parse(this.clockNow());
    const agg = { p7: { cur: 0, prev: 0 }, u7: { cur: 0, prev: 0 }, p30: { cur: 0, prev: 0 }, u30: { cur: 0, prev: 0 }, mov30: { cur: 0, prev: 0 } };
    for (const sid of sellers) {
      const m = await this.metrics.forSeller(sid);
      const w7 = m.windows.find((w) => w.window === '7d');
      const w30 = m.windows.find((w) => w.window === '30d');
      if (w7) { agg.p7.cur += w7.ordersPrepared.current; agg.p7.prev += w7.ordersPrepared.previous; agg.u7.cur += w7.unitsPrepared.current; agg.u7.prev += w7.unitsPrepared.previous; }
      if (w30) { agg.p30.cur += w30.ordersPrepared.current; agg.p30.prev += w30.ordersPrepared.previous; agg.u30.cur += w30.unitsPrepared.current; agg.u30.prev += w30.unitsPrepared.previous; agg.mov30.cur += w30.movements.current; agg.mov30.prev += w30.movements.previous; }
    }
    const pct = (cur: number, prev: number) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);
    const acc = await this.getInventoryAccuracy(operationId);
    const prod = await this.laborProductivity(operationId);
    const stockout = await this.getStockoutRisk(operationId, { limit: 5 });
    const atRisk = await this.getOrdersAtRisk(operationId, { limit: 5 });
    return {
      generadoEl: new Date(nowMs).toISOString(),
      throughput: {
        ordenesPreparadas7d: { actual: agg.p7.cur, anterior: agg.p7.prev, variacionPct: pct(agg.p7.cur, agg.p7.prev) },
        unidadesPreparadas7d: { actual: agg.u7.cur, anterior: agg.u7.prev, variacionPct: pct(agg.u7.cur, agg.u7.prev) },
        ordenesPreparadas30d: { actual: agg.p30.cur, anterior: agg.p30.prev, variacionPct: pct(agg.p30.cur, agg.p30.prev) },
        movimientos30d: { actual: agg.mov30.cur, anterior: agg.mov30.prev, variacionPct: pct(agg.mov30.cur, agg.mov30.prev) },
      },
      exactitudInventario: acc.accuracyPct != null ? Math.round(acc.accuracyPct * 1000) / 10 : null,
      productividadTop: (prod.operators || []).slice(0, 5).map((o: any) => ({ operario: o.operator, unidades: o.units, unidadesPorHora: o.unitsPerHour })),
      quiebresInminentes: stockout.enRiesgo,
      quiebresTop: stockout.items,
      ordenesEnRiesgo: atRisk.enRiesgo,
      ordenesEnRiesgoPorEstado: atRisk.porEstado,
      ordenesEnRiesgoTop: atRisk.items,
    };
  }

  // ---- Asignación de tareas / balanceo de carga (Camino B) ------------------

  /** Modo de asignación de la operación: 'advisory' (def) o 'strict'. */
  async getAssignmentMode(operationId: string): Promise<'advisory' | 'strict'> {
    const op = await this.operationsService.get(operationId);
    return op?.assignmentMode === 'strict' ? 'strict' : 'advisory';
  }
  async setAssignmentMode(operationId: string, mode: 'advisory' | 'strict'): Promise<{ assignmentMode: 'advisory' | 'strict' }> {
    await this.operationsService.setAssignmentMode(operationId, mode);
    return { assignmentMode: mode };
  }

  /** Roster de operarios de la operación con su velocidad real (u/h) para balancear. */
  private async operatorRoster(operationId: string): Promise<Array<{ id: string; name: string; speed: number }>> {
    const users = (await this.listUsers(operationId)).filter((u) => String(u.role) === 'OPERATOR' && u.active !== false);
    let speedOf = new Map<string, number>();
    try {
      const prod = await this.laborProductivity(operationId);
      for (const o of prod.operators || []) if (o.unitsPerHour) speedOf.set(o.operator, o.unitsPerHour);
    } catch { /* sin productividad aún */ }
    const DEFAULT_SPEED = 50;
    return users.map((u) => ({ id: u.id, name: u.name, speed: speedOf.get(u.id) || DEFAULT_SPEED }));
  }

  /** Pool de tareas pendientes de un tipo, con su estimación de unidades y asignatario actual. */
  async getTaskPool(operationId: string, type: WorkTaskType, opts?: { onlyUnassigned?: boolean; limit?: number }): Promise<Array<{ type: WorkTaskType; entityId: string; entityRef: string; sellerId: string; unidades: number; prioridad: number; asignadoA: string | null; note?: string | null }>> {
    const sellers = (await this.listSellers(operationId)).map((s) => s.id);
    const assigneeOf = new Map<string, string>();
    if (this.assignments) for (const a of await this.assignments.listOpen(operationId, { type })) assigneeOf.set(a.entityId, a.operator);
    const out: Array<{ type: WorkTaskType; entityId: string; entityRef: string; sellerId: string; unidades: number; prioridad: number; asignadoA: string | null; note?: string | null }> = [];
    if (type === 'PICK') {
      for (const sid of sellers) {
        for (const o of await this.getPickingQueue(sid)) {
          const entityId = o.id;
          out.push({ type, entityId, entityRef: o.externalOrderId || o.id, sellerId: sid, unidades: (o.lines || []).reduce((s, l) => s + l.qty, 0), prioridad: o.queuePosition, asignadoA: assigneeOf.get(entityId) ?? null });
        }
      }
    } else if (type === 'PUTAWAY') {
      const locs = await this.locations.listByOperation(operationId);
      const recv = new Map(locs.filter((l) => l.zoneType === ZoneType.RECEIVING).map((l) => [l.id, l.code] as [string, string]));
      for (const sid of sellers) {
        const bal = await this.inventory.getStock({ sellerId: sid });
        const byKey = new Map<string, { sku: string; loc: string; qty: number }>();
        for (const b of bal) {
          if (!recv.has(b.locationId) || b.qty <= 0 || b.state !== StockState.AVAILABLE) continue;
          const k = `${b.sku}:${b.locationId}`;
          const e = byKey.get(k) || { sku: b.sku, loc: b.locationId, qty: 0 };
          e.qty += b.qty; byKey.set(k, e);
        }
        let pr = 1;
        for (const e of byKey.values()) {
          const entityId = `${sid}:${e.sku}:${e.loc}`;
          out.push({ type, entityId, entityRef: `${e.sku} @ ${recv.get(e.loc)}`, sellerId: sid, unidades: e.qty, prioridad: pr++, asignadoA: assigneeOf.get(entityId) ?? null });
        }
      }
    } else if (type === 'COUNT') {
      for (const sid of sellers) {
        const tasks = await this.planCounts(sid);
        for (const t of tasks) {
          const entityId = `${sid}:${t.ref}`;
          let unidades = 10;
          try {
            const q = t.kind === 'LOCATION' ? { sellerId: sid, locationId: t.ref } : { sellerId: sid, sku: t.ref };
            unidades = (await this.inventory.getStock(q)).reduce((s, b) => s + Math.max(0, b.qty), 0) || 10;
          } catch { /* estimación nominal */ }
          out.push({ type, entityId, entityRef: t.label, sellerId: sid, unidades, prioridad: t.priority, asignadoA: assigneeOf.get(entityId) ?? null });
        }
      }
    } else if (type === 'RECEIVE') {
      // Recepciones pendientes/parciales (inbound) por cotejar.
      for (const sid of sellers) {
        for (const r of await this.listReceipts(sid)) {
          if (r.status !== 'PENDING' && r.status !== 'PARTIAL') continue;
          const pend = (r.lines || []).reduce((s, l) => s + Math.max(0, l.expectedQty - (l.receivedQty || 0)), 0);
          const entityId = r.id;
          out.push({ type, entityId, entityRef: r.reference || r.id, sellerId: sid, unidades: pend, prioridad: r.status === 'PARTIAL' ? 1 : 2, asignadoA: assigneeOf.get(entityId) ?? null });
        }
      }
    } else if (type === 'RESLOT') {
      // Re-slotting dinámico (G7): stock clase A que rota mucho pero está LEJOS del
      // despacho → moverlo a la ubicación de almacenaje más cercana. La cercanía usa la
      // distancia real (geometría) si hay coordenadas, si no el pickRank.
      const locs = await this.locations.listByOperation(operationId);
      const codeOf = new Map(locs.map((l) => [l.id, l.code] as [string, string]));
      const storage = locs.filter((l) => l.zoneType === ZoneType.STORAGE && l.active);
      const dispatch = locs.filter((l) => (l.zoneType === ZoneType.PICKING || l.zoneType === ZoneType.SHIPPING) && l.x != null && l.y != null);
      const proximity = (l: typeof storage[number]): number => {
        if (l.x != null && l.y != null && dispatch.length) {
          let best = Infinity;
          for (const d of dispatch) { const dx = l.x - (d.x as number), dy = l.y - (d.y as number); best = Math.min(best, Math.sqrt(dx * dx + dy * dy)); }
          return best;
        }
        return l.pickRank; // sin geometría: cercanía estática
      };
      const proxOf = new Map(storage.map((l) => [l.id, proximity(l)] as [string, number]));
      const storageIds = new Set(storage.map((l) => l.id));
      // Ubicación de almacenaje más cercana al despacho (destino de re-slot para clase A).
      const nearest = storage.slice().sort((a, b) => (proxOf.get(a.id)! - proxOf.get(b.id)!))[0];
      let count = 0;
      for (const sid of sellers) {
        if (count >= 50 || !nearest) break;
        const classOf = new Map((await this.skus.list(sid)).map((s) => [s.sku, s.rotationClass] as [string, string]));
        const buckets = new Map<string, { sku: string; loc: string; qty: number }>();
        for (const b of await this.inventory.getStock({ sellerId: sid })) {
          if (!storageIds.has(b.locationId) || b.qty <= 0 || b.state !== StockState.AVAILABLE) continue;
          const k = `${b.sku}:${b.locationId}`;
          const e = buckets.get(k) || { sku: b.sku, loc: b.locationId, qty: 0 };
          e.qty += b.qty; buckets.set(k, e);
        }
        for (const e of buckets.values()) {
          if (count >= 50) break;
          if (classOf.get(e.sku) !== RotationClass.A) continue; // foco clase A (alta rotación)
          // Existe una ubicación estrictamente más cercana que la actual → re-slot.
          const target = storage.filter((l) => proxOf.get(l.id)! < proxOf.get(e.loc)!).sort((a, b) => proxOf.get(a.id)! - proxOf.get(b.id)!)[0];
          if (!target) continue; // ya está en (una de) las más cercanas
          count++;
          const entityId = `${sid}:${e.sku}:${e.loc}`;
          out.push({ type, entityId, entityRef: `${e.sku}: ${codeOf.get(e.loc)} → ${target.code}`, sellerId: sid, unidades: e.qty, prioridad: 1, asignadoA: assigneeOf.get(entityId) ?? null, note: target.id });
        }
      }
    } else if (type === 'PACK') {
      // Órdenes recolectadas (PICKED) listas para EMPACAR.
      for (const sid of sellers) {
        for (const o of await this.orders.listOrders(sid)) {
          if (o.status !== 'PICKED') continue;
          out.push({ type, entityId: o.id, entityRef: o.externalOrderId || o.id, sellerId: sid, unidades: (o.lines || []).reduce((s, l) => s + l.qty, 0), prioridad: Date.parse(o.createdAt) || 1, asignadoA: assigneeOf.get(o.id) ?? null });
        }
      }
    } else if (type === 'SHIP') {
      // Órdenes empacadas (PACKED) listas para DESPACHAR.
      for (const sid of sellers) {
        for (const o of await this.orders.listOrders(sid)) {
          if (o.status !== 'PACKED') continue;
          out.push({ type, entityId: o.id, entityRef: o.externalOrderId || o.id, sellerId: sid, unidades: (o.lines || []).reduce((s, l) => s + l.qty, 0), prioridad: Date.parse(o.createdAt) || 1, asignadoA: assigneeOf.get(o.id) ?? null });
        }
      }
    }
    let filtered = opts?.onlyUnassigned ? out.filter((t) => !t.asignadoA) : out;
    filtered = filtered.sort((a, b) => a.prioridad - b.prioridad);
    return opts?.limit ? filtered.slice(0, opts.limit) : filtered;
  }

  /** Asigna (o reasigna) una tarea a un operario. Idempotente por (type:entityId). */
  async assignTask(operationId: string, input: { type: WorkTaskType; entityId: string; entityRef?: string | null; sellerId?: string | null; operator: string; unitsEstimate?: number; by: string; note?: string | null; skipOperatorCheck?: boolean }): Promise<WorkAssignment> {
    if (!this.assignments) throw new ValidationError('Módulo de asignación no disponible');
    await this.assertFeature(operationId, 'task_assignment', 'La asignación de tareas');
    // Solo se asigna a un operario ACTIVO de la operación. El auto-balanceo ya parte del
    // roster activo, así que puede omitir esta verificación (skipOperatorCheck).
    if (!input.skipOperatorCheck) {
      const u = (await this.listUsers(operationId)).find((x) => x.id === input.operator);
      if (!u) throw new ValidationError(`Operario no encontrado en la operación: ${input.operator}`);
      if (String(u.role) === 'CLIENT') throw new ValidationError(`${u.name} es un usuario cliente; no puede recibir tareas de bodega.`);
      if (u.active === false) throw new ValidationError(`El operario ${u.name} está inactivo; no se le pueden asignar tareas.`);
    }
    const id = `${input.type}:${input.entityId}`;
    const a: WorkAssignment = {
      id, operationId, sellerId: input.sellerId ?? null, type: input.type, entityId: input.entityId,
      entityRef: input.entityRef ?? null, operator: input.operator, status: 'assigned',
      unitsEstimate: Math.max(0, Math.round(input.unitsEstimate || 0)), assignedBy: input.by,
      assignedAt: this.clockNow(), completedAt: null, completedBy: null, note: input.note ?? null,
    };
    await this.assignments.save(a);
    this.prioritiesAt.delete(operationId); // la bandeja se reordena en la próxima lectura
    // Ledger: vincula la asignación con la tarea abierta de esa etapa; si no existe
    // (ej. PUTAWAY/COUNT/RESLOT sin tarea pre-creada), la crea en estado 'assigned'.
    if (this.taskLedger) {
      const stage = input.type as WorkTaskStage;
      const existing = await this.taskLedger.findOpen(operationId, stage, input.entityId).catch(() => null);
      if (existing) {
        await this.advanceTask(operationId, stage, input.entityId, { state: 'assigned', assignmentId: id, operator: input.operator, by: input.by });
      } else {
        const orderId = (stage === 'PICK' || stage === 'PACK' || stage === 'SHIP') ? input.entityId : null;
        const t = await this.openTask(operationId, { type: stage, sellerId: input.sellerId ?? null, orderId, orderRef: orderId ? (input.entityRef ?? null) : null, entityId: input.entityId, entityRef: input.entityRef ?? null, unitsEstimate: input.unitsEstimate, by: input.by, state: 'assigned', note: input.note ?? null });
        if (t) await this.taskLedger.update({ ...t, assignmentId: id, operator: input.operator });
      }
    }
    return a;
  }

  /** Libera una asignación (vuelve al pool sin asignatario). */
  async releaseAssignment(operationId: string, entityId: string, type: WorkTaskType, by: string): Promise<{ ok: boolean }> {
    if (!this.assignments) return { ok: false };
    const a = await this.assignments.get(`${type}:${entityId}`);
    if (!a || a.operationId !== operationId) return { ok: false };
    await this.assignments.save({ ...a, status: 'released', completedBy: by, completedAt: this.clockNow() });
    return { ok: true };
  }

  /** Asignación masiva. */
  async bulkAssign(operationId: string, items: Array<{ type: WorkTaskType; entityId: string; entityRef?: string | null; sellerId?: string | null; unitsEstimate?: number; operator: string }>, by: string): Promise<{ asignadas: number }> {
    let n = 0;
    for (const it of items) { await this.assignTask(operationId, { ...it, by }); n++; }
    return { asignadas: n };
  }

  /**
   * Auto-balanceo: reparte las tareas pendientes (sin asignar) de un tipo entre los
   * operarios, minimizando el TIEMPO proyectado de término de cada uno (usa la
   * velocidad real u/h). Devuelve el plan; si execute=true además lo persiste.
   */
  async autoBalance(operationId: string, opts?: { type?: WorkTaskType; execute?: boolean; by?: string; limit?: number }): Promise<{ tipo: WorkTaskType; asignadas: number; ejecutado: boolean; plan: Array<{ entityId: string; entityRef: string; operario: string; unidades: number }>; porOperario: Array<{ operario: string; tareas: number; unidades: number; horasEstimadas: number }> }> {
    const type = opts?.type || 'PICK';
    const by = opts?.by || 'system';
    const pool = await this.getTaskPool(operationId, type, { onlyUnassigned: true, limit: opts?.limit });
    const roster = await this.operatorRoster(operationId);
    if (!roster.length) return { tipo: type, asignadas: 0, ejecutado: false, plan: [], porOperario: [] };
    // Carga actual (horas) por operario a partir de sus asignaciones abiertas.
    const load = new Map<string, { units: number; hours: number }>();
    for (const op of roster) load.set(op.id, { units: 0, hours: 0 });
    if (this.assignments) {
      for (const a of await this.assignments.listOpen(operationId)) {
        const op = roster.find((r) => r.id === a.operator);
        if (op) { const l = load.get(op.id)!; l.units += a.unitsEstimate; l.hours += a.unitsEstimate / op.speed; }
      }
    }
    const plan: Array<{ entityId: string; entityRef: string; operario: string; unidades: number; type: WorkTaskType; sellerId: string }> = [];
    for (const task of pool) {
      // Operario con menor tiempo proyectado tras tomar esta tarea.
      let best = roster[0];
      let bestProj = Infinity;
      for (const op of roster) {
        const proj = load.get(op.id)!.hours + task.unidades / op.speed;
        if (proj < bestProj) { bestProj = proj; best = op; }
      }
      const l = load.get(best.id)!; l.units += task.unidades; l.hours += task.unidades / best.speed;
      plan.push({ entityId: task.entityId, entityRef: task.entityRef, operario: best.id, unidades: task.unidades, type, sellerId: task.sellerId });
    }
    if (opts?.execute && this.assignments) {
      for (const p of plan) await this.assignTask(operationId, { type: p.type, entityId: p.entityId, entityRef: p.entityRef, sellerId: p.sellerId, operator: p.operario, unitsEstimate: p.unidades, by, skipOperatorCheck: true });
    }
    const porOperario = roster.map((op) => { const l = load.get(op.id)!; return { operario: op.id, tareas: plan.filter((p) => p.operario === op.id).length, unidades: l.units, horasEstimadas: Math.round(l.hours * 10) / 10 }; }).filter((r) => r.tareas > 0 || r.unidades > 0);
    return { tipo: type, asignadas: plan.length, ejecutado: !!opts?.execute, plan: plan.map((p) => ({ entityId: p.entityId, entityRef: p.entityRef, operario: p.operario, unidades: p.unidades })), porOperario };
  }

  /** Carga de trabajo por operario (para el panel del supervisor y el copiloto). */
  async operatorLoad(operationId: string): Promise<{ operarios: Array<{ operario: string; nombre: string; velocidadUH: number; tareasAbiertas: number; unidades: number; horasEstimadas: number | null; porTipo: Record<string, number> }>; pendientesSinAsignar: Record<string, number> }> {
    const roster = await this.operatorRoster(operationId);
    const open = this.assignments ? await this.assignments.listOpen(operationId) : [];
    const byOp = new Map<string, WorkAssignment[]>();
    for (const a of open) { const arr = byOp.get(a.operator) || []; arr.push(a); byOp.set(a.operator, arr); }
    const operarios = roster.map((op) => {
      const list = byOp.get(op.id) || [];
      const unidades = list.reduce((s, a) => s + a.unitsEstimate, 0);
      const porTipo: Record<string, number> = {};
      for (const a of list) porTipo[a.type] = (porTipo[a.type] || 0) + 1;
      return { operario: op.id, nombre: op.name, velocidadUH: op.speed, tareasAbiertas: list.length, unidades, horasEstimadas: op.speed > 0 ? Math.round((unidades / op.speed) * 10) / 10 : null, porTipo };
    }).sort((a, b) => (b.horasEstimadas || 0) - (a.horasEstimadas || 0));
    const pendientesSinAsignar: Record<string, number> = {};
    for (const t of ['PICK', 'PUTAWAY', 'PACK', 'SHIP', 'COUNT', 'RECEIVE', 'RESLOT'] as WorkTaskType[]) pendientesSinAsignar[t] = (await this.getTaskPool(operationId, t, { onlyUnassigned: true })).length;
    return { operarios, pendientesSinAsignar };
  }

  /**
   * Directorio de operarios con su DISPONIBILIDAD: si están activos o inactivos, su
   * última conexión (presencia) y cuántas tareas abiertas tienen. Insumo para decidir a
   * quién asignar. Incluye a los INACTIVOS (marcados) para que la IA vea el panorama completo.
   */
  async operatorsDirectory(operationId: string): Promise<{ operarios: Array<{ id: string; nombre: string; activo: boolean; ultimaConexion: string | null; tareasAbiertas: number }>; activos: number; inactivos: number }> {
    const users = (await this.listUsers(operationId)).filter((u) => String(u.role) === 'OPERATOR');
    const lastLogin = await this.platformUsageService.lastLoginByOperation(operationId).catch(() => ({} as Record<string, string>));
    const open = this.assignments ? await this.assignments.listOpen(operationId) : [];
    const openByOp = new Map<string, number>();
    for (const a of open) openByOp.set(a.operator, (openByOp.get(a.operator) || 0) + 1);
    const operarios = users
      .map((u) => ({ id: u.id, nombre: u.name, activo: u.active !== false, ultimaConexion: lastLogin[u.id] ?? null, tareasAbiertas: openByOp.get(u.id) || 0 }))
      .sort((a, b) => (a.activo === b.activo ? a.nombre.localeCompare(b.nombre) : (a.activo ? -1 : 1)));
    return { operarios, activos: operarios.filter((o) => o.activo).length, inactivos: operarios.filter((o) => !o.activo).length };
  }

  // ---- Agente proactivo (Nivel 3, Fase 1: reglas + barrido + alertas in-app) -----

  /** Config efectiva de una regla: la guardada, o los valores por defecto de su definición. */
  private async agentRuleEffective(operationId: string, def: AgentRuleDef): Promise<AgentRuleConfig> {
    const stored = this.agentRuleConfig ? await this.agentRuleConfig.get(operationId, def.key).catch(() => null) : null;
    return stored ?? {
      operationId, ruleKey: def.key, enabled: true, threshold: def.defaultThreshold,
      cooldownMin: def.defaultCooldownMin, severity: def.defaultSeverity, sellerId: null,
      actionType: 'alert', actionMode: 'confirmar',
      updatedAt: this.clockNow(), updatedBy: null,
    };
  }

  /** Catálogo de reglas del agente con su configuración efectiva (para el panel). */
  async agentRules(operationId: string): Promise<Array<AgentRuleConfig & { name: string; description: string; unit: string; autoAction: { tool: string; label: string } | null }>> {
    const out: Array<AgentRuleConfig & { name: string; description: string; unit: string; autoAction: { tool: string; label: string } | null }> = [];
    for (const def of AGENT_RULES) {
      const cfg = await this.agentRuleEffective(operationId, def);
      out.push({ ...cfg, name: def.name, description: def.description, unit: def.unit, autoAction: def.autoAction ?? null });
    }
    return out;
  }

  /** Actualiza la configuración de una regla (encendido, umbral, enfriamiento, severidad, alcance, acción). */
  async updateAgentRule(operationId: string, ruleKey: string, patch: { enabled?: boolean; threshold?: number; cooldownMin?: number; severity?: AgentRuleSeverity; sellerId?: string | null; actionType?: 'alert' | 'execute'; actionMode?: 'confirmar' | 'directo' }, actor?: string): Promise<AgentRuleConfig> {
    if (!this.agentRuleConfig) throw new ValidationError('Agente no disponible');
    const def = agentRuleDef(ruleKey);
    if (!def) throw new NotFoundError(`Regla no encontrada: ${ruleKey}`);
    // Solo se puede poner en 'execute' una regla que tiene una acción automática definida.
    if (patch.actionType === 'execute' && !def.autoAction) throw new ValidationError(`La regla "${def.name}" no tiene una acción automática; solo puede avisar.`);
    const cur = await this.agentRuleEffective(operationId, def);
    const next: AgentRuleConfig = {
      ...cur,
      enabled: patch.enabled != null ? patch.enabled : cur.enabled,
      threshold: patch.threshold != null && patch.threshold >= 0 ? Math.round(patch.threshold) : cur.threshold,
      cooldownMin: patch.cooldownMin != null && patch.cooldownMin >= 0 ? Math.round(patch.cooldownMin) : cur.cooldownMin,
      severity: patch.severity ?? cur.severity,
      sellerId: patch.sellerId !== undefined ? patch.sellerId : cur.sellerId,
      actionType: patch.actionType ?? cur.actionType,
      actionMode: patch.actionMode ?? cur.actionMode,
      updatedAt: this.clockNow(), updatedBy: actor ?? null,
    };
    await this.agentRuleConfig.save(next);
    return next;
  }

  /** Ejecuta una herramienta de acción del agente (reversible + auditada). Devuelve el resultado legible. */
  private async runAgentTool(operationId: string, tool: string, actor: string): Promise<string> {
    if (tool === 'balancear_carga') {
      const r = await this.autoBalance(operationId, { type: 'PICK', execute: true, by: actor });
      return `${r.asignadas} tarea(s) de picking repartida(s)`;
    }
    if (tool === 'liberar_inactivos') {
      // Libera las tareas abiertas de los operarios INACTIVOS y las redistribuye entre los activos.
      const dir = await this.operatorsDirectory(operationId);
      const off = dir.operarios.filter((o) => !o.activo && o.tareasAbiertas > 0);
      let released = 0; const types = new Set<WorkTaskType>();
      if (this.assignments) {
        for (const o of off) {
          for (const a of await this.assignments.listByOperator(operationId, o.id)) {
            await this.releaseAssignment(operationId, a.entityId, a.type, actor);
            released++; types.add(a.type);
          }
        }
      }
      let reassigned = 0;
      for (const t of types) { const r = await this.autoBalance(operationId, { type: t, execute: true, by: actor }); reassigned += r.asignadas; }
      return `${released} tarea(s) liberada(s) de operarios inactivos, ${reassigned} reasignada(s) a operarios activos`;
    }
    throw new ValidationError(`Acción no reconocida: ${tool}`);
  }

  /** Ejecuta la acción propuesta de una alerta (botón "Confirmar y ejecutar"). */
  async executeAgentAlertAction(operationId: string, id: string, actor?: string): Promise<{ ok: boolean; result?: string; error?: string }> {
    if (!this.agentAlertRepo) return { ok: false, error: 'Agente no disponible' };
    const a = await this.agentAlertRepo.get(id);
    if (!a || a.operationId !== operationId) return { ok: false, error: 'Alerta no encontrada' };
    if (!a.actionTool || (a.actionStatus !== 'proposed' && a.actionStatus !== 'error')) return { ok: false, error: 'La alerta no tiene una acción pendiente' };
    const by = actor || 'agente';
    try {
      const result = await this.runAgentTool(operationId, a.actionTool, by);
      await this.agentAlertRepo.save({ ...a, actionStatus: 'done', actionResult: result });
      await this.recordAgentAction({ operationId, sellerId: a.sellerId, agent: 'agent-rule', decision: `${a.ruleKey} → ${a.actionTool}`, actor: by, orderRef: a.entityRef, result: `ok: ${result}`, recommendationId: null });
      return { ok: true, result };
    } catch (e: any) {
      const msg = (e && e.message) || 'no se pudo ejecutar';
      await this.agentAlertRepo.save({ ...a, actionStatus: 'error', actionResult: msg });
      await this.recordAgentAction({ operationId, sellerId: a.sellerId, agent: 'agent-rule', decision: `${a.ruleKey} → ${a.actionTool}`, actor: by, orderRef: a.entityRef, result: `error: ${msg}`, recommendationId: null });
      return { ok: false, error: msg };
    }
  }

  /**
   * Evalúa UNA regla y devuelve los candidatos a alerta POR ENTIDAD (orden, SKU, lote,
   * operario), cada uno con su referencia, para que sean accionables. Devuelve [] si nada.
   */
  private async evalAgentRule(operationId: string, def: AgentRuleDef, cfg: AgentRuleConfig): Promise<Array<{ sellerId: string | null; title: string; detail: string; action: string; entityRef: string; entityType: 'ORDER' | 'SKU' | 'LOT' | 'OPERATOR' }>> {
    const sid = cfg.sellerId || undefined;
    const nm = new Map<string, string>();
    try { for (const x of await this.listSellers(operationId)) nm.set(x.id, x.name); } catch { /* ignore */ }
    const cl = (id: string | null | undefined) => (id ? nm.get(id) || id : '');
    if (def.key === 'orden_estancada') {
      const r = await this.getOrdersAtRisk(operationId, { sellerId: sid, maxHours: cfg.threshold, limit: 100 });
      return r.items.filter((i) => i.estado !== 'PACKED').map((i) => ({
        sellerId: i.sellerId, entityRef: i.orden, entityType: 'ORDER' as const,
        title: `Orden ${i.orden} detenida ${Math.round(i.horasDetenida)} h en ${i.estado}`,
        detail: `${cl(i.sellerId)} · ${i.unidades} un${i.courier ? ' · ' + i.courier : ''} · creada ${i.creada.slice(0, 16).replace('T', ' ')}.`,
        action: i.estado === 'RECEIVED' ? 'Reserva su stock (o revisa si falta stock).' : i.estado === 'ALLOCATED' ? 'Asígnala a un operario y pásala a picking.' : 'Revisa por qué el picking no avanza.',
      }));
    }
    if (def.key === 'sla_despacho') {
      const r = await this.getOrdersAtRisk(operationId, { sellerId: sid, maxHours: cfg.threshold, limit: 100 });
      return r.items.filter((i) => i.estado === 'PACKED').map((i) => ({
        sellerId: i.sellerId, entityRef: i.orden, entityType: 'ORDER' as const,
        title: `Pedido ${i.orden} empacado hace ${Math.round(i.horasDetenida)} h sin despachar`,
        detail: `${cl(i.sellerId)} · ${i.unidades} un${i.courier ? ' · ' + i.courier : ''}.`,
        action: 'Despáchalo antes del corte del courier.',
      }));
    }
    if (def.key === 'quiebre_stock') {
      const r = await this.getStockoutRisk(operationId, { sellerId: sid, coverDays: cfg.threshold, limit: 50 });
      return r.items.map((i) => ({
        sellerId: i.sellerId, entityRef: i.sku, entityType: 'SKU' as const,
        title: `${i.sku} con cobertura de ${i.diasCobertura} día(s)`,
        detail: `${cl(i.sellerId)} · disponible ${i.disponible} · demanda ${i.demandaDiaria}/día · reposición sugerida ${i.reposicionSugerida}.`,
        action: 'Gestiona la reposición con el cliente.',
      }));
    }
    if (def.key === 'operario_inactivo') {
      const dir = await this.operatorsDirectory(operationId);
      return dir.operarios.filter((o) => !o.activo && o.tareasAbiertas >= Math.max(1, cfg.threshold)).map((o) => ({
        sellerId: null, entityRef: o.id, entityType: 'OPERATOR' as const,
        title: `${o.nombre} inactivo con ${o.tareasAbiertas} tarea(s) abierta(s)`,
        detail: `Última conexión ${o.ultimaConexion ? o.ultimaConexion.slice(0, 16).replace('T', ' ') : 'desconocida'}.`,
        action: 'Reasigna su carga a operarios activos.',
      }));
    }
    if (def.key === 'lote_por_vencer') {
      const scope = cfg.sellerId ? [cfg.sellerId] : (await this.listSellers(operationId)).map((s) => s.id);
      const now = Date.parse(this.clockNow());
      const out: Array<{ sellerId: string | null; title: string; detail: string; action: string; entityRef: string; entityType: 'LOT' }> = [];
      for (const s of scope) for (const l of await this.expiringLots(s, now)) if (l.days <= cfg.threshold) out.push({
        sellerId: s, entityRef: `${l.sku}·${l.lot}`, entityType: 'LOT',
        title: `${l.sku} lote ${l.lot} ${l.days < 0 ? 'VENCIDO' : 'vence en ' + l.days + ' día(s)'}`,
        detail: `${cl(s)} · ${l.qty} un en stock.`,
        action: l.days < 0 ? 'Da de baja o pon en cuarentena el lote vencido.' : 'Prioriza su salida (FEFO).',
      });
      return out.sort((a, b) => a.title.localeCompare(b.title));
    }
    return [];
  }

  /**
   * Barrido del agente: evalúa las reglas encendidas y genera alertas nuevas POR ENTIDAD
   * (dedupe por regla+entidad, cooldown). Respeta la política: en modo sombra o con nivel
   * insuficiente, la acción automática queda PROPUESTA en vez de ejecutarse.
   */
  async runAgentSweep(operationId: string, opts?: { autonomous?: boolean }): Promise<{ evaluadas: number; nuevas: number; ejecutadas: number; propuestas: number; sombra: number }> {
    if (!this.agentAlertRepo) return { evaluadas: 0, nuevas: 0, ejecutadas: 0, propuestas: 0, sombra: 0 };
    const now = Date.parse(this.clockNow());
    const settings = await this.agentSettings(operationId);
    const usage = { cycle: 0, hour: await this.agentActionsLastHour(operationId) };
    let evaluadas = 0, nuevas = 0, ejecutadas = 0, propuestas = 0, sombra = 0;
    const MAX_PER_RULE = 15;
    for (const def of AGENT_RULES) {
      const cfg = await this.agentRuleEffective(operationId, def);
      if (!cfg.enabled) continue;
      evaluadas++;
      let cands: Awaited<ReturnType<WmsFacade['evalAgentRule']>> = [];
      try { cands = await this.evalAgentRule(operationId, def, cfg); } catch { cands = []; }
      let createdForRule = 0;
      // La acción automática de la regla se ejecuta UNA vez por barrido (no por entidad).
      let ruleActionDone: { status: 'done' | 'error' | 'proposed' | 'none'; result: string | null } | null = null;
      for (const cand of cands) {
        if (createdForRule >= MAX_PER_RULE) break;
        const dedupeKey = `${def.key}:${cand.entityRef}`;
        if (await this.agentAlertRepo.findOpenByDedupe(operationId, dedupeKey)) continue;
        const last = await this.agentAlertRepo.lastByDedupe(operationId, dedupeKey);
        if (last && (now - Date.parse(last.createdAt)) < cfg.cooldownMin * 60000) continue;
        const canExec = cfg.actionType === 'execute' && !!def.autoAction;
        let actionTool: string | null = null, actionLabel: string | null = null;
        let actionStatus: 'none' | 'proposed' | 'done' | 'error' = 'none', actionResult: string | null = null;
        if (canExec && def.autoAction) {
          actionTool = def.autoAction.tool; actionLabel = def.autoAction.label;
          if (!ruleActionDone) {
            const pol = decidePolicy({ tool: def.autoAction.tool, settings, autonomous: true, usage });
            if (cfg.actionMode === 'directo' && pol.decision === 'execute') {
              try {
                const result = await this.runAgentTool(operationId, actionTool, 'agente');
                ruleActionDone = { status: 'done', result }; usage.cycle++; ejecutadas++;
                await this.recordAgentAction({ operationId, sellerId: cand.sellerId, agent: 'agent-rule', decision: `${def.key} → ${actionTool}`, actor: 'agente', orderRef: cand.entityRef, result: `ok: ${result}`, recommendationId: null });
                await this.journal(operationId, 'decision', 'agente', `${def.name}: ejecuté "${actionLabel}" → ${result}`, { rule: def.key, tool: actionTool });
              } catch (e: any) {
                const msg = (e && e.message) || 'no se pudo ejecutar';
                ruleActionDone = { status: 'error', result: msg };
                await this.recordAgentAction({ operationId, sellerId: cand.sellerId, agent: 'agent-rule', decision: `${def.key} → ${actionTool}`, actor: 'agente', orderRef: cand.entityRef, result: `error: ${msg}`, recommendationId: null });
                await this.journal(operationId, 'outcome', 'agente', `${def.name}: falló "${actionLabel}" (${msg}); escalado a excepción.`, { rule: def.key, tool: actionTool });
              }
            } else {
              const why = cfg.actionMode !== 'directo' ? 'la regla pide confirmación' : pol.reason;
              ruleActionDone = { status: 'proposed', result: `propuesta (${why})` };
              if (settings.shadowMode && cfg.actionMode === 'directo') {
                sombra++;
                await this.recordAgentAction({ operationId, sellerId: cand.sellerId, agent: 'agent-shadow', decision: `${def.key} → ${actionTool}`, actor: 'agente', orderRef: cand.entityRef, result: `shadow: habría ejecutado "${actionLabel}"`, recommendationId: null });
                await this.journal(operationId, 'decision', 'agente', `[sombra] ${def.name}: habría ejecutado "${actionLabel}" (${pol.reason}).`, { rule: def.key, tool: actionTool, shadow: true });
              } else propuestas++;
            }
          }
          actionStatus = ruleActionDone.status; actionResult = ruleActionDone.result;
        }
        await this.agentAlertRepo.create({
          operationId, sellerId: cand.sellerId, ruleKey: def.key, severity: cfg.severity,
          title: cand.title, detail: cand.detail, action: cand.action, link: def.link, entityRef: cand.entityRef, entityType: cand.entityType,
          dedupeKey, status: 'open', actionTool, actionLabel, actionStatus, actionResult,
          createdAt: this.clockNow(), ackAt: null, ackBy: null,
        });
        nuevas++; createdForRule++;
      }
    }
    return { evaluadas, nuevas, ejecutadas, propuestas, sombra };
  }

  // ---- Diario e instrucciones del agente ------------------------------------------------
  async agentJournalList(operationId: string, opts?: { kind?: AgentJournalEntry['kind'] | null; limit?: number }): Promise<AgentJournalEntry[]> {
    if (!this.agentJournal) return [];
    return this.agentJournal.listRecent(operationId, { kind: opts?.kind ?? null, limit: Math.min(opts?.limit ?? 60, 300) });
  }
  async agentInstructions(operationId: string): Promise<AgentJournalEntry[]> {
    if (!this.agentJournal) return [];
    return this.agentJournal.listInstructions(operationId, this.clockNow());
  }
  async addAgentInstruction(operationId: string, texto: string, diasVigencia: number, actor?: string): Promise<{ ok: boolean; id: string | null }> {
    const t = String(texto || '').trim();
    if (!t) throw new ValidationError('Falta el texto de la instrucción');
    const expiresAt = diasVigencia > 0 ? new Date(Date.parse(this.clockNow()) + diasVigencia * 86400000).toISOString() : null;
    const id = await this.journal(operationId, 'instruction', actor || 'admin', t, null, expiresAt);
    return { ok: !!id, id };
  }
  async retireAgentInstruction(operationId: string, id: string, actor?: string): Promise<{ ok: boolean }> {
    if (!this.agentJournal) return { ok: false };
    const cur = (await this.agentJournal.listInstructions(operationId, this.clockNow())).find((e) => e.id === id);
    if (!cur) throw new NotFoundError('Instrucción no encontrada');
    await this.agentJournal.update(id, { active: false });
    await this.journal(operationId, 'note', actor || 'admin', `Instrucción retirada: ${cur.text.slice(0, 80)}`, null);
    return { ok: true };
  }

  // ---- Ciclo del agente autónomo (Fase 1): reloj propio, lock, sombra, notificaciones ----

  private agentRunning = new Set<string>();
  private agentLastCycle = new Map<string, { at: string; summary: Record<string, unknown> }>();
  private agentLastLlm = new Map<string, number>();

  /** Estado del agente para el panel: ajustes, último ciclo, lock, presupuesto. */
  async agentStatus(operationId: string): Promise<{ settings: Required<CopilotSettings>; running: boolean; lastCycle: { at: string; summary: Record<string, unknown> } | null; scheduler: { enabled: boolean; intervalSec: number }; llmCallsToday: number }> {
    const settings = await this.agentSettings(operationId);
    return {
      settings,
      running: this.agentRunning.has(operationId),
      lastCycle: this.agentLastCycle.get(operationId) ?? null,
      scheduler: { enabled: process.env.AGENT_SCHEDULER !== 'false', intervalSec: Math.max(30, Number(process.env.AGENT_INTERVAL_SEC || 120)) },
      llmCallsToday: await this.agentLlmCallsToday(operationId),
    };
  }
  private async agentLlmCallsToday(operationId: string): Promise<number> {
    if (!this.agentJournal) return 0;
    const since = new Date(this.clockNow()); since.setUTCHours(0, 0, 0, 0);
    try { return (await this.agentJournal.listRecent(operationId, { kind: 'cycle', since: since.toISOString(), limit: 500 })).filter((e) => e.data && (e.data as any).llm).length; } catch { return 0; }
  }

  /**
   * UN ciclo completo del agente para una operación. Lo dispara el scheduler del servidor
   * (o "Evaluar ahora"). Nunca corren dos ciclos a la vez para la misma operación.
   */
  async runAgentCycle(operationId: string, opts?: { force?: boolean; by?: string }): Promise<{ skipped?: string; barrido?: { evaluadas: number; nuevas: number; ejecutadas: number; propuestas: number; sombra: number }; llm?: { ran: boolean; text?: string | null; actions?: number; error?: string | null }; notificadas?: number }> {
    if (this.agentRunning.has(operationId)) return { skipped: 'ciclo en curso' };
    const settings = await this.agentSettings(operationId);
    if (settings.paused && !opts?.force) return { skipped: 'agente en pausa' };
    this.agentRunning.add(operationId);
    const startedAt = this.clockNow();
    try {
      const barrido = await this.runAgentSweep(operationId, { autonomous: true });
      // Orden de ejecución de las bandejas de los operarios (courier, SLA, instrucciones, tipo).
      try { this.prioritiesAt.set(operationId, Date.now()); await this.recomputeAssignmentPriorities(operationId); } catch { /* best-effort */ }
      let llm: { ran: boolean; text?: string | null; actions?: number; error?: string | null } = { ran: false };
      if (settings.llmPlanning) llm = await this.agentLlmPlanning(operationId, settings);
      const notificadas = await this.notifyAgentAlerts(operationId, settings, startedAt);
      const summary = { ...barrido, llm: llm.ran, llmActions: llm.actions ?? 0, notificadas, by: opts?.by || 'scheduler' };
      this.agentLastCycle.set(operationId, { at: this.clockNow(), summary });
      if (barrido.nuevas || barrido.ejecutadas || llm.ran) {
        await this.journal(operationId, 'cycle', 'agente', `Ciclo: ${barrido.evaluadas} reglas, ${barrido.nuevas} alerta(s) nueva(s), ${barrido.ejecutadas} ejecutada(s), ${barrido.propuestas} propuesta(s), ${barrido.sombra} en sombra${llm.ran ? `, planificación LLM (${llm.actions ?? 0} acción(es))` : ''}.`, summary);
      }
      return { barrido, llm, notificadas };
    } finally {
      this.agentRunning.delete(operationId);
    }
  }

  /**
   * Ciclo de PLANIFICACIÓN con LLM (opcional, presupuestado): el modelo recibe el contexto
   * en capas y puede invocar las herramientas de acción; la política decide si cada acción se
   * ejecuta, queda propuesta o se registra en sombra. Solo corre si hay algo accionable.
   */
  private async agentLlmPlanning(operationId: string, settings: Required<CopilotSettings>): Promise<{ ran: boolean; text?: string | null; actions?: number; error?: string | null }> {
    const now = Date.parse(this.clockNow());
    const last = this.agentLastLlm.get(operationId) || 0;
    if (now - last < settings.llmEveryMin * 60000) return { ran: false };
    if ((await this.agentLlmCallsToday(operationId)) >= settings.maxLlmCallsPerDay) return { ran: false, error: 'presupuesto diario de llamadas agotado' };
    const cred = await this.resolveAiCredential(operationId, null);
    if (!cred) return { ran: false, error: 'sin IA conectada' };
    await this.agentStateContext(operationId, null); // refresca los contadores
    // Sin nada accionable, no gastamos una llamada.
    const c = this.lastStateSnapshot.get(`${operationId}:*`) || {};
    const actionable = (c.ordenesEnRiesgo || 0) + (c.quiebres || 0) + (c.lotesPorVencer || 0) + (c.insumosBajos || 0) + Object.keys(c).filter((k) => k.startsWith('sinAsignar_')).reduce((a, k) => a + (c[k] || 0), 0);
    if (!actionable) return { ran: false };
    this.agentLastLlm.set(operationId, now);
    const ctx = await this.copilotContext(operationId, null);
    const sys = [
      'Eres el AGENTE DE BODEGA de Ninja WMS operando en automático para esta operación. No conversas con nadie: decides y actúas.',
      'Tu objetivo: que ninguna orden quede detenida, que el trabajo pendiente esté asignado y balanceado entre operarios activos, y que los riesgos (quiebres, lotes por vencer, insumos bajos) queden escalados.',
      'Usa las herramientas de acción cuando corresponda; la política decide si se ejecutan o quedan propuestas (la herramienta te lo dirá). Respeta las instrucciones vigentes del administrador y las reglas de negocio del perfil.',
      'No repitas acciones que el diario reciente muestre como ya hechas o propuestas. No inventes órdenes ni operarios: usa listar_ordenes, tareas_pendientes y operarios si necesitas confirmar.',
      'Al final responde en español con un informe breve (máximo 6 frases) de lo que hiciste, lo que dejaste propuesto y lo que requiere a un humano, con los identificadores.',
    ].join(' ') + `\n\n=== CONTEXTO ===\n${ctx}`;
    const usage = { cycle: 0, hour: await this.agentActionsLastHour(operationId) };
    const pendingActions: CopilotPendingAction[] = [];
    let actions = 0;
    const exec = async (name: string, args: any) => {
      const r = await this.copilotExecAction(name, args, { operationId, sellerId: null, mode: settings.actionMode, canWrite: true, question: 'ciclo automático del agente', actor: { id: 'agente', role: 'SUPERVISOR' }, pendingActions, settings, autonomous: true, usage });
      if (r !== undefined) { if (r && r.ok) { usage.cycle++; actions++; } return r; }
      return this.runCopilotTool(name, args, operationId, null);
    };
    const res = await askCopilotAgent(cred, sys, [{ role: 'user', content: 'Ejecuta el ciclo de planificación de la bodega ahora.' }], [...COPILOT_TOOLS, ...COPILOT_ACTION_TOOLS], exec);
    await this.journal(operationId, 'cycle', 'agente', `Planificación LLM: ${res.text ? res.text.slice(0, 400) : 'sin respuesta'}${res.error ? ' (error: ' + res.error + ')' : ''}`, { llm: true, actions, proposed: pendingActions.length, toolsUsed: res.toolsUsed });
    for (const p of pendingActions) await this.journal(operationId, 'decision', 'agente', `[propuesta] ${p.resumen || (p.accion + ' ' + p.orden)}`, { pending: p });
    return { ran: true, text: res.text, actions, error: res.error ?? null };
  }

  /** Notifica por correo/webhook las alertas creadas en este ciclo (críticas y acciones propuestas). */
  private async notifyAgentAlerts(operationId: string, settings: Required<CopilotSettings>, sinceIso: string): Promise<number> {
    if (!this.agentAlertRepo) return 0;
    if (!settings.notifyEmail && !settings.notifyWebhookUrl) return 0;
    const recent = (await this.agentAlertRepo.listRecent(operationId, 100)).filter((a) => a.createdAt >= sinceIso && (a.severity === 'crit' || a.actionStatus === 'proposed' || a.actionStatus === 'error'));
    if (!recent.length) return 0;
    const opName = (await this.operationsService.get(operationId))?.name || operationId;
    const lines = recent.map((a) => `[${a.severity}] ${a.title} — ${a.detail}${a.actionStatus === 'proposed' ? ` → propuesta: ${a.actionLabel}` : a.actionStatus === 'error' ? ` → falló: ${a.actionResult}` : ''}`);
    if (settings.notifyEmail && this.emailSender) {
      try {
        await this.emailSender.send({ to: settings.notifyEmail, subject: `[Ninja WMS] ${recent.length} alerta(s) del agente · ${opName}`, text: `Alertas nuevas del agente de bodega (${opName}):\n\n${lines.join('\n')}\n\nRevísalas en el panel → Reglas / Alertas.` });
      } catch { /* best-effort */ }
    }
    if (settings.notifyWebhookUrl) {
      try {
        const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 5000);
        await fetch(settings.notifyWebhookUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Ninja-Event': 'agent.alerts' }, body: JSON.stringify({ event: 'agent.alerts', at: this.clockNow(), operationId, operation: opName, alerts: recent }), signal: ctrl.signal }).catch(() => null);
        clearTimeout(t);
      } catch { /* best-effort */ }
    }
    return recent.length;
  }

  /** Alertas del agente. Con `sweep`, primero corre el barrido (panel en vivo). */
  async agentAlerts(operationId: string, opts?: { sweep?: boolean; includeRecent?: number }): Promise<{ abiertas: AgentAlert[]; recientes?: AgentAlert[]; barrido?: { evaluadas: number; nuevas: number } }> {
    if (!this.agentAlertRepo) return { abiertas: [] };
    let barrido;
    if (opts?.sweep) barrido = await this.runAgentSweep(operationId);
    const abiertas = await this.agentAlertRepo.listOpen(operationId);
    const recientes = opts?.includeRecent ? await this.agentAlertRepo.listRecent(operationId, opts.includeRecent) : undefined;
    return { abiertas, recientes, barrido };
  }

  /** Marca una alerta como vista/descartada. */
  async ackAgentAlert(operationId: string, id: string, actor?: string): Promise<{ ok: boolean }> {
    if (!this.agentAlertRepo) return { ok: false };
    const a = await this.agentAlertRepo.get(id);
    if (!a || a.operationId !== operationId) return { ok: false };
    if (a.status === 'open') await this.agentAlertRepo.save({ ...a, status: 'ack', ackAt: this.clockNow(), ackBy: actor ?? null });
    return { ok: true };
  }

  /**
   * Actividades asignadas a un operario para la vista "por operario" del panel: sus
   * asignaciones abiertas (autoritativas), enriquecidas con el estado real del ledger
   * (en ejecución vs. pendiente). "en ejecución" = la tarea del ledger arrancó (in_progress).
   */
  async operatorActivities(operationId: string, operator: string): Promise<{ operario: string; tareas: Array<{ tipo: WorkTaskType; referencia: string | null; cliente: string | null; unidades: number; estado: 'in_progress' | 'assigned'; asignada: string; prioridad: number; motivo: string | null }>; enEjecucion: number; pendientes: number; unidades: number }> {
    await this.ensureAssignmentPriorities(operationId);
    const asgs = this.assignments ? await this.assignments.listByOperator(operationId, operator) : [];
    const ledger = this.taskLedger ? await this.taskLedger.list(operationId, { limit: 2000 }) : [];
    const stateOf = new Map<string, string>();
    for (const t of ledger) stateOf.set(`${t.type}:${t.entityId}`, t.state);
    const tareas = asgs.map((a) => ({
      tipo: a.type, referencia: a.entityRef, cliente: a.sellerId, unidades: a.unitsEstimate,
      estado: (stateOf.get(`${a.type}:${a.entityId}`) === 'in_progress' ? 'in_progress' : 'assigned') as 'in_progress' | 'assigned',
      asignada: a.assignedAt, prioridad: a.priority ?? 0, motivo: a.priorityReason ?? null,
    })).sort((x, y) => (x.estado !== y.estado ? (x.estado === 'in_progress' ? -1 : 1) : (x.prioridad - y.prioridad) || (x.asignada < y.asignada ? -1 : 1)));
    return {
      operario: operator, tareas,
      enEjecucion: tareas.filter((t) => t.estado === 'in_progress').length,
      pendientes: tareas.filter((t) => t.estado === 'assigned').length,
      unidades: tareas.reduce((s, t) => s + t.unidades, 0),
    };
  }

  /**
   * Tareas asignadas a un operario (la vista "Mis tareas" de la PWA), en ORDEN DE EJECUCIÓN:
   * primero lo que está en curso, luego por prioridad calculada (courier/SLA/instrucciones/tipo)
   * y, a igual prioridad, lo asignado antes. La primera lleva `next`.
   */
  async getOperatorTasks(operationId: string, operator: string): Promise<Array<WorkAssignment & { next?: boolean; position?: number }>> {
    if (!this.assignments) return [];
    await this.ensureAssignmentPriorities(operationId);
    const list = await this.assignments.listByOperator(operationId, operator);
    const ledger = this.taskLedger ? await this.taskLedger.list(operationId, { limit: 2000 }) : [];
    const running = new Set(ledger.filter((t) => t.state === 'in_progress').map((t) => `${t.type}:${t.entityId}`));
    const sorted = [...list].sort((a, b) => {
      const ra = running.has(`${a.type}:${a.entityId}`) ? 0 : 1, rb = running.has(`${b.type}:${b.entityId}`) ? 0 : 1;
      if (ra !== rb) return ra - rb;
      const pa = a.priority ?? 0, pb = b.priority ?? 0;
      if (pa !== pb) return pa - pb;
      return a.assignedAt < b.assignedAt ? -1 : 1;
    });
    return sorted.map((a, i) => ({ ...a, priority: a.priority ?? 0, priorityReason: a.priorityReason ?? null, position: i + 1, next: i === 0 }));
  }

  private prioritiesAt = new Map<string, number>();
  /** Recalcula las prioridades si llevan más de 60 s sin actualizarse (barato: se llama desde la PWA). */
  private async ensureAssignmentPriorities(operationId: string): Promise<void> {
    const now = Date.now();
    if ((this.prioritiesAt.get(operationId) || 0) > now - 60000) return;
    this.prioritiesAt.set(operationId, now);
    try { await this.recomputeAssignmentPriorities(operationId); } catch { /* best-effort */ }
  }

  /**
   * Orden de ejecución de las tareas asignadas (Fase 3 adelantada). Para cada asignación abierta:
   *   prioridad = peso del tipo (despacho < empaque < picking < recepción < guardado < conteo < re-slot)
   *             × 1000 + posición dentro de su cola (cola de picking = courier + FIFO; guardado = llegada;
   *             recepciones parciales primero; conteos por prioridad del plan)
   *   − impulsos: orden con prioridad "alta" (−300), courier nombrado en una instrucción vigente
   *     del administrador ("priorizar Chilexpress") (−500), pedido empacado hace +N h (SLA) (−200).
   * Devuelve cuántas asignaciones cambiaron de prioridad. Lo llama el ciclo del agente y la PWA.
   */
  async recomputeAssignmentPriorities(operationId: string): Promise<{ recalculadas: number; cambiadas: number }> {
    if (!this.assignments) return { recalculadas: 0, cambiadas: 0 };
    const open = (await this.assignments.list(operationId, { limit: 5000 })).filter((a) => a.status === 'assigned' || a.status === 'in_progress');
    if (!open.length) return { recalculadas: 0, cambiadas: 0 };
    const TYPE_W: Record<string, number> = { SHIP: 1, PACK: 2, PICK: 3, RECEIVE: 4, PUTAWAY: 5, COUNT: 6, RESLOT: 7 };
    // Posición dentro de la cola de cada tipo (normalizada a 1..n).
    const rank = new Map<string, number>();
    const types = [...new Set(open.map((a) => a.type))];
    for (const t of types) {
      const pool = await this.getTaskPool(operationId, t, { limit: 5000 }).catch(() => [] as Awaited<ReturnType<WmsFacade['getTaskPool']>>);
      pool.forEach((p, i) => rank.set(`${t}:${p.entityId}`, i + 1));
    }
    // Instrucciones vigentes: couriers o clientes a priorizar.
    const boostsCourier: string[] = []; const boostsSeller: string[] = [];
    try {
      const ins = this.agentJournal ? await this.agentJournal.listInstructions(operationId, this.clockNow()) : [];
      const sellers = await this.listSellers(operationId);
      for (const i of ins) {
        const t = i.text.toLowerCase();
        if (!/priori/.test(t)) continue;
        for (const c of ['chilexpress', 'starken', 'blue express', 'blueexpress', 'correos', 'dhl', 'rapiboy', 'uber', 'samex', 'fedex', 'ups']) if (t.includes(c)) boostsCourier.push(c.replace(' ', ''));
        for (const sl of sellers) if (t.includes(sl.name.toLowerCase())) boostsSeller.push(sl.id);
      }
    } catch { /* sin instrucciones */ }
    const nowMs = Date.parse(this.clockNow());
    let cambiadas = 0;
    const orderCache = new Map<string, SalesOrder | null>();
    for (const a of open) {
      const w = TYPE_W[a.type] ?? 8;
      const r = rank.get(`${a.type}:${a.entityId}`) ?? 999;
      let prio = w * 1000 + Math.min(r, 999);
      const why: string[] = [];
      if (a.type === 'PICK' || a.type === 'PACK' || a.type === 'SHIP') {
        let o = orderCache.get(a.entityId);
        if (o === undefined) { o = a.sellerId ? await this.orders.getOrder(a.sellerId, a.entityId).catch(() => null) : null; orderCache.set(a.entityId, o ?? null); }
        if (o) {
          const carrier = (o.carrier || '').toLowerCase().replace(' ', '');
          if (carrier) why.push(o.carrier as string);
          if (carrier && boostsCourier.some((c) => carrier.includes(c))) { prio -= 500; why.push('instrucción: priorizar courier'); }
          if (o.priority === 'alta') { prio -= 300; why.push('prioridad alta'); }
          if (o.status === 'PACKED') { const ev = (o.events || []).find((e) => e.type === 'PACKED'); const h = ev ? (nowMs - Date.parse(ev.at)) / 3600000 : 0; if (h >= 6) { prio -= 200; why.push(`empacada hace ${Math.round(h)} h`); } }
        }
      }
      if (a.sellerId && boostsSeller.includes(a.sellerId)) { prio -= 400; why.push('instrucción: priorizar cliente'); }
      const reason = why.length ? why.join(' · ') : ({ SHIP: 'despacho pendiente', PACK: 'listo para empacar', PICK: `cola de picking #${r}`, RECEIVE: 'recepción abierta', PUTAWAY: 'guardado pendiente', COUNT: 'conteo del día', RESLOT: 're-slot sugerido' } as Record<string, string>)[a.type] || a.type;
      if (a.priority !== prio || a.priorityReason !== reason) {
        await this.assignments.save({ ...a, priority: prio, priorityReason: reason });
        cambiadas++;
      }
    }
    return { recalculadas: open.length, cambiadas };
  }

  /** Historial de asignaciones (panel/auditoría). */
  async listAssignments(operationId: string, opts?: { type?: WorkTaskType; limit?: number }): Promise<WorkAssignment[]> {
    if (!this.assignments) return [];
    return this.assignments.list(operationId, opts);
  }

  /** Marca como completadas las asignaciones abiertas de estas tareas (hook de ejecución). */
  private async completeAssignments(type: WorkTaskType, entityIds: string[], completedBy: string): Promise<void> {
    if (!this.assignments) return;
    for (const entityId of entityIds) {
      try {
        const a = await this.assignments.get(`${type}:${entityId}`);
        if (a && (a.status === 'assigned' || a.status === 'in_progress')) {
          await this.assignments.save({ ...a, status: 'done', completedAt: this.clockNow(), completedBy });
        }
        // Ledger: para tareas de bodega no ligadas a orden (guardado/conteo/re-slotting),
        // cerrar la tarea aquí. Las de orden (PICK/PACK/SHIP/RECEIVE) las cierra su hook.
        if ((type === 'PUTAWAY' || type === 'COUNT' || type === 'RESLOT') && a) {
          await this.advanceTask(a.operationId, type as WorkTaskStage, entityId, { state: 'done', by: completedBy });
        }
      } catch { /* best-effort */ }
    }
  }

  // ---- Registro de tareas (task ledger) -------------------------------------
  /** Abre (o reutiliza) una tarea del ledger para una etapa/entidad. Best-effort. */
  private async openTask(operationId: string, input: { type: WorkTaskStage; sellerId?: string | null; orderId?: string | null; orderRef?: string | null; entityId: string; entityRef?: string | null; unitsEstimate?: number; by: string; state?: WorkTaskState; note?: string | null }): Promise<WorkTask | null> {
    if (!this.taskLedger) return null;
    try {
      const existing = await this.taskLedger.findOpen(operationId, input.type, input.entityId);
      if (existing) return existing;
      return await this.taskLedger.create({
        operationId, sellerId: input.sellerId ?? null, type: input.type,
        orderId: input.orderId ?? null, orderRef: input.orderRef ?? null,
        entityId: input.entityId, entityRef: input.entityRef ?? null,
        state: input.state ?? 'pending', unitsEstimate: Math.max(0, Math.round(input.unitsEstimate || 0)),
        assignmentId: null, operator: null, createdAt: this.clockNow(), createdBy: input.by,
        startedAt: null, completedAt: null, completedBy: null, note: input.note ?? null,
      });
    } catch { return null; }
  }
  /** Avanza el estado de la tarea abierta de una etapa/entidad (best-effort). */
  private async advanceTask(operationId: string, type: WorkTaskStage, entityId: string, patch: { state: WorkTaskState; by?: string; assignmentId?: string | null; operator?: string | null }): Promise<void> {
    if (!this.taskLedger) return;
    try {
      const t = await this.taskLedger.findOpen(operationId, type, entityId);
      if (!t) return;
      const now = this.clockNow();
      const next: WorkTask = { ...t, state: patch.state };
      if (patch.assignmentId !== undefined) next.assignmentId = patch.assignmentId;
      if (patch.operator !== undefined) next.operator = patch.operator;
      if (patch.state === 'in_progress' && !next.startedAt) next.startedAt = now;
      if (patch.state === 'done' || patch.state === 'cancelled') { next.completedAt = now; next.completedBy = patch.by ?? next.operator ?? 'system'; }
      await this.taskLedger.update(next);
    } catch { /* best-effort */ }
  }
  /** Registra una tarea instantánea ya completada (ej. la reserva de stock). */
  private async recordDoneTask(operationId: string, input: { type: WorkTaskStage; sellerId?: string | null; orderId?: string | null; orderRef?: string | null; entityId: string; entityRef?: string | null; unitsEstimate?: number; by: string }): Promise<void> {
    const t = await this.openTask(operationId, { ...input, state: 'in_progress' });
    if (t) await this.advanceTask(operationId, input.type, input.entityId, { state: 'done', by: input.by });
  }

  /** Tareas (todas las etapas) de una orden, con su id/tipo/estado. Relación tarea↔tipo↔orden. */
  async orderTasks(sellerId: string, orderId: string): Promise<WorkTask[]> {
    if (!this.taskLedger) return [];
    const opId = await this.operationOfSeller(sellerId).catch(() => null);
    if (!opId) return [];
    // Resuelve por id interno o por referencia externa de la orden.
    let oid = orderId;
    const byRef = await this.orders.getOrder(sellerId, orderId).catch(() => null);
    if (!byRef) {
      const list = await this.orders.listOrders(sellerId);
      const hit = list.find((o) => o.externalOrderId === orderId);
      if (hit) oid = hit.id;
    }
    return this.taskLedger.listByOrder(opId, oid);
  }

  /** Historial de tareas del ledger (panel/auditoría), filtrable por tipo/estado/cliente. */
  async listTasks(operationId: string, opts?: { type?: WorkTaskStage; state?: WorkTaskState; sellerId?: string | null; limit?: number }): Promise<WorkTask[]> {
    if (!this.taskLedger) return [];
    return this.taskLedger.list(operationId, opts);
  }

  /**
   * Enforcement 'strict': si la tarea está asignada a OTRO operario, bloquea. En
   * 'advisory' nunca bloquea. Tareas sin asignar se permiten en ambos modos.
   */
  private async assertAssignmentAllowed(operationId: string, type: WorkTaskType, entityId: string, actor: string): Promise<void> {
    if (!this.assignments) return;
    if ((await this.getAssignmentMode(operationId)) !== 'strict') return;
    const a = await this.assignments.get(`${type}:${entityId}`);
    if (a && (a.status === 'assigned' || a.status === 'in_progress') && a.operator !== actor) {
      throw new ForbiddenError(`Tarea asignada a otro operario (modo estricto). Solo ${a.operator} puede ejecutarla.`);
    }
  }

  // ---- Auto-balanceo continuo (Camino B) ------------------------------------

  async getAutoBalanceEnabled(operationId: string): Promise<boolean> {
    const op = await this.operationsService.get(operationId);
    return !!op?.autoBalance;
  }

  /** Activa/desactiva el auto-balanceo continuo. Al activarlo, hace un barrido inicial. */
  async setAutoBalanceContinuous(operationId: string, on: boolean): Promise<{ autoBalance: boolean; asignadasInicial: number }> {
    await this.operationsService.setAutoBalance(operationId, on);
    let asignadasInicial = 0;
    if (on) for (const t of ['PICK', 'RECEIVE', 'PUTAWAY', 'RESLOT', 'COUNT'] as WorkTaskType[]) asignadasInicial += await this.rebalancePending(operationId, t);
    return { autoBalance: on, asignadasInicial };
  }

  /** Carga actual (unidades/horas) por operario, a partir de sus asignaciones abiertas. */
  private async currentLoad(operationId: string): Promise<{ roster: Array<{ id: string; name: string; speed: number }>; load: Map<string, { hours: number }> }> {
    const roster = await this.operatorRoster(operationId);
    const load = new Map<string, { hours: number }>();
    for (const op of roster) load.set(op.id, { hours: 0 });
    if (this.assignments) {
      for (const a of await this.assignments.listOpen(operationId)) {
        const op = roster.find((r) => r.id === a.operator);
        if (op) load.get(op.id)!.hours += a.unitsEstimate / op.speed;
      }
    }
    return { roster, load };
  }

  /** Asigna UNA tarea al operario con menor tiempo proyectado. Devuelve true si asignó. */
  private async autoAssignOne(operationId: string, type: WorkTaskType, task: { entityId: string; entityRef: string | null; sellerId: string | null; unidades: number; note?: string | null }): Promise<boolean> {
    if (!this.assignments) return false;
    const existing = await this.assignments.get(`${type}:${task.entityId}`);
    if (existing && (existing.status === 'assigned' || existing.status === 'in_progress')) return false; // ya asignada
    const { roster, load } = await this.currentLoad(operationId);
    if (!roster.length) return false;
    let best = roster[0]; let bestProj = Infinity;
    for (const op of roster) { const proj = load.get(op.id)!.hours + task.unidades / op.speed; if (proj < bestProj) { bestProj = proj; best = op; } }
    await this.assignTask(operationId, { type, entityId: task.entityId, entityRef: task.entityRef, sellerId: task.sellerId, operator: best.id, unitsEstimate: task.unidades, by: 'auto-balance', note: task.note ?? 'auto-balanceo continuo', skipOperatorCheck: true });
    return true;
  }

  /** Reparte TODO lo pendiente sin asignar de un tipo al operario menos cargado. */
  private async rebalancePending(operationId: string, type: WorkTaskType): Promise<number> {
    const pool = await this.getTaskPool(operationId, type, { onlyUnassigned: true });
    let n = 0;
    for (const t of pool) if (await this.autoAssignOne(operationId, type, { entityId: t.entityId, entityRef: t.entityRef, sellerId: t.sellerId, unidades: t.unidades, note: t.note })) n++;
    return n;
  }

  /**
   * Enganche del auto-balanceo continuo: si está activo, asigna la tarea nueva
   * (task) al operario menos cargado, o —si task es null— reparte lo pendiente del
   * tipo (usado al liberarse un operario). Best-effort, nunca rompe el flujo.
   */
  private async continuousHook(operationId: string | null, type: WorkTaskType, task: { entityId: string; entityRef: string | null; sellerId: string | null; unidades: number; note?: string | null } | null): Promise<void> {
    try {
      if (!operationId || !this.assignments) return;
      if (!(await this.getAutoBalanceEnabled(operationId))) return;
      if (task) await this.autoAssignOne(operationId, type, task);
      else { await this.rebalancePending(operationId, type); await this.rebalanceLoad(operationId, { execute: true }); }
    } catch { /* best-effort */ }
  }

  /**
   * Reasignación automática (work-stealing): mueve tareas ASIGNADAS pero aún no
   * empezadas desde el operario más cargado al menos cargado, hasta que la diferencia
   * de tiempo proyectado baje del umbral. Protege la tarea más antigua de cada operario
   * (la que presumiblemente está ejecutando). Devuelve los movimientos; execute los persiste.
   */
  async rebalanceLoad(operationId: string, opts?: { maxGapHours?: number; execute?: boolean }): Promise<{ movimientos: Array<{ tarea: string; de: string; a: string; unidades: number }>; porOperario: Array<{ operario: string; tareas: number; horas: number }> }> {
    if (!this.assignments) return { movimientos: [], porOperario: [] };
    const gapThreshold = opts?.maxGapHours ?? 0.1;
    const roster = await this.operatorRoster(operationId);
    if (roster.length < 2) return { movimientos: [], porOperario: [] };
    const speed = new Map(roster.map((r) => [r.id, r.speed] as [string, number]));
    // Asignaciones abiertas por operario (ordenadas por antigüedad: la más antigua = en curso).
    const openByOp = new Map<string, WorkAssignment[]>();
    for (const r of roster) openByOp.set(r.id, []);
    for (const a of await this.assignments.listOpen(operationId)) {
      if (!openByOp.has(a.operator)) continue; // operario fuera del roster
      openByOp.get(a.operator)!.push(a);
    }
    for (const arr of openByOp.values()) arr.sort((a, b) => (a.assignedAt < b.assignedAt ? -1 : 1));
    const hours = new Map<string, number>();
    for (const r of roster) hours.set(r.id, (openByOp.get(r.id) || []).reduce((s, a) => s + a.unitsEstimate / r.speed, 0));

    const movimientos: Array<{ tarea: string; de: string; a: string; unidades: number }> = [];
    let guard = 0;
    while (guard++ < 500) {
      const sorted = roster.slice().sort((a, b) => hours.get(a.id)! - hours.get(b.id)!);
      const lo = sorted[0], hi = sorted[sorted.length - 1];
      if (hours.get(hi.id)! - hours.get(lo.id)! <= gapThreshold) break;
      // Tareas movibles del más cargado: todas menos la más antigua (en curso).
      const movable = (openByOp.get(hi.id) || []).slice(1);
      if (!movable.length) break;
      // Elige la tarea que deja los tiempos más parejos tras moverla.
      let pick: WorkAssignment | null = null, bestScore = Infinity;
      for (const a of movable) {
        const newHi = hours.get(hi.id)! - a.unitsEstimate / speed.get(hi.id)!;
        const newLo = hours.get(lo.id)! + a.unitsEstimate / speed.get(lo.id)!;
        const score = Math.abs(newHi - newLo);
        if (score < bestScore) { bestScore = score; pick = a; }
      }
      if (!pick) break;
      const gapNow = hours.get(hi.id)! - hours.get(lo.id)!;
      if (bestScore >= gapNow) break; // ningún movimiento mejora el balance
      // Aplica el movimiento (en memoria + persistencia si execute).
      hours.set(hi.id, hours.get(hi.id)! - pick.unitsEstimate / speed.get(hi.id)!);
      hours.set(lo.id, hours.get(lo.id)! + pick.unitsEstimate / speed.get(lo.id)!);
      openByOp.set(hi.id, (openByOp.get(hi.id) || []).filter((x) => x.id !== pick!.id));
      openByOp.get(lo.id)!.push({ ...pick, operator: lo.id });
      movimientos.push({ tarea: pick.entityRef || pick.entityId, de: hi.id, a: lo.id, unidades: pick.unitsEstimate });
      if (opts?.execute) {
        await this.assignments.save({ ...pick, operator: lo.id, assignedBy: 'auto-rebalance', assignedAt: this.clockNow(), note: 'reasignación automática (balanceo por ociosidad)' });
      }
    }
    const porOperario = roster.map((r) => ({ operario: r.id, tareas: (openByOp.get(r.id) || []).length, horas: Math.round(hours.get(r.id)! * 10) / 10 }));
    return { movimientos, porOperario };
  }

  async getSeller(sellerId: string): Promise<Seller | null> {
    return this.sellers.findById(sellerId);
  }

  // ---- Mantenedor de productos (SKUs + kits) — permiso product:manage --------
  createSku(sellerId: string, input: CreateSkuInput, actor?: string): Promise<Sku> {
    return this.products.create(sellerId, input as ProductInput, actor);
  }
  createProduct(sellerId: string, input: ProductInput, actor?: string): Promise<Sku> {
    return this.products.create(sellerId, input, actor);
  }
  updateProduct(sellerId: string, sku: string, patch: ProductPatch, actor?: string): Promise<Sku> {
    return this.products.update(sellerId, sku, patch, actor);
  }
  setProductActive(sellerId: string, sku: string, active: boolean, actor?: string): Promise<Sku> {
    return this.products.setActive(sellerId, sku, active, actor);
  }
  async assembleKit(
    sellerId: string,
    cmd: { kitSku: string; qty: number; toLocationId: string; sources: { sku: string; locationId: string; lot?: string | null; qty: number }[] },
    actor?: string,
  ): Promise<Sku> {
    await this.assertFeature(await this.operationOfSeller(sellerId).catch(() => null), 'kitting', 'El armado de kits');
    return this.products.assembleKit(sellerId, cmd, actor);
  }
  planAssemblySources(sellerId: string, kitSku: string, qty: number) {
    return this.products.planAssemblySources(sellerId, kitSku, qty);
  }
  listAssemblies(sellerId: string) {
    return this.products.listAssemblies(sellerId);
  }

  // ---- Facturación 3PL ------------------------------------------------------
  getBillingRate(sellerId: string) {
    return this.billing.getRate(sellerId);
  }
  async setBillingRate(sellerId: string, patch: RatePatch) {
    const seller = await this.sellers.findById(sellerId);
    if (seller) await this.assertFeature(seller.operationId, 'billing_3pl', 'La facturación 3PL');
    return this.billing.setRate(sellerId, patch);
  }
  generateInvoice(sellerId: string, year: number, month: number, actor?: string) {
    return this.billing.generateInvoice(sellerId, year, month, actor);
  }
  previewInvoice(sellerId: string, year: number, month: number) {
    const fromISO = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const toISO = new Date(Date.UTC(year, month, 1)).toISOString();
    return this.billing.computeInvoice(sellerId, fromISO, toISO);
  }
  listInvoices(sellerId: string) {
    return this.billing.listInvoices(sellerId);
  }
  getInvoice(sellerId: string, id: string) {
    return this.billing.getInvoice(sellerId, id);
  }
  invoicesForMonth(sellerId: string, year: number, month: number) {
    return this.billing.invoicesForMonth(sellerId, year, month);
  }
  updateInvoice(sellerId: string, id: string, patch: { number?: string; lines?: { concept: string; unit?: string; qty: number; rate: number }[] }) {
    return this.billing.updateInvoice(sellerId, id, patch);
  }
  deleteInvoice(sellerId: string, id: string) {
    return this.billing.deleteInvoice(sellerId, id);
  }
  recordInvoiceSend(sellerId: string, id: string, to: string, delivered: boolean, actor?: string) {
    return this.billing.recordSend(sellerId, id, to, delivered, actor);
  }
  approveInvoice(sellerId: string, id: string, actor: string) {
    return this.billing.approveInvoice(sellerId, id, actor);
  }
  attachInvoiceTaxDocument(sellerId: string, id: string, input: AttachTaxDocInput, actor?: string) {
    return this.billing.attachTaxDocument(sellerId, id, input, actor);
  }
  markInvoiceInvoiced(sellerId: string, id: string) {
    return this.billing.markInvoiced(sellerId, id);
  }
  removeInvoiceTaxDocument(sellerId: string, id: string) {
    return this.billing.removeTaxDocument(sellerId, id);
  }
  getInvoiceTaxDocument(sellerId: string, id: string) {
    return this.billing.getTaxDocument(sellerId, id);
  }
  billingDashboard(operationId: string) {
    return this.billing.dashboard(operationId);
  }

  // ---- Costos y rentabilidad (costeo por actividad + estándar/real) ---------
  /** Tarjeta de costos de la operación (con defaults si aún no se configuró). */
  async getCostRates(operationId: string) {
    if (!this.costing) throw new ValidationError('El módulo de costos no está disponible');
    await this.assertFeature(operationId, 'cost_profitability', 'El módulo de costos y rentabilidad');
    return this.costing.getCard(operationId);
  }
  /** Edita el tarifario de costos (labor por rol/operario, estándar u/h, almacenaje, embalaje, overhead). */
  async setCostRates(operationId: string, patch: Partial<CostRateCard>, by?: string) {
    if (!this.costing) throw new ValidationError('El módulo de costos no está disponible');
    await this.assertFeature(operationId, 'cost_profitability', 'El módulo de costos y rentabilidad');
    return this.costing.setCard(operationId, patch, by);
  }
  /** Rentabilidad por cliente: ingreso (facturación) vs. costo, con margen estándar y real. */
  async profitability(operationId: string, year: number, month: number) {
    if (!this.costing) throw new ValidationError('El módulo de costos no está disponible');
    await this.assertFeature(operationId, 'cost_profitability', 'El módulo de costos y rentabilidad');
    const from = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const to = new Date(Date.UTC(year, month, 1)).toISOString();
    return this.costing.profitability(operationId, from, to);
  }
  /** Rentabilidad para un rango arbitrario. */
  async profitabilityRange(operationId: string, fromISO: string, toISO: string) {
    if (!this.costing) throw new ValidationError('El módulo de costos no está disponible');
    await this.assertFeature(operationId, 'cost_profitability', 'El módulo de costos y rentabilidad');
    return this.costing.profitability(operationId, fromISO, toISO);
  }
  /** Eficiencia de mano de obra estándar vs. real (por operario o por tipo de tarea). */
  async laborEfficiency(operationId: string, year: number, month: number, groupBy?: 'operator' | 'type') {
    if (!this.costing) throw new ValidationError('El módulo de costos no está disponible');
    await this.assertFeature(operationId, 'cost_profitability', 'El módulo de costos y rentabilidad');
    const from = new Date(Date.UTC(year, month - 1, 1)).toISOString();
    const to = new Date(Date.UTC(year, month, 1)).toISOString();
    return this.costing.laborEfficiency(operationId, from, to, groupBy || 'operator');
  }
  dashboardMetrics(sellerId: string) {
    return this.metrics.forSeller(sellerId);
  }
  dashboardMetricsRange(sellerId: string, fromIso: string, toIso: string) {
    return this.metrics.forSellerRange(sellerId, fromIso, toIso);
  }
  // ---- Panel de uso de la plataforma (solo PLATFORM_ADMIN) ------------------
  /** Registra un login exitoso (auditoría + métricas de uso). */
  recordLogin(userId: string, operationId: string | null, at?: string) {
    return this.platformUsageService.recordLogin(userId, operationId, at);
  }
  /** Nivel de uso por operación + consolidado, para la ventana de `spanDays` días. */
  platformUsage(spanDays: number) {
    return this.platformUsageService.usage(spanDays);
  }
  platformUsageRange(fromIso: string, toIso: string) {
    return this.platformUsageService.usage(0, { from: fromIso, to: toIso });
  }
  // ---- Anuncios de plataforma (barra superior) ----
  async createAnnouncement(input: AnnouncementInput, actor: string) {
    await this.assertFeature((input as any)?.operationId ?? null, 'announcements', 'El módulo de anuncios');
    return this.announcements.create(input, actor);
  }
  updateAnnouncement(id: string, patch: AnnouncementPatch) {
    return this.announcements.update(id, patch);
  }
  deleteAnnouncement(id: string) {
    return this.announcements.remove(id);
  }
  listAnnouncements() {
    return this.announcements.list();
  }
  activeAnnouncement(viewerRole?: string) {
    return this.announcements.activeForViewer(viewerRole);
  }
  clickAnnouncement(id: string, user: User | null) {
    return this.announcements.recordClick(id, user);
  }
  announcementClicks(id: string) {
    return this.announcements.clicks(id);
  }
  // ---- Webhooks configurables por evento ----
  listWebhooks(user: User) {
    return this.webhooks.list(user);
  }
  async createWebhook(user: User, dto: CreateWebhookInput) {
    await this.assertFeature(user.operationId, 'webhooks', 'Los webhooks');
    return this.webhooks.create(user, dto);
  }
  updateWebhook(user: User, id: string, dto: UpdateWebhookInput) {
    return this.webhooks.update(user, id, dto);
  }
  deleteWebhook(user: User, id: string) {
    return this.webhooks.remove(user, id);
  }
  webhookDeliveries(user: User, id: string) {
    return this.webhooks.deliveries(user, id);
  }
  testWebhook(user: User, id: string) {
    return this.webhooks.test(user, id);
  }
  /** Mantenedor del administrador: activa/desactiva el panel de webhooks de un cliente. */
  setSellerWebhooksAccess(sellerId: string, enabled: boolean) {
    return this.webhooks.setClientAccess(sellerId, enabled);
  }
  /** Clientes de una operación con su flag de acceso al panel de webhooks. */
  listWebhookClients(operationId: string) {
    return this.webhooks.listClientsAccess(operationId);
  }
  /**
   * Dispara (fire-and-forget) un evento de webhook resolviendo la operación del seller.
   * Nunca bloquea ni propaga errores al flujo de negocio.
   */
  private async dispatchWebhook(event: WebhookEventType, sellerId: string, payload: object): Promise<void> {
    try {
      const seller = await this.sellers.findById(sellerId);
      await this.webhooks.dispatch(event, sellerId, seller ? seller.operationId : null, payload);
    } catch {
      /* jamás afecta la respuesta del negocio */
    }
  }
  // ---- Chat interno cliente ↔ operaciones ----
  chatThread(sellerId: string, viewerRole: string) {
    return this.chat.thread(sellerId, viewerRole);
  }
  async chatSend(sellerId: string, sender: ChatSender, body: string) {
    await this.assertFeature(await this.operationOfSeller(sellerId).catch(() => null), 'client_chat', 'La mensajería con clientes');
    return this.chat.send(sellerId, sender, body);
  }
  chatMarkRead(sellerId: string, viewerRole: string) {
    return this.chat.markRead(sellerId, viewerRole);
  }
  chatSummary(operationId: string) {
    return this.chat.summary(operationId);
  }
  getProduct(sellerId: string, sku: string): Promise<Sku | null> {
    return this.products.getSku(sellerId, sku);
  }
  listProductLog(sellerId: string, sku?: string) {
    return this.products.listLog(sellerId, sku);
  }

  async createLocation(input: CreateLocationInput): Promise<Location> {
    await this.operationsService.mustGet(input.operationId);
    await this.assertQuota(input.operationId, 'warehouses');
    const location: Location = {
      id: this.ids.next(),
      operationId: input.operationId,
      warehouseId: input.warehouseId ?? 'W1',
      code: input.code,
      zoneType: input.zoneType,
      capacity: input.capacity ?? 0,
      pickRank: input.pickRank ?? 1,
      active: true,
      x: input.x ?? null,
      y: input.y ?? null,
    };
    await this.locations.save(location);
    return location;
  }

  /** G7: fija/actualiza las coordenadas (geometría) de una ubicación. */
  async setLocationGeometry(operationId: string, locationId: string, coords: { x: number | null; y: number | null }): Promise<Location> {
    const loc = await this.locations.findById(locationId);
    if (!loc || loc.operationId !== operationId) throw new NotFoundError(`Ubicación no encontrada: ${locationId}`);
    const updated: Location = { ...loc, x: coords.x, y: coords.y };
    await this.locations.save(updated);
    return updated;
  }

  /** Sugerencia de guardado dirigido (motor caótico). */
  async suggestPutaway(
    sellerId: string,
    input: { sku: string; qty: number; limit?: number },
  ): Promise<PutawaySuggestion[]> {
    const suggestions = await this.putawayAdvisor.suggest(sellerId, input);
    // G5: registra la recomendación del advisor (para gobernanza y % de aceptación).
    if (this.aiAudit && suggestions.length) {
      const seller = await this.sellers.findById(sellerId);
      if (seller) {
        const top = suggestions.slice(0, 3);
        await this.recordRecommendation({
          operationId: seller.operationId, sellerId, type: 'putaway',
          input: JSON.stringify({ sku: input.sku, qty: input.qty }),
          output: JSON.stringify({ top: top.map((s) => s.locationId), codes: top.map((s) => s.locationCode) }),
          score: top[0]?.score ?? null, taken: null, outcome: null, actor: 'putaway_advisor',
        });
      }
    }
    return suggestions;
  }

  /**
   * G5: al guardar en una ubicación, marca si se siguió la recomendación de guardado
   * más reciente para ese SKU (efecto medible de las sugerencias). Best-effort.
   */
  private async markPutawayRecommendationTaken(operationId: string, sellerId: string, sku: string, chosenLocationId: string, chosenCode: string): Promise<void> {
    if (!this.aiAudit) return;
    try {
      const recs = await this.aiAudit.listRecommendations(operationId, { type: 'putaway', limit: 100 });
      const rec = recs.find((r) => {
        if (r.sellerId !== sellerId || r.taken != null) return false;
        try { return (JSON.parse(r.input)?.sku) === sku; } catch { return false; }
      });
      if (!rec) return;
      let suggested: string[] = [];
      try { suggested = JSON.parse(rec.output)?.top || []; } catch { /* n/a */ }
      const taken = suggested.includes(chosenLocationId);
      await this.aiAudit.updateRecommendation(rec.id, { taken, outcome: taken ? `guardado en ${chosenCode} (sugerida)` : `operario eligió ${chosenCode} (no sugerida)` });
      await this.recordAgentAction({ operationId, sellerId, agent: 'putaway_advisor', decision: `sugerencia de guardado ${sku}`, actor: 'operario', orderRef: null, result: taken ? 'ok: sugerencia seguida' : 'ok: sugerencia no seguida', recommendationId: rec.id });
    } catch { /* best-effort */ }
  }

  // ---- Operación ------------------------------------------------------------
  receive(sellerId: string, cmd: ReceiveCommand): Promise<StockMovement> {
    return this.inventory.receive(sellerId, cmd);
  }

  async putaway(sellerId: string, cmd: PutawayCommand): Promise<StockMovement[]> {
    const opId = await this.operationOfSeller(sellerId).catch(() => null);
    const entityId = `${sellerId}:${cmd.sku}:${cmd.fromLocationId}`;
    if (opId) { await this.assertAssignmentAllowed(opId, 'PUTAWAY', entityId, cmd.actor || 'system'); await this.assertAssignmentAllowed(opId, 'RESLOT', entityId, cmd.actor || 'system'); }
    const movs = await this.inventory.putaway(sellerId, cmd);
    // Un guardado desde recepción cierra PUTAWAY; un movimiento entre almacenaje cierra RESLOT.
    if (opId) { await this.completeAssignments('PUTAWAY', [entityId], cmd.actor || 'system'); await this.completeAssignments('RESLOT', [entityId], cmd.actor || 'system'); await this.continuousHook(opId, 'PUTAWAY', null); await this.continuousHook(opId, 'RESLOT', null); }
    return movs;
  }

  getStock(query: StockQuery): Promise<StockBalance[]> {
    return this.inventory.getStock(query);
  }

  listMovements(sellerId: string, limit?: number): Promise<StockMovement[]> {
    return this.inventory.listMovements(sellerId, limit);
  }

  // ---- Registro de actividad por usuario (auditoría operativa) --------------
  /**
   * Reúne QUIÉN hizo QUÉ y CUÁNDO en una operación, cruzando dos libros append-only:
   *  - eventos de orden (ciclo de vida: reservar, iniciar/terminar picking, empacar, despachar, anular);
   *  - movimientos de inventario físicos (recepción, guardado/putaway, traslado, ajuste, devolución).
   * Para no duplicar historia, los movimientos "espejo" del ciclo de orden (RESERVE/RELEASE/PICK/SHIP)
   * NO entran al feed: esa historia ya la cuentan los eventos de orden. La productividad de fulfillment
   * (pickeó/empacó/despachó) sale de los eventos; la física (guardó/recepcionó/ajustó) de los movimientos.
   * Acota por operación y, opcionalmente, por usuario y ventana de fechas.
   */
  async userActivity(
    operationId: string,
    opts?: { userId?: string | null; from?: number | null; to?: number | null; limit?: number },
  ): Promise<{
    window: { fromIso: string | null; toIso: string | null };
    users: { id: string; name: string; role: string }[];
    productivity: Array<{
      userId: string; name: string; role: string;
      allocated: number; pickingStarted: number; picked: number; packed: number; shipped: number; cancelled: number;
      putaways: number; putawayUnits: number; receipts: number; receiptUnits: number; adjustments: number; total: number;
    }>;
    feed: Array<{ at: string; actor: string; actorName: string; role: string; source: 'orden' | 'inventario'; type: string; label: string; detail: string | null; ref: string | null }>;
    totalEvents: number;
  }> {
    const from = opts?.from ?? null;
    const to = opts?.to ?? null;
    const userId = opts?.userId ?? null;
    const limit = Math.max(1, Math.min(opts?.limit ?? 400, 2000));
    const inWindow = (iso: string): boolean => {
      const t = Date.parse(iso);
      if (Number.isNaN(t)) return false;
      if (from != null && t < from) return false;
      if (to != null && t > to) return false;
      return true;
    };

    // Roster de usuarios de la operación (para el filtro y para nombrar actores).
    const roster = await this.listUsers(operationId);
    const nameOf = new Map<string, { name: string; role: string }>();
    for (const u of roster) nameOf.set(u.id, { name: u.name, role: String(u.role) });
    // Alias comunes por email (algunos actores históricos se guardaron como email).
    for (const u of roster) if (u.email) nameOf.set(u.email.toLowerCase(), { name: u.name, role: String(u.role) });
    const resolveActor = (a: string | null | undefined): { id: string; name: string; role: string } => {
      const key = (a || 'system').toString();
      const hit = nameOf.get(key) || nameOf.get(key.toLowerCase());
      if (hit) return { id: key, name: hit.name, role: hit.role };
      if (key === 'system') return { id: 'system', name: 'Sistema', role: 'SYSTEM' };
      if (key === 'copiloto') return { id: 'copiloto', name: 'Copiloto IA', role: 'AI' };
      return { id: key, name: key, role: '' };
    };

    // Mapa ubicaciones → código legible.
    const locs = await this.locations.listByOperation(operationId);
    const locCode = new Map<string, string>();
    for (const l of locs) locCode.set(l.id, l.code);

    const sellerIds = (await this.sellers.list(operationId)).map((s) => s.id);

    const feed: Array<{ at: string; actor: string; actorName: string; role: string; source: 'orden' | 'inventario'; type: string; label: string; detail: string | null; ref: string | null }> = [];
    // Productividad acumulada por actor.
    const prod = new Map<string, { userId: string; name: string; role: string; allocated: number; pickingStarted: number; picked: number; packed: number; shipped: number; cancelled: number; putaways: number; putawayUnits: number; receipts: number; receiptUnits: number; adjustments: number; total: number }>();
    const bucket = (id: string, name: string, role: string) => {
      let b = prod.get(id);
      if (!b) { b = { userId: id, name, role, allocated: 0, pickingStarted: 0, picked: 0, packed: 0, shipped: 0, cancelled: 0, putaways: 0, putawayUnits: 0, receipts: 0, receiptUnits: 0, adjustments: 0, total: 0 }; prod.set(id, b); }
      return b;
    };

    const ORDER_LABEL: Record<string, string> = {
      CREATED: 'Creó la orden', UPDATED: 'Editó la orden', ALLOCATED: 'Reservó stock',
      PICKING: 'Inició picking', PICKED: 'Terminó picking', PACKED: 'Empacó',
      LABELED: 'Generó etiqueta', SHIPPED: 'Despachó', CANCELLED: 'Anuló', REACTIVATED: 'Reactivó',
    };

    // 1) Eventos de orden (ciclo de vida).
    for (const sid of sellerIds) {
      const orders = await this.orders.listOrders(sid);
      for (const o of orders) {
        const ref = o.externalOrderId || o.id;
        for (const ev of o.events || []) {
          if (!inWindow(ev.at)) continue;
          const who = resolveActor(ev.actor);
          if (userId && who.id !== userId) continue;
          feed.push({ at: ev.at, actor: who.id, actorName: who.name, role: who.role, source: 'orden', type: ev.type, label: ORDER_LABEL[ev.type] || ev.type, detail: ev.detail ?? null, ref });
          const b = bucket(who.id, who.name, who.role);
          if (ev.type === 'ALLOCATED') b.allocated += 1;
          else if (ev.type === 'PICKING') b.pickingStarted += 1;
          else if (ev.type === 'PICKED') b.picked += 1;
          else if (ev.type === 'PACKED') b.packed += 1;
          else if (ev.type === 'SHIPPED') b.shipped += 1;
          else if (ev.type === 'CANCELLED') b.cancelled += 1;
          b.total += 1;
        }
      }
    }

    // 2) Movimientos físicos (recepción, guardado, traslado, ajuste, devolución).
    //    Los movimientos con groupId (putaway/traslado tienen 2 patas) se colapsan a 1 evento.
    const seenGroup = new Set<string>();
    const FEED_MOV = new Set(['RECEIPT', 'PUTAWAY', 'TRANSFER', 'ADJUSTMENT', 'RETURN']);
    for (const sid of sellerIds) {
      const movs = await this.listMovements(sid, 1_000_000);
      // Índice por grupo para reconstruir origen→destino.
      const byGroup = new Map<string, StockMovement[]>();
      for (const m of movs) if (m.groupId) { const arr = byGroup.get(m.groupId) || []; arr.push(m); byGroup.set(m.groupId, arr); }
      for (const m of movs) {
        if (!FEED_MOV.has(String(m.type))) continue; // omite espejos del ciclo de orden
        if (!inWindow(m.occurredAt)) continue;
        const who = resolveActor(m.actor);
        if (userId && who.id !== userId) continue;
        // Colapsa las 2 patas de un grupo en un único evento.
        if (m.groupId) {
          if (seenGroup.has(m.groupId)) continue;
          seenGroup.add(m.groupId);
        }
        const b = bucket(who.id, who.name, who.role);
        let label = 'Movimiento'; let detail: string | null = null; const ref = m.reference || m.sku;
        const units = Math.abs(m.qtyDelta);
        if (m.type === 'RECEIPT') {
          label = 'Recepcionó'; detail = `${m.sku} · +${units} un · ${locCode.get(m.locationId) || m.locationId}`;
          b.receipts += 1; b.receiptUnits += units;
        } else if (m.type === 'PUTAWAY') {
          const legs = m.groupId ? byGroup.get(m.groupId) || [m] : [m];
          const fromLeg = legs.find((x) => x.qtyDelta < 0); const toLeg = legs.find((x) => x.qtyDelta > 0) || m;
          const u = Math.abs(toLeg.qtyDelta);
          label = 'Guardó en ubicación';
          detail = `${m.sku} · ${u} un · ${fromLeg ? (locCode.get(fromLeg.locationId) || fromLeg.locationId) + ' → ' : ''}${locCode.get(toLeg.locationId) || toLeg.locationId}`;
          b.putaways += 1; b.putawayUnits += u;
        } else if (m.type === 'TRANSFER') {
          const legs = m.groupId ? byGroup.get(m.groupId) || [m] : [m];
          const fromLeg = legs.find((x) => x.qtyDelta < 0); const toLeg = legs.find((x) => x.qtyDelta > 0) || m;
          label = 'Trasladó';
          detail = `${m.sku} · ${Math.abs(toLeg.qtyDelta)} un · ${fromLeg ? (locCode.get(fromLeg.locationId) || fromLeg.locationId) + ' → ' : ''}${locCode.get(toLeg.locationId) || toLeg.locationId}`;
        } else if (m.type === 'ADJUSTMENT') {
          label = 'Ajustó inventario'; detail = `${m.sku} · ${m.qtyDelta > 0 ? '+' : ''}${m.qtyDelta} un · ${locCode.get(m.locationId) || m.locationId}`;
          b.adjustments += 1;
        } else if (m.type === 'RETURN') {
          label = 'Ingresó devolución'; detail = `${m.sku} · +${units} un · ${locCode.get(m.locationId) || m.locationId}`;
        }
        feed.push({ at: m.occurredAt, actor: who.id, actorName: who.name, role: who.role, source: 'inventario', type: String(m.type), label, detail, ref });
        b.total += 1;
      }
    }

    feed.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    const totalEvents = feed.length;
    const productivity = Array.from(prod.values())
      .filter((p) => p.userId !== 'system' || p.total > 0)
      .sort((a, b) => b.total - a.total);

    return {
      window: { fromIso: from != null ? new Date(from).toISOString() : null, toIso: to != null ? new Date(to).toISOString() : null },
      users: roster.map((u) => ({ id: u.id, name: u.name, role: String(u.role) })),
      productivity,
      feed: feed.slice(0, limit),
      totalEvents,
    };
  }

  // ---- Órdenes de recepción (inbound) ---------------------------------------
  async createReceipt(sellerId: string, input: CreateReceiptInput, actor?: string): Promise<ReceiptOrder> {
    const order = await this.receipts.create(sellerId, input, actor);
    // Auto-balanceo continuo: la recepción entra al pool RECEIVE.
    const opId = await this.operationOfSeller(sellerId).catch(() => null);
    const units = (order.lines || []).reduce((s, l) => s + Math.max(0, l.expectedQty - (l.receivedQty || 0)), 0);
    await this.continuousHook(opId, 'RECEIVE', { entityId: order.id, entityRef: order.reference || order.id, sellerId, unidades: units });
    // Ledger: abre la tarea de RECEIVE (cotejo) de la recepción.
    if (opId) await this.openTask(opId, { type: 'RECEIVE', sellerId, orderId: null, orderRef: order.reference || order.id, entityId: order.id, entityRef: order.reference || order.id, unitsEstimate: units, by: actor || 'system' });
    return order;
  }
  updateReceipt(sellerId: string, orderId: string, input: CreateReceiptInput, actor?: string): Promise<ReceiptOrder> {
    return this.receipts.update(sellerId, orderId, input, actor);
  }
  /** Cotejo: registra el físico recibido por línea (postea el stock contado). */
  async receiveReceipt(sellerId: string, orderId: string, counts: ReceiptCountInput[], actor?: string): Promise<ReceiptOrder> {
    // Camino B: en modo estricto, no recibir una recepción asignada a otro operario.
    const opId = await this.operationOfSeller(sellerId).catch(() => null);
    if (opId) await this.assertAssignmentAllowed(opId, 'RECEIVE', orderId, actor || 'system');
    const order = await this.receipts.receive(sellerId, orderId, counts, actor);
    // Dispara reception.received a las suscripciones que matcheen (sin bloquear).
    void this.dispatchWebhook('reception.received', sellerId, { orderId, counts });
    // Cierra la asignación de recepción cuando la orden queda RECIBIDA (cotejo completo).
    if (opId && order.status === 'RECEIVED') {
      await this.completeAssignments('RECEIVE', [orderId], actor || 'system'); await this.continuousHook(opId, 'RECEIVE', null);
      await this.advanceTask(opId, 'RECEIVE', order.id, { state: 'done', by: actor || 'system' }); // ledger: cotejo completo
    }
    // La mercadería recibida entra al pool de guardado → repartir si hay auto-balanceo.
    if (opId) await this.continuousHook(opId, 'PUTAWAY', null);
    return order;
  }
  /** Cierra la orden como recibida aunque falte mercadería (parcial). */
  closeReceipt(sellerId: string, orderId: string, actor?: string): Promise<ReceiptOrder> {
    return this.receipts.close(sellerId, orderId, actor);
  }
  deleteReceipt(sellerId: string, orderId: string, actor?: string): Promise<{ ok: true; id: string }> {
    return this.receipts.remove(sellerId, orderId, actor);
  }
  getReceipt(sellerId: string, orderId: string): Promise<ReceiptOrder | null> {
    return this.receipts.get(sellerId, orderId);
  }
  listReceipts(sellerId: string): Promise<ReceiptOrder[]> {
    return this.receipts.list(sellerId);
  }

  // ---- Devoluciones (logística reversa) -------------------------------------
  async createReturn(sellerId: string, input: CreateReturnInput, actor?: string): Promise<ReturnOrder> {
    await this.assertFeature(await this.operationOfSeller(sellerId).catch(() => null), 'returns', 'Las devoluciones');
    return this.returnsService.createFromOrder(sellerId, input, actor);
  }
  processReturn(sellerId: string, returnId: string, input: ProcessReturnInput, actor?: string): Promise<ReturnOrder> {
    return this.returnsService.process(sellerId, returnId, input, actor);
  }
  cancelReturn(sellerId: string, returnId: string, actor?: string): Promise<ReturnOrder> {
    return this.returnsService.cancel(sellerId, returnId, actor);
  }
  getReturn(sellerId: string, returnId: string): Promise<ReturnOrder | null> {
    return this.returnsService.get(sellerId, returnId);
  }
  listReturns(sellerId: string): Promise<ReturnOrder[]> {
    return this.returnsService.list(sellerId);
  }

  // ---- Órdenes (Fase de órdenes + reserva) ----------------------------------
  async createOrder(sellerId: string, input: CreateOrderInput, actor?: string): Promise<SalesOrder> {
    // Idempotencia (G1): un reintento con el mismo externalOrderId devuelve la orden
    // existente y NO consume cuota del plan (no es una orden nueva).
    if (input.externalOrderId) {
      const existing = await this.orders.findByExternal(sellerId, input.externalOrderId);
      if (existing) return existing;
    }
    await this.assertQuotaBySeller(sellerId, 'ordersPerMonth');
    const order = await this.orders.createOrder(sellerId, input, actor);
    // Reserva inmediata al ingreso si el cliente está configurado para ello (sin revisión).
    // Best-effort: si no hay stock suficiente, la orden queda RECEIVED para revisión/espera.
    const seller = await this.sellers.findById(sellerId).catch(() => null);
    if (seller?.autoAllocateOnIngest && order.status === OrderStatus.RECEIVED) {
      try { return await this.allocateOrder(sellerId, order.id, actor || 'auto-reserva'); }
      catch { /* sin stock suficiente: se deja RECEIVED */ }
    }
    return order;
  }

  /** Edita una orden aún en estado RECEIVED (antes de reservar stock). */
  updateOrder(sellerId: string, orderId: string, input: CreateOrderInput, actor?: string): Promise<SalesOrder> {
    return this.orders.updateOrder(sellerId, orderId, input, actor);
  }

  /**
   * Dispara el webhook del EVENTO DE ORDEN correspondiente al estado resultante
   * (reservada/en picking/pickeada/despachada/cancelada). Fire-and-forget.
   */
  private fireOrderWebhook(sellerId: string, order: SalesOrder): void {
    const ev: Record<string, WebhookEventType> = {
      ALLOCATED: 'order.allocated',
      PICKING: 'order.picking',
      PICKED: 'order.picked',
      PACKED: 'order.packed',
      SHIPPED: 'order.shipped',
      CANCELLED: 'order.cancelled',
    };
    const type = ev[order.status];
    if (type) void this.dispatchWebhook(type, sellerId, { orderId: order.id, order });
  }

  async allocateOrder(sellerId: string, orderId: string, actor?: string): Promise<SalesOrder> {
    const order = await this.orders.allocate(sellerId, orderId, actor);
    this.fireOrderWebhook(sellerId, order); // order.allocated
    // Auto-balanceo continuo: la orden entra a la cola de picking → asignarla ya.
    if (order.status === OrderStatus.ALLOCATED) {
      const opId = await this.operationOfSeller(sellerId).catch(() => null);
      const units = (order.lines || []).reduce((s, l) => s + l.qty, 0);
      await this.continuousHook(opId, 'PICK', { entityId: order.id, entityRef: order.externalOrderId || order.id, sellerId, unidades: units });
      // Ledger: la RESERVA es una tarea instantánea (queda done) y abre la tarea de PICK.
      if (opId) {
        await this.recordDoneTask(opId, { type: 'RESERVE', sellerId, orderId: order.id, orderRef: order.externalOrderId || order.id, entityId: order.id, entityRef: order.externalOrderId || order.id, unitsEstimate: units, by: actor || 'system' });
        await this.openTask(opId, { type: 'PICK', sellerId, orderId: order.id, orderRef: order.externalOrderId || order.id, entityId: order.id, entityRef: order.externalOrderId || order.id, unitsEstimate: units, by: actor || 'system' });
      }
    }
    return order;
  }

  /**
   * Cola de preparación (picking): las órdenes LISTAS para pickear, en orden FORZADO.
   * Solo órdenes reservadas (ALLOCATED) o ya en curso (PICKING).
   * Orden: (1) prioridad de courier según seller.courierPriority — el primero de la lista
   * va antes; los couriers no listados van al final; (2) antigüedad del pedido (FIFO,
   * el más antiguo primero). Si el seller no define prioridad de courier, queda FIFO puro.
   * Devuelve cada orden con su posición en la cola y el rank de courier aplicado.
   */
  async getPickingQueue(sellerId: string): Promise<Array<SalesOrder & { queuePosition: number; courierRank: number }>> {
    const seller = await this.sellers.findById(sellerId);
    const priority = (seller?.courierPriority ?? []).map((c) => this.normCourier(c));
    const rankOf = (carrier: string | null): number => {
      const n = this.normCourier(carrier || '');
      if (!n) return priority.length + 1; // sin courier: después de los priorizados
      const i = priority.indexOf(n);
      return i >= 0 ? i : priority.length; // no listado: al final (antes que "sin courier")
    };
    const all = await this.orders.listOrders(sellerId);
    const ready = all.filter((o) => o.status === OrderStatus.ALLOCATED || o.status === OrderStatus.PICKING);
    ready.sort((a, b) => {
      const ra = rankOf(a.carrier), rb = rankOf(b.carrier);
      if (ra !== rb) return ra - rb;
      // FIFO: más antiguo primero.
      if (a.createdAt < b.createdAt) return -1;
      if (a.createdAt > b.createdAt) return 1;
      return 0;
    });
    return ready.map((o, idx) => ({ ...o, queuePosition: idx + 1, courierRank: rankOf(o.carrier) }));
  }

  /** Normaliza el nombre de un courier para comparar (minúsculas, sin espacios ni signos). */
  private normCourier(s: string): string {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]/g, '');
  }

  /**
   * Reserva de stock MASIVA. Reserva varias órdenes en una sola operación.
   * - Si `orderIds` viene, reserva solo esas; si no, todas las órdenes en estado RECEIVED.
   * - Cada orden se reserva de forma independiente y atómica (allocate hace rollback
   *   por orden si le falta stock), así que una falla no bloquea al resto.
   * Devuelve un resumen: reservadas, sin stock/omitidas y el detalle por orden.
   */
  async allocateOrders(
    sellerId: string,
    orderIds: string[] | null,
    actor?: string,
  ): Promise<{
    solicitadas: number;
    reservadas: number;
    conError: number;
    reserved: { id: string; orden: string; unidades: number }[];
    failed: { id: string; orden: string; motivo: string }[];
  }> {
    const all = await this.orders.listOrders(sellerId);
    let targets: SalesOrder[];
    if (orderIds && orderIds.length) {
      const set = new Set(orderIds);
      targets = all.filter((o) => set.has(o.id));
    } else {
      // Por defecto: todas las que están listas para reservar (RECEIVED).
      targets = all.filter((o) => o.status === OrderStatus.RECEIVED);
    }
    const reserved: { id: string; orden: string; unidades: number }[] = [];
    const failed: { id: string; orden: string; motivo: string }[] = [];
    for (const o of targets) {
      const label = o.externalOrderId || o.id;
      if (o.status !== OrderStatus.RECEIVED) {
        failed.push({ id: o.id, orden: label, motivo: `No está lista para reservar (estado: ${o.status}).` });
        continue;
      }
      try {
        const done = await this.allocateOrder(sellerId, o.id, actor);
        const units = (done.lines || []).reduce((a, l) => a + (l.qty || 0), 0);
        reserved.push({ id: o.id, orden: label, unidades: units });
      } catch (e) {
        failed.push({ id: o.id, orden: label, motivo: (e as Error).message });
      }
    }
    return {
      solicitadas: targets.length,
      reservadas: reserved.length,
      conError: failed.length,
      reserved,
      failed,
    };
  }

  async cancelOrder(sellerId: string, orderId: string, actor?: string): Promise<SalesOrder> {
    const order = await this.orders.cancel(sellerId, orderId, actor);
    this.fireOrderWebhook(sellerId, order); // order.cancelled
    return order;
  }
  async reactivateOrder(sellerId: string, orderId: string, actor?: string): Promise<SalesOrder> {
    const order = await this.orders.reactivate(sellerId, orderId, actor);
    this.fireOrderWebhook(sellerId, order);
    return order;
  }

  // ---- Picking y despacho ---------------------------------------------------
  getPickList(sellerId: string, orderId: string): Promise<PickTask[]> {
    return this.orders.pickList(sellerId, orderId);
  }

  async confirmPick(sellerId: string, orderId: string, actor?: string): Promise<SalesOrder> {
    // Camino B: en modo estricto, no dejar pickear una orden asignada a otro operario.
    const opId = await this.operationOfSeller(sellerId).catch(() => null);
    if (opId) await this.assertAssignmentAllowed(opId, 'PICK', orderId, actor || 'system');
    const order = await this.orders.confirmPick(sellerId, orderId, actor);
    this.fireOrderWebhook(sellerId, order); // order.picked (o en picking según estado)
    if (opId) {
      await this.completeAssignments('PICK', [orderId], actor || 'system'); await this.continuousHook(opId, 'PICK', null);
      // Ledger: PICK completo → cierra PICK y abre PACK.
      if (order.status === OrderStatus.PICKED) {
        await this.advanceTask(opId, 'PICK', order.id, { state: 'done', by: actor || 'system' });
        await this.openTask(opId, { type: 'PACK', sellerId, orderId: order.id, orderRef: order.externalOrderId || order.id, entityId: order.id, entityRef: order.externalOrderId || order.id, unitsEstimate: (order.lines || []).reduce((s, l) => s + l.qty, 0), by: actor || 'system' });
      } else {
        await this.advanceTask(opId, 'PICK', order.id, { state: 'in_progress', by: actor || 'system' });
      }
    }
    return order;
  }

  /** Inicia el picking de una orden reservada: ALLOCATED → PICKING (sin recolectar aún). */
  async startPicking(sellerId: string, orderId: string, actor?: string): Promise<SalesOrder> {
    const order = await this.orders.startPicking(sellerId, orderId, actor);
    this.fireOrderWebhook(sellerId, order); // order.picking
    const opId = await this.operationOfSeller(sellerId).catch(() => null);
    if (opId) await this.advanceTask(opId, 'PICK', order.id, { state: 'in_progress', by: actor || 'system' });
    return order;
  }

  /** Confirma el picking de una ubicación específica de la orden (picking dirigido). */
  async pickTask(
    sellerId: string,
    orderId: string,
    input: { sku: string; locationId: string; lot?: string | null; qty?: number },
    actor?: string,
  ): Promise<SalesOrder> {
    const order = await this.orders.pickTask(sellerId, orderId, input, actor);
    this.fireOrderWebhook(sellerId, order); // order.picking (parcial) u order.picked (completo)
    return order;
  }

  /**
   * Empaca la orden (PICKED → PACKED). Al empacar:
   *   1) dispara el webhook order.packed (notifica al OMS de Ninja), y
   *   2) conecta con el OMS para traer el tracking del transporte + las etiquetas de
   *      cada bulto, que quedan guardadas en la orden para verse/imprimirse en packing.
   * Si el OMS no responde, la orden queda empacada con etiquetas en ERROR (reintentables).
   */
  async packOrder(
    sellerId: string,
    orderId: string,
    input: { bultos?: number; materials?: { sku: string; qty: number }[] } = {},
    actor?: string,
  ): Promise<SalesOrder> {
    // Insumos de embalaje consumidos (opcional). Se validan ANTES de empacar; el stock
    // se descuenta DESPUÉS de que el empaque quedó confirmado, para no consumir en falso.
    // Camino B: en modo estricto, no dejar empacar una orden asignada a otro operario.
    const opId = await this.operationOfSeller(sellerId).catch(() => null);
    if (opId) await this.assertAssignmentAllowed(opId, 'PACK', orderId, actor || 'system');
    let prepared: { used: { sku: string; name: string; qty: number }[]; movements: any[] } = { used: [], movements: [] };
    if (this.packaging && input.materials && input.materials.length) {
      const seller = await this.sellers.findById(sellerId);
      if (!seller) throw new NotFoundError(`Seller no encontrado: ${sellerId}`);
      prepared = await this.packaging.resolveUse(seller.operationId, sellerId, orderId, input.materials, actor);
    }
    const packed = await this.orders.packOrder(sellerId, orderId, { bultos: input.bultos, materials: prepared.used }, actor);
    if (this.packaging && prepared.movements.length) await this.packaging.commit(prepared.movements);
    this.fireOrderWebhook(sellerId, packed); // order.packed → OMS
    if (opId) {
      await this.completeAssignments('PACK', [orderId], actor || 'system'); await this.continuousHook(opId, 'PACK', null);
      // Ledger: PACK completo → cierra PACK y abre SHIP.
      await this.advanceTask(opId, 'PACK', packed.id, { state: 'done', by: actor || 'system' });
      await this.openTask(opId, { type: 'SHIP', sellerId, orderId: packed.id, orderRef: packed.externalOrderId || packed.id, entityId: packed.id, entityRef: packed.externalOrderId || packed.id, unitsEstimate: (packed.lines || []).reduce((s, l) => s + l.qty, 0), by: actor || 'system' });
    }
    // Conecta con el OMS para obtener tracking + etiquetas (síncrono en la demo).
    return this.pullShippingLabels(sellerId, packed, actor);
  }

  // ---- Insumos de embalaje (packaging, nivel operación) ---------------------
  async createPackaging(operationId: string, input: { sku: string; name: string; barcode?: string | null; unitPrice?: number; active?: boolean }) {
    if (!this.packaging) throw new ValidationError('Embalaje no disponible');
    await this.assertFeature(operationId, 'packaging_materials', 'Los insumos de embalaje');
    return this.packaging.createMaterial(operationId, input);
  }
  updatePackaging(operationId: string, sku: string, patch: { name?: string; barcode?: string | null; unitPrice?: number; active?: boolean }) {
    if (!this.packaging) throw new ValidationError('Embalaje no disponible');
    return this.packaging.updateMaterial(operationId, sku, patch);
  }
  setPackagingSellerPrice(operationId: string, sku: string, sellerId: string, price: number | null) {
    if (!this.packaging) throw new ValidationError('Embalaje no disponible');
    return this.packaging.setSellerPrice(operationId, sku, sellerId, price);
  }
  listPackaging(operationId: string) {
    if (!this.packaging) return Promise.resolve([]);
    return this.packaging.listMaterials(operationId);
  }
  receivePackagingStock(operationId: string, sku: string, qty: number, actor?: string, reference?: string | null, unitCost?: number | null) {
    if (!this.packaging) throw new ValidationError('Embalaje no disponible');
    return this.packaging.receiveStock(operationId, sku, qty, actor, reference ?? null, unitCost ?? null);
  }
  adjustPackagingStock(operationId: string, sku: string, qtyDelta: number, actor?: string, reference?: string | null) {
    if (!this.packaging) throw new ValidationError('Embalaje no disponible');
    return this.packaging.adjustStock(operationId, sku, qtyDelta, actor, reference ?? null);
  }
  listPackagingMovements(operationId: string, filter?: { materialSku?: string; sellerId?: string }) {
    if (!this.packaging) return Promise.resolve([]);
    return this.packaging.listMovements(operationId, filter);
  }

  /**
   * Consulta al OMS las etiquetas de una orden empacada y las adjunta (o marca error).
   * Reutilizable como reintento manual desde el panel de packing.
   */
  async pullShippingLabels(sellerId: string, order: SalesOrder, actor?: string): Promise<SalesOrder> {
    const bultos = order.packing?.bultos ?? 1;
    try {
      const result = await this.shippingLabels.fetchLabels({ sellerId, order, bultos });
      return await this.orders.attachShippingLabels(
        sellerId,
        order.id,
        { ...result, source: 'oms-ninja' },
        actor,
      );
    } catch (e) {
      const msg = (e as Error)?.message || 'El OMS no entregó las etiquetas';
      return this.orders.markLabelError(sellerId, order.id, msg);
    }
  }

  /** Reintenta traer las etiquetas del OMS para una orden ya empacada. */
  async fetchShippingLabels(sellerId: string, orderId: string, actor?: string): Promise<SalesOrder> {
    const order = await this.orders.getOrder(sellerId, orderId);
    if (!order) throw new NotFoundError(`Orden no encontrada: ${orderId}`);
    return this.pullShippingLabels(sellerId, order, actor);
  }

  /**
   * Callback del OMS (inbound): adjunta manualmente el tracking + etiquetas que envía
   * el OMS de Ninja para una orden empacada.
   */
  async attachShippingLabels(
    sellerId: string,
    orderId: string,
    input: AttachLabelsInput,
    actor?: string,
  ): Promise<SalesOrder> {
    return this.orders.attachShippingLabels(sellerId, orderId, { ...input, source: input.source ?? 'manual' }, actor);
  }

  async shipOrder(
    sellerId: string,
    orderId: string,
    input: { carrier?: string | null; trackingNumber?: string | null },
    actor?: string,
  ): Promise<SalesOrder> {
    // Camino B: en modo estricto, no dejar despachar una orden asignada a otro operario.
    const opId = await this.operationOfSeller(sellerId).catch(() => null);
    if (opId) await this.assertAssignmentAllowed(opId, 'SHIP', orderId, actor || 'system');
    const order = await this.orders.ship(sellerId, orderId, input, actor);
    this.fireOrderWebhook(sellerId, order); // order.shipped
    if (opId) {
      await this.completeAssignments('SHIP', [orderId], actor || 'system'); await this.continuousHook(opId, 'SHIP', null);
      await this.advanceTask(opId, 'SHIP', order.id, { state: 'done', by: actor || 'system' }); // ledger: despacho completo
    }
    return order;
  }

  getOrder(sellerId: string, orderId: string): Promise<SalesOrder | null> {
    return this.orders.getOrder(sellerId, orderId);
  }

  listOrders(sellerId: string): Promise<SalesOrder[]> {
    return this.orders.listOrders(sellerId);
  }

  // ---- Idempotencia de órdenes: auditoría y consolidación de duplicados (G1) --
  /**
   * Audita duplicados por (sellerId, externalOrderId) con count > 1 en una operación.
   * Devuelve cada grupo con sus ids de orden, ordenados del más antiguo al más nuevo.
   */
  async auditDuplicateOrders(operationId: string): Promise<{ groups: Array<{ sellerId: string; externalOrderId: string; count: number; orderIds: string[] }>; totalDuplicates: number }> {
    const sellers = await this.sellers.list(operationId);
    const groups: Array<{ sellerId: string; externalOrderId: string; count: number; orderIds: string[] }> = [];
    let totalDuplicates = 0;
    for (const s of sellers) {
      const orders = await this.orders.listOrders(s.id);
      const byExt = new Map<string, SalesOrder[]>();
      for (const o of orders) {
        if (!o.externalOrderId) continue;
        const arr = byExt.get(o.externalOrderId) || [];
        arr.push(o);
        byExt.set(o.externalOrderId, arr);
      }
      for (const [ext, arr] of byExt) {
        if (arr.length <= 1) continue;
        arr.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
        groups.push({ sellerId: s.id, externalOrderId: ext, count: arr.length, orderIds: arr.map((o) => o.id) });
        totalDuplicates += arr.length - 1; // los que sobran (se conservaría 1)
      }
    }
    return { groups, totalDuplicates };
  }

  /**
   * Consolida duplicados: por cada grupo (sellerId, externalOrderId) conserva la orden
   * MÁS ANTIGUA y elimina las demás (los reintentos del webhook crean copias sin procesar).
   * Devuelve cuántas órdenes se eliminaron.
   */
  async consolidateDuplicateOrders(operationId: string): Promise<{ groups: number; removed: number }> {
    const audit = await this.auditDuplicateOrders(operationId);
    let removed = 0;
    for (const g of audit.groups) {
      const [, ...extras] = g.orderIds; // conserva el primero (más antiguo)
      for (const id of extras) {
        await this.orders.delete(g.sellerId, id);
        removed += 1;
      }
    }
    return { groups: audit.groups.length, removed };
  }
}
