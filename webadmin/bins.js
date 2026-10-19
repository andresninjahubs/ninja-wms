/*
 * Ninja WMS — Bins (contenedores lógicos: pallet, caja, tote, jaula).
 *
 * NOMENCLATURA: un Bin NO es una ubicación. Es un contenedor con número correlativo
 * (BIN-000123) que agrupa productos y se ubica DENTRO de una ubicación. Una ubicación
 * puede tener varios Bins y además stock suelto.
 *
 * Este módulo pinta la sección «Bins» del panel, el detalle de cada Bin con sus
 * acciones, las etiquetas Code 128, la consolidación y los ajustes. Recibe los
 * helpers del panel con NinjaBins.init(ctx) (lo llama app.js al arrancar).
 */
(function () {
  'use strict';
  var C = null; // contexto del panel (api, esc, toast, openModal, …)
  var ST = { settings: null, list: [], sel: {}, filtros: { sellerId: '', estado: '', ubicacion: '', sku: '', q: '' } };
  var ESTADOS = [['', 'Todos los estados'], ['EN_ARMADO', 'En armado'], ['POR_UBICAR', 'Por ubicar'], ['UBICADO', 'Ubicado'], ['EN_MOVIMIENTO', 'En movimiento'], ['VACIO', 'Vacío'], ['CONSOLIDADO', 'Consolidado'], ['ELIMINADO', 'Eliminado']];
  var CHIP = { EN_ARMADO: 'st-RECEIVED', POR_UBICAR: 'st-RESERVED', UBICADO: 'st-AVAILABLE', EN_MOVIMIENTO: 'st-PICKING', VACIO: 'st-QUARANTINE', CONSOLIDADO: 'st-CANCELLED', ELIMINADO: 'st-CANCELLED' };

  function $(s, r) { return (r || document).querySelector(s); }
  function $$(s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); }
  function esc(s) { return C.esc(s); }
  function opq() { return 'operationId=' + encodeURIComponent(C.getOp() || ''); }
  function interno() { var r = C.getRole(); return r !== 'CLIENT'; }
  function puedeMover() { var r = C.getRole(); return r === 'PLATFORM_ADMIN' || r === 'ADMIN' || r === 'SUPERVISOR' || r === 'OPERATOR'; }
  function esAdmin() { var r = C.getRole(); return r === 'PLATFORM_ADMIN' || r === 'ADMIN' || r === 'SUPERVISOR'; }
  function chip(e, t) { return '<span class="chip ' + (CHIP[e] || '') + '"><span class="dot"></span>' + esc(t || e) + '</span>'; }
  function fecha(s) { return s ? C.fmtDate(s) : '—'; }
  function err(e) { C.toast((e && e.message) || 'No se pudo completar'); }
  function post(path, body) { return C.api(path, { method: 'POST', body: Object.assign({ operationId: C.getOp() }, body || {}) }); }

  // ---- Code 128 (set B) → SVG ---------------------------------------------------------
  var P128 = ['212222','222122','222221','121223','121322','131222','122213','122312','132212','221213','221312','231212','112232','122132','122231','113222','123122','123221','223211','221132','221231','213212','223112','312131','311222','321122','321221','312212','322112','322211','212123','212321','232121','111323','131123','131321','112313','132113','132311','211313','231113','231311','112133','112331','132131','113123','113321','133121','313121','211331','231131','213113','213311','213131','311123','311321','331121','312113','312311','332111','314111','221411','431111','111224','111422','121124','121421','141122','141221','112214','112412','122114','122411','142112','142211','241211','221114','413111','241112','134111','111242','121142','121241','114212','124112','124211','411212','421112','421211','212141','214121','412121','111143','111341','131141','114113','114311','411113','411311','113141','114131','311141','411131','211412','211214','211232','2331112'];
  function code128svg(text, h) {
    var vals = [104], sum = 104;
    for (var i = 0; i < text.length; i++) { var v = text.charCodeAt(i) - 32; if (v < 0 || v > 94) v = 0; vals.push(v); sum += v * (i + 1); }
    vals.push(sum % 103); vals.push(106);
    var x = 10, bars = '';
    vals.forEach(function (v) {
      var p = P128[v];
      for (var k = 0; k < p.length; k++) { var w = +p[k]; if (k % 2 === 0) bars += '<rect x="' + x + '" y="0" width="' + w + '" height="' + h + '"/>'; x += w; }
    });
    x += 10;
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + x + ' ' + h + '" preserveAspectRatio="none" style="width:100%;height:' + h + 'px">' + bars + '</svg>';
  }

  /** Imprime etiquetas (una por Bin): número grande, Code 128, fecha, cliente y contenido opcional. */
  function imprimirEtiquetas(refs) {
    if (!refs.length) { C.toast('Selecciona al menos un Bin'); return; }
    var w = window.open('', '_blank', 'width=520,height=720');
    if (!w) { C.toast('Habilita las ventanas emergentes para imprimir'); return; }
    w.document.write('<!doctype html><title>Etiquetas de Bins</title><body style="font-family:system-ui;padding:20px">Preparando ' + refs.length + ' etiqueta(s)…</body>');
    Promise.all(refs.map(function (r) { return C.api('/bins/' + encodeURIComponent(r) + '/label?' + opq()).catch(function () { return null; }); })).then(function (labels) {
      var html = labels.filter(Boolean).map(function (l) {
        var cont = l.contenido && l.contenido.length ? '<div class="ct">' + l.contenido.slice(0, 8).map(function (c) { return esc(c.cantidad + ' × ' + c.sku + (c.lot ? ' · ' + c.lot : '')); }).join('<br>') + (l.contenido.length > 8 ? '<br>… +' + (l.contenido.length - 8) : '') + '</div>' : '';
        return '<div class="lb"><div class="tp">BIN · ' + esc(String(l.tipo || '').toUpperCase()) + '</div><div class="nm">' + esc(l.numero) + '</div>'
          + '<div class="bc">' + code128svg(l.numero, 70) + '</div><div class="hr">' + esc(l.numero) + '</div>'
          + '<div class="ft"><span>' + esc(l.cliente) + '</span><span>' + esc(new Date(l.fecha).toLocaleDateString('es-CL')) + '</span></div>' + cont + '</div>';
      }).join('');
      w.document.open();
      w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Etiquetas de Bins</title><style>'
        + '@page{size:100mm 75mm;margin:4mm}body{margin:0;font-family:Arial,Helvetica,sans-serif;color:#000}'
        + '.lb{width:92mm;height:66mm;box-sizing:border-box;border:1px dashed #bbb;padding:3mm 4mm;page-break-after:always;display:flex;flex-direction:column}'
        + '.tp{font-size:9pt;letter-spacing:.12em;font-weight:700}.nm{font-size:26pt;font-weight:900;line-height:1.05;margin:1mm 0}'
        + '.bc svg{display:block}.hr{font-family:monospace;font-size:11pt;text-align:center;letter-spacing:.2em;margin-top:1mm}'
        + '.ft{display:flex;justify-content:space-between;font-size:10pt;font-weight:700;margin-top:2mm}.ct{font-size:8pt;margin-top:1.5mm;line-height:1.25}'
        + '@media print{.lb{border:0}}</style></head><body>' + html + '<script>setTimeout(function(){window.print()},300)<\/script></body></html>');
      w.document.close();
    });
  }

  // ---- Listado ---------------------------------------------------------------------
  function render() {
    var page = $('.page[data-pg="bins"]'); if (!page || !C) return;
    var cli = $('#bn-cli');
    if (cli) { var cur = ST.filtros.sellerId; cli.innerHTML = '<option value="">Todos los clientes</option>' + (C.getSellers() || []).map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === cur ? ' selected' : '') + '>' + esc(s.name) + '</option>'; }).join(''); }
    C.api('/bins/settings?' + opq()).then(function (s) {
      ST.settings = s;
      var ban = $('#bn-banner');
      if (ban) {
        if (s.habilitado === false) ban.innerHTML = '<div class="apprv-box warn"><div class="apprv-t">Los Bins están desactivados en esta operación</div><div class="hint">Con el módulo apagado el WMS funciona exactamente como siempre (stock suelto por ubicación).' + (esAdmin() ? ' <button class="btn pri" id="bn-enable" style="margin-left:8px;padding:5px 12px">Activar Bins</button>' : '') + '</div></div>';
        else ban.innerHTML = '';
        var be = $('#bn-enable'); if (be) be.addEventListener('click', function () { C.api('/bins/settings', { method: 'PATCH', body: { operationId: C.getOp(), habilitado: true } }).then(function () { C.toast('Bins activados'); render(); }).catch(err); });
      }
      ['#bn-new', '#bn-cons', '#bn-settings'].forEach(function (id) { var b = $(id); if (b) b.classList.toggle('hidden', !puedeMover() || (id === '#bn-settings' && !esAdmin())); });
      var bc = $('#bn-cli'); if (bc) bc.parentElement.classList.toggle('hidden', !interno());
      cargar();
    }).catch(function (e) {
      var ban = $('#bn-banner'); if (ban) ban.innerHTML = '<div class="apprv-box warn"><div class="apprv-t">Bins no disponible</div><div class="hint">' + esc(e.message) + '</div></div>';
      $('#bn-body').innerHTML = '<tr><td colspan="9" class="empty">—</td></tr>';
    });
  }

  function cargar() {
    var f = ST.filtros, q = [opq()];
    if (f.sellerId) q.push('sellerId=' + encodeURIComponent(f.sellerId));
    if (f.estado) q.push('estado=' + encodeURIComponent(f.estado));
    if (f.ubicacion) q.push('ubicacion=' + encodeURIComponent(f.ubicacion));
    if (f.sku) q.push('sku=' + encodeURIComponent(f.sku));
    if (f.q) q.push('q=' + encodeURIComponent(f.q));
    if (f.estado === 'CONSOLIDADO' || f.estado === 'ELIMINADO') q.push('inactivos=1');
    C.api('/bins?' + q.join('&')).then(function (r) { ST.list = r.bins || []; pintar(r); }).catch(err);
  }

  function pintar(r) {
    var sum = $('#bn-sum');
    if (sum) sum.innerHTML = ESTADOS.filter(function (e) { return e[0] && r.resumen && r.resumen[e[0]]; }).map(function (e) {
      return '<button class="fchip' + (ST.filtros.estado === e[0] ? ' on' : '') + '" data-bnest="' + e[0] + '">' + esc(e[1]) + ' · ' + r.resumen[e[0]] + '</button>';
    }).join('') || '<span class="muted">Sin Bins todavía.</span>';
    $$('#bn-sum [data-bnest]').forEach(function (b) { b.addEventListener('click', function () { var v = b.getAttribute('data-bnest'); ST.filtros.estado = ST.filtros.estado === v ? '' : v; $('#bn-est').value = ST.filtros.estado; cargar(); }); });
    var cnt = $('#bn-count'); if (cnt) cnt.textContent = r.total + ' Bin(s) · ' + ST.list.reduce(function (t, b) { return t + b.unidades; }, 0) + ' un';
    var body = $('#bn-body'); if (!body) return;
    if (!ST.list.length) { body.innerHTML = '<tr><td colspan="9"><div class="empty">' + (r.total === 0 && !ST.filtros.estado && !ST.filtros.q ? 'Aún no hay Bins. Crea los primeros con «＋ Crear Bins» o desde una recepción.' : 'Sin resultados para estos filtros.') + '</div></td></tr>'; return; }
    body.innerHTML = ST.list.map(function (b) {
      var cli = b.multiCliente ? '<span class="chip st-RESERVED" style="font-size:10.5px">Multi-cliente</span> ' + esc(b.clientesNombre.join(', ')) : esc(b.clientesNombre.join(', ') || '—');
      return '<tr>' + (puedeMover() ? '<td class="selcol"><input type="checkbox" data-bnsel="' + esc(b.id) + '"' + (ST.sel[b.id] ? ' checked' : '') + '></td>' : '<td></td>')
        + '<td class="mono2"><a href="#" data-bnopen="' + esc(b.id) + '" style="font-weight:700">' + esc(b.numero) + '</a></td>'
        + '<td>' + chip(b.estado, b.estadoTexto) + (b.pending ? ' <span class="muted" style="font-size:11px">· ' + (b.pending.kind === 'MOVE' ? 'traslado' : 'consolidación') + ' pendiente</span>' : '') + '</td>'
        + '<td>' + (b.ubicacion ? '<span class="loc-chip">' + esc(b.ubicacion) + '</span>' : '<span class="muted">sin ubicación</span>') + '</td>'
        + '<td>' + esc(b.tipo) + '</td><td>' + cli + '</td><td class="num">' + b.skus + '</td>'
        + '<td class="num"><b>' + b.unidades + '</b>' + (b.reservadas ? ' <span class="muted" style="font-size:11px">(' + b.reservadas + ' res.)</span>' : '') + '</td>'
        + '<td class="muted" style="white-space:nowrap">' + esc(fecha(b.updatedAt)) + '</td></tr>';
    }).join('');
    $$('#bn-body [data-bnopen]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); openDetail(a.getAttribute('data-bnopen')); }); });
    $$('#bn-body [data-bnsel]').forEach(function (c) { c.addEventListener('change', function () { var id = c.getAttribute('data-bnsel'); if (c.checked) ST.sel[id] = true; else delete ST.sel[id]; syncSel(); }); });
    syncSel();
  }
  function seleccion() { return ST.list.filter(function (b) { return ST.sel[b.id]; }); }
  function syncSel() {
    var n = seleccion().length, el = $('#bn-seln'); if (el) el.textContent = n ? n + ' seleccionado(s)' : '';
    var all = $('#bn-selall'); if (all) all.checked = n > 0 && n === ST.list.length;
  }

  // ---- Crear --------------------------------------------------------------------------
  function openCreate(opts) {
    opts = opts || {};
    var s = ST.settings || { tipos: ['pallet'] };
    var html = '<div class="form"><p class="hint" style="margin:0">Cada Bin recibe un número correlativo (' + esc(s.prefix || 'BIN-') + '…) que nunca se reutiliza. Nace EN ARMADO: luego recibes o pasas stock a él, lo cierras y lo ubicas con un escaneo.</p>'
      + '<div class="row2"><div class="fld"><label>Cantidad de Bins</label><input id="bc-n" type="number" min="1" max="500" value="' + (opts.n || 1) + '"></div>'
      + '<div class="fld"><label>Tipo</label><select id="bc-tipo">' + (s.tipos || ['pallet']).map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('') + '</select></div></div>'
      + '<div class="fld"><label>Ubicación inicial (opcional)</label><input id="bc-loc" placeholder="Código, ej. RECV-01" value="' + esc(opts.ubicacion || '') + '"></div>'
      + '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="bc-print" checked style="width:auto"> Imprimir sus etiquetas al crear</label>'
      + '<div class="ferr" id="bc-err"></div><div class="acts"><span class="hint"></span><div style="display:flex;gap:10px"><button class="btn" id="bc-cancel">Cancelar</button><button class="btn pri" id="bc-ok">Crear</button></div></div></div>';
    C.openModal('Crear Bins', html);
    $('#bc-cancel').addEventListener('click', C.closeModal);
    $('#bc-ok').addEventListener('click', function () {
      var b = this; b.disabled = true;
      post('/bins', { cantidad: parseInt($('#bc-n').value, 10) || 1, tipo: $('#bc-tipo').value, ubicacion: $('#bc-loc').value.trim() || undefined })
        .then(function (r) {
          C.closeModal(); C.toast(r.creados === 1 ? 'Bin ' + r.bins[0].numero + ' creado' : r.creados + ' Bins creados');
          if ($('#bc-print') ? $('#bc-print').checked : true) imprimirEtiquetas(r.bins.map(function (x) { return x.id; }));
          if (opts.onCreated) opts.onCreated(r.bins); else cargar();
        }).catch(function (e) { b.disabled = false; $('#bc-err').textContent = e.message; });
    });
  }

  // ---- Detalle ------------------------------------------------------------------------
  function openDetail(ref) {
    C.api('/bins/' + encodeURIComponent(ref) + '?' + opq()).then(function (d) { pintarDetalle(d); }).catch(err);
  }
  function pintarDetalle(d) {
    var e = d.estado, mover = puedeMover() && interno();
    var acts = [];
    if (mover) {
      if (e === 'EN_ARMADO') { acts.push(['close', 'Cerrar Bin', 'pri']); acts.push(['add', 'Pasar stock suelto']); }
      if (e === 'POR_UBICAR') { acts.push(['putaway', 'Ubicar (putaway)', 'pri']); acts.push(['reopen', 'Reabrir']); acts.push(['movetask', 'Crear tarea de putaway/traslado']); }
      if (e === 'UBICADO') { acts.push(['move', 'Mover', 'pri']); acts.push(['movetask', 'Mover como tarea']); acts.push(['transfer', 'Transferir / dividir']); acts.push(['add', 'Pasar stock suelto']); acts.push(['remove', 'Sacar a suelto']); acts.push(['count', 'Contar']); acts.push(['presence', 'Validar presencia']); acts.push(['unpack', 'Desarmar', 'danger']); }
      if (e === 'EN_MOVIMIENTO') {
        if (d.pendiente && d.pendiente.tipo === 'CONSOLIDATE' && !d.pending.intoBinId) acts.push(['consexec', 'Ejecutar consolidación', 'pri']);
        else if (d.pendiente && d.pendiente.tipo === 'MOVE') acts.push(['putaway', 'Ejecutar traslado', 'pri']);
        else acts.push(['putaway', 'Terminar putaway', 'pri']);
        if (d.pendiente) acts.push(['cancel', 'Cancelar trabajo pendiente', 'danger']);
      }
      if (e === 'VACIO') { acts.push(['add', 'Pasar stock suelto']); acts.push(['delete', 'Eliminar', 'danger']); }
      if (e === 'EN_ARMADO' && !d.unidades) acts.push(['delete', 'Eliminar', 'danger']);
    }
    acts.push(['print', '🖨 Etiqueta']);
    var lineas = d.lineasDesc || [];
    var tabla = lineas.length ? '<div class="tablewrap"><table><thead><tr>' + (interno() ? '<th>Cliente</th>' : '') + '<th>SKU</th><th>Descripción</th><th>Lote</th><th>Vence</th><th class="num">Cantidad</th><th class="num">Reservada</th><th class="num">Disponible</th></tr></thead><tbody>'
      + lineas.map(function (l) { return '<tr>' + (interno() ? '<td>' + esc(l.cliente) + '</td>' : '') + '<td class="sku">' + esc(l.sku) + '</td><td class="muted">' + esc(l.descripcion || '—') + '</td><td class="mono2">' + esc(l.lot || '—') + '</td><td>' + esc(l.vencimiento ? String(l.vencimiento).slice(0, 10) : '—') + '</td><td class="num"><b>' + l.cantidad + '</b></td><td class="num">' + l.reservada + '</td><td class="num">' + l.disponible + '</td></tr>'; }).join('')
      + '</tbody></table></div>' : '<div class="empty">Sin contenido.</div>';
    var hist = (d.historial || []).slice().reverse().slice(0, 60).map(function (h) {
      var mov = h.tipo.indexOf('MOV:') === 0;
      var txt = mov ? (h.qty > 0 ? '+' : '') + h.qty + ' ' + esc(h.sku) + (h.lot ? ' · ' + esc(h.lot) : '') + (h.ubicacion ? ' · ' + esc(h.ubicacion) : '') + (h.cliente && interno() ? ' · ' + esc(h.cliente) : '') + (h.detalle ? ' · <span class="muted">' + esc(h.detalle) + '</span>' : '') : esc(h.detalle || '');
      return '<li><div class="te">' + esc(mov ? h.tipo.slice(4) : h.tipo) + '</div><div class="tw">' + esc(fecha(h.at)) + ' · ' + esc(h.hechoPor || '') + '</div>' + (txt ? '<div class="td">' + txt + '</div>' : '') + '</li>';
    }).join('');
    var info = '<div class="kv"><span>Estado</span><b>' + chip(e, d.estadoTexto) + '</b></div>'
      + '<div class="kv"><span>Ubicación</span><b>' + (d.ubicacion ? '<span class="loc-chip">' + esc(d.ubicacion) + '</span>' : 'sin ubicación') + '</b></div>'
      + '<div class="kv"><span>Tipo</span><b>' + esc(d.tipo) + '</b></div>'
      + '<div class="kv"><span>Clientes</span><b>' + (d.multiCliente ? '<span class="chip st-RESERVED" style="font-size:10.5px">Multi-cliente</span> ' : '') + esc((d.clientes || []).map(function (c) { return d.clientesNombre[c] || c; }).join(', ') || '—') + '</b></div>'
      + '<div class="kv"><span>Contenido</span><b>' + d.unidades + ' un · ' + d.skus + ' SKU' + (d.reservadas ? ' · ' + d.reservadas + ' reservadas' : '') + '</b></div>'
      + (d.receiptId ? '<div class="kv"><span>Recepción de origen</span><b class="mono2">' + esc(d.receiptId) + '</b></div>' : '')
      + (d.consolidadoEn ? '<div class="kv"><span>Consolidado en</span><b><a href="#" data-bngo="' + esc(d.consolidatedIntoId) + '">' + esc(d.consolidadoEn) + '</a></b></div>' : '')
      + (d.pendiente ? '<div class="kv"><span>Pendiente</span><b>' + (d.pendiente.tipo === 'MOVE' ? 'Traslado' + (d.pendiente.destino ? ' → ' + esc(d.pendiente.destino) : '') : 'Consolidación' + (d.pendiente.origenes.length ? ' de ' + esc(d.pendiente.origenes.join(', ')) : '')) + ' · pedido por ' + esc(d.pendiente.pedidoPor) + '</b></div>' : '')
      + (d.tarea ? '<div class="kv"><span>Tarea</span><b>' + esc(d.tarea.operario) + ' (' + (d.tarea.estado === 'in_progress' ? 'en curso' : 'asignada') + ')</b></div>' : '')
      + '<div class="kv"><span>Creado</span><b>' + esc(fecha(d.createdAt)) + '</b></div>';
    var html = '<div class="form" style="gap:14px">'
      + '<div style="display:flex;gap:8px;flex-wrap:wrap">' + acts.map(function (a) { return '<button class="btn ' + (a[2] || '') + '" data-bnact="' + a[0] + '" style="padding:7px 12px">' + esc(a[1]) + '</button>'; }).join('') + '</div>'
      + '<div class="card" style="padding:12px">' + info + '</div>'
      + '<h4 style="margin:4px 0 0">Contenido</h4>' + tabla
      + '<h4 style="margin:4px 0 0">Historial</h4><ul class="timeline" style="max-height:300px;overflow:auto">' + (hist || '<li class="muted">Sin eventos.</li>') + '</ul></div>';
    C.openModal('Bin ' + d.numero, html, 'xl');
    $$('#m-body [data-bngo]').forEach(function (a) { a.addEventListener('click', function (ev) { ev.preventDefault(); openDetail(a.getAttribute('data-bngo')); }); });
    $$('#m-body [data-bnact]').forEach(function (b) { b.addEventListener('click', function () { accion(b.getAttribute('data-bnact'), d); }); });
  }

  function refrescar(d, msg) { if (msg) C.toast(msg); openDetail(d.id); cargar(); }

  function elegirUbicacion(d, titulo, cb, opts) {
    opts = opts || {};
    C.api('/bins/' + encodeURIComponent(d.id) + '/suggest?' + opq()).catch(function () { return []; }).then(function (sug) {
      var html = '<div class="form"><p class="hint" style="margin:0">' + esc(opts.ayuda || 'Todo el contenido del Bin queda en la ubicación elegida con un solo movimiento. Las reservas de órdenes en curso lo siguen.') + '</p>'
        + (sug.length ? '<div class="fld"><label>Sugeridas por el sistema</label><div style="display:flex;gap:8px;flex-wrap:wrap">' + sug.map(function (s) { return '<button class="btn" data-bnsug="' + esc(s.code) + '" title="' + esc(s.motivo) + '">★ ' + esc(s.code) + '</button>'; }).join('') + '</div></div>' : '')
        + '<div class="fld"><label>Ubicación destino</label><input id="bu-loc" placeholder="Código o escanea" value="' + esc(sug[0] ? sug[0].code : '') + '"></div>'
        + (opts.tarea ? '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="bu-sin" style="width:auto"> Sin destino (lo elige el operario)</label>' : '')
        + '<div class="ferr" id="bu-err"></div><div class="acts"><span class="hint"></span><div style="display:flex;gap:10px"><button class="btn" id="bu-cancel">Volver</button><button class="btn pri" id="bu-ok">' + esc(opts.boton || 'Confirmar') + '</button></div></div></div>';
      C.openModal(titulo + ' — ' + d.numero, html);
      $$('#m-body [data-bnsug]').forEach(function (b) { b.addEventListener('click', function () { $('#bu-loc').value = b.getAttribute('data-bnsug'); }); });
      $('#bu-cancel').addEventListener('click', function () { openDetail(d.id); });
      $('#bu-ok').addEventListener('click', function () {
        var sin = $('#bu-sin') && $('#bu-sin').checked, loc = $('#bu-loc').value.trim();
        if (!loc && !sin) { $('#bu-err').textContent = 'Indica la ubicación destino.'; return; }
        this.disabled = true; var btn = this;
        cb(sin ? null : loc).catch(function (e) { btn.disabled = false; $('#bu-err').textContent = e.message; });
      });
    });
  }

  function itemsForm(d, titulo, opts, cb) {
    var lineas = (d.lineasDesc || []).filter(function (l) { return opts.todas || l.disponible > 0; });
    var html = '<div class="form"><p class="hint" style="margin:0">' + esc(opts.ayuda) + '</p>'
      + (opts.extra || '')
      + (lineas.length ? '<div class="tablewrap"><table><thead><tr><th>Cliente</th><th>SKU</th><th>Lote</th><th class="num">' + (opts.colMax || 'Disponible') + '</th><th class="num" style="width:110px">' + esc(opts.colQty || 'Cantidad') + '</th></tr></thead><tbody>'
        + lineas.map(function (l, i) { return '<tr><td>' + esc(l.cliente) + '</td><td class="sku">' + esc(l.sku) + '</td><td class="mono2">' + esc(l.lot || '—') + '</td><td class="num">' + (opts.todas ? l.cantidad : l.disponible) + '</td><td><input type="number" min="0" data-bni="' + i + '" value="' + (opts.prefill ? (opts.todas ? l.cantidad : l.disponible) : 0) + '" style="width:100%"></td></tr>'; }).join('') + '</tbody></table></div>' : '<div class="empty">No hay contenido disponible (lo reservado no se mueve por línea).</div>')
      + '<div class="ferr" id="bi-err"></div><div class="acts"><span class="hint"></span><div style="display:flex;gap:10px"><button class="btn" id="bi-cancel">Volver</button><button class="btn pri" id="bi-ok">' + esc(opts.boton || 'Confirmar') + '</button></div></div></div>';
    C.openModal(titulo + ' — ' + d.numero, html, true);
    $('#bi-cancel').addEventListener('click', function () { openDetail(d.id); });
    $('#bi-ok').addEventListener('click', function () {
      var items = [];
      $$('#m-body [data-bni]').forEach(function (inp) { var q = parseInt(inp.value, 10); var l = lineas[+inp.getAttribute('data-bni')]; if (q > 0 || (opts.ceros && !isNaN(q))) items.push({ sellerId: l.sellerId, sku: l.sku, lot: l.lot || null, qty: q || 0 }); });
      if (!items.length && !opts.ceros) { $('#bi-err').textContent = 'Indica al menos una cantidad.'; return; }
      var btn = this; btn.disabled = true;
      cb(items).catch(function (e) { btn.disabled = false; $('#bi-err').textContent = e.message; });
    });
  }

  function accion(a, d) {
    var R = encodeURIComponent(d.id);
    if (a === 'print') { imprimirEtiquetas([d.id]); return; }
    if (a === 'close') { post('/bins/' + R + '/close').then(function (r) { refrescar(d, 'Bin cerrado: queda POR UBICAR con su tarea de putaway' + (r.sugerencias && r.sugerencias[0] ? ' (sugerida ' + r.sugerencias[0].code + ')' : '')); }).catch(err); return; }
    if (a === 'reopen') { post('/bins/' + R + '/reopen').then(function () { refrescar(d, 'Bin reabierto'); }).catch(err); return; }
    if (a === 'putaway' || a === 'move') { elegirUbicacion(d, a === 'move' ? 'Mover Bin' : 'Ubicar Bin', function (loc) { return post('/bins/' + R + '/putaway', { destino: loc }).then(function (r) { refrescar(d, 'Bin en ' + loc + (r.ordenesReubicadas ? ' · ' + r.ordenesReubicadas + ' orden(es) con reservas reubicadas' : '')); }); }, { boton: a === 'move' ? 'Mover ahora' : 'Ubicar' }); return; }
    if (a === 'movetask') { elegirUbicacion(d, 'Tarea de traslado', function (loc) { return post('/bins/' + R + '/move', { destino: loc, comoTarea: true }).then(function () { refrescar(d, 'Tarea de traslado creada: el Bin queda EN MOVIMIENTO'); }); }, { tarea: true, boton: 'Crear tarea', ayuda: 'El Bin queda EN MOVIMIENTO (bloqueado para otros movimientos) y la tarea entra a la cola de los operarios.' }); return; }
    if (a === 'cancel') { post('/bins/' + R + '/cancel-pending').then(function () { refrescar(d, 'Trabajo pendiente cancelado'); }).catch(err); return; }
    if (a === 'consexec') { post('/bins/' + R + '/consolidate-execute').then(function () { refrescar(d, 'Consolidación ejecutada'); }).catch(err); return; }
    if (a === 'delete') { C.api('/bins/' + R + '?' + opq(), { method: 'DELETE' }).then(function () { C.closeModal(); C.toast('Bin eliminado'); cargar(); }).catch(err); return; }
    if (a === 'unpack') {
      var html = '<div class="form"><p class="hint" style="margin:0">Desarmar: TODO el contenido pasa a stock suelto en ' + esc(d.ubicacion || 'su ubicación') + ' (o a otro Bin) y el Bin queda eliminado. Nunca se pierde stock. No se puede si tiene reservas.</p><div class="fld"><label>Pasar el contenido a otro Bin (opcional)</label><input id="bd-to" placeholder="Número de Bin destino (vacío = suelto)"></div><div class="ferr" id="bd-err"></div><div class="acts"><span class="hint"></span><div style="display:flex;gap:10px"><button class="btn" id="bd-cancel">Volver</button><button class="btn danger" id="bd-ok">Desarmar y eliminar</button></div></div></div>';
      C.openModal('Desarmar ' + d.numero, html);
      $('#bd-cancel').addEventListener('click', function () { openDetail(d.id); });
      $('#bd-ok').addEventListener('click', function () { post('/bins/' + R + '/unpack', { haciaBin: $('#bd-to').value.trim() || null }).then(function (r) { C.closeModal(); C.toast(r.unidades + ' un → ' + r.destino); cargar(); }).catch(function (e) { $('#bd-err').textContent = e.message; }); });
      return;
    }
    if (a === 'remove') { itemsForm(d, 'Sacar a stock suelto', { ayuda: 'Lo indicado sale del Bin y queda suelto en ' + (d.ubicacion || 'su ubicación') + '.', boton: 'Sacar' }, function (items) { return post('/bins/' + R + '/remove', { items: items }).then(function () { refrescar(d, 'Contenido pasado a stock suelto'); }); }); return; }
    if (a === 'transfer') {
      itemsForm(d, 'Transferir / dividir', { ayuda: 'Las cantidades indicadas pasan a otro Bin en la misma ubicación. Sin número de destino se crea un Bin nuevo (dividir).', boton: 'Transferir', extra: '<div class="fld"><label>Bin destino</label><input id="bt-to" placeholder="Número (vacío = Bin nuevo)"></div>' },
        function (items) { return post('/bins/transfer', { desde: d.id, hacia: ($('#bt-to').value || '').trim() || 'nuevo', items: items }).then(function (r) { refrescar(d, r.unidades + ' un → ' + r.hacia.numero); }); });
      return;
    }
    if (a === 'count') {
      itemsForm(d, 'Contar Bin', { todas: true, prefill: false, ceros: true, colMax: 'Teórico', colQty: 'Contado', boton: 'Registrar conteo', ayuda: 'Cuenta TODO lo físico del Bin (incluye lo reservado). Lo que no cuentes se toma como 0. Las diferencias se ajustan con el motivo y quedan en el historial.', extra: '<div class="fld"><label>Motivo de las diferencias</label><input id="bk-mot" placeholder="Ej: merma, error de recepción"></div>' },
        function (items) { return post('/bins/' + R + '/count', { lineas: items, motivo: ($('#bk-mot').value || '').trim() || null }).then(function (r) { refrescar(d, r.exacto ? 'Conteo exacto: sin diferencias' : r.diferencias.length + ' diferencia(s) ajustada(s)'); }); });
      return;
    }
    if (a === 'presence') {
      var h2 = '<div class="form"><p class="hint" style="margin:0">Conteo rápido: confirma que el Bin está donde dice el sistema (' + esc(d.ubicacion || '—') + ').</p><div class="fld"><label>Ubicación donde lo encontraste</label><input id="bp-loc" value="' + esc(d.ubicacion || '') + '"></div><div class="ferr" id="bp-err"></div><div class="acts"><span class="hint"></span><div style="display:flex;gap:10px"><button class="btn" id="bp-cancel">Volver</button><button class="btn pri" id="bp-ok">Validar</button></div></div></div>';
      C.openModal('Validar presencia — ' + d.numero, h2);
      $('#bp-cancel').addEventListener('click', function () { openDetail(d.id); });
      $('#bp-ok').addEventListener('click', function () { post('/bins/' + R + '/presence', { ubicacion: $('#bp-loc').value.trim() }).then(function (r) { refrescar(d, r.ok ? 'Confirmado en ' + r.encontrado : 'Atención: el sistema lo tiene en ' + (r.esperado || '—') + ' y está en ' + r.encontrado); }).catch(function (e) { $('#bp-err').textContent = e.message; }); });
      return;
    }
    if (a === 'add') {
      var sellers = C.getSellers();
      var h3 = '<div class="form"><p class="hint" style="margin:0">Pasa stock SUELTO de una ubicación a este Bin. El stock debe estar donde está el Bin' + (d.ubicacion ? ' (' + esc(d.ubicacion) + ')' : '') + '.</p>'
        + '<div class="row2"><div class="fld"><label>Ubicación del stock</label><input id="ba-loc" value="' + esc(d.ubicacion || '') + '"></div><div class="fld"><label>Cliente</label><select id="ba-cli">' + sellers.map(function (s) { return '<option value="' + esc(s.id) + '">' + esc(s.name) + '</option>'; }).join('') + '</select></div></div>'
        + '<div class="row2"><div class="fld"><label>SKU</label><input id="ba-sku"></div><div class="fld"><label>Lote (si aplica)</label><input id="ba-lot"></div></div>'
        + '<div class="fld"><label>Cantidad</label><input id="ba-qty" type="number" min="1" value="1"></div>'
        + '<div class="ferr" id="ba-err"></div><div class="acts"><span class="hint"></span><div style="display:flex;gap:10px"><button class="btn" id="ba-cancel">Volver</button><button class="btn pri" id="ba-ok">Pasar al Bin</button></div></div></div>';
      C.openModal('Pasar stock suelto — ' + d.numero, h3);
      $('#ba-cancel').addEventListener('click', function () { openDetail(d.id); });
      $('#ba-ok').addEventListener('click', function () {
        post('/bins/' + R + '/add', { ubicacion: $('#ba-loc').value.trim(), items: [{ sellerId: $('#ba-cli').value, sku: $('#ba-sku').value.trim(), lot: $('#ba-lot').value.trim() || null, qty: parseInt($('#ba-qty').value, 10) || 0 }] })
          .then(function () { refrescar(d, 'Stock pasado al Bin'); }).catch(function (e) { $('#ba-err').textContent = e.message; });
      });
    }
  }

  // ---- Consolidar ---------------------------------------------------------------------
  function openConsolidate() {
    var sel = seleccion();
    if (sel.length < 2) { C.toast('Selecciona al menos 2 Bins para consolidar'); return; }
    var locs = {}; sel.forEach(function (b) { locs[b.ubicacion || '—'] = 1; });
    var distintas = Object.keys(locs).length > 1;
    var html = '<div class="form"><p class="hint" style="margin:0">Todo el contenido de los Bins origen pasa al destino, agrupado por cliente + SKU + lote (nunca se mezclan líneas de clientes distintos). Los origen quedan CONSOLIDADOS. Las reservas activas viajan al destino.</p>'
      + '<div class="fld"><label>Bin destino</label><select id="bk-dst"><option value="">＋ Un Bin nuevo</option>' + sel.map(function (b) { return '<option value="' + esc(b.id) + '">' + esc(b.numero) + ' · ' + b.unidades + ' un · ' + esc(b.ubicacion || 'sin ubicación') + '</option>'; }).join('') + '</select></div>'
      + (distintas ? '<div class="apprv-box warn"><div class="hint">Están en ubicaciones distintas (' + esc(Object.keys(locs).join(', ')) + '): se creará una <b>tarea</b> para que un operario los junte; hasta entonces quedan EN MOVIMIENTO.</div></div>' : '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="bk-task" style="width:auto"> Hacerlo como tarea (si no, se ejecuta ahora)</label>')
      + '<div class="ferr" id="bk-err"></div><div class="acts"><span class="hint">' + sel.length + ' Bins</span><div style="display:flex;gap:10px"><button class="btn" id="bk-cancel">Cancelar</button><button class="btn pri" id="bk-ok">Consolidar</button></div></div></div>';
    C.openModal('Consolidar Bins', html);
    $('#bk-cancel').addEventListener('click', C.closeModal);
    $('#bk-ok').addEventListener('click', function () {
      var dst = $('#bk-dst').value || null;
      var origenes = sel.filter(function (b) { return b.id !== dst; }).map(function (b) { return b.id; });
      post('/bins/consolidate', { origenes: origenes, destino: dst, comoTarea: !!($('#bk-task') && $('#bk-task').checked) })
        .then(function (r) { C.closeModal(); ST.sel = {}; C.toast(r.ejecutada ? 'Consolidado en ' + r.destino.numero : 'Tarea de consolidación creada hacia ' + r.destino.numero); cargar(); })
        .catch(function (e) { $('#bk-err').textContent = e.message; });
    });
  }

  // ---- Ajustes ------------------------------------------------------------------------
  function openSettings() {
    var s = ST.settings || {};
    var ck = function (id, v, t) { return '<label style="display:flex;gap:8px;align-items:center"><input type="checkbox" id="' + id + '" ' + (v ? 'checked' : '') + ' style="width:auto"> ' + t + '</label>'; };
    var html = '<div class="form">'
      + ck('bs-on', s.habilitado !== false, '<b>Bins activos en esta operación</b> <span class="hint">— apagado, el WMS funciona exactamente como siempre</span>')
      + (s.planIncluye === false ? '<div class="apprv-box warn"><div class="hint">Tu plan no incluye Bins: mejora el plan para activarlos.</div></div>' : '')
      + '<div class="row2"><div class="fld"><label>Prefijo de numeración</label><input id="bs-pre" value="' + esc(s.prefix || 'BIN-') + '"></div><div class="fld"><label>Dígitos</label><input id="bs-dig" type="number" min="3" max="10" value="' + (s.digits || 6) + '"></div></div>'
      + '<div class="fld"><label>Tipos de Bin (separados por coma)</label><input id="bs-tipos" value="' + esc((s.tipos || []).join(', ')) + '"></div>'
      + ck('bs-del', s.deleteOnEmpty, 'Al vaciarse por picking, <b>eliminar</b> el Bin (si no, queda VACÍO para reutilizarlo)')
      + '<div class="row2"><div class="fld"><label>Alerta: por ubicar más de (h)</label><input id="bs-apu" type="number" min="0" value="' + (s.alertPorUbicarHoras != null ? s.alertPorUbicarHoras : 4) + '"></div><div class="fld"><label>Alerta: en armado sin cerrar (h)</label><input id="bs-aar" type="number" min="0" value="' + (s.alertArmadoHoras != null ? s.alertArmadoHoras : 12) + '"></div></div>'
      + '<div class="row2"><div class="fld"><label>Baja ocupación (menos de N un)</label><input id="bs-baja" type="number" min="0" value="' + (s.bajaOcupacionUnidades != null ? s.bajaOcupacionUnidades : 10) + '"></div>'
      + '<div class="fld"><label>Prorrateo del almacenaje en Bins compartidos</label><select id="bs-pro"><option value="unidades">Por unidades</option><option value="volumen">Por volumen (medidas del SKU)</option><option value="peso">Por peso (medidas del SKU)</option><option value="iguales">A partes iguales</option></select></div></div>'
      + ck('bs-etc', s.etiquetaMostrarContenido !== false, 'Mostrar un resumen del contenido en la etiqueta')
      + ck('bs-etm', s.etiquetaOcultarContenidoMulti !== false, '…pero ocultarlo en Bins multi-cliente')
      + '<p class="hint" style="margin:0">Las alertas del agente («Bin por ubicar» y «Bin en armado abandonado») se activan y ajustan en Agente → Reglas.</p>'
      + '<div class="ferr" id="bs-err"></div><div class="acts"><span class="hint"></span><div style="display:flex;gap:10px"><button class="btn" id="bs-cancel">Cancelar</button><button class="btn pri" id="bs-ok">Guardar</button></div></div></div>';
    C.openModal('Ajustes de Bins', html, true);
    $('#bs-pro').value = s.prorrateo || 'unidades';
    $('#bs-cancel').addEventListener('click', C.closeModal);
    $('#bs-ok').addEventListener('click', function () {
      var body = { operationId: C.getOp(), habilitado: $('#bs-on').checked, prefix: $('#bs-pre').value.trim(), digits: parseInt($('#bs-dig').value, 10), tipos: $('#bs-tipos').value, deleteOnEmpty: $('#bs-del').checked,
        alertPorUbicarHoras: parseFloat($('#bs-apu').value), alertArmadoHoras: parseFloat($('#bs-aar').value), bajaOcupacionUnidades: parseInt($('#bs-baja').value, 10), prorrateo: $('#bs-pro').value,
        etiquetaMostrarContenido: $('#bs-etc').checked, etiquetaOcultarContenidoMulti: $('#bs-etm').checked };
      C.api('/bins/settings', { method: 'PATCH', body: body }).then(function () { C.closeModal(); C.toast('Ajustes de Bins guardados'); render(); }).catch(function (e) { $('#bs-err').textContent = e.message; });
    });
  }

  // ---- Vista de ubicación: Bins y stock suelto por separado -----------------------------
  function openLocation(loc) {
    var sellers = C.getSellers();
    var pBins = C.api('/bins?' + opq() + '&ubicacion=' + encodeURIComponent(loc.code)).catch(function () { return { bins: [] }; });
    var pStock = Promise.all(sellers.map(function (s) { return C.api('/sellers/' + encodeURIComponent(s.id) + '/inventory?locationId=' + encodeURIComponent(loc.id)).then(function (rows) { return { s: s, rows: rows || [] }; }).catch(function () { return { s: s, rows: [] }; }); }));
    Promise.all([pBins, pStock]).then(function (r) {
      var bins = r[0].bins || [];
      var sueltos = [];
      r[1].forEach(function (x) { x.rows.forEach(function (b) { if (!b.binId && b.qty) sueltos.push({ cliente: x.s.name, sku: b.sku, lot: b.lot, state: b.state, qty: b.qty }); }); });
      var totB = bins.reduce(function (t, b) { return t + b.unidades; }, 0), totS = sueltos.reduce(function (t, b) { return t + b.qty; }, 0);
      var html = '<div class="form" style="gap:12px"><div class="muted">Total en ' + esc(loc.code) + ': <b>' + (totB + totS) + ' un</b> = ' + totS + ' suelto + ' + totB + ' en ' + bins.length + ' Bin(s).</div>'
        + '<h4 style="margin:0">Bins en esta ubicación</h4>'
        + (bins.length ? '<div class="tablewrap"><table><thead><tr><th>Bin</th><th>Estado</th><th>Clientes</th><th class="num">Unidades</th></tr></thead><tbody>' + bins.map(function (b) { return '<tr><td class="mono2"><a href="#" data-bnopen="' + esc(b.id) + '">' + esc(b.numero) + '</a></td><td>' + chip(b.estado, b.estadoTexto) + '</td><td>' + esc(b.multiCliente ? 'Multi-cliente' : (b.clientesNombre || []).join(', ')) + '</td><td class="num">' + b.unidades + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<div class="empty">Sin Bins.</div>')
        + '<h4 style="margin:0">Stock suelto</h4>'
        + (sueltos.length ? '<div class="tablewrap"><table><thead><tr><th>Cliente</th><th>SKU</th><th>Lote</th><th>Estado</th><th class="num">Cantidad</th></tr></thead><tbody>' + sueltos.map(function (b) { return '<tr><td>' + esc(b.cliente) + '</td><td class="sku">' + esc(b.sku) + '</td><td class="mono2">' + esc(b.lot || '—') + '</td><td><span class="chip st-' + b.state + '"><span class="dot"></span>' + esc(b.state) + '</span></td><td class="num">' + b.qty + '</td></tr>'; }).join('') + '</tbody></table></div>' : '<div class="empty">Sin stock suelto.</div>')
        + '</div>';
      C.openModal('Contenido de ' + loc.code, html, true);
      $$('#m-body [data-bnopen]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); openDetail(a.getAttribute('data-bnopen')); }); });
    });
  }

  // ---- Recepción hacia Bin (panel): selector + «Nuevo Bin» -------------------------------
  /** HTML del selector de Bin para el cotejo de una recepción. */
  function receiptBinPicker() {
    return '<div class="card" id="ct-binbox" style="padding:12px;margin-bottom:10px;display:none"><div style="display:flex;gap:10px;align-items:flex-end;flex-wrap:wrap">'
      + '<div class="fld" style="flex:1;min-width:200px"><label>Recibir dentro de un Bin (opcional)</label><select id="ct-bin"><option value="">— Stock suelto (sin Bin) —</option></select></div>'
      + '<button class="btn" id="ct-binnew" type="button">＋ Nuevo Bin</button>'
      + '<label style="display:flex;gap:6px;align-items:center;margin-bottom:6px"><input type="checkbox" id="ct-binclose" style="width:auto"> Cerrar el Bin al confirmar</label></div>'
      + '<div class="hint" style="margin-top:4px">Todo lo contado en esta entrega entra al Bin elegido. Al cerrarlo queda POR UBICAR y se genera su tarea de putaway.</div></div>';
  }
  function wireReceiptBinPicker() {
    var box = $('#ct-binbox'); if (!box || !interno()) return;
    C.api('/bins/settings?' + opq()).then(function (s) {
      if (s.habilitado === false || s.planIncluye === false) return;
      box.style.display = '';
      var cargarSel = function (sel) {
        C.api('/bins?' + opq() + '&estado=EN_ARMADO').then(function (r) {
          var opts = '<option value="">— Stock suelto (sin Bin) —</option>' + (r.bins || []).map(function (b) { return '<option value="' + esc(b.numero) + '">' + esc(b.numero) + ' · ' + b.unidades + ' un' + (b.ubicacion ? ' · ' + esc(b.ubicacion) : '') + '</option>'; }).join('');
          $('#ct-bin').innerHTML = opts; if (sel) $('#ct-bin').value = sel;
        });
      };
      cargarSel();
      $('#ct-binnew').addEventListener('click', function () {
        post('/bins', { cantidad: 1 }).then(function (r) { C.toast('Bin ' + r.bins[0].numero + ' creado'); imprimirEtiquetas([r.bins[0].id]); cargarSel(r.bins[0].numero); }).catch(err);
      });
    }).catch(function () {});
  }
  function receiptBinValue() { var s = $('#ct-bin'); return s && s.value ? s.value : null; }
  function afterReceiptReceived(binNum) {
    if (binNum && $('#ct-binclose') && $('#ct-binclose').checked) return post('/bins/' + encodeURIComponent(binNum) + '/close').then(function () { C.toast('Bin ' + binNum + ' cerrado: queda POR UBICAR'); }).catch(err);
    return Promise.resolve();
  }

  function wire() {
    if (!$('.page[data-pg="bins"]')) return;
    var cli = $('#bn-cli');
    if (cli) cli.addEventListener('change', function () { ST.filtros.sellerId = cli.value; cargar(); });
    var est = $('#bn-est'); if (est) { est.innerHTML = ESTADOS.map(function (e) { return '<option value="' + e[0] + '">' + esc(e[1]) + '</option>'; }).join(''); est.addEventListener('change', function () { ST.filtros.estado = est.value; cargar(); }); }
    var deb = null;
    [['#bn-loc', 'ubicacion'], ['#bn-sku', 'sku'], ['#bn-q', 'q']].forEach(function (p) {
      var el = $(p[0]); if (!el) return;
      el.addEventListener('input', function () { ST.filtros[p[1]] = el.value.trim(); clearTimeout(deb); deb = setTimeout(cargar, 350); });
    });
    var q = $('#bn-q');
    if (q) q.addEventListener('keydown', function (e) { if (e.key === 'Enter' && q.value.trim()) { e.preventDefault(); openDetail(q.value.trim()); } });
    var b = $('#bn-new'); if (b) b.addEventListener('click', function () { openCreate(); });
    b = $('#bn-print'); if (b) b.addEventListener('click', function () { imprimirEtiquetas(seleccion().map(function (x) { return x.id; })); });
    b = $('#bn-cons'); if (b) b.addEventListener('click', openConsolidate);
    b = $('#bn-settings'); if (b) b.addEventListener('click', openSettings);
    b = $('#bn-selall'); if (b) b.addEventListener('change', function () { var on = this.checked; ST.sel = {}; if (on) ST.list.forEach(function (x) { ST.sel[x.id] = true; }); $$('#bn-body [data-bnsel]').forEach(function (c) { c.checked = on; }); syncSel(); });
  }

  window.NinjaBins = {
    init: function (ctx) { C = ctx; if (!ST.wired) { ST.wired = true; wire(); } },
    render: render,
    openDetail: openDetail,
    openLocation: openLocation,
    receiptBinPicker: receiptBinPicker,
    wireReceiptBinPicker: wireReceiptBinPicker,
    receiptBinValue: receiptBinValue,
    afterReceiptReceived: afterReceiptReceived,
    code128svg: code128svg,
  };
})();
