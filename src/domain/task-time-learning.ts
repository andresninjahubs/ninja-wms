/**
 * Aprendizaje de los coeficientes de tiempo desde el libro de eventos.
 * ---------------------------------------------------------------------------
 * La Fase 2 cambió la FORMA del modelo (setup + paradas + unidades) pero sus tres
 * números venían de una calibración declarada, no de la bodega. Acá se reemplazan
 * por lo que de verdad pasó: cada tarea terminada deja una observación
 * (minutos, paradas, unidades) y de ese conjunto sale el trío por mínimos cuadrados.
 *
 * Dos cosas que este módulo hace y que suelen olvidarse:
 *
 *   1. **Descarta antes de aprender.** Un modelo entrenado sobre el ritmo del agente
 *      de IA, sobre un reloj corrido o sobre la tarea que alguien dejó abierta
 *      durante el almuerzo no describe a nadie. La higiene no es un detalle de
 *      implementación: es la diferencia entre aprender y memorizar ruido.
 *   2. **Devuelve rangos, no puntos.** Un promedio sirve para repartir carga; para
 *      comprometerse con un cliente hace falta el p90, porque prometer la mediana
 *      significa incumplir la mitad de las veces.
 *
 * Módulo puro: sin repositorios, sin reloj, sin I/O.
 */

import { TaskTimeCoefficients, TaskTimeSource, estimarMinutos, modeloPorDefecto } from './task-time';

/** Una tarea terminada, reducida a lo que el modelo necesita. */
export interface Observacion {
  stage: string;
  operator: string;
  /** Duración real de la ejecución (STARTED → DONE), en minutos. */
  minutos: number;
  /** Ubicaciones visitadas. */
  lines: number;
  /** Unidades efectivamente ejecutadas. */
  units: number;
  /** Cuándo terminó: las muestras recientes pesan más. */
  at: string;
}

/** Por qué se descartó una observación. Se cuenta para poder explicarlo, no se esconde. */
export type MotivoDescarte =
  | 'duracion_imposible'    // bajo el piso o sobre el techo
  | 'actor_no_humano'       // el agente, el sistema, el copiloto
  | 'sin_trabajo'           // cero unidades y cero paradas: no hay nada que explicar
  | 'incompleta';           // le falta inicio o fin

/** Actores cuyo ritmo no describe a una persona y no puede entrar al modelo. */
export const ACTORES_NO_HUMANOS: ReadonlySet<string> = new Set(['system', 'agente', 'copiloto', 'scheduler', 'auto-balance', 'oms', 'webhook']);

/** Una ejecución de menos de medio minuto o de más de cuatro horas no es una tarea. */
const MIN_MINUTOS = 0.5;
const MAX_MINUTOS = 4 * 60;

/**
 * Muestras mínimas para confiar en un ajuste propio.
 *
 * Treinta no es un número mágico: es el punto donde tres coeficientes dejan de estar
 * sobre-determinados por un puñado de casos. Por debajo, el modelo heredado de la
 * plataforma describe mejor la realidad que uno entrenado con diez tareas de un día raro.
 */
export const MIN_MUESTRAS = 30;

/**
 * Separa lo que sirve de lo que contamina, y dice por qué.
 *
 * Nada se corrige ni se “arregla”: una muestra sospechosa se deja fuera del ajuste y
 * se cuenta. Si un día el 40% queda fuera, eso es un problema de instrumentación que
 * hay que ver, no un número que convenga suavizar.
 */
export function filtrarObservaciones(obs: Observacion[]): { utiles: Observacion[]; descartes: Record<MotivoDescarte, number> } {
  const descartes: Record<MotivoDescarte, number> = { duracion_imposible: 0, actor_no_humano: 0, sin_trabajo: 0, incompleta: 0 };
  const utiles: Observacion[] = [];
  for (const o of obs) {
    if (!(o.minutos > 0) || !Number.isFinite(o.minutos)) { descartes.incompleta += 1; continue; }
    if (ACTORES_NO_HUMANOS.has(String(o.operator).toLowerCase())) { descartes.actor_no_humano += 1; continue; }
    if (o.minutos < MIN_MINUTOS || o.minutos > MAX_MINUTOS) { descartes.duracion_imposible += 1; continue; }
    if (!(o.units > 0) && !(o.lines > 0)) { descartes.sin_trabajo += 1; continue; }
    utiles.push(o);
  }
  return { utiles, descartes };
}

/** Resuelve A·x = b para 3 incógnitas (eliminación de Gauss con pivoteo parcial). */
function resolver3x3(A: number[][], b: number[]): number[] | null {
  const M = A.map((fila, i) => [...fila, b[i]]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let f = col + 1; f < 3; f++) if (Math.abs(M[f][col]) > Math.abs(M[piv][col])) piv = f;
    if (Math.abs(M[piv][col]) < 1e-9) return null; // sistema degenerado: no hay variación suficiente
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let f = 0; f < 3; f++) {
      if (f === col) continue;
      const k = M[f][col] / M[col][col];
      for (let c = col; c < 4; c++) M[f][c] -= k * M[col][c];
    }
  }
  return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
}

/**
 * Ajusta `minutos ≈ a + b·paradas + c·unidades` por mínimos cuadrados ponderados.
 *
 * El peso decae con la antigüedad (vida media de 30 días): una bodega cambia de
 * layout, de gente y de mezcla de productos, y lo de hace dos meses describe una
 * operación que ya no existe. No se descarta lo viejo —se le hace pesar menos.
 *
 * Los coeficientes negativos se rechazan en vez de usarse: que una tarea demore MENOS
 * por tener más unidades es un artefacto del ajuste, no un hallazgo. Cuando pasa, se
 * devuelve null y el llamador cae al modelo de arriba en la jerarquía.
 */
export function ajustarCoeficientes(obs: Observacion[], nowMs: number): { coef: TaskTimeCoefficients; samples: number; errorMedioMin: number } | null {
  if (obs.length < 3) return null;
  const VIDA_MEDIA_DIAS = 30;
  const peso = (at: string): number => {
    const dias = Math.max(0, (nowMs - Date.parse(at)) / 86400000);
    return Number.isFinite(dias) ? Math.pow(0.5, dias / VIDA_MEDIA_DIAS) : 1;
  };

  // Ecuaciones normales de la regresión con término independiente.
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  const y = [0, 0, 0];
  for (const o of obs) {
    const w = peso(o.at);
    const x = [1, Math.max(1, o.lines), Math.max(0, o.units)];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) A[i][j] += w * x[i] * x[j];
      y[i] += w * x[i] * o.minutos;
    }
  }
  const sol = resolver3x3(A, y);
  if (!sol) return null;
  const [setupMin, perLineMin, perUnitMin] = sol;
  // Un coeficiente negativo o absurdo invalida el ajuste completo: preferimos no
  // aprender a aprender algo que no se sostiene.
  if (![setupMin, perLineMin, perUnitMin].every((v) => Number.isFinite(v) && v >= 0 && v < 240)) return null;

  const coef: TaskTimeCoefficients = {
    setupMin: Math.round(setupMin * 100) / 100,
    perLineMin: Math.round(perLineMin * 100) / 100,
    perUnitMin: Math.round(perUnitMin * 100) / 100,
  };
  // Error medio absoluto: cuánto se equivoca el modelo, en minutos. Es la cifra con
  // la que se compara contra lo anterior para saber si aprender sirvió de algo.
  const err = obs.reduce((s, o) => s + Math.abs(estimarMinutos(coef, { lines: o.lines, units: o.units }) - o.minutos), 0) / obs.length;
  return { coef, samples: obs.length, errorMedioMin: Math.round(err * 100) / 100 };
}

/**
 * Cuánto se estira una estimación para cubrir al 90% de los casos.
 *
 * Se calcula sobre los residuos relativos (real ÷ estimado) y no sobre los absolutos:
 * equivocarse 5 minutos en una tarea de 8 y en una de 90 no es el mismo error. El
 * resultado es un multiplicador ≥ 1 que se aplica al p50 para obtener el p90.
 */
export function factorP90(obs: Observacion[], coef: TaskTimeCoefficients): number {
  const ratios: number[] = [];
  for (const o of obs) {
    const est = estimarMinutos(coef, { lines: o.lines, units: o.units });
    if (est > 0) ratios.push(o.minutos / est);
  }
  if (ratios.length < 5) return 1.5; // sin evidencia, un margen prudente y declarado
  ratios.sort((a, b) => a - b);
  const idx = Math.min(ratios.length - 1, Math.floor(ratios.length * 0.9));
  return Math.max(1, Math.round(ratios[idx] * 100) / 100);
}

/**
 * Factor personal de un operario: cuánto se desvía del modelo de su bodega.
 *
 * Es un multiplicador y no un modelo propio a propósito: una sola persona casi nunca
 * junta muestras para estimar tres coeficientes con sentido, pero sí para estimar un
 * número. Se acota entre 0,5 y 2 para que una semana rara no lo mande a asignarle
 * todo el trabajo a alguien, y exige un mínimo de tareas para existir.
 */
export function factorDeOperario(obs: Observacion[], coef: TaskTimeCoefficients, minTareas = 10): number | null {
  const suyas = obs.filter((o) => o.minutos > 0);
  if (suyas.length < minTareas) return null;
  const ratios = suyas
    .map((o) => ({ real: o.minutos, est: estimarMinutos(coef, { lines: o.lines, units: o.units }) }))
    .filter((r) => r.est > 0)
    .map((r) => r.real / r.est)
    .sort((a, b) => a - b);
  if (!ratios.length) return null;
  // Mediana, no promedio: una tarea que quedó abierta toda la tarde no puede mover
  // el factor de una persona.
  const mid = Math.floor(ratios.length / 2);
  const mediana = ratios.length % 2 ? ratios[mid] : (ratios[mid - 1] + ratios[mid]) / 2;
  return Math.min(2, Math.max(0.5, Math.round(mediana * 100) / 100));
}

/**
 * La jerarquía completa: el modelo del operario, el de su bodega, el de la plataforma
 * y, al final, el declarado. Nunca devuelve nada: siempre hay una estimación, y
 * siempre dice de dónde salió y con cuántas muestras.
 *
 * Que el origen viaje con la cifra importa: "estimado con 340 tareas de esta bodega"
 * y "valor por defecto, aún sin datos" no merecen la misma confianza, y quien decide
 * mirando la pantalla tiene que poder notarlo sin preguntar.
 */
export function resolverModelo(
  stage: string,
  candidatos: { operacion?: { coef: TaskTimeCoefficients; samples: number } | null; plataforma?: { coef: TaskTimeCoefficients; samples: number } | null; factorOperario?: number | null },
): { coef: TaskTimeCoefficients; source: TaskTimeSource; samples: number; factor: number } {
  const factor = candidatos.factorOperario ?? 1;
  if (candidatos.operacion && candidatos.operacion.samples >= MIN_MUESTRAS) {
    return { coef: candidatos.operacion.coef, source: candidatos.factorOperario ? 'operario' : 'operacion', samples: candidatos.operacion.samples, factor };
  }
  if (candidatos.plataforma && candidatos.plataforma.samples >= MIN_MUESTRAS) {
    return { coef: candidatos.plataforma.coef, source: 'plataforma', samples: candidatos.plataforma.samples, factor };
  }
  return { coef: modeloPorDefecto(stage).coef, source: 'defecto', samples: 0, factor };
}
