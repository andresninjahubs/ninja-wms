/**
 * Fábrica de contexto: arma el WmsFacade con la persistencia elegida.
 *
 *   PERSISTENCE=memory  -> repos en-memoria (arranque instantáneo, sin base de datos)
 *   PERSISTENCE=prisma  -> repos PostgreSQL vía Prisma (producción)
 *
 * La persistencia Prisma se importa de forma perezosa, así el modo "memory"
 * funciona aunque `prisma generate` no se haya corrido todavía.
 */
import { InventoryService } from '../domain/inventory.service';
import { OrderService } from '../domain/order.service';
import { ReceiptOrderService } from '../domain/receipt.service';
import { ReturnService } from '../domain/return.service';
import { ProductService } from '../domain/product.service';
import { PackagingService } from '../domain/packaging.service';
import { OpsChannelService } from '../domain/ops-channel.service';
import { selectOpsAiAnalyst } from './ops-ai-analyst';
import { BillingService } from '../domain/billing.service';
import { MetricsService } from '../domain/metrics.service';
import { RollupService } from '../domain/rollup.service';
import { LaborService } from '../domain/labor.service';
import { AbcService } from '../domain/abc.service';
import { CostingService } from '../domain/costing.service';
import { PlatformUsageService } from '../domain/platform-usage.service';
import { AnnouncementService } from '../domain/announcement.service';
import { WebhookService } from '../domain/webhook.service';
import { HttpWebhookSender } from './webhook-sender';
import { LocalShippingLabelProvider } from './shipping/local-label-provider';
import { ChatService } from '../domain/chat.service';
import { PutawayAdvisor } from '../domain/putaway.advisor';
import { CycleCountService } from '../domain/cyclecount.service';
import { UserService } from '../domain/user.service';
import { OperationService } from '../domain/operation.service';
import { BarcodeService } from '../domain/barcode.service';
import {
  LocationRepository,
  LoginEventRepository,
  LotRepository,
  SerialRepository,
  PackagingRepository,
  BrandingRepository,
  OpsChannelRepository,
  AiConfigRepository,
  CopilotSettingsRepository,
  AuthTokenRepository,
  PlanConfigRepository,
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
  AgentJournalRepository,
  EmailSender,
  MovementRepository,
  OperationRepository,
  OrderRepository,
  PackRepository,
  ProductLogRepository,
  AssemblyLogRepository,
  BillingRepository,
  ChatRepository,
  AnnouncementRepository,
  ReceiptOrderRepository,
  ReturnOrderRepository,
  SellerRepository,
  SkuRepository,
  UserRepository,
  WebhookRepository,
} from '../domain/ports';
import { WmsFacade } from '../app/wms.facade';
import {
  InMemoryAnnouncementRepository,
  InMemoryLocationRepository,
  InMemoryLoginEventRepository,
  InMemoryLotRepository,
  InMemorySerialRepository,
  InMemoryPackagingRepository,
  InMemoryBrandingRepository,
  InMemoryOpsChannelRepository,
  InMemoryAiConfigRepository,
  InMemoryCopilotSettingsRepository,
  InMemoryAuthTokenRepository,
  InMemoryPlanConfigRepository,
  InMemoryCountAuditRepository,
  InMemoryEventRepository,
  InMemoryRollupRepository,
  InMemoryLaborTaskRepository,
  InMemoryCostRepository,
  InMemoryAiAuditRepository,
  InMemoryWorkAssignmentRepository,
  InMemoryWorkTaskRepository,
  InMemoryAgentRuleConfigRepository,
  InMemoryAgentAlertRepository,
  InMemoryAgentJournalRepository,
  InMemoryMovementRepository,
  InMemoryOperationRepository,
  InMemoryOrderRepository,
  InMemoryPackRepository,
  InMemoryProductLogRepository,
  InMemoryAssemblyLogRepository,
  InMemoryBillingRepository,
  InMemoryChatRepository,
  InMemoryReceiptOrderRepository,
  InMemoryReturnOrderRepository,
  InMemorySellerRepository,
  InMemorySkuRepository,
  InMemoryUserRepository,
  InMemoryWebhookRepository,
} from './memory/in-memory.repositories';
import { MutableClock, UuidGenerator } from './system';
import { selectEmailSender } from './email';

export interface WmsContext {
  facade: WmsFacade;
  persistence: 'memory' | 'prisma';
  dispose: () => Promise<void>;
  clock: MutableClock; // reloj con override — la semilla lo usa para retro-fechar historia
}

export async function createWmsContext(): Promise<WmsContext> {
  const persistence = (process.env.PERSISTENCE ?? 'memory') as 'memory' | 'prisma';
  const ids = new UuidGenerator();
  // Reloj con override para permitir a la semilla retro-fechar actividad histórica.
  const clock = new MutableClock();

  let sellers: SellerRepository;
  let skus: SkuRepository;
  let locations: LocationRepository;
  let movements: MovementRepository;
  let orders: OrderRepository;
  let receipts: ReceiptOrderRepository;
  let returnsRepo: ReturnOrderRepository;
  let productLogs: ProductLogRepository;
  let assemblies: AssemblyLogRepository;
  let billing: BillingRepository;
  let chat: ChatRepository;
  let lots: LotRepository;
  let serials: SerialRepository;
  let packaging: PackagingRepository;
  let branding: BrandingRepository;
  let opsChannel: OpsChannelRepository;
  let aiConfig: AiConfigRepository;
  let copilotSettings: CopilotSettingsRepository;
  let authTokens: AuthTokenRepository;
  let planConfig: PlanConfigRepository;
  let countAudits: CountAuditRepository;
  let events: EventRepository;
  let rollups: RollupRepository;
  let laborTasks: LaborTaskRepository;
  let costs: CostRepository;
  let aiAudit: AiAuditRepository;
  let assignments: WorkAssignmentRepository;
  let taskLedger: WorkTaskRepository;
  let agentRuleConfig: AgentRuleConfigRepository;
  let agentAlerts: AgentAlertRepository;
  let agentJournal: AgentJournalRepository;
  let users: UserRepository;
  let packs: PackRepository;
  let operations: OperationRepository;
  let logins: LoginEventRepository;
  let announcements: AnnouncementRepository;
  let webhooks: WebhookRepository;
  let dispose = async () => {};

  if (persistence === 'prisma') {
    const { PrismaClient } = (await import('@prisma/client')) as any;
    const {
      PrismaSellerRepository,
      PrismaSkuRepository,
      PrismaLocationRepository,
      PrismaMovementRepository,
      PrismaOrderRepository,
      PrismaReceiptOrderRepository,
      PrismaReturnOrderRepository,
      PrismaProductLogRepository,
      PrismaAssemblyLogRepository,
      PrismaBillingRepository,
      PrismaChatRepository,
      PrismaLotRepository,
      PrismaSerialRepository,
      PrismaPackagingRepository,
      PrismaBrandingRepository,
      PrismaOpsChannelRepository,
      PrismaAiConfigRepository,
      PrismaCopilotSettingsRepository,
      PrismaAuthTokenRepository,
      PrismaPlanConfigRepository,
      PrismaCountAuditRepository,
      PrismaEventRepository,
      PrismaRollupRepository,
      PrismaLaborTaskRepository,
      PrismaCostRepository,
      PrismaAiAuditRepository,
      PrismaWorkAssignmentRepository,
      PrismaWorkTaskRepository,
      PrismaAgentRuleConfigRepository,
      PrismaAgentAlertRepository,
      PrismaAgentJournalRepository,
      PrismaUserRepository,
      PrismaPackRepository,
      PrismaOperationRepository,
      PrismaLoginEventRepository,
      PrismaAnnouncementRepository,
      PrismaWebhookRepository,
    } = await import('./prisma/prisma.repositories');
    const db = new PrismaClient();
    await db.$connect();
    events = new PrismaEventRepository(db);
    rollups = new PrismaRollupRepository(db);
    laborTasks = new PrismaLaborTaskRepository(db);
    costs = new PrismaCostRepository(db);
    aiAudit = new PrismaAiAuditRepository(db);
    assignments = new PrismaWorkAssignmentRepository(db);
    taskLedger = new PrismaWorkTaskRepository(db);
    agentRuleConfig = new PrismaAgentRuleConfigRepository(db);
    agentAlerts = new PrismaAgentAlertRepository(db);
    agentJournal = new PrismaAgentJournalRepository(db);
    sellers = new PrismaSellerRepository(db);
    skus = new PrismaSkuRepository(db);
    locations = new PrismaLocationRepository(db);
    movements = new PrismaMovementRepository(db);
    orders = new PrismaOrderRepository(db, events);
    receipts = new PrismaReceiptOrderRepository(db, events);
    returnsRepo = new PrismaReturnOrderRepository(db, events);
    productLogs = new PrismaProductLogRepository(db);
    assemblies = new PrismaAssemblyLogRepository(db);
    billing = new PrismaBillingRepository(db);
    chat = new PrismaChatRepository(db);
    lots = new PrismaLotRepository(db);
    serials = new PrismaSerialRepository(db);
    packaging = new PrismaPackagingRepository(db);
    branding = new PrismaBrandingRepository(db);
    opsChannel = new PrismaOpsChannelRepository(db);
    aiConfig = new PrismaAiConfigRepository(db);
    copilotSettings = new PrismaCopilotSettingsRepository(db);
    authTokens = new PrismaAuthTokenRepository(db);
    planConfig = new PrismaPlanConfigRepository(db);
    countAudits = new PrismaCountAuditRepository(db);
    users = new PrismaUserRepository(db);
    packs = new PrismaPackRepository(db);
    operations = new PrismaOperationRepository(db);
    logins = new PrismaLoginEventRepository(db);
    announcements = new PrismaAnnouncementRepository(db);
    webhooks = new PrismaWebhookRepository(db);
    dispose = async () => {
      await db.$disconnect();
    };
  } else {
    sellers = new InMemorySellerRepository();
    skus = new InMemorySkuRepository();
    locations = new InMemoryLocationRepository();
    movements = new InMemoryMovementRepository();
    events = new InMemoryEventRepository();
    rollups = new InMemoryRollupRepository();
    laborTasks = new InMemoryLaborTaskRepository();
    costs = new InMemoryCostRepository();
    aiAudit = new InMemoryAiAuditRepository();
    assignments = new InMemoryWorkAssignmentRepository();
    taskLedger = new InMemoryWorkTaskRepository();
    agentRuleConfig = new InMemoryAgentRuleConfigRepository();
    agentAlerts = new InMemoryAgentAlertRepository();
    agentJournal = new InMemoryAgentJournalRepository();
    orders = new InMemoryOrderRepository(events);
    receipts = new InMemoryReceiptOrderRepository(events);
    returnsRepo = new InMemoryReturnOrderRepository(events);
    productLogs = new InMemoryProductLogRepository();
    assemblies = new InMemoryAssemblyLogRepository();
    billing = new InMemoryBillingRepository();
    chat = new InMemoryChatRepository();
    lots = new InMemoryLotRepository();
    serials = new InMemorySerialRepository();
    packaging = new InMemoryPackagingRepository();
    branding = new InMemoryBrandingRepository();
    opsChannel = new InMemoryOpsChannelRepository();
    aiConfig = new InMemoryAiConfigRepository();
    copilotSettings = new InMemoryCopilotSettingsRepository();
    authTokens = new InMemoryAuthTokenRepository();
    planConfig = new InMemoryPlanConfigRepository();
    countAudits = new InMemoryCountAuditRepository();
    users = new InMemoryUserRepository();
    packs = new InMemoryPackRepository();
    operations = new InMemoryOperationRepository();
    logins = new InMemoryLoginEventRepository();
    announcements = new InMemoryAnnouncementRepository();
    webhooks = new InMemoryWebhookRepository();
  }

  const inventory = new InventoryService(sellers, skus, locations, movements, ids, clock, lots);
  const orderService = new OrderService(orders, inventory, sellers, skus, ids, clock);
  const receiptService = new ReceiptOrderService(receipts, inventory, sellers, skus, locations, ids, clock, serials);
  const returnService = new ReturnService(returnsRepo, orders, inventory, sellers, skus, locations, ids, clock);
  const putawayAdvisor = new PutawayAdvisor(sellers, skus, locations, movements);
  const cycleCounts = new CycleCountService(sellers, skus, locations, movements, ids, clock, countAudits);
  const userService = new UserService(users, ids);
  const barcodeService = new BarcodeService(packs, skus, sellers);
  const productService = new ProductService(skus, productLogs, sellers, inventory, barcodeService, ids, clock, assemblies);
  const packagingService = new PackagingService(packaging, ids, clock);
  const opsChannelService = new OpsChannelService(opsChannel, ids, clock, selectOpsAiAnalyst());
  const billingService = new BillingService(billing, movements, locations, orders, assemblies, sellers, ids, clock, packagingService);
  const metricsService = new MetricsService(movements, orders, receipts, clock, events, rollups);
  const rollupService = new RollupService(movements, sellers, rollups, clock, events, orders);
  const laborService = new LaborService(movements, sellers, laborTasks, ids, clock);
  const abcService = new AbcService(sellers, skus, movements, clock);
  const costingService = new CostingService(costs, sellers, users, billingService, movements, laborTasks, clock, rollups, packagingService);
  const chatService = new ChatService(chat, sellers, clock);
  const announcementService = new AnnouncementService(announcements, ids, clock);
  const webhookSender = new HttpWebhookSender();
  const webhookService = new WebhookService(webhooks, sellers, webhookSender, ids, clock);
  // OMS de Ninja (packing → tracking + etiquetas). En la demo, proveedor local.
  const shippingLabels = new LocalShippingLabelProvider(ids, clock);
  const operationService = new OperationService(operations, ids);
  const platformUsageService = new PlatformUsageService(
    operations,
    sellers,
    users,
    movements,
    orders,
    receipts,
    billing,
    logins,
    ids,
    clock,
  );
  const facade = new WmsFacade(
    inventory,
    orderService,
    receiptService,
    productService,
    billingService,
    sellers,
    skus,
    locations,
    ids,
    putawayAdvisor,
    cycleCounts,
    userService,
    barcodeService,
    operationService,
    metricsService,
    chatService,
    platformUsageService,
    announcementService,
    webhookService,
    shippingLabels,
    returnService,
    serials,
    packagingService,
    branding,
    opsChannelService,
    clock,
    lots,
    aiConfig,
    copilotSettings,
    authTokens,
    selectEmailSender(),
    planConfig,
    countAudits,
    events,
    rollupService,
    laborService,
    aiAudit,
    abcService,
    assignments,
    costingService,
    taskLedger,
    agentRuleConfig,
    agentAlerts,
    agentJournal,
  );

  // Bootstrap del super-admin de plataforma (Ninja Hubs).
  // Configurable por entorno (ROOT_EMAIL / ROOT_PASSWORD) e IDEMPOTENTE:
  //  - si el usuario no existe, se crea con la clave definida;
  //  - si ya existe, se le reafirma la clave definida y queda activo como PLATFORM_ADMIN.
  // Así las credenciales definidas funcionan tras cada despliegue, sin importar el estado de la base.
  {
    const { UserRole } = await import('../domain/types');
    const rootEmail = (process.env.ROOT_EMAIL || 'admin@ninjahubs.cl').trim().toLowerCase();
    const rootPassword = process.env.ROOT_PASSWORD || 'admin1234';
    const existing = (await userService.listUsers()).find(
      (u) => u.email.trim().toLowerCase() === rootEmail,
    );
    if (!existing) {
      await userService.createUser({
        name: 'Ninja Hubs (Plataforma)',
        email: rootEmail,
        role: UserRole.PLATFORM_ADMIN,
        password: rootPassword,
      });
    } else {
      await userService.setPassword(existing.id, rootPassword);
      if (!existing.active || existing.role !== UserRole.PLATFORM_ADMIN) {
        await userService.updateUser(existing.id, { active: true, role: UserRole.PLATFORM_ADMIN });
      }
    }
  }

  // Backfill inicial del event store (G2): si la tabla está vacía, promueve los
  // historiales ya existentes (órdenes/recepciones/devoluciones). Idempotente y
  // barato: en arranques posteriores count() > 0 y se omite.
  try {
    if ((await events.count()) === 0) await facade.backfillEvents();
  } catch {
    /* el backfill es best-effort; el dual-write en vivo cubre lo nuevo */
  }

  return { facade, persistence, dispose, clock };
}
