/**
 * Copiloto del WMS — Fase 1: "Pregúntale a tu WMS" + insights proactivos.
 *
 * Este módulo contiene la lógica PURA y determinista del copiloto:
 *   - parseCopilotIntent(): clasifica la pregunta del usuario en una intención
 *     (stock bajo, órdenes pendientes, despachos, stock de un SKU, cola de picking,
 *      facturación del mes) usando palabras clave en español. Sin dependencias.
 *   - buildInsights(): a partir de una "foto" de datos ya consultados, arma las
 *     alertas proactivas con su acción sugerida.
 *
 * El facade (que sí tiene acceso a los servicios/repos) usa estas funciones para
 * responder con DATOS REALES. Todo es grounded: el copiloto nunca inventa cifras.
 * Diseñado como motor enchufable: hoy heurístico/determinista (sin costo, seguro
 * para demos); un LLM real se puede conectar por configuración más adelante.
 */

export type CopilotIntent =
  | 'low_stock'      // ¿qué está por quebrar?
  | 'open_orders'    // órdenes pendientes / sin despachar
  | 'shipped'        // despachos (hoy/semana/mes)
  | 'sku_stock'      // stock y ubicación de un SKU puntual
  | 'pending_pick'   // cola de preparación
  | 'billing_month'  // facturación / consumo del mes
  | 'expiring'       // lotes por vencer (FEFO)
  | 'packaging_low'  // insumos de embalaje por agotarse
  | 'anomalies'      // anomalías de consumo por cliente
  | 'help';          // no reconocida → sugerencias

export type CopilotWindow = 'today' | 'week' | 'month';

export interface CopilotIntentResult {
  intent: CopilotIntent;
  window: CopilotWindow;
  skuGuess: string | null; // candidato de código SKU detectado en el texto
}

export interface CopilotInsight {
  id: string;
  severity: 'info' | 'warn' | 'crit';
  icon: string;
  title: string;
  detail: string;
  action: string;      // próxima acción sugerida
  link?: string | null; // data-pg de la sección a abrir
  count?: number;
}

export interface CopilotAnswerItem { label: string; value?: string; }
export interface CopilotAnswer {
  intent: CopilotIntent;
  answer: string;                 // respuesta en lenguaje natural (grounded)
  items?: CopilotAnswerItem[];    // detalle tabular opcional
  link?: string | null;           // sección sugerida (data-pg)
  suggestions?: string[];         // preguntas sugeridas (para 'help')
  toolsUsed?: string[];           // herramientas que el LLM consultó (transparencia)
  pendingAction?: CopilotPendingAction; // (compat) primera acción propuesta pendiente de confirmación
  pendingActions?: CopilotPendingAction[]; // TODAS las acciones propuestas en el turno, en orden
}

/** Acción de escritura propuesta por el copiloto, pendiente de confirmación del usuario. */
export interface CopilotPendingAction { orden: string; orderId: string; sellerId: string; accion: string; from: string; to: string; }

/** Preguntas de ejemplo que se muestran como chips en la UI. */
export const COPILOT_SUGGESTIONS: string[] = [
  '¿Qué SKUs están por quebrar stock?',
  '¿Cuántas órdenes tengo pendientes?',
  '¿Qué se despachó hoy?',
  '¿Qué hay en la cola de preparación?',
  '¿Cuánto llevo facturado este mes?',
];

function norm(s: string): string {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Detecta la ventana temporal mencionada (por defecto: hoy). */
function detectWindow(n: string): CopilotWindow {
  if (/\bmes\b|mensual|este mes|del mes/.test(n)) return 'month';
  if (/semana|7 dias|ultimos 7|ultima semana/.test(n)) return 'week';
  return 'today';
}

/**
 * Candidato a código SKU: un token "tipo código" (mayúsculas/números/guiones) del
 * texto ORIGINAL. El facade lo valida contra el catálogo real antes de usarlo.
 */
function detectSkuGuess(raw: string): string | null {
  const tokens = String(raw || '').split(/\s+/);
  for (const t of tokens) {
    const clean = t.replace(/[¿?¡!.,;:()"']/g, '');
    // Con guion o dígitos, y al menos 3 caracteres → parece código (SKU-123, EAN, ABC12).
    if (clean.length >= 3 && /[0-9-]/.test(clean) && /^[A-Za-z0-9-]+$/.test(clean)) return clean.toUpperCase();
  }
  return null;
}

/** Clasifica la pregunta en una intención + ventana + posible SKU. */
export function parseCopilotIntent(text: string): CopilotIntentResult {
  const n = norm(text);
  const window = detectWindow(n);
  const skuGuess = detectSkuGuess(text);

  const has = (re: RegExp) => re.test(n);

  // Stock de un SKU puntual (si hay candidato y se pregunta por stock/ubicación).
  if (skuGuess && has(/stock|hay|queda|quedan|cuanto|cuant|donde|ubicac|encuentro|localiz/)) {
    return { intent: 'sku_stock', window, skuGuess };
  }
  // Embalaje y vencimientos se evalúan ANTES que "stock bajo" porque comparten
  // términos ("agotar", "por vencer") y deben ganar cuando el usuario los nombra.
  if (has(/embalaje|insumo|insumos|cinta|film|material de embalaje/)) {
    return { intent: 'packaging_low', window, skuGuess };
  }
  if (has(/vence|vencer|vencimiento|caduc|fefo|por vencer|expira|expiran/)) {
    return { intent: 'expiring', window, skuGuess };
  }
  if (has(/anomal|inusual|raro|fuera de lo normal|alerta de consumo|variacion|cambio de consumo/)) {
    return { intent: 'anomalies', window, skuGuess };
  }
  if (has(/quebrar|quiebre|por acabar|acabando|bajo stock|poco stock|falta stock|reponer|repone|reposicion|reabastec|agotad|sin stock|criticos|por agotar|comprar mas/)) {
    return { intent: 'low_stock', window, skuGuess };
  }
  if (has(/cola|preparacion|preparar|pickear|picking|por preparar/)) {
    return { intent: 'pending_pick', window, skuGuess };
  }
  if (has(/despach|enviad|envie|salio|salieron|shipped|entregad/)) {
    return { intent: 'shipped', window, skuGuess };
  }
  if (has(/pendiente|pendientes|abiertas|sin despachar|por despachar|en proceso|atrasad|retras/)) {
    return { intent: 'open_orders', window, skuGuess };
  }
  if (has(/factur|cobr|consumo|ingreso|cuanto llevo|cuanto gane|facturacion/)) {
    return { intent: 'billing_month', window, skuGuess };
  }
  if (skuGuess) return { intent: 'sku_stock', window, skuGuess };
  return { intent: 'help', window, skuGuess: null };
}

// -------------------- Insights proactivos ------------------------------------
/** Foto de datos (ya consultada por el facade) para armar los insights. */
/** Ítem de reabastecimiento basado en demanda (cobertura). */
export interface ReplenishItem {
  sku: string;
  name: string;      // descripción/nombre legible
  onHand: number;    // saldo actual
  demand: number;    // unidades demandadas en la ventana de referencia
  windowDays: number; // ventana de referencia (14 o 30)
  coverageDays: number; // días que cubre el saldo al ritmo de la demanda
  reorder: number;   // sugerido a reponer para cubrir una ventana
}

export interface InsightSnapshot {
  lowStock: ReplenishItem[]; // SKUs a reabastecer según demanda (30d)
  agingOrders: { id: string; ref: string; days: number; status: string }[]; // órdenes abiertas antiguas
  pendingPick: number;   // órdenes en ALLOCATED/PICKING
  toAllocate: number;    // órdenes RECEIVED sin reservar
  shippedToday: number;  // despachos de hoy
  expiringLots?: { sku: string; lot: string; days: number; qty: number }[]; // lotes por vencer (o vencidos)
  packagingLow?: ReplenishItem[]; // insumos de embalaje a reabastecer según consumo (14d)
  anomalies?: { sellerName: string; metric: string; changePct: number; from: number; to: number }[]; // anomalías de consumo
}

const AGING_DAYS = 2;            // días: orden abierta más antigua que esto = en riesgo

/** Arma las alertas proactivas + su acción sugerida a partir de la foto de datos. */
export function buildInsights(s: InsightSnapshot): CopilotInsight[] {
  const out: CopilotInsight[] = [];

  if (s.lowStock.length) {
    const top = s.lowStock.slice(0, 5).map((x) => `${x.sku} (quedan ${x.onHand}, ~${x.coverageDays}d)`).join(', ');
    out.push({
      id: 'low_stock',
      severity: s.lowStock.some((x) => x.onHand <= 0) ? 'crit' : 'warn',
      icon: '📉',
      title: `${s.lowStock.length} SKU(s) requieren reabastecimiento`,
      detail: `Según la demanda de los últimos 30 días, el saldo no cubre el próximo mes: ${top}${s.lowStock.length > 5 ? '…' : ''}.`,
      action: 'Coordina reposición con el cliente; para cubrir el mes conviene reponer ~' + s.lowStock.slice(0, 5).reduce((a, x) => a + x.reorder, 0) + ' un en los SKUs críticos.',
      link: 'inventory',
      count: s.lowStock.length,
    });
  }

  if (s.agingOrders.length) {
    const top = s.agingOrders.slice(0, 5).map((o) => `${o.ref} (${o.days}d)`).join(', ');
    out.push({
      id: 'aging_orders',
      severity: 'crit',
      icon: '⏰',
      title: `${s.agingOrders.length} orden(es) en riesgo por antigüedad`,
      detail: `Abiertas hace más de ${AGING_DAYS} días: ${top}${s.agingOrders.length > 5 ? '…' : ''}.`,
      action: 'Prioriza su preparación en la cola o revisa si están bloqueadas por stock.',
      link: 'orders',
      count: s.agingOrders.length,
    });
  }

  if (s.toAllocate > 0) {
    out.push({
      id: 'to_allocate',
      severity: 'warn',
      icon: '📥',
      title: `${s.toAllocate} orden(es) ingresadas sin reservar`,
      detail: 'Órdenes recibidas que aún no reservan stock para preparación.',
      action: 'Reserva su stock (o usa la reserva masiva) para que entren a la cola.',
      link: 'orders',
      count: s.toAllocate,
    });
  }

  const expiring = s.expiringLots || [];
  if (expiring.length) {
    const expired = expiring.filter((l) => l.days < 0).length;
    const top = expiring.slice(0, 5).map((l) => `${l.sku}·${l.lot} (${l.days < 0 ? 'vencido' : l.days + 'd'}, ${l.qty}u)`).join(', ');
    out.push({
      id: 'expiring',
      severity: expired > 0 ? 'crit' : 'warn',
      icon: '⏳',
      title: `${expiring.length} lote(s) por vencer${expired ? ` (${expired} ya vencido/s)` : ''}`,
      detail: `Próximos a caducar (FEFO): ${top}${expiring.length > 5 ? '…' : ''}.`,
      action: 'Prioriza su salida (FEFO), sepáralos o coordina retiro/baja con el cliente.',
      link: 'inventory',
      count: expiring.length,
    });
  }

  const packLow = s.packagingLow || [];
  if (packLow.length) {
    const top = packLow.slice(0, 5).map((p) => `${p.sku} (quedan ${p.onHand}, ~${p.coverageDays}d)`).join(', ');
    out.push({
      id: 'packaging_low',
      severity: packLow.some((p) => p.onHand <= 0) ? 'crit' : 'warn',
      icon: '📦',
      title: `${packLow.length} insumo(s) de embalaje requieren reabastecimiento`,
      detail: `Según el consumo de los últimos 14 días, el saldo no cubre las próximas 2 semanas: ${top}${packLow.length > 5 ? '…' : ''}.`,
      action: 'Repón antes de que frene el packing; sugerido ~' + packLow.slice(0, 5).reduce((a, p) => a + p.reorder, 0) + ' un para 14 días. Registra el ingreso en Embalajes.',
      link: 'packaging',
      count: packLow.length,
    });
  }

  const anomalies = s.anomalies || [];
  if (anomalies.length) {
    const top = anomalies.slice(0, 4).map((a) => `${a.sellerName} ${a.changePct > 0 ? '▲+' : '▼'}${Math.abs(a.changePct)}%`).join(', ');
    out.push({
      id: 'anomalies',
      severity: 'warn',
      icon: '📈',
      title: `${anomalies.length} anomalía(s) de consumo por cliente`,
      detail: `Cambio fuerte de despachos vs. semana previa: ${top}${anomalies.length > 4 ? '…' : ''}.`,
      action: 'Revisa con el cliente: ¿campaña, quiebre o error? Ajusta capacidad y tarifa si aplica.',
      link: 'reports',
      count: anomalies.length,
    });
  }

  if (s.pendingPick > 0) {
    out.push({
      id: 'pending_pick',
      severity: 'info',
      icon: '▶',
      title: `${s.pendingPick} orden(es) en cola de preparación`,
      detail: 'Listas para pickear según prioridad de courier y FIFO.',
      action: 'Abre la cola y avanza en el orden sugerido.',
      link: 'pickqueue',
      count: s.pendingPick,
    });
  }

  if (!out.length) {
    out.push({
      id: 'all_clear',
      severity: 'info',
      icon: '✅',
      title: 'Todo al día',
      detail: `No hay SKUs por quebrar ni órdenes en riesgo. ${s.shippedToday} despacho(s) hoy.`,
      action: 'Buen momento para conteos cíclicos o revisar tarifas.',
      link: 'dashboard',
    });
  }

  return out;
}
