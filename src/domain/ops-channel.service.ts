/**
 * OpsChannelService — Canal de voz/mensaje operador ↔ administrador de la operación.
 *
 * El operador (en el piso de bodega) deja un mensaje de VOZ o de texto; el admin lo
 * escucha/lee y responde. Cada mensaje se interpreta con un agente (OpsAiAnalyst):
 *   - transcribe el audio (si hay IA real conectada),
 *   - clasifica el tópico (stock, ubicaciones, incidencia, …),
 * y el admin obtiene estadísticas de tópicos + insights de mejora del historial.
 *
 * El agente es enchufable: sin clave de IA usa la heurística (reglas por palabras clave);
 * con clave usa el LLM real. El servicio siempre tiene la heurística como red de seguridad.
 */
import { ValidationError } from './errors';
import { Clock, IdGenerator, OpsAiAnalyst, OpsChannelRepository } from './ports';
import {
  OpsAudioBlob,
  OpsCategory,
  OpsInsights,
  OpsMessage,
  OpsThreadRead,
  OPS_CATEGORIES,
  OPS_CATEGORY_LABEL,
} from './types';

export interface SendOpsMessageInput {
  threadUserId: string; // el operador dueño del hilo
  senderId: string;
  senderName: string;
  senderRole: string;
  kind: 'voice' | 'text';
  text?: string | null; // texto (si kind=text) o nota escrita
  note?: string | null; // nota corta opcional que acompaña al audio
  audioBase64?: string | null; // audio en base64 (si kind=voice)
  audioMime?: string | null;
  durationSec?: number | null;
}

// -------------------- Heurística por palabras clave --------------------------
// Diccionario tópico -> términos. Se normaliza (sin acentos) y se cuenta por coincidencias.
const KEYWORDS: Record<OpsCategory, string[]> = {
  stock: ['stock', 'inventario', 'falta', 'faltan', 'faltante', 'sobra', 'sobrante', 'diferencia', 'cuadratura', 'unidades', 'quiebre', 'agotado', 'sin stock'],
  ubicaciones: ['ubicacion', 'ubicaciones', 'donde esta', 'pasillo', 'estante', 'rack', 'posicion', 'senaletica', 'layout', 'no encuentro', 'localizar'],
  recepcion: ['recepcion', 'recibir', 'recibimos', 'proveedor', 'llego', 'llegada', 'cotejo', 'guia', 'ingreso', 'descarga', 'contenedor'],
  picking: ['picking', 'pickear', 'preparar', 'preparacion', 'pedido', 'orden', 'recolectar', 'ola', 'cola'],
  despacho: ['despacho', 'despachar', 'salida', 'courier', 'transportista', 'etiqueta', 'bulto', 'envio', 'ruta', 'retiro'],
  incidencia: ['problema', 'error', 'incidencia', 'roto', 'danado', 'dano', 'mal', 'falla', 'reclamo', 'urgente', 'quebrado', 'perdido', 'accidente'],
  proceso: ['como', 'duda', 'consulta', 'no se', 'procedimiento', 'proceso', 'ayuda', 'explicar', 'capacitacion'],
  equipos: ['scanner', 'pistola', 'impresora', 'sistema', 'equipo', 'wifi', 'internet', 'computador', 'pda', 'lector', 'bateria', 'app'],
  personal: ['turno', 'personal', 'ausente', 'permiso', 'colacion', 'reemplazo', 'horario', 'gente', 'faltó', 'llegue tarde', 'atraso'],
  otro: [],
};

function norm(s: string): string {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** \u00bfEl texto (ya normalizado) contiene la palabra/frase clave como token completo? */
function hasKeyword(normalizedText: string, kw: string): boolean {
  return new RegExp(`\\b${escapeRe(kw)}\\b`).test(normalizedText);
}

/** Clasificación heurística: cuenta coincidencias por tópico y elige el de mayor puntaje. */
export function classifyHeuristic(text: string): { category: OpsCategory; confidence: number; source: 'heuristic' } {
  const n = norm(text);
  if (!n.trim()) return { category: 'otro', confidence: 0, source: 'heuristic' };
  let best: OpsCategory = 'otro';
  let bestScore = 0;
  for (const cat of OPS_CATEGORIES) {
    if (cat === 'otro') continue;
    let score = 0;
    for (const kw of KEYWORDS[cat]) if (hasKeyword(n, kw)) score += 1;
    if (score > bestScore) { bestScore = score; best = cat; }
  }
  const confidence = bestScore === 0 ? 0 : Math.min(1, 0.4 + 0.2 * bestScore);
  return { category: best, confidence, source: 'heuristic' };
}

/** Insights heurísticos: top tópicos + sugerencias plantilladas según la distribución. */
export function insightsHeuristic(counts: Record<string, number>, total: number): OpsInsights {
  const entries = OPS_CATEGORIES
    .map((c) => ({ category: c, label: OPS_CATEGORY_LABEL[c], count: counts[c] || 0 }))
    .filter((e) => e.count > 0)
    .sort((a, b) => b.count - a.count);
  const topTopics = entries.slice(0, 5).map((e) => ({ ...e, pct: total ? Math.round((e.count / total) * 100) : 0 }));
  const pctOf = (c: OpsCategory) => (total ? (counts[c] || 0) / total : 0);

  const suggestions: string[] = [];
  const SUG: Partial<Record<OpsCategory, string>> = {
    incidencia: 'Alta proporción de incidencias: revisa causas raíz recurrentes y define un protocolo de respuesta rápida.',
    ubicaciones: 'Muchas consultas de ubicaciones: refuerza la señalética y revisa el layout/slotting de los SKUs más buscados.',
    stock: 'Frecuentes temas de stock/diferencias: agenda conteos cíclicos más seguidos en las zonas afectadas.',
    equipos: 'Reportes de equipos/sistema: revisa el mantenimiento de scanners/impresoras y la conectividad en el piso.',
    proceso: 'Varias dudas de proceso: puede faltar capacitación o documentación clara de los procedimientos.',
    picking: 'Carga de temas de picking: evalúa la secuencia de preparación y la cola de trabajo del turno.',
    despacho: 'Temas de despacho: revisa cortes de courier y la generación de etiquetas para evitar cuellos de botella.',
    recepcion: 'Temas de recepción: coordina ventanas de proveedores y agiliza el cotejo en el ingreso.',
    personal: 'Temas de personal/turnos: revisa la cobertura de turnos y los reemplazos.',
  };
  for (const e of topTopics) {
    if (pctOf(e.category) >= 0.15 && SUG[e.category]) suggestions.push(SUG[e.category] as string);
  }
  if (!suggestions.length && total > 0) suggestions.push('El canal se usa de forma variada; sigue monitoreando para detectar tópicos recurrentes.');

  const top = topTopics[0];
  const summary = total === 0
    ? 'Aún no hay mensajes en el canal para analizar.'
    : `Se analizaron ${total} mensaje(s). El tópico más frecuente es "${top ? top.label : 'Otro'}" (${top ? top.pct : 0}%).`;

  return { summary, topTopics, suggestions, generatedBy: 'heuristic', totalMessages: total };
}

export class OpsChannelService {
  constructor(
    private readonly repo: OpsChannelRepository,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly analyst?: OpsAiAnalyst, // real (LLM) opcional; si falla, heurística
  ) {}

  async send(operationId: string, input: SendOpsMessageInput): Promise<OpsMessage> {
    if (input.kind !== 'voice' && input.kind !== 'text') throw new ValidationError('Tipo de mensaje inválido');
    if (input.kind === 'text' && !(input.text && input.text.trim())) throw new ValidationError('El mensaje de texto está vacío');
    if (input.kind === 'voice' && !input.audioBase64) throw new ValidationError('Falta el audio del mensaje de voz');

    const now = this.clock.now();
    let audioId: string | null = null;
    if (input.kind === 'voice' && input.audioBase64) {
      audioId = this.ids.next();
      const blob: OpsAudioBlob = { id: audioId, operationId, mime: input.audioMime || 'audio/webm', dataBase64: input.audioBase64 };
      await this.repo.saveAudio(blob);
    }

    // Texto para analizar: texto directo, o transcripción del audio, o la nota.
    let text = (input.text || '').trim() || null;
    if (input.kind === 'voice' && !text && this.analyst && input.audioBase64) {
      try {
        const tr = await this.analyst.transcribe(input.audioBase64, input.audioMime || 'audio/webm');
        if (tr && tr.trim()) text = tr.trim();
      } catch { /* cae a nota/heurística */ }
    }
    const note = (input.note || '').trim() || null;
    const analyzable = text || note || '';

    // Clasificación: IA real si está disponible, si no heurística.
    let category: OpsCategory | null = null;
    let categoryConfidence: number | null = null;
    let categorySource: 'ai' | 'heuristic' | null = null;
    if (analyzable) {
      let res: { category: OpsCategory; confidence: number; source: 'ai' | 'heuristic' } | null = null;
      if (this.analyst) {
        try { res = await this.analyst.classify(analyzable); } catch { res = null; }
      }
      if (!res) res = classifyHeuristic(analyzable);
      category = res.category; categoryConfidence = res.confidence; categorySource = res.source;
    }

    const message: OpsMessage = {
      id: this.ids.next(),
      operationId,
      threadUserId: input.threadUserId,
      senderId: input.senderId,
      senderName: input.senderName,
      senderRole: input.senderRole,
      kind: input.kind,
      text,
      note,
      audioId,
      audioMime: input.kind === 'voice' ? input.audioMime || 'audio/webm' : null,
      durationSec: input.durationSec ?? null,
      category,
      categoryConfidence,
      categorySource,
      at: now,
    };
    await this.repo.saveMessage(message);
    return message;
  }

  listMessages(operationId: string, filter?: { threadUserId?: string }): Promise<OpsMessage[]> {
    return this.repo.listMessages(operationId, filter);
  }

  getAudio(operationId: string, audioId: string): Promise<OpsAudioBlob | null> {
    return this.repo.getAudio(operationId, audioId);
  }

  /** Marca el hilo como leído por un lado (para el "visto"). Usa el reloj si no se pasa fecha. */
  markRead(operationId: string, threadUserId: string, side: 'ADMIN' | 'OPERATOR', at?: string): Promise<void> {
    return this.repo.markRead(operationId, threadUserId, side, at || this.clock.now());
  }
  /** Estado de lectura del hilo (hasta cuándo leyó cada lado). */
  getRead(operationId: string, threadUserId: string): Promise<OpsThreadRead | null> {
    return this.repo.getRead(operationId, threadUserId);
  }

  /** Estadísticas del canal: conteo por categoría, por operador, y volumen. */
  async stats(operationId: string): Promise<{
    total: number;
    voice: number;
    text: number;
    byCategory: { category: OpsCategory; label: string; count: number; pct: number }[];
    byOperator: { userId: string; name: string; count: number }[];
  }> {
    const msgs = await this.repo.listMessages(operationId);
    const total = msgs.length;
    const counts: Record<string, number> = {};
    const ops = new Map<string, { name: string; count: number }>();
    let voice = 0;
    for (const m of msgs) {
      const c = m.category || 'otro';
      counts[c] = (counts[c] || 0) + 1;
      if (m.kind === 'voice') voice += 1;
      if (m.senderRole !== 'ADMIN' && m.senderRole !== 'PLATFORM_ADMIN') {
        const cur = ops.get(m.senderId) || { name: m.senderName, count: 0 };
        cur.count += 1; ops.set(m.senderId, cur);
      }
    }
    const byCategory = OPS_CATEGORIES
      .map((c) => ({ category: c, label: OPS_CATEGORY_LABEL[c], count: counts[c] || 0 }))
      .filter((e) => e.count > 0)
      .sort((a, b) => b.count - a.count)
      .map((e) => ({ ...e, pct: total ? Math.round((e.count / total) * 100) : 0 }));
    const byOperator = [...ops.entries()].map(([userId, v]) => ({ userId, name: v.name, count: v.count })).sort((a, b) => b.count - a.count);
    return { total, voice, text: total - voice, byCategory, byOperator };
  }

  /** Insights de mejora sobre el historial. IA real si hay; si no, heurística. */
  async insights(operationId: string): Promise<OpsInsights> {
    const msgs = await this.repo.listMessages(operationId);
    const counts: Record<string, number> = {};
    for (const m of msgs) { const c = m.category || 'otro'; counts[c] = (counts[c] || 0) + 1; }
    const total = msgs.length;
    if (this.analyst) {
      try {
        const ai = await this.analyst.insights({
          messages: msgs.filter((m) => (m.text || m.note)).map((m) => ({ text: (m.text || m.note) as string, category: (m.category || 'otro') as OpsCategory })),
          counts,
          total,
        });
        if (ai) return ai;
      } catch { /* cae a heurística */ }
    }
    return insightsHeuristic(counts, total);
  }
}
