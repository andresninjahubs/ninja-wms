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
    ['login', 'home', 'scan', 'quick', 'msgs', 'pack', 'ship'].forEach(function (s) { $(s).classList.toggle('on', s === id); });
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
  $('cfg-api').value = cfg.api || window.location.origin;
  $('cfg-seller').value = cfg.seller || '';
  $('cfg-email').value = cfg.email || '';

  $('btn-login').addEventListener('click', function () {
    cfg.api = $('cfg-api').value.trim();
    cfg.seller = $('cfg-seller').value.trim();
    cfg.email = $('cfg-email').value.trim();
    var pass = $('cfg-pass').value;
    if (!cfg.api || !cfg.email || !pass) { toast('Completa servidor, email y contraseña', false); return; }
    save();
    api('/auth/login', { method: 'POST', body: { email: cfg.email, password: pass } })
      .then(function (r) {
        if (!r.authenticated) { toast('Email o contraseña incorrectos', false); return; }
        cfg.token = r.token; save();   // guarda el JWT firmado
        $('cfg-pass').value = '';
        user = r.user;
        $('h-user').textContent = user.name;
        $('h-seller').textContent = (cfg.seller ? 'Cliente: ' + cfg.seller + ' · ' : '') + 'Operario';
        if (user.operationId) opId = user.operationId;
        loadLocations();
        loadPwaBranding();
        // Un turno pudo terminar sin señal y la app cerrarse con muestras pendientes.
        // Apenas hay sesión válida se vacían: esperar el minuto del intervalo dejaría
        // el tiempo del turno anterior colgando en el aparato más de lo necesario.
        laborFlush();
        show('home');
      })
      .catch(function (e) { toast('No se pudo conectar: ' + e.message, false); });
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
      if (!cfg.seller) { toast('Para operar libre indica el cliente en la pantalla de ingreso', false); return; }
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
    if (t.type === 'COUNT') { toast('Los conteos se registran desde el panel de conteo cíclico (o pide al supervisor que lo cierre).', false); return; }
    startOp('pick');
  }
  function setTaskCtx(html) { var c = $('taskctx'); c.innerHTML = html; c.style.display = html ? '' : 'none'; }
  // Lista de picking de la orden de la tarea (líneas, ubicación y avance).
  function loadTaskPicklist() {
    if (!task || task.type !== 'PICK') return;
    setTaskCtx('<b>' + esc(taskTitle(task)) + ' · ' + esc(task.entityRef || '') + '</b>Cargando lista de picking…');
    api('/sellers/' + encodeURIComponent(task.sellerId) + '/orders/' + encodeURIComponent(task.entityId) + '/picklist')
      .then(function (lines) {
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
    $('btn-finish').textContent = 'Volver a mis tareas';
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
    $('qty-lbl').textContent = 'Cantidad de packs (' + captured.resolved.code + ')';
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
      $('btn-finish').textContent = 'Terminar y volver a mis tareas';
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

  $('btn-back').addEventListener('click', function () { task = null; show('home'); });
  $('btn-again').addEventListener('click', function () {
    var t = task; startOp(op);
    if (t && t.type === 'PICK') loadTaskPicklist();
    else if (t && t.type === 'RECEIVE') { steps = ['product']; stepIdx = 0; enterStep(); loadTaskReceipt(); }
    else if (t && (t.type === 'PUTAWAY' || t.type === 'RESLOT')) startAssigned(t);
  });
  $('btn-closercpt').addEventListener('click', function () {
    if (!task || task.type !== 'RECEIVE') return;
    var b = $('btn-closercpt'); b.disabled = true;
    api('/sellers/' + encodeURIComponent(task.sellerId) + '/receipts/' + encodeURIComponent(task.entityId) + '/close', { method: 'POST', body: {} })
      .then(function () { toast('Recepción cerrada con faltante', true); finishTask('Recepción cerrada: la tarea salió de tu bandeja.'); })
      .catch(function (e) { toast(e.message, false); })
      .then(function () { b.disabled = false; });
  });
  $('btn-finish').addEventListener('click', function () { task = null; show('home'); });

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
      var lg = $('pwa-brand-login'); if (lg) { lg.innerHTML = ''; var e1 = logoHtml(56); if (e1) lg.appendChild(e1); }
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


  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // ---- Service worker -------------------------------------------------------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('./service-worker.js').catch(function () {}); });
  }

  // Arranque
  laborFlush();   // por si quedaron mediciones del turno anterior en este aparato
  show(cfg.api && cfg.token ? 'login' : 'login');
})();
