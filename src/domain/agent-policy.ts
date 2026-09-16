import { SCHEDULE_DEFAULT } from './agent-schedule';
/**
 * Política de autonomía del agente (Fase 1 del agente autónomo).
 *
 * La autonomía NO es un interruptor global: cada acción declara el nivel mínimo que
 * requiere, si es reversible y si necesita evidencia física. La operación fija hasta qué
 * nivel permite (autonomyLevel) y si el agente corre en modo sombra (decide y registra,
 * pero no ejecuta). La decisión final para cada acción es una de tres:
 *   - 'execute'  → se ejecuta ahora
 *   - 'propose'  → queda propuesta para que un humano confirme
 *   - 'deny'     → no se puede (sin permisos / agente pausado)
 *
 * Niveles:
 *   0 Observador   — solo vigila y propone.
 *   1 Asistido     — ejecuta lo reversible que prepara el trabajo (asignar, balancear).
 *   2 Supervisado  — además cierra pasos administrativos con evidencia (avanzar órdenes,
 *                    crear recepciones/órdenes, configurar automatismos).
 *   3 Autónomo     — todo lo anterior sin confirmación, dentro de límites; escala excepciones.
 */
import { CopilotSettings } from './ports';

export type AgentAutonomyLevel = 0 | 1 | 2 | 3;
export type PolicyDecision = 'execute' | 'propose' | 'deny';

export interface ActionPolicy {
  /** Nombre de la herramienta de acción del copiloto. */
  tool: string;
  /** Nivel mínimo de autonomía para ejecutar SIN confirmación humana. */
  minLevel: AgentAutonomyLevel;
  /** Si la acción tiene inversa conocida (se puede deshacer). */
  reversible: boolean;
  /** Si exige evidencia física (escaneo/confirmación de operario) para ser automática. */
  requiresEvidence: boolean;
  /** Categoría para límites y reporting. */
  category: 'workload' | 'order' | 'inbound' | 'returns' | 'comms' | 'config' | 'memory';
  label: string;
}

export const ACTION_POLICIES: ActionPolicy[] = [
  { tool: 'asignar_tarea',          minLevel: 1, reversible: true,  requiresEvidence: false, category: 'workload', label: 'Asignar tarea a operario' },
  { tool: 'balancear_carga',        minLevel: 1, reversible: true,  requiresEvidence: false, category: 'workload', label: 'Balancear carga' },
  { tool: 'reasignar_ociosidad',    minLevel: 1, reversible: true,  requiresEvidence: false, category: 'workload', label: 'Reasignar por ociosidad' },
  { tool: 'liberar_inactivos',      minLevel: 1, reversible: true,  requiresEvidence: false, category: 'workload', label: 'Liberar carga de operarios inactivos' },
  { tool: 'asignar_a_ociosos',      minLevel: 1, reversible: true,  requiresEvidence: false, category: 'workload', label: 'Asignar carga a operarios sin trabajo' },
  { tool: 'vaciar_operario',        minLevel: 1, reversible: true,  requiresEvidence: false, category: 'workload', label: 'Dejar a un operario sin tareas' },
  { tool: 'atender_deadline_riesgo', minLevel: 1, reversible: true, requiresEvidence: false, category: 'workload', label: 'Atender los compromisos en riesgo (asignar / priorizar)' },
  { tool: 'guardar_instruccion',    minLevel: 1, reversible: true,  requiresEvidence: false, category: 'memory',   label: 'Guardar instrucción' },
  { tool: 'activar_auto_balanceo',  minLevel: 2, reversible: true,  requiresEvidence: false, category: 'config',   label: 'Auto-balanceo continuo' },
  { tool: 'fijar_modo_asignacion',  minLevel: 2, reversible: true,  requiresEvidence: false, category: 'config',   label: 'Modo de asignación' },
  { tool: 'crear_recepcion',        minLevel: 2, reversible: true,  requiresEvidence: false, category: 'inbound',  label: 'Crear recepción' },
  { tool: 'crear_orden',            minLevel: 2, reversible: true,  requiresEvidence: false, category: 'order',    label: 'Crear orden' },
  { tool: 'avanzar_estado_orden',   minLevel: 2, reversible: false, requiresEvidence: true,  category: 'order',    label: 'Avanzar estado de orden' },
  { tool: 'fijar_deadline_orden',   minLevel: 2, reversible: true,  requiresEvidence: false, category: 'order',    label: 'Fijar deadline de preparación' },
  // ---- v111: el copiloto pasa de crear cosas a media máquina a cerrar los flujos ----
  // Nivel 1 = reversible de verdad (la tarea vuelve al pool y se reasigna).
  { tool: 'liberar_asignacion',     minLevel: 1, reversible: true,  requiresEvidence: false, category: 'workload', label: 'Liberar una tarea asignada' },
  { tool: 'asignar_tareas_masivo',  minLevel: 1, reversible: true,  requiresEvidence: false, category: 'workload', label: 'Asignar varias tareas de una vez' },
  // Nivel 2 = toca stock, plata o al cliente: en modo confirmación queda propuesta.
  { tool: 'reservar_ordenes',       minLevel: 2, reversible: true,  requiresEvidence: false, category: 'order',    label: 'Reservar stock de varias órdenes' },
  { tool: 'cancelar_orden',         minLevel: 2, reversible: true,  requiresEvidence: true,  category: 'order',    label: 'Cancelar una orden' },
  { tool: 'reactivar_orden',        minLevel: 2, reversible: true,  requiresEvidence: false, category: 'order',    label: 'Reactivar una orden cancelada' },
  { tool: 'recibir_recepcion',      minLevel: 2, reversible: false, requiresEvidence: true,  category: 'inbound',  label: 'Recibir mercadería contra una recepción' },
  { tool: 'cerrar_recepcion',       minLevel: 2, reversible: false, requiresEvidence: false, category: 'inbound',  label: 'Cerrar una recepción' },
  { tool: 'crear_devolucion',       minLevel: 2, reversible: true,  requiresEvidence: false, category: 'returns',  label: 'Abrir una devolución' },
  { tool: 'procesar_devolucion',    minLevel: 2, reversible: false, requiresEvidence: true,  category: 'returns',  label: 'Procesar una devolución (mueve stock)' },
  { tool: 'cancelar_devolucion',    minLevel: 2, reversible: true,  requiresEvidence: false, category: 'returns',  label: 'Cancelar una devolución' },
  { tool: 'mensaje_a_operario',     minLevel: 2, reversible: false, requiresEvidence: false, category: 'comms',    label: 'Mandar un mensaje a un operario' },
  { tool: 'recibir_insumos_embalaje', minLevel: 2, reversible: false, requiresEvidence: true, category: 'inbound', label: 'Ingresar insumos de embalaje' },
];

export function actionPolicy(tool: string): ActionPolicy | undefined {
  return ACTION_POLICIES.find((p) => p.tool === tool);
}

/** Ajustes del agente con sus valores por defecto (nivel 1, sombra encendida). */
export const AGENT_DEFAULTS = {
  autonomyLevel: 1 as AgentAutonomyLevel,
  shadowMode: true,
  paused: false,
  maxActionsPerCycle: 20,
  maxActionsPerHour: 100,
  llmPlanning: false,
  llmEveryMin: 15,
  maxLlmCallsPerDay: 100,
};

export function effectiveAgentSettings(s: CopilotSettings | null, operationId: string): Required<CopilotSettings> {
  return {
    operationId,
    actionMode: s?.actionMode === 'direct' ? 'direct' : 'confirm',
    autonomyLevel: (s?.autonomyLevel ?? AGENT_DEFAULTS.autonomyLevel) as AgentAutonomyLevel,
    shadowMode: s?.shadowMode ?? AGENT_DEFAULTS.shadowMode,
    paused: s?.paused ?? AGENT_DEFAULTS.paused,
    maxActionsPerCycle: s?.maxActionsPerCycle ?? AGENT_DEFAULTS.maxActionsPerCycle,
    maxActionsPerHour: s?.maxActionsPerHour ?? AGENT_DEFAULTS.maxActionsPerHour,
    notifyEmail: s?.notifyEmail ?? null,
    notifyWebhookUrl: s?.notifyWebhookUrl ?? null,
    llmPlanning: s?.llmPlanning ?? AGENT_DEFAULTS.llmPlanning,
    llmEveryMin: s?.llmEveryMin ?? AGENT_DEFAULTS.llmEveryMin,
    maxLlmCallsPerDay: s?.maxLlmCallsPerDay ?? AGENT_DEFAULTS.maxLlmCallsPerDay,
    agenda: s?.agenda ?? SCHEDULE_DEFAULT,
  };
}

export interface PolicyInput {
  tool: string;
  settings: Required<CopilotSettings>;
  /** true si quien actúa es el agente (ciclo automático); false si es un humano vía copiloto. */
  autonomous: boolean;
  /** El humano ya confirmó explícitamente esta acción (botón confirmar). */
  confirmed?: boolean;
  /** Acciones ya ejecutadas por el agente en el ciclo actual / última hora (límites). */
  usage?: { cycle: number; hour: number };
}

export interface PolicyResult { decision: PolicyDecision; reason: string; policy: ActionPolicy | null; }

/**
 * Decide qué hacer con una acción.
 *  - Humano confirmando → execute (los permisos ya se validaron antes).
 *  - Agente pausado → deny.
 *  - Modo sombra (solo para el agente autónomo) → propose, siempre.
 *  - Nivel de autonomía < nivel mínimo de la acción → propose.
 *  - Humano vía copiloto en modo 'confirm' → las acciones de nivel ≥ 2 quedan propuestas
 *    (así "confirmación" protege TODAS las escrituras relevantes, no solo el avance de
 *    órdenes); las de nivel 1 (reversibles: asignar, balancear) se ejecutan.
 *  - Límites por ciclo / hora superados (agente) → propose.
 */
export function decidePolicy(input: PolicyInput): PolicyResult {
  const policy = actionPolicy(input.tool) ?? null;
  if (input.confirmed) return { decision: 'execute', reason: 'confirmada por un humano', policy };
  if (!policy) return { decision: 'propose', reason: 'acción sin política definida: requiere confirmación', policy };
  const s = input.settings;
  if (input.autonomous && s.paused) return { decision: 'deny', reason: 'el agente está en pausa', policy };
  if (input.autonomous && s.shadowMode) return { decision: 'propose', reason: 'modo sombra: se registra sin ejecutar', policy };
  if (s.autonomyLevel < policy.minLevel) return { decision: 'propose', reason: `requiere nivel ${policy.minLevel} (operación en nivel ${s.autonomyLevel})`, policy };
  if (input.autonomous && input.usage) {
    if (input.usage.cycle >= s.maxActionsPerCycle) return { decision: 'propose', reason: `límite de ${s.maxActionsPerCycle} acciones por ciclo alcanzado`, policy };
    if (input.usage.hour >= s.maxActionsPerHour) return { decision: 'propose', reason: `límite de ${s.maxActionsPerHour} acciones por hora alcanzado`, policy };
  }
  if (!input.autonomous && s.actionMode === 'confirm' && policy.minLevel >= 2) {
    return { decision: 'propose', reason: 'modo confirmación: queda propuesta', policy };
  }
  return { decision: 'execute', reason: input.autonomous ? `nivel ${s.autonomyLevel} permite ejecutar` : 'ejecución directa', policy };
}

/** Resumen legible de la política para el contexto del LLM. */
export function describePolicy(s: Required<CopilotSettings>): string {
  const lvl = ['0 observador (solo propone)', '1 asistido (ejecuta asignar/balancear; el resto propone)', '2 supervisado (además avanza órdenes, crea recepciones/órdenes y configura automatismos)', '3 autónomo (todo dentro de límites)'][s.autonomyLevel];
  return `Nivel de autonomía ${lvl}. ${s.shadowMode ? 'MODO SOMBRA activo: el agente registra lo que haría sin ejecutar.' : 'Ejecución real.'} ${s.paused ? 'AGENTE EN PAUSA.' : ''} Límites: ${s.maxActionsPerCycle} acciones por ciclo, ${s.maxActionsPerHour} por hora.`.trim();
}
