/**
 * Implementaciones en-memoria de los puertos del dominio.
 * Se usan en los tests y para un arranque rápido sin base de datos.
 * En producción, las reemplaza la implementación Prisma (misma interfaz).
 */
import { PlanConfig } from '../../domain/plans';
import { toDomainEvents } from '../../domain/domain-events';
import {
  AuthTokenRepository,
  CountAuditRepository,
  EventRepository,
  RollupRepository,
  LaborTaskRepository,
  CostRepository,
  AiAuditRepository,
  WorkAssignmentRepository,
  WorkTaskRepository,
  AgentRuleConfigRepository,
  AgentAlertRepository,
  PlanConfigRepository,
  Clock,
  IdGenerator,
  LocationRepository,
  LoginEventRepository,
  LotRepository,
  SerialRepository,
  PackagingRepository,
  BrandingRepository,
  OpsChannelRepository,
  AiConfigRepository,
  AiCredential,
  CopilotSettingsRepository,
  CopilotSettings,
  MovementRepository,
  OperationRepository,
  OrderRepository,
  PackRepository,
  ProductLogRepository,
  AssemblyLogRepository,
  BillingRepository,
  InvoiceDocumentBlob,
  ChatRepository,
  AnnouncementRepository,
  ReceiptOrderRepository,
  ReturnOrderRepository,
  SellerRepository,
  SkuRepository,
  StockQuery,
  UserRepository,
  WebhookRepository,
} from '../../domain/ports';
import {
  Announcement,
  AnnouncementClick,
  AuthToken,
  AuthTokenKind,
  CountAudit,
  DomainEvent,
  DomainEntityType,
  DailyInventorySnapshot,
  DailyDemand,
  DailyMetricRollup,
  LaborTask,
  CostRateCard,
  WorkAssignment,
  WorkTaskType,
  WorkAssignmentStatus,
  WorkTask,
  WorkTaskStage,
  WorkTaskState,
  AgentRuleConfig,
  AgentAlert,
  AiRecommendation,
  AgentAction,
  Location,
  LoginEvent,
  Lot,
  Serial,
  PackagingMaterial,
  PackagingMovement,
  OperationBranding,
  OpsMessage,
  OpsAudioBlob,
  OpsThreadRead,
  Operation,
  PackConfig,
  ProductLogEntry,
  AssemblyRecord,
  BillingInvoice,
  BillingRate,
  ChatMessage,
  ChatReadState,
  ReceiptOrder,
  ReturnOrder,
  SalesOrder,
  Seller,
  Sku,
  StockBalance,
  StockMovement,
  User,
  Webhook,
  WebhookDelivery,
} from '../../domain/types';

export class InMemoryMovementRepository implements MovementRepository {
  private readonly log: StockMovement[] = [];
  // Índices para que las consultas sean O(coincidencias), no O(todo el ledger).
  // Sin esto, con decenas de miles de órdenes las lecturas de stock son O(n²).
  private readonly bySeller = new Map<string, StockMovement[]>();
  private readonly bySellerSku = new Map<string, StockMovement[]>();
  // Ocupación física por ubicación (suma de deltas, cross-seller), incremental.
  private readonly occ = new Map<string, number>();

  async append(movements: StockMovement[]): Promise<void> {
    // Append-only: solo agregamos, nunca mutamos lo existente.
    for (const m of movements) {
      const copy = { ...m };
      this.log.push(copy);
      let a = this.bySeller.get(m.sellerId);
      if (!a) { a = []; this.bySeller.set(m.sellerId, a); }
      a.push(copy);
      const sk = `${m.sellerId}|${m.sku}`;
      let b = this.bySellerSku.get(sk);
      if (!b) { b = []; this.bySellerSku.set(sk, b); }
      b.push(copy);
      this.occ.set(m.locationId, (this.occ.get(m.locationId) ?? 0) + m.qtyDelta);
    }
  }

  /** Elige el índice más estrecho para la consulta. */
  private scope(query: StockQuery): StockMovement[] {
    if (query.sku) return this.bySellerSku.get(`${query.sellerId}|${query.sku}`) || [];
    return this.bySeller.get(query.sellerId) || [];
  }

  async balances(query: StockQuery): Promise<StockBalance[]> {
    const buckets = new Map<string, StockBalance>();
    for (const m of this.scope(query)) {
      if (query.locationId && m.locationId !== query.locationId) continue;
      const key = `${m.sku}|${m.locationId}|${m.lot ?? ''}|${m.state}`;
      const existing = buckets.get(key);
      if (existing) {
        existing.qty += m.qtyDelta;
      } else {
        buckets.set(key, {
          sellerId: m.sellerId,
          sku: m.sku,
          locationId: m.locationId,
          lot: m.lot,
          state: m.state,
          qty: m.qtyDelta,
        });
      }
    }
    let result = [...buckets.values()];
    if (!query.includeZeros) result = result.filter((b) => b.qty !== 0);
    return result;
  }

  async find(query: StockQuery): Promise<StockMovement[]> {
    return this.scope(query)
      .filter((m) => !query.locationId || m.locationId === query.locationId)
      .map((m) => ({ ...m }));
  }

  async occupancyByLocation(): Promise<Record<string, number>> {
    const acc: Record<string, number> = {};
    for (const [loc, qty] of this.occ) acc[loc] = qty;
    return acc;
  }

  /** Solo para tests: expone el ledger crudo. */
  all(): StockMovement[] {
    return [...this.log];
  }
}

export class InMemoryOperationRepository implements OperationRepository {
  private readonly store = new Map<string, Operation>();
  async findById(id: string): Promise<Operation | null> {
    return this.store.get(id) ?? null;
  }
  async save(op: Operation): Promise<void> {
    this.store.set(op.id, { ...op });
  }
  async list(): Promise<Operation[]> {
    return [...this.store.values()].map((o) => ({ ...o }));
  }
}

export class InMemorySellerRepository implements SellerRepository {
  private readonly store = new Map<string, Seller>();
  async findById(id: string): Promise<Seller | null> {
    return this.store.get(id) ?? null;
  }
  async save(seller: Seller): Promise<void> {
    this.store.set(seller.id, { ...seller });
  }
  async list(operationId: string): Promise<Seller[]> {
    return [...this.store.values()].filter((s) => s.operationId === operationId).map((s) => ({ ...s }));
  }
}

export class InMemorySkuRepository implements SkuRepository {
  private readonly store = new Map<string, Sku>();
  private key(sellerId: string, sku: string) {
    return `${sellerId}::${sku}`; // scoped al seller: sin colisiones entre clientes
  }
  async find(sellerId: string, sku: string): Promise<Sku | null> {
    return this.store.get(this.key(sellerId, sku)) ?? null;
  }
  async save(sku: Sku): Promise<void> {
    this.store.set(this.key(sku.sellerId, sku.sku), { ...sku });
  }
  async list(sellerId: string): Promise<Sku[]> {
    return [...this.store.values()].filter((s) => s.sellerId === sellerId).map((s) => ({ ...s }));
  }
}

export class InMemoryLotRepository implements LotRepository {
  private readonly store = new Map<string, Lot>();
  private key(sellerId: string, sku: string, lot: string) {
    return `${sellerId}::${sku}::${lot}`;
  }
  async upsert(lot: Lot): Promise<void> {
    this.store.set(this.key(lot.sellerId, lot.sku, lot.lot), { ...lot });
  }
  async get(sellerId: string, sku: string, lot: string): Promise<Lot | null> {
    return this.store.get(this.key(sellerId, sku, lot)) ?? null;
  }
  async list(sellerId: string, sku: string): Promise<Lot[]> {
    return [...this.store.values()]
      .filter((l) => l.sellerId === sellerId && l.sku === sku)
      .map((l) => ({ ...l }));
  }
}

export class InMemoryBrandingRepository implements BrandingRepository {
  private readonly store = new Map<string, OperationBranding>();
  async get(operationId: string): Promise<OperationBranding | null> {
    const b = this.store.get(operationId);
    return b ? { ...b } : null;
  }
  async save(branding: OperationBranding): Promise<void> {
    this.store.set(branding.operationId, { ...branding });
  }
}

export class InMemoryPackagingRepository implements PackagingRepository {
  private readonly materials = new Map<string, PackagingMaterial>();
  private readonly movements: PackagingMovement[] = [];
  private key(operationId: string, sku: string) { return `${operationId}::${sku}`; }
  async saveMaterial(m: PackagingMaterial): Promise<void> {
    this.materials.set(this.key(m.operationId, m.sku), { ...m, sellerPrices: { ...m.sellerPrices } });
  }
  async getMaterial(operationId: string, sku: string): Promise<PackagingMaterial | null> {
    const m = this.materials.get(this.key(operationId, sku));
    return m ? { ...m, sellerPrices: { ...m.sellerPrices } } : null;
  }
  async listMaterials(operationId: string): Promise<PackagingMaterial[]> {
    return [...this.materials.values()].filter((m) => m.operationId === operationId).map((m) => ({ ...m, sellerPrices: { ...m.sellerPrices } }));
  }
  async findByBarcode(operationId: string, barcode: string): Promise<PackagingMaterial | null> {
    const m = [...this.materials.values()].find((x) => x.operationId === operationId && x.barcode === barcode);
    return m ? { ...m, sellerPrices: { ...m.sellerPrices } } : null;
  }
  async appendMovements(movements: PackagingMovement[]): Promise<void> {
    for (const mv of movements) this.movements.push({ ...mv });
  }
  async listMovements(operationId: string, filter?: { materialSku?: string; sellerId?: string }): Promise<PackagingMovement[]> {
    return this.movements
      .filter((mv) => mv.operationId === operationId
        && (filter?.materialSku === undefined || mv.materialSku === filter.materialSku)
        && (filter?.sellerId === undefined || mv.sellerId === filter.sellerId))
      .map((mv) => ({ ...mv }));
  }
}

export class InMemoryCopilotSettingsRepository implements CopilotSettingsRepository {
  private readonly store = new Map<string, CopilotSettings>();
  async get(operationId: string): Promise<CopilotSettings | null> {
    const s = this.store.get(operationId);
    return s ? { ...s } : null;
  }
  async save(settings: CopilotSettings): Promise<void> {
    this.store.set(settings.operationId, { ...settings });
  }
}

export class InMemoryAiConfigRepository implements AiConfigRepository {
  private readonly store = new Map<string, AiCredential>();
  private key(operationId: string, sellerId: string | null) { return `${operationId}::${sellerId || '*'}`; }
  async get(operationId: string, sellerId: string | null): Promise<AiCredential | null> {
    const c = this.store.get(this.key(operationId, sellerId));
    return c ? { ...c } : null;
  }
  async save(cred: AiCredential): Promise<void> {
    this.store.set(this.key(cred.operationId, cred.sellerId), { ...cred });
  }
  async delete(operationId: string, sellerId: string | null): Promise<void> {
    this.store.delete(this.key(operationId, sellerId));
  }
}

export class InMemoryOpsChannelRepository implements OpsChannelRepository {
  private readonly messages: OpsMessage[] = [];
  private readonly audio = new Map<string, OpsAudioBlob>();
  private audioKey(operationId: string, id: string) { return `${operationId}::${id}`; }
  async saveMessage(m: OpsMessage): Promise<void> {
    this.messages.push({ ...m });
  }
  async listMessages(operationId: string, filter?: { threadUserId?: string }): Promise<OpsMessage[]> {
    return this.messages
      .filter((m) => m.operationId === operationId
        && (filter?.threadUserId === undefined || m.threadUserId === filter.threadUserId))
      .map((m) => ({ ...m }));
  }
  async saveAudio(blob: OpsAudioBlob): Promise<void> {
    this.audio.set(this.audioKey(blob.operationId, blob.id), { ...blob });
  }
  async getAudio(operationId: string, audioId: string): Promise<OpsAudioBlob | null> {
    const b = this.audio.get(this.audioKey(operationId, audioId));
    return b ? { ...b } : null;
  }
  private readonly reads = new Map<string, OpsThreadRead>();
  private readKey(operationId: string, threadUserId: string) { return `${operationId}::${threadUserId}`; }
  async markRead(operationId: string, threadUserId: string, side: 'ADMIN' | 'OPERATOR', at: string): Promise<void> {
    const k = this.readKey(operationId, threadUserId);
    const cur = this.reads.get(k) || { operationId, threadUserId, adminReadAt: null, operatorReadAt: null };
    if (side === 'ADMIN') cur.adminReadAt = at; else cur.operatorReadAt = at;
    this.reads.set(k, { ...cur });
  }
  async getRead(operationId: string, threadUserId: string): Promise<OpsThreadRead | null> {
    const r = this.reads.get(this.readKey(operationId, threadUserId));
    return r ? { ...r } : null;
  }
}

export class InMemorySerialRepository implements SerialRepository {
  private readonly store = new Map<string, Serial>();
  private key(sellerId: string, sku: string, serial: string) {
    return `${sellerId}::${sku}::${serial}`;
  }
  async save(serial: Serial): Promise<void> {
    this.store.set(this.key(serial.sellerId, serial.sku, serial.serial), { ...serial });
  }
  async get(sellerId: string, sku: string, serial: string): Promise<Serial | null> {
    return this.store.get(this.key(sellerId, sku, serial)) ?? null;
  }
  async list(sellerId: string, sku?: string): Promise<Serial[]> {
    return [...this.store.values()]
      .filter((s) => s.sellerId === sellerId && (sku === undefined || s.sku === sku))
      .map((s) => ({ ...s }));
  }
}

export class InMemoryLocationRepository implements LocationRepository {
  private readonly store = new Map<string, Location>();
  async findById(id: string): Promise<Location | null> {
    return this.store.get(id) ?? null;
  }
  async findByCode(operationId: string, code: string): Promise<Location | null> {
    const found = [...this.store.values()].find((l) => l.operationId === operationId && l.code === code);
    return found ? { ...found } : null;
  }
  async save(location: Location): Promise<void> {
    this.store.set(location.id, { ...location });
  }
  async listByOperation(operationId: string): Promise<Location[]> {
    return [...this.store.values()].filter((l) => l.operationId === operationId).map((l) => ({ ...l }));
  }
  async delete(locationId: string): Promise<void> {
    this.store.delete(locationId);
  }
}

export class InMemoryPackRepository implements PackRepository {
  private readonly store = new Map<string, PackConfig>();
  private key(sellerId: string, sku: string, code: string) {
    return `${sellerId}::${sku}::${code}`;
  }
  async upsert(pack: PackConfig): Promise<void> {
    this.store.set(this.key(pack.sellerId, pack.sku, pack.code), { ...pack });
  }
  async listBySku(sellerId: string, sku: string): Promise<PackConfig[]> {
    return [...this.store.values()]
      .filter((p) => p.sellerId === sellerId && p.sku === sku)
      .map((p) => ({ ...p }));
  }
  async findByBarcode(sellerId: string, barcode: string): Promise<PackConfig | null> {
    const found = [...this.store.values()].find(
      (p) => p.sellerId === sellerId && p.barcode === barcode,
    );
    return found ? { ...found } : null;
  }
}

export class InMemoryUserRepository implements UserRepository {
  private readonly store = new Map<string, User>();
  async save(user: User): Promise<void> {
    this.store.set(user.id, { ...user });
  }
  async findById(userId: string): Promise<User | null> {
    return this.store.get(userId) ? { ...this.store.get(userId)! } : null;
  }
  async findByEmail(email: string): Promise<User | null> {
    const found = [...this.store.values()].find((u) => u.email === email.trim().toLowerCase());
    return found ? { ...found } : null;
  }
  async list(operationId?: string | null): Promise<User[]> {
    return [...this.store.values()]
      .filter((u) => operationId == null || u.operationId === operationId)
      .map((u) => ({ ...u }));
  }
}

export class InMemoryAuthTokenRepository implements AuthTokenRepository {
  private readonly store = new Map<string, AuthToken>(); // por token
  async create(token: AuthToken): Promise<void> {
    this.store.set(token.token, { ...token });
  }
  async findByToken(token: string): Promise<AuthToken | null> {
    const t = this.store.get(token);
    return t ? { ...t } : null;
  }
  async markUsed(id: string, usedAt: string): Promise<void> {
    for (const t of this.store.values()) {
      if (t.id === id) { t.usedAt = usedAt; return; }
    }
  }
  async invalidateForUser(userId: string, kind: AuthTokenKind, usedAt: string): Promise<void> {
    for (const t of this.store.values()) {
      if (t.userId === userId && t.kind === kind && !t.usedAt) t.usedAt = usedAt;
    }
  }
}

export class InMemoryCountAuditRepository implements CountAuditRepository {
  private readonly store: CountAudit[] = [];
  async save(audit: CountAudit): Promise<void> {
    this.store.push(JSON.parse(JSON.stringify(audit)));
  }
  async list(operationId: string, opts?: { sellerId?: string | null; limit?: number }): Promise<CountAudit[]> {
    const out = this.store
      .filter((a) => a.operationId === operationId && (!opts?.sellerId || a.sellerId === opts.sellerId))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .map((a) => JSON.parse(JSON.stringify(a)));
    return opts?.limit ? out.slice(0, opts.limit) : out;
  }
}

export class InMemoryEventRepository implements EventRepository {
  private readonly store = new Map<string, DomainEvent>(); // por id determinístico → idempotente
  async append(events: DomainEvent[]): Promise<void> {
    // DomainEvent es plano: copia superficial (mucho más rápida que JSON clone a escala).
    for (const e of events) this.store.set(e.id, { ...e });
  }
  async listByEntity(entityId: string): Promise<DomainEvent[]> {
    return [...this.store.values()]
      .filter((e) => e.entityId === entityId)
      .sort((a, b) => a.seq - b.seq)
      .map((e) => ({ ...e }));
  }
  async query(opts: { sellerIds?: string[]; entityType?: DomainEntityType; type?: string; from?: string; to?: string; limit?: number }): Promise<DomainEvent[]> {
    const sellers = opts.sellerIds && opts.sellerIds.length ? new Set(opts.sellerIds) : null;
    let out = [...this.store.values()].filter((e) =>
      (!sellers || sellers.has(e.sellerId)) &&
      (!opts.entityType || e.entityType === opts.entityType) &&
      (!opts.type || e.type === opts.type) &&
      (!opts.from || e.at >= opts.from) &&
      (!opts.to || e.at <= opts.to),
    );
    // Orden estable: por entidad y luego por seq, para que agrupar transiciones sea trivial.
    out.sort((a, b) => (a.entityId === b.entityId ? a.seq - b.seq : (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)));
    if (opts.limit) out = out.slice(0, opts.limit);
    return out.map((e) => ({ ...e }));
  }
  async count(): Promise<number> { return this.store.size; }
}

export class InMemoryRollupRepository implements RollupRepository {
  private snap = new Map<string, DailyInventorySnapshot>();
  private dem = new Map<string, DailyDemand>();
  private met = new Map<string, DailyMetricRollup>();
  async saveInventorySnapshots(rows: DailyInventorySnapshot[]): Promise<void> {
    for (const r of rows) this.snap.set(r.id, JSON.parse(JSON.stringify(r)));
  }
  async saveDemand(rows: DailyDemand[]): Promise<void> {
    for (const r of rows) this.dem.set(r.id, JSON.parse(JSON.stringify(r)));
  }
  async saveMetricRollups(rows: DailyMetricRollup[]): Promise<void> {
    for (const r of rows) this.met.set(r.id, JSON.parse(JSON.stringify(r)));
  }
  private inRange(date: string, from?: string, to?: string) { return (!from || date >= from) && (!to || date <= to); }
  async listInventorySnapshots(sellerId: string, opts?: { sku?: string | null; fromDate?: string; toDate?: string }): Promise<DailyInventorySnapshot[]> {
    return [...this.snap.values()]
      .filter((r) => r.sellerId === sellerId && (!opts?.sku || r.sku === opts.sku) && this.inRange(r.date, opts?.fromDate, opts?.toDate))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((r) => JSON.parse(JSON.stringify(r)));
  }
  async listDemand(sellerId: string, opts?: { sku?: string | null; fromDate?: string; toDate?: string }): Promise<DailyDemand[]> {
    return [...this.dem.values()]
      .filter((r) => r.sellerId === sellerId && (!opts?.sku || r.sku === opts.sku) && this.inRange(r.date, opts?.fromDate, opts?.toDate))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((r) => JSON.parse(JSON.stringify(r)));
  }
  async listMetricRollups(sellerId: string, opts?: { fromDate?: string; toDate?: string }): Promise<DailyMetricRollup[]> {
    return [...this.met.values()]
      .filter((r) => r.sellerId === sellerId && this.inRange(r.date, opts?.fromDate, opts?.toDate))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0))
      .map((r) => JSON.parse(JSON.stringify(r)));
  }
  async countAll(): Promise<{ snapshots: number; demand: number; metrics: number }> {
    return { snapshots: this.snap.size, demand: this.dem.size, metrics: this.met.size };
  }
}

export class InMemoryLaborTaskRepository implements LaborTaskRepository {
  private store = new Map<string, LaborTask>(); // por id → idempotente
  async append(tasks: LaborTask[]): Promise<void> {
    // LaborTask es plano: copia superficial.
    for (const t of tasks) this.store.set(t.id, { ...t });
  }
  async list(operationId: string, opts?: { operator?: string | null; type?: string | null; from?: string; to?: string; limit?: number }): Promise<LaborTask[]> {
    let out = [...this.store.values()].filter((t) =>
      t.operationId === operationId &&
      (!opts?.operator || t.operator === opts.operator) &&
      (!opts?.type || t.type === opts.type) &&
      (!opts?.from || t.startAt >= opts.from) &&
      (!opts?.to || t.startAt <= opts.to),
    );
    out.sort((a, b) => (a.startAt < b.startAt ? 1 : a.startAt > b.startAt ? -1 : 0)); // más nuevo primero
    if (opts?.limit) out = out.slice(0, opts.limit);
    return out.map((t) => ({ ...t }));
  }
  async count(): Promise<number> { return this.store.size; }
}

export class InMemoryCostRepository implements CostRepository {
  private cards = new Map<string, CostRateCard>(); // por operationId
  async getCard(operationId: string): Promise<CostRateCard | null> {
    const c = this.cards.get(operationId);
    return c ? JSON.parse(JSON.stringify(c)) : null;
  }
  async saveCard(card: CostRateCard): Promise<CostRateCard> {
    this.cards.set(card.operationId, JSON.parse(JSON.stringify(card)));
    return JSON.parse(JSON.stringify(card));
  }
}

export class InMemoryAiAuditRepository implements AiAuditRepository {
  private recs = new Map<string, AiRecommendation>();
  private actions = new Map<string, AgentAction>();
  async saveRecommendation(rec: AiRecommendation): Promise<void> { this.recs.set(rec.id, JSON.parse(JSON.stringify(rec))); }
  async updateRecommendation(id: string, patch: { taken?: boolean | null; outcome?: string | null }): Promise<void> {
    const r = this.recs.get(id);
    if (!r) return;
    if (patch.taken !== undefined) r.taken = patch.taken;
    if (patch.outcome !== undefined) r.outcome = patch.outcome;
  }
  async getRecommendation(id: string): Promise<AiRecommendation | null> {
    const r = this.recs.get(id); return r ? JSON.parse(JSON.stringify(r)) : null;
  }
  private inRange(at: string, from?: string, to?: string) { return (!from || at >= from) && (!to || at <= to); }
  async listRecommendations(operationId: string, opts?: { type?: string | null; from?: string; to?: string; limit?: number }): Promise<AiRecommendation[]> {
    let out = [...this.recs.values()].filter((r) => r.operationId === operationId && (!opts?.type || r.type === opts.type) && this.inRange(r.at, opts?.from, opts?.to));
    out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    if (opts?.limit) out = out.slice(0, opts.limit);
    return out.map((r) => JSON.parse(JSON.stringify(r)));
  }
  async saveAction(action: AgentAction): Promise<void> { this.actions.set(action.id, JSON.parse(JSON.stringify(action))); }
  async listActions(operationId: string, opts?: { agent?: string | null; from?: string; to?: string; limit?: number }): Promise<AgentAction[]> {
    let out = [...this.actions.values()].filter((a) => a.operationId === operationId && (!opts?.agent || a.agent === opts.agent) && this.inRange(a.at, opts?.from, opts?.to));
    out.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    if (opts?.limit) out = out.slice(0, opts.limit);
    return out.map((a) => JSON.parse(JSON.stringify(a)));
  }
  async countAll(): Promise<{ recommendations: number; actions: number }> { return { recommendations: this.recs.size, actions: this.actions.size }; }
}

export class InMemoryWorkAssignmentRepository implements WorkAssignmentRepository {
  private store = new Map<string, WorkAssignment>();
  private open(a: WorkAssignment) { return a.status === 'assigned' || a.status === 'in_progress'; }
  async save(a: WorkAssignment): Promise<void> { this.store.set(a.id, { ...a }); }
  async get(id: string): Promise<WorkAssignment | null> { const a = this.store.get(id); return a ? { ...a } : null; }
  async listOpen(operationId: string, opts?: { type?: WorkTaskType; operator?: string | null }): Promise<WorkAssignment[]> {
    return [...this.store.values()]
      .filter((a) => a.operationId === operationId && this.open(a) && (!opts?.type || a.type === opts.type) && (!opts?.operator || a.operator === opts.operator))
      .sort((a, b) => (a.assignedAt < b.assignedAt ? -1 : 1))
      .map((a) => ({ ...a }));
  }
  async listByOperator(operationId: string, operator: string, opts?: { includeCompleted?: boolean }): Promise<WorkAssignment[]> {
    return [...this.store.values()]
      .filter((a) => a.operationId === operationId && a.operator === operator && (opts?.includeCompleted ? true : this.open(a)))
      .sort((a, b) => (a.assignedAt < b.assignedAt ? -1 : 1))
      .map((a) => ({ ...a }));
  }
  async list(operationId: string, opts?: { type?: WorkTaskType; status?: WorkAssignmentStatus; limit?: number }): Promise<WorkAssignment[]> {
    let out = [...this.store.values()]
      .filter((a) => a.operationId === operationId && (!opts?.type || a.type === opts.type) && (!opts?.status || a.status === opts.status))
      .sort((a, b) => (a.assignedAt < b.assignedAt ? 1 : -1));
    if (opts?.limit) out = out.slice(0, opts.limit);
    return out.map((a) => ({ ...a }));
  }
}

export class InMemoryWorkTaskRepository implements WorkTaskRepository {
  private store = new Map<string, WorkTask>();
  private seq = 0;
  private isOpen(t: WorkTask) { return t.state === 'pending' || t.state === 'assigned' || t.state === 'in_progress'; }
  async create(input: Omit<WorkTask, 'id'>): Promise<WorkTask> {
    const id = `t-${++this.seq}`;
    const t: WorkTask = { ...input, id };
    this.store.set(id, { ...t });
    return { ...t };
  }
  async update(task: WorkTask): Promise<void> { this.store.set(task.id, { ...task }); }
  async get(id: string): Promise<WorkTask | null> { const t = this.store.get(id); return t ? { ...t } : null; }
  async listByOrder(operationId: string, orderId: string): Promise<WorkTask[]> {
    return [...this.store.values()]
      .filter((t) => t.operationId === operationId && t.orderId === orderId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((t) => ({ ...t }));
  }
  async findOpen(operationId: string, type: WorkTaskStage, entityId: string): Promise<WorkTask | null> {
    const hit = [...this.store.values()]
      .filter((t) => t.operationId === operationId && t.type === type && t.entityId === entityId && this.isOpen(t))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0];
    return hit ? { ...hit } : null;
  }
  async list(operationId: string, opts?: { type?: WorkTaskStage; state?: WorkTaskState; sellerId?: string | null; limit?: number }): Promise<WorkTask[]> {
    let out = [...this.store.values()]
      .filter((t) => t.operationId === operationId
        && (!opts?.type || t.type === opts.type)
        && (!opts?.state || t.state === opts.state)
        && (opts?.sellerId === undefined || opts?.sellerId === null || t.sellerId === opts.sellerId))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (opts?.limit) out = out.slice(0, opts.limit);
    return out.map((t) => ({ ...t }));
  }
}

export class InMemoryAgentRuleConfigRepository implements AgentRuleConfigRepository {
  private store = new Map<string, AgentRuleConfig>();
  private k(op: string, key: string) { return `${op}::${key}`; }
  async get(operationId: string, ruleKey: string): Promise<AgentRuleConfig | null> {
    const c = this.store.get(this.k(operationId, ruleKey)); return c ? { ...c } : null;
  }
  async listByOperation(operationId: string): Promise<AgentRuleConfig[]> {
    return [...this.store.values()].filter((c) => c.operationId === operationId).map((c) => ({ ...c }));
  }
  async save(config: AgentRuleConfig): Promise<void> { this.store.set(this.k(config.operationId, config.ruleKey), { ...config }); }
}

export class InMemoryAgentAlertRepository implements AgentAlertRepository {
  private store = new Map<string, AgentAlert>();
  private seq = 0;
  async create(input: Omit<AgentAlert, 'id'>): Promise<AgentAlert> {
    const id = `al-${++this.seq}`; const a: AgentAlert = { ...input, id }; this.store.set(id, { ...a }); return { ...a };
  }
  async get(id: string): Promise<AgentAlert | null> { const a = this.store.get(id); return a ? { ...a } : null; }
  async listOpen(operationId: string): Promise<AgentAlert[]> {
    return [...this.store.values()].filter((a) => a.operationId === operationId && a.status === 'open')
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map((a) => ({ ...a }));
  }
  async listRecent(operationId: string, limit: number): Promise<AgentAlert[]> {
    return [...this.store.values()].filter((a) => a.operationId === operationId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).slice(0, limit).map((a) => ({ ...a }));
  }
  async findOpenByDedupe(operationId: string, dedupeKey: string): Promise<AgentAlert | null> {
    const a = [...this.store.values()].find((x) => x.operationId === operationId && x.dedupeKey === dedupeKey && x.status === 'open');
    return a ? { ...a } : null;
  }
  async lastByDedupe(operationId: string, dedupeKey: string): Promise<AgentAlert | null> {
    const a = [...this.store.values()].filter((x) => x.operationId === operationId && x.dedupeKey === dedupeKey)
      .sort((x, y) => (x.createdAt < y.createdAt ? 1 : -1))[0];
    return a ? { ...a } : null;
  }
  async save(alert: AgentAlert): Promise<void> { this.store.set(alert.id, { ...alert }); }
}

export class InMemoryPlanConfigRepository implements PlanConfigRepository {
  private readonly store = new Map<string, PlanConfig>();
  async list(): Promise<PlanConfig[]> { return [...this.store.values()].map((c) => JSON.parse(JSON.stringify(c))); }
  async get(planId: string): Promise<PlanConfig | null> { const c = this.store.get(planId); return c ? JSON.parse(JSON.stringify(c)) : null; }
  async save(config: PlanConfig): Promise<void> { this.store.set(config.planId, JSON.parse(JSON.stringify(config))); }
  async clear(): Promise<void> { this.store.clear(); }
}

export class InMemoryOrderRepository implements OrderRepository {
  private readonly store = new Map<string, SalesOrder>();
  // Índice por (sellerId, externalOrderId) → el order MÁS ANTIGUO con esa referencia.
  // Sin esto, la comprobación de idempotencia en cada createOrder sería O(órdenes)
  // y sembrar decenas de miles de órdenes resultaría O(n²).
  private readonly byExternal = new Map<string, SalesOrder>();
  constructor(private readonly events?: EventRepository) {}
  private key(sellerId: string, orderId: string) {
    return `${sellerId}::${orderId}`;
  }
  private extKey(sellerId: string, externalOrderId: string) {
    return `${sellerId} ${externalOrderId}`;
  }
  async save(order: SalesOrder): Promise<void> {
    // Deep-copy para que el ledger de órdenes no comparta referencias mutables.
    const clone = structuredClone(order);
    this.store.set(this.key(order.sellerId, order.id), clone);
    if (order.externalOrderId) {
      const ek = this.extKey(order.sellerId, order.externalOrderId);
      const existing = this.byExternal.get(ek);
      if (!existing || existing.id === order.id || order.createdAt < existing.createdAt) {
        this.byExternal.set(ek, clone);
      }
    }
    // Dual-write (G2+G6): promueve el historial al event store consultable.
    await this.events?.append(toDomainEvents('ORDER', order.id, order.externalOrderId, order.sellerId, order.events));
  }
  async findById(sellerId: string, orderId: string): Promise<SalesOrder | null> {
    const o = this.store.get(this.key(sellerId, orderId));
    return o ? structuredClone(o) : null;
  }
  async findByExternal(sellerId: string, externalOrderId: string): Promise<SalesOrder | null> {
    if (!externalOrderId) return null;
    const o = this.byExternal.get(this.extKey(sellerId, externalOrderId));
    return o ? structuredClone(o) : null;
  }
  async delete(sellerId: string, orderId: string): Promise<void> {
    const k = this.key(sellerId, orderId);
    const o = this.store.get(k);
    this.store.delete(k);
    if (o) {
      if (o.externalOrderId) {
        const ek = this.extKey(sellerId, o.externalOrderId);
        if (this.byExternal.get(ek)?.id === orderId) {
          // Recalcula el más antiguo restante para esa referencia externa (raro; O(órdenes) sólo al borrar).
          const remaining: SalesOrder[] = [];
          for (const x of this.store.values()) if (x.sellerId === sellerId && x.externalOrderId === o.externalOrderId) remaining.push(x);
          remaining.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
          if (remaining.length) this.byExternal.set(ek, remaining[0]); else this.byExternal.delete(ek);
        }
      }
    }
  }
  async list(sellerId: string): Promise<SalesOrder[]> {
    const out: SalesOrder[] = [];
    for (const o of this.store.values()) if (o.sellerId === sellerId) out.push(structuredClone(o));
    return out;
  }
}

export class InMemoryProductLogRepository implements ProductLogRepository {
  private readonly log: ProductLogEntry[] = [];
  async append(entry: ProductLogEntry): Promise<void> {
    this.log.push({ ...entry });
  }
  async list(sellerId: string, sku?: string): Promise<ProductLogEntry[]> {
    return this.log
      .filter((e) => e.sellerId === sellerId && (!sku || e.sku === sku))
      .slice()
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .map((e) => ({ ...e }));
  }
}

export class InMemoryBillingRepository implements BillingRepository {
  private readonly rates = new Map<string, BillingRate>();
  private readonly invoices = new Map<string, BillingInvoice>();
  async getRate(sellerId: string): Promise<BillingRate | null> {
    const r = this.rates.get(sellerId);
    return r ? { ...r } : null;
  }
  async saveRate(rate: BillingRate): Promise<void> {
    this.rates.set(rate.sellerId, { ...rate });
  }
  async saveInvoice(invoice: BillingInvoice): Promise<void> {
    this.invoices.set(`${invoice.sellerId}::${invoice.id}`, structuredClone(invoice));
  }
  async listInvoices(sellerId: string): Promise<BillingInvoice[]> {
    return [...this.invoices.values()]
      .filter((i) => i.sellerId === sellerId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((i) => structuredClone(i));
  }
  async findInvoice(sellerId: string, id: string): Promise<BillingInvoice | null> {
    const i = this.invoices.get(`${sellerId}::${id}`);
    return i ? structuredClone(i) : null;
  }
  async deleteInvoice(sellerId: string, id: string): Promise<void> {
    this.invoices.delete(`${sellerId}::${id}`);
    this.docs.delete(`${sellerId}::${id}`);
  }
  private readonly docs = new Map<string, InvoiceDocumentBlob>();
  async saveInvoiceDocument(sellerId: string, invoiceId: string, blob: InvoiceDocumentBlob): Promise<void> {
    this.docs.set(`${sellerId}::${invoiceId}`, { ...blob });
  }
  async getInvoiceDocument(sellerId: string, invoiceId: string): Promise<InvoiceDocumentBlob | null> {
    const d = this.docs.get(`${sellerId}::${invoiceId}`);
    return d ? { ...d } : null;
  }
  async deleteInvoiceDocument(sellerId: string, invoiceId: string): Promise<void> {
    this.docs.delete(`${sellerId}::${invoiceId}`);
  }
}

export class InMemoryChatRepository implements ChatRepository {
  private readonly msgs: ChatMessage[] = [];
  private readonly reads = new Map<string, ChatReadState>();
  async append(message: ChatMessage): Promise<void> {
    this.msgs.push(structuredClone(message));
  }
  async list(sellerId: string): Promise<ChatMessage[]> {
    return this.msgs
      .filter((m) => m.sellerId === sellerId)
      .slice()
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))
      .map((m) => structuredClone(m));
  }
  async getReadState(sellerId: string): Promise<ChatReadState | null> {
    const r = this.reads.get(sellerId);
    return r ? { ...r } : null;
  }
  async setReadState(sellerId: string, side: 'CLIENT' | 'OPS', at: string): Promise<void> {
    const cur = this.reads.get(sellerId) || { sellerId, opsReadAt: null, clientReadAt: null };
    if (side === 'OPS') cur.opsReadAt = at;
    else cur.clientReadAt = at;
    this.reads.set(sellerId, cur);
  }
}

export class InMemoryAssemblyLogRepository implements AssemblyLogRepository {
  private readonly log: AssemblyRecord[] = [];
  async append(record: AssemblyRecord): Promise<void> {
    this.log.push(structuredClone(record));
  }
  async list(sellerId: string): Promise<AssemblyRecord[]> {
    return this.log
      .filter((r) => r.sellerId === sellerId)
      .slice()
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .map((r) => structuredClone(r));
  }
}

export class InMemoryReceiptOrderRepository implements ReceiptOrderRepository {
  private readonly store = new Map<string, ReceiptOrder>();
  constructor(private readonly events?: EventRepository) {}
  private key(sellerId: string, orderId: string) {
    return `${sellerId}::${orderId}`;
  }
  async save(order: ReceiptOrder): Promise<void> {
    this.store.set(this.key(order.sellerId, order.id), structuredClone(order));
    await this.events?.append(toDomainEvents('RECEIPT', order.id, order.reference ?? null, order.sellerId, order.events));
  }
  async findById(sellerId: string, orderId: string): Promise<ReceiptOrder | null> {
    const o = this.store.get(this.key(sellerId, orderId));
    return o ? structuredClone(o) : null;
  }
  async list(sellerId: string): Promise<ReceiptOrder[]> {
    return [...this.store.values()]
      .filter((o) => o.sellerId === sellerId)
      .map((o) => structuredClone(o));
  }
  async delete(sellerId: string, orderId: string): Promise<void> {
    this.store.delete(this.key(sellerId, orderId));
  }
}

export class InMemoryReturnOrderRepository implements ReturnOrderRepository {
  private readonly store = new Map<string, ReturnOrder>();
  constructor(private readonly events?: EventRepository) {}
  private key(sellerId: string, returnId: string) {
    return `${sellerId}::${returnId}`;
  }
  async save(order: ReturnOrder): Promise<void> {
    this.store.set(this.key(order.sellerId, order.id), structuredClone(order));
    await this.events?.append(toDomainEvents('RETURN', order.id, order.originalOrderRef ?? null, order.sellerId, order.events));
  }
  async findById(sellerId: string, returnId: string): Promise<ReturnOrder | null> {
    const o = this.store.get(this.key(sellerId, returnId));
    return o ? structuredClone(o) : null;
  }
  async list(sellerId: string): Promise<ReturnOrder[]> {
    return [...this.store.values()].filter((o) => o.sellerId === sellerId).map((o) => structuredClone(o));
  }
}

export class InMemoryLoginEventRepository implements LoginEventRepository {
  private readonly log: LoginEvent[] = [];
  async append(event: LoginEvent): Promise<void> {
    // Append-only: solo agregamos, nunca mutamos lo existente.
    this.log.push({ ...event });
  }
  async list(): Promise<LoginEvent[]> {
    return this.log.map((e) => ({ ...e }));
  }
}

export class InMemoryAnnouncementRepository implements AnnouncementRepository {
  private readonly anns = new Map<string, Announcement>();
  private readonly clicks: AnnouncementClick[] = [];
  async save(a: Announcement): Promise<void> {
    this.anns.set(a.id, { ...a });
  }
  async findById(id: string): Promise<Announcement | null> {
    const a = this.anns.get(id);
    return a ? { ...a } : null;
  }
  async list(): Promise<Announcement[]> {
    return [...this.anns.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)).map((a) => ({ ...a }));
  }
  async delete(id: string): Promise<void> {
    this.anns.delete(id);
  }
  async appendClick(click: AnnouncementClick): Promise<void> {
    this.clicks.push({ ...click });
  }
  async listClicks(announcementId: string): Promise<AnnouncementClick[]> {
    return this.clicks.filter((c) => c.announcementId === announcementId).map((c) => ({ ...c }));
  }
}

export class InMemoryWebhookRepository implements WebhookRepository {
  private readonly hooks = new Map<string, Webhook>();
  private readonly deliveries: WebhookDelivery[] = [];
  async save(w: Webhook): Promise<void> {
    this.hooks.set(w.id, { ...w, events: [...w.events] });
  }
  async findById(id: string): Promise<Webhook | null> {
    const w = this.hooks.get(id);
    return w ? { ...w, events: [...w.events] } : null;
  }
  async list(): Promise<Webhook[]> {
    return [...this.hooks.values()]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((w) => ({ ...w, events: [...w.events] }));
  }
  async delete(id: string): Promise<void> {
    this.hooks.delete(id);
  }
  async appendDelivery(d: WebhookDelivery): Promise<void> {
    this.deliveries.push({ ...d });
  }
  async listDeliveries(webhookId: string): Promise<WebhookDelivery[]> {
    return this.deliveries
      .filter((d) => d.webhookId === webhookId)
      .slice()
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .map((d) => ({ ...d }));
  }
}

/** Generador de IDs incremental y determinista (para tests) o aleatorio (prod). */
export class SequentialIdGenerator implements IdGenerator {
  private n = 0;
  constructor(private readonly prefix = 'id') {}
  next(): string {
    this.n += 1;
    return `${this.prefix}-${this.n}`;
  }
}

/** Reloj fijo para tests deterministas. */
export class FixedClock implements Clock {
  constructor(private iso = '2026-01-01T00:00:00.000Z') {}
  now(): string {
    return this.iso;
  }
  set(iso: string): void {
    this.iso = iso;
  }
}
