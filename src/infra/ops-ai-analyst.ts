/**
 * Adaptador de IA real (LLM) para el canal de voz — OPCIONAL y enchufable.
 *
 * Sin clave configurada, `selectOpsAiAnalyst()` devuelve undefined y el
 * OpsChannelService usa SIEMPRE la heurística (clasificación por palabras clave).
 * Al configurar una clave (OPS_AI_API_KEY), se conecta un LLM compatible con la
 * API de OpenAI (chat/completions + transcripción Whisper) para:
 *   - transcribir el audio de los mensajes de voz,
 *   - clasificar el tópico de cada mensaje,
 *   - generar insights de mejora sobre el historial.
 *
 * Todo es defensivo: cualquier fallo de red/parseo devuelve null y el servicio
 * cae a la heurística. Nunca lanza. No agrega dependencias: usa fetch nativo.
 */
import { OpsAiAnalyst } from '../domain/ports';
import { OpsCategory, OpsInsights, OPS_CATEGORIES, OPS_CATEGORY_LABEL } from '../domain/types';

interface OpsAiConfig {
  apiKey: string;
  baseUrl: string; // p.ej. https://api.openai.com/v1
  chatModel: string; // p.ej. gpt-4o-mini
  transcribeModel: string; // p.ej. whisper-1
}

function readConfig(): OpsAiConfig | null {
  const apiKey = process.env.OPS_AI_API_KEY || '';
  if (!apiKey.trim()) return null;
  return {
    apiKey,
    baseUrl: (process.env.OPS_AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    chatModel: process.env.OPS_AI_CHAT_MODEL || 'gpt-4o-mini',
    transcribeModel: process.env.OPS_AI_TRANSCRIBE_MODEL || 'whisper-1',
  };
}

const CATLIST = OPS_CATEGORIES.filter((c) => c !== 'otro').join(', ') + ', otro';

class LlmOpsAiAnalyst implements OpsAiAnalyst {
  constructor(private readonly cfg: OpsAiConfig) {}

  private async chat(system: string, user: string): Promise<string | null> {
    try {
      const res = await fetch(`${this.cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.cfg.apiKey}` },
        body: JSON.stringify({
          model: this.cfg.chatModel,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      const txt = data?.choices?.[0]?.message?.content;
      return typeof txt === 'string' ? txt : null;
    } catch {
      return null;
    }
  }

  async transcribe(audioBase64: string, mime: string): Promise<string | null> {
    try {
      const bytes = Buffer.from(audioBase64, 'base64');
      const ext = mime.includes('mp4') || mime.includes('m4a') ? 'm4a' : mime.includes('ogg') ? 'ogg' : mime.includes('wav') ? 'wav' : 'webm';
      const form = new FormData();
      form.append('file', new Blob([bytes], { type: mime || 'audio/webm' }), `audio.${ext}`);
      form.append('model', this.cfg.transcribeModel);
      const res = await fetch(`${this.cfg.baseUrl}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.cfg.apiKey}` },
        body: form as any,
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      const txt = data?.text;
      return typeof txt === 'string' && txt.trim() ? txt.trim() : null;
    } catch {
      return null;
    }
  }

  async classify(text: string): Promise<{ category: OpsCategory; confidence: number; source: 'ai' | 'heuristic' } | null> {
    const sys = `Eres un clasificador de mensajes operativos de una bodega (3PL/WMS). Clasifica el mensaje en UNA de estas categorías: ${CATLIST}. Responde SOLO con un JSON {"category":"<categoria>","confidence":<0..1>}. Sin texto adicional.`;
    const out = await this.chat(sys, text);
    if (!out) return null;
    try {
      const m = out.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const parsed = JSON.parse(m[0]);
      const cat = String(parsed.category || '').toLowerCase() as OpsCategory;
      if (!OPS_CATEGORIES.includes(cat)) return null;
      let conf = Number(parsed.confidence);
      if (!isFinite(conf)) conf = 0.7;
      conf = Math.max(0, Math.min(1, conf));
      return { category: cat, confidence: conf, source: 'ai' };
    } catch {
      return null;
    }
  }

  async insights(input: { messages: { text: string; category: OpsCategory }[]; counts: Record<string, number>; total: number }): Promise<OpsInsights | null> {
    if (!input.total) return null;
    const dist = OPS_CATEGORIES
      .map((c) => ({ c, n: input.counts[c] || 0 }))
      .filter((e) => e.n > 0)
      .sort((a, b) => b.n - a.n)
      .map((e) => `${OPS_CATEGORY_LABEL[e.c]}: ${e.n}`)
      .join('; ');
    const sample = input.messages.slice(-40).map((m) => `- [${OPS_CATEGORY_LABEL[m.category] || m.category}] ${m.text}`).join('\n');
    const sys = `Eres un consultor de operaciones de bodega. A partir del historial de mensajes operador→administrador y su distribución por tópico, entrega un resumen ejecutivo breve y 2-4 sugerencias accionables de mejora de la operación. Responde SOLO JSON: {"summary":"...","suggestions":["...","..."]}. En español.`;
    const user = `Total mensajes: ${input.total}\nDistribución: ${dist}\nMuestra de mensajes:\n${sample}`;
    const out = await this.chat(sys, user);
    if (!out) return null;
    try {
      const m = out.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const parsed = JSON.parse(m[0]);
      const summary = typeof parsed.summary === 'string' ? parsed.summary : '';
      const suggestions = Array.isArray(parsed.suggestions) ? parsed.suggestions.filter((s: any) => typeof s === 'string') : [];
      if (!summary && !suggestions.length) return null;
      const topTopics = OPS_CATEGORIES
        .map((c) => ({ category: c, label: OPS_CATEGORY_LABEL[c], count: input.counts[c] || 0 }))
        .filter((e) => e.count > 0)
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
        .map((e) => ({ ...e, pct: input.total ? Math.round((e.count / input.total) * 100) : 0 }));
      return { summary, topTopics, suggestions, generatedBy: 'ai', totalMessages: input.total };
    } catch {
      return null;
    }
  }
}

/** Devuelve un OpsAiAnalyst real si hay clave configurada; si no, undefined (→ heurística). */
export function selectOpsAiAnalyst(): OpsAiAnalyst | undefined {
  const cfg = readConfig();
  return cfg ? new LlmOpsAiAnalyst(cfg) : undefined;
}
