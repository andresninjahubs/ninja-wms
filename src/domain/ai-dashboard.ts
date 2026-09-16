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

/** Tipos de widget que el panel sabe dibujar. */
export type WidgetType = 'kpi' | 'tabla' | 'barras' | 'lineas' | 'lista' | 'texto';

export const WIDGET_TYPES: WidgetType[] = ['kpi', 'tabla', 'barras', 'lineas', 'lista', 'texto'];

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
      nombre, descripcion,
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
