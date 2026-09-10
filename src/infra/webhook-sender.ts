/**
 * HttpWebhookSender — envío HTTP real de los webhooks (implementa WebhookSender).
 *
 * Hace un POST con `fetch` global (Node 18+) con timeout ~5s vía AbortController.
 * Devuelve { ok, status } en caso de respuesta HTTP, o { ok:false, status:null, error }
 * si la conexión falla o se agota el tiempo. NUNCA lanza: el WebhookService captura
 * todo y registra la entrega (DELIVERED/FAILED) con este resultado.
 */
import { WebhookSender } from '../domain/ports';

const TIMEOUT_MS = 5000;

export class HttpWebhookSender implements WebhookSender {
  constructor(private readonly timeoutMs = TIMEOUT_MS) {}

  async send(
    url: string,
    body: string,
    headers: Record<string, string>,
  ): Promise<{ ok: boolean; status: number | null; error?: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
        signal: controller.signal,
      });
      // 2xx = entregado; cualquier otro código se registra como fallo con su status.
      return { ok: res.ok, status: res.status };
    } catch (err) {
      const aborted = (err as Error)?.name === 'AbortError';
      return {
        ok: false,
        status: null,
        error: aborted ? `Timeout tras ${this.timeoutMs}ms` : (err as Error)?.message || 'Error de red',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
