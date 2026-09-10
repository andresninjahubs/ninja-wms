/**
 * Implementaciones Prisma/PostgreSQL de los puertos del dominio.
 * Misma interfaz que las in-memory: el dominio no sabe cuál está usando.
 */
// El cliente real se genera con `prisma generate`. Se tipa laxo (any) para que el
// build no dependa de la generación en entornos sin acceso a los binarios de Prisma.
type PrismaClient = any;
import {
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
  AuthTokenRepository,
  CountAuditRepository,
  CostRepository,
  EventRepository,
  RollupRepository,
  LaborTaskRepository,
  AiAuditRepository,
  WorkAssignmentRepository,
  WorkTaskRepository,
  AgentRuleConfigRepository,
  AgentAlertRepository,
  PlanConfigRepository,
  WebhookRepository,
} from '../../domain/ports';
import { PlanConfig } from '../../domain/plans';
import { toDomainEvents } from '../../domain/domain-events';
import {
  Allocation,
  Announcement,
  AuthToken,
  AuthTokenKind,
  CountAudit,
  CostRateCard,
  DomainEvent,
  DomainEntityType,
  DailyInventorySnapshot,
  DailyDemand,
  DailyMetricRollup,
  LaborTask,
  LaborTaskType,
  WorkAssignment,
  WorkTaskType,
  WorkAssignmentStatus,
  WorkTask,
  WorkTaskStage,
  WorkTaskState,
  AgentRuleConfig,
  AgentAlert,
  AgentRuleSeverity,
  AgentAlertStatus,
  AgentActionType,
  AgentActionMode,
  AgentAlertActionStatus,
  AiRecommendation,
  AgentAction,
  AnnouncementClick,
  CycleCountStrategy,
  Location,
  LoginEvent,
  Lot,
  Serial,
  PackagingMaterial,
  PackagingMovement,
  OperationBranding,
  OpsMessage,
  OpsAudioBlob,
  OpsCategory,
  OpsThreadRead,
  KitComponent,
  KitMode,
  MovementType,
  Operation,
  OrderStatus,
  OrderType,
  PackConfig,
  PickingStrategy,
  RotationClass,
  ProductLogEntry,
  AssemblyRecord,
  AssemblySource,
  BillingInvoice,
  BillingLine,
  BillingRate,
  ChatMessage,
  ChatReadState,
  ReceiptOrder,
  ReturnOrder,
  SalesOrder,
  Seller,
  Shipment,
  ShipTo,
  Sku,
  StockBalance,
  StockMovement,
  StockState,
  Uom,
  User,
  UserRole,
  Webhook,
  WebhookDelivery,
  WebhookEventType,
  WebhookScope,
  ZoneType,
} from '../../domain/types';

export class PrismaMovementRepository implements MovementRepository {
  constructor(private readonly db: PrismaClient) {}

  async append(movements: StockMovement[]): Promise<void> {
    await this.db.stockMovement.createMany({
      data: movements.map((m) => ({
        id: m.id,
        sellerId: m.sellerId,
        sku: m.sku,
        locationId: m.locationId,
        lot: m.lot,
        state: m.state,
        type: m.type,
        qtyDelta: m.qtyDelta,
        uom: m.uom,
        reference: m.reference,
        groupId: m.groupId,
        actor: m.actor,
        occurredAt: new Date(m.occurredAt),
      })),
    });
  }

  async balances(query: StockQuery): Promise<StockBalance[]> {
    const rows = (await this.db.stockMovement.groupBy({
      by: ['sku', 'locationId', 'lot', 'state'],
      where: {
        sellerId: query.sellerId, // aislamiento por seller SIEMPRE presente
        ...(query.sku ? { sku: query.sku } : {}),
        ...(query.locationId ? { locationId: query.locationId } : {}),
      },
      _sum: { qtyDelta: true },
    })) as Array<{
      sku: string;
      locationId: string;
      lot: string | null;
      state: string;
      _sum: { qtyDelta: number | null };
    }>;

    const balances: StockBalance[] = rows.map((r) => ({
      sellerId: query.sellerId,
      sku: r.sku,
      locationId: r.locationId,
      lot: r.lot,
      state: r.state as StockState,
      qty: r._sum.qtyDelta ?? 0,
    }));

    return query.includeZeros ? balances : balances.filter((b) => b.qty !== 0);
  }

  async find(query: StockQuery): Promise<StockMovement[]> {
    const rows = await this.db.stockMovement.findMany({
      where: {
        sellerId: query.sellerId,
        ...(query.sku ? { sku: query.sku } : {}),
        ...(query.locationId ? { locationId: query.locationId } : {}),
      },
    });
    return rows.map((m: any) => ({
      id: m.id,
      sellerId: m.sellerId,
      sku: m.sku,
      locationId: m.locationId,
      lot: m.lot,
      state: m.state as StockState,
      type: m.type as MovementType,
      qtyDelta: m.qtyDelta,
      uom: m.uom as Uom,
      reference: m.reference,
      groupId: m.groupId,
      actor: m.actor,
      occurredAt: (m.occurredAt as Date).toISOString(),
    }));
  }

  async occupancyByLocation(): Promise<Record<string, number>> {
    // Ocupación física por ubicación, sumando TODOS los sellers (ubicaciones compartidas).
    const rows = (await this.db.stockMovement.groupBy({
      by: ['locationId'],
      _sum: { qtyDelta: true },
    })) as Array<{ locationId: string; _sum: { qtyDelta: number | null } }>;
    const acc: Record<string, number> = {};
    for (const r of rows) acc[r.locationId] = r._sum.qtyDelta ?? 0;
    return acc;
  }
}

export class PrismaPackRepository implements PackRepository {
  constructor(private readonly db: PrismaClient) {}
  private toDomain(p: any): PackConfig {
    return { sellerId: p.sellerId, sku: p.sku, code: p.code, label: p.label, barcode: p.barcode, factor: p.factor, isBase: p.isBase };
  }
  async upsert(pack: PackConfig): Promise<void> {
    await this.db.packConfig.upsert({
      where: { sellerId_sku_code: { sellerId: pack.sellerId, sku: pack.sku, code: pack.code } },
      create: { ...pack },
      update: { label: pack.label, barcode: pack.barcode, factor: pack.factor, isBase: pack.isBase },
    });
  }
  async listBySku(sellerId: string, sku: string): Promise<PackConfig[]> {
    const rows = await this.db.packConfig.findMany({ where: { sellerId, sku } });
    return rows.map((p: any) => this.toDomain(p));
  }
  async findByBarcode(sellerId: string, barcode: string): Promise<PackConfig | null> {
    const p = await this.db.packConfig.findUnique({ where: { sellerId_barcode: { sellerId, barcode } } });
    return p ? this.toDomain(p) : null;
  }
}

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly db: PrismaClient) {}
  private toDomain(u: any): User {
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      role: u.role as UserRole,
      operationId: u.operationId ?? null,
      sellerId: u.sellerId ?? null,
      active: u.active,
      emailVerified: u.emailVerified ?? true,
      passwordHash: u.passwordHash ?? null,
    };
  }
  async save(user: User): Promise<void> {
    const data = { name: user.name, email: user.email, role: user.role, operationId: user.operationId, sellerId: user.sellerId, active: user.active, emailVerified: user.emailVerified ?? true, passwordHash: user.passwordHash ?? null };
    await this.db.user.upsert({ where: { id: user.id }, create: { id: user.id, ...data }, update: data });
  }
  async findById(userId: string): Promise<User | null> {
    const u = await this.db.user.findUnique({ where: { id: userId } });
    return u ? this.toDomain(u) : null;
  }
  async findByEmail(email: string): Promise<User | null> {
    const u = await this.db.user.findUnique({ where: { email: email.trim().toLowerCase() } });
    return u ? this.toDomain(u) : null;
  }
  async list(operationId?: string | null): Promise<User[]> {
    const rows = await this.db.user.findMany(operationId == null ? {} : { where: { operationId } });
    return rows.map((u: any) => this.toDomain(u));
  }
}

export class PrismaOperationRepository implements OperationRepository {
  constructor(private readonly db: PrismaClient) {}
  private toDomain(o: any): Operation {
    return {
      id: o.id, name: o.name, active: o.active, track: o.track ?? null, selfServe: o.selfServe ?? false,
      planId: o.planId ?? null, trialPlan: o.trialPlan ?? null,
      trialEndsAt: o.trialEndsAt ? (o.trialEndsAt as Date).toISOString() : null,
      assignmentMode: (o.assignmentMode as any) ?? null,
      autoBalance: o.autoBalance ?? false,
    };
  }
  async findById(id: string): Promise<Operation | null> {
    const o = await this.db.operation.findUnique({ where: { id } });
    return o ? this.toDomain(o) : null;
  }
  async save(op: Operation): Promise<void> {
    const data = {
      name: op.name, active: op.active, track: op.track ?? null, selfServe: op.selfServe ?? false,
      planId: op.planId ?? null, trialPlan: op.trialPlan ?? null,
      trialEndsAt: op.trialEndsAt ? new Date(op.trialEndsAt) : null,
      assignmentMode: op.assignmentMode ?? null,
      autoBalance: op.autoBalance ?? false,
    };
    await this.db.operation.upsert({
      where: { id: op.id },
      create: { id: op.id, ...data },
      update: data,
    });
  }
  async list(): Promise<Operation[]> {
    const rows = await this.db.operation.findMany();
    return rows.map((o: any) => this.toDomain(o));
  }
}

export class PrismaSellerRepository implements SellerRepository {
  constructor(private readonly db: PrismaClient) {}
  async findById(sellerId: string): Promise<Seller | null> {
    const s = await this.db.seller.findUnique({ where: { id: sellerId } });
    return s
      ? {
          id: s.id,
          operationId: s.operationId,
          name: s.name,
          pickingStrategy: s.pickingStrategy as PickingStrategy,
          cycleCountStrategy: s.cycleCountStrategy as CycleCountStrategy,
          consolidateByLocation: !!s.consolidateByLocation,
          courierPriority: Array.isArray(s.courierPriority) ? s.courierPriority : [],
          autoAllocateOnIngest: !!s.autoAllocateOnIngest,
          active: s.active,
          webhooksClientEnabled: !!s.webhooksClientEnabled,
        }
      : null;
  }
  async save(seller: Seller): Promise<void> {
    const data = {
      operationId: seller.operationId,
      name: seller.name,
      pickingStrategy: seller.pickingStrategy,
      cycleCountStrategy: seller.cycleCountStrategy,
      consolidateByLocation: !!seller.consolidateByLocation,
      courierPriority: seller.courierPriority as unknown as object,
      autoAllocateOnIngest: !!seller.autoAllocateOnIngest,
      active: seller.active,
      webhooksClientEnabled: !!seller.webhooksClientEnabled,
    };
    await this.db.seller.upsert({ where: { id: seller.id }, create: { id: seller.id, ...data }, update: data });
  }
  async list(operationId: string): Promise<Seller[]> {
    const rows = await this.db.seller.findMany({ where: { operationId } });
    return rows.map((s: any) => ({
      id: s.id, operationId: s.operationId, name: s.name,
      pickingStrategy: s.pickingStrategy as PickingStrategy,
      cycleCountStrategy: s.cycleCountStrategy as CycleCountStrategy,
      consolidateByLocation: !!s.consolidateByLocation,
      courierPriority: Array.isArray(s.courierPriority) ? s.courierPriority : [],
      active: s.active,
      webhooksClientEnabled: !!s.webhooksClientEnabled,
    }));
  }
}

export class PrismaSkuRepository implements SkuRepository {
  constructor(private readonly db: PrismaClient) {}
  async find(sellerId: string, sku: string): Promise<Sku | null> {
    const s = await this.db.sku.findUnique({
      where: { sellerId_sku: { sellerId, sku } },
    });
    return s ? skuToDomain(s) : null;
  }
  async save(sku: Sku): Promise<void> {
    const cols = {
      description: sku.description,
      barcode: sku.barcode,
      lotControlled: sku.lotControlled,
      serialControlled: sku.serialControlled,
      expiryControlled: sku.expiryControlled,
      rotationClass: sku.rotationClass,
      active: sku.active,
      isKit: sku.isKit,
      kitMode: sku.kitMode,
      components: sku.components as unknown as object,
    };
    await this.db.sku.upsert({
      where: { sellerId_sku: { sellerId: sku.sellerId, sku: sku.sku } },
      create: { sellerId: sku.sellerId, sku: sku.sku, ...cols },
      update: cols,
    });
  }
  async list(sellerId: string): Promise<Sku[]> {
    const rows = await this.db.sku.findMany({ where: { sellerId } });
    return rows.map((s: any) => skuToDomain(s));
  }
}

function skuToDomain(s: any): Sku {
  return {
    sellerId: s.sellerId,
    sku: s.sku,
    description: s.description,
    barcode: s.barcode,
    lotControlled: s.lotControlled,
    serialControlled: s.serialControlled ?? false,
    expiryControlled: s.expiryControlled ?? false,
    rotationClass: s.rotationClass as RotationClass,
    active: s.active,
    isKit: s.isKit ?? false,
    kitMode: (s.kitMode as KitMode) ?? null,
    components: (s.components as KitComponent[]) ?? [],
  };
}

export class PrismaProductLogRepository implements ProductLogRepository {
  constructor(private readonly db: PrismaClient) {}
  async append(entry: ProductLogEntry): Promise<void> {
    await this.db.productLog.create({
      data: {
        id: entry.id,
        sellerId: entry.sellerId,
        sku: entry.sku,
        at: new Date(entry.at),
        actor: entry.actor,
        action: entry.action,
        detail: entry.detail,
      },
    });
  }
  async list(sellerId: string, sku?: string): Promise<ProductLogEntry[]> {
    const rows = await this.db.productLog.findMany({
      where: { sellerId, ...(sku ? { sku } : {}) },
      orderBy: { at: 'desc' },
    });
    return rows.map((e: any) => ({
      id: e.id,
      sellerId: e.sellerId,
      sku: e.sku,
      at: (e.at instanceof Date ? e.at.toISOString() : e.at),
      actor: e.actor,
      action: e.action,
      detail: e.detail ?? null,
    }));
  }
}

export class PrismaLotRepository implements LotRepository {
  constructor(private readonly db: PrismaClient) {}
  async upsert(lot: Lot): Promise<void> {
    await this.db.lot.upsert({
      where: { sellerId_sku_lot: { sellerId: lot.sellerId, sku: lot.sku, lot: lot.lot } },
      create: {
        sellerId: lot.sellerId,
        sku: lot.sku,
        lot: lot.lot,
        receivedAt: new Date(lot.receivedAt),
        expiryDate: lot.expiryDate ? new Date(lot.expiryDate) : null,
      },
      update: { expiryDate: lot.expiryDate ? new Date(lot.expiryDate) : null },
    });
  }
  async get(sellerId: string, sku: string, lot: string): Promise<Lot | null> {
    const l = await this.db.lot.findUnique({
      where: { sellerId_sku_lot: { sellerId, sku, lot } },
    });
    return l ? this.toDomain(l) : null;
  }
  async list(sellerId: string, sku: string): Promise<Lot[]> {
    const rows = await this.db.lot.findMany({ where: { sellerId, sku } });
    return rows.map((l: any) => this.toDomain(l));
  }
  private toDomain(l: any): Lot {
    return {
      sellerId: l.sellerId,
      sku: l.sku,
      lot: l.lot,
      receivedAt: (l.receivedAt as Date).toISOString(),
      expiryDate: l.expiryDate ? (l.expiryDate as Date).toISOString() : null,
    };
  }
}

export class PrismaSerialRepository implements SerialRepository {
  constructor(private readonly db: PrismaClient) {}
  async save(s: Serial): Promise<void> {
    const cols = {
      lot: s.lot,
      expiry: s.expiry ? new Date(s.expiry) : null,
      status: s.status,
      receiptId: s.receiptId,
      locationId: s.locationId,
      receivedAt: new Date(s.receivedAt),
      actor: s.actor,
    };
    await this.db.serial.upsert({
      where: { sellerId_sku_serial: { sellerId: s.sellerId, sku: s.sku, serial: s.serial } },
      create: { sellerId: s.sellerId, sku: s.sku, serial: s.serial, ...cols },
      update: cols,
    });
  }
  async get(sellerId: string, sku: string, serial: string): Promise<Serial | null> {
    const s = await this.db.serial.findUnique({
      where: { sellerId_sku_serial: { sellerId, sku, serial } },
    });
    return s ? this.toDomain(s) : null;
  }
  async list(sellerId: string, sku?: string): Promise<Serial[]> {
    const rows = await this.db.serial.findMany({ where: sku === undefined ? { sellerId } : { sellerId, sku } });
    return rows.map((s: any) => this.toDomain(s));
  }
  private toDomain(s: any): Serial {
    return {
      sellerId: s.sellerId,
      sku: s.sku,
      serial: s.serial,
      lot: s.lot ?? null,
      expiry: s.expiry ? (s.expiry as Date).toISOString() : null,
      status: s.status,
      receiptId: s.receiptId ?? null,
      locationId: s.locationId ?? null,
      receivedAt: (s.receivedAt as Date).toISOString(),
      actor: s.actor,
    };
  }
}

export class PrismaBrandingRepository implements BrandingRepository {
  constructor(private readonly db: PrismaClient) {}
  async get(operationId: string): Promise<OperationBranding | null> {
    const b = await this.db.operationBranding.findUnique({ where: { operationId } });
    return b ? this.toDomain(b) : null;
  }
  async save(b: OperationBranding): Promise<void> {
    const cols = {
      companyName: b.companyName, legalName: b.legalName, taxId: b.taxId, address: b.address,
      email: b.email, phone: b.phone, website: b.website, primaryColor: b.primaryColor, logoDataUri: b.logoDataUri,
    };
    await this.db.operationBranding.upsert({
      where: { operationId: b.operationId },
      create: { operationId: b.operationId, ...cols },
      update: cols,
    });
  }
  private toDomain(b: any): OperationBranding {
    return {
      operationId: b.operationId,
      companyName: b.companyName ?? null, legalName: b.legalName ?? null, taxId: b.taxId ?? null,
      address: b.address ?? null, email: b.email ?? null, phone: b.phone ?? null, website: b.website ?? null,
      primaryColor: b.primaryColor ?? null, logoDataUri: b.logoDataUri ?? null,
    };
  }
}

export class PrismaPackagingRepository implements PackagingRepository {
  constructor(private readonly db: PrismaClient) {}
  async saveMaterial(m: PackagingMaterial): Promise<void> {
    const cols = {
      barcode: m.barcode,
      name: m.name,
      unitPrice: m.unitPrice,
      sellerPrices: m.sellerPrices as unknown as object,
      active: m.active,
    };
    await this.db.packagingMaterial.upsert({
      where: { operationId_sku: { operationId: m.operationId, sku: m.sku } },
      create: { operationId: m.operationId, sku: m.sku, ...cols },
      update: cols,
    });
  }
  async getMaterial(operationId: string, sku: string): Promise<PackagingMaterial | null> {
    const m = await this.db.packagingMaterial.findUnique({ where: { operationId_sku: { operationId, sku } } });
    return m ? this.matToDomain(m) : null;
  }
  async listMaterials(operationId: string): Promise<PackagingMaterial[]> {
    const rows = await this.db.packagingMaterial.findMany({ where: { operationId } });
    return rows.map((m: any) => this.matToDomain(m));
  }
  async findByBarcode(operationId: string, barcode: string): Promise<PackagingMaterial | null> {
    const m = await this.db.packagingMaterial.findFirst({ where: { operationId, barcode } });
    return m ? this.matToDomain(m) : null;
  }
  async appendMovements(movements: PackagingMovement[]): Promise<void> {
    if (!movements.length) return;
    await this.db.packagingMovement.createMany({
      data: movements.map((mv) => ({
        id: mv.id,
        operationId: mv.operationId,
        materialSku: mv.materialSku,
        type: mv.type,
        qtyDelta: mv.qtyDelta,
        sellerId: mv.sellerId,
        orderId: mv.orderId,
        unitPrice: mv.unitPrice,
        reference: mv.reference,
        actor: mv.actor,
        occurredAt: new Date(mv.occurredAt),
      })),
    });
  }
  async listMovements(operationId: string, filter?: { materialSku?: string; sellerId?: string }): Promise<PackagingMovement[]> {
    const where: any = { operationId };
    if (filter?.materialSku !== undefined) where.materialSku = filter.materialSku;
    if (filter?.sellerId !== undefined) where.sellerId = filter.sellerId;
    const rows = await this.db.packagingMovement.findMany({ where });
    return rows.map((mv: any) => ({
      id: mv.id,
      operationId: mv.operationId,
      materialSku: mv.materialSku,
      type: mv.type,
      qtyDelta: mv.qtyDelta,
      sellerId: mv.sellerId ?? null,
      orderId: mv.orderId ?? null,
      unitPrice: mv.unitPrice ?? null,
      reference: mv.reference ?? null,
      actor: mv.actor,
      occurredAt: (mv.occurredAt as Date).toISOString(),
    }));
  }
  private matToDomain(m: any): PackagingMaterial {
    return {
      operationId: m.operationId,
      sku: m.sku,
      barcode: m.barcode ?? null,
      name: m.name,
      unitPrice: m.unitPrice,
      sellerPrices: (m.sellerPrices as Record<string, number>) ?? {},
      active: m.active,
    };
  }
}

export class PrismaOpsChannelRepository implements OpsChannelRepository {
  constructor(private readonly db: PrismaClient) {}
  async saveMessage(m: OpsMessage): Promise<void> {
    await this.db.opsMessage.create({
      data: {
        id: m.id,
        operationId: m.operationId,
        threadUserId: m.threadUserId,
        senderId: m.senderId,
        senderName: m.senderName,
        senderRole: m.senderRole,
        kind: m.kind,
        text: m.text,
        note: m.note,
        audioId: m.audioId,
        audioMime: m.audioMime,
        durationSec: m.durationSec,
        category: m.category,
        categoryConfidence: m.categoryConfidence,
        categorySource: m.categorySource,
        at: new Date(m.at),
      },
    });
  }
  async listMessages(operationId: string, filter?: { threadUserId?: string }): Promise<OpsMessage[]> {
    const where: any = { operationId };
    if (filter?.threadUserId !== undefined) where.threadUserId = filter.threadUserId;
    const rows = await this.db.opsMessage.findMany({ where, orderBy: { at: 'asc' } });
    return rows.map((m: any) => ({
      id: m.id,
      operationId: m.operationId,
      threadUserId: m.threadUserId,
      senderId: m.senderId,
      senderName: m.senderName,
      senderRole: m.senderRole,
      kind: m.kind,
      text: m.text ?? null,
      note: m.note ?? null,
      audioId: m.audioId ?? null,
      audioMime: m.audioMime ?? null,
      durationSec: m.durationSec ?? null,
      category: (m.category as OpsCategory) ?? null,
      categoryConfidence: m.categoryConfidence ?? null,
      categorySource: (m.categorySource as 'ai' | 'heuristic') ?? null,
      at: (m.at as Date).toISOString(),
    }));
  }
  async saveAudio(blob: OpsAudioBlob): Promise<void> {
    await this.db.opsAudioBlob.create({
      data: { id: blob.id, operationId: blob.operationId, mime: blob.mime, dataBase64: blob.dataBase64 },
    });
  }
  async getAudio(operationId: string, audioId: string): Promise<OpsAudioBlob | null> {
    const b = await this.db.opsAudioBlob.findFirst({ where: { id: audioId, operationId } });
    return b ? { id: b.id, operationId: b.operationId, mime: b.mime, dataBase64: b.dataBase64 } : null;
  }
  async markRead(operationId: string, threadUserId: string, side: 'ADMIN' | 'OPERATOR', at: string): Promise<void> {
    const col = side === 'ADMIN' ? { adminReadAt: new Date(at) } : { operatorReadAt: new Date(at) };
    await this.db.opsThreadRead.upsert({
      where: { operationId_threadUserId: { operationId, threadUserId } },
      create: { operationId, threadUserId, ...col },
      update: col,
    });
  }
  async getRead(operationId: string, threadUserId: string): Promise<OpsThreadRead | null> {
    const r = await this.db.opsThreadRead.findUnique({ where: { operationId_threadUserId: { operationId, threadUserId } } });
    return r ? {
      operationId: r.operationId,
      threadUserId: r.threadUserId,
      adminReadAt: r.adminReadAt ? (r.adminReadAt as Date).toISOString() : null,
      operatorReadAt: r.operatorReadAt ? (r.operatorReadAt as Date).toISOString() : null,
    } : null;
  }
}

export class PrismaCopilotSettingsRepository implements CopilotSettingsRepository {
  constructor(private readonly db: PrismaClient) {}
  async get(operationId: string): Promise<CopilotSettings | null> {
    const r = await this.db.copilotSetting.findUnique({ where: { operationId } });
    return r ? { operationId: r.operationId, actionMode: (r.actionMode === 'direct' ? 'direct' : 'confirm') } : null;
  }
  async save(s: CopilotSettings): Promise<void> {
    await this.db.copilotSetting.upsert({ where: { operationId: s.operationId }, create: { operationId: s.operationId, actionMode: s.actionMode }, update: { actionMode: s.actionMode } });
  }
}

export class PrismaCostRepository implements CostRepository {
  constructor(private readonly db: PrismaClient) {}
  private toDomain(r: any): CostRateCard {
    return {
      operationId: r.operationId,
      currency: r.currency,
      standardLaborRatePerHour: r.standardLaborRatePerHour,
      laborCostByRole: (r.laborCostByRole || {}) as Record<string, number>,
      laborCostByOperator: (r.laborCostByOperator || {}) as Record<string, number>,
      standardUph: (r.standardUph || {}) as Record<string, number>,
      storageCostPerUnitMonth: r.storageCostPerUnitMonth,
      packagingCostRatio: r.packagingCostRatio,
      monthlyOverhead: r.monthlyOverhead,
      overheadDriver: (r.overheadDriver || 'laborHours') as 'laborHours' | 'unitMonths' | 'orders',
      updatedAt: (r.updatedAt as Date).toISOString(),
      updatedBy: r.updatedBy ?? null,
    };
  }
  async getCard(operationId: string): Promise<CostRateCard | null> {
    const r = await this.db.costRateCard.findUnique({ where: { operationId } });
    return r ? this.toDomain(r) : null;
  }
  async saveCard(card: CostRateCard): Promise<CostRateCard> {
    const data = {
      currency: card.currency,
      standardLaborRatePerHour: card.standardLaborRatePerHour,
      laborCostByRole: card.laborCostByRole as unknown as object,
      laborCostByOperator: card.laborCostByOperator as unknown as object,
      standardUph: card.standardUph as unknown as object,
      storageCostPerUnitMonth: card.storageCostPerUnitMonth,
      packagingCostRatio: card.packagingCostRatio,
      monthlyOverhead: card.monthlyOverhead,
      overheadDriver: card.overheadDriver,
      updatedAt: new Date(card.updatedAt),
      updatedBy: card.updatedBy,
    };
    const r = await this.db.costRateCard.upsert({
      where: { operationId: card.operationId },
      create: { operationId: card.operationId, ...data },
      update: data,
    });
    return this.toDomain(r);
  }
}

export class PrismaCountAuditRepository implements CountAuditRepository {
  constructor(private readonly db: PrismaClient) {}
  private toDomain(r: any): CountAudit {
    return {
      id: r.id, operationId: r.operationId, sellerId: r.sellerId, locationId: r.locationId,
      at: (r.at as Date).toISOString(), linesCounted: r.linesCounted, linesAccurate: r.linesAccurate,
      unitsExpected: r.unitsExpected, absVarianceUnits: r.absVarianceUnits, accuracyPct: r.accuracyPct,
      variances: r.variances || [],
    };
  }
  async save(a: CountAudit): Promise<void> {
    await this.db.countVariance.create({
      data: {
        id: a.id, operationId: a.operationId, sellerId: a.sellerId, locationId: a.locationId,
        at: new Date(a.at), linesCounted: a.linesCounted, linesAccurate: a.linesAccurate,
        unitsExpected: a.unitsExpected, absVarianceUnits: a.absVarianceUnits, accuracyPct: a.accuracyPct,
        variances: a.variances as unknown as object,
      },
    });
  }
  async list(operationId: string, opts?: { sellerId?: string | null; limit?: number }): Promise<CountAudit[]> {
    const rows = await this.db.countVariance.findMany({
      where: { operationId, ...(opts?.sellerId ? { sellerId: opts.sellerId } : {}) },
      orderBy: { at: 'desc' },
      ...(opts?.limit ? { take: opts.limit } : {}),
    });
    return rows.map((r: any) => this.toDomain(r));
  }
}

export class PrismaEventRepository implements EventRepository {
  constructor(private readonly db: PrismaClient) {}
  private toDomain(r: any): DomainEvent {
    return {
      id: r.id, entityType: r.entityType, entityId: r.entityId, entityRef: r.entityRef ?? null,
      sellerId: r.sellerId, seq: r.seq, type: r.type, at: (r.at as Date).toISOString(),
      actor: r.actor, detail: r.detail ?? null,
    };
  }
  async append(events: DomainEvent[]): Promise<void> {
    if (!events.length) return;
    // Idempotente: el id es determinístico, así que re-guardar una entidad no duplica.
    await this.db.domainEvent.createMany({
      data: events.map((e) => ({
        id: e.id, entityType: e.entityType, entityId: e.entityId, entityRef: e.entityRef,
        sellerId: e.sellerId, seq: e.seq, type: e.type, at: new Date(e.at), actor: e.actor, detail: e.detail,
      })),
      skipDuplicates: true,
    });
  }
  async listByEntity(entityId: string): Promise<DomainEvent[]> {
    const rows = await this.db.domainEvent.findMany({ where: { entityId }, orderBy: { seq: 'asc' } });
    return rows.map((r: any) => this.toDomain(r));
  }
  async query(opts: { sellerIds?: string[]; entityType?: DomainEntityType; type?: string; from?: string; to?: string; limit?: number }): Promise<DomainEvent[]> {
    const where: any = {};
    if (opts.sellerIds && opts.sellerIds.length) where.sellerId = { in: opts.sellerIds };
    if (opts.entityType) where.entityType = opts.entityType;
    if (opts.type) where.type = opts.type;
    if (opts.from || opts.to) where.at = { ...(opts.from ? { gte: new Date(opts.from) } : {}), ...(opts.to ? { lte: new Date(opts.to) } : {}) };
    const rows = await this.db.domainEvent.findMany({
      where,
      orderBy: [{ entityId: 'asc' }, { seq: 'asc' }],
      ...(opts.limit ? { take: opts.limit } : {}),
    });
    return rows.map((r: any) => this.toDomain(r));
  }
  async count(): Promise<number> { return this.db.domainEvent.count(); }
}

export class PrismaRollupRepository implements RollupRepository {
  constructor(private readonly db: PrismaClient) {}
  async saveInventorySnapshots(rows: DailyInventorySnapshot[]): Promise<void> {
    for (const r of rows) {
      await this.db.dailyInventorySnapshot.upsert({
        where: { id: r.id },
        create: r as any,
        update: { available: r.available, reserved: r.reserved, quarantine: r.quarantine, damaged: r.damaged, inTransit: r.inTransit, total: r.total },
      });
    }
  }
  async saveDemand(rows: DailyDemand[]): Promise<void> {
    for (const r of rows) {
      await this.db.dailyDemand.upsert({
        where: { id: r.id },
        create: r as any,
        update: { unitsShipped: r.unitsShipped, orders: r.orders },
      });
    }
  }
  async saveMetricRollups(rows: DailyMetricRollup[]): Promise<void> {
    for (const r of rows) {
      await this.db.dailyMetricRollup.upsert({
        where: { id: r.id },
        create: r as any,
        update: { ordersPrepared: r.ordersPrepared, unitsPrepared: r.unitsPrepared, ordersReceived: r.ordersReceived, unitsReceived: r.unitsReceived, movements: r.movements },
      });
    }
  }
  private dateWhere(fromDate?: string, toDate?: string) {
    if (!fromDate && !toDate) return {};
    return { date: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lte: toDate } : {}) } };
  }
  async listInventorySnapshots(sellerId: string, opts?: { sku?: string | null; fromDate?: string; toDate?: string }): Promise<DailyInventorySnapshot[]> {
    return this.db.dailyInventorySnapshot.findMany({
      where: { sellerId, ...(opts?.sku ? { sku: opts.sku } : {}), ...this.dateWhere(opts?.fromDate, opts?.toDate) },
      orderBy: { date: 'asc' },
    });
  }
  async listDemand(sellerId: string, opts?: { sku?: string | null; fromDate?: string; toDate?: string }): Promise<DailyDemand[]> {
    return this.db.dailyDemand.findMany({
      where: { sellerId, ...(opts?.sku ? { sku: opts.sku } : {}), ...this.dateWhere(opts?.fromDate, opts?.toDate) },
      orderBy: { date: 'asc' },
    });
  }
  async listMetricRollups(sellerId: string, opts?: { fromDate?: string; toDate?: string }): Promise<DailyMetricRollup[]> {
    return this.db.dailyMetricRollup.findMany({
      where: { sellerId, ...this.dateWhere(opts?.fromDate, opts?.toDate) },
      orderBy: { date: 'asc' },
    });
  }
  async countAll(): Promise<{ snapshots: number; demand: number; metrics: number }> {
    const [snapshots, demand, metrics] = await Promise.all([
      this.db.dailyInventorySnapshot.count(), this.db.dailyDemand.count(), this.db.dailyMetricRollup.count(),
    ]);
    return { snapshots, demand, metrics };
  }
}

export class PrismaLaborTaskRepository implements LaborTaskRepository {
  constructor(private readonly db: PrismaClient) {}
  private toDomain(r: any): LaborTask {
    return {
      id: r.id, operationId: r.operationId, sellerId: r.sellerId ?? null, operator: r.operator,
      type: r.type as LaborTaskType, startAt: (r.startAt as Date).toISOString(), endAt: (r.endAt as Date).toISOString(),
      units: r.units, orderRef: r.orderRef ?? null, locationId: r.locationId ?? null, source: r.source,
    };
  }
  async append(tasks: LaborTask[]): Promise<void> {
    if (!tasks.length) return;
    await this.db.laborTask.createMany({
      data: tasks.map((t) => ({
        id: t.id, operationId: t.operationId, sellerId: t.sellerId, operator: t.operator, type: t.type,
        startAt: new Date(t.startAt), endAt: new Date(t.endAt), units: t.units, orderRef: t.orderRef, locationId: t.locationId, source: t.source,
      })),
      skipDuplicates: true, // idempotente por id
    });
  }
  async list(operationId: string, opts?: { operator?: string | null; type?: string | null; from?: string; to?: string; limit?: number }): Promise<LaborTask[]> {
    const where: any = { operationId };
    if (opts?.operator) where.operator = opts.operator;
    if (opts?.type) where.type = opts.type;
    if (opts?.from || opts?.to) where.startAt = { ...(opts?.from ? { gte: new Date(opts.from) } : {}), ...(opts?.to ? { lte: new Date(opts.to) } : {}) };
    const rows = await this.db.laborTask.findMany({ where, orderBy: { startAt: 'desc' }, ...(opts?.limit ? { take: opts.limit } : {}) });
    return rows.map((r: any) => this.toDomain(r));
  }
  async count(): Promise<number> { return this.db.laborTask.count(); }
}

export class PrismaAiAuditRepository implements AiAuditRepository {
  constructor(private readonly db: PrismaClient) {}
  private recDomain(r: any): AiRecommendation {
    return { id: r.id, operationId: r.operationId, sellerId: r.sellerId ?? null, type: r.type, input: r.input, output: r.output, score: r.score ?? null, taken: r.taken ?? null, outcome: r.outcome ?? null, actor: r.actor ?? null, at: (r.at as Date).toISOString() };
  }
  private actDomain(r: any): AgentAction {
    return { id: r.id, operationId: r.operationId, sellerId: r.sellerId ?? null, agent: r.agent, decision: r.decision, actor: r.actor, orderRef: r.orderRef ?? null, result: r.result, recommendationId: r.recommendationId ?? null, at: (r.at as Date).toISOString() };
  }
  async saveRecommendation(rec: AiRecommendation): Promise<void> {
    await this.db.aiRecommendation.upsert({
      where: { id: rec.id },
      create: { ...rec, at: new Date(rec.at) },
      update: { taken: rec.taken, outcome: rec.outcome, score: rec.score },
    });
  }
  async updateRecommendation(id: string, patch: { taken?: boolean | null; outcome?: string | null }): Promise<void> {
    await this.db.aiRecommendation.update({ where: { id }, data: { ...(patch.taken !== undefined ? { taken: patch.taken } : {}), ...(patch.outcome !== undefined ? { outcome: patch.outcome } : {}) } }).catch(() => {});
  }
  async getRecommendation(id: string): Promise<AiRecommendation | null> {
    const r = await this.db.aiRecommendation.findUnique({ where: { id } });
    return r ? this.recDomain(r) : null;
  }
  async listRecommendations(operationId: string, opts?: { type?: string | null; from?: string; to?: string; limit?: number }): Promise<AiRecommendation[]> {
    const where: any = { operationId };
    if (opts?.type) where.type = opts.type;
    if (opts?.from || opts?.to) where.at = { ...(opts?.from ? { gte: new Date(opts.from) } : {}), ...(opts?.to ? { lte: new Date(opts.to) } : {}) };
    const rows = await this.db.aiRecommendation.findMany({ where, orderBy: { at: 'desc' }, ...(opts?.limit ? { take: opts.limit } : {}) });
    return rows.map((r: any) => this.recDomain(r));
  }
  async saveAction(action: AgentAction): Promise<void> {
    await this.db.agentAction.upsert({ where: { id: action.id }, create: { ...action, at: new Date(action.at) }, update: { result: action.result } });
  }
  async listActions(operationId: string, opts?: { agent?: string | null; from?: string; to?: string; limit?: number }): Promise<AgentAction[]> {
    const where: any = { operationId };
    if (opts?.agent) where.agent = opts.agent;
    if (opts?.from || opts?.to) where.at = { ...(opts?.from ? { gte: new Date(opts.from) } : {}), ...(opts?.to ? { lte: new Date(opts.to) } : {}) };
    const rows = await this.db.agentAction.findMany({ where, orderBy: { at: 'desc' }, ...(opts?.limit ? { take: opts.limit } : {}) });
    return rows.map((r: any) => this.actDomain(r));
  }
  async countAll(): Promise<{ recommendations: number; actions: number }> {
    const [recommendations, actions] = await Promise.all([this.db.aiRecommendation.count(), this.db.agentAction.count()]);
    return { recommendations, actions };
  }
}

export class PrismaWorkAssignmentRepository implements WorkAssignmentRepository {
  constructor(private readonly db: PrismaClient) {}
  private toDomain(r: any): WorkAssignment {
    return {
      id: r.id, operationId: r.operationId, sellerId: r.sellerId ?? null, type: r.type as WorkTaskType,
      entityId: r.entityId, entityRef: r.entityRef ?? null, operator: r.operator, status: r.status as WorkAssignmentStatus,
      unitsEstimate: r.unitsEstimate, assignedBy: r.assignedBy, assignedAt: (r.assignedAt as Date).toISOString(),
      completedAt: r.completedAt ? (r.completedAt as Date).toISOString() : null, completedBy: r.completedBy ?? null, note: r.note ?? null,
    };
  }
  async save(a: WorkAssignment): Promise<void> {
    const data = { ...a, assignedAt: new Date(a.assignedAt), completedAt: a.completedAt ? new Date(a.completedAt) : null };
    await this.db.workAssignment.upsert({ where: { id: a.id }, create: data, update: data });
  }
  async get(id: string): Promise<WorkAssignment | null> {
    const r = await this.db.workAssignment.findUnique({ where: { id } });
    return r ? this.toDomain(r) : null;
  }
  async listOpen(operationId: string, opts?: { type?: WorkTaskType; operator?: string | null }): Promise<WorkAssignment[]> {
    const rows = await this.db.workAssignment.findMany({ where: { operationId, status: { in: ['assigned', 'in_progress'] }, ...(opts?.type ? { type: opts.type } : {}), ...(opts?.operator ? { operator: opts.operator } : {}) }, orderBy: { assignedAt: 'asc' } });
    return rows.map((r: any) => this.toDomain(r));
  }
  async listByOperator(operationId: string, operator: string, opts?: { includeCompleted?: boolean }): Promise<WorkAssignment[]> {
    const rows = await this.db.workAssignment.findMany({ where: { operationId, operator, ...(opts?.includeCompleted ? {} : { status: { in: ['assigned', 'in_progress'] } }) }, orderBy: { assignedAt: 'asc' } });
    return rows.map((r: any) => this.toDomain(r));
  }
  async list(operationId: string, opts?: { type?: WorkTaskType; status?: WorkAssignmentStatus; limit?: number }): Promise<WorkAssignment[]> {
    const rows = await this.db.workAssignment.findMany({ where: { operationId, ...(opts?.type ? { type: opts.type } : {}), ...(opts?.status ? { status: opts.status } : {}) }, orderBy: { assignedAt: 'desc' }, ...(opts?.limit ? { take: opts.limit } : {}) });
    return rows.map((r: any) => this.toDomain(r));
  }
}

export class PrismaWorkTaskRepository implements WorkTaskRepository {
  constructor(private readonly db: PrismaClient) {}
  private get t(): any { return (this.db as any).workTask; }
  private toDomain(r: any): WorkTask {
    return {
      id: `t-${r.seq}`, operationId: r.operationId, sellerId: r.sellerId ?? null, type: r.type as WorkTaskStage,
      orderId: r.orderId ?? null, orderRef: r.orderRef ?? null, entityId: r.entityId, entityRef: r.entityRef ?? null,
      state: r.state as WorkTaskState, unitsEstimate: r.unitsEstimate, assignmentId: r.assignmentId ?? null, operator: r.operator ?? null,
      createdAt: (r.createdAt as Date).toISOString(), createdBy: r.createdBy,
      startedAt: r.startedAt ? (r.startedAt as Date).toISOString() : null,
      completedAt: r.completedAt ? (r.completedAt as Date).toISOString() : null, completedBy: r.completedBy ?? null, note: r.note ?? null,
    };
  }
  private toRow(t: Omit<WorkTask, 'id'>): any {
    return {
      operationId: t.operationId, sellerId: t.sellerId, type: t.type, orderId: t.orderId, orderRef: t.orderRef,
      entityId: t.entityId, entityRef: t.entityRef, state: t.state, unitsEstimate: t.unitsEstimate,
      assignmentId: t.assignmentId, operator: t.operator, createdAt: new Date(t.createdAt), createdBy: t.createdBy,
      startedAt: t.startedAt ? new Date(t.startedAt) : null, completedAt: t.completedAt ? new Date(t.completedAt) : null,
      completedBy: t.completedBy, note: t.note,
    };
  }
  private seqOf(id: string): number { return parseInt(id.replace(/^t-/, ''), 10); }
  async create(input: Omit<WorkTask, 'id'>): Promise<WorkTask> {
    const r = await this.t.create({ data: this.toRow(input) });
    return this.toDomain(r);
  }
  async update(task: WorkTask): Promise<void> {
    const { id, ...rest } = task;
    await this.t.update({ where: { seq: this.seqOf(id) }, data: this.toRow(rest) });
  }
  async get(id: string): Promise<WorkTask | null> {
    const r = await this.t.findUnique({ where: { seq: this.seqOf(id) } });
    return r ? this.toDomain(r) : null;
  }
  async listByOrder(operationId: string, orderId: string): Promise<WorkTask[]> {
    const rows = await this.t.findMany({ where: { operationId, orderId }, orderBy: { seq: 'desc' } });
    return rows.map((r: any) => this.toDomain(r));
  }
  async findOpen(operationId: string, type: WorkTaskStage, entityId: string): Promise<WorkTask | null> {
    const r = await this.t.findFirst({ where: { operationId, type, entityId, state: { in: ['pending', 'assigned', 'in_progress'] } }, orderBy: { seq: 'desc' } });
    return r ? this.toDomain(r) : null;
  }
  async list(operationId: string, opts?: { type?: WorkTaskStage; state?: WorkTaskState; sellerId?: string | null; limit?: number }): Promise<WorkTask[]> {
    const rows = await this.t.findMany({
      where: { operationId, ...(opts?.type ? { type: opts.type } : {}), ...(opts?.state ? { state: opts.state } : {}), ...(opts?.sellerId ? { sellerId: opts.sellerId } : {}) },
      orderBy: { seq: 'desc' }, ...(opts?.limit ? { take: opts.limit } : {}),
    });
    return rows.map((r: any) => this.toDomain(r));
  }
}

export class PrismaAgentRuleConfigRepository implements AgentRuleConfigRepository {
  constructor(private readonly db: PrismaClient) {}
  private get t(): any { return (this.db as any).agentRuleConfig; }
  private toDomain(r: any): AgentRuleConfig {
    return { operationId: r.operationId, ruleKey: r.ruleKey, enabled: !!r.enabled, threshold: r.threshold,
      cooldownMin: r.cooldownMin, severity: r.severity as AgentRuleSeverity, sellerId: r.sellerId ?? null,
      actionType: (r.actionType ?? 'alert') as AgentActionType, actionMode: (r.actionMode ?? 'confirmar') as AgentActionMode,
      updatedAt: (r.updatedAt as Date).toISOString(), updatedBy: r.updatedBy ?? null };
  }
  async get(operationId: string, ruleKey: string): Promise<AgentRuleConfig | null> {
    const r = await this.t.findUnique({ where: { operationId_ruleKey: { operationId, ruleKey } } });
    return r ? this.toDomain(r) : null;
  }
  async listByOperation(operationId: string): Promise<AgentRuleConfig[]> {
    const rows = await this.t.findMany({ where: { operationId } });
    return rows.map((r: any) => this.toDomain(r));
  }
  async save(c: AgentRuleConfig): Promise<void> {
    const data = { operationId: c.operationId, ruleKey: c.ruleKey, enabled: c.enabled, threshold: c.threshold,
      cooldownMin: c.cooldownMin, severity: c.severity, sellerId: c.sellerId, actionType: c.actionType, actionMode: c.actionMode, updatedAt: new Date(c.updatedAt), updatedBy: c.updatedBy };
    await this.t.upsert({ where: { operationId_ruleKey: { operationId: c.operationId, ruleKey: c.ruleKey } }, create: data, update: data });
  }
}

export class PrismaAgentAlertRepository implements AgentAlertRepository {
  constructor(private readonly db: PrismaClient) {}
  private get t(): any { return (this.db as any).agentAlert; }
  private toDomain(r: any): AgentAlert {
    return { id: r.id, operationId: r.operationId, sellerId: r.sellerId ?? null, ruleKey: r.ruleKey,
      severity: r.severity as AgentRuleSeverity, title: r.title, detail: r.detail, action: r.action ?? null, link: r.link ?? null,
      entityRef: r.entityRef ?? null, dedupeKey: r.dedupeKey, status: r.status as AgentAlertStatus,
      actionTool: r.actionTool ?? null, actionLabel: r.actionLabel ?? null, actionStatus: (r.actionStatus ?? 'none') as AgentAlertActionStatus, actionResult: r.actionResult ?? null,
      createdAt: (r.createdAt as Date).toISOString(), ackAt: r.ackAt ? (r.ackAt as Date).toISOString() : null, ackBy: r.ackBy ?? null };
  }
  private row(a: Omit<AgentAlert, 'id'>): any {
    return { operationId: a.operationId, sellerId: a.sellerId, ruleKey: a.ruleKey, severity: a.severity, title: a.title,
      detail: a.detail, action: a.action, link: a.link, entityRef: a.entityRef, dedupeKey: a.dedupeKey, status: a.status,
      actionTool: a.actionTool, actionLabel: a.actionLabel, actionStatus: a.actionStatus, actionResult: a.actionResult,
      createdAt: new Date(a.createdAt), ackAt: a.ackAt ? new Date(a.ackAt) : null, ackBy: a.ackBy };
  }
  async create(input: Omit<AgentAlert, 'id'>): Promise<AgentAlert> {
    const r = await this.t.create({ data: this.row(input) }); return this.toDomain(r);
  }
  async get(id: string): Promise<AgentAlert | null> { const r = await this.t.findUnique({ where: { id } }); return r ? this.toDomain(r) : null; }
  async listOpen(operationId: string): Promise<AgentAlert[]> {
    const rows = await this.t.findMany({ where: { operationId, status: 'open' }, orderBy: { createdAt: 'desc' } });
    return rows.map((r: any) => this.toDomain(r));
  }
  async listRecent(operationId: string, limit: number): Promise<AgentAlert[]> {
    const rows = await this.t.findMany({ where: { operationId }, orderBy: { createdAt: 'desc' }, take: limit });
    return rows.map((r: any) => this.toDomain(r));
  }
  async findOpenByDedupe(operationId: string, dedupeKey: string): Promise<AgentAlert | null> {
    const r = await this.t.findFirst({ where: { operationId, dedupeKey, status: 'open' }, orderBy: { createdAt: 'desc' } });
    return r ? this.toDomain(r) : null;
  }
  async lastByDedupe(operationId: string, dedupeKey: string): Promise<AgentAlert | null> {
    const r = await this.t.findFirst({ where: { operationId, dedupeKey }, orderBy: { createdAt: 'desc' } });
    return r ? this.toDomain(r) : null;
  }
  async save(a: AgentAlert): Promise<void> {
    const { id } = a; await this.t.update({ where: { id }, data: this.row(a) });
  }
}

export class PrismaPlanConfigRepository implements PlanConfigRepository {
  constructor(private readonly db: PrismaClient) {}
  private toDomain(r: any): PlanConfig {
    const d = r.data || {};
    return { planId: r.planId, name: d.name, prices: d.prices || { usd: null, clp: null }, blurb: d.blurb, limits: d.limits, features: d.features || [] };
  }
  async list(): Promise<PlanConfig[]> {
    const rows = await this.db.planConfig.findMany();
    return rows.map((r: any) => this.toDomain(r));
  }
  async get(planId: string): Promise<PlanConfig | null> {
    const r = await this.db.planConfig.findUnique({ where: { planId } });
    return r ? this.toDomain(r) : null;
  }
  async save(c: PlanConfig): Promise<void> {
    const data = { name: c.name, prices: c.prices, blurb: c.blurb, limits: c.limits, features: c.features };
    await this.db.planConfig.upsert({ where: { planId: c.planId }, create: { planId: c.planId, data }, update: { data } });
  }
  async clear(): Promise<void> {
    await this.db.planConfig.deleteMany({});
  }
}

export class PrismaAuthTokenRepository implements AuthTokenRepository {
  constructor(private readonly db: PrismaClient) {}
  private toDomain(t: any): AuthToken {
    return {
      id: t.id, userId: t.userId, kind: t.kind as AuthTokenKind, token: t.token,
      createdAt: (t.createdAt as Date).toISOString(), expiresAt: (t.expiresAt as Date).toISOString(),
      usedAt: t.usedAt ? (t.usedAt as Date).toISOString() : null,
    };
  }
  async create(t: AuthToken): Promise<void> {
    await this.db.authToken.create({
      data: { id: t.id, userId: t.userId, kind: t.kind, token: t.token, createdAt: new Date(t.createdAt), expiresAt: new Date(t.expiresAt), usedAt: t.usedAt ? new Date(t.usedAt) : null },
    });
  }
  async findByToken(token: string): Promise<AuthToken | null> {
    const t = await this.db.authToken.findUnique({ where: { token } });
    return t ? this.toDomain(t) : null;
  }
  async markUsed(id: string, usedAt: string): Promise<void> {
    await this.db.authToken.update({ where: { id }, data: { usedAt: new Date(usedAt) } });
  }
  async invalidateForUser(userId: string, kind: AuthTokenKind, usedAt: string): Promise<void> {
    await this.db.authToken.updateMany({ where: { userId, kind, usedAt: null }, data: { usedAt: new Date(usedAt) } });
  }
}

export class PrismaAiConfigRepository implements AiConfigRepository {
  constructor(private readonly db: PrismaClient) {}
  private key(sellerId: string | null) { return sellerId || '*'; }
  async get(operationId: string, sellerId: string | null): Promise<AiCredential | null> {
    const r = await this.db.aiCredential.findUnique({ where: { operationId_sellerKey: { operationId, sellerKey: this.key(sellerId) } } });
    if (!r) return null;
    return {
      operationId: r.operationId, sellerId: r.sellerKey === '*' ? null : r.sellerKey,
      provider: r.provider, baseUrl: r.baseUrl, chatModel: r.chatModel, apiKey: r.apiKey,
      active: r.active, updatedAt: (r.updatedAt as Date).toISOString(),
    };
  }
  async save(c: AiCredential): Promise<void> {
    const cols = { provider: c.provider, baseUrl: c.baseUrl, chatModel: c.chatModel, apiKey: c.apiKey, active: c.active, updatedAt: new Date(c.updatedAt) };
    await this.db.aiCredential.upsert({
      where: { operationId_sellerKey: { operationId: c.operationId, sellerKey: this.key(c.sellerId) } },
      create: { operationId: c.operationId, sellerKey: this.key(c.sellerId), ...cols },
      update: cols,
    });
  }
  async delete(operationId: string, sellerId: string | null): Promise<void> {
    await this.db.aiCredential.deleteMany({ where: { operationId, sellerKey: this.key(sellerId) } });
  }
}

export class PrismaLocationRepository implements LocationRepository {
  constructor(private readonly db: PrismaClient) {}
  private toDomain(l: any): Location {
    return {
      id: l.id, operationId: l.operationId, warehouseId: l.warehouseId, code: l.code,
      zoneType: l.zoneType as ZoneType, capacity: l.capacity, pickRank: l.pickRank, active: l.active,
      x: l.x ?? null, y: l.y ?? null,
    };
  }
  async findById(locationId: string): Promise<Location | null> {
    const l = await this.db.location.findUnique({ where: { id: locationId } });
    return l ? this.toDomain(l) : null;
  }
  async findByCode(operationId: string, code: string): Promise<Location | null> {
    const l = await this.db.location.findFirst({ where: { operationId, code } });
    return l ? this.toDomain(l) : null;
  }
  async save(location: Location): Promise<void> {
    await this.db.location.upsert({
      where: { id: location.id },
      create: { ...location },
      update: {
        operationId: location.operationId,
        warehouseId: location.warehouseId,
        code: location.code,
        zoneType: location.zoneType,
        capacity: location.capacity,
        pickRank: location.pickRank,
        active: location.active,
        x: location.x ?? null,
        y: location.y ?? null,
      },
    });
  }
  async listByOperation(operationId: string): Promise<Location[]> {
    const rows = await this.db.location.findMany({ where: { operationId } });
    return rows.map((l: any) => this.toDomain(l));
  }
}

export class PrismaOrderRepository implements OrderRepository {
  constructor(private readonly db: PrismaClient, private readonly events?: EventRepository) {}

  async save(order: SalesOrder): Promise<void> {
    // Upsert de la cabecera + reemplazo de líneas (simple y consistente para el skeleton).
    await this.db.$transaction([
      this.db.salesOrder.upsert({
        where: { id: order.id },
        create: {
          id: order.id,
          sellerId: order.sellerId,
          externalOrderId: order.externalOrderId,
          salesChannel: order.salesChannel,
          orderType: order.orderType,
          purchaseOrderRef: order.purchaseOrderRef,
          documentType: order.documentType,
          carrier: order.carrier,
          priority: order.priority,
          shipTo: order.shipTo as unknown as object,
          status: order.status,
          createdAt: new Date(order.createdAt),
          // Historial de auditoría en la cabecera: lo leen facturación (evento SHIPPED del
          // período), métricas y actividad. Antes no se persistía y en producción (Prisma)
          // toda orden volvía con events=[] → despacho/picking facturados en 0.
          events: (order.events ?? []) as unknown as object,
          ...(order.shipment ? { shipment: order.shipment as unknown as object } : {}),
          ...(order.packing ? { packing: order.packing as unknown as object } : {}),
        },
        update: {
          status: order.status,
          priority: order.priority,
          purchaseOrderRef: order.purchaseOrderRef,
          documentType: order.documentType,
          carrier: order.carrier,
          shipTo: order.shipTo as unknown as object,
          events: (order.events ?? []) as unknown as object,
          ...(order.shipment ? { shipment: order.shipment as unknown as object } : {}),
          ...(order.packing ? { packing: order.packing as unknown as object } : {}),
        },
      }),
      this.db.orderLine.deleteMany({ where: { orderId: order.id } }),
      this.db.orderLine.createMany({
        data: order.lines.map((l) => ({
          id: `${order.id}:${l.lineNo}`,
          orderId: order.id,
          lineNo: l.lineNo,
          sku: l.sku,
          qty: l.qty,
          uom: l.uom,
          lot: l.lot,
          allocations: l.allocations as unknown as object,
        })),
      }),
    ]);
    // Dual-write (G2+G6): el SalesOrder no persiste `events` en su cabecera, así que
    // el event store es la única fuente consultable de su historial. Idempotente por id.
    await this.events?.append(toDomainEvents('ORDER', order.id, order.externalOrderId, order.sellerId, order.events));
  }

  async findById(sellerId: string, orderId: string): Promise<SalesOrder | null> {
    const o = await this.db.salesOrder.findFirst({
      where: { id: orderId, sellerId }, // aislamiento por seller
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    return o ? this.toDomain(o) : null;
  }

  async findByExternal(sellerId: string, externalOrderId: string): Promise<SalesOrder | null> {
    if (!externalOrderId) return null;
    const o = await this.db.salesOrder.findFirst({
      where: { sellerId, externalOrderId },
      orderBy: { createdAt: 'asc' }, // el "primero" ante duplicados históricos
      include: { lines: { orderBy: { lineNo: 'asc' } } },
    });
    return o ? this.toDomain(o) : null;
  }

  async delete(sellerId: string, orderId: string): Promise<void> {
    // Verifica pertenencia al seller antes de borrar (aislamiento).
    const o = await this.db.salesOrder.findFirst({ where: { id: orderId, sellerId } });
    if (!o) return;
    await this.db.$transaction([
      this.db.orderLine.deleteMany({ where: { orderId } }),
      this.db.salesOrder.delete({ where: { id: orderId } }),
    ]);
  }

  async list(sellerId: string): Promise<SalesOrder[]> {
    const rows = await this.db.salesOrder.findMany({
      where: { sellerId },
      include: { lines: { orderBy: { lineNo: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((o: any) => this.toDomain(o));
  }

  private toDomain(o: any): SalesOrder {
    return {
      id: o.id,
      sellerId: o.sellerId,
      externalOrderId: o.externalOrderId,
      salesChannel: o.salesChannel,
      orderType: o.orderType as OrderType,
      purchaseOrderRef: o.purchaseOrderRef,
      documentType: o.documentType ?? null,
      carrier: o.carrier ?? null,
      priority: o.priority,
      shipTo: o.shipTo as ShipTo,
      status: o.status as OrderStatus,
      packing: (o.packing as any) ?? null,
      shipment: (o.shipment as Shipment) ?? null,
      createdAt: (o.createdAt as Date).toISOString(),
      events: (o.events as any) ?? [], // historial de auditoría (columna JSON opcional)
      lines: (o.lines as any[]).map((l) => ({
        lineNo: l.lineNo,
        sku: l.sku,
        qty: l.qty,
        uom: l.uom as Uom,
        lot: l.lot ?? null,
        allocations: (l.allocations as Allocation[]) ?? [],
      })),
    };
  }
}

export class PrismaReceiptOrderRepository implements ReceiptOrderRepository {
  constructor(private readonly db: PrismaClient, private readonly events?: EventRepository) {}

  async save(order: ReceiptOrder): Promise<void> {
    await this.db.receiptOrder.upsert({
      where: { id: order.id },
      create: {
        id: order.id,
        sellerId: order.sellerId,
        supplier: order.supplier,
        reference: order.reference,
        locationId: order.locationId,
        notes: order.notes,
        status: order.status,
        lines: order.lines as unknown as object,
        events: order.events as unknown as object,
        createdAt: new Date(order.createdAt),
        createdBy: order.createdBy,
      },
      update: {
        supplier: order.supplier,
        reference: order.reference,
        locationId: order.locationId,
        notes: order.notes,
        status: order.status,
        lines: order.lines as unknown as object,
        events: order.events as unknown as object,
      },
    });
    // Normalización (G8): reemplaza las líneas en la tabla ReceiptLine para analytics por línea.
    await this.db.receiptLine.deleteMany({ where: { receiptId: order.id } });
    if (order.lines?.length) {
      await this.db.receiptLine.createMany({
        data: order.lines.map((l: any) => ({
          id: `${order.id}:${l.lineNo}`, receiptId: order.id, lineNo: l.lineNo, sku: l.sku,
          qty: l.qty, uom: l.uom ?? 'EA', lot: l.lot ?? null, expiry: l.expiry ? new Date(l.expiry) : null,
        })),
      });
    }
    // Dual-write (G2+G6): promueve el historial al event store consultable.
    await this.events?.append(toDomainEvents('RECEIPT', order.id, order.reference ?? null, order.sellerId, order.events));
  }

  async findById(sellerId: string, orderId: string): Promise<ReceiptOrder | null> {
    const o = await this.db.receiptOrder.findFirst({ where: { id: orderId, sellerId } });
    return o ? this.toDomain(o) : null;
  }

  async list(sellerId: string): Promise<ReceiptOrder[]> {
    const rows = await this.db.receiptOrder.findMany({ where: { sellerId }, orderBy: { createdAt: 'desc' } });
    return rows.map((o: any) => this.toDomain(o));
  }

  async delete(sellerId: string, orderId: string): Promise<void> {
    await this.db.receiptOrder.deleteMany({ where: { id: orderId, sellerId } });
  }

  private toDomain(o: any): ReceiptOrder {
    return {
      id: o.id,
      sellerId: o.sellerId,
      supplier: o.supplier ?? null,
      reference: o.reference ?? null,
      locationId: o.locationId,
      notes: o.notes ?? null,
      status: o.status,
      lines: (o.lines as any) ?? [],
      createdAt: (o.createdAt instanceof Date ? o.createdAt.toISOString() : o.createdAt),
      createdBy: o.createdBy ?? 'system',
      events: (o.events as any) ?? [],
    };
  }
}

export class PrismaReturnOrderRepository implements ReturnOrderRepository {
  constructor(private readonly db: PrismaClient, private readonly events?: EventRepository) {}

  async save(order: ReturnOrder): Promise<void> {
    await this.db.returnOrder.upsert({
      where: { id: order.id },
      create: {
        id: order.id,
        sellerId: order.sellerId,
        originalOrderId: order.originalOrderId,
        originalOrderRef: order.originalOrderRef,
        reason: order.reason,
        status: order.status,
        lines: order.lines as unknown as object,
        events: order.events as unknown as object,
        createdAt: new Date(order.createdAt),
      },
      update: {
        status: order.status,
        reason: order.reason,
        lines: order.lines as unknown as object,
        events: order.events as unknown as object,
      },
    });
    // Normalización (G8): reemplaza las líneas en la tabla ReturnLine para analytics por línea.
    await this.db.returnLine.deleteMany({ where: { returnId: order.id } });
    if (order.lines?.length) {
      await this.db.returnLine.createMany({
        data: order.lines.map((l: any) => ({
          id: `${order.id}:${l.lineNo}`, returnId: order.id, lineNo: l.lineNo, sku: l.sku,
          expectedQty: l.expectedQty, toStock: l.toStock ?? 0, toMerma: l.toMerma ?? 0,
          toQuarantine: l.toQuarantine ?? 0, note: l.note ?? null,
        })),
      });
    }
    // Dual-write (G2+G6): promueve el historial al event store consultable.
    await this.events?.append(toDomainEvents('RETURN', order.id, order.originalOrderRef ?? null, order.sellerId, order.events));
  }

  async findById(sellerId: string, returnId: string): Promise<ReturnOrder | null> {
    const o = await this.db.returnOrder.findFirst({ where: { id: returnId, sellerId } });
    return o ? this.toDomain(o) : null;
  }

  async list(sellerId: string): Promise<ReturnOrder[]> {
    const rows = await this.db.returnOrder.findMany({ where: { sellerId }, orderBy: { createdAt: 'desc' } });
    return rows.map((o: any) => this.toDomain(o));
  }

  private toDomain(o: any): ReturnOrder {
    return {
      id: o.id,
      sellerId: o.sellerId,
      originalOrderId: o.originalOrderId ?? null,
      originalOrderRef: o.originalOrderRef ?? null,
      reason: o.reason ?? null,
      status: o.status,
      lines: (o.lines as any) ?? [],
      createdAt: o.createdAt instanceof Date ? o.createdAt.toISOString() : o.createdAt,
      events: (o.events as any) ?? [],
    };
  }
}

export class PrismaAssemblyLogRepository implements AssemblyLogRepository {
  constructor(private readonly db: PrismaClient) {}
  async append(record: AssemblyRecord): Promise<void> {
    await this.db.assemblyLog.create({
      data: {
        id: record.id,
        sellerId: record.sellerId,
        kitSku: record.kitSku,
        qty: record.qty,
        toLocationId: record.toLocationId,
        sources: record.sources as unknown as object,
        actor: record.actor,
        at: new Date(record.at),
      },
    });
  }
  async list(sellerId: string): Promise<AssemblyRecord[]> {
    const rows = await this.db.assemblyLog.findMany({ where: { sellerId }, orderBy: { at: 'desc' } });
    return rows.map((r: any) => ({
      id: r.id,
      sellerId: r.sellerId,
      kitSku: r.kitSku,
      qty: r.qty,
      toLocationId: r.toLocationId,
      sources: (r.sources as AssemblySource[]) ?? [],
      actor: r.actor,
      at: r.at instanceof Date ? r.at.toISOString() : r.at,
    }));
  }
}

export class PrismaBillingRepository implements BillingRepository {
  constructor(private readonly db: PrismaClient) {}
  async getRate(sellerId: string): Promise<BillingRate | null> {
    const r = await this.db.billingRate.findUnique({ where: { sellerId } });
    return r ? {
      sellerId: r.sellerId, currency: r.currency, fixedMonthly: r.fixedMonthly,
      storagePerUnitMonth: r.storagePerUnitMonth, receiptPerUnit: r.receiptPerUnit,
      shipmentPerOrder: r.shipmentPerOrder, pickPerUnit: r.pickPerUnit, assemblyPerKit: r.assemblyPerKit,
      requiresApproval: r.requiresApproval ?? false,
    } : null;
  }
  async saveRate(rate: BillingRate): Promise<void> {
    const data = {
      currency: rate.currency, fixedMonthly: rate.fixedMonthly, storagePerUnitMonth: rate.storagePerUnitMonth,
      receiptPerUnit: rate.receiptPerUnit, shipmentPerOrder: rate.shipmentPerOrder, pickPerUnit: rate.pickPerUnit, assemblyPerKit: rate.assemblyPerKit,
      requiresApproval: rate.requiresApproval,
    };
    await this.db.billingRate.upsert({ where: { sellerId: rate.sellerId }, create: { sellerId: rate.sellerId, ...data }, update: data });
  }
  async saveInvoice(invoice: BillingInvoice): Promise<void> {
    const data = {
      sellerId: invoice.sellerId, number: invoice.number,
      periodFrom: new Date(invoice.periodFrom), periodTo: new Date(invoice.periodTo),
      currency: invoice.currency, lines: invoice.lines as unknown as object, total: invoice.total,
      createdAt: new Date(invoice.createdAt), createdBy: invoice.createdBy,
      sends: invoice.sends as unknown as object,
      status: invoice.status, approval: (invoice.approval as unknown as object) ?? undefined,
      taxDocument: (invoice.taxDocument as unknown as object) ?? undefined,
    };
    await this.db.billingInvoice.upsert({ where: { id: invoice.id }, create: { id: invoice.id, ...data }, update: data });
  }
  async deleteInvoice(sellerId: string, id: string): Promise<void> {
    await this.db.billingInvoice.deleteMany({ where: { id, sellerId } });
    await this.db.invoiceDocument.deleteMany({ where: { invoiceId: id, sellerId } });
  }
  async saveInvoiceDocument(sellerId: string, invoiceId: string, blob: InvoiceDocumentBlob): Promise<void> {
    const data = { sellerId, fileName: blob.fileName, mimeType: blob.mimeType, contentBase64: blob.contentBase64 };
    await this.db.invoiceDocument.upsert({ where: { invoiceId }, create: { invoiceId, ...data }, update: data });
  }
  async getInvoiceDocument(sellerId: string, invoiceId: string): Promise<InvoiceDocumentBlob | null> {
    const d = await this.db.invoiceDocument.findFirst({ where: { invoiceId, sellerId } });
    return d ? { fileName: d.fileName, mimeType: d.mimeType, contentBase64: d.contentBase64 } : null;
  }
  async deleteInvoiceDocument(sellerId: string, invoiceId: string): Promise<void> {
    await this.db.invoiceDocument.deleteMany({ where: { invoiceId, sellerId } });
  }
  private inv(r: any): BillingInvoice {
    return {
      id: r.id, number: r.number ?? r.id, sellerId: r.sellerId,
      periodFrom: r.periodFrom instanceof Date ? r.periodFrom.toISOString() : r.periodFrom,
      periodTo: r.periodTo instanceof Date ? r.periodTo.toISOString() : r.periodTo,
      currency: r.currency, lines: (r.lines as BillingLine[]) ?? [], total: r.total,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt, createdBy: r.createdBy,
      sends: (r.sends as any) ?? [],
      status: (r.status as any) ?? 'ISSUED',
      approval: (r.approval as any) ?? null,
      taxDocument: (r.taxDocument as any) ?? null,
    };
  }
  async listInvoices(sellerId: string): Promise<BillingInvoice[]> {
    const rows = await this.db.billingInvoice.findMany({ where: { sellerId }, orderBy: { createdAt: 'desc' } });
    return rows.map((r: any) => this.inv(r));
  }
  async findInvoice(sellerId: string, id: string): Promise<BillingInvoice | null> {
    const r = await this.db.billingInvoice.findFirst({ where: { id, sellerId } });
    return r ? this.inv(r) : null;
  }
}

export class PrismaLoginEventRepository implements LoginEventRepository {
  constructor(private readonly db: PrismaClient) {}
  async append(event: LoginEvent): Promise<void> {
    await this.db.loginEvent.create({
      data: {
        id: event.id,
        userId: event.userId,
        operationId: event.operationId,
        at: new Date(event.at),
      },
    });
  }
  async list(): Promise<LoginEvent[]> {
    const rows = await this.db.loginEvent.findMany();
    return rows.map((r: any) => ({
      id: r.id,
      userId: r.userId,
      operationId: r.operationId ?? null,
      at: r.at instanceof Date ? r.at.toISOString() : r.at,
    }));
  }
}

export class PrismaChatRepository implements ChatRepository {
  constructor(private readonly db: PrismaClient) {}
  async append(m: ChatMessage): Promise<void> {
    await this.db.chatMessage.create({
      data: {
        id: m.id, sellerId: m.sellerId, senderId: m.senderId, senderName: m.senderName,
        senderRole: m.senderRole, side: m.side, body: m.body, at: new Date(m.at),
      },
    });
  }
  async list(sellerId: string): Promise<ChatMessage[]> {
    const rows = await this.db.chatMessage.findMany({ where: { sellerId }, orderBy: { at: 'asc' } });
    return rows.map((r: any) => ({
      id: r.id, sellerId: r.sellerId, senderId: r.senderId, senderName: r.senderName,
      senderRole: r.senderRole, side: r.side, body: r.body,
      at: r.at instanceof Date ? r.at.toISOString() : r.at,
    }));
  }
  async getReadState(sellerId: string): Promise<ChatReadState | null> {
    const r = await this.db.chatReadState.findUnique({ where: { sellerId } });
    if (!r) return null;
    return {
      sellerId,
      opsReadAt: r.opsReadAt ? (r.opsReadAt instanceof Date ? r.opsReadAt.toISOString() : r.opsReadAt) : null,
      clientReadAt: r.clientReadAt ? (r.clientReadAt instanceof Date ? r.clientReadAt.toISOString() : r.clientReadAt) : null,
    };
  }
  async setReadState(sellerId: string, side: 'CLIENT' | 'OPS', at: string): Promise<void> {
    const field = side === 'OPS' ? 'opsReadAt' : 'clientReadAt';
    const when = new Date(at);
    await this.db.chatReadState.upsert({
      where: { sellerId },
      create: { sellerId, [field]: when },
      update: { [field]: when },
    });
  }
}

export class PrismaAnnouncementRepository implements AnnouncementRepository {
  constructor(private readonly db: PrismaClient) {}
  private map(r: any): Announcement {
    return {
      id: r.id, title: r.title, linkUrl: r.linkUrl, linkLabel: r.linkLabel,
      active: r.active, audience: (r.audience === 'ALL' ? 'ALL' : 'OPS'), createdBy: r.createdBy,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    };
  }
  async save(a: Announcement): Promise<void> {
    const data = { title: a.title, linkUrl: a.linkUrl, linkLabel: a.linkLabel, active: a.active, audience: a.audience, createdAt: new Date(a.createdAt), createdBy: a.createdBy };
    await this.db.announcement.upsert({ where: { id: a.id }, create: { id: a.id, ...data }, update: data });
  }
  async findById(id: string): Promise<Announcement | null> {
    const r = await this.db.announcement.findUnique({ where: { id } });
    return r ? this.map(r) : null;
  }
  async list(): Promise<Announcement[]> {
    const rows = await this.db.announcement.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((r: any) => this.map(r));
  }
  async delete(id: string): Promise<void> {
    await this.db.announcement.deleteMany({ where: { id } });
  }
  async appendClick(c: AnnouncementClick): Promise<void> {
    await this.db.announcementClick.create({
      data: {
        id: c.id, announcementId: c.announcementId, userId: c.userId, userName: c.userName,
        userRole: c.userRole, operationId: c.operationId, sellerId: c.sellerId, at: new Date(c.at),
      },
    });
  }
  async listClicks(announcementId: string): Promise<AnnouncementClick[]> {
    const rows = await this.db.announcementClick.findMany({ where: { announcementId }, orderBy: { at: 'desc' } });
    return rows.map((r: any) => ({
      id: r.id, announcementId: r.announcementId, userId: r.userId, userName: r.userName,
      userRole: r.userRole, operationId: r.operationId ?? null, sellerId: r.sellerId ?? null,
      at: r.at instanceof Date ? r.at.toISOString() : r.at,
    }));
  }
}

export class PrismaWebhookRepository implements WebhookRepository {
  constructor(private readonly db: PrismaClient) {}
  private map(r: any): Webhook {
    return {
      id: r.id,
      scope: r.scope as WebhookScope,
      scopeId: r.scopeId ?? null,
      url: r.url,
      secret: r.secret,
      events: (Array.isArray(r.events) ? r.events : []) as WebhookEventType[],
      active: r.active,
      createdBy: r.createdBy,
      createdAt: r.createdAt instanceof Date ? r.createdAt.toISOString() : r.createdAt,
    };
  }
  async save(w: Webhook): Promise<void> {
    const data = {
      scope: w.scope, scopeId: w.scopeId, url: w.url, secret: w.secret,
      events: w.events, active: w.active, createdAt: new Date(w.createdAt), createdBy: w.createdBy,
    };
    await this.db.webhook.upsert({ where: { id: w.id }, create: { id: w.id, ...data }, update: data });
  }
  async findById(id: string): Promise<Webhook | null> {
    const r = await this.db.webhook.findUnique({ where: { id } });
    return r ? this.map(r) : null;
  }
  async list(): Promise<Webhook[]> {
    const rows = await this.db.webhook.findMany({ orderBy: { createdAt: 'desc' } });
    return rows.map((r: any) => this.map(r));
  }
  async delete(id: string): Promise<void> {
    await this.db.webhook.deleteMany({ where: { id } });
  }
  async appendDelivery(d: WebhookDelivery): Promise<void> {
    await this.db.webhookDelivery.create({
      data: {
        id: d.id, webhookId: d.webhookId, event: d.event, status: d.status,
        httpStatus: d.httpStatus, error: d.error, at: new Date(d.at), payloadSummary: d.payloadSummary,
      },
    });
  }
  async listDeliveries(webhookId: string): Promise<WebhookDelivery[]> {
    const rows = await this.db.webhookDelivery.findMany({ where: { webhookId }, orderBy: { at: 'desc' } });
    return rows.map((r: any) => ({
      id: r.id, webhookId: r.webhookId, event: r.event as WebhookEventType,
      status: r.status as 'DELIVERED' | 'FAILED', httpStatus: r.httpStatus ?? null,
      error: r.error ?? null, payloadSummary: r.payloadSummary,
      at: r.at instanceof Date ? r.at.toISOString() : r.at,
    }));
  }
}
