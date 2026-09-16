/**
 * Dashboard AI — orquestación.
 * ---------------------------------------------------------------------------
 * Aquí viven las tres cosas que el tablero necesita y que el dominio puro no puede
 * hacer solo: guardar, traer datos frescos y conversar con el modelo.
 *
 * El modelo recibe: el esquema de widgets, el CATÁLOGO COMPLETO de herramientas de
 * lectura (con su descripción y parámetros) y el tablero actual. Devuelve una lista
 * de operaciones. El servidor las valida una por una antes de guardar: una
 * herramienta inventada o un campo raro se rechaza con su motivo, y eso vuelve al
 * usuario como texto. Nada que diga el modelo llega crudo a la pantalla.
 */
import { AiCredential } from '../domain/ports';
import { askCopilotChat, ChatTurn } from '../domain/copilot-llm';
import { COPILOT_TOOLS } from '../domain/copilot-tools';
import {
  AiDashboard, DashboardPatch, GRID_COLS, Widget, WIDGET_TYPES,
  aplicarPatch, transformar, validarWidget,
} from '../domain/ai-dashboard';
import { WmsFacade } from './wms.facade';

/** Herramientas que un widget puede usar: solo las de LECTURA. */
export function herramientasDeLectura(): string[] {
  return COPILOT_TOOLS.map((t) => t.name);
}

/**
 * Qué puede y qué no puede hacer el tablero, en palabras. Sale del mismo catálogo
 * que usan los widgets, así que nunca queda desactualizado respecto del sistema.
 */
export function capacidades() {
  const grupos: Record<string, string[]> = {
    'Inventario y productos': ['stock_de_sku', 'inventario_resumen', 'kardex_sku', 'catalogo_productos', 'clasificacion_abc', 'demanda_sku', 'lotes_por_vencer', 'ocupacion_ubicaciones', 'conteo_exactitud'],
    'Órdenes y preparación': ['listar_ordenes', 'tareas_de_orden', 'linea_tiempo_orden', 'ordenes_en_riesgo', 'ordenes_por_vencer', 'tiempos_preparacion', 'recepciones', 'devoluciones', 'armados_kit'],
    'Trabajo y operarios': ['operarios', 'carga_operarios', 'productividad_operarios', 'tareas_pendientes'],
    'Dinero': ['facturacion_cliente', 'rentabilidad', 'eficiencia_costos', 'insumos_embalaje'],
    'Dirección y agente': ['metricas_dashboard', 'brief_ejecutivo', 'alertas_activas', 'auditoria_ia', 'contexto_operativo', 'clientes_operacion', 'uso_plataforma', 'mensajes_clientes', 'canal_voz'],
  };
  const porNombre = new Map(COPILOT_TOOLS.map((t) => [t.name, t] as const));
  const usados = new Set<string>();
  const areas = Object.keys(grupos).map((area) => ({
    area,
    fuentes: grupos[area].filter((n) => porNombre.has(n)).map((n) => {
      usados.add(n);
      return { tool: n, descripcion: (porNombre.get(n) as any).description as string };
    }),
  }));
  const otras = COPILOT_TOOLS.filter((t) => !usados.has(t.name)).map((t) => ({ tool: t.name, descripcion: t.description }));
  if (otras.length) areas.push({ area: 'Otras', fuentes: otras });
  return {
    puede: [
      'Crear tarjetas de indicador (KPI), tablas, barras, líneas y listas con cualquiera de los datos de abajo.',
      'Filtrar, agrupar, ordenar y limitar lo que muestra cada widget.',
      'Mover y redimensionar todo en una grilla de 12 columnas, también a mano.',
      'Refrescar los datos solo, cada 30 segundos.',
      'Guardar varios tableros por persona y volver a la versión anterior.',
    ],
    noPuede: [
      'Escribir o cambiar datos de la operación: el tablero es de solo lectura.',
      'Mostrar datos de otra operación o de un cliente que no te corresponda.',
      'Ejecutar código, HTML o consultas SQL libres.',
      'Inventar datos: si algo no se mide todavía, el widget queda vacío y lo dice.',
    ],
    tiposDeWidget: WIDGET_TYPES,
    areas,
  };
}

/** Prompt del sistema: el contrato con el modelo. */
function systemPrompt(dashboard: AiDashboard, catalogo: string): string {
  return [
    'Eres el diseñador de tableros del WMS Ninja. Ayudas a un administrador a armar su panel a medida.',
    '',
    'REGLA PRINCIPAL: nunca escribes HTML, CSS, JavaScript ni SQL. Respondes SOLO con un objeto JSON',
    'con esta forma exacta:',
    '{"mensaje": "<qué hiciste, en una o dos frases, en español>", "ops": [ ...operaciones... ]}',
    '',
    'Operaciones disponibles:',
    '  {"op":"agregar","widget":{...}}                      agrega un widget',
    '  {"op":"modificar","id":"<id>","widget":{...}}        cambia uno existente (solo los campos que cambian)',
    '  {"op":"eliminar","id":"<id>"}                        lo borra',
    '  {"op":"mover","id":"<id>","x":0,"y":0,"ancho":6,"alto":7}',
    '  {"op":"renombrar","nombre":"<nuevo nombre>"}',
    '  {"op":"limpiar"}                                     vacía el tablero',
    '',
    'Forma de un widget:',
    '{ "tipo":"kpi|tabla|barras|lineas|lista|texto", "titulo":"...",',
    '  "x":0, "y":0, "ancho":1..12, "alto":2..24,',
    `  "source": { "tool":"<una herramienta del catálogo>", "args":{...}, "path":"ruta.dentro.de.la.respuesta" },`,
    '  "transform": { "groupBy":"campo", "field":"campo", "agg":"suma|promedio|conteo|maximo|minimo|primero",',
    '                 "sortBy":"campo", "sortDir":"asc|desc", "limit":10,',
    '                 "filter":{"field":"campo","op":"=|!=|>|>=|<|<=|contiene","value":"..."} },',
    '  "display": { "columnas":[{"campo":"x","titulo":"X","formato":"texto|numero|dinero|porcentaje|fecha"}],',
    '               "formato":"...", "unidad":"u", "nota":"..." } }',
    '',
    `La grilla tiene ${GRID_COLS} columnas; el alto va en filas de 40 px. Un KPI suele ser ancho 3, alto 3.`,
    'Una tabla o un gráfico, ancho 6, alto 7. No superpongas widgets: si no sabes dónde, omite x/y y se acomoda solo.',
    '',
    'CATÁLOGO DE FUENTES DE DATOS (son las ÚNICAS que puedes usar; son de solo lectura):',
    catalogo,
    '',
    'Si te piden algo que ninguna fuente puede responder, dilo con claridad en "mensaje" y devuelve "ops": [].',
    'No inventes nombres de herramientas ni de campos. Si no estás seguro de un campo, usa una tabla sin',
    '"columnas" para que se muestren todos y la persona elija.',
    '',
    'TABLERO ACTUAL:',
    JSON.stringify({ nombre: dashboard.nombre, widgets: dashboard.widgets }, null, 1).slice(0, 6000),
  ].join('\n');
}

function catalogoTexto(): string {
  return COPILOT_TOOLS.map((t) => {
    const props = (t.parameters && t.parameters.properties) || {};
    const args = Object.keys(props).map((k) => `${k}`).join(', ');
    return `- ${t.name}${args ? ` (args: ${args})` : ''}: ${t.description}`;
  }).join('\n');
}

/** Extrae el primer objeto JSON de la respuesta del modelo, tolerando ```json ... ```. */
export function parsearRespuesta(txt: string | null): { mensaje: string; ops: DashboardPatch[] } | null {
  if (!txt) return null;
  let s = txt.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i < 0 || j <= i) return null;
  try {
    const o = JSON.parse(s.slice(i, j + 1));
    return { mensaje: String(o.mensaje || o.message || ''), ops: Array.isArray(o.ops) ? o.ops : [] };
  } catch { return null; }
}

export class AiDashboardService {
  constructor(private readonly facade: WmsFacade) {}

  private get repo() { return (this.facade as any).aiDashboards as import('../domain/ports').AiDashboardRepository | undefined; }
  private now(): string { return (this.facade as any).clockNow(); }
  private id(): string { return (this.facade as any).ids.next(); }

  private must() {
    const r = this.repo;
    if (!r) throw new Error('El Dashboard AI no está disponible en esta instalación');
    return r;
  }

  async list(operationId: string, ownerId: string): Promise<AiDashboard[]> {
    return this.must().list(operationId, ownerId);
  }

  async create(operationId: string, ownerId: string, nombre: string, sellerId?: string | null): Promise<AiDashboard> {
    const now = this.now();
    const d: AiDashboard = {
      id: 'dsh-' + this.id(), operationId, ownerId,
      nombre: (nombre || 'Mi tablero').slice(0, 80),
      descripcion: null, sellerId: sellerId || null,
      widgets: [], version: 1, createdAt: now, updatedAt: now,
    };
    await this.must().save(d);
    return d;
  }

  /** Trae un tablero verificando que sea de quien lo pide. */
  async get(id: string, operationId: string, ownerId: string): Promise<AiDashboard> {
    const d = await this.must().get(id);
    if (!d || d.operationId !== operationId || d.ownerId !== ownerId) {
      throw new Error('Tablero no encontrado');
    }
    return d;
  }

  async remove(id: string, operationId: string, ownerId: string): Promise<{ ok: true }> {
    await this.get(id, operationId, ownerId);
    await this.must().delete(id);
    return { ok: true };
  }

  /** Guarda cambios hechos A MANO desde el editor (mover, redimensionar, editar). */
  async savePatch(id: string, operationId: string, ownerId: string, ops: DashboardPatch[]) {
    const actual = await this.get(id, operationId, ownerId);
    const r = aplicarPatch(actual, ops, herramientasDeLectura(), () => 'w-' + this.id(), this.now());
    await this.must().save(r.dashboard);
    return r;
  }

  /**
   * Datos en vivo de todos los widgets. Cada widget ejecuta SU herramienta por el
   * mismo camino de lectura del copiloto, con el tenant y el alcance del usuario.
   * Un widget que falla no bota al tablero: devuelve su error y los demás siguen.
   */
  async data(id: string, operationId: string, ownerId: string, sellerScope: string | null) {
    const d = await this.get(id, operationId, ownerId);
    const alcance = d.sellerId || sellerScope || null;
    const out: Record<string, any> = {};
    await Promise.all(d.widgets.map(async (w: Widget) => {
      if (w.tipo === 'texto' || !w.source) { out[w.id] = { filas: [], valor: null }; return; }
      try {
        const bruto = await this.facade.runCopilotTool(w.source.tool, w.source.args || {}, operationId, alcance);
        if (bruto && bruto.error) { out[w.id] = { error: String(bruto.error), filas: [], valor: null }; return; }
        out[w.id] = transformar(bruto, w);
      } catch (e: any) {
        out[w.id] = { error: (e && e.message) || 'no se pudo consultar', filas: [], valor: null };
      }
    }));
    return { id: d.id, version: d.version, generadoEn: this.now(), widgets: out };
  }

  /** Conversación: el usuario pide, el modelo propone, el servidor valida y guarda. */
  async chat(id: string, operationId: string, ownerId: string, prompt: string, cred: AiCredential | null, historial?: ChatTurn[]) {
    const actual = await this.get(id, operationId, ownerId);
    if (!cred) {
      return {
        ok: false as const,
        mensaje: 'No hay una IA conectada a esta operación. Conéctala en la sección Agente, o arma el tablero a mano con el botón "＋ Widget".',
        dashboard: actual, aplicados: [], rechazados: [],
      };
    }
    const turns: ChatTurn[] = (historial || []).slice(-6).concat([{ role: 'user', content: prompt }]);
    const res = await askCopilotChat(cred, systemPrompt(actual, catalogoTexto()), turns);
    const parsed = parsearRespuesta(res.text);
    if (!parsed) {
      return {
        ok: false as const,
        mensaje: res.error
          ? `La IA no pudo responder: ${res.error}`
          : 'La IA respondió algo que no pude interpretar como cambios del tablero. Intenta pedirlo de otra forma.',
        dashboard: actual, aplicados: [], rechazados: [],
      };
    }
    const r = aplicarPatch(actual, parsed.ops, herramientasDeLectura(), () => 'w-' + this.id(), this.now());
    if (r.aplicados.length) await this.must().save(r.dashboard);
    return {
      ok: true as const,
      mensaje: parsed.mensaje || (r.aplicados.length ? 'Listo.' : 'No hice cambios.'),
      dashboard: r.dashboard, aplicados: r.aplicados, rechazados: r.rechazados,
    };
  }

  /** Valida un widget suelto (editor manual) sin guardarlo. */
  validar(raw: any) {
    return validarWidget(raw, herramientasDeLectura(), () => 'w-' + this.id());
  }
}
