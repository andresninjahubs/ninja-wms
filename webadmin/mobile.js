/* Ninja WMS — Comportamiento del panel en pantallas pequeñas (≤ 860 px).
 *  - Cajón de navegación (hamburguesa ☰, fondo, cierre al navegar / Esc / tocar fuera).
 *  - Botón de contexto en la barra superior que despliega buscador, operación, cliente y sesión,
 *    y muestra el cliente activo cuando está plegado.
 *  - Tablas → tarjetas: etiqueta cada celda con el texto de su cabecera (data-label) para que el
 *    CSS las apile. Se re-aplica automáticamente cuando el panel vuelve a dibujar una tabla.
 * No cambia nada en escritorio: todo se activa solo cuando la media query coincide.
 */
(function(){
  "use strict";
  var mq=window.matchMedia('(max-width: 860px)');
  var $=function(s,r){return (r||document).querySelector(s);};
  var $$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));};
  var isMobile=function(){return mq.matches;};

  // ---- Cajón de navegación --------------------------------------------------
  var side, backdrop, menuBtn, ctxBtn, topbar;
  function openNav(){ document.body.classList.add('nav-open'); if(menuBtn)menuBtn.setAttribute('aria-expanded','true'); }
  function closeNav(){ document.body.classList.remove('nav-open'); if(menuBtn)menuBtn.setAttribute('aria-expanded','false'); }
  function toggleNav(){ document.body.classList.contains('nav-open')?closeNav():openNav(); }

  function mount(){
    side=$('.side'); topbar=$('.topbar'); if(!side||!topbar)return;
    // Fondo oscurecido + cabecera del cajón con botón cerrar
    backdrop=document.createElement('div'); backdrop.className='m-backdrop'; backdrop.addEventListener('click',closeNav); document.body.appendChild(backdrop);
    var brand=$('.brand',side);
    if(brand){
      var head=document.createElement('div'); head.className='m-side-head'; head.hidden=!isMobile();
      brand.parentNode.insertBefore(head,brand); head.appendChild(brand);
      var x=document.createElement('button'); x.className='m-close'; x.type='button'; x.setAttribute('aria-label','Cerrar menú'); x.textContent='✕'; x.addEventListener('click',closeNav); head.appendChild(x);
    }
    // Hamburguesa
    menuBtn=document.createElement('button'); menuBtn.className='m-menu'; menuBtn.type='button'; menuBtn.setAttribute('aria-label','Abrir menú'); menuBtn.innerHTML='☰'; menuBtn.hidden=!isMobile();
    menuBtn.addEventListener('click',toggleNav); topbar.insertBefore(menuBtn,topbar.firstChild);
    // Botón de contexto (cliente activo ▾)
    ctxBtn=document.createElement('button'); ctxBtn.className='m-ctx'; ctxBtn.type='button'; ctxBtn.hidden=!isMobile();
    ctxBtn.innerHTML='<span class="av" id="m-ctx-av">·</span><span class="t" id="m-ctx-t">Contexto</span><span class="car">▾</span>';
    ctxBtn.addEventListener('click',function(){ topbar.classList.toggle('ctx-open'); });
    var who=$('.who',topbar); topbar.insertBefore(ctxBtn, who||null);
    // Cerrar el cajón al elegir una sección
    side.addEventListener('click',function(e){ if(e.target.closest('.nav, .navlearn') && isMobile()) setTimeout(closeNav,60); });
    document.addEventListener('keydown',function(e){ if(e.key==='Escape')closeNav(); });
    // Al cambiar operación/cliente, actualizamos el chip y plegamos el panel de contexto
    ['#seller','#op'].forEach(function(s){ var el=$(s); if(el)el.addEventListener('change',function(){ syncCtx(); setTimeout(function(){ topbar.classList.remove('ctx-open'); },150); }); });
    var lg=$('#btn-logout'); if(lg)lg.addEventListener('click',function(){ topbar.classList.remove('ctx-open'); closeNav(); });
    // Observamos cambios del DOM para re-etiquetar tablas y refrescar el chip
    var timer=null;
    new MutationObserver(function(){ if(timer)return; timer=setTimeout(function(){ timer=null; if(isMobile()){ labelTables(); syncCtx(); } },120); })
      .observe(document.body,{childList:true,subtree:true});
    mq.addEventListener?mq.addEventListener('change',onChange):mq.addListener(onChange);
    onChange();
  }
  function onChange(){
    var m=isMobile();
    if(menuBtn)menuBtn.hidden=!m; if(ctxBtn)ctxBtn.hidden=!m; var h=$('.m-side-head'); if(h)h.hidden=!m;
    if(!m){ closeNav(); topbar.classList.remove('ctx-open'); unlabelTables(); } else { labelTables(); syncCtx(); }
  }
  function syncCtx(){
    if(!ctxBtn)return;
    var sel=$('#seller'), opSel=$('#op'), nm=$('#who-av');
    var t='Contexto';
    if(sel&&sel.options.length&&sel.selectedIndex>=0){ t=sel.options[sel.selectedIndex].text||t; }
    else if(opSel&&opSel.options.length&&opSel.selectedIndex>=0){ t=opSel.options[opSel.selectedIndex].text||t; }
    var tt=$('#m-ctx-t'), av=$('#m-ctx-av'); if(tt&&tt.textContent!==t)tt.textContent=t; if(av&&nm)av.textContent=nm.textContent||'·';
  }

  // ---- Tablas → tarjetas ----------------------------------------------------
  function labelTables(){
    $$('.content table').forEach(function(t){
      if(t.classList.contains('pkg')||t.classList.contains('m-skip'))return;
      var ths=$$('thead th',t); if(!ths.length)return;
      var labels=ths.map(function(th){ return th.hasAttribute('data-action')?'':(th.textContent||'').trim(); });
      t.classList.add('m-cards');
      $$('tbody tr, tfoot tr',t).forEach(function(tr){
        var i=0;
        $$('td',tr).forEach(function(td){
          var span=parseInt(td.getAttribute('colspan')||'1',10);
          var lbl=labels[i]!=null?labels[i]:'';
          if(td.getAttribute('data-label')!==lbl)td.setAttribute('data-label',lbl);
          td.classList.toggle('m-first',i===0&&span===1&&!td.querySelector('.rowacts,button'));
          td.classList.toggle('m-actions',(ths[i]&&ths[i].hasAttribute('data-action'))||!!td.querySelector('.rowacts'));
          i+=span;
        });
      });
    });
  }
  function unlabelTables(){ $$('.content table.m-cards').forEach(function(t){ t.classList.remove('m-cards'); }); }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount); else mount();
})();
