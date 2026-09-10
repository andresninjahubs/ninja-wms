/**
 * Cliente LLM multi-proveedor del copiloto. El tenant conecta SU cuenta de un
 * proveedor y aquí se traduce a la API que cada uno exige:
 *   - openai / compatible → POST {baseUrl}/chat/completions, Authorization: Bearer
 *   - anthropic (Claude)  → POST {baseUrl}/v1/messages, header x-api-key + anthropic-version
 *   - gemini (Google)     → POST {baseUrl}/v1beta/models/{model}:generateContent?key=…
 *
 * Es DEFENSIVO: nunca lanza. Devuelve { text } en éxito o { error } con el motivo
 * legible (para mostrarlo al usuario). Aplica timeout para no quedarse colgado.
 */
import { AiCredential } from './ports';

export type CopilotProvider = 'openai' | 'anthropic' | 'gemini' | 'compatible';
export interface LlmResult { text: string | null; error: string | null; }

/** Valores por defecto por proveedor (baseUrl + modelo sugerido). */
export const PROVIDER_DEFAULTS: Record<CopilotProvider, { label: string; baseUrl: string; model: string; needsBaseUrl: boolean; keyHint: string }> = {
  openai:      { label: 'OpenAI',                    baseUrl: 'https://api.openai.com/v1',                 model: 'gpt-4o-mini',               needsBaseUrl: false, keyHint: 'sk-…' },
  anthropic:   { label: 'Anthropic (Claude)',        baseUrl: 'https://api.anthropic.com',                 model: 'claude-3-5-sonnet-latest',  needsBaseUrl: false, keyHint: 'sk-ant-…' },
  gemini:      { label: 'Google Gemini',             baseUrl: 'https://generativelanguage.googleapis.com', model: 'gemini-1.5-flash',          needsBaseUrl: false, keyHint: 'AIza…' },
  compatible:  { label: 'Otro (compatible OpenAI)',  baseUrl: '',                                          model: '',                          needsBaseUrl: true,  keyHint: 'API key del proveedor' },
};

const TIMEOUT_MS = 25000;

function normProvider(p: string): CopilotProvider {
  const v = (p || '').toLowerCase();
  if (v === 'anthropic' || v === 'claude') return 'anthropic';
  if (v === 'gemini' || v === 'google') return 'gemini';
  if (v === 'compatible' || v === 'otro' || v === 'custom' || v === 'azure' || v === 'openrouter' || v === 'groq') return 'compatible';
  return 'openai';
}

/** fetch con timeout; traduce fallas de red a un error legible. */
async function timedFetch(url: string, init: any): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e: any) {
    if (e && e.name === 'AbortError') throw new Error('el proveedor no respondió a tiempo (timeout)');
    throw new Error('no se pudo conectar con el proveedor (revisa la salida a internet del servidor)');
  } finally {
    clearTimeout(t);
  }
}

/** Extrae un mensaje de error corto y legible del cuerpo de la respuesta. */
async function errorFrom(res: Response): Promise<string> {
  let detail = '';
  try {
    const j: any = await res.json();
    detail = j?.error?.message || j?.error?.type || j?.message || (typeof j?.error === 'string' ? j.error : '');
  } catch { /* cuerpo no-JSON */ }
  const hint = res.status === 401 || res.status === 403 ? ' (clave inválida o sin permisos)'
    : res.status === 429 ? ' (límite de uso o sin crédito)'
    : res.status === 404 ? ' (modelo o endpoint no encontrado — revisa el nombre del modelo)'
    : res.status === 400 ? ' (solicitud inválida — revisa el modelo)'
    : '';
  return `HTTP ${res.status}${detail ? ': ' + detail : ''}${hint}`;
}

/** Un turno de la conversación. */
export interface ChatTurn { role: 'user' | 'assistant'; content: string; }

async function askOpenAiLike(baseUrl: string, apiKey: string, model: string, system: string, turns: ChatTurn[]): Promise<LlmResult> {
  const res = await timedFetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ model, temperature: 0.3, messages: [{ role: 'system', content: system }, ...turns] }),
  });
  if (!res.ok) return { text: null, error: await errorFrom(res) };
  const data: any = await res.json();
  const txt = data?.choices?.[0]?.message?.content;
  return typeof txt === 'string' && txt.trim() ? { text: txt.trim(), error: null } : { text: null, error: 'respuesta vacía del proveedor' };
}

async function askAnthropic(baseUrl: string, apiKey: string, model: string, system: string, turns: ChatTurn[]): Promise<LlmResult> {
  const res = await timedFetch(`${baseUrl.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 1024, system, messages: turns }),
  });
  if (!res.ok) return { text: null, error: await errorFrom(res) };
  const data: any = await res.json();
  const blocks = data?.content;
  if (Array.isArray(blocks)) {
    const txt = blocks.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n').trim();
    return txt ? { text: txt, error: null } : { text: null, error: 'respuesta vacía del proveedor' };
  }
  return { text: null, error: 'formato de respuesta inesperado' };
}

async function askGemini(baseUrl: string, apiKey: string, model: string, system: string, turns: ChatTurn[]): Promise<LlmResult> {
  const b = baseUrl.replace(/\/$/, '');
  const url = `${b}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const res = await timedFetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] })),
      generationConfig: { temperature: 0.3 },
    }),
  });
  if (!res.ok) return { text: null, error: await errorFrom(res) };
  const data: any = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) {
    const txt = parts.map((p: any) => p?.text || '').join('').trim();
    return txt ? { text: txt, error: null } : { text: null, error: 'respuesta vacía del proveedor' };
  }
  return { text: null, error: 'formato de respuesta inesperado' };
}

/** Conversación multi-turno con el proveedor del tenant. */
export async function askCopilotChat(cred: AiCredential, system: string, turns: ChatTurn[]): Promise<LlmResult> {
  try {
    const provider = normProvider(cred.provider);
    const def = PROVIDER_DEFAULTS[provider];
    const baseUrl = (cred.baseUrl && cred.baseUrl.trim()) || def.baseUrl;
    const model = (cred.chatModel && cred.chatModel.trim()) || def.model;
    if (!baseUrl || !model) return { text: null, error: 'falta baseUrl o modelo' };
    const safe = (turns && turns.length ? turns : [{ role: 'user' as const, content: '' }]);
    if (provider === 'anthropic') return await askAnthropic(baseUrl, cred.apiKey, model, system, safe);
    if (provider === 'gemini') return await askGemini(baseUrl, cred.apiKey, model, system, safe);
    return await askOpenAiLike(baseUrl, cred.apiKey, model, system, safe);
  } catch (e: any) {
    return { text: null, error: (e && e.message) || 'error desconocido' };
  }
}

/** Compat: una sola pregunta (un turno de usuario). */
export function askCopilotLlmDetailed(cred: AiCredential, system: string, user: string): Promise<LlmResult> {
  return askCopilotChat(cred, system, [{ role: 'user', content: user }]);
}

// ============================ Tool-calling (agente) =========================
/** Especificación de una herramienta, neutral al proveedor. */
export interface ToolSpec { name: string; description: string; parameters: any; }
/** Ejecuta una herramienta y devuelve datos serializables (nunca lanza). */
export type ToolExec = (name: string, args: any) => Promise<any>;
export interface AgentResult extends LlmResult { toolsUsed: string[]; rounds: number; }

const MAX_ROUNDS = 6;
function capResult(v: any): string {
  let s: string;
  try { s = JSON.stringify(v); } catch { s = String(v); }
  return s.length > 9000 ? s.slice(0, 9000) + '…(truncado)' : s;
}

async function agentOpenAi(baseUrl: string, apiKey: string, model: string, system: string, turns: ChatTurn[], tools: ToolSpec[], exec: ToolExec): Promise<AgentResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const messages: any[] = [{ role: 'system', content: system }, ...turns];
  const oaTools = tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  const used: string[] = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await timedFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model, temperature: 0.3, messages, tools: oaTools, tool_choice: 'auto' }) });
    if (!res.ok) return { text: null, error: await errorFrom(res), toolsUsed: used, rounds: round };
    const data: any = await res.json();
    const msg = data?.choices?.[0]?.message;
    if (!msg) return { text: null, error: 'respuesta vacía', toolsUsed: used, rounds: round };
    const calls = msg.tool_calls;
    if (Array.isArray(calls) && calls.length) {
      messages.push(msg);
      for (const c of calls) {
        let args: any = {}; try { args = JSON.parse(c.function?.arguments || '{}'); } catch { args = {}; }
        used.push(c.function?.name);
        const result = await exec(c.function?.name, args);
        messages.push({ role: 'tool', tool_call_id: c.id, content: capResult(result) });
      }
      continue;
    }
    const txt = msg.content;
    return { text: typeof txt === 'string' && txt.trim() ? txt.trim() : null, error: typeof txt === 'string' ? null : 'respuesta vacía', toolsUsed: used, rounds: round };
  }
  return { text: null, error: 'se alcanzó el máximo de pasos de razonamiento', toolsUsed: used, rounds: MAX_ROUNDS };
}

async function agentAnthropic(baseUrl: string, apiKey: string, model: string, system: string, turns: ChatTurn[], tools: ToolSpec[], exec: ToolExec): Promise<AgentResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1/messages`;
  const messages: any[] = turns.map((t) => ({ role: t.role, content: t.content }));
  const anTools = tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
  const used: string[] = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await timedFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model, max_tokens: 1200, system, messages, tools: anTools }) });
    if (!res.ok) return { text: null, error: await errorFrom(res), toolsUsed: used, rounds: round };
    const data: any = await res.json();
    const blocks = data?.content;
    if (!Array.isArray(blocks)) return { text: null, error: 'formato inesperado', toolsUsed: used, rounds: round };
    const toolUses = blocks.filter((b: any) => b?.type === 'tool_use');
    if (toolUses.length && data?.stop_reason === 'tool_use') {
      messages.push({ role: 'assistant', content: blocks });
      const results: any[] = [];
      for (const tu of toolUses) { used.push(tu.name); const r = await exec(tu.name, tu.input || {}); results.push({ type: 'tool_result', tool_use_id: tu.id, content: capResult(r) }); }
      messages.push({ role: 'user', content: results });
      continue;
    }
    const txt = blocks.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('\n').trim();
    return { text: txt || null, error: txt ? null : 'respuesta vacía', toolsUsed: used, rounds: round };
  }
  return { text: null, error: 'se alcanzó el máximo de pasos de razonamiento', toolsUsed: used, rounds: MAX_ROUNDS };
}

async function agentGemini(baseUrl: string, apiKey: string, model: string, system: string, turns: ChatTurn[], tools: ToolSpec[], exec: ToolExec): Promise<AgentResult> {
  const url = `${baseUrl.replace(/\/$/, '')}/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const contents: any[] = turns.map((t) => ({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] }));
  const gTools = [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }];
  const used: string[] = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await timedFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, tools: gTools, generationConfig: { temperature: 0.3 } }) });
    if (!res.ok) return { text: null, error: await errorFrom(res), toolsUsed: used, rounds: round };
    const data: any = await res.json();
    const parts = data?.candidates?.[0]?.content?.parts;
    if (!Array.isArray(parts)) return { text: null, error: 'formato inesperado', toolsUsed: used, rounds: round };
    const fcalls = parts.filter((p: any) => p?.functionCall);
    if (fcalls.length) {
      contents.push({ role: 'model', parts });
      const respParts = [];
      for (const p of fcalls) { const fc = p.functionCall; used.push(fc.name); const r = await exec(fc.name, fc.args || {}); respParts.push({ functionResponse: { name: fc.name, response: { result: r } } }); }
      contents.push({ role: 'user', parts: respParts });
      continue;
    }
    const txt = parts.map((p: any) => p?.text || '').join('').trim();
    return { text: txt || null, error: txt ? null : 'respuesta vacía', toolsUsed: used, rounds: round };
  }
  return { text: null, error: 'se alcanzó el máximo de pasos de razonamiento', toolsUsed: used, rounds: MAX_ROUNDS };
}

/** Agente conversacional con herramientas: el LLM decide qué datos consultar. */
export async function askCopilotAgent(cred: AiCredential, system: string, turns: ChatTurn[], tools: ToolSpec[], exec: ToolExec): Promise<AgentResult> {
  try {
    const provider = normProvider(cred.provider);
    const def = PROVIDER_DEFAULTS[provider];
    const baseUrl = (cred.baseUrl && cred.baseUrl.trim()) || def.baseUrl;
    const model = (cred.chatModel && cred.chatModel.trim()) || def.model;
    if (!baseUrl || !model) return { text: null, error: 'falta baseUrl o modelo', toolsUsed: [], rounds: 0 };
    const safe = (turns && turns.length ? turns : [{ role: 'user' as const, content: '' }]);
    if (provider === 'anthropic') return await agentAnthropic(baseUrl, cred.apiKey, model, system, safe, tools, exec);
    if (provider === 'gemini') return await agentGemini(baseUrl, cred.apiKey, model, system, safe, tools, exec);
    return await agentOpenAi(baseUrl, cred.apiKey, model, system, safe, tools, exec);
  } catch (e: any) {
    return { text: null, error: (e && e.message) || 'error desconocido', toolsUsed: [], rounds: 0 };
  }
}

/** Variante simple (compat): devuelve solo el texto o null. */
export async function askCopilotLlm(cred: AiCredential, system: string, user: string): Promise<string | null> {
  return (await askCopilotLlmDetailed(cred, system, user)).text;
}

/** Lista los modelos disponibles para la cuenta del tenant (para elegir uno válido). */
export async function listModels(cred: AiCredential): Promise<{ models: string[]; error: string | null }> {
  try {
    const provider = normProvider(cred.provider);
    const def = PROVIDER_DEFAULTS[provider];
    const baseUrl = ((cred.baseUrl && cred.baseUrl.trim()) || def.baseUrl).replace(/\/$/, '');
    if (provider === 'anthropic') {
      const res = await timedFetch(`${baseUrl}/v1/models?limit=100`, { headers: { 'x-api-key': cred.apiKey, 'anthropic-version': '2023-06-01' } });
      if (!res.ok) return { models: [], error: await errorFrom(res) };
      const data: any = await res.json();
      const ids = (data?.data || []).map((m: any) => m?.id).filter(Boolean);
      return { models: ids, error: null };
    }
    if (provider === 'gemini') {
      const res = await timedFetch(`${baseUrl}/v1beta/models?key=${encodeURIComponent(cred.apiKey)}&pageSize=200`, {});
      if (!res.ok) return { models: [], error: await errorFrom(res) };
      const data: any = await res.json();
      const ids = (data?.models || [])
        .filter((m: any) => !Array.isArray(m?.supportedGenerationMethods) || m.supportedGenerationMethods.includes('generateContent'))
        .map((m: any) => String(m?.name || '').replace(/^models\//, ''))
        .filter(Boolean);
      return { models: ids, error: null };
    }
    // openai + compatible
    const res = await timedFetch(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${cred.apiKey}` } });
    if (!res.ok) return { models: [], error: await errorFrom(res) };
    const data: any = await res.json();
    const ids = (data?.data || []).map((m: any) => m?.id).filter(Boolean);
    return { models: ids, error: null };
  } catch (e: any) {
    return { models: [], error: (e && e.message) || 'error desconocido' };
  }
}
