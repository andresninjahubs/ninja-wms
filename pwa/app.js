/* WMS Operador — PWA. App móvil que usa la cámara como lector y llama a la API del WMS. */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var CFG_KEY = 'wms.operador.cfg';

  var cfg = load();           // { api, seller, token }
  var user = null;            // usuario autenticado
  var opId = null;            // operación del seller (para capturar productividad G4)
  var taskStartAt = null;     // inicio real de la tarea en curso (G4)
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
        var data = t ? JSON.parse(t) : {};
        if (!res.ok) {
          var msg = (data && (data.detail || data.message)) || ('Error ' + res.status);
          if (typeof msg === 'object') msg = JSON.stringify(msg);
          throw new Error(msg);
        }
        return data;
      });
    });
  }

  // ---- Navegación -----------------------------------------------------------
  function show(id) {
    ['login', 'home', 'scan', 'quick'].forEach(function (s) { $(s).classList.toggle('on', s === id); });
    if (id !== 'scan') stopCamera();
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
        show('home');
      })
      .catch(function (e) { toast('No se pudo conectar: ' + e.message, false); });
  });

  $('btn-logout').addEventListener('click', function () { user = null; show('login'); });

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
    b.addEventListener('click', function () { task = null; if (!cfg.seller) { toast('Para operar libre indica el cliente en la pantalla de ingreso', false); return; } startOp(b.getAttribute('data-op')); });
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
  var TL = { PICK: 'Picking', PACK: 'Empaque', SHIP: 'Despacho', PUTAWAY: 'Guardado', COUNT: 'Conteo', RECEIVE: 'Recepción', RESLOT: 'Re-slotting' };
  var TI = { PICK: '🛒', PACK: '📦', SHIP: '🚚', PUTAWAY: '⇄', COUNT: '🔢', RECEIVE: '📥', RESLOT: '↔' };
  function opIdOrNull() { return opId || (user && user.operationId) || null; }
  function loadBoard() {
    var oid = opIdOrNull(); if (!oid || !user) return;
    api('/assignments/board?operationId=' + encodeURIComponent(oid) + '&operator=' + encodeURIComponent(user.id))
      .then(function (b) { board = b; renderBoard(); })
      .catch(function (e) { toast('No pude cargar tus tareas: ' + e.message, false); });
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
    api('/assignments/start', { method: 'POST', body: { operationId: opIdOrNull(), type: t.type, entityId: t.entityId } }).catch(function () {});
    task = t;
    if (t.sellerId) { cfg.seller = t.sellerId; save(); }
    if (t.type === 'PICK') { startOp('pick'); loadTaskPicklist(); return; }
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
    if (t.type === 'PACK' || t.type === 'SHIP') { openQuick(t); return; }
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
    call.then(function () { toast(task.type === 'PACK' ? 'Orden empacada' : 'Orden despachada', true); task = null; show('home'); })
      .catch(function (e) { toast(e.message, false); $('btn-qconfirm').disabled = false; });
  });
  $('btn-qback').addEventListener('click', function () { task = null; show('home'); });
  $('btn-qcancel').addEventListener('click', function () { task = null; show('home'); });

  function startOp(which) {
    op = which; steps = OP_META[op].steps.slice(); stepIdx = 0; captured = {};
    taskStartAt = new Date().toISOString(); // G4: marca de inicio real de la tarea
    $('s-title').textContent = OP_META[op].title;
    $('reso').style.display = 'none';
    $('picklist').style.display = 'none'; $('picklist').innerHTML = '';
    $('bins').style.display = 'none'; $('bins').innerHTML = '';
    $('qtywrap').style.display = 'none';
    $('btn-confirm').style.display = 'none';
    $('result').style.display = 'none';
    $('manual').style.display = 'none';
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
    $('s-step').textContent = s ? STEP_HINT[s] : 'Listo';
    $('cam-hint').textContent = s ? STEP_HINT[s] : '';
    $('picklist').style.display = 'none'; $('picklist').innerHTML = '';
    if (s && s !== 'product') renderPicklist(s);
  }
  function updateStepHint() { enterStep(); }

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
    if (stepIdx < steps.length) { updateStepHint(); return; }
    // Todos los pasos capturados
    updateStepHint();
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
    $('q-count').value = 1; updatePreview();
    $('qtywrap').style.display = ''; $('btn-confirm').style.display = '';
  }

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
    $('btn-confirm').disabled = over || !(n > 0);
  }
  $('q-plus').addEventListener('click', function () { $('q-count').value = (parseInt($('q-count').value, 10) || 0) + 1; updatePreview(); });
  $('q-minus').addEventListener('click', function () { $('q-count').value = Math.max(1, (parseInt($('q-count').value, 10) || 1) - 1); updatePreview(); });
  $('q-count').addEventListener('input', updatePreview);

  // ---- Confirmar operación --------------------------------------------------
  $('btn-confirm').addEventListener('click', function () {
    var packCount = parseInt($('q-count').value, 10);
    if (!(packCount > 0)) { toast('Cantidad inválida', false); return; }
    var seller = encodeURIComponent(cfg.seller), base = '/sellers/' + seller;
    var call;
    if (task && task.type === 'RECEIVE') {
      // Cotejo de una TAREA de recepción: se registra contra la línea de la orden de recepción.
      var rc = task.receipt, sku = captured.resolved ? captured.resolved.sku : null;
      var line = rc && (rc.lines || []).filter(function (l) { return l.sku === sku; })[0];
      if (!line) { toast('El producto ' + (sku || captured.product) + ' no está en esta recepción', false); return; }
      var rq = packCount * (captured.resolved ? captured.resolved.factor : 1);
      call = api(base + '/receipts/' + encodeURIComponent(task.entityId) + '/receive', { method: 'POST', body: { counts: [{ lineNo: line.lineNo, qty: rq }] } })
        .then(function (o) { return { scan: { baseQty: rq, code: captured.resolved.code, sku: sku }, receipt: o }; });
    } else if (op === 'receive') {
      call = api(base + '/scan/inbound', { method: 'POST', body: { barcode: captured.product, packCount: packCount, locationCode: captured.bin } });
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
      // G4: captura de productividad con inicio/fin reales (best-effort, no bloquea).
      var LABOR_TYPE = { pick: 'PICK', putaway: 'PUTAWAY', receive: 'RECEIVE' };
      if (opId && LABOR_TYPE[op] && taskStartAt) {
        api('/labor/capture', { method: 'POST', body: {
          operationId: opId, sellerId: cfg.seller, operator: (user && user.id) || cfg.email,
          type: LABOR_TYPE[op], startAt: taskStartAt, endAt: new Date().toISOString(), units: q,
        } }).catch(function () {});
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

  // ---- Cámara + lector ------------------------------------------------------
  var stream = null, detector = null, scanning = false, lastCode = '', lastAt = 0;

  function startCamera() {
    var video = $('video');
    if (!('BarcodeDetector' in window)) { showManual('Este navegador no tiene lector nativo de códigos. Usa el ingreso manual.'); return; }
    try { detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'itf', 'qr_code'] }); }
    catch (e) { showManual('No se pudo iniciar el lector. Usa el ingreso manual.'); return; }
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
      .then(function (s) { stream = s; video.srcObject = s; return video.play(); })
      .then(function () { scanning = true; $('cam-hint').textContent = STEP_HINT[steps[stepIdx]] || ''; requestAnimationFrame(loop); })
      .catch(function () { showManual('Sin acceso a la cámara. Usa el ingreso manual.'); });
  }

  function loop() {
    if (!scanning) return;
    var video = $('video');
    detector.detect(video).then(function (codes) {
      if (codes && codes.length) {
        var raw = codes[0].rawValue, now = Date.now();
        if (raw && (raw !== lastCode || now - lastAt > 1600)) { lastCode = raw; lastAt = now; onDetect(raw); }
      }
    }).catch(function () {}).then(function () { if (scanning) requestAnimationFrame(loop); });
  }

  function stopCamera() {
    scanning = false;
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
  }

  function showManual(msg) {
    $('cam-hint').textContent = msg;
    $('manual').style.display = '';
  }
  $('btn-mresolve').addEventListener('click', function () {
    var code = $('m-code').value.trim(); if (code) onDetect(code); $('m-code').value = '';
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
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }); }

  // ---- Service worker -------------------------------------------------------
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('./service-worker.js').catch(function () {}); });
  }

  // Arranque
  show(cfg.api && cfg.token ? 'login' : 'login');
})();
