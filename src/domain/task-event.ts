/**
 * Libro de eventos de tarea (append-only).
 * ---------------------------------------------------------------------------
 * Hasta ahora una tarea era UNA FILA que se sobrescribía. Cada reasignación pisaba
 * al operario anterior; cada liberación pisaba `completedAt`. Si una tarea rebotó
 * entre tres personas antes de completarse, el sistema solo sabía de la última: la
 * historia no se perdía por falta de espacio, se perdía porque el modelo no la
 * guardaba.
 *
 * Acá cada transición deja una fila y ninguna reemplaza a otra. `WorkTask` y
 * `WorkAssignment` siguen existiendo —se leen rápido y las pantallas no cambian—
 * pero dejan de ser la verdad: pasan a ser PROYECCIONES reconstruibles desde estos
 * eventos. Esa es la diferencia entre un sistema que muestra un estado y uno
 * auditable: no hay forma de cambiar el pasado sin que quede el evento que lo cambió.
 *
 * Módulo puro: sin repositorios, sin reloj del sistema, sin I/O.
 */

/**
 * Qué le pasó a la tarea.
 *
 * `TAKEN` y `ASSIGNED` son distintos a propósito: uno es el operario que se ofrece,
 * el otro es el supervisor que reparte. Confundirlos borra quién decidió qué, que es
 * justamente lo que se quiere poder auditar.
 */
export type TaskEventType =
  | 'CREATED'      // la tarea nace en el pool, sin dueño
  | 'ASSIGNED'     // alguien se la da a un operario
  | 'TAKEN'        // el operario la toma del pool por su cuenta
  | 'REASSIGNED'   // cambia de dueño (queda de quién a quién)
  | 'STARTED'      // el operario empieza a trabajarla
  | 'PAUSED'
  | 'RESUMED'
  | 'PROGRESS'     // avance parcial: tantas unidades, en tal ubicación
  | 'RELEASED'     // vuelve al pool sin terminar
  | 'DONE'
  | 'CANCELLED';

/** Etapas del ciclo, en los mismos términos que `WorkTaskStage`. */
export type TaskEventStage = string;

export interface TaskEvent {
  id: string;
  operationId: string;
  sellerId: string | null;
  /** Tarea del ledger a la que pertenece. null si el evento nació de una asignación suelta. */
  taskId: string | null;
  /** Asignación involucrada, cuando la hay. */
  assignmentId: string | null;
  /** Etapa (PICK, PACK, PUTAWAY…), copiada acá para poder consultar sin ir a la tarea. */
  stage: TaskEventStage;
  /** Entidad sobre la que se trabaja: orden, sku@ubicación, plan de conteo. */
  entityId: string;
  entityRef: string | null;
  type: TaskEventType;
  /** Hora del SERVIDOR. Es la que manda para ordenar y medir. */
  at: string;
  /**
   * Hora que declaró el dispositivo del operario, cuando el evento vino de la app.
   * No se usa para medir: sirve para detectar un reloj corrido y descartar la muestra.
   */
  clientAt: string | null;
  /** Quién ejecutó la transición. */
  actor: string;
  /**
   * A quién le ocurre, cuando no es el mismo que la ejecuta: en `ASSIGNED` es el
   * operario que recibe la tarea, no el supervisor que la reparte.
   */
  subject: string | null;
  /** Avance concreto del evento, cuando aplica (PROGRESS, DONE). */
  units: number | null;
  lines: number | null;
  locationId: string | null;
  sku: string | null;
  /** Motivo, para las transiciones que lo tienen (liberación, cancelación, rebalanceo). */
  reason: string | null;
}

/** Los eventos que cierran una tarea: después de uno de estos no debería venir nada. */
export const EVENTOS_TERMINALES: ReadonlySet<TaskEventType> = new Set<TaskEventType>(['DONE', 'CANCELLED']);

/** Los eventos que ponen (o cambian) el dueño de la tarea. */
export const EVENTOS_DE_DUENO: ReadonlySet<TaskEventType> = new Set<TaskEventType>(['ASSIGNED', 'TAKEN', 'REASSIGNED']);

/**
 * El estado de una tarea reconstruido desde sus eventos.
 *
 * Esto es lo que hace que la fila sea una proyección y no la fuente: si alguna vez la
 * fila y los eventos discrepan, mandan los eventos, porque son los que no se pisan.
 */
export interface TaskProjection {
  taskId: string | null;
  stage: TaskEventStage;
  entityId: string;
  entityRef: string | null;
  /** Dueño actual. null = está en el pool. */
  operator: string | null;
  estado: 'pending' | 'assigned' | 'in_progress' | 'done' | 'cancelled';
  createdAt: string | null;
  /** Cuándo se le dio (o la tomó) por PRIMERA vez. */
  assignedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  completedBy: string | null;
  /** Unidades efectivamente ejecutadas, sumando los avances. */
  unitsDone: number;
  /** Cuántas veces cambió de dueño después de la primera asignación. */
  rebotes: number;
  /** Quiénes la tuvieron, en orden de llegada. */
  duenos: string[];
  eventos: number;
}

/**
 * Reconstruye el estado de una tarea desde su historia.
 *
 * Los eventos llegan en cualquier orden y se ordenan por `at` acá: el orden de
 * inserción no es confiable cuando hay varias instancias escribiendo.
 */
export function proyectarTarea(eventos: TaskEvent[]): TaskProjection | null {
  if (!eventos.length) return null;
  const evs = [...eventos].sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  const primero = evs[0];
  const p: TaskProjection = {
    taskId: primero.taskId,
    stage: primero.stage,
    entityId: primero.entityId,
    entityRef: primero.entityRef,
    operator: null,
    estado: 'pending',
    createdAt: null,
    assignedAt: null,
    startedAt: null,
    completedAt: null,
    completedBy: null,
    unitsDone: 0,
    rebotes: 0,
    duenos: [],
    eventos: evs.length,
  };
  for (const e of evs) {
    if (e.entityRef && !p.entityRef) p.entityRef = e.entityRef;
    if (e.taskId && !p.taskId) p.taskId = e.taskId;
    switch (e.type) {
      case 'CREATED':
        p.createdAt = p.createdAt ?? e.at;
        p.estado = 'pending';
        break;
      case 'ASSIGNED':
      case 'TAKEN':
      case 'REASSIGNED': {
        const nuevo = e.subject || e.actor;
        // Un rebote es un cambio de dueño, no la primera entrega. Reasignar a la
        // misma persona (pasa con el auto-balanceo) tampoco cuenta.
        if (p.operator && nuevo !== p.operator) p.rebotes += 1;
        p.operator = nuevo;
        if (nuevo && p.duenos[p.duenos.length - 1] !== nuevo) p.duenos.push(nuevo);
        p.assignedAt = p.assignedAt ?? e.at;
        if (p.estado !== 'in_progress') p.estado = 'assigned';
        break;
      }
      case 'STARTED':
        // Solo la PRIMERA vez: un reingreso a la tarea no debe borrar el rato que
        // llevaba trabajándose, que es justamente lo que se quiere medir.
        p.startedAt = p.startedAt ?? e.at;
        p.estado = 'in_progress';
        break;
      case 'RESUMED':
        p.estado = 'in_progress';
        break;
      case 'PROGRESS':
        p.unitsDone += Math.max(0, e.units || 0);
        p.estado = 'in_progress';
        break;
      case 'RELEASED':
        p.operator = null;
        p.estado = 'pending';
        break;
      case 'DONE':
        p.unitsDone += Math.max(0, e.units || 0);
        p.completedAt = e.at;
        p.completedBy = e.actor;
        p.estado = 'done';
        break;
      case 'CANCELLED':
        p.completedAt = e.at;
        p.completedBy = e.actor;
        p.estado = 'cancelled';
        break;
      default:
        break;
    }
  }
  return p;
}

/**
 * Los tres intervalos de una tarea, en minutos. Es la respuesta a "¿esto se atrasó
 * por espera o por ejecución?", que hoy el sistema no puede distinguir porque mide
 * latencia de estado de la orden y la llama tiempo de preparación.
 *
 *   espera    = desde que nació hasta que alguien la tomó
 *   arranque  = desde que se la dieron hasta que la empezó (el rato en su bandeja)
 *   ejecucion = desde que la empezó hasta que la terminó
 */
export function tiemposDeTarea(p: TaskProjection): { esperaMin: number | null; arranqueMin: number | null; ejecucionMin: number | null; totalMin: number | null } {
  const min = (a: string | null, b: string | null): number | null => {
    if (!a || !b) return null;
    const d = Date.parse(b) - Date.parse(a);
    return Number.isNaN(d) ? null : Math.round((d / 60000) * 10) / 10;
  };
  return {
    esperaMin: min(p.createdAt, p.assignedAt),
    arranqueMin: min(p.assignedAt, p.startedAt),
    ejecucionMin: min(p.startedAt, p.completedAt),
    totalMin: min(p.createdAt, p.completedAt),
  };
}
