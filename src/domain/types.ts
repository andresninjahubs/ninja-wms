/**
 * Tipos del dominio del WMS.
 * El dominio es framework-agnostic: no depende de NestJS, Prisma ni HTTP.
 */

/** Estado del inventario. El stock siempre "cuadra" solo dentro de un mismo estado. */
export enum StockState {
  AVAILABLE = 'AVAILABLE', // disponible para vender/pickear
  RESERVED = 'RESERVED', // comprometido a una orden
  QUARANTINE = 'QUARANTINE', // en revisión de calidad
  DAMAGED = 'DAMAGED', // dañado, no vendible
  IN_TRANSIT = 'IN_TRANSIT', // en tránsito entre ubicaciones/bodegas
}

/** Tipo de movimiento en el ledger inmutable. */
export enum MovementType {
  RECEIPT = 'RECEIPT', // entrada por recepción de mercadería
  PUTAWAY = 'PUTAWAY', // guardado (traslado de recepción a almacenaje)
  TRANSFER = 'TRANSFER', // traslado interno entre ubicaciones
  RESERVE = 'RESERVE', // reserva: pasa stock de AVAILABLE a RESERVED
  RELEASE = 'RELEASE', // libera una reserva: RESERVED de vuelta a AVAILABLE
  PICK = 'PICK', // salida por picking
  SHIP = 'SHIP', // salida definitiva por despacho
  ADJUSTMENT = 'ADJUSTMENT', // ajuste de inventario (conteo, merma)
  RETURN = 'RETURN', // entrada por devolución de cliente (a stock, merma o cuarentena)
  REACTIVATION = 'REACTIVATION', // marca de auditoría: una orden cancelada fue reactivada (qty 0)
}

/** Modo de fulfillment de una orden. */
export enum OrderType {
  B2C = 'b2c',
  B2B = 'b2b',
  RETURN = 'devolucion',
}

/**
 * Tipo de documento asociado a la orden. Es solo un ATRIBUTO seleccionable
 * (para clasificar/filtrar la orden), NO implica emisión de documentos ante el SII.
 */
export enum DocumentType {
  BOLETA = 'boleta',
  FACTURA = 'factura',
  GUIA_DESPACHO = 'guia_despacho',
  ORDEN_COMPRA = 'orden_compra',
}

/** Unidad de manejo de una línea. */
export enum Uom {
  EACH = 'each',
  CASE = 'case',
  PALLET = 'pallet',
}

/**
 * Un "bucket" de stock: la granularidad mínima donde vive una cantidad.
 * El stock disponible de un bucket es SIEMPRE la suma de los deltas de sus movimientos.
 */
export interface StockBucketKey {
  sellerId: string;
  sku: string;
  locationId: string;
  lot: string | null;
  state: StockState;
}

/**
 * Movimiento de stock: la unidad atómica e inmutable del ledger.
 * Nunca se edita ni se borra. Un delta positivo suma al bucket, uno negativo resta.
 * Un traslado se expresa como DOS movimientos que comparten `groupId`.
 */
export interface StockMovement extends StockBucketKey {
  id: string;
  type: MovementType;
  qtyDelta: number; // + entrada / - salida sobre el bucket
  uom: Uom;
  reference: string | null; // documento origen: recepción, orden, ajuste
  groupId: string | null; // agrupa las 2 patas de un traslado
  actor: string; // usuario o sistema que originó el movimiento
  occurredAt: string; // ISO timestamp
}

/** Saldo agregado de un bucket (resultado de sumar movimientos). */
export interface StockBalance extends StockBucketKey {
  qty: number;
}

/** Estrategia de picking del seller: cómo se elige de qué stock tomar al reservar. */
export enum PickingStrategy {
  FIFO = 'FIFO', // primero en entrar, primero en salir (por fecha de recepción)
  FEFO = 'FEFO', // primero en vencer, primero en salir (por fecha de vencimiento)
  LOT_DIRECTED = 'LOT_DIRECTED', // la orden DEBE indicar el lote/serie a tomar
}

/** Estrategia de conteo cíclico del seller. */
export enum CycleCountStrategy {
  ABC = 'ABC', // por clase de rotación (A seguido, C rara vez)
  LOCATION = 'LOCATION', // barrido por ubicaciones / zona
  RANDOM = 'RANDOM', // muestreo aleatorio
}

/** Maestro: seller (cliente 3PL), con su política operativa configurable. */
export interface Seller {
  id: string;
  operationId: string; // operación a la que pertenece (tenant superior)
  name: string;
  pickingStrategy: PickingStrategy;
  cycleCountStrategy: CycleCountStrategy;
  // Preferir una sola ubicación que alcance para toda la cantidad al reservar
  // (respetando FIFO/FEFO como desempate). Si ninguna alcanza sola, combina varias.
  consolidateByLocation: boolean;
  // Orden de prioridad de courier para la cola de preparación (nombres de courier,
  // el primero se prepara antes). Vacío = sin prioridad de courier (FIFO puro por antigüedad).
  courierPriority: string[];
  // ¿Las órdenes de este cliente se RESERVAN de inmediato al ingresar, sin pasar por
  // revisión? Default false: la orden nace RECEIVED y un operador/admin la reserva.
  autoAllocateOnIngest: boolean;
  active: boolean;
  // ¿El administrador habilitó a este cliente para ver/usar el panel de webhooks?
  // Default false: el CLIENT recibe 403 y su portal no muestra el panel hasta que
  // un ADMIN/PLATFORM_ADMIN lo active desde su mantenedor de acceso.
  webhooksClientEnabled: boolean;
}

// ---- Webhooks configurables por evento --------------------------------------

/** Eventos de dominio que pueden dispararse a suscripciones de webhook. */
export type WebhookEventType =
  | 'order.allocated' // orden reservada (ALLOCATED)
  | 'order.picking' // orden en picking (PICKING)
  | 'order.picked' // orden pickeada (PICKED)
  | 'order.packed' // orden empacada (PACKED) — dispara la conexión con el OMS para tracking + etiquetas
  | 'order.shipped' // orden despachada (SHIPPED)
  | 'order.cancelled' // orden cancelada (CANCELLED)
  | 'reception.received'; // recepción confirmada

/**
 * Alcance de una suscripción de webhook:
 *  - SELLER: la configura el CLIENT sobre su propio seller (scopeId = sellerId).
 *  - OPERATION: la configura el ADMIN/SUPERVISOR sobre su operación (scopeId = operationId).
 *  - PLATFORM: la configura el PLATFORM_ADMIN; recibe TODOS los eventos (scopeId = null).
 */
export type WebhookScope = 'SELLER' | 'OPERATION' | 'PLATFORM';

/** Una suscripción de webhook: a qué URL entregar qué eventos, con qué alcance. */
export interface Webhook {
  id: string;
  scope: WebhookScope;
  scopeId: string | null; // sellerId | operationId | null (PLATFORM)
  url: string;
  secret: string; // secreto para firmar el payload (HMAC-SHA256)
  events: WebhookEventType[]; // eventos a los que está suscrito (no vacío)
  active: boolean;
  createdAt: string; // ISO
  createdBy: string; // id/email del usuario que la creó
}

/** Registro de una entrega (auditable) de un evento a un webhook. */
export interface WebhookDelivery {
  id: string;
  webhookId: string;
  event: WebhookEventType;
  status: 'DELIVERED' | 'FAILED';
  httpStatus: number | null; // código HTTP de la respuesta (null si no hubo)
  error: string | null; // detalle del fallo (timeout, red, etc.)
  at: string; // ISO
  payloadSummary: string; // resumen legible del payload entregado
}

// ---- Usuarios, roles y permisos ---------------------------------------------

/** Permisos atómicos: cada acción sensible del WMS exige uno. */
export type Permission =
  | 'stock:read'
  | 'inventory:receive'
  | 'inventory:putaway'
  | 'order:create'
  | 'order:fulfill' // reservar, pickear, despachar
  | 'order:cancel'
  | 'count:perform' // ejecutar conteo cíclico y ajustar
  | 'seller:config' // cambiar estrategia de picking / conteo
  | 'product:manage' // mantenedor de productos/SKUs del seller (cliente + ops)
  | 'billing:manage' // tarifario y facturación 3PL (staff de operación)
  | 'billing:approve' // aprobar facturas propias (cliente/seller en su portal)
  | 'chat:use' // usar el chat interno del cliente (cliente + staff)
  | 'chat:manage' // ver la bandeja de conversaciones de la operación (staff)
  | 'announcement:view' // ver la barra de anuncios de plataforma (admin/supervisor)
  | 'announcement:manage' // mantenedor de anuncios y reporte de clics (solo plataforma)
  | 'webhook:manage' // configurar las propias suscripciones de webhook (cliente + staff)
  | 'webhook:admin' // mantenedor de acceso de clientes al panel de webhooks (admin + plataforma)
  | 'master:manage' // crear sellers, ubicaciones (maestros de la operación)
  | 'user:manage' // mantenedor de usuarios (dentro de la operación)
  | 'operation:manage'; // crear/gestionar OPERACIONES (solo plataforma)

/**
 * Roles del sistema.
 *  - PLATFORM_ADMIN: super-admin de Ninja Hubs, por ENCIMA de las operaciones.
 *  - ADMIN/SUPERVISOR/OPERATOR: staff de UNA operación (su operationId).
 *  - CLIENT: usuario de un seller dentro de una operación.
 */
export enum UserRole {
  PLATFORM_ADMIN = 'PLATFORM_ADMIN', // Ninja Hubs: crea operaciones y ve todas
  ADMIN = 'ADMIN', // administrador de UNA operación
  SUPERVISOR = 'SUPERVISOR',
  OPERATOR = 'OPERATOR',
  CLIENT = 'CLIENT',
}

/** Permisos por rol. Fuente única de verdad de la autorización. */
export const ROLE_PERMISSIONS: Record<UserRole, Permission[]> = {
  [UserRole.PLATFORM_ADMIN]: [
    'stock:read', 'inventory:receive', 'inventory:putaway', 'order:create',
    'order:fulfill', 'order:cancel', 'count:perform', 'seller:config',
    'master:manage', 'user:manage', 'operation:manage', 'product:manage', 'billing:manage', 'billing:approve', 'chat:use', 'chat:manage', 'announcement:view', 'announcement:manage', 'webhook:manage', 'webhook:admin',
  ],
  [UserRole.ADMIN]: [
    'stock:read', 'inventory:receive', 'inventory:putaway', 'order:create',
    'order:fulfill', 'order:cancel', 'count:perform', 'seller:config',
    'master:manage', 'user:manage', 'product:manage', 'billing:manage', 'chat:use', 'chat:manage', 'announcement:view', 'webhook:manage', 'webhook:admin',
  ],
  [UserRole.SUPERVISOR]: [
    'stock:read', 'inventory:receive', 'inventory:putaway', 'order:create',
    'order:fulfill', 'order:cancel', 'count:perform', 'seller:config', 'master:manage', 'product:manage', 'billing:manage', 'chat:use', 'chat:manage', 'announcement:view', 'webhook:manage',
  ],
  [UserRole.OPERATOR]: [
    'stock:read', 'inventory:receive', 'inventory:putaway', 'order:create', 'order:fulfill',
  ],
  // El CLIENT (seller) puede consultar su stock, REGISTRAR recepciones de su propia
  // mercadería, y CREAR/EDITAR/CANCELAR sus órdenes de venta. La frontera de seller
  // (guard) garantiza que solo actúa sobre su propio seller.
  [UserRole.CLIENT]: ['stock:read', 'inventory:receive', 'order:create', 'order:cancel', 'product:manage', 'billing:approve', 'chat:use', 'announcement:view', 'webhook:manage'],
};

/** Operación: el tenant de MÁS ALTO nivel. Cada una es un mundo aislado. */
export interface Operation {
  id: string;
  name: string;
  active: boolean;
  // Pista de onboarding self-serve: 'brand' (marca con un seller = ella misma) u
  // 'operator' (operador 3PL multi-seller). Ausente en operaciones creadas por el super-admin.
  track?: 'brand' | 'operator' | null;
  // true si la operación nació de un registro self-serve (no creada por el PLATFORM_ADMIN).
  selfServe?: boolean;
  // Plan del SaaS (PLG · Fase 1). Ausente = 'internal' (sin límites): super-admin / semilla.
  planId?: string | null;
  // Reverse-trial: plan y vencimiento del período de prueba (efectivo mientras esté vigente).
  trialPlan?: string | null;
  trialEndsAt?: string | null;
  // Modo de asignación de tareas (Camino B): 'advisory' (def) = la PWA sugiere las
  // tareas asignadas pero el operario puede tomar otras; 'strict' = no puede ejecutar
  // una tarea asignada a otro operario.
  assignmentMode?: 'advisory' | 'strict' | null;
  // Auto-balanceo continuo: cuando está activo, el sistema asigna el trabajo nuevo al
  // operario menos cargado a medida que entra, y reparte lo pendiente al liberarse alguien.
  autoBalance?: boolean | null;
}

/**
 * Usuario del WMS.
 *  - PLATFORM_ADMIN: operationId = null (transversal a todas las operaciones).
 *  - Staff de operación: operationId fijo, sellerId = null.
 *  - CLIENT: operationId fijo + sellerId fijo (solo su seller).
 */
export interface User {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  operationId: string | null; // null solo para PLATFORM_ADMIN
  sellerId: string | null; // fijo para CLIENT; null para staff/plataforma
  active: boolean;
  // ¿El usuario verificó su email? Los usuarios existentes/sembrados se consideran
  // verificados (default true); los altas self-serve nacen en false hasta confirmar.
  emailVerified?: boolean;
  // Hash de contraseña (bcrypt). null/undefined = sin credencial fijada aún (invitación pendiente).
  // NUNCA se expone al cliente: se elimina en la capa de API antes de responder.
  passwordHash?: string | null;
}

/** Tipo de token de un solo uso para flujos de cuenta (verificación / reset de clave). */
export type AuthTokenKind = 'verify' | 'reset';

/**
 * Token de un solo uso para verificación de email o reset de contraseña.
 * Se emite al registrarse o al pedir un reset; se consume (usedAt) al canjearse.
 */
export interface AuthToken {
  id: string;
  userId: string;
  kind: AuthTokenKind;
  token: string; // secreto opaco que viaja en el enlace del correo
  createdAt: string;
  expiresAt: string;
  usedAt?: string | null;
}

/**
 * Evento de inicio de sesión (login) exitoso. Append-only, auditable.
 * Alimenta el "Panel de uso" de la plataforma: logins, usuarios activos únicos,
 * tasa de adopción y detección de operaciones dormidas. `operationId` es null
 * para el PLATFORM_ADMIN (transversal a todas las operaciones).
 */
export interface LoginEvent {
  id: string;
  userId: string;
  operationId: string | null;
  at: string; // ISO timestamp
}

/**
 * Anuncio de plataforma: una barra superior que el PLATFORM_ADMIN habilita on-demand
 * para informar lanzamientos a los administradores/supervisores de todas las operaciones.
 * Siempre lleva un enlace a una landing.
 */
/** Audiencia de un anuncio: solo operaciones (admin+supervisor) o también clientes. */
export type AnnouncementAudience = 'OPS' | 'ALL';

export interface Announcement {
  id: string;
  title: string; // texto que se muestra en la barra
  linkUrl: string; // enlace a la landing (siempre presente)
  linkLabel: string; // etiqueta del botón (p. ej. "Ver más")
  active: boolean; // habilitado on-demand
  audience: AnnouncementAudience; // OPS = admin+supervisor; ALL = también clientes
  createdAt: string;
  createdBy: string;
}

/** Registro de un clic en un anuncio, con la identidad del usuario que lo abrió. */
export interface AnnouncementClick {
  id: string;
  announcementId: string;
  userId: string;
  userName: string;
  userRole: string;
  operationId: string | null; // operación (administrador) del usuario
  sellerId: string | null; // cliente (seller), si aplica
  at: string;
}

/**
 * Configuración de empaque de un SKU: cada nivel (unidad, caja master, pallet…)
 * tiene su PROPIO código de barras y un factor de conversión a la unidad base.
 *
 *   code='EA'    barcode=EAN-13  factor=1    (base)
 *   code='CASE'  barcode=DUN-14  factor=12   (1 caja = 12 unidades)
 *   code='PALLET' barcode=SSCC   factor=480
 *
 * Todo el inventario se lleva en unidades BASE; los packs se traducen al escanear.
 */
export interface PackConfig {
  sellerId: string;
  sku: string;
  code: string; // 'EA' | 'CASE' | 'PALLET' | 'INNER' | ... (EA = base)
  label: string; // texto legible: "Unidad (EAN)", "Caja master (DUN)"
  barcode: string; // GTIN del nivel: EAN-13, DUN-14, etc.
  factor: number; // unidades base que representa este pack (EA = 1)
  isBase: boolean; // true para la unidad base
}

/** Resultado de escanear un código y traducirlo a unidades base. */
export interface ScanResult {
  sellerId: string;
  sku: string;
  code: string;
  label: string;
  factor: number;
  packCount: number; // cuántos packs se escanearon
  baseQty: number; // packCount * factor (múltiplos del EAN)
}

/** Metadata de un lote/serie: recepción y vencimiento (para FIFO/FEFO). */
export interface Lot {
  sellerId: string;
  sku: string;
  lot: string;
  receivedAt: string; // ISO — fecha de primera recepción (FIFO)
  expiryDate: string | null; // ISO — vencimiento (FEFO)
}

/**
 * Marca (white-label) de una OPERACIÓN. El admin de la operación la configura para que
 * todos los documentos y pantallas hacia sus sellers lleven SU información y logo, en
 * vez de la de Ninja Hubs. Campos vacíos caen al valor por defecto del deployment.
 */
export interface OperationBranding {
  operationId: string;
  companyName: string | null; // marca visible (reemplaza "Ninja WMS")
  legalName: string | null; // razón social
  taxId: string | null; // RUT / identificador tributario
  address: string | null;
  email: string | null;
  phone: string | null;
  website: string | null;
  primaryColor: string | null; // color primario del tema (hex)
  logoDataUri: string | null; // logo embebido (data URI)
}

// ---- Canal de voz operador ↔ administrador ---------------------------------

/**
 * Taxonomía de tópicos del canal operativo. El agente IA (o la heurística) clasifica
 * cada mensaje en una de estas categorías para alimentar estadísticas e insights.
 */
export const OPS_CATEGORIES = [
  'stock', // faltantes/sobrantes, diferencias de inventario
  'ubicaciones', // dónde está algo, señalética, layout
  'recepcion', // ingresos, cotejo, proveedores
  'picking', // preparación de pedidos
  'despacho', // salidas, couriers, etiquetas
  'incidencia', // errores, daños, problemas, quiebres
  'proceso', // dudas de cómo hacer algo
  'equipos', // scanner, impresora, herramientas, sistema
  'personal', // turnos, ausencias, coordinación de gente
  'otro',
] as const;
export type OpsCategory = (typeof OPS_CATEGORIES)[number];

export const OPS_CATEGORY_LABEL: Record<OpsCategory, string> = {
  stock: 'Stock / inventario',
  ubicaciones: 'Ubicaciones',
  recepcion: 'Recepción',
  picking: 'Picking / preparación',
  despacho: 'Despacho',
  incidencia: 'Incidencias / errores',
  proceso: 'Dudas de proceso',
  equipos: 'Equipos / sistema',
  personal: 'Personal / turnos',
  otro: 'Otro',
};

/** Un mensaje del canal de voz operador↔admin (por operación). Un hilo por operador. */
export interface OpsMessage {
  id: string;
  operationId: string;
  threadUserId: string; // el operador dueño del hilo (admin responde a ese hilo)
  senderId: string;
  senderName: string;
  senderRole: string;
  kind: 'voice' | 'text';
  text: string | null; // texto escrito, o transcripción del audio
  note: string | null; // nota corta opcional que acompaña al audio
  audioId: string | null; // referencia al blob de audio (si kind=voice)
  audioMime: string | null;
  durationSec: number | null;
  category: OpsCategory | null; // categoría asignada por IA/heurística
  categoryConfidence: number | null;
  categorySource: 'ai' | 'heuristic' | null;
  at: string; // ISO
}

/** Blob de audio de un mensaje de voz (se guarda aparte para no cargarlo en los listados). */
export interface OpsAudioBlob {
  id: string;
  operationId: string;
  mime: string;
  dataBase64: string;
}

/**
 * Estado de lectura de un hilo (por operación + operador). Alimenta el "visto"
 * estilo WhatsApp: cada lado (administración / operador) marca hasta cuándo leyó.
 */
export interface OpsThreadRead {
  operationId: string;
  threadUserId: string;
  adminReadAt: string | null; // hasta cuándo leyó la administración
  operatorReadAt: string | null; // hasta cuándo leyó el operador
}

/** Insights del canal generados sobre el historial de mensajes. */
export interface OpsInsights {
  summary: string;
  topTopics: { category: OpsCategory; label: string; count: number; pct: number }[];
  suggestions: string[];
  generatedBy: 'ai' | 'heuristic';
  totalMessages: number;
}

/** Ciclo de vida de un número de serie. */
export enum SerialStatus {
  IN_STOCK = 'IN_STOCK', // recibido y en bodega
  SHIPPED = 'SHIPPED', // salió en un despacho
  RETURNED = 'RETURNED', // volvió por una devolución
}

/**
 * Registro de un número de serie individual (trazabilidad unidad-a-unidad).
 * Se captura en la recepción para SKUs serializados. Cada serie es única por (seller, sku)
 * y arrastra su lote y vencimiento. El stock por cantidad sigue viviendo en el ledger;
 * este registro es la capa de trazabilidad por serie encima de ese stock.
 */
export interface Serial {
  sellerId: string;
  sku: string;
  serial: string; // número de serie (único por seller+sku)
  lot: string | null; // lote al que pertenece (si el SKU también es por lote)
  expiry: string | null; // vencimiento (ISO)
  status: SerialStatus;
  receiptId: string | null; // orden de recepción donde se registró
  locationId: string | null; // ubicación donde ingresó
  receivedAt: string; // ISO — cuándo se registró
  actor: string; // quién lo registró
}

/** Clase de rotación ABC: A = alta rotación (cerca de picking), C = baja. */
export enum RotationClass {
  A = 'A',
  B = 'B',
  C = 'C',
}

/** Maestro: SKU, siempre scoped a un seller. */
/** Modo de un kit (SKU compuesto por otros SKUs). */
export enum KitMode {
  VIRTUAL = 'VIRTUAL', // no tiene stock propio: al pedirlo, se explota en sus componentes
  ASSEMBLED = 'ASSEMBLED', // tiene stock propio: se arma en bodega consumiendo componentes
}

/** Un componente de un kit: cuántas unidades base de `sku` lleva 1 kit. */
export interface KitComponent {
  sku: string;
  qty: number;
}

export interface Sku {
  sellerId: string;
  sku: string;
  description: string;
  barcode: string | null;
  lotControlled: boolean;
  serialControlled: boolean; // true = cada unidad tiene número de serie único (se captura en recepción)
  expiryControlled: boolean; // true = exige vencimiento al recepcionar (perecibles / FEFO)
  rotationClass: RotationClass; // guía el guardado caótico dirigido
  active: boolean;
  // ---- Kits (SKU compuesto por otros SKUs) ----
  isKit: boolean; // true si este SKU es un kit/bundle
  kitMode: KitMode | null; // VIRTUAL (explota en órdenes) o ASSEMBLED (stock propio)
  components: KitComponent[]; // lista de materiales (BOM); vacío si no es kit
}

// ---- Facturación 3PL --------------------------------------------------------

/** Tarifario de un cliente (seller): cuánto cobra el 3PL por cada concepto. */
export interface BillingRate {
  sellerId: string;
  currency: string; // p.ej. 'CLP'
  fixedMonthly: number; // cuota fija mensual
  storagePerUnitMonth: number; // almacenamiento por unidad-mes
  receiptPerUnit: number; // por unidad recibida
  shipmentPerOrder: number; // por pedido despachado
  pickPerUnit: number; // por unidad pickeada
  assemblyPerKit: number; // por kit armado
  requiresApproval: boolean; // si true, las facturas de este cliente requieren su aprobación
}

/** Una línea de la factura. */
export interface BillingLine {
  concept: string; // 'Almacenamiento', 'Recepción', ...
  unit: string; // 'unidad-mes', 'unidad', 'pedido', 'kit', 'mes'
  qty: number;
  rate: number;
  amount: number;
}

/** Un envío por correo de una factura (auditoría). */
export interface InvoiceSend {
  to: string;
  at: string;
  by: string;
  delivered: boolean; // true si el SMTP entregó; false si solo quedó registrado
}

/**
 * Estado de una factura. Mientras no tenga documento tributario adjunto y marcado
 * es una **Pre-factura** (ISSUED/PENDING/APPROVED, según el flujo de aprobación);
 * cuando el administrador adjunta el documento tributario y la marca, pasa a **Facturado**.
 *  - ISSUED: pre-factura directa (el cliente NO requiere aprobación).
 *  - PENDING: pre-factura pendiente de la aprobación del cliente.
 *  - APPROVED: pre-factura aprobada por el cliente (ver `approval`).
 *  - INVOICED: Facturado — con documento tributario adjunto y marcada por el administrador.
 */
export type InvoiceStatus = 'ISSUED' | 'PENDING' | 'APPROVED' | 'INVOICED';

/** Registro de aprobación del cliente sobre una factura (fecha, hora y usuario). */
export interface InvoiceApproval {
  by: string; // id/nombre del usuario del cliente que aprobó
  at: string; // ISO — fecha y hora de la aprobación
}

/**
 * Documento tributario adjunto a una factura (la factura real en PDF u otro archivo).
 * Los bytes se guardan aparte (repositorio); aquí van solo los metadatos visibles.
 */
export interface InvoiceTaxDocument {
  fileName: string; // nombre original del archivo
  mimeType: string; // p.ej. application/pdf
  size: number; // tamaño en bytes
  uploadedAt: string; // ISO
  uploadedBy: string; // id/nombre del administrador que lo adjuntó
}

/** Factura mensual de un cliente. */
export interface BillingInvoice {
  id: string; // clave interna inmutable: FAC-YYYYMM-XXXX
  number: string; // número visible/editable de la factura (por defecto = id)
  sellerId: string;
  periodFrom: string; // ISO (inclusive)
  periodTo: string; // ISO (exclusivo)
  currency: string;
  lines: BillingLine[];
  total: number;
  createdAt: string;
  createdBy: string;
  sends: InvoiceSend[]; // historial de envíos por correo
  status: InvoiceStatus; // Pre-factura (ISSUED/PENDING/APPROVED) o Facturado (INVOICED)
  approval: InvoiceApproval | null; // set cuando el cliente aprueba
  taxDocument: InvoiceTaxDocument | null; // documento tributario adjunto (visible por el cliente)
}

// ---- Chat interno cliente ↔ equipo de operaciones ---------------------------

/** Lado del que proviene un mensaje del chat. */
export type ChatSide = 'CLIENT' | 'OPS';

/** Un mensaje del chat interno de un cliente (seller). Append-only, auditable. */
export interface ChatMessage {
  id: string;
  sellerId: string; // conversación por cliente
  senderId: string; // id del usuario que escribió
  senderName: string; // nombre visible (para que operaciones sepa quién habla)
  senderRole: string; // rol del emisor
  side: ChatSide; // CLIENT = cliente; OPS = equipo de operaciones
  body: string;
  at: string; // ISO
}

/** Marcadores de "leído hasta" por lado, por conversación (para no leídos). */
export interface ChatReadState {
  sellerId: string;
  opsReadAt: string | null; // hasta cuándo leyó el equipo de operaciones
  clientReadAt: string | null; // hasta cuándo leyó el cliente
}

/** Una extracción de componente para armar un kit: de qué ubicación/lote y cuánto. */
export interface AssemblySource {
  sku: string;
  locationId: string;
  lot: string | null;
  qty: number;
}

/** Registro auditable de un armado de kit. */
export interface AssemblyRecord {
  id: string;
  sellerId: string;
  kitSku: string;
  qty: number; // kits armados
  toLocationId: string; // dónde quedó el kit terminado
  sources: AssemblySource[]; // de qué ubicaciones salió cada componente
  actor: string; // usuario que armó
  at: string; // ISO timestamp
}

/** Entrada del historial de cambios de un producto (auditoría). */
export interface ProductLogEntry {
  id: string;
  sellerId: string;
  sku: string;
  at: string; // ISO timestamp
  actor: string; // usuario que hizo el cambio
  action: string; // CREADO | EDITADO | ACTIVADO | DESACTIVADO | ARMADO | PACK
  detail: string | null; // texto legible del cambio
}

/** Tipo de zona en la bodega. */
export enum ZoneType {
  RECEIVING = 'RECEIVING',
  STORAGE = 'STORAGE',
  PICKING = 'PICKING',
  SHIPPING = 'SHIPPING',
  QUARANTINE = 'QUARANTINE',
}

/** Maestro: ubicación física. Compartida entre sellers (propiedad va en el bucket). */
export interface Location {
  id: string;
  operationId: string; // las ubicaciones/bodegas son propias de cada operación
  warehouseId: string;
  code: string; // p.ej. "A-03-2-B"
  zoneType: ZoneType;
  capacity: number; // capacidad en unidades (0 = sin límite definido)
  pickRank: number; // cercanía a picking/despacho: 1 = más cerca (mejor para clase A)
  active: boolean;
  x?: number | null; // coordenada (G7): geometría para distancia real de traslado
  y?: number | null;
}

/** Sugerencia de ubicación para guardar, con su puntaje y las razones. */
export interface PutawaySuggestion {
  locationId: string;
  locationCode: string;
  score: number;
  remainingCapacity: number;
  reasons: string[];
}

// ---- Órdenes -----------------------------------------------------------------

/** Estado de una orden de venta a lo largo del fulfillment. */
export enum OrderStatus {
  RECEIVED = 'RECEIVED', // ingresada desde el OMS, sin reservar
  ALLOCATED = 'ALLOCATED', // stock reservado por completo
  PICKING = 'PICKING', // pick list generada, recolección en curso
  PICKED = 'PICKED', // recolectada; el stock salió de las ubicaciones
  PACKED = 'PACKED', // empacada: las unidades pickeadas se embalaron en bultos (con etiquetas del OMS)
  SHIPPED = 'SHIPPED', // despachada (con courier B2C / transporte B2B)
  CANCELLED = 'CANCELLED', // cancelada, reservas liberadas
}

/** Modo de despacho. */
export enum ShippingMode {
  PARCEL = 'parcel', // paquetería (B2C)
  FREIGHT = 'freight', // transporte / flota (B2B)
}

/** Una tarea de recolección: qué tomar, de dónde y en qué cantidad. Guía al pickeador. */
export interface PickTask {
  lineNo: number;
  sku: string;
  locationId: string;
  lot: string | null;
  qty: number; // cantidad reservada en esa ubicación
  pickedQty: number; // cuánto de esa tarea ya se pickeó (0..qty)
  uom: Uom;
}

/** Registro de despacho de una orden. */
export interface Shipment {
  mode: ShippingMode;
  carrier: string | null;
  trackingNumber: string | null;
  shippedAt: string;
}

// ---- Empaque (packing) + etiquetas del OMS ----------------------------------

/** Formato en que llega una etiqueta desde el OMS (para renderizar/imprimir). */
export type ShippingLabelFormat = 'SVG' | 'PNG' | 'PDF' | 'ZPL';

/**
 * Una etiqueta de un bulto, tal como la entrega el OMS de Ninja.
 * `dataUri` es la etiqueta lista para ver/imprimir (data: URI), que el operario
 * pega en el bulto durante el packing.
 */
export interface ShippingLabel {
  bultoNo: number; // número de bulto (1..N)
  trackingNumber: string | null; // tracking de ESTE bulto (puede coincidir con el master)
  carrier: string | null; // courier / transporte
  format: ShippingLabelFormat; // formato del contenido de `dataUri`
  dataUri: string; // etiqueta imprimible (p.ej. data:image/svg+xml;base64,...)
}

/** Estado de la obtención de etiquetas desde el OMS. */
export type LabelStatus =
  | 'PENDING' // empacada; aún esperando tracking/etiquetas del OMS
  | 'READY' // el OMS respondió con tracking + etiquetas
  | 'ERROR'; // el OMS no respondió / falló (se puede reintentar)

/** Información de empaque de una orden: bultos + tracking + etiquetas del OMS. */
export interface PackingInfo {
  packedAt: string; // ISO
  bultos: number; // cantidad de bultos embalados
  packedBy: string; // id/email del operario que empacó
  trackingNumber: string | null; // tracking master del transporte (del OMS)
  carrier: string | null; // courier / transporte asignado por el OMS
  labelStatus: LabelStatus; // estado de la obtención de etiquetas
  labelError: string | null; // detalle si labelStatus = ERROR
  labels: ShippingLabel[]; // una etiqueta por bulto
  source: string | null; // origen de las etiquetas: 'oms-ninja' | 'manual'
  labeledAt: string | null; // ISO en que se adjuntaron las etiquetas
  materials: PackingMaterialUse[]; // insumos de embalaje consumidos por esta orden
}

/** Un insumo de embalaje consumido al empacar una orden (registro en la orden). */
export interface PackingMaterialUse {
  sku: string; // SKU del insumo de embalaje (catálogo de la operación)
  name: string; // nombre al momento del consumo
  qty: number; // unidades consumidas
}

// ---- Insumos de embalaje (packaging) ---------------------------------------

/**
 * Insumo de embalaje: caja, bolsa, cinta, etc. Es un "producto" con SKU/EAN pero
 * NO se vende ni se reserva en órdenes de cliente: se CONSUME al empacar y se cobra
 * al seller cuyo pedido lo usó. El catálogo es de la OPERACIÓN (bodega), compartido
 * entre clientes; el precio por defecto puede tener override por seller.
 */
export interface PackagingMaterial {
  operationId: string;
  sku: string; // identificador del insumo (único por operación)
  barcode: string | null; // EAN para escanear en el packing
  name: string;
  unitPrice: number; // precio de cobro por unidad (por defecto)
  sellerPrices: Record<string, number>; // override de precio por seller (opcional)
  active: boolean;
}

/** Tipo de movimiento de stock de embalaje. */
export enum PackagingMovementType {
  RECEIPT = 'RECEIPT', // ingreso de stock de embalaje
  CONSUMPTION = 'CONSUMPTION', // consumo al empacar (cargado a un seller/orden)
  ADJUSTMENT = 'ADJUSTMENT', // ajuste manual (+/-)
}

/** Movimiento del ledger de embalaje (a nivel operación). Inmutable; saldo = suma de deltas. */
export interface PackagingMovement {
  id: string;
  operationId: string;
  materialSku: string;
  type: PackagingMovementType;
  qtyDelta: number; // + entra / - consume
  sellerId: string | null; // a qué cliente se carga el consumo (null en RECEIPT/ADJUSTMENT)
  orderId: string | null; // orden que consumió el insumo
  unitPrice: number | null; // precio efectivo aplicado al consumo (para trazar el cobro)
  /**
   * Costo unitario del insumo: en RECEIPT es el costo de compra declarado en la reposición;
   * en CONSUMPTION/ADJUSTMENT es el costo promedio ponderado (PMP) vigente al momento, para
   * valorizar la salida y calcular margen (precio cobrado − costo).
   */
  unitCost: number | null;
  reference: string | null;
  actor: string;
  occurredAt: string; // ISO
}

// ---- Conteo cíclico ----------------------------------------------------------

/** Una tarea de conteo generada por el planificador según la estrategia del seller. */
export interface CycleCountTask {
  kind: 'LOCATION' | 'SKU';
  ref: string; // locationId o sku
  label: string; // texto legible para el operario
  priority: number; // 1 = mayor prioridad
  reason: string; // por qué se generó (ABC, barrido, aleatorio, evento)
}

/** Línea contada físicamente por el operario. */
export interface CountLine {
  sku: string;
  lot: string | null;
  countedQty: number;
}

/** Varianza de una línea: lo que el sistema esperaba vs. lo contado. */
export interface CountVariance {
  sku: string;
  lot: string | null;
  locationId: string;
  expected: number;
  counted: number;
  delta: number; // counted − expected (positivo = sobrante, negativo = faltante)
}

/** Resultado de ejecutar un conteo en una ubicación. */
export interface CountResult {
  sellerId: string;
  locationId: string;
  variances: CountVariance[];
  adjustedUnits: number; // suma de |delta| ajustada al ledger
  accurate: boolean; // true si no hubo ninguna varianza
}

/**
 * Registro persistido de un conteo (tabla CountVariance): esperado vs. contado por
 * conteo. Alimenta el KPI de exactitud de inventario y su tendencia (G8).
 */
export interface CountAudit {
  id: string;
  operationId: string;
  sellerId: string;
  locationId: string;
  at: string; // ISO
  linesCounted: number; // buckets SKU/lote examinados
  linesAccurate: number; // buckets con delta 0
  unitsExpected: number; // unidades que el sistema esperaba
  absVarianceUnits: number; // suma de |delta|
  accuracyPct: number; // exactitud por línea: linesAccurate / linesCounted (0..1)
  variances: CountVariance[]; // detalle de las líneas con diferencia
}

/** Dirección de despacho (B2C: consumidor; B2B: negocio). */
export interface ShipTo {
  name: string;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  comuna?: string | null;
  region?: string | null;
}

/** Una reserva concreta de una línea contra una ubicación/lote. Guía el picking. */
export interface Allocation {
  locationId: string;
  lot: string | null;
  qty: number; // reservado en esta ubicación
  pickedQty?: number; // recolectado desde esta ubicación (picking parcial/dirigido)
  sku?: string; // SKU realmente reservado; para un kit VIRTUAL es el componente (default: el SKU de la línea)
}

/** Línea de una orden. */
export interface OrderLine {
  lineNo: number;
  sku: string;
  qty: number;
  uom: Uom;
  lot: string | null; // opcional: si viene, exige reservar de ese lote/serie
  allocations: Allocation[]; // se llenan al reservar (allocate)
}

/**
 * Orden de venta. Llega desde el OMS con seller y canal ya resueltos.
 * El mismo modelo sirve para B2C y B2B (cambia orderType, uom y modo de despacho).
 */
/** Evento del historial/auditoría de una orden (append-only: quién hizo qué y cuándo). */
export interface OrderEvent {
  type: string; // CREATED | UPDATED | ALLOCATED | PICKING | PICKED | PACKED | LABELED | SHIPPED | CANCELLED
  at: string; // ISO timestamp
  actor: string; // id/email del usuario (o 'system')
  detail?: string | null; // texto legible (p.ej. "2 líneas · 24 un", "Chilexpress TRK123")
}

/**
 * Evento de negocio promovido a tabla indexable (G2+G6). Es el MISMO stream que
 * vive dentro de `entity.events` (JSON), pero desnormalizado a filas consultables
 * por SQL: tiempos entre estados, forecasting y agentes leen de aquí sin cargar
 * las órdenes completas a memoria. La fuente sigue siendo append-only.
 */
export type DomainEntityType = 'ORDER' | 'RECEIPT' | 'RETURN';
export interface DomainEvent {
  id: string; // determinístico: `${entityType}:${entityId}:${seq}` — idempotente ante re-guardado
  entityType: DomainEntityType;
  entityId: string; // id interno de la orden/recepción/devolución
  entityRef: string | null; // n° externo legible (externalOrderId / reference)
  sellerId: string; // scoping por cliente (y, vía seller, por operación)
  seq: number; // posición del evento en el historial de la entidad (0-based)
  type: string; // mismo `type` del OrderEvent (CREATED, PICKED, RECEPCIÓN…, SHIPPED…)
  at: string; // ISO timestamp del evento
  actor: string; // quién lo generó
  detail: string | null; // texto legible
}

// ---- Rollups diarios (G3): métricas O(1) y series limpias para forecasting -----

/**
 * Foto diaria del on-hand por SKU y estado (AVAILABLE/RESERVED/…), calculada por el
 * job diario a partir del ledger. Permite posición de inventario sin full-scan.
 * `date` es 'YYYY-MM-DD' (UTC). id determinístico → re-ejecutar el job da el mismo resultado.
 */
export interface DailyInventorySnapshot {
  id: string; // `${sellerId}:${sku}:${date}`
  sellerId: string;
  sku: string;
  date: string; // YYYY-MM-DD
  available: number;
  reserved: number;
  quarantine: number;
  damaged: number;
  inTransit: number;
  total: number; // suma de todos los estados (on-hand total)
}

/**
 * Demanda diaria por SKU (unidades despachadas + nº de órdenes). Es la SERIE que
 * el forecasting consume directamente, sin recalcular desde el ledger.
 */
export interface DailyDemand {
  id: string; // `${sellerId}:${sku}:${date}`
  sellerId: string;
  sku: string;
  date: string; // YYYY-MM-DD
  unitsShipped: number;
  orders: number; // nº de órdenes distintas despachadas ese día con este SKU
}

/**
 * Rollup diario de los indicadores operativos por seller (los que consume el
 * dashboard). Sumar los días de la ventana evita el full-scan del ledger.
 */
export interface DailyMetricRollup {
  id: string; // `${sellerId}:${date}`
  sellerId: string;
  date: string; // YYYY-MM-DD
  ordersPrepared: number; // órdenes que llegaron a PICKED ese día
  unitsPrepared: number; // unidades pickeadas (movimientos PICK)
  ordersReceived: number; // recepciones con evento RECEPCIÓN ese día
  unitsReceived: number; // unidades recibidas (movimientos RECEIPT)
  movements: number; // asientos del ledger ese día
}

// ---- Persistencia + auditoría de IA (G5) --------------------------------------

/**
 * Recomendación generada por un agente/IA (guardado sugerido, respuesta del copiloto,
 * reclasificación ABC…). Se registra para gobernanza y para medir el % de sugerencias
 * aceptadas y su efecto. `taken` y `outcome` se completan cuando se sabe si se siguió.
 */
export interface AiRecommendation {
  id: string;
  operationId: string;
  sellerId: string | null;
  type: string; // 'putaway' | 'copilot_action' | 'copilot_answer' | 'abc_reclass' | …
  input: string; // resumen legible del input (JSON serializado o texto)
  output: string; // resumen legible de la recomendación
  score: number | null; // puntaje/confianza cuando aplica
  taken: boolean | null; // ¿se siguió? null = aún no se sabe
  outcome: string | null; // efecto observado (texto)
  actor: string | null; // quién la recibió/gatilló
  at: string; // ISO
}

/**
 * Acción ejecutada por un agente (copiloto, advisor, job) sobre el sistema. Deja
 * traza auditable de qué decidió, quién la confirmó, sobre qué orden y con qué
 * resultado.
 */
export interface AgentAction {
  id: string;
  operationId: string;
  sellerId: string | null;
  agent: string; // 'copilot' | 'putaway_advisor' | 'abc_job' | …
  decision: string; // qué se decidió (p.ej. 'pickear', 'reservar')
  actor: string; // quién la ejecutó/confirmó
  orderRef: string | null; // orden afectada (n° externo o id)
  result: string; // 'ok' | 'error: …'
  recommendationId: string | null; // enlaza con la AiRecommendation, si vino de una
  at: string; // ISO
}

// ---- Asignación de tareas / balanceo de carga (Camino B) ----------------------

export type WorkTaskType = 'PICK' | 'PUTAWAY' | 'COUNT' | 'RECEIVE' | 'RESLOT' | 'PACK' | 'SHIP';
export type WorkAssignmentStatus = 'assigned' | 'in_progress' | 'done' | 'released';

/**
 * Asignación de una tarea a un operario (modelo push). Una tarea (identificada por
 * `type`+`entityId`) tiene a lo más UNA asignación activa; reasignar la reemplaza.
 * `completedBy` puede diferir del `operator` asignado cuando el modo es advisory
 * (el sistema registra quién la ejecutó realmente).
 */
export interface WorkAssignment {
  id: string; // determinístico: `${type}:${entityId}`
  operationId: string;
  sellerId: string | null;
  type: WorkTaskType;
  entityId: string; // orderId (PICK) | `${sellerId}:${sku}:${locationId}` (PUTAWAY) | `${sellerId}:${ref}` (COUNT)
  entityRef: string | null; // texto legible (n° de orden, sku@ubicación, etiqueta de conteo)
  operator: string; // id del operario asignado
  status: WorkAssignmentStatus;
  unitsEstimate: number; // unidades estimadas de trabajo (para balancear por tiempo)
  assignedBy: string;
  assignedAt: string;
  completedAt: string | null;
  completedBy: string | null;
  note: string | null;
}

// ---- Registro de tareas (task ledger) -----------------------------------------
/**
 * Etapa/tipo de una tarea del ciclo de vida. A diferencia de WorkTaskType (que son
 * las tareas ASIGNABLES a un operario), la etapa incluye RESERVE: la reserva de stock
 * es una tarea del ledger (instantánea) aunque no se asigne a nadie.
 */
export type WorkTaskStage = 'RESERVE' | 'PICK' | 'PACK' | 'SHIP' | 'PUTAWAY' | 'RECEIVE' | 'COUNT' | 'RESLOT';
export type WorkTaskState = 'pending' | 'assigned' | 'in_progress' | 'done' | 'cancelled';

/**
 * TAREA persistente del ciclo de vida (task ledger). Cada etapa por la que pasa una
 * orden (reserva, picking, packing, despacho) o una recepción/guardado/conteo se
 * registra como una tarea con su propio id interno secuencial (`t-N`), su tipo/etapa,
 * su estado y el vínculo a la orden (`orderId`) cuando aplica. Da trazabilidad completa
 * y la relación tarea ↔ tipo ↔ orden.
 */
export interface WorkTask {
  id: string; // id interno secuencial, ej. "t-1042"
  operationId: string;
  sellerId: string | null;
  type: WorkTaskStage;
  orderId: string | null; // orden asociada (null para tareas no ligadas a orden, ej. PUTAWAY/COUNT)
  orderRef: string | null; // referencia externa legible de la orden
  entityId: string; // entidad de trabajo (orderId | receiptId | `${sellerId}:${sku}:${loc}` | ref de conteo)
  entityRef: string | null; // texto legible
  state: WorkTaskState;
  unitsEstimate: number;
  assignmentId: string | null; // WorkAssignment.id cuando la tarea se asigna a un operario
  operator: string | null; // operario asignado (si aplica)
  createdAt: string;
  createdBy: string;
  startedAt: string | null;
  completedAt: string | null;
  completedBy: string | null;
  note: string | null;
}

// ---- Agente proactivo (Nivel 3): reglas y alertas -----------------------------
export type AgentRuleSeverity = 'info' | 'warn' | 'crit';
export type AgentAlertStatus = 'open' | 'ack';
/** Fase 3: qué hace la regla al cumplirse — solo avisar, o ejecutar su acción. */
export type AgentActionType = 'alert' | 'execute';
/** En 'execute': la acción se propone para confirmación, o se ejecuta directo. */
export type AgentActionMode = 'confirmar' | 'directo';
/** Estado de la acción sobre una alerta. */
export type AgentAlertActionStatus = 'none' | 'proposed' | 'done' | 'error';

/**
 * Configuración por operación de una regla del agente proactivo. La DEFINICIÓN de cada
 * regla (qué evalúa) vive en código (AGENT_RULES); esto guarda solo los ajustes: si está
 * encendida, el umbral, el enfriamiento anti-spam, la severidad y el alcance por cliente.
 */
export interface AgentRuleConfig {
  operationId: string;
  ruleKey: string; // clave de la definición (ej. 'orden_estancada')
  enabled: boolean;
  threshold: number; // significado según la regla (horas | días | mínimo)
  cooldownMin: number; // no repetir la misma alerta dentro de N minutos
  severity: AgentRuleSeverity;
  sellerId: string | null; // alcance: null = toda la operación
  actionType: AgentActionType; // Fase 3: 'alert' (solo avisa) | 'execute' (corre su acción)
  actionMode: AgentActionMode; // en 'execute': 'confirmar' (propone) | 'directo' (ejecuta solo)
  updatedAt: string;
  updatedBy: string | null;
}

/** Alerta generada por el agente (notificación in-app de la Fase 1). */
export interface AgentAlert {
  id: string;
  operationId: string;
  sellerId: string | null;
  ruleKey: string;
  severity: AgentRuleSeverity;
  title: string;
  detail: string;
  action: string | null; // sugerencia de qué hacer
  link: string | null; // pantalla a abrir
  entityRef: string | null;
  dedupeKey: string; // para no repetir la misma alerta
  status: AgentAlertStatus;
  // Fase 3: acción asociada a la alerta (si la regla ejecuta).
  actionTool: string | null; // herramienta a correr (ej. 'reasignar_ociosidad')
  actionLabel: string | null; // etiqueta legible de la acción
  actionStatus: AgentAlertActionStatus; // none | proposed (esperando confirmación) | done | error
  actionResult: string | null; // resultado de la ejecución
  createdAt: string;
  ackAt: string | null;
  ackBy: string | null;
}

// ---- Productividad de mano de obra (G4): LaborTask ----------------------------

export type LaborTaskType = 'PICK' | 'PUTAWAY' | 'PACK' | 'RECEIVE' | 'COUNT' | 'OTHER';

/**
 * Tarea de trabajo de un operario: quién, qué tipo, cuándo empezó/terminó y cuántas
 * unidades. `source` distingue lo DERIVADO del ledger (arranque sin instrumentar:
 * start==end, sólo occurredAt) de lo CAPTURADO por la PWA (inicio/fin reales).
 */
export interface LaborTask {
  id: string; // derivado: `PICK:${movementId}` — idempotente; capturado: id propio
  operationId: string;
  sellerId: string | null;
  operator: string; // actor (id/email del operario)
  type: LaborTaskType;
  startAt: string; // ISO
  endAt: string; // ISO (== startAt en tareas derivadas del ledger)
  units: number;
  orderRef: string | null;
  locationId: string | null;
  source: 'ledger' | 'captured';
}

// ---- Costos y rentabilidad (costeo por actividad + estándar/real) -------------

/**
 * Tarifario de COSTOS de la operación (espejo del tarifario de facturación, pero por
 * el lado del costo). Habilita el costeo por actividad (ABC) y la gestión de eficiencia
 * comparando costo ESTÁNDAR (ingeniería: unidades ÷ estándar u/h × tarifa) contra el
 * costo REAL (horas efectivas del LaborTask × tarifa cargada del operario).
 *
 * Una tarjeta por operación. La mano de obra es el costo directo dominante en un 3PL;
 * almacenaje, embalaje y overhead completan el costo total para calcular margen.
 */
export interface CostRateCard {
  operationId: string;
  currency: string; // p.ej. 'CLP'
  // Mano de obra
  standardLaborRatePerHour: number; // tarifa cargada ESTÁNDAR por hora (sueldo + leyes) — base del costo estándar
  laborCostByRole: Record<string, number>; // costo/hora real por rol (OPERATOR, SUPERVISOR…); default si no hay override por operario
  laborCostByOperator: Record<string, number>; // override de costo/hora por operario (id/email)
  standardUph: Record<string, number>; // estándar de unidades/hora por tipo de tarea (PICK, PUTAWAY, PACK, RECEIVE, COUNT)
  // Almacenaje
  storageCostPerUnitMonth: number; // costo de almacenaje por unidad-mes (arriendo/racks prorrateado al inventario)
  // Embalaje
  packagingCostRatio: number; // costo de los insumos de embalaje como fracción del precio de cobro (0..1)
  // Overhead (gastos generales del CD que no se atribuyen directo)
  monthlyOverhead: number; // costo fijo mensual de la bodega (arriendo base, energía, supervisión, admin)
  overheadDriver: 'laborHours' | 'unitMonths' | 'orders'; // cómo se prorratea entre clientes
  updatedAt: string;
  updatedBy: string | null;
}

/** Desglose de costo por actividad para un cliente/período. */
export interface CostBreakdown {
  laborStandard: number; // costo de mano de obra a estándar (ingeniería)
  laborReal: number; // costo de mano de obra real (horas efectivas × tarifa)
  laborVariance: number; // real − estándar (positivo = ineficiencia; negativo = mejor que estándar)
  storage: number;
  packaging: number;
  overhead: number;
  totalStandard: number; // laborStandard + storage + packaging + overhead
  totalReal: number; // laborReal + storage + packaging + overhead
}

/** Rentabilidad de un cliente en un período: ingreso (facturación) vs. costo. */
export interface SellerProfitability {
  sellerId: string;
  sellerName: string;
  currency: string;
  revenue: number; // ingreso del período (facturación 3PL)
  cost: CostBreakdown;
  marginStandard: number; // revenue − cost.totalStandard (margen objetivo/ingeniería)
  marginReal: number; // revenue − cost.totalReal (margen efectivo)
  marginPctStandard: number | null; // marginStandard / revenue
  marginPctReal: number | null; // marginReal / revenue
}

/** Eficiencia de mano de obra estándar vs. real (para gestión C-level). */
export interface LaborEfficiencyRow {
  key: string; // operario o tipo de tarea
  label: string;
  units: number;
  realHours: number; // horas efectivas trabajadas
  standardHours: number; // horas que "debería" haber tomado a estándar
  efficiencyPct: number | null; // standardHours / realHours × 100 (>100 = más rápido que estándar)
  realCost: number;
  standardCost: number;
  variance: number; // realCost − standardCost
}

export interface SalesOrder {
  id: string;
  sellerId: string;
  externalOrderId: string; // id de la orden en el canal de origen
  salesChannel: string; // canal resuelto por el OMS
  orderType: OrderType;
  purchaseOrderRef: string | null; // OC del cliente (B2B)
  documentType: string | null; // atributo seleccionable (boleta | factura | guia_despacho | orden_compra); no emite ante el SII
  carrier: string | null; // courier/transporte que trae la orden al ingresar (ej. Chilexpress, Rapiboy); insumo para priorizar picking
  priority: string; // normal | express
  shipTo: ShipTo;
  status: OrderStatus;
  lines: OrderLine[];
  packing: PackingInfo | null; // se llena al empacar (PACKED): bultos + tracking + etiquetas del OMS
  shipment: Shipment | null; // se llena al despachar
  createdAt: string;
  events: OrderEvent[]; // historial de auditoría (append-only)
}

// ---- Órdenes de DEVOLUCIÓN (reversa) ---------------------------------------

/**
 * Estado de una devolución:
 *   PENDING   — creada y enlazada a la orden de salida original; espera QA/recepción.
 *   PARTIAL   — se procesó (recibió) parte de las líneas; sigue abierta.
 *   COMPLETED — cerrada: el QA registró la disposición de todo lo recibido.
 *   CANCELLED — anulada antes de procesar.
 */
export enum ReturnStatus {
  PENDING = 'PENDING',
  PARTIAL = 'PARTIAL',
  COMPLETED = 'COMPLETED',
  CANCELLED = 'CANCELLED',
}

/** Disposición de una unidad devuelta tras el control de calidad (QA). */
export enum ReturnDisposition {
  STOCK = 'stock', // vuelve a stock disponible (vendible)
  MERMA = 'merma', // dañado: a ubicación de merma de devoluciones
  CUARENTENA = 'cuarentena', // en revisión: a ubicación de cuarentena de devoluciones
}

export interface ReturnLine {
  lineNo: number;
  sku: string;
  expectedQty: number; // lo que salió en la orden original (0 en líneas "comodín" agregadas en QA)
  toStock: number; // unidades dispuestas a stock disponible (acumulado)
  toMerma: number; // unidades dispuestas a merma (acumulado)
  toQuarantine: number; // unidades dispuestas a cuarentena (acumulado)
  note: string | null;
}

/**
 * Orden de devolución. Enlaza con la orden de salida original para saber qué se
 * despachó, y en el QA cada unidad recibida se dispone a stock, merma o cuarentena.
 */
export interface ReturnOrder {
  id: string;
  sellerId: string;
  originalOrderId: string | null; // id interno de la orden de salida (SalesOrder)
  originalOrderRef: string | null; // N° externo de la orden (etiqueta pistoleada)
  reason: string | null;
  status: ReturnStatus;
  lines: ReturnLine[];
  createdAt: string;
  events: OrderEvent[]; // auditoría (append-only)
}

// ---- Órdenes de RECEPCIÓN (inbound) ----------------------------------------

/**
 * Estado de una orden de recepción (ciclo de cotejo físico vs teórico):
 *   PENDING  — creada con cantidades esperadas; aún sin recibir (no hay stock).
 *   PARTIAL  — se recibió parte; sigue abierta para más eventos de recepción.
 *   RECEIVED — cerrada: se recibió todo lo esperado (completa) o se cerró con
 *              faltante (parcial). El detalle esperado/recibido queda en las líneas.
 *   CANCELLED — anulada: el stock recibido (si hubo) fue revertido del ledger.
 */
export enum ReceiptOrderStatus {
  PENDING = 'PENDING',
  PARTIAL = 'PARTIAL',
  RECEIVED = 'RECEIVED',
  CANCELLED = 'CANCELLED',
}

/** Una línea (SKU) dentro de una orden de recepción. */
export interface ReceiptLine {
  lineNo: number;
  sku: string;
  expectedQty: number; // cantidad teórica declarada en la orden
  receivedQty: number; // cantidad física acumulada realmente recibida (cotejo)
  uom: Uom;
  lot: string | null; // lote/serie declarado por el proveedor (opcional)
  expiry: string | null; // vencimiento del lote (ISO) — habilita FEFO
}

/**
 * Orden de recepción / manifiesto de bodega. Un ingreso de mercadería (una entrega
 * de un proveedor) con su propio ID, que puede contener varios SKUs. Se crea con las
 * cantidades ESPERADAS (sin stock). El equipo de operaciones cotejo el físico contra
 * lo teórico por SKU; al confirmar cada cotejo, el stock recibido entra a la ubicación
 * de recepción (movimientos RECEIPT). Puede recibirse en varios eventos hasta
 * completar o cerrarse como parcial.
 */
export interface ReceiptOrder {
  id: string; // legible: OR-YYYYMMDD-XXXX (se muestra al proveedor)
  sellerId: string;
  supplier: string | null; // proveedor / origen de la mercadería
  reference: string | null; // documento del proveedor (guía de despacho / factura / OC)
  locationId: string; // ubicación de recepción donde aterriza la carga
  notes: string | null; // observaciones (daños, faltantes, etc.)
  status: ReceiptOrderStatus;
  lines: ReceiptLine[];
  createdAt: string;
  createdBy: string; // usuario que registró la recepción
  events: OrderEvent[]; // auditoría append-only (CREADA | RECEPCIÓN | CERRADA | ANULADA)
}
