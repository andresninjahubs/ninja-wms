/**
 * Catálogo de planes del SaaS (PLG · Fase 1) y motor de entitlements.
 *
 * Cada plan define LÍMITES (cuánto) y FEATURES (qué). Un límite en `null` es
 * ilimitado. El plan efectivo de una operación considera un reverse-trial:
 * las cuentas nuevas parten en Free pero con un trial de Growth por 14 días.
 *
 * Las operaciones creadas por el super-admin o sembradas (sin planId) se tratan
 * como 'internal' — sin límites y con todos los features —, de modo que el
 * enforcement solo afecta a las cuentas self-serve con un plan explícito.
 */

export type PlanId = 'free' | 'growth' | 'scale' | 'enterprise' | 'internal';

/** Recursos medibles con tope por plan (null = ilimitado). */
export interface PlanLimits {
  ordersPerMonth: number | null; // métrica de valor principal
  sellers: number | null;
  users: number | null;
  warehouses: number | null; // ubicaciones (bodegas/zonas) creadas
}

/**
 * Features conmutables por plan. Modelo GRANULAR por módulo: el núcleo operativo
 * (`wms_core`) agrupa los flujos base inseparables — inbound (recepción), outbound
 * (picking/empaque/despacho), inventario, ubicaciones, movimientos, órdenes y productos —
 * y todo lo demás es un módulo add-on que se activa/desactiva por separado, sin
 * dependencias entre sí (cada toggle es independiente).
 */
export type PlanFeature =
  // Núcleo operativo (siempre incluido; NO se puede desasociar)
  | 'wms_core'
  // Operaciones (add-ons)
  | 'returns'
  | 'kitting'
  | 'cycle_count'
  | 'packaging_materials'
  | 'lot_serial'
  | 'task_assignment'
  | 'reslotting'
  // Negocio / analítica
  | 'billing_3pl'
  | 'cost_profitability'
  | 'advanced_analytics'
  // Inteligencia artificial
  | 'ai_copilot'
  | 'ai_voice'
  // Plataforma / integración
  | 'webhooks'
  | 'api'
  | 'white_label'
  | 'multi_courier'
  | 'client_chat'
  | 'voice_channel'
  | 'announcements';

/** Tarifa mensual por moneda (null = a medida / no aplica; 0 = gratis). */
export interface PlanPrices {
  usd: number | null;
  clp: number | null;
}

export interface PlanDef {
  id: PlanId;
  name: string;
  prices: PlanPrices;
  blurb: string;
  limits: PlanLimits;
  features: PlanFeature[];
  /** Se oculta del comparador público (planes internos). */
  hidden?: boolean;
}

const ALL_FEATURES: PlanFeature[] = [
  'wms_core',
  'returns', 'kitting', 'cycle_count', 'packaging_materials', 'lot_serial', 'task_assignment', 'reslotting',
  'billing_3pl', 'cost_profitability', 'advanced_analytics',
  'ai_copilot', 'ai_voice',
  'webhooks', 'api', 'white_label', 'multi_courier', 'client_chat', 'voice_channel', 'announcements',
];

/** El módulo núcleo va SIEMPRE incluido en todos los planes (no se puede desasociar). */
export const CORE_FEATURE: PlanFeature = 'wms_core';

/**
 * Módulos conmutables por plan que muestra la matriz del mantenedor (fila por módulo).
 * `group` los agrupa en la UI. El núcleo (`wms_core`) NO aparece: va siempre incluido.
 */
export const MODULE_CATALOG: Array<{ key: PlanFeature; label: string; description: string; group: string }> = [
  // Operaciones
  { key: 'returns', label: 'Devoluciones', description: 'Logística reversa: recepción, QA y disposición de devoluciones.', group: 'Operaciones' },
  { key: 'kitting', label: 'Armado de kits', description: 'Ensamblar kits/bundles desde sus componentes.', group: 'Operaciones' },
  { key: 'cycle_count', label: 'Conteo cíclico', description: 'Planificador de conteos y ajustes de inventario.', group: 'Operaciones' },
  { key: 'packaging_materials', label: 'Insumos de embalaje', description: 'Catálogo, consumo y cobro de materiales de empaque.', group: 'Operaciones' },
  { key: 'lot_serial', label: 'Lote / serie / vencimiento', description: 'Control por lote, número de serie y fecha de vencimiento.', group: 'Operaciones' },
  { key: 'task_assignment', label: 'Asignación de tareas', description: 'Balanceo de carga y asignación de trabajo a operarios (auto y manual).', group: 'Operaciones' },
  { key: 'reslotting', label: 'Re-slotting dinámico', description: 'Reubicación sugerida de SKUs de alta rotación (ABC/geometría).', group: 'Operaciones' },
  // Negocio / analítica
  { key: 'billing_3pl', label: 'Facturación 3PL', description: 'Tarifarios y facturas del operador a sus clientes.', group: 'Negocio' },
  { key: 'cost_profitability', label: 'Costos y rentabilidad', description: 'Costeo por actividad, margen por cliente y eficiencia estándar vs. real.', group: 'Negocio' },
  { key: 'advanced_analytics', label: 'Analítica avanzada', description: 'Rollups diarios, demanda/forecast y KPIs históricos.', group: 'Negocio' },
  // Inteligencia artificial
  { key: 'ai_copilot', label: 'Copiloto IA', description: 'Conectar un LLM y usar el copiloto con acciones.', group: 'Inteligencia artificial' },
  { key: 'ai_voice', label: 'Copiloto de voz', description: 'Conversación por voz manos libres para consultar y operar.', group: 'Inteligencia artificial' },
  // Plataforma / integración
  { key: 'webhooks', label: 'Webhooks', description: 'Suscripciones por evento hacia sistemas externos.', group: 'Plataforma' },
  { key: 'api', label: 'API', description: 'Acceso programático para integraciones propias.', group: 'Plataforma' },
  { key: 'white_label', label: 'Marca propia (white-label)', description: 'Logo, colores y nombre personalizados.', group: 'Plataforma' },
  { key: 'multi_courier', label: 'Multi-courier', description: 'Orquestación de múltiples couriers.', group: 'Plataforma' },
  { key: 'client_chat', label: 'Mensajería con clientes', description: 'Chat interno entre el operador y sus clientes.', group: 'Plataforma' },
  { key: 'voice_channel', label: 'Canal de voz operativo', description: 'Mensajes de voz operador ↔ administración.', group: 'Plataforma' },
  { key: 'announcements', label: 'Anuncios', description: 'Barra de anuncios y tracking de clics.', group: 'Plataforma' },
];

/** Límites numéricos que muestra la matriz (fila por límite; vacío = ilimitado). */
export const LIMIT_KEYS: Array<{ key: keyof PlanLimits; label: string }> = [
  { key: 'ordersPerMonth', label: 'Órdenes por mes' },
  { key: 'sellers', label: 'Clientes (sellers)' },
  { key: 'users', label: 'Usuarios' },
  { key: 'warehouses', label: 'Ubicaciones' },
];

/**
 * Config editable de un plan (lo que el super-admin puede cambiar en la matriz).
 * Persistida; si no hay override, rige el valor por defecto del catálogo.
 */
export interface PlanConfig {
  planId: PlanId;
  name: string;
  prices: PlanPrices;
  blurb: string;
  limits: PlanLimits;
  features: PlanFeature[];
}

/** Fusiona overrides persistidos sobre los defaults del catálogo. Núcleo siempre presente. */
export function mergeCatalog(overrides: PlanConfig[]): Record<PlanId, PlanDef> {
  const out: Record<PlanId, PlanDef> = JSON.parse(JSON.stringify(PLAN_CATALOG));
  for (const o of overrides || []) {
    const base = out[o.planId];
    if (!base) continue;
    out[o.planId] = {
      ...base,
      name: o.name ?? base.name,
      prices: o.prices ?? base.prices,
      blurb: o.blurb ?? base.blurb,
      limits: o.limits ?? base.limits,
      features: Array.from(new Set([CORE_FEATURE, ...(o.features || base.features)])),
    };
  }
  return out;
}

/** La config por defecto de un plan (para sembrar/restaurar). */
export function defaultPlanConfig(id: PlanId): PlanConfig {
  const d = PLAN_CATALOG[id];
  return { planId: id, name: d.name, prices: { ...d.prices }, blurb: d.blurb, limits: { ...d.limits }, features: [...d.features] };
}

export const PLAN_CATALOG: Record<PlanId, PlanDef> = {
  free: {
    id: 'free', name: 'Free', prices: { usd: 0, clp: 0 }, blurb: 'Para partir y activar. Sin tarjeta.',
    limits: { ordersPerMonth: 50, sellers: 1, users: 2, warehouses: 1 },
    features: ['wms_core'],
  },
  growth: {
    id: 'growth', name: 'Growth', prices: { usd: 59, clp: 49990 }, blurb: 'El plan donde convierte la prueba.',
    limits: { ordersPerMonth: 1500, sellers: 3, users: 10, warehouses: 3 },
    features: ['wms_core', 'returns', 'cycle_count', 'packaging_materials', 'kitting', 'ai_copilot', 'white_label', 'api', 'client_chat', 'announcements'],
  },
  scale: {
    id: 'scale', name: 'Scale', prices: { usd: 199, clp: 179990 }, blurb: 'Operadores 3PL y marcas de alto volumen.',
    limits: { ordersPerMonth: 10000, sellers: null, users: null, warehouses: null },
    features: ['wms_core', 'returns', 'kitting', 'cycle_count', 'packaging_materials', 'lot_serial', 'task_assignment', 'reslotting', 'billing_3pl', 'cost_profitability', 'advanced_analytics', 'ai_copilot', 'ai_voice', 'webhooks', 'api', 'white_label', 'multi_courier', 'client_chat', 'voice_channel', 'announcements'],
  },
  enterprise: {
    id: 'enterprise', name: 'Enterprise', prices: { usd: null, clp: null }, blurb: 'Volumen a medida, SSO, SLA y soporte dedicado.',
    limits: { ordersPerMonth: null, sellers: null, users: null, warehouses: null },
    features: ALL_FEATURES,
  },
  internal: {
    id: 'internal', name: 'Interno', prices: { usd: null, clp: null }, blurb: 'Cuenta de plataforma / demo, sin límites.',
    limits: { ordersPerMonth: null, sellers: null, users: null, warehouses: null },
    features: ALL_FEATURES,
    hidden: true,
  },
};

/** Planes que se muestran en el comparador público (para poblar el pricing). */
export const PUBLIC_PLANS: PlanDef[] = ['free', 'growth', 'scale', 'enterprise'].map((id) => PLAN_CATALOG[id as PlanId]);

export function planDef(id: string | null | undefined): PlanDef {
  return PLAN_CATALOG[(id as PlanId) in PLAN_CATALOG ? (id as PlanId) : 'internal'];
}

/** Estado del trial de una operación en un instante dado. */
export interface TrialState { active: boolean; plan: PlanId | null; endsAt: string | null; daysLeft: number; }

export function trialStateOf(op: { trialPlan?: string | null; trialEndsAt?: string | null }, nowMs: number): TrialState {
  const endsAt = op.trialEndsAt || null;
  const plan = (op.trialPlan as PlanId) || null;
  if (!endsAt || !plan) return { active: false, plan: null, endsAt: null, daysLeft: 0 };
  const end = Date.parse(endsAt);
  const active = !Number.isNaN(end) && end > nowMs;
  const daysLeft = active ? Math.ceil((end - nowMs) / 86400000) : 0;
  return { active, plan, endsAt, daysLeft };
}

/**
 * Plan EFECTIVO de una operación: el del trial mientras esté vigente; si no, el base.
 * Sin planId (super-admin / semilla) => 'internal'.
 */
export function effectivePlanId(op: { planId?: string | null; trialPlan?: string | null; trialEndsAt?: string | null }, nowMs: number): PlanId {
  const trial = trialStateOf(op, nowMs);
  if (trial.active && trial.plan) return trial.plan;
  const base = op.planId as PlanId;
  return base in PLAN_CATALOG ? base : 'internal';
}
