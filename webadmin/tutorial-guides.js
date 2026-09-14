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

  dashboard: {
    icon:'◧', title:'Dashboard',
    summary:'Tu centro de mando: en una sola pantalla ves cómo viene la operación hoy, qué necesita atención y qué pasó en el inventario.',
    steps:[
      {el:'.side', place:'right', title:'El menú lateral', text:'Desde aquí navegas a todas las secciones. Los <b>Workflows</b> agrupan el día a día de la bodega (órdenes, recepción, picking) e <b>Inventario</b> lo que tienes y dónde. Más abajo están finanzas, comunicación y administración.'},
      {el:'.topbar', place:'bottom', title:'Barra superior: contexto y búsqueda', text:'Aquí eliges la <b>operación</b> y el <b>cliente</b> con el que estás trabajando: todo el panel se filtra según esa selección. El buscador encuentra un SKU, una orden o una ubicación al instante.'},
      {el:'#opmetrics', title:'Actividad operativa', text:'Las métricas de las últimas 24 horas comparadas con el período anterior: órdenes ingresadas, despachadas, unidades recibidas y más. Cambia la ventana a 7, 30 o 90 días, o define un rango personalizado.'},
      {el:'#kpis', title:'Indicadores clave', text:'Los KPIs resumen el estado actual: stock disponible, órdenes pendientes, reservas y alertas. Si un número te llama la atención, haz clic en la sección correspondiente para profundizar.'},
      {el:'.grid2', title:'Gráficos de zona y estados', text:'A la izquierda, cuántas unidades hay en cada <b>zona</b> de la bodega. A la derecha, las órdenes por <b>estado</b>: ingresadas, reservadas, en picking, empacadas y despachadas. Así detectas cuellos de botella de un vistazo.'},
      {el:'#activity', title:'Actividad reciente del ledger', text:'Cada movimiento de inventario queda registrado en un <b>ledger inmutable</b>: quién hizo qué, con qué SKU, en qué ubicación y cuánto. Nada se borra; todo es auditable.'},
      {el:'#nt-topbtn', place:'bottom', title:'Vuelve al tutorial cuando quieras', text:'Cada sección tiene su propio tutorial. Este botón lo abre en cualquier momento, y el <b>Centro de aprendizaje</b> del menú reúne todos los tutoriales y videos.'}
    ],
    tips:['El panel se actualiza solo cada 30 segundos mientras esté visible (punto verde junto al título); tócalo para refrescar al instante.','Usa el selector de cliente para revisar la operación de un seller en particular.','El buscador global acepta SKU, número de orden o código de ubicación.','El ledger de actividad es tu fuente de verdad ante cualquier diferencia de stock.']
  },

  copilot: {
    icon:'✨', title:'Copiloto',
    summary:'Un asistente con inteligencia artificial que analiza tu operación en vivo, te avisa qué necesita atención y responde preguntas con tus datos reales.',
    steps:[
      {el:'#cop-insights', title:'Qué necesita tu atención', text:'El copiloto revisa órdenes, stock y tareas y te muestra <b>insights accionables</b>: SKUs por quebrar, órdenes atrasadas, recepciones pendientes. Pulsa «Actualizar» para volver a analizar.'},
      {el:'#cop-chips', place:'top', title:'Preguntas sugeridas', text:'Estos chips son preguntas frecuentes listas para usar. Haz clic en una para ver la respuesta al instante y aprender qué tipo de cosas puedes preguntar.'},
      {el:'#cop-q', place:'top', title:'Pregúntale a tu WMS', text:'Escribe en lenguaje natural: <b>«¿qué SKUs están por quebrar stock?»</b>, <b>«¿cuántas órdenes hay listas para despachar?»</b> o <b>«asigna el picking pendiente a Pedro»</b>. El copiloto consulta y también puede ejecutar acciones.'},
      {el:'#cop-answer', title:'Respuestas con datos en vivo', text:'Las respuestas se construyen con la información actual de tu operación, no con datos genéricos. Cuando la acción modifica algo (por ejemplo, asignar una tarea), te pedirá confirmación antes de ejecutarla.'}
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
      {el:'#mc-table', title:'Tabla comparativa', text:'Cada fila es un cliente. Ordena por cualquier columna haciendo clic en su cabecera para ver, por ejemplo, quién tiene más órdenes en riesgo o quién factura más. Haz clic en un cliente para ir a su detalle.'}
    ]
  },

  orders: {
    icon:'🗎', title:'Órdenes',
    summary:'El flujo completo de fulfillment: desde que la orden entra desde el e-commerce hasta que sale despachada, con reserva de stock anti-sobreventa.',
    steps:[
      {el:'#ord-filters', title:'Filtra por estado', text:'Cada chip es un estado del ciclo de vida: <b>Ingresada → Reservada → En picking → Pickeada → Empacada → Despachada</b>. Haz clic en uno para ver solo esas órdenes y saber cuántas hay en cada etapa.'},
      {el:'#ord-new', place:'bottom', title:'Crear una orden manual', text:'Normalmente las órdenes llegan solas desde tu OMS o e-commerce. Con <b>Nueva orden</b> puedes crear una a mano: eliges canal, líneas con SKU y cantidad, courier y destinatario.'},
      {el:'#ord-import', place:'bottom', title:'Carga masiva', text:'¿Muchas órdenes? Sube un Excel con el formato de plantilla y se crean todas de una vez; el sistema valida SKUs y cantidades y te muestra qué filas tuvieron problemas.'},
      {el:'#ord-reserve-all', place:'bottom', title:'Reserva masiva', text:'Reserva el stock de todas las órdenes ingresadas de un solo clic. Cada reserva pasa la unidad de <b>disponible</b> a <b>reservada</b>: así nunca vendes lo que no tienes.'},
      {el:'#ord-body', place:'top', title:'La tabla y sus acciones', text:'Cada fila muestra orden, fecha, canal, tipo y estado. A la derecha aparecen las <b>acciones disponibles según el estado</b>: Reservar, A picking, Empacar, Etiquetas, Despachar o Cancelar. Solo ves lo que corresponde hacer ahora.'},
      {el:['th.selcol','#ord-selall-m'], place:'bottom', title:'Cambio de estado masivo', text:'Marca varias órdenes con las casillas (o <b>todas las visibles</b> de un filtro) y aparece una barra para aplicarles un cambio de estado de una vez: reservar, pasar a picking, confirmar picking, empacar, despachar o cancelar. Cada orden se procesa por separado y al final ves cuántas se actualizaron, cuántas se omitieron por estado y cuáles fallaron.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN']},
      {el:'#drawer .panel', place:'left', title:'Detalle de la orden', text:'Al hacer clic en una fila se abre el detalle: líneas, destinatario, courier, empaque, tareas asignadas y el <b>historial auditable</b> de cada evento: quién lo hizo y cuándo.',
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
      {el:'#pq-body', title:'Las órdenes en fila', text:'Cada tarjeta muestra la posición, el courier, unidades y líneas. Solo aparecen órdenes <b>reservadas</b> o <b>en picking</b>: si la cola está vacía, primero reserva órdenes desde la sección Órdenes.'},
      {el:'#pq-body [data-pqgo]', place:'left', title:'Preparar en cadena', text:'Pulsa <b>Preparar</b> para abrir el picking guiado: el sistema indica de qué ubicación tomar cada SKU. Al terminar, te lleva automáticamente a la siguiente orden de la cola.'}
    ],
    tips:['Configura la prioridad de courier en Clientes → editar cliente.','Un pedido «en picking» conserva su lugar en la fila hasta terminarse.']
  },

  inbound: {
    icon:'▼', title:'Recepción',
    summary:'Controla la entrada de mercadería: cada recepción tiene lo esperado versus lo realmente contado, con recepción parcial y cierre con faltantes.',
    steps:[
      {el:'#inb-filters', title:'Estados de recepción', text:'<b>Pendiente</b>: se anunció pero aún no llega. <b>Parcial</b>: llegó una parte. <b>Recepcionada</b>: cerrada. Filtra con los chips para enfocarte en lo que falta por recibir.'},
      {el:'#inb-new', place:'bottom', title:'Nueva orden de recepción', text:'Crea el aviso de llegada con proveedor, referencia y los SKUs con cantidad <b>esperada</b>. Recibe un ID propio (OR-AAAAMMDD-XXXX) para seguirla.'},
      {el:'#inb-import', place:'bottom', title:'Carga masiva', text:'Importa varias recepciones desde Excel a la vez, ideal cuando el proveedor te envía su packing list.'},
      {el:'#inb-body', place:'top', title:'Cotejo físico vs. teórico', text:'Al abrir una recepción, el equipo cuenta cada SKU y confirma lo recibido. El stock entra al inventario <b>solo al confirmar</b>. Puedes recibir en varios eventos y cerrar con faltante si el proveedor no completó.'},
      {el:'#inb-body tr', place:'bottom', title:'Manifiesto y auditoría', text:'Cada recepción se puede imprimir como <b>manifiesto PDF</b> con esperado, recibido y diferencia, y guarda una bitácora de quién contó qué y cuándo.'}
    ],
    tips:['Lo recibido queda en zona de recepción: guárdalo en su ubicación desde «Almacenado».','Una recepción pendiente se puede editar; una con stock ya recibido se puede anular revirtiendo el stock si sigue íntegro.']
  },

  returns: {
    icon:'↩', title:'Devoluciones',
    summary:'Logística reversa enlazada a la orden original: recibe la devolución, haz el control de calidad y dispón cada unidad a stock, merma o cuarentena.',
    steps:[
      {el:'#ret-new', place:'bottom', title:'Registrar una devolución', text:'Parte desde la <b>orden de salida original</b>: eliges qué líneas y cuántas unidades vuelven. Así la devolución queda trazada con el pedido y el cliente.'},
      {el:'#ret-body', place:'top', title:'QA y disposición', text:'Al abrir la devolución revisas unidad por unidad y decides: <b>a stock</b> (vuelve a estar disponible), <b>merma</b> (se descarta) o <b>cuarentena</b> (se aparta para revisión). La columna «Dispuesto» resume el resultado.'},
      {el:'[data-pg=returns] .toolbar', title:'Estados', text:'<b>Pendiente</b> cuando aún no se hace QA, <b>Parcial</b> si se dispuso una parte y <b>Completada</b> al terminar. Todo queda en el kardex como movimiento de tipo Devolución.'}
    ]
  },

  putaway: {
    icon:'⇲', title:'Almacenado',
    summary:'Lo recibido espera en zona de recepción; aquí lo guardas en su ubicación definitiva con un destino sugerido automáticamente.',
    steps:[
      {el:'#pw-body', place:'top', title:'Pendientes de guardar', text:'Cada fila es stock que ya entró pero sigue en recepción: SKU, lote y vencimiento, de qué recepción viene y cuánto falta por guardar.'},
      {el:['[data-pg=putaway] thead th:nth-child(6)','#pw-body'], place:'top', title:'Destino sugerido', text:'El sistema propone la mejor ubicación según reglas de <b>slotting</b>: cercanía a la zona de picking, rotación del SKU y espacio disponible. Puedes aceptar la sugerencia o elegir otra.'},
      {el:['#pw-body td:last-child','#pw-body'], place:'left', title:'Guardar', text:'Pulsa Guardar, confirma la cantidad y la ubicación. El movimiento queda en el kardex como <b>Guardado</b> y el stock pasa a estar disponible para reservar.'}
    ],
    tips:['Los operarios pueden hacer el putaway desde la app móvil escaneando la ubicación.',{t:'Las sugerencias aceptadas o rechazadas alimentan la Auditoría IA.',mod:'aiaudit'}]
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
      {el:['#cc-body td:last-child','#cc-body'], place:'left', title:'Ejecutar el conteo', text:'Al contar ingresas la cantidad física. Si difiere de la teórica, el sistema genera el <b>ajuste</b> correspondiente y lo registra en el kardex. La exactitud resultante se ve en Reportes.'}
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
      {el:'#pr-body', place:'top', title:'Historial por producto', text:'El botón <b>Historial</b> de cada fila muestra cada creación, edición, activación o desactivación con usuario y fecha. Un SKU desactivado no se puede usar en órdenes nuevas pero conserva su historia.'}
    ]
  },

  packaging: {
    icon:'▧', title:'Embalajes',
    summary:'Los insumos de embalaje de la bodega (cajas, bolsas, relleno) con su precio y saldo, para controlarlos y cobrarlos por pedido.',
    steps:[
      {el:'#pkg-new', place:'bottom', title:'Nuevo insumo', text:'Registra cada tipo de caja o material con SKU interno, EAN, nombre y <b>precio</b>. Son de la bodega, no del cliente.'},
      {el:'#pkg-body', place:'top', title:'Saldo y consumo', text:'El saldo baja cada vez que un empaque usa el insumo. Así sabes cuándo reponer y cuánto embalaje se consumió por cliente para facturarlo.'},
      {el:'#pkg-body', place:'top', title:'Reponer, costos e historial', text:'Con <b>Reponer</b> registras cada ingreso con cantidad, <b>costo unitario de compra</b>, proveedor o N° de guía y usuario. El sistema calcula el <b>costo promedio ponderado</b> (PMP) del insumo, el margen contra el precio de cobro y el valor del stock. <b>Historial</b> muestra reposiciones, consumos (valorizados al costo del momento) y ajustes.'}
    ]
  },

  locations: {
    icon:'▤', title:'Ubicaciones',
    summary:'El mapa de la bodega: cada posición con su ocupación. Las ubicaciones son compartidas entre clientes (modelo caótico) para aprovechar el espacio.',
    steps:[
      {el:'#loc-new', place:'bottom', title:'Nueva ubicación', text:'Crea posiciones con código (pasillo-rack-nivel), zona y capacidad. Las zonas se usan en los gráficos del dashboard y en las sugerencias de guardado.'},
      {el:'#loc-import', place:'bottom', title:'Carga masiva', text:'Descarga el formato Excel, completa una fila por ubicación (código, zona, bodega, capacidad, cercanía a picking) y súbelo. Antes de guardar verás qué se crea y qué cambia. Ideal para montar la bodega completa de una vez.', roles:['PLATFORM_ADMIN','ADMIN','SUPERVISOR']},
      {el:'#loc-grid', place:'top', title:'Ocupación en vivo', text:'Cada tarjeta muestra la ubicación, su zona y cuántas unidades tiene. Haz clic para ver qué SKUs y de qué clientes están ahí. El color indica el nivel de ocupación.'},
      {el:'#loc-grid', place:'top', title:'Editar, desactivar o eliminar', text:'Una ubicación que nunca tuvo movimientos se puede <b>eliminar</b>. Si ya registró stock, el kardex la referencia: en ese caso se <b>desactiva</b> y deja de usarse para guardado y picking.'}
    ],
    tips:['Imprime las etiquetas de ubicación para el escaneo desde la app móvil.']
  },

  reports: {
    icon:'▧', title:'Reportes',
    summary:'Los indicadores del cliente: nivel de servicio, exactitud de inventario y ritmo de despachos, listos para compartir.',
    steps:[
      {el:'#rep-kpis', title:'KPIs del cliente', text:'Resumen de órdenes despachadas, tiempo de ciclo, exactitud de inventario y stock. Se calculan sobre el cliente seleccionado en la barra superior.'},
      {el:'#rep-acc-chart', title:'Exactitud de inventario', text:'Evolución de la exactitud medida en los conteos cíclicos. Una caída indica que hay que revisar procesos de guardado o picking.'},
      {el:'#rep-chart', title:'Despachos por día', text:'Cuántas órdenes salieron cada uno de los últimos días. Útil para ver picos de demanda y planificar turnos.'}
    ]
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
      {el:'#bd-kpis', title:'Dashboard de facturación', text:'De vuelta en Resumen: ingresos del período, composición por concepto, tendencia mensual y apertura por cliente. Es la mirada comercial de la operación.', roles:['ADMIN','SUPERVISOR','PLATFORM_ADMIN'],
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
    summary:'Tu plan de Ninja WMS: qué módulos incluye, cuánto has usado este mes y cómo compararlo con los otros planes.',
    steps:[
      {el:'#plan-current', place:'right', title:'Tu plan actual', text:'Muestra el plan contratado, los módulos habilitados y los límites. Los módulos que no incluye aparecen con un <b>candado</b> en el menú.'},
      {el:'#plan-usage', place:'left', title:'Uso este mes', text:'Órdenes, SKUs, usuarios y otros contadores frente a su límite. Si te acercas al tope, es momento de evaluar un plan superior.'},
      {el:'#plan-catalog', place:'top', title:'Compara los planes', text:'Todos los planes lado a lado con sus módulos y precios en CLP o USD. Desde aquí solicitas el cambio de plan.'}
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
      {el:'#asg-balance', place:'bottom', title:'Auto-balancear y redistribuir', text:'<b>Auto-balancear</b> reparte el pool según velocidad y carga de cada operario. <b>Redistribuir</b> mueve tareas no iniciadas del más cargado al más libre. <b>Continuo</b> lo hace solo, permanentemente.'},
      {el:'#asg-load-body', place:'top', title:'Carga por operario', text:'Velocidad histórica en unidades por hora, tareas abiertas, unidades y horas estimadas. Así ves quién terminará primero y quién va atrasado.'},
      {el:'#asg-pool-body', place:'top', title:'Pool de pendientes', text:'Cada tarea pendiente con su cliente y unidades. Asigna a un operario desde la última columna o deja que el balanceo lo haga.'}
    ],
    tips:[{t:'El copiloto de voz puede activar el balanceo: «mantén el equipo balanceado solo».',mod:'voz'}]
  },

  agente: {
    icon:'🛰️', title:'Agente',
    summary:'El agente de bodega corre en el servidor con su propio reloj: vigila la operación, genera alertas por orden, SKU, lote u operario, y ejecuta o propone acciones según el nivel de autonomía que fijes.',
    steps:[
      {el:'#agt-status', place:'bottom', title:'Nivel de autonomía y modo sombra', text:'Elige hasta dónde puede actuar solo: <b>0</b> solo propone, <b>1</b> asigna y balancea, <b>2</b> además avanza órdenes y crea recepciones u órdenes, <b>3</b> todo dentro de límites. Con <b>modo sombra</b> decide y anota lo que haría sin ejecutar: úsalo para calibrar antes de soltarlo. Aquí también fijas límites por ciclo y por hora, el correo o webhook de aviso y la pausa.'},
      {el:'#agt-eval', place:'bottom', title:'Ejecutar ciclo ahora', text:'Fuerza un ciclo completo inmediato. Normalmente corre solo cada dos minutos, aunque nadie tenga el panel abierto.'},
      {el:'#agt-alerts', place:'top', title:'Alertas por entidad', text:'Cada alerta nombra la orden, el SKU, el lote o el operario afectado y propone qué hacer. Si la regla tiene acción automática, verás si se ejecutó, quedó propuesta para tu confirmación o se registró en sombra.'},
      {el:'#agt-instr', place:'top', title:'Instrucciones al agente', text:'Directrices en lenguaje natural que el agente respeta en cada ciclo («hoy priorizar Chilexpress», «no despachar Tienda X hasta que apruebe»), con vigencia opcional. También se pueden dictar desde el copiloto.'},
      {el:'#agt-journal', place:'top', title:'Diario', text:'La memoria del agente: qué evaluó, qué decidió y por qué, qué habría hecho en sombra y qué resultado tuvo. Es la base para subir el nivel de autonomía con evidencia.'},
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
      {el:['#cli-body td:last-child','#cli-body'], place:'left', title:'Usuarios del cliente', text:'Cada cliente puede tener usuarios con rol CLIENT que entran a su portal: ven su stock, órdenes, recepciones y facturas, y conversan con operaciones.'}
    ]
  },

  users: {
    icon:'◍', title:'Usuarios',
    summary:'Administra quién entra al sistema y con qué permisos: administradores, supervisores, operarios y usuarios de cliente.',
    steps:[
      {el:'#usr-new', place:'bottom', title:'Nuevo usuario', text:'Nombre, email, rol y, para los clientes, el seller al que pertenecen. El usuario recibe sus credenciales y puede cambiar su contraseña desde el panel.'},
      {el:'#usr-body', place:'top', title:'Roles y alcance', text:'<b>Admin</b> administra toda la operación. <b>Supervisor</b> gestiona sin tocar configuración crítica. <b>Operario</b> ejecuta movimientos, también desde la app móvil. <b>Cliente</b> solo ve su seller.'},
      {el:['#usr-body td:last-child','#usr-body'], place:'left', title:'Activar y desactivar', text:'Un usuario desactivado no puede entrar pero conserva su historial de actividad. Restablece contraseñas desde la misma acción.'}
    ]
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
      {el:'#ops-grid', place:'top', title:'Operaciones existentes', text:'Cada tarjeta resume clientes, usuarios y actividad. Selecciona una en la barra superior para administrarla como si fueras su admin.'}
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
      {el:'#ann-list', place:'top', title:'Seguimiento', text:'Cada anuncio muestra estado, clics recibidos y fecha. Desactívalo cuando termine la campaña.'}
    ]
  }
};
