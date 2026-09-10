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
    ['login', 'home', 'scan'].forEach(function (s) { $(s).classList.toggle('on', s === id); });
    if (id !== 'scan') stopCamera();
  }

  function toast(msg, ok) {
    var t = $('toast'), i = $('toast-i');
    i.className = 'i ' + (ok ? 'ok' : 'err'); i.textContent = (ok ? '✓  ' : '✕  ') + msg;
    t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }

  // ---- Login ----------------------------------------------------------------
  // Si la PWA se sirve desde el mismo origen que la API (caso túnel), usa ese origen.
  $('cfg-api').value = cfg.api || window.location.origin;
  $('cfg-seller').value = cfg.seller || 'acme';
  $('cfg-email').value = cfg.email || '';

  $('btn-login').addEventListener('click', function () {
    cfg.api = $('cfg-api').value.trim();
    cfg.seller = $('cfg-seller').value.trim();
    cfg.email = $('cfg-email').value.trim();
    var pass = $('cfg-pass').value;
    if (!cfg.api || !cfg.seller || !cfg.email || !pass) { toast('Completa servidor, cliente, email y contraseña', false); return; }
    save();
    api('/auth/login', { method: 'POST', body: { email: cfg.email, password: pass } })
      .then(function (r) {
        if (!r.authenticated) { toast('Email o contraseña incorrectos', false); return; }
        cfg.token = r.token; save();   // guarda el JWT firmado
        $('cfg-pass').value = '';
        user = r.user;
        $('h-user').textContent = user.name + ' · ' + user.role;
        $('h-seller').textContent = 'Cliente: ' + cfg.seller + '  ·  ' + cfg.api;
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
    b.addEventListener('click', function () { startOp(b.getAttribute('data-op')); });
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
    if (!cfg.seller) return;
    api('/sellers/' + encodeURIComponent(cfg.seller))
      .then(function (s) {
        if (!s || !s.operationId) throw new Error('seller sin operación');
        opId = s.operationId; // G4: contexto para capturar productividad
        loadMyTasks(); // Camino B: mis tareas asignadas
        return api('/operations/' + encodeURIComponent(s.operationId) + '/locations');
      })
      .then(setLocs)
      .catch(function () {
        // Respaldo: la operación del propio usuario (si la tiene).
        if (user && user.operationId) {
          opId = user.operationId;
          api('/operations/' + encodeURIComponent(user.operationId) + '/locations').then(setLocs).catch(function () {});
        }
      });
  }

  // Camino B: muestra las tareas asignadas al operario (guía; en modo advisory igual
  // puede escanear libremente, en estricto el backend valida al ejecutar).
  function loadMyTasks() {
    if (!opId) return;
    var wrap = document.getElementById('mytasks');
    var list = document.getElementById('mytasks-list');
    if (!wrap || !list) return;
    api('/assignments/mine?operationId=' + encodeURIComponent(opId) + '&operator=' + encodeURIComponent((user && user.id) || cfg.email))
      .then(function (tasks) {
        if (!tasks || !tasks.length) { wrap.style.display = 'none'; return; }
        var TL = { PICK: 'Picking', PACK: 'Empaque', SHIP: 'Despacho', PUTAWAY: 'Guardado', COUNT: 'Conteo', RECEIVE: 'Recepción', RESLOT: 'Re-slotting' };
        list.innerHTML = tasks.map(function (t) {
          return '<div style="background:var(--card,#fff);border:1px solid var(--line,#e5e7eb);border-radius:10px;padding:8px 10px;margin-bottom:6px;font-size:14px"><b>' + (TL[t.type] || t.type) + '</b> · ' + (t.entityRef || t.entityId) + ' <span style="color:#888">(' + t.unitsEstimate + ' un)</span></div>';
        }).join('');
        wrap.style.display = '';
      })
      .catch(function () { wrap.style.display = 'none'; });
  }

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
    if (op === 'receive') {
      call = api(base + '/scan/inbound', { method: 'POST', body: { barcode: captured.product, packCount: packCount, locationCode: captured.bin } });
    } else if (op === 'putaway') {
      call = api(base + '/scan/putaway', { method: 'POST', body: { productBarcode: captured.product, packCount: packCount, fromLocationCode: captured.from, toLocationCode: captured.to } });
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

  $('btn-back').addEventListener('click', function () { show('home'); });

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
