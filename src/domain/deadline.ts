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
export type DueSource = 'oms' | 'manual' | 'regla' | 'corte' | 'sla';

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
  /** Días hábiles de la bodega (0 = domingo … 6 = sábado). Por defecto lunes a viernes. */
  diasHabiles?: number[];
  /** Feriados ("AAAA-MM-DD"): no cuentan como día hábil. */
  feriados?: string[];
  /** Reglas de deadline automático por cliente (sellerId → reglas). */
  clientes?: Record<string, ClientDeadlineRules>;
}

/**
 * Regla de deadline por horario de ingreso:
 * "las órdenes que entran hasta las `corteIngreso` vencen `diasHabiles` días hábiles
 * después (0 = el mismo día si es hábil) a la `horaDeadline`; las que entran después
 * del corte, `diasHabilesDespues` días hábiles después".
 */
export interface DeadlineRule {
  id: string;
  nombre?: string | null;
  /** Solo para órdenes de este courier (null = cualquier courier). */
  courier?: string | null;
  /** Hora local "HH:MM" hasta la que una orden cuenta como ingresada "a tiempo". */
  corteIngreso: string;
  /** Días hábiles hacia adelante si entra hasta el corte (0 = mismo día hábil). */
  diasHabiles: number;
  /** Días hábiles si entra DESPUÉS del corte (por defecto diasHabiles + 1). */
  diasHabilesDespues?: number | null;
  /** Hora local "HH:MM" del deadline. Si el courier tiene hora prefijada, manda la del courier. */
  horaDeadline?: string | null;
  activa?: boolean;
}

/** Reglas de deadline de un cliente. */
export interface ClientDeadlineRules {
  activo: boolean;
  reglas: DeadlineRule[];
  /** Hora de deadline prefijada por courier ("Blue Express" → "16:00"). */
  horasCourier?: Array<{ courier: string; hora: string }>;
}

const HHMM = /^([01]?\d|2[0-3]):([0-5]\d)$/;
export function horaValida(h: unknown): boolean { return HHMM.test(String(h || '').trim()); }
function minutosDe(h: string): number { const m = HHMM.exec(h.trim())!; return Number(m[1]) * 60 + Number(m[2]); }

/** Normaliza y valida las reglas de un cliente (lanza Error con mensaje claro). */
export function normalizarReglasCliente(raw: any, idGen: () => string): ClientDeadlineRules {
  const reglas: DeadlineRule[] = [];
  for (const [i, r] of (Array.isArray(raw?.reglas) ? raw.reglas : []).entries()) {
    const n = i + 1;
    if (!horaValida(r?.corteIngreso)) throw new Error(`Regla ${n}: la hora de corte de ingreso debe ser HH:MM (ej. 14:00).`);
    const dias = Number(r?.diasHabiles);
    if (!Number.isInteger(dias) || dias < 0 || dias > 30) throw new Error(`Regla ${n}: los días hábiles deben ser un entero entre 0 y 30.`);
    let despues: number | null = r?.diasHabilesDespues == null || r?.diasHabilesDespues === '' ? null : Number(r.diasHabilesDespues);
    if (despues != null && (!Number.isInteger(despues) || despues < 0 || despues > 30)) throw new Error(`Regla ${n}: los días hábiles después del corte deben ser un entero entre 0 y 30.`);
    const hora = r?.horaDeadline ? String(r.horaDeadline).trim() : null;
    if (hora && !horaValida(hora)) throw new Error(`Regla ${n}: la hora del deadline debe ser HH:MM (ej. 18:00).`);
    reglas.push({
      id: String(r?.id || '').slice(0, 40) || idGen(),
      nombre: r?.nombre ? String(r.nombre).trim().slice(0, 80) : null,
      courier: r?.courier ? String(r.courier).trim().slice(0, 60) : null,
      corteIngreso: String(r.corteIngreso).trim(), diasHabiles: dias, diasHabilesDespues: despues, horaDeadline: hora,
      activa: r?.activa !== false,
    });
  }
  const horasCourier: Array<{ courier: string; hora: string }> = [];
  for (const h of Array.isArray(raw?.horasCourier) ? raw.horasCourier : []) {
    const c = String(h?.courier || '').trim();
    if (!c) continue;
    if (!horaValida(h?.hora)) throw new Error(`La hora del courier ${c} debe ser HH:MM.`);
    horasCourier.push({ courier: c.slice(0, 60), hora: String(h.hora).trim() });
  }
  return { activo: raw?.activo !== false, reglas, horasCourier };
}

/** ¿Es hábil la fecha local "AAAA-MM-DD"? */
export function esDiaHabil(ymd: string, cfg?: DeadlineConfig | null): boolean {
  const dias = cfg?.diasHabiles && cfg.diasHabiles.length ? cfg.diasHabiles : [1, 2, 3, 4, 5];
  const d = new Date(ymd + 'T12:00:00Z').getUTCDay();
  return dias.includes(d) && !(cfg?.feriados || []).includes(ymd);
}
function sumarDia(ymd: string, n: number): string {
  const t = new Date(ymd + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10);
}
function siguienteHabil(ymd: string, cfg?: DeadlineConfig | null): string {
  let d = ymd; for (let i = 0; i < 400 && !esDiaHabil(d, cfg); i++) d = sumarDia(d, 1); return d;
}
/** Avanza `n` días hábiles desde un día hábil. */
export function sumarHabiles(ymd: string, n: number, cfg?: DeadlineConfig | null): string {
  let d = siguienteHabil(ymd, cfg);
  for (let k = 0; k < n; k++) d = siguienteHabil(sumarDia(d, 1), cfg);
  return d;
}

/**
 * Deadline por las reglas del cliente. Devuelve null si el cliente no tiene reglas
 * activas o ninguna aplica al courier de la orden. Una regla de ese courier gana
 * sobre una regla general.
 */
export function deadlinePorReglas(nowIso: string, carrier: string | null | undefined, cliente: ClientDeadlineRules | null | undefined, cfg?: DeadlineConfig | null): { dueAt: string; regla: DeadlineRule; detalle: string } | null {
  if (!cliente || cliente.activo === false || !cliente.reglas?.length) return null;
  const c = normCourierName(carrier);
  const match = (x?: string | null) => { const n = normCourierName(x); return !!n && !!c && (n === c || c.includes(n) || n.includes(c)); };
  const activas = cliente.reglas.filter((r) => r.activa !== false);
  const regla = activas.find((r) => r.courier && match(r.courier)) || activas.find((r) => !r.courier);
  if (!regla) return null;
  const off = (cfg?.offsetHoras ?? DEADLINE_DEFAULTS.offsetHoras) * 3600000;
  const now = Date.parse(nowIso); if (Number.isNaN(now)) return null;
  const local = new Date(now + off);
  const hoy = local.toISOString().slice(0, 10);
  const minHoy = local.getUTCHours() * 60 + local.getUTCMinutes();
  const habilHoy = esDiaHabil(hoy, cfg);
  // Si hoy no es hábil, la orden cuenta como ingresada al inicio del próximo hábil (antes del corte).
  const aTiempo = habilHoy ? minHoy <= minutosDe(regla.corteIngreso) : true;
  const n = aTiempo ? regla.diasHabiles : (regla.diasHabilesDespues ?? regla.diasHabiles + 1);
  const base = habilHoy ? hoy : siguienteHabil(hoy, cfg);
  let dia = sumarHabiles(base, n, cfg);
  const hc = (cliente.horasCourier || []).find((h) => match(h.courier));
  const hora = hc?.hora || regla.horaDeadline || '23:59';
  const aUtc = (ymd: string) => Date.parse(`${ymd}T${hora.padStart(5, '0')}:00Z`) - off;
  let due = aUtc(dia);
  // Un deadline que ya pasó (ej. entra 15:00 con hora 13:00, mismo día) corre al siguiente hábil.
  if (due <= now) { dia = sumarHabiles(sumarDia(dia, 1), 0, cfg); due = aUtc(dia); }
  const detalle = `${regla.nombre || 'Regla'}: ingreso ${aTiempo ? 'hasta' : 'después de'} las ${regla.corteIngreso} → ${n === 0 ? 'mismo día hábil' : `${n} día(s) hábil(es)`} a las ${hora}${hc ? ` (hora de ${hc.courier})` : ''}`;
  return { dueAt: new Date(due).toISOString(), regla, detalle };
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
  /** Id del cliente (seller) para aplicar sus reglas de deadline. */
  sellerId?: string | null;
}): { dueAt: string | null; dueSource: DueSource | null } {
  if (input.explicito) {
    const t = Date.parse(input.explicito);
    if (Number.isNaN(t)) return { dueAt: null, dueSource: null };
    return { dueAt: new Date(t).toISOString(), dueSource: input.fuenteExplicita || 'manual' };
  }
  const cfg = input.config || {};
  // Reglas del cliente: ganan sobre el corte general del courier y el SLA.
  if (input.sellerId && cfg.clientes && cfg.clientes[input.sellerId]) {
    const r = deadlinePorReglas(input.nowIso, input.carrier, cfg.clientes[input.sellerId], cfg);
    if (r) return { dueAt: r.dueAt, dueSource: 'regla' };
  }
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
