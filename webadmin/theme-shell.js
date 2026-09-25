/* Ninja WMS — Comportamiento del esqueleto renovado (menú y barra superior).
 * Independiente de app.js: solo lee y toca el DOM. Tres piezas:
 *  1) Botón de modo oscuro (#theme-toggle): alterna data-theme en <html> y lo
 *     recuerda en localStorage 'wms.admin.theme'. El <head> lo aplica antes de pintar.
 *  2) Atajo "Carga tus órdenes" (#side-upload): abre Órdenes y luego la carga masiva
 *     (#ord-import). Se esconde si ese botón no existe o está oculto para el rol.
 *  3) Tooltip (title) de cada ítem del menú, para el modo colapsado a solo íconos.
 *  4) Contador de la categoría plegada: refleja los badges de sus ítems en la cabecera.
 */
(function(){
  "use strict";
  var KEY='wms.admin.theme';
  var root=document.documentElement;
  var $=function(s,r){return (r||document).querySelector(s);};
  var $$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));};

  // ---- 1) Modo oscuro -------------------------------------------------------
  // Si nadie eligió, manda el sistema: se lee el tema efectivo para decidir el siguiente.
  function efectivo(){
    var t=root.getAttribute('data-theme');
    if(t==='dark'||t==='light')return t;
    try{ return window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'; }catch(e){ return 'light'; }
  }
  function pintaTema(){
    var b=$('#theme-toggle'); if(!b)return;
    var dark=efectivo()==='dark';
    b.setAttribute('aria-pressed',dark?'true':'false');
    b.title=dark?'Modo claro':'Modo oscuro';
    b.setAttribute('aria-label',b.title);
  }
  function alternaTema(){
    var next=efectivo()==='dark'?'light':'dark';
    root.setAttribute('data-theme',next);
    try{ localStorage.setItem(KEY,next); }catch(e){}
    pintaTema();
  }

  // ---- 2) Carga tus órdenes -------------------------------------------------
  function visible(el){ return !!el && !el.classList.contains('hidden') && !el.hidden; }
  function syncUpload(){
    var box=$('#side-account'); if(!box)return;
    var imp=$('#ord-import'), navOrd=$('.nav[data-pg="orders"]');
    box.hidden=!(visible(imp) && visible(navOrd));
  }
  function cargaOrdenes(){
    var navOrd=$('.nav[data-pg="orders"]'); if(!navOrd)return;
    navOrd.click();
    // go() es síncrono, pero damos un respiro para que la página quede pintada.
    setTimeout(function(){ var imp=$('#ord-import'); if(visible(imp))imp.click(); },60);
  }

  // ---- 3) Tooltips del menú -------------------------------------------------
  // El texto de cada ítem pasa a title para que el menú colapsado (solo íconos)
  // siga diciendo qué es cada botón.
  function tooltips(){
    $$('.side .nav, .side .navcat-h, .side .navlearn, .side .navout').forEach(function(b){
      if(b.getAttribute('title'))return;
      var t=(b.textContent||'').replace(/\s+/g,' ').trim(); if(t)b.setAttribute('title',t);
    });
  }


  // ---- 4) Badges con la categoría plegada -----------------------------------
  // Las categorías del menú nacen plegadas: un contador (#nav-counts, #nav-chat,
  // #nav-agente) quedaría escondido. Se refleja la suma en la cabecera de la
  // categoría (.navcat-badge), que solo se ve mientras está plegada.
  function badgeVisible(b){
    if(!b||b.style.display==='none')return false;
    var n=b.closest('.nav'); if(n&&(n.classList.contains('hidden')||n.hidden))return false;
    return !!(b.textContent||'').trim();
  }
  function syncCatBadges(){
    $$('.side .navcat').forEach(function(cat){
      var h=$('.navcat-h',cat); if(!h)return;
      var tot=0,plus=false,any=false;
      $$('.navcat-body .badge',cat).forEach(function(b){
        if(!badgeVisible(b))return; any=true;
        var t=(b.textContent||'').trim(), v=parseInt(t,10);
        if(/\+$/.test(t))plus=true; if(!isNaN(v))tot+=v;
      });
      var el=$('.navcat-badge',h);
      if(!any){ if(el)el.hidden=true; return; }
      if(!el){
        el=document.createElement('span'); el.className='navcat-badge';
        var arr=$('.navcat-arrow',h); h.insertBefore(el,arr||null);
      }
      var txt=tot>99||plus?(tot>99?'99+':tot+'+'):(tot?String(tot):'•');
      if(el.textContent!==txt)el.textContent=txt;
      el.hidden=false;
    });
  }
  function watchBadges(){
    var t=null, sch=function(){ if(t)return; t=setTimeout(function(){t=null;syncCatBadges();},30); };
    var mo=new MutationObserver(sch);
    $$('.side .navcat-body .badge').forEach(function(b){
      mo.observe(b,{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['style','class','hidden']});
      var n=b.closest('.nav'); if(n)mo.observe(n,{attributes:true,attributeFilter:['class','hidden']});
    });
    syncCatBadges();
  }

  function mount(){
    var tb=$('#theme-toggle'); if(tb)tb.addEventListener('click',alternaTema);
    pintaTema();
    try{
      var mq=window.matchMedia('(prefers-color-scheme: dark)');
      var f=function(){ pintaTema(); };
      mq.addEventListener?mq.addEventListener('change',f):mq.addListener(f);
    }catch(e){}

    var up=$('#side-upload'); if(up)up.addEventListener('click',cargaOrdenes);
    syncUpload();
    // El rol se conoce tras el login: app.js cambia la clase "hidden" de #ord-import y
    // de los .nav, y oculta #loginov. Observamos esos tres puntos.
    var mo=new MutationObserver(syncUpload);
    var imp=$('#ord-import'); if(imp)mo.observe(imp,{attributes:true,attributeFilter:['class','hidden']});
    var nav=$('.nav[data-pg="orders"]'); if(nav)mo.observe(nav,{attributes:true,attributeFilter:['class']});
    var lg=$('#loginov'); if(lg)mo.observe(lg,{attributes:true,attributeFilter:['class']});

    tooltips();
    watchBadges();
    onPrimary();
  }
  // Texto sobre el color de marca: oscuro si la marca es clara, blanco si es oscura.
  // applyOperationBranding cambia --primary en el root; lo seguimos con un observer.
  function onPrimary(){
    function lum(c){var m=c.match(/\d+(\.\d+)?/g);if(!m||m.length<3)return 1;var v=m.slice(0,3).map(function(x){x=+x/255;return x<=.03928?x/12.92:Math.pow((x+.055)/1.055,2.4)});return .2126*v[0]+.7152*v[1]+.0722*v[2]}
    function sync(){try{var p=document.createElement('span');p.style.cssText='color:var(--primary);display:none';document.body.appendChild(p);var L=lum(getComputedStyle(p).color);p.remove();var v=((L+.05)/.0565)>=(1.05/(L+.05))?'#0B1220':'#FFFFFF',r=document.documentElement.style;if(r.getPropertyValue('--on-primary')!==v)r.setProperty('--on-primary',v)}catch(e){}}
    sync();new MutationObserver(sync).observe(document.documentElement,{attributes:true,attributeFilter:['style','class','data-theme']});
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount); else mount();
})();
