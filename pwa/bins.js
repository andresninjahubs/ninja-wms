/*
 * Ninja WMS · App del operario — Bins (contenedores: pallet, caja, tote, jaula).
 *
 * NOMENCLATURA: un Bin NO es una ubicación. Es un contenedor con número correlativo
 * (BIN-000123) que se ubica DENTRO de una ubicación. Aquí viven las pantallas del
 * operario para trabajar con Bins:
 *   · Ubicar un Bin (putaway con UN escaneo de ubicación, con sugerencia)
 *   · Mover un Bin (tarea o directo)
 *   · Consolidar Bins (juntar varios en uno)
 *   · Contar un Bin (presencia + conteo ciego con motivo)
 *   · Consultar un Bin · Crear un Bin
 *   · Recibir dentro de un Bin (barra en el flujo de recepción)
 * app.js le pasa sus helpers con NinjaBinsOp.init(ctx).
 */
(function () {
  'use strict';
  var C = null;                 // helpers de app.js
  var SET = null;               // ajustes de Bins de la operación (null = desconocido)
  var M = null;                 // estado de la pantalla actual
  var RB = { num: null, open: false, unidades: 0 };   // Bin de la recepción en curso

  function $(id) { return document.getElementById(id); }
  function esc(s) { return C.esc(s); }
  function oid() { return C.opId(); }
  function q() { return 'operationId=' + encodeURIComponent(oid() || ''); }
  function post(path, body) { return C.api(path, { method: 'POST', body: Object.assign({ operationId: oid() }, body || {}) }); }
  function getBin(ref) { return C.api('/bins/' + encodeURIComponent(ref) + '?' + q()); }
  function habilitado() { return !!(SET && SET.habilitado !== false && SET.planIncluye !== false); }
  function prefijo() { return String((SET && SET.prefix) || 'BIN-').toUpperCase(); }
  /** ¿Este código parece un número de Bin? (prefijo de la operación + dígitos). */
  function pareceBin(raw) {
    var c = String(raw || '').trim().toUpperCase(), p = prefijo();
    return c.indexOf(p) === 0 && /^\d+$/.test(c.slice(p.length));
  }
  function norm(raw) { return String(raw || '').trim().toUpperCase(); }
  var EST_CLS = { EN_ARMADO: 'run', POR_UBICAR: 'warn', UBICADO: 'ok', EN_MOVIMIENTO: 'run', VACIO: '', CONSOLIDADO: '', ELIMINADO: '' };

  // ---- Ajustes / visibilidad ------------------------------------------------------
  function refresh() {
    if (!oid()) return Promise.resolve(null);
    return C.api('/bins/settings?' + q()).then(function (s) { SET = s; sync(); return s; }).catch(function () { SET = null; sync(); return null; });
  }
  function sync() {
    Array.prototype.forEach.call(document.querySelectorAll('.op[data-op="binst"],.op[data-op="binpa"]'), function (b) { b.style.display = habilitado() ? '' : 'none'; });
  }

  // ---- Pantalla -------------------------------------------------------------------
  var MODOS = {
    menu: { t: 'Bins', l: 'Escanea un Bin para consultarlo' },
    putaway: { t: 'Ubicar Bin', l: 'Escanea el Bin' },
    move: { t: 'Mover Bin', l: 'Escanea el Bin' },
    consolidate: { t: 'Consolidar Bins', l: 'Escanea el Bin que se queda con todo' },
    count: { t: 'Contar Bin', l: 'Escanea el Bin a contar' },
    consult: { t: 'Consultar Bin', l: 'Escanea el Bin' },
    create: { t: 'Crear Bin', l: '' },
  };
  /** Abre un modo. `t` = tarea de la bandeja (BIN_PUTAWAY / BIN_MOVE / BIN_CONSOLIDATE). */
  function open(modo, t, back) {
    M = { modo: modo, task: t || null, back: back || (M && M.back) || 'menu', bin: null, fase: 'bin', busy: false, sug: [], destino: null, origenes: [], vistos: {}, lineas: [], armed: false, pres: null };
    C.show('binop');
    $('bo-title').textContent = MODOS[modo].t;
    $('bo-sub').textContent = t ? (t.entityRef || '') : (modo === 'menu' ? 'Contenedores con número propio' : 'Sin tarea');
    $('bo-scan').style.display = modo === 'create' ? 'none' : '';
    ctx('');
    if (t && t.entityId) {
      $('bo-body').innerHTML = '<div class="pk-empty">Cargando el Bin…</div>';
      getBin(t.entityId).then(function (b) { cargado(b, true); }).catch(function (e) { $('bo-body').innerHTML = '<div class="pk-empty">' + esc(e.message) + '</div>'; });
    } else render();
    C.camStart('bo-cam', onCode, MODOS[modo].l || 'Apunta al código');
  }
  function ctx(html) { var c = $('bo-ctx'); c.innerHTML = html; c.style.display = html ? '' : 'none'; }
  function label(txt, ph) { $('bo-label').textContent = txt; $('bo-code').placeholder = ph || 'Código'; C.camHint(txt); }
  function salir() {
    C.camStop();
    var b = M && M.back;
    if (b === 'home') { C.goHome(); return; }
    if (b === 'ts') { C.openStation(); return; }
    open('menu', null, 'home');
  }
  function binCard(b, conCantidades) {
    var cli = b.multiCliente ? 'Multi-cliente' : ((b.lineasDesc && b.lineasDesc[0] && b.lineasDesc[0].cliente) || '—');
    var lineas = (b.lineasDesc || []).slice(0, 8).map(function (l) {
      var sub = [l.descripcion, b.multiCliente ? l.cliente : ''].filter(Boolean).join(' · ');
      return '<div class="ln"><span style="min-width:0">' + esc(l.sku) + (l.lot ? ' · ' + esc(l.lot) : '') + (sub ? '<span class="pdl" style="display:block;font-weight:500">' + esc(sub) + '</span>' : '') + '</span>' + (conCantidades ? '<span>' + l.cantidad + '</span>' : '') + '</div>';
    }).join('') + ((b.lineasDesc || []).length > 8 ? '<div class="ln"><span>… +' + (b.lineasDesc.length - 8) + ' líneas</span></div>' : '');
    return '<b>📦 ' + esc(b.numero) + ' · ' + esc(b.estadoTexto) + '</b>'
      + esc(b.tipo) + ' · ' + esc(cli) + (conCantidades ? ' · ' + b.unidades + ' un' : '') + ' · ' + (b.ubicacion ? 'en <span class="code">' + esc(b.ubicacion) + '</span>' : 'sin ubicación')
      + (b.pendiente ? '<div style="margin-top:4px">Pendiente: ' + (b.pendiente.tipo === 'MOVE' ? 'traslado' + (b.pendiente.destino ? ' a <span class="code">' + esc(b.pendiente.destino) + '</span>' : '') : 'consolidación de ' + esc((b.pendiente.origenes || []).join(', '))) + '</div>' : '')
      + (lineas ? '<div class="lines">' + lineas + '</div>' : '');
  }

  // ---- Render por modo ------------------------------------------------------------
  function render() {
    var m = M, html = '';
    if (m.modo === 'menu') {
      label(MODOS.menu.l, 'N° de Bin');
      var acc = [['putaway', '⬇', 'Ubicar un Bin', 'Bin cerrado → escanea la ubicación'], ['move', '⇄', 'Mover un Bin', 'De una ubicación a otra, con todo su contenido'], ['consolidate', '⇢', 'Consolidar Bins', 'Juntar varios Bins en uno'], ['count', '🔢', 'Contar un Bin', 'Presencia + conteo ciego'], ['consult', '🔎', 'Consultar un Bin', 'Qué tiene y dónde está'], ['create', '＋', 'Crear un Bin', 'Número nuevo para un contenedor'], ['receive', '📥', 'Recibir en un Bin', 'Desde la recepción: elige o crea el Bin']];
      html = acc.map(function (a) { return '<button class="ordc" data-bomodo="' + a[0] + '"><div class="oc-main"><div class="oc-ref">' + a[1] + ' ' + esc(a[2]) + '</div><div class="oc-meta">' + esc(a[3]) + '</div></div></button>'; }).join('');
    } else if (m.modo === 'create') {
      var tipos = (SET && SET.tipos) || ['pallet', 'caja', 'tote'];
      html = '<div class="card"><div class="sec">Tipo de contenedor</div><div class="chips" id="bo-tipos">' + tipos.map(function (t, i) { return '<button class="chip' + (i === 0 ? ' on' : '') + '" data-botipo="' + esc(t) + '">' + esc(t) + '</button>'; }).join('') + '</div>'
        + '<button class="btn" id="bo-crear" style="margin-top:12px">Crear Bin</button><div class="muted" style="margin-top:8px">El número es correlativo y nunca se reutiliza. Imprime su etiqueta desde el panel (Bins → Etiquetas) o escribe el número en el contenedor.</div></div>'
        + (m.creado ? '<div class="resbox"><div class="rb-t">✓ Bin creado</div><div style="font-size:30px;font-weight:900;letter-spacing:.04em">' + esc(m.creado) + '</div><div class="muted">Queda EN ARMADO: recibe o pasa productos a él, ciérralo y ubícalo.</div></div>' : '');
    } else if (!m.bin && m.modo === 'putaway' && !m.task) {
      // Guardado libre de Bins: escanear el Bin, o tocarlo en la lista de los que esperan ubicación.
      label('Escanea el Bin o tócalo en la lista', 'N° de Bin');
      html = renderPorUbicar();
    } else if (!m.bin && !(m.modo === 'consolidate' && !m.task)) {
      label(MODOS[m.modo].l, 'N° de Bin');
      html = '<div class="pk-empty">Escanea o escribe el número del Bin.</div>';
    } else if (m.modo === 'putaway' || m.modo === 'move') html = renderUbicar();
    else if (m.modo === 'consolidate') html = renderConsolidar();
    else if (m.modo === 'count') html = renderContar();
    else if (m.modo === 'consult') { label('Escanea otro Bin', 'N° de Bin'); html = renderConsulta(); }
    if (m.modo !== 'menu') html += '<button class="btn alt" id="bo-salir" style="margin-top:12px">' + (m.back === 'home' ? 'Volver a mis tareas' : m.back === 'ts' ? 'Volver a la lista de Bins' : 'Volver al menú de Bins') + '</button>';
    $('bo-body').innerHTML = html;
    C.enfoca('bo-code');
  }

  /** Bins cerrados esperando ubicación (los más antiguos primero), para elegir tocando. */
  function hace(iso) {
    var min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
    return min < 60 ? 'hace ' + min + ' min' : min < 1440 ? 'hace ' + Math.round(min / 60) + ' h' : 'hace ' + Math.round(min / 1440) + ' d';
  }
  function renderPorUbicar() {
    var m = M;
    if (!m.lista) {
      m.lista = 'cargando';
      C.api('/bins?' + q() + '&estado=POR_UBICAR,EN_MOVIMIENTO').then(function (r) {
        var l = (r.bins || []).filter(function (b) { return b.estado === 'POR_UBICAR' || !b.pending; });
        l.sort(function (a, b) { return Date.parse(a.closedAt || a.updatedAt) - Date.parse(b.closedAt || b.updatedAt); });
        if (M === m) { m.lista = l; if (!m.bin) render(); }
      }).catch(function (e) { if (M === m) { m.lista = []; m.listaErr = e.message; if (!m.bin) render(); } });
      return '<div class="pk-empty">Buscando Bins por ubicar…</div>';
    }
    if (m.lista === 'cargando') return '<div class="pk-empty">Buscando Bins por ubicar…</div>';
    if (!m.lista.length) return '<div class="pk-empty">' + (m.listaErr ? esc(m.listaErr) : 'No hay Bins esperando ubicación. 🎉') + '</div>';
    return '<div class="sec">Por ubicar · ' + m.lista.length + ' Bin(s) · los más antiguos primero</div>' + m.lista.map(function (b) {
      var cli = b.multiCliente ? 'Multi-cliente' : ((b.clientesNombre || [])[0] || '—');
      return '<button class="ordc" data-bopick="' + esc(b.numero) + '"><div class="oc-main"><div class="oc-ref">📦 ' + esc(b.numero) + (b.estado === 'EN_MOVIMIENTO' ? ' <span class="tagrun">En curso</span>' : '') + '</div>'
        + '<div class="oc-meta">' + esc(cli) + ' · ' + b.unidades + ' un · ' + (b.ubicacion ? 'en ' + esc(b.ubicacion) : 'sin ubicación') + ' · ' + esc(hace(b.closedAt || b.updatedAt)) + '</div></div><span class="oc-act">Ubicar</span></button>';
    }).join('');
  }

  // Ubicar / mover: Bin conocido → escanear la ubicación destino (con sugerencias).
  function renderUbicar() {
    var m = M, b = m.bin;
    if (m.hecho) {
      label('Escanea otro Bin', 'N° de Bin');
      return '<div class="resbox"><div class="rb-t">✓ ' + esc(b.numero) + ' quedó en ' + esc(m.hecho.ubicacion) + '</div><div class="muted">' + b.unidades + ' un movidas con un solo movimiento.' + (m.hecho.reub ? ' ' + m.hecho.reub + ' orden(es) con reservas reubicadas.' : '') + '</div></div>'
        + '<button class="btn" id="bo-otro">' + (m.modo === 'putaway' ? 'Ubicar otro Bin' : 'Mover otro Bin') + '</button>';
    }
    var destPend = b.pendiente && b.pendiente.tipo === 'MOVE' ? b.pendiente.destino : null;
    label('Escanea la ubicación destino' + (destPend ? ' (' + destPend + ')' : ''), 'Código de ubicación');
    ctx(binCard(b, true));
    var h = '';
    if (destPend) h += '<div class="banner" style="margin:0 0 10px">El traslado pide dejarlo en <b>' + esc(destPend) + '</b>.</div>';
    if (m.alerta) h += '<div class="banner" style="margin:0 0 10px">' + m.alerta.texto + '<button class="btn warn" id="bo-igual" style="margin-top:8px">Dejarlo en ' + esc(m.alerta.code) + ' igualmente</button></div>';
    if (m.sug.length) h += '<div class="sec">Sugeridas</div>' + m.sug.map(function (s, i) { return '<button class="ordc" data-bosug="' + esc(s.code) + '"><div class="oc-main"><div class="oc-ref">' + (i === 0 ? '★ ' : '') + '<span class="code">' + esc(s.code) + '</span></div><div class="oc-meta">' + esc(s.motivo || '') + '</div></div><span class="oc-act alt">Elegir</span></button>'; }).join('');
    else h += '<div class="muted">Buscando ubicaciones sugeridas…</div>';
    return h;
  }
  function ubicarEn(code, forzar) {
    var m = M, b = m.bin; if (m.busy) return;
    var loc = C.findLoc(code);
    if (!loc) { C.bip(false); C.toast('Ese código no es una ubicación: ' + code, false); return; }
    if (loc.zoneType === 'RECEIVING' && m.modo === 'putaway') { C.bip(false); C.toast('Ubica el Bin en almacenaje o picking, no en recepción', false); return; }
    if (b.locationId && loc.id === b.locationId) { C.bip(false); C.toast('El Bin ya está en ' + loc.code, false); return; }
    var destPend = b.pendiente && b.pendiente.tipo === 'MOVE' ? b.pendiente.destino : null;
    if (!forzar && destPend && norm(destPend) !== norm(loc.code)) { C.bip(false); m.alerta = { code: loc.code, texto: 'Escaneaste <b>' + esc(loc.code) + '</b>, pero el traslado pide <b>' + esc(destPend) + '</b>.' }; render(); return; }
    m.busy = true; m.alerta = null;
    post('/bins/' + encodeURIComponent(b.numero) + '/putaway', { destino: loc.code }).then(function (r) {
      m.busy = false; C.bip(true); C.toast('Bin ' + b.numero + ' en ' + loc.code, true);
      m.bin = r.bin || b; m.hecho = { ubicacion: loc.code, reub: r.ordenesReubicadas || 0 };
      if (m.task) { m.task = null; C.taskDone(); }
      ctx(''); render();
    }).catch(function (e) { m.busy = false; C.bip(false); C.toast(e.message, false); });
  }

  // Consolidar: con tarea (destino + orígenes conocidos) o libre (destino y luego orígenes).
  function renderConsolidar() {
    var m = M;
    if (m.hecho) {
      label('Escanea otro Bin', 'N° de Bin');
      return '<div class="resbox"><div class="rb-t">' + (m.hecho.ejecutada ? '✓ Consolidado en ' : '⏳ Quedó como tarea: ') + esc(m.hecho.destino) + '</div><div class="muted">' + (m.hecho.ejecutada ? esc(m.hecho.origenes.join(', ')) + ' quedaron vacíos (CONSOLIDADOS).' + (m.hecho.reub ? ' ' + m.hecho.reub + ' orden(es) con reservas reubicadas.' : '') : 'Los Bins están en ubicaciones distintas: hay que juntarlos físicamente y ejecutar la tarea.') + '</div></div>';
    }
    var h = '';
    if (m.task) {
      var orig = (m.bin && m.bin.pendiente && m.bin.pendiente.origenes) || [];
      var faltan = orig.filter(function (n) { return !m.vistos[norm(n)]; });
      var destOk = !!m.vistos[norm(m.bin.numero)];
      label(faltan.length ? 'Escanea cada Bin de origen' : (destOk ? 'Todo listo: confirma' : 'Escanea el Bin destino ' + m.bin.numero), 'N° de Bin');
      ctx('<b>Junta todo en ' + esc(m.bin.numero) + '</b>Escanea cada Bin de origen y luego el Bin destino. Nunca se mezclan clientes en una misma línea.');
      h += '<div class="card">' + orig.map(function (n) { return '<div class="kv"><span>Origen</span><b class="code">' + esc(n) + (m.vistos[norm(n)] ? ' ✓' : '') + '</b></div>'; }).join('')
        + '<div class="kv"><span>Destino</span><b class="code">' + esc(m.bin.numero) + (destOk ? ' ✓' : '') + '</b></div></div>';
      h += '<button class="btn good" id="bo-consok" style="margin-top:12px"' + (faltan.length || !destOk ? ' disabled' : '') + '>Confirmar consolidación</button>';
      return h;
    }
    // Libre
    if (!m.bin) { label('Escanea el Bin que se queda con todo (destino)', 'N° de Bin'); return '<div class="pk-empty">Primero el Bin DESTINO; después los Bins que se vacían en él.</div>'; }
    label('Escanea los Bins que se vacían en ' + m.bin.numero, 'N° de Bin');
    ctx(binCard(m.bin, true));
    h += '<div class="card"><div class="kv"><span>Destino</span><b class="code">' + esc(m.bin.numero) + '</b></div>' + (m.origenes.length ? m.origenes.map(function (o, i) { return '<div class="kv"><span>Origen · ' + o.unidades + ' un' + (o.ubicacion ? ' · ' + esc(o.ubicacion) : '') + '</span><b class="code">' + esc(o.numero) + ' <button class="mini" data-boqo="' + i + '">✕</button></b></div>'; }).join('') : '<div class="muted" style="padding:6px 0">Aún no escaneas Bins de origen.</div>') + '</div>';
    h += '<button class="btn good" id="bo-consok" style="margin-top:12px"' + (m.origenes.length ? '' : ' disabled') + '>Consolidar ' + m.origenes.length + ' Bin(s) en ' + esc(m.bin.numero) + '</button>';
    return h;
  }
  function consolidar() {
    var m = M; if (m.busy) return; m.busy = true;
    var call = m.task ? post('/bins/' + encodeURIComponent(m.bin.numero) + '/consolidate-execute', {})
      : post('/bins/consolidate', { destino: m.bin.numero, origenes: m.origenes.map(function (o) { return o.numero; }) });
    call.then(function (r) {
      m.busy = false; C.bip(true);
      m.hecho = { ejecutada: !!r.ejecutada, destino: (r.destino && r.destino.numero) || m.bin.numero, origenes: r.origenes || [], reub: r.ordenesReubicadas || 0 };
      C.toast(r.ejecutada ? 'Bins consolidados' : 'Quedó como tarea de consolidación', true);
      if (m.task) { m.task = null; C.taskDone(); }
      ctx(''); render();
    }).catch(function (e) { m.busy = false; C.bip(false); C.toast(e.message, false); });
  }

  // Contar: presencia (ubicación) → conteo ciego por línea → confirmar con motivo.
  function renderContar() {
    var m = M, b = m.bin;
    if (m.hecho) {
      label('Escanea otro Bin', 'N° de Bin');
      var d = m.hecho.diferencias || [];
      return '<div class="resbox"><div class="rb-t">' + (m.hecho.exacto ? '✓ Conteo exacto' : '⚠️ ' + d.length + ' diferencia(s) ajustada(s)') + '</div>'
        + d.map(function (x) { return '<div class="kv"><span>' + esc(x.sku) + (x.lot ? ' · ' + esc(x.lot) : '') + '</span><b>' + (x.delta > 0 ? '+' : '') + x.delta + '</b></div>' + (x.aviso ? '<div class="muted">' + esc(x.aviso) + '</div>' : ''); }).join('') + '</div>';
    }
    if (m.fase === 'pres') {
      label('Escanea la ubicación donde está el Bin', 'Código de ubicación');
      ctx('<b>📦 ' + esc(b.numero) + '</b>Confirma dónde está: escanea la ubicación.');
      return '<button class="btn alt" id="bo-saltapres">Saltar este paso</button>';
    }
    label('Escanea cada unidad del Bin', 'EAN / DUN o N° de Bin');
    ctx('<b>Cuenta todo lo que hay dentro de ' + esc(b.numero) + '</b>' + (m.pres ? (m.pres.ok ? '✓ Está en ' + esc(m.pres.encontrado) + '. ' : '⚠️ El sistema lo tenía en ' + esc(m.pres.esperado || 'ninguna ubicación') + ' y lo encontraste en ' + esc(m.pres.encontrado) + '. ') : '') + 'Escanea cada unidad (o usa + / −). Lo que no cuentes queda en 0.');
    var h = m.lineas.map(function (l, i) {
      return '<div class="cl"><div class="cl-main"><div class="cl-sku">' + esc(l.sku) + (l.lot ? ' · ' + esc(l.lot) : '') + '</div><div class="cl-sub">' + esc(l.descripcion || '') + (b.multiCliente ? ' · ' + esc(l.cliente) : '') + '</div></div>'
        + '<div class="pl-q"><button class="mini" data-bom="' + i + '">−</button><b>' + l.qty + '</b><button class="mini" data-bop="' + i + '">+</button></div></div>';
    }).join('') || '<div class="pk-empty">El sistema no tiene productos en este Bin. Escanea lo que encuentres.</div>';
    h += '<div class="fld" style="margin-top:12px"><label class="muted">Motivo del ajuste (si hay diferencias)</label><input id="bo-motivo" class="code" value="' + esc(m.motivo || 'conteo de Bin') + '"></div>';
    h += '<button class="btn ' + (m.armed ? 'warn' : 'good') + '" id="bo-contar" style="margin-top:12px">' + (m.armed ? 'Toca de nuevo para confirmar el conteo' : 'Confirmar conteo') + '</button>'
      + (m.armed ? '<div class="banner" style="margin:8px 0 0">Las diferencias se ajustan con el motivo indicado y quedan en el historial del Bin.</div>' : '');
    return h;
  }
  function contarCodigo(raw) {
    var m = M, b = m.bin;
    var clientes = []; (b.lineasDesc || []).forEach(function (l) { if (clientes.indexOf(l.sellerId) < 0) clientes.push(l.sellerId); });
    if (!clientes.length && b.clientes) clientes = b.clientes.slice();
    if (!clientes.length) { C.bip(false); C.toast('Bin sin cliente conocido: agrega productos desde el panel', false); return; }
    (function intenta(k) {
      if (k >= clientes.length) { C.bip(false); C.toast('Producto no reconocido: ' + raw, false); return; }
      C.resolveCode(clientes[k], raw).then(function (r) {
        var ix = -1; m.lineas.forEach(function (l, j) { if (ix < 0 && l.sellerId === clientes[k] && l.sku === r.sku) ix = j; });
        if (ix < 0) { m.lineas.push({ sellerId: clientes[k], sku: r.sku, lot: null, qty: 0, descripcion: C.descOf(r.sku, clientes[k]) || '', cliente: C.sellerNom(clientes[k]) }); ix = m.lineas.length - 1; }
        m.lineas[ix].qty += (r.factor || 1); m.armed = false; C.bip(true); render();
      }).catch(function () { intenta(k + 1); });
    })(0);
  }
  function confirmarConteo() {
    var m = M; if (m.busy) return;
    if (!m.armed) { m.armed = true; m.motivo = ($('bo-motivo') && $('bo-motivo').value) || m.motivo; render(); return; }
    m.busy = true;
    var motivo = ($('bo-motivo') && $('bo-motivo').value.trim()) || 'conteo de Bin';
    post('/bins/' + encodeURIComponent(m.bin.numero) + '/count', { motivo: motivo, lineas: m.lineas.map(function (l) { return { sellerId: l.sellerId, sku: l.sku, lot: l.lot || null, qty: l.qty }; }) })
      .then(function (r) { m.busy = false; m.hecho = r; C.bip(!!r.exacto); C.toast(r.exacto ? 'Conteo exacto' : 'Diferencias ajustadas', true); ctx(''); render(); })
      .catch(function (e) { m.busy = false; m.armed = false; C.bip(false); C.toast(e.message, false); render(); });
  }

  function renderConsulta() {
    var b = M.bin;
    ctx(binCard(b, true));
    var hist = (b.historial || []).slice(-6).reverse().map(function (h) { return '<div class="kv"><span>' + esc(new Date(h.at).toLocaleString('es-CL', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })) + ' · ' + esc(h.tipo.replace('MOV:', '')) + '</span><b style="font-weight:600;font-size:12.5px">' + esc(h.hechoPor || h.actor) + '</b></div>'; }).join('');
    return (b.tarea ? '<div class="banner" style="margin:0 0 10px">Tarea en curso: ' + esc(b.tarea.tipo) + ' · ' + esc(b.tarea.operario) + '</div>' : '')
      + (hist ? '<div class="card"><div class="sec">Últimos movimientos</div>' + hist + '</div>' : '');
  }

  // ---- Carga de un Bin escaneado ---------------------------------------------------
  function cargado(b, desdeTarea) {
    var m = M;
    if (m.modo === 'menu') { open('consult', null, m.back); M.bin = b; render(); return; }
    if (m.modo === 'putaway' || m.modo === 'move') {
      if (m.modo === 'putaway' && b.estado !== 'POR_UBICAR' && !(b.estado === 'EN_MOVIMIENTO' && !b.pendiente)) {
        if (b.estado === 'EN_ARMADO') { C.bip(false); C.toast('El Bin ' + b.numero + ' sigue EN ARMADO: ciérralo primero (desde la recepción o el panel)', false); if (!desdeTarea) return; }
        else if (!desdeTarea) { C.toast('El Bin ' + b.numero + ' está ' + b.estadoTexto.toLowerCase() + ': lo muevo como traslado', true); m.modo = 'move'; $('bo-title').textContent = MODOS.move.t; }
      }
      if (m.modo === 'move' && (b.estado === 'EN_ARMADO' || b.estado === 'VACIO' || b.estado === 'CONSOLIDADO' || b.estado === 'ELIMINADO')) { C.bip(false); C.toast('Un Bin ' + b.estadoTexto.toLowerCase() + ' no se puede mover', false); return; }
      m.bin = b; m.sug = []; m.hecho = null; m.alerta = null; C.bip(true); render();
      C.api('/bins/' + encodeURIComponent(b.numero) + '/suggest?' + q()).then(function (s) { if (M === m && m.bin && m.bin.id === b.id) { m.sug = s || []; if (!m.sug.length) m.sug = []; render(); } }).catch(function () {});
      return;
    }
    if (m.modo === 'consolidate') {
      if (m.task) { m.bin = b; render(); return; }
      if (!m.bin) {
        if (['VACIO', 'CONSOLIDADO', 'ELIMINADO'].indexOf(b.estado) >= 0) { C.bip(false); C.toast('El Bin destino no puede estar ' + b.estadoTexto.toLowerCase(), false); return; }
        m.bin = b; C.bip(true); render(); return;
      }
      if (b.id === m.bin.id) { C.bip(false); C.toast('Ese es el Bin destino', false); return; }
      if (m.origenes.some(function (o) { return o.id === b.id; })) { C.bip(false); C.toast('Ya lo escaneaste', false); return; }
      if (!b.unidades) { C.bip(false); C.toast('El Bin ' + b.numero + ' está vacío', false); return; }
      m.origenes.push(b); C.bip(true); render(); return;
    }
    if (m.modo === 'count') {
      if (!b.locationId) { C.bip(false); C.toast('El Bin ' + b.numero + ' no tiene ubicación: no se puede contar', false); return; }
      m.bin = b; m.fase = 'pres'; m.armed = false; m.hecho = null;
      m.lineas = (b.lineasDesc || []).map(function (l) { return { sellerId: l.sellerId, sku: l.sku, lot: l.lot, qty: 0, descripcion: l.descripcion, cliente: l.cliente }; });
      C.bip(true); render(); return;
    }
    if (m.modo === 'consult') { m.bin = b; C.bip(true); render(); }
  }

  // ---- Lectura de códigos ------------------------------------------------------------
  function onCode(raw) {
    var m = M; if (!m || !raw) return;
    var code = String(raw).trim();
    if (m.modo === 'create') return;
    // Ubicar / mover con el Bin ya cargado: el código es la ubicación destino.
    if ((m.modo === 'putaway' || m.modo === 'move') && m.bin && !m.hecho) {
      if (pareceBin(code) && norm(code) === norm(m.bin.numero)) { C.bip(true); C.toast('Bin confirmado: ahora la ubicación', true); return; }
      if (C.findLoc(code)) { ubicarEn(code, false); return; }
      if (!pareceBin(code)) { C.bip(false); C.toast('Ese código no es una ubicación', false); return; }
    }
    if (m.modo === 'count' && m.bin && !m.hecho) {
      if (m.fase === 'pres') {
        var loc = C.findLoc(code);
        if (!loc) { C.bip(false); C.toast('Escanea una ubicación', false); return; }
        post('/bins/' + encodeURIComponent(m.bin.numero) + '/presence', { ubicacion: loc.code }).then(function (r) { m.pres = r; m.fase = 'items'; C.bip(!!r.ok); if (!r.ok) C.toast('El Bin no estaba donde el sistema decía: quedó en el historial', false); render(); }).catch(function (e) { C.bip(false); C.toast(e.message, false); });
        return;
      }
      if (!pareceBin(code)) { contarCodigo(code); return; }
      if (norm(code) === norm(m.bin.numero)) { C.bip(true); return; }
    }
    if (m.modo === 'consolidate' && m.task && m.bin && !m.hecho) {
      var c = norm(code), orig = (m.bin.pendiente && m.bin.pendiente.origenes) || [];
      if (c === norm(m.bin.numero) || orig.some(function (n) { return norm(n) === c; })) { m.vistos[c] = true; C.bip(true); render(); return; }
      C.bip(false); C.toast('Ese Bin no es parte de esta consolidación', false); return;
    }
    // En cualquier otro caso, el código es un Bin.
    if (C.findLoc(code) && !pareceBin(code)) { C.bip(false); C.toast('Eso es una ubicación. Escanea el número del Bin', false); return; }
    getBin(code).then(function (b) { cargado(b, false); }).catch(function (e) { C.bip(false); C.toast(e.message || ('No encontré el Bin ' + code), false); });
  }

  // ---- Eventos de la pantalla ----------------------------------------------------------
  function wire() {
    $('bo-scan').addEventListener('submit', function (e) { e.preventDefault(); var el = $('bo-code'), c = (el.value || '').trim(); el.value = ''; if (c) onCode(c); C.enfoca('bo-code'); });
    $('btn-boback').addEventListener('click', salir);
    $('btn-bocam').addEventListener('click', function () { C.camToggle('bo-cam', onCode, $('bo-label').textContent); });
    $('bo-body').addEventListener('click', function (e) {
      var t = e.target.closest('button'); if (!t || t.disabled) return;
      var m = M;
      if (t.id === 'bo-salir') { salir(); return; }
      if (t.hasAttribute('data-bomodo')) { var md = t.getAttribute('data-bomodo'); if (md === 'receive') { C.camStop(); C.openRecv(); C.toast('Elige la recepción: en el cotejo puedes recibir dentro de un Bin', true); return; } open(md, null, 'menu'); return; }
      if (t.hasAttribute('data-botipo')) { Array.prototype.forEach.call(document.querySelectorAll('#bo-tipos .chip'), function (c) { c.classList.toggle('on', c === t); }); return; }
      if (t.id === 'bo-crear') {
        var on = document.querySelector('#bo-tipos .chip.on'); t.disabled = true;
        post('/bins', { cantidad: 1, tipo: on ? on.getAttribute('data-botipo') : null }).then(function (r) { m.creado = r.bins[0].numero; C.bip(true); render(); }).catch(function (x) { t.disabled = false; C.bip(false); C.toast(x.message, false); });
        return;
      }
      if (t.hasAttribute('data-bosug')) { ubicarEn(t.getAttribute('data-bosug'), false); return; }
      if (t.hasAttribute('data-bopick')) { t.disabled = true; getBin(t.getAttribute('data-bopick')).then(function (b) { cargado(b, false); }).catch(function (x) { t.disabled = false; C.bip(false); C.toast(x.message, false); }); return; }
      if (t.id === 'bo-igual' && m.alerta) { ubicarEn(m.alerta.code, true); return; }
      if (t.id === 'bo-otro') { open(m.modo, null, m.back === 'home' || m.back === 'ts' ? m.back : 'menu'); return; }
      if (t.id === 'bo-consok') { consolidar(); return; }
      if (t.hasAttribute('data-boqo')) { m.origenes.splice(+t.getAttribute('data-boqo'), 1); render(); return; }
      if (t.id === 'bo-saltapres') { m.fase = 'items'; m.pres = null; render(); return; }
      if (t.hasAttribute('data-bop')) { m.lineas[+t.getAttribute('data-bop')].qty++; m.armed = false; render(); return; }
      if (t.hasAttribute('data-bom')) { var l = m.lineas[+t.getAttribute('data-bom')]; l.qty = Math.max(0, l.qty - 1); m.armed = false; render(); return; }
      if (t.id === 'bo-contar') { confirmarConteo(); return; }
    });
  }

  /** Abre el flujo que corresponde a una tarea de Bin de la bandeja. */
  function openTask(t, back) {
    var modo = t.type === 'BIN_PUTAWAY' ? 'putaway' : t.type === 'BIN_MOVE' ? 'move' : 'consolidate';
    open(modo, t, back);
  }

  // =====================================================================
  // RECIBIR DENTRO DE UN BIN (barra en el flujo de recepción)
  // =====================================================================
  function recvBar(esRecepcion) {
    var el = $('rbin'); if (!el) return;
    if (!esRecepcion || !habilitado()) { el.style.display = 'none'; el.innerHTML = ''; return; }
    el.style.display = '';
    if (RB.num) {
      el.innerHTML = '<div class="taskctx"><b>📦 Recibiendo dentro del Bin ' + esc(RB.num) + '</b>Todo lo que confirmes entra a este Bin.' + (RB.unidades ? ' Lleva ' + RB.unidades + ' un en esta sesión.' : '')
        + '<div class="pa-acts" style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap"><button class="btn" id="rb-next" style="flex:1;min-height:44px;font-size:14px">Cerrar Bin y abrir otro</button><button class="btn alt" id="rb-close" style="flex:1;min-height:44px">Cerrar Bin</button><button class="btn alt" id="rb-off" style="flex:none;width:auto;min-height:44px">Quitar</button></div></div>';
    } else if (RB.open) {
      el.innerHTML = '<div class="taskctx"><b>📦 ¿En qué Bin recibes?</b>Escanea el número del Bin (o escríbelo), o crea uno nuevo.'
        + '<div class="scanrow" style="margin-top:8px"><input id="rb-code" class="code" placeholder="' + esc(prefijo()) + '000123" autocomplete="off" autocapitalize="characters" spellcheck="false"><button class="btn alt" id="rb-ok" type="button">OK</button></div>'
        + '<div style="display:flex;gap:8px;margin-top:8px"><button class="btn" id="rb-new" style="flex:1;min-height:44px;font-size:14px">＋ Nuevo Bin</button><button class="btn alt" id="rb-cancel" style="flex:none;width:auto;min-height:44px">Cancelar</button></div></div>';
    } else {
      el.innerHTML = '<button class="btn alt" id="rb-use" style="min-height:44px">📦 Recibir dentro de un Bin</button>';
    }
    var b;
    if ((b = $('rb-use'))) b.onclick = function () { RB.open = true; recvBar(true); setTimeout(function () { C.enfoca('rb-code'); }, 50); };
    if ((b = $('rb-cancel'))) b.onclick = function () { RB.open = false; recvBar(true); };
    if ((b = $('rb-ok'))) b.onclick = function () { usarBin($('rb-code').value); };
    if ((b = $('rb-code'))) b.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); usarBin(this.value); } };
    if ((b = $('rb-new'))) b.onclick = function () { nuevoBin(); };
    if ((b = $('rb-off'))) b.onclick = function () { RB.num = null; RB.open = false; RB.unidades = 0; recvBar(true); C.toast('Se recibe como stock suelto', true); };
    if ((b = $('rb-close'))) b.onclick = function () { cerrarBin(false); };
    if ((b = $('rb-next'))) b.onclick = function () { cerrarBin(true); };
  }
  function usarBin(raw) {
    var c = norm(raw); if (!c) return;
    getBin(c).then(function (bn) {
      if (bn.estado !== 'EN_ARMADO' && bn.estado !== 'VACIO') { C.bip(false); C.toast('El Bin ' + bn.numero + ' está ' + bn.estadoTexto.toLowerCase() + ': no recibe mercadería', false); return; }
      RB.num = bn.numero; RB.open = false; RB.unidades = 0; C.bip(true); C.toast('Recibiendo en ' + bn.numero, true); recvBar(true);
    }).catch(function (e) { C.bip(false); C.toast(e.message, false); });
  }
  function nuevoBin() {
    post('/bins', { cantidad: 1 }).then(function (r) { RB.num = r.bins[0].numero; RB.open = false; RB.unidades = 0; C.bip(true); C.toast('Bin ' + RB.num + ' creado: anota el número en el contenedor o imprime su etiqueta', true); recvBar(true); })
      .catch(function (e) { C.bip(false); C.toast(e.message, false); });
  }
  function cerrarBin(abrirOtro) {
    var n = RB.num; if (!n) return;
    post('/bins/' + encodeURIComponent(n) + '/close', {}).then(function () {
      C.bip(true); C.toast('Bin ' + n + ' cerrado: queda POR UBICAR', true);
      RB.num = null; RB.unidades = 0; RB.open = !!abrirOtro; recvBar(true);
      if (abrirOtro) setTimeout(function () { C.enfoca('rb-code'); }, 50);
    }).catch(function (e) { C.bip(false); C.toast(e.message, false); });
  }
  /** Si en el paso de producto se escanea un Bin, se toma como el Bin de la recepción. */
  function tryRecvCode(raw, esRecepcion) {
    if (!esRecepcion || !habilitado() || !pareceBin(raw)) return false;
    usarBin(raw); return true;
  }
  function recvBinNum() { return habilitado() ? RB.num : null; }
  function recvNote(unidades) { if (RB.num) { RB.unidades += unidades || 0; recvBar(true); } }
  function recvReset() { RB.num = null; RB.open = false; RB.unidades = 0; }

  window.NinjaBinsOp = {
    init: function (ctx) { C = ctx; if (!C._wired) { C._wired = true; wire(); } },
    refresh: refresh,
    habilitado: habilitado,
    open: open,
    openTask: openTask,
    /** Abre un modo y procesa de inmediato un código ya leído (p. ej. un Bin escaneado en la estación de guardado). */
    openWithCode: function (modo, code, back) { open(modo, null, back); onCode(code); },
    pareceBin: pareceBin,
    recvBar: recvBar,
    tryRecvCode: tryRecvCode,
    recvBinNum: recvBinNum,
    recvNote: recvNote,
    recvReset: recvReset,
  };
})();
