/**
 * Dashboard AI — tableros que el usuario arma conversando con el LLM.
 * ---------------------------------------------------------------------------
 * La decisión central: el modelo NO escribe HTML ni JavaScript. Escribe una
 * ESPECIFICACIÓN declarativa (este archivo) que el panel valida y dibuja con sus
 * propios componentes. Eso compra tres cosas que el HTML generado no da:
 *   1. Seguridad: nada de lo que diga el modelo se ejecuta en el navegador.
 *   2. Datos vivos: el tablero se vuelve a dibujar con datos frescos cada vez
 *      (cada 30 s), porque guardamos la PREGUNTA, no la respuesta.
 *   3. Edición a mano: como es estructura, el usuario puede mover, redimensionar
 *      y editar cada widget sin pasar por el modelo.
 *
 * La fuente de datos de un widget es siempre una herramienta de LECTURA del
 * catálogo del copiloto, ejecutada con los permisos y el tenant del usuario: un
 * widget no puede pedir nada que esa persona no pudiera ver por su cuenta.
 */

/**
 * Tipos de widget que el panel sabe dibujar.
 * Los seis primeros son los básicos (HTML puro); el resto se dibuja con ECharts,
 * que el panel carga solo cuando entras a la sección.
 */
export type WidgetType =
  | 'kpi' | 'tabla' | 'barras' | 'lineas' | 'lista' | 'texto'
  | 'gauge'      // aguja radial: ocupación, precisión, cumplimiento
  | 'rosco'      // dona con el total al centro
  | 'area'       // tendencia con degradado
  | 'apiladas'   // barras apiladas (composición)
  | 'radar'      // perfil multidimensional
  | 'treemap'    // qué pesa más
  | 'calendario' // mapa de calor por día
  | 'sankey'     // flujo entre etapas
  | 'mapa3d'     // bodega isométrica por ubicación
  | 'bullet'     // valor contra su meta
  | 'latido';    // últimos hechos, con pulso

export const WIDGET_TYPES: WidgetType[] = [
  'kpi', 'tabla', 'barras', 'lineas', 'lista', 'texto',
  'gauge', 'rosco', 'area', 'apiladas', 'radar', 'treemap', 'calendario', 'sankey', 'mapa3d', 'bullet', 'latido',
];

/** Qué hace cada tipo, en una línea. Lo lee el LLM y también la ayuda del panel. */
export const WIDGET_HELP: Record<WidgetType, string> = {
  kpi: 'un número grande con su unidad',
  tabla: 'filas y columnas',
  barras: 'barras horizontales con su valor',
  lineas: 'mini gráfico de línea (sparkline)',
  lista: 'lista simple de clave y valor',
  texto: 'una nota fija escrita por la persona',
  gauge: 'aguja radial de 0 a 100 con zona de riesgo (ocupación, precisión, cumplimiento)',
  rosco: 'dona con el total al centro (composición de un todo)',
  area: 'tendencia en el tiempo con degradado',
  apiladas: 'barras apiladas por categoría (composición por hora, estado o courier)',
  radar: 'perfil de varias dimensiones a la vez (desempeño de un operario o cliente)',
  treemap: 'rectángulos proporcionales: qué pesa más',
  calendario: 'mapa de calor por día del año (ritmo de la operación)',
  sankey: 'flujo entre etapas: por dónde pasa la mercadería y dónde se atasca',
  mapa3d: 'la bodega vista de arriba: cada ubicación con su ocupación en color y altura',
  bullet: 'valor contra su meta, con la marca del compromiso',
  latido: 'los últimos hechos de la operación con su pulso de color',
};

/** Aspecto del tablero completo. */
export type DashboardTema = 'claro' | 'torre';
export const TEMAS: DashboardTema[] = ['claro', 'torre'];

/** Agregaciones disponibles al transformar los datos de la herramienta. */
export type Agg = 'suma' | 'promedio' | 'conteo' | 'maximo' | 'minimo' | 'primero';

export interface WidgetSource {
  /** Nombre de una herramienta de LECTURA del catálogo del copiloto. */
  tool: string;
  /** Argumentos de la herramienta (los valida la herramienta misma). */
  args?: Record<string, unknown>;
  /**
   * Ruta al arreglo/valor dentro de la respuesta, con puntos: "items",
   * "porCliente", "actividad.ordenesPreparadas.valor". Vacío = la raíz.
   */
  path?: string;
}

export interface WidgetTransform {
  /** Campo por el que agrupar (para barras/líneas/kpi). */
  groupBy?: string;
  /** Campo que se agrega. Vacío con agg=conteo cuenta filas. */
  field?: string;
  agg?: Agg;
  /** Orden: campo y dirección. */
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  limit?: number;
  /** Filtro simple: campo op valor. */
  filter?: { field: string; op: '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contiene'; value: unknown };
}

export interface WidgetDisplay {
  /** Columnas de la tabla (o campos de la lista). */
  columnas?: Array<{ campo: string; titulo?: string; formato?: 'texto' | 'numero' | 'dinero' | 'porcentaje' | 'fecha' }>;
  formato?: 'texto' | 'numero' | 'dinero' | 'porcentaje' | 'fecha';
  unidad?: string;
  color?: string;
  /** Texto fijo, solo para el widget de tipo texto. */
  texto?: string;
  /** Nota al pie del widget. */
  nota?: string;
}

export interface Widget {
  id: string;
  tipo: WidgetType;
  titulo: string;
  /** Posición en una grilla de 12 columnas. `alto` va en filas de 40 px. */
  x: number; y: number; ancho: number; alto: number;
  source?: WidgetSource | null;
  transform?: WidgetTransform | null;
  display?: WidgetDisplay | null;
}

export interface AiDashboard {
  id: string;
  operationId: string;
  ownerId: string;
  nombre: string;
  descripcion?: string | null;
  /** Cliente al que se acota el tablero completo (null = toda la operación). */
  sellerId?: string | null;
  /**
   * Aspecto: 'claro' (el del panel) o 'torre' (oscuro, pensado para la pantalla
   * colgada en la bodega y para mostrar la operación a un cliente).
   */
  tema?: DashboardTema;
  widgets: Widget[];
  /** Sube en cada guardado; permite volver a la versión anterior. */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export const GRID_COLS = 12;
const MAX_WIDGETS = 24;
const OPS = ['=', '!=', '>', '>=', '<', '<=', 'contiene'];
const AGGS: Agg[] = ['suma', 'promedio', 'conteo', 'maximo', 'minimo', 'primero'];
const FORMATOS = ['texto', 'numero', 'dinero', 'porcentaje', 'fecha'];

function texto(v: unknown, max: number, fallback = ''): string {
  const s = typeof v === 'string' ? v.trim() : v == null ? '' : String(v);
  return s.slice(0, max) || fallback;
}
function entero(v: unknown, min: number, max: number, def: number): number {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/**
 * Valida y normaliza un widget propuesto (venga del LLM o del editor manual).
 * Devuelve el widget limpio o el motivo del rechazo. Nunca lanza: los errores
 * son parte de la conversación ("esa herramienta no existe"), no excepciones.
 */
export function validarWidget(
  raw: any,
  herramientasValidas: string[],
  idGen: () => string,
): { ok: true; widget: Widget } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'el widget no es un objeto' };
  const tipo = String(raw.tipo || '').toLowerCase() as WidgetType;
  if (!WIDGET_TYPES.includes(tipo)) {
    return { ok: false, error: `tipo de widget desconocido: "${raw.tipo}". Disponibles: ${WIDGET_TYPES.join(', ')}` };
  }
  const titulo = texto(raw.titulo, 80, 'Sin título');

  let source: WidgetSource | null = null;
  if (tipo !== 'texto') {
    const tool = texto(raw.source?.tool ?? raw.tool, 64);
    if (!tool) return { ok: false, error: `el widget "${titulo}" no dice de qué herramienta saca los datos` };
    if (!herramientasValidas.includes(tool)) {
      return { ok: false, error: `la herramienta "${tool}" no existe o no es de lectura. Usa una del catálogo.` };
    }
    const args = (raw.source?.args ?? raw.args) || {};
    source = {
      tool,
      args: typeof args === 'object' && !Array.isArray(args) ? args : {},
      path: texto(raw.source?.path ?? raw.path, 80) || undefined,
    };
  }

  let transform: WidgetTransform | null = null;
  const t = raw.transform;
  if (t && typeof t === 'object') {
    const agg = AGGS.includes(t.agg) ? (t.agg as Agg) : undefined;
    let filter: WidgetTransform['filter'];
    if (t.filter && typeof t.filter === 'object' && t.filter.field && OPS.includes(t.filter.op)) {
      filter = { field: texto(t.filter.field, 60), op: t.filter.op, value: t.filter.value };
    }
    transform = {
      groupBy: texto(t.groupBy, 60) || undefined,
      field: texto(t.field, 60) || undefined,
      agg,
      sortBy: texto(t.sortBy, 60) || undefined,
      sortDir: t.sortDir === 'asc' ? 'asc' : t.sortDir === 'desc' ? 'desc' : undefined,
      limit: t.limit == null ? undefined : entero(t.limit, 1, 500, 20),
      filter,
    };
  }

  let display: WidgetDisplay | null = null;
  const d = raw.display;
  if (d && typeof d === 'object') {
    display = {
      columnas: Array.isArray(d.columnas)
        ? d.columnas.slice(0, 12).map((c: any) => ({
            campo: texto(c?.campo, 60),
            titulo: texto(c?.titulo, 60) || undefined,
            formato: FORMATOS.includes(c?.formato) ? c.formato : undefined,
          })).filter((c: any) => c.campo)
        : undefined,
      formato: FORMATOS.includes(d.formato) ? d.formato : undefined,
      unidad: texto(d.unidad, 16) || undefined,
      color: /^#[0-9a-fA-F]{3,8}$/.test(String(d.color || '')) ? String(d.color) : undefined,
      texto: texto(d.texto, 2000) || undefined,
      nota: texto(d.nota, 200) || undefined,
    };
  }
  if (tipo === 'texto' && !display?.texto) {
    return { ok: false, error: `el widget de texto "${titulo}" no trae contenido (display.texto)` };
  }

  const ancho = entero(raw.ancho, 1, GRID_COLS, tipo === 'kpi' ? 3 : 6);
  return {
    ok: true,
    widget: {
      id: texto(raw.id, 40) || idGen(),
      tipo, titulo,
      x: entero(raw.x, 0, GRID_COLS - 1, 0),
      y: entero(raw.y, 0, 999, 0),
      ancho,
      alto: entero(raw.alto, 2, 24, tipo === 'kpi' ? 3 : 7),
      source, transform, display,
    },
  };
}

/**
 * Primer hueco libre de la grilla donde cabe un widget de ese tamaño, leyendo de
 * arriba hacia abajo y de izquierda a derecha (como se lee un tablero).
 */
export function primerHueco(widgets: Widget[], ancho: number, alto: number): { x: number; y: number } {
  const ocupada = (x: number, y: number) =>
    widgets.some((w) => x < w.x + w.ancho && x + 1 > w.x && y < w.y + w.alto && y + 1 > w.y);
  const cabe = (x: number, y: number) => {
    if (x + ancho > GRID_COLS) return false;
    for (let i = x; i < x + ancho; i++) for (let j = y; j < y + alto; j++) if (ocupada(i, j)) return false;
    return true;
  };
  const maxY = widgets.reduce((m, w) => Math.max(m, w.y + w.alto), 0);
  for (let y = 0; y <= maxY; y++) for (let x = 0; x <= GRID_COLS - ancho; x++) if (cabe(x, y)) return { x, y };
  return { x: 0, y: maxY };
}

/** Acomoda los widgets: sin solapes imposibles y sin salirse de las 12 columnas. */
export function normalizarLayout(widgets: Widget[]): Widget[] {
  return widgets.slice(0, MAX_WIDGETS).map((w) => ({
    ...w,
    ancho: Math.max(1, Math.min(GRID_COLS, w.ancho)),
    x: Math.max(0, Math.min(GRID_COLS - 1, w.x)),
  })).map((w) => (w.x + w.ancho > GRID_COLS ? { ...w, x: Math.max(0, GRID_COLS - w.ancho) } : w));
}

/** Operaciones que el LLM puede pedir sobre un tablero. */
export type DashboardPatch =
  | { op: 'agregar'; widget: any }
  | { op: 'modificar'; id: string; widget: any }
  | { op: 'eliminar'; id: string }
  | { op: 'mover'; id: string; x?: number; y?: number; ancho?: number; alto?: number }
  | { op: 'renombrar'; nombre: string; descripcion?: string }
  | { op: 'tema'; tema: DashboardTema }
  | { op: 'plantilla'; plantilla: string }
  | { op: 'limpiar' };

export interface AplicarResultado {
  dashboard: AiDashboard;
  aplicados: string[];
  rechazados: string[];
}

/**
 * Aplica una lista de operaciones sobre el tablero. Cada operación se valida por
 * separado: una mala no bota a las demás, y lo rechazado se devuelve explicado
 * para que el modelo (y la persona) sepan qué no se hizo y por qué.
 */
export function aplicarPatch(
  dashboard: AiDashboard,
  ops: DashboardPatch[],
  herramientasValidas: string[],
  idGen: () => string,
  nowIso: string,
): AplicarResultado {
  let widgets = dashboard.widgets.slice();
  let nombre = dashboard.nombre;
  let descripcion = dashboard.descripcion ?? null;
  let tema: DashboardTema = dashboard.tema || 'claro';
  const aplicados: string[] = [];
  const rechazados: string[] = [];

  for (const op of ops || []) {
    if (!op || typeof op !== 'object') { rechazados.push('operación vacía'); continue; }
    switch (op.op) {
      case 'agregar': {
        if (widgets.length >= MAX_WIDGETS) { rechazados.push(`no caben más de ${MAX_WIDGETS} widgets`); break; }
        const r = validarWidget(op.widget, herramientasValidas, idGen);
        if (r.ok !== true) { rechazados.push(r.error); break; }
        // Si no dijo dónde ponerlo, se busca el primer hueco libre: apilar todo en
        // una columna desperdicia la pantalla y obliga a acomodar a mano.
        if (op.widget?.y == null || op.widget?.x == null) {
          const hueco = primerHueco(widgets, r.widget.ancho, r.widget.alto);
          r.widget.x = hueco.x; r.widget.y = hueco.y;
        }
        widgets.push(r.widget);
        aplicados.push(`agregado: ${r.widget.titulo}`);
        break;
      }
      case 'modificar': {
        const i = widgets.findIndex((w) => w.id === op.id);
        if (i < 0) { rechazados.push(`no existe el widget ${op.id}`); break; }
        const mezcla = { ...widgets[i], ...(op.widget || {}), id: widgets[i].id };
        const r = validarWidget(mezcla, herramientasValidas, idGen);
        if (r.ok !== true) { rechazados.push(r.error); break; }
        widgets[i] = r.widget;
        aplicados.push(`modificado: ${r.widget.titulo}`);
        break;
      }
      case 'eliminar': {
        const antes = widgets.length;
        const quitado = widgets.find((w) => w.id === op.id);
        widgets = widgets.filter((w) => w.id !== op.id);
        if (widgets.length === antes) rechazados.push(`no existe el widget ${op.id}`);
        else aplicados.push(`eliminado: ${quitado?.titulo || op.id}`);
        break;
      }
      case 'mover': {
        const i = widgets.findIndex((w) => w.id === op.id);
        if (i < 0) { rechazados.push(`no existe el widget ${op.id}`); break; }
        const w = widgets[i];
        widgets[i] = {
          ...w,
          x: op.x == null ? w.x : entero(op.x, 0, GRID_COLS - 1, w.x),
          y: op.y == null ? w.y : entero(op.y, 0, 999, w.y),
          ancho: op.ancho == null ? w.ancho : entero(op.ancho, 1, GRID_COLS, w.ancho),
          alto: op.alto == null ? w.alto : entero(op.alto, 2, 24, w.alto),
        };
        aplicados.push(`movido: ${w.titulo}`);
        break;
      }
      case 'renombrar': {
        const n = texto(op.nombre, 80);
        if (!n) { rechazados.push('el nombre no puede quedar vacío'); break; }
        nombre = n;
        if (op.descripcion != null) descripcion = texto(op.descripcion, 300) || null;
        aplicados.push(`renombrado a "${n}"`);
        break;
      }
      case 'plantilla': {
        const p = PLANTILLAS.find((x) => x.id === String(op.plantilla));
        if (!p) { rechazados.push(`no existe la plantilla "${op.plantilla}". Disponibles: ${PLANTILLAS.map((x) => x.id).join(', ')}`); break; }
        // Se expande a operaciones normales: pasa por la misma validación que el resto.
        const r = aplicarPatch({ ...dashboard, widgets, nombre, descripcion, tema }, opsDePlantilla(p), herramientasValidas, idGen, nowIso);
        widgets = r.dashboard.widgets; tema = r.dashboard.tema || tema;
        aplicados.push(`plantilla aplicada: ${p.nombre} (${r.aplicados.length - 2} widgets)`);
        for (const x of r.rechazados) rechazados.push(x);
        break;
      }
      case 'tema': {
        if (!TEMAS.includes(op.tema)) { rechazados.push(`tema desconocido: ${op.tema}. Disponibles: ${TEMAS.join(', ')}`); break; }
        tema = op.tema;
        aplicados.push(`tema: ${op.tema === 'torre' ? 'torre de control' : 'claro'}`);
        break;
      }
      case 'limpiar': {
        widgets = [];
        aplicados.push('tablero vaciado');
        break;
      }
      default:
        rechazados.push(`operación desconocida: ${(op as any).op}`);
    }
  }

  return {
    dashboard: {
      ...dashboard,
      nombre, descripcion, tema,
      widgets: normalizarLayout(widgets),
      version: dashboard.version + (aplicados.length ? 1 : 0),
      updatedAt: aplicados.length ? nowIso : dashboard.updatedAt,
    },
    aplicados, rechazados,
  };
}

// ---- Transformación de los datos que devuelve la herramienta ----------------

function leerRuta(obj: any, path?: string): any {
  if (!path) return obj;
  const v = path.split('.').reduce((acc: any, k: string) => (acc == null ? acc : acc[k]), obj);
  if (v !== undefined && v !== null) return v;
  // La ruta no existe. Antes de devolver vacío, si la respuesta trae UNA sola lista,
  // esa es casi siempre la que se quería: el modelo (o la persona) le erró al nombre.
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const listas = Object.keys(obj).filter((k) => Array.isArray((obj as any)[k]));
    if (listas.length === 1) return (obj as any)[listas[0]];
  }
  return v;
}
function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
function cumple(fila: any, f: NonNullable<WidgetTransform['filter']>): boolean {
  const v = fila?.[f.field];
  switch (f.op) {
    case '=': return String(v) === String(f.value);
    case '!=': return String(v) !== String(f.value);
    case '>': return num(v) > num(f.value);
    case '>=': return num(v) >= num(f.value);
    case '<': return num(v) < num(f.value);
    case '<=': return num(v) <= num(f.value);
    case 'contiene': return String(v ?? '').toLowerCase().includes(String(f.value ?? '').toLowerCase());
    default: return true;
  }
}

/**
 * Convierte la respuesta cruda de una herramienta en las filas que el widget
 * dibuja. Si el resultado no es una lista, lo envuelve: así un KPI puede salir
 * tanto de un número suelto como de una lista que se agrega.
 */
export function transformar(bruto: any, w: Widget): { filas: any[]; valor: number | null } {
  const raw = leerRuta(bruto, w.source?.path);
  let filas: any[];
  if (Array.isArray(raw)) filas = raw;
  else if (raw && typeof raw === 'object') {
    // Un objeto {clave: número} se vuelve lista de pares: es la forma más común
    // de los conteos por estado, por zona, por tipo.
    const vals = Object.values(raw);
    filas = vals.length && vals.every((v) => typeof v === 'number')
      ? Object.keys(raw).map((k) => ({ clave: k, valor: (raw as any)[k] }))
      : [raw];
  } else filas = raw == null ? [] : [{ valor: raw }];

  const t = w.transform || {};
  if (t.filter) filas = filas.filter((f) => cumple(f, t.filter!));

  if (t.groupBy) {
    const grupos = new Map<string, any[]>();
    for (const f of filas) {
      const k = String(f?.[t.groupBy] ?? '—');
      const a = grupos.get(k) || []; a.push(f); grupos.set(k, a);
    }
    filas = Array.from(grupos.entries()).map(([clave, items]) => ({
      clave,
      valor: agregar(items, t.field, t.agg || 'suma'),
      filas: items.length,
    }));
  }

  if (t.sortBy) {
    const dir = t.sortDir === 'asc' ? 1 : -1;
    filas = filas.slice().sort((a, b) => {
      const x = a?.[t.sortBy!], y = b?.[t.sortBy!];
      if (typeof x === 'number' || typeof y === 'number') return (num(x) - num(y)) * dir;
      return String(x ?? '').localeCompare(String(y ?? '')) * dir;
    });
  }
  if (t.limit) filas = filas.slice(0, t.limit);

  // Para un KPI: un solo número.
  let valor: number | null = null;
  if (w.tipo === 'kpi') {
    if (typeof raw === 'number') valor = raw;
    else if (t.agg === 'conteo' && !t.field) valor = filas.length;
    else valor = agregar(filas, t.field || 'valor', t.agg || 'suma');
  }
  return { filas, valor };
}

function agregar(items: any[], field: string | undefined, agg: Agg): number {
  const vals = items.map((i) => (field ? num(i?.[field]) : num(i?.valor ?? i)));
  if (!vals.length) return 0;
  switch (agg) {
    case 'conteo': return items.length;
    case 'promedio': return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;
    case 'maximo': return Math.max(...vals);
    case 'minimo': return Math.min(...vals);
    case 'primero': return vals[0];
    default: return Math.round(vals.reduce((a, b) => a + b, 0) * 100) / 100;
  }
}

// ---- Plantillas invocables ---------------------------------------------------

/**
 * Tableros listos para invocar de una vez. Existen porque la hoja en blanco es el
 * peor punto de partida: con una plantilla la persona ve el tablero armado en dos
 * segundos y desde ahí lo edita, en vez de tener que imaginárselo.
 *
 * El LLM también puede invocarlas por nombre ("arma la torre de control").
 */
export interface PlantillaDef {
  id: string;
  nombre: string;
  descripcion: string;
  tema: DashboardTema;
  widgets: Array<Omit<Widget, 'id'>>;
}

const W = (w: Omit<Widget, 'id'>) => w;

export const PLANTILLAS: PlantillaDef[] = [
  {
    id: 'torre',
    nombre: 'Torre de control',
    descripcion: 'Oscuro, para la pantalla colgada en la bodega: flujo, ocupación 3D, ritmo y latido en vivo.',
    tema: 'torre',
    widgets: [
      W({ tipo: 'kpi', titulo: 'Órdenes preparadas', x: 0, y: 0, ancho: 3, alto: 5,
        source: { tool: 'panel_operacion', path: 'actividad.ordenesPreparadas.valor' }, transform: null,
        display: { formato: 'numero', nota: 'últimas 24 h' } }),
      W({ tipo: 'kpi', titulo: 'Unidades preparadas', x: 3, y: 0, ancho: 3, alto: 5,
        source: { tool: 'panel_operacion', path: 'actividad.unidadesPreparadas.valor' }, transform: null,
        display: { formato: 'numero', unidad: 'un', nota: 'últimas 24 h' } }),
      W({ tipo: 'kpi', titulo: 'Órdenes atrasadas', x: 6, y: 0, ancho: 3, alto: 5,
        source: { tool: 'ordenes_por_vencer', args: { horas: 0 }, path: 'items' }, transform: { agg: 'conteo' },
        display: { formato: 'numero', color: '#FF6B6B', nota: 'pasadas de su deadline' } }),
      W({ tipo: 'gauge', titulo: 'Ocupación', x: 9, y: 0, ancho: 3, alto: 5,
        source: { tool: 'panel_operacion', path: 'ocupacion' }, transform: null, display: { nota: 'unidades sobre capacidad' } }),
      W({ tipo: 'mapa3d', titulo: 'Mapa de ocupación por ubicación', x: 0, y: 4, ancho: 5, alto: 9,
        source: { tool: 'ocupacion_ubicaciones', path: 'masOcupadas' }, transform: null, display: { nota: 'altura y color = ocupación' } }),
      W({ tipo: 'sankey', titulo: 'Flujo de la mercadería', x: 5, y: 4, ancho: 7, alto: 9,
        source: { tool: 'flujo_mercaderia' }, transform: null, display: { nota: 'últimos 30 días' } }),
      W({ tipo: 'latido', titulo: 'Latido de la operación', x: 0, y: 13, ancho: 5, alto: 8,
        source: { tool: 'alertas_activas', path: 'alertas' }, transform: { limit: 8 }, display: null }),
      W({ tipo: 'calendario', titulo: 'Ritmo de preparación', x: 5, y: 13, ancho: 7, alto: 8,
        source: { tool: 'serie_diaria', args: { dias: 90, metrica: 'unidadesPreparadas' }, path: 'series' }, transform: null,
        display: { nota: 'unidades preparadas por día' } }),
      W({ tipo: 'treemap', titulo: 'Inventario por cliente', x: 0, y: 21, ancho: 12, alto: 7,
        source: { tool: 'inventario_por_cliente', path: 'porCliente' }, transform: null, display: null }),
    ],
  },
  {
    id: 'premium',
    nombre: 'Panel premium',
    descripcion: 'Claro, para la dirección: tendencia, cumplimiento por cliente, mezcla de trabajo y desempeño.',
    tema: 'claro',
    widgets: [
      W({ tipo: 'area', titulo: 'Unidades preparadas por día', x: 0, y: 0, ancho: 6, alto: 7,
        source: { tool: 'serie_diaria', args: { dias: 14, metrica: 'unidadesPreparadas' }, path: 'series' }, transform: null,
        display: { nota: 'últimos 14 días' } }),
      W({ tipo: 'kpi', titulo: 'A tiempo vs. deadline', x: 6, y: 0, ancho: 3, alto: 7,
        source: { tool: 'panel_operacion', path: 'despacho.aTiempo' }, transform: null, display: { formato: 'numero' } }),
      W({ tipo: 'kpi', titulo: 'Atrasadas', x: 9, y: 0, ancho: 3, alto: 7,
        source: { tool: 'panel_operacion', path: 'despacho.atrasadas' }, transform: null, display: { formato: 'numero', color: '#E05A4B' } }),
      W({ tipo: 'gauge', titulo: 'Precisión de preparación', x: 8, y: 7, ancho: 4, alto: 7,
        source: { tool: 'panel_operacion', path: 'precision' }, transform: null, display: { nota: 'pedidos verificados al empacar' } }),
      W({ tipo: 'rosco', titulo: 'Mezcla de trabajo pendiente', x: 0, y: 7, ancho: 4, alto: 8,
        source: { tool: 'trabajo_pendiente', path: 'porTipo' }, transform: null, display: null }),
      W({ tipo: 'bullet', titulo: 'Carga pendiente por cliente', x: 4, y: 7, ancho: 4, alto: 8,
        source: { tool: 'panel_operacion', path: 'cargaPorCliente' }, transform: { field: 'unidades' }, display: { nota: 'unidades abiertas' } }),
      W({ tipo: 'barras', titulo: 'Productividad de bodega', x: 8, y: 11, ancho: 4, alto: 8,
        source: { tool: 'panel_operacion', path: 'productividad' }, transform: { groupBy: 'nombre', field: 'unidades', agg: 'suma', sortBy: 'valor', sortDir: 'desc', limit: 8 },
        display: { unidad: 'u' } }),
      W({ tipo: 'apiladas', titulo: 'Órdenes por estado', x: 0, y: 15, ancho: 12, alto: 7,
        source: { tool: 'panel_operacion', path: 'ordenesPorEstado' }, transform: null, display: null }),
    ],
  },
  {
    id: 'galeria',
    nombre: 'Galería de widgets',
    descripcion: 'Uno de cada tipo, con datos reales: para ver todo lo que se puede pedir antes de armar el tuyo.',
    tema: 'claro',
    widgets: [
      W({ tipo: 'gauge', titulo: 'Gauge · ocupación', x: 0, y: 0, ancho: 3, alto: 6, source: { tool: 'panel_operacion', path: 'ocupacion' }, transform: null, display: null }),
      W({ tipo: 'sankey', titulo: 'Sankey · flujo', x: 3, y: 0, ancho: 6, alto: 6, source: { tool: 'flujo_mercaderia' }, transform: null, display: null }),
      W({ tipo: 'rosco', titulo: 'Rosco · trabajo pendiente', x: 9, y: 0, ancho: 3, alto: 6, source: { tool: 'trabajo_pendiente', path: 'porTipo' }, transform: null, display: null }),
      W({ tipo: 'treemap', titulo: 'Treemap · inventario', x: 0, y: 6, ancho: 4, alto: 6, source: { tool: 'inventario_por_cliente', path: 'porCliente' }, transform: null, display: null }),
      W({ tipo: 'calendario', titulo: 'Calendario · ritmo', x: 4, y: 6, ancho: 8, alto: 6,
        source: { tool: 'serie_diaria', args: { dias: 90, metrica: 'unidadesPreparadas' }, path: 'series' }, transform: null, display: null }),
      W({ tipo: 'mapa3d', titulo: 'Mapa 3D · racks', x: 0, y: 12, ancho: 5, alto: 8, source: { tool: 'ocupacion_ubicaciones', path: 'masOcupadas' }, transform: null, display: null }),
      W({ tipo: 'area', titulo: 'Área · tendencia', x: 5, y: 12, ancho: 7, alto: 8,
        source: { tool: 'serie_diaria', args: { dias: 14, metrica: 'unidadesPreparadas' }, path: 'series' }, transform: null, display: null }),
      W({ tipo: 'bullet', titulo: 'Bullet · carga por cliente', x: 0, y: 20, ancho: 4, alto: 7, source: { tool: 'panel_operacion', path: 'cargaPorCliente' }, transform: { field: 'unidades' }, display: null }),
      W({ tipo: 'apiladas', titulo: 'Apiladas · órdenes por estado', x: 4, y: 20, ancho: 4, alto: 7, source: { tool: 'panel_operacion', path: 'ordenesPorEstado' }, transform: null, display: null }),
      W({ tipo: 'latido', titulo: 'Latido · alertas', x: 8, y: 20, ancho: 4, alto: 7, source: { tool: 'alertas_activas', path: 'alertas' }, transform: { limit: 6 }, display: null }),
    ],
  },
];

/**
 * Convierte una plantilla en operaciones de patch (así pasa por la misma validación).
 *
 * A propósito NO se le pasan las coordenadas: el acomodador busca el primer hueco
 * libre para cada widget, en orden. Escribir x/y a mano en la plantilla es pedir
 * que dos widgets terminen encimados el día que alguien cambie un alto.
 */
export function opsDePlantilla(p: PlantillaDef): DashboardPatch[] {
  return ([{ op: 'limpiar' }, { op: 'tema', tema: p.tema }] as DashboardPatch[])
    .concat(p.widgets.map((w) => {
      const { x, y, ...resto } = w as any;
      return { op: 'agregar', widget: resto } as DashboardPatch;
    }));
}
