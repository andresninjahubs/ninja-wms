/**
 * Puertos (interfaces) que el dominio necesita del mundo exterior.
 * Las implementaciones concretas (Prisma, en-memoria) viven en /infra.
 */
import { AiDashboard } from './ai-dashboard';
import {
  Announcement,
  AnnouncementClick,
  AssemblyRecord,
  AuthToken,
  AuthTokenKind,
  CountAudit,
  DomainEvent,
  DomainEntityType,
  DailyInventorySnapshot,
  DailyDemand,
  DailyMetricRollup,
  CostRateCard,
  LaborTask,
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
  BillingInvoice,
  BillingRate,
  ChatMessage,
  ChatReadState,
  Location,
  LoginEvent,
  Lot,
  Operation,
  OperationBranding,
  OpsAudioBlob,
  OpsCategory,
  OpsInsights,
  OpsMessage,
  OpsThreadRead,
  PackConfig,
  PackagingMaterial,
  PackagingMovement,
  ProductLogEntry,
  ReceiptOrder,
  ReturnOrder,
  SalesOrder,
  Serial,
  Seller,
  ShippingLabel,
  Sku,
  StockBalance,
  StockMovement,
  User,
  Webhook,
  WebhookDelivery,
} from './types';

/** Filtro para consultar saldos de stock, siempre acotado a un seller. */
export interface StockQuery {
  sellerId: string;
  sku?: string;
  locationId?: string;
  includeZeros?: boolean;
}

/**
 * Repositorio del ledger. Es append-only: `append` agrega movimientos,
 * nunca se actualiza ni borra un movimiento existente.
 */
export interface MovementRepository {
  append(movements: StockMovement[]): Promise<void>;
  /** Saldos agregados (suma de deltas) por bucket, para un seller. */
  balances(query: StockQuery): Promise<StockBalance[]>;
  /** Movimientos crudos (append-only) scoped al seller — para FIFO y auditoría. */
  find(query: StockQuery): Promise<StockMovement[]>;
  /**
   * Ocupación física por ubicación, SUMANDO todos los sellers.
   * Las ubicaciones son compartidas, así que la capacidad se mide cross-seller.
   * Devuelve { locationId: unidades ocupadas }.
   */
  occupancyByLocation(): Promise<Record<string, number>>;
}

/** Registro de conteos (tabla CountVariance): esperado vs. contado, por conteo (G8). */
export interface CountAuditRepository {
  save(audit: CountAudit): Promise<void>;
  /** Conteos de una operación (o de un seller), del más nuevo al más viejo. */
  list(operationId: string, opts?: { sellerId?: string | null; limit?: number }): Promise<CountAudit[]>;
}

/**
 * Event store consultable (tabla DomainEvent, G2+G6). Recibe el stream de eventos
 * de negocio ya desnormalizado y lo expone por consultas indexadas (por entidad y
 * por rango/scoping) sin cargar las entidades completas. `append` es IDEMPOTENTE:
 * usa el id determinístico, así que re-guardar una entidad no duplica filas.
 */
export interface EventRepository {
  append(events: DomainEvent[]): Promise<void>;
  /** Todos los eventos de una entidad, ordenados por seq ascendente (línea de tiempo). */
  listByEntity(entityId: string): Promise<DomainEvent[]>;
  /** Eventos filtrados por seller(s), tipo de entidad y rango temporal — para métricas. */
  query(opts: {
    sellerIds?: string[];
    entityType?: DomainEntityType;
    type?: string;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<DomainEvent[]>;
  /** Total de filas (para diagnósticos/backfill). */
  count(): Promise<number>;
}

/**
 * Rollups diarios (G3): snapshots de inventario, demanda y métricas operativas.
 * Todas las escrituras son UPSERT por id determinístico → re-ejecutar el job diario
 * produce exactamente las mismas filas (reproducible).
 */
export interface RollupRepository {
  saveInventorySnapshots(rows: DailyInventorySnapshot[]): Promise<void>;
  saveDemand(rows: DailyDemand[]): Promise<void>;
  saveMetricRollups(rows: DailyMetricRollup[]): Promise<void>;
  listInventorySnapshots(sellerId: string, opts?: { sku?: string | null; fromDate?: string; toDate?: string }): Promise<DailyInventorySnapshot[]>;
  listDemand(sellerId: string, opts?: { sku?: string | null; fromDate?: string; toDate?: string }): Promise<DailyDemand[]>;
  listMetricRollups(sellerId: string, opts?: { fromDate?: string; toDate?: string }): Promise<DailyMetricRollup[]>;
  countAll(): Promise<{ snapshots: number; demand: number; metrics: number }>;
}

/**
 * Tarjeta de costos por operación (una por operación). Persiste el tarifario de costos
 * que habilita el costeo por actividad y la rentabilidad. `getCard` devuelve null si la
 * operación aún no configuró costos (el servicio aplica defaults).
 */
export interface CostRepository {
  getCard(operationId: string): Promise<CostRateCard | null>;
  saveCard(card: CostRateCard): Promise<CostRateCard>;
}

/**
 * Tareas de trabajo (G4). `append` es idempotente por id (las derivadas del ledger
 * usan el id del movimiento), así que re-derivar no duplica.
 */
export interface LaborTaskRepository {
  append(tasks: LaborTask[]): Promise<void>;
  list(operationId: string, opts?: { operator?: string | null; type?: string | null; from?: string; to?: string; limit?: number }): Promise<LaborTask[]>;
  count(): Promise<number>;
}

/**
 * Persistencia + auditoría de IA (G5): recomendaciones de agentes y acciones
 * ejecutadas. Todo queda registrado y consultable para gobernanza y métricas.
 */
/**
 * Asignaciones de tareas a operarios (balanceo de carga, Camino B). El id es
 * determinístico por (type:entityId): una tarea tiene a lo más una asignación activa.
 */
export interface WorkAssignmentRepository {
  save(a: WorkAssignment): Promise<void>; // upsert por id
  get(id: string): Promise<WorkAssignment | null>;
  /** Asignaciones abiertas (assigned|in_progress) de una operación, filtrables por tipo/operario. */
  listOpen(operationId: string, opts?: { type?: WorkTaskType; operator?: string | null }): Promise<WorkAssignment[]>;
  /** Todas las de un operario (por defecto solo abiertas). */
  listByOperator(operationId: string, operator: string, opts?: { includeCompleted?: boolean }): Promise<WorkAssignment[]>;
  /** Historial general (para auditoría/paneles). */
  list(operationId: string, opts?: { type?: WorkTaskType; status?: WorkAssignmentStatus; limit?: number }): Promise<WorkAssignment[]>;
}

/**
 * Registro de tareas (task ledger). `create` asigna el id interno secuencial (`t-N`).
 */
export interface WorkTaskRepository {
  create(input: Omit<WorkTask, 'id'>): Promise<WorkTask>;
  update(task: WorkTask): Promise<void>;
  get(id: string): Promise<WorkTask | null>;
  /** Tareas de una orden (todas sus etapas), más nuevas primero. */
  listByOrder(operationId: string, orderId: string): Promise<WorkTask[]>;
  /** La tarea ABIERTA (pending|assigned|in_progress) de un tipo para una entidad, si existe. */
  findOpen(operationId: string, type: WorkTaskStage, entityId: string): Promise<WorkTask | null>;
  /** Historial general filtrable (paneles/auditoría). */
  list(operationId: string, opts?: { type?: WorkTaskStage; state?: WorkTaskState; sellerId?: string | null; limit?: number }): Promise<WorkTask[]>;
}

/** Configuración por operación de las reglas del agente proactivo. */
export interface AgentRuleConfigRepository {
  get(operationId: string, ruleKey: string): Promise<AgentRuleConfig | null>;
  listByOperation(operationId: string): Promise<AgentRuleConfig[]>;
  save(config: AgentRuleConfig): Promise<void>;
}

/** Alertas generadas por el agente proactivo. */
export interface AgentAlertRepository {
  create(input: Omit<AgentAlert, 'id'>): Promise<AgentAlert>;
  get(id: string): Promise<AgentAlert | null>;
  listOpen(operationId: string): Promise<AgentAlert[]>;
  listRecent(operationId: string, limit: number): Promise<AgentAlert[]>;
  /** La alerta ABIERTA con esa clave de deduplicación, si existe. */
  findOpenByDedupe(operationId: string, dedupeKey: string): Promise<AgentAlert | null>;
  /** La última alerta (cualquier estado) con esa clave — para el enfriamiento (cooldown). */
  lastByDedupe(operationId: string, dedupeKey: string): Promise<AgentAlert | null>;
  save(alert: AgentAlert): Promise<void>;
}

export interface AiAuditRepository {
  saveRecommendation(rec: AiRecommendation): Promise<void>;
  updateRecommendation(id: string, patch: { taken?: boolean | null; outcome?: string | null }): Promise<void>;
  getRecommendation(id: string): Promise<AiRecommendation | null>;
  listRecommendations(operationId: string, opts?: { type?: string | null; from?: string; to?: string; limit?: number }): Promise<AiRecommendation[]>;
  saveAction(action: AgentAction): Promise<void>;
  listActions(operationId: string, opts?: { agent?: string | null; from?: string; to?: string; limit?: number }): Promise<AgentAction[]>;
  countAll(): Promise<{ recommendations: number; actions: number }>;
}

export interface OperationRepository {
  findById(operationId: string): Promise<Operation | null>;
  save(operation: Operation): Promise<void>;
  list(): Promise<Operation[]>;
}

export interface SellerRepository {
  findById(sellerId: string): Promise<Seller | null>;
  save(seller: Seller): Promise<void>;
  list(operationId: string): Promise<Seller[]>; // sellers de UNA operación
}

export interface SkuRepository {
  find(sellerId: string, sku: string): Promise<Sku | null>;
  save(sku: Sku): Promise<void>;
  list(sellerId: string): Promise<Sku[]>;
}

/** Historial de cambios de productos (auditoría), scoped al seller. */
export interface ProductLogRepository {
  append(entry: ProductLogEntry): Promise<void>;
  list(sellerId: string, sku?: string): Promise<ProductLogEntry[]>;
}

/** Historial auditable de armados de kit, scoped al seller. */
export interface AssemblyLogRepository {
  append(record: AssemblyRecord): Promise<void>;
  list(sellerId: string): Promise<AssemblyRecord[]>;
}

/** Bytes de un documento tributario adjunto a una factura. */
export interface InvoiceDocumentBlob {
  fileName: string;
  mimeType: string;
  contentBase64: string; // contenido del archivo en base64
}

/** Tarifarios y facturas de facturación 3PL, scoped al seller. */
export interface BillingRepository {
  getRate(sellerId: string): Promise<BillingRate | null>;
  saveRate(rate: BillingRate): Promise<void>;
  saveInvoice(invoice: BillingInvoice): Promise<void>;
  listInvoices(sellerId: string): Promise<BillingInvoice[]>;
  findInvoice(sellerId: string, id: string): Promise<BillingInvoice | null>;
  deleteInvoice(sellerId: string, id: string): Promise<void>;
  /** Guarda/reemplaza el documento tributario (bytes) de una factura. */
  saveInvoiceDocument(sellerId: string, invoiceId: string, blob: InvoiceDocumentBlob): Promise<void>;
  /** Recupera los bytes del documento tributario de una factura (o null). */
  getInvoiceDocument(sellerId: string, invoiceId: string): Promise<InvoiceDocumentBlob | null>;
  /** Elimina el documento tributario de una factura. */
  deleteInvoiceDocument(sellerId: string, invoiceId: string): Promise<void>;
}

/** Metadata de lotes/series por seller — para FIFO (receivedAt) y FEFO (expiry). */
export interface LotRepository {
  upsert(lot: Lot): Promise<void>;
  get(sellerId: string, sku: string, lot: string): Promise<Lot | null>;
  list(sellerId: string, sku: string): Promise<Lot[]>;
}

export interface SerialRepository {
  save(serial: Serial): Promise<void>;
  get(sellerId: string, sku: string, serial: string): Promise<Serial | null>;
  // sku opcional: si se omite, todas las series del seller.
  list(sellerId: string, sku?: string): Promise<Serial[]>;
}

/**
 * Credenciales de un LLM propio del tenant (operación o seller) para el copiloto.
 * sellerId = null → nivel operación (aplica a toda la operación). La apiKey se
 * guarda pero NUNCA se expone al cliente (se devuelve enmascarada).
 */
export interface AiCredential {
  operationId: string;
  sellerId: string | null;
  provider: string; // compatible con API estilo OpenAI
  baseUrl: string;
  chatModel: string;
  apiKey: string;
  active: boolean;
  updatedAt: string;
}
export interface AiConfigRepository {
  get(operationId: string, sellerId: string | null): Promise<AiCredential | null>;
  save(cred: AiCredential): Promise<void>;
  delete(operationId: string, sellerId: string | null): Promise<void>;
}

/** Ajustes del copiloto por operación (p.ej. modo de acciones: confirmar vs directo). */
export interface CopilotSettings {
  operationId: string;
  actionMode: 'confirm' | 'direct';
  // ---- Agente autónomo (Fase 1): política de autonomía y límites ----
  autonomyLevel?: 0 | 1 | 2 | 3; // ver agent-policy.ts (def 1)
  shadowMode?: boolean; // decide y registra sin ejecutar (def true)
  paused?: boolean; // interruptor: no inicia nada nuevo (def false)
  maxActionsPerCycle?: number; // def 20
  maxActionsPerHour?: number; // def 100
  notifyEmail?: string | null; // correo para alertas críticas / excepciones
  notifyWebhookUrl?: string | null; // POST firmado con las alertas nuevas
  llmPlanning?: boolean; // ciclo de planificación con LLM (def false)
  llmEveryMin?: number; // frecuencia mínima del ciclo LLM (def 15)
  maxLlmCallsPerDay?: number; // presupuesto (def 100)
}
export interface CopilotSettingsRepository {
  get(operationId: string): Promise<CopilotSettings | null>;
  save(settings: CopilotSettings): Promise<void>;
}

/**
 * Tableros del Dashboard AI. Cada tablero pertenece a una persona dentro de una
 * operación: se listan los propios, y nadie ve los de otra operación.
 */
export interface AiDashboardRepository {
  get(id: string): Promise<AiDashboard | null>;
  list(operationId: string, ownerId: string): Promise<AiDashboard[]>;
  save(dashboard: AiDashboard): Promise<void>;
  delete(id: string): Promise<void>;
}

/**
 * Diario del agente (memoria persistente entre ciclos y sesiones). Cada entrada es un
 * hecho corto: un ciclo corrido, una decisión con su justificación, una instrucción del
 * administrador, un resultado observado. El contexto del LLM incluye las últimas entradas.
 */
export interface AgentJournalEntry {
  id: string;
  operationId: string;
  at: string; // ISO
  kind: 'cycle' | 'decision' | 'instruction' | 'outcome' | 'tools' | 'note';
  actor: string;
  text: string;
  data: Record<string, unknown> | null;
  /** Solo para 'instruction': hasta cuándo rige (null = hasta que se retire). */
  expiresAt: string | null;
  active: boolean;
}
export interface AgentJournalRepository {
  append(entry: AgentJournalEntry): Promise<void>;
  listRecent(operationId: string, opts?: { kind?: AgentJournalEntry['kind'] | null; limit?: number; since?: string }): Promise<AgentJournalEntry[]>;
  /** Instrucciones vigentes (activas y no vencidas). */
  listInstructions(operationId: string, now: string): Promise<AgentJournalEntry[]>;
  update(id: string, patch: { active?: boolean; text?: string; data?: Record<string, unknown> | null }): Promise<void>;
}

/** Marca (white-label) por operación. */
export interface BrandingRepository {
  get(operationId: string): Promise<OperationBranding | null>;
  save(branding: OperationBranding): Promise<void>;
}

/** Canal de voz operador↔admin: mensajes + blobs de audio (por operación). */
export interface OpsChannelRepository {
  saveMessage(m: OpsMessage): Promise<void>;
  listMessages(operationId: string, filter?: { threadUserId?: string }): Promise<OpsMessage[]>;
  saveAudio(blob: OpsAudioBlob): Promise<void>;
  getAudio(operationId: string, audioId: string): Promise<OpsAudioBlob | null>;
  /** Marca hasta cuándo leyó un lado (ADMIN/OPERATOR) un hilo. */
  markRead(operationId: string, threadUserId: string, side: 'ADMIN' | 'OPERATOR', at: string): Promise<void>;
  /** Estado de lectura de un hilo (o null si nunca se leyó). */
  getRead(operationId: string, threadUserId: string): Promise<OpsThreadRead | null>;
}

/**
 * Agente que interpreta los mensajes del canal: transcribe voz, clasifica el tópico
 * y genera insights. Implementación heurística por defecto; una real (LLM) se conecta
 * por configuración. Cualquier método puede devolver null y el servicio cae a la heurística.
 */
export interface OpsAiAnalyst {
  transcribe(audioBase64: string, mime: string): Promise<string | null>;
  classify(text: string): Promise<{ category: OpsCategory; confidence: number; source: 'ai' | 'heuristic' } | null>;
  insights(input: { messages: { text: string; category: OpsCategory }[]; counts: Record<string, number>; total: number }): Promise<OpsInsights | null>;
}

/** Catálogo de insumos de embalaje (nivel operación) + su ledger de stock. */
export interface PackagingRepository {
  saveMaterial(m: PackagingMaterial): Promise<void>;
  getMaterial(operationId: string, sku: string): Promise<PackagingMaterial | null>;
  listMaterials(operationId: string): Promise<PackagingMaterial[]>;
  findByBarcode(operationId: string, barcode: string): Promise<PackagingMaterial | null>;
  appendMovements(movements: PackagingMovement[]): Promise<void>;
  listMovements(operationId: string, filter?: { materialSku?: string; sellerId?: string }): Promise<PackagingMovement[]>;
}

export interface UserRepository {
  save(user: User): Promise<void>;
  findById(userId: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  // Sin argumento: todos (para PLATFORM_ADMIN). Con operationId: solo esa operación.
  list(operationId?: string | null): Promise<User[]>;
}

/** Config editable de planes (matriz módulo × plan del super-admin). */
export interface PlanConfigRepository {
  list(): Promise<import('./plans').PlanConfig[]>;
  get(planId: string): Promise<import('./plans').PlanConfig | null>;
  save(config: import('./plans').PlanConfig): Promise<void>;
  clear(): Promise<void>; // restaurar defaults (borra overrides)
}

/** Tokens de un solo uso para verificación de email y reset de contraseña. */
export interface AuthTokenRepository {
  create(token: AuthToken): Promise<void>;
  findByToken(token: string): Promise<AuthToken | null>;
  markUsed(id: string, usedAt: string): Promise<void>;
  /** Invalida (marca usados) los tokens vigentes de un usuario de cierto tipo. */
  invalidateForUser(userId: string, kind: AuthTokenKind, usedAt: string): Promise<void>;
}

/** Mensaje de correo transaccional. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * Envío de correo transaccional. La implementación por defecto (dev) registra el
 * correo en consola y no entrega nada; una implementación SMTP entrega de verdad
 * cuando hay SMTP_URL configurado. `delivered=false` indica que quedó solo en log.
 */
export interface EmailSender {
  send(message: EmailMessage): Promise<{ delivered: boolean }>;
}

/** Configuraciones de empaque (packs) por SKU, con su código de barras y factor. */
export interface PackRepository {
  upsert(pack: PackConfig): Promise<void>;
  listBySku(sellerId: string, sku: string): Promise<PackConfig[]>;
  findByBarcode(sellerId: string, barcode: string): Promise<PackConfig | null>;
}

export interface LocationRepository {
  findById(locationId: string): Promise<Location | null>;
  // resolver el código pistoleado del bin DENTRO de una operación (los códigos pueden repetirse entre operaciones)
  findByCode(operationId: string, code: string): Promise<Location | null>;
  save(location: Location): Promise<void>;
  listByOperation(operationId: string): Promise<Location[]>;
  /** Elimina físicamente una ubicación (solo se permite si nunca tuvo movimientos). */
  delete(locationId: string): Promise<void>;
}

export interface OrderRepository {
  save(order: SalesOrder): Promise<void>;
  findById(sellerId: string, orderId: string): Promise<SalesOrder | null>;
  /** Busca por la referencia externa del OMS (clave de idempotencia junto al sellerId). */
  findByExternal(sellerId: string, externalOrderId: string): Promise<SalesOrder | null>;
  /** Elimina una orden (usado por la consolidación de duplicados). */
  delete(sellerId: string, orderId: string): Promise<void>;
  list(sellerId: string): Promise<SalesOrder[]>;
}

/** Repositorio de órdenes de recepción (inbound), scoped al seller. */
export interface ReceiptOrderRepository {
  save(order: ReceiptOrder): Promise<void>;
  findById(sellerId: string, orderId: string): Promise<ReceiptOrder | null>;
  list(sellerId: string): Promise<ReceiptOrder[]>;
  delete(sellerId: string, orderId: string): Promise<void>;
}

/** Repositorio de órdenes de devolución (reversa), scoped al seller. */
export interface ReturnOrderRepository {
  save(order: ReturnOrder): Promise<void>;
  findById(sellerId: string, returnId: string): Promise<ReturnOrder | null>;
  list(sellerId: string): Promise<ReturnOrder[]>;
}

/** Repositorio del chat interno (mensajes append-only + marcadores de leído), por seller. */
export interface ChatRepository {
  append(message: ChatMessage): Promise<void>;
  list(sellerId: string): Promise<ChatMessage[]>; // orden cronológico
  getReadState(sellerId: string): Promise<ChatReadState | null>;
  setReadState(sellerId: string, side: 'CLIENT' | 'OPS', at: string): Promise<void>;
}

/**
 * Repositorio de eventos de login (append-only). Alimenta el Panel de uso de la
 * plataforma: registra CADA inicio de sesión exitoso para medir logins, usuarios
 * activos únicos y última actividad por operación.
 */
export interface LoginEventRepository {
  append(event: LoginEvent): Promise<void>;
  list(): Promise<LoginEvent[]>;
}

/**
 * Repositorio de anuncios de plataforma (barra superior) + registro de clics.
 * Transversal a todas las operaciones; lo gestiona el PLATFORM_ADMIN.
 */
export interface AnnouncementRepository {
  save(announcement: Announcement): Promise<void>;
  findById(id: string): Promise<Announcement | null>;
  list(): Promise<Announcement[]>; // todos (para el mantenedor), orden desc por createdAt
  delete(id: string): Promise<void>;
  appendClick(click: AnnouncementClick): Promise<void>;
  listClicks(announcementId: string): Promise<AnnouncementClick[]>;
}

/**
 * Repositorio de suscripciones de webhook + su historial de entregas.
 * `list()` devuelve TODAS las suscripciones (transversal); el filtrado por scope
 * (SELLER/OPERATION/PLATFORM) lo hace el WebhookService.
 */
export interface WebhookRepository {
  save(webhook: Webhook): Promise<void>;
  findById(id: string): Promise<Webhook | null>;
  list(): Promise<Webhook[]>; // todas (el servicio filtra por scope)
  delete(id: string): Promise<void>;
  appendDelivery(delivery: WebhookDelivery): Promise<void>;
  listDeliveries(webhookId: string): Promise<WebhookDelivery[]>; // desc por fecha
}

/**
 * Puerto de conexión con el OMS de Ninja para el empaque (packing).
 * Cuando una orden se empaca (PACKED), el WMS consulta al OMS para obtener el
 * número de seguimiento del transporte y las etiquetas de cada bulto, que el
 * operario ve e imprime durante el packing para pegarlas en los bultos.
 * En producción es un gateway HTTP al OMS; en la demo, un proveedor local.
 */
export interface ShippingLabelRequest {
  sellerId: string;
  order: SalesOrder;
  bultos: number; // cantidad de bultos embalados
}
export interface ShippingLabelResult {
  trackingNumber: string | null; // tracking master del transporte
  carrier: string | null; // courier / transporte asignado
  labels: ShippingLabel[]; // una etiqueta por bulto (data: URI imprimible)
}
export interface ShippingLabelProvider {
  /** Conecta con el OMS para traer tracking + etiquetas de una orden empacada. */
  fetchLabels(req: ShippingLabelRequest): Promise<ShippingLabelResult>;
}

/**
 * Puerto de envío HTTP de un webhook. Se inyecta la implementación real
 * (HttpWebhookSender con fetch) o un fake en los tests.
 */
export interface WebhookSender {
  send(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ ok: boolean; status: number | null; error?: string }>;
}

/** Generador de IDs. Inyectable para tests deterministas. */
export interface IdGenerator {
  next(): string;
}

/** Reloj. Inyectable para tests deterministas. */
export interface Clock {
  now(): string; // ISO timestamp
}
