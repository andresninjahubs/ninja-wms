/**
 * Deadline de preparación (compromiso de salida).
 * ------------------------------------------------------------------------
 * Antes el sistema solo sabía CUÁNTO llevaba esperando una orden (horas en un
 * estado). Eso no distingue un pedido que tiene que salir hoy a las 14:00 de
 * uno que puede salir mañana. El deadline (`dueAt`) responde la otra pregunta:
 * PARA CUÁNDO tiene que estar lista.
 *
 * De dónde sale, en este orden:
 *   1. `oms`    — la fecha vino en la orden (el canal la comprometió con el cliente).
 *   2. `manual` — alguien la fijó a mano en el panel.
 *   3. `corte`  — hora de corte del courier de la orden, configurada en la operación.
 *   4. `sla`    — promesa del cliente: "preparar dentro de N horas desde el ingreso".
 *   5. null     — sin compromiso: la orden se ordena como siempre (courier + FIFO).
 *
 * Todo este módulo es puro: recibe el `now` y la configuración, no consulta nada.
 */

/** Origen del deadline de una orden. */
export type DueSource = 'oms' | 'manual' | 'corte' | 'sla';

/** Hora de corte de un courier en la operación (cuándo pasa a retirar). */
export interface CourierCutoff {
  /** Nombre del courier tal como llega en la orden (se compara normalizado). */
  courier: string;
  /** Hora local de corte, "HH:MM". */
  hora: string;
  /** Días de la semana en que ese corte aplica (0 = domingo … 6 = sábado). Vacío = todos. */
  dias?: number[];
}

/** Configuración de deadlines de una operación. */
export interface DeadlineConfig {
  /** Desfase horario de la bodega respecto de UTC, en horas (Chile continental: −3 o −4). */
  offsetHoras?: number;
  /** Cuántas horas antes del deadline una orden se considera "en riesgo". */
  riesgoHoras?: number;
  /** Cortes por courier. */
  cortes?: CourierCutoff[];
}

export const DEADLINE_DEFAULTS = { offsetHoras: -3, riesgoHoras: 4 };

/** Normaliza el nombre de un courier para comparar ("Blue Express" → "blueexpress"). */
export function normCourierName(c: string | null | undefined): string {
  return String(c || '').toLowerCase().replace(/[\s._-]/g, '');
}

/**
 * Próxima ocurrencia de una hora de corte a partir de `nowIso`, en la zona de la bodega.
 * Devuelve ISO UTC, o null si el corte no tiene días válidos.
 */
export function nextCutoff(nowIso: string, hora: string, dias: number[] | undefined, offsetHoras: number): string | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hora || '').trim());
  if (!m) return null;
  const hh = Number(m[1]), mm = Number(m[2]);
  if (hh > 23 || mm > 59) return null;
  const nowMs = Date.parse(nowIso);
  if (Number.isNaN(nowMs)) return null;
  const offMs = offsetHoras * 3600000;
  // "Local" = UTC desplazado: así el día y la hora que calculamos son los de la bodega.
  const local = new Date(nowMs + offMs);
  const validos = dias && dias.length ? dias : [0, 1, 2, 3, 4, 5, 6];
  for (let d = 0; d < 14; d++) {
    const cand = new Date(local.getTime());
    cand.setUTCDate(cand.getUTCDate() + d);
    cand.setUTCHours(hh, mm, 0, 0);
    if (cand.getTime() <= local.getTime()) continue; // ya pasó
    if (!validos.includes(cand.getUTCDay())) continue; // ese día no hay retiro
    return new Date(cand.getTime() - offMs).toISOString();
  }
  return null;
}

/**
 * Resuelve el deadline de una orden. `explicito` gana sobre todo lo demás
 * (es lo que mandó el OMS o lo que fijó una persona).
 */
export function resolveDueAt(input: {
  nowIso: string;
  carrier?: string | null;
  config?: DeadlineConfig | null;
  slaHoras?: number | null;
  explicito?: string | null;
  fuenteExplicita?: DueSource;
}): { dueAt: string | null; dueSource: DueSource | null } {
  if (input.explicito) {
    const t = Date.parse(input.explicito);
    if (Number.isNaN(t)) return { dueAt: null, dueSource: null };
    return { dueAt: new Date(t).toISOString(), dueSource: input.fuenteExplicita || 'manual' };
  }
  const cfg = input.config || {};
  const off = cfg.offsetHoras ?? DEADLINE_DEFAULTS.offsetHoras;
  const carrier = normCourierName(input.carrier);
  if (carrier && cfg.cortes && cfg.cortes.length) {
    const corte = cfg.cortes.find((c) => {
      const n = normCourierName(c.courier);
      return !!n && (n === carrier || carrier.includes(n) || n.includes(carrier));
    });
    if (corte) {
      const at = nextCutoff(input.nowIso, corte.hora, corte.dias, off);
      if (at) return { dueAt: at, dueSource: 'corte' };
    }
  }
  const sla = input.slaHoras;
  if (sla && sla > 0) {
    const base = Date.parse(input.nowIso);
    if (!Number.isNaN(base)) return { dueAt: new Date(base + sla * 3600000).toISOString(), dueSource: 'sla' };
  }
  return { dueAt: null, dueSource: null };
}

/** Nivel de urgencia de una orden respecto de su deadline. */
export type DeadlineLevel = 'vencido' | 'critico' | 'riesgo' | 'ok' | 'sin';

export interface DeadlineState {
  level: DeadlineLevel;
  /** Minutos que faltan (negativo si ya venció). null si no hay deadline. */
  holguraMin: number | null;
  /** Texto corto para la UI: "vence en 2 h 10", "vencida hace 40 min". */
  texto: string;
}

/** Cuánto falta para el deadline y qué tan grave es. */
export function deadlineState(dueAt: string | null | undefined, nowIso: string, riesgoHoras?: number | null): DeadlineState {
  if (!dueAt) return { level: 'sin', holguraMin: null, texto: '' };
  const due = Date.parse(dueAt), now = Date.parse(nowIso);
  if (Number.isNaN(due) || Number.isNaN(now)) return { level: 'sin', holguraMin: null, texto: '' };
  const min = Math.round((due - now) / 60000);
  const riesgo = (riesgoHoras ?? DEADLINE_DEFAULTS.riesgoHoras) * 60;
  const level: DeadlineLevel = min < 0 ? 'vencido' : min <= 60 ? 'critico' : min <= riesgo ? 'riesgo' : 'ok';
  const abs = Math.abs(min);
  const h = Math.floor(abs / 60), r = abs % 60;
  const dur = h > 0 ? `${h} h${r ? ` ${r} min` : ''}` : `${r} min`;
  return { level, holguraMin: min, texto: min < 0 ? `vencida hace ${dur}` : `vence en ${dur}` };
}

/**
 * Impulso de prioridad por deadline (número NEGATIVO: menor prioridad = se hace antes).
 * Reemplaza al viejo "empacada hace +6 h", que medía tiempo transcurrido en vez de holgura.
 */
export function deadlineBoost(st: DeadlineState): number {
  switch (st.level) {
    case 'vencido': return -900;
    case 'critico': return -700;
    case 'riesgo': return -450;
    default: return 0;
  }
}

/** ¿Esta orden debe saltarse la cola (deadline vencido o en riesgo)? */
export function enRiesgo(st: DeadlineState): boolean {
  return st.level === 'vencido' || st.level === 'critico' || st.level === 'riesgo';
}
