/**
 * Ventanas horarias del agente autónomo.
 * ---------------------------------------------------------------------------
 * El agente corre en el servidor cada pocos minutos. El barrido de reglas es
 * determinista y gratis; la planificación con LLM cuesta plata y no siempre se
 * quiere corriendo a las 3 de la mañana de un domingo. Acá se define CUÁNDO
 * puede hacerlo: una o más ventanas, cada una con sus días de la semana.
 *
 * Decisiones que importan:
 *   - La hora es LOCAL de la operación, no UTC. Una bodega en Santiago configura
 *     "08:00 a 20:00" y eso significa las ocho de la mañana allá, con cambio de
 *     horario de verano incluido. Se resuelve con Intl, sin librerías.
 *   - Una ventana que termina antes de empezar (22:00 → 06:00) cruza la
 *     medianoche. El día que se marca es el día en que EMPIEZA.
 *   - `alcance` decide qué se pausa fuera de ventana: solo el LLM (por defecto,
 *     que es de lo que se trata el gasto) o el agente entero.
 *   - Sin ventanas configuradas y con la agenda activa, no corre nunca. Eso es
 *     literal y a propósito: una lista vacía no significa "siempre".
 */

export interface AgentWindow {
  /** Días de la semana en que ARRANCA la ventana. 0 = domingo … 6 = sábado. */
  dias: number[];
  /** "HH:MM" local. */
  desde: string;
  /** "HH:MM" local. Si es menor o igual que `desde`, la ventana cruza la medianoche. */
  hasta: string;
}

export interface AgentSchedule {
  /** false = sin restricción horaria (se comporta como siempre). */
  activo: boolean;
  /** Zona horaria IANA de la operación. */
  tz: string;
  /** Qué se pausa fuera de ventana. */
  alcance: 'llm' | 'todo';
  ventanas: AgentWindow[];
}

export const SCHEDULE_DEFAULT: AgentSchedule = {
  activo: false,
  tz: 'America/Santiago',
  alcance: 'llm',
  ventanas: [],
};

export const DIAS_NOMBRE = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutos(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (!m) throw new Error(`Hora inválida: "${hhmm}". Se espera HH:MM entre 00:00 y 23:59.`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Valida que la zona horaria exista de verdad antes de guardarla. */
export function tzValida(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/**
 * Deja la agenda en forma canónica o explica qué está mal. Nunca guarda basura:
 * lo que entra por la API viene de un formulario y puede venir con cualquier cosa.
 */
export function normalizarSchedule(raw: unknown): AgentSchedule {
  const r = (raw || {}) as any;
  const tz = typeof r.tz === 'string' && r.tz.trim() ? r.tz.trim() : SCHEDULE_DEFAULT.tz;
  if (!tzValida(tz)) throw new Error(`Zona horaria desconocida: "${tz}".`);
  const ventanas: AgentWindow[] = (Array.isArray(r.ventanas) ? r.ventanas : []).map((v: any, i: number) => {
    const dias = Array.from(new Set((Array.isArray(v?.dias) ? v.dias : []).map((d: any) => Math.trunc(Number(d)))))
      .filter((d) => Number.isFinite(d) && (d as number) >= 0 && (d as number) <= 6)
      .sort((a: any, b: any) => a - b) as number[];
    if (!dias.length) throw new Error(`La ventana ${i + 1} no tiene días seleccionados.`);
    const desde = String(v?.desde ?? '').trim();
    const hasta = String(v?.hasta ?? '').trim();
    minutos(desde); minutos(hasta); // valida formato
    if (minutos(desde) === minutos(hasta)) throw new Error(`La ventana ${i + 1} empieza y termina a la misma hora.`);
    return { dias, desde, hasta };
  });
  const activo = !!r.activo;
  if (activo && !ventanas.length) throw new Error('Agenda activa sin ventanas: el agente no correría nunca. Agrega al menos una.');
  return { activo, tz, alcance: r.alcance === 'todo' ? 'todo' : 'llm', ventanas };
}

const DIA_CORTO: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Día de la semana (0-6) y minuto del día, en la zona horaria pedida. */
export function localEn(iso: string, tz: string): { dia: number; min: number } {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
  let dia = 0, hh = 0, mm = 0;
  for (const p of f.formatToParts(new Date(iso))) {
    if (p.type === 'weekday') dia = DIA_CORTO[p.value] ?? 0;
    else if (p.type === 'hour') hh = Number(p.value) % 24;
    else if (p.type === 'minute') mm = Number(p.value);
  }
  return { dia, min: hh * 60 + mm };
}

function cubre(v: AgentWindow, dia: number, min: number): boolean {
  const a = minutos(v.desde), b = minutos(v.hasta);
  if (a < b) return v.dias.includes(dia) && min >= a && min < b;
  // Cruza la medianoche: o es el día de inicio después de `desde`, o el día
  // siguiente antes de `hasta`.
  const ayer = (dia + 6) % 7;
  return (v.dias.includes(dia) && min >= a) || (v.dias.includes(ayer) && min < b);
}

export interface EstadoVentana {
  dentro: boolean;
  /** Frase lista para mostrar, sin adornos. */
  motivo: string;
  /** ISO del próximo instante en que se abre la ventana (null si ya está dentro o nunca). */
  proximaAperturaIso: string | null;
}

/**
 * ¿Puede correr ahora? Si no, cuándo. La próxima apertura se busca avanzando de
 * a 10 minutos hasta 8 días: es barato, se calcula solo para mostrar el estado,
 * y evita tener que convertir hora local a UTC a mano (que es donde se cometen
 * los errores con el horario de verano).
 */
export function estadoVentana(s: AgentSchedule, nowIso: string): EstadoVentana {
  if (!s.activo) return { dentro: true, motivo: 'Sin restricción horaria.', proximaAperturaIso: null };
  if (!s.ventanas.length) return { dentro: false, motivo: 'Agenda activa sin ventanas configuradas.', proximaAperturaIso: null };
  const aqui = localEn(nowIso, s.tz);
  if (s.ventanas.some((v) => cubre(v, aqui.dia, aqui.min))) {
    return { dentro: true, motivo: 'Dentro de la ventana horaria.', proximaAperturaIso: null };
  }
  const t0 = Date.parse(nowIso);
  const PASO = 10 * 60000;
  const abierta = (t: number) => {
    const p = localEn(new Date(t).toISOString(), s.tz);
    return s.ventanas.some((v) => cubre(v, p.dia, p.min));
  };
  for (let t = t0 + PASO; t <= t0 + 8 * 86400000; t += PASO) {
    if (!abierta(t)) continue;
    // Afinado: el barrido grueso cae DENTRO de la ventana, no en su borde.
    // Retrocedemos de a un minuto para reportar la hora exacta de apertura.
    let exacto = t;
    for (let k = 1; k <= 10; k++) {
      const prev = t - k * 60000;
      if (prev <= t0 || !abierta(prev)) break;
      exacto = prev;
    }
    return { dentro: false, motivo: 'Fuera de la ventana horaria.', proximaAperturaIso: new Date(exacto).toISOString() };
  }
  return { dentro: false, motivo: 'Fuera de la ventana horaria.', proximaAperturaIso: null };
}

/** Resumen legible de la agenda, para el panel y el diario del agente. */
export function resumenSchedule(s: AgentSchedule): string {
  if (!s.activo) return 'Sin restricción horaria';
  if (!s.ventanas.length) return 'Activa, sin ventanas (no corre)';
  return s.ventanas
    .map((v) => `${v.dias.map((d) => DIAS_NOMBRE[d]).join(', ')} ${v.desde}–${v.hasta}`)
    .join(' · ') + ` (${s.tz})`;
}
