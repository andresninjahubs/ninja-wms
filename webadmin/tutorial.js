/* Ninja WMS — Tutoriales guiados por sección ("video" interactivo sobre la interfaz real).
 *
 * Motor de tours: resalta cada elemento paso a paso, narra en voz (Web Speech API),
 * avanza solo (modo video), permite pausar, retroceder, saltar y ver el video MP4 de
 * la sección. Se ofrece automáticamente la primera vez que el usuario entra a una
 * sección y siempre queda disponible desde el botón «▶ Tutorial» del encabezado y
 * el «Centro de aprendizaje» del menú.
 *
 * El contenido de cada sección vive en tutorial-guides.js (window.NINJA_TOUR_GUIDES).
 * API pública: window.NinjaTour = { start(pg, opts), onPage(pg), openCenter(), openVideo(pg),
 *                                   has(pg), setContext({go, getRole}), runAll(pgs, opts) }
 */
(function(){
  "use strict";
  var $=function(s,r){return (r||document).querySelector(s);};
  var $$=function(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s));};
  var LS_SEEN="nwms.tour.seen.v1", LS_AUTO="nwms.tour.auto", LS_VOICE="nwms.tour.voice";
  var GUIDES=function(){return window.NINJA_TOUR_GUIDES||{};};
  var ctx={go:null,getRole:null,isHidden:null};
  var videoManifest=null; // {pg:{file,duration}} — se carga desde videos/manifest.json

  // ===== Preferencias persistidas (por navegador) ============================
  function lsGet(k,d){try{var v=localStorage.getItem(k);return v==null?d:JSON.parse(v);}catch(e){return d;}}
  function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v));}catch(e){}}
  function seen(){return lsGet(LS_SEEN,{});}
  function markSeen(pg){var s=seen();s[pg]=Date.now();lsSet(LS_SEEN,s);syncTopBtn();}
  function autoOn(){return lsGet(LS_AUTO,true)!==false;}
  function voiceOn(){return lsGet(LS_VOICE,true)!==false && ('speechSynthesis' in window) && !!voice;}

  // ===== Estilos (inyectados para que el módulo sea autocontenido) ===========
  var CSS=''
  +'.nt-root{position:fixed;inset:0;z-index:90;pointer-events:none;font-family:"Manrope","Inter",system-ui,sans-serif}'
  +'.nt-root.on{pointer-events:auto}'
  +'.nt-blocker{position:absolute;inset:0}'
  +'.nt-spot{position:fixed;border-radius:14px;box-shadow:0 0 0 9999px rgba(6,14,18,.62),0 0 0 3px rgba(46,224,160,.95),0 0 32px 6px rgba(46,224,160,.35);transition:top .45s cubic-bezier(.2,.8,.2,1),left .45s cubic-bezier(.2,.8,.2,1),width .45s cubic-bezier(.2,.8,.2,1),height .45s cubic-bezier(.2,.8,.2,1),border-radius .3s;pointer-events:none}'
  +'.nt-spot.none{box-shadow:0 0 0 9999px rgba(6,14,18,.66)}'
  +'.nt-spot:after{content:"";position:absolute;inset:-3px;border-radius:inherit;border:2px solid rgba(46,224,160,.7);animation:nt-pulse 1.6s ease-out infinite}'
  +'.nt-spot.none:after{display:none}'
  +'@keyframes nt-pulse{0%{transform:scale(1);opacity:.9}100%{transform:scale(1.06);opacity:0}}'
  +'.nt-card{position:fixed;width:400px;max-width:calc(100vw - 24px);background:var(--surface,#fff);color:var(--ink,#0F1B17);border:1px solid var(--line,#E7EEEE);border-radius:18px;box-shadow:0 10px 30px -10px rgba(0,0,0,.35),0 40px 80px -30px rgba(0,0,0,.45);padding:18px 20px 14px;transition:top .45s cubic-bezier(.2,.8,.2,1),left .45s cubic-bezier(.2,.8,.2,1),opacity .25s;opacity:0;transform:translateY(6px);animation:nt-in .35s .05s forwards}'
  +'@keyframes nt-in{to{opacity:1;transform:none}}'
  +'.nt-card .nt-arrow{position:absolute;width:16px;height:16px;background:var(--surface,#fff);border-left:1px solid var(--line,#E7EEEE);border-top:1px solid var(--line,#E7EEEE);transform:rotate(45deg)}'
  +'.nt-card.p-bottom .nt-arrow{top:-9px}.nt-card.p-top .nt-arrow{bottom:-9px;transform:rotate(225deg)}.nt-card.p-right .nt-arrow{left:-9px;transform:rotate(-45deg)}.nt-card.p-left .nt-arrow{right:-9px;transform:rotate(135deg)}.nt-card.p-center .nt-arrow{display:none}'
  +'.nt-card.center{width:520px;left:50%!important;top:50%!important;transform:translate(-50%,-50%)!important;padding:28px 30px 22px;text-align:center;animation:nt-in-c .4s forwards}'
  +'@keyframes nt-in-c{from{opacity:0;transform:translate(-50%,-46%)}to{opacity:1;transform:translate(-50%,-50%)}}'
  +'.nt-kicker{display:flex;align-items:center;gap:8px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3,#7C8B90);font-weight:700;margin-bottom:8px}'
  +'.nt-kicker .nt-chip{background:var(--primary-wash,#E4F7EE);color:var(--primary-ink,#0E8F55);border-radius:999px;padding:3px 9px;font-size:11px;letter-spacing:0;text-transform:none}'
  +'.nt-kicker .sp{flex:1}'
  +'.nt-title{font-family:"Sora",sans-serif;font-weight:800;font-size:17px;line-height:1.25;margin:0 0 6px}'
  +'.nt-card.center .nt-title{font-size:24px;margin-bottom:10px}'
  +'.nt-text{font-size:14px;line-height:1.55;color:var(--ink-2,#46565A);margin:0}'
  +'.nt-text b{color:var(--ink,#0F1B17)}'
  +'.nt-card.center .nt-text{font-size:15px}'
  +'.nt-icon{width:72px;height:72px;border-radius:22px;margin:0 auto 14px;background:var(--aurora,linear-gradient(120deg,#12B76A,#0EA5A5 52%,#7C6BF0 118%));display:flex;align-items:center;justify-content:center;font-size:34px;color:#fff;box-shadow:0 16px 30px -12px rgba(14,165,165,.6)}'
  +'.nt-prog{height:4px;border-radius:999px;background:var(--surface-2,#EFF4F5);margin:14px 0 10px;overflow:hidden}'
  +'.nt-prog i{display:block;height:100%;width:0;background:var(--aurora-2,linear-gradient(135deg,#12B76A,#0EA5A5));border-radius:999px}'
  +'.nt-dots{display:flex;gap:5px;justify-content:center;margin:12px 0 10px}'
  +'.nt-dots i{width:6px;height:6px;border-radius:50%;background:var(--line-2,#D6E0E0);transition:.2s}.nt-dots i.on{width:18px;border-radius:999px;background:var(--primary,#12B76A)}.nt-dots i.done{background:var(--primary,#12B76A);opacity:.5}'
  +'.nt-ctl{display:flex;align-items:center;gap:6px}'
  +'.nt-ctl .sp{flex:1}'
  +'.nt-ib{width:36px;height:36px;border-radius:10px;border:1px solid var(--line,#E7EEEE);background:var(--surface,#fff);color:var(--ink,#0F1B17);font-size:15px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.12s}'
  +'.nt-ib:hover{background:var(--surface-2,#EFF4F5)}.nt-ib:disabled{opacity:.35;cursor:default}'
  +'.nt-ib.pri{background:var(--aurora,#12B76A);color:#fff;border-color:transparent;width:42px;height:42px;border-radius:12px;font-size:17px;box-shadow:0 8px 18px -8px rgba(14,165,165,.6)}'
  +'.nt-ib.off{opacity:.5;text-decoration:line-through}'
  +'.nt-link{background:none;border:0;color:var(--ink-3,#7C8B90);font-size:12.5px;cursor:pointer;padding:6px 4px}.nt-link:hover{color:var(--ink,#0F1B17)}'
  +'.nt-btn{font-size:13.5px;font-weight:700;padding:11px 18px;border-radius:12px;border:1px solid var(--line,#E7EEEE);background:var(--surface,#fff);color:var(--ink,#0F1B17);cursor:pointer;transition:.12s}'
  +'.nt-btn:hover{background:var(--surface-2,#EFF4F5)}'
  +'.nt-btn.pri{background:var(--aurora,#12B76A);color:#fff;border-color:transparent;box-shadow:0 8px 18px -8px rgba(14,165,165,.6)}'
  +'.nt-btn.pri:hover{transform:translateY(-1px)}'
  +'.nt-actions{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:18px}'
  +'.nt-meta{display:flex;gap:14px;justify-content:center;margin-top:12px;font-size:12px;color:var(--ink-3,#7C8B90)}'
  +'.nt-meta span{display:flex;align-items:center;gap:5px}'
  +'.nt-list{text-align:left;margin:14px auto 0;max-width:400px;display:flex;flex-direction:column;gap:6px}'
  +'.nt-list div{display:flex;gap:9px;align-items:flex-start;font-size:13.5px;color:var(--ink-2,#46565A)}'
  +'.nt-list div:before{content:"✓";color:var(--primary,#12B76A);font-weight:800;flex:none}'
  +'.nt-sub{font-size:12.5px;color:var(--ink-3,#7C8B90);margin-top:10px}'
  +'.nt-hint{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);font-size:11.5px;color:#fff;opacity:.75;pointer-events:none;letter-spacing:.02em}'
  +'.nt-hint kbd{border:1px solid rgba(255,255,255,.4);border-radius:5px;padding:1px 6px;font-family:inherit;font-size:10.5px;margin:0 2px}'
  /* botón del encabezado */
  +'.nt-topbtn{display:inline-flex;align-items:center;gap:7px;font-size:12.5px;font-weight:700;padding:8px 13px;border-radius:999px;border:1px solid var(--line,#E7EEEE);background:var(--surface,#fff);color:var(--ink,#0F1B17);cursor:pointer;position:relative;white-space:nowrap;transition:.12s}'
  +'.nt-topbtn:hover{border-color:var(--primary,#12B76A);color:var(--primary-ink,#0E8F55)}'
  +'.nt-topbtn .pl{width:20px;height:20px;border-radius:50%;background:var(--aurora,#12B76A);color:#fff;font-size:9px;display:flex;align-items:center;justify-content:center;padding-left:2px}'
  +'.nt-topbtn.new:after{content:"";position:absolute;top:-3px;right:-3px;width:10px;height:10px;border-radius:50%;background:var(--signal,#E38A17);box-shadow:0 0 0 2px var(--surface,#fff);animation:nt-blink 1.4s infinite}'
  +'@keyframes nt-blink{50%{opacity:.3}}'
  +'.nt-topbtn.hide{display:none}'
  +'@media (max-width:1560px){.nt-topbtn .lbl{display:none}.nt-topbtn{padding:5px;border-radius:50%}.nt-topbtn .pl{width:24px;height:24px}}'
  /* menú lateral */
  +'.navlearn{display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:9px 11px;border-radius:10px;border:1px dashed var(--line-2,#D6E0E0);background:transparent;color:var(--ink-2,#46565A);font-size:13.5px;font-weight:600;cursor:pointer;margin-top:6px;transition:.12s}'
  +'.navlearn:hover{background:var(--primary-wash,#E4F7EE);color:var(--primary-ink,#0E8F55);border-color:var(--primary,#12B76A)}'
  +'.navlearn .ic{width:18px;text-align:center}'
  +'.navlearn .cnt{margin-left:auto;font-size:10.5px;font-family:"IBM Plex Mono",monospace;color:var(--ink-3,#7C8B90)}'
  /* Centro de aprendizaje + video */
  +'.nt-center{position:fixed;inset:0;z-index:95;background:rgba(6,14,18,.6);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:20px;animation:nt-fade .2s}'
  +'@keyframes nt-fade{from{opacity:0}}'
  +'.nt-cpanel{width:min(980px,100%);max-height:92vh;overflow:auto;background:var(--bg,#F4F8F8);border:1px solid var(--line,#E7EEEE);border-radius:22px;box-shadow:0 40px 90px -30px rgba(0,0,0,.6);color:var(--ink,#0F1B17)}'
  +'.nt-chead{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:14px;padding:20px 26px 14px;background:var(--bg,#F4F8F8);border-bottom:1px solid var(--line,#E7EEEE)}'
  +'.nt-chead h2{font-family:"Sora",sans-serif;font-weight:800;font-size:22px;margin:0}'
  +'.nt-chead .d{font-size:13px;color:var(--ink-3,#7C8B90);margin-top:2px}'
  +'.nt-chead .x{margin-left:auto;width:36px;height:36px;border-radius:10px;border:1px solid var(--line,#E7EEEE);background:var(--surface,#fff);cursor:pointer;font-size:15px;color:var(--ink,#0F1B17)}'
  +'.nt-cbody{padding:16px 26px 26px}'
  +'.nt-hero{display:flex;gap:18px;align-items:center;background:var(--surface,#fff);border:1px solid var(--line,#E7EEEE);border-radius:16px;padding:16px 18px;margin-bottom:18px;flex-wrap:wrap}'
  +'.nt-hero .ring{width:64px;height:64px;border-radius:50%;background:conic-gradient(var(--primary,#12B76A) var(--p,0%),var(--surface-2,#EFF4F5) 0);display:flex;align-items:center;justify-content:center;flex:none}'
  +'.nt-hero .ring i{width:50px;height:50px;border-radius:50%;background:var(--surface,#fff);display:flex;align-items:center;justify-content:center;font-style:normal;font-family:"IBM Plex Mono",monospace;font-size:12px;font-weight:700}'
  +'.nt-hero .t{flex:1;min-width:200px}.nt-hero .t b{font-family:"Sora",sans-serif;font-size:15px}.nt-hero .t div{font-size:13px;color:var(--ink-3,#7C8B90);margin-top:2px}'
  +'.nt-toggles{display:flex;flex-direction:column;gap:6px;font-size:13px}'
  +'.nt-toggles label{display:flex;align-items:center;gap:8px;cursor:pointer}'
  +'.nt-toggles input{accent-color:var(--primary,#12B76A);width:16px;height:16px}'
  +'.nt-group{margin-top:18px}'
  +'.nt-group h4{font-family:"IBM Plex Mono",monospace;font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3,#7C8B90);margin:0 0 10px;font-weight:600}'
  +'.nt-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px}'
  +'.nt-tile{display:flex;gap:12px;align-items:center;background:var(--surface,#fff);border:1px solid var(--line,#E7EEEE);border-radius:14px;padding:12px 14px;transition:.12s}'
  +'.nt-tile:hover{border-color:var(--primary,#12B76A);box-shadow:0 12px 26px -16px rgba(14,165,165,.5)}'
  +'.nt-tile .ic{width:40px;height:40px;border-radius:12px;background:var(--surface-2,#EFF4F5);display:flex;align-items:center;justify-content:center;font-size:19px;flex:none}'
  +'.nt-tile.seen .ic{background:var(--primary-wash,#E4F7EE)}'
  +'.nt-tile .t{flex:1;min-width:0}.nt-tile .t b{display:block;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.nt-tile .t span{font-size:12px;color:var(--ink-3,#7C8B90)}'
  +'.nt-tile .a{display:flex;gap:5px}'
  +'.nt-tile .a button{width:34px;height:34px;border-radius:9px;border:1px solid var(--line,#E7EEEE);background:var(--surface,#fff);cursor:pointer;font-size:13px;color:var(--ink,#0F1B17)}'
  +'.nt-tile .a button:hover{background:var(--surface-2,#EFF4F5)}.nt-tile .a button.pri{background:var(--aurora,#12B76A);color:#fff;border-color:transparent}'
  +'.nt-tile .a button:disabled{opacity:.3;cursor:default}'
  +'.nt-tile .ok{font-size:11px;color:var(--good,#0F9D5B);font-weight:700}'
  +'.nt-vpanel{width:min(1040px,100%);background:#0A1016;border-radius:20px;overflow:hidden;box-shadow:0 40px 90px -30px rgba(0,0,0,.8);color:#EAF2F0}'
  +'.nt-vpanel video{display:block;width:100%;aspect-ratio:16/9;background:#000}'
  +'.nt-vbar{display:flex;align-items:center;gap:14px;padding:14px 18px;flex-wrap:wrap}'
  +'.nt-vbar b{font-family:"Sora",sans-serif;font-size:16px}.nt-vbar .d{font-size:12.5px;color:#AFBEC1}'
  +'.nt-vbar .sp{flex:1}'
  +'.nt-vbar button{font-size:12.5px;font-weight:700;padding:8px 13px;border-radius:10px;border:1px solid #31454E;background:#18242A;color:#EAF2F0;cursor:pointer}'
  +'.nt-vbar button.pri{background:linear-gradient(135deg,#16E0A0,#22C8D6);color:#062018;border-color:transparent}'
  +'.nt-vempty{padding:60px 20px;text-align:center;color:#AFBEC1;font-size:14px}'
  /* primera vez: aviso flotante */
  +'.nt-nudge{position:fixed;right:22px;bottom:22px;z-index:85;width:340px;max-width:calc(100vw - 30px);background:var(--surface,#fff);color:var(--ink,#0F1B17);border:1px solid var(--line,#E7EEEE);border-radius:16px;box-shadow:0 30px 60px -24px rgba(0,0,0,.5);padding:14px 16px;display:flex;gap:12px;align-items:center;animation:nt-up .35s}'
  +'@keyframes nt-up{from{opacity:0;transform:translateY(12px)}}'
  +'.nt-nudge .ic{width:40px;height:40px;border-radius:12px;background:var(--aurora,#12B76A);color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;flex:none}'
  +'.nt-nudge b{font-size:13.5px;display:block}.nt-nudge span{font-size:12px;color:var(--ink-3,#7C8B90)}'
  +'.nt-nudge .a{display:flex;flex-direction:column;gap:4px}'
  +'.nt-nudge .a button{font-size:12px;font-weight:700;padding:6px 10px;border-radius:8px;border:1px solid var(--line,#E7EEEE);background:var(--surface,#fff);cursor:pointer;color:var(--ink,#0F1B17)}'
  +'.nt-nudge .a button.pri{background:var(--aurora,#12B76A);color:#fff;border-color:transparent}'
  +'@media (max-width:760px){.nt-card{left:12px!important;right:12px;width:auto;top:auto!important;bottom:12px}.nt-card .nt-arrow{display:none}.nt-card.center{width:auto;left:12px!important;right:12px;transform:translateY(-50%)!important}.nt-hint{display:none}}'
  +'@media (prefers-reduced-motion:reduce){.nt-spot,.nt-card{transition:none}.nt-spot:after{animation:none}}';
  var st=document.createElement('style'); st.id='nt-style'; st.textContent=CSS; document.head.appendChild(st);

  // ===== Voz (narración) ======================================================
  var voice=null, voiceBroken=false; // voiceBroken: el navegador rechazó hablar (p. ej. sin activación del usuario)
  function pickVoice(){
    if(voiceBroken)return;
    try{
      var vs=window.speechSynthesis.getVoices()||[];
      voice=vs.find(function(v){return /es[-_]CL/i.test(v.lang);})
        ||vs.find(function(v){return /es[-_](419|MX|US|AR|CO)/i.test(v.lang);})
        ||vs.find(function(v){return /^es/i.test(v.lang);})||null;
    }catch(e){}
  }
  if('speechSynthesis' in window){ pickVoice(); try{window.speechSynthesis.onvoiceschanged=pickVoice;}catch(e){} }
  function stripHtml(h){var d=document.createElement('div');d.innerHTML=h;return (d.textContent||'').replace(/\s+/g,' ').trim();}
  function speak(text,onEnd){
    if(!voice)pickVoice();
    if(!('speechSynthesis' in window) || !voice){ if(onEnd)onEnd(); return null; }
    try{
      window.speechSynthesis.cancel();
      var u=new SpeechSynthesisUtterance(text);
      u.lang=(voice&&voice.lang)||'es-CL'; if(voice)u.voice=voice; u.rate=1.02; u.pitch=1;
      var done=false; function fin(err){ if(done)return; done=true; if(onEnd)onEnd(err); }
      u.onend=function(){fin(false);}; u.onerror=function(){fin(true);};
      window.speechSynthesis.speak(u);
      // Salvaguarda: algunos navegadores no disparan onend si se pausa la pestaña.
      var est=readMs(text)*1.8; setTimeout(function(){ if(!done && !window.speechSynthesis.speaking) fin(); }, est);
      return u;
    }catch(e){ if(onEnd)onEnd(); return null; }
  }
  function stopSpeak(){ if(!voice)return; try{ window.speechSynthesis && window.speechSynthesis.cancel(); }catch(e){} }
  function readMs(text){ return Math.max(3500, 70*String(text||'').length); } // ~14 caracteres/seg en español

  // ===== Motor del tour =======================================================
  var run=null; // estado del tour activo
  function isVisible(el){ if(!el)return false; var r=el.getBoundingClientRect(); return r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden'; }
  function resolve(sel){
    if(!sel)return null;
    var list=Array.isArray(sel)?sel:[sel];
    for(var i=0;i<list.length;i++){ var el=null; try{ el=document.querySelector(list[i]); }catch(e){} if(el&&isVisible(el))return el; }
    return null;
  }
  function stepsFor(pg){
    var g=GUIDES()[pg]; if(!g)return null;
    var role=ctx.getRole?ctx.getRole():null;
    return g.steps.filter(function(s){ return !s.roles || s.roles.indexOf(role)>=0; });
  }

  function summaryOf(g){ var role=ctx.getRole?ctx.getRole():null; return (role==='CLIENT'&&g.summaryClient)||g.summary; }
  function buildRoot(){
    var root=document.createElement('div'); root.className='nt-root on';
    root.innerHTML='<div class="nt-blocker"></div><div class="nt-spot none"></div><div class="nt-card p-center"><div class="nt-arrow"></div><div class="nt-body"></div></div><div class="nt-hint"><kbd>→</kbd> siguiente &nbsp; <kbd>←</kbd> anterior &nbsp; <kbd>espacio</kbd> pausa &nbsp; <kbd>Esc</kbd> salir</div>';
    document.body.appendChild(root);
    root.querySelector('.nt-blocker').addEventListener('click',function(){ if(run&&run.phase==='step')togglePause(); });
    return root;
  }

  function start(pg,opts){
    opts=opts||{};
    var g=GUIDES()[pg]; if(!g){ return Promise.resolve(false); }
    if(run) end(false);
    dismissNudge();
    var steps=stepsFor(pg);
    run={pg:pg,g:g,steps:steps,i:-1,phase:'intro',paused:false,record:!!opts.record,timings:opts.timings||null,log:[],recT0:performance.now(),auto:!!opts.auto,root:buildRoot(),timer:null,raf:null,resolveP:null,t0:0,dur:0,elapsed:0,cleanup:null};
    window.__ntLog=run.log; run.log.push({k:'intro',t:0});
    var p=new Promise(function(res){run.resolveP=res;});
    markSeen(pg);
    window.addEventListener('keydown',onKey,true);
    window.addEventListener('resize',relayout);
    window.addEventListener('scroll',relayout,true);
    renderIntro();
    if(run.record||opts.skipIntro){ setTimeout(function(){ if(run&&run.phase==='intro')beginSteps(); }, run.record?((run.timings&&run.timings.intro)||3800):0); }
    return p;
  }
  function end(finished){
    if(!run)return;
    stopSpeak(); clearTimer();
    if(run.cleanup){ try{run.cleanup();}catch(e){} run.cleanup=null; }
    window.removeEventListener('keydown',onKey,true);
    window.removeEventListener('resize',relayout);
    window.removeEventListener('scroll',relayout,true);
    var r=run; run=null;
    r.root.classList.remove('on'); r.root.style.opacity='0'; r.root.style.transition='opacity .25s';
    setTimeout(function(){ r.root.remove(); },260);
    if(r.resolveP)r.resolveP(!!finished);
  }
  function clearTimer(){ if(run&&run.timer){clearTimeout(run.timer);run.timer=null;} if(run&&run.raf){cancelAnimationFrame(run.raf);run.raf=null;} }

  function card(){ return run.root.querySelector('.nt-card'); }
  function body(){ return run.root.querySelector('.nt-body'); }
  function spot(){ return run.root.querySelector('.nt-spot'); }

  function renderIntro(){
    var g=run.g, n=run.steps.length, mins=Math.max(1,Math.round(run.steps.reduce(function(a,s){return a+readMs(stripHtml(s.text));},0)/60000));
    spot().className='nt-spot none';
    var c=card(); c.className='nt-card center p-center';
    body().innerHTML='<div class="nt-icon">'+(g.icon||'▶')+'</div>'
      +'<div class="nt-kicker" style="justify-content:center"><span class="nt-chip">Tutorial guiado</span></div>'
      +'<h3 class="nt-title">'+g.title+'</h3>'
      +'<p class="nt-text">'+summaryOf(g)+'</p>'
      +'<div class="nt-meta"><span>⏱ ≈ '+mins+' min</span><span>◎ '+n+' pasos</span>'+(voiceOn()?'<span>🔊 Con narración</span>':'')+'</div>'
      +'<div class="nt-actions"><button class="nt-btn pri" data-nt="begin">▶ Empezar</button>'+(hasVideo(run.pg)?'<button class="nt-btn" data-nt="video">🎬 Ver video</button>':'')+'<button class="nt-btn" data-nt="skip">Ahora no</button></div>'
      +(run.auto?'<div class="nt-sub">Se muestra porque es tu primera vez aquí. Siempre podrás volver desde «▶ Tutorial» arriba.</div>':'');
    bind();
    if(!run.record) speak(stripHtml(g.title+'. '+summaryOf(g)));
  }
  function beginSteps(){ run.phase='step'; run.i=-1; next(); }

  function renderOutro(){
    run.phase='outro'; clearTimer(); stopSpeak(); if(run.cleanup){try{run.cleanup();}catch(e){}run.cleanup=null;}
    var g=run.g;
    spot().className='nt-spot none';
    var c=card(); c.className='nt-card center p-center';
    var tips=(g.tips||[]).filter(function(t){ return typeof t==='string' || !(t.mod&&ctx.isHidden&&ctx.isHidden(t.mod)); }).map(function(t){return '<div>'+(typeof t==='string'?t:t.t)+'</div>';}).join('');
    body().innerHTML='<div class="nt-icon">🎉</div>'
      +'<h3 class="nt-title">¡Listo! Ya dominas '+g.title+'</h3>'
      +'<p class="nt-text">'+(g.outro||'Ahora puedes operar esta sección con autonomía. Si tienes dudas, vuelve a este tutorial cuando quieras.')+'</p>'
      +(tips?'<div class="nt-list">'+tips+'</div>':'')
      +'<div class="nt-actions">'+(hasVideo(run.pg)?'<button class="nt-btn pri" data-nt="video">🎬 Ver video de esta sección</button>':'')+'<button class="nt-btn" data-nt="center">🎓 Centro de aprendizaje</button><button class="nt-btn" data-nt="close">Cerrar</button></div>';
    bind();
    if(run.record){ run.log.push({k:'outro',t:performance.now()-run.recT0}); run.timer=setTimeout(function(){ end(true); },(run.timings&&run.timings.outro)||3200); }
    else speak(stripHtml('¡Listo! '+(g.outro||'Ya puedes operar esta sección con autonomía.')));
  }

  function next(){ if(!run)return; goStep(run.i+1); }
  function prev(){ if(!run)return; if(run.i<=0){ renderIntro(); run.phase='intro'; return; } goStep(run.i-1); }
  function goStep(i){
    if(!run)return;
    clearTimer(); stopSpeak();
    if(run.cleanup){ try{run.cleanup();}catch(e){} run.cleanup=null; }
    if(i>=run.steps.length){ renderOutro(); return; }
    run.i=i; run.phase='step'; run.paused=false; run.pendingNext=false;
    var s=run.steps[i];
    var helpers={click:function(sel){var el=resolve(sel);if(el){el.click();return true;}return false;},$:$,$$:$$};
    if(s.before){ try{ run.cleanup=s.before(helpers)||null; }catch(e){} }
    // Damos tiempo al DOM a reaccionar (pestañas, paneles) antes de medir.
    setTimeout(function(){ if(run&&run.i===i)showStep(s,i); }, s.before?260:0);
  }
  function showStep(s,i){
    var el=resolve(s.el);
    if(!el && s.el && !s.fallbackCenter){ // el elemento no existe para este rol/estado: se salta.
      next(); return;
    }
    if(el){ try{ el.scrollIntoView({block:'center',inline:'nearest',behavior:run.record?'smooth':'smooth'}); }catch(e){} }
    var text=s.text, plain=stripHtml(text);
    var c=card(); c.className='nt-card';
    body().innerHTML='<div class="nt-kicker"><span class="nt-chip">'+run.g.title+'</span><span class="sp"></span>Paso '+(i+1)+' de '+run.steps.length+'</div>'
      +'<h3 class="nt-title">'+s.title+'</h3>'
      +'<p class="nt-text">'+text+'</p>'
      +'<div class="nt-prog"><i></i></div>'
      +'<div class="nt-ctl">'
      +'<button class="nt-ib" data-nt="prev" title="Anterior">◀</button>'
      +'<button class="nt-ib pri" data-nt="pause" title="Pausar / reanudar">❚❚</button>'
      +'<button class="nt-ib" data-nt="next" title="Siguiente">▶</button>'
      +'<button class="nt-ib'+(voiceOn()?'':' off')+'" data-nt="voice" title="Narración por voz">🔊</button>'
      +'<span class="sp"></span>'
      +'<button class="nt-link" data-nt="skip">Saltar tutorial</button>'
      +'</div>';
    bind();
    setTimeout(function(){ if(run&&run.i===i)place(el,s.place); }, el?380:0);
    // Duración del paso: la voz manda; sin voz, un tiempo de lectura cómodo.
    run.dur=(run.record&&run.timings&&run.timings.steps&&run.timings.steps[i])||readMs(plain); run.elapsed=0; run.t0=performance.now();
    if(run.record)run.log.push({k:'step',i:i,t:performance.now()-run.recT0});
    if(!voice)pickVoice();
    if(!run.record && voiceOn() && voice){
      var tv=performance.now();
      speak(plain,function(err){
        if(!run||run.i!==i||run.phase!=='step')return;
        if(err && performance.now()-tv<600){ // el motor de voz falló al instante: seguimos por tiempo
          voiceBroken=true; voice=null; clearTimer(); run.t0=performance.now()-run.elapsed; tickProgress(i,false); return;
        }
        if(!run.paused){ setTimeout(function(){ if(run&&run.i===i&&!run.paused)next(); },500); }
        else run.pendingNext=true; // terminó de hablar en pausa: avanzamos al reanudar
      });
      tickProgress(i,true);
    } else {
      tickProgress(i,false);
    }
  }
  function tickProgress(i,voiceDriven){
    function frame(){
      if(!run||run.i!==i||run.phase!=='step')return;
      if(!run.paused){ run.elapsed=performance.now()-run.t0; }
      var pct=Math.min(100,run.elapsed/run.dur*100);
      var bar=run.root.querySelector('.nt-prog i'); if(bar)bar.style.width=pct+'%';
      if(!voiceDriven && !run.paused && run.elapsed>=run.dur){ next(); return; }
      run.raf=requestAnimationFrame(frame);
    }
    run.raf=requestAnimationFrame(frame);
  }
  function togglePause(){
    if(!run||run.phase!=='step')return;
    run.paused=!run.paused;
    var b=run.root.querySelector('[data-nt=pause]'); if(b)b.textContent=run.paused?'▶':'❚❚';
    if(run.paused){ if(voice)try{window.speechSynthesis.pause();}catch(e){} }
    else { run.t0=performance.now()-run.elapsed; if(voice)try{window.speechSynthesis.resume();}catch(e){} if(run.pendingNext){ run.pendingNext=false; next(); } }
  }
  function toggleVoice(){
    lsSet(LS_VOICE,!lsGet(LS_VOICE,true));
    var b=run&&run.root.querySelector('[data-nt=voice]'); if(b)b.classList.toggle('off',!voiceOn());
    if(run&&run.phase==='step'){ goStep(run.i); } else if(!voiceOn()) stopSpeak();
  }
  function place(el,pref){
    var c=card(), sp=spot(), pad=8;
    if(!el){ sp.className='nt-spot none'; sp.style.cssText='top:50%;left:50%;width:0;height:0'; c.className='nt-card p-center'; c.style.left='50%'; c.style.top='50%'; c.style.transform='translate(-50%,-50%)'; return; }
    var r=el.getBoundingClientRect();
    sp.className='nt-spot'; sp.style.cssText='top:'+(r.top-pad)+'px;left:'+(r.left-pad)+'px;width:'+(r.width+pad*2)+'px;height:'+(r.height+pad*2)+'px;border-radius:'+(Math.min(18,parseFloat(getComputedStyle(el).borderRadius)||0)+pad)+'px';
    c.style.transform='';
    var vw=window.innerWidth, vh=window.innerHeight, cw=c.offsetWidth||400, ch=c.offsetHeight||200, gap=18;
    var space={bottom:vh-r.bottom, top:r.top, right:vw-r.right, left:r.left};
    var order=pref?[pref]:[]; ['bottom','right','top','left'].forEach(function(p){ if(order.indexOf(p)<0)order.push(p); });
    var pos=null;
    for(var k=0;k<order.length;k++){
      var p=order[k];
      if(p==='bottom'&&space.bottom>=ch+gap){pos={p:p,top:r.bottom+gap,left:r.left+r.width/2-cw/2};break;}
      if(p==='top'&&space.top>=ch+gap){pos={p:p,top:r.top-gap-ch,left:r.left+r.width/2-cw/2};break;}
      if(p==='right'&&space.right>=cw+gap){pos={p:p,top:r.top+r.height/2-ch/2,left:r.right+gap};break;}
      if(p==='left'&&space.left>=cw+gap){pos={p:p,top:r.top+r.height/2-ch/2,left:r.left-gap-cw};break;}
    }
    if(!pos){ pos={p:'bottom',top:Math.min(vh-ch-12,r.bottom+gap),left:r.left+r.width/2-cw/2}; if(pos.top<12)pos.top=12; }
    pos.left=Math.max(12,Math.min(vw-cw-12,pos.left)); pos.top=Math.max(12,Math.min(vh-ch-12,pos.top));
    c.className='nt-card p-'+pos.p; c.style.left=pos.left+'px'; c.style.top=pos.top+'px';
    // flecha apuntando al centro del elemento
    var a=c.querySelector('.nt-arrow'); var cx=r.left+r.width/2-pos.left, cy=r.top+r.height/2-pos.top;
    if(pos.p==='bottom'||pos.p==='top'){ a.style.left=Math.max(16,Math.min(cw-32,cx-8))+'px'; a.style.top=''; }
    else { a.style.top=Math.max(16,Math.min(ch-32,cy-8))+'px'; a.style.left=''; }
  }
  function relayout(){ if(!run||run.phase!=='step')return; var s=run.steps[run.i]; if(!s)return; place(resolve(s.el),s.place); }

  function bind(){
    $$('[data-nt]',run.root).forEach(function(b){
      b.addEventListener('click',function(e){
        e.stopPropagation();
        var a=b.getAttribute('data-nt');
        if(a==='begin')beginSteps();
        else if(a==='skip'||a==='close')end(a==='close');
        else if(a==='next')next();
        else if(a==='prev')prev();
        else if(a==='pause')togglePause();
        else if(a==='voice')toggleVoice();
        else if(a==='video'){ var pg=run.pg; end(true); openVideo(pg); }
        else if(a==='center'){ end(true); openCenter(); }
      });
    });
  }
  function onKey(e){
    if(!run)return;
    if(e.key==='Escape'){ e.preventDefault(); end(false); }
    else if(e.key==='ArrowRight'){ e.preventDefault(); if(run.phase==='intro')beginSteps(); else if(run.phase==='step')next(); }
    else if(e.key==='ArrowLeft'){ e.preventDefault(); if(run.phase==='step')prev(); }
    else if(e.key===' '){ e.preventDefault(); if(run.phase==='intro')beginSteps(); else togglePause(); }
  }

  // ===== Primera vez: aviso automático ========================================
  var nudge=null, nudgeTimer=null, curPg=null;
  function dismissNudge(){ if(nudgeTimer){clearTimeout(nudgeTimer);nudgeTimer=null;} if(nudge){nudge.remove();nudge=null;} }
  function onPage(pg){
    curPg=pg; syncTopBtn();
    dismissNudge();
    if(run){ if(run.pg===pg||run.record)return; end(false); } // cambió de sección: cerramos el tour anterior
    if(!autoOn() || !GUIDES()[pg] || seen()[pg]) return;
    if($('#loginov') && !$('#loginov').classList.contains('off')) return;
    // Pequeña espera para que la sección cargue sus datos; luego se abre solo.
    nudgeTimer=setTimeout(function(){ nudgeTimer=null; if(curPg===pg && !run) start(pg,{auto:true}); }, 1100);
  }
  function syncTopBtn(){
    var b=$('#nt-topbtn'); if(!b)return;
    var has=!!(curPg&&GUIDES()[curPg]);
    b.classList.toggle('hide',!has);
    b.classList.toggle('new',has&&!seen()[curPg]);
    var c=$('#nt-navcenter .cnt'); if(c){ var all=availablePages(); var done=all.filter(function(p){return seen()[p];}).length; c.textContent=done+'/'+all.length; }
  }
  function availablePages(){
    var role=ctx.getRole?ctx.getRole():null, allowed=(window.NINJA_NAV_BY_ROLE&&role)?window.NINJA_NAV_BY_ROLE[role]:null;
    var extra=['ADMIN','SUPERVISOR','PLATFORM_ADMIN'].indexOf(role)>=0?['multicliente']:[];
    return Object.keys(GUIDES()).filter(function(p){ return (!allowed || allowed.indexOf(p)>=0 || extra.indexOf(p)>=0) && !(ctx.isHidden&&ctx.isHidden(p)); });
  }

  // ===== Videos MP4 ===========================================================
  function loadManifest(){
    if(videoManifest)return Promise.resolve(videoManifest);
    return fetch('videos/manifest.json',{cache:'no-cache'}).then(function(r){return r.ok?r.json():{};}).then(function(j){videoManifest=j||{};return videoManifest;}).catch(function(){videoManifest={};return videoManifest;});
  }
  function hasVideo(pg){ return !!(videoManifest&&videoManifest[pg]); }
  function openVideo(pg){
    var g=GUIDES()[pg]||{title:pg};
    var ov=document.createElement('div'); ov.className='nt-center';
    var v=videoManifest&&videoManifest[pg];
    ov.innerHTML='<div class="nt-vpanel">'
      +(v?'<video controls autoplay playsinline src="videos/'+v.file+'"></video>':'<div class="nt-vempty">El video de esta sección aún no está disponible. Puedes ver el tutorial interactivo.</div>')
      +'<div class="nt-vbar"><div><b>'+(g.icon||'')+' '+g.title+'</b><div class="d">'+(g.summary||'')+(v&&v.duration?' · '+v.duration:'')+'</div></div><span class="sp"></span>'
      +'<button class="pri" data-v="tour">▶ Tutorial interactivo</button><button data-v="close">Cerrar</button></div></div>';
    document.body.appendChild(ov);
    function close(){ var vid=ov.querySelector('video'); if(vid){try{vid.pause();}catch(e){}} ov.remove(); }
    ov.addEventListener('click',function(e){ if(e.target===ov)close(); });
    ov.querySelector('[data-v=close]').addEventListener('click',close);
    ov.querySelector('[data-v=tour]').addEventListener('click',function(){ close(); navTo(pg); setTimeout(function(){start(pg,{skipIntro:true});},450); });
  }

  // Navega a una sección (la vista «Todos los clientes» se activa desde el selector de cliente).
  function navTo(pg){
    if(curPg===pg)return;
    if(pg==='multicliente'){ var s=$('#seller'); if(s){ s.value='__all__'; s.dispatchEvent(new Event('change')); } return; }
    if(ctx.go)ctx.go(pg);
  }

  // ===== Centro de aprendizaje ================================================
  var GROUPS=[
    ['Inicio',['dashboard','copilot','voz','multicliente']],
    ['Workflows de bodega',['orders','pickqueue','inbound','returns','putaway','assembly','movements','counts']],
    ['Inventario y ubicaciones',['inventory','products','packaging','locations']],
    ['Negocio',['reports','billing','costos','plan']],
    ['Comunicación e integraciones',['chat','voicechannel','webhooks']],
    ['Administración',['activity','aiaudit','asignaciones','agente','branding','clients','users']],
    ['Plataforma',['pkgmatrix','operations','usage','announcements']]
  ];
  function openCenter(){
    loadManifest().then(function(){
      var avail=availablePages(), sn=seen(), G=GUIDES();
      var done=avail.filter(function(p){return sn[p];}).length, pct=avail.length?Math.round(done/avail.length*100):0;
      var ov=document.createElement('div'); ov.className='nt-center';
      var groups=GROUPS.map(function(gr){
        var items=gr[1].filter(function(p){return G[p]&&avail.indexOf(p)>=0;});
        if(!items.length)return '';
        return '<div class="nt-group"><h4>'+gr[0]+'</h4><div class="nt-grid">'+items.map(function(p){
          var g=G[p], s=!!sn[p];
          return '<div class="nt-tile'+(s?' seen':'')+'"><div class="ic">'+(g.icon||'▶')+'</div><div class="t"><b>'+g.title+'</b><span>'+(s?'<span class="ok">✓ Visto</span> · ':'')+g.steps.length+' pasos</span></div>'
            +'<div class="a"><button class="pri" data-tour="'+p+'" title="Tutorial interactivo">▶</button><button data-video="'+p+'" title="Ver video" '+(hasVideo(p)?'':'disabled')+'>🎬</button></div></div>';
        }).join('')+'</div></div>';
      }).join('');
      ov.innerHTML='<div class="nt-cpanel"><div class="nt-chead"><div><h2>🎓 Centro de aprendizaje</h2><div class="d">Un tutorial por sección: míralo como video o recórrelo paso a paso sobre la interfaz real.</div></div><button class="x" data-c="close">✕</button></div>'
        +'<div class="nt-cbody"><div class="nt-hero"><div class="ring" style="--p:'+pct+'%"><i>'+pct+'%</i></div><div class="t"><b>'+done+' de '+avail.length+' secciones recorridas</b><div>'+(done===avail.length&&avail.length?'¡Completaste todos los tutoriales disponibles para tu rol!':'Cada tutorial dura alrededor de un minuto. Puedes verlos en cualquier orden.')+'</div></div>'
        +'<div class="nt-toggles"><label><input type="checkbox" data-c="auto" '+(autoOn()?'checked':'')+'> Abrir el tutorial automáticamente la primera vez que entro a una sección</label>'
        +'<label><input type="checkbox" data-c="voice" '+(lsGet(LS_VOICE,true)?'checked':'')+' '+('speechSynthesis' in window?'':'disabled')+'> Narración por voz</label>'
        +'<button class="nt-link" data-c="reset" style="text-align:left;padding-left:0">↺ Reiniciar mi progreso</button></div></div>'
        +groups+'</div></div>';
      document.body.appendChild(ov);
      function close(){ ov.remove(); }
      ov.addEventListener('click',function(e){ if(e.target===ov)close(); });
      ov.querySelector('[data-c=close]').addEventListener('click',close);
      ov.querySelector('[data-c=auto]').addEventListener('change',function(e){ lsSet(LS_AUTO,!!e.target.checked); });
      ov.querySelector('[data-c=voice]').addEventListener('change',function(e){ lsSet(LS_VOICE,!!e.target.checked); });
      ov.querySelector('[data-c=reset]').addEventListener('click',function(){ lsSet(LS_SEEN,{}); close(); syncTopBtn(); openCenter(); });
      $$('[data-tour]',ov).forEach(function(b){ b.addEventListener('click',function(){ var p=b.getAttribute('data-tour'); close(); navTo(p); setTimeout(function(){start(p);},curPg===p?0:500); }); });
      $$('[data-video]',ov).forEach(function(b){ b.addEventListener('click',function(){ var p=b.getAttribute('data-video'); close(); openVideo(p); }); });
    });
  }

  // ===== Modo grabación (Playwright): recorre varias secciones sin voz ========
  function runAll(pgs,opts){
    opts=opts||{}; var out=[];
    return pgs.reduce(function(p,pg){ return p.then(function(){
      if(ctx.go)ctx.go(pg);
      return new Promise(function(r){setTimeout(r,opts.settleMs||1500);}).then(function(){ return start(pg,{record:true}); }).then(function(ok){ out.push({pg:pg,ok:ok}); });
    }); },Promise.resolve()).then(function(){return out;});
  }

  // ===== Enganches en la interfaz =============================================
  function mountUi(){
    var tb=$('#nt-topbtn'); if(tb)tb.addEventListener('click',function(){ if(curPg&&GUIDES()[curPg])start(curPg); else openCenter(); });
    var nc=$('#nt-navcenter'); if(nc)nc.addEventListener('click',openCenter);
    loadManifest();
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mountUi); else mountUi();

  window.NinjaTour={
    start:function(pg,opts){ return loadManifest().then(function(){ return start(pg,opts); }); },
    onPage:onPage, openCenter:openCenter, openVideo:openVideo,
    has:function(pg){return !!GUIDES()[pg];},
    setContext:function(c){ ctx.go=c.go||ctx.go; ctx.getRole=c.getRole||ctx.getRole; ctx.isHidden=c.isHidden||ctx.isHidden; syncTopBtn(); },
    runAll:runAll, isRunning:function(){return !!run;}, end:function(){end(false);}
  };
})();
