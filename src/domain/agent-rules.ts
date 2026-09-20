/**
 * Definiciones (catálogo) de las reglas del agente proactivo — Fase 1 (solo AVISAR).
 * La lógica de evaluación vive en el facade (runAgentSweep); aquí solo el catálogo y sus
 * valores por defecto. La configuración por operación (encendido/umbral/…) se persiste
 * aparte (AgentRuleConfig), de modo que estas definiciones son estables y versionables.
 */
import { AgentRuleSeverity } from './types';

/** Herramientas que una regla puede ejecutar automáticamente (Fase 3). Reversibles y auditadas. */
export type AgentActionTool =
  | 'liberar_inactivos'
  | 'balancear_carga'
  | 'asignar_a_ociosos'
  | 'atender_deadline_riesgo'
  | 'atender_guardado'
  | 'atender_recepciones'
  | 'atender_reposicion';

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
    key: 'deadline_riesgo',
    name: 'Deadline de preparación en riesgo',
    description: 'Órdenes abiertas cuyo compromiso de salida (corte del courier o SLA del cliente) vence dentro de N horas o ya venció.',
    unit: 'horas', defaultThreshold: 2, defaultSeverity: 'crit', defaultCooldownMin: 45, link: 'pickqueue',
    // Escalada en dos pasos: primero un operario libre la toma ya; si no queda
    // ninguno, se asigna igual pero con prioridad máxima en la bandeja.
    autoAction: { tool: 'atender_deadline_riesgo', label: 'Paso 1: asignar a operario activo sin tareas · Paso 2: asignar con prioridad máxima a operario activo' },
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
    key: 'operario_ocioso',
    name: 'Operario activo sin carga',
    description: 'Operarios activos sin tareas abiertas mientras hay trabajo pendiente sin asignar.',
    unit: 'mínimo', defaultThreshold: 1, defaultSeverity: 'warn', defaultCooldownMin: 30, link: 'asignaciones',
    autoAction: { tool: 'asignar_a_ociosos', label: 'Asignarle carga balanceando entre operarios activos' },
  },
  {
    key: 'lote_por_vencer',
    name: 'Lote por vencer (FEFO)',
    description: 'Lotes con saldo cuyo vencimiento está próximo o ya venció.',
    unit: 'días', defaultThreshold: 14, defaultSeverity: 'warn', defaultCooldownMin: 1440, link: 'inventory',
  },
  // ---- Flujo de entrada y de vuelta a ubicación -----------------------------
  // Tres cuellos de botella clásicos que no miran las reglas de órdenes: la
  // mercadería que llegó pero todavía no es vendible, la recepción que quedó a
  // medio cotejar, y el stock que volvió de una cancelación y no regresó a su sitio.
  {
    key: 'guardado_pendiente',
    name: 'Mercadería sin guardar',
    description: 'Stock esperando guardado en zona de recepción hace más de N horas. Mientras siga ahí NO es reservable: aparecen quiebres que no son reales.',
    unit: 'horas', defaultThreshold: 4, defaultSeverity: 'crit', defaultCooldownMin: 60, link: 'putaway',
    autoAction: { tool: 'atender_guardado', label: 'Repartir el guardado pendiente entre operarios activos' },
  },
  {
    key: 'recepcion_abierta',
    name: 'Recepción abierta sin cerrar',
    description: 'Recepciones pendientes o parciales que llevan demasiadas horas sin terminar de cotejarse.',
    unit: 'horas', defaultThreshold: 8, defaultSeverity: 'warn', defaultCooldownMin: 120, link: 'inbound',
    autoAction: { tool: 'atender_recepciones', label: 'Asignar las recepciones abiertas a operarios activos' },
  },
  {
    key: 'reposicion_pendiente',
    name: 'Reposición pendiente',
    description: 'Mercadería que volvió de una orden cancelada y sigue en la ubicación de reposición sin regresar a su sitio.',
    unit: 'horas', defaultThreshold: 12, defaultSeverity: 'warn', defaultCooldownMin: 180, link: 'putaway',
    autoAction: { tool: 'atender_reposicion', label: 'Repartir la reposición pendiente entre operarios activos' },
  },
  // ---- Insumos, devoluciones y calidad de la data ---------------------------
  {
    key: 'embalaje_bajo',
    name: 'Insumo de embalaje por agotarse',
    description: 'Insumos de embalaje bajo su stock mínimo. Sin cajas no se despacha, aunque todo lo demás esté listo.',
    unit: 'mínimo', defaultThreshold: 20, defaultSeverity: 'crit', defaultCooldownMin: 720, link: 'packaging',
  },
  {
    key: 'devolucion_sin_procesar',
    name: 'Devolución sin procesar',
    description: 'Devoluciones recibidas hace más de N horas que siguen sin resolverse (el stock no vuelve a estar disponible hasta que se procesan).',
    unit: 'horas', defaultThreshold: 24, defaultSeverity: 'warn', defaultCooldownMin: 240, link: 'returns',
  },
  {
    key: 'ordenes_duplicadas',
    name: 'Órdenes duplicadas',
    description: 'Mismo cliente y misma referencia externa en más de una orden: riesgo de preparar y despachar dos veces.',
    unit: 'mínimo', defaultThreshold: 1, defaultSeverity: 'crit', defaultCooldownMin: 360, link: 'orders',
  },
];

export function agentRuleDef(key: string): AgentRuleDef | undefined {
  return AGENT_RULES.find((r) => r.key === key);
}
