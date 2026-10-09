/* Ninja WMS — Contenido de los tutoriales guiados, una guía por sección del panel.
 *
 * Cada guía: { icon, title, summary, steps:[{ el, title, text, place?, before?, roles? }], tips?, outro? }
 *  - el:     selector CSS (o lista de alternativas) del elemento a resaltar. Si no está visible
 *            para el rol/estado actual, el paso se salta solo. Sin `el` → tarjeta centrada.
 *  - before: función (h) que prepara la pantalla (p. ej. h.click('#tab')); puede devolver una
 *            función de limpieza que se ejecuta al salir del paso.
 *  - roles:  limita el paso a ciertos roles (ADMIN, SUPERVISOR, OPERATOR, CLIENT, PLATFORM_ADMIN).
 *  - summaryClient: resumen alternativo cuando quien mira es un usuario CLIENT.
 *  - tips: strings, o {t:'texto', mod:'seccion'} para omitir el consejo si esa sección está oculta.
 * El texto admite HTML simple (<b>). La narración por voz lee el texto plano.
 */
window.NINJA_TOUR_GUIDES = {

  /* Recorrido de puesta en marcha: cruza secciones en el orden lógico de una bodega nueva.
   * journey: los pasos llevan `pg` (sección) y `key` (paso de /onboarding, para marcar lo ya hecho)
   * y `stage` (etapa visible arriba). manual: no avanza solo; el usuario puede tocar la pantalla. */
  primeros: {
    icon:'🚀', title:'Primeros pasos', journey:true, manual:true,
    summary:'En 10 minutos dejas tu bodega lista para operar: productos, ubicaciones, stock y tu primera orden. Puedes hacer cada paso mientras lo lees; el recorrido no se cierra al cambiar de sección.',
    steps:[
      {pg:'clients', key:'create_client', stage:'Cliente', el:'#cli-new', place:'bottom', fallbackCenter:true, title:'Crea tu primer cliente', when:function(st){return st&&st.track==='operator';},
        text:'Como operador logístico, todo lo que guardas pertenece a un <b>cliente</b>: sus productos, su stock y sus órdenes. Crea el primero con <b>Nuevo cliente</b> (nombre y RUT bastan). Después podrás darle acceso a su propio portal.'},
      {pg:'products', key:'create_product', stage:'Productos', el:'#pr-new', place:'bottom', title:'1 · Crea tus productos',
        text:'Cada producto es un <b>SKU</b> con código, descripción y, si lo tiene, EAN para escanear. Con <b>Nuevo producto</b> creas uno a la vez; es lo justo para probar.'},
      {pg:'products', key:'create_product', stage:'Productos', el:'#pr-import', place:'bottom', title:'…o carga el catálogo completo',
        text:'Si ya tienes tu maestro en Excel, usa <b>Carga masiva</b>: descarga la plantilla, pégala y súbela. Verás qué se crea y qué cambia antes de confirmar. Es la forma rápida de partir con cientos de SKUs.'},
      {pg:'locations', key:'create_location', stage:'Ubicaciones', el:'#loc-new', place:'bottom', title:'2 · Crea una ubicación de recepción',
        text:'La mercadería entra por una ubicación de zona <b>Recepción</b> (por ejemplo <b>REC-01</b>). Crea al menos una: ahí queda el stock mientras se guarda.'},
      {pg:'locations', key:'create_location', stage:'Ubicaciones', el:['#loc-import','#loc-new'], place:'bottom', title:'…y tus ubicaciones de almacenaje',
        text:'Después crea las de zona <b>Almacenaje</b> con el código de tu bodega (pasillo-rack-nivel, como <b>A-01-1-A</b>). Si son muchas, <b>Carga masiva</b> las crea todas desde la plantilla Excel.'},
      {pg:'inbound', key:'receive_stock', stage:'Stock', el:['#inb-new','#inb-filters'], place:'bottom', fallbackCenter:true, title:'3 · Recibe tu stock',
        text:'Con <b>Nueva orden de recepción</b> declaras qué llega: proveedor, referencia y las líneas con SKU y cantidad esperada. Al llegar el camión, <b>Recepcionar</b> cuenta lo real y deja las unidades en la ubicación de recepción.'},
      {pg:'putaway', key:'receive_stock', stage:'Stock', el:['#pw-body','#pw-tabs'], place:'top', title:'…y guárdalo en su ubicación',
        text:'Lo recibido aparece en <b>Almacenado</b> como pendiente de guardar. El sistema sugiere una ubicación; confirma y el stock queda disponible para vender. También se puede hacer desde la app del operario con escaneo.'},
      {pg:'orders', key:'create_order', stage:'Órdenes', el:'#ord-new', place:'bottom', title:'4 · Crea tu primera orden',
        text:'Normalmente las órdenes llegan solas desde tu e-commerce u OMS. Para probar, <b>Nueva orden</b>: canal, destinatario, courier y las líneas con SKU y cantidad.'},
      {pg:'orders', key:'create_order', stage:'Órdenes', el:'#ord-import', place:'bottom', title:'…o varias de una vez',
        text:'Con <b>Carga masiva</b> subes un Excel con muchas órdenes; cada fila se valida contra tus SKUs y el stock.'},
      {pg:'orders', key:'ship_order', stage:'Órdenes', el:['#ord-reserve-all','#ord-body'], place:'bottom', title:'Reserva y despacha',
        text:'Con stock guardado, <b>Reservar</b> aparta las unidades (nunca vendes lo que no tienes). Luego la orden sigue su camino: picking, empaque y despacho. Cuando despaches la primera, tu bodega está operando.'}
    ],
    outro:'Ya tienes lo esencial. Cada sección tiene su propio tutorial en «▶ Tutorial» y en el Centro de aprendizaje.',
    tips:['Si prefieres ver el flujo completo con datos ficticios, en el Dashboard está «Cargar datos de ejemplo».','La app del operario (menú → Equipo) recibe, guarda, pickea, empaca, despacha, cuenta, procesa devoluciones y arma kits desde el celular: todo se puede hacer pistoleando o tocando en pantalla.']
  },

  aidash: {
    icon:'▦', title:'Dashboard AI',
    summary:'Tableros a tu medida: le pides al agente qué quieres ver y arma los widgets con datos vivos de tu operación. También puedes agregarlos a mano.',
    steps:[
      {el:'#aid-sel', place:'bottom', title:'Tus tableros', text:'Puedes tener varios tableros (uno por cliente, uno para el turno de la mañana, otro para la gerencia). Aquí eliges cuál ver; con los botones de al lado lo <b>creas</b>, <b>renombras</b> o <b>eliminas</b>.'},
      {el:'#aid-tpl', place:'bottom', title:'Parte de una plantilla', text:'Las <b>plantillas</b> traen tableros ya armados: control diario, cumplimiento de deadlines, productividad. Úsalas tal cual o como punto de partida.'},
      {el:'#aid-q', place:'top', title:'Pídelo en lenguaje natural', text:'Escribe qué quieres ver: «órdenes despachadas por día de este mes, por cliente». El agente propone widgets y tú decides <b>Construir</b> o <b>Mejor no</b>. Con <b>¿Qué puedo pedir?</b> ves ejemplos.'},
      {el:'#aid-widget', place:'bottom', title:'O agrega un widget a mano', text:'Eliges la fuente (órdenes, inventario, tareas…), el campo, cómo agrupar y el tamaño. Hay 17 tipos: desde un KPI hasta el mapa 3D de la bodega.'},
      {el:'#aid-canvas', place:'top', title:'El lienzo', text:'Arrastra los widgets para ordenarlos y redimensiónalos desde la esquina. Al pasar el mouse sobre uno puedes <b>editarlo</b>, <b>duplicarlo</b>, ver <b>de dónde sale el dato</b> o eliminarlo.'},
      {el:['#aid-live','#aid-tema'], place:'bottom', title:'En vivo y con tu tema', text:'Con <b>En vivo</b> los datos se refrescan cada 30 segundos, ideal para una pantalla en la bodega. El tema claro u oscuro es por tablero.'}
    ],
    tips:['El botón ⓘ de cada widget explica exactamente qué consulta responde ese número.','Un tablero en modo oscuro y en vivo funciona como pantalla de piso.']
  },

  consignees: {
    icon:'⌂', title:'Destinatarios',
    summary:'La libreta de destinatarios del cliente: a quién le despacha seguido, con RUT validado y varias direcciones, para no volver a escribirlos en cada orden.',
    steps:[
      {el:'#cg-q', place:'bottom', title:'Buscar', text:'Encuentra un destinatario por nombre, RUT o dirección.'},
      {el:'#cg-new', place:'bottom', title:'Nuevo destinatario', text:'Nombre, <b>RUT validado</b> (dígito verificador incluido), contacto y una o varias <b>direcciones</b>. Al crear una orden, eliges el destinatario y su dirección desde la lista.'},
      {el:'#cg-body', place:'top', title:'Editar, desactivar o eliminar', text:'Para <b>eliminar</b> una ubicación debe estar <b>vacía</b> (sin stock de ningún cliente) y sin recepciones abiertas. Su historial de movimientos se conserva. Si prefieres que deje de usarse sin borrarla, <b>desactívala</b>.'}
    ],
    tips:['Un usuario cliente administra sus propios destinatarios desde su portal.']
  },

  mcp: {
    icon:'⚙', title:'Conexión MCP',
    summary:'Deja que un agente externo (el Claude de escritorio de tu jefe de bodega, un ERP con IA, un bot propio) consulte tu operación en vivo a través del protocolo MCP, con una llave que tú controlas.',
    steps:[
      {el:'#mcp-howto', place:'bottom', title:'Cómo conectarse', text:'Aquí está la dirección del servidor y el bloque de configuración listo para pegar en Claude Desktop u otro cliente MCP. Con <b>Copiar configuración</b> lo llevas al portapapeles.'},
      {el:'#mcp-new', place:'bottom', title:'Nueva llave', text:'Cada llave tiene un nombre, un <b>alcance</b> (toda la operación o un cliente) y un <b>vencimiento</b>. El secreto se muestra <b>una sola vez</b>: guárdalo al crearla.'},
      {el:'#mcp-body', place:'top', title:'Tus llaves', text:'La lista muestra cada llave, su alcance, cuándo vence y cuándo se usó por última vez. Las llaves de esta versión son de <b>solo lectura</b>: el agente consulta, no opera.'},
      {el:'#mcp-body', place:'top', title:'Revocar', text:'Si una llave se filtra o ya no se usa, <b>Revocar</b> la deja inválida al instante. El historial de uso se conserva.'}
    ],
    tips:['Un usuario cliente puede crear llaves acotadas a su propio seller.']
  },

  agdiario: {
    icon:'📓', title:'Diario del agente',
    summary:'La memoria del agente: ciclo a ciclo, qué evaluó, qué decidió, qué ejecutó y con qué resultado. Es donde revisas por qué la bodega avanzó como avanzó.',
    steps:[
      {el:'#agd-now', place:'bottom', title:'Estado actual', text:'Si el agente está activo, cuándo corrió por última vez y cuándo vuelve a correr.'},
      {el:'#agt-journal', place:'top', title:'Ciclo a ciclo', text:'Cada entrada es un ciclo: las reglas que evaluó, las alertas que abrió, las acciones que ejecutó (o que propuso, según el nivel de autonomía) y su resultado. Las notas explican el criterio.'}
    ],
    tips:['Las alertas abiertas viven en «Alertas activas»; las reglas y el nivel de autonomía, en «Agente».']
  },

  agalertas: {
    icon:'⚠', title:'Alertas activas',
    summary:'Lo que el agente detectó y todavía nadie resolvió: órdenes estancadas, deadlines en riesgo, operarios sin carga. Cada alerta trae una sugerencia y, cuando se puede, un botón para ejecutarla.',
    steps:[
      {el:'#agt-alerts', place:'top', title:'Cada alerta con su sugerencia', text:'De la más nueva a la más antigua: qué pasa, en qué cliente u orden, y qué propone el agente. La severidad (crítica, alta, media) ordena la atención.'},
      {el:'#agt-alerts', place:'top', title:'Confirmar y ejecutar', text:'Si la alerta tiene una acción automática (balancear picking, asignar a operarios libres, atender un deadline), <b>Ejecutar</b> la aplica. Es reversible y queda auditada en el diario.'},
      {el:['#aga-ackall','#agt-alerts'], place:'bottom', title:'Ir, descartar o descartar todas', text:'<b>Ir</b> te lleva a la pantalla donde se resuelve; <b>Descartar</b> la cierra sin acción. <b>Descartar todas</b> limpia la bandeja cuando ya revisaste el turno.'}
    ]
  },

  torre: {
    icon:'◉', title:'Torre en vivo',
    summary:'La pantalla de piso: en un solo lugar y refrescándose cada 15 segundos, lo que el agente va ejecutando, cómo queda la carga por operario y el trabajo que nadie tiene asignado.',
    steps:[
      {el:['#torre-now','#torre-live'], place:'bottom', title:'En vivo', text:'Se actualiza sola cada 15 segundos. El indicador muestra el último ciclo del agente y cuándo viene el próximo.'},
      {el:'#torre-diario', place:'top', title:'Diario en tiempo real', text:'Las últimas decisiones y acciones del agente, apenas ocurren.'},
      {el:'#torre-carga', place:'top', title:'Carga por operario', text:'Cuántas tareas y unidades tiene cada operario y el tiempo estimado que le queda. Si alguien está sobrecargado o libre, se ve al instante.'},
      {el:'#torre-pend', place:'top', title:'Trabajo sin asignar', text:'Tareas que esperan dueño. Desde Asignaciones (o con el agente en modo automático) se reparten.'}
    ],
    tips:['Déjala abierta en una pantalla de la bodega, en modo oscuro.']
  },

  dashboard: {
    icon:'◧', title:'Dashboard',
    summary:'Tu centro de mando: en una sola pantalla ves cómo viene la operación hoy, qué necesita atención y qué pasó en el inventario.',
    steps:[
      {el:'.side', place:'right', title:'El menú lateral', text:'Desde aquí navegas a todas las secciones. Los <b>Workflows</b> agrupan el día a día de la bodega (órdenes, recepción, picking) e <b>Inventario</b> lo que tienes y dónde. Más abajo están finanzas, comunicación y administración.'},
      {el:'.topbar', place:'bottom', title:'Barra superior: contexto y búsqueda', text:'Aquí eliges la <b>operación</b> y el <b>cliente</b> con el que estás trabajando: todo el panel se filtra según esa selección. El buscador encuentra un SKU, una orden o una ubicación al instante.'},
      {el:'#opmetrics', title:'Actividad operativa', text:'Las métricas de las últimas 24 horas comparadas con el período anterior: órdenes ingresadas, despachadas, unidades recibidas y más. Cambia la ventana a 7, 30 o 90 días, o define un rango personalizado.'},
      {el:['#kpis','#dash-cards'], title:'Indicadores clave', text:'Los KPIs resumen el estado actual: stock disponible, órdenes pendientes, reservas y alertas. Si un número te llama la atención, haz clic en la sección correspondiente para profundizar.'},
      {el:'#dash-scope', place:'bottom', title:'Alcance: operación o cliente', text:'Con <b>Toda la operación</b> ves los números consolidados; con <b>Cliente actual</b>, solo los del seller elegido arriba.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN']},
      {el:'#dash-cards', place:'bottom', title:'Tarjetas de control', text:'Seis indicadores de servicio: órdenes <b>por despachar a tiempo y atrasadas</b>, <b>On Time Fulfillment</b> (de las órdenes con deadline ya despachadas, cuántas salieron a tiempo), <b>precisión de preparación</b>, <b>tiempo de preparación</b> B2B y B2C, y <b>ocupación de bodega</b>. Si una tarjeta dice «pendiente de configurar», te indica qué dato falta.'},
      {el:'#dash-excepciones', place:'top', title:'Excepciones que requieren tu atención', text:'Órdenes vencidas o en riesgo, faltantes, recepciones abiertas: cada línea explica qué pasa y qué hacer, y te lleva a la pantalla donde se resuelve.'},
      {el:['#dash-carga','#dash-cola'], place:'top', title:'Carga pendiente y cola de picking', text:'<b>Carga pendiente por cliente</b> muestra cuánto trabajo queda por seller. <b>Cola de picking por prioridad de courier</b> ordena lo que sale primero según los cortes de cada transportista.'},
      {el:['#dash-prod','#dash-embalaje','#dash-prefac'], place:'top', title:'Productividad, embalaje y pre-facturación', text:'La <b>productividad por operario</b> (unidades y tareas del día), la <b>reposición de material de embalaje</b> cuando un insumo se está acabando y la <b>pre-facturación acumulada</b> por cliente del mes en curso.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN']},
      {el:'.grid2', title:'Gráficos de zona y estados', text:'A la izquierda, cuántas unidades hay en cada <b>zona</b> de la bodega. A la derecha, las órdenes por <b>estado</b>: ingresadas, reservadas, en picking, empacadas y despachadas. Así detectas cuellos de botella de un vistazo.'},
      {el:'#activity', title:'Actividad reciente del ledger', text:'Cada movimiento de inventario queda registrado en un <b>ledger inmutable</b>: quién hizo qué, con qué SKU, en qué ubicación y cuánto. Nada se borra; todo es auditable.'},
      {el:['#side-toggle','.side'], place:'right', title:'Menú: categorías, contadores y candados', text:'Las categorías se pliegan y despliegan; un <b>número rojo</b> junto a Conteo cíclico, Canal clientes o Alertas indica pendientes. Un <b>candado</b> marca un módulo fuera de tu plan: puedes verlo, y al intentar operarlo se explica cómo habilitarlo. El botón « contrae el menú a solo íconos.'},
      {el:'#opapp-btn', place:'bottom', title:'App operador', text:'Este botón abre la <b>app del operador</b> en una ventana nueva (tamaño teléfono) y <b>copia su link</b> al portapapeles, listo para pegarlo en WhatsApp o correo y enviárselo al operario. El operario entra con su correo y contraseña.'},
      {el:['#live-btn','#theme-toggle'], place:'bottom', title:'Al día, modo oscuro y tu cuenta', text:'El punto verde indica que los datos están al día; tócalo para refrescar. La luna cambia a <b>modo oscuro</b>. Desde el candado de la barra cambias tu contraseña, y <b>Cerrar sesión</b> está al pie del menú.'},
      {el:'[id$="-export"]', place:'bottom', title:'Exportar a Excel', text:'Casi todas las tablas tienen un botón <b>Exportar</b> que descarga lo que estás viendo, con los filtros aplicados.', fallbackCenter:true},
      {el:'#nt-topbtn', place:'bottom', title:'Vuelve al tutorial cuando quieras', text:'Cada sección tiene su propio tutorial. Este botón lo abre en cualquier momento, y el <b>Centro de aprendizaje</b> del menú reúne todos los tutoriales y videos.'}
    ],
    tips:['El panel se actualiza solo cada 30 segundos mientras esté visible (punto verde junto al título); tócalo para refrescar al instante.','Usa el selector de cliente para revisar la operación de un seller en particular.','El buscador global acepta SKU, número de orden o código de ubicación.','El ledger de actividad es tu fuente de verdad ante cualquier diferencia de stock.']
  },

  copilot: {
    icon:'✨', title:'Copiloto',
    summary:'Un asistente con inteligencia artificial que analiza tu operación en vivo, te avisa qué necesita atención y responde preguntas con tus datos reales.',
    steps:[
      {el:['#cop-ins-h','#cop-insights'], title:'Qué necesita tu atención', text:'El copiloto revisa órdenes, stock y tareas y te muestra <b>alertas accionables</b>: SKUs por quebrar, órdenes atrasadas, recepciones pendientes. Haz clic en el título para <b>plegar o desplegar</b> el bloque; plegado, muestra el resumen de cuántas alertas hay activas y de qué gravedad.'},
      {el:'#cop-chips', place:'top', title:'Preguntas sugeridas', text:'Estos chips son preguntas frecuentes listas para usar. Haz clic en una para ver la respuesta al instante y aprender qué tipo de cosas puedes preguntar.'},
      {el:'#cop-q', place:'top', title:'Pregúntale a tu WMS', text:'Escribe en lenguaje natural: <b>«¿qué SKUs están por quebrar stock?»</b>, <b>«¿cuántas órdenes hay listas para despachar?»</b> o <b>«asigna el picking pendiente a Pedro»</b>. El copiloto consulta y también puede ejecutar acciones.'},
      {el:['#cop-q','#cop-answer'], place:'top', title:'Gráficos, tablas y reportes', text:'Pide <b>«grafícame las órdenes por estado»</b>, <b>«dame una tabla de stock por cliente»</b> o <b>«arma un reporte de productividad»</b>. El copiloto dibuja los gráficos bajo su respuesta; cada uno se puede ver como <b>tabla dinámica</b> (ordenar, filtrar, agrupar) y exportar a <b>Excel</b>, y el reporte completo sale en un libro con una hoja por gráfico.'},
      {el:'#cop-answer', title:'Respuestas con datos en vivo', text:'Las respuestas se construyen con la información actual de tu operación, no con datos genéricos. Cuando la acción modifica algo (por ejemplo, asignar una tarea), te pedirá confirmación antes de ejecutarla.'},
      {el:'#cop-ai-status', place:'bottom', title:'Conectar la IA', text:'Con <b>Conectar IA</b> eliges proveedor y modelo, pegas tu API key y la pruebas. <b>Ver contexto</b> muestra exactamente qué información de tu operación recibe el modelo; <b>Desconectar</b> la retira.'},
      {el:'#cop-settings', place:'bottom', title:'Confirmar o ejecutar directo', text:'Cuando el copiloto propone una acción (reservar, asignar, mover), puedes pedir que <b>confirme contigo</b> antes o que la <b>ejecute directo</b>. Empieza con confirmación.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN']},
    ],
    tips:['Puedes preguntar por cliente, por SKU o por operario.',{t:'Cada recomendación y acción del copiloto queda registrada en «Auditoría IA».',mod:'aiaudit'}]
  },

  voz: {
    icon:'🎧', title:'Copiloto de voz',
    summary:'Conversa con tu operación manos libres: pregunta cómo viene el día, pide despachar lo que está listo o activa las automatizaciones, todo por voz.',
    steps:[
      {el:'#voz-mic', title:'Toca para hablar', text:'Pulsa el micrófono y habla con naturalidad. La IA transcribe, entiende la intención y te <b>responde por voz</b>. Vuelve a tocar para detener la conversación.'},
      {el:'#voz-mode', place:'left', title:'Confirmar o ejecutar directo', text:'En <b>Confirmar acciones</b>, cualquier orden que modifique la operación se te repite y espera tu «sí». En <b>Ejecución directa</b> se aplica de inmediato. Empieza en modo confirmar hasta tomar confianza.'},
      {el:'.voz-controls', place:'left', title:'Manos libres y voz de respuesta', text:'Con <b>Manos libres</b> la escucha se reactiva sola después de cada respuesta, para conversar sin tocar la pantalla. Puedes silenciar la voz de respuesta y leer el texto.'},
      {el:'#voz-hint', place:'left', title:'Qué puedes decir', text:'Ejemplos: «¿cómo viene la operación hoy?», «despacha las órdenes listas», «mantén el equipo balanceado» o «que nadie quede ocioso». Si la IA necesita una directriz, te preguntará de vuelta.'},
      {el:'#voz-convo', place:'left', title:'Historial de la conversación', text:'Todo lo dicho y respondido queda aquí como transcripción. «Reiniciar conversación» limpia el contexto para empezar un tema nuevo.'}
    ],
    tips:['Usa Chrome o Edge para la mejor calidad de reconocimiento de voz.','Las acciones ejecutadas por voz quedan auditadas igual que las del copiloto de texto.']
  },

  multicliente: {
    icon:'🏢', title:'Todos los clientes',
    summary:'La vista consolidada de la operación: todos tus clientes en una tabla accionable con indicadores operativos y comerciales.',
    steps:[
      {el:'#seller-wrap', place:'bottom', title:'Cómo llegar aquí', text:'En el selector de cliente de la barra superior elige <b>«Todos los clientes»</b>. Vuelve a un cliente específico para trabajar en su operación.'},
      {el:'#mc-kpis', title:'Totales de la operación', text:'Los KPIs consolidan órdenes abiertas, en riesgo, recepciones pendientes, quiebres y facturación del mes de todos los sellers.'},
      {el:'#mc-month', place:'bottom', title:'Filtro por mes', text:'Cambia el mes para comparar la actividad y la pre-facturación de cada cliente en períodos anteriores.'},
      {el:'#mc-table', title:'Tabla comparativa', text:'Cada fila es un cliente. Ordena por cualquier columna haciendo clic en su cabecera para ver, por ejemplo, quién tiene más órdenes en riesgo o quién factura más. Haz clic en un cliente para ir a su detalle.'}
    ]
  },

  orders: {
    icon:'🗎', title:'Órdenes',
    summary:'El flujo completo de fulfillment: desde que la orden entra desde el e-commerce hasta que sale despachada, con reserva de stock anti-sobreventa.',
    steps:[
      {el:'#ord-filters', title:'Filtra por estado', text:'Cada chip es un estado del ciclo de vida: <b>Ingresada → Reservada → En picking → Pickeada → Empacada → Despachada</b>. Haz clic en uno para ver solo esas órdenes y saber cuántas hay en cada etapa.'},
      {el:['#ord-filters [data-f=DL_VENCIDO]','#ord-filters'], place:'bottom', title:'Vencidas y en riesgo', text:'Las dos últimas pastillas filtran por <b>deadline</b>: órdenes que ya pasaron su hora de corte y órdenes a las que les queda poco. En la tabla, la columna Deadline lleva un <b>semáforo</b> con el mismo criterio.'},
      {el:'#ord-new', place:'bottom', title:'Crear una orden manual', text:'Normalmente las órdenes llegan solas desde tu OMS o e-commerce. Con <b>Nueva orden</b> puedes crear una a mano: eliges canal, líneas con SKU y cantidad, courier y destinatario.'},
      {el:'#ord-import', place:'bottom', title:'Carga masiva', text:'¿Muchas órdenes? Sube un Excel con el formato de plantilla y se crean todas de una vez; el sistema valida SKUs y cantidades y te muestra qué filas tuvieron problemas.'},
      {el:'#ord-reserve-all', place:'bottom', title:'Reserva masiva', text:'Reserva el stock de todas las órdenes ingresadas de un solo clic. Cada reserva pasa la unidad de <b>disponible</b> a <b>reservada</b>: así nunca vendes lo que no tienes.'},
      {el:'#ord-body', place:'top', title:'La tabla y sus acciones', text:'Cada fila muestra orden, fecha, canal, tipo y estado. A la derecha aparecen las <b>acciones disponibles según el estado</b>: Reservar, A picking, Empacar, Etiquetas, Despachar o Cancelar. Solo ves lo que corresponde hacer ahora.'},
      {el:'#ord-day', place:'bottom', title:'Planifica por día de deadline', text:'Elige <b>Hoy</b>, <b>Mañana</b> o cualquier día con órdenes para ver solo las que deben salir ese día (en hora de la bodega). Cada opción muestra cuántas órdenes hay y se combina con los chips de estado: por ejemplo, <b>Hoy + Ingresada</b> te dice qué falta reservar para cumplir hoy. Al elegir un día, la tabla se ordena por deadline.'},
      {el:'#ord-seller', place:'bottom', title:'Filtrar por cliente', text:'Al mirar <b>Todos los clientes</b>, este selector deja solo las órdenes de un seller. También puedes ordenar la tabla haciendo clic en cualquier encabezado.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN']},
      {el:['#ord-body [data-oedit]','#ord-body'], place:'left', title:'Editar, cancelar y reactivar', text:'Una orden <b>Ingresada</b> o <b>Reservada</b> todavía se puede <b>editar</b> (líneas, destinatario, courier). <b>Cancelar</b> libera su reserva; si fue un error, <b>Reactivar</b> la vuelve a Ingresada.'},
      {el:['th.selcol','#ord-selall-m'], place:'bottom', title:'Cambio de estado masivo', text:'Marca varias órdenes con las casillas (o <b>todas las visibles</b> de un filtro) y aparece una barra para aplicarles un cambio de estado de una vez: reservar, pasar a picking, confirmar picking, despachar o cancelar. Con <b>Empacar e imprimir etiquetas</b> defines los bultos y los insumos de cada orden y sale un solo trabajo de impresión con todas las etiquetas; <b>Imprimir etiquetas</b> reimprime las de órdenes ya empacadas. Cada orden se procesa por separado y al final ves cuántas se actualizaron, cuántas se omitieron por estado y cuáles fallaron.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN']},
      {el:'#drawer .panel', place:'left', title:'Detalle de la orden', text:'Al hacer clic en una fila se abre el detalle: líneas, destinatario, courier, empaque, tareas asignadas y el <b>historial auditable</b> de cada evento: quién lo hizo y cuándo.',
        before:function(h){ var tr=document.querySelector('#ord-body tr.click'); if(tr){ tr.click(); return function(){ var d=document.getElementById('drawer'); if(d)d.classList.remove('on'); }; } }},
      {el:'#drawer .panel', place:'left', title:'Deadline de la orden', text:'En el detalle ves el <b>deadline</b> (para cuándo debe estar lista), de dónde salió (corte del courier, SLA del cliente o el OMS) y puedes cambiarlo a mano si la operación lo requiere.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN'],
        before:function(h){ var tr=document.querySelector('#ord-body tr.click'); if(tr){ tr.click(); return function(){ var d=document.getElementById('drawer'); if(d)d.classList.remove('on'); }; } }},
      {el:'#ord-export', place:'bottom', title:'Exportar', text:'Descarga la vista actual a Excel para compartirla o analizarla fuera del sistema.'}
    ],
    tips:['Una orden cancelada libera su reserva automáticamente.','Si el stock no alcanza para todas las líneas, la reserva no se hace a medias: es todo o nada.','El picking guiado está en «Cola de preparación».']
  },

  pickqueue: {
    icon:'▶', title:'Cola de preparación',
    summary:'El orden exacto en que hay que preparar los pedidos: primero por prioridad de courier y, dentro de cada courier, del más antiguo al más nuevo.',
    steps:[
      {el:'#pq-body .hint', title:'Orden forzado', text:'La cola respeta la <b>prioridad de courier</b> definida en el mantenedor del cliente y luego aplica <b>FIFO</b>. Nadie decide «cuál preparo»: el sistema ya lo resolvió para cumplir los cortes de retiro.'},
      {el:['#dl-cfg','#pq-body .hint'], place:'bottom', title:'Cortes por courier', text:'Con <b>Configurar cortes</b> defines a qué hora retira cada courier por día de la semana. Con eso cada orden recibe su deadline sola y la cola se ordena por urgencia real.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN']},
      {el:'#pq-body', title:'Las órdenes en fila', text:'Cada tarjeta muestra la posición, el courier, unidades y líneas. Solo aparecen órdenes <b>reservadas</b> o <b>en picking</b>: si la cola está vacía, primero reserva órdenes desde la sección Órdenes.'},
      {el:'#pq-body [data-pqgo]', place:'left', title:'Preparar en cadena', text:'Pulsa <b>Preparar</b> para abrir el picking guiado: el sistema indica de qué ubicación tomar cada SKU. Al terminar, te lleva automáticamente a la siguiente orden de la cola.'}
    ],
    tips:['Configura la prioridad de courier en Clientes → editar cliente.','Un pedido «en picking» conserva su lugar en la fila hasta terminarse.','En la app del operario el picking va por ubicación: escanea la ubicación, luego cada unidad del producto, y la app lo lleva a la siguiente parada en orden de recorrido (según el «orden de picking» de cada ubicación).','Picking en lote: en la app, marca varios pedidos (Picking → Asignados o Libres, o en Mis tareas) y «Pickear juntos». Se recorre una sola vez la bodega y los pedidos se separan en Empaque.','En Empaque la app exige verificar cada producto (escaneándolo o tocándolo) hasta completar <b>exactamente</b> lo pickeado: no deja contar de más ni empacar con faltantes.','Si el operario marca «Falta», el pedido queda en picking y te llega una alerta crítica «Faltante en picking» en Alertas activas.']
  },

  inbound: {
    icon:'▼', title:'Recepción',
    summary:'Controla la entrada de mercadería: cada recepción tiene lo esperado versus lo realmente contado, con recepción parcial y cierre con faltantes.',
    steps:[
      {el:'#inb-filters', title:'Estados de recepción', text:'<b>Creada</b>: se anunció pero la carga aún no llega. <b>En bodega</b>: la carga llegó pero aún no se abre ni se cuenta (un pallet esperando en el andén). <b>Parcial</b>: se recibió una parte. <b>Recepcionada</b>: cerrada. Filtra con los chips para enfocarte en lo que falta.'},
      {el:['#inb-body [data-rarrive]','#inb-body'], place:'left', title:'Marcar en bodega', text:'Cuando llega la carga y todavía no se abre, usa <b>Marcar en bodega</b>: queda registrado cuándo llegó y quién la recibió, con una nota opcional. El stock aún no entra: eso pasa al recepcionar.'},
      {el:'#inb-new', place:'bottom', title:'Nueva orden de recepción', text:'Crea el aviso de llegada con proveedor, referencia y los SKUs con cantidad <b>esperada</b>. Los campos de <b>lote</b> y <b>vencimiento</b> se habilitan solo si el producto tiene ese control activo en Productos; si no, aparecen bloqueados. Recibe un ID propio (OR-AAAAMMDD-XXXX) para seguirla.'},
      {el:'#inb-import', place:'bottom', title:'Carga masiva', text:'Importa varias recepciones desde Excel a la vez, ideal cuando el proveedor te envía su packing list. <b>Lote</b> y <b>vencimiento</b> se completan solo en los SKUs que tienen ese control (el formato trae la hoja «Productos» que lo indica); si una fila los trae en un SKU sin control, esa recepción no se crea y el resultado te dice qué fila corregir.'},
      {el:['#inb-body [data-redit]','#inb-body'], place:'left', title:'Editar o eliminar', text:'Una recepción <b>Pendiente</b> se puede <b>editar</b> (líneas, proveedor, referencia) o <b>eliminar</b> si se creó por error. Una vez que registra unidades, queda en el kardex y ya no se elimina.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN']},
      {el:'#inb-body', place:'top', title:'Cotejo físico vs. teórico', text:'Con <b>Recepcionar</b> el equipo cuenta cada SKU. «Recibido ahora» <b>parte en 0</b>: ingresa lo que realmente cuentas. Si el producto controla <b>lote</b> y/o <b>vencimiento</b>, el cotejo pide ese dato y es <b>obligatorio</b>; si no los controla, no aparecen y solo registras la cantidad. El stock entra al inventario <b>solo al confirmar</b>, y puedes recibir en varias entregas.'},
      {el:'#inb-body tr', place:'bottom', title:'Manifiesto y auditoría', text:'Cada recepción se puede imprimir como <b>manifiesto PDF</b> con esperado, recibido y diferencia, y guarda una bitácora de quién contó qué y cuándo.'}
    ],
    tips:['Lo recibido queda en zona de recepción: guárdalo en su ubicación desde «Almacenado».','¿Necesitas lote o vencimiento en un producto? Actívalo en Productos → Control de lote / Control de vencimiento.','En la app del operario, «Recepción» muestra las recepciones asignadas y las libres para tomar; desde ahí el operario marca «Llegó al andén» y hace el cotejo escaneando o tocando el producto. El contador parte en <b>cero</b>: el operario cuenta lo que realmente llegó, no se asume lo pedido.','Una recepción pendiente se puede editar; una con stock ya recibido se puede anular revirtiendo el stock si sigue íntegro.']
  },

  returns: {
    icon:'↩', title:'Devoluciones',
    summary:'Logística reversa enlazada a la orden original: recibe la devolución, haz el control de calidad y dispón cada unidad a stock, merma o cuarentena.',
    steps:[
      {el:'#ret-new', place:'bottom', title:'Registrar una devolución', text:'Parte desde la <b>orden de salida original</b>: eliges qué líneas y cuántas unidades vuelven. Así la devolución queda trazada con el pedido y el cliente.'},
      {el:'#ret-body', place:'top', title:'QA y disposición', text:'Al abrir la devolución revisas unidad por unidad y decides: <b>a stock</b> (vuelve a estar disponible), <b>merma</b> (se descarta) o <b>cuarentena</b> (se aparta para revisión). La columna «Dispuesto» resume el resultado.'},
      {el:'#ret-body', place:'top', title:'Detalle e historial', text:'Haz clic en una devolución para ver sus líneas, la disposición de cada unidad (stock, merma o cuarentena) y el historial de quién hizo qué. En el QA también puedes <b>agregar un producto que no corresponde</b> a la orden original.'},
      {el:'[data-pg=returns] .toolbar', title:'Estados', text:'<b>Pendiente</b> cuando aún no se hace QA, <b>Parcial</b> si se dispuso una parte y <b>Completada</b> al terminar. Todo queda en el kardex como movimiento de tipo Devolución.'}
    ]
  },

  putaway: {
    icon:'⇲', title:'Almacenado',
    summary:'Lo recibido espera en zona de recepción; aquí lo guardas en su ubicación definitiva con un destino sugerido automáticamente.',
    steps:[
      {el:'#pw-body', place:'top', title:'Pendientes de guardar', text:'Cada fila es stock que ya entró pero sigue en recepción: SKU, lote y vencimiento, de qué recepción viene y cuánto falta por guardar.'},
      {el:'#pw-tabs', place:'bottom', title:'Desde recepción y por reponer', text:'Dos pestañas: lo que llegó por <b>recepción</b> y espera ubicación, y lo que hay que <b>reponer</b> en picking porque se está acabando.'},
      {el:['[data-pg=putaway] thead th:nth-child(6)','#pw-body'], place:'top', title:'Destino sugerido', text:'El sistema propone la mejor ubicación según reglas de <b>slotting</b>: cercanía a la zona de picking, rotación del SKU y espacio disponible. Puedes aceptar la sugerencia o elegir otra.'},
      {el:['#pw-body td:last-child','#pw-body'], place:'left', title:'Guardar', text:'Pulsa Guardar, confirma la cantidad y la ubicación. El movimiento queda en el kardex como <b>Guardado</b> y el stock pasa a estar disponible para reservar.'},
      {el:['#pw-body [data-pwall]','#pw-body'], place:'left', title:'Guardar todo aquí', text:'Si aceptas la sugerencia, <b>Guardar todo aquí</b> mueve toda la cantidad de una vez. Si prefieres repartirla, elige otra ubicación y una cantidad parcial.', roles:['ADMIN','SUPERVISOR','OPERATOR','PLATFORM_ADMIN']},
    ],
    tips:['Los operarios pueden hacer el putaway desde la app móvil escaneando la ubicación.','En la app, el guardado muestra «Por guardar N un» del SKU en esa ubicación: se guarda de a una (escaneando cada unidad o «Guardar 1»), todas de una vez («Guardar todas») u otra cantidad, y se puede cambiar el destino a mitad de camino. La tarea sigue en la bandeja del operario hasta que el origen queda vacío.',{t:'Las sugerencias aceptadas o rechazadas alimentan la Auditoría IA.',mod:'aiaudit'}]
  },

  assembly: {
    icon:'⊞', title:'Armado de kit',
    summary:'Ensambla kits de stock propio a partir de sus componentes, eligiendo de qué ubicación sale cada uno y dejando todo auditado.',
    steps:[
      {el:'#asm-kits', place:'top', title:'Kits armables', text:'Aquí ves los kits de tipo <b>armado</b> con su receta (componentes y cantidades) y el stock actual del kit. Los kits <b>virtuales</b> no aparecen: esos se explotan solos al pickear.'},
      {el:['#asm-kits td:last-child','#asm-kits'], place:'left', title:'Armar', text:'Indica cuántos kits armar y, por cada componente, de qué ubicación se extrae. El sistema descuenta los componentes y suma el kit terminado en la ubicación destino.'},
      {el:'#asm-hist', place:'top', title:'Historial auditable', text:'Cada armado registra fecha, kit, cantidad, destino, extracciones por ubicación y usuario. Sirve para explicar cualquier diferencia de componentes.'}
    ],
    tips:['Define las recetas en Productos → tipo Kit.','El armado se cobra en facturación por kit si el tarifario lo incluye.']
  },

  movements: {
    icon:'↹', title:'Movimientos',
    summary:'El kardex completo del ledger de inventario: cada entrada, salida, reserva y ajuste, con filtros para encontrar cualquier movimiento en segundos.',
    steps:[
      {el:'.mvbar', title:'Filtros combinables', text:'Filtra por <b>SKU</b>, <b>tipo</b> de movimiento (recepción, guardado, picking, despacho, ajuste…), ubicación, usuario, cliente, referencia y rango de fechas. Los filtros se combinan entre sí.'},
      {el:'#mv-table', place:'top', title:'Lectura del kardex', text:'Cada fila es un movimiento inmutable: fecha, tipo, SKU, ubicación, lote, estado del stock (disponible o reservado), quién lo hizo, referencia y cantidad con signo. Positivo entra, negativo sale.'},
      {el:'.mvactions', title:'Limpiar y exportar', text:'Con <b>Limpiar filtros</b> vuelves a la vista completa. <b>Exportar</b> descarga a Excel exactamente lo que estás viendo, ideal para conciliar con el cliente.'}
    ],
    tips:['Para reconstruir la historia de un SKU, filtra por SKU y ordena por fecha.','La referencia enlaza el movimiento con su orden, recepción o devolución.']
  },

  counts: {
    icon:'◎', title:'Conteo cíclico',
    summary:'El sistema propone qué contar y cuándo según la estrategia del cliente, para mantener la exactitud de inventario sin detener la bodega.',
    steps:[
      {el:'#cc-strat', place:'bottom', title:'Estrategia del cliente', text:'La estrategia (por ejemplo <b>ABC</b>) define la frecuencia: los SKUs de mayor rotación o valor se cuentan más seguido. Se configura por cliente en el mantenedor de clientes.'},
      {el:'#cc-body', place:'top', title:'Tareas propuestas', text:'Cada tarea indica prioridad, objetivo (ubicación o SKU) y el motivo por el que se propone: diferencia reciente, alta rotación, tiempo sin contar…'},
      {el:['#cc-body td:last-child','#cc-body'], place:'left', title:'Ejecutar el conteo', text:'Al contar ingresas la cantidad física. Si difiere de la teórica, el sistema genera el <b>ajuste</b> correspondiente y lo registra en el kardex. La exactitud resultante se ve en el Dashboard.'}
    ]
  },

  inventory: {
    icon:'▦', title:'Inventario',
    summary:'Todo el stock del cliente: cuánto hay de cada SKU, en qué ubicación y en qué estado, con la distinción clave entre físico, reservado y disponible.',
    steps:[
      {el:'#inv-q', place:'bottom', title:'Buscar', text:'Escribe un SKU, parte de la descripción o un código de ubicación y la tabla se filtra al instante.'},
      {el:'#inv-views', place:'bottom', title:'Dos formas de ver el stock', text:'<b>Consolidado por SKU</b> muestra totales: físico, reservado y disponible. <b>Detalle por ubicación</b> baja al nivel de cada posición, con lote y vencimiento.'},
      {el:'#inv-move', place:'bottom', title:'Guardar o mover', text:'Traslada stock entre ubicaciones o guarda lo que sigue en recepción. Cada traslado queda registrado en el kardex.'},
      {el:'#inv-body', place:'top', title:'Leer la tabla', text:'<b>Disponible = físico − reservado</b>. Lo reservado ya tiene dueño (una orden) y no se puede volver a vender. Las cantidades en cuarentena tampoco cuentan como disponibles.'},
      {el:'#inv-body', place:'top', title:'Stock bajo', text:'Una fila se marca en <b>naranja</b> cuando el disponible de un SKU cae bajo su mínimo. Es la señal para reponer o avisar al cliente.'},
      {el:'#inv-body', place:'top', title:'Lo que ve el cliente', text:'Un usuario cliente ve solo su propio stock, agrupado por SKU y <b>lote o serie</b>, sin las ubicaciones internas de la bodega ni la opción de mover.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN']},
      {el:'#inv-export', place:'bottom', title:'Exportar', text:'Descarga el inventario actual a Excel para conciliaciones o reportes al cliente.'}
    ],
    tips:['Si el disponible es menor de lo que esperas, revisa las reservas en Órdenes.','El detalle por ubicación es la vista que usa el operario para el picking.']
  },

  products: {
    icon:'◲', title:'Productos',
    summary:'El maestro de SKUs del cliente: crea y edita productos, define niveles de empaque y arma kits virtuales o de stock propio.',
    steps:[
      {el:'#pr-q', place:'bottom', title:'Buscar productos', text:'Encuentra un SKU por código o descripción.'},
      {el:'#pr-new', place:'bottom', title:'Nuevo producto', text:'Define código SKU, descripción, tipo (simple o kit), EAN y niveles de empaque (unidad, caja/DUN). El SKU es <b>propio del cliente</b>: dos clientes pueden usar el mismo código sin colisión.'},
      {el:'#pr-import', place:'bottom', title:'Carga masiva', text:'Sube el maestro completo desde Excel. Es la forma más rápida de iniciar un cliente nuevo.'},
      {el:'#pr-body', place:'top', title:'Kits virtuales y armados', text:'Un kit <b>virtual</b> se explota en sus componentes al reservar y pickear. Un kit <b>armado</b> tiene stock propio y se ensambla en bodega. Elige según cómo trabaja el cliente.'},
      {el:'#pr-body', place:'top', title:'Historial por producto', text:'El botón <b>Historial</b> de cada fila muestra cada creación, edición, activación o desactivación con usuario y fecha. Un SKU desactivado no se puede usar en órdenes nuevas pero conserva su historia.'},
      {el:'#pr-export', place:'bottom', title:'Exportar', text:'Descarga el catálogo a Excel con los mismos campos de la plantilla de carga: sirve para revisarlo o corregirlo y volver a subirlo.'},
    ]
  },

  packaging: {
    icon:'▧', title:'Embalajes',
    summary:'Los insumos de embalaje de la bodega (cajas, bolsas, relleno) con su precio y saldo, para controlarlos y cobrarlos por pedido.',
    steps:[
      {el:'#pkg-new', place:'bottom', title:'Nuevo insumo', text:'Registra cada tipo de caja o material con SKU interno, EAN, nombre y <b>precio</b>. Son de la bodega, no del cliente.'},
      {el:'#pkg-body', place:'top', title:'Saldo y consumo', text:'El saldo baja cada vez que un empaque usa el insumo. Así sabes cuándo reponer y cuánto embalaje se consumió por cliente para facturarlo.'},
      {el:'#pkg-body', place:'top', title:'Reponer, costos e historial', text:'Con <b>Reponer</b> registras cada ingreso con cantidad, <b>costo unitario de compra</b>, proveedor o N° de guía y usuario. El sistema calcula el <b>costo promedio ponderado</b> (PMP) del insumo, el margen contra el precio de cobro y el valor del stock. <b>Historial</b> muestra reposiciones, consumos (valorizados al costo del momento) y ajustes.'},
      {el:'#pkg-body', place:'top', title:'Ajuste y precio por cliente', text:'<b>Ajuste</b> corrige el saldo tras un conteo (con motivo). <b>Precios cliente</b> fija un precio distinto del base para un seller en particular; ese es el que se factura.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN']},
    ]
  },

  locations: {
    icon:'▤', title:'Ubicaciones',
    summary:'El mapa de la bodega: cada posición con su ocupación. Las ubicaciones son compartidas entre clientes (modelo caótico) para aprovechar el espacio.',
    steps:[
      {el:'#loc-new', place:'bottom', title:'Nueva ubicación', text:'Crea posiciones con código (pasillo-rack-nivel), zona y capacidad. Las zonas se usan en los gráficos del dashboard y en las sugerencias de guardado.'},
      {el:'#loc-import', place:'bottom', title:'Carga masiva', text:'Descarga el formato Excel, completa una fila por ubicación (código, zona, bodega, capacidad, cercanía a picking) y súbelo. Antes de guardar verás qué se crea y qué cambia. Ideal para montar la bodega completa de una vez.', roles:['PLATFORM_ADMIN','ADMIN','SUPERVISOR']},
      {el:['#loc-q','#loc-zone'], place:'bottom', title:'Buscar y filtrar', text:'Busca por código o filtra por <b>zona</b> (recepción, almacenaje, picking, despacho, cuarentena). El contador muestra cuántas ubicaciones cumplen el filtro.'},
      {el:['#loc-view','#loc-export'], place:'bottom', title:'Lista o tarjetas, y exportar', text:'La vista de <b>lista</b> es más densa para bodegas grandes; la de <b>tarjetas</b> muestra la ocupación con color. <b>Exportar</b> descarga el mapa completo a Excel.'},
      {el:['#loc-grid','#loc-listwrap'], place:'top', title:'Ocupación en vivo', text:'Cada tarjeta muestra la ubicación, su zona y cuántas unidades tiene. Haz clic para ver qué SKUs y de qué clientes están ahí. El color indica el nivel de ocupación.'},
      {el:['#loc-selall','#loc-listwrap','#loc-grid'], place:'bottom', title:'Eliminar varias a la vez', text:'Marca la casilla de cada ubicación (o la del encabezado para todas las vacías) y usa <b>Eliminar seleccionadas</b>. Solo se pueden eliminar ubicaciones <b>vacías</b>: las que tienen stock aparecen bloqueadas. Al terminar ves cuáles se eliminaron y cuáles no, con el motivo.'},
      {el:['#loc-grid','#loc-listwrap'], place:'top', title:'Editar, desactivar o eliminar', text:'Una ubicación que nunca tuvo movimientos se puede <b>eliminar</b>. Si ya registró stock, el kardex la referencia: en ese caso se <b>desactiva</b> y deja de usarse para guardado y picking.'}
    ],
    tips:['Imprime las etiquetas de ubicación para el escaneo desde la app móvil.']
  },


  billing: {
    icon:'$', title:'Facturación',
    summary:'Cobra tus servicios logísticos: define el tarifario de cada cliente y genera la factura mensual automáticamente a partir del ledger.',
    summaryClient:'Revisa las facturas de servicios logísticos que emite tu operador, abre el detalle en PDF y apruébalas cuando corresponda.',
    steps:[
      {el:'#bill-tabs', place:'bottom', title:'Resumen y facturas', text:'La pestaña <b>Resumen</b> es el dashboard de facturación de la operación; <b>Facturas</b> es donde defines tarifas y emites.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN']},
      {el:'#bill-manage .card:first-child', place:'right', title:'Tarifario del cliente', text:'Seis conceptos: <b>cuota fija</b> mensual, <b>almacenamiento</b> por unidad-mes, <b>recepción</b> por unidad, <b>despacho</b> por pedido, <b>picking</b> por unidad y <b>armado</b> por kit. Guarda y quedan vigentes para las próximas facturas.',
        before:function(h){ h.click('[data-billtab=inv]'); }},
      {el:'#rt-approval', place:'right', title:'Aprobación del cliente', text:'Si lo activas, cada factura queda <b>pendiente</b> hasta que el cliente la apruebe desde su portal, registrando quién y cuándo. Si no, se emite directamente.'},
      {el:'#bill-manage .card:last-child', place:'left', title:'Generar la factura', text:'Elige año y mes. <b>Vista previa</b> te muestra el cálculo concepto por concepto antes de emitir. El almacenamiento integra las unidades físicas en el tiempo (unidad-mes); <b>despacho, picking y embalaje se cobran por las órdenes despachadas dentro del mes</b>, así un pedido nunca se factura a medias entre dos períodos.'},
      {el:'#bill-invoices', place:'top', title:'Facturas emitidas', text:'Cada factura tiene período, fecha, emisor, estado y total. Ábrela para ver el detalle y descargar el <b>PDF imprimible</b>.'},
      {el:'#bill-invoices', place:'top', title:'Ciclo de cada factura', text:'Al abrir una factura: <b>Editar</b> ítems y número mientras no esté facturada; <b>Facturar</b> subiendo el documento tributario (PDF o XML); <b>Ver</b> o descargar ese documento; <b>Deshacer</b> si te equivocaste; <b>Enviar por correo</b> al cliente, con el registro de envíos; y <b>Eliminar</b> una factura que no corresponde.', roles:['ADMIN','PLATFORM_ADMIN']},
      {el:'#bd-kpis', title:'Dashboard de facturación', text:'De vuelta en Resumen: ingresos del período, composición por concepto, tendencia mensual y apertura por cliente. Es la mirada comercial de la operación.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN'],
        before:function(h){ h.click('[data-billtab=dash]'); return function(){ h.click('[data-billtab=inv]'); }; }},
      {el:['#bd-year','#bd-month'], place:'bottom', title:'Filtros del resumen', text:'Elige año y mes para ver los KPIs y gráficos de ese período.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN'],
        before:function(h){ h.click('[data-billtab=dash]'); return function(){ h.click('[data-billtab=inv]'); }; }},
      {el:'#bill-cli-note', title:'Portal del cliente', text:'Como cliente, aquí revisas las facturas emitidas por tu operador, abres el detalle y las <b>apruebas</b> cuando corresponde.', roles:['CLIENT']}
    ],
    tips:[{t:'Cruza la facturación con los costos en «Rentabilidad» para ver el margen real por cliente.',mod:'costos'}]
  },

  costos: {
    icon:'📊', title:'Rentabilidad',
    summary:'Ingreso versus costo por actividad, cliente por cliente, y la eficiencia de la mano de obra comparando el costo estándar con el real.',
    steps:[
      {el:'#cos-month', place:'bottom', title:'Elige el mes', text:'Todo el análisis se calcula para el período seleccionado.'},
      {el:'#cos-rates-card', title:'Tarifario de costos', text:'Define la tarifa <b>estándar</b> de mano de obra, el costo/hora real por rol, almacenaje por unidad-mes, embalaje como % del cobro, el overhead mensual y cómo prorratearlo. Abajo, la productividad estándar (unidades/hora) por tipo de tarea.',
        before:function(h){ var c=document.getElementById('cos-rates-card'); if(c&&c.classList.contains('hidden')){ h.click('#cos-rates-toggle'); return function(){ h.click('#cos-rates-toggle'); }; } }},
      {el:'#cos-kpis', title:'Resultado del período', text:'Ingreso facturado, costo real, margen y eficiencia global. Si el margen se aleja del objetivo, la tabla de abajo te dice en qué cliente y en qué concepto.'},
      {el:'#cos-prof-body', place:'top', title:'Rentabilidad por cliente', text:'Por cada cliente: ingreso, costo real desglosado en mano de obra (estándar y real), almacenaje, embalaje y overhead, margen real, porcentaje y objetivo. Detecta clientes que cuestan más de lo que pagan.'},
      {el:'#cos-eff-body', place:'top', title:'Eficiencia estándar vs. real', text:'Por operario o por tarea: unidades, horas reales frente a horas estándar, eficiencia y varianza en dinero. Es la herramienta para gestionar la productividad del equipo.'}
    ],
    tips:['Ajusta los estándares (u/h) cuando cambie el proceso; una eficiencia siempre superior al 120% suele indicar un estándar desactualizado.']
  },

  plan: {
    icon:'◆', title:'Plan',
    summary:'Tu plan de Ninja WMS: qué módulos incluye y cuánto has usado este mes.',
    steps:[
      {el:'#plan-current', place:'right', title:'Tu plan actual', text:'Muestra el plan contratado, los módulos habilitados y los límites. Los módulos que no incluye aparecen con un <b>candado</b> en el menú.'},
      {el:'#plan-trial', place:'bottom', title:'Tu período de prueba', text:'Durante la prueba tienes el plan Growth completo. La barra indica cuántos días quedan; al terminar, la cuenta sigue en Free y los módulos que no incluye quedan visibles con candado.', roles:['ADMIN','SUPERVISOR','CLIENT']},
      {el:'#plan-usage', place:'left', title:'Uso este mes', text:'Órdenes, SKUs, usuarios y otros contadores frente a su límite. Si te acercas al tope, habla con tu ejecutivo para revisar el plan.'},
      // El comparador solo existe para la plataforma: es una tabla de tarifas. El paso
      // se filtra por rol para que el tour no apunte a una tarjeta que no está.
      {el:'#plan-catalog', place:'top', roles:['PLATFORM_ADMIN'], title:'Compara los planes', text:'Todos los planes lado a lado con sus módulos, límites y tarifas en CLP o USD. Desde aquí asignas un plan a la cuenta.'}
    ]
  },

  chat: {
    icon:'💬', title:'Mensajes',
    summary:'Chat interno entre el cliente y el equipo de operaciones, con el contexto de la operación siempre a mano.',
    steps:[
      {el:'#chat-inbox-pane', place:'right', title:'Conversaciones', text:'Como operador ves una conversación por cliente; el contador indica mensajes sin leer. Como cliente, hablas directamente con el equipo de operaciones.'},
      {el:'#chat-msgs', title:'El hilo', text:'Los mensajes se muestran en orden cronológico con autor y hora. Todo queda guardado como respaldo de acuerdos e instrucciones.'},
      {el:'.chat-composer', place:'top', title:'Escribir', text:'Redacta y pulsa <b>Enviar</b>. La otra parte recibe la notificación en el contador del menú.'}
    ]
  },

  voicechannel: {
    icon:'🎙️', title:'Canal de voz',
    summary:'El canal directo entre el piso de la bodega y la administración: los operarios dejan mensajes de voz o texto y la IA los clasifica y resume.',
    steps:[
      {el:'#voc-compose .grid2', title:'Dejar un mensaje', text:'Graba un <b>mensaje de voz</b> o escribe uno de texto. Una nota opcional ayuda a clasificarlo (por ejemplo «falta stock en zona A»).'},
      {el:'#voc-mythread', place:'top', title:'Mi hilo', text:'Aquí ves tus mensajes enviados y las respuestas de la administración.'},
      {el:'#voc-threads', title:'Bandeja de administración', text:'Como admin, un hilo por operador: escucha o lee cada mensaje y responde desde el mismo lugar.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN'],
        before:function(h){ h.click('[data-voctab=threads]'); return function(){ h.click('[data-voctab=compose]'); }; }},
      {el:'#voc-insights', title:'Estadísticas e IA', text:'Los tópicos más frecuentes, la actividad por operador y los <b>insights del agente</b>: patrones que se repiten y sugerencias de mejora extraídas de los mensajes.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN'],
        before:function(h){ h.click('[data-voctab=insights]'); return function(){ h.click('[data-voctab=compose]'); }; }}
    ]
  },

  webhooks: {
    icon:'🔗', title:'Webhooks',
    summary:'Integra tus sistemas: Ninja WMS envía por HTTP cada evento de despacho y recepción a la URL que definas.',
    steps:[
      {el:'#wh-new', place:'bottom', title:'Nuevo webhook', text:'Indica la URL de destino y qué eventos suscribir (orden despachada, recepción confirmada, etc.). Se genera un <b>secreto</b> para que verifiques la firma de cada entrega.'},
      {el:'#wh-list', place:'top', title:'Tus suscripciones', text:'Cada fila muestra URL, eventos, alcance y estado. Puedes pausar, probar o eliminar una suscripción.'},
      {el:'#wh-list', place:'top', title:'Editar, probar, entregas y eliminar', text:'Desde cada fila puedes <b>editar</b> URL y eventos, <b>activar o pausar</b>, <b>probar</b> (envía un evento de ejemplo) y ver las <b>entregas</b> con su respuesta HTTP para depurar. <b>Eliminar</b> corta la suscripción.'},
      {el:'#wh-access-card', place:'top', title:'Acceso de clientes', text:'Como operador decides qué clientes pueden administrar sus propios webhooks desde su portal.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN']}
    ],
    tips:['Guarda el secreto al crearlo: por seguridad no se vuelve a mostrar.']
  },

  activity: {
    icon:'📋', title:'Actividad',
    summary:'Quién hizo qué y cuándo: la productividad de cada operario y la línea de tiempo completa de eventos de órdenes e inventario.',
    steps:[
      {el:'#act-toggle', place:'bottom', title:'Ventana de tiempo', text:'Elige 24 horas, 7, 30 o 90 días, todo el historial o un rango personalizado.'},
      {el:'#act-user', place:'bottom', title:'Filtrar por operador', text:'Enfócate en una persona para revisar su jornada o comparar con el resto.'},
      {el:'#act-kpis', title:'Resumen', text:'Totales de eventos del período: reservas, picking, empaques, despachos, recepciones y guardados.'},
      {el:'#act-prod-body', place:'top', title:'Productividad por operador', text:'Una matriz con las acciones de cada operario por tipo. Detecta quién concentra la carga y quién puede apoyar.'},
      {el:'#act-feed', place:'top', title:'Línea de tiempo', text:'Cada evento con hora, usuario, tipo y referencia. Es el registro que respalda cualquier revisión con el cliente o el equipo.'}
    ]
  },

  aiaudit: {
    icon:'🧠', title:'Auditoría IA',
    summary:'Gobernanza de la inteligencia artificial: cada recomendación y acción de los agentes queda registrada, con su tasa de aceptación y su efecto.',
    steps:[
      {el:'#aia-kpis', title:'Indicadores', text:'Cuántas recomendaciones se generaron, qué porcentaje fue aceptado y cuántas acciones ejecutaron los agentes.'},
      {el:'#aia-type-body', place:'top', title:'Aceptación por tipo', text:'Sugerencias de guardado, asignaciones, alertas del agente proactivo… Por cada tipo, cuántas se aceptaron. Una tasa baja indica que hay que ajustar la regla.'},
      {el:'#aia-act-body', place:'top', title:'Acciones de agente', text:'La bitácora completa: fecha, agente, decisión, quién la aprobó, orden afectada y resultado. Nada ocurre sin dejar rastro.'}
    ]
  },

  asignaciones: {
    icon:'🧑‍🏭', title:'Asignaciones',
    summary:'Balancea la carga de trabajo entre operarios: mira el pool de tareas pendientes, asigna manualmente o deja que el sistema equilibre solo.',
    steps:[
      {el:'#asg-view', place:'bottom', title:'Dos vistas', text:'<b>Por tipo de tarea</b> muestra la carga y el pool de un tipo (picking, empaque, despacho…). <b>Por operario</b> muestra todo lo asignado a una persona.'},
      {el:'#asg-type', place:'bottom', title:'Familia de tarea', text:'Cambia entre picking, empaque, despacho, guardado, recepción, re-slotting y conteo. Cada familia tiene su propio pool.'},
      {el:'#asg-mode', place:'bottom', title:'Advisory o estricto', text:'En <b>Advisory</b> el sistema sugiere y tú confirmas. En <b>Estricto</b> los operarios solo pueden tomar lo que tienen asignado.'},
      {el:'#asg-selfpick', place:'bottom', title:'Que los operarios tomen tareas', text:'Con <b>Tomar tareas</b> activado, cada operario ve en su app la pestaña <b>Disponibles</b> y se asigna trabajo solo, en el orden de prioridad de la cola. Útil cuando no hay supervisor repartiendo.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN']},
      {el:'#asg-balance', place:'bottom', title:'Auto-balancear y redistribuir', text:'<b>Auto-balancear</b> reparte el pool según velocidad y carga de cada operario. <b>Redistribuir</b> mueve tareas no iniciadas del más cargado al más libre. <b>Continuo</b> lo hace solo, permanentemente.'},
      {el:'#asg-load-body', place:'top', title:'Carga por operario', text:'Velocidad histórica en unidades por hora, tareas abiertas, unidades y horas estimadas. Así ves quién terminará primero y quién va atrasado.'},
      {el:['#tt-body','#tt-learn'], place:'top', title:'Modelo de tiempo', text:'En la vista <b>Por tipo de tarea</b> ves cuánto tarda cada familia (picking, guardado, recepción) por unidad y por ubicación visitada. <b>Reajustar</b> vuelve a calcularlo con los tiempos reales de tu bodega; con eso la <b>proyección de carga</b> tras balancear es realista.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN'],
        before:function(h){ var on=document.querySelector('#asg-view .segbtn.on'), t=document.querySelector('#asg-view .segbtn[data-asgv=tipo]'); if(t&&on!==t){ t.click(); return function(){ if(on)on.click(); }; } }},
      {el:'#asg-pool-body', place:'top', title:'Pool de pendientes', text:'Cada tarea pendiente con su cliente y unidades. Asigna a un operario desde la última columna o deja que el balanceo lo haga. Los operarios que no tienen esa <b>habilidad</b> aparecen deshabilitados: el sistema no les asigna esa actividad.'}
    ],
    tips:[{t:'El copiloto de voz puede activar el balanceo: «mantén el equipo balanceado solo».',mod:'voz'}]
  },

  agente: {
    icon:'🛰️', title:'Agente',
    summary:'El agente de bodega corre en el servidor con su propio reloj: vigila la operación, genera alertas por orden, SKU, lote u operario, y ejecuta o propone acciones según el nivel de autonomía que fijes.',
    steps:[
      {el:'#agt-status', place:'bottom', title:'Nivel de autonomía y modo sombra', text:'Elige hasta dónde puede actuar solo: <b>0</b> solo propone, <b>1</b> asigna y balancea, <b>2</b> además avanza órdenes y crea recepciones u órdenes, <b>3</b> todo dentro de límites. Con <b>modo sombra</b> decide y anota lo que haría sin ejecutar: úsalo para calibrar antes de soltarlo. Aquí también fijas límites por ciclo y por hora, el correo o webhook de aviso y la pausa.'},
      {el:'#agt-eval', place:'bottom', title:'Ejecutar ciclo ahora', text:'Fuerza un ciclo completo inmediato. Normalmente corre solo cada dos minutos, aunque nadie tenga el panel abierto.'},
      {el:'.nav[data-pg=agalertas]', place:'right', title:'Alertas por entidad', text:'Cada alerta nombra la orden, el SKU, el lote o el operario afectado, con una sugerencia y, cuando aplica, un botón para ejecutarla. Viven en <b>Alertas activas</b>, en el menú.'},
      {el:'#agt-instr', place:'top', title:'Instrucciones al agente', text:'Directrices en lenguaje natural que el agente respeta en cada ciclo («hoy priorizar Chilexpress», «no despachar Tienda X hasta que apruebe»), con vigencia opcional. También se pueden dictar desde el copiloto.'},
      {el:'#agt-agenda', place:'top', title:'Ventanas horarias', text:'Define en qué días y horas puede actuar el agente. Fuera de esas ventanas solo observa y alerta; no ejecuta.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN']},
      {el:'.nav[data-pg=agdiario]', place:'right', title:'Diario', text:'La memoria del agente, ciclo a ciclo, está en <b>Diario del agente</b>: qué evaluó, qué decidió y con qué resultado.'},
      {el:'#agt-rules', place:'top', title:'Reglas', text:'Enciende o apaga cada regla, ajusta su <b>umbral</b> y su <b>enfriamiento</b>, y elige si solo avisa, ejecuta con confirmación o ejecuta directo (siempre dentro de la política de autonomía).'}
    ]
  },

  branding: {
    icon:'🎨', title:'Marca',
    summary:'Personaliza el panel y los documentos con la identidad de tu operación: logo, colores y nombre, para que tus clientes vean tu marca.',
    steps:[
      {el:'#brand-form', title:'Tu identidad', text:'Sube tu <b>logo</b>, define el color principal y el nombre comercial. Se aplican al panel, al portal del cliente y a los PDF (manifiestos, facturas, etiquetas).'},
      {el:'#brandLogo', place:'right', title:'Vista previa', text:'El logo del menú se actualiza al guardar. Así compruebas de inmediato cómo lo verán tus clientes.'}
    ]
  },

  clients: {
    icon:'🏢', title:'Clientes',
    summary:'Las cuentas de cliente (sellers) de tu operación: cada una con inventario aislado, su estrategia de picking y de conteo.',
    steps:[
      {el:'#cli-new', place:'bottom', title:'Nuevo cliente', text:'Crea el seller con nombre e ID. Su stock, SKUs y órdenes quedan <b>totalmente aislados</b> de los demás clientes, aunque compartan ubicaciones físicas.'},
      {el:'#cli-body', place:'top', title:'Configuración por cliente', text:'Estrategia de <b>picking</b> (por ejemplo FIFO o por vencimiento), estrategia de <b>conteo</b> (ABC), prioridad de courier y estado. Edita desde la acción de la fila.'},
      {el:['#cli-body td:last-child','#cli-body'], place:'left', title:'Usuarios del cliente', text:'Cada cliente puede tener usuarios con rol CLIENT que entran a su portal: ven su stock, órdenes, recepciones y facturas, y conversan con operaciones.'},
      {el:'#cli-body', place:'top', title:'Reglas por cliente', text:'Al <b>editar</b> un cliente defines su estrategia de picking, la <b>prioridad de couriers</b>, el <b>SLA</b> de preparación y si sus órdenes se <b>reservan automáticamente</b> al ingresar.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN']},
      {el:'#cli-demo', place:'bottom', title:'Sandbox de demostración', text:'Crea un cliente ficticio con productos, stock y órdenes para mostrar el flujo completo a un prospecto sin tocar datos reales.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN']},
    ]
  },

  deadlines: {
    icon:'⏱', title:'Deadlines',
    summary:'Define reglas para que cada orden reciba su deadline de preparación apenas entra al WMS, cliente por cliente: hasta qué hora sale el mismo día, cuántos días hábiles después y a qué hora, con horas fijas por courier.',
    steps:[
      {el:'#dlp-cal', place:'right', title:'Calendario hábil', text:'Marca los <b>días hábiles</b> de tu bodega y agrega los <b>feriados</b>. Los días no hábiles no cuentan: una orden que entra un sábado se trata como ingresada el lunes a primera hora.'},
      {el:'#dlp-seller', place:'bottom', title:'Elige el cliente', text:'Cada cliente tiene sus propias reglas. La lista te dice cuáles ya tienen reglas activas.'},
      {el:['#dlp-activo','#dlp-rules'], place:'bottom', title:'Activar el deadline automático', text:'Con esta casilla las órdenes del cliente reciben su deadline solas al entrar. Si la orden ya trae deadline desde el OMS, se respeta el del OMS.'},
      {el:['#dlp-rules .dlp-tbl','#dlp-rules'], place:'top', title:'Reglas por horario de ingreso', text:'Ejemplo: <b>Ingreso hasta 14:00 → Mismo día hábil, a las 18:00</b>; si entra después, <b>Día hábil siguiente</b>. También puedes poner <b>2, 3… días hábiles</b>. Una regla con <b>courier</b> aplica solo a ese courier; la regla sin courier vale para el resto.'},
      {el:['#dlp-hcs','#dlp-rules'], place:'top', title:'Hora por courier', text:'Si un courier retira a una hora fija (por ejemplo Blue Express a las 16:00), agrégala aquí: el deadline de sus órdenes queda a esa hora en vez de la hora de la regla.'},
      {el:['#dlp-save','#dlp-rules'], place:'top', title:'Guardar', text:'Guarda las reglas del cliente. Rigen para las órdenes que entren desde ese momento.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN']},
      {el:'#dlp-sim', place:'left', title:'Simulador', text:'Antes de guardar, prueba: elige courier y la fecha y hora de ingreso, y verás qué deadline recibiría la orden y qué regla lo decidió.'},
      {el:'#dlp-cortes', place:'bottom', title:'Cortes generales', text:'Para los clientes sin reglas propias se usan los <b>cortes generales por courier</b> de la operación y, si no hay, el SLA del cliente.'}
    ],
    tips:['Con el deadline puesto, la cola de preparación prioriza sola lo que vence antes.',{t:'Activa la regla «Deadline en riesgo» del agente para que vigile estas órdenes.',mod:'agente'}]
  },

  lotes: {
    icon:'📅', title:'Lotes y vencimiento',
    summary:'Todos los productos con manejo de lote, sus lotes con stock y su fecha de vencimiento, con aviso de lo que vence pronto y de lo ya vencido.',
    steps:[
      {el:'#lt-kpis', place:'bottom', title:'Resumen', text:'Cuántos productos y lotes manejan lote, cuántos están <b>vencidos</b> y cuántos <b>vencen pronto</b>, con las unidades comprometidas.'},
      {el:'#lt-filter', place:'bottom', title:'Próximos a vencer y vencidos', text:'Filtra para ver solo los lotes <b>próximos a vencer</b> o los <b>ya vencidos</b>. El número junto a cada filtro dice cuántos hay.'},
      {el:'#lt-dias', place:'bottom', title:'Qué es «próximo»', text:'Define la ventana: un lote es <b>próximo a vencer</b> si vence dentro de 7, 15, 30, 60 o 90 días.'},
      {el:'#lt-body', place:'top', title:'Lotes con su etiqueta', text:'Cada lote con su vencimiento, cantidad y ubicaciones. La etiqueta lo distingue: <b>Vencido</b> (rojo), <b>Vence en N días</b> (ámbar), <b>Vigente</b> (verde) o <b>Sin vencimiento</b>. Se ordenan por el que vence primero, como en FEFO.'},
      {el:'#lt-q', place:'bottom', title:'Buscar', text:'Busca por SKU, nombre de producto o número de lote. La tabla se exporta a Excel con el botón de arriba a la derecha.'}
    ],
    tips:['Los lotes se cargan al recepcionar: captura el lote y el vencimiento en el cotejo.',{t:'El agente avisa los lotes por vencer en «Alertas activas».',mod:'agalertas'}]
  },

  cargas: {
    icon:'📊', title:'Cargas',
    summary:'Qué está haciendo cada operario en este momento y qué tiene en cola, en tiempo real.',
    steps:[
      {el:'#crg-kpis', place:'bottom', title:'El equipo de un vistazo', text:'Cuántos operarios están <b>ejecutando</b>, cuántos tienen tareas <b>en cola</b>, cuántos están <b>libres</b>, y el total de tareas en ejecución y en cola.'},
      {el:'#crg-pend', place:'bottom', title:'Trabajo sin dueño', text:'Las tareas que aún nadie tiene asignadas, por tipo. Desde aquí vas directo a <b>Asignaciones</b> para repartirlas.'},
      {el:'#crg-grid', place:'top', title:'Una tarjeta por operario', text:'Arriba, lo que está <b>en ejecución</b> y cuánto lleva; abajo, lo que tiene <b>en cola</b> y cuánto espera. También ves sus habilidades, unidades y tiempo estimado. Una tarea en curso que supera su tiempo estimado se marca en rojo.'},
      {el:['#crg-filter','#crg-q'], place:'bottom', title:'Filtrar y buscar', text:'Ve a todos, solo a los que tienen carga o solo a los libres, y busca a un operario por nombre.'},
      {el:'#crg-live', place:'bottom', title:'En vivo', text:'La pantalla se actualiza sola cada 10 segundos; aquí ves la hora de la última actualización.'}
    ],
    tips:['Ideal para dejarla abierta en una pantalla de la bodega.',{t:'Para mover trabajo entre personas usa «Asignaciones».',mod:'asignaciones'}]
  },

  users: {
    icon:'◍', title:'Usuarios',
    summary:'Administra quién entra al sistema y con qué permisos: administradores, supervisores, operarios y usuarios de cliente.',
    steps:[
      {el:'#usr-new', place:'bottom', title:'Nuevo usuario', text:'Nombre, email, rol y, para los clientes, el seller al que pertenecen. El usuario recibe sus credenciales y puede cambiar su contraseña desde el panel.'},
      {el:'#usr-body', place:'top', title:'Roles y alcance', text:'<b>Admin</b> administra toda la operación. <b>Supervisor</b> gestiona sin tocar configuración crítica. <b>Operario</b> ejecuta movimientos, también desde la app móvil. <b>Cliente</b> solo ve su seller.'},
      {el:['#usr-body td:last-child','#usr-body'], place:'left', title:'Activar y desactivar', text:'Un usuario desactivado no puede entrar pero conserva su historial de actividad. Restablece contraseñas desde la misma acción.'},
      {el:'#usr-state', place:'bottom', title:'Activos e inactivos', text:'Este switch alterna entre los usuarios <b>activos</b> y los <b>inactivos</b>, con su contador. Al reactivar a alguien pasa solo a la otra vista. La elección se recuerda.'},
      {el:'#usr-role', place:'bottom', title:'Filtrar por rol', text:'Muestra solo administradores, supervisores, operarios o clientes. Cada opción dice cuántos hay.'},
      {el:'#usr-head', place:'bottom', title:'Ordenar por columna', text:'Haz clic en cualquier encabezado para ordenar de la A a la Z; un segundo clic invierte el orden. La flecha marca la columna activa.'},
      {el:['#usr-body [data-uskill]','#usr-body'], place:'left', title:'Habilidades de cada operario', text:'Con <b>Habilidades</b> eliges qué actividades puede hacer un operario (picking, empaque, despacho, recepción, guardado, reposición, conteo, re-slotting). El sistema <b>solo le asigna tareas de esas actividades</b>: en la asignación manual, el balanceo automático, el agente, el copiloto y la app. Puedes cambiarlas cuando quieras.', roles:['ADMIN','PLATFORM_ADMIN']}
    ],
    tips:['Las habilidades también se consultan y cambian por API (<b>/assignments/skills</b>) y por MCP (habilidades_operarios / fijar_habilidades_operario).']
  },

  pkgmatrix: {
    icon:'▦', title:'Empaquetado',
    summary:'La matriz de planes de la plataforma: qué módulos incluye cada plan y con qué límites.',
    steps:[
      {el:'#pkg-matrix', place:'top', title:'Módulos por plan', text:'Cada fila es un módulo agrupado en Operaciones, Negocio, IA y Plataforma; cada columna un plan. Marca la casilla para incluirlo y define nombre, precios y límites del plan.'},
      {el:'#pkg-save', place:'bottom', title:'Guardar y restaurar', text:'Los cambios rigen en vivo para cuentas nuevas y afectan a las existentes según su plan. <b>Restaurar</b> vuelve a los valores por defecto.'}
    ]
  },

  operations: {
    icon:'◈', title:'Operaciones',
    summary:'Cada operación es un mundo aislado en la plataforma: sus bodegas, clientes, usuarios e inventario.',
    steps:[
      {el:'#ops-new', place:'bottom', title:'Nueva operación', text:'Crea un tenant nuevo con su nombre y administrador inicial. Desde ese momento tiene su propio espacio, invisible para las demás operaciones.'},
      {el:'#ops-grid', place:'top', title:'Operaciones existentes', text:'Cada tarjeta resume clientes, usuarios y actividad. Selecciona una en la barra superior para administrarla como si fueras su admin.'},
      {el:'#ops-view', place:'bottom', title:'Listado o tarjetas', text:'Cambia entre <b>listado</b> (más denso, ideal para revisar muchas altas) y <b>tarjetas</b>. En ambas vistas las operaciones van de la <b>más nueva a la más antigua</b>, y el buscador filtra por nombre, contacto o email.'},
      {el:['#ops-grid','#ops-listwrap'], place:'top', title:'Ficha y edición', text:'Cada tarjeta muestra la ficha del alta (contacto, celular, email, tipo, fecha y campaña de origen), los indicadores de uso y el plan. Con <b>Editar</b> cambias nombre y contacto, y desde ahí la <b>activas o desactivas</b>.'},
      {el:['#ops-body [data-odel]','#ops-grid [data-odel]','#ops-grid'], place:'left', title:'Eliminar una operación', text:'<b>Eliminar</b> saca la operación de la lista y bloquea el acceso de todos sus usuarios (panel y app). Para confirmar hay que escribir su nombre. Los datos se conservan: con <b>🗑 Eliminadas</b> en la barra superior la puedes <b>restaurar</b>. No se puede eliminar la operación a la que pertenece tu propio usuario.'},
    ]
  },

  usage: {
    icon:'📈', title:'Uso de plataforma',
    summary:'Cuánto usa cada operación la plataforma: órdenes, movimientos, usuarios activos y consultas al copiloto, consolidado y por tenant.',
    steps:[
      {el:'#usg-toggle', place:'bottom', title:'Período', text:'Elige la ventana de análisis o un rango personalizado.'},
      {el:'#usg-kpis', title:'Consolidado', text:'Totales de toda la plataforma en el período.'},
      {el:'#usg-mx-body', place:'top', title:'Uso por operación', text:'Una fila por tenant con sus contadores. Ordena por columna para ver quién crece más rápido o quién está inactivo.'}
    ]
  },

  announcements: {
    icon:'📣', title:'Anuncios',
    summary:'Comunica novedades a todos los administradores con una barra superior que enlaza a una landing y mide los clics.',
    steps:[
      {el:'#ann-new', place:'bottom', title:'Nuevo anuncio', text:'Título, enlace y texto del botón. Al activarlo aparece la barra superior para admins y supervisores de todas las operaciones.'},
      {el:'#ann-list', place:'top', title:'Seguimiento', text:'Cada anuncio muestra estado, clics recibidos y fecha. Desactívalo cuando termine la campaña.'},
      {el:'#ann-list', place:'top', title:'Activar, clics y eliminar', text:'Cada anuncio se <b>activa o pausa</b> desde su fila, muestra cuántos <b>clics</b> tuvo el enlace y se puede <b>editar</b> (texto, enlace, audiencia por rol) o <b>eliminar</b>.'},
    ]
  }
};
