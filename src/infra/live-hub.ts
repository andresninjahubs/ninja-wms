/**
 * Canal EN VIVO (WebSocket) entre la app del operario y el panel.
 *
 *   App del operario ──(ws)──▶ servidor ──(ws)──▶ panel (admin / supervisor / plataforma)
 *
 * La app avisa en qué está trabajando el operario (tipo de tarea + entidad: orden,
 * recepción, conteo, guardado) y su AVANCE en unidades; el servidor lo reparte a los
 * paneles de esa operación. Además, cada cambio de una asignación (tomar, asignar,
 * empezar, completar, liberar) se difunde aunque la app no esté conectada al socket,
 * porque sale del repositorio de asignaciones.
 *
 * Ruta: GET /ws?token=<JWT>  (upgrade a WebSocket).
 *
 * Mensajes de la APP (operario):
 *   { t: 'working', items: [{ type, entityId, ref?, sellerId?, done?, total?, unit? }] }
 *   { t: 'idle' }
 *   { t: 'ping' }
 * Mensajes del PANEL:
 *   { t: 'sub', operationId }     ← suscribirse a una operación (el super admin elige cuál)
 * Mensajes del SERVIDOR al panel:
 *   { t: 'snap', operationId, presence: [...], asignaciones: [...] }
 *   { t: 'pres', operationId, operator, name, items: [...] | [] , at }
 *   { t: 'asg',  operationId, key, type, entityId, entityRef, operator, name, status, startedAt, at }
 *
 * Sin dependencias del framework: se cuelga del servidor HTTP con `upgrade`.
 */
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import { WebSocketServer, WebSocket } from 'ws';
import type { WorkAssignment, User } from '../domain/types';
import type { WorkAssignmentRepository } from '../domain/ports';

type Item = { type: string; entityId: string; ref?: string | null; sellerId?: string | null; done?: number | null; total?: number | null; unit?: string | null };
type Presence = { operator: string; name: string; items: Item[]; since: string; at: string };
type Client = { ws: WebSocket; user: User; viewer: boolean; opId: string | null; alive: boolean };

/** Bus mínimo de cambios de asignación (el repositorio lo alimenta). */
type AsgListener = (a: WorkAssignment) => void;
const asgListeners: AsgListener[] = [];
export function onAssignmentChange(fn: AsgListener): void { asgListeners.push(fn); }

/** Envuelve el repositorio de asignaciones para avisar cada `save` al canal en vivo. */
export function withLiveAssignments<T extends WorkAssignmentRepository>(repo: T): T {
  const save = repo.save.bind(repo);
  (repo as any).save = async (a: WorkAssignment) => {
    await save(a);
    for (const fn of asgListeners) { try { fn(a); } catch { /* nunca bloquea */ } }
  };
  return repo;
}

export interface LiveFacade {
  resolveToken(token: string, allowDemo: boolean): Promise<User | null>;
  listUsers(operationId?: string | null): Promise<User[]>;
  liveOpenAssignments(operationId: string): Promise<WorkAssignment[]>;
}

const VIEWER_ROLES = new Set(['ADMIN', 'SUPERVISOR', 'PLATFORM_ADMIN']);
const PRESENCE_TTL_MS = 75_000;

export function attachLiveHub(server: Server, facade: LiveFacade, log: (m: string) => void = () => {}): void {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<Client>();
  const presence = new Map<string, Map<string, Presence>>(); // opId → operator → presencia
  const names = new Map<string, { at: number; byId: Map<string, string> }>();

  async function nameOf(opId: string, userId: string): Promise<string> {
    const c = names.get(opId);
    if (!c || Date.now() - c.at > 60_000) {
      const users = await facade.listUsers(opId).catch(() => [] as User[]);
      names.set(opId, { at: Date.now(), byId: new Map(users.map((u) => [u.id, u.name || u.email] as [string, string])) });
    }
    return names.get(opId)!.byId.get(userId) || userId;
  }
  function send(ws: WebSocket, msg: unknown) {
    if (ws.readyState === WebSocket.OPEN) { try { ws.send(JSON.stringify(msg)); } catch { /* ignore */ } }
  }
  function toViewers(opId: string, msg: unknown) {
    for (const c of clients) if (c.viewer && c.opId === opId) send(c.ws, msg);
  }
  function presList(opId: string): Presence[] {
    const m = presence.get(opId); if (!m) return [];
    const now = Date.now();
    for (const [k, p] of m) if (now - Date.parse(p.at) > PRESENCE_TTL_MS) m.delete(k);
    return [...m.values()];
  }
  function clearPresence(opId: string | null, operator: string) {
    if (!opId) return;
    const m = presence.get(opId);
    if (m && m.delete(operator)) toViewers(opId, { t: 'pres', operationId: opId, operator, name: null, items: [], at: new Date().toISOString() });
  }

  // Cambios de asignación → paneles de esa operación.
  onAssignmentChange(async (a) => {
    try {
      const name = await nameOf(a.operationId, a.operator);
      toViewers(a.operationId, {
        t: 'asg', operationId: a.operationId, key: `${a.type}:${a.entityId}`, type: a.type, entityId: a.entityId,
        entityRef: a.entityRef, operator: a.operator, name, status: a.status, startedAt: a.startedAt ?? null, at: new Date().toISOString(),
      });
    } catch { /* ignore */ }
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try { url = new URL(req.url || '', 'http://x'); } catch { socket.destroy(); return; }
    if (url.pathname !== '/ws') return; // otras rutas de upgrade no son nuestras
    const token = url.searchParams.get('token') || '';
    const allowDemo = process.env.AUTH_REQUIRED !== 'true';
    facade.resolveToken(token, allowDemo).then((user) => {
      if (!user) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
      wss.handleUpgrade(req, socket, head, (ws) => {
        const c: Client = { ws, user, viewer: VIEWER_ROLES.has(String(user.role)), opId: user.operationId ?? null, alive: true };
        clients.add(c);
        ws.on('pong', () => { c.alive = true; });
        ws.on('message', (raw) => onMessage(c, raw.toString()));
        ws.on('close', () => { clients.delete(c); if (!c.viewer) clearPresence(c.opId, user.id); });
        send(ws, { t: 'hello', user: user.id, viewer: c.viewer });
        if (c.viewer && c.opId) snapshot(c);
      });
    }).catch(() => socket.destroy());
  });

  async function snapshot(c: Client) {
    if (!c.opId) return;
    const opId = c.opId;
    const open = await facade.liveOpenAssignments(opId).catch(() => [] as WorkAssignment[]);
    const asignaciones = await Promise.all(open.map(async (a) => ({
      key: `${a.type}:${a.entityId}`, type: a.type, entityId: a.entityId, entityRef: a.entityRef,
      operator: a.operator, name: await nameOf(opId, a.operator), status: a.status, startedAt: a.startedAt ?? null,
    })));
    send(c.ws, { t: 'snap', operationId: opId, presence: presList(opId), asignaciones });
  }

  function onMessage(c: Client, raw: string) {
    let m: any; try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'ping') { send(c.ws, { t: 'pong' }); return; }
    if (m.t === 'sub' && c.viewer) {
      // El admin de una operación queda en la suya; el super admin elige cuál mirar.
      c.opId = String(c.user.role) === 'PLATFORM_ADMIN' ? String(m.operationId || '') || null : (c.user.operationId ?? null);
      snapshot(c);
      return;
    }
    const opId = c.user.operationId ?? null;
    if (!opId) return;
    if (m.t === 'idle') { clearPresence(opId, c.user.id); return; }
    if (m.t === 'working' && Array.isArray(m.items)) {
      const items: Item[] = m.items.slice(0, 50).map((x: any) => ({
        type: String(x.type || '').toUpperCase().slice(0, 16), entityId: String(x.entityId || '').slice(0, 200),
        ref: x.ref != null ? String(x.ref).slice(0, 120) : null, sellerId: x.sellerId != null ? String(x.sellerId).slice(0, 80) : null,
        done: Number.isFinite(Number(x.done)) ? Number(x.done) : null, total: Number.isFinite(Number(x.total)) ? Number(x.total) : null,
        unit: x.unit != null ? String(x.unit).slice(0, 12) : null,
      })).filter((x: Item) => x.type && x.entityId);
      if (!items.length) { clearPresence(opId, c.user.id); return; }
      nameOf(opId, c.user.id).then((name) => {
        let m2 = presence.get(opId); if (!m2) { m2 = new Map(); presence.set(opId, m2); }
        const prev = m2.get(c.user.id);
        const same = prev && prev.items.map((i) => i.type + i.entityId).join() === items.map((i) => i.type + i.entityId).join();
        const now = new Date().toISOString();
        const p: Presence = { operator: c.user.id, name, items, since: same ? prev!.since : now, at: now };
        m2.set(c.user.id, p);
        toViewers(opId, { t: 'pres', operationId: opId, ...p });
      });
    }
  }

  // Latido: mantiene vivas las conexiones detrás de proxies y limpia presencias viejas.
  const timer = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) { try { c.ws.terminate(); } catch { /* ignore */ } continue; }
      c.alive = false; try { c.ws.ping(); } catch { /* ignore */ }
    }
    for (const opId of presence.keys()) {
      const antes = presence.get(opId)!.size; const vivos = presList(opId);
      if (vivos.length !== antes) for (const c of clients) if (c.viewer && c.opId === opId) snapshot(c);
    }
  }, 25_000);
  (timer as any).unref?.();
  log('Canal en vivo (WebSocket) activo en /ws');
}
