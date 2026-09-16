/**
 * Catálogo de herramientas (tool-calling) que el copiloto puede invocar para
 * profundizar en cualquier dato del WMS. Los esquemas son neutrales al proveedor
 * (OpenAI / Anthropic / Gemini); la ejecución vive en el facade (runCopilotTool),
 * siempre acotada al tenant (operación / seller del usuario) y de solo lectura.
 */
import { ToolSpec } from './copilot-llm';

const str = (description: string) => ({ type: 'string', description });
const int = (description: string) => ({ type: 'integer', description });

export const COPILOT_TOOLS: ToolSpec[] = [
  {
    name: 'stock_de_sku',
    description: 'Stock (on-hand) de un SKU: total, por ubicación, por lote y estado. Úsalo para "¿cuánto stock hay de X?" o "¿dónde está X?".',
    parameters: { type: 'object', properties: { sku: str('código del SKU a consultar'), sellerId: str('id del cliente/seller (opcional)') }, required: ['sku'] },
  },
  {
    name: 'inventario_resumen',
    description: 'Resumen de inventario de un cliente o de toda la operación: total on-hand, por estado y SKUs con más stock.',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente (opcional; si se omite, toda la operación)') } },
  },
  {
    name: 'tareas_de_orden',
    description: 'Tareas (todas las etapas) de una orden: reserva, picking, packing, despacho — cada una con su id interno (t-N), tipo, estado, operario asignado y tiempos. Úsalo para "¿en qué va la orden X?", "¿qué tareas tiene el pedido X y quién las ejecutó?", o trazabilidad de una orden.',
    parameters: { type: 'object', properties: { orden: str('id interno o referencia externa de la orden'), sellerId: str('id del cliente (opcional)') }, required: ['orden'] },
  },
  {
    name: 'linea_tiempo_orden',
    description: 'Línea de tiempo cronológica de los estados de una orden (creada, reservada, picking, empacada, despachada…), con marcas de tiempo y horas entre estados.',
    parameters: { type: 'object', properties: { orden: str('id o referencia externa de la orden'), sellerId: str('id del cliente (opcional)') }, required: ['orden'] },
  },
  {
    name: 'listar_ordenes',
    description: 'Lista órdenes filtrando por estado y/o cliente. Estados: RECEIVED, ALLOCATED, PICKING, PICKED, PACKED, SHIPPED, CANCELLED.',
    parameters: { type: 'object', properties: { estado: str('estado a filtrar (opcional)'), sellerId: str('id del cliente (opcional)'), limite: int('máx. resultados (opcional, def 30)') } },
  },
  {
    name: 'kardex_sku',
    description: 'Movimientos de inventario (kardex) de un SKU: recepciones, picking, ajustes, etc., con fecha, tipo, delta y ubicación.',
    parameters: { type: 'object', properties: { sku: str('código del SKU'), sellerId: str('id del cliente (opcional)'), limite: int('máx. movimientos (opcional, def 40)') }, required: ['sku'] },
  },
  {
    name: 'facturacion_cliente',
    description: 'Facturación de un cliente: tarifario, facturas emitidas y estimación del mes en curso.',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente'), limite: int('máx. facturas (opcional, def 12)') }, required: ['sellerId'] },
  },
  {
    name: 'insumos_embalaje',
    description: 'Estado de insumos de embalaje: saldo actual, consumo de 14 días y sugerencia de reabastecimiento.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'lotes_por_vencer',
    description: 'Lotes con saldo cuyo vencimiento está próximo (≤14 días) o ya venció (FEFO).',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente (opcional)') } },
  },
  {
    name: 'uso_plataforma',
    description: 'Métricas de uso de la plataforma por operación (logins, usuarios activos, adopción, operaciones activas) para una ventana en días.',
    parameters: { type: 'object', properties: { dias: int('ventana en días (1, 7, 30, 90; def 7)') } },
  },
  {
    name: 'canal_voz',
    description: 'Canal de voz operador↔admin: estadísticas por tópico, insights de mejora y últimos mensajes.',
    parameters: { type: 'object', properties: { limiteMensajes: int('máx. mensajes recientes (opcional, def 15)') } },
  },
  {
    name: 'armados_kit',
    description: 'Historial de armados/ensamblado de kits de un cliente (o de la operación).',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente (opcional)') } },
  },
  {
    name: 'metricas_dashboard',
    description: 'KPIs del dashboard de un cliente (órdenes, despachos, stock, etc.).',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente (opcional)') } },
  },
  {
    name: 'recepciones',
    description: 'Recepciones (inbound) registradas de un cliente, con estado y fecha.',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente (opcional)'), limite: int('máx. recepciones (opcional, def 30)') } },
  },
  {
    name: 'tiempos_preparacion',
    description: 'Tiempos promedio entre estados de las órdenes (recepción→reserva→picking→empaque→despacho) para medir la velocidad de preparación.',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente (opcional)'), limite: int('órdenes recientes a considerar (opcional, def 100)') } },
  },
  {
    name: 'clientes_operacion',
    description: 'Lista de clientes (sellers) de la operación con su id y nombre.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'riesgo_quiebre',
    description: 'Riesgo de quiebre de stock: cruza la demanda diaria con el disponible por SKU y devuelve los días de cobertura y la reposición sugerida. Úsalo para "¿qué SKUs están por quedarse sin stock?" o "¿qué necesito reponer?".',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente (opcional)'), diasCobertura: int('umbral de días de cobertura para marcar riesgo (opcional, def 7)'), ventanaDias: int('ventana de demanda en días (opcional, def 30)'), limite: int('máx. resultados (opcional, def 50)') } },
  },
  {
    name: 'ordenes_en_riesgo',
    description: 'Órdenes atascadas / en riesgo: pedidos no despachados ni cancelados que llevan demasiadas horas detenidos en su estado actual. Úsalo para "¿qué órdenes están trabadas?" o "¿qué priorizo hoy?".',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente (opcional)'), maxHoras: int('horas detenido para marcar riesgo (opcional, def 24)'), limite: int('máx. resultados (opcional, def 50)') } },
  },
  {
    name: 'panel_operacion',
    description: 'Panel consolidado de la operación en UNA llamada: actividad con comparativo, productividad, pre-facturación del mes, cumplimiento de deadlines (aTiempo/atrasadas), precisión de preparación, tiempos B2B/B2C, ocupación de bodega, carga por cliente, cola por courier, órdenes por estado, reposición de embalaje y excepciones. Es la fuente preferida para armar tableros: casi todo lo que un widget necesita sale de acá. Rutas útiles: actividad.ordenesPreparadas.valor, despacho.atrasadas, precision, ocupacion, cargaPorCliente, ordenesPorEstado, colaPorCourier, embalaje, excepciones, productividad, prefacturacion.porCliente.',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente (opcional; sin él, toda la operación)'), ventana: str('24h | 7d | 30d | 90d (opcional, def 24h)') } },
  },
  {
    name: 'flujo_mercaderia',
    description: 'Flujo de la mercadería entre etapas (recepción → almacenaje → picking → empaque → despacho, más reposición y devoluciones), con las unidades que pasaron por cada tramo. Pensado para un widget de tipo sankey.',
    parameters: { type: 'object', properties: { dias: int('ventana en días (opcional, def 30)'), sellerId: str('id del cliente (opcional)') } },
  },
  {
    name: 'serie_diaria',
    description: 'Serie de un indicador día por día, para gráficos de área, línea o calendario de calor. Métricas: unidadesPreparadas, ordenesPreparadas, unidadesRecibidas, movimientos.',
    parameters: { type: 'object', properties: { dias: int('cuántos días hacia atrás (opcional, def 30)'), metrica: str('unidadesPreparadas | ordenesPreparadas | unidadesRecibidas | movimientos'), sellerId: str('id del cliente (opcional)') } },
  },
  {
    name: 'inventario_por_cliente',
    description: 'Unidades en stock agrupadas por cliente y, dentro de cada uno, por sus SKUs principales. Pensado para un treemap.',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente (opcional)'), topSkus: int('cuántos SKUs por cliente (opcional, def 6)') } },
  },
  {
    name: 'trabajo_pendiente',
    description: 'Cuántas tareas hay pendientes de cada tipo (picking, empaque, despacho, recepción, guardado, reposición, conteo, re-slot). Pensado para un rosco o unas barras.',
    parameters: { type: 'object', properties: { soloSinAsignar: str('true para contar solo lo no asignado (opcional)') } },
  },
  {
    name: 'ordenes_por_vencer',
    description: 'Órdenes con el DEADLINE DE PREPARACIÓN vencido o por vencer: mira hacia adelante (cuánta holgura queda contra el compromiso de salida: corte del courier o SLA del cliente), a diferencia de ordenes_en_riesgo que mira cuánto llevan detenidas. Úsalo para "¿qué tiene que salir hoy?", "¿qué está por incumplir?", "¿qué priorizo ahora?".',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente (opcional)'), horas: int('ventana en horas hacia adelante (opcional, def 4)'), limite: int('máx. resultados (opcional, def 50)') } },
  },
  {
    name: 'brief_ejecutivo',
    description: 'Resumen ejecutivo de la operación para gerencia: throughput y su variación vs. período anterior, exactitud de inventario, top de operarios por productividad, quiebres inminentes y órdenes en riesgo. Úsalo para "dame el resumen de la bodega" o "¿cómo venimos este mes?".',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente (opcional; si se omite, toda la operación)') } },
  },
  {
    name: 'alertas_activas',
    description: 'Alertas abiertas del agente proactivo: qué necesita atención ahora (órdenes estancadas, deadlines de preparación en riesgo, SLA de despacho, quiebres, operarios inactivos con carga, lotes por vencer), con su severidad y sugerencia. Úsalo para "¿qué hay pendiente urgente?", "¿qué alertas tengo?".',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'operarios',
    description: 'Directorio de operarios con su DISPONIBILIDAD: si están ACTIVOS o inactivos, su última conexión y cuántas tareas abiertas tienen. Úsalo para "¿quién está activo/disponible?", "¿a quién le puedo asignar?" y SIEMPRE antes de asignar una tarea, para no asignársela a alguien inactivo.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'carga_operarios',
    description: 'Balanceo de carga: muestra las tareas asignadas y las horas estimadas de trabajo por operario (según su velocidad real), y cuántas tareas quedan sin asignar por tipo (PICK/PUTAWAY/COUNT). Úsalo para "¿quién está saturado?", "¿cómo está la carga del equipo?" o antes de balancear.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'rentabilidad',
    description: 'Rentabilidad por cliente en un mes: ingreso (facturación 3PL) menos costo (mano de obra, almacenaje, embalaje, overhead), con margen ESTÁNDAR (objetivo/ingeniería) y REAL (efectivo) y su %. Los clientes vienen ordenados de peor a mejor margen. Úsalo para "¿qué clientes son rentables?", "¿con quién estoy perdiendo plata?" o "margen del mes".',
    parameters: { type: 'object', properties: { year: int('año (opcional, def actual)'), month: int('mes 1-12 (opcional, def actual)') } },
  },
  {
    name: 'eficiencia_costos',
    description: 'Eficiencia de mano de obra estándar vs. real: horas reales vs. horas que debería haber tomado a estándar, % de eficiencia y sobrecosto ($) por operario o por tipo de tarea. Úsalo para "¿dónde estamos perdiendo eficiencia?", "¿qué operario está bajo estándar?" o gestión de productividad.',
    parameters: { type: 'object', properties: { year: int('año (opcional, def actual)'), month: int('mes 1-12 (opcional, def actual)'), agrupar: str('"operario" (def) o "tipo"') } },
  },
  {
    name: 'contexto_operativo',
    description: 'Snapshot INTEGRAL de la operación en una sola llamada: brief ejecutivo, rentabilidad y márgenes, exactitud de inventario, productividad por operario, carga del equipo, distribución ABC y auditoría IA. Úsalo cuando la pregunta es amplia o transversal ("¿cómo está todo?", "dame el panorama completo", "estado general de la bodega") o para partir con visión global antes de profundizar.',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente (opcional; si se omite, toda la operación)') } },
  },
  {
    name: 'devoluciones',
    description: 'Logística reversa: devoluciones por cliente, su estado (pendiente, en QA, procesada) y las más recientes con su orden de origen. Úsalo para "¿qué devoluciones hay?", "¿cuántas devoluciones pendientes?".',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente (opcional)') } },
  },
  {
    name: 'conteo_exactitud',
    description: 'Exactitud de inventario (conteos cíclicos): % de exactitud, líneas exactas vs. contadas, tendencia y cuántas tareas de conteo están propuestas. Úsalo para "¿qué tan exacto está el inventario?", "¿cuánto hay que contar?".',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente (opcional)') } },
  },
  {
    name: 'catalogo_productos',
    description: 'Catálogo/mantenedor de SKUs: total y activos, distribución por clase ABC, y una muestra con atributos (kit, control de lote/vencimiento/serie). Úsalo para "¿cuántos SKUs tiene el cliente?", "busca el producto X en el catálogo".',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente (opcional)'), buscar: str('texto para filtrar por SKU o descripción (opcional)') } },
  },
  {
    name: 'productividad_operarios',
    description: 'Productividad de mano de obra: unidades/hora por operario y por tipo de tarea, con horas trabajadas y unidades. Úsalo para "¿quién es más productivo?", "unidades por hora del equipo".',
    parameters: { type: 'object', properties: { operario: str('id del operario (opcional)'), desde: str('ISO desde (opcional)'), hasta: str('ISO hasta (opcional)') } },
  },
  {
    name: 'clasificacion_abc',
    description: 'Clasificación ABC (rotación): distribución de SKUs por clase A/B/C según su velocidad, global y por cliente. Úsalo para "¿cómo está la rotación?", "¿cuántos SKUs clase A hay?".',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente (opcional)') } },
  },
  {
    name: 'demanda_sku',
    description: 'Serie de demanda diaria (unidades despachadas y nº de órdenes) por SKU — input directo del forecasting. Úsalo para "¿cómo viene la demanda de X?", "tendencia de salida de un producto".',
    parameters: { type: 'object', properties: { sellerId: str('id del cliente (opcional)'), sku: str('SKU (opcional; si se omite, todos)'), desde: str('YYYY-MM-DD (opcional)'), hasta: str('YYYY-MM-DD (opcional)') } },
  },
  {
    name: 'auditoria_ia',
    description: 'Gobernanza de IA: recomendaciones de agentes y su % de aceptación, y acciones ejecutadas (ok/error) por agente. Úsalo para "¿cuánto se acepta lo que sugiere la IA?", "¿qué ha hecho el copiloto?".',
    parameters: { type: 'object', properties: { desde: str('ISO desde (opcional)'), hasta: str('ISO hasta (opcional)') } },
  },
  {
    name: 'ocupacion_ubicaciones',
    description: 'Ocupación de la bodega: unidades ocupadas y capacidad por zona, y las ubicaciones más llenas. Úsalo para "¿cómo está la ocupación?", "¿qué zonas están saturadas?".',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'mensajes_clientes',
    description: 'Bandeja de mensajes internos con clientes: hilos y no leídos por cliente. Úsalo para "¿hay mensajes de clientes sin responder?".',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'tareas_pendientes',
    description: 'Pool de tareas asignables por tipo, con su id, referencia, cliente, unidades y a quién están asignadas. Tipos: PICK (órdenes por pickear), PACK (órdenes recolectadas por EMPACAR), SHIP (órdenes empacadas por DESPACHAR), PUTAWAY (recepción por GUARDAR en almacenaje), RECEIVE (recepciones por cotejar/recibir), RESLOT (re-slotting sugerido), COUNT (conteos). Úsalo para "¿qué hay pendiente de empacar/despachar/guardar/recepcionar?", "¿qué falta por mover a su ubicación?" y antes de asignar una tarea, para obtener su id.',
    parameters: { type: 'object', properties: { tipo: { type: 'string', enum: ['PICK', 'PACK', 'SHIP', 'PUTAWAY', 'RECEIVE', 'RESLOT', 'COUNT'], description: 'tipo de tarea (def PUTAWAY)' }, soloSinAsignar: { type: 'boolean', description: 'solo las que no tienen operario (def false)' }, limite: int('máx. resultados (def 40)') } },
  },
];

/**
 * Herramientas de ACCIÓN (escritura). Solo se exponen a usuarios con permiso de
 * operación (order:fulfill). Según el modo de la operación, se ejecutan directo o
 * se proponen para confirmación del usuario.
 */
export const COPILOT_ACTION_TOOLS: ToolSpec[] = [
  {
    name: 'fijar_deadline_orden',
    description: 'Fija o quita el deadline de preparación de una orden (compromiso de salida). Úsalo cuando el courier mueve su hora de retiro o cuando una orden debe adelantarse. Requiere sellerId, orden y la fecha/hora ISO; dueAt vacío quita el deadline.',
    parameters: { type: 'object', required: ['sellerId', 'orden'], properties: { sellerId: str('id del cliente'), orden: str('N° de orden externo o id interno'), dueAt: str('fecha y hora ISO del compromiso; vacío para quitarlo') } },
  },
  {
    name: 'guardar_instruccion',
    description: 'Guarda una directriz del administrador para el agente de bodega (ej. "hoy priorizar Chilexpress", "no despachar el cliente X hasta que apruebe"). Queda vigente en los próximos ciclos del agente hasta que se retire o venza.',
    parameters: {
      type: 'object',
      properties: {
        texto: { type: 'string', description: 'La instrucción, en una frase clara.' },
        diasVigencia: { type: 'number', description: 'Días de vigencia (0 = hasta que se retire).' },
      },
      required: ['texto'],
    },
  },
  {
    name: 'avanzar_estado_orden',
    description: 'Avanza el estado de una orden en el flujo de fulfillment. Acciones: "reservar" (RECEIVED→ALLOCATED), "iniciar_picking" (ALLOCATED→PICKING: marca la recolección en curso, sin recolectar aún), "pickear" (ALLOCATED/PICKING→PICKED: completa la recolección), "empacar" (PICKED→PACKED), "despachar" (PACKED→SHIPPED). Úsala cuando el usuario pida marcar/avanzar una orden; usa "iniciar_picking" cuando pida "poner en picking" o "empezar a preparar" y "pickear" cuando pida darla por recolectada.',
    parameters: {
      type: 'object',
      properties: {
        orden: str('id o referencia externa de la orden'),
        accion: { type: 'string', enum: ['reservar', 'iniciar_picking', 'pickear', 'empacar', 'despachar'], description: 'transición a aplicar' },
        sellerId: str('id del cliente (opcional)'),
      },
      required: ['orden', 'accion'],
    },
  },
  {
    name: 'asignar_tarea',
    description: 'Asigna una tarea a un operario (balanceo de carga). Solo se puede asignar a un operario ACTIVO: si dudas de la disponibilidad, revisa primero la herramienta operarios. Para PICK, PACK (empacar) y SHIP (despachar), `entidad` es el n° de orden. Para PUTAWAY (guardar), RECEIVE (recepcionar), RESLOT o COUNT, `entidad` es el id o la referencia de la tarea: obténla primero con la herramienta tareas_pendientes del tipo correspondiente. Úsala cuando el usuario diga "asigna la orden X a Pedro", "que Ana empaque la orden 1234", "que Luis despache esos pedidos", "que Sofía guarde la recepción GD-1", "asígnale el conteo a Diego".',
    parameters: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['PICK', 'PACK', 'SHIP', 'PUTAWAY', 'COUNT', 'RECEIVE', 'RESLOT'], description: 'tipo de tarea (def PICK)' },
        entidad: str('id o referencia de la tarea (para PICK, el n° o id de la orden; para el resto, el id/ref que devuelve tareas_pendientes)'),
        operario: str('id del operario a asignar'),
      },
      required: ['entidad', 'operario'],
    },
  },
  {
    name: 'crear_recepcion',
    description: 'CREA una recepción (inbound) nueva para un cliente: la mercadería que se espera recibir en bodega. Queda pendiente para que un operario la coteje/reciba (no postea stock aún). Úsala cuando el usuario diga "crea una recepción de 100 CAM para acme", "ingresa la llegada del proveedor X". Necesita las líneas (SKU y cantidad esperada). Si no sabes el id del cliente usa clientes_operacion; para los SKU usa catalogo_productos.',
    parameters: {
      type: 'object',
      properties: {
        sellerId: str('id del cliente/seller para el que se crea la recepción'),
        lineas: {
          type: 'array',
          description: 'líneas esperadas de la recepción',
          items: { type: 'object', properties: { sku: str('código del SKU'), qty: int('cantidad esperada'), lot: str('lote (opcional)'), expiry: str('vencimiento ISO YYYY-MM-DD (opcional)') }, required: ['sku', 'qty'] },
        },
        proveedor: str('nombre del proveedor (opcional)'),
        referencia: str('referencia / n° de documento del proveedor (opcional)'),
        notas: str('notas (opcional)'),
      },
      required: ['lineas'],
    },
  },
  {
    name: 'crear_orden',
    description: 'CREA una orden de salida (pedido) nueva para un cliente y, si se te pide, RESERVA su stock (pon `reservar` en true). Sin reservar, la orden queda en RECEIVED (borrador) sin comprometer inventario; con reserva pasa a ALLOCATED (en modo confirmación la reserva queda propuesta para que el usuario la confirme). Úsala cuando el usuario diga "crea un pedido de 2 CAM para Juan Pérez y resérvale el stock", "ingresa una orden para acme". Necesita las líneas (SKU y cantidad) y el destinatario (al menos el nombre). Si no sabes el id del cliente usa clientes_operacion; para los SKU usa catalogo_productos.',
    parameters: {
      type: 'object',
      properties: {
        sellerId: str('id del cliente/seller dueño del pedido'),
        lineas: {
          type: 'array',
          description: 'líneas del pedido',
          items: { type: 'object', properties: { sku: str('código del SKU'), qty: int('cantidad'), lot: str('lote a exigir (opcional)') }, required: ['sku', 'qty'] },
        },
        destinatario: {
          type: 'object',
          description: 'a quién se despacha el pedido',
          properties: { nombre: str('nombre del destinatario'), telefono: str('teléfono (opcional)'), email: str('email (opcional)'), direccion: str('dirección (opcional)'), comuna: str('comuna (opcional)'), region: str('región (opcional)') },
          required: ['nombre'],
        },
        referencia: str('referencia externa / n° de pedido (opcional; si se omite se genera una)'),
        canal: str('canal de venta (opcional, def "copiloto")'),
        courier: str('courier / transportista (opcional)'),
        reservar: { type: 'boolean', description: 'true para reservar el stock inmediatamente tras crear la orden' },
      },
      required: ['lineas', 'destinatario'],
    },
  },
  {
    name: 'balancear_carga',
    description: 'Reparte automáticamente las tareas pendientes entre los operarios, minimizando el tiempo de término (usa la velocidad real de cada uno). Úsala cuando el usuario diga "balancea la carga" o "reparte el picking entre el equipo".',
    parameters: {
      type: 'object',
      properties: {
        tipo: { type: 'string', enum: ['PICK', 'PUTAWAY', 'COUNT', 'RECEIVE', 'RESLOT'], description: 'tipo de tarea a balancear (def PICK)' },
      },
    },
  },
  {
    name: 'activar_auto_balanceo',
    description: 'Activa o desactiva el AUTO-BALANCEO CONTINUO: el sistema reparte y reasigna tareas solo, en vivo, a medida que entra trabajo y los operarios se liberan. Úsala para directrices de operación automática como "mantén el equipo balanceado solo", "encárgate tú del reparto" o "desactiva el balanceo automático".',
    parameters: { type: 'object', properties: { activar: { type: 'boolean', description: 'true para activar (def), false para desactivar' } } },
  },
  {
    name: 'fijar_modo_asignacion',
    description: 'Fija el modo de asignación de la operación: "advisory" (un operario puede tomar cualquier tarea aunque esté asignada a otro) o "estricto" (solo el operario asignado puede ejecutar su tarea). Úsala cuando el admin diga "que cada uno haga solo lo suyo" (estricto) o "déjalo flexible" (advisory).',
    parameters: { type: 'object', properties: { modo: { type: 'string', enum: ['advisory', 'strict'], description: 'advisory o strict' } }, required: ['modo'] },
  },
  {
    name: 'reasignar_ociosidad',
    description: 'Dispara la REASIGNACIÓN POR OCIOSIDAD (work-stealing): mueve tareas asignadas pero no iniciadas desde el operario más cargado al más ocioso, para que nadie quede sin trabajo mientras otro está saturado. Úsala cuando el admin diga "que nadie quede ocioso", "redistribuye la carga ahora" o "empareja el trabajo del equipo".',
    parameters: { type: 'object', properties: {} },
  },
];
