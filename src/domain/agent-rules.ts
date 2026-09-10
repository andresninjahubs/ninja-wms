/**
 * Definiciones (catálogo) de las reglas del agente proactivo — Fase 1 (solo AVISAR).
 * La lógica de evaluación vive en el facade (runAgentSweep); aquí solo el catálogo y sus
 * valores por defecto. La configuración por operación (encendido/umbral/…) se persiste
 * aparte (AgentRuleConfig), de modo que estas definiciones son estables y versionables.
 */
import { AgentRuleSeverity } from './types';

/** Herramientas que una regla puede ejecutar automáticamente (Fase 3). Reversibles y auditadas. */
export type AgentActionTool = 'liberar_inactivos' | 'balancear_carga';

export interface AgentRuleDef {
  key: string;
  name: string;
  description: string;
  unit: 'horas' | 'días' | 'mínimo'; // etiqueta del umbral en la UI
  defaultThreshold: number;
  defaultSeverity: AgentRuleSeverity;
  defaultCooldownMin: number;
  link: string; // pantalla del panel a la que lleva la alerta
  // Fase 3: acción automática que puede ejecutar esta regla (si aplica). Sin esto, la
  // regla es solo-aviso y el panel no ofrece "ejecutar".
  autoAction?: { tool: AgentActionTool; label: string };
}

export const AGENT_RULES: AgentRuleDef[] = [
  {
    key: 'orden_estancada',
    name: 'Orden estancada',
    description: 'Órdenes no despachadas ni canceladas detenidas demasiadas horas en su estado.',
    unit: 'horas', defaultThreshold: 24, defaultSeverity: 'crit', defaultCooldownMin: 120, link: 'orders',
    autoAction: { tool: 'balancear_carga', label: 'Balancear el picking entre operarios activos' },
  },
  {
    key: 'sla_despacho',
    name: 'SLA de despacho en riesgo',
    description: 'Órdenes empacadas (PACKED) que llevan demasiado tiempo sin despachar.',
    unit: 'horas', defaultThreshold: 12, defaultSeverity: 'crit', defaultCooldownMin: 90, link: 'orders',
  },
  {
    key: 'quiebre_stock',
    name: 'Quiebre inminente de stock',
    description: 'SKUs cuya cobertura proyectada cae por debajo del umbral de días.',
    unit: 'días', defaultThreshold: 7, defaultSeverity: 'warn', defaultCooldownMin: 720, link: 'inventory',
  },
  {
    key: 'operario_inactivo',
    name: 'Operario inactivo con carga',
    description: 'Operarios inactivos que todavía tienen tareas abiertas sin completar.',
    unit: 'mínimo', defaultThreshold: 1, defaultSeverity: 'warn', defaultCooldownMin: 60, link: 'asignaciones',
    autoAction: { tool: 'liberar_inactivos', label: 'Reasignar su carga a operarios activos' },
  },
  {
    key: 'lote_por_vencer',
    name: 'Lote por vencer (FEFO)',
    description: 'Lotes con saldo cuyo vencimiento está próximo o ya venció.',
    unit: 'días', defaultThreshold: 14, defaultSeverity: 'warn', defaultCooldownMin: 1440, link: 'inventory',
  },
];

export function agentRuleDef(key: string): AgentRuleDef | undefined {
  return AGENT_RULES.find((r) => r.key === key);
}
