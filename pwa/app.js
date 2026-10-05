/* WMS Operador — PWA. App móvil que usa la cámara como lector y llama a la API del WMS. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var CFG_KEY = 'wms.operador.cfg';

  var cfg = load();           // { api, seller, token }
  var user = null;            // usuario autenticado
  var opId = null;            // operación del seller (para capturar productividad G4)
  var taskStartAt = null;     // inicio real de la tarea en curso (G4)
  var quickStartAt = null;   // inicio real de una tarea de empaque o despacho
  var op = null;              // receive | putaway | pick | stock
  var task = null;            // tarea de la bandeja en ejecución (contexto del flujo), o null en operación libre
  var board = null;           // último tablero cargado
  var boardTimer = null;
  var steps = [];             // secuencia de escaneos de la operación
  var stepIdx = 0;
  var captured = {};          // { product, resolved, bin, from, to, loc, maxBase }
  var lastRejected = '';      // último código rechazado como ubicación (evita repetir el aviso)
  var ALL_LOCS = [];          // TODAS las ubicaciones de la operación del seller (activas e inactivas)
  var LOCS = [];              // solo activas (candidatas para recepción/destino)
  var LOC_BY_ID = {};         // id -> ubicación (incluye inactivas, para resolver códigos)

  // ---- Persistencia ---------------------------------------------------------
  function load() { try { return JSON.parse(localStorage.getItem(CFG_KEY) || '{}'); } catch (e) { return {}; } }
  function save() { try { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); } catch (e) {} }

  // ---- API ------------------------------------------------------------------
  /**
   * La ubicación donde ocurrió el trabajo, como id (no como código escaneado).
   * Cada operación la guarda en un paso distinto: el picking en `loc`, el guardado en
   * su destino `to`, la recepción en el andén `bin`. Es lo que después permite medir
   * cuánto cuesta cada pasillo, que es la razón de tener esta columna.
   */
  function laborLocationId(which) {
    var code = which === 'pick' ? captured.loc : which === 'putaway' ? captured.to : which === 'receive' ? captured.bin : null;
    if (!code) return null;
    var l = findLocByCode(code);
    return l ? l.id : null;   // sin ubicación conocida es mejor null que un código suelto
  }

  // ---- Cola de captura de tiempos -------------------------------------------
  // La medición de tiempo se hacía con un fetch suelto y un `.catch(){}`: un operario
  // en una zona sin señal perdía su turno completo y nadie se enteraba. Como el tiempo
  // es el insumo del que después salen los estándares de la bodega, no puede depender
  // de que la antena llegue al fondo del pasillo.
  //
  // La muestra se guarda en el aparato ANTES de intentar mandarla, y la cola se vacía
  // sola cuando vuelve la conexión. Si el operario cierra la app, la cola sobrevive.
  var LABOR_Q = 'njw_labor_q';
  var laborFlushing = false;

  function laborQueue() {
    try { return JSON.parse(localStorage.getItem(LABOR_Q) || '[]'); } catch (e) { return []; }
  }
  function laborQueueSave(q) {
    // Tope de seguridad: 500 muestras es más de un turno completo. Si se llega ahí es
    // que el aparato lleva días sin conexión; se botan las más viejas, no las nuevas.
    try { localStorage.setItem(LABOR_Q, JSON.stringify(q.slice(-500))); } catch (e) { /* almacenamiento lleno o bloqueado */ }
  }
  /** Encola una medición y dispara el envío. Nunca lanza: medir no puede romper el flujo. */
  function laborCapture(body) {
    try {
      var q = laborQueue();
      q.push(body);
      laborQueueSave(q);
    } catch (e) { return; }
    laborFlush();
  }
  /** Vacía la cola de a una muestra, en orden. Un fallo de red la deja para después. */
  function laborFlush() {
    if (laborFlushing) return;
    var q = laborQueue();
    if (!q.length || !cfg.token) return;
    laborFlushing = true;
    // `clientNow` se sella acá, al enviar, no al encolar: así el servidor puede
    // distinguir un reloj corrido de una muestra que esperó por falta de señal.
    var muestra = q[0]; muestra.clientNow = new Date().toISOString();
    api('/labor/capture', { method: 'POST', body: muestra }).then(function () {
      var rest = laborQueue(); rest.shift(); laborQueueSave(rest);
      laborFlushing = false;
      if (rest.length) laborFlush();   // sigue con la siguiente
    }).catch(function (e) {
      laborFlushing = false;
      // Un 4xx que NO sea de sesión es una muestra que el servidor nunca va a aceptar
      // (mal formada): se descarta para que no bloquee a las que vienen detrás. Un 401
      // es otra cosa — la muestra es válida y el problema es el token: se conserva y se
      // reintenta cuando el operario vuelva a entrar. Antes un turno entero de
      // mediciones se perdía en silencio justo por esto.
      var st = e && e.status;
      if (st && st >= 400 && st < 500 && st !== 401) { var rest = laborQueue(); rest.shift(); laborQueueSave(rest); }
    });
  }
  // Reintenta al volver la conexión y cada minuto mientras la app esté abierta.
  window.addEventListener('online', laborFlush);
  setInterval(laborFlush, 60000);

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (cfg.token) headers['Authorization'] = 'Bearer ' + cfg.token;
    return fetch(cfg.api.replace(/\/$/, '') + path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.text().then(function (t) {
        // Una respuesta que no es JSON (un 502 del proxy, un portal cautivo de la wifi
        // de la bodega) reventaba con un SyntaxError crudo en pantalla.
        var data = {};
        if (t) { try { data = JSON.parse(t); } catch (e) { data = { message: 'El servidor respondió algo que no se entiende (' + res.status + ')' }; } }
        if (!res.ok) {
          var msg = (data && (data.detail || data.message)) || ('Error ' + res.status);
          if (typeof msg === 'object') msg = JSON.stringify(msg);
          var err = new Error(msg);
          // El status se conserva en el error. Antes se perdía, y el único chequeo del
          // archivo era una expresión regular sobre el TEXTO del mensaje — que fallaba
          // justo cuando el servidor sí mandaba un detalle.
          err.status = res.status;
          if (res.status === 401) sesionVencida();
          throw err;
        }
        return data;
      });
    });
  }

  /**
   * La sesión expiró (el token dura 12 horas y un turno la cruza).
   *
   * Antes no pasaba nada: la bandeja fallaba con un mensaje rojo cada 30 segundos, sin
   * decir nunca que había que volver a entrar, y las mediciones de productividad
   * encoladas se tiraban a la basura al recibir el 401. Ahora se avisa una sola vez, se
   * vuelve al login y **la cola se conserva**: esas muestras son trabajo real medido y
   * se envían solas cuando el operario vuelve a entrar.
   */
  var avisoSesion = false;
  function sesionVencida() {
    if (avisoSesion) return;
    avisoSesion = true;
    cfg.token = ''; save();
    user = null;
    if (msgTimer) { clearInterval(msgTimer); msgTimer = null; }
    MSGS = []; msgLeidoAt = null;
    if ($('msg-dot')) $('msg-dot').classList.remove('on');
    toast('Tu sesión expiró. Vuelve a entrar.', false);
    show('login');
    setTimeout(function () { avisoSesion = false; }, 5000);
  }

  // ---- Navegación -----------------------------------------------------------
  function show(id) {
    ['login', 'home', 'scan', 'quick', 'msgs', 'pack', 'ship', 'pickst', 'recvst', 'taskst', 'count', 'ret', 'kit'].forEach(function (s) { $(s).classList.toggle('on', s === id); });
    if (id !== 'scan') stopCamera();
    if (typeof camClose === 'function' && $('camsheet') && $('camsheet').style.display !== 'none') camClose();
    if (id === 'home') { loadBoard(); if (!boardTimer) boardTimer = setInterval(function () { if ($('home').classList.contains('on') && !document.hidden) loadBoard(); }, 30000); }
  }

  function toast(msg, ok) {
    var t = $('toast'), i = $('toast-i');
    i.className = 'i ' + (ok ? 'ok' : 'err'); i.textContent = (ok ? '✓  ' : '✕  ') + msg;
    t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }

  // ---- Login ----------------------------------------------------------------
  // Si la PWA se sirve desde el mismo origen que la API (caso túnel), usa ese origen.
  // El operario solo escribe email y contraseña. La app se sirve desde el mismo
  // servidor que la API, así que el servidor es el origen de la página. Para pruebas
  // contra otro servidor se puede abrir la app con ?api=https://otro-servidor.
  var apiParam = null;
  try { apiParam = new URLSearchParams(window.location.search).get('api'); } catch (e) {}
  function apiBase() { return (apiParam || window.location.origin).replace(/\/$/, ''); }
  $('cfg-email').value = cfg.email || '';
  cfg.api = apiBase();   // una configuración vieja guardada en el aparato no debe apuntar a otro servidor

  function doLogin() {
    cfg.api = apiBase();
    cfg.email = $('cfg-email').value.trim();
    var pass = $('cfg-pass').value;
    if (!cfg.email || !pass) { toast('Completa email y contraseña', false); return; }
    save();
    api('/auth/login', { method: 'POST', body: { email: cfg.email, password: pass } })
      .then(function (r) {
        if (!r.authenticated) { toast('Email o contraseña incorrectos', false); return; }
        cfg.token = r.token; save();   // guarda el JWT firmado
        $('cfg-pass').value = '';
        user = r.user;
        $('h-user').textContent = user.name;
        $('h-seller').textContent = 'Operario';
        if (user.operationId) opId = user.operationId;
        loadLocations();
        loadPwaBranding();
        // Un turno pudo terminar sin señal y la app cerrarse con muestras pendientes.
        // Apenas hay sesión válida se vacían: esperar el minuto del intervalo dejaría
        // el tiempo del turno anterior colgando en el aparato más de lo necesario.
        laborFlush();
        loadFreeSellers();
        show('home');
      })
      .catch(function (e) { toast('No se pudo conectar: ' + e.message, false); });
  }
  $('btn-login').addEventListener('click', doLogin);
  // Enter en la contraseña entra (teclado del teléfono o pistola con teclado).
  $('cfg-pass').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); doLogin(); } });
  $('cfg-email').addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); $('cfg-pass').focus(); } });

  // ---- Cliente para la operación libre --------------------------------------
  // Recepción, guardado, picking y consulta de stock libres trabajan sobre UN cliente.
  // Antes se escribía su id en el login; ahora se elige de la lista de la operación.
  function loadFreeSellers() {
    var sel = $('free-seller'); if (!sel || !user || !user.operationId) return;
    api('/operations/' + encodeURIComponent(user.operationId) + '/sellers').then(function (list) {
      var act = (list || []).filter(function (x) { return x.active !== false; });
      SELLERS = act;
      if (cfg.seller && !act.some(function (x) { return x.id === cfg.seller; })) { cfg.seller = ''; save(); }
      if (!cfg.seller && act.length === 1) { cfg.seller = act[0].id; save(); loadLocations(); }
      sel.innerHTML = (act.length > 1 ? '<option value="">— Elige el cliente —</option>' : '')
        + act.map(function (x) { return '<option value="' + esc(x.id) + '">' + esc(x.name || x.id) + '</option>'; }).join('');
      sel.value = cfg.seller || '';
    }).catch(function () { sel.innerHTML = '<option value="">No pude cargar los clientes</option>'; });
  }
  $('free-seller').addEventListener('change', function () {
    cfg.seller = this.value || ''; save();
    loadLocations();
  });

  $('btn-logout').addEventListener('click', function () {
    // Salir tiene que BORRAR la credencial. Antes solo volvía a la pantalla de login
    // con el token intacto en el aparato: cualquiera que recargara la página entraba.
    // La cola de mediciones NO se toca: es trabajo que ya ocurrió y se manda cuando
    // alguien vuelva a entrar.
    cfg.token = ''; save();
    user = null; opId = null; task = null;
    if (boardTimer) { clearInterval(boardTimer); boardTimer = null; }
    // El hilo de mensajes es de una persona: al salir no puede quedar en pantalla para
    // quien entre después en el mismo aparato compartido.
    if (msgTimer) { clearInterval(msgTimer); msgTimer = null; }
    MSGS = []; msgLeidoAt = null;
    if ($('msg-list')) $('msg-list').innerHTML = '';
    if ($('msg-dot')) $('msg-dot').classList.remove('on');
    show('login');
  });

  // ---- Selección de operación ----------------------------------------------
  var OP_META = {
    receive: { title: 'Recepción', steps: ['product', 'bin'], perm: 'recibir' },
    putaway: { title: 'Guardado', steps: ['product', 'from', 'to'] },
    pick:    { title: 'Picking', steps: ['product', 'loc'] },
    stock:   { title: 'Consultar stock', steps: ['product'] },
  };
  var STEP_HINT = {
    product: 'Escanea el PRODUCTO (EAN o DUN)',
    bin: 'Toca o escanea la ubicación de recepción',
    from: 'Toca o escanea la ubicación de ORIGEN',
    to: 'Toca o escanea la ubicación de DESTINO',
    loc: 'Toca o escanea la ubicación a pickear',
  };

  Array.prototype.forEach.call(document.querySelectorAll('.op'), function (b) {
    b.addEventListener('click', function () {
      task = null;
      var which = b.getAttribute('data-op');
      // Empaque y despacho trabajan con todas las órdenes de la operación: no piden cliente.
      if (which === 'packst') { openPackStation(null); return; }
      if (which === 'shipst') { openShipStation(null); return; }
      // Picking: pedidos asignados y libres de toda la operación (no pide cliente).
      if (which === 'pick') { openPickStation(); return; }
      // Recepción: recepciones asignadas y libres de toda la operación (no pide cliente).
      if (which === 'receive') { openRecvStation(); return; }
      if (which === 'putaway') { openTaskStation('putaway'); return; }
      if (which === 'countst') { openTaskStation('count'); return; }
      if (which === 'retst') { openReturns(); return; }
      if (which === 'kitst') { openKits(); return; }
      if (!cfg.seller) { toast('Elige primero el cliente en «Operar libre»', false); var fs = $('free-seller'); if (fs) fs.focus(); return; }
      startOp(which);
    });
  });

  function setLocs(rows) {
    ALL_LOCS = rows || [];
    LOC_BY_ID = {};
    ALL_LOCS.forEach(function (l) { LOC_BY_ID[l.id] = l; });
    LOCS = ALL_LOCS.filter(function (l) { return l.active !== false; });
  }
  // Las ubicaciones pertenecen a la operación DEL SELLER (así el backend resuelve los
  // códigos). Se derivan del seller para ser consistentes aunque el operador atienda
  // varios clientes/operaciones.
  function loadLocations() {
    ALL_LOCS = []; LOCS = []; LOC_BY_ID = {};
    var viaUser = function () {
      if (user && user.operationId) {
        opId = user.operationId;
        api('/operations/' + encodeURIComponent(user.operationId) + '/locations').then(setLocs).catch(function () {});
      }
    };
    if (!cfg.seller) { viaUser(); return; }
    api('/sellers/' + encodeURIComponent(cfg.seller))
      .then(function (s) {
        if (!s || !s.operationId) throw new Error('seller sin operación');
        opId = s.operationId; // G4: contexto para capturar productividad
        return api('/operations/' + encodeURIComponent(s.operationId) + '/locations');
      })
      .then(setLocs)
      .catch(viaUser);
  }

  // ---- Bandeja de tareas (tablero del operario) ------------------------------
  var TL = { PICK: 'Picking', PACK: 'Empaque', SHIP: 'Despacho', PUTAWAY: 'Guardado', RESTOCK: 'Reposición', COUNT: 'Conteo', RECEIVE: 'Recepción', RESLOT: 'Re-slotting' };
  var TI = { PICK: '🛒', PACK: '📦', SHIP: '🚚', PUTAWAY: '⇄', RESTOCK: '↩', COUNT: '🔢', RECEIVE: '📥', RESLOT: '↔' };
  function opIdOrNull() { return opId || (user && user.operationId) || null; }
  function loadBoard() {
    var oid = opIdOrNull(); if (!oid || !user) return;
    api('/assignments/board?operationId=' + encodeURIComponent(oid) + '&operator=' + encodeURIComponent(user.id))
      .then(function (b) { board = b; renderBoard(); })
      .catch(function (e) { toast('No pude cargar tus tareas: ' + e.message, false); });
    refrescaNoLeidos();
  }
  function taskTitle(t) { return (TI[t.type] || '•') + ' ' + (TL[t.type] || t.type); }
  function renderBoard() {
    if (!board) return;
    var mine = board.mine || [], avail = board.available || [];
    $('cnt-mine').textContent = mine.length;
    $('cnt-available').textContent = avail.length;
    $('tab-available').style.display = board.selfPickup ? '' : 'none';
    // Siguiente
    var nx = $('board-next'), ls = $('board-list'), em = $('board-empty');
    if (!mine.length) { nx.innerHTML = ''; ls.innerHTML = ''; em.style.display = ''; return; }
    em.style.display = 'none';
    var n = mine[0];
    nx.innerHTML = '<div class="next"><div class="lbl">' + (n.estado === 'in_progress' ? '▶ En curso' : '▶ Siguiente') + '</div>'
      + '<div class="tt">' + taskTitle(n) + ' · <span class="ref">' + esc(n.entityRef || n.entityId) + '</span></div>'
      + '<div class="meta">' + esc(n.cliente || '') + (n.unitsEstimate ? ' · ' + n.unitsEstimate + ' un' : '') + '</div>'
      + (n.priorityReason ? '<div class="why">' + esc(n.priorityReason) + '</div>' : '')
      + '<button class="btn" data-start="0">' + (n.estado === 'in_progress' ? 'Continuar' : 'Iniciar') + '</button></div>';
    ls.innerHTML = mine.slice(1).map(function (t, i) {
      return '<div class="task' + (t.estado === 'in_progress' ? ' running' : '') + '"><div class="num">' + (t.position || (i + 2)) + '</div>'
        + '<div style="flex:1;min-width:0"><div class="tt"><span class="typechip ' + esc(t.type) + '">' + esc(TL[t.type] || t.type) + '</span><span class="ref">' + esc(t.entityRef || t.entityId) + '</span></div>'
        + '<div class="meta">' + esc(t.cliente || '') + (t.unitsEstimate ? ' · ' + t.unitsEstimate + ' un' : '') + (t.estado === 'in_progress' ? ' · en curso' : '') + '</div>'
        + (t.priorityReason ? '<div class="why">' + esc(t.priorityReason) + '</div>' : '') + '</div>'
        + '<div class="act"><button data-start="' + (i + 1) + '">' + (t.estado === 'in_progress' ? 'Continuar' : 'Iniciar') + '</button></div></div>';
    }).join('');
    Array.prototype.forEach.call(document.querySelectorAll('#pane-mine [data-start]'), function (b) {
      b.addEventListener('click', function () { startAssigned(mine[parseInt(b.getAttribute('data-start'), 10)]); });
    });
    // Disponibles
    var al = $('avail-list');
    al.innerHTML = avail.length ? avail.map(function (t, i) {
      return '<div class="task"><div class="num">' + (i + 1) + '</div>'
        + '<div style="flex:1;min-width:0"><div class="tt"><span class="typechip ' + esc(t.type) + '">' + esc(TL[t.type] || t.type) + '</span><span class="ref">' + esc(t.entityRef || t.entityId) + '</span></div>'
        + '<div class="meta">' + esc(t.cliente || '') + (t.unidades ? ' · ' + t.unidades + ' un' : '') + '</div><div class="why">' + esc(t.motivo || '') + '</div></div>'
        + '<div class="act"><button data-take="' + i + '">Tomar</button></div></div>';
    }).join('') : '<div class="card muted" style="text-align:center">No hay tareas disponibles ahora.</div>';
    Array.prototype.forEach.call(al.querySelectorAll('[data-take]'), function (b) {
      b.addEventListener('click', function () {
        var t = avail[parseInt(b.getAttribute('data-take'), 10)]; b.disabled = true;
        api('/assignments/take', { method: 'POST', body: { operationId: opIdOrNull(), type: t.type, entityId: t.entityId } })
          .then(function () { toast('Tarea agregada a tu bandeja', true); switchTab('mine'); loadBoard(); })
          .catch(function (e) { toast(e.message, false); b.disabled = false; });
      });
    });
  }
  function switchTab(name) {
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { t.classList.toggle('on', t.getAttribute('data-tab') === name); });
    ['mine', 'available', 'free'].forEach(function (k) { $('pane-' + k).classList.toggle('on', k === name); });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { t.addEventListener('click', function () { switchTab(t.getAttribute('data-tab')); }); });
  $('btn-refresh').addEventListener('click', function () { loadBoard(); toast('Actualizado', true); });
  // Al volver la app al frente (cambio de pestaña / desbloqueo del teléfono) se refresca la bandeja.
  document.addEventListener('visibilitychange', function () { if (!document.hidden && $('home').classList.contains('on')) loadBoard(); });

  // Inicia una tarea de la bandeja: marca in_progress y abre el flujo correspondiente con contexto.
  function startAssigned(t) {
    if (!t) return;
    // Marcar la tarea como iniciada NO es opcional: de ese instante salen los tiempos
    // en cola / en bandeja / ejecución que ve el supervisor, y el modelo que aprende
    // cuánto dura cada tarea. Se descartaba el error en silencio, así que el operario
    // trabajaba y el panel nunca veía la tarea empezada.
    // `clientAt` deja constancia del reloj del aparato, para descartar mediciones de un
    // teléfono desfasado sin castigar al que trabaja donde no llega la antena.
    api('/assignments/start', {
      method: 'POST',
      body: { operationId: opIdOrNull(), type: t.type, entityId: t.entityId, clientAt: new Date().toISOString() },
    }).catch(function (e) {
      if (e && e.status === 401) return;          // ya se avisó y se volvió al login
      toast('No se pudo marcar la tarea como iniciada: ' + (e && e.message || 'sin conexión'), false);
    });
    task = t;
    if (t.sellerId) { cfg.seller = t.sellerId; save(); }
    if (t.type === 'PICK') { startOp('pick'); loadTaskPicklist(); return; }
    if (t.type === 'RESTOCK') {
      // Reposición: la mercadería está en la ubicación DEV-REPOSICION y hay que devolverla
      // a su sitio. Origen preseleccionado; el destino viene sugerido pero se puede cambiar.
      var pr = String(t.entityId).split(':');
      var fromR = pr.length >= 3 ? LOC_BY_ID[pr[2]] : null;
      // El destino sugerido viaja en `note` (id de ubicación) o, si la asignación no lo
      // trae, se lee del texto de la tarea: "SKU → CÓDIGO".
      var destino = t.note ? LOC_BY_ID[t.note] : null;
      if (!destino && t.entityRef && t.entityRef.indexOf('→') > 0) {
        destino = findLocByCode(String(t.entityRef).split('→').pop().trim());
      }
      startOp('putaway');
      if (fromR) { captured.from = fromR.code; steps = ['product', 'to']; enterStep(); }
      setTaskCtx('<b>' + esc(taskTitle(t)) + ' · ' + esc(t.entityRef || '') + '</b>'
        + (fromR ? 'Está en <span class="code">' + esc(fromR.code) + '</span>. ' : '')
        + (destino ? 'Vuelve a <span class="code">' + esc(destino.code) + '</span> (puedes elegir otra).' : 'Escanea el producto y elige el destino.'));
      return;
    }
    if (t.type === 'PUTAWAY' || t.type === 'RESLOT') {
      // entityId = sellerId:sku:locationId → origen conocido; el operario escanea el producto y elige destino.
      var parts = String(t.entityId).split(':');
      var fromLoc = parts.length >= 3 ? LOC_BY_ID[parts[2]] : null;
      startOp('putaway');
      if (fromLoc) { captured.from = fromLoc.code; steps = ['product', 'to']; enterStep(); }
      setTaskCtx('<b>' + esc(taskTitle(t)) + ' · ' + esc(t.entityRef || '') + '</b>' + (fromLoc ? 'Origen: <span class="code">' + esc(fromLoc.code) + '</span> · escanea el producto y elige el destino.' : 'Escanea el producto, luego origen y destino.'));
      return;
    }
    if (t.type === 'RECEIVE') {
      // Cotejo de una RECEPCIÓN: el stock aterriza en la ubicación de recepción de la orden,
      // así que solo se escanea el producto y se indica la cantidad. Al completar todas las
      // líneas la recepción queda RECIBIDA y la tarea sale de la bandeja.
      startOp('receive');
      steps = ['product']; stepIdx = 0; enterStep();
      loadTaskReceipt();
      return;
    }
    // Empaque y despacho de una tarea abren su estación con la orden ya elegida.
    if (t.type === 'PACK') { openPackStation(t); return; }
    if (t.type === 'SHIP') { openShipStation(t); return; }
    if (t.type === 'COUNT') { openCount(t, null); return; }
    startOp('pick');
  }
  function setTaskCtx(html) { var c = $('taskctx'); c.innerHTML = html; c.style.display = html ? '' : 'none'; }
  // Lista de picking de la orden de la tarea (líneas, ubicación y avance).
  function loadTaskPicklist() {
    if (!task || task.type !== 'PICK') return;
    setTaskCtx('<b>' + esc(taskTitle(task)) + ' · ' + esc(task.entityRef || '') + '</b>Cargando lista de picking…');
    api('/sellers/' + encodeURIComponent(task.sellerId) + '/orders/' + encodeURIComponent(task.entityId) + '/picklist')
      .then(function (lines) {
        if (task) { task.picklist = lines || []; if (steps[stepIdx] === 'product') renderProductPicker(); }
        var html = '<b>' + esc(taskTitle(task)) + ' · ' + esc(task.entityRef || '') + '</b>Escanea cada producto y su ubicación:<div class="lines">'
          + (lines || []).map(function (l) {
            var loc = LOC_BY_ID[l.locationId]; var done = (l.pickedQty || 0) >= l.qty;
            return '<div class="ln' + (done ? ' done' : '') + '"><span>' + esc(l.sku) + (l.lot ? ' · ' + esc(l.lot) : '') + '</span><span>' + esc(loc ? loc.code : l.locationId) + ' · ' + (l.pickedQty || 0) + '/' + l.qty + '</span></div>';
          }).join('') + '</div>';
        setTaskCtx(html);
        if ((lines || []).length && lines.every(function (l) { return (l.pickedQty || 0) >= l.qty; })) toast('Esta orden ya está completamente pickeada', true);
      })
      .catch(function (e) { setTaskCtx('<b>' + esc(taskTitle(task)) + ' · ' + esc(task.entityRef || '') + '</b>' + esc(e.message)); });
  }

  // Líneas de la recepción de la tarea (esperado / recibido). Guarda la orden en task.receipt.
  function loadTaskReceipt() {
    if (!task || task.type !== 'RECEIVE') return;
    setTaskCtx('<b>' + esc(taskTitle(task)) + ' · ' + esc(task.entityRef || '') + '</b>Cargando recepción…');
    api('/sellers/' + encodeURIComponent(task.sellerId) + '/receipts/' + encodeURIComponent(task.entityId))
      .then(function (r) {
        task.receipt = r;
        if (steps[stepIdx] === 'product') renderProductPicker();
        var loc = LOC_BY_ID[r.locationId];
        var html = '<b>' + esc(taskTitle(task)) + ' · ' + esc(task.entityRef || r.id) + '</b>'
          + (r.supplier ? esc(r.supplier) + ' · ' : '') + 'Ubicación de recepción: <span class="code">' + esc(loc ? loc.code : r.locationId) + '</span>. Escanea cada producto e indica la cantidad recibida:<div class="lines">'
          + (r.lines || []).map(function (l) {
            var done = (l.receivedQty || 0) >= l.expectedQty;
            return '<div class="ln' + (done ? ' done' : '') + '"><span>' + esc(l.sku) + (l.lot ? ' · ' + esc(l.lot) : '') + '</span><span>' + (l.receivedQty || 0) + '/' + l.expectedQty + '</span></div>';
          }).join('') + '</div>';
        setTaskCtx(html);
        if (r.status === 'RECEIVED') toast('Esta recepción ya está cerrada', true);
      })
      .catch(function (e) { setTaskCtx('<b>' + esc(taskTitle(task)) + ' · ' + esc(task.entityRef || '') + '</b>' + esc(e.message)); });
  }
  // Cuando la tarea en curso terminó (orden pickeada / recepción cerrada), se suelta el
  // contexto y se refresca la bandeja para que la tarea desaparezca de "Mis tareas".
  function finishTask(msg) {
    if (msg) $('res-sub').textContent += ' ' + msg;
    $('btn-again').style.display = 'none';
    $('btn-closercpt').style.display = 'none';
    $('btn-finish').textContent = PI.back === 'recv' ? 'Volver a la lista de recepciones' : PI.back === 'ts:putaway' ? 'Volver a la lista de guardado' : PI.back ? 'Volver a la lista de picking' : 'Volver a mis tareas';
    task = null;
    loadBoard();
  }

  // ---- Acción rápida: empacar / despachar (sin escaneo) ----------------------
  function openQuick(t) {
    task = t;
    // Empaque y despacho no pasan por el flujo de escaneo, así que nunca marcaban
    // inicio: su duración era la única del ciclo que no se podía medir. El reloj
    // parte cuando el operario abre la pantalla, que es cuando empieza el trabajo.
    quickStartAt = new Date().toISOString();
    $('q-title').textContent = taskTitle(t);
    $('q-sub').textContent = (t.entityRef || t.entityId) + (t.cliente ? ' · ' + t.cliente : '');
    $('q-card').innerHTML = '<div class="kv"><span>Orden</span><b class="code">' + esc(t.entityRef || t.entityId) + '</b></div><div class="kv"><span>Unidades</span><b>' + (t.unitsEstimate || '—') + '</b></div>' + (t.priorityReason ? '<div class="kv"><span>Prioridad</span><b>' + esc(t.priorityReason) + '</b></div>' : '');
    if (t.type === 'PACK') {
      $('q-form').innerHTML = '<label for="q-bultos">Número de bultos</label><div class="qtybar"><button id="qb-minus">−</button><input id="q-bultos" type="number" inputmode="numeric" min="1" value="1"><button id="qb-plus">+</button></div>';
      $('qb-plus').addEventListener('click', function () { $('q-bultos').value = (parseInt($('q-bultos').value, 10) || 0) + 1; });
      $('qb-minus').addEventListener('click', function () { $('q-bultos').value = Math.max(1, (parseInt($('q-bultos').value, 10) || 1) - 1); });
      $('btn-qconfirm').textContent = 'Confirmar empaque';
    } else {
      $('q-form').innerHTML = '<label for="q-carrier">Courier / transporte</label><input id="q-carrier" placeholder="Ej: Chilexpress"><div style="height:8px"></div><label for="q-track">N° de seguimiento (opcional)</label><input id="q-track" class="code" placeholder="Tracking">';
      api('/sellers/' + encodeURIComponent(t.sellerId) + '/orders/' + encodeURIComponent(t.entityId)).then(function (o) { if (o && o.carrier && !$('q-carrier').value) $('q-carrier').value = o.carrier; if (o && o.packing && o.packing.trackingNumber && !$('q-track').value) $('q-track').value = o.packing.trackingNumber; }).catch(function () {});
      $('btn-qconfirm').textContent = 'Confirmar despacho';
    }
    $('btn-qconfirm').disabled = false;
    show('quick');
  }
  $('btn-qconfirm').addEventListener('click', function () {
    if (!task) return;
    var base = '/sellers/' + encodeURIComponent(task.sellerId) + '/orders/' + encodeURIComponent(task.entityId);
    var call;
    if (task.type === 'PACK') {
      var b = parseInt($('q-bultos').value, 10); if (!(b > 0)) { toast('Indica los bultos', false); return; }
      call = api(base + '/pack', { method: 'POST', body: { bultos: b, materials: [] } });
    } else {
      var carrier = $('q-carrier').value.trim(); if (!carrier) { toast('Indica el courier', false); return; }
      var trk = $('q-track').value.trim();
      call = api(base + '/ship', { method: 'POST', body: trk ? { carrier: carrier, trackingNumber: trk } : { carrier: carrier } });
    }
    $('btn-qconfirm').disabled = true;
    var tipo = task.type, refOrden = task.entityRef || task.entityId, unidades = task.unitsEstimate || 0, sellerDeTarea = task.sellerId;
    call.then(function () {
      if (opId && quickStartAt) {
        laborCapture({
          operationId: opId, sellerId: sellerDeTarea, operator: (user && user.id) || cfg.email,
          type: tipo === 'PACK' ? 'PACK' : 'OTHER',   // el dominio no tiene tipo SHIP; despacho entra como OTHER
          startAt: quickStartAt, endAt: new Date().toISOString(), units: unidades,
          orderRef: refOrden, locationId: null,
        });
      }
      quickStartAt = null;
      toast(tipo === 'PACK' ? 'Orden empacada' : 'Orden despachada', true); task = null; show('home');
    }).catch(function (e) { toast(e.message, false); $('btn-qconfirm').disabled = false; });
  });
  $('btn-qback').addEventListener('click', function () { task = null; show('home'); });
  $('btn-qcancel').addEventListener('click', function () { task = null; show('home'); });

  function startOp(which) {
    avisoCamara = '';   // se vuelve a evaluar en cada operación
    op = which; steps = OP_META[op].steps.slice(); stepIdx = 0; captured = {};
    taskStartAt = new Date().toISOString(); // G4: marca de inicio real de la tarea
    $('s-title').textContent = OP_META[op].title;
    $('reso').style.display = 'none';
    $('picklist').style.display = 'none'; $('picklist').innerHTML = '';
    $('bins').style.display = 'none'; $('bins').innerHTML = '';
    $('qtywrap').style.display = 'none';
    $('btn-confirm').style.display = 'none';
    $('result').style.display = 'none';
    // El campo de código NO se esconde. Venía de cuando era el plan B de la cámara:
    // en un iPhone (sin lector nativo) y con pistola era la única entrada posible, y
    // estaba oculta. Ahora se muestra siempre y la cámara es la que sobra si no está.
    $('manual').style.display = '';
    $('after').style.display = 'none';
    if (!task) setTaskCtx('');
    show('scan');
    enterStep();
    startCamera();
  }

  // Entra al paso actual: actualiza la ayuda y, si es un paso de ubicación,
  // muestra las ubicaciones reales (con cantidades) para tocar — además del escaneo.
  function enterStep() {
    var s = steps[stepIdx];
    lastRejected = '';
    var hint = s ? STEP_HINT[s] : 'Listo';
    $('s-step').textContent = hint;
    $('cam-hint').textContent = s ? hint : '';
    // El rótulo del campo dice QUÉ escanear en este paso: con pistola no hay visor de
    // cámara con texto encima, así que esta es la única indicación que el operario ve.
    // El rótulo dice QUÉ escanear en este paso, y arrastra el aviso de que en este
    // equipo no hay cámara: si se pisara uno con otro, el operario perdería la
    // instrucción del paso, que es lo que de verdad necesita leer.
    var lbl = $('m-label');
    if (lbl) lbl.textContent = (s ? hint : 'Listo') + (avisoCamara ? ' · ' + avisoCamara : '');
    var inp = $('m-code');
    if (inp) inp.placeholder = (s === 'product') ? 'EAN / DUN del producto' : 'Código de ubicación';
    $('picklist').style.display = 'none'; $('picklist').innerHTML = '';
    if (s && s !== 'product') renderPicklist(s);
    if (s === 'product') renderProductPicker(); else { $('prodpick').style.display = 'none'; $('prodpick').innerHTML = ''; }
    // Con todos los pasos resueltos solo queda la cantidad: el campo de código sobra.
    $('manual').style.display = s ? '' : 'none';
    enfocaCodigo();   // la pistola escribe donde está el cursor
  }

  // Ordena y rotula las ubicaciones candidatas según el paso.
  function renderPicklist(step) {
    var box = $('picklist');
    if (step === 'bin') {
      // Recepción: ubicaciones de recepción primero.
      var opts = LOCS.slice().sort(function (a, b) { return (a.zoneType === 'RECEIVING' ? 0 : 1) - (b.zoneType === 'RECEIVING' ? 0 : 1); });
      paintLocs(step, 'Toca la ubicación de recepción (o escanéala):', opts.map(function (l) { return { loc: l }; }), false);
    } else if (step === 'to') {
      // Guardado destino: almacenaje / picking, EXCLUYENDO el origen (no puede ser el mismo).
      var dest = LOCS.filter(function (l) {
        return (l.zoneType === 'STORAGE' || l.zoneType === 'PICKING') && l.code !== captured.from;
      });
      paintLocs(step, 'Toca la ubicación destino (o escanéala):', dest.map(function (l) { return { loc: l }; }), false);
    } else if (step === 'from' || step === 'loc') {
      // Origen (guardado) / picking: solo ubicaciones con stock del SKU.
      var wantState = step === 'loc' ? 'RESERVED' : 'AVAILABLE';
      if (!captured.resolved) return;
      box.style.display = ''; box.innerHTML = '<div class="pl-title">Buscando stock…</div>';
      api('/sellers/' + encodeURIComponent(cfg.seller) + '/inventory?sku=' + encodeURIComponent(captured.resolved.sku))
        .then(function (rows) {
          // Suma por ubicación (todos los lotes del estado pedido) -> una fila por ubicación.
          var agg = {};
          rows.forEach(function (b) { if (b.state === wantState) agg[b.locationId] = (agg[b.locationId] || 0) + b.qty; });
          var items = Object.keys(agg).filter(function (id) { return agg[id] > 0; }).map(function (id) {
            var l = LOC_BY_ID[id] || { id: id, code: id, zoneType: '' };
            return { loc: l, qty: agg[id] };
          }).sort(function (a, b) { return b.qty - a.qty; });
          var title = step === 'loc'
            ? 'Toca la ubicación con stock RESERVADO de ' + captured.resolved.sku + ':'
            : 'Toca la ubicación ORIGEN con stock de ' + captured.resolved.sku + ':';
          if (!items.length) {
            box.innerHTML = '<div class="pl-empty">' + (step === 'loc'
              ? 'No hay stock reservado de ' + esc(captured.resolved.sku) + ' en ninguna ubicación. El picking retira de reservas de órdenes; primero debe existir una orden asignada.'
              : 'No hay stock disponible de ' + esc(captured.resolved.sku) + ' en ninguna ubicación.') + '</div>';
            return;
          }
          paintLocs(step, title, items, true);
        })
        .catch(function () { box.style.display = 'none'; });
    }
  }

  function paintLocs(step, title, items, withQty) {
    var box = $('picklist');
    if (!items.length) { box.style.display = 'none'; box.innerHTML = ''; return; }
    var html = '<div class="pl-title">' + esc(title) + '</div>';
    items.forEach(function (it) {
      var l = it.loc;
      var q = withQty ? ('<span class="lq' + (it.qty > 0 ? '' : ' zero') + '">' + it.qty + ' un</span>') : ('<span class="lz">' + esc(zoneName(l.zoneType)) + '</span>');
      html += '<button class="loc" data-code="' + esc(l.code) + '" data-max="' + (withQty ? it.qty : '') + '">'
        + '<span><span class="lc">' + esc(l.code) + '</span>' + (withQty ? ' <span class="lz">' + esc(zoneName(l.zoneType)) + '</span>' : '') + '</span>'
        + q + '</button>';
    });
    box.innerHTML = html; box.style.display = '';
    Array.prototype.forEach.call(box.querySelectorAll('.loc'), function (btn) {
      btn.addEventListener('click', function () {
        // Solo el ORIGEN (guardado) y la ubicación de PICKING fijan el tope de unidades.
        if (step === 'from' || step === 'loc') {
          var mx = btn.getAttribute('data-max');
          captured.maxBase = (mx === '' || mx == null) ? null : parseInt(mx, 10);
        }
        pickValue(step, btn.getAttribute('data-code'));
      });
    });
  }

  // Selección de un valor de ubicación (por toque o por escaneo/manual).
  function pickValue(step, code) {
    captured[step] = code;
    $('picklist').style.display = 'none';
    renderBins(); advance();
  }

  function zoneName(z) { return { RECEIVING: 'Recepción', STORAGE: 'Almacenaje', PICKING: 'Picking', SHIPPING: 'Despacho', QUARANTINE: 'Cuarentena' }[z] || z || ''; }

  // Busca una ubicación por su código (tolerante a mayúsculas/espacios).
  function findLocByCode(code) {
    var c = String(code || '').trim().toLowerCase();
    for (var i = 0; i < ALL_LOCS.length; i++) {
      if (String(ALL_LOCS[i].code).toLowerCase() === c) return ALL_LOCS[i];
    }
    return null;
  }

  // ---- Manejo de un código detectado ---------------------------------------
  function onDetect(raw) {
    if (navigator.vibrate) navigator.vibrate(60);
    var s = steps[stepIdx];
    if (!s) return;
    if (s === 'product') {
      api('/sellers/' + encodeURIComponent(cfg.seller) + '/barcodes/' + encodeURIComponent(raw))
        .then(function (pack) {
          captured.product = raw; captured.resolved = pack;
          $('r-sku').textContent = pack.sku;
          $('r-level').textContent = pack.label + ' (' + pack.code + ')';
          $('r-factor').textContent = '× ' + pack.factor + (pack.isBase ? '  (unidad base)' : '');
          $('reso').style.display = '';
          advance();
        })
        .catch(function (e) { toast('Código no reconocido', false); });
    } else {
      // Paso de UBICACIÓN: solo se acepta si el código es una ubicación real de la
      // operación. Así, si la cámara relee el producto (o se teclea otra cosa), no se
      // toma por error como bin. Si no tenemos la lista cargada, confiamos (el backend valida).
      var loc = findLocByCode(raw);
      if (ALL_LOCS.length && !loc) {
        if (raw !== lastRejected) { toast('Ese código no es una ubicación. Toca la ubicación en la lista.', false); lastRejected = raw; }
        return; // no captura ni avanza
      }
      // Restricciones de zona coherentes con cada paso.
      if (loc) {
        if (s === 'to' && !(loc.zoneType === 'STORAGE' || loc.zoneType === 'PICKING')) {
          toast('El destino debe ser una ubicación de almacenaje o picking.', false); return;
        }
        if (s === 'to' && loc.code === captured.from) {
          toast('El destino no puede ser la misma ubicación de origen.', false); return;
        }
      }
      // Escaneo/manual: no conocemos la cantidad exacta en esa ubicación -> sin tope local.
      if (s === 'from' || s === 'loc') captured.maxBase = null;
      pickValue(s, loc ? loc.code : raw);
    }
  }

  function advance() {
    stepIdx += 1;
    if (stepIdx < steps.length) { enterStep(); return; }
    // Todos los pasos capturados
    enterStep();
    if (op === 'stock') { doStockLookup(); return; }
    setupQty();
  }

  function renderBins() {
    var rows = [];
    ['bin', 'from', 'to', 'loc'].forEach(function (k) {
      if (captured[k]) {
        var lbl = k === 'from' ? 'Origen' : k === 'to' ? 'Destino' : 'Ubicación';
        rows.push('<div class="kv"><span>' + lbl + '</span><b class="code">' + esc(captured[k]) + '</b></div>');
      }
    });
    if (rows.length) { $('bins').innerHTML = '<div class="card">' + rows.join('') + '</div>'; $('bins').style.display = ''; }
  }

  function setupQty() {
    stopCamera();
    $('picklist').style.display = 'none';
    $('qty-lbl').textContent = captured.resolved.isBase ? 'Cantidad de unidades' : ('Cantidad de packs (' + (captured.resolved.label || captured.resolved.code) + ')');
    $('prodpick').style.display = 'none';
    $('q-count').value = 1;
    captured.ctl = { lot: false, exp: false };
    $('q-lot').value = ''; $('q-exp').value = '';
    $('lotwrap').style.display = 'none'; $('lot-f').style.display = 'none'; $('exp-f').style.display = 'none';
    updatePreview();
    $('qtywrap').style.display = ''; $('btn-confirm').style.display = '';
    if (op === 'receive') setupLotFields();
  }

  // ---- Lote / vencimiento en la recepción -----------------------------------
  // Se piden SI Y SOLO SI el producto los controla (y entonces son obligatorios): el
  // maestro de SKUs dice qué controla cada uno. Se trae una vez por cliente.
  var SKU_CTL = {};
  function skuCtlMap(sellerId) {
    if (SKU_CTL[sellerId]) return Promise.resolve(SKU_CTL[sellerId]);
    return api('/sellers/' + encodeURIComponent(sellerId) + '/skus').then(function (list) {
      var m = {};
      (list || []).forEach(function (k) { m[k.sku] = { lot: !!k.lotControlled, exp: !!k.expiryControlled }; });
      SKU_CTL[sellerId] = m; return m;
    });
  }
  function setupLotFields() {
    var sku = captured.resolved && captured.resolved.sku;
    if (!sku) return;
    $('btn-confirm').disabled = true; // hasta saber qué pide el producto
    skuCtlMap(cfg.seller).then(function (m) {
      var c = m[sku] || { lot: false, exp: false };
      captured.ctl = c;
      // En una tarea, lo declarado en la orden de recepción viene prellenado.
      var rc = task && task.receipt, line = rc && (rc.lines || []).filter(function (l) { return l.sku === sku; })[0];
      if (c.lot && line && line.lot) $('q-lot').value = line.lot;
      if (c.exp && line && line.expiry) $('q-exp').value = String(line.expiry).slice(0, 10);
      $('lot-f').style.display = c.lot ? '' : 'none';
      $('exp-f').style.display = c.exp ? '' : 'none';
      $('lotwrap').style.display = (c.lot || c.exp) ? '' : 'none';
      updatePreview();
    }).catch(function () { captured.ctl = { lot: false, exp: false }; updatePreview(); });
  }
  function lotFaltante() {
    var c = captured.ctl || {};
    if (op !== 'receive') return '';
    if (c.lot && !$('q-lot').value.trim()) return 'Ingresa el lote: este producto es controlado por lote.';
    if (c.exp && !$('q-exp').value) return 'Ingresa el vencimiento: este producto es controlado por vencimiento.';
    return '';
  }
  $('q-lot').addEventListener('input', function () { updatePreview(); });
  $('q-exp').addEventListener('input', function () { updatePreview(); });
  $('q-exp').addEventListener('change', function () { updatePreview(); });

  function updatePreview() {
    var n = parseInt($('q-count').value, 10) || 0;
    var f = captured.resolved ? captured.resolved.factor : 1;
    var base = n * f;
    var txt = n + ' × ' + (captured.resolved ? captured.resolved.label : '') + ' = ' + base + ' unidades base';
    var over = (captured.maxBase != null && base > captured.maxBase);
    if (captured.maxBase != null) {
      txt += '  ·  disponible: ' + captured.maxBase + ' un';
    }
    var pv = $('q-preview');
    pv.textContent = txt;
    pv.className = 'muted' + (over ? ' warnrow' : '');
    // No permitir confirmar por encima de lo disponible (guardado/picking).
    $('btn-confirm').disabled = over || !(n > 0) || !!lotFaltante();
  }
  $('q-plus').addEventListener('click', function () { $('q-count').value = (parseInt($('q-count').value, 10) || 0) + 1; updatePreview(); });
  $('q-minus').addEventListener('click', function () { $('q-count').value = Math.max(1, (parseInt($('q-count').value, 10) || 1) - 1); updatePreview(); });
  $('q-count').addEventListener('input', updatePreview);

  // ---- Confirmar operación --------------------------------------------------
  $('btn-confirm').addEventListener('click', function () {
    var packCount = parseInt($('q-count').value, 10);
    if (!(packCount > 0)) { toast('Cantidad inválida', false); return; }
    var falta = lotFaltante(); if (falta) { toast(falta, false); return; }
    var seller = encodeURIComponent(cfg.seller), base = '/sellers/' + seller;
    var call;
    // Lote / vencimiento: solo viajan si el producto los controla.
    var ctl = captured.ctl || {}, lotV = ctl.lot ? $('q-lot').value.trim() : '', expV = ctl.exp ? $('q-exp').value : '';
    if (task && task.type === 'RECEIVE') {
      // Cotejo de una TAREA de recepción: se registra contra la línea de la orden de recepción.
      var rc = task.receipt, sku = captured.resolved ? captured.resolved.sku : null;
      var line = rc && (rc.lines || []).filter(function (l) { return l.sku === sku; })[0];
      if (!line) { toast('El producto ' + (sku || captured.product) + ' no está en esta recepción', false); return; }
      var rq = packCount * (captured.resolved ? captured.resolved.factor : 1);
      call = api(base + '/receipts/' + encodeURIComponent(task.entityId) + '/receive', { method: 'POST', body: { counts: [Object.assign({ lineNo: line.lineNo, qty: rq }, lotV ? { lot: lotV } : {}, expV ? { expiry: expV } : {})] } })
        .then(function (o) { return { scan: { baseQty: rq, code: captured.resolved.code, sku: sku }, receipt: o }; });
    } else if (op === 'receive') {
      call = api(base + '/scan/inbound', { method: 'POST', body: Object.assign({ barcode: captured.product, packCount: packCount, locationCode: captured.bin }, lotV ? { lot: lotV } : {}, expV ? { expiry: expV } : {}) });
    } else if (op === 'putaway') {
      call = api(base + '/scan/putaway', { method: 'POST', body: { productBarcode: captured.product, packCount: packCount, fromLocationCode: captured.from, toLocationCode: captured.to } });
    } else if (task && task.type === 'PICK') {
      // Picking de una TAREA: se registra contra la orden (avance por línea; la orden pasa a PICKED al completar).
      var locObj = findLocByCode(captured.loc);
      var baseQty = packCount * (captured.resolved ? captured.resolved.factor : 1);
      call = api(base + '/orders/' + encodeURIComponent(task.entityId) + '/pick-task', { method: 'POST', body: { sku: captured.resolved.sku, locationId: locObj ? locObj.id : captured.loc, qty: baseQty } })
        .then(function (o) { return { scan: { baseQty: baseQty, code: captured.resolved.code, sku: captured.resolved.sku }, order: o }; });
    } else {
      call = api(base + '/scan/pick', { method: 'POST', body: { productBarcode: captured.product, packCount: packCount, locationCode: captured.loc } });
    }
    $('btn-confirm').disabled = true;
    call.then(function (r) {
      var q = r.scan.baseQty;
      $('res-big').textContent = '✓ ' + packCount + ' × ' + r.scan.code + ' = ' + q + ' un';
      $('res-sub').textContent = OP_META[op].title + ' de ' + r.scan.sku + ' confirmada (' + q + ' unidades base).';
      $('result').style.display = '';
      $('qtywrap').style.display = 'none'; $('btn-confirm').style.display = 'none';
      $('after').style.display = 'flex';
      $('btn-closercpt').style.display = 'none';
      $('btn-finish').textContent = PI.back === 'recv' ? 'Terminar y volver a la lista de recepciones' : PI.back === 'ts:putaway' ? 'Terminar y volver a la lista de guardado' : PI.back ? 'Terminar y volver a la lista de picking' : 'Terminar y volver a mis tareas';
      if (task && task.type === 'PICK') {
        if (r.order && r.order.status === 'PICKED') finishTask('Orden completamente pickeada: la tarea salió de tu bandeja.');
        else { loadTaskPicklist(); $('btn-again').style.display = ''; }
      } else if (task && task.type === 'RECEIVE') {
        if (r.receipt && r.receipt.status === 'RECEIVED') finishTask('Recepción completa: la tarea salió de tu bandeja.');
        else { task.receipt = r.receipt || task.receipt; loadTaskReceipt(); $('btn-again').style.display = ''; $('btn-closercpt').style.display = ''; }
      } else if (task && (task.type === 'PUTAWAY' || task.type === 'RESLOT')) {
        // El guardado cierra su asignación en el servidor (una tarea = un SKU/origen).
        finishTask('Tarea completada: salió de tu bandeja.');
      } else $('btn-again').style.display = task ? '' : 'none';
      toast(OP_META[op].title + ' registrada', true);
      // Captura de productividad con inicio/fin reales. Va por la cola: si no hay red,
      // la muestra espera en el aparato en vez de perderse.
      var LABOR_TYPE = { pick: 'PICK', putaway: 'PUTAWAY', receive: 'RECEIVE' };
      if (opId && LABOR_TYPE[op] && taskStartAt) {
        laborCapture({
          operationId: opId, sellerId: cfg.seller, operator: (user && user.id) || cfg.email,
          type: LABOR_TYPE[op], startAt: taskStartAt, endAt: new Date().toISOString(), units: q,
          // La orden y la ubicación ya se conocen acá y el endpoint las acepta desde
          // siempre; no mandarlas dejaba esas columnas en null y con ellas se cae la
          // posibilidad de medir tiempo por ubicación.
          orderRef: (task && (task.entityRef || task.entityId)) || null,
          locationId: laborLocationId(op),
        });
        taskStartAt = new Date().toISOString(); // reinicia para la próxima tarea
      }
    }).catch(function (e) {
      toast(e.message, false);
    }).then(function () { $('btn-confirm').disabled = false; });
  });

  // ---- Consulta de stock ----------------------------------------------------
  function doStockLookup() {
    stopCamera();
    api('/sellers/' + encodeURIComponent(cfg.seller) + '/inventory?sku=' + encodeURIComponent(captured.resolved.sku))
      .then(function (rows) {
        var total = rows.reduce(function (s, b) { return s + b.qty; }, 0);
        var byState = {};
        rows.forEach(function (b) { byState[b.state] = (byState[b.state] || 0) + b.qty; });
        var detail = Object.keys(byState).map(function (k) { return k + ': ' + byState[k]; }).join('  ·  ') || 'sin stock';
        $('res-big').textContent = total + ' un base';
        $('res-sub').textContent = captured.resolved.sku + '  —  ' + detail;
        $('result').style.display = '';
      })
      .catch(function (e) { toast(e.message, false); });
  }

  // ---- Entrada de código: pistola, cámara y teclado --------------------------
  // Tres caminos hacia la MISMA función `onDetect`, porque en una bodega conviven los
  // tres: un lector de mano o de anillo que teclea el código y da Enter, la cámara del
  // teléfono donde el navegador la soporta, y los dedos cuando el código está rayado.
  //
  // Antes solo existía la cámara, y el campo de texto aparecía únicamente si la cámara
  // fallaba. Eso dejaba fuera a toda pistola (que no dispara ningún evento que la app
  // escuchara) y a todo iPhone (Safari no tiene el lector nativo del navegador).
  var stream = null, detector = null, scanning = false, lastCode = '', lastAt = 0;

  /** ¿Ya vimos este código hace nada? Evita el doble disparo entre cámara y pistola. */
  function esRepetido(raw) {
    var now = Date.now();
    if (raw === lastCode && now - lastAt < 1600) return true;
    lastCode = raw; lastAt = now;
    return false;
  }

  function startCamera() {
    var video = $('video');
    // La cámara es un extra, no el camino principal: si no está, la app sigue
    // perfectamente usable con la pistola o el teclado.
    if (!('BarcodeDetector' in window)) { sinCamara('Este equipo lee con pistola o a mano.'); return; }
    try { detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'] }); }
    catch (e) { sinCamara('Este equipo lee con pistola o a mano.'); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(function (s) { stream = s; video.srcObject = s; return video.play(); })
      .then(function () { scanning = true; $('cam-hint').textContent = STEP_HINT[steps[stepIdx]] || ''; requestAnimationFrame(loop); })
      .catch(function () { sinCamara('Sin acceso a la cámara. Usa la pistola o escribe el código.'); });
  }

  /** Sin cámara: se oculta el visor para no ocupar media pantalla con un recuadro negro. */
  var avisoCamara = '';
  function sinCamara(msg) {
    var cam = $('cam'); if (cam) cam.style.display = 'none';
    var f = $('manual'); if (f) f.style.display = '';   // por si algo la escondió
    avisoCamara = msg;
    enterStep();        // repinta el rótulo del paso con el aviso incorporado
    enfocaCodigo();
  }

  /**
   * Devuelve el foco al campo de código.
   *
   * Una pistola HID es un teclado: escribe donde esté el cursor. Si el foco se fue a
   * otro lado, el disparo se pierde en el vacío y el operario no entiende por qué no
   * pasa nada. Por eso se reclama el foco al entrar a cada paso y después de cada
   * confirmación.
   *
   * `preventScroll` evita que el teclado en pantalla salte en un teléfono: el campo ya
   * está a la vista y el salto marea.
   */
  function enfocaCodigo() {
    var el = $('m-code'); if (!el) return;
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  }

  function loop() {
    if (!scanning) return;
    var video = $('video');
    detector.detect(video).then(function (codes) {
      if (codes && codes.length) {
        var raw = codes[0].rawValue;
        if (raw && !esRepetido(raw)) onDetect(raw);
      }
    }).catch(function () {}).then(function () { if (scanning) requestAnimationFrame(loop); });
  }

  function stopCamera() {
    scanning = false;
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  }

  // El campo es un <form>: el Enter de la pistola lo envía. Esto es TODO lo que hace
  // falta para soportar un lector HID — no hay que detectar la velocidad de tecleo ni
  // adivinar si fue una persona o un aparato.
  $('manual').addEventListener('submit', function (e) {
    e.preventDefault();
    var el = $('m-code'), code = (el.value || '').trim();
    el.value = '';
    enfocaCodigo();                       // listo para el siguiente disparo
    if (!code) return;
    if (esRepetido(code)) return;         // la pistola a veces dispara dos veces
    if (navigator.vibrate) navigator.vibrate(40);
    onDetect(code);
  });

  // Si el flujo se abrió desde la estación de picking, volver lleva a esa lista.
  function volverDeFlujo() {
    task = null;
    var a = PI.back; PI.back = false;
    if (a === 'recv') openRecvStation(); else if (a === 'ts:putaway') openTaskStation('putaway'); else if (a) openPickStation(); else show('home');
  }
  $('btn-back').addEventListener('click', volverDeFlujo);
  $('btn-again').addEventListener('click', function () {
    var t = task; startOp(op);
    if (t && t.type === 'PICK') loadTaskPicklist();
    else if (t && t.type === 'RECEIVE') { steps = ['product']; stepIdx = 0; enterStep(); loadTaskReceipt(); }
    else if (t && (t.type === 'PUTAWAY' || t.type === 'RESLOT')) startAssigned(t);
  });
  $('btn-closercpt').addEventListener('click', function () {
    if (!task || task.type !== 'RECEIVE') return;
    var b = $('btn-closercpt');
    // Cerrar con faltante no tiene vuelta atrás: pide un segundo toque.
    if (!b.getAttribute('data-arm')) {
      b.setAttribute('data-arm', '1'); b.textContent = 'Toca de nuevo para cerrar con faltante';
      setTimeout(function () { b.removeAttribute('data-arm'); b.textContent = 'Cerrar recepción con faltante'; }, 4000);
      return;
    }
    b.removeAttribute('data-arm'); b.textContent = 'Cerrar recepción con faltante';
    b.disabled = true;
    api('/sellers/' + encodeURIComponent(task.sellerId) + '/receipts/' + encodeURIComponent(task.entityId) + '/close', { method: 'POST', body: {} })
      .then(function () { toast('Recepción cerrada con faltante', true); finishTask('Recepción cerrada: la tarea salió de tu bandeja.'); })
      .catch(function (e) { toast(e.message, false); })
      .then(function () { b.disabled = false; });
  });
  $('btn-finish').addEventListener('click', volverDeFlujo);

  // ---- Marca (white-label) de la operación ----------------------------------
  // La marca que configura el administrador (logo, nombre, color) se refleja aquí.
  function resolveOpId(cb) {
    if (user && user.operationId) { cb(user.operationId); return; }
    if (cfg.seller) {
      api('/sellers/' + encodeURIComponent(cfg.seller))
        .then(function (s) { cb(s && s.operationId); })
        .catch(function () { cb(null); });
      return;
    }
    cb(null);
  }
  function applyPwaBranding(b) {
    try {
      var root = document.documentElement;
      if (b && b.primaryColor) {
        root.style.setProperty('--primary', b.primaryColor);
        root.style.setProperty('--primary-2', b.primaryColor);
      }
      var name = b ? (b.companyName || b.legalName || '') : '';
      var title = $('pwa-title'); if (title) title.textContent = name ? (name + ' · Operador') : 'WMS Operador';
      function logoHtml(px) {
        if (b && b.logoDataUri) { var i = document.createElement('img'); i.src = b.logoDataUri; i.alt = name || 'logo'; i.style.cssText = 'max-height:' + px + 'px;max-width:200px;display:block'; return i; }
        if (name) { var d = document.createElement('div'); d.textContent = name; d.style.cssText = 'font-weight:800;font-size:16px;color:var(--primary-2)'; return d; }
        return null;
      }
      // En el login se mantiene el logo Ninja Hubs salvo que la operación tenga logo propio.
      var lg = $('pwa-brand-login'); if (lg && b && b.logoDataUri) { lg.innerHTML = ''; var e1 = logoHtml(56); if (e1) lg.appendChild(e1); }
      var hb = $('pwa-brand-home'); if (hb) { hb.innerHTML = ''; var e2 = logoHtml(30); if (e2) hb.appendChild(e2); }
    } catch (e) {}
  }
  function loadPwaBranding() {
    // El super administrador (plataforma) conserva la identidad Ninja WMS.
    if (user && user.role === 'PLATFORM_ADMIN') return;
    resolveOpId(function (id) {
      if (!id) return;
      api('/operations/' + encodeURIComponent(id) + '/branding').then(applyPwaBranding).catch(function () {});
    });
  }

  // ---- Utils ----------------------------------------------------------------
  // ---- Canal con la administración ------------------------------------------
  // El panel del administrador podía escribirle a un operario desde antes, y el
  // copiloto incluso le respondía al admin "le llega a su app". No le llegaba: la app
  // nunca leyó ese canal. Esto lo vuelve cierto.
  //
  // El hilo es el del propio operario y el servidor lo fuerza: el endpoint ignora el
  // `threadUserId` que mande alguien sin `chat:manage`, así que desde acá no hay forma
  // de leer la conversación de otro aunque se manipule la petición.
  var MSGS = [];            // último hilo cargado
  var msgLeidoAt = null;    // hasta cuándo leyó este operario (para el no-leído)
  var msgTimer = null;
  var msgEnviando = false;

  function fechaCorta(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var hoy = new Date();
    var mismoDia = d.toDateString() === hoy.toDateString();
    var hora = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
    return mismoDia ? hora : ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + ' ' + hora;
  }

  /** Mensajes que llegaron después de la última vez que este operario abrió la bandeja. */
  function contarNoLeidos() {
    if (!user) return 0;
    var corte = msgLeidoAt ? Date.parse(msgLeidoAt) : 0;
    return MSGS.filter(function (m) {
      return m.senderId !== user.id && Date.parse(m.at) > corte;
    }).length;
  }

  function pintaNoLeidos() {
    var d = $('msg-dot'); if (!d) return;
    var n = contarNoLeidos();
    d.textContent = n > 9 ? '9+' : String(n);
    d.classList.toggle('on', n > 0);
  }

  /**
   * Trae el hilo y el estado de lectura. Se llama desde el tablero (cada 30 s) y con
   * más frecuencia mientras la pantalla de mensajes está abierta.
   *
   * Un fallo acá NO grita: si la bodega se quedó sin señal, el operario ya lo va a
   * notar por sus tareas; un segundo mensaje rojo por lo mismo solo estorba.
   */
  function refrescaNoLeidos() {
    var oid = opIdOrNull(); if (!oid || !user || !cfg.token) return Promise.resolve();
    return Promise.all([
      api('/ops-channel/messages?operationId=' + encodeURIComponent(oid)),
      api('/ops-channel/read?operationId=' + encodeURIComponent(oid)).catch(function () { return null; }),
    ]).then(function (r) {
      MSGS = Array.isArray(r[0]) ? r[0] : [];
      if (r[1] && typeof r[1].operatorReadAt !== 'undefined') msgLeidoAt = r[1].operatorReadAt;
      pintaNoLeidos();
      if ($('msgs').classList.contains('on')) renderMsgs();
    }).catch(function () { /* silencioso a propósito */ });
  }

  function renderMsgs() {
    var cont = $('msg-list'); if (!cont) return;
    if (!MSGS.length) {
      cont.innerHTML = '<div class="msgs-empty">Aún no hay mensajes.<br>Escribe si necesitas algo de la administración: un faltante, una duda de una orden, un problema con una ubicación.</div>';
      return;
    }
    var ordenados = MSGS.slice().sort(function (a, b) { return Date.parse(a.at) - Date.parse(b.at); });
    cont.innerHTML = ordenados.map(function (m) {
      var mio = user && m.senderId === user.id;
      var cuerpo = m.text || m.note || (m.kind === 'voice' ? 'Mensaje de voz' : '');
      var audio = '';
      if (m.kind === 'voice' && m.audioId) {
        audio = '<div class="audio"><button class="btn alt" style="padding:9px" data-audio="' + esc(m.audioId) + '">▶ Escuchar'
          + (m.durationSec ? ' (' + m.durationSec + 's)' : '') + '</button></div>';
      }
      return '<div class="msg ' + (mio ? 'me' : 'them') + (m.kind === 'voice' ? ' voice' : '') + '">'
        + (mio ? '' : '<div class="who">' + esc(m.senderName || 'Administración') + '</div>')
        + esc(cuerpo) + audio
        + '<div class="when">' + fechaCorta(m.at) + '</div></div>';
    }).join('');
    cont.scrollTop = cont.scrollHeight;
    try { cont.lastElementChild.scrollIntoView({ block: 'end' }); } catch (e) {}
  }

  /** Deja constancia de que el operario ya vio el hilo. El "visto" del panel sale de acá. */
  function marcaLeido() {
    var oid = opIdOrNull(); if (!oid || !user) return;
    api('/ops-channel/read', { method: 'POST', body: { operationId: oid } })
      .then(function (r) { if (r && typeof r.operatorReadAt !== 'undefined') msgLeidoAt = r.operatorReadAt; pintaNoLeidos(); })
      .catch(function () {});
  }

  function abreMensajes() {
    show('msgs');
    renderMsgs();
    refrescaNoLeidos().then(marcaLeido);
    if (!msgTimer) {
      msgTimer = setInterval(function () {
        if (!$('msgs').classList.contains('on') || document.hidden) return;
        refrescaNoLeidos().then(function () { if (contarNoLeidos()) marcaLeido(); });
      }, 12000);
    }
  }

  if ($('btn-msgs')) $('btn-msgs').addEventListener('click', abreMensajes);
  if ($('btn-msgback')) $('btn-msgback').addEventListener('click', function () { show('home'); });

  // El teclado del teléfono manda Enter; en un textarea eso sería un salto de línea.
  // Enter envía, Shift+Enter (teclado físico de una pistola con dock) hace el salto.
  if ($('msg-text')) {
    $('msg-text').addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); enviaMensaje(); }
    });
  }
  if ($('msg-form')) {
    $('msg-form').addEventListener('submit', function (e) { e.preventDefault(); enviaMensaje(); });
  }

  function enviaMensaje() {
    if (msgEnviando) return;
    var el = $('msg-text'), texto = (el.value || '').trim();
    if (!texto) return;
    var oid = opIdOrNull();
    if (!oid) { toast('No sé a qué operación mandar el mensaje', false); return; }
    msgEnviando = true; $('msg-send').disabled = true;
    api('/ops-channel/messages', { method: 'POST', body: { operationId: oid, kind: 'text', text: texto } })
      .then(function (m) {
        el.value = '';
        if (m && m.id) MSGS.push(m);
        renderMsgs();
        marcaLeido();
      })
      .catch(function (e) {
        // El envío puede fallar porque la operación no tiene el canal habilitado. Eso
        // no es un problema de red y decirle "sin conexión" al operario lo manda a
        // buscar señal por nada.
        toast('No se pudo enviar: ' + (e && e.message || 'sin conexión'), false);
      })
      .then(function () { msgEnviando = false; $('msg-send').disabled = false; });
  }

  // Reproducción de una nota de voz que dejó la administración. El audio se pide solo
  // cuando se toca: el listado trae la referencia, no los megabytes.
  if ($('msg-list')) {
    $('msg-list').addEventListener('click', function (e) {
      var b = e.target.closest ? e.target.closest('[data-audio]') : null;
      if (!b) return;
      var oid = opIdOrNull(); if (!oid) return;
      b.disabled = true; b.textContent = 'Cargando…';
      api('/ops-channel/audio/' + encodeURIComponent(b.getAttribute('data-audio')) + '?operationId=' + encodeURIComponent(oid))
        .then(function (a) {
          if (!a || !a.dataBase64) throw new Error('el audio ya no está disponible');
          var au = document.createElement('audio');
          au.controls = true; au.autoplay = true;
          au.src = 'data:' + (a.mime || 'audio/webm') + ';base64,' + a.dataBase64;
          b.parentNode.replaceChild(au, b);
        })
        .catch(function (err) {
          b.disabled = false; b.textContent = '▶ Escuchar';
          toast('No se pudo reproducir: ' + (err && err.message || 'sin conexión'), false);
        });
    });
  }

  // =====================================================================
  // ESTACIONES DE EMPAQUE Y DESPACHO
  // ---------------------------------------------------------------------
  // Trabajan con las órdenes de TODA la operación (un empacador no empaca "de un
  // cliente": empaca lo que salió de picking). Se entra desde "Operar libre" o desde
  // una tarea PACK / SHIP de la bandeja, que llega con su orden ya elegida.
  // =====================================================================
  var ST_LBL = { RECEIVED: 'Ingresada', ALLOCATED: 'Reservada', PICKING: 'En picking', PICKED: 'Pickeada', PACKED: 'Empacada', SHIPPED: 'Despachada', CANCELLED: 'Cancelada' };
  var PK = { orders: [], order: null, counts: {}, mats: {}, bultos: 1, materials: [], startAt: null, task: null, armado: false, codeCache: {} };
  var SH = { orders: [], courier: '', sel: {}, task: null, startAt: null, busy: false };

  function oRef(o) { return (o && (o.externalOrderId || String(o.id).slice(0, 8))) || '—'; }
  function oUnits(o) { return (o.lines || []).reduce(function (a, l) { return a + (l.qty || 0); }, 0); }
  function oCarrier(o) { return (o.packing && o.packing.carrier) || o.carrier || ''; }
  function norm(s) { return String(s || '').trim().toLowerCase(); }
  function dlChipHtml(o) {
    if (!o || !o.dueAt) return '';
    var min = Math.round((Date.parse(o.dueAt) - Date.now()) / 60000);
    if (isNaN(min)) return '';
    var abs = Math.abs(min), h = Math.floor(abs / 60), m = abs % 60;
    var dur = h > 0 ? h + ' h' + (m ? ' ' + m + ' min' : '') : m + ' min';
    var cls = min < 0 ? 'v' : (min <= 240 ? 'r' : '');
    return '<span class="dlc ' + cls + '">' + (min < 0 ? 'Vencida hace ' : 'Vence en ') + dur + '</span>';
  }
  /** Urgencia primero: deadline más cercano, luego las sin deadline por antigüedad. */
  function porUrgencia(a, b) {
    var da = a.dueAt ? Date.parse(a.dueAt) : Infinity, db = b.dueAt ? Date.parse(b.dueAt) : Infinity;
    if (da !== db) return da - db;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt);
  }
  function bip(ok) { if (navigator.vibrate) navigator.vibrate(ok ? 40 : [80, 60, 80]); }
  function enfoca(id) { var el = $(id); if (!el) return; try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); } }
  function opOrders() {
    var oid = opIdOrNull(); if (!oid) return Promise.reject(new Error('Sin operación'));
    return api('/operations/' + encodeURIComponent(oid) + '/orders');
  }
  /** Busca una orden por lo que trae su etiqueta: N° externo, id, tracking o tracking de un bulto. */
  function matchOrder(list, code) {
    var c = norm(code); if (!c) return null;
    return list.filter(function (o) {
      if (norm(o.externalOrderId) === c || norm(o.id) === c || norm(String(o.id).slice(0, 8)) === c) return true;
      var p = o.packing || {};
      if (p.trackingNumber && norm(p.trackingNumber) === c) return true;
      return (p.labels || []).some(function (l) { return l.trackingNumber && norm(l.trackingNumber) === c; });
    })[0] || null;
  }

  // ---- Lector con cámara compartido -------------------------------------
  var CS = { stream: null, on: false, det: null, cb: null, cont: false, last: '', lastAt: 0 };
  function camOpen(cb, opts) {
    opts = opts || {};
    if (!('BarcodeDetector' in window)) { toast('Este equipo no lee con cámara: usa la pistola o escribe el código', false); return; }
    try { CS.det = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'] }); }
    catch (e) { toast('Este equipo no lee con cámara', false); return; }
    CS.cb = cb; CS.cont = !!opts.continuous; $('cs-hint').textContent = opts.hint || 'Apunta al código';
    $('camsheet').style.display = '';
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(function (s) { CS.stream = s; $('cs-video').srcObject = s; return $('cs-video').play(); })
      .then(function () { CS.on = true; requestAnimationFrame(camLoop); })
      .catch(function () { camClose(); toast('Sin acceso a la cámara. Usa la pistola o escribe el código.', false); });
  }
  function camLoop() {
    if (!CS.on) return;
    CS.det.detect($('cs-video')).then(function (codes) {
      var raw = codes && codes[0] && codes[0].rawValue;
      var now = Date.now();
      if (raw && !(raw === CS.last && now - CS.lastAt < 1500)) {
        CS.last = raw; CS.lastAt = now;
        var cb = CS.cb; if (!CS.cont) camClose();
        if (cb) cb(raw);
      }
    }).catch(function () {}).then(function () { if (CS.on) requestAnimationFrame(camLoop); });
  }
  function camClose() {
    CS.on = false;
    if (CS.stream) { CS.stream.getTracks().forEach(function (t) { t.stop(); }); CS.stream = null; }
    $('camsheet').style.display = 'none';
  }
  $('cs-close').addEventListener('click', camClose);

  // =====================================================================
  // EMPAQUE
  // =====================================================================
  function openPackStation(t) {
    task = null;
    PK.task = t || null; PK.order = null;
    show('pack');
    $('pk-order').style.display = 'none'; $('pk-list').style.display = '';
    $('pk-title').textContent = 'Empaque';
    $('pk-sub').textContent = 'Órdenes pickeadas listas para empacar';
    $('pk-label').textContent = 'Escanea o escribe el N° de orden';
    $('pk-code').placeholder = 'N° de orden';
    $('pk-scan').style.display = '';
    $('pk-list').innerHTML = '<div class="pk-empty">Cargando órdenes…</div>';
    // Insumos de embalaje de la bodega (cajas, bolsas…): se cargan una vez por entrada.
    var oid = opIdOrNull();
    api('/packaging?operationId=' + encodeURIComponent(oid)).then(function (m) { PK.materials = (m || []).filter(function (x) { return x.active !== false; }); }).catch(function () { PK.materials = []; });
    opOrders().then(function (list) {
      PK.orders = (list || []).filter(function (o) { return o.status === 'PICKED'; }).sort(porUrgencia);
      if (PK.task) {
        var o = PK.orders.filter(function (x) { return x.id === PK.task.entityId; })[0];
        if (o) { selectPack(o); return; }
        toast('La orden de la tarea ya no está pickeada', false);
      }
      renderPackList();
    }).catch(function (e) { $('pk-list').innerHTML = '<div class="pk-empty">No pude cargar las órdenes: ' + esc(e.message) + '</div>'; });
    enfoca('pk-code');
  }
  function renderPackList() {
    $('pk-sub').textContent = PK.orders.length + ' orden(es) pickeada(s) para empacar';
    if (!PK.orders.length) { $('pk-list').innerHTML = '<div class="pk-empty">No hay órdenes pickeadas esperando empaque. 🎉</div>'; return; }
    $('pk-list').innerHTML = '<div class="sec" style="margin-bottom:8px">Más urgentes primero</div>' + PK.orders.map(function (o) {
      return '<button class="ordc" data-pko="' + esc(o.id) + '"><div class="oc-main"><div class="oc-ref">' + esc(oRef(o)) + ' ' + dlChipHtml(o) + '</div>'
        + '<div class="oc-meta">' + esc(o.sellerName || o.sellerId) + ' · ' + (o.lines || []).length + ' línea(s) · ' + oUnits(o) + ' un' + (oCarrier(o) ? ' · ' + esc(oCarrier(o)) : '') + '</div></div>'
        + '<span class="oc-go">Empacar ›</span></button>';
    }).join('');
  }
  $('pk-list').addEventListener('click', function (e) {
    var b = e.target.closest('[data-pko]'); if (!b) return;
    var o = PK.orders.filter(function (x) { return x.id === b.getAttribute('data-pko'); })[0];
    if (o) selectPack(o);
  });
  function selectPack(o) {
    PK.order = o; PK.counts = {}; PK.mats = {}; PK.bultos = 1; PK.armado = false; PK.startAt = new Date().toISOString();
    $('pk-list').style.display = 'none'; $('pk-order').style.display = '';
    $('pk-title').textContent = 'Empacar ' + oRef(o);
    $('pk-sub').textContent = (o.sellerName || o.sellerId) + ' · ' + oUnits(o) + ' un';
    $('pk-label').textContent = 'Escanea cada PRODUCTO para verificarlo (o el embalaje)';
    $('pk-code').placeholder = 'EAN del producto o del embalaje';
    renderPackOrder();
    enfoca('pk-code');
  }
  function pkContado() { return (PK.order.lines || []).reduce(function (a, l) { return a + (PK.counts[l.lineNo] || 0); }, 0); }
  function renderPackOrder() {
    var o = PK.order; if (!o) return;
    var total = oUnits(o), cont = pkContado(), pct = total ? Math.min(100, Math.round(cont * 100 / total)) : 0;
    var lines = (o.lines || []).map(function (l) {
      var c = PK.counts[l.lineNo] || 0;
      var cls = c === l.qty ? ' done' : (c > l.qty ? ' over' : '');
      return '<div class="pkl' + cls + '"><div><div class="pl-sku">' + esc(l.sku) + (c === l.qty ? ' ✓' : '') + '</div>'
        + '<div class="pl-sub">' + (l.lot ? 'Lote ' + esc(l.lot) + ' · ' : '') + 'pide ' + l.qty + '</div></div>'
        + '<div class="pl-q"><button class="mini" data-pkm="' + l.lineNo + '">−</button><b>' + c + '/' + l.qty + '</b><button class="mini" data-pkp="' + l.lineNo + '">+</button></div></div>';
    }).join('');
    var mats = PK.materials.length
      ? PK.materials.map(function (m) {
          var q = PK.mats[m.sku] || 0;
          return '<div class="matrow"><div class="mn">' + esc(m.name) + '<small>Saldo ' + (m.onHand || 0) + (m.barcode ? ' · EAN ' + esc(m.barcode) : '') + '</small></div>'
            + '<div class="pl-q"><button class="mini" data-mtm="' + esc(m.sku) + '">−</button><b style="min-width:28px;text-align:center">' + q + '</b><button class="mini" data-mtp="' + esc(m.sku) + '">+</button></div></div>';
        }).join('')
      : '<div class="muted" style="font-size:13px">Esta bodega no tiene insumos de embalaje cargados.</div>';
    var faltan = total - cont;
    var btnTxt = cont === 0 ? 'Empacar sin verificar' : (faltan !== 0 || (o.lines || []).some(function (l) { return (PK.counts[l.lineNo] || 0) !== l.qty; }) ? 'Empacar con diferencias' : 'Empacar y traer etiquetas');
    var ok = cont > 0 && (o.lines || []).every(function (l) { return (PK.counts[l.lineNo] || 0) === l.qty; });
    $('pk-order').innerHTML =
      '<div class="card"><div class="kv"><span>Orden</span><b class="code">' + esc(oRef(o)) + '</b></div>'
      + '<div class="kv"><span>Cliente</span><b>' + esc(o.sellerName || o.sellerId) + '</b></div>'
      + (oCarrier(o) ? '<div class="kv"><span>Courier</span><b>' + esc(oCarrier(o)) + '</b></div>' : '')
      + (o.dueAt ? '<div class="kv"><span>Deadline</span><b>' + dlChipHtml(o) + '</b></div>' : '') + '</div>'
      + '<div class="sec">Verificación · ' + cont + ' de ' + total + ' un</div><div class="bar"><i style="width:' + pct + '%"></i></div>'
      + lines
      + '<div class="sec" style="margin-top:6px">Bultos</div>'
      + '<div class="qtybar"><button id="pk-bm">−</button><input id="pk-bultos" type="number" inputmode="numeric" min="1" value="' + PK.bultos + '"><button id="pk-bp">+</button></div>'
      + '<div class="sec" style="margin-top:6px">Embalaje usado (opcional)</div><div class="card" style="padding:4px 14px">' + mats + '</div>'
      + '<button class="btn ' + (ok ? 'good' : (PK.armado ? 'warn' : 'good')) + '" id="pk-go">' + (PK.armado && !ok ? 'Confirmar: ' + btnTxt.toLowerCase() : btnTxt) + '</button>'
      + (PK.armado && !ok ? '<div class="banner" style="margin:0">' + (cont === 0 ? 'No escaneaste ningún producto: la orden se empaca sin verificación.' : 'Lo contado no calza con lo pedido. Se empaca igual y la diferencia queda registrada en la orden (cuenta en la precisión de preparación).') + '</div>' : '')
      + '<button class="btn alt" id="pk-other">Elegir otra orden</button>';
    $('pk-bultos').addEventListener('input', function () { PK.bultos = Math.max(1, parseInt(this.value, 10) || 1); });
    $('pk-bm').addEventListener('click', function () { PK.bultos = Math.max(1, PK.bultos - 1); $('pk-bultos').value = PK.bultos; });
    $('pk-bp').addEventListener('click', function () { PK.bultos += 1; $('pk-bultos').value = PK.bultos; });
    $('pk-go').addEventListener('click', confirmPack);
    $('pk-other').addEventListener('click', function () { if (PK.task) { PK.task = null; } openPackStation(null); });
  }
  $('pk-order').addEventListener('click', function (e) {
    var b = e.target.closest('[data-pkp],[data-pkm],[data-mtp],[data-mtm]'); if (!b) return;
    if (b.hasAttribute('data-pkp')) { var n = +b.getAttribute('data-pkp'); PK.counts[n] = (PK.counts[n] || 0) + 1; }
    else if (b.hasAttribute('data-pkm')) { var m = +b.getAttribute('data-pkm'); PK.counts[m] = Math.max(0, (PK.counts[m] || 0) - 1); }
    else if (b.hasAttribute('data-mtp')) { var s = b.getAttribute('data-mtp'); PK.mats[s] = (PK.mats[s] || 0) + 1; }
    else { var s2 = b.getAttribute('data-mtm'); PK.mats[s2] = Math.max(0, (PK.mats[s2] || 0) - 1); }
    PK.armado = false; renderPackOrder();
  });
  /** Un código en el paso de verificación: embalaje (local) o producto (vía API del cliente). */
  function packScan(code) {
    var o = PK.order; if (!o) return;
    var mat = PK.materials.filter(function (m) { return m.barcode && String(m.barcode) === code; })[0];
    if (mat) { PK.mats[mat.sku] = (PK.mats[mat.sku] || 0) + 1; bip(true); toast(mat.name + ' +1', true); PK.armado = false; renderPackOrder(); return; }
    var key = o.sellerId + '|' + code;
    var p = PK.codeCache[key] ? Promise.resolve(PK.codeCache[key])
      : api('/sellers/' + encodeURIComponent(o.sellerId) + '/barcodes/' + encodeURIComponent(code)).then(function (r) { PK.codeCache[key] = r; return r; });
    p.then(function (r) {
      var sku = r && r.sku, f = (r && r.factor) || 1;
      var ls = (o.lines || []).filter(function (l) { return l.sku === sku; });
      if (!ls.length) { bip(false); toast('El producto ' + (sku || code) + ' NO es de esta orden', false); return; }
      var l = ls.filter(function (x) { return (PK.counts[x.lineNo] || 0) < x.qty; })[0];
      if (!l) { bip(false); toast('Ya están todas las unidades de ' + sku + '. Revisa si sobra una.', false); return; }
      PK.counts[l.lineNo] = (PK.counts[l.lineNo] || 0) + f;
      bip(true);
      toast(sku + ' +' + f + (f > 1 ? ' (' + (r.label || 'pack') + ')' : ''), true);
      PK.armado = false; renderPackOrder();
    }).catch(function () { bip(false); toast('Código no reconocido: ' + code, false); });
  }
  function confirmPack() {
    var o = PK.order; if (!o) return;
    var cont = pkContado();
    var ok = cont > 0 && (o.lines || []).every(function (l) { return (PK.counts[l.lineNo] || 0) === l.qty; });
    if (!ok && !PK.armado) { PK.armado = true; renderPackOrder(); return; }   // segundo toque confirma
    var materials = Object.keys(PK.mats).filter(function (k) { return PK.mats[k] > 0; }).map(function (k) { return { sku: k, qty: PK.mats[k] }; });
    var body = { bultos: PK.bultos, materials: materials };
    if (cont > 0) body.verify = (o.lines || []).map(function (l) { return { sku: l.sku, lot: l.lot || null, qty: PK.counts[l.lineNo] || 0 }; });
    var btn = $('pk-go'); btn.disabled = true; btn.textContent = 'Empacando…';
    api('/sellers/' + encodeURIComponent(o.sellerId) + '/orders/' + encodeURIComponent(o.id) + '/pack', { method: 'POST', body: body })
      .then(function (r) {
        if (opIdOrNull() && PK.startAt) laborCapture({ operationId: opIdOrNull(), sellerId: o.sellerId, operator: (user && user.id) || cfg.email, type: 'PACK', startAt: PK.startAt, endAt: new Date().toISOString(), units: oUnits(o), orderRef: oRef(o), locationId: null });
        PK.orders = PK.orders.filter(function (x) { return x.id !== o.id; });
        renderPackDone(r || o, ok);
      })
      .catch(function (e) { toast(e.message, false); btn.disabled = false; PK.armado = false; renderPackOrder(); });
  }
  function renderPackDone(r, verificada) {
    var p = r.packing || {};
    var labels = p.labels || [];
    var deTarea = !!PK.task; PK.task = null; PK.order = null;
    $('pk-scan').style.display = 'none';
    $('pk-title').textContent = 'Empacada ✓';
    $('pk-order').innerHTML = '<div class="resbox"><div class="rb-t">✓ ' + esc(oRef(r)) + ' empacada</div>'
      + '<div class="muted">' + (p.bultos || PK.bultos) + ' bulto(s)' + (verificada ? ' · verificada sin diferencias' : '') + '</div>'
      + (p.trackingNumber ? '<div class="kv"><span>Tracking</span><b class="code">' + esc(p.trackingNumber) + '</b></div>' : '')
      + (p.carrier ? '<div class="kv"><span>Courier</span><b>' + esc(p.carrier) + '</b></div>' : '')
      + (labels.length ? '<div class="lbls">' + labels.map(function (l) { return '<img alt="Etiqueta bulto ' + l.bultoNo + '" src="' + esc(l.dataUri) + '">'; }).join('') + '</div>'
        : '<div class="banner" style="margin:0">' + (p.labelStatus === 'ERROR' ? 'El OMS no entregó etiquetas: ' + esc(p.labelError || '') + '. Se pueden reintentar desde el panel.' : 'Las etiquetas llegarán desde el OMS.') + '</div>')
      + '</div>'
      + (labels.length ? '<button class="btn alt" id="pk-print">🖨 Imprimir etiquetas</button>' : '')
      + (deTarea ? '<button class="btn" id="pk-home">Volver a mis tareas</button>' : '<button class="btn" id="pk-next">Siguiente orden (' + PK.orders.length + ')</button><button class="btn alt" id="pk-home">Volver al inicio</button>');
    if ($('pk-print')) $('pk-print').addEventListener('click', function () { printLbls(labels, p.trackingNumber); });
    if ($('pk-next')) $('pk-next').addEventListener('click', function () { openPackStation(null); });
    $('pk-home').addEventListener('click', function () { show('home'); });
    toast('Orden empacada', true);
  }
  function printLbls(labels, trk) {
    var w = window.open('', '_blank');
    if (!w) { toast('Permite ventanas emergentes para imprimir', false); return; }
    w.document.write('<!doctype html><html><head><title>Etiquetas ' + esc(trk || '') + '</title><style>@page{margin:6mm}body{margin:0}img{width:100mm;max-width:100%;display:block;margin:0 auto 8mm;page-break-after:always;border:1px solid #000}</style></head><body onload="window.print()">'
      + labels.map(function (l) { return '<img src="' + l.dataUri + '">'; }).join('') + '</body></html>');
    w.document.close();
  }
  $('pk-scan').addEventListener('submit', function (e) {
    e.preventDefault();
    var el = $('pk-code'), code = (el.value || '').trim(); el.value = '';
    if (!code) return;
    onPackCode(code);
    enfoca('pk-code');
  });
  function onPackCode(code) {
    if (PK.order) { packScan(code); return; }
    var o = matchOrder(PK.orders, code);
    if (o) { bip(true); selectPack(o); return; }
    // ¿Existe pero en otro estado? Decirlo ahorra ir a preguntar al supervisor.
    opOrders().then(function (all) {
      var x = matchOrder(all || [], code);
      bip(false);
      toast(x ? ('La orden ' + oRef(x) + ' está ' + (ST_LBL[x.status] || x.status) + ': solo se empacan órdenes pickeadas') : ('No encontré la orden ' + code), false);
    }).catch(function () { bip(false); toast('No encontré la orden ' + code, false); });
  }
  $('btn-pkcam').addEventListener('click', function () {
    camOpen(function (c) { onPackCode(c); }, { continuous: !!PK.order, hint: PK.order ? 'Escanea los productos' : 'Escanea el N° de orden' });
  });
  $('btn-pkback').addEventListener('click', function () {
    if (PK.order && !PK.task) { PK.order = null; openPackStation(null); return; }
    PK.task = null; PK.order = null; show('home');
  });

  // =====================================================================
  // DESPACHO
  // =====================================================================
  function openShipStation(t) {
    task = null;
    SH.task = t || null; SH.sel = {}; SH.courier = ''; SH.startAt = new Date().toISOString();
    show('ship');
    $('sh-result').style.display = 'none'; $('sh-result').innerHTML = '';
    $('sh-scan').style.display = ''; $('sh-couriers').style.display = '';
    $('sh-list').innerHTML = '<div class="pk-empty">Cargando órdenes…</div>';
    $('sh-carrier').value = '';
    opOrders().then(function (list) {
      SH.orders = (list || []).filter(function (o) { return o.status === 'PACKED'; }).sort(porUrgencia);
      if (SH.task) {
        var o = SH.orders.filter(function (x) { return x.id === SH.task.entityId; })[0];
        if (o) { SH.sel[o.id] = true; SH.courier = oCarrier(o); }
        else toast('La orden de la tarea ya no está empacada', false);
      }
      renderShip();
    }).catch(function (e) { $('sh-list').innerHTML = '<div class="pk-empty">No pude cargar las órdenes: ' + esc(e.message) + '</div>'; });
    enfoca('sh-code');
  }
  function shVisibles() {
    return SH.orders.filter(function (o) { return !SH.courier || (oCarrier(o) || 'Sin courier') === SH.courier; });
  }
  function renderShip() {
    var couriers = {};
    SH.orders.forEach(function (o) { var c = oCarrier(o) || 'Sin courier'; couriers[c] = (couriers[c] || 0) + 1; });
    var names = Object.keys(couriers).sort();
    $('sh-couriers').innerHTML = names.length > 1 || SH.courier
      ? '<button class="chip' + (SH.courier ? '' : ' on') + '" data-shc="">Todos · ' + SH.orders.length + '</button>' + names.map(function (n) { return '<button class="chip' + (SH.courier === n ? ' on' : '') + '" data-shc="' + esc(n) + '">' + esc(n) + ' · ' + couriers[n] + '</button>'; }).join('')
      : '';
    var vis = shVisibles();
    $('sh-sub').textContent = SH.orders.length + ' orden(es) empacada(s) lista(s) para salir';
    var card = function (o) {
      var p = o.packing || {};
      return '<button class="ordc' + (SH.sel[o.id] ? ' sel' : '') + '" data-sho="' + esc(o.id) + '"><span class="ck">' + (SH.sel[o.id] ? '✓' : '') + '</span><div class="oc-main"><div class="oc-ref">' + esc(oRef(o)) + ' ' + dlChipHtml(o) + '</div>'
        + '<div class="oc-meta">' + esc(o.sellerName || o.sellerId) + ' · ' + (p.bultos || 1) + ' bulto(s)' + (oCarrier(o) ? ' · <b>' + esc(oCarrier(o)) + '</b>' : ' · sin courier') + (p.trackingNumber ? ' · ' + esc(p.trackingNumber) : '') + '</div></div></button>';
    };
    // Lo que ya está en la carga va arriba (aunque sea de otro courier que el filtro),
    // para que el operario vea de un vistazo qué sube al camión.
    var enCarga = SH.orders.filter(function (o) { return SH.sel[o.id]; });
    var resto = vis.filter(function (o) { return !SH.sel[o.id]; });
    var html = '';
    if (enCarga.length) html += '<div class="sec" style="margin-bottom:8px">En la carga · ' + enCarga.length + '</div>' + enCarga.map(card).join('') + '<div style="height:14px"></div>';
    html += resto.length
      ? '<div class="sec" style="margin-bottom:8px">' + (enCarga.length ? 'Pendientes' : 'Toca o escanea para sumar a la carga') + ' · ' + resto.length + '</div>' + resto.map(card).join('')
      : (enCarga.length ? '' : '<div class="pk-empty">No hay órdenes empacadas' + (SH.courier ? ' para ' + esc(SH.courier) : '') + ' esperando despacho.</div>');
    $('sh-list').innerHTML = html;
    var n = enCarga.length;
    $('sh-dock').style.display = n ? '' : 'none';
    var bultos = enCarga.reduce(function (a, o) { return a + ((o.packing && o.packing.bultos) || 1); }, 0);
    $('sh-go').textContent = 'Despachar ' + n + (n === 1 ? ' orden' : ' órdenes') + ' · ' + bultos + (bultos === 1 ? ' bulto' : ' bultos');
    // Cada orden sale con SU courier. El campo solo reemplaza (o completa si falta).
    var cs = {}; enCarga.forEach(function (o) { var c = oCarrier(o) || 'Sin courier'; cs[c] = (cs[c] || 0) + 1; });
    var ks = Object.keys(cs);
    $('sh-mix').innerHTML = ks.length > 1
      ? '<div class="banner" style="margin:0">La carga mezcla couriers: ' + ks.map(function (k) { return esc(k) + ' (' + cs[k] + ')'; }).join(' · ') + '. Cada orden se despacha con el suyo, salvo que escribas uno abajo.</div>'
      : (ks.length ? '<div class="muted" style="font-size:13px">Courier de la carga: <b>' + esc(ks[0]) + '</b></div>' : '');
    $('sh-carrier').placeholder = cs['Sin courier'] ? 'Obligatorio: hay órdenes sin courier' : 'Vacío = el de cada orden';
  }
  $('sh-couriers').addEventListener('click', function (e) {
    var b = e.target.closest('[data-shc]'); if (!b) return;
    SH.courier = b.getAttribute('data-shc'); renderShip();
  });
  $('sh-list').addEventListener('click', function (e) {
    var b = e.target.closest('[data-sho]'); if (!b) return;
    var id = b.getAttribute('data-sho'); SH.sel[id] = !SH.sel[id]; renderShip();
  });
  function onShipCode(code) {
    var o = matchOrder(SH.orders, code);
    if (o) {
      if (SH.sel[o.id]) { bip(false); toast(oRef(o) + ' ya está en la carga', false); return; }
      SH.sel[o.id] = true; bip(true); toast(oRef(o) + ' sumada a la carga', true);
      if (SH.courier && (oCarrier(o) || 'Sin courier') !== SH.courier) SH.courier = '';
      renderShip(); return;
    }
    opOrders().then(function (all) {
      var x = matchOrder(all || [], code);
      bip(false);
      toast(x ? ('La orden ' + oRef(x) + ' está ' + (ST_LBL[x.status] || x.status) + ': solo se despachan órdenes empacadas') : ('No encontré la orden ' + code), false);
    }).catch(function () { bip(false); toast('No encontré la orden ' + code, false); });
  }
  $('sh-scan').addEventListener('submit', function (e) {
    e.preventDefault();
    var el = $('sh-code'), code = (el.value || '').trim(); el.value = '';
    if (code) onShipCode(code);
    enfoca('sh-code');
  });
  $('btn-shcam').addEventListener('click', function () { camOpen(onShipCode, { continuous: true, hint: 'Escanea las órdenes de la carga' }); });
  $('sh-go').addEventListener('click', function () {
    if (SH.busy) return;
    var lista = SH.orders.filter(function (o) { return SH.sel[o.id]; });
    if (!lista.length) return;
    var carrier = $('sh-carrier').value.trim();
    var sinCourier = lista.filter(function (o) { return !carrier && !oCarrier(o); });
    if (sinCourier.length) { toast('Indica el courier: ' + sinCourier.map(oRef).join(', ') + ' no tiene', false); enfoca('sh-carrier'); return; }
    SH.busy = true; $('sh-go').disabled = true; $('sh-go').textContent = 'Despachando…';
    var ok = [], fail = [];
    // De a una: así cada orden queda con su propio resultado y un error no tumba al resto.
    lista.reduce(function (pr, o) {
      return pr.then(function () {
        var p = o.packing || {};
        var body = { carrier: carrier || oCarrier(o) };
        if (p.trackingNumber) body.trackingNumber = p.trackingNumber;
        return api('/sellers/' + encodeURIComponent(o.sellerId) + '/orders/' + encodeURIComponent(o.id) + '/ship', { method: 'POST', body: body })
          .then(function () {
            ok.push(o);
            if (opIdOrNull()) laborCapture({ operationId: opIdOrNull(), sellerId: o.sellerId, operator: (user && user.id) || cfg.email, type: 'OTHER', startAt: SH.startAt, endAt: new Date().toISOString(), units: oUnits(o), orderRef: oRef(o), locationId: null });
          })
          .catch(function (e) { fail.push({ o: o, msg: e.message }); });
      });
    }, Promise.resolve()).then(function () {
      SH.busy = false; $('sh-go').disabled = false;
      var deTarea = !!SH.task; SH.task = null;
      SH.orders = SH.orders.filter(function (o) { return ok.indexOf(o) < 0; });
      ok.forEach(function (o) { delete SH.sel[o.id]; });
      bip(!fail.length);
      $('sh-scan').style.display = 'none'; $('sh-couriers').style.display = 'none'; $('sh-list').innerHTML = ''; $('sh-dock').style.display = 'none';
      $('sh-result').style.display = '';
      $('sh-result').innerHTML = '<div class="resbox"><div class="rb-t">' + (fail.length ? '⚠️ ' : '✓ ') + ok.length + ' orden(es) despachada(s)</div>'
        + (ok.length ? '<div class="muted">' + ok.map(function (o) { return esc(oRef(o)); }).join(' · ') + (carrier ? ' — ' + esc(carrier) : '') + '</div>' : '')
        + (fail.length ? '<div class="banner" style="margin:0"><b>No se despacharon:</b><br>' + fail.map(function (f) { return esc(oRef(f.o)) + ': ' + esc(f.msg); }).join('<br>') + '</div>' : '')
        + '</div>'
        + (deTarea ? '<button class="btn" id="sh-home">Volver a mis tareas</button>'
          : '<button class="btn" id="sh-more">Armar otra carga (' + SH.orders.length + ' pendiente(s))</button><button class="btn alt" id="sh-home">Volver al inicio</button>');
      if ($('sh-more')) $('sh-more').addEventListener('click', function () { openShipStation(null); });
      $('sh-home').addEventListener('click', function () { show('home'); });
      if (ok.length) toast(ok.length + ' orden(es) despachada(s)', true);
    });
  });
  $('btn-shback').addEventListener('click', function () { SH.task = null; show('home'); });


  // =====================================================================
  // ESTACIÓN DE PICKING
  // ---------------------------------------------------------------------
  // El operario ve sus pedidos de picking asignados (en el orden en que debe hacerlos)
  // y, si el administrador lo permite, los pedidos libres de la bodega para tomarlos.
  // Al empezar uno se abre el flujo de picking guiado por la lista del pedido.
  // =====================================================================
  var PI = { tab: 'mine', board: null, ord: {}, back: false, busy: false };
  function openPickStation() {
    task = null;
    show('pickst');
    $('pi-list').innerHTML = '<div class="pk-empty">Cargando pedidos…</div>';
    loadPickStation();
    enfoca('pi-code');
  }
  function loadPickStation() {
    var oid = opIdOrNull(); if (!oid || !user) return;
    Promise.all([
      api('/assignments/board?operationId=' + encodeURIComponent(oid) + '&operator=' + encodeURIComponent(user.id) + '&type=PICK'),
      opOrders().catch(function () { return []; }),
    ]).then(function (r) {
      PI.board = r[0] || { mine: [], available: [] };
      PI.ord = {}; (r[1] || []).forEach(function (o) { PI.ord[o.id] = o; });
      // Libres: el deadline manda (lo que vence antes, primero).
      (PI.board.available || []).sort(function (a, b) {
        var oa = PI.ord[a.entityId] || {}, ob = PI.ord[b.entityId] || {};
        var da = oa.dueAt ? Date.parse(oa.dueAt) : Infinity, db = ob.dueAt ? Date.parse(ob.dueAt) : Infinity;
        return da !== db ? da - db : (a.prioridad || 0) - (b.prioridad || 0);
      });
      if (PI.tab === 'mine' && !(PI.board.mine || []).length && (PI.board.available || []).length) PI.tab = 'free';
      renderPickStation();
    }).catch(function (e) { $('pi-list').innerHTML = '<div class="pk-empty">No pude cargar los pedidos: ' + esc(e.message) + '</div>'; });
  }
  function piCard(t, libre) {
    var o = PI.ord[t.entityId] || {};
    var run = t.estado === 'in_progress';
    var lineas = (o.lines || []).length, un = t.unitsEstimate || t.unidades || oUnits(o);
    var btn = libre
      ? '<button class="oc-act" data-pitake="' + esc(t.entityId) + '">Tomar</button>'
      : '<button class="oc-act' + (t._first ? '' : ' alt') + '" data-pistart="' + esc(t.entityId) + '">' + (run ? 'Continuar' : 'Empezar') + '</button>';
    return '<div class="ordc' + (run ? ' run' : '') + '"><div class="oc-main"><div class="oc-ref">' + esc(t.entityRef || oRef(o)) + ' ' + (run ? '<span class="tagrun">En curso</span> ' : '') + dlChipHtml(o) + '</div>'
      + '<div class="oc-meta">' + esc(t.cliente || o.sellerName || '') + (lineas ? ' · ' + lineas + ' línea(s)' : '') + (un ? ' · ' + un + ' un' : '') + (o.status === 'PICKING' && !run ? ' · picking a medias' : '') + '</div>'
      + (!libre && t.priorityReason ? '<div class="oc-meta" style="color:var(--ink-2)">' + esc(t.priorityReason) + '</div>' : '')
      + '</div>' + btn + '</div>';
  }
  function renderPickStation() {
    var b = PI.board || { mine: [], available: [] };
    var mine = b.mine || [], free = b.available || [];
    $('pi-cmine').textContent = mine.length; $('pi-cfree').textContent = b.selfPickup ? free.length : '—';
    Array.prototype.forEach.call(document.querySelectorAll('#pi-tabs [data-pit]'), function (c) { c.classList.toggle('on', c.getAttribute('data-pit') === PI.tab); });
    $('pi-sub').textContent = mine.length + ' asignado(s) a ti' + (b.selfPickup ? ' · ' + free.length + ' libre(s)' : '');
    var html = '';
    if (b.habilitado === false) {
      html = '<div class="pk-empty">Tu usuario no tiene habilitado el <b>picking</b>. Pídele al administrador que lo active en tus habilidades.</div>';
    } else if (PI.tab === 'mine') {
      html = mine.length
        ? '<div class="sec" style="margin-bottom:8px">En el orden en que debes hacerlos</div>' + mine.map(function (t, i) { t._first = i === 0; return piCard(t, false); }).join('')
        : '<div class="pk-empty">No tienes pedidos de picking asignados.' + (b.selfPickup && free.length ? ' Revisa <b>Libres</b> para tomar uno.' : '') + '</div>';
    } else {
      html = !b.selfPickup
        ? '<div class="pk-empty">El administrador no permite tomar pedidos desde la app. Espera a que te asignen, o pídele que active <b>«Tomar tareas»</b> en Asignaciones.</div>'
        : (free.length
          ? '<div class="sec" style="margin-bottom:8px">Más urgentes primero · toca Tomar para agregarlo a tu lista</div>' + free.map(function (t) { return piCard(t, true); }).join('')
          : '<div class="pk-empty">No hay pedidos libres para pickear ahora. 🎉</div>');
    }
    $('pi-list').innerHTML = html;
  }
  $('pi-tabs').addEventListener('click', function (e) {
    var c = e.target.closest('[data-pit]'); if (!c) return;
    PI.tab = c.getAttribute('data-pit'); renderPickStation();
  });
  function piStart(t) {
    PI.back = true;          // al terminar, vuelve a la estación de picking
    startAssigned(t);
  }
  function piTake(entityId, thenStart) {
    if (PI.busy) return;
    var t = ((PI.board && PI.board.available) || []).filter(function (x) { return x.entityId === entityId; })[0];
    if (!t) return;
    PI.busy = true;
    api('/assignments/take', { method: 'POST', body: { operationId: opIdOrNull(), type: 'PICK', entityId: entityId } })
      .then(function (a) {
        PI.busy = false; bip(true);
        toast((t.entityRef || 'Pedido') + ' es tuyo', true);
        var asg = { type: 'PICK', entityId: entityId, entityRef: (a && a.entityRef) || t.entityRef, sellerId: (a && a.sellerId) || t.sellerId, cliente: t.cliente, unitsEstimate: (a && a.unitsEstimate) || t.unidades };
        if (thenStart) { piStart(asg); return; }
        PI.tab = 'mine'; loadPickStation();
      })
      .catch(function (e) { PI.busy = false; bip(false); toast(e.message, false); loadPickStation(); });
  }
  $('pi-list').addEventListener('click', function (e) {
    var s = e.target.closest('[data-pistart]');
    if (s) { var t = ((PI.board && PI.board.mine) || []).filter(function (x) { return x.entityId === s.getAttribute('data-pistart'); })[0]; if (t) piStart(t); return; }
    var k = e.target.closest('[data-pitake]');
    if (k) { k.disabled = true; piTake(k.getAttribute('data-pitake'), false); }
  });
  $('pi-scan').addEventListener('submit', function (e) {
    e.preventDefault();
    var el = $('pi-code'), c = norm(el.value); el.value = '';
    if (!c) return;
    var b = PI.board || {};
    var hit = function (t) { var o = PI.ord[t.entityId] || {}; return norm(t.entityRef) === c || norm(t.entityId) === c || norm(o.externalOrderId) === c; };
    var m = (b.mine || []).filter(hit)[0];
    if (m) { bip(true); piStart(m); return; }
    var f = (b.available || []).filter(hit)[0];
    if (f) {
      if (!b.selfPickup) { bip(false); toast('Ese pedido está libre, pero el administrador no permite tomar pedidos desde la app', false); return; }
      piTake(f.entityId, true); return;   // escanear un pedido libre = tomarlo y empezar
    }
    var x = matchOrder(Object.keys(PI.ord).map(function (k) { return PI.ord[k]; }), c);
    bip(false);
    toast(x ? ('El pedido ' + oRef(x) + ' está ' + (ST_LBL[x.status] || x.status) + (x.status === 'ALLOCATED' || x.status === 'PICKING' ? ' y asignado a otro operario' : '')) : ('No encontré el pedido ' + c), false);
    enfoca('pi-code');
  });
  $('btn-pirefresh').addEventListener('click', function () { loadPickStation(); toast('Actualizado', true); });
  $('btn-piback').addEventListener('click', function () { PI.back = false; show('home'); });
  $('pi-loose').addEventListener('click', function () {
    // El picking suelto saca stock reservado sin ligarlo a un pedido: queda como
    // opción secundaria y pide cliente, como antes.
    PI.back = false;
    if (!cfg.seller) { toast('Para el picking suelto elige primero el cliente en «Operar libre»', false); show('home'); switchTab('free'); var fs = $('free-seller'); if (fs) fs.focus(); return; }
    startOp('pick');
  });



  // ---- Selección MANUAL del producto -----------------------------------------
  // Cuando el código no se puede leer (etiqueta rota, sin EAN, sin pistola) el operario
  // toca el producto en una lista. Se trabaja en UNIDADES base y después elige cuántas
  // (una o varias). En una tarea la lista es la de la propia tarea; en operación libre,
  // el catálogo del cliente con buscador.
  var PACKS = {}, SKU_LIST = {};
  function basePack(sellerId, sku) {
    var k = sellerId + '|' + sku;
    if (PACKS[k]) return Promise.resolve(PACKS[k]);
    return api('/sellers/' + encodeURIComponent(sellerId) + '/skus/' + encodeURIComponent(sku) + '/packs')
      .then(function (ps) { return (ps || []).filter(function (x) { return x.isBase; })[0] || (ps || []).filter(function (x) { return x.factor === 1; })[0] || null; })
      .catch(function () { return null; })
      .then(function (b) {
        var r = { sku: sku, code: (b && b.code) || 'UN', label: (b && b.label) || 'Unidad', factor: 1, isBase: true, barcode: (b && b.barcode) || null };
        PACKS[k] = r; return r;
      });
  }
  function ppItem(it, i) {
    return '<button class="pp' + (it.done ? ' done' : '') + '" data-pp="' + i + '"' + (it.done ? ' disabled' : '') + '><div class="pp-main"><div class="pp-sku">' + esc(it.sku) + '</div>'
      + '<div class="pp-sub">' + esc(it.sub || '') + '</div></div>' + (it.badge ? '<span class="pp-q">' + esc(it.badge) + '</span>' : '') + '</button>';
  }
  var PP_ITEMS = [];
  function renderProductPicker() {
    var box = $('prodpick'); if (!box) return;
    var items = [], titulo = 'O toca el producto sin escanear';
    if (task && task.type === 'PICK') {
      if (!task.picklist) { box.style.display = 'none'; return; }
      items = task.picklist.map(function (l) {
        var loc = LOC_BY_ID[l.locationId], falta = Math.max(0, l.qty - (l.pickedQty || 0));
        return { sku: l.sku, sub: 'Ubicación ' + (loc ? loc.code : l.locationId) + (l.lot ? ' · lote ' + l.lot : '') + ' · ' + (l.pickedQty || 0) + '/' + l.qty, badge: falta ? 'faltan ' + falta : '✓', done: !falta, loc: loc ? loc.code : null, pend: falta };
      });
    } else if (task && task.type === 'RECEIVE') {
      if (!task.receipt) { box.style.display = 'none'; return; }
      items = (task.receipt.lines || []).map(function (l) {
        var falta = Math.max(0, l.expectedQty - (l.receivedQty || 0));
        return { sku: l.sku, sub: 'Recibido ' + (l.receivedQty || 0) + ' de ' + l.expectedQty, badge: falta ? 'faltan ' + falta : '✓', done: !falta, pend: falta };
      });
    } else if (task && (task.type === 'PUTAWAY' || task.type === 'RESLOT' || task.type === 'RESTOCK')) {
      var parts = String(task.entityId).split(':');
      if (parts.length >= 2) items = [{ sku: parts[1], sub: 'Producto de esta tarea' }];
    } else {
      // Operación libre: catálogo del cliente con buscador.
      if (!cfg.seller) { box.style.display = 'none'; return; }
      if (!SKU_LIST[cfg.seller]) {
        box.style.display = ''; box.innerHTML = '<div class="pp-title">O elige el producto sin escanear</div><div class="muted" style="font-size:13px">Cargando productos…</div>';
        api('/sellers/' + encodeURIComponent(cfg.seller) + '/skus').then(function (l) { SKU_LIST[cfg.seller] = (l || []).filter(function (k) { return k.active !== false; }); if (steps[stepIdx] === 'product') renderProductPicker(); }).catch(function () { box.style.display = 'none'; });
        return;
      }
      var q = ($('pp-q') && $('pp-q').value || '').trim().toLowerCase();
      var all = SKU_LIST[cfg.seller];
      var hits = all.filter(function (k) { return !q || String(k.sku).toLowerCase().indexOf(q) >= 0 || String(k.description || '').toLowerCase().indexOf(q) >= 0; });
      items = hits.slice(0, 25).map(function (k) { return { sku: k.sku, sub: k.description || '' }; });
      PP_ITEMS = items;
      var keep = $('pp-q') ? $('pp-q').value : '';
      box.style.display = '';
      box.innerHTML = '<div class="pp-title">O elige el producto sin escanear</div>'
        + '<input id="pp-q" placeholder="Buscar por SKU o nombre (' + all.length + ' productos)" autocomplete="off" value="' + esc(keep) + '">'
        + '<div id="pp-list">' + (items.length ? items.map(ppItem).join('') : '<div class="muted" style="font-size:13px;padding:6px 2px">Sin resultados.</div>')
        + (hits.length > 25 ? '<div class="muted" style="font-size:12px;padding:8px 2px">… ' + (hits.length - 25) + ' más: escribe para filtrar.</div>' : '') + '</div>';
      $('pp-q').addEventListener('input', function () { var pos = this.selectionStart; renderProductPicker(); var el = $('pp-q'); el.focus(); try { el.setSelectionRange(pos, pos); } catch (e) {} });
      return;
    }
    PP_ITEMS = items;
    if (!items.length) { box.style.display = 'none'; return; }
    box.style.display = '';
    box.innerHTML = '<div class="pp-title">' + titulo + '</div>' + items.map(ppItem).join('');
  }
  $('prodpick').addEventListener('click', function (e) {
    var b = e.target.closest('[data-pp]'); if (!b || b.disabled) return;
    var it = PP_ITEMS[parseInt(b.getAttribute('data-pp'), 10)]; if (!it) return;
    manualProduct(it);
  });
  function manualProduct(it) {
    var seller = cfg.seller;
    basePack(seller, it.sku).then(function (pack) {
      // Los flujos libres (y el guardado) registran por código de barras: sin EAN no se puede.
      // Sin EAN registrado se manda «SKU:<código>»: el servidor lo entiende como la unidad base.
      if (navigator.vibrate) navigator.vibrate(40);
      captured.product = pack.barcode || ('SKU:' + it.sku); captured.resolved = pack; captured.manual = true;
      $('r-sku').textContent = pack.sku;
      $('r-level').textContent = 'Elegido a mano · ' + pack.label;
      $('r-factor').textContent = '× 1 (unidad base)';
      $('reso').style.display = '';
      $('prodpick').style.display = 'none';
      // Picking de tarea: la línea ya dice de qué ubicación sale y cuánto falta.
      if (task && task.type === 'PICK' && it.loc && steps[stepIdx + 1] === 'loc') {
        captured.maxBase = it.pend;
        stepIdx += 1;          // queda en el paso de ubicación…
        pickValue('loc', it.loc); // …y lo resuelve con la de la línea
      } else {
        advance();
      }
      // "Una o varias unidades": se propone lo que falta (si se sabe) y se ajusta con − / +.
      if ($('qtywrap').style.display !== 'none' && it.pend > 0) { $('q-count').value = it.pend; updatePreview(); }
    });
  }

  // =====================================================================
  // ESTACIÓN DE RECEPCIÓN
  // ---------------------------------------------------------------------
  // Recepciones abiertas (Creada / En bodega / Parcial) de toda la operación: las que
  // tiene asignadas el operario y, si el administrador lo permite, las libres para
  // tomar. Desde aquí se marca la llegada al andén y se abre el cotejo guiado.
  // =====================================================================
  var RC = { tab: 'mine', board: null, rec: {}, arr: null, busy: false };
  var RST = { PENDING: 'Creada', ARRIVED: 'En bodega', PARTIAL: 'Parcial' };
  function openRecvStation() {
    task = null;
    show('recvst');
    $('rc-list').innerHTML = '<div class="pk-empty">Cargando recepciones…</div>';
    loadRecvStation();
    enfoca('rc-code');
  }
  function loadRecvStation() {
    var oid = opIdOrNull(); if (!oid || !user) return;
    Promise.all([
      api('/assignments/board?operationId=' + encodeURIComponent(oid) + '&operator=' + encodeURIComponent(user.id) + '&type=RECEIVE'),
      api('/operations/' + encodeURIComponent(oid) + '/receipts?open=true').catch(function () { return []; }),
    ]).then(function (r) {
      RC.board = r[0] || { mine: [], available: [] };
      RC.rec = {}; (r[1] || []).forEach(function (x) { RC.rec[x.id] = x; });
      // Libres: primero lo que ya llegó (está ocupando el andén), luego lo parcial, luego lo creado.
      var peso = { ARRIVED: 0, PARTIAL: 1, PENDING: 2 };
      (RC.board.available || []).sort(function (a, b) {
        var ra = RC.rec[a.entityId] || {}, rb = RC.rec[b.entityId] || {};
        var pa = peso[ra.status] != null ? peso[ra.status] : 3, pb = peso[rb.status] != null ? peso[rb.status] : 3;
        return pa !== pb ? pa - pb : Date.parse(ra.createdAt || 0) - Date.parse(rb.createdAt || 0);
      });
      if (RC.tab === 'mine' && !(RC.board.mine || []).length && (RC.board.available || []).length) RC.tab = 'free';
      renderRecvStation();
    }).catch(function (e) { $('rc-list').innerHTML = '<div class="pk-empty">No pude cargar las recepciones: ' + esc(e.message) + '</div>'; });
  }
  function rcCard(t, libre, first) {
    var r = RC.rec[t.entityId] || {};
    var lines = r.lines || [];
    var esp = lines.reduce(function (a, l) { return a + (l.expectedQty || 0); }, 0);
    var rec = lines.reduce(function (a, l) { return a + (l.receivedQty || 0); }, 0);
    var st = r.status || 'PENDING';
    var run = t.estado === 'in_progress';
    var ref = t.entityRef || r.reference || r.id;
    var acts = '';
    if (st === 'PENDING') acts += '<button class="oc-act alt" data-rcarr="' + esc(t.entityId) + '">🚚 Llegó al andén</button>';
    acts += libre
      ? '<button class="oc-act" data-rctake="' + esc(t.entityId) + '">Tomar</button>'
      : '<button class="oc-act' + (first ? '' : ' alt') + '" data-rcstart="' + esc(t.entityId) + '">' + (run || rec > 0 ? 'Continuar' : 'Recibir') + '</button>';
    var arr = RC.arr === t.entityId
      ? '<div class="rc-arr"><input id="rc-nota" placeholder="Nota (opcional): patente, pallets, daños…" autocomplete="off"><div class="rc-acts"><button class="oc-act alt" data-rcarrno="1">Cancelar</button><button class="oc-act" data-rcarrok="' + esc(t.entityId) + '">Confirmar llegada</button></div></div>'
      : '';
    return '<div class="ordc rc' + (run ? ' run' : '') + '"><div class="oc-main"><div class="oc-ref">' + esc(ref) + ' <span class="rst ' + esc(st) + '">' + esc(RST[st] || st) + '</span>' + (run ? ' <span class="tagrun">En curso</span>' : '') + '</div>'
      + '<div class="oc-meta">' + esc(t.cliente || r.sellerName || '') + (r.supplier ? ' · ' + esc(r.supplier) : '') + '</div>'
      + '<div class="oc-meta">' + lines.length + ' línea(s) · ' + rec + ' de ' + esp + ' un recibidas' + (r.reference && r.id !== ref ? ' · ' + esc(r.id) : '') + (st === 'ARRIVED' && r.arrivedAt ? ' · llegó ' + fechaCorta(r.arrivedAt) : '') + '</div>'
      + (esp ? '<div class="bar" style="margin-top:8px"><i style="width:' + Math.min(100, Math.round(rec * 100 / esp)) + '%"></i></div>' : '')
      + '</div><div class="rc-acts">' + acts + '</div>' + arr + '</div>';
  }
  function renderRecvStation() {
    var b = RC.board || { mine: [], available: [] };
    var mine = b.mine || [], free = b.available || [];
    $('rc-cmine').textContent = mine.length; $('rc-cfree').textContent = b.selfPickup ? free.length : '—';
    Array.prototype.forEach.call(document.querySelectorAll('#rc-tabs [data-rct]'), function (c) { c.classList.toggle('on', c.getAttribute('data-rct') === RC.tab); });
    $('rc-sub').textContent = mine.length + ' asignada(s) a ti' + (b.selfPickup ? ' · ' + free.length + ' libre(s)' : '');
    var html;
    if (b.habilitado === false) {
      html = '<div class="pk-empty">Tu usuario no tiene habilitada la <b>recepción</b>. Pídele al administrador que la active en tus habilidades.</div>';
    } else if (RC.tab === 'mine') {
      html = mine.length
        ? '<div class="sec" style="margin-bottom:8px">En el orden en que debes hacerlas</div>' + mine.map(function (t, i) { return rcCard(t, false, i === 0); }).join('')
        : '<div class="pk-empty">No tienes recepciones asignadas.' + (b.selfPickup && free.length ? ' Revisa <b>Libres</b> para tomar una.' : '') + '</div>';
    } else {
      html = !b.selfPickup
        ? '<div class="pk-empty">El administrador no permite tomar recepciones desde la app. Espera a que te asignen, o pídele que active <b>«Tomar tareas»</b> en Asignaciones.</div>'
        : (free.length
          ? '<div class="sec" style="margin-bottom:8px">Primero lo que ya está en el andén</div>' + free.map(function (t) { return rcCard(t, true, false); }).join('')
          : '<div class="pk-empty">No hay recepciones libres ahora. 🎉</div>');
    }
    $('rc-list').innerHTML = html;
    if (RC.arr && $('rc-nota')) enfoca('rc-nota');
  }
  $('rc-tabs').addEventListener('click', function (e) {
    var c = e.target.closest('[data-rct]'); if (!c) return;
    RC.tab = c.getAttribute('data-rct'); RC.arr = null; renderRecvStation();
  });
  function rcStart(t) {
    PI.back = 'recv';        // al terminar o volver, regresa a esta lista
    startAssigned(t);
  }
  function rcFind(list, id) { return (list || []).filter(function (x) { return x.entityId === id; })[0]; }
  function rcTake(entityId, thenStart) {
    if (RC.busy) return;
    var t = rcFind(RC.board && RC.board.available, entityId); if (!t) return;
    RC.busy = true;
    api('/assignments/take', { method: 'POST', body: { operationId: opIdOrNull(), type: 'RECEIVE', entityId: entityId } })
      .then(function (a) {
        RC.busy = false; bip(true);
        toast((t.entityRef || 'Recepción') + ' es tuya', true);
        var asg = { type: 'RECEIVE', entityId: entityId, entityRef: (a && a.entityRef) || t.entityRef, sellerId: (a && a.sellerId) || t.sellerId, cliente: t.cliente, unitsEstimate: (a && a.unitsEstimate) || t.unidades };
        if (thenStart) { rcStart(asg); return; }
        RC.tab = 'mine'; loadRecvStation();
      })
      .catch(function (e) { RC.busy = false; bip(false); toast(e.message, false); loadRecvStation(); });
  }
  function rcArrive(entityId) {
    var r = RC.rec[entityId]; if (!r || RC.busy) return;
    var nota = ($('rc-nota') && $('rc-nota').value || '').trim();
    RC.busy = true;
    api('/sellers/' + encodeURIComponent(r.sellerId) + '/receipts/' + encodeURIComponent(r.id) + '/arrive', { method: 'POST', body: nota ? { nota: nota } : {} })
      .then(function () { RC.busy = false; RC.arr = null; bip(true); toast((r.reference || r.id) + ' marcada En bodega', true); loadRecvStation(); })
      .catch(function (e) { RC.busy = false; bip(false); toast(e.message, false); });
  }
  $('rc-list').addEventListener('click', function (e) {
    var b;
    if ((b = e.target.closest('[data-rcstart]'))) { var t = rcFind(RC.board && RC.board.mine, b.getAttribute('data-rcstart')); if (t) rcStart(t); return; }
    if ((b = e.target.closest('[data-rctake]'))) { b.disabled = true; rcTake(b.getAttribute('data-rctake'), false); return; }
    if ((b = e.target.closest('[data-rcarr]'))) { RC.arr = b.getAttribute('data-rcarr'); renderRecvStation(); return; }
    if ((b = e.target.closest('[data-rcarrno]'))) { RC.arr = null; renderRecvStation(); return; }
    if ((b = e.target.closest('[data-rcarrok]'))) { b.disabled = true; rcArrive(b.getAttribute('data-rcarrok')); return; }
  });
  $('rc-scan').addEventListener('submit', function (e) {
    e.preventDefault();
    var el = $('rc-code'), c = norm(el.value); el.value = '';
    if (!c) return;
    var b = RC.board || {};
    var hit = function (t) { var r = RC.rec[t.entityId] || {}; return norm(t.entityRef) === c || norm(t.entityId) === c || norm(r.reference) === c || norm(r.id) === c; };
    var m = (b.mine || []).filter(hit)[0];
    if (m) { bip(true); rcStart(m); return; }
    var f = (b.available || []).filter(hit)[0];
    if (f) {
      if (!b.selfPickup) { bip(false); toast('Esa recepción está libre, pero el administrador no permite tomarlas desde la app', false); return; }
      rcTake(f.entityId, true); return;   // escanear una recepción libre = tomarla y empezar
    }
    var x = Object.keys(RC.rec).map(function (k) { return RC.rec[k]; }).filter(function (r) { return norm(r.reference) === c || norm(r.id) === c; })[0];
    bip(false);
    toast(x ? ('La recepción ' + (x.reference || x.id) + ' está asignada a otro operario') : ('No encontré una recepción abierta con «' + c + '»'), false);
    enfoca('rc-code');
  });
  $('btn-rcrefresh').addEventListener('click', function () { loadRecvStation(); toast('Actualizado', true); });
  $('btn-rcback').addEventListener('click', function () { PI.back = false; show('home'); });
  $('rc-loose').addEventListener('click', function () {
    // Ingreso sin orden de recepción: no hay esperado ni proveedor. Queda como opción
    // secundaria para urgencias y pide el cliente, como antes.
    PI.back = false;
    if (!cfg.seller) { toast('Para la recepción suelta elige primero el cliente en «Operar libre»', false); show('home'); switchTab('free'); var fs = $('free-seller'); if (fs) fs.focus(); return; }
    startOp('receive');
  });


  // =====================================================================
  // FLUJOS COMPLETOS DE LA APP: Guardado y Conteo por tareas, Conteo cíclico,
  // Devoluciones y Armado de kits. Todo se puede hacer pistoleando (pistola HID o
  // teclado: el campo de código siempre tiene el foco) o tocando en pantalla.
  // =====================================================================
  var SELLERS = [];                       // clientes activos de la operación (los carga loadFreeSellers)
  function sellerNom(id) { var s = SELLERS.filter(function (x) { return x.id === id; })[0]; return (s && s.name) || id; }
  function skuList(sellerId) {
    if (SKU_LIST[sellerId]) return Promise.resolve(SKU_LIST[sellerId]);
    return api('/sellers/' + encodeURIComponent(sellerId) + '/skus').then(function (l) {
      SKU_LIST[sellerId] = (l || []).filter(function (k) { return k.active !== false; }); return SKU_LIST[sellerId];
    });
  }
  /** Código pistoleado → { sku, factor }. Acepta EAN/DUN, o el SKU escrito tal cual. */
  function resolveCode(sellerId, code) {
    return api('/sellers/' + encodeURIComponent(sellerId) + '/barcodes/' + encodeURIComponent(code))
      .then(function (p) { return { sku: p.sku, factor: p.factor || 1, label: p.label }; })
      .catch(function () {
        return skuList(sellerId).then(function (l) {
          var k = l.filter(function (x) { return norm(x.sku) === norm(code) || (x.barcode && String(x.barcode) === String(code)); })[0];
          if (!k) throw new Error('Código no reconocido: ' + code);
          return { sku: k.sku, factor: 1, label: 'Unidad' };
        });
      });
  }
  function skuDef(sellerId, sku) { return ((SKU_LIST[sellerId] || []).filter(function (k) { return k.sku === sku; })[0]) || null; }
  function marcaInicio(t) {
    api('/assignments/start', { method: 'POST', body: { operationId: opIdOrNull(), type: t.type, entityId: t.entityId, clientAt: new Date().toISOString() } }).catch(function () {});
  }
  /** Buscador de catálogo reutilizable: pinta una lista tocable de SKUs del cliente. */
  function catalogPicker(hostId, sellerId, onPick, placeholder) {
    var host = $(hostId); if (!host) return;
    host.innerHTML = '<input class="cp-q" placeholder="' + esc(placeholder || 'Buscar producto por SKU o nombre') + '" autocomplete="off"><div class="cp-list" style="margin-top:8px"></div>';
    var q = host.querySelector('.cp-q'), list = host.querySelector('.cp-list');
    function pinta() {
      skuList(sellerId).then(function (all) {
        var t = norm(q.value);
        // Los kits virtuales no tienen stock propio: no se cuentan ni se mueven.
        var hits = all.filter(function (k) { return k.kitMode !== 'VIRTUAL' && (!t || norm(k.sku).indexOf(t) >= 0 || norm(k.description).indexOf(t) >= 0); }).slice(0, t ? 12 : 6);
        list.innerHTML = hits.length ? hits.map(function (k, i) {
          return '<button type="button" class="pp" data-cp="' + i + '"><div class="pp-main"><div class="pp-sku">' + esc(k.sku) + '</div><div class="pp-sub">' + esc(k.description || '') + '</div></div><span class="pp-q">＋</span></button>';
        }).join('') : '<div class="muted" style="font-size:13px">Sin resultados.</div>';
        list.onclick = function (e) { var b = e.target.closest('[data-cp]'); if (b) onPick(hits[+b.getAttribute('data-cp')]); };
      });
    }
    q.addEventListener('input', pinta); pinta();
  }
  /** Selector de ubicaciones tocable con buscador (para destino, conteo libre, etc.). */
  function locPicker(hostId, filtro, onPick, placeholder) {
    var host = $(hostId); if (!host) return;
    host.innerHTML = '<input class="lp-q" placeholder="' + esc(placeholder || 'Buscar ubicación') + '" autocomplete="off"><div class="locpick" style="margin-top:8px"></div>';
    var q = host.querySelector('.lp-q'), box = host.querySelector('.locpick');
    function pinta() {
      var t = norm(q.value);
      var hits = LOCS.filter(filtro || function () { return true; }).filter(function (l) { return !t || norm(l.code).indexOf(t) >= 0; }).slice(0, 40);
      box.innerHTML = hits.length ? hits.map(function (l) { return '<button type="button" class="chip" data-lp="' + esc(l.id) + '">' + esc(l.code) + '</button>'; }).join('') : '<span class="muted" style="font-size:13px">Sin ubicaciones.</span>';
      box.onclick = function (e) { var b = e.target.closest('[data-lp]'); if (b) onPick(LOC_BY_ID[b.getAttribute('data-lp')]); };
    }
    q.addEventListener('input', pinta); pinta();
  }

  // ---------------------------------------------------------------------
  // ESTACIÓN GENÉRICA POR TAREAS (Guardado y Conteo)
  // ---------------------------------------------------------------------
  var TS_KINDS = {
    putaway: { types: 'PUTAWAY,RESLOT,RESTOCK', title: 'Guardado', mine: 'Asignadas a mí', label: 'Escanea la ubicación de origen o escribe el SKU', loose: 'Guardado suelto (sin tarea)', nada: 'No hay stock esperando guardado.', skill: 'el guardado' },
    count: { types: 'COUNT', title: 'Conteo', mine: 'Asignados a mí', label: 'Escanea la ubicación a contar o escribe el SKU', loose: 'Conteo libre de una ubicación', nada: 'No hay conteos pendientes hoy. 🎉', skill: 'el conteo' },
  };
  var TS_TL = { PUTAWAY: 'Guardado', RESLOT: 'Re-slot', RESTOCK: 'Reposición', COUNT: 'Conteo' };
  var TS = { kind: null, tab: 'mine', board: null, busy: false };
  function openTaskStation(kind) {
    task = null; TS.kind = kind; var K = TS_KINDS[kind];
    show('taskst');
    $('ts-title').textContent = K.title; $('ts-label').textContent = K.label; $('ts-lmine').textContent = K.mine;
    $('ts-code').placeholder = kind === 'count' ? 'Ubicación o SKU' : 'Ubicación o SKU';
    $('ts-loose').textContent = K.loose;
    $('ts-list').innerHTML = '<div class="pk-empty">Cargando…</div>';
    loadTaskStation(); enfoca('ts-code');
  }
  function loadTaskStation() {
    var oid = opIdOrNull(); if (!oid || !user) return;
    api('/assignments/board?operationId=' + encodeURIComponent(oid) + '&operator=' + encodeURIComponent(user.id) + '&type=' + TS_KINDS[TS.kind].types)
      .then(function (b) {
        TS.board = b || { mine: [], available: [] };
        if (TS.tab === 'mine' && !(TS.board.mine || []).length && (TS.board.available || []).length) TS.tab = 'free';
        renderTaskStation();
      }).catch(function (e) { $('ts-list').innerHTML = '<div class="pk-empty">No pude cargar las tareas: ' + esc(e.message) + '</div>'; });
  }
  function tsParts(t) { var p = String(t.entityId).split(':'); return { sid: p[0], ref: p.slice(1).join(':'), sku: p[1], loc: p[2] }; }
  function tsCard(t, libre, first) {
    var p = tsParts(t), run = t.estado === 'in_progress';
    var meta = (t.cliente || sellerNom(t.sellerId || p.sid));
    if (TS.kind === 'count') meta += ' · ' + (LOC_BY_ID[p.ref] ? 'por ubicación' : 'por SKU');
    else meta += (t.unitsEstimate || t.unidades ? ' · ' + (t.unitsEstimate || t.unidades) + ' un' : '');
    var btn = libre ? '<button class="oc-act" data-tstake="' + esc(t.entityId) + '" data-tstype="' + esc(t.type) + '">Tomar</button>'
      : '<button class="oc-act' + (first ? '' : ' alt') + '" data-tsstart="' + esc(t.entityId) + '">' + (run ? 'Continuar' : 'Empezar') + '</button>';
    return '<div class="ordc' + (run ? ' run' : '') + '"><div class="oc-main"><div class="oc-ref"><span class="typechip ' + esc(t.type) + '">' + esc(TS_TL[t.type] || t.type) + '</span> ' + esc(t.entityRef || p.ref) + (run ? ' <span class="tagrun">En curso</span>' : '') + '</div>'
      + '<div class="oc-meta">' + esc(meta) + '</div>' + (!libre && t.priorityReason ? '<div class="oc-meta" style="color:var(--ink-2)">' + esc(t.priorityReason) + '</div>' : '') + '</div>' + btn + '</div>';
  }
  function renderTaskStation() {
    var b = TS.board || { mine: [], available: [] }, K = TS_KINDS[TS.kind];
    var mine = b.mine || [], free = b.available || [];
    $('ts-cmine').textContent = mine.length; $('ts-cfree').textContent = b.selfPickup ? free.length : '—';
    Array.prototype.forEach.call(document.querySelectorAll('#ts-tabs [data-tst]'), function (c) { c.classList.toggle('on', c.getAttribute('data-tst') === TS.tab); });
    $('ts-sub').textContent = mine.length + ' asignada(s) a ti' + (b.selfPickup ? ' · ' + free.length + ' libre(s)' : '');
    var html;
    if (b.habilitado === false) html = '<div class="pk-empty">Tu usuario no tiene habilitado ' + K.skill + '. Pídele al administrador que lo active en tus habilidades.</div>';
    else if (TS.tab === 'mine') html = mine.length ? mine.map(function (t, i) { return tsCard(t, false, i === 0); }).join('') : '<div class="pk-empty">No tienes tareas asignadas.' + (b.selfPickup && free.length ? ' Revisa <b>Libres</b>.' : '') + '</div>';
    else html = !b.selfPickup ? '<div class="pk-empty">El administrador no permite tomar tareas desde la app. Pídele que active <b>«Tomar tareas»</b> en Asignaciones.</div>'
      : (free.length ? free.map(function (t) { return tsCard(t, true, false); }).join('') : '<div class="pk-empty">' + K.nada + '</div>');
    $('ts-list').innerHTML = html;
  }
  function tsStart(t) {
    if (TS.kind === 'count') { openCount(t, null); return; }
    PI.back = 'ts:' + TS.kind; startAssigned(t);
  }
  function tsTake(entityId, type, thenStart) {
    if (TS.busy) return;
    var t = ((TS.board && TS.board.available) || []).filter(function (x) { return x.entityId === entityId && x.type === type; })[0]; if (!t) return;
    TS.busy = true;
    api('/assignments/take', { method: 'POST', body: { operationId: opIdOrNull(), type: type, entityId: entityId } })
      .then(function (a) {
        TS.busy = false; bip(true); toast('Tarea tomada', true);
        var asg = { type: type, entityId: entityId, entityRef: (a && a.entityRef) || t.entityRef, sellerId: (a && a.sellerId) || t.sellerId, cliente: t.cliente, unitsEstimate: (a && a.unitsEstimate) || t.unidades };
        if (thenStart) { tsStart(asg); return; }
        TS.tab = 'mine'; loadTaskStation();
      }).catch(function (e) { TS.busy = false; bip(false); toast(e.message, false); loadTaskStation(); });
  }
  $('ts-tabs').addEventListener('click', function (e) { var c = e.target.closest('[data-tst]'); if (!c) return; TS.tab = c.getAttribute('data-tst'); renderTaskStation(); });
  $('ts-list').addEventListener('click', function (e) {
    var b;
    if ((b = e.target.closest('[data-tsstart]'))) { var t = ((TS.board && TS.board.mine) || []).filter(function (x) { return x.entityId === b.getAttribute('data-tsstart'); })[0]; if (t) tsStart(t); return; }
    if ((b = e.target.closest('[data-tstake]'))) { b.disabled = true; tsTake(b.getAttribute('data-tstake'), b.getAttribute('data-tstype'), false); }
  });
  $('ts-scan').addEventListener('submit', function (e) {
    e.preventDefault();
    var el = $('ts-code'), c = norm(el.value); el.value = ''; if (!c) return;
    var b = TS.board || {};
    var hit = function (t) {
      var p = tsParts(t), lc = TS.kind === 'count' ? LOC_BY_ID[p.ref] : LOC_BY_ID[p.loc];
      return norm(t.entityRef) === c || (lc && norm(lc.code) === c) || norm(TS.kind === 'count' ? p.ref : p.sku) === c;
    };
    var m = (b.mine || []).filter(hit)[0]; if (m) { bip(true); tsStart(m); return; }
    var f = (b.available || []).filter(hit)[0];
    if (f) { if (!b.selfPickup) { bip(false); toast('Esa tarea está libre, pero el administrador no permite tomarlas desde la app', false); return; } tsTake(f.entityId, f.type, true); return; }
    bip(false); toast('No encontré una tarea con «' + c + '»', false); enfoca('ts-code');
  });
  $('btn-tsrefresh').addEventListener('click', function () { loadTaskStation(); toast('Actualizado', true); });
  $('btn-tsback').addEventListener('click', function () { PI.back = false; show('home'); });
  $('ts-loose').addEventListener('click', function () {
    PI.back = false;
    if (TS.kind === 'count') { openCount(null, { free: true }); return; }
    if (!cfg.seller) { toast('Para el guardado suelto elige primero el cliente en «Operar libre»', false); show('home'); switchTab('free'); var fs = $('free-seller'); if (fs) fs.focus(); return; }
    startOp('putaway');
  });

  // ---------------------------------------------------------------------
  // CONTEO CÍCLICO (ciego)
  // ---------------------------------------------------------------------
  // Por UBICACIÓN: el operario va al bin, lo confirma, y registra TODO lo que hay del
  // cliente (lo que no registra cuenta como 0). Por SKU: cuenta ese producto en cada
  // ubicación donde el sistema lo tiene, y puede sumar otras donde lo encuentre.
  // Nunca se muestra la cantidad esperada: así el conteo mide lo real.
  var CT = null;
  function openCount(t, opts) {
    task = null;
    CT = { task: t || null, sid: null, mode: 'LOC', locId: null, sku: null, conf: false, lines: [], rows: [], armed: false, busy: false, done: null, free: !!(opts && opts.free) };
    if (t) {
      var p = tsParts(t); CT.sid = t.sellerId || p.sid;
      if (LOC_BY_ID[p.ref]) { CT.mode = 'LOC'; CT.locId = p.ref; } else { CT.mode = 'SKU'; CT.sku = p.ref; CT.conf = true; }
      marcaInicio(t);
    } else {
      CT.sid = cfg.seller || (SELLERS.length === 1 ? SELLERS[0].id : null);
    }
    show('count');
    skuList(CT.sid || '').catch(function () {});
    if (CT.mode === 'SKU') loadSkuRows(); else renderCount();
  }
  function loadSkuRows() {
    renderCount();
    api('/sellers/' + encodeURIComponent(CT.sid) + '/inventory?sku=' + encodeURIComponent(CT.sku)).then(function (rows) {
      var seen = {};
      (rows || []).forEach(function (b) { if (b.state === 'AVAILABLE' && !seen[b.locationId + '|' + (b.lot || '')]) { seen[b.locationId + '|' + (b.lot || '')] = 1; CT.rows.push({ locationId: b.locationId, lot: b.lot || '', qty: 0, touched: false }); } });
      renderCount();
    }).catch(function () { renderCount(); });
  }
  function ctLotc(sku) { var d = skuDef(CT.sid, sku); return !!(d && d.lotControlled); }
  function renderCount() {
    if (!CT) return;
    var loc = CT.locId ? LOC_BY_ID[CT.locId] : null, body = '', ctx = '';
    $('ct-title').textContent = CT.mode === 'SKU' ? 'Conteo · ' + CT.sku : 'Conteo' + (loc ? ' · ' + loc.code : '');
    $('ct-sub').textContent = CT.sid ? sellerNom(CT.sid) : 'Elige el cliente';
    if (CT.done) { renderCountDone(); return; }
    $('ct-scan').style.display = '';
    // Conteo libre: primero cliente y ubicación.
    if (CT.free && (!CT.sid || !CT.locId)) {
      ctx = '<b>Conteo libre de una ubicación</b>Elige el cliente y la ubicación. Contarás todo lo que haya de ese cliente en ella.';
      $('ct-label').textContent = 'Escanea la ubicación a contar'; $('ct-code').placeholder = 'Código de ubicación';
      body = '<label>Cliente</label><select id="ct-seller">' + (SELLERS.length > 1 ? '<option value="">— Elige el cliente —</option>' : '') + SELLERS.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === CT.sid ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join('') + '</select>'
        + '<div class="sec" style="margin-top:10px">O toca la ubicación</div><div id="ct-locs"></div>';
      $('ct-ctx').innerHTML = ctx; $('ct-body').innerHTML = body;
      $('ct-seller').addEventListener('change', function () { CT.sid = this.value || null; skuList(CT.sid || '').catch(function () {}); renderCount(); });
      locPicker('ct-locs', null, function (l) { if (!CT.sid) { toast('Elige primero el cliente', false); return; } CT.locId = l.id; CT.conf = true; renderCount(); });
      enfoca('ct-code'); return;
    }
    if (CT.mode === 'LOC' && !CT.conf) {
      ctx = '<b>Ve a la ubicación ' + esc(loc ? loc.code : CT.locId) + '</b>Escanéala para confirmar que estás ahí (o toca el botón).';
      $('ct-label').textContent = 'Escanea la ubicación ' + (loc ? loc.code : ''); $('ct-code').placeholder = 'Código de ubicación';
      body = '<button class="btn alt" id="ct-here">Estoy en ' + esc(loc ? loc.code : '') + ' (confirmar sin escanear)</button>';
      $('ct-ctx').innerHTML = ctx; $('ct-body').innerHTML = body;
      $('ct-here').addEventListener('click', function () { CT.conf = true; renderCount(); });
      enfoca('ct-code'); return;
    }
    if (CT.mode === 'LOC') {
      ctx = '<b>Cuenta todo lo de ' + esc(sellerNom(CT.sid)) + ' en ' + esc(loc ? loc.code : '') + '</b>Escanea cada unidad (suma 1, o lo que traiga la caja) o búscala abajo. Lo que no registres queda en 0.';
      $('ct-label').textContent = 'Escanea cada producto'; $('ct-code').placeholder = 'EAN / DUN del producto';
      body = (CT.lines.length ? CT.lines.map(function (l, i) {
        return '<div class="cl"><div class="cl-main"><div class="cl-sku">' + esc(l.sku) + '</div><div class="cl-sub">' + esc((skuDef(CT.sid, l.sku) || {}).description || '') + '</div></div>'
          + '<div class="pl-q"><button class="mini" data-ctm="' + i + '">−</button><b>' + l.qty + '</b><button class="mini" data-ctp="' + i + '">+</button></div><button class="cl-x" data-ctx="' + i + '" title="Quitar">✕</button>'
          + (ctLotc(l.sku) ? '<input class="cl-lot" data-ctlot="' + i + '" placeholder="Lote (obligatorio)" value="' + esc(l.lot || '') + '">' : '') + '</div>';
      }).join('') : '<div class="pk-empty">Aún no registras productos. Si la ubicación está vacía, confirma el conteo así.</div>')
        + '<div class="sec" style="margin-top:12px">Agregar producto a mano</div><div id="ct-cat"></div>';
    } else {
      ctx = '<b>Cuenta ' + esc(CT.sku) + ' en cada ubicación</b>' + esc((skuDef(CT.sid, CT.sku) || {}).description || '') + ' · Indica cuántas unidades hay en cada una. Si lo encuentras en otra ubicación, escanéala para sumarla.';
      $('ct-label').textContent = 'Escanea una ubicación (o el producto para sumar 1)'; $('ct-code').placeholder = 'Ubicación o EAN';
      body = (CT.rows.length ? CT.rows.map(function (r, i) {
        var l = LOC_BY_ID[r.locationId];
        return '<div class="cl"><div class="cl-main"><div class="cl-sku">' + esc(l ? l.code : r.locationId) + (CT.sel === i ? ' <span class="tagrun">Contando</span>' : '') + '</div><div class="cl-sub">' + (r.touched ? 'Contada' : 'Sin contar') + '</div></div>'
          + '<div class="pl-q"><button class="mini" data-csm="' + i + '">−</button><b>' + r.qty + '</b><button class="mini" data-csp="' + i + '">+</button></div>'
          + (ctLotc(CT.sku) ? '<input class="cl-lot" data-cslot="' + i + '" placeholder="Lote (obligatorio)" value="' + esc(r.lot || '') + '">' : '') + '</div>';
      }).join('') : '<div class="pk-empty">El sistema no tiene este producto en ninguna ubicación. Si lo encuentras, escanea o elige la ubicación.</div>')
        + '<div class="sec" style="margin-top:12px">Sumar otra ubicación</div><div id="ct-locs"></div>';
    }
    var hint = CT.mode === 'LOC' ? 'Lo no registrado en esta ubicación se ajustará a 0.' : 'Las ubicaciones en 0 se ajustarán a 0.';
    body += '<button class="btn ' + (CT.armed ? 'warn' : 'good') + '" id="ct-go" style="margin-top:12px">' + (CT.armed ? 'Toca de nuevo para confirmar el conteo' : 'Confirmar conteo') + '</button>'
      + (CT.armed ? '<div class="banner" style="margin:0">' + hint + '</div>' : '');
    $('ct-ctx').innerHTML = ctx; $('ct-body').innerHTML = body;
    if ($('ct-cat')) catalogPicker('ct-cat', CT.sid, function (k) { ctAdd(k.sku, 1); });
    if ($('ct-locs')) locPicker('ct-locs', null, function (l) { ctAddLoc(l); }, 'Buscar ubicación');
    $('ct-go').addEventListener('click', ctConfirm);
    enfoca('ct-code');
  }
  function ctAdd(sku, n) {
    var l = CT.lines.filter(function (x) { return x.sku === sku; })[0];
    if (!l) { l = { sku: sku, lot: '', qty: 0 }; CT.lines.unshift(l); }
    l.qty += n; CT.armed = false; renderCount();
  }
  function ctAddLoc(l) {
    var i = -1; CT.rows.forEach(function (r, k) { if (r.locationId === l.id && i < 0) i = k; });
    if (i < 0) { CT.rows.push({ locationId: l.id, lot: '', qty: 0, touched: true }); i = CT.rows.length - 1; }
    CT.sel = i; CT.armed = false; renderCount();
  }
  $('ct-body').addEventListener('click', function (e) {
    var b = e.target.closest('[data-ctp],[data-ctm],[data-ctx],[data-csp],[data-csm]'); if (!b) return;
    var i;
    if (b.hasAttribute('data-ctp')) CT.lines[+b.getAttribute('data-ctp')].qty += 1;
    else if (b.hasAttribute('data-ctm')) { i = +b.getAttribute('data-ctm'); CT.lines[i].qty = Math.max(0, CT.lines[i].qty - 1); }
    else if (b.hasAttribute('data-ctx')) CT.lines.splice(+b.getAttribute('data-ctx'), 1);
    else if (b.hasAttribute('data-csp')) { i = +b.getAttribute('data-csp'); CT.rows[i].qty += 1; CT.rows[i].touched = true; CT.sel = i; }
    else { i = +b.getAttribute('data-csm'); CT.rows[i].qty = Math.max(0, CT.rows[i].qty - 1); CT.rows[i].touched = true; CT.sel = i; }
    CT.armed = false; renderCount();
  });
  $('ct-body').addEventListener('input', function (e) {
    var el = e.target;
    if (el.hasAttribute('data-ctlot')) CT.lines[+el.getAttribute('data-ctlot')].lot = el.value;
    if (el.hasAttribute('data-cslot')) CT.rows[+el.getAttribute('data-cslot')].lot = el.value;
  });
  $('ct-scan').addEventListener('submit', function (e) {
    e.preventDefault();
    var el = $('ct-code'), code = (el.value || '').trim(); el.value = ''; if (!code || !CT) return;
    var loc = findLocByCode(code);
    if (CT.free && (!CT.sid || !CT.locId)) {
      if (!CT.sid) { bip(false); toast('Elige primero el cliente', false); return; }
      if (!loc) { bip(false); toast('Ese código no es una ubicación', false); return; }
      bip(true); CT.locId = loc.id; CT.conf = true; renderCount(); return;
    }
    if (CT.mode === 'LOC' && !CT.conf) {
      if (loc && loc.id === CT.locId) { bip(true); CT.conf = true; renderCount(); }
      else { bip(false); toast(loc ? 'Esa es ' + loc.code + ', no la ubicación a contar' : 'Escanea la ubicación ' + ((LOC_BY_ID[CT.locId] || {}).code || ''), false); }
      return;
    }
    if (CT.mode === 'SKU' && loc) { bip(true); ctAddLoc(loc); return; }
    resolveCode(CT.sid, code).then(function (r) {
      if (CT.mode === 'SKU') {
        if (r.sku !== CT.sku) { bip(false); toast('Ese es ' + r.sku + ', este conteo es de ' + CT.sku, false); return; }
        if (CT.sel == null || !CT.rows[CT.sel]) { bip(false); toast('Primero escanea o toca la ubicación donde estás contando', false); return; }
        CT.rows[CT.sel].qty += r.factor; CT.rows[CT.sel].touched = true; bip(true); CT.armed = false; renderCount(); return;
      }
      bip(true); ctAdd(r.sku, r.factor);
    }).catch(function (err) { bip(false); toast(err.message, false); });
  });
  function ctConfirm() {
    if (!CT || CT.busy) return;
    var falta = CT.mode === 'LOC' ? CT.lines.filter(function (l) { return l.qty > 0 && ctLotc(l.sku) && !String(l.lot || '').trim(); })[0]
      : CT.rows.filter(function (r) { return r.qty > 0 && ctLotc(CT.sku) && !String(r.lot || '').trim(); })[0];
    if (falta) { toast('Falta el lote de ' + (falta.sku || CT.sku) + ': ese producto se controla por lote', false); return; }
    if (CT.mode === 'SKU' && !CT.rows.length) { toast('Agrega al menos una ubicación', false); return; }
    if (!CT.armed) { CT.armed = true; renderCount(); return; }
    CT.busy = true; $('ct-go').disabled = true; $('ct-go').textContent = 'Registrando…';
    var base = '/sellers/' + encodeURIComponent(CT.sid) + '/cycle-counts';
    var call = CT.mode === 'LOC'
      ? api(base, { method: 'POST', body: { locationId: CT.locId, counted: CT.lines.filter(function (l) { return l.qty >= 0; }).map(function (l) { return { sku: l.sku, lot: String(l.lot || '').trim() || null, countedQty: l.qty }; }) } }).then(function (r) { return [r]; })
      : api(base + '/sku', { method: 'POST', body: { sku: CT.sku, counted: CT.rows.map(function (r) { return { locationId: r.locationId, lot: String(r.lot || '').trim() || null, countedQty: r.qty }; }) } }).then(function (r) { return (r && r.resultados) || []; });
    call.then(function (res) { CT.busy = false; CT.done = res; bip(true); renderCount(); })
      .catch(function (e) { CT.busy = false; CT.armed = false; bip(false); toast(e.message, false); renderCount(); });
  }
  function renderCountDone() {
    $('ct-scan').style.display = 'none';
    var vars = []; CT.done.forEach(function (r) { (r.variances || []).forEach(function (v) { vars.push(v); }); });
    $('ct-ctx').innerHTML = '';
    $('ct-body').innerHTML = '<div class="resbox"><div class="rb-t">' + (vars.length ? '⚠️ Conteo registrado con diferencias' : '✓ Conteo registrado: todo calza') + '</div>'
      + (vars.length ? vars.map(function (v) { var l = LOC_BY_ID[v.locationId]; return '<div class="kv"><span>' + esc(v.sku) + (v.lot ? ' · ' + esc(v.lot) : '') + ' @ ' + esc(l ? l.code : v.locationId) + '</span><b style="color:' + (v.delta < 0 ? 'var(--crit)' : 'var(--good)') + '">' + (v.delta > 0 ? '+' : '') + v.delta + '</b></div>'; }).join('')
        + '<div class="muted" style="font-size:12.5px">El inventario quedó ajustado a lo contado y las diferencias quedan en el kardex.</div>' : '')
      + '</div><button class="btn" id="ct-next">' + (CT.task ? 'Volver a los conteos' : 'Contar otra ubicación') + '</button><button class="btn alt" id="ct-home">Volver al inicio</button>';
    $('ct-next').addEventListener('click', function () { if (CT.task) openTaskStation('count'); else openCount(null, { free: true }); });
    $('ct-home').addEventListener('click', function () { show('home'); });
  }
  $('btn-ctback').addEventListener('click', function () { if (CT && CT.task) openTaskStation('count'); else openTaskStation('count'); });

  // ---------------------------------------------------------------------
  // DEVOLUCIONES
  // ---------------------------------------------------------------------
  var RT = { list: [], ret: null, inc: {}, busy: false, q: '' };
  var RT_ST = { PENDING: 'Abierta', PARTIAL: 'En proceso', COMPLETED: 'Cerrada', CANCELLED: 'Anulada' };
  function openReturns() {
    task = null; RT.ret = null; RT.inc = {};
    show('ret');
    $('rt-scan').style.display = '';
    $('rt-label').textContent = 'Escanea o escribe el N° de la orden que vuelve';
    $('rt-code').placeholder = 'N° de orden o tracking';
    $('rt-title').textContent = 'Devoluciones';
    $('rt-body').innerHTML = '<div class="pk-empty">Cargando…</div>';
    loadReturns(); enfoca('rt-code');
  }
  function loadReturns() {
    var ids = SELLERS.map(function (s) { return s.id; });
    Promise.all(ids.map(function (sid) { return api('/sellers/' + encodeURIComponent(sid) + '/returns').catch(function () { return []; }); }))
      .then(function (rs) {
        RT.list = [];
        rs.forEach(function (l) { (l || []).forEach(function (r) { if (r.status === 'PENDING' || r.status === 'PARTIAL') RT.list.push(r); }); });
        RT.list.sort(function (a, b) { return Date.parse(b.createdAt) - Date.parse(a.createdAt); });
        renderReturnsList();
      });
  }
  function rtTot(r) { return (r.lines || []).reduce(function (a, l) { return a + l.toStock + l.toMerma + l.toQuarantine; }, 0); }
  function renderReturnsList() {
    $('rt-sub').textContent = RT.list.length + ' devolución(es) abierta(s)';
    var html = RT.list.length ? '<div class="sec" style="margin-bottom:8px">Abiertas · toca para continuar</div>' + RT.list.map(function (r) {
      var esp = (r.lines || []).reduce(function (a, l) { return a + (l.expectedQty || 0); }, 0);
      return '<button class="ordc" data-rto="' + esc(r.id) + '" data-rts="' + esc(r.sellerId) + '"><div class="oc-main"><div class="oc-ref">' + esc(r.originalOrderRef || r.id) + ' <span class="rst ' + (r.status === 'PARTIAL' ? 'PARTIAL' : '') + '">' + esc(RT_ST[r.status] || r.status) + '</span></div>'
        + '<div class="oc-meta">' + esc(sellerNom(r.sellerId)) + ' · ' + rtTot(r) + ' de ' + esp + ' un dispuestas' + (r.reason ? ' · ' + esc(r.reason) : '') + '</div></div><span class="oc-go">Abrir ›</span></button>';
    }).join('') : '<div class="pk-empty">No hay devoluciones abiertas. Escanea la orden que vuelve para registrar una.</div>';
    html += '<div class="sec" style="margin-top:14px">Nueva devolución · busca la orden despachada</div><input id="rt-find" placeholder="N° de orden, cliente o destinatario" autocomplete="off" value="' + esc(RT.q) + '"><div id="rt-found" style="margin-top:8px"></div>';
    $('rt-body').innerHTML = html;
    $('rt-find').addEventListener('input', function () { RT.q = this.value; rtFind(); });
    rtFind();
  }
  var RT_SHIPPED = null;
  function rtFind() {
    var box = $('rt-found'); if (!box) return;
    var q = norm(RT.q);
    if (!q) { box.innerHTML = '<div class="muted" style="font-size:13px">Escribe para buscar entre las órdenes despachadas.</div>'; return; }
    (RT_SHIPPED ? Promise.resolve(RT_SHIPPED) : opOrders().then(function (l) { RT_SHIPPED = (l || []).filter(function (o) { return o.status === 'SHIPPED'; }); return RT_SHIPPED; }))
      .then(function (list) {
        var hits = list.filter(function (o) { var st = o.shipTo || {}; return norm(o.externalOrderId).indexOf(q) >= 0 || norm(o.sellerName).indexOf(q) >= 0 || norm(st.name).indexOf(q) >= 0; }).slice(0, 10);
        box.innerHTML = hits.length ? hits.map(function (o) { return '<button class="pp" data-rtnew="' + esc(o.id) + '"><div class="pp-main"><div class="pp-sku">' + esc(oRef(o)) + '</div><div class="pp-sub">' + esc(o.sellerName || '') + ' · ' + oUnits(o) + ' un' + ((o.shipTo || {}).name ? ' · ' + esc(o.shipTo.name) : '') + '</div></div><span class="pp-q">Recibir</span></button>'; }).join('') : '<div class="muted" style="font-size:13px">Sin órdenes despachadas que coincidan.</div>';
      });
  }
  function rtCreate(o) {
    if (RT.busy) return;
    var ya = RT.list.filter(function (r) { return r.sellerId === o.sellerId && (r.originalOrderId === o.id || norm(r.originalOrderRef) === norm(o.externalOrderId)); })[0];
    if (ya) { rtOpen(ya); return; }
    RT.busy = true;
    api('/sellers/' + encodeURIComponent(o.sellerId) + '/returns', { method: 'POST', body: { originalOrderRef: o.externalOrderId || o.id } })
      .then(function (r) { RT.busy = false; bip(true); toast('Devolución creada para ' + oRef(o), true); RT.list.unshift(r); rtOpen(r); })
      .catch(function (e) { RT.busy = false; bip(false); toast(e.message, false); });
  }
  function rtOpen(r) { RT.ret = r; RT.inc = {}; RT.armed = false; skuList(r.sellerId).catch(function () {}); renderReturn(); }
  function renderReturn() {
    var r = RT.ret; if (!r) return;
    $('rt-title').textContent = 'Devolución ' + (r.originalOrderRef || r.id);
    $('rt-sub').textContent = sellerNom(r.sellerId) + ' · ' + (RT_ST[r.status] || r.status);
    $('rt-label').textContent = 'Escanea cada producto que vuelve (suma a Stock)';
    $('rt-code').placeholder = 'EAN / DUN del producto';
    var nuevos = Object.keys(RT.inc).reduce(function (a, k) { var x = RT.inc[k]; return a + x.s + x.m + x.q; }, 0);
    var html = (r.lines || []).map(function (l) {
      var x = RT.inc[l.sku] || { s: 0, m: 0, q: 0 };
      var dc = function (k, lbl) { return '<div class="dcol"><div class="dl">' + lbl + '</div><div class="dq"><button class="mini" data-rtm="' + esc(l.sku) + '|' + k + '">−</button><b>' + x[k] + '</b><button class="mini" data-rtp="' + esc(l.sku) + '|' + k + '">+</button></div></div>'; };
      return '<div class="cl"><div class="cl-main"><div class="cl-sku">' + esc(l.sku) + '</div><div class="cl-sub">Salió ' + l.expectedQty + ' · ya dispuesto: stock ' + l.toStock + ' · merma ' + l.toMerma + ' · cuarentena ' + l.toQuarantine + '</div></div>'
        + '<div class="disp">' + dc('s', 'Stock') + dc('m', 'Merma') + dc('q', 'Cuarentena') + '</div></div>';
    }).join('');
    html += '<div class="muted" style="font-size:12.5px;margin-top:6px">Stock: vuelve a la venta. Merma: dañado. Cuarentena: en revisión.</div>';
    var yaProc = rtTot(r) > 0;
    html += '<button class="btn alt" id="rt-save"' + (nuevos ? '' : ' disabled') + ' style="margin-top:10px">Ingresar ' + nuevos + ' un y seguir después</button>'
      + '<button class="btn ' + (RT.armed ? 'warn' : 'good') + '" id="rt-close"' + (nuevos || yaProc ? '' : ' disabled') + '>' + (RT.armed ? 'Toca de nuevo para cerrar la devolución' : (nuevos ? 'Ingresar ' + nuevos + ' un y cerrar' : 'Cerrar devolución')) + '</button>'
      + '<button class="btn alt" id="rt-back2">Volver a la lista</button>';
    $('rt-body').innerHTML = html;
    $('rt-save').addEventListener('click', function () { rtProcess(false); });
    $('rt-close').addEventListener('click', function () { if (!RT.armed) { RT.armed = true; renderReturn(); return; } rtProcess(true); });
    $('rt-back2').addEventListener('click', openReturns);
    enfoca('rt-code');
  }
  function rtBump(sku, k, d) {
    var x = RT.inc[sku] || (RT.inc[sku] = { s: 0, m: 0, q: 0 });
    x[k] = Math.max(0, x[k] + d); RT.armed = false; renderReturn();
  }
  $('rt-body').addEventListener('click', function (e) {
    var b = e.target.closest('[data-rtp],[data-rtm],[data-rto],[data-rtnew]'); if (!b) return;
    if (b.hasAttribute('data-rto')) { var r = RT.list.filter(function (x) { return x.id === b.getAttribute('data-rto') && x.sellerId === b.getAttribute('data-rts'); })[0]; if (r) rtOpen(r); return; }
    if (b.hasAttribute('data-rtnew')) { var o = (RT_SHIPPED || []).filter(function (x) { return x.id === b.getAttribute('data-rtnew'); })[0]; if (o) rtCreate(o); return; }
    var v = (b.getAttribute('data-rtp') || b.getAttribute('data-rtm')).split('|');
    rtBump(v[0], v[1], b.hasAttribute('data-rtp') ? 1 : -1);
  });
  function rtProcess(close) {
    var r = RT.ret; if (!r || RT.busy) return;
    var lines = Object.keys(RT.inc).map(function (sku) { var x = RT.inc[sku]; return { sku: sku, toStock: x.s, toMerma: x.m, toQuarantine: x.q }; }).filter(function (l) { return l.toStock + l.toMerma + l.toQuarantine > 0; });
    RT.busy = true;
    api('/sellers/' + encodeURIComponent(r.sellerId) + '/returns/' + encodeURIComponent(r.id) + '/process', { method: 'POST', body: { lines: lines, close: !!close } })
      .then(function (nr) {
        RT.busy = false; bip(true);
        toast(close ? 'Devolución cerrada' : 'Unidades ingresadas', true);
        if (close) { openReturns(); return; }
        RT.list = RT.list.map(function (x) { return x.id === nr.id ? nr : x; });
        rtOpen(nr);
      }).catch(function (e) { RT.busy = false; RT.armed = false; bip(false); toast(e.message, false); renderReturn(); });
  }
  $('rt-scan').addEventListener('submit', function (e) {
    e.preventDefault();
    var el = $('rt-code'), code = (el.value || '').trim(); el.value = ''; if (!code) return;
    if (RT.ret) {
      // Dentro de una devolución: el código es un producto que vuelve → suma a Stock.
      resolveCode(RT.ret.sellerId, code).then(function (x) {
        var en = (RT.ret.lines || []).some(function (l) { return l.sku === x.sku; });
        if (!en) { bip(false); toast(x.sku + ' no salió en esta orden', false); return; }
        bip(true); rtBump(x.sku, 's', x.factor);
      }).catch(function (err) { bip(false); toast(err.message, false); });
      return;
    }
    var c = norm(code);
    var abierta = RT.list.filter(function (r) { return norm(r.originalOrderRef) === c || norm(r.id) === c; })[0];
    if (abierta) { bip(true); rtOpen(abierta); return; }
    opOrders().then(function (all) {
      var o = matchOrder(all || [], code);
      if (!o) { bip(false); toast('No encontré la orden ' + code, false); return; }
      if (o.status !== 'SHIPPED') { bip(false); toast('La orden ' + oRef(o) + ' está ' + (ST_LBL[o.status] || o.status) + ': solo se reciben devoluciones de órdenes despachadas', false); return; }
      RT_SHIPPED = RT_SHIPPED || []; if (RT_SHIPPED.indexOf(o) < 0) RT_SHIPPED.push(o);
      rtCreate(o);
    }).catch(function (err) { bip(false); toast(err.message, false); });
  });
  $('btn-rtrefresh').addEventListener('click', function () { RT_SHIPPED = null; openReturns(); });
  $('btn-rtback').addEventListener('click', function () { if (RT.ret) { openReturns(); return; } show('home'); });

  // ---------------------------------------------------------------------
  // ARMADO DE KITS
  // ---------------------------------------------------------------------
  var KT = { kits: [], kit: null, qty: 1, pref: {}, dest: null, stock: {}, busy: false, armed: false };
  function openKits() {
    task = null; KT.kit = null;
    show('kit');
    $('kt-scan').style.display = ''; $('kt-label').textContent = 'Escanea el kit o tócalo en la lista'; $('kt-code').placeholder = 'EAN o SKU del kit';
    $('kt-title').textContent = 'Armado de kits';
    $('kt-body').innerHTML = '<div class="pk-empty">Cargando kits…</div>';
    Promise.all(SELLERS.map(function (s) { return skuList(s.id).then(function (l) { return l.filter(function (k) { return k.isKit && k.kitMode === 'ASSEMBLED' && (k.components || []).length; }).map(function (k) { return { sellerId: s.id, k: k }; }); }).catch(function () { return []; }); }))
      .then(function (rs) { KT.kits = [].concat.apply([], rs); renderKitList(); });
    enfoca('kt-code');
  }
  function renderKitList() {
    $('kt-sub').textContent = KT.kits.length + ' kit(s) armables';
    $('kt-body').innerHTML = KT.kits.length ? KT.kits.map(function (x, i) {
      return '<button class="ordc" data-kti="' + i + '"><div class="oc-main"><div class="oc-ref">' + esc(x.k.sku) + '</div><div class="oc-meta">' + esc(sellerNom(x.sellerId)) + ' · ' + esc(x.k.description || '') + '</div>'
        + '<div class="oc-meta">' + x.k.components.map(function (c) { return c.qty + '× ' + esc(c.sku); }).join(' + ') + '</div></div><span class="oc-go">Armar ›</span></button>';
    }).join('') : '<div class="pk-empty">No hay kits armables (con stock propio) configurados.</div>';
  }
  function ktSelect(x) {
    KT.kit = x; KT.qty = 1; KT.pref = {}; KT.dest = null; KT.stock = {}; KT.armed = false;
    $('kt-title').textContent = 'Armar ' + x.k.sku; $('kt-sub').textContent = sellerNom(x.sellerId);
    $('kt-label').textContent = 'Escanea la ubicación de destino del kit'; $('kt-code').placeholder = 'Código de ubicación';
    $('kt-body').innerHTML = '<div class="pk-empty">Buscando componentes…</div>';
    Promise.all(x.k.components.map(function (c) {
      return api('/sellers/' + encodeURIComponent(x.sellerId) + '/inventory?sku=' + encodeURIComponent(c.sku)).then(function (rows) {
        KT.stock[c.sku] = (rows || []).filter(function (b) { return b.state === 'AVAILABLE' && b.qty > 0; }).map(function (b) { return { locationId: b.locationId, lot: b.lot || null, qty: b.qty }; }).sort(function (a, b) { return b.qty - a.qty; });
      }).catch(function () { KT.stock[c.sku] = []; });
    })).then(renderKit);
  }
  /** Reparte lo que necesita cada componente entre sus ubicaciones (la preferida primero). */
  function ktPlan() {
    var plan = {}, falta = [];
    KT.kit.k.components.forEach(function (c) {
      var need = c.qty * KT.qty, out = [];
      var bk = (KT.stock[c.sku] || []).slice();
      var p = KT.pref[c.sku]; if (p) bk.sort(function (a, b) { return (a.locationId + '|' + a.lot === p ? -1 : 0) - (b.locationId + '|' + b.lot === p ? -1 : 0); });
      bk.forEach(function (b) { if (need <= 0) return; var t = Math.min(need, b.qty); out.push({ sku: c.sku, locationId: b.locationId, lot: b.lot, qty: t }); need -= t; });
      plan[c.sku] = out; if (need > 0) falta.push(c.sku + ' (faltan ' + need + ')');
    });
    return { plan: plan, falta: falta };
  }
  function renderKit() {
    var x = KT.kit; if (!x) return;
    var pl = ktPlan(), dl = KT.dest ? LOC_BY_ID[KT.dest] : null;
    var html = '<div class="sec">Cantidad de kits</div><div class="qtybar"><button id="kt-m">−</button><input id="kt-q" type="number" inputmode="numeric" min="1" value="' + KT.qty + '"><button id="kt-p">+</button></div>'
      + '<div class="sec" style="margin-top:8px">De dónde sale cada componente · toca para preferir una ubicación</div>'
      + x.k.components.map(function (c) {
        var src = pl.plan[c.sku] || [];
        return '<div class="cl"><div class="cl-main"><div class="cl-sku">' + esc(c.sku) + ' · ' + (c.qty * KT.qty) + ' un</div><div class="cl-sub">' + (src.length ? src.map(function (s) { return esc((LOC_BY_ID[s.locationId] || {}).code || s.locationId) + (s.lot ? ' (lote ' + esc(s.lot) + ')' : '') + ' ×' + s.qty; }).join(' + ') : 'Sin stock disponible') + '</div></div>'
          + '<div class="locpick">' + (KT.stock[c.sku] || []).map(function (b) { var k = b.locationId + '|' + b.lot; return '<button class="chip' + (KT.pref[c.sku] === k ? ' on' : '') + '" data-ktpref="' + esc(c.sku) + '" data-ktk="' + esc(k) + '">' + esc((LOC_BY_ID[b.locationId] || {}).code || b.locationId) + (b.lot ? ' · ' + esc(b.lot) : '') + ' · ' + b.qty + '</button>'; }).join('') + '</div></div>';
      }).join('')
      + (pl.falta.length ? '<div class="banner" style="margin:0">No alcanza: ' + esc(pl.falta.join(', ')) + '</div>' : '')
      + '<div class="sec" style="margin-top:8px">Dónde queda el kit armado</div>'
      + (dl ? '<div class="kv"><span>Destino</span><b class="code">' + esc(dl.code) + '</b></div>' : '') + '<div id="kt-locs"></div>'
      + '<button class="btn ' + (KT.armed ? 'warn' : 'good') + '" id="kt-go"' + (pl.falta.length || !KT.dest ? ' disabled' : '') + ' style="margin-top:10px">' + (KT.armed ? 'Toca de nuevo para armar ' + KT.qty + ' kit(s)' : 'Armar ' + KT.qty + ' kit(s)') + '</button>'
      + '<button class="btn alt" id="kt-other">Elegir otro kit</button>';
    $('kt-body').innerHTML = html;
    $('kt-q').addEventListener('change', function () { KT.qty = Math.max(1, parseInt(this.value, 10) || 1); KT.armed = false; renderKit(); });
    $('kt-m').addEventListener('click', function () { KT.qty = Math.max(1, KT.qty - 1); KT.armed = false; renderKit(); });
    $('kt-p').addEventListener('click', function () { KT.qty += 1; KT.armed = false; renderKit(); });
    locPicker('kt-locs', function (l) { return l.zoneType === 'STORAGE' || l.zoneType === 'PICKING'; }, function (l) { KT.dest = l.id; KT.armed = false; renderKit(); }, 'Buscar ubicación de almacenaje o picking');
    $('kt-go').addEventListener('click', ktConfirm);
    $('kt-other').addEventListener('click', openKits);
    enfoca('kt-code');
  }
  $('kt-body').addEventListener('click', function (e) {
    var b = e.target.closest('[data-kti],[data-ktpref]'); if (!b) return;
    if (b.hasAttribute('data-kti')) { ktSelect(KT.kits[+b.getAttribute('data-kti')]); return; }
    KT.pref[b.getAttribute('data-ktpref')] = b.getAttribute('data-ktk'); KT.armed = false; renderKit();
  });
  function ktConfirm() {
    if (KT.busy || !KT.kit) return;
    if (!KT.armed) { KT.armed = true; renderKit(); return; }
    var pl = ktPlan(), sources = [];
    Object.keys(pl.plan).forEach(function (k) { pl.plan[k].forEach(function (s) { sources.push(s); }); });
    KT.busy = true;
    api('/sellers/' + encodeURIComponent(KT.kit.sellerId) + '/products/' + encodeURIComponent(KT.kit.k.sku) + '/assemble', { method: 'POST', body: { qty: KT.qty, toLocationId: KT.dest, sources: sources } })
      .then(function () {
        KT.busy = false; bip(true);
        var dl = LOC_BY_ID[KT.dest];
        $('kt-scan').style.display = 'none';
        $('kt-body').innerHTML = '<div class="resbox"><div class="rb-t">✓ ' + KT.qty + ' kit(s) ' + esc(KT.kit.k.sku) + ' armado(s)</div><div class="muted">Quedaron en ' + esc(dl ? dl.code : '') + '. Los componentes se descontaron de sus ubicaciones.</div></div>'
          + '<button class="btn" id="kt-again">Armar otro</button><button class="btn alt" id="kt-home">Volver al inicio</button>';
        $('kt-again').addEventListener('click', openKits); $('kt-home').addEventListener('click', function () { show('home'); });
        toast('Kit armado', true);
      }).catch(function (e) { KT.busy = false; KT.armed = false; bip(false); toast(e.message, false); renderKit(); });
  }
  $('kt-scan').addEventListener('submit', function (e) {
    e.preventDefault();
    var el = $('kt-code'), code = (el.value || '').trim(); el.value = ''; if (!code) return;
    if (!KT.kit) {
      var c = norm(code);
      var x = KT.kits.filter(function (y) { return norm(y.k.sku) === c || (y.k.barcode && String(y.k.barcode) === code); })[0];
      if (x) { bip(true); ktSelect(x); return; }
      // ¿EAN de un pack del kit? Se prueba en cada cliente que tiene kits.
      var sids = KT.kits.map(function (y) { return y.sellerId; }).filter(function (v, i, a) { return a.indexOf(v) === i; });
      Promise.all(sids.map(function (sid) { return api('/sellers/' + encodeURIComponent(sid) + '/barcodes/' + encodeURIComponent(code)).then(function (p) { return { sid: sid, sku: p.sku }; }).catch(function () { return null; }); }))
        .then(function (rs) {
          var h = rs.filter(Boolean)[0], y = h && KT.kits.filter(function (k) { return k.sellerId === h.sid && k.k.sku === h.sku; })[0];
          if (y) { bip(true); ktSelect(y); } else { bip(false); toast('Ese código no es de un kit armable', false); }
        });
      return;
    }
    var loc = findLocByCode(code);
    if (!loc) { bip(false); toast('Ese código no es una ubicación', false); return; }
    if (!(loc.zoneType === 'STORAGE' || loc.zoneType === 'PICKING')) { bip(false); toast('El kit debe quedar en una ubicación de almacenaje o picking', false); return; }
    bip(true); KT.dest = loc.id; KT.armed = false; renderKit();
  });
  $('btn-ktback').addEventListener('click', function () { if (KT.kit) { openKits(); return; } show('home'); });


  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ---- Service worker -------------------------------------------------------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('./service-worker.js').catch(function () {}); });
  }

  // Arranque
  laborFlush();   // por si quedaron mediciones del turno anterior en este aparato
  show(cfg.api && cfg.token ? 'login' : 'login');
})();
