/**
 * Modelo de tiempo de una tarea de bodega.
 * ---------------------------------------------------------------------------
 * Hasta ahora todo el sistema estimaba con `unidades ÷ unidades-por-hora`. Ese
 * modelo dice que una orden de 8 unidades demora lo mismo si son 8 unidades del
 * mismo SKU en una ubicación que si son 8 SKU distintos en 8 ubicaciones repartidas
 * en tres pasillos. En una bodega real la segunda demora entre tres y cinco veces
 * más, y la diferencia no es la cantidad: es el desplazamiento.
 *
 * El tiempo de una tarea se descompone en tres pedazos que se comportan distinto:
 *
 *     t = setup + porLinea × líneas + porUnidad × unidades
 *
 *   - `setup`     — costo fijo: tomar la tarea, llegar a la zona, cerrar al final.
 *                   No depende del tamaño.
 *   - `porLinea`  — cada ubicación visitada: caminar hasta ella, buscar, escanear.
 *                   Es el término que el modelo viejo no tenía y el que más explica.
 *   - `porUnidad` — manipular cada unidad una vez que ya estás parado frente a ella.
 *
 * Los coeficientes de arranque están calibrados para que una tarea TÍPICA dé el
 * mismo tiempo que daba la constante anterior: así nada cambia de golpe al activar
 * esto, y lo que cambia es la SENSIBILIDAD a la forma de la tarea. Los valores
 * reales los aprende la Fase 3 desde el libro de eventos; mientras tanto estos son
 * un punto de partida declarado, no una medición.
 *
 * Módulo puro: sin repositorios, sin reloj, sin I/O.
 */

/** Los tres términos, en MINUTOS. */
export interface TaskTimeCoefficients {
  setupMin: number;
  perLineMin: number;
  perUnitMin: number;
}

/**
 * De dónde salieron los coeficientes que se están usando. Viaja con cada estimación
 * a propósito: una cifra estimada con 340 tareas medidas y otra sacada de un valor
 * por defecto no merecen la misma confianza, y quien la lee tiene que poder notarlo.
 */
export type TaskTimeSource = 'operario' | 'operacion' | 'plataforma' | 'defecto';

export interface TaskTimeModel {
  stage: string;
  coef: TaskTimeCoefficients;
  source: TaskTimeSource;
  /** Cuántas tareas medidas respaldan estos coeficientes. 0 = ninguna. */
  samples: number;
  /** Factor personal del operario sobre el modelo de la operación (1 = el promedio). */
  operatorFactor?: number;
}

/**
 * La tarea "típica" de cada etapa, que es contra la que se calibraron los valores de
 * arranque. Está acá y no escondida en un número para que se vea el supuesto: si una
 * bodega no se parece a esto, sus coeficientes van a moverse cuando se aprendan.
 */
const TAREA_TIPICA: Record<string, { lines: number; units: number }> = {
  PICK: { lines: 3, units: 10 },
  PUTAWAY: { lines: 1, units: 10 },
  PACK: { lines: 3, units: 10 },
  SHIP: { lines: 1, units: 10 },
  RECEIVE: { lines: 3, units: 10 },
  COUNT: { lines: 1, units: 10 },
  RESLOT: { lines: 1, units: 10 },
  RESTOCK: { lines: 1, units: 10 },
  OTHER: { lines: 1, units: 10 },
};

/**
 * Coeficientes de arranque por etapa.
 *
 * Cada trío está calibrado para que `estimarMinutos(TAREA_TIPICA[etapa])` dé
 * exactamente lo que daba la tabla de unidades/hora anterior (PICK 80, PUTAWAY 60,
 * PACK 50, RECEIVE 70, COUNT 120, otros 60). Eso lo verifica un test: si alguien
 * toca estos números sin querer, se nota.
 */
const COEF_DEFECTO: Record<string, TaskTimeCoefficients> = {
  //        setup  ×línea  ×unidad     típica → minutos  (equivalente u/h)
  PICK:     { setupMin: 1.5, perLineMin: 1.0,  perUnitMin: 0.3 },  // 3 líneas, 10 un → 7.5 min (80 u/h)
  PUTAWAY:  { setupMin: 2.0, perLineMin: 2.0,  perUnitMin: 0.6 },  // 1 línea,  10 un → 10 min  (60 u/h)
  PACK:     { setupMin: 3.0, perLineMin: 1.0,  perUnitMin: 0.6 },  // 3 líneas, 10 un → 12 min  (50 u/h)
  SHIP:     { setupMin: 3.0, perLineMin: 1.0,  perUnitMin: 0.6 },  // el despacho acompaña al empaque
  RECEIVE:  { setupMin: 2.0, perLineMin: 0.857, perUnitMin: 0.4 }, // 3 líneas, 10 un → 8.571 min (70 u/h)
  COUNT:    { setupMin: 1.5, perLineMin: 1.5,  perUnitMin: 0.2 },  // 1 línea,  10 un → 5 min   (120 u/h)
  RESLOT:   { setupMin: 2.0, perLineMin: 2.0,  perUnitMin: 0.6 },
  RESTOCK:  { setupMin: 2.0, perLineMin: 2.0,  perUnitMin: 0.6 },
  OTHER:    { setupMin: 2.0, perLineMin: 2.0,  perUnitMin: 0.6 },  // 1 línea,  10 un → 10 min  (60 u/h)
};

/** El modelo por defecto de una etapa. Nunca devuelve null: siempre hay una estimación. */
export function modeloPorDefecto(stage: string): TaskTimeModel {
  const coef = COEF_DEFECTO[String(stage).toUpperCase()] || COEF_DEFECTO.OTHER;
  return { stage: String(stage), coef: { ...coef }, source: 'defecto', samples: 0 };
}

/** La tarea típica de una etapa (la usa el test de calibración y el panel al explicar). */
export function tareaTipica(stage: string): { lines: number; units: number } {
  return TAREA_TIPICA[String(stage).toUpperCase()] || TAREA_TIPICA.OTHER;
}

/**
 * Minutos que debería tomar una tarea de esta forma.
 *
 * `lines` es la cantidad de UBICACIONES distintas que hay que visitar, no las líneas
 * del documento: dos líneas del mismo SKU en la misma ubicación son una sola parada.
 * Si no se sabe, se asume 1 — subestima, pero es mejor que descartar la tarea.
 */
export function estimarMinutos(coef: TaskTimeCoefficients, tarea: { lines?: number | null; units?: number | null }): number {
  const lineas = Math.max(1, Math.round(tarea.lines || 1));
  const unidades = Math.max(0, Math.round(tarea.units || 0));
  const min = coef.setupMin + coef.perLineMin * lineas + coef.perUnitMin * unidades;
  return Math.round(min * 100) / 100;
}

/** Lo mismo en horas, que es la unidad con la que trabaja el balanceo de carga. */
export function estimarHoras(coef: TaskTimeCoefficients, tarea: { lines?: number | null; units?: number | null }): number {
  return estimarMinutos(coef, tarea) / 60;
}

/**
 * Aplica el factor personal de un operario: 0.8 = es 20% más rápido que el promedio
 * de su bodega, 1.3 = 30% más lento.
 *
 * Es un multiplicador sobre el modelo de la operación y no un modelo propio por
 * persona a propósito: una sola persona casi nunca junta muestras suficientes para
 * estimar tres coeficientes con sentido, pero sí para estimar un número.
 */
export function conFactor(coef: TaskTimeCoefficients, factor: number | null | undefined): TaskTimeCoefficients {
  const f = factor && factor > 0 ? factor : 1;
  if (f === 1) return coef;
  return {
    setupMin: Math.round(coef.setupMin * f * 100) / 100,
    perLineMin: Math.round(coef.perLineMin * f * 100) / 100,
    perUnitMin: Math.round(coef.perUnitMin * f * 100) / 100,
  };
}

/**
 * La velocidad equivalente en unidades/hora de una tarea concreta.
 *
 * Existe solo para no romper lo que ya lee u/h (paneles, costeo). Ojo con el
 * concepto: en este modelo la velocidad NO es una propiedad del operario, es el
 * resultado de una tarea específica. La misma persona hace 170 u/h sacando 50
 * unidades de una ubicación y 25 u/h sacando 10 unidades de 10 ubicaciones, sin
 * haber cambiado de ritmo. Por eso un número único de u/h por persona engañaba.
 */
export function unidadesPorHoraEquivalente(coef: TaskTimeCoefficients, tarea: { lines?: number | null; units?: number | null }): number | null {
  const unidades = Math.max(0, Math.round(tarea.units || 0));
  if (!unidades) return null;
  const horas = estimarHoras(coef, tarea);
  if (!(horas > 0)) return null;
  return Math.round((unidades / horas) * 10) / 10;
}
