/* Panel de administración del WMS — CONECTADO a la API (mismo origen). */
(function(){
  "use strict";
  // Con raíz opcional: buscar dentro de un elemento, no solo en todo el documento.
  var $=function(s,raiz){return (raiz||document).querySelector(s);};
  var $$=function(s,raiz){return Array.prototype.slice.call((raiz||document).querySelectorAll(s));};
  var API=location.origin;

  var token=null, me=null, role=null, op=null, seller=null;
  var D={ ops:[], sellers:[], locations:[], users:[], opStock:{}, inv:[], ord:[], mov:[], plan:[], skus:[], packaging:[], acc:null };
  var locByCode={}, locById={}, ordFilter="ALL", inbFilter="ALL";
  // Etiquetas de estado de una orden de recepción (para chips de filtro).
  var REC_STL={PENDING:"Pendiente",PARTIAL:"Parcial",RECEIVED:"Recepcionada",CANCELLED:"Anulada"};

  var STN={RECEIVED:"Ingresada",ALLOCATED:"Reservada",PICKING:"En picking",PICKED:"Pickeada",PACKED:"Empacada",SHIPPED:"Despachada",CANCELLED:"Cancelada"};
  var LABELS={RECEIPT:"Recepción",PUTAWAY:"Guardado",TRANSFER:"Traslado",RESERVE:"Reserva",RELEASE:"Liberación",PICK:"Picking",SHIP:"Despacho",ADJUSTMENT:"Ajuste",RETURN:"Devolución",REACTIVATION:"Reactivación"};
  // Estados de una devolución (etiqueta legible).
  var RET_ST={PENDING:"Pendiente",PARTIAL:"Parcial",COMPLETED:"Completada",CANCELLED:"Anulada"};

  // ===== Ordenamiento de tablas (clic en la cabecera; ambos sentidos) =====
  // Cada <th data-tk="clave-tabla" data-sk="clave-columna"> se vuelve ordenable.
  // El texto ordena alfabético (con números naturales) y las fechas ISO por antigüedad.
  var _sort={};
  function sortRows(key, rows, cols){
    var s=_sort[key]; if(!s) return rows;
    var getv=cols[s.sk]; if(!getv) return rows.slice();
    return rows.slice().sort(function(a,b){
      var va=getv(a), vb=getv(b), r;
      if(typeof va==="number"||typeof vb==="number"){ r=(Number(va)||0)-(Number(vb)||0); }
      else { r=String(va==null?"":va).localeCompare(String(vb==null?"":vb),'es',{numeric:true,sensitivity:'base'}); }
      return r*s.dir;
    });
  }
  /** Fija el orden de una tabla desde código (lo mismo que hacer clic en su encabezado). */
  function setSort(key, sk, dir){ _sort[key]={sk:sk,dir:dir||1}; }
  function paintSort(key){
    $$('th[data-tk="'+key+'"][data-sk]').forEach(function(th){
      var ind=th.querySelector('.sar'); if(!ind)return;
      var s=_sort[key];
      ind.textContent=(s&&s.sk===th.getAttribute('data-sk'))?(s.dir>0?' ▲':' ▼'):'';
    });
  }
  function wireSort(key, defSk, defDir, renderFn){
    if(defSk&&!_sort[key])_sort[key]={sk:defSk,dir:defDir||1};
    $$('th[data-tk="'+key+'"][data-sk]').forEach(function(th){
      th.style.cursor='pointer'; th.title='Ordenar por esta columna';
      if(!th.querySelector('.sar')){var sp=document.createElement('span');sp.className='sar';sp.style.cssText='color:var(--primary);font-weight:700;font-size:11px';th.appendChild(sp);}
      th.addEventListener('click',function(){
        var sk=th.getAttribute('data-sk'); var st=_sort[key];
        if(st&&st.sk===sk){st.dir=-st.dir;} else {_sort[key]={sk:sk,dir:1};}
        renderFn(); paintSort(key);
      });
    });
    paintSort(key);
  }
  // Extractores de valor por columna para cada tabla ordenable.
  var ORD_COLS={orden:function(o){return o.externalOrderId||o.id;},fecha:function(o){return o.createdAt||"";},deadline:function(o){return o.dueAt||"9999";},canal:function(o){return CH_LABEL[o.salesChannel]||o.salesChannel;},tipo:function(o){return (o.orderType||"");},lineas:function(o){return o.lines.length;},estado:function(o){return STN[o.status]||o.status;}};
  var RET_COLS={dev:function(r){return r.id;},orden:function(r){return r.originalOrderRef||"";},fecha:function(r){return r.createdAt||"";},lineas:function(r){return r.lines.length;},estado:function(r){return RET_ST[r.status]||r.status;}};
  var INB_COLS={orden:function(o){return o.id;},prov:function(o){return o.supplier||"";},ref:function(o){return o.reference||"";},fecha:function(o){return o.createdAt||"";},lineas:function(o){return o.lines?o.lines.length:0;},estado:function(o){return o.status;}};
  // CSS autocontenido para la ventana de impresión del manifiesto de recepción.
  var MANIFEST_CSS=''
    +'*{box-sizing:border-box}body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a2b22;margin:0;padding:28px 30px;font-size:13px}'
    +'.manifest{max-width:760px;margin:0 auto}'
    +'.mf-head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:3px solid #1f7a44;padding-bottom:12px;margin-bottom:16px}'
    +'.mf-brand{font-size:20px;font-weight:800;color:#1f7a44}.mf-sub{font-size:12px;color:#5a6b62;margin-top:2px}'
    +'.mf-id{text-align:right}.mf-idn{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:18px;font-weight:700}'
    +'.mf-st{font-size:11px;font-weight:700;letter-spacing:.05em;color:#1f7a44;margin-top:2px}'
    +'.mf-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 26px;margin-bottom:16px}'
    +'.mf-grid>div{display:flex;justify-content:space-between;border-bottom:1px dotted #d5ddd8;padding:4px 0}'
    +'.mf-grid span{color:#5a6b62}.mf-grid b{font-weight:700}'
    +'.mf-tbl{width:100%;border-collapse:collapse;margin-top:4px}'
    +'.mf-tbl th{text-align:left;font-size:10.5px;text-transform:uppercase;letter-spacing:.05em;color:#5a6b62;border-bottom:2px solid #1f7a44;padding:7px 8px}'
    +'.mf-tbl td{padding:7px 8px;border-bottom:1px solid #e6ebe8}'
    +'.mf-tbl td.m{font-family:ui-monospace,Menlo,Consolas,monospace;font-weight:600}'
    +'.mf-tbl .r{text-align:right}.mf-tbl tfoot td{border-top:2px solid #1f7a44;border-bottom:none;padding-top:9px}'
    +'.mf-notes{margin-top:14px;font-size:12px;color:#3a4b42;background:#f3f7f4;border-left:3px solid #1f7a44;padding:8px 12px}'
    +'.mf-notes span{font-weight:700}'
    +'.mf-sign{display:flex;gap:40px;margin-top:44px}.mf-sign>div{flex:1;text-align:center;font-size:11px;color:#5a6b62}'
    +'.mf-line{border-top:1px solid #1a2b22;margin-bottom:6px;height:0}'
    +'@media print{body{padding:0}@page{margin:16mm}}';
  var CH_LABEL={mercadolibre:"MercadoLibre",shopify:"Shopify",jumpseller:"Jumpseller",falabella:"Falabella",b2b:"B2B directo",demo:"Demo"};
  // Tipos de documento (atributo seleccionable de la orden; no emite ante el SII).
  var DOC_LABEL={boleta:"Boleta",factura:"Factura",guia_despacho:"Guía de despacho",orden_compra:"Orden de compra"};
  // Opciones del menú, SIEMPRE en orden alfabético por etiqueta.
  function docTypeOptions(sel){
    var opts=Object.keys(DOC_LABEL).map(function(v){return {v:v,t:DOC_LABEL[v]};})
      .sort(function(a,b){return a.t.localeCompare(b.t,'es',{sensitivity:'base'});});
    return '<option value="">— Sin documento —</option>'+opts.map(function(o){
      return '<option value="'+o.v+'"'+(o.v===sel?' selected':'')+'>'+esc(o.t)+'</option>';
    }).join("");
  }
  var NAV_BY_ROLE={
    PLATFORM_ADMIN:["dashboard","aidash","copilot","voz","inventory","products","packaging","orders","pickqueue","inbound","returns","putaway","assembly","locations","movements","counts","billing","costos","chat","voicechannel","webhooks","activity","aiaudit","asignaciones","agente","agdiario","agalertas","torre","plan","pkgmatrix","branding","clients","users","operations","usage","announcements"],
    ADMIN:["dashboard","aidash","copilot","voz","inventory","products","packaging","orders","pickqueue","inbound","returns","putaway","assembly","locations","movements","counts","billing","costos","chat","voicechannel","webhooks","activity","aiaudit","asignaciones","agente","agdiario","agalertas","torre","plan","branding","clients","users"],
    // Sin "billing": la facturación es del administrador de la operación, no del supervisor.
    SUPERVISOR:["dashboard","copilot","voz","inventory","products","packaging","orders","pickqueue","inbound","returns","putaway","assembly","locations","movements","counts","costos","chat","voicechannel","webhooks","activity","aiaudit","asignaciones","agente","agdiario","agalertas","torre","plan"],
    OPERATOR:["dashboard","copilot","inventory","orders","pickqueue","inbound","returns","putaway","assembly","locations","movements","counts","voicechannel"],
    CLIENT:["dashboard","copilot","inventory","products","orders","inbound","returns","movements","billing","chat","webhooks"]
  };
  function esc(s){return String(s==null?"":s).replace(/[&<>]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;"}[c];});}
  function fill(el,opts){el.innerHTML=opts.map(function(o){return '<option value="'+esc(o.v)+'">'+esc(o.t)+'</option>';}).join("");}
  function code(id){return locById[id]?locById[id].code:id;}
  function canAct(){return role!=="CLIENT"&&role!=="OPERATOR"?true:false;}
  // Espejo (para UX) de los permisos del backend. El backend SIEMPRE es la autoridad;
  // esto solo decide qué botones mostrar.
  var PERMS={
    PLATFORM_ADMIN:{master:true,user:true,operation:true,receive:true,seller:true},
    ADMIN:{master:true,user:true,operation:false,receive:true,seller:true},
    SUPERVISOR:{master:true,user:false,operation:false,receive:true,seller:false},
    OPERATOR:{receive:true},
    CLIENT:{receive:true}
  };
  // 'order' = crear/editar órdenes: staff de operación + el cliente (su seller).
  PERMS.PLATFORM_ADMIN.order=true; PERMS.ADMIN.order=true; PERMS.SUPERVISOR.order=true; PERMS.CLIENT.order=true;
  // 'cancel' = cancelar órdenes: staff + el cliente (sus propias órdenes).
  PERMS.PLATFORM_ADMIN.cancel=true; PERMS.ADMIN.cancel=true; PERMS.SUPERVISOR.cancel=true; PERMS.CLIENT.cancel=true;
  // 'fulfill' = pickear/despachar órdenes; 'putaway' = guardar/mover stock (staff operativo).
  PERMS.PLATFORM_ADMIN.fulfill=true; PERMS.ADMIN.fulfill=true; PERMS.SUPERVISOR.fulfill=true; PERMS.OPERATOR.fulfill=true;
  PERMS.PLATFORM_ADMIN.putaway=true; PERMS.ADMIN.putaway=true; PERMS.SUPERVISOR.putaway=true; PERMS.OPERATOR.putaway=true;
  // 'product' = mantenedor de productos/SKUs y kits (cliente + staff de operación).
  PERMS.PLATFORM_ADMIN.product=true; PERMS.ADMIN.product=true; PERMS.SUPERVISOR.product=true; PERMS.CLIENT.product=true;
  // 'billing' = tarifario y facturación 3PL. Es del ADMINISTRADOR de la operación: el
  // supervisor maneja el piso de la bodega, no la plata.
  PERMS.PLATFORM_ADMIN.billing=true; PERMS.ADMIN.billing=true;
  // 'billappr' = ver y APROBAR facturas propias (el cliente en su portal; plataforma para soporte).
  PERMS.PLATFORM_ADMIN.billappr=true; PERMS.CLIENT.billappr=true;
  // 'chat' = usar el chat interno (cliente + staff); 'chatOps' = bandeja de la operación (staff).
  PERMS.PLATFORM_ADMIN.chat=true; PERMS.ADMIN.chat=true; PERMS.SUPERVISOR.chat=true; PERMS.CLIENT.chat=true;
  PERMS.PLATFORM_ADMIN.chatOps=true; PERMS.ADMIN.chatOps=true; PERMS.SUPERVISOR.chatOps=true;
  // 'annView' = ver la barra de anuncios (admin/supervisor + plataforma). 'annManage' = mantenedor (solo plataforma).
  PERMS.PLATFORM_ADMIN.annView=true; PERMS.ADMIN.annView=true; PERMS.SUPERVISOR.annView=true; PERMS.CLIENT.annView=true;
  PERMS.PLATFORM_ADMIN.annManage=true;
  // 'whAdmin' = mantenedor de acceso de clientes al panel de webhooks (admin + plataforma).
  PERMS.PLATFORM_ADMIN.whAdmin=true; PERMS.ADMIN.whAdmin=true;
  // 'whManage' = configurar los propios webhooks. Para el CLIENT depende del flag de su
  // seller (webhooksClientEnabled), por eso se calcula en tiempo real con whManage().
  function whManage(){
    if(role==='CLIENT'){var s=(D.sellers||[])[0]; return !!(s&&s.webhooksClientEnabled);}
    return role==='PLATFORM_ADMIN'||role==='ADMIN'||role==='SUPERVISOR';
  }
  function whAdmin(){return can('whAdmin');}
  var CARRIERS=["Chilexpress","Starken","Blue Express","Correos de Chile","Bluexpress","Transporte propio"];
  var PICK_LABEL={FIFO:"FIFO",FEFO:"FEFO",LOT_DIRECTED:"Lote/serie dirigido"};
  var COUNT_LABEL={ABC:"ABC (rotación)",LOCATION:"Por ubicación",RANDOM:"Aleatorio"};
  function can(p){return !!(PERMS[role]&&PERMS[role][p]);}
  var ROLE_LABEL={PLATFORM_ADMIN:"Plataforma (super-admin)",ADMIN:"Administrador",SUPERVISOR:"Supervisor",OPERATOR:"Operario",CLIENT:"Cliente"};
  var ZONES=[["RECEIVING","Recepción"],["STORAGE","Almacenaje"],["PICKING","Picking"],["SHIPPING","Despacho"],["QUARANTINE","Cuarentena"]];

  // ---- API ------------------------------------------------------------------
  function api(path,opts){
    opts=opts||{};
    var h={'Content-Type':'application/json'}; if(token)h['Authorization']='Bearer '+token;
    return fetch(API+path,{method:opts.method||'GET',headers:h,body:opts.body?JSON.stringify(opts.body):undefined})
      .then(function(r){return r.text().then(function(t){var d=t?JSON.parse(t):{};if(!r.ok){var m=(d&&(d.detail||d.message))||('Error '+r.status);if(typeof m==='object')m=JSON.stringify(m);var e=new Error(m);e.status=r.status;e.data=d&&d.data;throw e;}return d;});});
  }

  // ---- Login ----------------------------------------------------------------
  /**
   * El viaje hacia dentro de la caja: la cámara cae adentro en 1,4 segundos
   * y recién ahí aparece el panel. Si no hay escena 3D, entra directo.
   */
  function entrarAlWms(listo){
    var esc=window.__login3d, stage=document.getElementById('loginstage');
    if(!esc||!stage||!stage.classList.contains('has3d'))return listo();
    var hecho=false;
    function fin(){ if(hecho)return; hecho=true; listo(); }
    stage.classList.add('viajando');
    // El canvas crece con una transición: hay que avisarle al renderer en cada
    // cuadro, si no la escena queda estirada.
    var t0=performance.now();
    (function remedir(){
      try{ window.dispatchEvent(new Event('resize')); }catch(e){}
      if(performance.now()-t0<2000)requestAnimationFrame(remedir);
    })();
    setTimeout(function(){ esc.entrar(fin); }, 80);   // deja que el canvas empiece a crecer
    setTimeout(fin, 1900);                            // red de seguridad: nadie se queda afuera
  }

  function doLogin(){
    var email=$("#lg-email").value.trim(), pass=$("#lg-pass").value; $("#lg-err").textContent="";
    if(!email||!pass){$("#lg-err").textContent="Ingresa tu email y contraseña.";return;}
    api('/auth/login',{method:'POST',body:{email:email,password:pass}}).then(function(r){
      if(!r.authenticated){$("#lg-err").textContent=r.detail||"Email o contraseña incorrectos.";return;}
      token=r.token; me=r.user; role=me.role;   // token = JWT firmado
      $("#lg-pass").value="";
      entrarAlWms(function(){ $("#loginov").classList.add("off"); init(); });
    }).catch(function(e){$("#lg-err").textContent="No se pudo conectar: "+e.message;});
  }
  $("#lg-btn").addEventListener("click",doLogin);
  $("#lg-pass").addEventListener("keydown",function(e){if(e.key==="Enter")doLogin();});
  $("#lg-email").addEventListener("keydown",function(e){if(e.key==="Enter")$("#lg-pass").focus();});

  // ---- Entitlements del plan → candados en el menú -------------------------
  // Cada módulo mapea a una feature del plan. Si el plan de la operación no la
  // incluye, el ítem del menú aparece con candado y su página se bloquea.
  var planFeatures=null; // null = desconocido/interno (sin candados)
  var MODULE_FEATURE={returns:'returns',assembly:'kitting',counts:'cycle_count',packaging:'packaging_materials',asignaciones:'task_assignment',billing:'billing_3pl',costos:'cost_profitability',copilot:'ai_copilot',voz:'ai_voice',webhooks:'webhooks',branding:'white_label',chat:'client_chat',voicechannel:'voice_channel',announcements:'announcements'};
  var FEATURE_NAME={returns:'Devoluciones',kitting:'Armado de kits',cycle_count:'Conteo cíclico',packaging_materials:'Insumos de embalaje',lot_serial:'Lote/serie',task_assignment:'Asignación de tareas',reslotting:'Re-slotting',billing_3pl:'Facturación 3PL',cost_profitability:'Costos y rentabilidad',advanced_analytics:'Analítica avanzada',ai_copilot:'Copiloto IA',ai_voice:'Copiloto de voz',webhooks:'Webhooks',api:'API',white_label:'Marca propia',multi_courier:'Multi-courier',client_chat:'Mensajería con clientes',voice_channel:'Canal de voz',announcements:'Anuncios'};
  function moduleLocked(pg){ if(!planFeatures)return false; var f=MODULE_FEATURE[pg]; return !!(f && planFeatures.indexOf(f)<0); }
  // ---- Módulos ocultos en esta versión (GET /ui-config; env HIDDEN_MODULES) ------
  // Se quitan del menú, del Centro de aprendizaje y de la navegación directa. Por defecto
  // el super-admin de plataforma sí los ve (para revisarlos antes de mostrarlos al cliente).
  var uiConfig={hiddenModules:[],hideForPlatformAdmin:false};
  // Pantallas que nacieron dentro de otra: si el módulo padre está oculto, ellas
  // también. Sin esto, apagar "agente" dejaba igual visibles su diario y sus alertas.
  var MOD_PADRE={agdiario:'agente',agalertas:'agente'};
  function moduleHidden(pg){
    if(role==='PLATFORM_ADMIN'&&!uiConfig.hideForPlatformAdmin)return false;
    if(uiConfig.hiddenModules.indexOf(pg)>=0)return true;
    var padre=MOD_PADRE[pg];
    return !!padre&&uiConfig.hiddenModules.indexOf(padre)>=0;
  }
  function loadUiConfig(){ return api('/ui-config').then(function(c){ if(c&&Array.isArray(c.hiddenModules))uiConfig=c; }).catch(function(){}); }
  var uiConfigP=loadUiConfig(); // se pide al cargar la página (endpoint público) para que el menú no parpadee tras el login
  function applyHiddenModules(){
    $$(".nav[data-pg]").forEach(function(n){ if(moduleHidden(n.getAttribute("data-pg")))n.classList.add("hidden"); });
    syncNavCats();
    if(window.NinjaTour)NinjaTour.setContext({isHidden:moduleHidden});
  }
  function applyNavLocks(){
    $$(".nav[data-pg]").forEach(function(n){
      var pg=n.getAttribute("data-pg"), locked=moduleLocked(pg);
      n.classList.toggle("locked",locked);
      var badge=n.querySelector('.navlock');
      if(locked&&!badge){ var s=document.createElement('span'); s.className='navlock'; s.textContent='🔒'; n.appendChild(s); }
      else if(!locked&&badge){ badge.remove(); }
    });
  }
  function loadPlanFeatures(){
    return api('/plan?operationId='+encodeURIComponent(op||'')).then(function(st){
      planFeatures=(st&&st.plan&&Array.isArray(st.plan.features))?st.plan.features:null;
      applyNavLocks();
    }).catch(function(){ planFeatures=null; applyNavLocks(); });
  }

  // ---- Init tras login ------------------------------------------------------
  function init(){
    ajustarLogo();
    $("#sess-wrap").style.display="none";
    $("#who-nm").textContent=me.name; $("#who-rl").textContent=role.replace("_"," "); $("#who-av").textContent=(me.name||"?")[0];
    var allowed=NAV_BY_ROLE[role]||[];
    $$(".nav").forEach(function(n){n.classList.toggle("hidden",allowed.indexOf(n.getAttribute("data-pg"))<0);});
    applyNavLocks();
    syncNavCats();
    applyHiddenModules(); uiConfigP.then(applyHiddenModules);
    $("#loc-new").classList.toggle("hidden",!can('master'));
    if($("#loc-import"))$("#loc-import").classList.toggle("hidden",!can('master'));
    $("#usr-new").classList.toggle("hidden",!can('user'));
    $("#ops-new").classList.toggle("hidden",!can('operation'));
    $("#cli-new").classList.toggle("hidden",!can('seller'));
    if($("#cli-demo"))$("#cli-demo").classList.toggle("hidden",!can('master'));
    $("#ord-new").classList.toggle("hidden",!can('order'));
    if($("#ord-import"))$("#ord-import").classList.toggle("hidden",!can('order'));
    if($("#ord-reserve-all"))$("#ord-reserve-all").classList.toggle("hidden",!can('fulfill'));
    $("#inv-move").classList.toggle("hidden",!can('putaway'));
    $("#pr-new").classList.toggle("hidden",!can('product'));
    // operaciones
    var opsP = role==="PLATFORM_ADMIN" ? api('/operations') : Promise.resolve([{id:me.operationId,name:me.operationId}]);
    opsP.then(function(ops){
      D.ops=ops;
      fill($("#op"),ops.map(function(o){return {v:o.id,t:o.name||o.id};}));
      op = role==="PLATFORM_ADMIN" ? ops[0].id : me.operationId;
      $("#op").value=op; $("#op").disabled = role!=="PLATFORM_ADMIN";
      return loadOp();
    }).then(function(){
      // Tutoriales guiados: contexto + oferta automática en la sección visible.
      if(window.NinjaTour){ window.NINJA_NAV_BY_ROLE=NAV_BY_ROLE; NinjaTour.setContext({go:go,getRole:function(){return role;}}); var cur=$(".page.on"); NinjaTour.onPage(cur?cur.getAttribute("data-pg"):"dashboard"); }
    }).catch(err);
  }

  function loadOp(){
    var isClient = role==="CLIENT";
    loadPlanFeatures(); // candados del menú según el plan de la operación
    // El CLIENT carga su propio seller REAL (trae webhooksClientEnabled para el panel de webhooks).
    var pSellers = isClient
      ? api('/sellers/'+me.sellerId).then(function(s){return [s];}).catch(function(){return [{id:me.sellerId,name:me.sellerId,operationId:op,webhooksClientEnabled:false}];})
      : api('/operations/'+op+'/sellers');
    var pLocs = api('/operations/'+op+'/locations');
    var pUsers = (role==="PLATFORM_ADMIN"||role==="ADMIN") ? api('/users').catch(function(){return [];}) : Promise.resolve([]);
    var pPkg = api('/packaging?operationId='+encodeURIComponent(op)).catch(function(){return [];});
    var pBrand = api('/operations/'+encodeURIComponent(op)+'/branding').catch(function(){return null;});
    loadDeadlineConfig(); // cortes de courier y ventana de riesgo (para los chips de deadline)
    return Promise.all([pSellers,pLocs,pUsers,pPkg,pBrand]).then(function(res){
      D.sellers=res[0]; D.locations=res[1]; D.users=res[2]; D.packaging=res[3]||[]; D.brand=res[4]||null; applyOperationBranding(D.brand);
      locByCode={}; locById={}; D.locations.forEach(function(l){locByCode[l.code]=l;locById[l.id]=l;});
      var sellerOpts=D.sellers.map(function(s){return {v:s.id,t:s.name};});
      // Vista consolidada: una opción más del filtro para el administrador (no clientes).
      if(!isClient && D.sellers.length>1) sellerOpts.unshift({v:'__all__',t:'▤ Todos los clientes'});
      fill($("#seller"),sellerOpts);
      if(!D.sellers.some(function(s){return s.id===seller;})) seller=D.sellers[0]?D.sellers[0].id:null;
      $("#seller").value=seller; $("#seller").disabled = isClient;
      // stock + kardex de toda la operación — inventario y movimientos por seller
      return Promise.all(D.sellers.map(function(s){
        return Promise.all([
          api('/sellers/'+s.id+'/inventory').catch(function(){return [];}),
          api('/sellers/'+s.id+'/movements?limit=1000').catch(function(){return [];})
        ]).then(function(r){return {s:s.id,inv:r[0],mov:r[1]};});
      }));
    }).then(function(all){
      D.opStock={}; var kx=[]; var sname={}; D.sellers.forEach(function(s){sname[s.id]=s.name;});
      all.forEach(function(x){
        x.inv.forEach(function(b){D.opStock[b.locationId]=(D.opStock[b.locationId]||0)+b.qty;});
        x.mov.forEach(function(m){m.sellerId=m.sellerId||x.s; m._seller=sname[x.s]||x.s; kx.push(m);});
      });
      kx.sort(function(a,b){return a.occurredAt<b.occurredAt?1:(a.occurredAt>b.occurredAt?-1:0);});
      D.kardex=kx;
      return loadSeller();
    });
  }

  function loadSeller(){
    if(!seller){renderAll();return Promise.resolve();}
    return Promise.all([
      api('/sellers/'+seller+'/inventory'),
      api('/sellers/'+seller+'/orders'),
      api('/sellers/'+seller+'/movements?limit=40').catch(function(){return [];}),
      api('/sellers/'+seller+'/cycle-counts/plan').catch(function(){return [];}),
      api('/sellers/'+seller+'/skus').catch(function(){return [];}),
      api('/sellers/'+seller+'/receipts').catch(function(){return [];}),
      api('/sellers/'+seller+'/returns').catch(function(){return [];})
    ]).then(function(r){D.inv=r[0];D.ord=r[1];D.mov=r[2];D.plan=r[3];D.skus=r[4];D.receipts=r[5];D.ret=r[6]||[];ordSig=ordSigOf(D.ord);renderAll();if(typeof liveLast!=='undefined'){liveLast=Date.now();paintLive();}}).catch(err);
  }

  // ===== Vista consolidada de TODOS los clientes ("Todos los clientes") =====
  var mcMode=false, mcInited=false, mcData=null, mcSort={k:'enRiesgo',dir:-1};
  function mcEnter(){
    mcMode=true;
    $$(".page").forEach(function(p){p.classList.toggle("on",p.getAttribute("data-pg")==="multicliente");});
    $$(".nav").forEach(function(n){n.classList.remove("on");});
    if($("#pg-title"))$("#pg-title").textContent="Todos los clientes";
    if($("#pg-sub"))$("#pg-sub").textContent="Vista consolidada de la operación";
    if(!mcInited){
      mcInited=true;
      if($("#mc-month")&&!$("#mc-month").value){var d=new Date();$("#mc-month").value=d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');}
      var rf=$("#mc-refresh"); if(rf)rf.addEventListener("click",renderMultiCliente);
      var mo=$("#mc-month"); if(mo)mo.addEventListener("change",renderMultiCliente);
      $$("#mc-table th[data-mcsort]").forEach(function(th){th.addEventListener("click",function(){var k=th.getAttribute("data-mcsort");if(mcSort.k===k)mcSort.dir=-mcSort.dir;else{mcSort.k=k;mcSort.dir=(k==='nombre'?1:-1);}paintMultiCliente();});});
    }
    window.scrollTo(0,0);
    renderMultiCliente();
    if(window.NinjaTour)NinjaTour.onPage("multicliente");
  }
  function renderMultiCliente(){
    if(!op)return;
    var q='operationId='+encodeURIComponent(op);
    var mv=$("#mc-month")&&$("#mc-month").value; if(mv){var p=mv.split('-');q+='&year='+p[0]+'&month='+p[1];}
    if($("#mc-body"))$("#mc-body").innerHTML='<tr><td colspan="9" class="empty">Cargando…</td></tr>';
    api('/clients-overview?'+q).then(function(d){mcData=d;paintMultiCliente();}).catch(function(e){if($("#mc-body"))$("#mc-body").innerHTML='<tr><td colspan="9" class="empty">'+esc(e.message)+'</td></tr>';});
  }
  function paintMultiCliente(){
    if(!mcData)return; var t=mcData.totales||{}; var cur=t.currency||'CLP';
    $("#mc-kpis").innerHTML=[
      {l:"Clientes",v:fmtInt(t.clientes||0),d:"en la operación"},
      {l:"Órdenes abiertas",v:fmtInt(t.ordenesAbiertas||0),d:"sin despachar"},
      {l:"En riesgo",v:fmtInt(t.enRiesgo||0),d:"detenidas +2 días"},
      {l:"Recep. pendientes",v:fmtInt(t.recepcionesPendientes||0),d:"por recibir"},
      {l:"Quiebres",v:fmtInt(t.quiebres||0),d:"SKUs por reponer"},
      {l:"Facturación mes",v:fmtMoney(t.facturacionMes||0,cur),d:"del período"}
    ].map(function(x){return '<div class="kpi"><div class="l">'+x.l+'</div><div class="v">'+x.v+'</div><div class="d">'+esc(x.d)+'</div></div>';}).join("");
    var rows=(mcData.clientes||[]).slice(); var k=mcSort.k,dir=mcSort.dir;
    rows.sort(function(a,b){var x=a[k],y=b[k];if(k==='nombre')return dir*String(x).localeCompare(String(y));return dir*((x||0)-(y||0));});
    if($("#mc-sub"))$("#mc-sub").textContent=rows.length+" clientes";
    $("#mc-body").innerHTML=rows.length?rows.map(function(c){
      var risk=c.enRiesgo>0?' style="color:var(--crit,#c0392b);font-weight:700"':'';
      var qb=c.quiebres>0?' style="color:var(--warn,#c77700);font-weight:700"':'';
      return '<tr class="mc-row" data-sid="'+esc(c.sellerId)+'" style="cursor:pointer">'
        +'<td><b>'+esc(c.nombre)+'</b></td>'
        +'<td class="num">'+fmtInt(c.ordenesAbiertas)+'</td>'
        +'<td class="num">'+fmtInt(c.enProceso)+'</td>'
        +'<td class="num">'+fmtInt(c.porDespachar)+'</td>'
        +'<td class="num"'+risk+'>'+fmtInt(c.enRiesgo)+'</td>'
        +'<td class="num">'+fmtInt(c.recepcionesPendientes)+'</td>'
        +'<td class="num"'+qb+'>'+fmtInt(c.quiebres)+'</td>'
        +'<td class="num">'+fmtInt(c.stockOnHand)+'</td>'
        +'<td class="num">'+fmtMoney(c.facturacionMes,c.currency||cur)+'</td></tr>';
    }).join(""):'<tr><td colspan="9" class="empty">Sin clientes.</td></tr>';
    $("#mc-foot").innerHTML=rows.length?('<tr style="font-weight:700;border-top:2px solid var(--line)"><td>Total</td>'
      +'<td class="num">'+fmtInt(t.ordenesAbiertas)+'</td><td class="num">'+fmtInt(t.enProceso)+'</td><td class="num">'+fmtInt(t.porDespachar)+'</td>'
      +'<td class="num">'+fmtInt(t.enRiesgo)+'</td><td class="num">'+fmtInt(t.recepcionesPendientes)+'</td><td class="num">'+fmtInt(t.quiebres)+'</td>'
      +'<td class="num">'+fmtInt(t.stockOnHand)+'</td><td class="num">'+fmtMoney(t.facturacionMes,cur)+'</td></tr>'):'';
    $$("#mc-body .mc-row").forEach(function(tr){tr.addEventListener("click",function(){var sid=tr.getAttribute("data-sid");seller=sid;if($("#seller"))$("#seller").value=sid;mcMode=false;go('dashboard');loadSeller();});});
  }

  function loadPackaging(){ return api('/packaging?operationId='+encodeURIComponent(op)).then(function(l){D.packaging=l||[];renderPackaging();}).catch(function(){}); }
  // Logo Ninja WMS original del HTML — se conserva para restaurarlo (super admin / sin marca).
  var defaultBrandHTML=(document.getElementById('brandLogo')||{}).innerHTML||'';
  // Aplica la marca (white-label) de la operación al panel: color, logo y sello.
  // La marca se almacena por operación (la fija su administrador) y la heredan sus
  // sellers y operadores. El SUPER ADMINISTRADOR (plataforma) conserva SIEMPRE la
  // identidad Ninja WMS, aunque esté viendo o gestionando la marca de una operación.
  function applyOperationBranding(b){
    try{
      var root=document.documentElement;
      var host=document.getElementById('brandLogo');
      var pb=document.getElementById('poweredby');
      if(role==='PLATFORM_ADMIN'){
        root.style.removeProperty('--primary');
        // Ojo: esto REPONE el markup original del logo, así que hay que volver a
        // ajustarlo. Sin esta llamada el ajuste hecho en init() se perdía acá, y
        // el super admin —que siempre pasa por esta rama— veía el logo cortado.
        if(host){host.innerHTML=defaultBrandHTML;host.title='Ninja WMS';ajustarLogo();}
        if(pb)pb.style.display='';
        return;
      }
      if(b&&b.primaryColor){root.style.setProperty('--primary',b.primaryColor);}else{root.style.removeProperty('--primary');}
      var dispName=b?(b.companyName||b.legalName||''):'';
      if(host){
        if(b&&b.logoDataUri){host.innerHTML='<img alt="'+esc(dispName)+'" style="width:158px;height:auto;display:block" src="'+b.logoDataUri+'">';host.title=dispName;}
        else if(dispName){host.innerHTML='<div class="n" style="font-size:20px;font-weight:800;color:var(--primary)">'+esc(dispName)+'</div>';host.title=dispName;}
        else {host.innerHTML=defaultBrandHTML;host.title='Ninja WMS';ajustarLogo();} // operación sin marca → Ninja por defecto
      }
      if(pb)pb.style.display=(dispName||(b&&b.logoDataUri))?'none':'';
    }catch(e){}
  }
  function loadBranding(){ return api('/operations/'+encodeURIComponent(op)+'/branding').then(function(b){D.brand=b;applyOperationBranding(b);renderBranding();}).catch(function(){}); }
  var brandLogoDraft; // undefined = sin cambio; null = quitar; string = nuevo data URI
  function renderBranding(){
    var host=$("#brand-form"); if(!host)return;
    var canEdit=role==="PLATFORM_ADMIN"||role==="ADMIN";
    var b=D.brand||{};
    brandLogoDraft=undefined;
    var logo=b.logoDataUri||"";
    var color=b.primaryColor||"#0E9F6E";
    function row(id,label,val,ph){return '<div class="fld"><label>'+label+'</label><input id="'+id+'" value="'+esc(val||"")+'" placeholder="'+esc(ph||"")+'"'+(canEdit?'':' disabled')+'></div>';}
    host.innerHTML=''
      +'<p class="muted" style="margin:0 0 14px;max-width:70ch">Personaliza la marca de tu operación. Estos datos y el logo reemplazan a los de Ninja Hubs en <b>todo lo que ve o descarga tu cliente</b>: el panel, la factura/pre-factura y el manifiesto de recepción. Si dejas algo vacío, se usa el valor por defecto.</p>'
      +'<div class="row2"><div class="fld"><label>Nombre visible (marca)</label><input id="br-company" value="'+esc(b.companyName||"")+'" placeholder="Ej: Bodegas del Sur" '+(canEdit?'':'disabled')+'></div>'
      +'<div class="fld"><label>Color primario</label><input id="br-color" type="color" value="'+esc(color)+'" style="height:40px;padding:4px" '+(canEdit?'':'disabled')+'></div></div>'
      +'<div class="row2">'+row('br-legal','Razón social',b.legalName,'Bodegas del Sur SpA')+row('br-tax','RUT / ID tributario',b.taxId,'76.123.456-7')+'</div>'
      +'<div class="fld"><label>Dirección</label><input id="br-address" value="'+esc(b.address||"")+'" placeholder="Av. Ejemplo 123, Santiago" '+(canEdit?'':'disabled')+'></div>'
      +'<div class="row2">'+row('br-email','Email',b.email,'contacto@empresa.cl')+row('br-phone','Teléfono',b.phone,'+56 2 2345 6789')+'</div>'
      +row('br-web','Sitio web',b.website,'www.empresa.cl')
      +'<div class="fld"><label>Logo</label>'
        +'<div style="display:flex;gap:14px;align-items:center;flex-wrap:wrap">'
        +'<div id="br-logo-prev" style="width:170px;height:56px;border:1px dashed var(--line-2);border-radius:9px;display:flex;align-items:center;justify-content:center;background:var(--surface-2);overflow:hidden">'+(logo?'<img src="'+logo+'" style="max-width:100%;max-height:100%">':'<span class="muted" style="font-size:12px">Sin logo</span>')+'</div>'
        +(canEdit?'<input type="file" id="br-logo-file" accept="image/png,image/jpeg,image/svg+xml,image/webp"><button class="btn mini" id="br-logo-clear" type="button">Quitar logo</button>':'')+'</div>'
        +'<div class="hint" style="margin-top:4px">PNG, JPG, SVG o WebP. Máx ~200 KB. Se muestra en el panel y en los documentos.</div></div>'
      +'<div class="ferr" id="br-err"></div>'
      +(canEdit?'<div class="acts" style="margin-top:8px"><span class="hint">Se aplica de inmediato a tus clientes.</span><button class="btn pri" id="br-save">Guardar marca</button></div>':'<p class="hint">Solo el administrador de la operación puede editar la marca.</p>');
    if(!canEdit)return;
    $("#br-logo-file").addEventListener("change",function(){
      var f=this.files&&this.files[0]; if(!f)return;
      if(f.size>210000){$("#br-err").textContent="El logo supera ~200 KB. Usa una imagen más liviana.";this.value="";return;}
      var rd=new FileReader();
      rd.onload=function(){brandLogoDraft=String(rd.result||"");$("#br-logo-prev").innerHTML='<img src="'+brandLogoDraft+'" style="max-width:100%;max-height:100%">';$("#br-err").textContent="";};
      rd.readAsDataURL(f);
    });
    $("#br-logo-clear").addEventListener("click",function(){brandLogoDraft=null;$("#br-logo-prev").innerHTML='<span class="muted" style="font-size:12px">Sin logo</span>';});
    $("#br-save").addEventListener("click",function(){
      $("#br-err").textContent="";
      var body={
        companyName:$("#br-company").value.trim(), legalName:$("#br-legal").value.trim(), taxId:$("#br-tax").value.trim(),
        address:$("#br-address").value.trim(), email:$("#br-email").value.trim(), phone:$("#br-phone").value.trim(),
        website:$("#br-web").value.trim(), primaryColor:$("#br-color").value
      };
      if(brandLogoDraft!==undefined)body.logoDataUri=brandLogoDraft; // null quita, string nuevo
      $("#br-save").disabled=true;
      api('/operations/'+encodeURIComponent(op)+'/branding',{method:'PATCH',body:body})
        .then(function(b){D.brand=b;brandSig=JSON.stringify(b||{});applyOperationBranding(b);toast("Marca actualizada");renderBranding();})
        .catch(function(e){$("#br-save").disabled=false;$("#br-err").textContent=e.message;});
    });
  }
  $("#op").addEventListener("change",function(){op=this.value;seller=null;loadOp().catch(err);});
  $("#seller").addEventListener("change",function(){ if(this.value==='__all__'){ mcEnter(); return; } mcMode=false; seller=this.value; loadSeller(); });
  $$("#dash-scope .segbtn").forEach(function(b){b.addEventListener("click",function(){
    dashOnlySeller=b.getAttribute("data-scope")==='seller';
    $$("#dash-scope .segbtn").forEach(function(x){x.classList.toggle("on",x===b);});
    loadDash();
  });});
  $$("#opm-toggle .segbtn").forEach(function(b){b.addEventListener("click",function(){opmWindow=b.getAttribute("data-mw");$$("#opm-toggle .segbtn").forEach(function(x){x.classList.toggle("on",x===b);});if($("#opm-range"))$("#opm-range").classList.toggle("hidden",opmWindow!=="custom");if(opmWindow!=="custom")loadDash();});});
  if($("#opm-apply"))$("#opm-apply").addEventListener("click",applyOpmRange);
  $$("#usg-toggle .segbtn").forEach(function(b){b.addEventListener("click",function(){usgWindow=b.getAttribute("data-uw");$$("#usg-toggle .segbtn").forEach(function(x){x.classList.toggle("on",x===b);});if($("#usg-range"))$("#usg-range").classList.toggle("hidden",usgWindow!=="custom");if(usgWindow!=="custom")renderUsage();});});
  if($("#usg-apply"))$("#usg-apply").addEventListener("click",renderUsage);
  // Chat: sondeo cada 10 s para refrescar mensajes y el badge de no leídos.
  setInterval(function(){chatPoll();},10000);
  // Anuncios: barra superior. Clic abre la landing (registrando el clic) y ✕ la oculta.
  var _al=$("#ann-link"); if(_al)_al.addEventListener("click",function(){ if(!annActive)return; api('/announcements/'+encodeURIComponent(annActive.id)+'/click',{method:'POST'}).catch(function(){}); try{window.open(annActive.linkUrl,'_blank','noopener');}catch(e){} });
  var _ax=$("#ann-x"); if(_ax)_ax.addEventListener("click",function(){ if(annActive)annDismissedId=annActive.id; $("#ann-bar").style.display='none'; });
  var _annNew=$("#ann-new"); if(_annNew)_annNew.addEventListener("click",function(){openAnnForm(null);});
  setInterval(function(){pollAnnouncement();},60000);
  // Marca (white-label): sondeo para reflejar en vivo los cambios del administrador
  // en las cuentas de sellers y operadores (logo, nombre, color) sin re-login.
  var brandSig=null;
  function pollBranding(){
    if(!token||!op)return;
    api('/operations/'+encodeURIComponent(op)+'/branding').then(function(b){
      var sig=JSON.stringify(b||{});
      if(sig===brandSig)return;
      brandSig=sig; D.brand=b; applyOperationBranding(b);
      // Re-dibuja el editor solo si NO se está editando la sección Marca (evita pisar cambios en curso).
      var onBrandPage=document.querySelector('.page[data-pg="branding"].on');
      if(!onBrandPage)renderBranding();
    }).catch(function(){});
  }
  setInterval(pollBranding,30000);
  // Órdenes en vivo: refleja los cambios de estado al resto de stakeholders sin recargar.
  // Sondea las órdenes del seller en foco y re-dibuja SOLO si algo cambió (nuevo estado,
  // orden nueva, cancelación, etiqueta/tracking adjuntado), mientras se ve Órdenes o la Cola.
  var ordSig=null;
  function ordSigOf(list){ return (list||[]).map(function(o){return o.id+':'+o.status+':'+((o.events||[]).length);}).sort().join('|'); }
  function ordersLivePage(){ var p=document.querySelector('.page[data-pg="orders"].on,.page[data-pg="pickqueue"].on'); return !!p; }
  function pollOrders(){
    if(!token||!seller||!ordersLivePage())return;
    api('/sellers/'+encodeURIComponent(seller)+'/orders').then(function(list){
      list=list||[];
      var sig=ordSigOf(list);
      if(sig===ordSig)return;
      ordSig=sig; D.ord=list;
      renderOrdFilters(); renderOrders(); renderPickQueue();
    }).catch(function(){});
  }
  setInterval(pollOrders,6000);
  setInterval(function(){agtPoll();},30000);

  // ---- Refresco automático de la vista activa ("en vivo" por sondeo) -------------
  // Cada sección operativa se vuelve a cargar sola mientras esté visible. Se pausa si la
  // pestaña está en segundo plano, si hay un formulario/panel abierto o un tutorial corriendo.
  // El Dashboard recarga la operación completa (stock por zona + kardex + datos del cliente).
  var LIVE_PAGES={torre:15000,agente:20000,dashboard:30000,multicliente:30000,inventory:30000,inbound:20000,returns:30000,putaway:20000,movements:30000,counts:60000,locations:60000,products:60000,assembly:60000,packaging:60000,billing:60000};
  var liveLast=Date.now(), liveBusy=false;
  function activePg(){ if(mcMode)return 'multicliente'; var p=document.querySelector('.page.on'); return p?p.getAttribute('data-pg'):null; }
  function liveRefresh(force){
    if(!token||!op||liveBusy)return Promise.resolve();
    var pg=activePg(), iv=LIVE_PAGES[pg]; if(!iv)return Promise.resolve();
    if(!force){
      if(document.hidden||Date.now()-liveLast<iv)return Promise.resolve();
      if(document.querySelector('#modal.on,#drawer.on'))return Promise.resolve();
      if(window.NinjaTour&&NinjaTour.isRunning())return Promise.resolve();
      if(document.activeElement&&/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)&&document.activeElement.closest('.content'))return Promise.resolve();
    }
    liveBusy=true; paintLive();
    var p= pg==='agente' ? Promise.resolve(renderAgente()) : pg==='agalertas' ? Promise.resolve(renderAgAlertas()) : pg==='agdiario' ? Promise.resolve(renderAgDiario()) : pg==='multicliente' ? Promise.resolve(renderMultiCliente()) : (pg==='dashboard'||pg==='locations') ? loadOp() : loadSeller();
    if(pg==='billing'&&typeof renderBilling==='function')p=Promise.resolve(p).then(function(){renderBilling();});
    return Promise.resolve(p).catch(function(){}).then(function(){ liveBusy=false; liveLast=Date.now(); paintLive(); });
  }
  function paintLive(){
    var b=$("#live-btn"); if(!b)return;
    var pg=activePg(); if(!LIVE_PAGES[pg]){ b.classList.add('hidden'); return; }
    b.classList.remove('hidden'); b.classList.toggle('busy',liveBusy);
    var s=Math.max(0,Math.round((Date.now()-liveLast)/1000));
    b.querySelector('.lbl').textContent=liveBusy?'actualizando…':(s<5?'al día':'hace '+(s<60?s+' s':Math.round(s/60)+' min'));
    b.title='Se actualiza solo cada '+Math.round(LIVE_PAGES[pg]/1000)+' s mientras la pestaña esté visible. Clic para actualizar ahora.';
  }
  setInterval(function(){ liveRefresh(false); paintLive(); },5000);
  document.addEventListener('visibilitychange',function(){ if(!document.hidden&&Date.now()-liveLast>8000)liveRefresh(true); });
  if($("#live-btn"))$("#live-btn").addEventListener('click',function(){ liveRefresh(true); });

  // ---- Render ---------------------------------------------------------------
  function renderAll(){ renderOpMetrics();renderAlerts();renderKpis();renderZone();renderActivity();renderMovements();renderInv();renderProducts();renderPackaging();renderOrdFilters();renderOrders();renderPickQueue();renderInbound();renderReturns();renderPutaway();renderAssembly();renderLocations();renderCounts();renderBilling();renderClients();renderUsers();renderOps();chatPoll();pollAnnouncement();syncWebhookNav();injectTableExporters();renderOnboarding(); }
  // El CLIENT solo ve el nav "Webhooks" si su operador habilitó el panel (flag por seller).
  function syncWebhookNav(){ $$('.nav[data-pg="webhooks"]').forEach(function(n){ var allowed=(NAV_BY_ROLE[role]||[]).indexOf("webhooks")>=0; n.classList.toggle("hidden", !(allowed&&whManage())); }); }
  // Oculta una categoría del sidebar si el rol no tiene NINGÚN sub-ítem visible.
  function syncNavCats(){
    $$('.navcat').forEach(function(cat){
      var visible=Array.prototype.slice.call(cat.querySelectorAll('.nav')).some(function(n){return !n.classList.contains('hidden');});
      cat.classList.toggle('hidden',!visible);
    });
  }
  // Despliega la categoría que contiene la página activa (y marca su cabecera).
  function expandActiveCat(pg){
    $$('.navcat').forEach(function(cat){
      var has=!!cat.querySelector('.nav[data-pg="'+pg+'"]');
      cat.classList.toggle('has-active',has);
      if(has)cat.classList.remove('collapsed');
    });
  }
  // Alterna una categoría (menú desplegable).
  function toggleNavCat(el){ if(el)el.classList.toggle('collapsed'); }

  function availableLow(){ return D.inv.filter(function(b){return b.state==="AVAILABLE"&&b.qty<15;}); }
  function occHot(){ var storage=D.locations.filter(function(l){return l.capacity>0;}); return storage.filter(function(l){return (D.opStock[l.id]||0)/l.capacity>=0.85;}); }
  function ordersOpen(){ return D.ord.filter(function(o){return o.status!=="SHIPPED"&&o.status!=="CANCELLED";}); }

  function renderAlerts(){
    // Fila de tarjetas de alertas eliminada del dashboard a pedido.
    // Se conserva solo la actualización del badge de "Conteo cíclico".
    var counts=D.plan.length;
    var badge=$("#nav-counts"); badge.textContent=counts||""; badge.style.display=counts?"":"none";
  }

  function renderKpis(){
    var units=D.inv.reduce(function(a,b){return a+b.qty;},0);
    var skus={}; D.inv.forEach(function(b){skus[b.sku]=1;});
    var pend=ordersOpen().length;
    var storage=D.locations.filter(function(l){return l.capacity>0;});
    var capTot=storage.reduce(function(a,l){return a+l.capacity;},0);
    var used=storage.reduce(function(a,l){return a+(D.opStock[l.id]||0);},0);
    var occ=capTot?Math.min(100,Math.round(used/capTot*100)):0;
    var k=[
      {l:"SKUs con stock",v:Object.keys(skus).length,d:"cliente actual"},
      {l:"Unidades en stock",v:units.toLocaleString("es-CL"),d:"disponible + reservado"},
      {l:"Órdenes por despachar",v:pend,d:"en curso"},
      {l:"Movimientos",v:D.mov.length,d:"registrados (ledger)"},
      {l:"Ocupación bodega",v:occ+"%",d:opName()}
    ];
    $("#kpis").innerHTML=k.map(function(x){return '<div class="kpi"><div class="l">'+x.l+'</div><div class="v">'+x.v+'</div><div class="d">'+esc(x.d)+'</div></div>';}).join("");
  }
  function opName(){var o=D.ops.filter(function(x){return x.id===op;})[0];return o?(o.name||o.id):op;}

  // ===== Métricas operativas (24h/7d/30d/90d con comparativo vs período anterior) =====
  var opmData=null, opmWindow='24h', opmCustom=null;
  var OPM_LABEL={'24h':['Últimas 24 horas','las 24 h previas'],'7d':['Últimos 7 días','los 7 días previos'],'30d':['Últimos 30 días','los 30 días previos'],'90d':['Últimos 90 días','los 90 días previos']};
  function dOnly(iso){try{return new Date(iso).toLocaleDateString('es-CL',{day:'2-digit',month:'2-digit',year:'numeric'});}catch(e){return iso;}}
  function applyOpmRange(){
    var f=$("#opm-from").value, t=$("#opm-to").value;
    if(!f||!t){toast("Elige ambas fechas");return;}
    if(f>t){toast("La fecha 'Desde' no puede ser mayor que 'Hasta'");return;}
    // 'to' inclusivo: sumamos un día para cubrir todo el día final.
    var toEx=new Date(t+'T00:00:00'); toEx.setDate(toEx.getDate()+1);
    var fromIso=new Date(f+'T00:00:00').toISOString(), toIso=toEx.toISOString();
    dashRange={from:fromIso,to:toIso}; opmWindow='custom';
    loadDash().catch(function(e){toast(e.message);});
  }
  function fmtInt(n){try{return (n||0).toLocaleString('es-CL');}catch(e){return ''+(n||0);}}
  function deltaChip(mv){
    if(mv.pct===null||mv.pct===undefined)return mv.current>0?'<span class="chg none">nuevo</span>':'<span class="chg flat">—</span>';
    if(mv.pct>0)return '<span class="chg up">▲ +'+mv.pct+'%</span>';
    if(mv.pct<0)return '<span class="chg down">▼ '+mv.pct+'%</span>';
    return '<span class="chg flat">— 0%</span>';
  }
  // ===== Panel de control consolidado de la operación ==========================
  // Una sola llamada trae todo lo que muestra la pantalla, y se refresca sola cada
  // 30 s mientras el Dashboard está a la vista (no corre en segundo plano).
  var DASH=null, dashTimer=null, DASH_MS=30000;
  // Una sola consulta a la vez y un piso de 5 s entre consultas: el panel se pinta
  // desde varios lados (al entrar, al cambiar de cliente, al volver a la pestaña)
  // y sin esto se disparaban dos cadenas de refresco pidiendo lo mismo dos veces.
  var dashEnVuelo=null, dashUltimo=0, dashRelojChip=null;
  // El panel arranca consolidado (toda la operación); el cliente es un filtro opcional.
  var dashOnlySeller=false;
  function dashScope(){ return (dashOnlySeller&&seller) ? ('&sellerId='+encodeURIComponent(seller)) : ''; }
  function loadDash(forzar){
    if(!op||!$("#dash-cards"))return Promise.resolve();
    if(dashEnVuelo)return dashEnVuelo;                                    // ya viene en camino
    if(!forzar&&Date.now()-dashUltimo<5000)return Promise.resolve();      // recién refrescado
    var q='window='+(opmWindow==='custom'?'24h':opmWindow)+dashScope();
    if(opmWindow==='custom'&&dashRange)q+='&from='+encodeURIComponent(dashRange.from)+'&to='+encodeURIComponent(dashRange.to);
    function cerrar(){ dashEnVuelo=null; dashUltimo=Date.now(); }
    dashEnVuelo=api('/operations/'+op+'/dashboard?'+q).then(function(d){
      DASH=d; cerrar(); renderDash(); paintOpMetrics(); pintaFrescura();
    },function(){ cerrar(); });
    return dashEnVuelo;
  }

  /**
   * "En vivo · hace Xs". El panel se refresca solo; si el usuario no lo ve, no
   * lo cree. El reloj corre aparte del refresco para que el contador avance.
   */
  function pintaFrescura(){
    var el=$("#dash-live"); if(!el)return;
    clearInterval(dashRelojChip);
    function pinta(){
      if(!DASH||!DASH.generadoEn){ el.textContent=''; return; }
      var seg=Math.max(0,Math.round((Date.now()-Date.parse(DASH.generadoEn))/1000));
      el.textContent='En vivo · hace '+(seg<60?seg+' s':Math.floor(seg/60)+' min');
      el.classList.toggle('stale',seg>90);
    }
    pinta();
    dashRelojChip=setInterval(pinta,1000);
  }
  var dashRange=null;
  function dashTick(){
    clearTimeout(dashTimer);
    var visible=document.querySelector('.page[data-pg="dashboard"].on');
    if(!visible){ clearInterval(dashRelojChip); return; } // fuera del dashboard no se consulta
    dashTimer=setTimeout(function(){ loadDash(true).then(dashTick); }, DASH_MS);
  }

  // Al volver a la pestaña, refresca de inmediato: el navegador frena los
  // temporizadores en segundo plano y el panel podría quedar viejo.
  document.addEventListener('visibilitychange',function(){
    if(document.hidden)return;
    if(!document.querySelector('.page[data-pg="dashboard"].on'))return;
    loadDash(true).then(dashTick);
  });
  // Horas con un decimal. El backend manda horas ya calculadas; los minutos
  // quedan de respaldo por si el panel habla con una versión anterior.
  function hrs(h,min){
    var v = (h!=null) ? h : (min!=null ? Math.round((min/60)*10)/10 : null);
    if(v==null)return '—';
    return v.toLocaleString('es-CL',{minimumFractionDigits:1,maximumFractionDigits:1});
  }
  function money(n,cur){ try{ return (n||0).toLocaleString('es-CL',{style:'currency',currency:cur||'CLP',maximumFractionDigits:0}); }catch(e){ return '$'+fmtInt(n); } }
  function bar(pct,cls){ return '<div class="t"><i class="'+(cls||'')+'" style="width:'+Math.max(0,Math.min(100,pct||0))+'%"></i></div>'; }
  function hace(min){
    if(min==null)return '';
    if(min<60)return 'hace '+min+'m';
    var h=Math.floor(min/60); if(h<24)return 'hace '+h+'h';
    return 'hace '+Math.floor(h/24)+'d';
  }
  function renderDash(){
    var d=DASH; if(!d)return;
    // --- Las cinco tarjetas de control ---
    var p=d.precision, t=d.tiempos, oc=d.ocupacion, de=d.despacho;
    var cards=[
      {cls: de.atrasadas?'good':'good', l:'Órdenes por despachar a tiempo', v:fmtInt(de.aTiempo),
       s:'de '+fmtInt(de.conCompromiso)+' con compromiso · '+fmtInt(de.sinCompromiso)+' sin deadline'},
      {cls: de.atrasadas?'crit':'good', l:'Órdenes por despachar atrasadas', v:fmtInt(de.atrasadas),
       s: de.atrasadas? 'requieren atención inmediata':'ninguna pasada de su deadline'},
      {cls:'info', l:'Precisión de preparación', v:(p.pct==null?'—':p.pct+'%'),
       s:(p.pct==null? 'aún sin pedidos verificados al empacar'
          : fmtInt(p.pedidosVerificados)+' verificados · '+fmtInt(p.pedidosConError)+' con diferencia · '+p.ventanaDias+' días')},
      {cls:'info', duo:[{v:hrs(t.b2bHoras,t.b2bMin), l:'h B2B'},{v:hrs(t.b2cHoras,t.b2cMin), l:'h B2C'}],
       l:'Tiempo de preparación', s:'promedio de reserva a empaque · últimos '+t.ventanaDias+' días'},
      {cls:(oc.pct==null?'info':oc.pct>=90?'crit':oc.pct>=75?'warn':'good'), l:'Ocupación de bodega',
       v:(oc.pct==null?'—':oc.pct+'%'), s:fmtInt(oc.usado)+' de '+fmtInt(oc.capacidad)+' '+oc.unidad+' · '+oc.ubicaciones+' ubicaciones'}
    ];
    $("#dash-cards").innerHTML=cards.map(function(c){
      var cuerpo=c.duo
        ? '<div class="duo">'+c.duo.map(function(x){return '<div><div class="v">'+x.v+'</div><div class="s">'+x.l+'</div></div>';}).join('')+'</div>'
        : '<div class="v">'+c.v+'</div>';
      return '<div class="dcard '+c.cls+'"><div class="l">'+esc(c.l)+'</div>'+cuerpo+'<div class="s">'+esc(c.s)+'</div></div>';
    }).join('');

    // --- Productividad ---
    var prod=d.productividad||[];
    $("#dash-prod-sub").textContent=prod.length?('ventana de '+(d.ventana.dias||'')+' día(s)'):'';
    $("#dash-prod").innerHTML=prod.length?prod.map(function(o,i){
      return '<div class="drank"><span class="p">'+(i+1)+'</span><span class="nm">'+esc(o.nombre)+'</span>'
        +'<span class="d">'+fmtInt(o.unidades)+' u. · '+(o.minPorTarea==null?'—':o.minPorTarea+' min/tarea')+'</span></div>';
    }).join(''):'<div class="muted">Sin tareas registradas en esta ventana.</div>';

    // --- Pre-facturación ---
    var pf=d.prefacturacion, max=Math.max.apply(null,[1].concat((pf.porCliente||[]).map(function(x){return x.monto;})));
    $("#dash-prefac-total").textContent=money(pf.total,pf.moneda);
    $("#dash-prefac").innerHTML=(pf.porCliente||[]).length?(pf.porCliente.map(function(c){
      return '<div class="dbar"><span class="n">'+esc(c.nombre)+'</span>'+bar(c.monto/max*100)+'<span class="q">'+money(c.monto,pf.moneda)+'</span></div>';
    }).join('')+'<div class="dashnote">Acumulado del período '+esc(pf.periodo)+', aún sin emitir.</div>')
      :'<div class="muted">Sin tarifario configurado para los clientes de esta operación.</div>';

    // --- Carga por cliente ---
    var cg=d.cargaPorCliente||[], maxU=Math.max.apply(null,[1].concat(cg.map(function(x){return x.unidades;})));
    $("#dash-carga").innerHTML=cg.length?cg.map(function(c){
      return '<div class="dbar"><span class="n">'+esc(c.nombre)+'</span>'+bar(c.unidades/maxU*100)+'<span class="q">'+fmtInt(c.unidades)+' <small>u</small></span></div>';
    }).join(''):'<div class="muted">Sin órdenes abiertas.</div>';

    // --- Cola por courier ---
    var cc=d.colaPorCourier||[], maxC=Math.max.apply(null,[1].concat(cc.map(function(x){return x.ordenes;})));
    $("#dash-cola").innerHTML=cc.length?cc.map(function(c,i){
      return '<div class="drank"><span class="p">'+(i+1)+'</span><span class="nm">'+esc(c.courier)+'</span>'
        +'<span class="d" style="min-width:120px">'+bar(c.ordenes/maxC*100)+'</span><b style="min-width:26px;text-align:right">'+c.ordenes+'</b></div>';
    }).join(''):'<div class="muted">Nada en cola de preparación.</div>';

    // --- Órdenes por estado ---
    var est=d.ordenesPorEstado||{}, keys=Object.keys(est), maxE=Math.max.apply(null,[1].concat(keys.map(function(k){return est[k];})));
    var CLS={RECEIVED:'mute',ALLOCATED:'ok',PICKING:'warn',PICKED:'warn',PACKED:'warn',SHIPPED:'ok',CANCELLED:'crit'};
    $("#dash-estados").innerHTML=keys.length?keys.sort(function(a,b){return est[b]-est[a];}).map(function(k){
      return '<div class="dbar"><span class="n"><span class="chip st-'+k+'" style="font-size:10px"><span class="dot"></span>'+(STN[k]||k)+'</span></span>'
        +bar(est[k]/maxE*100,CLS[k]||'')+'<span class="q">'+fmtInt(est[k])+'</span></div>';
    }).join(''):'<div class="muted">Sin órdenes.</div>';

    // --- Embalaje ---
    var em=d.embalaje||[], maxS=Math.max.apply(null,[1].concat(em.map(function(x){return Math.max(x.stock,x.minStock);})));
    $("#dash-embalaje").innerHTML=em.length?em.map(function(m){
      var cls=m.estado==='critico'?'crit':m.estado==='bajo'?'warn':'ok';
      var pill=m.sugerido>0?'<span class="dpill '+cls+'">reponer '+fmtInt(m.sugerido)+'</span>':'<span class="dpill ok">ok</span>';
      return '<div class="dbar"><span class="n" style="min-width:190px">'+esc(m.nombre)+'</span>'+bar(m.stock/maxS*100,cls)
        +'<span class="q" style="min-width:150px">'+fmtInt(m.stock)+' uds <small>· mín. '+(m.minStock||'—')+'</small></span>'+pill+'</div>';
    }).join(''):'<div class="muted">No hay insumos de embalaje cargados en esta operación.</div>';

    // --- Excepciones ---
    var ex=d.excepciones||[];
    $("#dash-exc-sub").textContent=ex.length?(ex.length+' abierta(s)'):'nada pendiente';
    $("#dash-excepciones").innerHTML=ex.length?ex.map(function(e){
      return '<div class="dexc"><span class="dot '+esc(e.severidad)+'"></span>'
        +'<span class="tx">'+esc(e.titulo)+'<small>'+esc(e.accion||'')+'</small></span>'
        +'<span class="cl">'+esc(e.cliente)+'</span><span class="ag">'+esc(hace(e.minutos))+'</span></div>';
    }).join(''):'<div class="muted">Sin excepciones abiertas. 👍</div>';

    // --- Ocupación por zona ---
    var pz=(d.ocupacion&&d.ocupacion.porZona)||{};
    $("#dash-occ-sub").textContent=(d.ocupacion.pct==null?'':d.ocupacion.pct+'% del total');
    $("#dash-occzonas").innerHTML=Object.keys(pz).map(function(z){
      var x=pz[z], p=x.capacidad>0?Math.round(x.usado/x.capacidad*100):null;
      return '<div class="dbar"><span class="n">'+esc(zoneName(z))+'</span>'
        +bar(p==null?0:p, p==null?'mute':p>=90?'crit':p>=75?'warn':'ok')
        +'<span class="q">'+(p==null?'sin límite':p+'%')+' <small>'+fmtInt(x.usado)+' u</small></span></div>';
    }).join('')||'<div class="muted">Sin ubicaciones.</div>';

    // Los KPIs viejos son "del cliente actual": en vista consolidada confunden.
    var kp=$("#kpis"); if(kp)kp.classList.toggle('hidden', !!d.alcance.consolidado);

    // Lo que el sistema todavía no mide se dice, no se inventa.
    if(d.faltantes&&d.faltantes.length&&$("#dash-excepciones")){
      $("#dash-excepciones").insertAdjacentHTML('beforeend','<div class="dashnote">Pendiente de configurar: '+esc(d.faltantes.join(' · '))+'</div>');
    }
  }

  function renderOpMetrics(){
    if(!$("#opm-tiles"))return;
    loadDash().then(dashTick);
  }
  function paintOpMetrics(){
    if(!$("#opm-tiles")||!DASH)return;
    var a=DASH.actividad, sub;
    if(DASH.ventana.tipo==='personalizado'){
      var toShow=new Date(DASH.ventana.hasta); toShow.setDate(toShow.getDate()-1);
      sub='Del '+dOnly(DASH.ventana.desde)+' al '+dOnly(toShow.toISOString())+' · comparado con el período previo equivalente';
    } else {
      var lab=OPM_LABEL[DASH.ventana.tipo]||['',''];
      sub=lab[0]+' · comparado con '+lab[1];
    }
    // El encabezado dice de quién son los números: toda la operación o un cliente.
    var alcance=DASH.alcance.consolidado
      ? 'Operación consolidada — todos los clientes ('+DASH.alcance.clientes+')'
      : 'Cliente: '+esc((byId(D.sellers||[],DASH.alcance.sellerId)||{}).name||DASH.alcance.sellerId);
    if($("#opm-sub"))$("#opm-sub").textContent=alcance+' · '+sub;
    var defs=[
      {l:'Órdenes preparadas',mv:a.ordenesPreparadas},
      {l:'Unidades preparadas',mv:a.unidadesPreparadas},
      {l:'Órdenes recibidas',mv:a.ordenesRecibidas},
      {l:'Unidades recibidas',mv:a.unidadesRecibidas},
      {l:'Movimientos',mv:a.movimientos}
    ];
    $("#opm-tiles").innerHTML=defs.map(function(x){
      var mv={current:x.mv.valor,previous:x.mv.anterior,pct:x.mv.cambioPct};
      return '<div class="mtile"><div class="ml">'+x.l+'</div><div class="mv">'+fmtInt(mv.current)+'</div>'
        +'<div class="mdelta">'+deltaChip(mv)+'<span class="prev">ant.: '+fmtInt(mv.previous)+'</span></div></div>';
    }).join("");
  }

  // ===== Dashboard AI: tableros a medida armados con el LLM =====================
  // El servidor guarda la ESPECIFICACIÓN de cada widget (qué preguntar y cómo
  // mostrarlo), no los datos. Acá se dibuja esa especificación y se piden los
  // datos aparte, cada 30 s: por eso el tablero siempre está en vivo.
  var AID={ list:[], cur:null, data:{}, timer:null, hist:[], sel:null, charts:{} };
  var AID_MS=30000;

  /**
   * ECharts se carga SOLO al entrar a la sección (1 MB no se le cobra a quien
   * nunca abre el Dashboard AI). Se sirve desde el propio servidor, sin CDN.
   */
  var aidEchartsP=null;
  function aidEcharts(){
    if(window.echarts)return Promise.resolve(window.echarts);
    if(aidEchartsP)return aidEchartsP;
    aidEchartsP=new Promise(function(res,rej){
      var sc=document.createElement('script');
      sc.src='./vendor/echarts.min.js';
      sc.onload=function(){res(window.echarts);};
      sc.onerror=function(){rej(new Error('no se pudo cargar la librería de gráficos'));};
      document.head.appendChild(sc);
    });
    return aidEchartsP;
  }
  /** Paleta del tablero según su tema. */
  function aidTheme(){
    var torre=AID.cur&&AID.cur.tema==='torre';
    return torre
      ? {torre:true, ink:'#EAF0F7', ink2:'#9FB0C6', ink3:'#5E7189', line:'rgba(255,255,255,.09)', surf:'#0E1520',
         serie:['#12E39B','#22D3EE','#8B7BFF','#FFC24B','#FF6B6B','#5E7189']}
      : {torre:false, ink:'#0E1A20', ink2:'#41525C', ink3:'#7C8D97', line:'#E3EAEC', surf:'#ffffff',
         serie:['#12B886','#0EA5A5','#6366F1','#E5A13A','#E05A4B','#C9D6DB']};
  }

  function aidApi(path,opts){ return api('/ai-dashboards'+path,opts); }

  function renderAiDash(){
    if(!$("#aid-canvas"))return;
    aidApi('?operationId='+encodeURIComponent(op)).then(function(list){
      AID.list=list||[];
      var sel=$("#aid-sel");
      sel.innerHTML=AID.list.map(function(d){return '<option value="'+esc(d.id)+'">'+esc(d.nombre)+'</option>';}).join('')
        ||'<option value="">(sin tableros)</option>';
      if(AID.list.length){
        var id=(AID.cur&&AID.list.some(function(d){return d.id===AID.cur.id;}))?AID.cur.id:AID.list[0].id;
        sel.value=id;
        aidLoad(id);
      } else {
        AID.cur=null; aidPaint();
      }
    }).catch(function(e){ toast(e.message); });
  }
  function aidLoad(id){
    return aidApi('/'+id+'?operationId='+encodeURIComponent(op)).then(function(d){
      AID.cur=d; aidPaint(); return aidData();
    }).catch(function(e){ toast(e.message); });
  }
  function aidData(){
    if(!AID.cur)return Promise.resolve();
    return aidApi('/'+AID.cur.id+'/data?operationId='+encodeURIComponent(op)+(seller?('&sellerId='+encodeURIComponent(seller)):''))
      .then(function(r){ AID.data=r.widgets||{}; aidPaintData(); })
      .catch(function(){});
  }
  function aidTick(){
    clearTimeout(AID.timer);
    if(!document.querySelector('.page[data-pg="aidash"].on'))return; // solo mientras se ve
    AID.timer=setTimeout(function(){ aidData().then(aidTick); }, AID_MS);
  }

  var AID_EJEMPLOS=[
    'Muéstrame las órdenes atrasadas y quién las tiene asignadas',
    'Un KPI con las unidades en stock y otro con las órdenes en riesgo',
    'Tabla de los SKUs por quebrar stock, los 10 peores',
    'Barras con la carga de trabajo por operario',
    'Cuánto llevo facturado este mes por cliente'
  ];
  function aidPaint(){
    var c=$("#aid-canvas"); if(!c)return;
    // Cada repintado destruye los gráficos anteriores: si no, quedan canvas huérfanos
    // consumiendo memoria en una pantalla que vive horas encendida.
    Object.keys(AID.charts).forEach(function(k){ try{ if(AID.charts[k].__ro)AID.charts[k].__ro.disconnect(); AID.charts[k].dispose(); }catch(e){} });
    AID.charts={};
    var sec=document.querySelector('.page[data-pg="aidash"]');
    if(sec)sec.classList.toggle('aid-torre', !!(AID.cur&&AID.cur.tema==='torre'));
    if(!AID.cur){
      c.innerHTML='<div class="aid-blank"><b>Arma tu primer tablero</b>'
        +'Pídelo en tus palabras y se construye solo, con datos en vivo de tu bodega.'
        +'<div class="aid-chips">'+AID_EJEMPLOS.map(function(x){return '<button data-ej="'+esc(x)+'">'+esc(x)+'</button>';}).join('')+'</div></div>';
      $$("#aid-canvas [data-ej]").forEach(function(b){b.addEventListener('click',function(){
        $("#aid-q").value=b.getAttribute('data-ej'); aidCrearYEnviar();
      });});
      return;
    }
    var ws=AID.cur.widgets||[];
    if(!ws.length){
      c.innerHTML='<div class="aid-blank"><b>«'+esc(AID.cur.nombre)+'» está vacío</b>'
        +'Escribe arriba lo que quieres ver, o usa ＋ Widget para armarlo a mano.'
        +'<div class="aid-chips">'+AID_EJEMPLOS.map(function(x){return '<button data-ej="'+esc(x)+'">'+esc(x)+'</button>';}).join('')+'</div></div>';
      $$("#aid-canvas [data-ej]").forEach(function(b){b.addEventListener('click',function(){
        $("#aid-q").value=b.getAttribute('data-ej'); aidEnviar();
      });});
      return;
    }
    c.innerHTML=ws.map(function(w){
      var esGrafico=['gauge','rosco','area','apiladas','radar','treemap','calendario','sankey'].indexOf(w.tipo)>=0;
      return '<div class="aid-w'+(esGrafico?' chart':'')+(AID.sel===w.id?' sel':'')+'" data-w="'+esc(w.id)+'" style="grid-column:'+(w.x+1)+' / span '+w.ancho+';grid-row:'+(w.y+1)+' / span '+w.alto+'">'
        +'<div class="wh" data-drag="'+esc(w.id)+'"><span class="wt">'+esc(w.titulo)+'</span>'
        +'<span class="wa"><button data-wedit="'+esc(w.id)+'" title="Editar">✎</button>'
        +'<button data-wdup="'+esc(w.id)+'" title="Duplicar">⧉</button>'
        +'<button data-winfo="'+esc(w.id)+'" title="¿De dónde sale este dato?">ⓘ</button>'
        +'<button data-wdel="'+esc(w.id)+'" title="Eliminar">✕</button></span></div>'
        +'<div class="wb" id="aidb-'+esc(w.id)+'"><div class="aid-empty">Cargando…</div></div>'
        +(w.display&&w.display.nota?'<div class="wfoot">'+esc(w.display.nota)+'</div>':'')
        +'<div class="rz" data-rz="'+esc(w.id)+'"></div></div>';
    }).join('');
    aidWire();
    aidPaintData();
  }

  function aidFmt(v,fmt,unidad){
    if(v==null||v==='')return '—';
    if(fmt==='dinero')return money(Number(v)||0,'CLP');
    if(fmt==='porcentaje')return (Math.round(Number(v)*10)/10)+'%';
    if(fmt==='fecha')return fmtDate(v);
    if(fmt==='numero'||typeof v==='number')return fmtInt(Math.round(Number(v)*100)/100)+(unidad?(' '+unidad):'');
    return String(v);
  }
  function aidPaintData(){
    (AID.cur&&AID.cur.widgets||[]).forEach(function(w){
      var host=$("#aidb-"+w.id); if(!host)return;
      var d=AID.data[w.id];
      if(w.tipo==='texto'){ host.innerHTML='<div style="font-size:13px;line-height:1.5">'+esc((w.display&&w.display.texto)||'')+'</div>'; return; }
      if(!d){ host.innerHTML='<div class="aid-empty">Cargando…</div>'; return; }
      if(d.error){ host.innerHTML='<div class="aid-empty"><span class="aid-err">No se pudo consultar: '+esc(d.error)+'</span></div>'; return; }
      var filas=d.filas||[];
      if(w.tipo==='kpi'){
        host.innerHTML='<div class="aid-kpi"><div class="n">'+esc(aidFmt(d.valor,(w.display&&w.display.formato)||'numero'))+'</div>'
          +((w.display&&w.display.unidad)?'<div class="u">'+esc(w.display.unidad)+'</div>':'')+'</div>';
        return;
      }
      if(!filas.length){ host.innerHTML='<div class="aid-empty">Sin datos para mostrar todavía.</div>'; return; }
      if(w.tipo==='tabla'){
        var cols=(w.display&&w.display.columnas&&w.display.columnas.length)
          ? w.display.columnas
          : Object.keys(filas[0]).slice(0,6).map(function(k){return {campo:k,titulo:k};});
        host.innerHTML='<table class="aid-tbl"><thead><tr>'+cols.map(function(c){return '<th>'+esc(c.titulo||c.campo)+'</th>';}).join('')+'</tr></thead><tbody>'
          +filas.slice(0,200).map(function(f){
            return '<tr>'+cols.map(function(c){
              var v=f[c.campo]; var num=typeof v==='number';
              return '<td'+(num?' class="num"':'')+'>'+esc(aidFmt(v,c.formato))+'</td>';
            }).join('')+'</tr>';
          }).join('')+'</tbody></table>';
        return;
      }
      if(w.tipo==='barras'||w.tipo==='lista'){
        var kf=(w.transform&&w.transform.groupBy)?'clave':(Object.keys(filas[0])[0]);
        var vf=(filas[0].valor!==undefined)?'valor':(Object.keys(filas[0]).filter(function(k){return typeof filas[0][k]==='number';})[0]);
        var max=Math.max.apply(null,[1].concat(filas.map(function(f){return Number(f[vf])||0;})));
        host.innerHTML=filas.slice(0,40).map(function(f){
          var v=Number(f[vf])||0;
          return '<div class="aid-row"><span class="k">'+esc(String(f[kf]!=null?f[kf]:'—'))+'</span>'
            +(w.tipo==='barras'?'<span class="b"><i style="width:'+Math.max(2,v/max*100)+'%'+((w.display&&w.display.color)?';background:'+esc(w.display.color):'')+'"></i></span>':'')
            +'<span class="v">'+esc(aidFmt(v,(w.display&&w.display.formato)||'numero'))+'</span></div>';
        }).join('');
        return;
      }
      // ---- Tipos gráficos (ECharts) y visuales propios -------------------------
      if(['gauge','rosco','area','apiladas','radar','treemap','calendario','sankey'].indexOf(w.tipo)>=0){
        host.innerHTML='<div class="aid-ec"></div>';
        aidChart(w, host.firstChild, d);
        return;
      }
      if(w.tipo==='mapa3d'){ host.innerHTML=aidMapa3d(filas); return; }
      if(w.tipo==='bullet'){ host.innerHTML=aidBullet(filas,w); return; }
      if(w.tipo==='latido'){ host.innerHTML=aidLatido(filas); return; }
      if(w.tipo==='lineas'){
        var vf2=(filas[0].valor!==undefined)?'valor':(Object.keys(filas[0]).filter(function(k){return typeof filas[0][k]==='number';})[0]);
        var vals=filas.map(function(f){return Number(f[vf2])||0;}), mx=Math.max.apply(null,[1].concat(vals));
        host.innerHTML='<div class="aid-spark">'+vals.slice(-60).map(function(v){
          return '<i style="height:'+Math.max(3,v/mx*100)+'%"></i>';
        }).join('')+'</div>';
        return;
      }
      host.innerHTML='<div class="aid-empty">Tipo de widget no soportado.</div>';
    });
  }

  /**
   * Dibuja un widget gráfico con ECharts. Cada tipo traduce las filas del widget
   * (clave/valor) a la opción que ECharts espera; el tema decide los colores.
   */
  function aidChart(w, el, d){
    aidEcharts().then(function(ec){
      var T=aidTheme(), filas=(d&&d.filas)||[], val=d&&d.valor;
      // ECharts mide el contenedor al crearse: si lo hace antes de que el navegador
      // termine de acomodar la grilla, el gráfico queda del tamaño equivocado y se
      // sale de su tarjeta. Por eso se crea en el siguiente cuadro y se le avisa
      // cada vez que el widget cambia de tamaño (arrastre, resize de ventana).
      // OJO: no se le pasa width/height al crear. Si se los pasas, ECharts los toma
      // como fijos y resize() deja de tener efecto: el gráfico se dibuja fuera de su
      // tarjeta para siempre. Se crea sin medidas y se ajusta al contenedor.
      var ch=ec.init(el, null, {renderer:'canvas'});
      AID.charts[w.id]=ch;
      try{ window.__aidCharts=AID.charts; }catch(e){}
      requestAnimationFrame(function(){ try{ ch.resize({width:'auto',height:'auto'}); }catch(e){} });
      if(window.ResizeObserver){
        var ro=new ResizeObserver(function(){ try{ ch.resize({width:'auto',height:'auto'}); }catch(e){} });
        ro.observe(el); ch.__ro=ro;
      }
      var G=ec.graphic, base={animation:true,animationDuration:700,textStyle:{fontFamily:'Inter'}};
      var op=null;
      var clave=function(f){return f.clave!=null?f.clave:(f.nombre||f.fecha||f.sku||f.courier||Object.values(f)[0]);};
      var valor=function(f){return Number(f.valor!=null?f.valor:(f.unidades!=null?f.unidades:(f.ordenes!=null?f.ordenes:0)))||0;};

      if(w.tipo==='gauge'){
        // Acepta un número suelto o un objeto con {pct} / {usado, capacidad}.
        var pct=val;
        if(pct==null&&filas.length){ var f0=filas[0]; pct=(f0.pct!=null)?f0.pct:(f0.capacidad?Math.round(f0.usado/f0.capacidad*100):valor(f0)); }
        pct=Math.max(0,Math.min(100,Math.round(Number(pct)||0)));
        var sub=(filas[0]&&filas[0].usado!=null&&filas[0].capacidad!=null)
          ? fmtInt(filas[0].usado)+' de '+fmtInt(filas[0].capacidad)+' '+(filas[0].unidad||'')
          : ((w.display&&w.display.nota)||'');
        op={series:[{type:'gauge',startAngle:210,endAngle:-30,min:0,max:100,radius:'94%',center:['50%','58%'],
          progress:{show:true,width:14,roundCap:true,itemStyle:{color:new G.LinearGradient(0,0,1,0,[{offset:0,color:T.serie[0]},{offset:.6,color:T.serie[3]},{offset:1,color:T.serie[4]}])}},
          axisLine:{lineStyle:{width:14,color:[[1,T.torre?'rgba(255,255,255,.08)':'#EDF2F3']]}},
          pointer:{show:false},axisTick:{show:false},splitLine:{show:false},
          axisLabel:{color:T.ink3,fontSize:9,distance:-22},
          detail:{fontSize:30,fontFamily:'Sora',fontWeight:800,color:T.ink,offsetCenter:[0,'6%'],formatter:'{value}%'},
          title:{show:!!sub,offsetCenter:[0,'44%'],color:T.ink3,fontSize:10.5},
          data:[{value:pct,name:sub}]}]};
      }
      else if(w.tipo==='rosco'){
        var total=filas.reduce(function(a,f){return a+valor(f);},0);
        op={legend:{bottom:0,icon:'circle',itemWidth:7,itemHeight:7,textStyle:{color:T.ink2,fontSize:11}},
          series:[{type:'pie',radius:['56%','80%'],center:['50%','44%'],
            itemStyle:{borderColor:T.surf,borderWidth:3,borderRadius:5},labelLine:{show:false},
            label:{show:true,position:'center',formatter:'{a|'+fmtInt(total)+'}',rich:{a:{fontFamily:'Sora',fontSize:26,fontWeight:800,color:T.ink}}},
            data:filas.slice(0,8).map(function(f,i){return {name:String(clave(f)),value:valor(f),itemStyle:{color:T.serie[i%T.serie.length]}};})}]};
      }
      else if(w.tipo==='area'){
        op={grid:{left:40,right:10,top:14,bottom:24},
          xAxis:{type:'category',data:filas.map(function(f){return String(clave(f)).slice(5);}),
            axisLine:{lineStyle:{color:T.line}},axisTick:{show:false},axisLabel:{color:T.ink3,fontSize:10}},
          yAxis:{type:'value',splitLine:{lineStyle:{color:T.line}},axisLabel:{color:T.ink3,fontSize:10}},
          series:[{type:'line',smooth:true,showSymbol:false,data:filas.map(valor),
            lineStyle:{width:2.5,color:T.serie[0]},
            areaStyle:{color:new G.LinearGradient(0,0,0,1,[{offset:0,color:T.serie[0]+'55'},{offset:1,color:T.serie[0]+'05'}])}}]};
      }
      else if(w.tipo==='apiladas'){
        op={grid:{left:40,right:10,top:14,bottom:24},
          xAxis:{type:'category',data:filas.map(function(f){return String(clave(f));}),
            axisLine:{lineStyle:{color:T.line}},axisTick:{show:false},axisLabel:{color:T.ink3,fontSize:10,interval:0,rotate:filas.length>6?28:0}},
          yAxis:{type:'value',splitLine:{lineStyle:{color:T.line}},axisLabel:{color:T.ink3,fontSize:10}},
          series:[{type:'bar',barMaxWidth:26,data:filas.map(function(f,i){return {value:valor(f),itemStyle:{color:T.serie[i%T.serie.length],borderRadius:[4,4,0,0]}};})}]};
      }
      else if(w.tipo==='radar'){
        var ind=filas.slice(0,8).map(function(f){return {name:String(clave(f)),max:Math.max.apply(null,filas.map(valor))||100};});
        op={radar:{center:['50%','52%'],radius:'66%',indicator:ind,axisName:{color:T.ink2,fontSize:10},
            splitLine:{lineStyle:{color:T.line}},splitArea:{show:false},axisLine:{lineStyle:{color:T.line}}},
          series:[{type:'radar',symbolSize:4,data:[{value:filas.map(valor),itemStyle:{color:T.serie[0]},areaStyle:{color:T.serie[0]+'38'}}]}]};
      }
      else if(w.tipo==='treemap'){
        op={series:[{type:'treemap',roam:false,nodeClick:false,breadcrumb:{show:false},top:2,bottom:2,left:2,right:2,
          itemStyle:{borderColor:T.surf,borderWidth:2,gapWidth:2},
          label:{fontSize:11,fontWeight:600,color:'#06121A'},
          levels:[{itemStyle:{gapWidth:3}},{colorSaturation:[.35,.62]}],
          data:filas.slice(0,12).map(function(f,i){
            var n={name:String(clave(f)),value:valor(f),itemStyle:{color:T.serie[i%T.serie.length]}};
            if(Array.isArray(f.hijos)&&f.hijos.length)n.children=f.hijos.map(function(h){return {name:String(h.clave||h.sku||''),value:Number(h.valor)||0};});
            return n;})}]};
      }
      else if(w.tipo==='calendario'){
        var ds=filas.map(function(f){return [String(f.fecha||clave(f)).slice(0,10), valor(f)];}).filter(function(x){return /^\d{4}-\d{2}-\d{2}$/.test(x[0]);});
        if(!ds.length){ el.innerHTML='<div class="aid-empty">Sin serie de días.</div>'; return; }
        var mx=Math.max.apply(null,ds.map(function(x){return x[1];}))||1;
        op={visualMap:{show:false,min:0,max:mx,inRange:{color:T.torre?['#0C2430','#0E5C68','#12A88C','#3BE8A7']:['#E4F7EF','#5BD6B0','#12B886','#0C7A5E']}},
          calendar:{top:24,left:34,right:12,bottom:8,cellSize:['auto',14],range:[ds[0][0],ds[ds.length-1][0]],
            splitLine:{show:false},itemStyle:{color:'transparent',borderColor:T.surf,borderWidth:2},yearLabel:{show:false},
            dayLabel:{color:T.ink3,fontSize:9,nameMap:['D','L','M','M','J','V','S']},
            monthLabel:{color:T.ink2,fontSize:10,nameMap:['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic']}},
          series:[{type:'heatmap',coordinateSystem:'calendar',data:ds,itemStyle:{borderRadius:3}}]};
      }
      else if(w.tipo==='sankey'){
        var raw=(d&&d.crudo)||null;
        var nodos=(raw&&raw.nodos)||[], enlaces=(raw&&raw.enlaces)||[];
        if(!nodos.length){ el.innerHTML='<div class="aid-empty">Esta fuente no entrega un flujo (nodos y enlaces).</div>'; return; }
        op={series:[{type:'sankey',left:6,right:104,top:8,bottom:8,nodeWidth:12,nodeGap:12,
          lineStyle:{color:'gradient',opacity:.3,curveness:.5},
          label:{color:T.ink,fontSize:11,fontWeight:600},
          data:nodos.map(function(n,i){return {name:n.nombre||n.name,itemStyle:{color:n.color||T.serie[i%T.serie.length]}};}),
          links:enlaces.map(function(l){return {source:l.desde||l.source,target:l.hacia||l.target,value:Number(l.valor||l.value)||0};})}]};
      }
      if(op)ch.setOption(Object.assign({},base,op));
    }).catch(function(e){ el.innerHTML='<div class="aid-empty"><span class="aid-err">'+esc(e.message)+'</span></div>'; });
  }

  /** La bodega vista de arriba: cada ubicación es un bloque con su ocupación. */
  function aidMapa3d(filas){
    if(!filas.length)return '<div class="aid-empty">Sin ubicaciones para dibujar.</div>';
    var cols=Math.min(10,Math.max(4,Math.ceil(Math.sqrt(filas.length*1.6))));
    var cel=filas.length>40?22:filas.length>24?28:34;
    var html='<div class="aid-iso"><div class="aid-fl" style="grid-template-columns:repeat('+cols+','+cel+'px)">';
    filas.slice(0,60).forEach(function(f){
      var cap=Number(f.capacidad)||0, us=Number(f.ocupado!=null?f.ocupado:f.valor)||0;
      var pct=cap>0?Math.min(100,Math.round(us/cap*100)):(us>0?55:0);
      var c=pct>85?'#FF6B6B':pct>60?'#FFC24B':pct>0?'#12E39B':'#9FB0C6';
      html+='<div class="aid-rk" style="height:'+cel+'px" title="'+esc((f.codigo||f.clave||'')+' · '+pct+'%')+'">'
        +'<span style="transform:translateZ('+(4+pct/2.4)+'px);background:linear-gradient(145deg,'+c+'ee,'+c+'77);color:'+c+'"></span></div>';
    });
    return html+'</div></div>';
  }
  /** Valor contra su meta: la barra es el valor, la marca es el compromiso. */
  function aidBullet(filas,w){
    if(!filas.length)return '<div class="aid-empty">Sin datos.</div>';
    var campo=(w.transform&&w.transform.field)||'valor';
    var vals=filas.map(function(f){return Number(f[campo]!=null?f[campo]:f.valor)||0;});
    var max=Math.max.apply(null,[1].concat(vals));
    var meta=(w.display&&w.display.meta)||null;
    return '<div class="aid-bul">'+filas.slice(0,10).map(function(f,i){
      var v=vals[i], pc=v/max*100;
      var col=pc>85?'var(--crit)':pc>60?'var(--warn)':'var(--primary)';
      return '<div class="row"><div class="lb">'+esc(String(f.nombre||f.clave||f.sku||'—'))+'<b>'+fmtInt(v)+'</b></div>'
        +'<div class="tr"><i style="width:'+Math.max(2,pc)+'%;background:'+col+'"></i>'+(meta?'<u style="left:'+meta+'%"></u>':'')+'</div></div>';
    }).join('')+'</div>';
  }
  /** Lo que está pasando ahora, con su pulso de color. */
  function aidLatido(filas){
    if(!filas.length)return '<div class="aid-empty">Nada que reportar. 👍</div>';
    var COL={crit:'var(--crit)',warn:'var(--warn)',info:'var(--primary)'};
    return '<div class="aid-lat">'+filas.slice(0,12).map(function(f){
      var txt=f.titulo||f.title||f.texto||f.clave||'—';
      var cu=f.creada||f.at||f.desde||null;
      var min=cu?Math.max(0,Math.round((Date.now()-Date.parse(cu))/60000)):null;
      return '<div><i style="background:'+(COL[f.severidad||f.severity]||'var(--ink-3)')+'"></i>'
        +'<span>'+esc(String(txt))+'</span><b>'+esc(min==null?'':hace(min))+'</b></div>';
    }).join('')+'</div>';
  }

  // ---- Arrastrar, redimensionar y acciones por widget -------------------------
  function aidWire(){
    $$("#aid-canvas [data-wdel]").forEach(function(b){b.addEventListener('click',function(e){e.stopPropagation();
      aidPatch([{op:'eliminar',id:b.getAttribute('data-wdel')}]);
    });});
    $$("#aid-canvas [data-wdup]").forEach(function(b){b.addEventListener('click',function(e){e.stopPropagation();
      var w=aidW(b.getAttribute('data-wdup')); if(!w)return;
      var copia=JSON.parse(JSON.stringify(w)); delete copia.id; copia.titulo=w.titulo+' (copia)'; copia.y=null;
      aidPatch([{op:'agregar',widget:copia}]);
    });});
    $$("#aid-canvas [data-wedit]").forEach(function(b){b.addEventListener('click',function(e){e.stopPropagation();
      aidEditor(aidW(b.getAttribute('data-wedit')));
    });});
    $$("#aid-canvas [data-winfo]").forEach(function(b){b.addEventListener('click',function(e){e.stopPropagation();
      var w=aidW(b.getAttribute('data-winfo')); if(!w)return;
      openModal('De dónde sale «'+esc(w.titulo)+'»',
        '<p class="muted" style="margin:0 0 10px">Este widget consulta una fuente de <b>solo lectura</b> del WMS, con tus permisos y tu operación. No guarda datos: los vuelve a pedir cada 30 segundos.</p>'
        +'<div class="kv"><span>Fuente</span><b>'+esc(w.source?w.source.tool:'—')+'</b></div>'
        +(w.source&&w.source.path?'<div class="kv"><span>Campo</span><b>'+esc(w.source.path)+'</b></div>':'')
        +(w.source&&w.source.args&&Object.keys(w.source.args).length?'<div class="kv"><span>Parámetros</span><b>'+esc(JSON.stringify(w.source.args))+'</b></div>':'')
        +(w.transform?'<div class="kv"><span>Transformación</span><b>'+esc(JSON.stringify(w.transform))+'</b></div>':'')
        +'<div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn pri" id="m-ok">Cerrar</button></div>');
      $("#m-ok").addEventListener('click',closeModal);
    });});
    $$("#aid-canvas [data-drag]").forEach(function(h){ aidDrag(h,'move'); });
    $$("#aid-canvas [data-rz]").forEach(function(h){ aidDrag(h,'resize'); });
  }
  function aidW(id){ return (AID.cur&&AID.cur.widgets||[]).filter(function(w){return w.id===id;})[0]; }

  /**
   * Arrastre y redimensión sobre la grilla de 12 columnas. Se calcula en celdas,
   * no en píxeles: así el resultado es el mismo en cualquier pantalla y lo que se
   * guarda son coordenadas de grilla, no posiciones absolutas.
   */
  function aidDrag(handle,modo){
    handle.addEventListener('mousedown',function(ev){
      if(ev.button!==0)return;
      if(window.innerWidth<=860)return; // en el teléfono todo va apilado
      ev.preventDefault();
      var id=handle.getAttribute('data-drag')||handle.getAttribute('data-rz');
      var w=aidW(id); if(!w)return;
      var canvas=$("#aid-canvas"), rect=canvas.getBoundingClientRect();
      var colW=(rect.width-11*12)/12+12, rowH=52; // 40 px + 12 de gap
      var x0=ev.clientX, y0=ev.clientY, ox=w.x, oy=w.y, ow=w.ancho, oh=w.alto;
      var el=handle.closest('.aid-w');
      canvas.classList.add('drag'); AID.sel=id; el.classList.add('sel');
      function mover(e){
        var dx=Math.round((e.clientX-x0)/colW), dy=Math.round((e.clientY-y0)/rowH);
        if(modo==='move'){
          w.x=Math.max(0,Math.min(12-ow,ox+dx)); w.y=Math.max(0,oy+dy);
        } else {
          w.ancho=Math.max(1,Math.min(12-w.x,ow+dx)); w.alto=Math.max(2,Math.min(24,oh+dy));
        }
        el.style.gridColumn=(w.x+1)+' / span '+w.ancho;
        el.style.gridRow=(w.y+1)+' / span '+w.alto;
      }
      function soltar(){
        document.removeEventListener('mousemove',mover); document.removeEventListener('mouseup',soltar);
        canvas.classList.remove('drag');
        if(w.x!==ox||w.y!==oy||w.ancho!==ow||w.alto!==oh){
          aidPatch([{op:'mover',id:id,x:w.x,y:w.y,ancho:w.ancho,alto:w.alto}],true);
        }
      }
      document.addEventListener('mousemove',mover); document.addEventListener('mouseup',soltar);
    });
  }

  /** Guarda cambios hechos a mano; el servidor valida igual que al LLM. */
  function aidPatch(ops,silencioso){
    if(!AID.cur)return Promise.resolve();
    return aidApi('/'+AID.cur.id,{method:'PATCH',body:{operationId:op,ops:ops}}).then(function(r){
      AID.cur=r.dashboard;
      if(r.rechazados&&r.rechazados.length){ AIDC.push({rol:'ai',texto:'',rechazados:r.rechazados}); aidChatPaint(); }
      aidPaint(); return aidData();
    }).catch(function(e){ toast(e.message); if(!silencioso)renderAiDash(); });
  }

  // ---- Conversación con el agente ---------------------------------------------
  // El agente NO aplica cambios: pregunta hasta entender, propone un plan y la
  // persona decide. Construir es un clic explícito.
  var AIDC=[]; // hilo visible {rol, texto, preguntas, plan, ops, rechazados}
  function aidChatPaint(){
    var box=$("#aid-chat"); if(!box)return;
    if(!AIDC.length){ box.classList.add('hidden'); box.innerHTML=''; return; }
    box.classList.remove('hidden');
    box.innerHTML=AIDC.map(function(m,idx){
      if(m.rol==='me')return '<div class="aid-b me"><span class="who me">Tú</span><div class="tx">'+esc(m.texto)+'</div></div>';
      if(m.rol==='pensando')return '<div class="aid-b"><span class="who ai">✦</span><div class="tx"><span class="aid-think"><i></i><i></i><i></i></span></div></div>';
      var h='<div class="aid-b"><span class="who ai">✦</span><div class="tx">'+esc(m.texto||'');
      (m.preguntas||[]).forEach(function(p){
        h+='<div style="margin-top:8px;font-weight:600">'+esc(p.texto)+'</div>';
        if((p.opciones||[]).length)h+='<div class="aid-qs">'+p.opciones.map(function(o){
          return '<button data-resp="'+esc(o)+'">'+esc(o)+'</button>';}).join('')+'</div>';
      });
      if(m.plan){
        h+='<div class="aid-plan"><div class="l">Propuesta</div><div class="p">'+esc(m.plan)+'</div>'
          +((m.cambios||[]).length?'<ul>'+m.cambios.map(function(c){return '<li>'+esc(c)+'</li>';}).join('')+'</ul>':'')
          +'<button class="btn pri mini" data-build="'+idx+'">Construir</button> '
          +'<button class="btn mini" data-nobuild="'+idx+'">Mejor no</button></div>';
      }
      if((m.rechazados||[]).length)h+='<div class="aid-bad">No puedo hacer esto: '+esc(m.rechazados.join(' · '))+'</div>';
      return h+'</div></div>';
    }).join('');
    box.scrollTop=box.scrollHeight;
    $$("#aid-chat [data-resp]").forEach(function(b){b.addEventListener('click',function(){
      $("#aid-q").value=b.getAttribute('data-resp'); aidEnviar();
    });});
    $$("#aid-chat [data-build]").forEach(function(b){b.addEventListener('click',function(){
      var m=AIDC[Number(b.getAttribute('data-build'))]; if(!m||!m.ops)return;
      b.disabled=true; b.textContent='Construyendo…';
      aidPatch(m.ops).then(function(){
        m.plan=null; m.texto=(m.texto?m.texto+' ':'')+'✅ Construido.';
        aidChatPaint();
      });
    });});
    $$("#aid-chat [data-nobuild]").forEach(function(b){b.addEventListener('click',function(){
      var m=AIDC[Number(b.getAttribute('data-nobuild'))]; if(!m)return;
      m.plan=null; m.ops=null; aidChatPaint();
      $("#aid-q").focus();
    });});
  }

  function aidCrearYEnviar(){
    aidApi('',{method:'POST',body:{operationId:op,nombre:'Mi tablero'}}).then(function(d){
      AID.cur=d; return renderAiDash();
    }).then(function(){ aidEnviar(); });
  }
  function aidEnviar(){
    var q=$("#aid-q").value.trim(); if(!q)return;
    if(!AID.cur)return aidCrearYEnviar();
    var btn=$("#aid-send"); btn.disabled=true;
    AIDC.push({rol:'me',texto:q});
    AIDC.push({rol:'pensando'});
    aidChatPaint();
    $("#aid-q").value='';
    var historial=AIDC.filter(function(m){return m.rol==='me'||m.rol==='ai';})
      .slice(-10).map(function(m){return {role:m.rol==='me'?'user':'assistant',content:(m.texto||'')+(m.plan?(' · plan: '+m.plan):'')};});
    aidApi('/'+AID.cur.id+'/chat',{method:'POST',body:{operationId:op,sellerId:seller||undefined,prompt:q,historial:historial}})
      .then(function(r){
        AIDC.pop(); // saca el "pensando"
        AIDC.push({rol:'ai',texto:r.mensaje,preguntas:r.preguntas||[],plan:r.plan||null,
                   ops:(r.ops&&r.ops.length)?r.ops:null,cambios:r.cambios||[],rechazados:r.rechazados||[]});
        aidChatPaint();
      })
      .catch(function(e){ AIDC.pop(); AIDC.push({rol:'ai',texto:'',rechazados:[e.message]}); aidChatPaint(); })
      .then(function(){ btn.disabled=false; });
  }

  /** Editor manual de un widget (o uno nuevo): sin pasar por el modelo. */
  function aidEditor(w){
    var nuevo=!w;
    w=w||{tipo:'kpi',titulo:'',ancho:3,alto:3,source:{tool:'',args:{},path:''},transform:{},display:{}};
    var tipos=['kpi','tabla','barras','lineas','lista','texto'];
    aidApi('/capacidades').then(function(cap){
      var fuentes=[]; (cap.areas||[]).forEach(function(a){ a.fuentes.forEach(function(f){ fuentes.push({area:a.area,tool:f.tool,desc:f.descripcion}); }); });
      var opts=fuentes.map(function(f){return '<option value="'+esc(f.tool)+'"'+((w.source&&w.source.tool===f.tool)?' selected':'')+'>'+esc(f.area+' · '+f.tool)+'</option>';}).join('');
      openModal(nuevo?'Nuevo widget':'Editar widget',
        '<div class="form">'
        +'<div class="row2"><div class="fld"><label>Título</label><input id="aw-t" value="'+esc(w.titulo||'')+'"></div>'
        +'<div class="fld"><label>Tipo</label><select id="aw-tipo">'+tipos.map(function(t){return '<option value="'+t+'"'+(w.tipo===t?' selected':'')+'>'+t+'</option>';}).join('')+'</select></div></div>'
        +'<div class="fld" id="aw-fuente-wrap"><label>Fuente de datos (solo lectura)</label><select id="aw-tool"><option value="">—</option>'+opts+'</select>'
        +'<div class="hint" id="aw-desc"></div></div>'
        +'<div class="row2"><div class="fld"><label>Campo dentro de la respuesta (opcional)</label><input id="aw-path" value="'+esc((w.source&&w.source.path)||'')+'" placeholder="Ej: items"></div>'
        +'<div class="fld"><label>Agrupar por (opcional)</label><input id="aw-group" value="'+esc((w.transform&&w.transform.groupBy)||'')+'" placeholder="Ej: estado"></div></div>'
        +'<div class="row2"><div class="fld"><label>Campo a sumar (opcional)</label><input id="aw-field" value="'+esc((w.transform&&w.transform.field)||'')+'" placeholder="Ej: unidades"></div>'
        +'<div class="fld"><label>Operación</label><select id="aw-agg">'+['suma','conteo','promedio','maximo','minimo','primero'].map(function(a){return '<option value="'+a+'"'+((w.transform&&w.transform.agg)===a?' selected':'')+'>'+a+'</option>';}).join('')+'</select></div></div>'
        +'<div class="row2"><div class="fld"><label>Ancho (1–12)</label><input id="aw-w" type="number" min="1" max="12" value="'+(w.ancho||3)+'"></div>'
        +'<div class="fld"><label>Alto (2–24)</label><input id="aw-h" type="number" min="2" max="24" value="'+(w.alto||3)+'"></div></div>'
        +'<div class="fld" id="aw-texto-wrap" style="display:none"><label>Texto</label><textarea id="aw-texto" rows="3" style="width:100%;padding:8px;border-radius:9px;border:1px solid var(--line);background:var(--surface-2);color:var(--ink);font-family:inherit">'+esc((w.display&&w.display.texto)||'')+'</textarea></div>'
        +'<div class="fld"><label>Nota al pie (opcional)</label><input id="aw-nota" value="'+esc((w.display&&w.display.nota)||'')+'"></div>'
        +'<div id="aw-err" style="color:var(--crit);font-size:12.5px;min-height:16px"></div>'
        +'<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:8px"><button class="btn" id="m-no">Cancelar</button><button class="btn pri" id="aw-save">Guardar</button></div></div>', true);
      function sync(){
        var esTexto=$("#aw-tipo").value==='texto';
        $("#aw-fuente-wrap").style.display=esTexto?'none':'';
        $("#aw-texto-wrap").style.display=esTexto?'':'none';
        var f=fuentes.filter(function(x){return x.tool===$("#aw-tool").value;})[0];
        $("#aw-desc").textContent=f?f.desc:'';
      }
      $("#aw-tipo").addEventListener('change',sync); $("#aw-tool").addEventListener('change',sync); sync();
      $("#m-no").addEventListener('click',closeModal);
      $("#aw-save").addEventListener('click',function(){
        var nw={
          id: nuevo?undefined:w.id,
          tipo:$("#aw-tipo").value, titulo:$("#aw-t").value.trim()||'Sin título',
          ancho:Number($("#aw-w").value)||3, alto:Number($("#aw-h").value)||3,
          x: nuevo?0:w.x, y: nuevo?null:w.y,
          source: $("#aw-tipo").value==='texto'?null:{tool:$("#aw-tool").value,args:(w.source&&w.source.args)||{},path:$("#aw-path").value.trim()},
          transform:{groupBy:$("#aw-group").value.trim()||undefined,field:$("#aw-field").value.trim()||undefined,agg:$("#aw-agg").value},
          display:{texto:$("#aw-texto")?$("#aw-texto").value:undefined,nota:$("#aw-nota").value.trim()||undefined}
        };
        aidApi('/'+AID.cur.id,{method:'PATCH',body:{operationId:op,ops:[nuevo?{op:'agregar',widget:nw}:{op:'modificar',id:w.id,widget:nw}]}})
          .then(function(r){
            if(r.rechazados&&r.rechazados.length){ $("#aw-err").textContent=r.rechazados.join(' · '); return; }
            AID.cur=r.dashboard; closeModal(); aidPaint(); aidData();
          }).catch(function(e){ $("#aw-err").textContent=e.message; });
      });
    });
  }

  /**
   * Plantillas: tableros listos para invocar de una vez. La hoja en blanco es el
   * peor punto de partida; con una plantilla se ve el tablero armado y desde ahí
   * se edita. Reemplaza el contenido del tablero actual, así que se confirma.
   */
  var AID_TPL_PV={
    torre:'<div style="position:absolute;inset:0;background:#070B12"></div>'
      +'<div style="position:absolute;inset:8px;display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:14px;gap:5px">'
      +'<i style="background:rgba(18,227,155,.55);border-radius:3px"></i><i style="background:rgba(34,211,238,.5);border-radius:3px"></i><i style="background:rgba(255,194,75,.5);border-radius:3px"></i><i style="background:rgba(139,123,255,.5);border-radius:3px"></i>'
      +'<i style="grid-column:span 2;grid-row:span 3;background:rgba(255,255,255,.07);border-radius:5px"></i>'
      +'<i style="grid-column:span 2;grid-row:span 2;background:rgba(18,227,155,.18);border-radius:5px"></i>'
      +'<i style="grid-column:span 2;background:rgba(255,255,255,.07);border-radius:5px"></i></div>',
    premium:'<div style="position:absolute;inset:0;background:#F5F8F9"></div>'
      +'<div style="position:absolute;inset:8px;display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:14px;gap:5px">'
      +'<i style="grid-column:span 3;grid-row:span 2;background:linear-gradient(135deg,rgba(18,184,134,.25),rgba(99,102,241,.18));border-radius:5px"></i>'
      +'<i style="background:#fff;border:1px solid #E3EAEC;border-radius:5px"></i><i style="background:#fff;border:1px solid #E3EAEC;border-radius:5px"></i>'
      +'<i style="background:#fff;border:1px solid #E3EAEC;border-radius:5px"></i><i style="grid-column:span 2;background:#fff;border:1px solid #E3EAEC;border-radius:5px"></i>'
      +'<i style="background:rgba(18,184,134,.3);border-radius:5px"></i></div>',
    galeria:'<div style="position:absolute;inset:0;background:#F5F8F9"></div>'
      +'<div style="position:absolute;inset:8px;display:grid;grid-template-columns:repeat(4,1fr);grid-auto-rows:20px;gap:5px">'
      +'<i style="background:rgba(18,184,134,.35);border-radius:50%"></i><i style="background:rgba(14,165,165,.3);border-radius:5px"></i>'
      +'<i style="background:rgba(99,102,241,.3);border-radius:50%"></i><i style="background:rgba(229,161,58,.3);border-radius:5px"></i>'
      +'<i style="background:rgba(224,90,75,.25);border-radius:5px"></i><i style="background:rgba(18,184,134,.25);border-radius:5px"></i>'
      +'<i style="background:rgba(14,165,165,.25);border-radius:50%"></i><i style="background:rgba(99,102,241,.2);border-radius:5px"></i></div>'
  };
  function aidPlantillas(){
    if(!AID.cur){ toast('Crea un tablero primero'); return; }
    aidApi('/capacidades').then(function(c){
      var ps=c.plantillas||[];
      openModal('Plantillas de tablero',
        '<p class="muted" style="margin:0 0 14px">Cada una arma un tablero completo con datos en vivo de tu bodega. Reemplaza lo que tenga «'+esc(AID.cur.nombre)+'» — después puedes mover, editar o borrar lo que quieras.</p>'
        +'<div class="tplg">'+ps.map(function(p){
          return '<button class="tpl" data-tpl="'+esc(p.id)+'"><div class="pv">'+(AID_TPL_PV[p.id]||'')+'</div>'
            +'<h4>'+esc(p.nombre)+'</h4><p>'+esc(p.descripcion)+'</p>'
            +'<div class="meta">'+p.widgets+' widgets · tema '+(p.tema==='torre'?'oscuro':'claro')+'</div></button>';
        }).join('')+'</div>'
        +'<div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn" id="m-no">Cancelar</button></div>', 'xl');
      $("#m-no").addEventListener('click',closeModal);
      $$("#m-body [data-tpl]").forEach(function(b){b.addEventListener('click',function(){
        var id=b.getAttribute('data-tpl');
        b.style.opacity=.6; b.style.pointerEvents='none';
        aidPatch([{op:'plantilla',plantilla:id}]).then(function(){
          closeModal(); toast('Tablero armado');
          AIDC.push({rol:'ai',texto:'Armé el tablero con la plantilla «'+((ps.filter(function(x){return x.id===id;})[0]||{}).nombre||id)+'». Dime qué quieres cambiar.'});
          aidChatPaint();
        });
      });});
    }).catch(function(e){toast(e.message);});
  }

  function aidCapacidades(){
    aidApi('/capacidades').then(function(c){
      openModal('¿Qué puedo pedirle a este tablero?',
        '<div style="max-height:62vh;overflow:auto">'
        +'<p class="sec-t" style="margin:0 0 6px">Puede</p><ul style="margin:0 0 14px 18px;font-size:13px;line-height:1.6">'+c.puede.map(function(x){return '<li>'+esc(x)+'</li>';}).join('')+'</ul>'
        +'<p class="sec-t" style="margin:0 0 6px">No puede</p><ul style="margin:0 0 14px 18px;font-size:13px;line-height:1.6;color:var(--ink-3)">'+c.noPuede.map(function(x){return '<li>'+esc(x)+'</li>';}).join('')+'</ul>'
        +'<p class="sec-t" style="margin:0 0 6px">Tipos de widget</p><div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:14px">'
        +(c.tiposDeWidget||[]).map(function(t){return '<span class="dpill ok" title="'+esc(t.para||'')+'" style="background:var(--surface-2);color:var(--ink-2)">'+esc(t.tipo||t)+'</span>';}).join('')+'</div>'
        +'<p class="sec-t" style="margin:0 0 6px">Datos disponibles</p>'
        +(c.areas||[]).map(function(a){
          return '<div style="margin-bottom:12px"><b style="font-size:12.5px">'+esc(a.area)+'</b>'
            +a.fuentes.map(function(f){var d=String(f.descripcion||f.desc||'');return '<div class="muted" style="font-size:12px;margin-top:3px"><b style="font-family:\'IBM Plex Mono\',monospace">'+esc(f.tool)+'</b> — '+esc(d.split('.')[0])+'.</div>';}).join('')+'</div>';
        }).join('')
        +'</div><div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn pri" id="m-ok">Cerrar</button></div>', 'xl');
      $("#m-ok").addEventListener('click',closeModal);
    }).catch(function(e){toast(e.message);});
  }

  // ---- Barra superior de la sección ------------------------------------------
  if($("#aid-send")){
    $("#aid-send").addEventListener('click',aidEnviar);
    $("#aid-q").addEventListener('keydown',function(e){ if(e.key==='Enter')aidEnviar(); });
    $("#aid-sel").addEventListener('change',function(){ aidLoad(this.value); });
    $("#aid-refresh").addEventListener('click',function(){ aidData(); });
    $("#aid-help").addEventListener('click',aidCapacidades);
    $("#aid-widget").addEventListener('click',function(){ if(!AID.cur){toast('Crea un tablero primero');return;} aidEditor(null); });
    $("#aid-tpl").addEventListener('click',aidPlantillas);
    $("#aid-tema").addEventListener('click',function(){
      if(!AID.cur)return;
      var nuevo=(AID.cur.tema==='torre')?'claro':'torre';
      aidPatch([{op:'tema',tema:nuevo}]).then(function(){ toast(nuevo==='torre'?'Tema torre de control':'Tema claro'); });
    });
    $("#aid-new").addEventListener('click',function(){
      openModal('Nuevo tablero','<div class="form"><div class="fld"><label>Nombre</label><input id="aid-nm" value="Mi tablero" maxlength="80"></div>'
        +'<div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn" id="m-no">Cancelar</button><button class="btn pri" id="aid-ok">Crear</button></div></div>');
      $("#m-no").addEventListener('click',closeModal);
      $("#aid-ok").addEventListener('click',function(){
        aidApi('',{method:'POST',body:{operationId:op,nombre:$("#aid-nm").value.trim()||'Mi tablero'}})
          .then(function(d){ AID.cur=d; closeModal(); renderAiDash(); }).catch(function(e){toast(e.message);});
      });
    });
    $("#aid-rename").addEventListener('click',function(){
      if(!AID.cur)return;
      openModal('Renombrar tablero','<div class="form"><div class="fld"><label>Nombre</label><input id="aid-nm" value="'+esc(AID.cur.nombre)+'" maxlength="80"></div>'
        +'<div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn" id="m-no">Cancelar</button><button class="btn pri" id="aid-ok">Guardar</button></div></div>');
      $("#m-no").addEventListener('click',closeModal);
      $("#aid-ok").addEventListener('click',function(){
        aidPatch([{op:'renombrar',nombre:$("#aid-nm").value.trim()}]).then(function(){ closeModal(); renderAiDash(); });
      });
    });
    $("#aid-del").addEventListener('click',function(){
      if(!AID.cur)return;
      openConfirm('Eliminar tablero','Se eliminará «'+AID.cur.nombre+'» con todos sus widgets. Esto no se puede deshacer.',function(){
        aidApi('/'+AID.cur.id+'?operationId='+encodeURIComponent(op),{method:'DELETE'}).then(function(){
          AID.cur=null; renderAiDash(); toast('Tablero eliminado');
        }).catch(function(e){toast(e.message);});
      });
    });
  }

  // ===== Panel de uso de la plataforma (solo PLATFORM_ADMIN; 7/30/90 días) =====
  var usgWindow='7', usgData=null;
  function usgPct(p){return p==null?'—':(p+'%');}
  function usgAgo(iso){
    if(!iso)return '—';
    try{
      var diff=Date.now()-new Date(iso).getTime();
      if(diff<0)diff=0;
      var d=Math.floor(diff/86400000);
      if(d<=0){var h=Math.floor(diff/3600000);return h<=0?'hace <1 h':('hace '+h+' h');}
      if(d===1)return 'ayer';
      if(d<30)return 'hace '+d+' días';
      var mo=Math.floor(d/30);return 'hace '+mo+(mo>1?' meses':' mes');
    }catch(e){return '—';}
  }
  function renderUsage(){
    if(role!=="PLATFORM_ADMIN"||!$("#usg-mx-body"))return;
    var url;
    if(usgWindow==='custom'){
      var f=$("#usg-from")?$("#usg-from").value:"", t=$("#usg-to")?$("#usg-to").value:"";
      if(!f||!t){toast("Elige ambas fechas");return;}
      if(f>t){toast("La fecha 'Desde' no puede ser mayor que 'Hasta'");return;}
      var toEx=new Date(t+'T00:00:00'); toEx.setDate(toEx.getDate()+1);
      url='/platform/usage?from='+encodeURIComponent(new Date(f+'T00:00:00').toISOString())+'&to='+encodeURIComponent(toEx.toISOString());
    } else {
      url='/platform/usage?days='+usgWindow;
    }
    api(url).then(function(d){usgData=d;paintUsage();}).catch(function(e){toast(e.message);});
  }
  function mCur(m){return (m&&typeof m==='object')?(m.current||0):(m||0);}
  function usgDeltaInfo(m){
    if(!m||typeof m!=='object'||m.pct===null||m.pct===undefined)return {cls:(m&&m.current>0?'none':'flat'),txt:(m&&m.current>0?'nuevo':'—')};
    if(m.pct>0)return {cls:'up',txt:'▲ +'+m.pct+'%'};
    if(m.pct<0)return {cls:'down',txt:'▼ '+m.pct+'%'};
    return {cls:'flat',txt:'— 0%'};
  }
  function uCell(m,isPct){var d=usgDeltaInfo(m);var v=mCur(m);return '<div>'+(isPct?usgPct(v):fmtInt(v))+'</div><div class="udelta '+d.cls+'">'+d.txt+'</div>';}
  function uKpiSub(m,suffix){var d=usgDeltaInfo(m);var col=d.cls==='up'?'var(--good)':d.cls==='down'?'var(--crit)':'var(--ink-3)';return '<b style="color:'+col+'">'+d.txt+'</b> vs período anterior'+(suffix?(' · '+esc(suffix)):'');}
  function paintUsage(){
    if(!usgData||!$("#usg-kpis"))return;
    var t=usgData.totals;
    var winTxt=usgData.spanDays===1?'últimas 24 horas vs. las 24 horas previas':('últimos '+usgData.spanDays+' días vs. los '+usgData.spanDays+' días previos');
    if($("#usg-sub"))$("#usg-sub").textContent='Ventana: '+winTxt+' · '+t.activeOperations+' de '+t.operations+' operaciones activas';
    var kpis=[
      {l:"Operaciones activas",v:fmtInt(t.activeOperations)+' / '+fmtInt(t.operations),d:"con actividad en la ventana"},
      {l:"Logins",v:fmtInt(mCur(t.logins)),d:uKpiSub(t.logins,fmtInt(mCur(t.activeUsers))+" usuarios activos")},
      {l:"Adopción",v:usgPct(mCur(t.adoptionRate)),d:uKpiSub(t.adoptionRate,fmtInt(mCur(t.activeUsers))+" de "+fmtInt(t.totalUsers)+" usuarios")},
      {l:"Movimientos",v:fmtInt(mCur(t.movements)),d:uKpiSub(t.movements,"asientos del ledger")},
      {l:"Órdenes despachadas",v:fmtInt(mCur(t.ordersShipped)),d:uKpiSub(t.ordersShipped,fmtInt(mCur(t.ordersCreated))+" creadas")}
    ];
    $("#usg-kpis").innerHTML=kpis.map(function(x){return '<div class="kpi"><div class="l">'+x.l+'</div><div class="v">'+x.v+'</div><div class="d">'+x.d+'</div></div>';}).join("");
    var head='<tr><th>Operación</th><th class="num">Logins</th><th class="num">Usuarios activos</th><th class="num">Adopción</th><th class="num">Movimientos</th><th class="num">Órd. desp.</th><th class="num">Órd. creadas</th><th class="num">Recepciones</th><th class="num">Facturas</th><th class="num">Clientes</th><th class="num">Usuarios</th><th class="num">Última actividad</th></tr>';
    $("#usg-mx-head").innerHTML=head;
    var body=(usgData.operations||[]).map(function(o){
      var dorm=o.dormant?' <span class="pill warn">dormida</span>':'';
      var nameCell='<div>'+esc(o.operationName)+dorm+'</div><div class="hint mono2">'+esc(o.operationId)+'</div>';
      return '<tr'+(o.dormant?' style="opacity:.6"':'')+'><td>'+nameCell+'</td>'
        +'<td class="num">'+uCell(o.logins)+'</td>'
        +'<td class="num">'+uCell(o.activeUsers)+'</td>'
        +'<td class="num">'+uCell(o.adoptionRate,true)+'</td>'
        +'<td class="num">'+uCell(o.movements)+'</td>'
        +'<td class="num">'+uCell(o.ordersShipped)+'</td>'
        +'<td class="num">'+uCell(o.ordersCreated)+'</td>'
        +'<td class="num">'+uCell(o.receipts)+'</td>'
        +'<td class="num">'+uCell(o.invoices)+'</td>'
        +'<td class="num">'+fmtInt(o.totalSellers)+'</td>'
        +'<td class="num">'+fmtInt(o.totalUsers)+'</td>'
        +'<td class="num'+(o.dormant?' z':'')+'">'+esc(usgAgo(o.lastActivity))+'</td></tr>';
    }).join("")||'<tr><td colspan="12" class="empty">Sin operaciones.</td></tr>';
    $("#usg-mx-body").innerHTML=body;
    $("#usg-mx-foot").innerHTML='<tr><td>Consolidado</td>'
      +'<td class="num">'+uCell(t.logins)+'</td>'
      +'<td class="num">'+uCell(t.activeUsers)+'</td>'
      +'<td class="num">'+uCell(t.adoptionRate,true)+'</td>'
      +'<td class="num">'+uCell(t.movements)+'</td>'
      +'<td class="num">'+uCell(t.ordersShipped)+'</td>'
      +'<td class="num">'+uCell(t.ordersCreated)+'</td>'
      +'<td class="num">'+uCell(t.receipts)+'</td>'
      +'<td class="num">'+uCell(t.invoices)+'</td>'
      +'<td class="num">'+fmtInt(t.totalSellers)+'</td>'
      +'<td class="num">'+fmtInt(t.totalUsers)+'</td>'
      +'<td class="num">—</td></tr>';
  }

  // ===== Chat interno cliente ↔ equipo de operaciones (polling 10s) =====
  var chatIsOps=false, chatSel=null, chatInboxData=[], chatInit=false;
  function chatActivePage(){var p=document.querySelector('.page[data-pg="chat"]');return p&&p.classList.contains('on');}
  function roleLabelShort(r){return {PLATFORM_ADMIN:'Plataforma',ADMIN:'Operaciones',SUPERVISOR:'Operaciones',OPERATOR:'Operaciones',CLIENT:'Cliente'}[r]||r;}
  function setChatBadge(n){var b=$("#nav-chat");if(!b)return;b.textContent=n>0?(n>99?'99+':n):'';b.style.display=n>0?'':'none';}
  function renderChat(){
    if(!$("#chatwrap")||!can('chat'))return;
    chatIsOps=can('chatOps');
    $("#chatwrap").classList.toggle('solo',!chatIsOps);
    $("#chat-inbox-pane").style.display=chatIsOps?'':'none';
    if(!chatInit){ chatInit=true;
      $("#chat-send").addEventListener("click",sendChatMsg);
      $("#chat-input").addEventListener("keydown",function(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendChatMsg();}});
    }
    if(!chatIsOps){ chatSel=seller; $("#chat-th-title").textContent='Equipo de operaciones'; $("#chat-th-sub").textContent='Escríbenos y te respondemos por aquí.'; }
    chatPoll();
  }
  function chatPoll(){
    if(!can('chat')||!$("#chatwrap"))return;
    chatIsOps=can('chatOps');
    if(chatIsOps){
      if(!op)return;
      api('/operations/'+op+'/chat').then(function(items){
        chatInboxData=items||[];
        setChatBadge(chatInboxData.reduce(function(a,i){return a+(i.unread||0);},0));
        if(!chatActivePage())return;
        if(!chatSel&&chatInboxData.length)chatSel=chatInboxData[0].sellerId;
        renderChatInbox();
        if(chatSel)loadChatThread(chatSel);
        else{$("#chat-th-title").textContent='Selecciona una conversación';$("#chat-msgs").innerHTML='<div class="chat-empty">Elige un cliente en la lista para ver la conversación.</div>';}
      }).catch(function(){});
    } else {
      if(!seller)return;
      api('/sellers/'+seller+'/chat').then(function(t){
        setChatBadge(t.unread||0);
        if(!chatActivePage())return;
        renderChatMsgs(t.messages);
        if(t.unread>0)markChatRead(seller);
      }).catch(function(){});
    }
  }
  function renderChatInbox(){
    var el=$("#chat-inbox");if(!el)return;
    $("#chat-inbox-count").textContent=chatInboxData.length?('· '+chatInboxData.length):'';
    el.innerHTML=chatInboxData.length?chatInboxData.map(function(i){
      var un=i.unread>0?'<span class="chat-unread">'+i.unread+'</span>':'';
      var who=i.last?(i.last.side==='CLIENT'?i.last.senderName:'Operaciones: '+i.last.senderName):'';
      return '<div class="chat-irow'+(i.sellerId===chatSel?' on':'')+'" data-cs="'+esc(i.sellerId)+'">'
        +'<div class="cli">'+esc(i.sellerName)+un+'</div>'
        +'<div class="prev">'+esc(i.last?i.last.body:'')+'</div>'
        +'<div class="who">'+esc(who)+' · '+esc(i.last?fmtDate(i.last.at):'')+'</div></div>';
    }).join(""):'<div class="chat-empty" style="padding:20px">Aún no hay conversaciones.</div>';
    $$("#chat-inbox [data-cs]").forEach(function(r){r.addEventListener("click",function(){chatSel=r.getAttribute("data-cs");renderChatInbox();loadChatThread(chatSel);});});
  }
  function loadChatThread(sid){
    var it=chatInboxData.filter(function(x){return x.sellerId===sid;})[0];
    $("#chat-th-title").textContent='Conversación con '+((it&&it.sellerName)||sid);
    $("#chat-th-sub").textContent='El cliente y el usuario de cada mensaje se muestran en la conversación.';
    api('/sellers/'+sid+'/chat').then(function(t){
      renderChatMsgs(t.messages);
      if(t.unread>0)markChatRead(sid);
    }).catch(function(){});
  }
  function renderChatMsgs(msgs){
    var el=$("#chat-msgs");if(!el)return;
    var mine=function(m){return chatIsOps?m.side==='OPS':m.side==='CLIENT';};
    if(!msgs||!msgs.length){el.innerHTML='<div class="chat-empty">No hay mensajes todavía. Escribe el primero.</div>';return;}
    var atBottom=(el.scrollHeight-el.scrollTop-el.clientHeight)<60;
    el.innerHTML=msgs.map(function(m){
      var cls=mine(m)?'mine':'theirs';
      var meta=esc(m.senderName)+' · '+esc(roleLabelShort(m.senderRole));
      return '<div class="cbub '+cls+'"><div class="cmeta">'+meta+'</div>'+esc(m.body)+'<div class="ctime">'+esc(fmtDate(m.at))+'</div></div>';
    }).join("");
    if(atBottom||true)el.scrollTop=el.scrollHeight;
  }
  function markChatRead(sid){ api('/sellers/'+sid+'/chat/read',{method:'POST'}).then(function(){
    // refresca badge localmente
    if(chatIsOps){var it=chatInboxData.filter(function(x){return x.sellerId===sid;})[0];if(it)it.unread=0;setChatBadge(chatInboxData.reduce(function(a,i){return a+(i.unread||0);},0));renderChatInbox();}
    else setChatBadge(0);
  }).catch(function(){}); }
  function sendChatMsg(){
    var inp=$("#chat-input");var body=(inp.value||'').trim();if(!body)return;
    var sid=chatIsOps?chatSel:seller;
    if(!sid){toast("Selecciona una conversación");return;}
    inp.value='';
    api('/sellers/'+sid+'/chat',{method:'POST',body:{body:body}}).then(function(){
      if(chatIsOps){loadChatThread(sid);api('/operations/'+op+'/chat').then(function(items){chatInboxData=items||[];renderChatInbox();}).catch(function(){});}
      else chatPoll();
    }).catch(function(e){toast(e.message);inp.value=body;});
  }

  // ===== Canal de voz operador↔administración =====================================
  var CAT_LABEL={stock:"Stock / diferencias",ubicaciones:"Ubicaciones",recepcion:"Recepción",picking:"Picking",despacho:"Despacho",incidencia:"Incidencia",proceso:"Proceso / dudas",equipos:"Equipos / sistema",personal:"Personal / turnos",otro:"Otro"};
  var vocTab="compose", vocAdminView=false, vocThreads={}, vocActiveThread=null;
  var vocRec={mediaRec:null,chunks:[],blob:null,base64:null,mime:"",dur:0,timer:null,stream:null};
  var vocSig='', vocPollTimer=null;
  function vocIsAdmin(){return can('chatOps');}
  function vocOpQ(){return 'operationId='+encodeURIComponent(op);}
  function vocActivePage(){var p=document.querySelector('.page[data-pg="voicechannel"]');return p&&p.classList.contains('on');}

  function renderVoiceChannel(){
    // Muestra/oculta pestañas de administración según capacidad.
    $$('#voc-tabs [data-admin]').forEach(function(b){b.classList.toggle('hidden',!vocIsAdmin());});
    if(!vocIsAdmin()&&(vocTab==='threads'||vocTab==='insights'))vocTab='compose';
    $$('#voc-tabs .segbtn').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-voctab')===vocTab);});
    $("#voc-compose").classList.toggle('hidden',vocTab!=='compose');
    $("#voc-threads").classList.toggle('hidden',vocTab!=='threads');
    $("#voc-insights").classList.toggle('hidden',vocTab!=='insights');
    vocSig=''; // fuerza el primer render del nuevo tab
    if(vocTab==='insights')loadVocInsights(); else vocRefresh(true);
    vocStartPoll();
  }
  // Poll en vivo: mientras el canal esté abierto, refresca el hilo cada pocos segundos.
  // Solo re-renderiza si algo cambió (mensaje nuevo o "visto"), para no cortar audio ni tipeo.
  function vocStartPoll(){
    if(vocPollTimer)return;
    vocPollTimer=setInterval(function(){ if(token&&op&&vocActivePage()&&vocTab!=='insights')vocRefresh(false); },4000);
  }
  // Firma del estado visible: cantidad + último mensaje + "visto" del OTRO lado (el que mueve el tick).
  function vocSigOf(list,otherReadAt){
    var last=list.length?list[list.length-1]:null;
    return list.length+'|'+(last?last.id+'|'+last.at:'')+'|'+(otherReadAt||'');
  }
  function vocRefresh(force){
    if(!vocActivePage())return;
    if(vocTab==='compose'){
      Promise.all([
        api('/ops-channel/messages?'+vocOpQ()),
        api('/ops-channel/read?'+vocOpQ()).catch(function(){return null;})
      ]).then(function(res){
        var list=res[0]||[], read=res[1]||{};
        var sig='c|'+vocSigOf(list,read.adminReadAt);
        if(force||sig!==vocSig){ vocSig=sig; renderMyThread(list,read); }
      }).catch(function(){ if(force){var box=$("#voc-mythread");if(box)box.innerHTML='<div class="muted">No se pudo cargar el hilo.</div>';} });
    } else if(vocTab==='threads'){
      api('/ops-channel/messages?'+vocOpQ()).then(function(list){
        list=list||[];
        var fin=function(otherRead){
          var sig='t|'+(vocActiveThread||'')+'|'+vocSigOf(list,otherRead);
          if(force||sig!==vocSig){ vocSig=sig; renderThreadsData(list); }
        };
        if(vocActiveThread) api('/ops-channel/read?'+vocOpQ()+'&threadUserId='+encodeURIComponent(vocActiveThread)).then(function(r){fin(r&&r.operatorReadAt);}).catch(function(){fin(null);});
        else fin(null);
      }).catch(function(){});
    }
  }
  // Pestañas
  $$('#voc-tabs .segbtn').forEach(function(b){b.addEventListener('click',function(){vocTab=b.getAttribute('data-voctab');renderVoiceChannel();});});

  // Doble check estilo WhatsApp (azul = visto, gris = enviado).
  function doubleCheck(color){
    return '<svg width="17" height="11" viewBox="0 0 17 11" style="display:block" aria-hidden="true">'
      +'<path d="M1 5.8 L4.1 8.9 L9.2 2.2" fill="none" stroke="'+color+'" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'
      +'<path d="M7.2 8.9 L12.3 2.2" fill="none" stroke="'+color+'" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }
  // Tick de estado para MIS mensajes: visto (azul) si el otro lado ya leyó hasta la fecha del mensaje.
  function seenTick(m,read){
    var otherReadAt=vocIsAdmin()?(read&&read.operatorReadAt):(read&&read.adminReadAt);
    var seen=!!(otherReadAt&&otherReadAt>=m.at);
    return '<span title="'+(seen?'Visto':'Enviado')+'" style="display:inline-flex;color:'+(seen?'#34b7f1':'#9aa7b2')+'">'+doubleCheck(seen?'#34b7f1':'#9aa7b2')+'</span>';
  }
  function msgHtml(m,opts){
    opts=opts||{};
    var mine=m.senderId===(me&&me.id);
    var isAdminMsg=m.senderRole==='ADMIN'||m.senderRole==='PLATFORM_ADMIN'||m.senderRole==='SUPERVISOR';
    var when=new Date(m.at).toLocaleTimeString('es-CL',{hour:'2-digit',minute:'2-digit'});
    var body='';
    if(m.kind==='voice'){
      body+='<div><button class="btn" data-vocplay="'+esc(m.audioId||'')+'" style="padding:5px 11px;font-size:12.5px">▶ Reproducir'+(m.durationSec?(' ('+m.durationSec+'s)'):'')+'</button><audio data-vocaudio="'+esc(m.audioId||'')+'" controls class="hidden" style="width:100%;margin-top:6px"></audio></div>';
      if(m.text)body+='<div style="margin-top:5px;font-style:italic;opacity:.85">“'+esc(m.text)+'”</div>';
      if(m.note)body+='<div style="margin-top:4px">'+esc(m.note)+'</div>';
    } else {
      body+='<div style="white-space:pre-wrap;word-break:break-word">'+esc(m.text||'')+'</div>';
    }
    // Nombre solo en los mensajes de la otra parte (izquierda).
    var nameLbl=(!mine)?'<div style="font-size:11.5px;font-weight:700;color:var(--primary);margin-bottom:3px">'+esc(m.senderName||'—')+(isAdminMsg?' · administración':'')+'</div>':'';
    var cat=(opts.showCat&&m.category)?'<span class="pill" style="background:rgba(0,0,0,.06);font-size:10.5px;margin-right:6px;color:#556">'+esc(CAT_LABEL[m.category]||m.category)+'</span>':'';
    var tick=mine?seenTick(m,opts.read):'';
    var meta='<div style="display:flex;align-items:center;justify-content:flex-end;gap:5px;margin-top:4px;font-size:10.5px;color:#7a8894">'+cat+'<span>'+when+'</span>'+tick+'</div>';
    var align=mine?'flex-end':'flex-start';
    var bg=mine?'#d9fdd3':'#ffffff';
    var radius=mine?'12px 12px 3px 12px':'12px 12px 12px 3px';
    return '<div style="display:flex;justify-content:'+align+';margin-bottom:8px">'
      +'<div style="max-width:74%;background:'+bg+';border:1px solid rgba(0,0,0,.08);border-radius:'+radius+';padding:8px 11px;box-shadow:0 1px 1px rgba(0,0,0,.05)">'
      +nameLbl+body+meta
      +'</div></div>';
  }
  // Reproducción de audio (fetch autenticado -> data URI)
  document.addEventListener('click',function(e){
    var btn=e.target.closest&&e.target.closest('[data-vocplay]');if(!btn)return;
    var aid=btn.getAttribute('data-vocplay');if(!aid)return;
    var au=document.querySelector('[data-vocaudio="'+aid.replace(/"/g,'')+'"]');
    if(au&&au.src){au.classList.remove('hidden');au.play();return;}
    btn.disabled=true;btn.textContent='Cargando…';
    api('/ops-channel/audio/'+encodeURIComponent(aid)+'?'+vocOpQ()).then(function(r){
      btn.disabled=false;btn.textContent='▶ Reproducir';
      if(!r||!r.dataBase64){toast('Audio no disponible');return;}
      if(au){
        // Blob URL en vez de data: URI — Safari no reproduce audio desde data: URIs
        // (requiere range-requests que un data: URI no ofrece).
        try{
          if(au.dataset.vocurl){URL.revokeObjectURL(au.dataset.vocurl);}
          var url=URL.createObjectURL(b64ToBlob(r.dataBase64,r.mime||'audio/webm'));
          au.dataset.vocurl=url;au.src=url;au.classList.remove('hidden');au.play();
        }catch(e){toast('No se pudo reproducir el audio');}
      }
    }).catch(function(){btn.disabled=false;btn.textContent='▶ Reproducir';toast('No se pudo cargar el audio');});
  });
  // base64 -> Blob (para reproducción robusta con Blob URL en todos los navegadores)
  function b64ToBlob(b64,mime){
    var bin=atob(b64);var len=bin.length;var arr=new Uint8Array(len);
    for(var i=0;i<len;i++)arr[i]=bin.charCodeAt(i);
    return new Blob([arr],{type:mime||'audio/webm'});
  }

  // ---- Componer: mi hilo ----
  function renderMyThread(list,read){
    var box=$("#voc-mythread");if(!box)return;
    if(!list.length){box.innerHTML='<div class="muted">Aún no has enviado mensajes.</div>';return;}
    box.innerHTML=list.map(function(m){return msgHtml(m,{read:read});}).join('');
    box.scrollTop=box.scrollHeight;
    // El operador marca que leyó las respuestas de la administración.
    api('/ops-channel/read',{method:'POST',body:{operationId:op}}).catch(function(){});
  }
  // Enviar texto
  var _vts=$("#voc-text-send");if(_vts)_vts.addEventListener('click',function(){
    var t=($("#voc-text").value||'').trim();if(!t){toast('Escribe un mensaje');return;}
    _vts.disabled=true;
    api('/ops-channel/messages',{method:'POST',body:{operationId:op,kind:'text',text:t}}).then(function(){
      _vts.disabled=false;$("#voc-text").value='';toast('Mensaje enviado');vocSig='';vocRefresh(true);
    }).catch(function(e){_vts.disabled=false;toast(e.message);});
  });
  // Grabación de voz (MediaRecorder)
  function vocResetRec(){
    vocRec.blob=null;vocRec.base64=null;vocRec.chunks=[];vocRec.dur=0;
    $("#voc-rec-preview").classList.add('hidden');$("#voc-rec-preview").removeAttribute('src');
    $("#voc-rec-send").classList.add('hidden');$("#voc-rec-discard").classList.add('hidden');
    $("#voc-rec-btn").textContent='🎙️ Grabar';$("#voc-rec-btn").classList.remove('pri');$("#voc-rec-btn").classList.add('pri');
    $("#voc-rec-status").textContent='Presiona grabar y habla. Puedes agregar una nota escrita opcional.';
  }
  var _vrb=$("#voc-rec-btn");if(_vrb)_vrb.addEventListener('click',function(){
    if(vocRec.mediaRec&&vocRec.mediaRec.state==='recording'){vocRec.mediaRec.stop();return;}
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){toast('Tu navegador no permite grabar audio');return;}
    navigator.mediaDevices.getUserMedia({audio:true}).then(function(stream){
      vocRec.stream=stream;vocRec.chunks=[];
      var mime=(window.MediaRecorder&&MediaRecorder.isTypeSupported&&MediaRecorder.isTypeSupported('audio/webm'))?'audio/webm':'';
      var mr=mime?new MediaRecorder(stream,{mimeType:mime}):new MediaRecorder(stream);
      vocRec.mediaRec=mr;vocRec.mime=mr.mimeType||mime||'audio/webm';
      var t0=Date.now();
      mr.ondataavailable=function(ev){if(ev.data&&ev.data.size)vocRec.chunks.push(ev.data);};
      mr.onstop=function(){
        try{vocRec.stream.getTracks().forEach(function(t){t.stop();});}catch(e){}
        clearInterval(vocRec.timer);
        vocRec.dur=Math.round((Date.now()-t0)/1000);
        var blob=new Blob(vocRec.chunks,{type:vocRec.mime});vocRec.blob=blob;
        var url=URL.createObjectURL(blob);
        $("#voc-rec-preview").src=url;$("#voc-rec-preview").classList.remove('hidden');
        var fr=new FileReader();fr.onloadend=function(){vocRec.base64=String(fr.result).split(',')[1]||'';};fr.readAsDataURL(blob);
        $("#voc-rec-btn").textContent='🎙️ Grabar de nuevo';
        $("#voc-rec-send").classList.remove('hidden');$("#voc-rec-discard").classList.remove('hidden');
        $("#voc-rec-status").textContent='Grabación lista ('+vocRec.dur+'s). Revísala y envía.';
      };
      mr.start();
      $("#voc-rec-btn").textContent='⏹ Detener';
      $("#voc-rec-status").textContent='Grabando… 0s';
      vocRec.timer=setInterval(function(){$("#voc-rec-status").textContent='Grabando… '+Math.round((Date.now()-t0)/1000)+'s';},500);
    }).catch(function(){toast('No se pudo acceder al micrófono');});
  });
  var _vrd=$("#voc-rec-discard");if(_vrd)_vrd.addEventListener('click',vocResetRec);
  var _vrs=$("#voc-rec-send");if(_vrs)_vrs.addEventListener('click',function(){
    if(!vocRec.base64){toast('Graba un mensaje primero');return;}
    _vrs.disabled=true;
    api('/ops-channel/messages',{method:'POST',body:{operationId:op,kind:'voice',audioBase64:vocRec.base64,audioMime:vocRec.mime,durationSec:vocRec.dur,note:($("#voc-rec-note").value||'').trim()||null}}).then(function(){
      _vrs.disabled=false;$("#voc-rec-note").value='';vocResetRec();toast('Mensaje de voz enviado');vocSig='';vocRefresh(true);
    }).catch(function(e){_vrs.disabled=false;toast(e.message);});
  });

  // ---- Bandeja admin ----
  function renderThreadsData(list){
    vocThreads={};
    (list||[]).forEach(function(m){var k=m.threadUserId;if(!vocThreads[k])vocThreads[k]={userId:k,name:null,msgs:[],last:m.at,unreadHint:0};vocThreads[k].msgs.push(m);
      // nombre del operador = primer mensaje de un no-admin en el hilo
      if(!vocThreads[k].name&&m.senderId===k)vocThreads[k].name=m.senderName;
      if(m.at>vocThreads[k].last)vocThreads[k].last=m.at;});
    renderThreadList();
    if(vocActiveThread&&vocThreads[vocActiveThread])renderThreadView(vocActiveThread);
  }
  function renderThreadList(){
    var box=$("#voc-thread-list");var keys=Object.keys(vocThreads).sort(function(a,b){return vocThreads[b].last<vocThreads[a].last?-1:1;});
    if(!keys.length){box.innerHTML='<div class="muted">Sin mensajes.</div>';return;}
    box.innerHTML=keys.map(function(k){var t=vocThreads[k];var last=t.msgs[t.msgs.length-1];
      var prev=last.kind==='voice'?'🎙️ Mensaje de voz':(last.text||'');
      return '<button class="btn" data-vocthread="'+esc(k)+'" style="display:block;width:100%;text-align:left;margin-bottom:6px;padding:9px 11px;'+(k===vocActiveThread?'border-color:var(--primary)':'')+'">'
        +'<div style="display:flex;justify-content:space-between"><b style="font-size:12.5px">'+esc(t.name||k)+'</b><span class="muted" style="font-size:11px">'+t.msgs.length+'</span></div>'
        +'<div class="muted" style="font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:210px">'+esc(prev)+'</div></button>';
    }).join('');
    $$('#voc-thread-list [data-vocthread]').forEach(function(b){b.addEventListener('click',function(){vocActiveThread=b.getAttribute('data-vocthread');renderThreadList();renderThreadView(vocActiveThread);});});
  }
  function renderThreadView(k){
    var t=vocThreads[k];if(!t)return;
    $("#voc-thread-title").textContent=t.name||k;
    var view=$("#voc-thread-view");
    api('/ops-channel/read?'+vocOpQ()+'&threadUserId='+encodeURIComponent(k)).catch(function(){return null;}).then(function(read){
      read=read||{};
      view.innerHTML=t.msgs.map(function(m){return msgHtml(m,{showCat:true,read:read});}).join('');
      view.scrollTop=view.scrollHeight;
      // La administración marca el hilo como leído.
      api('/ops-channel/read',{method:'POST',body:{operationId:op,threadUserId:k}}).catch(function(){});
    });
    $("#voc-reply-box").style.display='block';
  }
  var _vrsend=$("#voc-reply-send");if(_vrsend)_vrsend.addEventListener('click',function(){
    if(!vocActiveThread){toast('Selecciona un hilo');return;}
    var t=($("#voc-reply-text").value||'').trim();if(!t){toast('Escribe una respuesta');return;}
    _vrsend.disabled=true;
    api('/ops-channel/messages',{method:'POST',body:{operationId:op,threadUserId:vocActiveThread,kind:'text',text:t}}).then(function(){
      _vrsend.disabled=false;$("#voc-reply-text").value='';vocSig='';vocRefresh(true);
    }).catch(function(e){_vrsend.disabled=false;toast(e.message);});
  });

  // ---- Estadísticas + insights ----
  function loadVocInsights(){
    api('/ops-channel/stats?'+vocOpQ()).then(function(s){
      s=s||{total:0,voice:0,text:0,byCategory:[],byOperator:[]};
      $("#voc-kpis").innerHTML=[
        ['Mensajes',s.total],['De voz',s.voice],['De texto',s.text],['Operadores activos',(s.byOperator||[]).length]
      ].map(function(k){return '<div class="kpi"><div class="kpi-v">'+k[1]+'</div><div class="kpi-l">'+k[0]+'</div></div>';}).join('');
      var tp=$("#voc-topics");
      tp.innerHTML=(s.byCategory&&s.byCategory.length)?s.byCategory.map(function(c){
        return '<div style="margin-bottom:8px"><div style="display:flex;justify-content:space-between;font-size:12.5px"><span>'+esc(CAT_LABEL[c.category]||c.category)+'</span><b>'+c.count+' · '+c.pct+'%</b></div>'
          +'<div style="height:7px;background:var(--chip);border-radius:5px;overflow:hidden;margin-top:3px"><div style="height:100%;width:'+c.pct+'%;background:var(--primary)"></div></div></div>';
      }).join(''):'<div class="muted">Sin datos.</div>';
      var bo=$("#voc-byoperator");
      bo.innerHTML=(s.byOperator&&s.byOperator.length)?s.byOperator.map(function(o){
        return '<div style="display:flex;justify-content:space-between;font-size:12.5px;padding:5px 0;border-bottom:1px solid var(--line)"><span>'+esc(o.name||o.userId)+'</span><b>'+o.count+'</b></div>';
      }).join(''):'<div class="muted">Sin datos.</div>';
    }).catch(function(){});
    var body=$("#voc-ins-body");body.innerHTML='<div class="muted">Analizando…</div>';
    api('/ops-channel/insights?'+vocOpQ()).then(function(ins){
      ins=ins||{summary:'',suggestions:[],generatedBy:'heuristic'};
      $("#voc-ins-engine").textContent=ins.generatedBy==='ai'?'Generado por IA':'Análisis heurístico';
      var html='<p style="margin:0 0 10px">'+esc(ins.summary||'')+'</p>';
      if(ins.suggestions&&ins.suggestions.length){
        html+='<ul style="margin:0;padding-left:18px">'+ins.suggestions.map(function(t){return '<li style="margin-bottom:6px">'+esc(t)+'</li>';}).join('')+'</ul>';
      }
      body.innerHTML=html||'<div class="muted">Sin datos suficientes todavía.</div>';
    }).catch(function(){body.innerHTML='<div class="muted">No se pudo generar el análisis.</div>';});
  }

  // ===== Copiloto del WMS =========================================================
  var COP_SUGGESTIONS=['¿Qué SKUs están por quebrar stock?','¿Qué lotes están por vencer?','¿Qué insumos de embalaje se están por agotar?','¿Hay anomalías de consumo?','¿Cuántas órdenes tengo pendientes?','¿Qué se despachó hoy?','¿Qué hay en la cola de preparación?','¿Cuánto llevo facturado este mes?'];
  var copInited=false, copAiConnected=false;
  function copSevColor(sev){return sev==='crit'?'var(--crit)':sev==='warn'?'var(--signal,#F0A24A)':'var(--primary)';}
  function renderCopilot(){
    if(!copInited){
      copInited=true;
      var chips=$("#cop-chips");
      if(chips)chips.innerHTML=COP_SUGGESTIONS.map(function(q){return '<button class="btn" data-copq="'+esc(q)+'" style="padding:6px 11px;font-size:12.5px">'+esc(q)+'</button>';}).join('');
      $$('#cop-chips [data-copq]').forEach(function(b){b.addEventListener('click',function(){$("#cop-q").value=b.getAttribute('data-copq');copAsk();});});
      var ab=$("#cop-ask"); if(ab)ab.addEventListener('click',copAsk);
      var qi=$("#cop-q"); if(qi)qi.addEventListener('keydown',function(e){if(e.key==='Enter')copAsk();});
      var rf=$("#cop-refresh"); if(rf)rf.addEventListener('click',copLoadInsights);
    }
    copLoadInsights();
    copLoadAiStatus();
    copLoadSettings();
  }
  function copLoadSettings(){
    var el=$("#cop-settings"); if(!el)return;
    api('/copilot/settings?operationId='+encodeURIComponent(op||'')).then(function(s){
      if(!s||!s.canManage){ el.style.display='none'; return; }
      el.style.display='flex';
      var mode=s.actionMode==='direct'?'direct':'confirm';
      el.innerHTML='<span>Acciones del copiloto sobre órdenes:</span>'
        +'<button class="btn'+(mode==='confirm'?' pri':'')+'" data-copmode="confirm" style="padding:4px 10px;font-size:11.5px">Pedir confirmación</button>'
        +'<button class="btn'+(mode==='direct'?' pri':'')+'" data-copmode="direct" style="padding:4px 10px;font-size:11.5px">Ejecutar directo</button>';
      $$('#cop-settings [data-copmode]').forEach(function(b){b.addEventListener('click',function(){
        var m=b.getAttribute('data-copmode');
        api('/copilot/settings',{method:'PUT',body:{operationId:op,actionMode:m}}).then(function(){toast('Modo actualizado');copLoadSettings();}).catch(function(e){toast(e.message);});
      });});
    }).catch(function(){ el.style.display='none'; });
  }
  // Formato inline seguro (el texto YA viene escapado, sin tags aún).
  function mdInline(s){
    // 1) Negrita a TODO dato numérico (miles con . o ,, decimales y % opcional).
    //    Evita tocar códigos alfanuméricos (A-01-1-A) exigiendo que el número no esté
    //    pegado a letras/dígitos. Sin lookbehind (compatible con Safari antiguo).
    s=s.replace(/(^|[^A-Za-z0-9.,\-])(\d[\d.,]*\d|\d)(\s?%)?(?![A-Za-z0-9])/g,'$1<b>$2$3</b>');
    // 2) Markdown explícito (puede envolver números ya en <b>, no pasa nada).
    s=s.replace(/\*\*([^*]+)\*\*/g,'<b>$1</b>')
       .replace(/(^|[^*])\*([^*\n]+)\*/g,'$1<i>$2</i>')
       .replace(/`([^`]+)`/g,'<code style="background:rgba(0,0,0,.06);padding:1px 4px;border-radius:4px">$1</code>');
    return s;
  }
  function mdIsTableSep(line){ return /\|/.test(line) && /^[\s|:-]+$/.test(line) && /-/.test(line); }
  function mdCells(line){
    var raw=line.trim().replace(/^\|/,'').replace(/\|$/,'');
    return raw.split('|').map(function(c){return mdInline(c.trim());});
  }
  // Render markdown ligero y SEGURO (escapa HTML primero). Soporta tablas, títulos,
  // viñetas, negrita/itálica y citas — para que la respuesta del LLM se vea natural.
  function mdLite(t){
    var lines=esc(String(t==null?'':t)).split('\n');
    var out=[]; var i=0;
    while(i<lines.length){
      var line=lines[i];
      // Tabla markdown: fila con | seguida de separador |---|
      if(/\|/.test(line) && i+1<lines.length && mdIsTableSep(lines[i+1])){
        var head=mdCells(line); i+=2; var rows=[];
        while(i<lines.length && /\|/.test(lines[i]) && lines[i].trim()!==''){ rows.push(mdCells(lines[i])); i++; }
        var th='<tr>'+head.map(function(c){return '<th style="text-align:left;padding:5px 9px;border-bottom:2px solid var(--line);font-size:12px">'+c+'</th>';}).join('')+'</tr>';
        var tb=rows.map(function(r){return '<tr>'+r.map(function(c){return '<td style="padding:5px 9px;border-bottom:1px solid var(--line);font-size:12.5px">'+c+'</td>';}).join('')+'</tr>';}).join('');
        out.push('<div style="overflow-x:auto"><table style="border-collapse:collapse;width:100%;margin:6px 0">'+th+tb+'</table></div>');
        continue;
      }
      // Títulos → negrita en su propia línea
      var h=line.match(/^#{1,6}\s?(.*)$/);
      if(h){ out.push('<div style="font-weight:700;margin:6px 0 2px">'+mdInline(h[1])+'</div>'); i++; continue; }
      // Cita "> texto" → nota
      var q=line.match(/^>\s?(.*)$/);
      if(q){ out.push('<div style="border-left:3px solid var(--line);padding-left:10px;color:var(--ink-2,#556)">'+mdInline(q[1])+'</div>'); i++; continue; }
      // Viñeta
      var b=line.match(/^\s*[-*]\s+(.*)$/);
      if(b){ out.push('<div style="padding-left:8px">• '+mdInline(b[1])+'</div>'); i++; continue; }
      out.push(mdInline(line));
      i++;
    }
    return out.join('<br>').replace(/(<\/table><\/div>)<br>/g,'$1').replace(/<br>(<div)/g,'$1');
  }
  var copProviders=null;
  function copLoadAiStatus(){
    var el=$("#cop-ai-status"); if(!el)return;
    api('/copilot/ai-config?'+copScopeQ()).then(function(s){
      copAiConnected=!!(s&&s.connected);
      if(copAiConnected){
        var scope=s.scope==='plataforma'?'de la plataforma (super admin)':(s.scope==='seller'?'de tu cuenta':'de la operación');
        el.innerHTML='<span style="display:inline-flex;align-items:center;gap:5px;background:var(--primary-wash);color:var(--primary-ink);padding:3px 9px;border-radius:999px;font-weight:700;font-size:11.5px">✨ '+esc(s.providerLabel||'IA')+' conectada</span>'
          +'<button class="btn" id="cop-ai-btn" style="padding:4px 10px;font-size:12px">Cambiar</button>';
        el.title=(s.providerLabel||'')+' · modelo '+(s.chatModel||'')+' · clave •••'+(s.last4||'')+' ('+scope+')';
      } else {
        el.innerHTML='<span class="muted" style="font-size:12px">IA no conectada</span><button class="btn pri" id="cop-ai-btn" style="padding:4px 11px;font-size:12px">Conectar IA</button>';
      }
      var bb=$("#cop-ai-btn"); if(bb)bb.addEventListener('click',openCopAiForm);
    }).catch(function(){});
  }
  function openCopAiForm(){
    // Carga (una vez) el catálogo de proveedores servido por el backend.
    if(!copProviders){ api('/copilot/ai-providers').then(function(p){copProviders=p||{};openCopAiForm();}).catch(function(){copProviders={openai:{label:'OpenAI',baseUrl:'https://api.openai.com/v1',model:'gpt-4o-mini',needsBaseUrl:false,keyHint:'sk-…'}};openCopAiForm();}); return; }
    var connected=copAiConnected;
    var opts=Object.keys(copProviders).map(function(k){return '<option value="'+esc(k)+'">'+esc(copProviders[k].label)+'</option>';}).join('');
    var html='<div class="form">'
      +'<p class="muted" style="margin:0 0 12px;max-width:66ch">Conecta la cuenta del proveedor de IA que prefieras. La clave se guarda del lado del servidor y <b>nunca se muestra completa</b>. Aplica a '+(role==='PLATFORM_ADMIN'?'<b>tu cuenta de super admin</b>: es independiente de la clave de cada operación y no se hereda en ninguna direcci\u00f3n':(role==='CLIENT'?'tu cuenta (seller)':'toda tu operación'))+'.</p>'
      +'<div class="fld"><label>Proveedor</label><select id="cai-prov">'+opts+'</select></div>'
      +'<div class="fld" id="cai-url-fld"><label>Base URL (API)</label><input id="cai-url" placeholder="https://…"></div>'
      +'<div class="fld"><label>Modelo <button type="button" id="cai-models-btn" class="btn" style="padding:2px 8px;font-size:11px;margin-left:6px">Ver modelos</button></label><input id="cai-model" placeholder="modelo"><div id="cai-models" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px"></div></div>'
      +'<div class="fld"><label>API key</label><input id="cai-key" type="password" autocomplete="off"></div>'
      +'<div class="muted" id="cai-hint" style="font-size:11.5px;margin:-4px 0 8px"></div>'
      +'<div style="margin:-2px 0 8px"><button type="button" id="cai-ctx" class="btn" style="padding:3px 9px;font-size:11px">Ver contexto que recibe la IA</button></div>'
      +'<div class="ferr" id="cai-err"></div>'
      +'<div id="cai-test-res" style="font-size:12.5px;margin:2px 0 8px"></div>'
      +'<div class="acts"><span class="hint"></span><div style="display:flex;gap:10px">'
      +(connected?'<button class="btn" id="cai-del" style="color:var(--crit)">Desconectar</button>':'')
      +'<button class="btn" id="cai-cancel">Cancelar</button><button class="btn" id="cai-test">Probar</button><button class="btn pri" id="cai-save">Guardar</button></div></div>'
      +'</div>';
    openModal('Conectar IA del copiloto',html);
    function applyProvider(){
      var k=$("#cai-prov").value; var d=copProviders[k]||{};
      $("#cai-model").value=d.model||''; $("#cai-model").placeholder=d.model||'modelo';
      $("#cai-url").value=d.baseUrl||'';
      $("#cai-key").placeholder=d.keyHint||'API key';
      // La Base URL solo es visible/necesaria para proveedores "compatibles" (Azure, OpenRouter, local…).
      $("#cai-url-fld").style.display=d.needsBaseUrl?'':'none';
      var hints={openai:'Usa una API key de platform.openai.com.',anthropic:'Usa una API key de console.anthropic.com (empieza con sk-ant-).',gemini:'Usa una API key de aistudio.google.com (AI Studio).',compatible:'Cualquier servicio compatible con la API de OpenAI: indica su Base URL y modelo.'};
      $("#cai-hint").textContent=hints[k]||'';
    }
    $("#cai-prov").addEventListener('change',function(){applyProvider();var mb=$("#cai-models");if(mb)mb.innerHTML='';}); applyProvider();
    $("#cai-cancel").addEventListener('click',closeModal);
    // Ver modelos: guarda la clave ingresada y consulta al proveedor su lista real.
    var mbtn=$("#cai-models-btn"); if(mbtn)mbtn.addEventListener('click',function(){
      var box=$("#cai-models"); var key=($("#cai-key").value||'').trim();
      if(key.length<8){$("#cai-err").textContent='Ingresa la API key para ver los modelos.';return;}
      $("#cai-err").textContent=''; box.innerHTML='<span class="muted" style="font-size:12px">Consultando modelos…</span>';
      var prov=$("#cai-prov").value;
      var body={operationId:op,provider:prov,baseUrl:($("#cai-url").value||'').trim(),chatModel:($("#cai-model").value||'').trim()||'x',apiKey:key};
      if(role==='CLIENT')body.sellerId=seller;
      api('/copilot/ai-config',{method:'PUT',body:body}).then(function(){
        return api('/copilot/ai-models?'+copScopeQ());
      }).then(function(r){
        var models=(r&&r.models)||[];
        if(!models.length){box.innerHTML='<span class="muted" style="font-size:12px">'+(r&&r.error?esc(r.error):'Sin modelos disponibles')+'</span>';return;}
        box.innerHTML=models.slice(0,40).map(function(m){return '<button type="button" class="btn" data-copmodel="'+esc(m)+'" style="padding:4px 9px;font-size:11.5px">'+esc(m)+'</button>';}).join('');
        $$('#cai-models [data-copmodel]').forEach(function(bb){bb.addEventListener('click',function(){$("#cai-model").value=bb.getAttribute('data-copmodel');});});
      }).catch(function(e){box.innerHTML='<span class="muted" style="font-size:12px">'+esc(e.message)+'</span>';});
    });
    $("#cai-save").addEventListener('click',function(){
      var key=($("#cai-key").value||'').trim();
      if(key.length<8){$("#cai-err").textContent='Ingresa una API key válida.';return;}
      var prov=$("#cai-prov").value;
      var body={operationId:op,provider:prov,baseUrl:($("#cai-url").value||'').trim(),chatModel:($("#cai-model").value||'').trim(),apiKey:key};
      if(role==='CLIENT')body.sellerId=seller;
      api('/copilot/ai-config',{method:'PUT',body:body}).then(function(){closeModal();toast('IA conectada');copLoadAiStatus();}).catch(function(e){$("#cai-err").textContent=e.message;});
    });
    var del=$("#cai-del"); if(del)del.addEventListener('click',function(){
      api('/copilot/ai-config?'+copScopeQ(),{method:'DELETE'}).then(function(){closeModal();toast('IA desconectada');copLoadAiStatus();}).catch(function(e){$("#cai-err").textContent=e.message;});
    });
    // Ver contexto: muestra exactamente los datos reales que se le entregan al LLM.
    var cb=$("#cai-ctx"); if(cb)cb.addEventListener('click',function(){
      api('/copilot/ai-context-preview?'+copScopeQ()).then(function(r){
        var ctx=(r&&r.context)||'(vacío)';
        openModal('Contexto que recibe la IA ('+((r&&r.chars)||0)+' caracteres)','<pre style="white-space:pre-wrap;word-break:break-word;font-size:12px;max-height:60vh;overflow:auto;margin:0">'+esc(ctx)+'</pre><div class="acts" style="margin-top:12px"><span class="hint"></span><button class="btn" id="ctx-close">Cerrar</button></div>');
        var cc=$("#ctx-close"); if(cc)cc.addEventListener('click',function(){openCopAiForm();});
      }).catch(function(e){$("#cai-err").textContent=e.message;});
    });
    // Probar: primero guarda lo ingresado y luego hace un ping real al proveedor.
    var tb=$("#cai-test"); if(tb)tb.addEventListener('click',function(){
      var res=$("#cai-test-res"); var key=($("#cai-key").value||'').trim();
      if(key.length<8){$("#cai-err").textContent='Ingresa la API key para probar.';return;}
      $("#cai-err").textContent=''; res.style.color='var(--ink-3)'; res.textContent='Probando conexión…';
      var prov=$("#cai-prov").value;
      var body={operationId:op,provider:prov,baseUrl:($("#cai-url").value||'').trim(),chatModel:($("#cai-model").value||'').trim(),apiKey:key};
      if(role==='CLIENT')body.sellerId=seller;
      api('/copilot/ai-config',{method:'PUT',body:body}).then(function(){
        return api('/copilot/ai-test?'+copScopeQ(),{method:'POST'});
      }).then(function(r){
        if(r&&r.ok){res.style.color='var(--good,#127a3d)';res.textContent='✓ Conexión OK — la IA respondió correctamente.';copLoadAiStatus();}
        else{res.style.color='var(--crit)';res.textContent='✗ '+((r&&r.error)||'No respondió');}
      }).catch(function(e){res.style.color='var(--crit)';res.textContent='✗ '+e.message;});
    });
  }
  function copScopeQ(){ return 'operationId='+encodeURIComponent(op)+(role==='CLIENT'&&seller?('&sellerId='+encodeURIComponent(seller)):''); }
  function copLoadInsights(){
    var box=$("#cop-insights"); if(!box)return;
    box.innerHTML='<div class="muted">Analizando tu operación…</div>';
    api('/copilot/insights?'+copScopeQ()).then(function(d){
      var ins=(d&&d.insights)||[];
      if(!ins.length){box.innerHTML='<div class="muted">Sin datos para analizar todavía.</div>';return;}
      box.innerHTML=ins.map(function(i){
        var col=copSevColor(i.severity);
        return '<div style="display:flex;gap:12px;padding:11px 12px;border:1px solid var(--line);border-left:4px solid '+col+';border-radius:10px;margin-bottom:9px">'
          +'<div style="font-size:20px;line-height:1">'+esc(i.icon||'•')+'</div>'
          +'<div style="flex:1">'
          +'<div style="font-weight:700;font-size:13.5px">'+esc(i.title)+'</div>'
          +'<div class="muted" style="font-size:12.5px;margin:2px 0 4px">'+esc(i.detail)+'</div>'
          +'<div style="font-size:12.5px"><b style="color:'+col+'">Sugerencia:</b> '+esc(i.action)+'</div>'
          +'</div>'
          +(i.link?'<button class="btn" data-copgo="'+esc(i.link)+'" style="padding:6px 11px;align-self:center">Ir →</button>':'')
          +'</div>';
      }).join('');
      $$('#cop-insights [data-copgo]').forEach(function(b){b.addEventListener('click',function(){go(b.getAttribute('data-copgo'));});});
    }).catch(function(){box.innerHTML='<div class="muted">No se pudo analizar la operación.</div>';});
  }
  // Hilo de conversación del copiloto: [{role, text, items?, suggestions?, link?, pending?}]
  var copChat=[];
  function copRenderChat(){
    var ans=$("#cop-answer"); if(!ans)return;
    if(!copChat.length){ ans.innerHTML=''; return; }
    var html='<div style="display:flex;justify-content:flex-end;margin-bottom:10px"><button class="btn" id="cop-new" style="padding:3px 10px;font-size:11.5px">＋ Nueva conversación</button></div>';
    html+=copChat.map(function(m,idx){
      if(m.role==='user'){
        return '<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><div style="max-width:80%;background:var(--primary-wash);color:var(--primary-ink);border-radius:12px 12px 3px 12px;padding:8px 12px;font-size:13.5px">'+esc(m.text)+'</div></div>';
      }
      var inner='<div style="line-height:1.5">'+(m.pending?'<span class="muted">Pensando…</span>':mdLite(m.text||''))+'</div>';
      if(m.items&&m.items.length){
        inner+='<div class="tablewrap"><table style="width:100%;margin-top:6px"><tbody>'+m.items.map(function(it){
          return '<tr><td style="padding:4px 8px">'+esc(it.label)+'</td>'+(it.value!==undefined?'<td style="padding:4px 8px;text-align:right;font-weight:700">'+esc(it.value)+'</td>':'')+'</tr>';
        }).join('')+'</tbody></table></div>';
      }
      if(m.suggestions&&m.suggestions.length){
        inner+='<div style="display:flex;flex-wrap:wrap;gap:7px;margin-top:8px">'+m.suggestions.map(function(s){return '<button class="btn" data-copq2="'+esc(s)+'" style="padding:5px 10px;font-size:12px">'+esc(s)+'</button>';}).join('')+'</div>';
      }
      if(m.link){ inner+='<div style="margin-top:10px"><button class="btn pri" data-copgo2="'+esc(m.link)+'" style="padding:7px 14px">Abrir '+esc((TITLES[m.link]||[m.link])[0])+' →</button></div>'; }
      if(m.toolsUsed&&m.toolsUsed.length){ inner+='<div class="muted" style="font-size:10.5px;margin-top:7px;opacity:.8">🔧 consultó: '+esc(m.toolsUsed.join(', '))+'</div>'; }
      if(m.actions&&m.actions.length){
        var acts=m.actions;
        var pend=acts.filter(function(a){return a.state==='pending';}).length;
        var doneN=acts.filter(function(a){return a.state==='done';}).length;
        var rows=acts.map(function(a){
          var pa=a.pa, ic='', col='', extra='';
          if(a.state==='done'){ ic='✓'; col='var(--good,#127a3d)'; extra=' — ahora <b>'+esc(a.newState||pa.to)+'</b>'; }
          else if(a.state==='error'){ ic='✕'; col='var(--bad,#c0392b)'; extra=' — '+esc(a.error||'no se pudo'); }
          else if(a.state==='busy'){ ic='⏳'; col='var(--ink-2,#556)'; }
          else { ic='•'; col='var(--warn,#c78a00)'; }
          var ACC={reservar:'reservar',iniciar_picking:'poner en picking',pickear:'pickear',empacar:'empacar',despachar:'despachar'};
          if(pa.tool){ if(a.state==='done')extra=' — ejecutada'; return '<div style="font-size:12.5px;padding:3px 0;color:'+col+'"><b>'+ic+'</b> '+esc(pa.resumen||pa.tool)+extra+'</div>'; }
          return '<div style="font-size:12.5px;padding:3px 0;color:'+col+'"><b>'+ic+'</b> '+esc(ACC[pa.accion]||pa.accion)+' <b>'+esc(pa.orden)+'</b> <span class="muted">('+esc(pa.from)+' → '+esc(pa.to)+')</span>'+extra+'</div>';
        }).join('');
        inner+='<div style="margin-top:10px;padding:10px 12px;border-radius:9px;background:var(--warn-wash,#fff8e6);border:1px solid var(--warn,#c78a00)">'
          +'<div style="font-weight:700;font-size:12.5px;margin-bottom:6px">'+(acts.length>1?('Acciones propuestas ('+acts.length+')'):'Acción propuesta')+'</div>'
          +rows;
        if(m.actionsBusy){
          inner+='<div class="muted" style="font-size:12px;margin-top:8px">Ejecutando… ('+doneN+'/'+acts.length+')</div>';
        } else if(pend>0){
          inner+='<div style="display:flex;gap:8px;margin-top:9px"><button class="btn pri" data-copconfirm="'+idx+'" style="padding:6px 14px;font-size:12.5px">'+(pend>1?('Confirmar y ejecutar todas ('+pend+')'):'Confirmar')+'</button>'
            +'<button class="btn" data-copcancel="'+idx+'" style="padding:6px 14px;font-size:12.5px">Cancelar</button></div>';
        } else {
          inner+='<div style="font-size:12px;margin-top:8px;color:var(--good,#127a3d)">Listo — se ejecutaron '+doneN+' de '+acts.length+'.</div>';
        }
        inner+='</div>';
      }
      return '<div style="display:flex;justify-content:flex-start;margin-bottom:10px"><div style="max-width:88%;background:var(--surface-2,#f7f8fa);border:1px solid var(--line);border-radius:12px 12px 12px 3px;padding:10px 13px">'+inner+'</div></div>';
    }).join('');
    ans.innerHTML=html;
    var nb=$("#cop-new"); if(nb)nb.addEventListener('click',function(){copChat=[];copRenderChat();});
    $$('#cop-answer [data-copq2]').forEach(function(b){b.addEventListener('click',function(){copSend(b.getAttribute('data-copq2'));});});
    $$('#cop-answer [data-copgo2]').forEach(function(b){b.addEventListener('click',function(){go(b.getAttribute('data-copgo2'));});});
    $$('#cop-answer [data-copconfirm]').forEach(function(b){b.addEventListener('click',function(){copConfirmActions(+b.getAttribute('data-copconfirm'));});});
    $$('#cop-answer [data-copcancel]').forEach(function(b){b.addEventListener('click',function(){var m=copChat[+b.getAttribute('data-copcancel')];if(m&&m.actions){m.actions.forEach(function(a){if(a.state==='pending'){a.state='error';a.error='cancelada';}});copRenderChat();}});});
    ans.scrollTop=ans.scrollHeight;
  }
  function copAsk(){
    var qi=$("#cop-q"); if(!qi)return;
    var q=(qi.value||'').trim(); if(!q){return;}
    qi.value='';
    copSend(q);
  }
  function copSend(q){
    if(!q)return;
    // Historial (turnos previos ya respondidos) para continuar la conversación.
    var history=copChat.filter(function(m){return !m.pending;}).map(function(m){return {role:m.role,content:m.text||''};});
    copChat.push({role:'user',text:q});
    var pending={role:'assistant',text:'',pending:true}; copChat.push(pending);
    copRenderChat();
    api('/copilot/ask',{method:'POST',body:{operationId:op,sellerId:(role==='CLIENT'?seller:undefined),question:q,history:history}}).then(function(d){
      pending.pending=false; pending.text=d.answer||''; pending.items=d.items; pending.suggestions=d.suggestions; pending.link=d.link; pending.toolsUsed=d.toolsUsed;
      var pas=d.pendingActions||(d.pendingAction?[d.pendingAction]:null);
      if(pas&&pas.length){ pending.actions=pas.map(function(pa){return {pa:pa,state:'pending'};}); }
      copRenderChat();
    }).catch(function(e){ pending.pending=false; pending.text='No pude responder: '+e.message; copRenderChat(); });
  }
  // Ejecuta EN SECUENCIA todas las acciones pendientes propuestas por el copiloto,
  // mostrando el avance orden por orden. Reusa el endpoint validado /confirm-action.
  function copConfirmActions(idx){
    var m=copChat[idx]; if(!m||!m.actions||m.actionsBusy)return;
    m.actionsBusy=true; copRenderChat();
    var i=0; var okCount=0;
    function step(){
      // Busca la siguiente pendiente.
      while(i<m.actions.length && m.actions[i].state!=='pending') i++;
      if(i>=m.actions.length){
        m.actionsBusy=false; copRenderChat();
        if(okCount>0){ toast(okCount>1?(okCount+' acciones ejecutadas'):'Acción ejecutada'); if(typeof pollOrders==='function')pollOrders(); }
        return;
      }
      var a=m.actions[i]; a.state='busy'; copRenderChat();
      var cbody=a.pa.tool?{operationId:op,sellerId:(role==='CLIENT'?seller:undefined),tool:a.pa.tool,args:a.pa.args||{}}:{operationId:op,sellerId:(role==='CLIENT'?seller:undefined),orden:a.pa.orden,accion:a.pa.accion};
      api('/copilot/confirm-action',{method:'POST',body:cbody}).then(function(r){
        if(r&&r.ok){ a.state='done'; a.newState=r.nuevoEstado; okCount++; }
        else { a.state='error'; a.error=(r&&r.error)||'error desconocido'; }
        i++; copRenderChat(); step();
      }).catch(function(e){ a.state='error'; a.error=e.message; i++; copRenderChat(); step(); });
    }
    step();
  }

  // ===== Copiloto de VOZ: conversación natural manos libres =================
  var vozInited=false, vozSession=false, vozRec=null, vozRecActive=false;
  var vozHistory=[], vozMode='confirm', vozPending=null, vozAwaitingConfirm=false;
  var vozHandsFree=true, vozSpeak=true, vozVoice=null, vozSupported=false;
  var YES_RE=/\b(s[íi]|dale|ya|confirmo|confirmar|conf[íi]rmalo|h[aá]zlo|procede|adelante|ok|okey|correcto|as[íi] es|de una|listo)\b/i;
  var NO_RE=/\b(no|cancela|cancelar|para|detente|det[eé]nte|olv[íi]dalo|mejor no|espera)\b/i;
  function vozStripMd(s){return String(s||'').replace(/\*\*/g,'').replace(/[#*_`]/g,'').replace(/\[(.*?)\]\(.*?\)/g,'$1').trim();}
  function vozSetState(s,cls){var st=$("#voz-state"),orb=$("#voz-orb");if(st)st.textContent=s;if(orb)orb.className='voz-orb'+(cls?(' '+cls):'');}
  function vozPickVoice(){try{var vs=window.speechSynthesis.getVoices()||[];vozVoice=vs.find(function(v){return /es[-_]CL/i.test(v.lang);})||vs.find(function(v){return /es[-_](419|MX|US)/i.test(v.lang);})||vs.find(function(v){return /^es/i.test(v.lang);})||null;}catch(e){}}
  function vozSpeakText(text,onEnd){
    var clean=vozStripMd(text);
    if(!vozSpeak||!('speechSynthesis'in window)||!clean){if(onEnd)onEnd();return;}
    try{
      window.speechSynthesis.cancel();
      var u=new SpeechSynthesisUtterance(clean);
      u.lang='es-CL'; if(vozVoice)u.voice=vozVoice; u.rate=1.05; u.pitch=1;
      vozSetState('Hablando…','speaking');
      u.onend=function(){if(onEnd)onEnd();};
      u.onerror=function(){if(onEnd)onEnd();};
      window.speechSynthesis.speak(u);
    }catch(e){if(onEnd)onEnd();}
  }
  function vozAddMsg(role,text,actionsInfo){
    var box=$("#voz-convo"); if(!box)return null;
    var d=document.createElement('div'); d.className='voz-msg '+(role==='user'?'user':'ai');
    d.innerHTML='<div class="who">'+(role==='user'?'Tú':'Copiloto')+'</div>'+esc(text)+(actionsInfo?('<div class="voz-act" data-act>'+esc(actionsInfo)+'</div>'):'');
    box.appendChild(d); box.scrollTop=box.scrollHeight; return d;
  }
  function vozAfterSpeak(){ // vuelve a escuchar si es manos libres y la sesión sigue activa
    if(vozSession&&vozHandsFree){vozStartRec();}
    else{vozSetState(vozSession?'Toca el micrófono para hablar':'Toca para hablar con tu operación',null);}
  }
  function vozStartRec(){
    if(!vozRec||vozRecActive)return;
    try{ window.speechSynthesis&&window.speechSynthesis.cancel(); vozRec.start(); vozRecActive=true; vozSetState('Escuchando…','listening'); }
    catch(e){ /* start puede fallar si ya está activo */ }
  }
  function vozStopRec(){ if(vozRec&&vozRecActive){try{vozRec.stop();}catch(e){}} vozRecActive=false; }
  function vozHandle(text){
    text=(text||'').trim(); if(!text)return;
    vozAddMsg('user',text);
    // Si hay acciones esperando confirmación, interpretamos sí/no.
    if(vozAwaitingConfirm&&vozPending&&vozPending.length){
      if(YES_RE.test(text)){ vozExecPending(); return; }
      if(NO_RE.test(text)){ vozAwaitingConfirm=false; vozPending=null; vozReply('Ok, lo dejo así. ¿Algo más?'); return; }
      // Si no dijo sí/no, seguimos como nueva consulta y descartamos lo pendiente.
      vozAwaitingConfirm=false; vozPending=null;
    }
    vozSetState('Pensando…','thinking');
    var history=vozHistory.slice(-12);
    vozHistory.push({role:'user',content:text});
    api('/copilot/ask',{method:'POST',body:{operationId:op,question:text,history:history}}).then(function(d){
      var ans=d.answer||'No tengo una respuesta.';
      vozHistory.push({role:'assistant',content:ans});
      var pas=d.pendingActions||(d.pendingAction?[d.pendingAction]:null);
      if(pas&&pas.length){ vozPending=pas.slice(); vozAwaitingConfirm=true;
        var resumen=ans+' '+(pas.length>1?('Son '+pas.length+' acciones. '):'')+pas.filter(function(x){return x.tool;}).map(function(x){return (x.resumen||x.tool)+'. ';}).join('')+'¿Las confirmo?';
        vozAddMsg('ai',ans,'⏳ '+pas.length+' acción(es) esperando tu confirmación por voz');
        vozSpeakText(resumen,vozAfterSpeak);
      } else {
        vozAddMsg('ai',ans);
        vozSpeakText(ans,vozAfterSpeak);
      }
    }).catch(function(e){ vozAddMsg('ai','No pude responder: '+e.message); vozSpeakText('Tuve un problema para responder.',vozAfterSpeak); });
  }
  function vozReply(text){ vozAddMsg('ai',text); vozHistory.push({role:'assistant',content:text}); vozSpeakText(text,vozAfterSpeak); }
  function vozExecPending(){
    var actions=vozPending||[]; vozAwaitingConfirm=false; vozPending=null;
    vozSetState('Ejecutando…','thinking');
    var i=0,ok=0,errs=0;
    function step(){
      if(i>=actions.length){
        var msg=ok>0?('Listo, ejecuté '+ok+(ok>1?' acciones':' acción')+(errs?(' y '+errs+' fallaron'):'')+'.'):'No pude ejecutar las acciones.';
        vozReply(msg+' ¿Algo más?'); if(typeof pollOrders==='function')pollOrders(); return;
      }
      var a=actions[i];
      var vbody=a.tool?{operationId:op,tool:a.tool,args:a.args||{}}:{operationId:op,orden:a.orden,accion:a.accion};
      api('/copilot/confirm-action',{method:'POST',body:vbody}).then(function(r){
        if(r&&r.ok)ok++;else errs++; i++; step();
      }).catch(function(){errs++;i++;step();});
    }
    step();
  }
  function vozLoadMode(){
    api('/copilot/settings?operationId='+encodeURIComponent(op||'')).then(function(s){
      vozMode=(s&&s.actionMode==='direct')?'direct':'confirm';
      $$("#voz-mode .segbtn").forEach(function(b){b.classList.toggle("on",b.getAttribute("data-vmode")===vozMode);});
    }).catch(function(){});
  }
  function renderVoice(){
    if(!vozInited){
      vozInited=true;
      vozSupported=('SpeechRecognition'in window)||('webkitSpeechRecognition'in window);
      if('speechSynthesis'in window){vozPickVoice();window.speechSynthesis.onvoiceschanged=vozPickVoice;}
      if(!vozSupported){
        vozSetState('Tu navegador no soporta voz. Usa Chrome de escritorio.',null);
        var mic0=$("#voz-mic"); if(mic0){mic0.disabled=true;mic0.style.opacity=.4;}
      } else {
        var SR=window.SpeechRecognition||window.webkitSpeechRecognition;
        vozRec=new SR(); vozRec.lang='es-CL'; vozRec.interimResults=true; vozRec.continuous=false; vozRec.maxAlternatives=1;
        vozRec.onresult=function(ev){
          var interim='',fin='';
          for(var k=ev.resultIndex;k<ev.results.length;k++){var r=ev.results[k];if(r.isFinal)fin+=r[0].transcript;else interim+=r[0].transcript;}
          if($("#voz-live"))$("#voz-live").textContent=interim||fin;
          if(fin){ vozRecActive=false; if($("#voz-live"))$("#voz-live").textContent=''; vozStopRec(); vozHandle(fin); }
        };
        vozRec.onerror=function(ev){ vozRecActive=false; if(ev&&ev.error==='not-allowed'){vozSetState('Permiso de micrófono denegado. Actívalo en el navegador.',null);vozSession=false;var m=$("#voz-mic");if(m)m.classList.remove('on');} };
        vozRec.onend=function(){ vozRecActive=false; if(vozSession&&vozHandsFree&&!vozAwaitingConfirmPause()){ /* reinicia solo si no estamos hablando/pensando */ } };
      }
      var mic=$("#voz-mic"); if(mic)mic.addEventListener("click",function(){
        if(!vozSupported)return;
        vozSession=!vozSession; mic.classList.toggle('on',vozSession);
        if(vozSession){ vozReplyGreeting(); }
        else { vozStopRec(); try{window.speechSynthesis.cancel();}catch(e){} vozSetState('Toca para hablar con tu operación',null); }
      });
      $$("#voz-mode .segbtn").forEach(function(b){b.addEventListener("click",function(){
        var m=b.getAttribute("data-vmode");
        api('/copilot/settings',{method:'PUT',body:{operationId:op,actionMode:m}}).then(function(){vozMode=m;$$("#voz-mode .segbtn").forEach(function(x){x.classList.toggle("on",x===b);});toast('Modo: '+(m==='direct'?'ejecución directa':'confirmar acciones'));}).catch(function(e){toast(e.message);});
      });});
      var hf=$("#voz-handsfree"); if(hf)hf.addEventListener("change",function(){vozHandsFree=hf.checked;});
      var sp=$("#voz-speak"); if(sp)sp.addEventListener("change",function(){vozSpeak=sp.checked;if(!vozSpeak){try{window.speechSynthesis.cancel();}catch(e){}}});
      var cl=$("#voz-clear"); if(cl)cl.addEventListener("click",function(){vozHistory=[];vozPending=null;vozAwaitingConfirm=false;if($("#voz-convo"))$("#voz-convo").innerHTML='';toast('Conversación reiniciada');});
    }
    vozLoadMode();
  }
  function vozAwaitingConfirmPause(){return false;}
  function vozReplyGreeting(){
    var g='Hola, soy tu copiloto de voz. Pregúntame por la operación o dame una directriz.';
    vozAddMsg('ai',g); vozSpeakText(g,vozAfterSpeak);
  }

  // ===== Actividad por usuario (auditoría operativa; admin/supervisor) =====
  var actInited=false, actWindow='7', actUser='';
  var ACT_ROLE={PLATFORM_ADMIN:'Plataforma',ADMIN:'Administrador',SUPERVISOR:'Supervisor',OPERATOR:'Operario',CLIENT:'Cliente',SYSTEM:'Sistema',AI:'IA'};
  // ----- Auditoría de IA (G5) -----
  var aiaInited=false;
  function renderAiAudit(){
    if(!aiaInited){ aiaInited=true; var rb=$("#aia-refresh"); if(rb)rb.addEventListener("click",loadAiAudit); }
    loadAiAudit();
  }
  function loadAiAudit(){
    if(!op) return;
    var q='operationId='+encodeURIComponent(op);
    Promise.all([
      api('/ai-audit/summary?'+q).catch(function(){return null;}),
      api('/ai-audit/actions?'+q+'&limit=200').catch(function(){return [];})
    ]).then(function(r){
      var s=r[0]||{recommendations:{total:0,accepted:0,rejected:0,pending:0,acceptanceRate:null,byType:[]},actions:{total:0,ok:0,error:0,byAgent:[]}};
      var rec=s.recommendations, act=s.actions;
      var accTxt=(rec.acceptanceRate!=null)?rec.acceptanceRate+"%":"—";
      var k=[
        {l:"Sugerencias",v:rec.total,d:rec.pending+" pendientes"},
        {l:"% aceptadas",v:accTxt,d:rec.accepted+" de "+(rec.accepted+rec.rejected)+" decididas"},
        {l:"Acciones de agente",v:act.total,d:"registradas y auditables"},
        {l:"Acciones OK",v:act.ok,d:act.error+" con error"}
      ];
      $("#aia-kpis").innerHTML=k.map(function(x){return '<div class="kpi"><div class="l">'+x.l+'</div><div class="v">'+x.v+'</div><div class="d">'+esc(x.d)+'</div></div>';}).join("");
      var TLAB={putaway:"Guardado (advisor)",copilot_action:"Acción del copiloto",copilot_answer:"Respuesta del copiloto",abc_reclass:"Reclasificación ABC"};
      $("#aia-type-head").innerHTML='<tr><th>Tipo</th><th class="num">Total</th><th class="num">Aceptadas</th><th class="num">% aceptación</th></tr>';
      $("#aia-type-body").innerHTML=(rec.byType||[]).length?rec.byType.map(function(t){
        return '<tr><td>'+esc(TLAB[t.type]||t.type)+'</td><td class="num">'+t.total+'</td><td class="num">'+t.accepted+'</td><td class="num">'+(t.acceptanceRate!=null?t.acceptanceRate+"%":"—")+'</td></tr>';
      }).join(""):'<tr><td colspan="4" class="empty">Sin recomendaciones registradas aún.</td></tr>';
      var acts=r[1]||[];
      $("#aia-act-sub").textContent=acts.length+" acciones";
      var AG={copilot:"Copiloto",putaway_advisor:"Advisor guardado",abc_job:"Job ABC"};
      $("#aia-act-body").innerHTML=acts.length?acts.map(function(a){
        var okCls=(a.result&&a.result.indexOf('ok')===0)?'st-AVAILABLE':'st-CANCELLED';
        var when=new Date(a.at); var w=isNaN(when.getTime())?'—':(when.toLocaleDateString('es-CL')+' '+when.toLocaleTimeString('es-CL',{hour:'2-digit',minute:'2-digit'}));
        return '<tr><td class="mono2">'+esc(w)+'</td><td>'+esc(AG[a.agent]||a.agent)+'</td><td>'+esc(a.decision)+'</td><td>'+esc(a.actor)+'</td><td>'+esc(a.orderRef||'—')+'</td><td><span class="chip '+okCls+'"><span class="dot"></span>'+esc(a.result||'')+'</span></td></tr>';
      }).join(""):'<tr><td colspan="6" class="empty">Sin acciones de agente registradas aún.</td></tr>';
    }).catch(function(){});
  }

  // ----- Asignaciones / balanceo de carga (Camino B) -----
  var cosInited=false, cosGroup='operator', cosMonthVal='';
  var asgInited=false, asgType='PICK', asgOperators=[], asgView='tipo', asgOp='';
  function renderAssignments(){
    if(!asgInited){
      asgInited=true;
      $$("#asg-view .segbtn").forEach(function(b){b.addEventListener("click",function(){asgSetView(b.getAttribute("data-asgv"));});});
      var osel=$("#asg-op-sel"); if(osel)osel.addEventListener("change",function(){asgOp=osel.value;loadOperatorView();});
      $$("#asg-type .segbtn").forEach(function(b){b.addEventListener("click",function(){asgType=b.getAttribute("data-asgt");$$("#asg-type .segbtn").forEach(function(x){x.classList.toggle("on",x===b);});loadAssignments();});});
      $$("#asg-mode .segbtn").forEach(function(b){b.addEventListener("click",function(){var m=b.getAttribute("data-asgm");api('/assignments/mode',{method:'PUT',body:{operationId:op,mode:m}}).then(function(){$$("#asg-mode .segbtn").forEach(function(x){x.classList.toggle("on",x===b);});toast('Modo: '+m);}).catch(function(e){toast(e.message);});});});
      var rb=$("#asg-refresh"); if(rb)rb.addEventListener("click",function(){if(asgView==='operario')loadOperatorView();else loadAssignments();});
      var bb=$("#asg-balance"); if(bb)bb.addEventListener("click",function(){
        api('/assignments/auto-balance?operationId='+encodeURIComponent(op)+'&type='+asgType+'&execute=true',{method:'POST'}).then(function(r){toast('Balanceado: '+r.asignadas+' tareas repartidas');loadAssignments();}).catch(function(e){toast(e.message);});
      });
      var cb=$("#asg-continuous"); if(cb)cb.addEventListener("click",function(){
        var turnOn=cb.getAttribute('data-on')!=='1';
        api('/assignments/continuous',{method:'PUT',body:{operationId:op,on:turnOn}}).then(function(r){toast(turnOn?('Auto-balanceo continuo activado'+(r.asignadasInicial?(' ('+r.asignadasInicial+' repartidas)'):'')):'Auto-balanceo continuo desactivado');loadAssignments();}).catch(function(e){toast(e.message);});
      });
      var sp=$("#asg-selfpick"); if(sp)sp.addEventListener("click",function(){
        var turnOn=sp.getAttribute('data-on')!=='1';
        api('/assignments/self-pickup',{method:'PUT',body:{operationId:op,on:turnOn}}).then(function(){toast(turnOn?'Los operarios pueden tomar tareas disponibles desde su app':'Los operarios solo ven lo asignado');loadAssignments();}).catch(function(e){toast(e.message);});
      });
      var db=$("#asg-redistribute"); if(db)db.addEventListener("click",function(){
        api('/assignments/rebalance-load?operationId='+encodeURIComponent(op)+'&execute=true',{method:'POST'}).then(function(r){var n=(r.movimientos||[]).length;toast(n?('Redistribuidas '+n+' tareas del más cargado al ocioso'):'Ya estaba balanceado, sin movimientos');loadAssignments();}).catch(function(e){toast(e.message);});
      });
    }
    asgSetView(asgView);
  }
  function asgSetView(v){
    asgView=(v==='operario')?'operario':'tipo';
    $$("#asg-view .segbtn").forEach(function(x){x.classList.toggle("on",x.getAttribute("data-asgv")===asgView);});
    var tc=$("#asg-tipo-controls"); if(tc)tc.style.display=asgView==='tipo'?'contents':'none';
    var vt=$("#asg-tipo"); if(vt)vt.hidden=asgView!=='tipo';
    var vo=$("#asg-operario"); if(vo)vo.hidden=asgView!=='operario';
    if(asgView==='operario')loadOperatorView(); else loadAssignments();
  }
  function loadOperatorView(){
    if(!op)return;
    var q='operationId='+encodeURIComponent(op);
    api('/assignments/load?'+q).then(function(load){
      var ops=(load&&load.operarios||[]).map(function(o){return {id:o.operario,name:o.nombre};});
      var sel=$("#asg-op-sel"); if(!sel)return;
      if(!asgOp&&ops.length)asgOp=ops[0].id;
      sel.innerHTML=ops.length?ops.map(function(o){return '<option value="'+esc(o.id)+'"'+(o.id===asgOp?' selected':'')+'>'+esc(o.name||o.id)+'</option>';}).join(''):'<option value="">Sin operarios</option>';
      if(asgOp)renderOperatorTasks(asgOp);
      else{$("#asg-op-body").innerHTML='<tr><td colspan="6" class="empty">No hay operarios en la operación.</td></tr>';$("#asg-op-kpis").innerHTML='';$("#asg-op-sub").textContent='';}
    }).catch(function(){});
  }
  var ASG_TYPE_LABEL={PICK:'Picking',PACK:'Empaque',SHIP:'Despacho',PUTAWAY:'Guardado',RESTOCK:'Reposición',RECEIVE:'Recepción',RESLOT:'Re-slotting',COUNT:'Conteo'};
  function renderOperatorTasks(operator){
    var q='operationId='+encodeURIComponent(op)+'&operator='+encodeURIComponent(operator);
    api('/assignments/operator?'+q).then(function(d){
      var t=(d&&d.tareas)||[];
      $("#asg-op-kpis").innerHTML=[
        {l:'En ejecución',v:d.enEjecucion||0,dd:'tareas iniciadas'},
        {l:'Pendientes',v:d.pendientes||0,dd:'por iniciar'},
        {l:'Total unidades',v:d.unidades||0,dd:'carga asignada'}
      ].map(function(x){return '<div class="kpi"><div class="l">'+x.l+'</div><div class="v">'+x.v+'</div><div class="d">'+esc(x.dd)+'</div></div>';}).join('');
      $("#asg-op-sub").textContent=t.length+' actividad(es)';
      $("#asg-op-summary").textContent=(d.enEjecucion||0)+' en ejecución · '+(d.pendientes||0)+' pendientes';
      $("#asg-op-body").innerHTML=t.length?t.map(function(a,i){
        var run=a.estado==='in_progress';
        var chip=run?'<span class="chip st-PICKING"><span class="dot"></span>En ejecución</span>':(i===0?'<span class="chip st-AVAILABLE"><span class="dot"></span>Siguiente</span>':'<span class="chip st-ALLOCATED"><span class="dot"></span>Pendiente</span>');
        return '<tr><td class="num" style="font-weight:700">'+(i+1)+'</td><td class="mono2">'+esc(a.referencia||'—')+'</td><td>'+esc(ASG_TYPE_LABEL[a.tipo]||a.tipo)+'</td><td>'+esc(a.cliente||'—')+'</td><td class="num">'+a.unidades+'</td><td>'+chip+'</td><td class="muted">'+esc(a.motivo||'—')+'</td><td class="muted">'+esc(fmtDate(a.asignada))+'</td></tr>';
      }).join(''):'<tr><td colspan="8" class="empty">Este operario no tiene actividades asignadas.</td></tr>';
    }).catch(function(){});
  }
  function loadAssignments(){
    if(!op) return;
    var q='operationId='+encodeURIComponent(op);
    api('/assignments/mode?'+q).then(function(m){$$("#asg-mode .segbtn").forEach(function(x){x.classList.toggle("on",x.getAttribute("data-asgm")===(m&&m.assignmentMode));});}).catch(function(){});
    api('/assignments/continuous?'+q).then(function(c){var cb=$("#asg-continuous");if(cb){var on=!!(c&&c.autoBalance);cb.setAttribute('data-on',on?'1':'0');cb.textContent='🔄 Continuo: '+(on?'on':'off');cb.classList.toggle('pri',on);}}).catch(function(){});
    api('/assignments/self-pickup?'+q).then(function(c){var sp=$("#asg-selfpick");if(sp){var on=!!(c&&c.operatorSelfPickup);sp.setAttribute('data-on',on?'1':'0');sp.textContent='🧑‍🏭 Tomar tareas: '+(on?'on':'off');sp.classList.toggle('pri',on);}}).catch(function(){});
    Promise.all([
      api('/assignments/load?'+q).catch(function(){return {operarios:[],pendientesSinAsignar:{}};}),
      api('/assignments/pool?'+q+'&type='+asgType+'&limit=100').catch(function(){return [];})
    ]).then(function(r){
      var load=r[0]||{operarios:[],pendientesSinAsignar:{}};
      asgOperators=(load.operarios||[]).map(function(o){return {id:o.operario,name:o.nombre};});
      var pend=load.pendientesSinAsignar||{};
      var k=[
        {l:"Picking",v:pend.PICK||0,d:"sin asignar"},
        {l:"Empaque",v:pend.PACK||0,d:"sin asignar"},
        {l:"Despacho",v:pend.SHIP||0,d:"sin asignar"},
        {l:"Guardado",v:pend.PUTAWAY||0,d:"sin asignar"},
        {l:"Reposición",v:pend.RESTOCK||0,d:"sin asignar"},
        {l:"Recepción",v:pend.RECEIVE||0,d:"sin asignar"},
        {l:"Re-slotting",v:pend.RESLOT||0,d:"sin asignar"},
        {l:"Conteo",v:pend.COUNT||0,d:"sin asignar"},
        {l:"Operarios",v:(load.operarios||[]).length,d:"en la operación"}
      ];
      $("#asg-kpis").innerHTML=k.map(function(x){return '<div class="kpi"><div class="l">'+x.l+'</div><div class="v">'+x.v+'</div><div class="d">'+esc(x.d)+'</div></div>';}).join("");
      $("#asg-load-body").innerHTML=(load.operarios||[]).length?load.operarios.map(function(o){
        var hot=(o.horasEstimadas!=null&&o.horasEstimadas>=6)?' style="color:var(--bad,#c0392b);font-weight:700"':'';
        return '<tr><td>'+esc(o.nombre||o.operario)+'</td><td class="num">'+(o.velocidadUH||'—')+'</td><td class="num">'+(o.velocidadTH!=null?o.velocidadTH:'—')+'</td><td class="num">'+o.tareasAbiertas+'</td><td class="num">'+o.unidades+'</td><td class="num"'+hot+'>'+(o.horasEstimadas!=null?o.horasEstimadas+' h':'—')+'</td></tr>';
      }).join(""):'<tr><td colspan="6" class="empty">Sin operarios en la operación.</td></tr>';
      // Pie: el TOTAL del equipo y el PROMEDIO por operario. La velocidad total no
      // es el promedio de las velocidades: es unidades totales sobre horas totales.
      var T=load.totales, P=load.promedios, pie=$("#asg-load-foot");
      if(pie)pie.innerHTML=(T&&load.operarios&&load.operarios.length)
        ? '<tr class="tot"><td>Total ('+T.operarios+' operarios)</td><td class="num">'+(T.velocidadUH!=null?T.velocidadUH:'—')+'</td><td class="num">'+(T.velocidadTH!=null?T.velocidadTH:'—')+'</td><td class="num">'+T.tareasAbiertas+'</td><td class="num">'+fmtInt(T.unidades)+'</td><td class="num">'+T.horasEstimadas+' h</td></tr>'
          +'<tr class="prom"><td>Promedio por operario</td><td class="num">'+(P.velocidadUH!=null?P.velocidadUH:'—')+'</td><td class="num">—</td><td class="num">'+P.tareasAbiertas+'</td><td class="num">'+fmtInt(P.unidades)+'</td><td class="num">'+P.horasEstimadas+' h</td></tr>'
        : '';
      var pool=r[1]||[];
      $("#asg-pool-sub").textContent=pool.length+" tareas";
      var opts='<option value="">—</option>'+asgOperators.map(function(o){return '<option value="'+esc(o.id)+'">'+esc(o.name||o.id)+'</option>';}).join("");
      $("#asg-pool-body").innerHTML=pool.length?pool.map(function(t){
        return '<tr><td class="mono2">'+esc(t.entityRef)+'</td><td>'+esc(t.sellerId)+'</td><td class="num">'+t.unidades+'</td><td>'+(t.asignadoA?('<span class="chip st-RESERVED"><span class="dot"></span>'+esc(t.asignadoA)+'</span>'):'<span class="muted">sin asignar</span>')+'</td>'
          +'<td><select class="asg-pick" data-eid="'+esc(t.entityId)+'" data-ref="'+esc(t.entityRef)+'" data-sid="'+esc(t.sellerId)+'" data-un="'+t.unidades+'" style="padding:4px 6px">'+opts+'</select></td></tr>';
      }).join(""):'<tr><td colspan="5" class="empty">No hay tareas pendientes de este tipo.</td></tr>';
      $$("#asg-pool-body .asg-pick").forEach(function(sel){sel.addEventListener("change",function(){
        var operario=sel.value; if(!operario)return;
        api('/assignments/assign',{method:'POST',body:{operationId:op,type:asgType,entityId:sel.getAttribute('data-eid'),entityRef:sel.getAttribute('data-ref'),sellerId:sel.getAttribute('data-sid'),unitsEstimate:parseInt(sel.getAttribute('data-un'),10)||0,operator:operario}}).then(function(){toast('Asignada a '+operario);loadAssignments();}).catch(function(e){toast(e.message);});
      });});
    }).catch(function(){});
  }

  // ---- Costos y rentabilidad -----------------------------------------------
  function cosMonthParts(){
    var v=cosMonthVal||($("#cos-month")&&$("#cos-month").value)||'';
    if(!v){var d=new Date();return {year:d.getUTCFullYear(),month:d.getUTCMonth()+1};}
    var p=v.split('-');return {year:parseInt(p[0],10),month:parseInt(p[1],10)};
  }
  function renderCostos(){
    if(!cosInited){
      cosInited=true;
      if($("#cos-month")&&!$("#cos-month").value){var d=new Date();$("#cos-month").value=d.getUTCFullYear()+'-'+String(d.getUTCMonth()+1).padStart(2,'0');}
      var mo=$("#cos-month"); if(mo)mo.addEventListener("change",function(){cosMonthVal=mo.value;loadCostos();});
      var rf=$("#cos-refresh"); if(rf)rf.addEventListener("click",loadCostos);
      var tg=$("#cos-rates-toggle"); if(tg)tg.addEventListener("click",function(){var c=$("#cos-rates-card");if(c){c.classList.toggle("hidden");if(!c.classList.contains("hidden"))loadCostRates();}});
      var sv=$("#cr-save"); if(sv)sv.addEventListener("click",saveCostRates);
      $$("#cos-eff-group .segbtn").forEach(function(b){b.addEventListener("click",function(){cosGroup=b.getAttribute("data-effg");$$("#cos-eff-group .segbtn").forEach(function(x){x.classList.toggle("on",x===b);});loadEfficiency();});});
    }
    loadCostos();
  }
  function loadCostRates(){
    if(!op)return;
    api('/costs/rates?operationId='+encodeURIComponent(op)).then(function(c){
      if(!c)return;
      $("#cr-currency").value=c.currency||'CLP';
      $("#cr-stdrate").value=c.standardLaborRatePerHour;
      $("#cr-role-operator").value=(c.laborCostByRole&&c.laborCostByRole.OPERATOR)||'';
      $("#cr-role-supervisor").value=(c.laborCostByRole&&c.laborCostByRole.SUPERVISOR)||'';
      $("#cr-storage").value=c.storageCostPerUnitMonth;
      $("#cr-pkgratio").value=c.packagingCostRatio;
      $("#cr-overhead").value=c.monthlyOverhead;
      $("#cr-driver").value=c.overheadDriver||'laborHours';
      ['PICK','PUTAWAY','PACK','RECEIVE','COUNT'].forEach(function(t){var el=$("#cr-uph-"+t);if(el)el.value=(c.standardUph&&c.standardUph[t])||'';});
      if($("#cos-rates-sub"))$("#cos-rates-sub").textContent='Actualizado '+(c.updatedAt?fmtDate(c.updatedAt):'—');
    }).catch(function(e){toast(e.message);});
  }
  function saveCostRates(){
    if(!op)return;
    var body={operationId:op,
      currency:($("#cr-currency").value||'CLP').trim(),
      standardLaborRatePerHour:parseFloat($("#cr-stdrate").value)||0,
      laborCostByRole:{OPERATOR:parseFloat($("#cr-role-operator").value)||0,SUPERVISOR:parseFloat($("#cr-role-supervisor").value)||0},
      storageCostPerUnitMonth:parseFloat($("#cr-storage").value)||0,
      packagingCostRatio:parseFloat($("#cr-pkgratio").value)||0,
      monthlyOverhead:parseFloat($("#cr-overhead").value)||0,
      overheadDriver:$("#cr-driver").value||'laborHours',
      standardUph:{}
    };
    ['PICK','PUTAWAY','PACK','RECEIVE','COUNT'].forEach(function(t){var v=parseFloat($("#cr-uph-"+t).value);if(v>0)body.standardUph[t]=v;});
    api('/costs/rates',{method:'PUT',body:body}).then(function(){toast('Tarifario de costos guardado');loadCostos();}).catch(function(e){toast(e.message);});
  }
  function pctCell(p){ if(p==null)return '<td class="num muted">—</td>'; var col=p>=20?'var(--good,#1f9d55)':p>=0?'var(--warn,#c77700)':'var(--crit,#c0392b)'; return '<td class="num" style="color:'+col+';font-weight:700">'+p+'%</td>'; }
  function loadCostos(){
    if(!op)return;
    var mp=cosMonthParts();
    var q='operationId='+encodeURIComponent(op)+'&year='+mp.year+'&month='+mp.month;
    api('/costs/profitability?'+q).then(function(p){
      var cur=p.currency||'CLP', t=p.totals||{};
      $("#cos-prof-sub").textContent=(p.sellers||[]).length+' clientes · '+(p.window?p.window.days+' días':'');
      var mreal=t.marginReal||0, varlab=t.laborVariance||0;
      $("#cos-kpis").innerHTML=[
        {l:"Ingreso",v:fmtMoney(t.revenue||0,cur),d:"facturación del período"},
        {l:"Costo real",v:fmtMoney(t.totalReal||0,cur),d:"actividad + overhead"},
        {l:"Margen real",v:fmtMoney(mreal,cur),d:(t.marginPctReal!=null?t.marginPctReal+'% efectivo':'—')},
        {l:"Margen objetivo",v:fmtMoney(t.marginStandard||0,cur),d:(t.marginPctStandard!=null?t.marginPctStandard+'% a estándar':'—')},
        {l:"Varianza M. Obra",v:fmtMoney(varlab,cur),d:(varlab>0?'sobrecosto vs estándar':'bajo estándar (bueno)')}
      ].map(function(x){return '<div class="kpi"><div class="l">'+x.l+'</div><div class="v">'+x.v+'</div><div class="d">'+esc(x.d)+'</div></div>';}).join("");
      var rows=p.sellers||[];
      $("#cos-prof-body").innerHTML=rows.length?rows.map(function(s){
        var c=s.cost||{};
        return '<tr><td>'+esc(s.sellerName||s.sellerId)+'</td>'
          +'<td class="num">'+fmtInt(s.revenue)+'</td>'
          +'<td class="num">'+fmtInt(c.totalReal)+'</td>'
          +'<td class="num">'+fmtInt(c.laborStandard)+' / '+fmtInt(c.laborReal)+'</td>'
          +'<td class="num">'+fmtInt(c.storage)+'</td>'
          +'<td class="num">'+fmtInt(c.packaging)+'</td>'
          +'<td class="num">'+fmtInt(c.overhead)+'</td>'
          +'<td class="num" style="font-weight:700">'+fmtInt(s.marginReal)+'</td>'
          +pctCell(s.marginPctReal)+pctCell(s.marginPctStandard)+'</tr>';
      }).join(""):'<tr><td colspan="10" class="empty">Sin datos de facturación/costo en el período.</td></tr>';
    }).catch(function(e){$("#cos-prof-body").innerHTML='<tr><td colspan="10" class="empty">'+esc(e.message)+'</td></tr>';});
    loadEfficiency();
  }
  function loadEfficiency(){
    if(!op)return;
    var mp=cosMonthParts();
    var q='operationId='+encodeURIComponent(op)+'&year='+mp.year+'&month='+mp.month+'&groupBy='+cosGroup;
    api('/costs/efficiency?'+q).then(function(e){
      var rows=e.rows||[], cur=e.currency||'CLP';
      $("#cos-eff-body").innerHTML=rows.length?rows.map(function(r){
        var eff=r.efficiencyPct, ecol=eff==null?'':(eff>=100?'var(--good,#1f9d55)':eff>=85?'var(--warn,#c77700)':'var(--crit,#c0392b)');
        var vcol=r.variance>0?'var(--crit,#c0392b)':'var(--good,#1f9d55)';
        return '<tr><td>'+esc(r.label)+'</td><td class="num">'+fmtInt(r.units)+'</td><td class="num">'+r.realHours+' h</td><td class="num">'+r.standardHours+' h</td>'
          +'<td class="num"'+(ecol?' style="color:'+ecol+';font-weight:700"':'')+'>'+(eff!=null?eff+'%':'—')+'</td>'
          +'<td class="num">'+fmtInt(r.realCost)+'</td><td class="num">'+fmtInt(r.standardCost)+'</td>'
          +'<td class="num" style="color:'+vcol+';font-weight:700">'+fmtInt(r.variance)+'</td></tr>';
      }).join(""):'<tr><td colspan="8" class="empty">Sin tareas de mano de obra en el período.</td></tr>';
    }).catch(function(e){$("#cos-eff-body").innerHTML='<tr><td colspan="8" class="empty">'+esc(e.message)+'</td></tr>';});
  }

  function renderUserActivity(){
    if(!actInited){
      actInited=true;
      $$("#act-toggle .segbtn").forEach(function(b){b.addEventListener("click",function(){
        actWindow=b.getAttribute("data-aw");
        $$("#act-toggle .segbtn").forEach(function(x){x.classList.toggle("on",x===b);});
        var cust=actWindow==="custom";
        if($("#act-fromwrap"))$("#act-fromwrap").classList.toggle("hidden",!cust);
        if($("#act-towrap"))$("#act-towrap").classList.toggle("hidden",!cust);
        if(!cust)loadActivity();
      });});
      var rf=$("#act-refresh"); if(rf)rf.addEventListener("click",loadActivity);
      var us=$("#act-user"); if(us)us.addEventListener("change",function(){actUser=us.value;loadActivity();});
    }
    loadActivity();
  }
  function actRange(){
    var DAY=86400000, now=Date.now(), from=null, to=null;
    if(actWindow==="custom"){
      var f=$("#act-from")&&$("#act-from").value, t=$("#act-to")&&$("#act-to").value;
      if(f)from=Date.parse(f+"T00:00:00");
      if(t)to=Date.parse(t+"T23:59:59");
    } else if(actWindow!=="0"){
      from=now-parseInt(actWindow,10)*DAY;
    }
    return {from:from,to:to};
  }
  function loadActivity(){
    var body=$("#act-prod-body"); if(!body)return;
    var r=actRange();
    var qs='operationId='+encodeURIComponent(op||'');
    if(actUser)qs+='&userId='+encodeURIComponent(actUser);
    if(r.from!=null)qs+='&from='+encodeURIComponent(new Date(r.from).toISOString());
    if(r.to!=null)qs+='&to='+encodeURIComponent(new Date(r.to).toISOString());
    $("#act-feed").innerHTML='<div class="muted">Cargando actividad…</div>';
    api('/activity?'+qs).then(function(d){ actRenderUsers(d.users); actRenderKpis(d); actRenderProd(d); actRenderFeed(d); })
      .catch(function(e){ $("#act-feed").innerHTML='<div class="muted">No se pudo cargar: '+esc(e.message)+'</div>'; });
  }
  function actRenderUsers(users){
    var us=$("#act-user"); if(!us)return;
    var cur=us.value;
    var opts='<option value="">Todos los operadores</option>'+(users||[]).map(function(u){
      return '<option value="'+esc(u.id)+'">'+esc(u.name)+' · '+esc(ACT_ROLE[u.role]||u.role)+'</option>';
    }).join('');
    us.innerHTML=opts; us.value=cur||actUser||'';
  }
  function actRenderKpis(d){
    var el=$("#act-kpis"); if(!el)return;
    var s={picked:0,packed:0,shipped:0,putaways:0,receipts:0};
    (d.productivity||[]).forEach(function(p){s.picked+=p.picked;s.packed+=p.packed;s.shipped+=p.shipped;s.putaways+=p.putaways;s.receipts+=p.receipts;});
    var winLbl=actWindow==="0"?"todo el histórico":actWindow==="custom"?"rango elegido":(actWindow==="1"?"últimas 24 h":"últimos "+actWindow+" días");
    var kpis=[
      {l:"Eventos registrados",v:fmtInt(d.totalEvents),d:"en "+winLbl},
      {l:"Órdenes despachadas",v:fmtInt(s.shipped),d:"marcadas SHIPPED"},
      {l:"Órdenes empacadas",v:fmtInt(s.packed),d:"marcadas PACKED"},
      {l:"Órdenes pickeadas",v:fmtInt(s.picked),d:"picking terminado"},
      {l:"Guardados",v:fmtInt(s.putaways),d:"putaway a almacenaje"},
      {l:"Recepciones",v:fmtInt(s.receipts),d:"entradas de mercadería"}
    ];
    el.innerHTML=kpis.map(function(x){return '<div class="kpi"><div class="l">'+x.l+'</div><div class="v">'+x.v+'</div><div class="d">'+esc(x.d)+'</div></div>';}).join("");
  }
  function actRenderProd(d){
    var head=$("#act-prod-head"), body=$("#act-prod-body"); if(!head||!body)return;
    head.innerHTML='<tr><th>Operador</th><th>Rol</th><th style="text-align:right">Reservó</th><th style="text-align:right">Picking</th><th style="text-align:right">Pickeó</th><th style="text-align:right">Empacó</th><th style="text-align:right">Despachó</th><th style="text-align:right">Anuló</th><th style="text-align:right">Guardados</th><th style="text-align:right">Recepciones</th><th style="text-align:right">Ajustes</th><th style="text-align:right">Total</th></tr>';
    var rows=(d.productivity||[]);
    if(!rows.length){ body.innerHTML='<tr><td colspan="12" class="muted" style="text-align:center;padding:18px">Sin actividad en el período.</td></tr>'; if($("#act-prod-sub"))$("#act-prod-sub").textContent=''; return; }
    var rc=function(n){return '<td style="text-align:right">'+(n?fmtInt(n):'<span class="muted">·</span>')+'</td>';};
    var ru=function(n,u){return '<td style="text-align:right">'+(n?(fmtInt(n)+' <span class="muted" style="font-size:11px">('+fmtInt(u)+' un)</span>'):'<span class="muted">·</span>')+'</td>';};
    body.innerHTML=rows.map(function(p){
      return '<tr><td><b>'+esc(p.name)+'</b></td><td><span class="muted">'+esc(ACT_ROLE[p.role]||p.role)+'</span></td>'
        +rc(p.allocated)+rc(p.pickingStarted)+rc(p.picked)+rc(p.packed)+rc(p.shipped)+rc(p.cancelled)
        +ru(p.putaways,p.putawayUnits)+ru(p.receipts,p.receiptUnits)+rc(p.adjustments)
        +'<td style="text-align:right;font-weight:700">'+fmtInt(p.total)+'</td></tr>';
    }).join('');
    if($("#act-prod-sub"))$("#act-prod-sub").textContent=rows.length+' operador(es) con actividad';
  }
  function actFmtWhen(iso){
    try{ var dt=new Date(iso); return dt.toLocaleDateString('es-CL',{day:'2-digit',month:'short'})+' '+dt.toLocaleTimeString('es-CL',{hour:'2-digit',minute:'2-digit'}); }catch(e){return iso;}
  }
  function actRenderFeed(d){
    var el=$("#act-feed"); if(!el)return;
    var feed=d.feed||[];
    if($("#act-feed-sub"))$("#act-feed-sub").textContent=feed.length?('mostrando '+feed.length+' de '+d.totalEvents+' eventos'):'';
    if(!feed.length){ el.innerHTML='<div class="muted" style="padding:8px">Sin eventos en el período.</div>'; return; }
    var lastDay='';
    var html=feed.map(function(f){
      var day=''; try{ day=new Date(f.at).toLocaleDateString('es-CL',{weekday:'long',day:'2-digit',month:'long'}); }catch(e){}
      var hdr='';
      if(day!==lastDay){ lastDay=day; hdr='<div class="muted" style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;margin:12px 0 4px;font-weight:700">'+esc(day)+'</div>'; }
      var col=f.source==='orden'?'var(--primary,#127a3d)':'var(--warn,#c78a00)';
      var t=''; try{ t=new Date(f.at).toLocaleTimeString('es-CL',{hour:'2-digit',minute:'2-digit'}); }catch(e){}
      return hdr+'<div style="display:flex;gap:10px;align-items:flex-start;padding:6px 2px;border-bottom:1px solid var(--line)">'
        +'<div style="width:46px;flex:none;color:var(--ink-2,#556);font-size:12px;padding-top:1px">'+esc(t)+'</div>'
        +'<div style="width:8px;height:8px;border-radius:50%;background:'+col+';margin-top:6px;flex:none"></div>'
        +'<div style="flex:1;min-width:0"><div style="font-size:13px"><b>'+esc(f.actorName)+'</b> · '+esc(f.label)
        +' <span style="color:var(--ink-2,#556)">'+esc(f.ref||'')+'</span></div>'
        +(f.detail?'<div class="muted" style="font-size:11.5px">'+esc(f.detail)+'</div>':'')+'</div></div>';
    }).join('');
    el.innerHTML=html;
  }

  // ===== Plan del SaaS (PLG · Fase 1) =====
  var PLAN_LABEL={free:"Free",growth:"Growth",scale:"Scale",enterprise:"Enterprise",internal:"Interno"};
  var planCurrency="CLP"; // moneda mostrada en el comparador (Chile por defecto)
  var planLast=null;      // último estado+catálogo, para re-render al cambiar de moneda
  function fmtLimit(v){ return v==null ? "ilimitado" : fmtInt(v); }
  function planMoney(prices,cur){
    if(!prices) return "—";
    var v = cur==="USD" ? prices.usd : prices.clp;
    if(v==null) return "A medida";
    if(v===0) return "Gratis";
    return cur==="USD" ? ("US$"+fmtInt(v)+"/mes") : ("$"+fmtInt(v)+" CLP/mes");
  }
  function renderPlan(){
    var host=$("#plan-current"); if(!host)return;
    host.innerHTML='<div class="muted">Cargando tu plan…</div>';
    Promise.all([
      api('/plan?operationId='+encodeURIComponent(op||'')),
      api('/plan/catalog').catch(function(){return {plans:[]};})
    ]).then(function(r){ planLast={st:r[0],catalog:r[1].plans||[]}; planRender(r[0], r[1].plans||[]); })
      .catch(function(e){ host.innerHTML='<div class="muted">No se pudo cargar: '+esc(e.message)+'</div>'; });
  }
  function planMeter(label,row){
    var used=row.used||0, limit=row.limit;
    var pct = (limit==null||limit===0) ? (limit===0?100:8) : Math.min(100, Math.round(used/limit*100));
    var cls = limit==null ? "" : (used>=limit ? "crit" : (used/limit>=0.8 ? "warn" : ""));
    return '<div class="meter"><div class="lbl"><span>'+esc(label)+'</span><b>'+fmtInt(used)+' / '+fmtLimit(limit)+'</b></div>'
      +'<div class="track"><div class="fill '+cls+'" style="width:'+(limit==null?100:pct)+'%;opacity:'+(limit==null?.35:1)+'"></div></div></div>';
  }
  function planRender(st, catalog){
    // Barra de prueba
    var tb=$("#plan-trial");
    if(tb){
      if(st.trial&&st.trial.active){
        tb.innerHTML='<div class="plan-trialbar">✨ Estás probando <b>'+esc(PLAN_LABEL[st.trial.plan]||st.trial.plan)+'</b> gratis — te quedan <b>'+fmtInt(st.trial.daysLeft)+' día(s)</b>. Al terminar, tu cuenta pasa a <b>'+esc(st.basePlan.name)+'</b>.</div>';
      } else tb.innerHTML='';
    }
    // Plan actual
    $("#plan-current").innerHTML=''
      +'<div class="plan-hero"><span class="nm">'+esc(st.plan.name)+'</span><span class="pr">'+esc(planMoney(st.plan.prices,planCurrency))+'</span>'
      +(st.trial&&st.trial.active?'<span class="plan-badge">En prueba</span>':'')+'</div>'
      +'<div class="muted" style="margin-top:4px">'+esc(st.plan.blurb||'')+'</div>'
      +'<div style="font-size:12.5px;color:var(--ink-2);margin-top:12px;font-weight:600">Incluye</div>'
      +'<div class="featchips">'+(st.plan.features||[]).map(function(f){return '<span class="featchip">'+esc(FEATURE_LABEL[f]||f)+'</span>';}).join('')+'</div>';
    // Uso
    $("#plan-usage").innerHTML=''
      +planMeter("Órdenes despachables (este mes)", st.usage.ordersPerMonth)
      +planMeter("Clientes (sellers)", st.usage.sellers)
      +planMeter("Usuarios", st.usage.users)
      +planMeter("Ubicaciones", st.usage.warehouses);
    // Catálogo comparativo
    var canGrant = role==="PLATFORM_ADMIN";
    if($("#plan-admin-hint")) $("#plan-admin-hint").textContent = canGrant ? "Como plataforma, puedes asignar un plan directamente." : "";
    $("#plan-catalog").innerHTML=(catalog||[]).map(function(p){
      var cur = p.id===st.plan.id;
      var lim=p.limits||{};
      var btn = cur
        ? '<button class="tbtn cur" disabled>Plan actual</button>'
        : (canGrant
            ? '<button class="tbtn pri" data-plangrant="'+esc(p.id)+'">Asignar</button>'
            : '<button class="tbtn" data-planupg="'+esc(p.name)+'">Mejorar</button>');
      return '<div class="ptier'+(cur?' cur':'')+'">'
        +'<div class="tn">'+esc(p.name)+'</div><div class="tp">'+esc(planMoney(p.prices,planCurrency))+'</div>'
        +'<ul>'
        +'<li>'+fmtLimit(lim.ordersPerMonth)+' órdenes/mes</li>'
        +'<li>'+fmtLimit(lim.sellers)+' clientes</li>'
        +'<li>'+fmtLimit(lim.users)+' usuarios</li>'
        +'<li>'+fmtLimit(lim.warehouses)+' ubicaciones</li>'
        +'</ul>'+btn+'</div>';
    }).join('');
    $$('#plan-catalog [data-plangrant]').forEach(function(b){ b.addEventListener('click',function(){
      var pid=b.getAttribute('data-plangrant');
      api('/plan',{method:'PUT',body:{operationId:op,planId:pid}}).then(function(){ toast('Plan actualizado'); renderPlan(); if(typeof loadOp==='function')loadOp(); }).catch(function(e){ toast(e.message); });
    });});
    $$('#plan-catalog [data-planupg]').forEach(function(b){ b.addEventListener('click',function(){
      toast('Pronto podrás mejorar tu plan con pago en línea. Por ahora, escríbenos y lo activamos.');
    });});
  }
  var FEATURE_LABEL={wms_core:"WMS operativo (inbound + outbound + inventario)",returns:"Devoluciones",kitting:"Armado de kits",cycle_count:"Conteo cíclico",packaging_materials:"Insumos de embalaje",lot_serial:"Lote / serie / vencimiento",task_assignment:"Asignación de tareas",reslotting:"Re-slotting dinámico",billing_3pl:"Facturación 3PL",cost_profitability:"Costos y rentabilidad",advanced_analytics:"Analítica avanzada",ai_copilot:"Copiloto IA",ai_voice:"Copiloto de voz",webhooks:"Webhooks",api:"API",white_label:"Marca propia (white-label)",multi_courier:"Multi-courier",client_chat:"Mensajería con clientes",voice_channel:"Canal de voz operativo",announcements:"Anuncios"};
  (function wirePlanCurrency(){
    var box=$("#plan-cur"); if(!box)return;
    $$("#plan-cur .segbtn").forEach(function(b){ b.addEventListener("click",function(){
      planCurrency=b.getAttribute("data-cur");
      $$("#plan-cur .segbtn").forEach(function(x){x.classList.toggle("on",x===b);});
      if(planLast) planRender(planLast.st, planLast.catalog);
    });});
  })();

  // ===== Mantenedor de empaquetado: matriz módulo × plan (super-admin) =====
  function renderPkgMatrix(){
    var host=$("#pkg-matrix"); if(!host)return;
    host.innerHTML='<div class="b muted">Cargando matriz…</div>';
    api('/plan/admin/matrix').then(function(m){ pkgRenderMatrix(m); })
      .catch(function(e){ host.innerHTML='<div class="b muted">No se pudo cargar: '+esc(e.message)+'</div>'; });
  }
  function pkgRenderMatrix(m){
    var host=$("#pkg-matrix"); if(!host)return;
    var plans=m.plans||[], modules=m.modules||[], limits=m.limits||[], counts=m.accountCounts||{};
    // Encabezado: nombre + precio editables + cuentas por plan.
    var head='<tr><th class="rowlbl" style="min-width:220px">Módulo / Límite</th>'+plans.map(function(p){
      var c=counts[p.id]||0; var pr=p.prices||{usd:null,clp:null};
      var pv=function(v){return v==null?'':v;};
      return '<th><input class="pname" data-pn="'+esc(p.id)+'" value="'+esc(p.name)+'">'
        +'<div class="pricegrid">'
        +'<label>USD</label><input class="pprice" type="number" min="0" placeholder="a medida" data-pusd="'+esc(p.id)+'" value="'+pv(pr.usd)+'">'
        +'<label>CLP</label><input class="pprice" type="number" min="0" placeholder="a medida" data-pclp="'+esc(p.id)+'" value="'+pv(pr.clp)+'">'
        +'</div>'
        +'<div class="pcount">'+c+' cuenta'+(c===1?'':'s')+'</div></th>';
    }).join('')+'</tr>';
    // Núcleo (siempre incluido).
    var coreRow='<tr><td class="rowlbl">WMS completo <span class="d">(núcleo, siempre incluido)</span></td>'
      +plans.map(function(){return '<td><span class="core">✓ incluido</span></td>';}).join('')+'</tr>';
    // Filas de módulos, agrupadas por familia.
    var lastGroup=null;
    var modRows=modules.map(function(mod){
      var gh='';
      if(mod.group && mod.group!==lastGroup){ lastGroup=mod.group; gh='<tr class="pkg-group"><td class="rowlbl" colspan="'+(plans.length+1)+'" style="font-weight:800;color:var(--ink-2);background:var(--surface-2);text-transform:uppercase;letter-spacing:.04em;font-size:11.5px">'+esc(mod.group)+'</td></tr>'; }
      return gh+'<tr><td class="rowlbl">'+esc(mod.label)+'<div class="d">'+esc(mod.description)+'</div></td>'
        +plans.map(function(p){
          var on=(p.features||[]).indexOf(mod.key)>=0;
          return '<td><input type="checkbox" data-feat="'+esc(mod.key)+'" data-plan="'+esc(p.id)+'"'+(on?' checked':'')+'></td>';
        }).join('')+'</tr>';
    }).join('');
    // Filas de límites (vacío = ilimitado).
    var limRows=limits.map(function(l){
      return '<tr><td class="rowlbl">'+esc(l.label)+'<div class="d">vacío = ilimitado</div></td>'
        +plans.map(function(p){
          var v=(p.limits||{})[l.key];
          return '<td><input class="lim" type="number" min="0" placeholder="∞" data-lim="'+esc(l.key)+'" data-plan="'+esc(p.id)+'" value="'+(v==null?'':v)+'"></td>';
        }).join('')+'</tr>';
    }).join('');
    host.innerHTML='<table class="pkg"><thead>'+head+'</thead><tbody>'
      +'<tr class="secrow"><td colspan="'+(plans.length+1)+'">Módulos</td></tr>'
      +coreRow+modRows
      +'<tr class="secrow"><td colspan="'+(plans.length+1)+'">Límites</td></tr>'
      +limRows
      +'</tbody></table>';
  }
  function pkgCollect(planId){
    var name=($('#pkg-matrix [data-pn="'+planId+'"]')||{}).value;
    var usdRaw=(($('#pkg-matrix [data-pusd="'+planId+'"]')||{}).value||'').trim();
    var clpRaw=(($('#pkg-matrix [data-pclp="'+planId+'"]')||{}).value||'').trim();
    var prices={ usd: usdRaw===''?null:Math.max(0,Math.round(Number(usdRaw))), clp: clpRaw===''?null:Math.max(0,Math.round(Number(clpRaw))) };
    var features=[]; $$('#pkg-matrix input[data-plan="'+planId+'"][data-feat]').forEach(function(c){ if(c.checked)features.push(c.getAttribute('data-feat')); });
    var limits={}; $$('#pkg-matrix input[data-plan="'+planId+'"][data-lim]').forEach(function(inp){
      var k=inp.getAttribute('data-lim'); var raw=(inp.value||'').trim();
      limits[k]= raw===''? null : Math.max(0,Math.floor(Number(raw)));
    });
    return {name:name,prices:prices,features:features,limits:limits};
  }
  (function wirePkgButtons(){
    var save=$("#pkg-save"), reset=$("#pkg-reset");
    if(save)save.addEventListener('click',function(){
      var ids=[]; $$('#pkg-matrix [data-pn]').forEach(function(i){ids.push(i.getAttribute('data-pn'));});
      if(!ids.length){return;}
      save.disabled=true; save.textContent="Guardando…";
      var chain=Promise.resolve();
      ids.forEach(function(pid){ chain=chain.then(function(){ return api('/plan/admin/'+encodeURIComponent(pid),{method:'PUT',body:pkgCollect(pid)}); }); });
      chain.then(function(){ toast("Empaquetado guardado"); renderPkgMatrix(); }).catch(function(e){ toast(e.message); })
        .then(function(){ save.disabled=false; save.textContent="Guardar cambios"; });
    });
    if(reset)reset.addEventListener('click',function(){
      api('/plan/admin/reset',{method:'POST',body:{}}).then(function(){ toast("Restaurado a valores por defecto"); renderPkgMatrix(); }).catch(function(e){ toast(e.message); });
    });
  })();

  // ===== Onboarding / activación (PLG · Fase 2) =====
  var onbDismissed=false;
  function renderOnboarding(){
    var host=$("#onboard-card"); if(!host)return;
    if(role==="CLIENT"||onbDismissed){ host.innerHTML=""; return; }
    api('/onboarding?operationId='+encodeURIComponent(op||'')).then(function(st){
      if(!st||st.activated){ host.innerHTML=""; return; } // cuenta ya activada: sin tarjeta
      var pct=Math.round(st.done/st.total*100);
      var next=null; for(var i=0;i<st.steps.length;i++){ if(!st.steps[i].done){ next=st.steps[i]; break; } }
      var stepsHtml=st.steps.map(function(s){
        var isNext=next&&s.key===next.key;
        return '<div class="onb-step '+(s.done?'done':'')+'">'
          +'<div class="onb-tick '+(s.done?'on':'')+'">'+(s.done?'✓':'')+'</div>'
          +'<span class="lbl">'+esc(s.label)+'</span><span class="sp"></span>'
          +(!s.done&&s.link&&isNext?'<button class="go" data-onbgo="'+esc(s.link)+'">Ir →</button>':'')
          +'</div>';
      }).join('');
      var canSample=can('master');
      host.innerHTML='<div class="onb">'
        +'<div class="onb-head"><h3>🚀 Pon en marcha tu bodega</h3><span class="sp"></span>'
        +'<div class="onb-prog"><span class="pct">'+st.done+'/'+st.total+'</span><div class="track"><div class="fill" style="width:'+pct+'%"></div></div></div></div>'
        +'<div class="muted" style="margin-top:4px;font-size:13px">Completa estos pasos para despachar tu primera orden — ese es el momento en que Ninja WMS te empieza a rendir.</div>'
        +'<div class="onb-steps">'+stepsHtml+'</div>'
        +'<div class="onb-actions">'
        +(canSample?'<button class="onb-sample" id="onb-sample">✨ Cargar datos de ejemplo</button><span class="muted" style="font-size:12px">Puebla tu cuenta con productos y órdenes de prueba para explorar el flujo completo.</span>':'')
        +'<span class="sp" style="flex:1"></span><button class="onb-x" id="onb-x">Ocultar</button></div>'
        +'</div>';
      $$('#onboard-card [data-onbgo]').forEach(function(b){b.addEventListener('click',function(){go(b.getAttribute('data-onbgo'));});});
      var xb=$("#onb-x"); if(xb)xb.addEventListener('click',function(){onbDismissed=true;host.innerHTML="";});
      var sb=$("#onb-sample"); if(sb)sb.addEventListener('click',function(){
        sb.disabled=true; sb.textContent="Cargando…";
        api('/onboarding/sample-data',{method:'POST',body:{operationId:op}}).then(function(r){
          if(r&&r.loaded){ toast("Datos de ejemplo cargados"); if(typeof loadOp==='function')loadOp(); }
          else { toast("Tu cuenta ya tiene datos."); renderOnboarding(); }
        }).catch(function(e){ toast(e.message); sb.disabled=false; sb.textContent="✨ Cargar datos de ejemplo"; });
      });
    }).catch(function(){ host.innerHTML=""; });
  }

  // ===== Anuncios de plataforma: barra superior + mantenedor + reporte de clics =====
  var annActive=null, annDismissedId=null;
  function annRoleLabel(r){return {PLATFORM_ADMIN:'Plataforma',ADMIN:'Administrador',SUPERVISOR:'Supervisor',OPERATOR:'Operario',CLIENT:'Cliente'}[r]||r;}
  function opName2(id){if(!id)return '—';var o=(D.ops||[]).filter(function(x){return x.id===id;})[0];return o?(o.name||id):id;}
  /**
   * Muestra la barra superior SOLO si hay un anuncio activo de verdad.
   *
   * Cuidado con el caso vacío: cuando no hay ninguno activo el backend responde
   * 200 con cuerpo vacío y api() lo normaliza a {} —un objeto sin id, pero
   * igualmente "truthy"—, así que la barra se abría igual y quedaba una franja
   * de color sin texto. Por eso exigimos id y título, y ante cualquier error
   * la barra se esconde en vez de quedarse pegada de la vuelta anterior.
   */
  function pollAnnouncement(){
    var bar=$("#ann-bar"); if(!bar)return;
    function ocultar(){ annActive=null; bar.style.display='none'; }
    if(!can('annView')){ocultar();return;}
    api('/announcements/active').then(function(a){
      var hay=a&&typeof a==='object'&&a.id&&String(a.title||'').trim();
      if(!hay){ocultar();return;}
      annActive=a;
      if(a.id===annDismissedId){bar.style.display='none';return;} // el usuario la cerró
      $("#ann-text").textContent=a.title;
      $("#ann-link").textContent=a.linkLabel||'Ver más';
      bar.style.display='';
    }).catch(ocultar);
  }
  function renderAnnouncements(){
    if(!$("#ann-list")||!can('annManage'))return;
    api('/platform/announcements').then(function(list){renderAnnList(list);}).catch(function(){});
  }
  function renderAnnList(list){
    list=list||[];
    $("#ann-list").innerHTML=list.length?list.map(function(a){
      var estado=a.active?'<span class="pill ok">Activo</span>':'<span class="pill neutral">Inactivo</span>';
      var aud=(a.audience==='ALL')?'<span class="pill neutral" title="Se difunde también a clientes">Ops + Clientes</span>':'<span class="pill neutral" title="Solo administradores y supervisores">Solo Ops</span>';
      return '<tr data-ann="'+esc(a.id)+'"><td><b>'+esc(a.title)+'</b></td>'
        +'<td class="muted" style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(a.linkUrl)+'</td>'
        +'<td>'+estado+' '+aud+'</td>'
        +'<td class="num" data-anncount="'+esc(a.id)+'">…</td>'
        +'<td class="muted">'+esc(fmtDate(a.createdAt))+'</td>'
        +'<td><div class="card-actions" style="justify-content:flex-end;flex-wrap:wrap">'
        +'<button class="mini" data-anne="'+esc(a.id)+'">Editar</button>'
        +'<button class="mini" data-annt="'+esc(a.id)+'">'+(a.active?'Desactivar':'Activar')+'</button>'
        +'<button class="mini" data-annc="'+esc(a.id)+'">Clics</button>'
        +'<button class="mini danger" data-annd="'+esc(a.id)+'">Eliminar</button></div></td></tr>';
    }).join(""):'<tr><td colspan="6" class="empty">Aún no hay anuncios. Crea el primero para habilitar la barra.</td></tr>';
    // Rellena los conteos de clics de cada anuncio (llamadas ligeras).
    list.forEach(function(a){ api('/platform/announcements/'+encodeURIComponent(a.id)+'/clicks').then(function(r){var c=document.querySelector('[data-anncount="'+CSS.escape(a.id)+'"]');if(c)c.textContent=r.total;}).catch(function(){}); });
    var byId2=function(id){return list.filter(function(x){return x.id===id;})[0];};
    $$("#ann-list [data-anne]").forEach(function(b){b.addEventListener("click",function(){openAnnForm(byId2(b.getAttribute("data-anne")));});});
    $$("#ann-list [data-annt]").forEach(function(b){b.addEventListener("click",function(){var a=byId2(b.getAttribute("data-annt"));api('/platform/announcements/'+encodeURIComponent(a.id),{method:'PATCH',body:{active:!a.active}}).then(function(){toast(a.active?'Anuncio desactivado':'Anuncio activado');renderAnnouncements();pollAnnouncement();}).catch(function(e){toast(e.message);});});});
    $$("#ann-list [data-annc]").forEach(function(b){b.addEventListener("click",function(){openAnnClicks(byId2(b.getAttribute("data-annc")));});});
    $$("#ann-list [data-annd]").forEach(function(b){b.addEventListener("click",function(){var a=byId2(b.getAttribute("data-annd"));confirmBox('Eliminar anuncio','Se eliminará el anuncio <b>'+esc(a.title)+'</b> y sus clics registrados.','Eliminar',function(){api('/platform/announcements/'+encodeURIComponent(a.id),{method:'DELETE'}).then(function(){toast('Anuncio eliminado');renderAnnouncements();pollAnnouncement();}).catch(function(e){toast(e.message);});},true);});});
  }
  function openAnnForm(a){
    var isEdit=!!a; a=a||{};
    var aud=(a.audience==='ALL')?'ALL':'OPS';
    var body='<div class="fgrid" style="gap:12px">'
      +'<label>Texto del anuncio<input id="af-title" maxlength="240" value="'+esc(a.title||'')+'" placeholder="Ej: Nuevo módulo de facturación disponible"></label>'
      +'<label>Enlace a la landing (URL)<input id="af-url" value="'+esc(a.linkUrl||'')+'" placeholder="https://ninjahubs.cl/novedades"></label>'
      +'<label>Etiqueta del botón<input id="af-label" maxlength="40" value="'+esc(a.linkLabel||'Ver más')+'" placeholder="Ver más"></label>'
      +'<div><div class="hint" style="margin-bottom:6px">¿A quién se difunde?</div>'
      +'<div class="billtabs" id="af-aud" style="margin:0">'
      +'<button type="button" class="segbtn'+(aud==='OPS'?' on':'')+'" data-aud="OPS">Solo administradores (admin y supervisor)</button>'
      +'<button type="button" class="segbtn'+(aud==='ALL'?' on':'')+'" data-aud="ALL">Incluir también a clientes</button>'
      +'</div></div>'
      +'<label class="apprv-row" style="flex-direction:row;align-items:center;gap:9px;cursor:pointer"><input type="checkbox" id="af-active"'+(a.active!==false?' checked':'')+'> Mostrar la barra (activo)</label>'
      +'</div><p class="ferr" id="af-err" style="min-height:16px"></p>'
      +'<div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn" id="af-cancel">Cancelar</button><button class="btn pri" id="af-save">'+(isEdit?'Guardar cambios':'Crear anuncio')+'</button></div>';
    openModal(isEdit?'Editar anuncio':'Nuevo anuncio',body,true);
    $$("#af-aud .segbtn").forEach(function(b){b.addEventListener("click",function(){$$("#af-aud .segbtn").forEach(function(x){x.classList.toggle("on",x===b);});});});
    $("#af-cancel").addEventListener("click",closeModal);
    $("#af-save").addEventListener("click",function(){
      $("#af-err").textContent='';
      var audSel=(document.querySelector('#af-aud .segbtn.on')||{}).getAttribute?document.querySelector('#af-aud .segbtn.on').getAttribute('data-aud'):'OPS';
      var payload={title:($("#af-title").value||'').trim(),linkUrl:($("#af-url").value||'').trim(),linkLabel:($("#af-label").value||'').trim(),active:$("#af-active").checked,audience:audSel};
      if(!payload.title){$("#af-err").textContent='El anuncio debe tener un texto.';return;}
      if(!payload.linkUrl){$("#af-err").textContent='El anuncio debe llevar un enlace.';return;}
      var req=isEdit?api('/platform/announcements/'+encodeURIComponent(a.id),{method:'PATCH',body:payload}):api('/platform/announcements',{method:'POST',body:payload});
      req.then(function(){toast(isEdit?'Anuncio actualizado':'Anuncio creado');closeModal();renderAnnouncements();pollAnnouncement();}).catch(function(e){$("#af-err").textContent=e.message;});
    });
  }
  function openAnnClicks(a){
    if(!a)return;
    api('/platform/announcements/'+encodeURIComponent(a.id)+'/clicks').then(function(r){
      var rolebreak=Object.keys(r.byRole||{}).map(function(k){return annRoleLabel(k)+': '+r.byRole[k];}).join(' · ')||'—';
      var head='<div class="ann-clickrow head"><span>Usuario</span><span>Rol</span><span>Operación / Cliente</span><span>Fecha</span></div>';
      var rows=(r.clicks||[]).map(function(c){
        var tenant=opName2(c.operationId)+(c.sellerId?(' · '+esc(c.sellerId)):'');
        return '<div class="ann-clickrow"><span><b>'+esc(c.userName)+'</b></span><span><span class="rolechip">'+esc(annRoleLabel(c.userRole))+'</span></span><span>'+tenant+'</span><span class="muted">'+esc(fmtDate(c.at))+'</span></div>';
      }).join('')||'<div class="empty" style="padding:16px">Todavía nadie ha hecho clic en este anuncio.</div>';
      var body='<div class="kpis" style="grid-template-columns:1fr 1fr 1fr;margin-bottom:14px">'
        +'<div class="kpi"><div class="l">Clics totales</div><div class="v">'+r.total+'</div></div>'
        +'<div class="kpi"><div class="l">Usuarios únicos</div><div class="v">'+r.uniqueUsers+'</div></div>'
        +'<div class="kpi"><div class="l">Por rol</div><div class="v" style="font-size:14px;font-family:inherit;font-weight:600">'+esc(rolebreak)+'</div></div></div>'
        +'<div class="card"><div class="b">'+head+rows+'</div></div>'
        +'<div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn" id="ac-close">Cerrar</button></div>';
      openModal('Clics · '+a.title,body,true);
      $("#ac-close").addEventListener("click",closeModal);
    }).catch(function(e){toast(e.message);});
  }

  // ---- Webhooks configurables por evento ------------------------------------
  var WH_EVENTS=[
    ["order.allocated","Orden reservada","Reservada"],
    ["order.picking","Orden en picking","En picking"],
    ["order.picked","Orden pickeada","Pickeada"],
    ["order.packed","Orden empacada","Empacada"],
    ["order.shipped","Orden despachada","Despachada"],
    ["order.cancelled","Orden cancelada","Cancelada"],
    ["reception.received","Recepción confirmada","Recepción"]
  ];
  function whEventChips(events){return (events||[]).map(function(e){var m=WH_EVENTS.filter(function(x){return x[0]===e;})[0];return '<span class="pill neutral">'+esc(m?m[2]:e)+'</span>';}).join(' ')||'<span class="muted">—</span>';}
  function whScopeLabel(s){return {SELLER:'Cliente',OPERATION:'Operación',PLATFORM:'Plataforma (global)'}[s]||s;}
  function renderWebhooks(){
    if(!$("#wh-list"))return;
    var notice=$("#wh-notice");
    // El cliente sin acceso ve un aviso en vez del panel.
    if(!whManage()){
      if(notice)notice.innerHTML='<div class="card"><div class="b" style="padding:6px 4px"><p class="empty" style="padding:18px">Tu operador aún no ha habilitado el panel de webhooks para tu cuenta.</p></div></div>';
      $("#wh-list").innerHTML=''; if($("#wh-list-card"))$("#wh-list-card").style.display='none';
      if($("#wh-new"))$("#wh-new").style.display='none';
      $("#wh-access-card").style.display='none';
      return;
    }
    if(notice)notice.innerHTML='';
    if($("#wh-list-card"))$("#wh-list-card").style.display='';
    if($("#wh-new"))$("#wh-new").style.display='';
    $("#wh-scope").textContent = role==='CLIENT'
      ? 'Tus webhooks reciben eventos de tu cuenta (cliente).'
      : (role==='PLATFORM_ADMIN' ? 'Webhooks de plataforma: reciben eventos de todas las operaciones.' : 'Webhooks de tu operación: reciben eventos de todos tus clientes.');
    api('/webhooks').then(renderWhList).catch(function(e){toast(e.message);});
    if(whAdmin())renderWhAccess(); else $("#wh-access-card").style.display='none';
  }
  function renderWhList(list){
    list=list||[];
    $("#wh-list").innerHTML=list.length?list.map(function(w){
      var estado=w.active?'<span class="chip st-AVAILABLE"><span class="dot"></span>Activo</span>':'<span class="chip st-CANCELLED"><span class="dot"></span>Inactivo</span>';
      return '<tr data-wh="'+esc(w.id)+'">'
        +'<td class="mono2" style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+esc(w.url)+'</td>'
        +'<td>'+whEventChips(w.events)+'</td>'
        +'<td>'+esc(whScopeLabel(w.scope))+'</td>'
        +'<td>'+estado+'</td>'
        +'<td><div class="card-actions" style="justify-content:flex-end;flex-wrap:wrap">'
        +'<button class="mini" data-whe="'+esc(w.id)+'">Editar</button>'
        +'<button class="mini" data-wht="'+esc(w.id)+'">'+(w.active?'Desactivar':'Activar')+'</button>'
        +'<button class="mini" data-whp="'+esc(w.id)+'">Probar</button>'
        +'<button class="mini" data-whd="'+esc(w.id)+'">Entregas</button>'
        +'<button class="mini danger" data-whx="'+esc(w.id)+'">Eliminar</button></div></td></tr>';
    }).join(""):'<tr><td colspan="5" class="empty">Aún no hay webhooks. Crea el primero para recibir eventos.</td></tr>';
    var byId2=function(id){return list.filter(function(x){return x.id===id;})[0];};
    $$("#wh-list [data-whe]").forEach(function(b){b.addEventListener("click",function(){openWebhookForm(byId2(b.getAttribute("data-whe")));});});
    $$("#wh-list [data-wht]").forEach(function(b){b.addEventListener("click",function(){var w=byId2(b.getAttribute("data-wht"));api('/webhooks/'+encodeURIComponent(w.id),{method:'PATCH',body:{active:!w.active}}).then(function(){toast(w.active?'Webhook desactivado':'Webhook activado');renderWebhooks();}).catch(function(e){toast(e.message);});});});
    $$("#wh-list [data-whp]").forEach(function(b){b.addEventListener("click",function(){var w=byId2(b.getAttribute("data-whp"));api('/webhooks/'+encodeURIComponent(w.id)+'/test',{method:'POST'}).then(function(d){toast(d&&d.status==='DELIVERED'?('Entrega OK (HTTP '+d.httpStatus+')'):('Falló la entrega'+(d&&d.httpStatus?(' (HTTP '+d.httpStatus+')'):'')));}).catch(function(e){toast(e.message);});});});
    $$("#wh-list [data-whd]").forEach(function(b){b.addEventListener("click",function(){openWebhookDeliveries(byId2(b.getAttribute("data-whd")));});});
    $$("#wh-list [data-whx]").forEach(function(b){b.addEventListener("click",function(){var w=byId2(b.getAttribute("data-whx"));confirmBox('Eliminar webhook','Se eliminará el webhook a <b>'+esc(w.url)+'</b> y su historial de entregas.','Eliminar',function(){api('/webhooks/'+encodeURIComponent(w.id),{method:'DELETE'}).then(function(){toast('Webhook eliminado');renderWebhooks();}).catch(function(e){toast(e.message);});},true);});});
  }
  function openWebhookForm(w){
    var isEdit=!!w; w=w||{};
    var evs=w.events||[];
    var checks=WH_EVENTS.map(function(x){var on=evs.indexOf(x[0])>=0;return '<label class="apprv-row" style="flex-direction:row;align-items:center;gap:9px;cursor:pointer"><input type="checkbox" class="wf-ev" value="'+x[0]+'"'+(on?' checked':'')+'> '+esc(x[1])+'</label>';}).join('');
    var body='<div class="fgrid" style="gap:12px">'
      +'<label>URL de destino<input id="wf-url" value="'+esc(w.url||'')+'" placeholder="https://mi-sistema.cl/webhooks/ninja"></label>'
      +'<div><div class="hint" style="margin-bottom:6px">Eventos a los que suscribir</div><div style="display:flex;flex-direction:column;gap:8px">'+checks+'</div></div>'
      +'<label class="apprv-row" style="flex-direction:row;align-items:center;gap:9px;cursor:pointer"><input type="checkbox" id="wf-active"'+(w.active!==false?' checked':'')+'> Activo</label>'
      +'</div><p class="ferr" id="wf-err" style="min-height:16px"></p>'
      +'<div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn" id="wf-cancel">Cancelar</button><button class="btn pri" id="wf-save">'+(isEdit?'Guardar cambios':'Crear webhook')+'</button></div>';
    openModal(isEdit?'Editar webhook':'Nuevo webhook',body,true);
    $("#wf-cancel").addEventListener("click",closeModal);
    $("#wf-save").addEventListener("click",function(){
      $("#wf-err").textContent='';
      var url=($("#wf-url").value||'').trim();
      var events=$$(".wf-ev").filter(function(c){return c.checked;}).map(function(c){return c.value;});
      if(!/^https?:\/\//i.test(url)){$("#wf-err").textContent='La URL debe empezar con http:// o https://';return;}
      if(!events.length){$("#wf-err").textContent='Selecciona al menos un evento.';return;}
      var req;
      if(isEdit){req=api('/webhooks/'+encodeURIComponent(w.id),{method:'PATCH',body:{url:url,events:events,active:$("#wf-active").checked}});}
      else{req=api('/webhooks',{method:'POST',body:{url:url,events:events}});}
      req.then(function(res){
        closeModal();toast(isEdit?'Webhook actualizado':'Webhook creado');
        if(!isEdit&&res&&res.secret)showWebhookSecret(res.secret);
        renderWebhooks();
      }).catch(function(e){$("#wf-err").textContent=e.message;});
    });
  }
  function showWebhookSecret(secret){
    var body='<p class="muted" style="margin:0 0 12px;line-height:1.5">Guarda este <b>secreto de firma</b>. Se usa para validar la firma <code>X-Ninja-Signature</code> (HMAC-SHA256) de cada entrega. No volverá a mostrarse completo.</p>'
      +'<div class="card"><div class="b" style="padding:12px"><code style="word-break:break-all;font-size:13px">'+esc(secret)+'</code></div></div>'
      +'<div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn pri" id="ws-ok">Listo</button></div>';
    openModal('Secreto del webhook',body,true);
    $("#ws-ok").addEventListener("click",closeModal);
  }
  function openWebhookDeliveries(w){
    if(!w)return;
    api('/webhooks/'+encodeURIComponent(w.id)+'/deliveries').then(function(list){
      list=list||[];
      var head='<div class="ann-clickrow head"><span>Evento</span><span>Estado</span><span>HTTP</span><span>Fecha</span></div>';
      var rows=list.map(function(d){
        var st=d.status==='DELIVERED'?'<span class="chip st-AVAILABLE"><span class="dot"></span>Entregado</span>':'<span class="chip st-CANCELLED"><span class="dot"></span>Fallido</span>';
        var em=WH_EVENTS.filter(function(x){return x[0]===d.event;})[0];
        return '<div class="ann-clickrow"><span>'+esc(em?em[2]:d.event)+'</span><span>'+st+'</span><span class="mono2">'+(d.httpStatus!=null?d.httpStatus:'—')+'</span><span class="muted">'+esc(fmtDate(d.at))+'</span></div>';
      }).join('')||'<div class="empty" style="padding:16px">Todavía no hay entregas registradas.</div>';
      var body='<div class="card"><div class="b">'+head+rows+'</div></div>'
        +'<div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn" id="wd-close">Cerrar</button></div>';
      openModal('Entregas · '+esc(w.url),body,true);
      $("#wd-close").addEventListener("click",closeModal);
    }).catch(function(e){toast(e.message);});
  }
  function renderWhAccess(){
    var card=$("#wh-access-card"); if(!card)return;
    card.style.display='';
    $("#wh-access-sub").textContent='Operación: '+opName(op);
    api('/operations/'+encodeURIComponent(op)+'/webhook-clients').then(function(list){
      list=list||[];
      $("#wh-access-body").innerHTML=list.length?list.map(function(c){
        var on=!!c.webhooksClientEnabled;
        var estado=c.active===false?'<span class="chip st-CANCELLED"><span class="dot"></span>Inactivo</span>':'<span class="chip st-AVAILABLE"><span class="dot"></span>Activo</span>';
        var btn='<button class="mini'+(on?' danger':'')+'" data-whacc="'+esc(c.id)+'" data-on="'+(on?'1':'0')+'">'+(on?'Deshabilitar':'Habilitar')+'</button>';
        return '<tr><td class="sku">'+esc(c.name)+'</td><td>'+estado+'</td><td style="text-align:right"><span class="pill '+(on?'ok':'neutral')+'" style="margin-right:8px">'+(on?'Habilitado':'Deshabilitado')+'</span>'+btn+'</td></tr>';
      }).join(''):'<tr><td colspan="3" class="empty">Sin clientes en esta operación.</td></tr>';
      $$("#wh-access-body [data-whacc]").forEach(function(b){b.addEventListener("click",function(){
        var id=b.getAttribute("data-whacc"), enable=b.getAttribute("data-on")!=='1';
        api('/sellers/'+encodeURIComponent(id)+'/webhooks-access',{method:'PATCH',body:{enabled:enable}}).then(function(){toast(enable?'Panel habilitado para el cliente':'Panel deshabilitado');renderWhAccess();}).catch(function(e){toast(e.message);});
      });});
    }).catch(function(e){toast(e.message);});
  }

  function bars(el,rows,colorByChip){
    var max=Math.max.apply(null,rows.map(function(r){return r.v;}).concat([1]));
    el.innerHTML=rows.map(function(r){
      var cap=r.chip?('<span class="chip st-'+r.chip+'"><span class="dot"></span>'+esc(r.cap)+'</span>'):esc(r.cap);
      return '<div class="bar-row" data-tip="'+esc(r.cap)+': '+r.v+'"><div class="cap">'+cap+'</div><div class="bar-track"><div class="bar-fill"></div></div><div class="val mono">'+r.v+'</div></div>';
    }).join("");
    $$("#"+el.id+" .bar-row").forEach(function(row,i){var f=row.querySelector(".bar-fill");f.style.width=Math.max(3,Math.round(rows[i].v/max*100))+"%";if(rows[i].chip){var ch=row.querySelector(".chip");if(ch)f.style.background=getComputedStyle(ch).color;}});
    wireTips(el);
  }
  function renderZone(){
    var byZone={}; D.inv.forEach(function(b){var l=locById[b.locationId];var z=l?zoneName(l.zoneType):"—";byZone[z]=(byZone[z]||0)+b.qty;});
    var rows=Object.keys(byZone).map(function(z){return {cap:z,v:byZone[z]};}).filter(function(r){return r.v>0;}).sort(function(a,b){return b.v-a.v;});
    $("#zone-total").textContent=rows.reduce(function(a,r){return a+r.v;},0).toLocaleString("es-CL")+" un";
    bars($("#zone-chart"),rows);
  }
  function zoneName(zt){return {RECEIVING:"Recepción",STORAGE:"Almacenaje",PICKING:"Picking",SHIPPING:"Despacho",QUARANTINE:"Cuarentena"}[zt]||zt;}
  function renderOrderChart(){
    var order=["RECEIVED","ALLOCATED","PICKING","PICKED","PACKED","SHIPPED","CANCELLED"],c={};order.forEach(function(k){c[k]=0;});
    D.ord.forEach(function(o){c[o.status]=(c[o.status]||0)+1;});
    var rows=order.filter(function(k){return c[k]>0;}).map(function(k){return {cap:STN[k],v:c[k],chip:k};});
    bars($("#order-chart"),rows);
  }
  function renderActivity(){
    $("#activity").innerHTML=D.mov.slice(0,8).map(function(m){
      var sign=m.qtyDelta>0?'style="color:var(--good)"':'style="color:var(--crit)"';
      return '<tr><td><span class="chip st-'+(m.qtyDelta>0?'AVAILABLE':'RESERVED')+'"><span class="dot"></span>'+(LABELS[m.type]||m.type)+'</span></td><td class="sku">'+esc(m.sku)+'</td><td><span class="loc-chip">'+esc(code(m.locationId))+'</span></td><td>'+esc(m.actor)+'</td><td class="num" '+sign+'>'+(m.qtyDelta>0?"+":"")+m.qtyDelta+'</td></tr>';
    }).join("")||'<tr><td colspan="5" class="empty">Sin movimientos.</td></tr>';
  }

  // ---- Movimientos (kardex) -------------------------------------------------
  var ESTADO_LABEL={AVAILABLE:"Disponible",RESERVED:"Reservado",QUARANTINE:"Cuarentena",DAMAGED:"Dañado",IN_TRANSIT:"En tránsito"};
  var MV_TYPES=["RECEIPT","PUTAWAY","TRANSFER","RESERVE","RELEASE","PICK","SHIP","ADJUSTMENT"];
  var mvInit=false, mvLast=[], mvF={sku:"",type:"",loc:"",user:"",cli:"",ref:"",from:"",to:""};
  function fillSel(el,allLabel,opts,cur){el.innerHTML='<option value="">'+esc(allLabel)+'</option>'+opts.map(function(o){return '<option value="'+esc(o.v)+'">'+esc(o.t)+'</option>';}).join("");el.value=cur||"";}
  function setupMovements(){
    if(mvInit)return; mvInit=true;
    ["mv-sku","mv-type","mv-loc","mv-user","mv-cli","mv-ref","mv-from","mv-to"].forEach(function(id){var el=$("#"+id);if(el){el.addEventListener("input",readMvFilters);el.addEventListener("change",readMvFilters);}});
    $("#mv-clear").addEventListener("click",function(){mvF={sku:"",type:"",loc:"",user:"",cli:"",ref:"",from:"",to:""};["mv-sku","mv-type","mv-loc","mv-user","mv-cli","mv-ref","mv-from","mv-to"].forEach(function(id){$("#"+id).value="";});renderMvTable();});
    $("#mv-export").addEventListener("click",exportMovements);
  }
  function readMvFilters(){mvF.sku=$("#mv-sku").value.trim().toLowerCase();mvF.type=$("#mv-type").value;mvF.loc=$("#mv-loc").value;mvF.user=$("#mv-user").value;mvF.cli=$("#mv-cli").value;mvF.ref=$("#mv-ref").value.trim().toLowerCase();mvF.from=$("#mv-from").value;mvF.to=$("#mv-to").value;renderMvTable();}
  function dayOf(iso){return String(iso||"").slice(0,10);}
  function sellerName(id){for(var i=0;i<D.sellers.length;i++){if(D.sellers[i].id===id)return D.sellers[i].name;}return id;}
  function renderMovements(){
    if(!$("#mv-body"))return;
    setupMovements();
    var isClient=role==="CLIENT";
    $("#mv-cli-field").classList.toggle("hidden",isClient);
    $("#mv-table").classList.toggle("hide-cli",isClient);
    var locs=(D.locations||[]).slice().sort(function(a,b){return a.code<b.code?-1:1;}).map(function(l){return {v:l.id,t:l.code};});
    var seen={}; (D.kardex||[]).forEach(function(m){seen[m.actor]=1;});
    var users=Object.keys(seen).sort().map(function(a){return {v:a,t:a};});
    var sellers=(D.sellers||[]).map(function(s){return {v:s.id,t:s.name};});
    var seenT={}; (D.kardex||[]).forEach(function(m){seenT[m.type]=1;});
    var types=MV_TYPES.filter(function(t){return seenT[t];}).map(function(t){return {v:t,t:LABELS[t]||t};});
    fillSel($("#mv-type"),"Todos",types,mvF.type);
    fillSel($("#mv-loc"),"Todas",locs,mvF.loc);
    fillSel($("#mv-user"),"Todos",users,mvF.user);
    fillSel($("#mv-cli"),"Todos",sellers,mvF.cli);
    renderMvTable();
  }
  function mvFiltered(){
    var isClient=role==="CLIENT";
    return (D.kardex||[]).filter(function(m){
      if(isClient && m.sellerId!==me.sellerId) return false;
      if(mvF.sku && String(m.sku).toLowerCase().indexOf(mvF.sku)<0) return false;
      if(mvF.type && m.type!==mvF.type) return false;
      if(mvF.loc && m.locationId!==mvF.loc) return false;
      if(mvF.user && m.actor!==mvF.user) return false;
      if(mvF.cli && m.sellerId!==mvF.cli) return false;
      if(mvF.ref && String(m.reference||"").toLowerCase().indexOf(mvF.ref)<0) return false;
      if(mvF.from && dayOf(m.occurredAt) < mvF.from) return false;
      if(mvF.to && dayOf(m.occurredAt) > mvF.to) return false;
      return true;
    });
  }
  function mvRow(m){
    var sign=m.qtyDelta>0?'style="color:var(--good)"':'style="color:var(--crit)"';
    var mvCls=m.qtyDelta>0?'st-AVAILABLE':'st-RESERVED';
    var stTag=(m.state==="AVAILABLE"||m.state==="RESERVED")
      ? '<span class="chip st-'+esc(m.state)+'"><span class="dot"></span>'+esc(ESTADO_LABEL[m.state]||m.state)+'</span>'
      : '<span class="loc-chip">'+esc(ESTADO_LABEL[m.state]||m.state)+'</span>';
    return '<tr>'+
      '<td class="muted" style="white-space:nowrap">'+esc(fmtDate(m.occurredAt))+'</td>'+
      '<td><span class="chip '+mvCls+'"><span class="dot"></span>'+esc(LABELS[m.type]||m.type)+'</span></td>'+
      '<td class="sku">'+esc(m.sku)+'</td>'+
      '<td><span class="loc-chip">'+esc(code(m.locationId))+'</span></td>'+
      '<td>'+esc(m.lot||"—")+'</td>'+
      '<td>'+stTag+'</td>'+
      '<td>'+esc(m.actor)+'</td>'+
      '<td class="mv-col-cli">'+esc(sellerName(m.sellerId))+'</td>'+
      '<td class="muted">'+esc(m.reference||"—")+'</td>'+
      '<td class="num" '+sign+'>'+(m.qtyDelta>0?"+":"")+m.qtyDelta+'</td>'+
    '</tr>';
  }
  function renderMvTable(){
    mvLast=mvFiltered();
    $("#mv-count").textContent=mvLast.length+" movimiento"+(mvLast.length===1?"":"s");
    $("#mv-body").innerHTML=mvLast.length?mvLast.slice(0,500).map(mvRow).join(""):'<tr><td colspan="10" class="empty">Sin movimientos para el filtro seleccionado.</td></tr>';
  }
  function downloadXlsx(path,filename,okMsg){
    if(!seller){toast("Selecciona un cliente primero");return;}
    var h={}; if(token)h['Authorization']='Bearer '+token;
    fetch(API+'/sellers/'+seller+path,{headers:h})
      .then(function(r){if(!r.ok)throw new Error('No se pudo exportar ('+r.status+').');return r.blob();})
      .then(function(b){var u=URL.createObjectURL(b);var a=document.createElement('a');a.href=u;a.download=filename;document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(function(){URL.revokeObjectURL(u);},1500);toast(okMsg);})
      .catch(function(e){toast(e.message);});
  }
  function exportMovements(){ downloadXlsx('/movements/export','kardex-movimientos-ninjawms.xlsx',"Kardex exportado"); }
  function exportOrders(){ downloadXlsx('/orders/export','ordenes-ninjawms.xlsx',"Órdenes exportadas"); }

  // ----- Exportación GENÉRICA a Excel de cualquier tabla del portal -----
  // Lee la tabla tal como se muestra (sin la columna de acciones) y baja un .xlsx.
  function tableToAoa(table){
    var thead=table.querySelector("thead"); var ths=thead?Array.prototype.slice.call(thead.querySelectorAll("th")):[];
    // columnas a conservar: descarta la de acciones (data-action) y las de encabezado vacío.
    var keep=[]; var header=[];
    ths.forEach(function(th,i){
      if(th.hasAttribute("data-action"))return;
      var t=(th.textContent||"").trim();
      if(!t && th.querySelector("*")===null)return; // th realmente vacío
      keep.push(i); header.push(t||("Col"+(i+1)));
    });
    if(!keep.length){ // tabla sin thead reconocible: usa todas las columnas de la primera fila
      var first=table.querySelector("tbody tr");
      if(first){var n=first.children.length;for(var k=0;k<n;k++){keep.push(k);header.push("Col"+(k+1));}}
    }
    var aoa=[header];
    var body=table.querySelector("tbody")||table;
    Array.prototype.slice.call(body.querySelectorAll("tr")).forEach(function(tr){
      if(tr.querySelector(".empty"))return; // fila de estado vacío
      var tds=tr.children; if(!tds||!tds.length)return;
      var row=keep.map(function(idx){
        var cell=tds[idx]; if(!cell)return "";
        var txt=(cell.textContent||"").replace(/\s+/g," ").trim();
        // Entero/decimal en formato es-CL (miles con punto, decimal con coma) -> número real.
        if(/^-?[\d.]+(,\d+)?$/.test(txt)&&/\d/.test(txt)){
          var n=parseFloat(txt.replace(/\./g,"").replace(/,/g,"."));
          if(!isNaN(n))return n;
        }
        return txt;
      });
      aoa.push(row);
    });
    return aoa;
  }
  function tableToXlsx(table,filename,sheet){
    if(!table){toast("No hay tabla para exportar");return;}
    if(typeof XLSX==="undefined"){toast("No se pudo cargar el exportador");return;}
    var aoa=tableToAoa(table);
    if(aoa.length<=1){toast("La tabla no tiene datos para exportar");return;}
    var wb=XLSX.utils.book_new();
    var ws=XLSX.utils.aoa_to_sheet(aoa);
    ws["!cols"]=aoa[0].map(function(h,i){var w=h.length;aoa.forEach(function(r){var v=r[i]==null?"":String(r[i]);if(v.length>w)w=v.length;});return {wch:Math.min(48,Math.max(10,w+2))};});
    XLSX.utils.book_append_sheet(wb,ws,(sheet||"Datos").slice(0,31));
    var buf=XLSX.write(wb,{type:"array",bookType:"xlsx"});
    var blob=new Blob([buf],{type:"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"});
    var u=URL.createObjectURL(blob);var a=document.createElement("a");a.href=u;a.download=filename||"export.xlsx";document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(function(){URL.revokeObjectURL(u);},1500);
    toast("Exportado a Excel");
  }
  // Inyecta un botón "⤓ Excel" sobre cada tabla del portal (una sola vez).
  // Salta las tablas que ya tienen exportación dedicada .xlsx (órdenes, kardex, productos).
  function injectTableExporters(){
    var SKIP={"ord-body":1,"mv-body":1,"pr-body":1,"inv-body":1}; // ya tienen su propio botón de exportación
    Array.prototype.slice.call(document.querySelectorAll(".page table")).forEach(function(table){
      var tb=table.querySelector("tbody"); if(!tb||!tb.id)return;
      if(SKIP[tb.id])return;
      if(table.getAttribute("data-xexp"))return; // ya inyectado
      table.setAttribute("data-xexp","1");
      var sec=table.closest(".page"); var pg=sec?sec.getAttribute("data-pg"):"datos";
      var titleArr=(typeof TITLES!=="undefined"&&TITLES[pg])?TITLES[pg]:null;
      var label=titleArr?titleArr[0]:pg;
      var bar=document.createElement("div"); bar.className="tbl-exp-bar"; bar.style.cssText="display:flex;justify-content:flex-end;margin:0 0 8px";
      var btn=document.createElement("button"); btn.className="btn"; btn.type="button"; btn.textContent="⤓ Excel"; btn.style.cssText="font-size:12px;padding:6px 12px";
      btn.addEventListener("click",function(){
        var fn=("ninjawms-"+String(label).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/(^-|-$)/g,""))+".xlsx";
        tableToXlsx(table,fn,label);
      });
      bar.appendChild(btn);
      // Inserta la barra justo antes del contenedor de la tabla (.tablewrap si existe).
      var wrap=table.closest(".tablewrap")||table;
      wrap.parentNode.insertBefore(bar,wrap);
    });
  }

  // ----- Reserva de stock MASIVA (varias órdenes de una vez) -----
  function openReserveMasiva(){
    if(!seller){toast("Selecciona un cliente primero");return;}
    var pend=(D.ord||[]).filter(function(o){return o.status==="RECEIVED";});
    if(!pend.length){toast("No hay órdenes ingresadas pendientes de reservar");return;}
    var html='<div class="form">'
      +'<p class="muted" style="margin:0 0 4px">Se intentará reservar el stock de las <b>'+pend.length+'</b> orden(es) en estado <b>Ingresada</b>. '
      +'Cada orden se reserva de forma independiente: si a alguna le falta stock, se omite y las demás igual se reservan.</p>'
      +'<div class="ferr" id="rm-err"></div>'
      +'<div class="acts"><span class="hint">'+pend.length+' orden(es) por reservar</span>'
      +'<div style="display:flex;gap:10px"><button class="btn" id="rm-cancel">Cancelar</button><button class="btn pri" id="rm-go">Reservar '+pend.length+' órdenes</button></div></div>'
      +'</div>';
    openModal("Reserva de stock masiva",html);
    $("#rm-cancel").addEventListener("click",closeModal);
    $("#rm-go").addEventListener("click",function(){
      var btn=$("#rm-go"); btn.disabled=true; btn.textContent="Reservando…";
      api('/sellers/'+seller+'/orders/allocate-all',{method:'POST',body:{}})
        .then(function(r){renderReserveMasivaResult(r);loadSeller();})
        .catch(function(e){btn.disabled=false;btn.textContent="Reservar";$("#rm-err").textContent=e.message;});
    });
  }
  var rmFailed=[];
  function renderReserveMasivaResult(r){
    rmFailed=r.failed||[];
    var failRows=rmFailed.map(function(f,i){
      var motivo=(f.faltantes&&f.faltantes.length)
        ? ('Falta stock de '+f.faltantes.length+' producto(s) · <a href="#" class="rm-det" data-i="'+i+'">ver detalle</a>')
        : esc(f.motivo);
      return '<tr><td class="sku">'+esc(f.orden)+'</td><td style="color:var(--crit)">'+motivo+'</td></tr>';
    }).join("");
    var html='<div class="form">'
      +'<div class="pk-sum" style="display:flex;gap:18px;margin:0 0 8px">'
      +'<div><div class="muted" style="font-size:12px">Reservadas</div><div style="font-size:22px;font-weight:800;color:var(--good)">'+(r.reservadas||0)+'</div></div>'
      +'<div><div class="muted" style="font-size:12px">Sin stock / omitidas</div><div style="font-size:22px;font-weight:800;color:'+((r.conError||0)>0?'var(--crit)':'var(--ink)')+'">'+(r.conError||0)+'</div></div>'
      +'<div><div class="muted" style="font-size:12px">Solicitadas</div><div style="font-size:22px;font-weight:800">'+(r.solicitadas||0)+'</div></div>'
      +'</div>'
      +(failRows?'<p class="muted" style="margin:6px 0 4px">Órdenes que no se pudieron reservar:</p><div class="tablewrap"><table><thead><tr><th>Orden</th><th>Motivo</th></tr></thead><tbody>'+failRows+'</tbody></table></div>':'<p class="muted" style="margin:0">Todas las órdenes se reservaron correctamente. ✅</p>')
      +'<div class="acts" style="margin-top:8px"><span class="hint"></span><button class="btn pri" id="rm-close">Cerrar</button></div>'
      +'</div>';
    openModal("Resultado · reserva masiva",html,true);
    $("#rm-close").addEventListener("click",closeModal);
    $$("#m-body .rm-det").forEach(function(a){a.addEventListener("click",function(ev){
      ev.preventDefault();
      var f=rmFailed[parseInt(a.getAttribute("data-i"),10)];
      showStockShortage({data:{orden:f.orden,faltantes:f.faltantes}},f.orden);
    });});
    toast((r.reservadas||0)+" orden(es) reservada(s)");
  }

  var invView="consolidated"; // vista activa del staff: "consolidated" | "detail"
  function skuDesc(sku){for(var i=0;i<D.skus.length;i++){if(D.skus[i].sku===sku)return D.skus[i].description||"";}return "";}
  function renderInvViews(){
    var el=$("#inv-views");if(!el)return;
    var isClient=role==="CLIENT";
    el.classList.toggle("hidden",isClient);
    if(isClient){el.innerHTML="";return;}
    var views=[["consolidated","Consolidado por SKU"],["detail","Detalle por ubicación"]];
    el.innerHTML=views.map(function(v){return '<button class="fchip '+(invView===v[0]?"on":"")+'" data-v="'+v[0]+'">'+v[1]+'</button>';}).join("");
    $$("#inv-views .fchip").forEach(function(b){b.addEventListener("click",function(){invView=b.getAttribute("data-v");renderInvViews();renderInv();});});
  }
  function invGroup(rows,keyFn){
    var map={},order=[];
    rows.forEach(function(b){
      var k=keyFn(b);
      if(!map[k]){map[k]={sku:b.sku,lot:b.lot||"",avail:0,reserved:0,total:0};order.push(k);}
      var g=map[k];
      if(b.state==="AVAILABLE")g.avail+=b.qty;
      else if(b.state==="RESERVED")g.reserved+=b.qty;
      g.total+=b.qty;
    });
    return order.map(function(k){return map[k];});
  }
  function renderInv(){
    renderInvViews();
    var q=($("#inv-q").value||"").toLowerCase();
    var isClient=role==="CLIENT";
    var view=isClient?"client":invView;
    var head=$("#inv-head"),body=$("#inv-body"),cnt=$("#inv-count");

    if(view==="detail"){
      head.innerHTML='<tr><th>SKU</th><th>Descripción</th><th>Ubicación</th><th>Lote</th><th>Estado</th><th style="text-align:right">Cantidad</th><th data-action></th></tr>';
      var rows=D.inv.filter(function(b){return !q||b.sku.toLowerCase().indexOf(q)>=0||code(b.locationId).toLowerCase().indexOf(q)>=0;})
        .sort(function(a,b){return a.sku<b.sku?-1:a.sku>b.sku?1:0;});
      cnt.textContent=rows.length+" registros · "+rows.reduce(function(a,b){return a+b.qty;},0)+" unidades";
      body.innerHTML=rows.length?rows.map(function(b){
        var low=b.state==="AVAILABLE"&&b.qty<15;
        return '<tr><td class="sku">'+esc(b.sku)+'</td><td class="muted">'+esc(skuDesc(b.sku)||'—')+'</td><td><span class="loc-chip">'+esc(code(b.locationId))+'</span></td><td class="mono2">'+(b.lot?esc(b.lot):'—')+'</td><td><span class="chip st-'+b.state+'"><span class="dot"></span>'+(b.state==="AVAILABLE"?"Disponible":b.state==="RESERVED"?"Reservado":b.state)+'</span></td><td class="num '+(low?'warnrow':'')+'">'+b.qty+(low?' ⚠':'')+'</td><td></td></tr>';
      }).join(""):'<tr><td colspan="7" class="empty">Sin resultados.</td></tr>';
      return;
    }

    // Vistas consolidadas (staff por SKU / cliente por SKU+lote): filtran solo por SKU o descripción, nunca por ubicación.
    var base=D.inv.filter(function(b){return !q||b.sku.toLowerCase().indexOf(q)>=0||skuDesc(b.sku).toLowerCase().indexOf(q)>=0;});
    var groups;
    if(isClient){
      groups=invGroup(base,function(b){return b.sku+"||"+(b.lot||"");});
      head.innerHTML='<tr><th>SKU</th><th>Descripción</th><th>Lote/Serie</th><th style="text-align:right">Disponible</th><th style="text-align:right">Reservado</th><th style="text-align:right">Total</th></tr>';
    }else{
      groups=invGroup(base,function(b){return b.sku;});
      head.innerHTML='<tr><th>SKU</th><th>Descripción</th><th style="text-align:right">Disponible</th><th style="text-align:right">Reservado</th><th style="text-align:right">Total</th></tr>';
    }
    groups.sort(function(a,b){return a.sku<b.sku?-1:a.sku>b.sku?1:a.lot<b.lot?-1:a.lot>b.lot?1:0;});
    var units=groups.reduce(function(a,g){return a+g.total;},0);
    cnt.textContent=(isClient?groups.length+" ítems · ":groups.length+" SKUs · ")+units+" unidades";
    var cols=isClient?6:5;
    body.innerHTML=groups.length?groups.map(function(g){
      var low=g.avail<15;
      var lotCell=isClient?'<td class="mono2">'+(g.lot?esc(g.lot):'—')+'</td>':'';
      return '<tr><td class="sku">'+esc(g.sku)+'</td><td class="muted">'+esc(skuDesc(g.sku)||'—')+'</td>'+lotCell
        +'<td class="num '+(low?'warnrow':'')+'"><span class="chip st-AVAILABLE"><span class="dot"></span>'+g.avail+'</span></td>'
        +'<td class="num"><span class="chip st-RESERVED"><span class="dot"></span>'+g.reserved+'</span></td>'
        +'<td class="num">'+g.total+'</td></tr>';
    }).join(""):'<tr><td colspan="'+cols+'" class="empty">Sin resultados.</td></tr>';
  }
  $("#inv-q").addEventListener("input",renderInv);
  if($("#loc-q"))$("#loc-q").addEventListener("input",function(){locQ=this.value;renderLocations();});
  if($("#loc-zone"))$("#loc-zone").addEventListener("change",function(){locZone=this.value;renderLocations();});
  $$("#loc-view .vt").forEach(function(b){b.addEventListener("click",function(){
    locView=b.getAttribute("data-view");
    try{ localStorage.setItem(LOC_VIEW_KEY,locView); }catch(e){}
    renderLocations();
  });});

  /**
   * Nivel de deadline de una orden PARA FILTRAR.
   *
   * Despachada o cancelada ya no compromete nada: su deadline dejó de correr y no
   * debe engrosar los contadores de vencidas ni de riesgo (si no, la pestaña
   * "Vencidas" se llenaría de histórico y dejaría de servir como bandeja de trabajo).
   */
  function dlNivelOrden(o){
    if(!o||o.status==='SHIPPED'||o.status==='CANCELLED')return 'sin';
    return dlState(o.dueAt).level;
  }
  /** ¿Esta orden entra en la pestaña activa? Estados del ciclo + las dos de deadline. */
  function ordEnFiltro(o){
    if(ordFilter==='DL_VENCIDO')return dlNivelOrden(o)==='vencido';
    if(ordFilter==='DL_RIESGO'){var l=dlNivelOrden(o);return l==='critico'||l==='riesgo';}
    return ordFilter==='ALL'||o.status===ordFilter;
  }
  function renderOrdFilters(){
    var states=["ALL","RECEIVED","ALLOCATED","PICKING","PICKED","PACKED","SHIPPED","CANCELLED"];
    // Contador por estado: cuántas órdenes hay en cada etapa del ciclo de vida, para ver
    // la carga de trabajo sin tener que abrir cada filtro. Se recalcula en cada refresco.
    var counts={ALL:(D.ord||[]).length};
    var venc=0,riesgo=0;
    (D.ord||[]).forEach(function(o){
      counts[o.status]=(counts[o.status]||0)+1;
      var l=dlNivelOrden(o);
      if(l==='vencido')venc++; else if(l==='critico'||l==='riesgo')riesgo++;
    });
    var chip=function(k,label,n,extra){
      return '<button class="fchip '+(extra||"")+' '+(ordFilter===k?"on":"")+(n?"":" zero")+'" data-f="'+k+'">'+label+'<span class="fcount">'+n+'</span></button>';
    };
    var html=states.map(function(s){return chip(s,(s==="ALL"?"Todas":STN[s]),counts[s]||0);}).join("");
    // Las dos bandejas por compromiso de salida, al final y separadas de los estados.
    html+=chip('DL_VENCIDO','⏰ Vencidas',venc,'dl-v dlsep')+chip('DL_RIESGO','⚠️ En riesgo',riesgo,'dl-r');
    $("#ord-filters").innerHTML=html;
    $$("#ord-filters .fchip").forEach(function(b){b.addEventListener("click",function(){
      ordFilter=b.getAttribute("data-f");
      // Entrar a una bandeja de deadline la ordena por urgencia (la tabla trae por
      // defecto "más reciente primero", que aquí no dice nada). Después el usuario
      // puede reordenar por la columna que quiera, como en cualquier otra pestaña.
      if(ordFilter==='DL_VENCIDO'||ordFilter==='DL_RIESGO')setSort('orders','deadline',1);
      renderOrdFilters();renderOrders();
    });});
  }
  function renderInbFilters(){
    if(!$("#inb-filters"))return;
    var states=["ALL","PENDING","PARTIAL","RECEIVED","CANCELLED"];
    $("#inb-filters").innerHTML=states.map(function(s){return '<button class="fchip '+(inbFilter===s?"on":"")+'" data-f="'+s+'">'+(s==="ALL"?"Todas":REC_STL[s])+'</button>';}).join("");
    $$("#inb-filters .fchip").forEach(function(b){b.addEventListener("click",function(){inbFilter=b.getAttribute("data-f");renderInbound();});});
  }
  function renderOrders(){
    var os=D.ord.filter(ordEnFiltro);
    os=sortRows('orders',os,ORD_COLS);
    var canOrder=can('order');
    $("#ord-body").innerHTML=os.length?os.map(function(o){
      var q=o.lines.reduce(function(a,l){return a+l.qty;},0);
      // Cancelar devuelve la mercadería a la bodega, así que también se puede cancelar
      // reservada, en picking, pickeada y empacada. Despachada no: ya salió (devolución).
      var canCancel=can('cancel')&&["SHIPPED","CANCELLED"].indexOf(o.status)<0;
      var canReactivate=can('cancel')&&o.status==="CANCELLED";
      var isNew=o.status==="RECEIVED";
      var editable=o.status==="RECEIVED"||o.status==="ALLOCATED";   // reservada también se puede editar
      var canFulfill=can('fulfill');
      var acts='<div class="rowacts">'
        +(canOrder&&editable?'<button class="mini" data-oedit="'+o.id+'">Editar</button>':'')
        +(canFulfill&&isNew?'<button class="mini" data-oalloc="'+o.id+'">Reservar</button>':'')
        +(canFulfill&&o.status==="ALLOCATED"?'<button class="mini" data-ostart="'+o.id+'">A picking</button>':'')
        +(canFulfill&&o.status==="PICKING"?'<button class="mini" data-opick="'+o.id+'">Continuar picking</button>':'')
        +(canFulfill&&o.status==="PICKED"?'<button class="mini pri" data-opack="'+o.id+'">Empacar</button>':'')
        +(canFulfill&&o.status==="PACKED"?'<button class="mini" data-olabels="'+o.id+'">Etiquetas</button>':'')
        +(canFulfill&&o.status==="PACKED"?'<button class="mini" data-oship="'+o.id+'">Despachar</button>':'')
        +(canCancel?'<button class="mini danger" data-cancel="'+o.id+'">Cancelar</button>':'')
        +(canReactivate?'<button class="mini pri" data-react="'+o.id+'">Reactivar</button>':'')
        +'</div>';
      var selCell=bulkEnabled()?'<td class="selcol"><input type="checkbox" class="bulk-ck" data-bk="'+o.id+'" '+(bulkSel[o.id]?'checked':'')+' aria-label="Seleccionar orden"></td>':'';
      return '<tr class="click'+(bulkSel[o.id]?' selected':'')+'" data-o="'+o.id+'">'+selCell+'<td class="mono2">'+esc(o.externalOrderId||o.id.slice(0,8))+'</td><td class="muted" style="white-space:nowrap">'+esc(fmtDate(o.createdAt))+'</td><td style="white-space:nowrap">'+dlChip(o)+'</td><td>'+esc(CH_LABEL[o.salesChannel]||o.salesChannel)+'</td><td>'+esc((o.orderType||"").toUpperCase())+'</td><td>'+o.lines.length+' línea(s) · '+q+' un</td><td><span class="chip st-'+o.status+'"><span class="dot"></span>'+STN[o.status]+'</span></td><td style="text-align:right">'+acts+'</td></tr>';
    }).join(""):'<tr><td colspan="'+(bulkEnabled()?9:8)+'" class="empty">'+(ordFilter==='DL_VENCIDO'?'Ninguna orden pendiente pasó su deadline. 🎉':ordFilter==='DL_RIESGO'?'Ninguna orden pendiente está cerca de su deadline.':'Sin órdenes en este estado.')+'</td></tr>';
    var selTh=$("#ord-selall"); if(selTh)selTh.closest('th').classList.toggle('hidden',!bulkEnabled());
    var selM=$("#ord-selall-m"); if(selM)selM.classList.toggle('hidden',!bulkEnabled()||!os.length);
    syncBulkHeader(os); paintBulkBar();
    $$("#ord-body tr.click").forEach(function(tr){tr.addEventListener("click",function(e){if(e.target.closest("[data-cancel],[data-react],[data-oedit],[data-oalloc],[data-ostart],[data-opick],[data-opack],[data-olabels],[data-oship],.selcol"))return;openOrder(D.ord.filter(function(o){return o.id===tr.getAttribute("data-o");})[0]);});});
    $$("#ord-body .bulk-ck").forEach(function(ck){ck.addEventListener("change",function(){ if(ck.checked)bulkSel[ck.getAttribute("data-bk")]=true; else delete bulkSel[ck.getAttribute("data-bk")]; ck.closest("tr").classList.toggle("selected",ck.checked); paintBulkBar(); syncBulkHeader(os); });});
    $$("#ord-body [data-cancel]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();cancelOrder(b.getAttribute("data-cancel"));});});
    $$("#ord-body [data-react]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();reactivateOrder(b.getAttribute("data-react"));});});
    $$("#ord-body [data-oedit]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();openOrderForm(byId(D.ord,b.getAttribute("data-oedit")));});});
    $$("#ord-body [data-oalloc]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();var id=b.getAttribute("data-oalloc");openConfirm("Reservar stock","Se reservará el stock para esta orden (pasa a RESERVADA).",function(){api('/sellers/'+seller+'/orders/'+id+'/allocate',{method:'POST'}).then(function(){toast("Orden reservada");return loadSeller();}).catch(function(e){reserveError(e,(byId(D.ord,id)||{}).externalOrderId);});});});});
    $$("#ord-body [data-ostart]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();var id=b.getAttribute("data-ostart");api('/sellers/'+seller+'/orders/'+id+'/start-picking',{method:'POST'}).then(function(){toast("Orden en picking");return loadSeller();}).catch(function(e){toast(e.message);});});});
    $$("#ord-body [data-opick]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();pqFlow=false;openPickForm(byId(D.ord,b.getAttribute("data-opick")));});});
    $$("#ord-body [data-opack]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();openPackForm(byId(D.ord,b.getAttribute("data-opack")));});});
    $$("#ord-body [data-olabels]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();openLabels(byId(D.ord,b.getAttribute("data-olabels")));});});
    $$("#ord-body [data-oship]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();openShipForm(byId(D.ord,b.getAttribute("data-oship")));});});
    paintSort('orders');
  }

  // ===== Acciones masivas sobre órdenes (admin/supervisor) =====
  // Selección con casillas + barra flotante: la acción elegida se aplica orden por orden
  // (mismos endpoints que las acciones individuales); las que no están en el estado
  // correcto se omiten y al final se informa el resultado. La selección sobrevive a los
  // refrescos automáticos de la tabla.
  var bulkSel={};
  function bulkEnabled(){ return (role==='ADMIN'||role==='SUPERVISOR'||role==='PLATFORM_ADMIN') && can('fulfill') && !!seller; }
  var BULK_ACTIONS=[
    {k:'allocate', label:'Reservar stock',       from:['RECEIVED'],  to:'Reservada',   ep:function(id){return api('/sellers/'+seller+'/orders/'+id+'/allocate',{method:'POST'});}},
    {k:'start',    label:'Pasar a picking',      from:['ALLOCATED'], to:'En picking',  ep:function(id){return api('/sellers/'+seller+'/orders/'+id+'/start-picking',{method:'POST'});}},
    {k:'pick',     label:'Confirmar picking completo', from:['PICKING','ALLOCATED'], to:'Pickeada', ep:function(id){return api('/sellers/'+seller+'/orders/'+id+'/pick',{method:'POST'});}},
    {k:'pack',     label:'Empacar (1 bulto)',    from:['PICKED'],    to:'Empacada',    ep:function(id){return api('/sellers/'+seller+'/orders/'+id+'/pack',{method:'POST',body:{bultos:1}});}},
    {k:'ship',     label:'Despachar',            from:['PACKED'],    to:'Despachada',  needsCarrier:true, ep:function(id,o,x){return api('/sellers/'+seller+'/orders/'+id+'/ship',{method:'POST',body:{carrier:(o.carrier||x.carrier||undefined)}});}},
    {k:'cancel',   label:'Cancelar',             from:['RECEIVED','ALLOCATED','PICKING'], to:'Cancelada', danger:true, ep:function(id){return api('/sellers/'+seller+'/orders/'+id+'/cancel',{method:'POST'});}},
    {k:'react',    label:'Reactivar',            from:['CANCELLED'], to:'Ingresada',   ep:function(id){return api('/sellers/'+seller+'/orders/'+id+'/reactivate',{method:'POST'});}}
  ];
  function bulkSelected(){ return (D.ord||[]).filter(function(o){return bulkSel[o.id];}); }
  function syncBulkHeader(visible){
    var h=$("#ord-selall"); if(!h)return;
    var vis=(visible||[]).length, n=(visible||[]).filter(function(o){return bulkSel[o.id];}).length;
    h.checked=vis>0&&n===vis; h.indeterminate=n>0&&n<vis;
  }
  function paintBulkBar(){
    var bar=$("#bulk-bar"); if(!bar)return;
    var sel=bulkSelected();
    if(!bulkEnabled()||!sel.length){ bar.classList.add('hidden'); return; }
    bar.classList.remove('hidden');
    $("#bulk-count").textContent=sel.length+' orden'+(sel.length===1?'':'es')+' seleccionada'+(sel.length===1?'':'s');
    var opts=BULK_ACTIONS.map(function(a){ var n=sel.filter(function(o){return a.from.indexOf(o.status)>=0;}).length; return {a:a,n:n}; }).filter(function(x){return x.n>0;});
    var selEl=$("#bulk-action"), cur=selEl.value;
    selEl.innerHTML='<option value="">Cambiar estado a…</option>'+opts.map(function(x){return '<option value="'+x.a.k+'">'+esc(x.a.label)+' → '+esc(x.a.to)+' ('+x.n+')</option>';}).join('');
    if(opts.some(function(x){return x.a.k===cur;}))selEl.value=cur;
    $("#bulk-apply").disabled=!selEl.value;
  }
  function bulkClear(){ bulkSel={}; renderOrders(); paintBulkBar(); }
  function bulkApply(){
    var k=$("#bulk-action").value; var a=BULK_ACTIONS.filter(function(x){return x.k===k;})[0]; if(!a)return;
    var sel=bulkSelected(); var apply=sel.filter(function(o){return a.from.indexOf(o.status)>=0;}); var skip=sel.length-apply.length;
    if(!apply.length){toast('Ninguna de las órdenes seleccionadas está en un estado válido para esta acción');return;}
    var noCarrier=a.needsCarrier?apply.filter(function(o){return !o.carrier;}).length:0;
    var html='<p class="muted" style="margin:0 0 10px">Se aplicará <b>'+esc(a.label)+'</b> a <b>'+apply.length+'</b> orden(es)'+(skip?', y se omitirán <b>'+skip+'</b> que no están en el estado requerido ('+a.from.map(function(st){return STN[st]||st;}).join(' / ')+')':'')+'.</p>'
      +'<p class="muted" style="margin:0 0 12px;font-size:12.5px">Cada orden se procesa por separado: si alguna falla (por ejemplo, sin stock para reservar), las demás igual se actualizan.</p>'
      +(a.needsCarrier?'<div class="fld"><label>Courier'+(noCarrier?' (para las '+noCarrier+' sin courier definido)':' (opcional, solo si la orden no tiene uno)')+'</label><input id="bulk-carrier" placeholder="Ej: Chilexpress, Blue Express"></div>':'')
      +'<div id="bulk-prog" class="muted" style="margin:8px 0 0;font-size:12.5px"></div>'
      +'<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px"><button class="btn" id="m-no">Cancelar</button><button class="btn '+(a.danger?'danger':'pri')+'" id="m-yes">Aplicar a '+apply.length+'</button></div>';
    openModal('Cambio de estado masivo',html);
    $("#m-no").addEventListener('click',closeModal);
    $("#m-yes").addEventListener('click',function(){
      var extra={carrier:($("#bulk-carrier")&&$("#bulk-carrier").value.trim())||''};
      $("#m-yes").disabled=true; $("#m-no").disabled=true;
      var ok=0, fail=[], i=0, prog=$("#bulk-prog");
      (function next(){
        if(i>=apply.length){
          closeModal(); bulkSel={};
          loadSeller().then(function(){ paintBulkBar(); });
          var msg=a.label+': '+ok+' ok'+(skip?' · '+skip+' omitida(s)':'')+(fail.length?' · '+fail.length+' con error':'');
          if(fail.length){ openModal('Resultado del cambio masivo','<p class="muted" style="margin:0 0 10px">'+esc(msg)+'</p><div style="max-height:40vh;overflow:auto">'+fail.map(function(f){return '<div class="kv"><span>'+esc(f.ref)+'</span><b style="color:var(--crit)">'+esc(f.err)+'</b></div>';}).join('')+'</div><div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn pri" id="m-ok">Cerrar</button></div>'); $("#m-ok").addEventListener('click',closeModal); }
          else toast(msg);
          return;
        }
        var o=apply[i++]; if(prog)prog.textContent='Procesando '+i+' de '+apply.length+'… ('+(o.externalOrderId||o.id.slice(0,8))+')';
        a.ep(o.id,o,extra).then(function(){ok++;}).catch(function(e){fail.push({ref:o.externalOrderId||o.id.slice(0,8),err:e.message||'error'});}).then(next);
      })();
    });
  }
  (function bindBulk(){
    var h=$("#ord-selall"); if(h)h.addEventListener('change',function(){ var vis=D.ord.filter(ordEnFiltro); vis.forEach(function(o){ if(h.checked)bulkSel[o.id]=true; else delete bulkSel[o.id]; }); renderOrders(); paintBulkBar(); });
    var sa=$("#bulk-action"); if(sa)sa.addEventListener('change',function(){ $("#bulk-apply").disabled=!sa.value; });
    var ap=$("#bulk-apply"); if(ap)ap.addEventListener('click',bulkApply);
    var cl=$("#bulk-clear"); if(cl)cl.addEventListener('click',bulkClear);
    function selectVisible(){ D.ord.filter(ordEnFiltro).forEach(function(o){bulkSel[o.id]=true;}); renderOrders(); paintBulkBar(); }
    var al=$("#bulk-all"); if(al)al.addEventListener('click',selectVisible);
    var alm=$("#ord-selall-m"); if(alm)alm.addEventListener('click',selectVisible);
  })();

  // ===== Cola de preparación (picking queue) =====
  // Orden forzado: prioridad de courier (según el cliente) y, dentro de cada courier,
  // del pedido más antiguo al más nuevo (FIFO). Espeja la lógica del backend.
  // ---- Deadline de preparación (espeja domain/deadline.ts) --------------------
  // El compromiso de salida de una orden: cuánta holgura queda y qué tan grave es.
  // La ventana de riesgo la define la operación (DL.riesgoHoras); por defecto 4 h.
  var DL={riesgoHoras:4,offsetHoras:-3,cortes:[]};
  function dlState(dueAt){
    if(!dueAt)return{level:'sin',min:null,texto:''};
    var due=Date.parse(dueAt); if(isNaN(due))return{level:'sin',min:null,texto:''};
    var min=Math.round((due-Date.now())/60000);
    var riesgo=(DL.riesgoHoras==null?4:DL.riesgoHoras)*60;
    var level=min<0?'vencido':min<=60?'critico':min<=riesgo?'riesgo':'ok';
    var abs=Math.abs(min), h=Math.floor(abs/60), r=abs%60;
    var dur=h>0?(h+' h'+(r?' '+r+' min':'')):(r+' min');
    return{level:level,min:min,texto:(min<0?'vencida hace ':'vence en ')+dur};
  }
  var DL_LABEL={oms:'del canal',manual:'fijado a mano',corte:'corte del courier',sla:'SLA del cliente'};
  /** Chip de deadline para tablas y listas. */
  function dlChip(o){
    // Una orden despachada o cancelada ya no tiene cuenta regresiva: mostrarla sería ruido.
    if(o&&(o.status==='SHIPPED'||o.status==='CANCELLED'))return '<span class="muted" style="font-size:12px">—</span>';
    var st=dlState(o&&o.dueAt);
    if(st.level==='sin')return '<span class="muted" style="font-size:12px">—</span>';
    var hora=fmtDate(o.dueAt);
    return '<span class="dl dl-'+st.level+'" title="'+esc(hora+' · '+(DL_LABEL[o.dueSource]||o.dueSource||''))+'">'+esc(st.texto)+'</span>';
  }
  /** Valor para un <input type="datetime-local"> a partir de un ISO. */
  function isoToLocalInput(iso){
    if(!iso)return '';
    var d=new Date(iso); if(isNaN(d.getTime()))return '';
    var p=function(n){return String(n).padStart(2,'0');};
    return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate())+'T'+p(d.getHours())+':'+p(d.getMinutes());
  }
  function localInputToIso(v){ if(!v)return null; var t=Date.parse(v); return isNaN(t)?null:new Date(t).toISOString(); }

  /**
   * Tarjeta de configuración de deadlines (solo para quien administra la operación):
   * horas de corte por courier y a cuántas horas se considera "en riesgo".
   */
  function dlConfigCard(){
    if(!can('master'))return '';
    var cortes=(DL.cortes||[]);
    var txt=cortes.length
      ? cortes.map(function(c){return esc(c.courier)+' '+esc(c.hora);}).join(' · ')
      : 'sin horas de corte configuradas';
    return '<div class="card" style="padding:12px;margin:0 0 12px;display:flex;align-items:center;gap:12px;flex-wrap:wrap">'
      +'<div style="flex:1;min-width:240px"><b>Deadlines de preparación</b>'
      +'<div class="muted" style="font-size:12px">Cortes: '+txt+' · en riesgo a '+(DL.riesgoHoras==null?4:DL.riesgoHoras)+' h del compromiso.</div></div>'
      +'<button class="btn mini" id="dl-cfg">Configurar cortes</button></div>';
  }
  /** Carga la configuración de deadlines de la operación (una vez por sesión/operación). */
  function loadDeadlineConfig(){
    if(!op)return Promise.resolve();
    return api('/operations/'+op+'/deadline-config').then(function(c){
      DL=c||{}; if(DL.riesgoHoras==null)DL.riesgoHoras=4; if(!DL.cortes)DL.cortes=[];
      // La ventana de riesgo define qué cae en la pestaña "En riesgo": si la tabla ya
      // se pintó con el valor por defecto, hay que recontar con el real.
      if(D.ord&&D.ord.length){ renderOrdFilters(); renderOrders(); }
    }).catch(function(){});
  }
  var DIAS=[['1','Lun'],['2','Mar'],['3','Mié'],['4','Jue'],['5','Vie'],['6','Sáb'],['0','Dom']];
  function openDeadlineConfig(){
    var cortes=JSON.parse(JSON.stringify(DL.cortes||[]));
    function rowHtml(c,i){
      return '<div class="dl-row" data-i="'+i+'">'
        +'<input class="dl-c" value="'+esc(c.courier||'')+'" placeholder="Courier (ej: Chilexpress)">'
        +'<input class="dl-h mono2" value="'+esc(c.hora||'')+'" placeholder="14:00" maxlength="5">'
        +'<div class="dl-d">'+DIAS.map(function(d){
            var on=!c.dias||!c.dias.length||c.dias.indexOf(Number(d[0]))>=0;
            return '<label><input type="checkbox" data-d="'+d[0]+'" '+(on?'checked':'')+'> '+d[1]+'</label>';
          }).join('')+'</div>'
        +'<button class="mini danger dl-x" title="Quitar">✕</button></div>';
    }
    function paint(){ $("#dl-rows").innerHTML=cortes.length?cortes.map(rowHtml).join(''):'<div class="empty">Sin cortes. Agrega uno o deja que el deadline salga del SLA de cada cliente.</div>'; bind(); }
    function read(){
      cortes=$$("#dl-rows .dl-row").map(function(r){
        var dias=$$('[data-d]',r).filter(function(ck){return ck.checked;}).map(function(ck){return Number(ck.getAttribute('data-d'));});
        return {courier:$('.dl-c',r).value.trim(), hora:$('.dl-h',r).value.trim(), dias:dias.length===7?undefined:dias};
      }).filter(function(c){return c.courier&&/^\d{1,2}:\d{2}$/.test(c.hora);});
    }
    function bind(){
      $$("#dl-rows .dl-x").forEach(function(b){b.addEventListener('click',function(){ read(); cortes.splice(Number(b.closest('.dl-row').getAttribute('data-i')),1); paint(); });});
    }
    openModal('Deadlines de preparación',
      '<p class="muted" style="margin:0 0 12px">La hora de corte es cuándo pasa el courier a retirar. Una orden que entra con ese courier queda comprometida para el próximo corte; si el courier de la orden no está en esta lista, el deadline sale del <b>SLA en horas</b> del cliente.</p>'
      +'<div id="dl-rows"></div>'
      +'<div style="margin:10px 0"><button class="btn mini" id="dl-add">＋ Agregar courier</button></div>'
      +'<div class="fld"><label>Marcar "en riesgo" a cuántas horas del deadline</label><input id="dl-riesgo" type="number" min="0" max="72" value="'+(DL.riesgoHoras==null?4:DL.riesgoHoras)+'"></div>'
      +'<div class="fld"><label>Desfase horario de la bodega respecto de UTC (Chile: −3 en verano, −4 en invierno)</label><input id="dl-off" type="number" min="-12" max="14" value="'+(DL.offsetHoras==null?-3:DL.offsetHoras)+'"></div>'
      +'<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px"><button class="btn" id="m-no">Cancelar</button><button class="btn pri" id="dl-save">Guardar</button></div>', true);
    paint();
    $("#dl-add").addEventListener('click',function(){ read(); cortes.push({courier:'',hora:'14:00',dias:[1,2,3,4,5]}); paint(); });
    $("#m-no").addEventListener('click',closeModal);
    $("#dl-save").addEventListener('click',function(){
      read();
      api('/operations/'+op+'/deadline-config',{method:'PATCH',body:{cortes:cortes,riesgoHoras:Number($("#dl-riesgo").value)||0,offsetHoras:Number($("#dl-off").value)}})
        .then(function(c){ DL=c||{}; if(!DL.cortes)DL.cortes=[]; closeModal(); toast('Deadlines actualizados'); renderPickQueue(); renderOrdFilters(); renderOrders(); })
        .catch(function(e){ toast(e.message); });
    });
  }

  var pqFlow=false; // true mientras se prepara "en cadena" desde la cola
  function normCourier(s){return String(s||"").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/[^a-z0-9]/g,"");}
  function computePickQueue(){
    var s=byId(D.sellers||[],seller)||{};
    var prio=(s.courierPriority||[]).map(normCourier);
    function rank(carrier){var n=normCourier(carrier);if(!n)return prio.length+1;var i=prio.indexOf(n);return i>=0?i:prio.length;}
    var ready=(D.ord||[]).filter(function(o){return o.status==="ALLOCATED"||o.status==="PICKING";});
    // Deadline primero: lo vencido o en riesgo se atiende por compromiso (el más
    // apretado antes), por encima de la prioridad de courier. El resto, como siempre.
    var enRiesgo=function(o){var l=dlState(o.dueAt).level;return l==='vencido'||l==='critico'||l==='riesgo';};
    ready.sort(function(a,b){
      var ra1=enRiesgo(a)?0:1, rb1=enRiesgo(b)?0:1;
      if(ra1!==rb1)return ra1-rb1;
      if(ra1===0)return (dlState(a.dueAt).min||0)-(dlState(b.dueAt).min||0);
      var ra=rank(a.carrier),rb=rank(b.carrier);if(ra!==rb)return ra-rb;
      return a.createdAt<b.createdAt?-1:(a.createdAt>b.createdAt?1:0);
    });
    return ready;
  }
  function renderPickQueue(){
    var body=$("#pq-body"); if(!body)return;
    var s=byId(D.sellers||[],seller)||{};
    var prio=(s.courierPriority||[]);
    var q=computePickQueue();
    var head='<div class="hint" style="margin:0 0 10px">'
      +'Primero lo que tiene el <b>deadline de preparación</b> vencido o por vencer (de menor a mayor holgura). '
      +(prio.length
        ? 'Después: <b>'+prio.map(esc).join(' → ')+'</b> → resto, y dentro de cada courier del más antiguo al más nuevo (FIFO).'
        : 'Después, por antigüedad (FIFO). Configura la prioridad de courier en el mantenedor del cliente para reordenar la cola.')
      +'</div>'+dlConfigCard();
    if(!q.length){body.innerHTML=head+'<div class="empty">No hay órdenes reservadas listas para preparar. Reserva órdenes (o usa la reserva masiva) y aparecerán aquí en orden.</div>';if($("#dl-cfg"))$("#dl-cfg").addEventListener('click',openDeadlineConfig);return;}
    var rows=q.map(function(o,i){
      var units=(o.lines||[]).reduce(function(a,l){return a+(l.qty||0);},0);
      var inprog=o.status==="PICKING";
      return '<div class="card" style="display:flex;align-items:center;gap:14px;padding:12px;margin-bottom:8px">'
        +'<div style="font-size:20px;font-weight:800;min-width:34px;text-align:center;color:var(--ink-3)">'+(i+1)+'</div>'
        +'<div style="flex:1"><div style="font-weight:700">'+esc(o.externalOrderId||o.id.slice(0,8))
          +(inprog?' <span class="chip st-PICKING" style="font-size:10px">EN PICKING</span>':'')+'</div>'
          +'<div class="muted" style="font-size:12px">'
          +(o.carrier?('Courier: <b>'+esc(o.carrier)+'</b> · '):'Sin courier · ')
          +units+' un · '+(o.lines||[]).length+' línea(s) · '+esc(fmtDate(o.createdAt))
          +(o.dueAt?' · '+dlChip(o):'')+'</div></div>'
        +'<button class="btn pri mini" data-pqgo="'+esc(o.id)+'">'+(inprog?'Continuar':'Preparar')+'</button>'
        +'</div>';
    }).join("");
    body.innerHTML=head+'<div>'+rows+'</div>';
    if($("#dl-cfg"))$("#dl-cfg").addEventListener('click',openDeadlineConfig);
    $$("#pq-body [data-pqgo]").forEach(function(b){b.addEventListener("click",function(){
      pqFlow=true;
      var o=byId(D.ord,b.getAttribute("data-pqgo"));
      openPickForm(o);
    });});
  }
  // Al completar una orden: si venimos de la cola, saltar a la siguiente sin volver al listado.
  function onPickComplete(){
    return loadSeller().then(function(){
      if(!pqFlow){closeModal();return;}
      var next=computePickQueue()[0];
      if(next){toast("Orden lista · siguiente en la cola");openPickForm(next);}
      else{pqFlow=false;closeModal();toast("Cola de preparación completa ✅");}
    });
  }

  // ----- Picking dirigido (multi-ubicación) -----
  function openPickForm(order){
    if(!order)return;
    openModal("Picking · "+esc(order.externalOrderId||order.id.slice(0,8)),'<div class="form" id="pk-wrap"><p class="muted" style="margin:0">Cargando pick list…</p></div>');
    renderPickList(order.id);
  }
  function renderPickList(orderId){
    api('/sellers/'+seller+'/orders/'+orderId+'/picklist').then(function(tasks){
      var pending=tasks.filter(function(t){return (t.qty-(t.pickedQty||0))>0;});
      var rows=tasks.map(function(t){
        var rem=t.qty-(t.pickedQty||0), done=rem<=0;
        var right=done
          ? '<span class="chip st-AVAILABLE"><span class="dot"></span>Pickeado</span>'
          : '<div style="display:flex;gap:8px;align-items:center"><input type="number" class="pk-qty" data-sku="'+esc(t.sku)+'" data-loc="'+esc(t.locationId)+'" min="0" max="'+rem+'" value="0" style="width:70px;padding:8px;border-radius:9px;border:1px solid var(--line);background:var(--surface-2);color:var(--ink)"><span class="muted" style="font-size:12px">/ '+rem+'</span><button class="mini pri pk-go" data-sku="'+esc(t.sku)+'" data-loc="'+esc(t.locationId)+'">Pickear</button></div>';
        return '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--line)">'
          +'<div><div style="font-weight:700">'+esc(code(t.locationId))+' <span class="muted" style="font-weight:500">· '+esc(t.sku)+'</span></div>'
          +'<div class="muted" style="font-size:12px">'+(t.pickedQty||0)+' / '+t.qty+' un recolectadas</div></div>'
          +right+'</div>';
      }).join("");
      var html='<div class="form">'
        +'<p class="muted" style="margin:0 0 4px">Recolecta desde cada ubicación reservada. Puedes surtir la orden desde varias ubicaciones.</p>'
        +'<div>'+rows+'</div>'
        +'<div class="acts" style="margin-top:6px"><span class="hint">'+(pending.length?pending.length+' ubicación(es) pendiente(s)':'Todo recolectado')+'</span>'
        +'<div style="display:flex;gap:10px">'+(pending.length?'<button class="btn" id="pk-all">Pickear todo</button>':'')+'<button class="btn pri" id="pk-close">Cerrar</button></div></div>'
        +'</div>';
      $("#m-body").innerHTML=html;
      $$("#m-body .pk-go").forEach(function(b){b.addEventListener("click",function(){
        var wrap=b.closest("div"); var qtyEl=wrap.querySelector(".pk-qty");
        var qv=parseInt(qtyEl.value,10);
        if(!(qv>0)){toast("Ingresa la cantidad a pickear");qtyEl.focus();return;}
        var body={sku:b.getAttribute("data-sku"),locationId:b.getAttribute("data-loc"),qty:qv};
        api('/sellers/'+seller+'/orders/'+orderId+'/pick-task',{method:'POST',body:body}).then(function(o){
          if(o.status==="PICKED"){toast("Picking completo");return onPickComplete();}
          toast("Ubicación pickeada");renderPickList(orderId);loadSeller();
        }).catch(function(e){toast(e.message);});
      });});
      if($("#pk-all"))$("#pk-all").addEventListener("click",function(){
        api('/sellers/'+seller+'/orders/'+orderId+'/pick',{method:'POST'}).then(function(){toast("Picking completo");return onPickComplete();}).catch(function(e){toast(e.message);});
      });
      $("#pk-close").addEventListener("click",function(){pqFlow=false;closeModal();});
    }).catch(function(e){$("#m-body").innerHTML='<p class="ferr">'+esc(e.message)+'</p>';});
  }

  // ----- Empaque (packing) + etiquetas del OMS -----
  function labelStatusChip(p){
    if(!p)return '';
    if(p.labelStatus==="READY")return '<span class="chip st-AVAILABLE"><span class="dot"></span>Etiquetas listas</span>';
    if(p.labelStatus==="ERROR")return '<span class="chip st-CANCELLED"><span class="dot"></span>OMS sin respuesta</span>';
    return '<span class="chip st-RESERVED"><span class="dot"></span>Esperando OMS…</span>';
  }
  function packSummary(p){
    if(!p)return '';
    return '<div class="pk-sum">'
      +'<div class="kv"><span>Bultos</span><b>'+(p.bultos||1)+'</b></div>'
      +'<div class="kv"><span>Transporte</span><b>'+esc(p.carrier||"—")+'</b></div>'
      +'<div class="kv"><span>N° seguimiento</span><b class="mono2">'+esc(p.trackingNumber||"—")+'</b></div>'
      +'<div class="kv"><span>Etiquetas</span><b>'+labelStatusChip(p)+'</b></div>'
      +(p.labelError?'<div class="kv"><span>Detalle</span><b class="muted">'+esc(p.labelError)+'</b></div>':'')
      +'</div>';
  }
  function labelsGrid(p){
    if(!p||!p.labels||!p.labels.length)return '<p class="muted" style="margin:8px 0">Aún no hay etiquetas. El OMS de Ninja las genera al empacar.</p>';
    return '<div class="lbl-grid">'+p.labels.map(function(l){
      return '<figure class="lbl-card">'
        +'<img src="'+l.dataUri+'" alt="Etiqueta bulto '+l.bultoNo+'">'
        +'<figcaption>Bulto '+l.bultoNo+' · <span class="mono2">'+esc(l.trackingNumber||"")+'</span></figcaption>'
        +'</figure>';
    }).join("")+'</div>';
  }
  function printLabels(p){
    if(!p||!p.labels||!p.labels.length){toast("No hay etiquetas para imprimir");return;}
    var w=window.open("","_blank");
    if(!w){toast("Habilita las ventanas emergentes para imprimir");return;}
    var imgs=p.labels.map(function(l){return '<img src="'+l.dataUri+'" style="width:100mm;max-width:100%;display:block;margin:0 auto 8mm;page-break-after:always">';}).join("");
    w.document.write('<!doctype html><html><head><title>Etiquetas '+esc(p.trackingNumber||"")+'</title><style>@page{margin:6mm}body{margin:0;background:#fff}img{border:1px solid #000}</style></head><body onload="window.print()">'+imgs+'</body></html>');
    w.document.close();
  }
  function openPackForm(order){
    if(!order)return;
    var q=order.lines.reduce(function(a,l){return a+l.qty;},0);
    var mats=(D.packaging||[]).filter(function(m){return m.active!==false;});
    var matOpts='<option value="">— elegir insumo —</option>'+mats.map(function(m){return '<option value="'+esc(m.sku)+'">'+esc(m.name)+' (saldo '+(m.onHand||0)+')</option>';}).join("");
    var pkgBlock = mats.length
      ? '<div class="fld"><label>Insumos de embalaje usados (opcional)</label>'
        +'<div style="display:flex;gap:8px;margin-bottom:6px"><input id="pk2-scan" placeholder="Pistolea el EAN del embalaje y Enter…" autocomplete="off" style="flex:1"><button type="button" class="btn" id="pk2-scanbtn">Leer</button></div>'
        +'<div id="pk2-mats"></div>'
        +'<button type="button" class="btn" id="pk2-addmat" style="margin-top:4px">＋ Agregar insumo</button>'
        +'<div class="hint" style="margin-top:2px">Lo consumido descuenta stock del insumo y se cobra al cliente en su factura.</div></div>'
      : '<div class="hint">No hay insumos de embalaje en esta bodega. Créalos en la sección Embalajes para poder cargarlos aquí.</div>';
    var html='<div class="form" id="pk2-wrap">'
      +'<p class="muted" style="margin:0">Empacar la orden <b>'+esc(order.externalOrderId||order.id.slice(0,8))+'</b> — '+order.lines.length+' línea(s) · '+q+' un pickeadas.</p>'
      +'<div class="fld"><label>Cantidad de bultos</label><input id="pk2-bultos" type="number" min="1" max="999" value="1" style="width:120px"></div>'
      +pkgBlock
      +'<p class="hint" style="margin:0">Al empacar se conecta con el OMS de Ninja para obtener el N° de seguimiento del transporte y las etiquetas de cada bulto.</p>'
      +'<div class="ferr" id="pk2-err"></div>'
      +'<div class="acts"><span class="hint">La orden pasa a EMPACADA.</span><div style="display:flex;gap:10px"><button class="btn" id="pk2-cancel">Cancelar</button><button class="btn pri" id="pk2-save">Empacar y traer etiquetas</button></div></div>'
      +'</div>';
    openModal("Empacar orden",html);
    // Filas de insumos de embalaje (select + cantidad).
    function matRow(sku,qty){
      return '<div class="pk2-matrow" style="display:flex;gap:8px;margin-bottom:6px">'
        +'<select class="pk2-mat" style="flex:1">'+matOpts+'</select>'
        +'<input class="pk2-qty" type="number" min="1" value="'+(qty||1)+'" style="width:80px" placeholder="Cant.">'
        +'<button type="button" class="mini danger pk2-delmat">✕</button></div>';
    }
    function addMatRow(sku,qty){
      var wrap=$("#pk2-mats"); if(!wrap)return;
      var div=document.createElement('div'); div.innerHTML=matRow(sku,qty); var row=div.firstChild; wrap.appendChild(row);
      if(sku)row.querySelector('.pk2-mat').value=sku;
      row.querySelector('.pk2-delmat').addEventListener('click',function(){row.remove();});
    }
    if(mats.length){
      $("#pk2-addmat").addEventListener("click",function(){addMatRow('',1);});
      function pkgScan(){
        var code=($("#pk2-scan").value||"").trim(); if(!code)return;
        var m=mats.filter(function(x){return x.barcode&&String(x.barcode)===code;})[0];
        if(!m){toast("EAN de embalaje no reconocido");$("#pk2-scan").select();return;}
        // si ya hay una fila con ese insumo, suma 1; si no, agrega una.
        var found=false;
        $$('#pk2-mats .pk2-matrow').forEach(function(row){var sel=row.querySelector('.pk2-mat');if(sel.value===m.sku){var qi=row.querySelector('.pk2-qty');qi.value=(parseInt(qi.value,10)||0)+1;found=true;}});
        if(!found)addMatRow(m.sku,1);
        $("#pk2-scan").value=""; $("#pk2-scan").focus(); toast(m.name+" +1");
      }
      $("#pk2-scanbtn").addEventListener("click",pkgScan);
      $("#pk2-scan").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();pkgScan();}});
    }
    $("#pk2-cancel").addEventListener("click",closeModal);
    $("#pk2-save").addEventListener("click",function(){
      var bultos=parseInt($("#pk2-bultos").value,10)||1;
      $("#pk2-err").textContent="";
      var materials=[], perr="";
      $$('#pk2-mats .pk2-matrow').forEach(function(row){
        var sku=row.querySelector('.pk2-mat').value; var qv=parseInt(row.querySelector('.pk2-qty').value,10);
        if(!sku)return;
        if(!(qv>0)){perr=perr||"Ingresa una cantidad válida para el insumo de embalaje.";return;}
        materials.push({sku:sku,qty:qv});
      });
      if(perr){$("#pk2-err").textContent=perr;return;}
      $("#pk2-save").disabled=true;
      api('/sellers/'+seller+'/orders/'+order.id+'/pack',{method:'POST',body:{bultos:bultos,materials:materials}}).then(function(o){
        toast("Orden empacada");
        loadSeller(); loadPackaging();
        renderLabelsBody(o,true);
      }).catch(function(e){$("#pk2-save").disabled=false;$("#pk2-err").textContent=e.message;});
    });
  }
  function renderLabelsBody(order,justPacked){
    var p=order.packing;
    var err=p&&p.labelStatus==="ERROR";
    var html='<div class="form">'
      +(justPacked?'<p class="ok-note">✓ Orden empacada. Etiquetas del OMS:</p>':'')
      +packSummary(p)
      +'<p class="sec-t" style="margin:14px 0 6px">Etiquetas por bulto</p>'
      +labelsGrid(p)
      +'<div class="acts"><span class="hint">Pega cada etiqueta en su bulto.</span><div style="display:flex;gap:10px">'
      +(err?'<button class="btn" id="lb-retry">Reintentar con OMS</button>':'')
      +(p&&p.labels&&p.labels.length?'<button class="btn" id="lb-print">Imprimir etiquetas</button>':'')
      +'<button class="btn pri" id="lb-close">Cerrar</button></div></div>'
      +'</div>';
    $("#m-body").innerHTML=html;
    $("#lb-close").addEventListener("click",closeModal);
    if($("#lb-print"))$("#lb-print").addEventListener("click",function(){printLabels(p);});
    if($("#lb-retry"))$("#lb-retry").addEventListener("click",function(){
      $("#lb-retry").disabled=true;
      api('/sellers/'+seller+'/orders/'+order.id+'/labels/fetch',{method:'POST'}).then(function(o){toast("Etiquetas actualizadas");loadSeller();renderLabelsBody(o,false);}).catch(function(e){$("#lb-retry").disabled=false;toast(e.message);});
    });
  }
  function openLabels(order){
    if(!order)return;
    openModal("Etiquetas · "+esc(order.externalOrderId||order.id.slice(0,8)),'<div class="form"><p class="muted" style="margin:0">Cargando…</p></div>');
    api('/sellers/'+seller+'/orders/'+order.id).then(function(o){renderLabelsBody(o,false);}).catch(function(e){$("#m-body").innerHTML='<p class="ferr">'+esc(e.message)+'</p>';});
  }

  // ----- Despachar orden (courier + tracking) -----
  function openShipForm(order){
    if(!order)return;
    var isB2B=order.orderType==="b2b";
    var carrierOpts=CARRIERS.map(function(c){return '<option value="'+esc(c)+'">'+esc(c)+'</option>';}).join("");
    var html='<div class="form">'
      +'<p class="muted" style="margin:0">Despachar la orden <b>'+esc(order.externalOrderId||order.id.slice(0,8))+'</b> ('+(isB2B?'B2B · transporte':'B2C · paquetería')+').</p>'
      +'<div class="fld"><label>Courier / transporte</label><input id="sh-carrier" list="sh-carriers" placeholder="Ej: Chilexpress"><datalist id="sh-carriers">'+carrierOpts+'</datalist></div>'
      +'<div class="fld"><label>N° de seguimiento (tracking)</label><input id="sh-track" placeholder="Ej: TRK-123456"></div>'
      +'<div class="ferr" id="sh-err"></div>'
      +'<div class="acts"><span class="hint">La orden pasa a DESPACHADA.</span><div style="display:flex;gap:10px"><button class="btn" id="sh-cancel">Cancelar</button><button class="btn pri" id="sh-save">Despachar</button></div></div>'
      +'</div>';
    openModal("Despachar orden",html);
    $("#sh-cancel").addEventListener("click",closeModal);
    $("#sh-save").addEventListener("click",function(){
      var body={carrier:$("#sh-carrier").value.trim()||null,trackingNumber:$("#sh-track").value.trim()||null};
      api('/sellers/'+seller+'/orders/'+order.id+'/ship',{method:'POST',body:body}).then(function(){closeModal();toast("Orden despachada");return loadSeller();}).catch(function(e){$("#sh-err").textContent=e.message;});
    });
  }

  // ----- Crear / editar orden -----
  var CHANNELS=["web-propia","shopify","mercadolibre","falabella","jumpseller","ripley","walmart","b2b"];
  function openOrderForm(order){
    if(!seller){toast("Selecciona un cliente primero");return;}
    var isEdit=!!order;
    var chOpts=CHANNELS.map(function(c){return '<option value="'+esc(c)+'"'+((order&&order.salesChannel===c)?' selected':(!order&&c==="web-propia"?' selected':''))+'>'+esc(CH_LABEL[c]||c)+'</option>';}).join("");
    var typeOpts=[["b2c","B2C (a consumidor)"],["b2b","B2B (a empresa)"]].map(function(t){return '<option value="'+t[0]+'"'+((order?order.orderType===t[0]:t[0]==="b2c")?' selected':'')+'>'+t[1]+'</option>';}).join("");
    var st=order&&order.shipTo||{};
    var html='<div class="form">'
      +(isEdit&&order.status==="ALLOCATED"?'<div class="callout-edit">Esta orden ya tiene <b>stock reservado</b>. Al guardar se liberan las reservas actuales y se vuelve a reservar con las líneas nuevas. Si el stock no alcanza, no se guarda nada y la orden queda como está.</div>':'')
      +'<div class="row2"><div class="fld"><label>N° de orden (externo)</label><input id="of-ext" value="'+esc(order?order.externalOrderId:'')+'" placeholder="Ej: WEB-1042"'+(isEdit?' readonly title="El N° de orden no se puede cambiar"':'')+'></div>'
      +'<div class="fld"><label>Canal de venta</label><select id="of-ch">'+chOpts+'</select></div></div>'
      +'<div class="row2"><div class="fld"><label>Tipo</label><select id="of-type">'+typeOpts+'</select></div>'
      +'<div class="fld"><label>Prioridad</label><select id="of-prio"><option value="normal"'+((order&&order.priority==="normal")||!order?' selected':'')+'>Normal</option><option value="alta"'+(order&&order.priority==="alta"?' selected':'')+'>Alta</option></select></div></div>'
      +'<div class="row2"><div class="fld"><label>Tipo de documento</label><select id="of-doc">'+docTypeOptions(order?order.documentType:'')+'</select></div>'
      +'<div class="fld"><label>Courier / transporte</label><input id="of-carrier" list="carrier-list" value="'+esc(order&&order.carrier||'')+'" placeholder="Ej: Chilexpress, Rapiboy, DHL"></div></div>'
      // Deadline: si se deja vacío lo resuelve la operación (hora de corte del courier o SLA del cliente).
      +'<div class="fld"><label>Deadline de preparación (opcional)</label><input id="of-due" type="datetime-local" value="'+esc(order?isoToLocalInput(order.dueAt):'')+'">'
      +'<div class="hint">Si lo dejas vacío, se calcula solo: hora de corte del courier y, si ese courier no tiene corte, el SLA en horas del cliente.</div></div>'
      +'<datalist id="carrier-list"><option value="Chilexpress"></option><option value="BlueExpress"></option><option value="Starken"></option><option value="Correos de Chile"></option><option value="DHL"></option><option value="Rapiboy"></option><option value="Uber Flash"></option><option value="Samex"></option><option value="Retiro en tienda"></option></datalist>'
      +'<div class="row2"><div class="fld"><label>Destinatario</label><input id="of-name" value="'+esc(st.name||'')+'" placeholder="Nombre de quien recibe"></div>'
      +'<div class="fld"><label>Comuna / ciudad (opcional)</label><input id="of-comuna" value="'+esc(st.comuna||'')+'"></div></div>'
      +'<div class="fld"><label>Dirección (opcional)</label><input id="of-addr" value="'+esc(st.address||'')+'"></div>'
      +'<p class="sec-t" style="margin:6px 0 2px">Líneas de la orden</p>'
      +'<div class="ordline-h"><span>Producto (SKU)</span><span style="text-align:right">Cantidad</span><span>Lote (opcional)</span><span></span></div>'
      +'<div id="of-lines"></div>'

      +'<button class="btn" id="of-addline" style="align-self:flex-start">＋ Agregar línea</button>'
      +'<div class="ferr" id="of-err"></div>'
      +'<div class="acts"><span class="hint">Cliente: '+esc((byId(D.sellers,seller)||{}).name||seller)+'</span><div style="display:flex;gap:10px"><button class="btn" id="of-cancel">Cancelar</button><button class="btn pri" id="of-save">'+(isEdit?'Guardar cambios':'Crear orden')+'</button></div></div>'
      +'</div>';
    openModal(isEdit?("Editar orden "+(order.externalOrderId||"")):"Nueva orden",html,'xl');

    // El producto se escribe o se PEGA (no es un desplegable): se acepta el SKU, el
    // NOMBRE del producto o el código de barras, sin distinguir mayúsculas ni espacios
    // sobrantes, y bajo el campo aparece el nombre para confirmar que es el correcto.
    var skuByCode={}, skuByDesc={};
    D.skus.forEach(function(s){
      skuByCode[String(s.sku||'').trim().toUpperCase()]=s;
      if(s.barcode)skuByCode[String(s.barcode).trim().toUpperCase()]=s;
      var d=String(s.description||'').trim().toUpperCase();
      if(d)skuByDesc[d]=(skuByDesc[d]===undefined)?s:null;   // null = nombre repetido, ambiguo
    });
    function resolveSku(v){
      var k=String(v==null?'':v).trim().toUpperCase();
      if(!k)return null;
      return skuByCode[k]||skuByDesc[k]||null;
    }

    // Autocompletado del producto: usa el componente compartido AC.
    function acMatchSku(q){
      q=String(q||'').trim().toLowerCase();
      if(!q)return D.skus.slice(0,8);
      var pre=[], mid=[];
      D.skus.forEach(function(s){
        var sk=String(s.sku||'').toLowerCase(), de=String(s.description||'').toLowerCase(), bc=String(s.barcode||'').toLowerCase();
        if(sk.indexOf(q)===0||de.indexOf(q)===0)pre.push(s);
        else if(sk.indexOf(q)>=0||de.indexOf(q)>=0||bc.indexOf(q)>=0)mid.push(s);
      });
      return pre.concat(mid).slice(0,8);
    }
    function skuRow(s,q){ return '<span class="ac-sku">'+AC.mark(s.sku,q)+'</span><span class="ac-de">'+AC.mark(s.description||'',q)+'</span>'; }
    // quiet = mientras escribe; no se marca en rojo hasta que sale del campo o guarda.
    function paintSku(div,quiet){
      var inp=div.querySelector('.ol-sku'), cap=div.querySelector('.ol-skuname');
      var raw=inp.value.trim();
      if(!raw){ inp.classList.remove('bad'); cap.textContent=''; cap.classList.remove('bad'); return; }
      var m=resolveSku(raw);
      if(m){
        if(inp.value!==m.sku)inp.value=m.sku;   // normaliza (pegó el EAN, el nombre o en minúsculas)
        inp.classList.remove('bad');
        cap.textContent=m.description||'';
        cap.classList.remove('bad');
      }else if(quiet){
        inp.classList.remove('bad'); cap.textContent=''; cap.classList.remove('bad');
      }else{
        inp.classList.add('bad');
        cap.textContent='No existe un producto con ese código o nombre';
        cap.classList.add('bad');
      }
    }
    function lineRow(l){
      l=l||{};
      var div=document.createElement('div');
      div.className='ordline';
      div.innerHTML='<div class="ol-skuwrap"><input class="ol-sku" autocomplete="off" spellcheck="false" placeholder="SKU o nombre del producto" value="'+esc(l.sku||'')+'"><div class="ol-skuname"></div></div>'
        +'<input class="ol-qty" type="number" min="1" value="'+(l.qty||1)+'" title="Cantidad" placeholder="Cant.">'
        +'<input class="ol-lot" placeholder="Lote (opc.)" value="'+esc(l.lot||'')+'" title="Lote/serie opcional">'
        +'<button class="mini danger ol-del" title="Quitar">✕</button>';
      var inp=div.querySelector('.ol-sku');
      AC.attach(inp,{
        match: acMatchSku, row: skuRow, empty: 'Sin productos que coincidan',
        onType: function(){ paintSku(div,true); },
        onBlur: function(){ paintSku(div); },
        pick: function(s){ inp.value=s.sku; paintSku(div); var q=div.querySelector('.ol-qty'); if(q)q.focus(); }
      });
      // Pegar una COLUMNA de SKUs (desde Excel) crea una línea por código.
      inp.addEventListener('paste',function(e){
        var txt=(e.clipboardData||window.clipboardData).getData('text')||'';
        var codes=txt.split(/[\r\n\t;]+/).map(function(x){return x.trim();}).filter(Boolean);
        if(codes.length<2)return;                     // pegado normal de un solo código
        e.preventDefault();
        inp.value=codes[0]; AC.close(); paintSku(div);
        var ref=div;
        codes.slice(1).forEach(function(c){
          var row=lineRow({sku:c});
          ref.parentNode.insertBefore(row,ref.nextSibling); ref=row; paintSku(row);
        });
        toast(codes.length+' líneas agregadas');
      });
      div.querySelector('.ol-del').addEventListener('click',function(){div.parentNode.removeChild(div);});
      setTimeout(function(){paintSku(div,true);},0);
      return div;
    }
    var linesBox=$("#of-lines");
    (isEdit&&order.lines&&order.lines.length?order.lines:[{}]).forEach(function(l){linesBox.appendChild(lineRow(l));});
    $("#of-addline").addEventListener("click",function(){linesBox.appendChild(lineRow());});
    $("#of-cancel").addEventListener("click",function(){AC.close();closeModal();});
    $("#of-save").addEventListener("click",function(){
      $("#of-err").textContent="";
      var ext=$("#of-ext").value.trim(), name=$("#of-name").value.trim();
      if(!ext){$("#of-err").textContent="Ingresa el N° de orden.";return;}
      if(!name){$("#of-err").textContent="Ingresa el destinatario.";return;}
      var lines=[]; var desconocidos=[]; var sinCantidad=false;
      var rows=$$("#of-lines .ordline");
      rows.forEach(function(r){
        var raw=r.querySelector('.ol-sku').value.trim();
        var qty=parseInt(r.querySelector('.ol-qty').value,10);
        var lot=r.querySelector('.ol-lot').value.trim();
        if(!raw)return;                                   // línea vacía: se ignora
        var m=resolveSku(raw);
        if(!m){desconocidos.push(raw); paintSku(r); return;}
        if(!(qty>0)){sinCantidad=true;return;}
        var ln={sku:m.sku,qty:qty}; if(lot)ln.lot=lot; lines.push(ln);
      });
      if(desconocidos.length){$("#of-err").textContent=(desconocidos.length===1?"No existe un producto con el código o nombre ":"No existen productos con los códigos o nombres ")+desconocidos.join(", ")+". Revisa el catálogo del cliente.";return;}
      if(sinCantidad){$("#of-err").textContent="Hay líneas sin cantidad: cada producto necesita una cantidad mayor que 0.";return;}
      if(!lines.length){$("#of-err").textContent="Agrega al menos una línea: pega o escribe el SKU y la cantidad.";return;}
      var shipTo={name:name};
      var comuna=$("#of-comuna").value.trim(); if(comuna)shipTo.comuna=comuna;
      var addr=$("#of-addr").value.trim(); if(addr)shipTo.address=addr;
      var body={externalOrderId:ext,salesChannel:$("#of-ch").value,orderType:$("#of-type").value,priority:$("#of-prio").value,shipTo:shipTo,lines:lines};
      var docv=$("#of-doc")?$("#of-doc").value:""; if(docv)body.documentType=docv;
      var carv=$("#of-carrier")?$("#of-carrier").value.trim():""; if(carv)body.carrier=carv;
      var duev=$("#of-due")?localInputToIso($("#of-due").value):null; if(duev){body.dueAt=duev;body.dueSource='manual';}
      var p=isEdit?api('/sellers/'+seller+'/orders/'+order.id,{method:'PATCH',body:body}):api('/sellers/'+seller+'/orders',{method:'POST',body:body});
      var btn=this; btn.disabled=true;
      p.then(function(o){closeModal();toast(isEdit?((order.status==="ALLOCATED")?"Orden actualizada y stock reservado de nuevo":"Orden actualizada"):"Orden creada");return loadSeller();})
       .catch(function(e){btn.disabled=false; if(showStockShortage(e,order&&order.externalOrderId)){$("#of-err").textContent="No se guardó: falta stock. La orden quedó como estaba.";} else {$("#of-err").textContent=e.message;} });
    });
  }
  // ===== Carga masiva de órdenes por Excel =====
  function renderImportResult(j){
    var box=$("#imp-result"); if(!box)return;
    if(!j||j.ok===false){box.innerHTML='<div class="apprv-box warn"><div class="apprv-t">No se pudo procesar el archivo</div><div class="hint">'+esc((j&&j.error)||'Error desconocido')+'</div></div>';return;}
    var r=j.resumen||{};
    var html='<div class="apprv-box '+((r.creadas||0)>0?'ok':'warn')+'"><div class="apprv-t">'+esc(r.creadas||0)+' orden(es) creada(s) de '+esc(r.ordenesEnArchivo||0)+'</div>'
      +'<div class="hint">'+esc(r.conError||0)+' con error · '+esc(r.lineasIgnoradas||0)+' línea(s) ignorada(s)</div></div>';
    function list(title,arr,fmt){if(!arr||!arr.length)return'';return '<div style="margin-top:12px"><p class="sec-t" style="margin:0 0 4px">'+title+'</p>'+arr.map(function(x){return '<div class="hint">• '+fmt(x)+'</div>';}).join('')+'</div>';}
    html+=list('Creadas',j.created,function(x){return esc(x.orden)+' ('+esc(x.lineas)+' línea(s))';});
    html+=list('Con error (no se crearon)',j.failed,function(x){return '<b>'+esc(x.orden)+'</b>: '+esc(x.motivo);});
    html+=list('Líneas ignoradas',j.lineErrors,function(x){return 'Fila '+esc(x.fila)+': '+esc(x.motivo);});
    box.innerHTML=html;
  }
  function openBulkImport(){
    if(!seller){toast("Selecciona un cliente primero");return;}
    var sname=esc((byId(D.sellers,seller)||{}).name||seller);
    var html='<div class="form" style="gap:14px">'
      +'<p class="muted" style="margin:0">Sube varias órdenes de una vez con un archivo Excel. Descarga el formato, complétalo (una <b>fila por producto</b>; repite el mismo <b>N° de orden</b> para agregar varias líneas a una orden) y súbelo aquí.</p>'
      +'<div><button class="btn" id="imp-tpl">⬇ Descargar formato Excel</button></div>'
      +'<div class="fld"><label>Archivo de órdenes (.xlsx o .csv)</label><input type="file" id="imp-file" accept=".xlsx,.xls,.csv"></div>'
      +'<div class="ferr" id="imp-err"></div>'
      +'<div id="imp-result"></div>'
      +'<div class="acts"><span class="hint">Cliente: '+sname+'</span><div style="display:flex;gap:10px"><button class="btn" id="imp-cancel">Cerrar</button><button class="btn pri" id="imp-send">Subir órdenes</button></div></div>'
      +'</div>';
    openModal("Carga masiva de órdenes",html,true);
    $("#imp-cancel").addEventListener("click",closeModal);
    $("#imp-tpl").addEventListener("click",function(){
      $("#imp-err").textContent="";
      var h={}; if(token)h['Authorization']='Bearer '+token;
      fetch(API+'/sellers/'+seller+'/order-import/template',{headers:h})
        .then(function(r){if(!r.ok)throw new Error('No se pudo generar la plantilla ('+r.status+').');return r.blob();})
        .then(function(b){var u=URL.createObjectURL(b);var a=document.createElement('a');a.href=u;a.download='plantilla-ordenes-ninjawms.xlsx';document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(function(){URL.revokeObjectURL(u);},1500);toast("Formato descargado");})
        .catch(function(e){$("#imp-err").textContent=e.message;});
    });
    $("#imp-send").addEventListener("click",function(){
      $("#imp-err").textContent=""; $("#imp-result").innerHTML="";
      var inp=$("#imp-file"); var f=inp&&inp.files&&inp.files[0];
      if(!f){$("#imp-err").textContent="Elige un archivo primero.";return;}
      var btn=this; btn.disabled=true; btn.textContent="Subiendo…";
      var rd=new FileReader();
      rd.onload=function(){
        var b64=String(rd.result||"").split(',')[1]||"";
        api('/sellers/'+seller+'/order-import',{method:'POST',body:{dataBase64:b64,filename:f.name}})
          .then(function(j){renderImportResult(j);if(j&&j.ok&&j.resumen&&(j.resumen.creadas||0)>0){toast(j.resumen.creadas+" orden(es) creada(s)");loadSeller();}})
          .catch(function(e){$("#imp-err").textContent=e.message;})
          .then(function(){btn.disabled=false;btn.textContent="Subir órdenes";});
      };
      rd.onerror=function(){$("#imp-err").textContent="No se pudo leer el archivo.";btn.disabled=false;btn.textContent="Subir órdenes";};
      rd.readAsDataURL(f);
    });
  }

  // ----- Carga masiva de RECEPCIONES por Excel -----
  function renderReceiptImportResult(j){
    var box=$("#rimp-result"); if(!box)return;
    if(!j||j.ok===false){box.innerHTML='<div class="apprv-box warn"><div class="apprv-t">No se pudo procesar el archivo</div><div class="hint">'+esc((j&&j.error)||'Error desconocido')+'</div></div>';return;}
    var r=j.resumen||{};
    var html='<div class="apprv-box '+((r.creadas||0)>0?'ok':'warn')+'"><div class="apprv-t">'+esc(r.creadas||0)+' recepción(es) creada(s) de '+esc(r.recepcionesEnArchivo||0)+'</div>'
      +'<div class="hint">'+esc(r.conError||0)+' con error · '+esc(r.lineasIgnoradas||0)+' línea(s) ignorada(s)</div></div>';
    function list(title,arr,fmt){if(!arr||!arr.length)return'';return '<div style="margin-top:12px"><p class="sec-t" style="margin:0 0 4px">'+title+'</p>'+arr.map(function(x){return '<div class="hint">• '+fmt(x)+'</div>';}).join('')+'</div>';}
    html+=list('Creadas',j.created,function(x){return esc(x.grupo)+' → '+esc(x.id)+' ('+esc(x.lineas)+' línea(s))';});
    html+=list('Con error (no se crearon)',j.failed,function(x){return '<b>'+esc(x.grupo)+'</b>: '+esc(x.motivo);});
    html+=list('Líneas ignoradas',j.lineErrors,function(x){return 'Fila '+esc(x.fila)+': '+esc(x.motivo);});
    box.innerHTML=html;
  }
  function openReceiptImport(){
    if(!seller){toast("Selecciona un cliente primero");return;}
    var sname=esc((byId(D.sellers,seller)||{}).name||seller);
    var html='<div class="form" style="gap:14px">'
      +'<p class="muted" style="margin:0">Sube varias órdenes de recepción de una vez con un archivo Excel. Descarga el formato, complétalo (una <b>fila por producto</b>; repite el mismo <b>Recepción (grupo)</b> para agregar varias líneas a una recepción) y súbelo aquí. Es la misma información del formulario: proveedor, referencia, ubicación, notas, y por línea SKU, cantidad, lote y vencimiento.</p>'
      +'<div><button class="btn" id="rimp-tpl">⬇ Descargar formato Excel</button></div>'
      +'<div class="fld"><label>Archivo de recepciones (.xlsx o .csv)</label><input type="file" id="rimp-file" accept=".xlsx,.xls,.csv"></div>'
      +'<div class="ferr" id="rimp-err"></div>'
      +'<div id="rimp-result"></div>'
      +'<div class="acts"><span class="hint">Cliente: '+sname+'</span><div style="display:flex;gap:10px"><button class="btn" id="rimp-cancel">Cerrar</button><button class="btn pri" id="rimp-send">Subir recepciones</button></div></div>'
      +'</div>';
    openModal("Carga masiva de recepciones",html,true);
    $("#rimp-cancel").addEventListener("click",closeModal);
    $("#rimp-tpl").addEventListener("click",function(){
      $("#rimp-err").textContent="";
      var h={}; if(token)h['Authorization']='Bearer '+token;
      fetch(API+'/sellers/'+seller+'/receipt-import/template',{headers:h})
        .then(function(r){if(!r.ok)throw new Error('No se pudo generar la plantilla ('+r.status+').');return r.blob();})
        .then(function(b){var u=URL.createObjectURL(b);var a=document.createElement('a');a.href=u;a.download='plantilla-recepciones-ninjawms.xlsx';document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(function(){URL.revokeObjectURL(u);},1500);toast("Formato descargado");})
        .catch(function(e){$("#rimp-err").textContent=e.message;});
    });
    $("#rimp-send").addEventListener("click",function(){
      $("#rimp-err").textContent=""; $("#rimp-result").innerHTML="";
      var inp=$("#rimp-file"); var f=inp&&inp.files&&inp.files[0];
      if(!f){$("#rimp-err").textContent="Elige un archivo primero.";return;}
      var btn=this; btn.disabled=true; btn.textContent="Subiendo…";
      var rd=new FileReader();
      rd.onload=function(){
        var b64=String(rd.result||"").split(',')[1]||"";
        api('/sellers/'+seller+'/receipt-import',{method:'POST',body:{dataBase64:b64,filename:f.name}})
          .then(function(j){renderReceiptImportResult(j);if(j&&j.ok&&j.resumen&&(j.resumen.creadas||0)>0){toast(j.resumen.creadas+" recepción(es) creada(s)");loadSeller();}})
          .catch(function(e){$("#rimp-err").textContent=e.message;})
          .then(function(){btn.disabled=false;btn.textContent="Subir recepciones";});
      };
      rd.onerror=function(){$("#rimp-err").textContent="No se pudo leer el archivo.";btn.disabled=false;btn.textContent="Subir recepciones";};
      rd.readAsDataURL(f);
    });
  }

  // ===== Devoluciones (logística reversa) =====
  var QA_INP='width:100%;padding:6px 8px;border:1px solid var(--line);border-radius:7px;background:var(--surface-2);color:var(--ink);font-family:inherit;font-size:13px';
  var QA_GRID='display:grid;grid-template-columns:1fr 56px 78px 78px 92px;gap:8px;align-items:center;margin-bottom:6px';
  function retChip(st){
    var col=st==="COMPLETED"?"var(--good)":(st==="CANCELLED"?"var(--ink-3)":"var(--warn)");
    return '<span class="chip" style="background:transparent;border:1px solid '+col+';color:'+col+'"><span class="dot" style="background:'+col+'"></span>'+esc(RET_ST[st]||st)+'</span>';
  }
  function loadSellerReturns(){ return api('/sellers/'+seller+'/returns').then(function(list){D.ret=list||[];renderReturns();}).catch(function(){}); }
  function renderReturns(){
    if($("#ret-new"))$("#ret-new").classList.toggle("hidden",!can('order'));
    var body=$("#ret-body"); if(!body)return;
    var rows=sortRows('returns',(D.ret||[]),RET_COLS);
    if(!rows.length){body.innerHTML='<tr><td colspan="7"><div class="empty">Aún no hay devoluciones. Crea una desde una orden de salida con “Nueva devolución”.</div></td></tr>';return;}
    body.innerHTML=rows.map(function(r){
      var st=r.lines.reduce(function(a,l){return a+l.toStock;},0);
      var me=r.lines.reduce(function(a,l){return a+l.toMerma;},0);
      var cu=r.lines.reduce(function(a,l){return a+l.toQuarantine;},0);
      var acts=(r.status==="PENDING"||r.status==="PARTIAL")?'<button class="btn pri mini" data-qa="'+esc(r.id)+'">Procesar QA</button>':'<button class="btn mini" data-rv="'+esc(r.id)+'">Ver</button>';
      return '<tr><td class="mono2">'+esc(r.id)+'</td><td>'+esc(r.originalOrderRef||"—")+'</td><td>'+esc(fmtDate(r.createdAt))+'</td><td>'+r.lines.length+'</td><td>'+st+' / '+me+' / '+cu+'</td><td>'+retChip(r.status)+'</td><td style="text-align:right">'+acts+'</td></tr>';
    }).join("");
    $$("#ret-body [data-qa]").forEach(function(b){b.addEventListener("click",function(){openReturnQA((D.ret||[]).find(function(x){return x.id===b.getAttribute("data-qa");}));});});
    $$("#ret-body [data-rv]").forEach(function(b){b.addEventListener("click",function(){openReturnDetail((D.ret||[]).find(function(x){return x.id===b.getAttribute("data-rv");}));});});
    paintSort('returns');
  }
  function openNewReturn(){
    if(!seller){toast("Selecciona un cliente primero");return;}
    var shipped=(D.ord||[]).filter(function(o){return o.status==="SHIPPED";})
      .sort(function(a,b){return (a.createdAt<b.createdAt)?1:-1;});
    var html='<style>#rn-results .ac-item{padding:9px 11px;cursor:pointer;font-size:13.5px;border-bottom:1px solid var(--line)}#rn-results .ac-item:last-child{border-bottom:0}#rn-results .ac-item:hover{background:var(--surface-2)}</style>'
      +'<div class="form">'
      +'<p class="muted" style="margin:0">Busca la orden de salida <b>despachada</b> por su N°: el menú va filtrando mientras escribes. Al elegirla, se enlaza y se prellenan sus productos para el QA.</p>'
      +'<div class="fld" style="position:relative"><label>Orden de salida (despachada)</label>'
        +'<input id="rn-ref" placeholder="Escribe el N° de orden…" autocomplete="off">'
        +'<div id="rn-results" style="display:none;position:absolute;left:0;right:0;top:100%;margin-top:4px;background:var(--surface);border:1px solid var(--line);border-radius:9px;box-shadow:var(--shadow);max-height:230px;overflow:auto;z-index:50"></div>'
      +'</div>'
      +'<div class="fld"><label>Motivo (opcional)</label><input id="rn-reason" placeholder="Ej: Cliente se arrepintió"></div>'
      +'<div class="ferr" id="rn-err"></div>'
      +'<div class="acts"><span class="hint">'+shipped.length+' orden(es) despachada(s) disponibles</span><div style="display:flex;gap:10px"><button class="btn" id="rn-cancel">Cancelar</button><button class="btn pri" id="rn-create">Crear y continuar al QA</button></div></div>'
      +'</div>';
    openModal("Nueva devolución",html);
    // Buscador con menú desplegable: filtra las órdenes despachadas mientras se escribe.
    function rnRender(q){
      var box=$("#rn-results"); if(!box)return;
      q=(q||"").trim().toLowerCase();
      var matches=shipped.filter(function(o){return String(o.externalOrderId||o.id).toLowerCase().indexOf(q)>=0;});
      var list=matches.slice(0,8);
      if(!list.length){
        box.innerHTML='<div class="ac-item muted" style="cursor:default">'+(shipped.length?'Sin órdenes despachadas que coincidan':'No hay órdenes despachadas para este cliente')+'</div>';
        box.style.display='block'; return;
      }
      box.innerHTML=list.map(function(o){var id=String(o.externalOrderId||o.id);var q2=o.lines.reduce(function(a,l){return a+l.qty;},0);
        return '<div class="ac-item" data-ref="'+esc(id)+'"><b>'+esc(id)+'</b> <span class="muted">· '+o.lines.length+' línea(s) · '+q2+' un · '+esc(fmtDate(o.createdAt))+'</span></div>';
      }).join("")+(matches.length>list.length?'<div class="ac-item muted" style="cursor:default">…y '+(matches.length-list.length)+' más — sigue escribiendo</div>':'');
      box.style.display='block';
      $$("#rn-results .ac-item[data-ref]").forEach(function(it){it.addEventListener("mousedown",function(e){e.preventDefault();$("#rn-ref").value=it.getAttribute("data-ref");box.style.display='none';});});
    }
    $("#rn-ref").addEventListener("input",function(){rnRender(this.value);});
    $("#rn-ref").addEventListener("focus",function(){rnRender(this.value);});
    $("#rn-ref").addEventListener("blur",function(){setTimeout(function(){var b=$("#rn-results");if(b)b.style.display='none';},160);});
    $("#rn-cancel").addEventListener("click",closeModal);
    $("#rn-create").addEventListener("click",function(){
      $("#rn-err").textContent=""; var ref=$("#rn-ref").value.trim();
      if(!ref){$("#rn-err").textContent="Ingresa el N° de la orden original.";return;}
      var btn=this; btn.disabled=true;
      api('/sellers/'+seller+'/returns',{method:'POST',body:{originalOrderRef:ref,reason:$("#rn-reason").value.trim()||undefined}})
        .then(function(r){toast("Devolución "+r.id+" creada");return loadSellerReturns().then(function(){openReturnQA(r);});})
        .catch(function(e){$("#rn-err").textContent=e.message;btn.disabled=false;});
    });
  }
  function openReturnQA(ret){
    if(!ret){toast("No se encontró la devolución");return;}
    var skuOpts=(D.skus||[]).map(function(s){return '<option value="'+esc(s.sku)+'">'+esc(s.sku)+(s.description?' — '+esc(s.description):'')+'</option>';}).join("");
    var head='<div style="'+QA_GRID+';font-size:11.5px;font-weight:600;color:var(--ink-3)"><span>Producto</span><span>Salió</span><span>A stock</span><span>A merma</span><span>A cuar.</span></div>';
    var rows=ret.lines.map(function(l){
      return '<div class="qa-row" data-sku="'+esc(l.sku)+'" style="'+QA_GRID+'">'
        +'<span class="mono2">'+esc(l.sku)+'</span>'
        +'<span class="muted" style="text-align:center">'+l.expectedQty+'</span>'
        +'<input type="number" min="0" class="qa-stock" value="0" style="'+QA_INP+'">'
        +'<input type="number" min="0" class="qa-merma" value="0" style="'+QA_INP+'">'
        +'<input type="number" min="0" class="qa-cuar" value="0" style="'+QA_INP+'">'
        +'</div>';
    }).join("");
    var html='<div class="form" style="gap:12px">'
      +'<p class="muted" style="margin:0">Devolución <b>'+esc(ret.id)+'</b> · orden original <b>'+esc(ret.originalOrderRef||"—")+'</b>. Indica cuántas unidades de cada producto van a <b>stock</b>, <b>merma</b> o <b>cuarentena</b>. Puedes registrar menos de lo que salió (parcial).</p>'
      +head+'<div id="ret-qa-lines">'+rows+'</div>'
      +'<div id="ret-qa-extra"></div>'
      +'<button class="btn" id="ret-qa-add" style="align-self:flex-start">＋ Agregar producto que no corresponde</button>'
      +'<div class="ferr" id="ret-qa-err"></div>'
      +'<div class="acts"><span class="hint">Merma → ubicación DEV-MERMA · Cuarentena → DEV-CUARENTENA</span><div style="display:flex;gap:10px"><button class="btn" id="ret-qa-cancel">Cerrar</button><button class="btn pri" id="ret-qa-save">Registrar</button></div></div>'
      +'</div>';
    openModal("QA de devolución",html,true);
    $("#ret-qa-cancel").addEventListener("click",closeModal);
    $("#ret-qa-add").addEventListener("click",function(){
      var div=document.createElement('div'); div.className='qa-row'; div.style.cssText=QA_GRID;
      div.innerHTML='<select class="qa-sku" style="'+QA_INP+'"><option value="">SKU…</option>'+skuOpts+'</select>'
        +'<span class="muted" style="text-align:center">—</span>'
        +'<input type="number" min="0" class="qa-stock" value="0" style="'+QA_INP+'">'
        +'<input type="number" min="0" class="qa-merma" value="0" style="'+QA_INP+'">'
        +'<input type="number" min="0" class="qa-cuar" value="0" style="'+QA_INP+'">';
      $("#ret-qa-extra").appendChild(div);
    });
    $("#ret-qa-save").addEventListener("click",function(){
      $("#ret-qa-err").textContent=""; var lines=[];
      $$("#ret-qa-lines .qa-row, #ret-qa-extra .qa-row").forEach(function(row){
        var sel=row.querySelector(".qa-sku");
        var sku=row.getAttribute("data-sku")||(sel?sel.value:"");
        if(!sku)return;
        var s=parseInt(row.querySelector(".qa-stock").value,10)||0;
        var m=parseInt(row.querySelector(".qa-merma").value,10)||0;
        var c=parseInt(row.querySelector(".qa-cuar").value,10)||0;
        if(s+m+c>0)lines.push({sku:sku,toStock:s,toMerma:m,toQuarantine:c});
      });
      if(!lines.length){$("#ret-qa-err").textContent="Indica al menos una cantidad a disponer (stock, merma o cuarentena).";return;}
      var btn=this; btn.disabled=true;
      api('/sellers/'+seller+'/returns/'+ret.id+'/process',{method:'POST',body:{lines:lines,close:true}})
        .then(function(){closeModal();toast("Devolución registrada");loadSeller();})
        .catch(function(e){$("#ret-qa-err").textContent=e.message;btn.disabled=false;});
    });
  }
  function openReturnDetail(ret){
    if(!ret)return;
    var lines=ret.lines.map(function(l){return '<div class="kv"><span>'+esc(l.sku)+'</span><b>stock '+l.toStock+' · merma '+l.toMerma+' · cuar '+l.toQuarantine+' <span class="muted">(salió '+l.expectedQty+')</span></b></div>';}).join("");
    var hist=(ret.events||[]).map(function(e){return '<div class="kv"><span>'+esc(e.type)+'</span><b class="muted">'+esc(fmtDate(e.at))+(e.detail?' · '+esc(e.detail):'')+'</b></div>';}).join("");
    var html='<div class="form">'
      +'<div class="kv"><span>Estado</span><b>'+retChip(ret.status)+'</b></div>'
      +'<div class="kv"><span>Orden original</span><b>'+esc(ret.originalOrderRef||"—")+'</b></div>'
      +(ret.reason?'<div class="kv"><span>Motivo</span><b>'+esc(ret.reason)+'</b></div>':'')
      +'<p class="sec-t" style="margin:8px 0 2px">Disposición por producto</p>'+(lines||'<span class="muted">Sin disposición aún.</span>')
      +'<p class="sec-t" style="margin:10px 0 2px">Historial</p>'+hist
      +'<div class="acts"><span></span><button class="btn" id="rd-close">Cerrar</button></div>'
      +'</div>';
    openModal("Devolución "+esc(ret.id),html);
    $("#rd-close").addEventListener("click",closeModal);
  }

  var EVN={CREATED:"Creada",UPDATED:"Editada",ALLOCATED:"Reservada",PICKING:"En picking",PICKED:"Pickeada",PACKED:"Empacada",LABELED:"Etiquetada",SHIPPED:"Despachada",CANCELLED:"Cancelada",REACTIVATED:"Reactivada"};
  function fmtDate(s){try{return new Date(s).toLocaleString("es-CL",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit"});}catch(e){return s;}}
  function actorName(id){var u=byId(D.users,id);return u?u.name+" ("+u.email+")":(id==="system"?"Sistema":id);}
  function openOrder(o){
    if(!o)return;
    $("#dr-title").textContent="Orden "+(o.externalOrderId||o.id.slice(0,8));
    var st=o.shipTo||{};
    // Cada línea muestra el SKU y, DEBAJO, el nombre del producto.
    var lines=o.lines.map(function(l){
      var de=skuDesc(l.sku);
      return '<div class="ovline"><div><div class="ovl-sku">'+esc(l.sku)+'</div>'
        +(de?'<div class="ovl-de">'+esc(de)+'</div>':'')
        +(l.lot?'<div class="ovl-lot">Lote '+esc(l.lot)+'</div>':'')
        +'</div><div class="ovl-qty">'+l.qty+' un</div></div>';
    }).join("");
    var totalUn=o.lines.reduce(function(a,l){return a+l.qty;},0);
    var info='<div class="kv"><span>Estado</span><b><span class="chip st-'+o.status+'"><span class="dot"></span>'+STN[o.status]+'</span></b></div>'
      +'<div class="kv"><span>Canal</span><b>'+esc(CH_LABEL[o.salesChannel]||o.salesChannel)+'</b></div>'
      +'<div class="kv"><span>Tipo</span><b>'+esc((o.orderType||"").toUpperCase())+'</b></div>'
      +(o.documentType?'<div class="kv"><span>Documento</span><b>'+esc(DOC_LABEL[o.documentType]||o.documentType)+'</b></div>':'')
      +(o.carrier?'<div class="kv"><span>Courier</span><b>'+esc(o.carrier)+'</b></div>':'')
      +'<div class="kv"><span>Prioridad</span><b>'+esc(o.priority||"normal")+'</b></div>'
      +(st.name?'<div class="kv"><span>Destinatario</span><b>'+esc(st.name)+'</b></div>':'')
      +(st.comuna?'<div class="kv"><span>Comuna</span><b>'+esc(st.comuna)+'</b></div>':'')
      +(st.address?'<div class="kv"><span>Dirección</span><b>'+esc(st.address)+'</b></div>':'')
      +(o.purchaseOrderRef?'<div class="kv"><span>OC (B2B)</span><b>'+esc(o.purchaseOrderRef)+'</b></div>':'')
      +'<div class="kv"><span>Creada</span><b>'+esc(fmtDate(o.createdAt))+'</b></div>'
      // Deadline de preparación: cuándo se comprometió la salida y de dónde salió ese compromiso.
      +'<div class="kv"><span>Deadline</span><b>'+(o.dueAt
          ? esc(fmtDate(o.dueAt))+' <span class="muted" style="font-weight:400">('+esc(DL_LABEL[o.dueSource]||o.dueSource||'')+')</span><br>'+dlChip(o)
          : '<span class="muted" style="font-weight:400">sin compromiso</span>')
        +(can('order')&&['SHIPPED','CANCELLED'].indexOf(o.status)<0?' <button class="mini" id="dr-due" style="margin-left:6px">Cambiar</button>':'')
        +'</b></div>';
    var evs=(o.events||[]).slice().reverse();
    var hist=evs.length?('<ul class="tl">'+evs.map(function(e){
      return '<li><div class="te">'+esc(EVN[e.type]||e.type)+'</div><div class="tw">'+esc(fmtDate(e.at))+' · '+esc(actorName(e.actor))+'</div>'+(e.detail?'<div class="td">'+esc(e.detail)+'</div>':'')+'</li>';
    }).join("")+'</ul>'):'<p class="muted">Sin eventos registrados.</p>';
    var packBlock='';
    if(o.packing){
      packBlock='<p class="sec-t" style="margin:18px 0 6px">Empaque</p>'+packSummary(o.packing)+labelsGrid(o.packing)
        +(o.packing.labels&&o.packing.labels.length?'<div style="margin-top:8px"><button class="btn" id="dr-print-lbl">Imprimir etiquetas</button></div>':'');
    }
    // Vista HORIZONTAL de ancho fijo: a la izquierda los datos de la orden, a la
    // derecha las líneas y, bajo ellas, tareas e historial en dos columnas.
    $("#dr-body").innerHTML='<div class="ordv">'
      +'<div class="ordv-col left">'
        +'<p class="sec-t">Datos de la orden</p>'+info
        +packBlock
        +(o.shipment?'<p class="sec-t" style="margin:18px 0 6px">Despacho</p><div class="kv"><span>'+esc(o.shipment.mode)+'</span><b>'+esc((o.shipment.carrier||"")+" "+(o.shipment.trackingNumber||""))+'</b></div>':'')
      +'</div>'
      +'<div class="ordv-col">'
        +'<p class="sec-t">Líneas <span class="muted" style="font-weight:400">· '+o.lines.length+' producto(s) · '+totalUn+' unidades</span></p>'
        +'<div>'+lines+'</div>'
        +'<div class="ordv-split" style="margin-top:20px">'
          +'<div><p class="sec-t" style="margin:0 0 6px">Tareas</p><div id="dr-tasks" class="muted">Cargando…</div></div>'
          +'<div><p class="sec-t" style="margin:0 0 6px">Historial (auditoría)</p>'+hist+'</div>'
        +'</div>'
      +'</div>'
    +'</div>';
    if($("#dr-print-lbl"))$("#dr-print-lbl").addEventListener("click",function(){printLabels(o.packing);});
    if($("#dr-due"))$("#dr-due").addEventListener("click",function(){openDueForm(o);});
    renderOrderTasks(o.id);
    $("#drawer").classList.add("on");
  }
  /**
   * Cambia el deadline de una orden ya creada. Se puede en cualquier estado abierto:
   * que el courier mueva su hora de retiro no cambia las líneas ni el stock.
   */
  function openDueForm(o){
    var st=dlState(o.dueAt);
    openModal('Deadline de preparación · '+esc(o.externalOrderId||o.id.slice(0,8)),
      '<div class="form">'
      +'<p class="muted" style="margin:0 0 12px">Para cuándo esta orden tiene que estar lista para salir. Manda sobre la prioridad de courier en la cola de preparación.'
      +(o.dueAt?' Ahora: <b>'+esc(fmtDate(o.dueAt))+'</b> ('+esc(st.texto)+').':'')+'</p>'
      +'<div class="fld"><label>Fecha y hora del compromiso</label><input id="due-at" type="datetime-local" value="'+esc(isoToLocalInput(o.dueAt))+'"></div>'
      +'<div style="display:flex;gap:10px;justify-content:space-between;margin-top:14px">'
      +'<button class="btn" id="due-clear">Quitar deadline</button>'
      +'<div style="display:flex;gap:10px"><button class="btn" id="m-no">Cancelar</button><button class="btn pri" id="due-save">Guardar</button></div></div></div>');
    $("#m-no").addEventListener('click',closeModal);
    var send=function(iso){
      api('/sellers/'+seller+'/orders/'+o.id+'/due-date',{method:'PATCH',body:{dueAt:iso,source:'manual'}})
        .then(function(){ closeModal(); toast(iso?'Deadline actualizado':'Deadline quitado'); return loadSeller(); })
        .then(function(){ var f=byId(D.ord,o.id); if(f)openOrder(f); })
        .catch(function(e){ toast(e.message); });
    };
    $("#due-save").addEventListener('click',function(){ send(localInputToIso($("#due-at").value)); });
    $("#due-clear").addEventListener('click',function(){ send(null); });
  }

  var TASK_TYPE={RESERVE:"Reserva",PICK:"Picking",PACK:"Packing",SHIP:"Despacho",PUTAWAY:"Guardado",RESTOCK:"Reposición",RECEIVE:"Recepción",COUNT:"Conteo",RESLOT:"Re-slotting"};
  var TASK_STATE={pending:"Pendiente",assigned:"Asignada",in_progress:"En curso",done:"Hecha",cancelled:"Cancelada"};
  function renderOrderTasks(orderId){
    api('/sellers/'+seller+'/orders/'+orderId+'/tasks').then(function(tasks){
      var el=$("#dr-tasks"); if(!el)return;
      if(!tasks||!tasks.length){el.innerHTML='<span class="muted">Sin tareas registradas.</span>';return;}
      el.classList.remove("muted");
      el.innerHTML=tasks.slice().reverse().map(function(t){
        var who=t.operator?(" · "+actorName(t.operator)):"";
        return '<div class="kv"><span><b style="font-family:\'IBM Plex Mono\',monospace">'+esc(t.id)+'</b> · '+esc(TASK_TYPE[t.type]||t.type)+who+'</span><b>'+esc(TASK_STATE[t.state]||t.state)+'</b></div>';
      }).join("");
    }).catch(function(){var el=$("#dr-tasks");if(el)el.innerHTML='<span class="muted">No se pudieron cargar las tareas.</span>';});
  }
  function cancelOrder(id){
    var o=byId(D.ord,id)||{};
    // Se calcula desde las reservas de la orden qué está solo comprometido y qué ya
    // salió físicamente, para decirlo antes de cancelar en vez de después.
    var reservadas=0, recolectadas=0, porUbic={};
    (o.lines||[]).forEach(function(l){
      (l.allocations||[]).forEach(function(a){
        var pick=Math.max(0,Math.min(a.qty,a.pickedQty||0));
        reservadas+=a.qty-pick;
        if(pick>0){ recolectadas+=pick; porUbic[a.locationId]=(porUbic[a.locationId]||0)+pick; }
      });
    });
    var msg='La orden <b>'+esc(o.externalOrderId||id)+'</b> pasará a <b>Cancelada</b>. No se elimina: conserva su historial.';
    if(reservadas)msg+='<p style="margin:10px 0 0"><b>'+reservadas+' un</b> que estaban reservadas vuelven a disponible.</p>';
    if(recolectadas){
      var filas=Object.keys(porUbic).map(function(k){
        var l=locById&&locById[k];
        return '<div class="short-rec"><span class="rc">'+esc(l?l.code:k)+'</span><span class="rq">'+porUbic[k]+' un</span></div>';
      }).join('');
      msg+='<p style="margin:10px 0 4px"><b>'+recolectadas+' un</b> ya recolectadas se devuelven a las ubicaciones de las que salieron:</p>'
         +'<div class="short-recs">'+filas+'</div>'
         +'<p class="muted" style="margin:10px 0 0">Alguien tiene que reponerlas físicamente en esas ubicaciones.</p>';
    }
    if(o.packing)msg+='<p class="muted" style="margin:10px 0 0">La orden estaba empacada: los insumos de embalaje usados no se reponen.</p>';
    confirmBox("Cancelar orden",msg,"Sí, cancelar",function(){
      api('/sellers/'+seller+'/orders/'+id+'/cancel',{method:'POST'})
        .then(function(){toast(recolectadas?("Orden cancelada · "+recolectadas+" un devueltas a su ubicación"):"Orden cancelada");return loadSeller();})
        .catch(function(e){toast(e.message);});
    },true);
  }
  function reactivateOrder(id){
    confirmBox("Reactivar orden","Vuelve al flujo como <b>Ingresada</b>. Si antes tenía stock reservado, se intenta reservar de nuevo. Queda registrado en el historial de la orden y en el kardex, con tu usuario.","Reactivar",function(){
      api('/sellers/'+seller+'/orders/'+id+'/reactivate',{method:'POST'}).then(function(o){toast("Orden reactivada"+(o&&o.status==="ALLOCATED"?" y re-reservada":""));return loadSeller();}).catch(function(e){toast(e.message);});
    });
  }
  $("#dr-x").addEventListener("click",function(){$("#drawer").classList.remove("on");});
  $("#drawer").addEventListener("click",function(e){if(e.target===$("#drawer"))$("#drawer").classList.remove("on");});

  function recExpected(o){return (o.lines||[]).reduce(function(a,l){return a+(l.expectedQty||0);},0);}
  function recReceived(o){return (o.lines||[]).reduce(function(a,l){return a+(l.receivedQty||0);},0);}
  function recEstadoChip(o){
    if(o.status==="CANCELLED")return '<span class="chip st-RESERVED">Anulada</span>';
    if(o.status==="PENDING")return '<span class="loc-chip">Pendiente</span>';
    if(o.status==="PARTIAL")return '<span class="chip st-RESERVED"><span class="dot"></span>Parcial</span>';
    // RECEIVED: completa o cerrada con faltante
    var falta=recExpected(o)-recReceived(o);
    return '<span class="chip st-AVAILABLE"><span class="dot"></span>Recepcionada'+(falta>0?' · parcial':'')+'</span>';
  }
  function renderInbound(){
    $("#inb-new").classList.toggle("hidden",!can('receive')||!seller);
    if($("#inb-import"))$("#inb-import").classList.toggle("hidden",!can('receive')||!seller);
    var manage=can('receive');
    renderInbFilters();
    var filtered=(D.receipts||[]).filter(function(o){return inbFilter==="ALL"||o.status===inbFilter;});
    var list=sortRows('inbound',filtered,INB_COLS);
    $("#inb-body").innerHTML=list.length?list.map(function(o){
      var openForRecv=o.status==="PENDING"||o.status==="PARTIAL";
      var acts='<button class="mini" data-rview="'+esc(o.id)+'">Ver</button>'
        +'<button class="mini" data-rpdf="'+esc(o.id)+'">PDF</button>'
        +(manage&&openForRecv?'<button class="mini pri" data-rcotejo="'+esc(o.id)+'">Recepcionar</button>':'')
        +(manage&&o.status==="PENDING"?'<button class="mini" data-redit="'+esc(o.id)+'">Editar</button>':'')
        +(manage&&o.status==="PARTIAL"?'<button class="mini" data-rclose="'+esc(o.id)+'">Cerrar</button>':'')
        +(manage&&o.status!=="CANCELLED"?'<button class="mini danger" data-rdel="'+esc(o.id)+'">Eliminar</button>':'');
      var recibido=recReceived(o), esperado=recExpected(o);
      var uCol=o.status==="PENDING"?('<span class="muted">0 / '+esperado+'</span>'):(recibido+' / '+esperado);
      return '<tr class="click" data-rrow="'+esc(o.id)+'"><td class="mono2">'+esc(o.id)+'</td><td>'+esc(o.supplier||"—")+'</td><td>'+esc(o.reference||"—")+'</td>'
        +'<td class="muted" style="white-space:nowrap">'+esc(fmtDate(o.createdAt))+'</td><td><span class="loc-chip">'+esc(code(o.locationId))+'</span></td>'
        +'<td>'+(o.lines?o.lines.length:0)+'</td><td>'+recEstadoChip(o)+'</td><td class="num">'+uCol+'</td>'
        +'<td><div class="card-actions" style="justify-content:flex-end">'+acts+'</div></td></tr>';
    }).join(""):'<tr><td colspan="9" class="empty">Sin órdenes de recepción.</td></tr>';
    $$("#inb-body [data-rview]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();openReceiptView(recById(b.getAttribute("data-rview")));});});
    $$("#inb-body [data-rpdf]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();printReceiptManifest(recById(b.getAttribute("data-rpdf")));});});
    $$("#inb-body [data-rcotejo]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();openCotejoForm(recById(b.getAttribute("data-rcotejo")));});});
    $$("#inb-body [data-redit]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();openReceiveForm(recById(b.getAttribute("data-redit")));});});
    $$("#inb-body [data-rclose]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();confirmCloseReceipt(recById(b.getAttribute("data-rclose")));});});
    $$("#inb-body [data-rdel]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();confirmDeleteReceipt(recById(b.getAttribute("data-rdel")));});});
    $$("#inb-body tr[data-rrow]").forEach(function(tr){tr.addEventListener("click",function(e){if(e.target.closest("button"))return;openReceiptView(recById(tr.getAttribute("data-rrow")));});});
    paintSort('inbound');
  }
  function recById(id){return byId(D.receipts||[],id);}
  function recErrModal(title,msg){openModal(title,'<p class="muted" style="margin:0 0 16px">'+esc(msg)+'</p><div style="display:flex;justify-content:flex-end"><button class="btn" id="m-ok">Entendido</button></div>');$("#m-ok").addEventListener("click",closeModal);}
  function confirmDeleteReceipt(o){
    if(!o)return;
    var extra=recReceived(o)>0?" y se revertirá su stock recibido ("+recReceived(o)+" un) de la ubicación de recepción. Solo es posible si nada de esa recepción fue guardado o reservado.":".";
    openConfirm("Eliminar orden de recepción","Se eliminará la orden "+o.id+extra,function(){
      api('/sellers/'+seller+'/receipts/'+encodeURIComponent(o.id),{method:'DELETE'})
        .then(function(){toast("Recepción eliminada");return loadSeller();})
        .catch(function(e){recErrModal("No se pudo eliminar",e.message);});
    });
  }
  function confirmCloseReceipt(o){
    if(!o)return;
    var falta=recExpected(o)-recReceived(o);
    openConfirm("Cerrar recepción","Se cerrará la orden "+o.id+" como recepcionada"+(falta>0?(" con un faltante de "+falta+" un ("+recReceived(o)+"/"+recExpected(o)+" recibidas). El faltante quedará registrado."):" completa.")+" No se podrá recibir más contra esta orden.",function(){
      api('/sellers/'+seller+'/receipts/'+encodeURIComponent(o.id)+'/close',{method:'POST'})
        .then(function(){toast("Recepción cerrada");return loadSeller();})
        .catch(function(e){recErrModal("No se pudo cerrar",e.message);});
    });
  }
  // ----- Cotejo físico vs teórico -----
  function skuObj(sku){for(var i=0;i<(D.skus||[]).length;i++){if(D.skus[i].sku===sku)return D.skus[i];}return null;}
  function openCotejoForm(o){
    if(!o)return;
    var cards=(o.lines||[]).map(function(l){
      var pend=Math.max(0,(l.expectedQty||0)-(l.receivedQty||0));
      var sk=skuObj(l.sku), ser=!!(sk&&sk.serialControlled), lotc=!!(sk&&sk.lotControlled), expc=!!(sk&&sk.expiryControlled);
      var serBlock = ser
        ? '<div class="fld" style="margin-top:8px"><label>Números de serie <span class="ct-sercount" data-line="'+l.lineNo+'" style="font-weight:700"></span></label>'
          +'<textarea class="ct-serials" data-line="'+l.lineNo+'" rows="3" placeholder="Un número de serie por línea (o separados por coma)" style="width:100%;padding:8px;border-radius:9px;border:1px solid var(--line);background:var(--surface-2);color:var(--ink);font-family:monospace;font-size:12px"></textarea>'
          +'<div class="hint" style="margin-top:2px">Este SKU es serializado: la cantidad de series debe igualar la cantidad recibida.</div></div>'
        : '';
      return '<div class="card" data-cline="'+l.lineNo+'" style="padding:12px;margin-bottom:10px">'
        +'<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">'
          +'<div><b>'+esc(l.sku)+'</b> <span class="muted">'+esc(skuDesc(l.sku)||"")+'</span>'
          +(ser?' <span class="chip st-RESERVED" style="font-size:10px">SERIE</span>':'')
          +(lotc?' <span class="chip st-RESERVED" style="font-size:10px">LOTE</span>':'')
          +(expc?' <span class="chip st-RESERVED" style="font-size:10px">VENC.</span>':'')+'</div>'
          +'<div class="muted" style="font-size:12px">Esperado '+(l.expectedQty||0)+' · Ya recib. '+(l.receivedQty||0)+' · Pend. '+pend+'</div>'
        +'</div>'
        +'<div class="row3" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-top:8px">'
          +'<div class="fld"><label>Recibido ahora</label><input class="cotejo-in" data-line="'+l.lineNo+'" type="number" min="0" value="'+pend+'" style="width:100%"></div>'
          +'<div class="fld"><label>Lote'+(lotc?' <b style="color:var(--crit)">*</b>':'')+'</label><input class="ct-lot" data-line="'+l.lineNo+'" data-req="'+(lotc?1:0)+'" value="'+esc(l.lot||"")+'" placeholder="'+(lotc?'Obligatorio':'Lote (opc.)')+'"></div>'
          +'<div class="fld"><label>Vencimiento'+(expc?' <b style="color:var(--crit)">*</b>':'')+'</label><input class="ct-exp" data-line="'+l.lineNo+'" data-req="'+(expc?1:0)+'" type="date" value="'+esc(l.expiry?String(l.expiry).slice(0,10):"")+'"></div>'
        +'</div>'
        +serBlock
        +'</div>';
    }).join("");
    var html='<div class="form">'
      +'<p class="hint" style="margin:0 0 10px">Cuenta el físico recibido en esta entrega. Captura el lote y vencimiento reales; para SKUs serializados, ingresa los N° de serie. Al confirmar, ingresa al stock exactamente lo contado.</p>'
      +cards
      +'<div class="ferr" id="ct-err"></div>'
      +'<div class="acts"><span class="hint">'+esc(o.id)+' · '+esc(o.supplier||"proveedor")+'</span><div style="display:flex;gap:10px"><button class="btn" id="ct-cancel">Cancelar</button><button class="btn pri" id="ct-save">Confirmar recepción</button></div></div>'
      +'</div>';
    openModal("Recepcionar (cotejo) — "+o.id,html,true);
    // Contador vivo de series por línea (verde cuando iguala la cantidad).
    function parseSerials(txt){return (txt||"").split(/[\n,;]+/).map(function(s){return s.trim();}).filter(Boolean);}
    function refreshSerCount(line){
      var badge=$$('#m-body .ct-sercount').filter(function(b){return b.getAttribute('data-line')===String(line);})[0];
      if(!badge)return;
      var ta=$$('#m-body .ct-serials').filter(function(t){return t.getAttribute('data-line')===String(line);})[0];
      var qi=$$('#m-body .cotejo-in').filter(function(i){return i.getAttribute('data-line')===String(line);})[0];
      var n=parseSerials(ta?ta.value:"").length, q=parseInt(qi?qi.value:"0",10)||0;
      badge.textContent='('+n+' / '+q+')';
      badge.style.color = (n===q&&q>0) ? 'var(--good)' : 'var(--crit)';
    }
    $$('#m-body .ct-serials').forEach(function(ta){var ln=ta.getAttribute('data-line');ta.addEventListener('input',function(){refreshSerCount(ln);});refreshSerCount(ln);});
    $$('#m-body .cotejo-in').forEach(function(qi){var ln=qi.getAttribute('data-line');qi.addEventListener('input',function(){refreshSerCount(ln);});});
    $("#ct-cancel").addEventListener("click",closeModal);
    $("#ct-save").addEventListener("click",function(){
      $("#ct-err").textContent="";
      var counts=[], err="";
      $$("#m-body .cotejo-in").forEach(function(inp){
        var line=parseInt(inp.getAttribute("data-line"),10);
        var q=parseInt(inp.value,10);
        if(isNaN(q)||q<=0)return;
        var lotEl=$$('#m-body .ct-lot').filter(function(x){return x.getAttribute('data-line')===String(line);})[0];
        var expEl=$$('#m-body .ct-exp').filter(function(x){return x.getAttribute('data-line')===String(line);})[0];
        var serEl=$$('#m-body .ct-serials').filter(function(x){return x.getAttribute('data-line')===String(line);})[0];
        var c={lineNo:line,qty:q};
        if(lotEl&&lotEl.value.trim())c.lot=lotEl.value.trim();
        if(expEl&&expEl.value)c.expiry=expEl.value;
        if(lotEl&&lotEl.getAttribute('data-req')==='1'&&!(lotEl.value.trim())){err=err||("Falta el lote (obligatorio) en un SKU controlado por lote.");}
        if(expEl&&expEl.getAttribute('data-req')==='1'&&!expEl.value){err=err||("Falta el vencimiento (obligatorio) en un SKU controlado por vencimiento.");}
        if(serEl){
          var ss=parseSerials(serEl.value);
          if(ss.length!==q){err=err||("La línea de "+ (serEl.getAttribute('data-line')) +" requiere "+q+" N° de serie; ingresaste "+ss.length+".");}
          c.serials=ss;
        }
        counts.push(c);
      });
      if(!counts.length){$("#ct-err").textContent="Ingresa al menos una cantidad recibida (mayor a 0).";return;}
      if(err){$("#ct-err").textContent=err;return;}
      var btn=$("#ct-save"); btn.disabled=true;
      api('/sellers/'+seller+'/receipts/'+encodeURIComponent(o.id)+'/receive',{method:'POST',body:{counts:counts}})
        .then(function(r){closeModal();toast(r.status==="RECEIVED"?"Recepción completa":"Recepción parcial registrada");return loadSeller();})
        .catch(function(e){btn.disabled=false;$("#ct-err").textContent=e.message;});
    });
  }

  // ===== Insumos de embalaje (nivel bodega/operación) =====
  function canPkg(){return role==="PLATFORM_ADMIN"||role==="ADMIN"||role==="SUPERVISOR";}
  function renderPackaging(){
    var body=$("#pkg-body"); if(!body)return;
    if($("#pkg-new"))$("#pkg-new").classList.toggle("hidden",!canPkg());
    var rows=(D.packaging||[]);
    if(!rows.length){body.innerHTML='<tr><td colspan="10"><div class="empty">Aún no hay insumos de embalaje. Crea cajas, bolsas, cintas, etc. con "Nuevo insumo"; se consumen al empacar y se cobran al cliente.</div></td></tr>';return;}
    body.innerHTML=rows.map(function(m){
      var low=(m.onHand||0)<=0;
      var acts=canPkg()
        ? '<button class="mini" data-pkgedit="'+esc(m.sku)+'">Editar</button>'
          +'<button class="mini" data-pkgin="'+esc(m.sku)+'">＋ Reponer</button>'
          +'<button class="mini" data-pkgadj="'+esc(m.sku)+'">Ajuste</button>'
          +'<button class="mini" data-pkghist="'+esc(m.sku)+'">Historial</button>'
          +'<button class="mini" data-pkgprice="'+esc(m.sku)+'">Precios cliente</button>'
        : '<button class="mini" data-pkghist="'+esc(m.sku)+'">Historial</button>';
      var over=Object.keys(m.sellerPrices||{}).length;
      var cost=m.avgCost||0, margin=cost>0?Math.round((m.unitPrice-cost)/cost*100):null;
      return '<tr'+(m.active===false?' style="opacity:.55"':'')+'>'
        +'<td class="sku">'+esc(m.sku)+'</td>'
        +'<td class="mono2">'+esc(m.barcode||'—')+'</td>'
        +'<td>'+esc(m.name)+'</td>'
        +'<td style="text-align:right">'+(cost>0?fmtInt(cost):'<span class="hint" title="Registra el costo en la próxima reposición">sin costo</span>')+(m.lastCost!=null&&m.lastCost!==cost?' <span class="hint" title="Costo de la última reposición">(últ. '+fmtInt(m.lastCost)+')</span>':'')+'</td>'
        +'<td style="text-align:right">'+fmtInt(m.unitPrice)+(over?' <span class="hint">(+'+over+' cliente)</span>':'')+'</td>'
        +'<td style="text-align:right'+(margin!=null&&margin<0?';color:var(--crit)':'')+'">'+(margin!=null?(margin>0?'+':'')+margin+'%':'—')+'</td>'
        +'<td style="text-align:right'+(low?';color:var(--crit);font-weight:600':'')+'">'+fmtInt(m.onHand||0)+'</td>'
        +'<td style="text-align:right">'+(cost>0?'$'+fmtInt(m.stockValue||0):'—')+'</td>'
        +'<td><span class="chip st-'+(m.active===false?'CANCELLED':'AVAILABLE')+'"><span class="dot"></span>'+(m.active===false?'Inactivo':'Activo')+'</span></td>'
        +'<td style="text-align:right">'+acts+'</td></tr>';
    }).join("");
    if(canPkg()){
      $$("#pkg-body [data-pkgedit]").forEach(function(b){b.addEventListener("click",function(){openPkgForm(pkgBySku(b.getAttribute("data-pkgedit")));});});
      $$("#pkg-body [data-pkgin]").forEach(function(b){b.addEventListener("click",function(){openPkgStock(pkgBySku(b.getAttribute("data-pkgin")),'in');});});
      $$("#pkg-body [data-pkgadj]").forEach(function(b){b.addEventListener("click",function(){openPkgStock(pkgBySku(b.getAttribute("data-pkgadj")),'adj');});});
      $$("#pkg-body [data-pkgprice]").forEach(function(b){b.addEventListener("click",function(){openPkgPrices(pkgBySku(b.getAttribute("data-pkgprice")));});});
    }
    $$("#pkg-body [data-pkghist]").forEach(function(b){b.addEventListener("click",function(){openPkgHistory(pkgBySku(b.getAttribute("data-pkghist")));});});
  }
  var PKG_MV_LABEL={RECEIPT:"Reposición",CONSUMPTION:"Consumo (packing)",ADJUSTMENT:"Ajuste"};
  function openPkgHistory(m){
    if(!m)return;
    openModal("Historial · "+m.name,'<p class="muted" style="margin:0 0 10px">Cargando…</p>',true);
    api('/packaging/movements?materialSku='+encodeURIComponent(m.sku)+'&operationId='+encodeURIComponent(op)).then(function(movs){
      movs=(movs||[]).slice().sort(function(a,b){return String(b.occurredAt).localeCompare(String(a.occurredAt));});
      var saldo=movs.reduce(function(a,x){return a+(x.qtyDelta||0);},0);
      var repos=movs.filter(function(x){return x.type==='RECEIPT';});
      var invested=repos.reduce(function(a,x){return a+(x.unitCost!=null?x.qtyDelta*x.unitCost:0);},0);
      var head='<div class="apprv-box ok" style="margin-bottom:12px"><div class="apprv-t">Saldo actual: '+fmtInt(saldo)+' un.'+(m.avgCost>0?' · costo promedio $'+fmtInt(m.avgCost)+' · valor $'+fmtInt(Math.max(0,saldo)*m.avgCost):'')+'</div><div class="hint">'+repos.length+' reposición(es) · última: '+(repos.length?esc(fmtDate(repos[0].occurredAt))+' (+'+fmtInt(repos[0].qtyDelta)+(repos[0].unitCost!=null?' a $'+fmtInt(repos[0].unitCost):'')+')':'—')+(invested>0?' · total comprado $'+fmtInt(invested):'')+'</div></div>';
      var rows=movs.map(function(x){
        var who=x.sellerId?(byId(D.sellers,x.sellerId)||{}).name||x.sellerId:'';
        var det=[x.orderId?'Orden '+x.orderId:'',who,x.reference||''].filter(Boolean).join(' · ');
        var q=Math.abs(x.qtyDelta||0), costTxt=x.unitCost!=null?('$'+fmtInt(x.unitCost)+' <span class="hint">· $'+fmtInt(q*x.unitCost)+'</span>'):'—';
        if(x.type==='CONSUMPTION'&&x.unitPrice!=null)costTxt+='<div class="hint">cobrado $'+fmtInt(x.unitPrice)+'/un'+(x.unitCost!=null?' · margen $'+fmtInt(q*(x.unitPrice-x.unitCost)):'')+'</div>';
        return '<tr><td>'+esc(fmtDate(x.occurredAt))+'</td><td><span class="chip st-'+(x.type==='RECEIPT'?'AVAILABLE':x.type==='CONSUMPTION'?'RESERVED':'QUARANTINE')+'"><span class="dot"></span>'+esc(PKG_MV_LABEL[x.type]||x.type)+'</span></td><td style="text-align:right;font-weight:600;color:'+((x.qtyDelta||0)<0?'var(--crit)':'var(--good)')+'">'+((x.qtyDelta||0)>0?'+':'')+fmtInt(x.qtyDelta||0)+'</td><td style="text-align:right">'+costTxt+'</td><td class="muted">'+esc(det||'—')+'</td><td class="muted">'+esc(x.actor||'—')+'</td></tr>';
      }).join('');
      $("#m-body").innerHTML=head+(rows?'<div class="tablewrap" style="max-height:52vh;overflow:auto"><table class="m-skip"><thead><tr><th>Fecha</th><th>Tipo</th><th style="text-align:right">Cantidad</th><th style="text-align:right">Costo unit. · total</th><th>Detalle</th><th>Usuario</th></tr></thead><tbody>'+rows+'</tbody></table></div>':'<div class="empty">Este insumo aún no tiene movimientos.</div>')
        +'<div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn" id="ph-close">Cerrar</button></div>';
      $("#ph-close").addEventListener("click",closeModal);
    }).catch(function(e){$("#m-body").innerHTML='<div class="ferr">'+esc(e.message||'Error')+'</div>';});
  }
  function pkgBySku(sku){for(var i=0;i<(D.packaging||[]).length;i++){if(D.packaging[i].sku===sku)return D.packaging[i];}return null;}
  function pkgApi(path,opts){opts=opts||{};opts.body=opts.body||{};return api('/packaging'+path+(path.indexOf('?')<0?'?':'&')+'operationId='+encodeURIComponent(op),opts);}
  function openPkgForm(m){
    var isEdit=!!m;
    var html='<div class="form">'
      +(isEdit?'':'<div class="fld"><label>SKU del insumo</label><input id="pg-sku" placeholder="Ej: CAJA-M"></div>')
      +'<div class="fld"><label>Nombre</label><input id="pg-name" value="'+esc(isEdit?m.name:'')+'" placeholder="Ej: Caja mediana"></div>'
      +'<div class="row2"><div class="fld"><label>EAN / código (opcional)</label><input id="pg-ean" value="'+esc(isEdit?(m.barcode||''):'')+'" placeholder="Para escanear en packing"></div>'
      +'<div class="fld"><label>Precio por unidad (por defecto)</label><input id="pg-price" type="number" min="0" value="'+(isEdit?(m.unitPrice||0):0)+'"></div></div>'
      +(isEdit?'<label style="display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" id="pg-active" '+(m.active!==false?'checked':'')+' style="width:auto"> Activo</label>':'')
      +'<div class="ferr" id="pg-err"></div>'
      +'<div class="acts"><span class="hint">Insumo de bodega, compartido entre clientes.</span><div style="display:flex;gap:10px"><button class="btn" id="pg-cancel">Cancelar</button><button class="btn pri" id="pg-save">'+(isEdit?'Guardar':'Crear insumo')+'</button></div></div>'
      +'</div>';
    openModal(isEdit?"Editar insumo de embalaje":"Nuevo insumo de embalaje",html);
    $("#pg-cancel").addEventListener("click",closeModal);
    $("#pg-save").addEventListener("click",function(){
      $("#pg-err").textContent="";
      var name=$("#pg-name").value.trim(); if(!name){$("#pg-err").textContent="El nombre es obligatorio.";return;}
      var body={name:name,barcode:$("#pg-ean").value.trim()||undefined,unitPrice:parseInt($("#pg-price").value,10)||0};
      var p;
      if(isEdit){ if($("#pg-active"))body.active=$("#pg-active").checked; p=pkgApi('/'+encodeURIComponent(m.sku),{method:'PATCH',body:body}); }
      else { var sku=$("#pg-sku").value.trim(); if(!sku){$("#pg-err").textContent="El SKU es obligatorio.";return;} body.sku=sku; body.operationId=op; p=pkgApi('',{method:'POST',body:body}); }
      p.then(function(){closeModal();toast(isEdit?"Insumo actualizado":"Insumo creado");return loadPackaging();}).catch(function(e){$("#pg-err").textContent=e.message;});
    });
  }
  function openPkgStock(m,mode){
    if(!m)return;
    var isIn=mode==='in';
    var html='<div class="form">'
      +'<p class="muted" style="margin:0">'+esc(m.name)+' · saldo actual <b>'+fmtInt(m.onHand||0)+'</b></p>'
      +(isIn?'<div class="row2"><div class="fld"><label>Cantidad que ingresa (+)</label><input id="pg-qty" type="number" min="1" value="1"></div>'
          +'<div class="fld"><label>Costo unitario (CLP, neto)</label><input id="pg-cost" type="number" min="0" value="'+(m.lastCost!=null?m.lastCost:'')+'" placeholder="Ej: 320"><span class="hint" id="pg-costhint"></span></div></div>'
          +'<div class="fld"><label>Proveedor / N° guía o factura</label><input id="pg-ref" placeholder="Ej: Cartones Sur · Guía 4581" maxlength="200"></div>'
          +'<div class="apprv-box" id="pg-costbox" style="margin-top:-4px"><div class="apprv-t" id="pg-total">Total de la compra: —</div><div class="hint" id="pg-pmp">'+(m.avgCost>0?'Costo promedio actual: $'+fmtInt(m.avgCost)+' · precio de cobro: $'+fmtInt(m.unitPrice):'Aún sin costo registrado · precio de cobro: $'+fmtInt(m.unitPrice))+'</div></div>'
          +'<div class="hint" style="margin-top:-6px">La reposición queda en el historial con fecha, cantidad, costo, referencia y usuario. El costo promedio (PMP) se recalcula con cada ingreso y valoriza los consumos para la rentabilidad.</div>'
        :'<div class="fld"><label>Ajuste (+/−)</label><input id="pg-qty" type="number" value="0"></div>'
          +'<div class="fld"><label>Motivo del ajuste</label><input id="pg-ref" placeholder="Ej: merma por inventario" maxlength="200"></div>')
      +'<div class="ferr" id="pg-serr"></div>'
      +'<div class="acts"><span class="hint"></span><div style="display:flex;gap:10px"><button class="btn" id="pg-scancel">Cancelar</button><button class="btn pri" id="pg-sok">'+(isIn?'Registrar reposición':'Aplicar ajuste')+'</button></div></div>'
      +'</div>';
    openModal(isIn?("Reponer stock · "+m.name):("Ajustar stock · "+m.name),html);
    $("#pg-scancel").addEventListener("click",closeModal);
    if(isIn){
      var recalc=function(){
        var q=parseInt($("#pg-qty").value,10)||0, c=parseInt($("#pg-cost").value,10);
        if(!(q>0)||isNaN(c)){$("#pg-total").textContent="Total de la compra: —";$("#pg-costhint").textContent="";return;}
        $("#pg-total").textContent="Total de la compra: $"+fmtInt(q*c)+" ("+fmtInt(q)+" × $"+fmtInt(c)+")";
        var prev=Math.max(0,m.onHand||0), pmp=(prev>0&&m.avgCost>0)?Math.round((prev*m.avgCost+q*c)/(prev+q)):c;
        $("#pg-costhint").textContent="Nuevo costo promedio: $"+fmtInt(pmp)+(m.unitPrice>0&&pmp>0?" · margen "+Math.round((m.unitPrice-pmp)/pmp*100)+"%":"");
      };
      $("#pg-qty").addEventListener("input",recalc);$("#pg-cost").addEventListener("input",recalc);recalc();
    }
    $("#pg-sok").addEventListener("click",function(){
      $("#pg-serr").textContent="";
      var qty=parseInt($("#pg-qty").value,10);
      if(isIn&&!(qty>0)){$("#pg-serr").textContent="Ingresa una cantidad mayor que 0.";return;}
      if(!isIn&&(!qty||qty===0)){$("#pg-serr").textContent="El ajuste debe ser distinto de 0.";return;}
      var ref=($("#pg-ref")&&$("#pg-ref").value.trim())||undefined;
      var payload={qty:qty,reference:ref};
      if(isIn){var c=$("#pg-cost").value.trim(); if(c===""){$("#pg-serr").textContent="Ingresa el costo unitario de la compra (puede ser 0 si fue sin costo).";return;} var cn=parseInt(c,10); if(isNaN(cn)||cn<0){$("#pg-serr").textContent="El costo unitario debe ser un número mayor o igual a 0.";return;} payload.unitCost=cn;}
      pkgApi('/'+encodeURIComponent(m.sku)+(isIn?'/receive':'/adjust'),{method:'POST',body:payload})
        .then(function(){closeModal();toast(isIn?"Reposición registrada (+"+qty+")":"Ajuste aplicado");return loadPackaging();})
        .catch(function(e){$("#pg-serr").textContent=e.message;});
    });
  }
  function openPkgPrices(m){
    if(!m)return;
    var sellers=(D.sellers||[]);
    var rows=sellers.map(function(s){
      var ov=(m.sellerPrices||{})[s.id];
      return '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><div style="flex:1">'+esc(s.name)+'</div>'
        +'<input class="pg-sp" data-seller="'+esc(s.id)+'" type="number" min="0" value="'+(ov!=null?ov:'')+'" placeholder="'+fmtInt(m.unitPrice)+' (defecto)" style="width:140px"></div>';
    }).join("");
    var html='<div class="form">'
      +'<p class="muted" style="margin:0">Precio de <b>'+esc(m.name)+'</b> por cliente. Vacío = usa el precio por defecto ('+fmtInt(m.unitPrice)+').</p>'
      +'<div style="max-height:320px;overflow:auto">'+(rows||'<div class="hint">No hay clientes en esta operación.</div>')+'</div>'
      +'<div class="ferr" id="pg-perr"></div>'
      +'<div class="acts"><span class="hint"></span><div style="display:flex;gap:10px"><button class="btn" id="pg-pcancel">Cancelar</button><button class="btn pri" id="pg-pok">Guardar precios</button></div></div>'
      +'</div>';
    openModal("Precios por cliente · "+m.name,html);
    $("#pg-pcancel").addEventListener("click",closeModal);
    $("#pg-pok").addEventListener("click",function(){
      var calls=[];
      $$('#m-body .pg-sp').forEach(function(inp){
        var sid=inp.getAttribute('data-seller'); var raw=inp.value.trim();
        var ov=(m.sellerPrices||{})[sid];
        if(raw===''){ if(ov!=null)calls.push(pkgApi('/'+encodeURIComponent(m.sku)+'/seller-price',{method:'POST',body:{sellerId:sid,price:null}})); }
        else { var v=parseInt(raw,10); if(v>=0&&v!==ov)calls.push(pkgApi('/'+encodeURIComponent(m.sku)+'/seller-price',{method:'POST',body:{sellerId:sid,price:v}})); }
      });
      $("#pg-pok").disabled=true;
      Promise.all(calls).then(function(){closeModal();toast("Precios actualizados");return loadPackaging();}).catch(function(e){$("#pg-pok").disabled=false;$("#pg-perr").textContent=e.message;});
    });
  }

  // ===== Mantenedor de Productos (SKUs + kits) =====
  var prInit=false, prQ="", prKit=[];
  var PLA={CREADO:'Creado',EDITADO:'Editado',ACTIVADO:'Activado',DESACTIVADO:'Desactivado',ARMADO:'Kit armado',PACK:'Empaque'};
  function prBySku(code){var a=D.skus||[];for(var i=0;i<a.length;i++){if(a[i].sku===code)return a[i];}return null;}
  function prTipo(s){
    if(!s.isKit)return '<span class="loc-chip">Simple</span>';
    return '<span class="chip st-AVAILABLE"><span class="dot"></span>Kit · '+(s.kitMode==='VIRTUAL'?'virtual':'armado')+'</span>';
  }
  function exportProducts(){
    if(!seller){toast("Selecciona un cliente primero");return;}
    var h={}; if(token)h['Authorization']='Bearer '+token;
    fetch(API+'/sellers/'+seller+'/product-import/export',{headers:h})
      .then(function(r){if(!r.ok)throw new Error('No se pudo exportar ('+r.status+').');return r.blob();})
      .then(function(b){var u=URL.createObjectURL(b);var a=document.createElement('a');a.href=u;a.download='productos-ninjawms.xlsx';document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(function(){URL.revokeObjectURL(u);},1500);toast("Productos exportados");})
      .catch(function(e){toast(e.message);});
  }
  function openProductImport(){
    if(!seller){toast("Selecciona un cliente primero");return;}
    var piB64="";
    var html='<div class="form" style="gap:14px">'
      +'<p class="muted" style="margin:0">Carga o edita productos en masa con Excel. Los productos <b>nuevos</b> se crean; los <b>existentes</b> se editan — pero primero verás exactamente qué atributos cambian y deberás confirmar antes de guardar.</p>'
      +'<div><button class="btn" id="pi-tpl">⬇ Descargar formato Excel</button></div>'
      +'<div class="fld"><label>Archivo de productos (.xlsx o .csv)</label><input type="file" id="pi-file" accept=".xlsx,.xls,.csv"></div>'
      +'<div class="ferr" id="pi-err"></div>'
      +'<div id="pi-result"></div>'
      +'<div class="acts"><span class="hint">Nada se guarda hasta que confirmes.</span><div style="display:flex;gap:10px"><button class="btn" id="pi-cancel">Cerrar</button><button class="btn pri" id="pi-analyze">Analizar cambios</button></div></div>'
      +'</div>';
    openModal("Carga masiva de productos",html,true);
    $("#pi-cancel").addEventListener("click",closeModal);
    $("#pi-tpl").addEventListener("click",function(){
      $("#pi-err").textContent="";
      var h={}; if(token)h['Authorization']='Bearer '+token;
      fetch(API+'/sellers/'+seller+'/product-import/template',{headers:h}).then(function(r){if(!r.ok)throw new Error('No se pudo generar la plantilla');return r.blob();}).then(function(b){var u=URL.createObjectURL(b);var a=document.createElement('a');a.href=u;a.download='plantilla-productos-ninjawms.xlsx';document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(function(){URL.revokeObjectURL(u);},1500);toast("Formato descargado");}).catch(function(e){$("#pi-err").textContent=e.message;});
    });
    function renderPreview(j){
      var box=$("#pi-result");
      if(!j||j.ok===false){box.innerHTML='<div class="apprv-box warn"><div class="apprv-t">No se pudo analizar el archivo</div><div class="hint">'+esc((j&&j.error)||'Error')+'</div></div>';return;}
      var r=j.resumen||{};
      var html='<div class="apprv-box '+(((r.nuevos||0)+(r.modificar||0))>0?'ok':'warn')+'"><div class="apprv-t">'+(r.nuevos||0)+' nuevo(s) · '+(r.modificar||0)+' a modificar</div><div class="hint">'+(r.sinCambios||0)+' sin cambios · '+(r.errores||0)+' con error</div></div>';
      if(j.toCreate&&j.toCreate.length){html+='<div style="margin-top:12px"><p class="sec-t" style="margin:0 0 4px">Productos nuevos</p>'+j.toCreate.map(function(c){return '<div class="hint">• <b>'+esc(c.sku)+'</b> — '+esc(c.description)+'</div>';}).join('')+'</div>';}
      if(j.toUpdate&&j.toUpdate.length){html+='<div style="margin-top:12px"><p class="sec-t" style="margin:0 0 4px">Modificaciones — revisa antes de confirmar</p>'+j.toUpdate.map(function(u){return '<div style="border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:6px"><b class="mono2">'+esc(u.sku)+'</b>'+u.changes.map(function(c){return '<div class="hint">'+esc(c.campo)+': <span style="color:var(--crit)">'+esc(c.de)+'</span> → <span style="color:var(--good)">'+esc(c.a)+'</span></div>';}).join('')+'</div>';}).join('')+'</div>';}
      if(j.errors&&j.errors.length){html+='<div style="margin-top:12px"><p class="sec-t" style="margin:0 0 4px">Errores (esas filas se omiten)</p>'+j.errors.map(function(e){return '<div class="hint">Fila '+esc(e.fila)+': '+esc(e.motivo)+'</div>';}).join('')+'</div>';}
      if(((r.nuevos||0)+(r.modificar||0))>0){html+='<div style="margin-top:14px;display:flex;justify-content:flex-end"><button class="btn pri" id="pi-commit">Confirmar y cargar ('+((r.nuevos||0)+(r.modificar||0))+')</button></div>';}
      box.innerHTML=html;
      if($("#pi-commit"))$("#pi-commit").addEventListener("click",function(){
        var btn=this; btn.disabled=true; btn.textContent="Cargando…";
        api('/sellers/'+seller+'/product-import/commit',{method:'POST',body:{dataBase64:piB64}}).then(function(res){
          var rr=res.resumen||{};
          toast((rr.creados||0)+" creado(s), "+(rr.modificados||0)+" modificado(s)");
          box.innerHTML='<div class="apprv-box ok"><div class="apprv-t">Listo: '+(rr.creados||0)+' creado(s) · '+(rr.modificados||0)+' modificado(s)</div><div class="hint">'+(rr.errores||0)+' con error</div></div>';
          loadSeller();
        }).catch(function(e){btn.disabled=false;btn.textContent="Confirmar y cargar";$("#pi-err").textContent=e.message;});
      });
    }
    $("#pi-analyze").addEventListener("click",function(){
      $("#pi-err").textContent=""; $("#pi-result").innerHTML="";
      var inp=$("#pi-file"); var f=inp&&inp.files&&inp.files[0];
      if(!f){$("#pi-err").textContent="Elige un archivo primero.";return;}
      var btn=this; btn.disabled=true; btn.textContent="Analizando…";
      var rd=new FileReader();
      rd.onload=function(){
        piB64=String(rd.result||"").split(',')[1]||"";
        api('/sellers/'+seller+'/product-import/preview',{method:'POST',body:{dataBase64:piB64}}).then(function(j){renderPreview(j);}).catch(function(e){$("#pi-err").textContent=e.message;}).then(function(){btn.disabled=false;btn.textContent="Analizar cambios";});
      };
      rd.onerror=function(){$("#pi-err").textContent="No se pudo leer el archivo.";btn.disabled=false;btn.textContent="Analizar cambios";};
      rd.readAsDataURL(f);
    });
  }
  function renderProducts(){
    if(!$("#pr-body"))return;
    if(!prInit){ prInit=true;
      $("#pr-new").addEventListener("click",function(){openProductForm(null);});
      $("#pr-q").addEventListener("input",function(){prQ=this.value.trim().toLowerCase();renderProducts();});
      if($("#pr-export"))$("#pr-export").addEventListener("click",exportProducts);
      if($("#pr-import"))$("#pr-import").addEventListener("click",openProductImport);
    }
    if($("#pr-import"))$("#pr-import").classList.toggle("hidden",!can('product'));
    var manage=can('product');
    var list=(D.skus||[]).slice().filter(function(s){return !prQ||s.sku.toLowerCase().indexOf(prQ)>=0||(s.description||'').toLowerCase().indexOf(prQ)>=0;})
      .sort(function(a,b){return a.sku<b.sku?-1:1;});
    $("#pr-body").innerHTML=list.length?list.map(function(s){
      var estado=s.active!==false?'<span class="chip st-AVAILABLE"><span class="dot"></span>Activo</span>':'<span class="chip st-RESERVED">Inactivo</span>';
      var acts=(manage?'<button class="mini" data-pedit="'+esc(s.sku)+'">Editar</button>'
        +'<button class="mini" data-ptoggle="'+esc(s.sku)+'">'+(s.active!==false?'Desactivar':'Activar')+'</button>'
        :'')
        +'<button class="mini" data-plog="'+esc(s.sku)+'">Historial</button>';
      return '<tr><td class="sku">'+esc(s.sku)+'</td><td>'+esc(s.description||'')+'</td><td>'+prTipo(s)+'</td><td class="mono2">'+esc(s.barcode||'—')+'</td><td>'+estado+'</td>'
        +'<td><div class="card-actions" style="justify-content:flex-end">'+acts+'</div></td></tr>';
    }).join(""):'<tr><td colspan="6" class="empty">Sin productos. Crea el primero con “Nuevo producto”.</td></tr>';
    $$("#pr-body [data-pedit]").forEach(function(b){b.addEventListener("click",function(){openProductForm(prBySku(b.getAttribute("data-pedit")));});});
    $$("#pr-body [data-ptoggle]").forEach(function(b){b.addEventListener("click",function(){var s=prBySku(b.getAttribute("data-ptoggle"));toggleProduct(s);});});
    $$("#pr-body [data-plog]").forEach(function(b){b.addEventListener("click",function(){openProductLog(b.getAttribute("data-plog"));});});
  }
  function toggleProduct(s){
    if(!s)return;
    var next=!(s.active!==false);
    api('/sellers/'+seller+'/products/'+encodeURIComponent(s.sku),{method:'PATCH',body:{active:next}})
      .then(function(){toast(next?'Producto activado':'Producto desactivado');return loadSeller();})
      .catch(function(e){recErrModal("No se pudo actualizar",e.message);});
  }
  function prCompOptions(sel,selfSku){
    return (D.skus||[]).filter(function(x){return !x.isKit&&x.sku!==selfSku;})
      .map(function(x){return '<option value="'+esc(x.sku)+'"'+(x.sku===sel?' selected':'')+'>'+esc(x.sku)+' — '+esc(x.description||'')+'</option>';}).join("");
  }
  function prFirstComp(selfSku){var a=(D.skus||[]).filter(function(x){return !x.isKit&&x.sku!==selfSku;});return (a[0]||{}).sku||'';}
  function renderKitRows(selfSku){
    var host=$("#pf-comps"); if(!host)return;
    host.innerHTML=prKit.length?prKit.map(function(c,i){
      return '<div class="recline" style="grid-template-columns:2.2fr .8fr 30px">'
        +'<div class="rc"><select data-kc="sku" data-i="'+i+'">'+prCompOptions(c.sku,selfSku)+'</select></div>'
        +'<div class="rc"><input data-kc="qty" data-i="'+i+'" type="number" min="1" value="'+(c.qty||1)+'"></div>'
        +'<button type="button" class="mini danger" data-kdel="'+i+'">✕</button></div>';
    }).join(""):'<p class="hint">Agrega al menos un componente.</p>';
    $$("#pf-comps [data-kc]").forEach(function(el){el.addEventListener("input",function(){var i=+el.getAttribute("data-i"),k=el.getAttribute("data-kc");prKit[i][k]=el.value;});});
    $$("#pf-comps [data-kdel]").forEach(function(b){b.addEventListener("click",function(){prKit.splice(+b.getAttribute("data-kdel"),1);renderKitRows(selfSku);});});
  }
  function openProductForm(existing){
    if(!seller){toast("Selecciona un cliente primero");return;}
    var isEdit=!!existing, self=isEdit?existing.sku:'';
    prKit = isEdit&&existing.components?existing.components.map(function(c){return {sku:c.sku,qty:c.qty};}):[];
    var rotOpts=['A','B','C'].map(function(r){return '<option value="'+r+'"'+(((isEdit?existing.rotationClass:'B'))===r?' selected':'')+'>'+r+'</option>';}).join("");
    var isKit=isEdit?!!existing.isKit:false, kmode=isEdit&&existing.kitMode?existing.kitMode:'VIRTUAL';
    var html='<div class="form">'
      +'<div class="row2"><div class="fld"><label>Código SKU</label><input id="pf-sku" value="'+esc(self)+'" '+(isEdit?'disabled':'placeholder="Ej: POL-BL-M"')+'></div>'
      +'<div class="fld"><label>EAN / código de barras</label><input id="pf-ean" value="'+esc(isEdit?(existing.barcode||''):'')+'" placeholder="Opcional"></div></div>'
      +'<div class="fld"><label>Descripción</label><input id="pf-desc" value="'+esc(isEdit?(existing.description||''):'')+'" placeholder="Ej: Polera blanca M"></div>'
      +'<div class="fld"><label>Clase de rotación</label><select id="pf-rot">'+rotOpts+'</select></div>'
      +'<div class="row2"><div class="fld"><label>Control de lote</label><select id="pf-lot"><option value="no"'+(isEdit&&existing.lotControlled?'':' selected')+'>No</option><option value="si"'+(isEdit&&existing.lotControlled?' selected':'')+'>Sí</option></select></div>'
      +'<div class="fld"><label>Control de serie</label><select id="pf-serial"><option value="no"'+(isEdit&&existing.serialControlled?'':' selected')+'>No</option><option value="si"'+(isEdit&&existing.serialControlled?' selected':'')+'>Sí — captura N° de serie en recepción</option></select></div></div>'
      +'<div class="fld"><label>Control de vencimiento</label><select id="pf-expiry"><option value="no"'+(isEdit&&existing.expiryControlled?'':' selected')+'>No</option><option value="si"'+(isEdit&&existing.expiryControlled?' selected':'')+'>Sí — exige vencimiento en recepción</option></select><span class="hint">Con "Control de lote" o "Control de vencimiento" en Sí, la recepción obliga a capturar ese dato.</span></div>'
      +'<div class="fld"><label style="display:flex;gap:8px;align-items:center;cursor:pointer;font-weight:600"><input type="checkbox" id="pf-iskit" '+(isKit?'checked':'')+' style="width:18px;height:18px"> Este producto es un <span style="color:var(--primary-ink)">kit</span> (compuesto por otros SKUs)</label></div>'
      +'<div id="pf-kit" class="'+(isKit?'':'hidden')+'" style="border:1px solid var(--line);border-radius:10px;padding:13px;background:var(--surface-2)">'
        +'<div class="fld"><label>Modo del kit</label><select id="pf-kmode"><option value="VIRTUAL"'+(kmode==='VIRTUAL'?' selected':'')+'>Virtual — se explota en sus componentes al vender</option><option value="ASSEMBLED"'+(kmode==='ASSEMBLED'?' selected':'')+'>Armado — tiene stock propio, se ensambla en bodega</option></select></div>'
        +'<label class="hint" style="display:block;margin:8px 0 4px">Componentes — SKU · cantidad por kit</label>'
        +'<div id="pf-comps"></div>'
        +'<button type="button" class="btn" id="pf-addcomp" style="margin-top:6px">＋ Agregar componente</button>'
      +'</div>'
      +'<div class="ferr" id="pf-err"></div>'
      +'<div class="acts"><span class="hint">'+(isEdit?'Los cambios quedan en el historial auditable.':'Se registra en el historial.')+'</span><div style="display:flex;gap:10px"><button class="btn" id="pf-cancel">Cancelar</button><button class="btn pri" id="pf-save">'+(isEdit?'Guardar cambios':'Crear producto')+'</button></div></div>'
      +'</div>';
    openModal(isEdit?('Editar producto '+existing.sku):'Nuevo producto',html,true);
    renderKitRows(self);
    $("#pf-iskit").addEventListener("change",function(){$("#pf-kit").classList.toggle("hidden",!this.checked);if(this.checked&&!prKit.length){prKit=[{sku:prFirstComp(self),qty:1}];renderKitRows(self);}});
    $("#pf-addcomp").addEventListener("click",function(){prKit.push({sku:prFirstComp(self),qty:1});renderKitRows(self);});
    $("#pf-cancel").addEventListener("click",closeModal);
    $("#pf-save").addEventListener("click",function(){
      $("#pf-err").textContent="";
      var body={}, isKitNow=$("#pf-iskit").checked;
      if(!isEdit){body.sku=$("#pf-sku").value.trim();if(!body.sku){$("#pf-err").textContent="El código SKU es obligatorio.";return;}}
      body.description=$("#pf-desc").value.trim();if(!body.description){$("#pf-err").textContent="La descripción es obligatoria.";return;}
      var ean=$("#pf-ean").value.trim();if(ean)body.barcode=ean;
      body.rotationClass=$("#pf-rot").value;
      body.lotControlled=$("#pf-lot").value==='si';
      body.serialControlled=$("#pf-serial")?$("#pf-serial").value==='si':false;
      body.expiryControlled=$("#pf-expiry")?$("#pf-expiry").value==='si':false;
      body.isKit=isKitNow;
      if(isKitNow){
        body.kitMode=$("#pf-kmode").value;
        var comps=[];
        for(var i=0;i<prKit.length;i++){var c=prKit[i],s=(c.sku||'').trim(),q=num(c.qty);
          if(!s){$("#pf-err").textContent="Falta el SKU en un componente.";return;}
          if(!q||q<1){$("#pf-err").textContent="Cantidad inválida en un componente.";return;}
          comps.push({sku:s,qty:q});}
        if(!comps.length){$("#pf-err").textContent="Un kit necesita al menos un componente.";return;}
        body.components=comps;
      } else { body.isKit=false; body.kitMode=null; body.components=[]; }
      var path='/sellers/'+seller+'/products'+(isEdit?'/'+encodeURIComponent(existing.sku):'');
      api(path,{method:isEdit?'PATCH':'POST',body:body})
        .then(function(){closeModal();toast(isEdit?'Producto actualizado':'Producto creado');return loadSeller();})
        .catch(function(e){$("#pf-err").textContent=e.message;});
    });
  }
  function openAssembleForm(s){
    if(!s)return;
    var dests=(D.locations||[]).filter(function(l){return (l.zoneType==='STORAGE'||l.zoneType==='PICKING')&&l.active!==false;});
    var opts=dests.map(function(l){return '<option value="'+esc(l.id)+'">'+esc(l.code)+' · '+esc(zoneName(l.zoneType))+'</option>';}).join("");
    // Buckets disponibles por componente (el usuario elige de dónde sale cada uno).
    var comps=(s.components||[]).map(function(c){
      var buckets=(D.inv||[]).filter(function(b){return b.sku===c.sku&&b.state==='AVAILABLE'&&b.qty>0;})
        .map(function(b){return {locationId:b.locationId,lot:b.lot||'',avail:b.qty,take:0};});
      return {sku:c.sku,per:c.qty,buckets:buckets};
    });
    function qtyNow(){return num($("#as-qty").value)||0;}
    function renderRows(){
      var q=qtyNow();
      $("#as-comps").innerHTML=comps.map(function(c,ci){
        var req=c.per*q, assigned=c.buckets.reduce(function(a,b){return a+(b.take||0);},0);
        var totalAvail=c.buckets.reduce(function(a,b){return a+b.avail;},0);
        var head='<div style="display:flex;justify-content:space-between;align-items:baseline;margin:2px 0 6px"><b class="sku">'+esc(c.sku)+'</b>'
          +'<span class="hint">requiere <b id="as-req-'+ci+'">'+req+'</b> · asignado <b id="as-asg-'+ci+'" style="color:'+(assigned===req?'var(--good)':'var(--crit)')+'">'+assigned+'</b>'
          +(totalAvail<req?' · <span style="color:var(--crit)">falta stock ('+totalAvail+' disp.)</span>':'')+'</span></div>';
        var rows=c.buckets.length?c.buckets.map(function(b,bi){
          return '<div class="recline" style="grid-template-columns:1.5fr .7fr 1fr">'
            +'<div class="rc" style="align-self:center"><span class="loc-chip">'+esc(code(b.locationId))+'</span>'+(b.lot?(' <span class="hint">lote '+esc(b.lot)+'</span>'):'')+'</div>'
            +'<div class="rc hint" style="align-self:center">disp. '+b.avail+'</div>'
            +'<div class="rc"><input data-ac="'+ci+'" data-bc="'+bi+'" type="number" min="0" max="'+b.avail+'" value="'+(b.take||0)+'" placeholder="tomar"></div></div>';
        }).join(""):'<p class="hint" style="color:var(--crit)">Sin stock disponible de este componente.</p>';
        return '<div style="border:1px solid var(--line);border-radius:10px;padding:11px 12px;background:var(--surface-2);margin-bottom:8px">'+head+rows+'</div>';
      }).join("");
      $$("#as-comps [data-ac]").forEach(function(inp){inp.addEventListener("input",function(){var ci=+inp.getAttribute("data-ac"),bi=+inp.getAttribute("data-bc");comps[ci].buckets[bi].take=parseInt(inp.value,10)||0;updateState();});});
    }
    function updateState(){
      var q=qtyNow(), ok=q>0;
      comps.forEach(function(c,ci){
        var req=c.per*q, assigned=c.buckets.reduce(function(a,b){return a+(b.take||0);},0);
        var el=$("#as-asg-"+ci); if(el){el.textContent=assigned;el.style.color=assigned===req?'var(--good)':'var(--crit)';}
        var rq=$("#as-req-"+ci); if(rq)rq.textContent=req;
        if(assigned!==req)ok=false;
        c.buckets.forEach(function(b){if((b.take||0)>b.avail)ok=false;});
      });
      $("#as-save").disabled=!ok;
    }
    var html='<div class="form">'
      +'<div class="row2"><div class="fld"><label>Kit a armar</label><input value="'+esc(s.sku+(s.description?' — '+s.description:''))+'" disabled></div>'
      +'<div class="fld"><label>Cantidad a armar</label><input id="as-qty" type="number" min="1" value="1"></div></div>'
      +'<div class="fld"><label>Ubicación destino del kit</label><select id="as-dest">'+opts+'</select></div>'
      +'<label class="hint" style="display:block;margin:8px 0 2px">Elige de qué ubicación sale cada componente — debe cuadrar exacto:</label>'
      +'<div id="as-comps"></div>'
      +'<div class="ferr" id="as-err"></div>'
      +'<div class="acts"><span class="hint">El sistema no asume el origen: tú confirmas cada extracción.</span><div style="display:flex;gap:10px"><button class="btn" id="as-cancel">Cancelar</button><button class="btn pri" id="as-save" disabled>Armar kit</button></div></div></div>';
    openModal('Armar kit '+s.sku,html,true);
    renderRows(); updateState();
    $("#as-qty").addEventListener("input",function(){renderRows();updateState();});
    $("#as-cancel").addEventListener("click",closeModal);
    $("#as-save").addEventListener("click",function(){
      $("#as-err").textContent="";
      var q=qtyNow(), d=$("#as-dest").value;
      if(!q||q<1){$("#as-err").textContent="Cantidad inválida.";return;}
      if(!d){$("#as-err").textContent="Elige una ubicación destino.";return;}
      var sources=[];
      comps.forEach(function(c){c.buckets.forEach(function(b){if((b.take||0)>0){var src={sku:c.sku,locationId:b.locationId,qty:b.take};if(b.lot)src.lot=b.lot;sources.push(src);}});});
      if(!sources.length){$("#as-err").textContent="Asigna las extracciones de cada componente.";return;}
      api('/sellers/'+seller+'/products/'+encodeURIComponent(s.sku)+'/assemble',{method:'POST',body:{qty:q,toLocationId:d,sources:sources}})
        .then(function(){closeModal();toast("Kit armado ("+q+")");return loadSeller();})
        .catch(function(e){$("#as-err").textContent=e.message;});
    });
  }
  // ----- Página "Armado de kit": lista de kits armables + historial auditable -----
  function renderAssembly(){
    if(!$("#asm-kits"))return;
    var kits=(D.skus||[]).filter(function(s){return s.isKit&&s.kitMode==='ASSEMBLED';});
    $("#asm-kits").innerHTML=kits.length?kits.map(function(s){
      var recipe=(s.components||[]).map(function(c){return esc(c.sku)+' ×'+c.qty;}).join(', ');
      var stock=(D.inv||[]).filter(function(b){return b.sku===s.sku;}).reduce(function(a,b){return a+b.qty;},0);
      return '<tr><td class="sku">'+esc(s.sku)+'</td><td>'+esc(s.description||'')+'</td><td class="hint">'+recipe+'</td><td class="num">'+stock+'</td>'
        +'<td><div class="card-actions" style="justify-content:flex-end"><button class="mini pri" data-asm="'+esc(s.sku)+'">Armar</button></div></td></tr>';
    }).join(""):'<tr><td colspan="5" class="empty">No hay kits de tipo “armado”. Créalos en Productos.</td></tr>';
    $$("#asm-kits [data-asm]").forEach(function(b){b.addEventListener("click",function(){openAssembleForm(prBySku(b.getAttribute("data-asm")));});});
    api('/sellers/'+seller+'/products/assemblies').then(function(rows){
      if(!$("#asm-hist"))return;
      $("#asm-hist").innerHTML=rows.length?rows.map(function(r){
        var src=(r.sources||[]).map(function(x){return esc(x.sku)+' ×'+x.qty+' @ '+esc(code(x.locationId))+(x.lot?(' ('+esc(x.lot)+')'):'');}).join('<br>');
        return '<tr><td class="muted" style="white-space:nowrap">'+esc(fmtDate(r.at))+'</td><td class="sku">'+esc(r.kitSku)+'</td><td class="num">'+r.qty+'</td><td><span class="loc-chip">'+esc(code(r.toLocationId))+'</span></td><td class="hint">'+src+'</td><td>'+esc(r.actor)+'</td></tr>';
      }).join(""):'<tr><td colspan="6" class="empty">Sin armados registrados aún.</td></tr>';
    }).catch(function(){});
  }
  function openProductLog(sku){
    var path='/sellers/'+seller+'/products'+(sku?'/'+encodeURIComponent(sku):'')+'/log';
    openModal(sku?('Historial · '+sku):'Historial de productos','<div id="plog"><p class="hint">Cargando…</p></div>',true);
    api(path).then(function(rows){
      $("#plog").innerHTML=rows.length?('<div style="display:flex;flex-direction:column;gap:8px;max-height:60vh;overflow:auto">'+rows.map(function(e){
        return '<div style="border-left:3px solid var(--primary);padding:7px 12px;background:var(--surface-2);border-radius:8px"><b>'+esc(PLA[e.action]||e.action)+'</b> · <span class="mono2">'+esc(e.sku)+'</span><div class="hint">'+esc(fmtDate(e.at))+' · '+esc(e.actor)+(e.detail?(' · '+esc(e.detail)):'')+'</div></div>';
      }).join("")+'</div>'):'<p class="hint">Sin cambios registrados.</p>';
    }).catch(function(e){$("#plog").innerHTML='<p class="ferr">'+esc(e.message)+'</p>';});
  }

  // ===== Facturación 3PL =====
  var billInit=false, billList=[];
  function fmtMoney(n,cur){try{return (n||0).toLocaleString('es-CL')+' '+(cur||'CLP');}catch(e){return (n||0)+' '+(cur||'CLP');}}
  function fmtBytes(n){n=n||0;if(n<1024)return n+' B';if(n<1048576)return (n/1024).toFixed(1)+' KB';return (n/1048576).toFixed(1)+' MB';}
  function monthName(m){return ['','Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'][m]||m;}
  function fmtPeriod(fromISO){try{var d=new Date(fromISO);return monthName(d.getUTCMonth()+1)+' '+d.getUTCFullYear();}catch(e){return fromISO;}}
  function num0(v){var n=parseInt(v,10);return isNaN(n)?0:n;}
  function billActive(){var p=document.querySelector('.page[data-pg="billing"]');return p&&p.classList.contains('on');}
  function fillRate(r){r=r||{};$("#rt-fixed").value=r.fixedMonthly||0;$("#rt-storage").value=r.storagePerUnitMonth||0;$("#rt-receipt").value=r.receiptPerUnit||0;$("#rt-ship").value=r.shipmentPerOrder||0;$("#rt-pick").value=r.pickPerUnit||0;$("#rt-asm").value=r.assemblyPerKit||0;$("#rt-cur").textContent=r.currency||'CLP';if($("#rt-approval"))$("#rt-approval").checked=!!r.requiresApproval;}
  function billTab(which){
    $$("#bill-tabs .segbtn").forEach(function(b){b.classList.toggle("on",b.getAttribute("data-billtab")===which);});
    if($("#bill-dash"))$("#bill-dash").classList.toggle("on",which==="dash");
    if($("#bill-invoices-view"))$("#bill-invoices-view").classList.toggle("on",which==="inv");
    if(which==="dash")renderBillingDash();
  }
  function renderBilling(){
    var manage=can('billing'), approve=can('billappr');
    if(!$("#bill-invoices")||(!manage&&!approve))return;
    // El bloque de tarifario + generar factura es solo para el staff (manage).
    if($("#bill-manage"))$("#bill-manage").style.display=manage?'':'none';
    if($("#bill-cli-note"))$("#bill-cli-note").style.display=manage?'none':'';
    // Las pestañas (Resumen/Facturas) solo para staff; el cliente ve solo sus facturas.
    if($("#bill-tabs"))$("#bill-tabs").style.display=manage?'':'none';
    if(!manage){ if($("#bill-dash"))$("#bill-dash").classList.remove("on"); if($("#bill-invoices-view"))$("#bill-invoices-view").classList.add("on"); }
    if(manage&&!billInit){ billInit=true;
      var ms=''; for(var m=1;m<=12;m++)ms+='<option value="'+m+'">'+monthName(m)+'</option>';
      $("#bl-month").innerHTML=ms;
      try{$("#bl-month").value=String(new Date().getMonth()+1);$("#bl-year").value=String(new Date().getFullYear());}catch(e){}
      $("#rt-save").addEventListener("click",saveRate);
      $("#bl-preview").addEventListener("click",function(){doInvoice(false);});
      $("#bl-gen").addEventListener("click",function(){doInvoice(true);});
      $$("#bill-tabs .segbtn").forEach(function(b){b.addEventListener("click",function(){billTab(b.getAttribute("data-billtab"));});});
      $("#bd-year").addEventListener("change",renderBillDashView);
      $("#bd-month").addEventListener("change",renderBillDashView);
      billTab("dash"); // el staff entra al Resumen
    }
    if($("#bill-cli"))$("#bill-cli").textContent=(byId(D.sellers,seller)||{}).name||seller||'';
    if(!billActive())return;
    if(manage)api('/sellers/'+seller+'/billing/rate').then(function(r){fillRate(r);}).catch(function(){});
    api('/sellers/'+seller+'/billing/invoices').then(function(list){renderInvoiceList(list);}).catch(function(){});
    // Si estamos en la pestaña Resumen, refrescar el dashboard.
    if(manage&&$("#bill-dash")&&$("#bill-dash").classList.contains("on"))renderBillingDash();
  }
  function saveRate(){
    $("#rt-err").textContent="";
    var body={fixedMonthly:num0($("#rt-fixed").value),storagePerUnitMonth:num0($("#rt-storage").value),receiptPerUnit:num0($("#rt-receipt").value),shipmentPerOrder:num0($("#rt-ship").value),pickPerUnit:num0($("#rt-pick").value),assemblyPerKit:num0($("#rt-asm").value),requiresApproval:!!($("#rt-approval")&&$("#rt-approval").checked)};
    api('/sellers/'+seller+'/billing/rate',{method:'PATCH',body:body}).then(function(){toast("Tarifas guardadas");}).catch(function(e){$("#rt-err").textContent=e.message;});
  }
  function invStatusPill(inv){
    var clip=inv.taxDocument?' <span class="pill neutral" title="Documento tributario: '+esc(inv.taxDocument.fileName)+'">📎</span>':'';
    if(inv.status==='INVOICED')return '<span class="pill ok">Facturado</span>'+clip;
    var sub='';
    if(inv.status==='APPROVED')sub=' <span class="pill ok">Aprobada</span>';
    else if(inv.status==='PENDING')sub=' <span class="pill warn">Pend. aprob.</span>';
    return '<span class="pill neutral">Pre-factura</span>'+sub+clip;
  }
  // base64 (posible data: URI) → Blob del tipo indicado.
  function b64ToBlob(b64,mime){
    var clean=(b64||'').replace(/^data:[^,]*,/,'');
    var bin=atob(clean), len=bin.length, arr=new Uint8Array(len);
    for(var i=0;i<len;i++)arr[i]=bin.charCodeAt(i);
    return new Blob([arr],{type:mime||'application/octet-stream'});
  }
  // Abre/descarga un documento tributario (lo trae del backend y crea un blob).
  function downloadTaxDoc(inv){
    if(!inv||!inv.taxDocument)return;
    toast("Abriendo documento…");
    api('/sellers/'+seller+'/billing/invoices/'+encodeURIComponent(inv.id)+'/tax-document')
      .then(function(d){
        var blob=b64ToBlob(d.contentBase64,d.mimeType);
        var url=URL.createObjectURL(blob);
        var w=window.open(url,'_blank');
        if(!w){ // popup bloqueado → forzar descarga
          var a=document.createElement('a');a.href=url;a.download=d.fileName||'documento';document.body.appendChild(a);a.click();a.remove();
        }
        setTimeout(function(){URL.revokeObjectURL(url);},60000);
      }).catch(function(e){toast(e.message);});
  }

  // ===== Dashboard de facturación (staff): consolidado + por cliente + por concepto =====
  var bdData=null;
  function conceptColor(concept){
    var idx=bdData?bdData.concepts.indexOf(concept):-1;
    if(idx<0)return 'var(--ink-3)';
    return idx<8?('var(--cat-'+(idx+1)+')'):'var(--ink-3)';
  }
  function pctOf(part,total){return total>0?Math.round(part/total*1000)/10:0;}
  function dbars(el,rows,total,showPct){
    var max=Math.max.apply(null,rows.map(function(r){return r.amount;}).concat([1]));
    el.innerHTML=rows.length?rows.map(function(r){
      var w=Math.max(2,Math.round(r.amount/max*100));
      var pct=showPct?'<span class="pct">'+pctOf(r.amount,total)+'%</span>':'';
      var sw=r.color?'<span class="sw" style="background:'+r.color+'"></span>':'';
      return '<div class="dbar-row"><div class="dcap">'+sw+esc(r.cap)+'</div><div class="dbar-track"><div class="dbar-fill" style="width:'+w+'%;background:'+(r.color||'var(--primary)')+'"></div></div>'
        +'<div class="dbar-val">'+fmtMoney(r.amount,bdData?bdData.currency:'CLP')+pct+'</div></div>';
    }).join(""):'<div class="empty">Sin datos en el alcance.</div>';
  }
  function renderBillingDash(){
    if(!can('billing')||!op)return;
    api('/operations/'+op+'/billing/dashboard').then(function(d){
      bdData=d;
      // Poblar años a partir de las facturas.
      var years={}; (d.invoices||[]).forEach(function(iv){years[iv.period.slice(0,4)]=1;});
      var ys=Object.keys(years).sort(function(a,b){return b-a;});
      var cur=$("#bd-year").value;
      var opts='<option value="all">Todos</option>'+ys.map(function(y){return '<option value="'+y+'">'+y+'</option>';}).join("");
      $("#bd-year").innerHTML=opts;
      if(cur&&(cur==='all'||years[cur]))$("#bd-year").value=cur; else $("#bd-year").value=ys.length?ys[0]:'all';
      if(!$("#bd-month").options.length){
        var ms='<option value="all">Todos</option>'; for(var m=1;m<=12;m++)ms+='<option value="'+m+'">'+monthName(m)+'</option>';
        $("#bd-month").innerHTML=ms; $("#bd-month").value='all';
      }
      renderBillDashView();
    }).catch(function(e){toast(e.message);});
  }
  function renderBillDashView(){
    if(!bdData)return;
    var yr=$("#bd-year").value, mo=$("#bd-month").value;
    var inScope=function(period){
      if(yr!=='all'&&period.slice(0,4)!==yr)return false;
      if(mo!=='all'&&String(parseInt(period.slice(5,7),10))!==mo)return false;
      return true;
    };
    var lines=(bdData.lines||[]).filter(function(l){return inScope(l.period);});
    var invs=(bdData.invoices||[]).filter(function(iv){return inScope(iv.period);});
    var scopeTxt=(yr==='all'?'Todos los años':yr)+(mo==='all'?' · todos los meses':' · '+monthName(parseInt(mo,10)));
    $("#bd-scope").textContent=scopeTxt;
    var empty=invs.length===0;
    $("#bd-empty").style.display=empty?'':'none';
    $("#bd-content").style.display=empty?'none':'';
    if(empty){$("#bd-kpis").innerHTML='';return;}

    var total=invs.reduce(function(a,iv){return a+iv.total;},0);
    var clientsBilled={}; invs.forEach(function(iv){clientsBilled[iv.sellerId]=1;});
    var nClients=Object.keys(clientsBilled).length;
    var nInv=invs.length;
    var approved=invs.filter(function(iv){return iv.status==='APPROVED';}).length;
    var pending=invs.filter(function(iv){return iv.status==='PENDING';}).length;
    var invoiced=invs.filter(function(iv){return iv.status==='INVOICED';}).length;
    var ticket=nInv?Math.round(total/nInv):0;
    var kpis=[
      {l:"Facturación total",v:fmtMoney(total,bdData.currency),d:scopeTxt},
      {l:"Documentos",v:nInv,d:invoiced+" facturados · "+(nInv-invoiced)+" pre-facturas"},
      {l:"Clientes facturados",v:nClients,d:"con facturación en el alcance"},
      {l:"Ticket promedio",v:fmtMoney(ticket,bdData.currency),d:"por documento"},
      {l:"% Facturado",v:(nInv?Math.round(invoiced/nInv*100):0)+"%",d:invoiced+" con documento tributario"}
    ];
    $("#bd-kpis").innerHTML=kpis.map(function(x){return '<div class="kpi"><div class="l">'+x.l+'</div><div class="v">'+x.v+'</div><div class="d">'+esc(x.d)+'</div></div>';}).join("");

    // Composición por concepto (consolidado).
    var byConcept={}; lines.forEach(function(l){byConcept[l.concept]=(byConcept[l.concept]||0)+l.amount;});
    var concepts=bdData.concepts.filter(function(c){return byConcept[c];});
    var compRows=concepts.map(function(c){return {cap:c,amount:byConcept[c],color:conceptColor(c)};}).sort(function(a,b){return b.amount-a.amount;});
    $("#bd-comp-total").textContent="Total "+fmtMoney(total,bdData.currency);
    // Barra apilada 100%.
    $("#bd-stack").innerHTML=compRows.map(function(r){var w=pctOf(r.amount,total);return '<div class="stackseg" title="'+esc(r.cap)+': '+fmtMoney(r.amount,bdData.currency)+' ('+w+'%)" style="width:'+w+'%;background:'+r.color+'"></div>';}).join("");
    dbars($("#bd-comp"),compRows,total,true);

    // Tendencia por período.
    var trendRows, trendCap;
    if(yr==='all'){
      var byYear={}; invs.forEach(function(iv){var y=iv.period.slice(0,4);byYear[y]=(byYear[y]||0)+iv.total;});
      trendRows=Object.keys(byYear).sort().map(function(y){return {cap:y,amount:byYear[y]};});
      trendCap="por año";
    } else {
      var byMonth={}; invs.forEach(function(iv){var m=parseInt(iv.period.slice(5,7),10);byMonth[m]=(byMonth[m]||0)+iv.total;});
      trendRows=[]; for(var m=1;m<=12;m++){ if(mo==='all'||String(m)===mo){ trendRows.push({cap:monthName(m).slice(0,3),amount:byMonth[m]||0}); } }
      trendCap=(mo==='all')?("meses de "+yr):(monthName(parseInt(mo,10))+" "+yr);
    }
    $("#bd-trend-cap").textContent=trendCap;
    dbars($("#bd-trend"),trendRows,total,false);

    // Matriz cliente × concepto (+ Total; fila Consolidado).
    var clients=bdData.clients.filter(function(c){return clientsBilled[c.sellerId];});
    var cell={}; lines.forEach(function(l){cell[l.sellerId+'|'+l.concept]=(cell[l.sellerId+'|'+l.concept]||0)+l.amount;});
    var head='<tr><th>Cliente</th>'+concepts.map(function(c){return '<th class="num"><span class="sw" style="background:'+conceptColor(c)+'"></span>'+esc(c)+'</th>';}).join("")+'<th class="num">Total</th></tr>';
    $("#bd-mx-head").innerHTML=head;
    var colTot={}; concepts.forEach(function(c){colTot[c]=0;});
    var body=clients.map(function(cl){
      var rowTot=0;
      var tds=concepts.map(function(c){var v=cell[cl.sellerId+'|'+c]||0;rowTot+=v;colTot[c]+=v;return '<td class="num'+(v?'':' z')+'">'+(v?fmtMoney(v,bdData.currency):'—')+'</td>';}).join("");
      return '<tr><td>'+esc(cl.name)+'</td>'+tds+'<td class="num"><b>'+fmtMoney(rowTot,bdData.currency)+'</b></td></tr>';
    }).join("");
    $("#bd-mx-body").innerHTML=body;
    var foot='<tr><td>Consolidado</td>'+concepts.map(function(c){return '<td class="num">'+fmtMoney(colTot[c],bdData.currency)+'</td>';}).join("")+'<td class="num">'+fmtMoney(total,bdData.currency)+'</td></tr>';
    $("#bd-mx-foot").innerHTML=foot;
  }
  function doInvoice(persist){
    var y=parseInt($("#bl-year").value,10), m=parseInt($("#bl-month").value,10);
    if(!y||!m)return;
    if(persist){
      // Alerta de duplicado: ¿ya existe una factura de este mismo período para este cliente?
      var dups=(billList||[]).filter(function(inv){return periodOf(inv.periodFrom)===(y+'-'+pad2(m));});
      if(dups.length){
        var lbl=fmtPeriod(y+'-'+pad2(m)+'-01T00:00:00.000Z');
        confirmBox('Factura duplicada',
          'Ya existe '+(dups.length>1?dups.length+' facturas':'una factura')+' para <b>'+esc(lbl)+'</b> ('+dups.map(function(d){return esc(d.number||d.id);}).join(', ')+').<br><br>¿Quieres emitir otra factura para el mismo período de todas formas?',
          'Emitir otra', function(){genInvoice(y,m);});
        return;
      }
      genInvoice(y,m);
    } else {
      api('/sellers/'+seller+'/billing/preview?year='+y+'&month='+m)
        .then(function(inv){$("#bl-preview-box").innerHTML=invoicePreviewHTML(inv);}).catch(function(e){$("#bl-preview-box").innerHTML='<p class="ferr">'+esc(e.message)+'</p>';});
    }
  }
  function pad2(n){return (n<10?'0':'')+n;}
  function periodOf(fromISO){try{var d=new Date(fromISO);return d.getUTCFullYear()+'-'+pad2(d.getUTCMonth()+1);}catch(e){return String(fromISO).slice(0,7);}}
  function genInvoice(y,m){
    api('/sellers/'+seller+'/billing/invoices',{method:'POST',body:{year:y,month:m}})
      .then(function(inv){toast("Factura generada: "+(inv.number||inv.id));$("#bl-preview-box").innerHTML='';openInvoice(inv);return api('/sellers/'+seller+'/billing/invoices');})
      .then(function(list){renderInvoiceList(list);}).catch(function(e){toast(e.message);});
  }
  function invoicePreviewHTML(inv){
    var rows=(inv.lines||[]).map(function(l){return '<tr><td>'+esc(l.concept)+'</td><td class="hint">'+l.qty+' '+esc(l.unit)+' × '+fmtMoney(l.rate,inv.currency)+'</td><td class="num">'+fmtMoney(l.amount,inv.currency)+'</td></tr>';}).join("")||'<tr><td colspan="3" class="empty">Sin cargos en el período (configura tarifas o revisa el mes).</td></tr>';
    return '<div class="tablewrap"><table class="cotejo-tbl"><thead><tr><th>Concepto</th><th>Detalle</th><th class="num">Monto</th></tr></thead><tbody>'+rows+'</tbody><tfoot><tr><td colspan="2" class="num">Total</td><td class="num"><b>'+fmtMoney(inv.total,inv.currency)+'</b></td></tr></tfoot></table></div>';
  }
  function renderInvoiceList(list){
    billList=list||[];
    var canEdit=can('billing'), canApprove=can('billappr');
    $("#bill-invoices").innerHTML=billList.length?billList.map(function(inv){
      var numCell=(inv.number&&inv.number!==inv.id)?'<b>'+esc(inv.number)+'</b><div class="hint mono2">'+esc(inv.id)+'</div>':'<span class="mono2">'+esc(inv.id)+'</span>';
      var sent=(inv.sends&&inv.sends.length)?' <span class="pill ok" title="Enviada por correo '+esc(inv.sends.length)+' vez(es)">✉ '+esc(inv.sends.length)+'</span>':'';
      var acts='<button class="mini" data-invv="'+esc(inv.id)+'">Ver</button><button class="mini" data-invp="'+esc(inv.id)+'">PDF</button>';
      if(inv.taxDocument)acts+='<button class="mini" data-invdoc="'+esc(inv.id)+'" title="Ver el documento tributario adjunto">📎 Documento</button>';
      if(canApprove&&inv.status==='PENDING')acts+='<button class="mini" style="color:var(--good);border-color:var(--good)" data-inva="'+esc(inv.id)+'">Aprobar</button>';
      if(canEdit){
        if(inv.status!=='INVOICED'){
          acts+='<button class="mini" style="color:var(--good);border-color:var(--good)" data-invfac="'+esc(inv.id)+'">Facturar</button>';
          acts+='<button class="mini" data-inve="'+esc(inv.id)+'">Editar</button>';
        } else {
          acts+='<button class="mini" data-invunfac="'+esc(inv.id)+'" title="Quitar el documento y volver a Pre-factura">Deshacer</button>';
        }
        acts+='<button class="mini danger" data-invd="'+esc(inv.id)+'">Eliminar</button>';
      }
      return '<tr class="click" data-inv="'+esc(inv.id)+'"><td>'+numCell+'</td><td>'+esc(fmtPeriod(inv.periodFrom))+sent+'</td><td class="muted">'+esc(fmtDate(inv.createdAt))+'</td><td>'+esc(inv.createdBy)+'</td><td>'+invStatusPill(inv)+'</td><td class="num">'+fmtMoney(inv.total,inv.currency)+'</td>'
        +'<td><div class="card-actions" style="justify-content:flex-end;flex-wrap:wrap">'+acts+'</div></td></tr>';
    }).join(""):'<tr><td colspan="7" class="empty">Aún no hay facturas emitidas.</td></tr>';
    $$("#bill-invoices [data-invv]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();openInvoice(byId(billList,b.getAttribute("data-invv")));});});
    $$("#bill-invoices [data-invp]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();printInvoice(byId(billList,b.getAttribute("data-invp")));});});
    $$("#bill-invoices [data-invdoc]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();downloadTaxDoc(byId(billList,b.getAttribute("data-invdoc")));});});
    $$("#bill-invoices [data-invfac]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();openFacturarModal(byId(billList,b.getAttribute("data-invfac")));});});
    $$("#bill-invoices [data-invunfac]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();confirmRemoveTaxDoc(byId(billList,b.getAttribute("data-invunfac")));});});
    $$("#bill-invoices [data-inva]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();confirmApproveInvoice(byId(billList,b.getAttribute("data-inva")));});});
    $$("#bill-invoices [data-inve]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();openInvoiceEdit(byId(billList,b.getAttribute("data-inve")));});});
    $$("#bill-invoices [data-invd]").forEach(function(b){b.addEventListener("click",function(e){e.stopPropagation();confirmDeleteInvoice(byId(billList,b.getAttribute("data-invd")));});});
    $$("#bill-invoices tr[data-inv]").forEach(function(tr){tr.addEventListener("click",function(e){if(e.target.closest("button"))return;openInvoice(byId(billList,tr.getAttribute("data-inv")));});});
  }
  function approveInvoice(inv){
    if(!inv)return;
    api('/sellers/'+seller+'/billing/invoices/'+encodeURIComponent(inv.id)+'/approve',{method:'POST'})
      .then(function(updated){toast("Factura aprobada");replaceInvoice(updated);if($("#modal").classList.contains('on'))openInvoice(updated);})
      .catch(function(e){toast(e.message);});
  }
  function confirmApproveInvoice(inv){
    if(!inv)return;
    confirmBox('Aprobar factura',
      'Vas a aprobar la factura <b>'+esc(inv.number||inv.id)+'</b> ('+esc(fmtPeriod(inv.periodFrom))+', total '+esc(fmtMoney(inv.total,inv.currency))+').<br><br>Quedará registrada tu aprobación con la fecha y hora.',
      'Aprobar factura', function(){approveInvoice(inv);});
  }
  // Marca del documento (white-label): logo/nombre de la operación, o Ninja por defecto.
  function brandDocHead(){
    var b=D.brand||{};
    // Nombre a mostrar como título del documento: nombre de fantasía, luego razón
    // social, y solo si la operación no configuró NINGUNO se usa el de Ninja Hubs.
    var docName=b.companyName||b.legalName||'Ninja Hubs · WMS';
    if(b.logoDataUri)return '<img src="'+b.logoDataUri+'" alt="'+esc(docName)+'" style="max-height:46px;max-width:230px;display:block">';
    return '<div class="mf-brand">'+esc(docName)+'</div>';
  }
  function brandEmisor(){
    var b=D.brand||{};var head=[];
    // Si no hay nombre de fantasía, la razón social ya se usó como título del
    // documento (brandDocHead), así que no la repetimos en la línea de emisor.
    if(b.legalName&&b.companyName)head.push(b.legalName); if(b.taxId)head.push('RUT '+b.taxId); if(b.address)head.push(b.address);
    var c=[]; if(b.email)c.push(b.email); if(b.phone)c.push(b.phone); if(b.website)c.push(b.website);
    return head.concat(c).join(' · ');
  }
  function invoiceDocHTML(inv){
    var sellerName=(byId(D.sellers,seller)||{}).name||inv.sellerId;
    var opName=(byId(D.ops,op)||{}).name||op;
    var rows=(inv.lines||[]).map(function(l,i){return '<tr><td>'+(i+1)+'</td><td>'+esc(l.concept)+'</td><td class="r">'+l.qty+' '+esc(l.unit)+'</td><td class="r">'+fmtMoney(l.rate,inv.currency)+'</td><td class="r">'+fmtMoney(l.amount,inv.currency)+'</td></tr>';}).join("")||'<tr><td colspan="5" class="r">Sin cargos en el período.</td></tr>';
    var facturado=inv.status==='INVOICED';
    var estado=facturado?'Facturado':(inv.status==='APPROVED'?('Pre-factura · Aprobada'+(inv.approval?' · '+esc(inv.approval.by)+' · '+esc(fmtDate(inv.approval.at)):'')):(inv.status==='PENDING'?'Pre-factura · Pendiente de aprobación':'Pre-factura'));
    var docNote=inv.taxDocument?('<div class="mf-notes" style="border-left-color:#1f7a44"><span>Documento tributario asociado:</span> '+esc(inv.taxDocument.fileName)+' ('+fmtBytes(inv.taxDocument.size)+') — adjuntado por '+esc(inv.taxDocument.uploadedBy)+' el '+esc(fmtDate(inv.taxDocument.uploadedAt))+'.</div>'):'';
    return '<div class="manifest">'
      +'<div class="mf-head"><div>'+brandDocHead()+'<div class="mf-sub">'+(facturado?'Factura de servicios 3PL':'Pre-factura de servicios 3PL')+'</div>'+(brandEmisor()?'<div class="mf-sub" style="margin-top:1px">'+esc(brandEmisor())+'</div>':'')+'</div><div class="mf-id"><div class="mf-idn">'+esc(inv.number||inv.id)+'</div><div class="mf-st">'+(facturado?'FACTURADO · ':'PRE-FACTURA · ')+esc(fmtPeriod(inv.periodFrom))+((inv.number&&inv.number!==inv.id)?' · '+esc(inv.id):'')+'</div></div></div>'
      +'<div class="mf-grid"><div><span>Operación</span><b>'+esc(opName)+'</b></div><div><span>Cliente</span><b>'+esc(sellerName)+'</b></div><div><span>Período</span><b>'+esc(fmtPeriod(inv.periodFrom))+'</b></div><div><span>Emitida</span><b>'+esc(fmtDate(inv.createdAt))+'</b></div><div><span>Estado</span><b>'+estado+'</b></div></div>'
      +'<table class="mf-tbl"><thead><tr><th>#</th><th>Concepto</th><th class="r">Cantidad</th><th class="r">Tarifa</th><th class="r">Monto</th></tr></thead><tbody>'+rows+'</tbody>'
      +'<tfoot><tr><td colspan="4" class="r">Total</td><td class="r"><b>'+fmtMoney(inv.total,inv.currency)+'</b></td></tr></tfoot></table>'
      +docNote
      +'<div class="mf-notes"><span>Nota:</span> Documento de cálculo de servicios logísticos del período (almacenamiento, recepción, despacho, picking y armado). Referencial — el documento tributario válido es el archivo adjunto.</div>'
      +'</div>';
  }
  function openInvoice(inv){
    if(!inv)return;
    var editable=can('billing'), canApprove=can('billappr');
    var facturado=inv.status==='INVOICED';
    // Estado de aprobación (visible para ambos: 3PL y cliente).
    var apprv='';
    if(facturado){
      apprv='<div class="apprv-box ok"><div class="apprv-t">✓ Facturado</div><div class="hint">Documento tributario adjunto'+(inv.taxDocument?' el '+esc(fmtDate(inv.taxDocument.uploadedAt)):'')+'. Visible para el cliente en su módulo de facturación.</div></div>';
    } else if(inv.status==='APPROVED'&&inv.approval){
      apprv='<div class="apprv-box ok"><div class="apprv-t">✓ Pre-factura aprobada por el cliente</div><div class="hint">Aprobada por <b>'+esc(inv.approval.by)+'</b> el '+esc(fmtDate(inv.approval.at))+'</div></div>';
    } else if(inv.status==='PENDING'){
      apprv='<div class="apprv-box warn"><div class="apprv-t">⏳ Pre-factura · pendiente de aprobación del cliente</div><div class="hint">'+(canApprove?'Puedes aprobarla con el botón de abajo.':'El cliente debe aprobarla desde su portal.')+'</div></div>';
    }
    // Documento tributario (visible para 3PL y cliente).
    var docBox='';
    if(inv.taxDocument){
      docBox='<div class="apprv-box ok" style="margin-top:12px"><div class="apprv-t">📎 Documento tributario</div>'
        +'<div class="hint">'+esc(inv.taxDocument.fileName)+' · '+fmtBytes(inv.taxDocument.size)+' · adjuntado por '+esc(inv.taxDocument.uploadedBy)+' el '+esc(fmtDate(inv.taxDocument.uploadedAt))+'</div>'
        +'<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="m-doc">Ver / descargar documento</button>'
        +(editable?'<button class="btn" id="m-docrep">Reemplazar</button>'+(facturado?'<button class="btn danger" id="m-docdel">Deshacer facturado</button>':''):'')
        +'</div></div>';
    } else if(editable){
      docBox='<div class="apprv-box warn" style="margin-top:12px"><div class="apprv-t">Sin documento tributario</div><div class="hint">Adjunta la factura real (PDF u otro archivo) y márcala como Facturado.</div><div style="margin-top:8px"><button class="btn" style="background:var(--good);border-color:var(--good);color:#fff" id="m-fac">Facturar</button></div></div>';
    } else {
      docBox='<div class="apprv-box warn" style="margin-top:12px"><div class="apprv-t">Pre-factura</div><div class="hint">Aún sin documento tributario. Estará disponible aquí cuando operaciones la facture.</div></div>';
    }
    var approveBtnHtml=(canApprove&&inv.status==='PENDING')?'<button class="btn" id="m-approve" style="background:var(--good);border-color:var(--good);color:#fff">Aprobar pre-factura</button>':'';
    var sends='';
    if(inv.sends&&inv.sends.length){
      sends='<div class="maillog"><div class="mailog-t">Envíos por correo</div>'+inv.sends.map(function(s){
        return '<div class="mailog-r"><span>'+esc(s.to)+'</span><span class="hint">'+esc(fmtDate(s.at))+' · '+esc(s.by||'')+(s.delivered?' · <b style="color:#1f7a44">entregado</b>':' · <span style="color:#a86b12">registrado (sin SMTP)</span>')+'</span></div>';
      }).join('')+'</div>';
    }
    // Enviar por correo
    var sendBox=editable?('<div class="sendbox"><div class="sendbox-t">Enviar por correo</div>'
      +'<div class="sendrow"><input type="email" id="m-mailto" placeholder="correo@cliente.cl" autocomplete="off"><button class="btn pri" id="m-send">Enviar</button></div>'
      +'<div class="hint" id="m-mailmsg">Se registra el envío en la factura. La entrega real requiere SMTP configurado.</div></div>'):'';
    var actions='<button class="btn" id="m-close">Cerrar</button>';
    if(editable&&!facturado)actions+='<button class="btn" id="m-edit">Editar</button>';
    if(editable&&!facturado)actions+='<button class="btn" style="background:var(--good);border-color:var(--good);color:#fff" id="m-fac2">Facturar</button>';
    actions+=approveBtnHtml;
    actions+='<button class="btn pri" id="m-pdf">Imprimir / PDF</button>';
    var body=invoiceDocHTML(inv)+apprv+docBox+sends+sendBox+'<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap">'+actions+'</div>';
    openModal((facturado?"Factura ":"Pre-factura ")+(inv.number||inv.id),body,true);
    $("#m-close").addEventListener("click",closeModal);
    $("#m-pdf").addEventListener("click",function(){printInvoice(inv);});
    if($("#m-doc"))$("#m-doc").addEventListener("click",function(){downloadTaxDoc(inv);});
    if($("#m-docrep"))$("#m-docrep").addEventListener("click",function(){openFacturarModal(inv);});
    if($("#m-docdel"))$("#m-docdel").addEventListener("click",function(){confirmRemoveTaxDoc(inv);});
    if($("#m-fac"))$("#m-fac").addEventListener("click",function(){openFacturarModal(inv);});
    if($("#m-fac2"))$("#m-fac2").addEventListener("click",function(){openFacturarModal(inv);});
    if(editable){
      if($("#m-edit"))$("#m-edit").addEventListener("click",function(){openInvoiceEdit(inv);});
      if($("#m-send"))$("#m-send").addEventListener("click",function(){sendInvoice(inv);});
      if($("#m-mailto"))$("#m-mailto").addEventListener("keydown",function(e){if(e.key==="Enter")sendInvoice(inv);});
    }
    if(approveBtnHtml)$("#m-approve").addEventListener("click",function(){confirmApproveInvoice(inv);});
  }
  function sendInvoice(inv){
    var to=($("#m-mailto").value||'').trim(), msg=$("#m-mailmsg");
    if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)){msg.innerHTML='<span class="ferr">Ingresa un correo válido.</span>';return;}
    msg.textContent='Enviando…';
    api('/sellers/'+seller+'/billing/invoices/'+encodeURIComponent(inv.id)+'/send',{method:'POST',body:{to:to}})
      .then(function(r){
        toast(r.delivered?('Factura enviada a '+to):('Envío registrado ('+to+')'));
        if(r.invoice)replaceInvoice(r.invoice);
        openInvoice(byId(billList,inv.id)||r.invoice);
      })
      .catch(function(e){msg.innerHTML='<span class="ferr">'+esc(e.message)+'</span>';});
  }
  function replaceInvoice(inv){for(var i=0;i<billList.length;i++){if(billList[i].id===inv.id){billList[i]=inv;break;}}renderInvoiceList(billList);}
  // ---- Facturar: adjuntar el documento tributario y marcar como Facturado ----
  function openFacturarModal(inv){
    if(!inv)return;
    if(inv.status==='INVOICED'){toast("La factura ya está facturada");return;}
    var hasDoc=!!inv.taxDocument;
    var cur=hasDoc?('<div class="apprv-box ok" style="margin-bottom:12px"><div class="apprv-t">📎 Documento adjunto: '+esc(inv.taxDocument.fileName)+'</div><div class="hint">'+fmtBytes(inv.taxDocument.size)+' · '+esc(inv.taxDocument.uploadedBy)+' · '+esc(fmtDate(inv.taxDocument.uploadedAt))+'</div></div>'):'';
    var html='<div class="form">'
      +'<p class="muted" style="margin:0">Adjunta el <b>documento tributario</b> (la factura real en PDF u otro archivo) para la pre-factura <b>'+esc(inv.number||inv.id)+'</b> ('+esc(fmtPeriod(inv.periodFrom))+', total '+esc(fmtMoney(inv.total,inv.currency))+').</p>'
      +cur
      +'<div class="fld"><label>'+(hasDoc?'Reemplazar archivo (opcional)':'Archivo del documento tributario')+'</label>'
      +'<input id="fac-file" type="file" accept=".pdf,.png,.jpg,.jpeg,.xml,.doc,.docx,.xls,.xlsx,.zip,.txt,application/pdf,image/*"></div>'
      +'<label style="display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none"><input id="fac-mark" type="checkbox" checked> Marcar como <b>Facturado</b></label>'
      +'<p class="hint" style="margin:0">Al marcar Facturado, la pre-factura pasa a estado <b>Facturado</b> y el documento queda visible para el cliente en su módulo de facturación.</p>'
      +'<div class="ferr" id="fac-err"></div>'
      +'<div class="acts"><span class="hint">Máx. 20 MB.</span><div style="display:flex;gap:10px"><button class="btn" id="fac-cancel">Cancelar</button><button class="btn pri" id="fac-save">Guardar</button></div></div>'
      +'</div>';
    openModal("Facturar · "+(inv.number||inv.id),html);
    $("#fac-cancel").addEventListener("click",function(){openInvoice(byId(billList,inv.id)||inv);});
    $("#fac-save").addEventListener("click",function(){
      var f=$("#fac-file").files[0], mark=$("#fac-mark").checked, err=$("#fac-err");
      err.textContent="";
      if(!f){
        if(hasDoc){ // sin archivo nuevo: solo (des)marcar según checkbox sobre el doc existente
          if(mark){$("#fac-save").disabled=true;api('/sellers/'+seller+'/billing/invoices/'+encodeURIComponent(inv.id)+'/mark-invoiced',{method:'POST'}).then(function(u){toast("Marcada como facturada");replaceInvoice(u);openInvoice(u);}).catch(function(e){$("#fac-save").disabled=false;err.textContent=e.message;});}
          else{err.textContent="No hay cambios: adjunta un archivo o marca Facturado.";}
          return;
        }
        err.textContent="Selecciona el archivo del documento tributario.";return;
      }
      if(f.size>20*1024*1024){err.textContent="El archivo supera el máximo de 20 MB.";return;}
      $("#fac-save").disabled=true;
      var reader=new FileReader();
      reader.onload=function(){
        var body={fileName:f.name,mimeType:f.type||undefined,contentBase64:reader.result,markInvoiced:mark};
        api('/sellers/'+seller+'/billing/invoices/'+encodeURIComponent(inv.id)+'/tax-document',{method:'POST',body:body})
          .then(function(u){toast(mark?"Pre-factura facturada":"Documento adjuntado");replaceInvoice(u);openInvoice(u);})
          .catch(function(e){$("#fac-save").disabled=false;err.textContent=e.message;});
      };
      reader.onerror=function(){$("#fac-save").disabled=false;err.textContent="No se pudo leer el archivo.";};
      reader.readAsDataURL(f);
    });
  }
  function confirmRemoveTaxDoc(inv){
    if(!inv)return;
    confirmBox('Deshacer facturado',
      'Se quitará el documento tributario y la factura <b>'+esc(inv.number||inv.id)+'</b> volverá a <b>Pre-factura</b>.<br><br>¿Continuar?',
      'Deshacer', function(){
        api('/sellers/'+seller+'/billing/invoices/'+encodeURIComponent(inv.id)+'/tax-document',{method:'DELETE'})
          .then(function(u){toast("Volvió a Pre-factura");replaceInvoice(u);if($("#modal").classList.contains('on'))openInvoice(u);})
          .catch(function(e){toast(e.message);});
      }, true);
  }
  // ---- Editar factura: número, cantidades y conceptos adicionales (texto libre) ----
  function openInvoiceEdit(inv){
    if(!inv)return;
    var cur=inv.currency||'CLP';
    var lineRows=(inv.lines||[]).map(function(l,i){
      return '<tr data-li="'+i+'"><td><input class="ei-concept" value="'+esc(l.concept)+'"></td>'
        +'<td><input class="ei-qty num" type="number" min="0" step="1" value="'+esc(l.qty)+'" style="width:80px"></td>'
        +'<td><input class="ei-rate num" type="number" min="0" step="1" value="'+esc(l.rate)+'" style="width:110px"><div class="hint">'+esc(l.unit||'')+'</div></td>'
        +'<td class="num ei-amt">'+fmtMoney(l.qty*l.rate,cur)+'</td>'
        +'<td><button class="mini danger ei-del" title="Quitar concepto">✕</button></td></tr>';
    }).join('');
    var body='<div class="fgrid" style="margin-bottom:12px"><label>Número de factura'
      +'<input id="ei-number" value="'+esc(inv.number||inv.id)+'" placeholder="Ej: 0001-A"></label></div>'
      +'<div class="tablewrap"><table class="cotejo-tbl" id="ei-tbl"><thead><tr><th>Concepto</th><th class="num">Cantidad</th><th class="num">Tarifa</th><th class="num">Monto</th><th></th></tr></thead>'
      +'<tbody>'+lineRows+'</tbody>'
      +'<tfoot><tr><td colspan="3" class="num">Total</td><td class="num" id="ei-total"><b>'+fmtMoney(inv.total,cur)+'</b></td><td></td></tr></tfoot></table></div>'
      +'<div style="margin:10px 0"><button class="btn" id="ei-add">+ Agregar concepto adicional</button></div>'
      +'<p class="ferr" id="ei-err" style="min-height:16px;margin:4px 0"></p>'
      +'<div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn" id="ei-cancel">Cancelar</button><button class="btn pri" id="ei-save">Guardar cambios</button></div>';
    openModal("Editar factura "+(inv.number||inv.id),body,true);
    function recalc(){
      var tot=0;
      $$("#ei-tbl tbody tr").forEach(function(tr){
        var q=num0(tr.querySelector('.ei-qty').value), r=num0(tr.querySelector('.ei-rate').value);
        tr.querySelector('.ei-amt').textContent=fmtMoney(q*r,cur);tot+=q*r;
      });
      $("#ei-total").innerHTML='<b>'+fmtMoney(tot,cur)+'</b>';
    }
    function bindRow(tr){
      tr.querySelector('.ei-qty').addEventListener('input',recalc);
      tr.querySelector('.ei-rate').addEventListener('input',recalc);
      tr.querySelector('.ei-del').addEventListener('click',function(){tr.parentNode.removeChild(tr);recalc();});
    }
    $$("#ei-tbl tbody tr").forEach(bindRow);
    $("#ei-add").addEventListener("click",function(){
      var tb=$("#ei-tbl tbody");
      var tr=document.createElement('tr');
      tr.innerHTML='<td><input class="ei-concept" placeholder="Concepto adicional (texto libre)"></td>'
        +'<td><input class="ei-qty num" type="number" min="0" step="1" value="1" style="width:80px"></td>'
        +'<td><input class="ei-rate num" type="number" min="0" step="1" value="0" style="width:110px"><div class="hint">un</div></td>'
        +'<td class="num ei-amt">'+fmtMoney(0,cur)+'</td>'
        +'<td><button class="mini danger ei-del" title="Quitar concepto">✕</button></td>';
      tb.appendChild(tr);bindRow(tr);recalc();
    });
    $("#ei-cancel").addEventListener("click",function(){openInvoice(byId(billList,inv.id)||inv);});
    $("#ei-save").addEventListener("click",function(){
      $("#ei-err").textContent="";
      var num=($("#ei-number").value||'').trim();
      if(!num){$("#ei-err").textContent="El número de factura no puede quedar vacío.";return;}
      var lines=[], bad='';
      $$("#ei-tbl tbody tr").forEach(function(tr){
        var c=(tr.querySelector('.ei-concept').value||'').trim();
        var q=num0(tr.querySelector('.ei-qty').value), r=num0(tr.querySelector('.ei-rate').value);
        var unit=(tr.querySelector('.hint')?tr.querySelector('.hint').textContent:'')||'un';
        if(!c){bad='Todos los conceptos deben tener un nombre.';return;}
        lines.push({concept:c,unit:unit,qty:q,rate:r});
      });
      if(bad){$("#ei-err").textContent=bad;return;}
      if(!lines.length){$("#ei-err").textContent="La factura debe tener al menos un concepto.";return;}
      api('/sellers/'+seller+'/billing/invoices/'+encodeURIComponent(inv.id),{method:'PATCH',body:{number:num,lines:lines}})
        .then(function(updated){toast("Factura actualizada");replaceInvoice(updated);openInvoice(updated);})
        .catch(function(e){$("#ei-err").textContent=e.message;});
    });
  }
  function confirmDeleteInvoice(inv){
    if(!inv)return;
    confirmBox('Eliminar factura',
      'Se eliminará la factura <b>'+esc(inv.number||inv.id)+'</b> ('+esc(fmtPeriod(inv.periodFrom))+', total '+esc(fmtMoney(inv.total,inv.currency))+').<br><br>Esta acción no se puede deshacer.',
      'Eliminar factura', function(){
        api('/sellers/'+seller+'/billing/invoices/'+encodeURIComponent(inv.id),{method:'DELETE'})
          .then(function(){toast("Factura eliminada");return api('/sellers/'+seller+'/billing/invoices');})
          .then(function(list){renderInvoiceList(list);}).catch(function(e){toast(e.message);});
      }, true);
  }
  function printInvoice(inv){
    if(!inv)return;
    var w=window.open("","_blank","width=820,height=1000"); if(!w){toast("Habilita las ventanas emergentes para imprimir");return;}
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Factura '+esc(inv.id)+'</title><style>'+MANIFEST_CSS+'</style></head><body>'+invoiceDocHTML(inv)+'<script>window.onload=function(){setTimeout(function(){window.print();},250);};<\/script></body></html>');
    w.document.close();
  }

  // ===== Módulo "Almacenado": guardar recepción → almacenaje (asistido) =====
  var pwCurrent=[];
  // Almacenado tiene dos trabajos distintos que son el mismo movimiento físico:
  //  · "Desde recepción": mercadería recién llegada que hay que guardar.
  //  · "Por reponer": mercadería que volvió de una orden cancelada y debe regresar a su sitio.
  var REPO_CODE='DEV-REPOSICION';
  var pwTab='recepcion';
  function repoLoc(){ return locByCode[REPO_CODE]||null; }
  function pwRows(){
    var map={},order=[];
    var repo=repoLoc();
    (D.inv||[]).forEach(function(b){
      var l=locById[b.locationId];
      if(!l||l.zoneType!=="RECEIVING"||b.state!=="AVAILABLE"||!(b.qty>0))return;
      var esRepo=!!(repo&&b.locationId===repo.id);
      if(pwTab==='reposicion'?!esRepo:esRepo)return;
      var k=b.sku+"|"+(b.lot||"")+"|"+b.locationId;
      if(!map[k]){map[k]={sku:b.sku,lot:b.lot||"",locationId:b.locationId,qty:0};order.push(k);}
      map[k].qty+=b.qty;
    });
    return order.map(function(k){return map[k];}).sort(function(a,b){return b.qty-a.qty;});
  }
  function pwCounts(){
    var repo=repoLoc(), a=0, b2=0;
    (D.inv||[]).forEach(function(b){
      var l=locById[b.locationId];
      if(!l||l.zoneType!=="RECEIVING"||b.state!=="AVAILABLE"||!(b.qty>0))return;
      if(repo&&b.locationId===repo.id)b2+=b.qty; else a+=b.qty;
    });
    return {recepcion:a,reposicion:b2};
  }
  function renderPwTabs(){
    var el=$("#pw-tabs"); if(!el)return;
    var c=pwCounts();
    var tabs=[['recepcion','Desde recepción',c.recepcion],['reposicion','Por reponer',c.reposicion]];
    el.innerHTML=tabs.map(function(t){
      return '<button class="fchip '+(pwTab===t[0]?'on':'')+(t[2]?'':' zero')+'" data-pwtab="'+t[0]+'">'+t[1]+'<span class="fcount">'+t[2]+'</span></button>';
    }).join('');
    $$("#pw-tabs [data-pwtab]").forEach(function(b){b.addEventListener("click",function(){pwTab=b.getAttribute("data-pwtab");renderPutaway();});});
    var help=$("#pw-help");
    if(help)help.textContent=pwTab==='reposicion'
      ? 'Mercadería que volvió de órdenes canceladas y todavía no está en su ubicación. Mientras espera aquí no se puede reservar para otra orden.'
      : 'Stock recibido en zona de recepción, pendiente de guardar en almacenaje. El destino viene sugerido automáticamente.';
    var tho=$("#pw-th-origen"); if(tho)tho.textContent=pwTab==='reposicion'?'En reposición':'Recepción';
    var thq=$("#pw-th-qty"); if(thq)thq.textContent=pwTab==='reposicion'?'Por reponer':'Por guardar';
  }
  function renderPutaway(){
    if(!$("#pw-body"))return;
    renderPwTabs();
    var rows=pwRows(); pwCurrent=rows;
    $("#pw-count").textContent=rows.length?(rows.length+" SKU(s) por guardar · "+rows.reduce(function(a,r){return a+r.qty;},0)+" un"):"";
    if(!rows.length){$("#pw-body").innerHTML='<tr><td colspan="7" class="empty">No hay stock pendiente de guardar. ✓</td></tr>';return;}
    $("#pw-body").innerHTML=rows.map(function(r,i){
      return '<tr>'
        +'<td class="sku">'+esc(r.sku)+'</td>'
        +'<td>'+esc(skuDesc(r.sku)||"")+'</td>'
        +'<td>'+esc(r.lot||"—")+'</td>'
        +'<td><span class="loc-chip">'+esc(code(r.locationId))+'</span></td>'
        +'<td class="num">'+r.qty+'</td>'
        +'<td class="pw-dest muted" data-i="'+i+'">Calculando…</td>'
        +'<td><div class="card-actions" style="justify-content:flex-end">'
          +'<button class="mini pri" data-pwall="'+i+'" disabled>Guardar todo aquí</button>'
          +'<button class="mini" data-pwedit="'+i+'">Elegir…</button>'
        +'</div></td></tr>';
    }).join("");
    rows.forEach(function(r,i){
      api('/sellers/'+seller+'/putaway-suggestions?sku='+encodeURIComponent(r.sku)+'&qty='+r.qty).then(function(sugs){
        var cell=document.querySelector('#pw-body .pw-dest[data-i="'+i+'"]'); if(!cell)return;
        if(sugs&&sugs.length){
          r._sug=sugs[0];
          cell.classList.remove("muted");
          cell.innerHTML='<span class="loc-chip">'+esc(sugs[0].locationCode)+'</span> <span class="hint">sugerida</span>';
          var btn=document.querySelector('#pw-body [data-pwall="'+i+'"]'); if(btn)btn.disabled=false;
        } else { cell.textContent="(sin ubicación de almacenaje)"; }
      }).catch(function(){var cell=document.querySelector('#pw-body .pw-dest[data-i="'+i+'"]'); if(cell)cell.textContent="(error)";});
    });
    $$("#pw-body [data-pwall]").forEach(function(b){b.addEventListener("click",function(){var r=pwCurrent[+b.getAttribute("data-pwall")]; if(r&&r._sug)doPutaway(r,r._sug.locationId,r.qty);});});
    $$("#pw-body [data-pwedit]").forEach(function(b){b.addEventListener("click",function(){openStoreForm(pwCurrent[+b.getAttribute("data-pwedit")]);});});
  }
  function doPutaway(r,toLoc,qty){
    var body={sku:r.sku,qty:qty,fromLocationId:r.locationId,toLocationId:toLoc,reference:'ALMACENADO'}; if(r.lot)body.lot=r.lot;
    api('/sellers/'+seller+'/putaway',{method:'POST',body:body})
      .then(function(){toast("Guardado "+qty+" un en "+code(toLoc));return loadSeller();})
      .catch(function(e){recErrModal("No se pudo guardar",e.message);});
  }
  function openStoreForm(r){
    if(!r)return;
    var html='<div class="form">'
      +'<div class="row2"><div class="fld"><label>Producto</label><input value="'+esc(r.sku+(skuDesc(r.sku)?" — "+skuDesc(r.sku):""))+'" disabled></div>'
      +'<div class="fld"><label>Desde</label><input value="'+esc(code(r.locationId)+(r.lot?" · lote "+r.lot:""))+'" disabled></div></div>'
      +'<div class="row2"><div class="fld"><label>Cantidad (máx '+r.qty+')</label><input id="sf-qty" type="number" min="1" max="'+r.qty+'" value="'+r.qty+'"></div>'
      +'<div class="fld"><label>Ubicación destino</label><input id="sf-dest" class="mono2" placeholder="Pega o escribe el código"><span class="hint" id="sf-hint"></span></div></div>'
      +'<div class="ferr" id="sf-err"></div>'
      +'<div class="acts"><span class="hint">Guardado de recepción a almacenaje.</span><div style="display:flex;gap:10px"><button class="btn" id="sf-cancel">Cancelar</button><button class="btn pri" id="sf-save">Guardar</button></div></div>'
      +'</div>';
    openModal("Guardar "+r.sku,html);
    $("#sf-cancel").addEventListener("click",closeModal);
    var destSel=null;
    function locUp(v){
      var k=String(v==null?'':v).trim().toUpperCase(); if(!k)return null;
      var all=D.locations||[];
      for(var i=0;i<all.length;i++) if(String(all[i].code||'').toUpperCase()===k) return all[i];
      return null;
    }
    function paintDest(quiet){
      var l=locUp($("#sf-dest").value), inp=$("#sf-dest"), h=$("#sf-hint");
      var ok=l&&(l.zoneType==="STORAGE"||l.zoneType==="PICKING")&&l.active!==false&&l.id!==r.locationId;
      if(ok){ if(inp.value!==l.code)inp.value=l.code; inp.classList.remove("bad"); destSel=l; h.className="hint"; h.textContent=zoneName(l.zoneType); }
      else {
        destSel=null;
        if(quiet||!inp.value.trim()){ inp.classList.remove("bad"); h.className="hint"; h.textContent=""; }
        else { inp.classList.add("bad"); h.className="hint warnrow";
          h.textContent=!l?"No existe una ubicación con ese código":(l.id===r.locationId)?"El destino no puede ser la misma ubicación":(l.active===false)?"Esa ubicación está inactiva":"Solo se puede guardar en almacenaje o picking"; }
      }
    }
    AC.attach($("#sf-dest"),{
      match: function(q){
        q=String(q||'').trim().toLowerCase();
        var all=(D.locations||[]).filter(function(l){return (l.zoneType==="STORAGE"||l.zoneType==="PICKING")&&l.active!==false&&l.id!==r.locationId;});
        if(!q)return all.slice(0,8);
        var pre=[],mid=[];
        all.forEach(function(l){ var c=String(l.code||'').toLowerCase();
          if(c.indexOf(q)===0)pre.push(l); else if(c.indexOf(q)>=0||zoneName(l.zoneType).toLowerCase().indexOf(q)>=0)mid.push(l); });
        return pre.concat(mid).slice(0,8);
      },
      row: function(l,q){ return '<span class="ac-sku">'+AC.mark(l.code,q)+'</span><span class="ac-de">'+esc(zoneName(l.zoneType))+'</span>'; },
      empty: 'Sin ubicaciones de almacenaje o picking',
      onType: function(){ paintDest(true); },
      onBlur: function(){ paintDest(); },
      pick: function(l){ $("#sf-dest").value=l.code; paintDest(); $("#sf-qty").focus(); }
    });
    api('/sellers/'+seller+'/putaway-suggestions?sku='+encodeURIComponent(r.sku)+'&qty='+r.qty).then(function(sugs){
      if(sugs&&sugs[0]&&!$("#sf-dest").value){
        $("#sf-dest").value=sugs[0].locationCode; paintDest(true);
        var rs=sugs[0].reasons||[]; $("#sf-hint").textContent=rs.length?("Sugerida: "+rs.slice(0,2).join(" · ")):"sugerida";
      }
    }).catch(function(){});
    $("#sf-save").addEventListener("click",function(){
      $("#sf-err").textContent="";
      paintDest();
      var dest=destSel?destSel.id:"", q=parseInt($("#sf-qty").value,10)||0;
      if(!dest){$("#sf-err").textContent="Indica una ubicación de destino válida.";return;}
      if(!(q>0)||q>r.qty){$("#sf-err").textContent="Cantidad inválida (máx "+r.qty+").";return;}
      var body={sku:r.sku,qty:q,fromLocationId:r.locationId,toLocationId:dest,reference:'ALMACENADO'}; if(r.lot)body.lot=r.lot;
      api('/sellers/'+seller+'/putaway',{method:'POST',body:body})
        .then(function(){closeModal();toast("Guardado "+q+" un en "+code(dest));return loadSeller();})
        .catch(function(e){$("#sf-err").textContent=e.message;});
    });
  }

  // ----- Guardado / mover stock (putaway) -----
  // Producto y ubicaciones se PEGAN o se escriben (antes eran desplegables). El origen
  // solo admite ubicaciones con stock del producto y muestra cuánto hay; el destino solo
  // almacenaje o picking activas. La ubicación sugerida sigue viniendo preseleccionada.
  function openPutawayForm(){
    if(!seller){toast("Selecciona un cliente primero");return;}
    if(!D.skus.length){toast("Este cliente no tiene SKUs cargados");return;}
    var html='<div class="form">'
      +'<div class="fld"><label>Producto (SKU o nombre)</label><input id="pa-sku" class="mono2" placeholder="Pega el SKU, el nombre o el código de barras"><span class="hint" id="pa-skuhint"></span></div>'
      +'<div class="fld"><label>Desde (ubicación con stock)</label><input id="pa-from" class="mono2" placeholder="Pega o escribe el código de la ubicación"><span class="hint" id="pa-cap"></span></div>'
      +'<div class="fld"><label>Hacia (ubicación destino)</label><input id="pa-to" class="mono2" placeholder="Pega o escribe el código de la ubicación"><span class="hint" id="pa-tohint"></span></div>'
      +'<div class="fld"><label>Cantidad (unidades)</label><input id="pa-qty" type="number" min="1" value="1"></div>'
      +'<div class="ferr" id="pa-err"></div>'
      +'<div class="acts"><span class="hint">Traslado entre ubicaciones (no cambia el stock total).</span><div style="display:flex;gap:10px"><button class="btn" id="pa-cancel">Cancelar</button><button class="btn pri" id="pa-save">Mover</button></div></div>'
      +'</div>';
    openModal("Guardar / mover stock",html);

    var fromMax={};        // ubicaciones con stock disponible del SKU elegido
    var sel={sku:null,from:null,to:null};

    function skuByCode(v){
      var k=String(v==null?'':v).trim().toUpperCase(); if(!k)return null;
      for(var i=0;i<D.skus.length;i++){
        var x=D.skus[i];
        if(String(x.sku||'').toUpperCase()===k)return x;
        if(x.barcode&&String(x.barcode).toUpperCase()===k)return x;
        if(String(x.description||'').trim().toUpperCase()===k)return x;
      }
      return null;
    }
    function locByCodeUp(v){
      var k=String(v==null?'':v).trim().toUpperCase(); if(!k)return null;
      var all=D.locations||[];
      for(var i=0;i<all.length;i++) if(String(all[i].code||'').toUpperCase()===k) return all[i];
      return null;
    }
    function matchLocs(filter){
      return function(q){
        q=String(q||'').trim().toLowerCase();
        var all=(D.locations||[]).filter(filter);
        if(!q)return all.slice(0,8);
        var pre=[],mid=[];
        all.forEach(function(l){
          var c=String(l.code||'').toLowerCase();
          if(c.indexOf(q)===0)pre.push(l);
          else if(c.indexOf(q)>=0||zoneName(l.zoneType).toLowerCase().indexOf(q)>=0)mid.push(l);
        });
        return pre.concat(mid).slice(0,8);
      };
    }
    function locRow(extra){
      return function(l,q){
        return '<span class="ac-sku">'+AC.mark(l.code,q)+'</span><span class="ac-de">'+esc(zoneName(l.zoneType))+(extra&&extra(l)?' · '+esc(extra(l)):'')+'</span>';
      };
    }
    function validate(){
      var cap=sel.from?fromMax[sel.from.id]:null;
      var n=parseInt($("#pa-qty").value,10)||0;
      var over=(cap!=null&&n>cap);
      $("#pa-cap").className="hint"+(over?" warnrow":"");
      if(sel.from&&cap!=null)$("#pa-cap").textContent="disponible: "+cap+" un"+(over?" — la cantidad supera lo disponible":"");
      $("#pa-save").disabled = !sel.sku||!sel.from||!sel.to||!(n>0)||over;
    }
    function paintSkuField(quiet){
      var m=skuByCode($("#pa-sku").value);
      sel.sku=m;
      var inp=$("#pa-sku"), h=$("#pa-skuhint");
      if(m){ if(inp.value!==m.sku)inp.value=m.sku; inp.classList.remove("bad"); h.className="hint"; h.textContent=m.description||""; }
      else if(quiet||!inp.value.trim()){ inp.classList.remove("bad"); h.className="hint"; h.textContent=""; }
      else { inp.classList.add("bad"); h.className="hint warnrow"; h.textContent="No existe un producto con ese código o nombre"; }
      validate();
    }
    var fromHint="";
    function paintFrom(quiet){
      var l=locByCodeUp($("#pa-from").value);
      var inp=$("#pa-from"), h=$("#pa-cap");
      if(l&&fromMax[l.id]>0){ if(inp.value!==l.code)inp.value=l.code; inp.classList.remove("bad"); sel.from=l; h.className="hint"; h.textContent="disponible: "+fromMax[l.id]+" un"; }
      else {
        sel.from=null;
        if(quiet||!inp.value.trim()){ inp.classList.remove("bad"); h.className="hint"; h.textContent=fromHint; }
        else { inp.classList.add("bad"); h.className="hint warnrow"; h.textContent=l?("En "+l.code+" no hay stock disponible de este producto"):"No existe una ubicación con ese código"; }
      }
      paintToOptionsHint();
      validate();
    }
    function paintTo(quiet){
      var l=locByCodeUp($("#pa-to").value);
      var inp=$("#pa-to"), h=$("#pa-tohint");
      var ok=l&&(l.zoneType==="STORAGE"||l.zoneType==="PICKING")&&l.active!==false&&(!sel.from||l.id!==sel.from.id);
      if(ok){ if(inp.value!==l.code)inp.value=l.code; inp.classList.remove("bad"); sel.to=l; h.className="hint"; h.textContent=zoneName(l.zoneType); }
      else {
        sel.to=null;
        if(quiet||!inp.value.trim()){ inp.classList.remove("bad"); paintToOptionsHint(); }
        else {
          inp.classList.add("bad"); h.className="hint warnrow";
          h.textContent=!l?"No existe una ubicación con ese código"
            :(sel.from&&l.id===sel.from.id)?"El destino no puede ser la misma ubicación de origen"
            :(l.active===false)?"Esa ubicación está inactiva"
            :"Solo se puede mover a almacenaje o picking";
        }
      }
      validate();
    }
    function paintToOptionsHint(){
      var h=$("#pa-tohint");
      if(sel.to)return;
      h.className="hint"; h.textContent="";
    }
    function loadFrom(){
      fromHint="Buscando stock…"; $("#pa-cap").className="hint"; $("#pa-cap").textContent=fromHint;
      fromMax={}; sel.from=null; $("#pa-from").value="";
      if(!sel.sku){ fromHint=""; $("#pa-cap").textContent=""; validate(); return; }
      api('/sellers/'+seller+'/inventory?sku='+encodeURIComponent(sel.sku.sku)).then(function(rows){
        fromMax={};
        rows.forEach(function(b){if(b.state==="AVAILABLE")fromMax[b.locationId]=(fromMax[b.locationId]||0)+b.qty;});
        var conStock=Object.keys(fromMax).filter(function(id){return fromMax[id]>0;});
        if(conStock.length===1){ var l=locById[conStock[0]]; if(l){ $("#pa-from").value=l.code; } }
        fromHint=conStock.length?(conStock.length===1?"en 1 ubicación con stock":("en "+conStock.length+" ubicaciones con stock")):"Este producto no tiene stock disponible";
        $("#pa-cap").className="hint"; $("#pa-cap").textContent=fromHint;
        paintFrom(true);
        AC.refresh($("#pa-from"));
        // Destino sugerido por el motor de guardado (se puede cambiar).
        api('/sellers/'+seller+'/putaway-suggestions?sku='+encodeURIComponent(sel.sku.sku)+'&qty=1').then(function(sugs){
          if(sugs&&sugs[0]&&!$("#pa-to").value){ $("#pa-to").value=sugs[0].locationCode; paintTo(true); $("#pa-tohint").textContent="sugerida"; }
        }).catch(function(){});
      }).catch(function(){ fromHint="(no se pudo consultar el stock)"; $("#pa-cap").textContent=fromHint; });
    }

    AC.attach($("#pa-sku"),{
      match: function(q){
        q=String(q||'').trim().toLowerCase();
        if(!q)return D.skus.slice(0,8);
        var pre=[],mid=[];
        D.skus.forEach(function(x){
          var sk=String(x.sku||'').toLowerCase(), de=String(x.description||'').toLowerCase(), bc=String(x.barcode||'').toLowerCase();
          if(sk.indexOf(q)===0||de.indexOf(q)===0)pre.push(x); else if(sk.indexOf(q)>=0||de.indexOf(q)>=0||bc.indexOf(q)>=0)mid.push(x);
        });
        return pre.concat(mid).slice(0,8);
      },
      row: function(x,q){ return '<span class="ac-sku">'+AC.mark(x.sku,q)+'</span><span class="ac-de">'+AC.mark(x.description||'',q)+'</span>'; },
      empty: 'Sin productos que coincidan',
      onType: function(){ paintSkuField(true); },
      onBlur: function(){ paintSkuField(); if(sel.sku)loadFrom(); },
      pick: function(x){ $("#pa-sku").value=x.sku; paintSkuField(); loadFrom(); $("#pa-from").focus(); }
    });
    AC.attach($("#pa-from"),{
      match: matchLocs(function(l){ return fromMax[l.id]>0; }),
      row: locRow(function(l){ return fromMax[l.id]+' un'; }),
      empty: 'Ninguna ubicación tiene stock de este producto',
      onType: function(){ paintFrom(true); },
      onBlur: function(){ paintFrom(); },
      pick: function(l){ $("#pa-from").value=l.code; paintFrom(); $("#pa-to").focus(); }
    });
    AC.attach($("#pa-to"),{
      match: matchLocs(function(l){ return (l.zoneType==="STORAGE"||l.zoneType==="PICKING")&&l.active!==false; }),
      row: locRow(null),
      empty: 'Sin ubicaciones de almacenaje o picking',
      onType: function(){ paintTo(true); },
      onBlur: function(){ paintTo(); },
      pick: function(l){ $("#pa-to").value=l.code; paintTo(); $("#pa-qty").focus(); }
    });
    $("#pa-qty").addEventListener("input",validate);
    $("#pa-cancel").addEventListener("click",function(){AC.close();closeModal();});
    $("#pa-save").addEventListener("click",function(){
      $("#pa-err").textContent="";
      paintSkuField(); paintFrom(); paintTo();
      var n=parseInt($("#pa-qty").value,10);
      if(!sel.sku){$("#pa-err").textContent="Indica el producto.";return;}
      if(!sel.from){$("#pa-err").textContent="Indica una ubicación de origen con stock.";return;}
      if(!sel.to){$("#pa-err").textContent="Indica una ubicación de destino válida.";return;}
      if(!(n>0)){$("#pa-err").textContent="Cantidad inválida.";return;}
      api('/sellers/'+seller+'/putaway',{method:'POST',body:{sku:sel.sku.sku,qty:n,fromLocationId:sel.from.id,toLocationId:sel.to.id,reference:"PANEL-MOVE"}})
        .then(function(){closeModal();toast("Movido "+n+" un de "+sel.from.code+" a "+sel.to.code);return loadSeller();})
        .catch(function(e){$("#pa-err").textContent=e.message;});
    });
    $("#pa-save").disabled=true;
    setTimeout(function(){ $("#pa-sku").focus(); },50);
  }

  // ----- Recepción de mercadería -----
  // ----- Orden de recepción: crear / editar (multi-SKU) -----
  var recDraft=[]; // líneas en edición: [{sku,qty,lot,expiry}]
  function skuOptionsHtml(sel){return (D.skus||[]).map(function(s){return '<option value="'+esc(s.sku)+'"'+(s.sku===sel?' selected':'')+'>'+esc(s.sku)+' — '+esc(s.description||'')+'</option>';}).join("");}
  function renderRecLines(){
    var host=$("#rf-lines"); if(!host)return;
    var hasSkus=(D.skus||[]).length>0;
    host.innerHTML=recDraft.map(function(l,i){
      var skuCtl=hasSkus
        ? '<select data-rl="sku" data-i="'+i+'">'+skuOptionsHtml(l.sku)+'</select>'
        : '<input data-rl="sku" data-i="'+i+'" value="'+esc(l.sku||"")+'" placeholder="Código SKU">';
      return '<div class="recline">'
        +'<div class="rc rc-sku">'+skuCtl+'</div>'
        +'<div class="rc rc-qty"><input data-rl="qty" data-i="'+i+'" type="number" min="1" value="'+(l.qty||1)+'" placeholder="Cant."></div>'
        +'<div class="rc rc-lot"><input data-rl="lot" data-i="'+i+'" value="'+esc(l.lot||"")+'" placeholder="Lote (opc.)"></div>'
        +'<div class="rc rc-exp"><input data-rl="expiry" data-i="'+i+'" type="date" value="'+esc(l.expiry||"")+'"></div>'
        +'<button type="button" class="mini danger rc-del" data-rdelline="'+i+'"'+(recDraft.length<=1?' disabled':'')+'>✕</button>'
        +'</div>';
    }).join("");
    $$("#rf-lines [data-rl]").forEach(function(el){el.addEventListener("input",function(){var i=+el.getAttribute("data-i"),k=el.getAttribute("data-rl");recDraft[i][k]=el.value;});});
    $$("#rf-lines [data-rdelline]").forEach(function(b){b.addEventListener("click",function(){recDraft.splice(+b.getAttribute("data-rdelline"),1);renderRecLines();});});
  }
  function openReceiveForm(existing){
    if(!seller){toast("Selecciona un cliente primero");return;}
    var isEdit=!!existing;
    var recvLocs=D.locations.filter(function(l){return l.zoneType==="RECEIVING"&&l.active!==false;});
    if(!recvLocs.length)recvLocs=D.locations.filter(function(l){return l.active!==false;});
    var curLoc=isEdit?existing.locationId:(recvLocs[0]&&recvLocs[0].id);
    var locOpts=recvLocs.map(function(l){return '<option value="'+esc(l.id)+'"'+(l.id===curLoc?' selected':'')+'>'+esc(l.code)+' ('+zoneName(l.zoneType)+')</option>';}).join("");
    var sellerName=(byId(D.sellers,seller)||{}).name||seller;
    recDraft = isEdit
      ? (existing.lines||[]).map(function(l){return {sku:l.sku,qty:(l.expectedQty!=null?l.expectedQty:l.qty),lot:l.lot||"",expiry:l.expiry||""};})
      : [{sku:(D.skus[0]||{}).sku||"",qty:1,lot:"",expiry:""}];
    var html='<div class="form">'
      +'<div class="row2"><div class="fld"><label>Cliente</label><input value="'+esc(sellerName)+'" disabled></div>'
      +'<div class="fld"><label>Ubicación de recepción</label><select id="rf-loc">'+locOpts+'</select></div></div>'
      +'<div class="row2"><div class="fld"><label>Proveedor</label><input id="rf-sup" value="'+esc(isEdit?(existing.supplier||""):"")+'" placeholder="Ej: Importadora Andes"></div>'
      +'<div class="fld"><label>Referencia (guía / factura / OC)</label><input id="rf-ref" value="'+esc(isEdit?(existing.reference||""):"")+'" placeholder="Ej: Guía 10442"></div></div>'
      +'<div class="fld"><label>Escanear código (GS1 / EAN) — autocompleta SKU, lote y vencimiento</label>'
      +'<div style="display:flex;gap:8px"><input id="rf-scan" placeholder="Pistolea o pega el código aquí y presiona Enter…" autocomplete="off"><button type="button" class="btn" id="rf-scan-btn">Leer</button></div>'
      +'<div class="hint" id="rf-scan-msg" style="min-height:16px"></div></div>'
      +'<div class="fld"><label>Líneas esperadas (SKU · cantidad · lote · vencimiento)</label>'
      +'<div class="reclines-head"><span>Producto (SKU)</span><span>Cant. esp.</span><span>Lote</span><span>Vence</span><span></span></div>'
      +'<div id="rf-lines"></div>'
      +'<button type="button" class="btn" id="rf-addline" style="margin-top:8px">＋ Agregar SKU</button></div>'
      +'<div class="fld"><label>Notas (opcional)</label><input id="rf-notes" value="'+esc(isEdit?(existing.notes||""):"")+'" placeholder="Observaciones: daños, faltantes, etc."></div>'
      +'<div class="ferr" id="rf-err"></div>'
      +'<div class="acts"><span class="hint">'+(isEdit?"Edita las cantidades esperadas (aún no se recibe stock).":"Se crea con cantidades esperadas. El stock ingresa al recepcionar (cotejo).")+'</span><div style="display:flex;gap:10px"><button class="btn" id="rf-cancel">Cancelar</button><button class="btn pri" id="rf-save">'+(isEdit?"Guardar cambios":"Crear orden")+'</button></div></div>'
      +'</div>';
    openModal(isEdit?("Editar recepción "+existing.id):"Nueva orden de recepción",html,true);
    renderRecLines();
    function rfScan(){
      var code=$("#rf-scan").value.trim(); if(!code)return;
      $("#rf-scan-msg").textContent="Leyendo…";
      api('/sellers/'+seller+'/scan/parse',{method:'POST',body:{code:code}}).then(function(r){
        var lot=r.lot||r.serial||"";
        var parts=[];
        if(r.sku)parts.push("✓ SKU "+r.sku);
        else parts.push(r.isGs1?("Código GS1 leído; el GTIN "+(r.gtin||"?")+" no está vinculado a un SKU"):"Código no reconocido");
        if(r.lot)parts.push("lote "+r.lot); if(r.serial)parts.push("serie "+r.serial); if(r.expiry)parts.push("vence "+r.expiry);
        $("#rf-scan-msg").textContent=parts.join(" · ");
        if(r.sku){
          var idx=-1; for(var k=0;k<recDraft.length;k++){if(recDraft[k].sku===r.sku){idx=k;break;}}
          if(idx<0){var e=-1;for(var j=0;j<recDraft.length;j++){if(!recDraft[j].sku){e=j;break;}} if(e>=0)idx=e; else {recDraft.push({sku:r.sku,qty:1,lot:"",expiry:""});idx=recDraft.length-1;}}
          recDraft[idx].sku=r.sku;
          if(lot)recDraft[idx].lot=lot;
          if(r.expiry)recDraft[idx].expiry=r.expiry;
          if(!recDraft[idx].qty||recDraft[idx].qty<1)recDraft[idx].qty=1;
          renderRecLines();
        }
        $("#rf-scan").value=""; $("#rf-scan").focus();
      }).catch(function(e){$("#rf-scan-msg").textContent=e.message;});
    }
    $("#rf-scan-btn").addEventListener("click",rfScan);
    $("#rf-scan").addEventListener("keydown",function(e){if(e.key==="Enter"){e.preventDefault();rfScan();}});
    $("#rf-addline").addEventListener("click",function(){recDraft.push({sku:(D.skus[0]||{}).sku||"",qty:1,lot:"",expiry:""});renderRecLines();});
    $("#rf-cancel").addEventListener("click",closeModal);
    $("#rf-save").addEventListener("click",function(){
      $("#rf-err").textContent="";
      var locId=$("#rf-loc").value;
      if(!locId){$("#rf-err").textContent="Selecciona una ubicación de recepción.";return;}
      var lines=[];
      for(var i=0;i<recDraft.length;i++){
        var l=recDraft[i]; var sku=(l.sku||"").trim(); var qty=num(l.qty);
        if(!sku){$("#rf-err").textContent="Falta el SKU en la línea "+(i+1)+".";return;}
        if(!qty||qty<1){$("#rf-err").textContent="Cantidad inválida en la línea "+(i+1)+".";return;}
        var row={sku:sku,qty:qty}; if((l.lot||"").trim())row.lot=l.lot.trim(); if(l.expiry)row.expiry=l.expiry;
        lines.push(row);
      }
      if(!lines.length){$("#rf-err").textContent="Agrega al menos una línea.";return;}
      var body={locationId:locId,lines:lines};
      var sup=$("#rf-sup").value.trim(); if(sup)body.supplier=sup;
      var ref=$("#rf-ref").value.trim(); if(ref)body.reference=ref;
      var notes=$("#rf-notes").value.trim(); if(notes)body.notes=notes;
      var path='/sellers/'+seller+'/receipts'+(isEdit?'/'+encodeURIComponent(existing.id):'');
      api(path,{method:isEdit?'PATCH':'POST',body:body})
        .then(function(){closeModal();toast(isEdit?"Orden actualizada":"Orden de recepción creada");return loadSeller();})
        .catch(function(e){$("#rf-err").textContent=e.message;});
    });
  }

  // ----- Ver manifiesto + imprimir PDF -----
  function receiptManifestHTML(o,forPrint){
    var sellerName=(byId(D.sellers,seller)||{}).name||o.sellerId;
    var opName=(byId(D.ops,op)||{}).name||op;
    var rows=(o.lines||[]).map(function(l,i){
      var exp=l.expectedQty||0, rec=l.receivedQty||0, dif=rec-exp;
      var difTxt=dif===0?'0':(dif>0?'+'+dif:String(dif));
      return '<tr><td>'+(i+1)+'</td><td class="m">'+esc(l.sku)+'</td><td>'+esc(skuDesc(l.sku)||"")+'</td><td>'+esc(l.lot||"—")+'</td><td>'+esc(l.expiry||"—")+'</td><td class="r">'+exp+'</td><td class="r">'+rec+'</td><td class="r">'+difTxt+'</td></tr>';
    }).join("");
    var totExp=recExpected(o), totRec=recReceived(o), totDif=totRec-totExp;
    var estadoTxt=o.status==="CANCELLED"?"ANULADA":o.status==="PENDING"?"PENDIENTE":o.status==="PARTIAL"?"PARCIAL":(totDif<0?"RECEPCIONADA (PARCIAL)":"RECEPCIONADA");
    return ''
      +'<div class="manifest">'
      +'<div class="mf-head"><div>'+brandDocHead()+'<div class="mf-sub">Manifiesto de recepción en bodega</div>'+(brandEmisor()?'<div class="mf-sub" style="margin-top:1px">'+esc(brandEmisor())+'</div>':'')+'</div>'
      +'<div class="mf-id"><div class="mf-idn">'+esc(o.id)+'</div><div class="mf-st">'+estadoTxt+'</div></div></div>'
      +'<div class="mf-grid">'
      +'<div><span>Operación</span><b>'+esc(opName)+'</b></div>'
      +'<div><span>Cliente</span><b>'+esc(sellerName)+'</b></div>'
      +'<div><span>Proveedor</span><b>'+esc(o.supplier||"—")+'</b></div>'
      +'<div><span>Referencia</span><b>'+esc(o.reference||"—")+'</b></div>'
      +'<div><span>Ubicación de recepción</span><b>'+esc(code(o.locationId))+'</b></div>'
      +'<div><span>Fecha</span><b>'+esc(fmtDate(o.createdAt))+'</b></div>'
      +'<div><span>Recibido por</span><b>'+esc(o.createdBy||"—")+'</b></div>'
      +'<div><span>Esperado / Recibido</span><b>'+totExp+' / '+totRec+' un</b></div>'
      +'</div>'
      +'<table class="mf-tbl"><thead><tr><th>#</th><th>SKU</th><th>Descripción</th><th>Lote</th><th>Vence</th><th class="r">Esperado</th><th class="r">Recibido</th><th class="r">Dif.</th></tr></thead><tbody>'+rows+'</tbody>'
      +'<tfoot><tr><td colspan="5" class="r">Totales</td><td class="r"><b>'+totExp+'</b></td><td class="r"><b>'+totRec+'</b></td><td class="r"><b>'+(totDif>0?'+'+totDif:String(totDif))+'</b></td></tr></tfoot></table>'
      +(o.notes?'<div class="mf-notes"><span>Notas:</span> '+esc(o.notes)+'</div>':'')
      +'<div class="mf-sign"><div><div class="mf-line"></div>Entregado por (proveedor)</div><div><div class="mf-line"></div>Recibido por (bodega)</div></div>'
      +'</div>';
  }
  function openReceiptView(o){
    if(!o)return;
    var body=receiptManifestHTML(o)
      +'<div style="display:flex;gap:10px;justify-content:flex-end;margin-top:16px"><button class="btn" id="m-close">Cerrar</button><button class="btn pri" id="m-pdf">Imprimir / PDF</button></div>';
    openModal("Orden de recepción "+o.id,body,true);
    $("#m-close").addEventListener("click",closeModal);
    $("#m-pdf").addEventListener("click",function(){printReceiptManifest(o);});
  }
  function printReceiptManifest(o){
    if(!o)return;
    var w=window.open("","_blank","width=820,height=1000");
    if(!w){toast("Habilita las ventanas emergentes para imprimir");return;}
    var css=MANIFEST_CSS;
    w.document.write('<!doctype html><html><head><meta charset="utf-8"><title>Recepción '+esc(o.id)+'</title><style>'+css+'</style></head><body>'+receiptManifestHTML(o,true)+'<script>window.onload=function(){setTimeout(function(){window.print();},250);};<\/script></body></html>');
    w.document.close();
  }

  // Ubicaciones: dos vistas del mismo dato. La LISTA es la de por defecto (con volumen
  // es la única legible); las tarjetas siguen disponibles y la elección se recuerda.
  var LOC_VIEW_KEY='wms.admin.locview';
  var locView=(function(){ try{ return localStorage.getItem(LOC_VIEW_KEY)==='cards'?'cards':'list'; }catch(e){ return 'list'; } })();
  var locQ='', locZone='';
  function locFiltered(){
    var q=locQ.trim().toLowerCase();
    return (D.locations||[]).filter(function(l){
      if(locZone&&l.zoneType!==locZone)return false;
      if(!q)return true;
      return String(l.code||'').toLowerCase().indexOf(q)>=0 || zoneName(l.zoneType).toLowerCase().indexOf(q)>=0;
    });
  }
  function locUse(l){
    var used=D.opStock[l.id]||0;
    var pct=l.capacity>0?Math.min(100,Math.round(used/l.capacity*100)):0;
    return {used:used,pct:pct,cls:l.capacity===0?'':pct>=90?'full':pct>=85?'hi':''};
  }
  function locActionsHtml(l,manage){
    if(!manage)return '';
    var u=locUse(l), inactive=l.active===false;
    return '<button class="mini" data-ledit="'+esc(l.id)+'">Editar</button>'
      +(inactive?'<button class="mini" data-lact="'+esc(l.id)+'">Activar</button>':'<button class="mini danger" data-ldeact="'+esc(l.id)+'">Desactivar</button>')
      +(u.used===0?'<button class="mini" data-ldel="'+esc(l.id)+'" title="Solo si nunca tuvo movimientos">Eliminar</button>':'');
  }
  function renderLocations(){
    if(!$("#loc-grid"))return;
    var manage=can('master');
    // Filtro de zonas, con las zonas que realmente existen.
    var zsel=$("#loc-zone");
    if(zsel){
      var zonas=[];
      (D.locations||[]).forEach(function(l){ if(zonas.indexOf(l.zoneType)<0)zonas.push(l.zoneType); });
      var cur=zsel.value;
      zsel.innerHTML='<option value="">Todas las zonas</option>'+zonas.map(function(z){return '<option value="'+esc(z)+'">'+esc(zoneName(z))+'</option>';}).join('');
      zsel.value=cur||locZone||'';
    }
    var rows=locFiltered().slice().sort(function(a,b){return a.code<b.code?-1:a.code>b.code?1:0;});
    var cnt=$("#loc-count");
    if(cnt)cnt.textContent=rows.length+(rows.length===1?' ubicación':' ubicaciones')+((locQ||locZone)?(' de '+(D.locations||[]).length):'');
    $$("#loc-view .vt").forEach(function(b){b.classList.toggle('on',b.getAttribute('data-view')===locView);});
    $("#loc-grid").classList.toggle('hidden',locView!=='cards');
    if($("#loc-listwrap"))$("#loc-listwrap").classList.toggle('hidden',locView!=='list');

    if(locView==='cards'){
      $("#loc-grid").innerHTML=rows.map(function(l){
        var u=locUse(l);
        var capTxt=l.capacity>0?(u.used+'/'+l.capacity+' · '+u.pct+'%'):(u.used+' un · sin límite');
        var inactive=l.active===false;
        var acts=manage?('<div class="card-actions">'+locActionsHtml(l,manage)+'</div>'):'';
        return '<div class="locc"'+(inactive?' style="opacity:.55"':'')+'><div class="code">'+esc(l.code)+(inactive?' · inactiva':'')+'</div><div class="zone">'+esc(zoneName(l.zoneType))+'</div>'
          +(l.capacity>0?'<div class="occ"><i class="'+u.cls+'" style="width:'+u.pct+'%"></i></div>':'<div class="occ"><i style="width:'+Math.min(100,u.used/6)+'%;background:var(--ink-3)"></i></div>')
          +'<div class="u"><span>Ocupación</span><span>'+capTxt+'</span></div>'+acts+'</div>';
      }).join("")||'<div class="empty">Sin ubicaciones que coincidan.</div>';
    } else {
      $("#loc-body").innerHTML=rows.length?rows.map(function(l){
        var u=locUse(l), inactive=l.active===false;
        var capTxt=l.capacity>0?(u.used+' / '+l.capacity+' un'):(u.used+' un');
        var barra=l.capacity>0
          ? '<span class="occbar"><i class="'+u.cls+'" style="width:'+u.pct+'%"></i></span> <span class="muted">'+u.pct+'%</span>'
          : '<span class="muted">sin límite</span>';
        return '<tr'+(inactive?' style="opacity:.6"':'')+'>'
          +'<td class="mono2">'+esc(l.code)+'</td>'
          +'<td>'+esc(zoneName(l.zoneType))+'</td>'
          +'<td class="num">'+esc(capTxt)+'</td>'
          +'<td>'+barra+'</td>'
          +'<td>'+(inactive?'<span class="chip st-CANCELLED"><span class="dot"></span>Inactiva</span>':'<span class="chip st-AVAILABLE"><span class="dot"></span>Activa</span>')+'</td>'
          +'<td style="text-align:right"><div class="rowacts">'+locActionsHtml(l,manage)+'</div></td></tr>';
      }).join(""):'<tr><td colspan="6" class="empty">Sin ubicaciones que coincidan.</td></tr>';
    }
    if(manage){
      $$("[data-ledit]").forEach(function(b){b.addEventListener("click",function(){openLocForm(byId(D.locations,b.getAttribute("data-ledit")));});});
      $$("[data-ldeact]").forEach(function(b){b.addEventListener("click",function(){var l=byId(D.locations,b.getAttribute("data-ldeact"));openConfirm("Desactivar ubicación","La ubicación "+l.code+" dejará de usarse para guardado y picking.",function(){api('/locations/'+l.id,{method:'PATCH',body:{active:false}}).then(function(){toast("Ubicación desactivada");reloadLocations();}).catch(err);});});});
      $$("[data-lact]").forEach(function(b){b.addEventListener("click",function(){var id=b.getAttribute("data-lact");api('/locations/'+id,{method:'PATCH',body:{active:true}}).then(function(){toast("Ubicación activada");reloadLocations();}).catch(err);});});
      $$("[data-ldel]").forEach(function(b){b.addEventListener("click",function(){var l=byId(D.locations,b.getAttribute("data-ldel"));openConfirm("Eliminar ubicación","Se eliminará la ubicación "+l.code+". Solo es posible si nunca registró movimientos de stock; si los tuvo, el sistema te pedirá desactivarla en su lugar.",function(){api('/locations/'+l.id,{method:'DELETE'}).then(function(){toast("Ubicación "+l.code+" eliminada");reloadLocations();}).catch(function(e){openModal("No se pudo eliminar",'<p class="muted" style="margin:0 0 18px">'+esc(e.message||'Error')+'</p><div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn" id="m-no">Cerrar</button>'+(l.active!==false?'<button class="btn danger" id="m-deact">Desactivar ahora</button>':'')+'</div>');$("#m-no").addEventListener("click",closeModal);if($("#m-deact"))$("#m-deact").addEventListener("click",function(){api('/locations/'+l.id,{method:'PATCH',body:{active:false}}).then(function(){closeModal();toast("Ubicación desactivada");reloadLocations();}).catch(err);});});});});});
    }
  }

  // ----- Carga masiva de ubicaciones (Excel) -----
  function downloadAuth(path,filename,okMsg,onErr){
    var h={}; if(token)h['Authorization']='Bearer '+token;
    return fetch(API+path,{headers:h}).then(function(r){if(!r.ok)throw new Error('No se pudo generar el archivo');return r.blob();}).then(function(b){var u=URL.createObjectURL(b);var a=document.createElement('a');a.href=u;a.download=filename;document.body.appendChild(a);a.click();document.body.removeChild(a);setTimeout(function(){URL.revokeObjectURL(u);},1500);if(okMsg)toast(okMsg);}).catch(function(e){if(onErr)onErr(e);else err(e);});
  }
  function openLocationImport(){
    var b64="";
    var html='<div class="form" style="gap:14px">'
      +'<p class="muted" style="margin:0">Crea o edita ubicaciones en masa con Excel. Las ubicaciones <b>nuevas</b> se crean; las <b>existentes</b> (mismo código) se editan — primero verás qué cambia y deberás confirmar.</p>'
      +'<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="btn" id="li-tpl">⬇ Descargar formato Excel</button><button class="btn" id="li-cur">⬇ Exportar ubicaciones actuales</button></div>'
      +'<div class="fld"><label>Archivo de ubicaciones (.xlsx o .csv)</label><input type="file" id="li-file" accept=".xlsx,.xls,.csv"></div>'
      +'<div class="ferr" id="li-err"></div>'
      +'<div id="li-result"></div>'
      +'<div class="acts"><span class="hint">Nada se guarda hasta que confirmes.</span><div style="display:flex;gap:10px"><button class="btn" id="li-cancel">Cerrar</button><button class="btn pri" id="li-analyze">Analizar cambios</button></div></div>'
      +'</div>';
    openModal("Carga masiva de ubicaciones",html,true);
    $("#li-cancel").addEventListener("click",closeModal);
    $("#li-tpl").addEventListener("click",function(){$("#li-err").textContent="";downloadAuth('/operations/'+encodeURIComponent(op)+'/location-import/template','plantilla-ubicaciones-ninjawms.xlsx',"Formato descargado",function(e){$("#li-err").textContent=e.message;});});
    $("#li-cur").addEventListener("click",function(){$("#li-err").textContent="";downloadAuth('/operations/'+encodeURIComponent(op)+'/location-import/export','ubicaciones-ninjawms.xlsx',"Ubicaciones exportadas",function(e){$("#li-err").textContent=e.message;});});
    function renderPreview(j){
      var box=$("#li-result");
      if(!j||j.ok===false){box.innerHTML='<div class="apprv-box warn"><div class="apprv-t">No se pudo analizar el archivo</div><div class="hint">'+esc((j&&j.error)||'Error')+'</div></div>';return;}
      var r=j.resumen||{}; var total=(r.nuevas||0)+(r.modificar||0);
      var html='<div class="apprv-box '+(total>0?'ok':'warn')+'"><div class="apprv-t">'+(r.nuevas||0)+' nueva(s) · '+(r.modificar||0)+' a modificar</div><div class="hint">'+(r.sinCambios||0)+' sin cambios · '+(r.errores||0)+' con error</div></div>';
      if(j.toCreate&&j.toCreate.length){html+='<div style="margin-top:12px"><p class="sec-t" style="margin:0 0 4px">Ubicaciones nuevas</p>'+j.toCreate.map(function(c){return '<div class="hint">• <b class="mono2">'+esc(c.code)+'</b> — '+esc(c.zona)+' · capacidad '+esc(c.capacidad)+' · cercanía '+esc(c.pickRank)+'</div>';}).join('')+'</div>';}
      if(j.toUpdate&&j.toUpdate.length){html+='<div style="margin-top:12px"><p class="sec-t" style="margin:0 0 4px">Modificaciones — revisa antes de confirmar</p>'+j.toUpdate.map(function(u){return '<div style="border:1px solid var(--line);border-radius:8px;padding:8px 10px;margin-bottom:6px"><b class="mono2">'+esc(u.code)+'</b>'+u.changes.map(function(c){return '<div class="hint">'+esc(c.campo)+': <span style="color:var(--crit)">'+esc(c.de)+'</span> → <span style="color:var(--good)">'+esc(c.a)+'</span></div>';}).join('')+'</div>';}).join('')+'</div>';}
      if(j.errors&&j.errors.length){html+='<div style="margin-top:12px"><p class="sec-t" style="margin:0 0 4px">Errores (esas filas se omiten)</p>'+j.errors.map(function(e){return '<div class="hint">Fila '+esc(e.fila)+': '+esc(e.motivo)+'</div>';}).join('')+'</div>';}
      if(total>0){html+='<div style="margin-top:14px;display:flex;justify-content:flex-end"><button class="btn pri" id="li-commit">Confirmar y cargar ('+total+')</button></div>';}
      box.innerHTML=html;
      if($("#li-commit"))$("#li-commit").addEventListener("click",function(){
        var btn=this; btn.disabled=true; btn.textContent="Cargando…";
        api('/operations/'+encodeURIComponent(op)+'/location-import/commit',{method:'POST',body:{dataBase64:b64}}).then(function(res){
          var rr=res.resumen||{};
          toast((rr.creadas||0)+" creada(s), "+(rr.modificadas||0)+" modificada(s)");
          box.innerHTML='<div class="apprv-box ok"><div class="apprv-t">Listo: '+(rr.creadas||0)+' creada(s) · '+(rr.modificadas||0)+' modificada(s)</div><div class="hint">'+(rr.errores||0)+' con error</div></div>'
            +((res.errores||[]).length?'<div style="margin-top:8px">'+res.errores.map(function(e){return '<div class="hint">'+esc(e.code)+': '+esc(e.motivo)+'</div>';}).join('')+'</div>':'');
          reloadLocations();
        }).catch(function(e){btn.disabled=false;btn.textContent="Confirmar y cargar";$("#li-err").textContent=e.message;});
      });
    }
    $("#li-analyze").addEventListener("click",function(){
      $("#li-err").textContent=""; $("#li-result").innerHTML="";
      var inp=$("#li-file"); var f=inp&&inp.files&&inp.files[0];
      if(!f){$("#li-err").textContent="Elige un archivo primero.";return;}
      var btn=this; btn.disabled=true; btn.textContent="Analizando…";
      var rd=new FileReader();
      rd.onload=function(){
        b64=String(rd.result||"").split(',')[1]||"";
        api('/operations/'+encodeURIComponent(op)+'/location-import/preview',{method:'POST',body:{dataBase64:b64}}).then(function(j){renderPreview(j);}).catch(function(e){$("#li-err").textContent=e.message;}).then(function(){btn.disabled=false;btn.textContent="Analizar cambios";});
      };
      rd.onerror=function(){$("#li-err").textContent="No se pudo leer el archivo.";btn.disabled=false;btn.textContent="Analizar cambios";};
      rd.readAsDataURL(f);
    });
  }

  function renderCounts(){
    var sel=D.sellers.filter(function(s){return s.id===seller;})[0];
    $("#cc-strat").textContent=sel?sel.cycleCountStrategy:"—";
    $("#cc-body").innerHTML=D.plan.length?D.plan.map(function(t){
      return '<tr><td class="num" style="text-align:left">P'+t.priority+'</td><td>'+esc(t.label)+'</td><td class="muted">'+esc(t.reason)+'</td><td></td></tr>';
    }).join(""):'<tr><td colspan="4" class="empty">Sin tareas de conteo.</td></tr>';
  }

  function renderUsers(){
    var manage=can('user');
    $("#usr-scope").textContent = role==="PLATFORM_ADMIN" ? "Usuarios de todas las operaciones." : ("Usuarios de tu operación ("+(opName(op))+").");
    $("#usr-body").innerHTML=D.users.length?D.users.map(function(u){
      var acts="";
      if(manage){
        acts='<div class="rowacts"><button class="mini" data-uedit="'+esc(u.id)+'">Editar</button>'
          +'<button class="mini" data-upass="'+esc(u.id)+'">Clave</button>'
          +(u.id===me.id?'' : (u.active
              ? '<button class="mini danger" data-udeact="'+esc(u.id)+'">Desactivar</button>'
              : '<button class="mini" data-uact="'+esc(u.id)+'">Activar</button>'))
          +'</div>';
      }
      return '<tr><td class="sku">'+esc(u.name)+'</td><td>'+esc(u.email)+'</td><td><span class="rolechip r-'+u.role+'">'+esc(u.role.replace("_"," "))+'</span></td><td>'+esc(u.operationId||'—')+'</td><td>'+esc(u.sellerId?('Cliente · '+u.sellerId):(u.role==="PLATFORM_ADMIN"?"Plataforma":"Operación"))+'</td><td><span class="chip st-'+(u.active?'AVAILABLE':'CANCELLED')+'"><span class="dot"></span>'+(u.active?'Activo':'Inactivo')+'</span></td><td>'+acts+'</td></tr>';
    }).join(""):'<tr><td colspan="7" class="empty">Sin usuarios visibles.</td></tr>';
    if(manage){
      $$("#usr-body [data-uedit]").forEach(function(b){b.addEventListener("click",function(){openUserForm(byId(D.users,b.getAttribute("data-uedit")));});});
      $$("#usr-body [data-udeact]").forEach(function(b){b.addEventListener("click",function(){var u=byId(D.users,b.getAttribute("data-udeact"));openConfirm("Desactivar usuario","El usuario "+u.name+" no podrá iniciar sesión.",function(){api('/users/'+u.id+'/deactivate',{method:'POST'}).then(function(){toast("Usuario desactivado");reloadUsers();}).catch(err);});});});
      $$("#usr-body [data-uact]").forEach(function(b){b.addEventListener("click",function(){var id=b.getAttribute("data-uact");api('/users/'+id,{method:'PATCH',body:{active:true}}).then(function(){toast("Usuario activado");reloadUsers();}).catch(err);});});
      $$("#usr-body [data-upass]").forEach(function(b){b.addEventListener("click",function(){openSetPassword(byId(D.users,b.getAttribute("data-upass")));});});
    }
  }

  // ----- Fijar/restablecer contraseña (admin) -----
  function openSetPassword(u){
    var html='<div class="form">'
      +'<p class="muted" style="margin:0">Fijar una nueva contraseña para <b>'+esc(u.name)+'</b> ('+esc(u.email)+').</p>'
      +'<div class="fld"><label>Nueva contraseña</label><input id="pw-new" type="password" autocomplete="new-password" placeholder="mínimo 6 caracteres"></div>'
      +'<div class="ferr" id="pw-err"></div>'
      +'<div class="acts"><span class="hint">El usuario la usará en su próximo ingreso.</span><div style="display:flex;gap:10px"><button class="btn" id="pw-cancel">Cancelar</button><button class="btn pri" id="pw-save">Guardar contraseña</button></div></div>'
      +'</div>';
    openModal("Restablecer contraseña",html);
    $("#pw-cancel").addEventListener("click",closeModal);
    $("#pw-save").addEventListener("click",function(){
      var v=$("#pw-new").value||"";
      if(v.length<6){$("#pw-err").textContent="Mínimo 6 caracteres.";return;}
      api('/users/'+u.id+'/password',{method:'POST',body:{password:v}}).then(function(){closeModal();toast("Contraseña actualizada");}).catch(function(e){$("#pw-err").textContent=e.message;});
    });
  }

  function renderOps(){
    if(role!=="PLATFORM_ADMIN"){$("#ops-grid").innerHTML='<div class="empty">Solo la plataforma ve todas las operaciones.</div>';return;}
    $("#ops-grid").innerHTML=D.ops.map(function(o){
      var inactive=o.active===false;
      var acts='<div class="card-actions"><button class="mini" data-oedit="'+esc(o.id)+'">Editar</button>'
        +'<button class="mini" data-oadmin="'+esc(o.id)+'">＋ Admin</button>'
        +(inactive?'<button class="mini" data-oact="'+esc(o.id)+'">Activar</button>':'<button class="mini danger" data-odeact="'+esc(o.id)+'">Desactivar</button>')+'</div>';
      return '<div class="card"'+(inactive?' style="opacity:.6"':'')+'><div class="opcard"><div class="oi">'+esc(o.id.replace("op-","").slice(0,2).toUpperCase())+'</div><div><div class="on">'+esc(o.name||o.id)+'</div><div class="om">'+esc(o.id)+(inactive?' · inactiva':'')+'</div></div></div>'+acts+'</div>';
    }).join("");
    $$("#ops-grid [data-oedit]").forEach(function(b){b.addEventListener("click",function(){openOpForm(byId(D.ops,b.getAttribute("data-oedit")));});});
    $$("#ops-grid [data-oadmin]").forEach(function(b){b.addEventListener("click",function(){openUserForm(null,{operationId:b.getAttribute("data-oadmin"),role:"ADMIN"});});});
    $$("#ops-grid [data-odeact]").forEach(function(b){b.addEventListener("click",function(){var o=byId(D.ops,b.getAttribute("data-odeact"));openConfirm("Desactivar operación","La operación "+(o.name||o.id)+" quedará inactiva.",function(){api('/operations/'+o.id,{method:'PATCH',body:{active:false}}).then(function(){toast("Operación desactivada");reloadOps();}).catch(err);});});});
    $$("#ops-grid [data-oact]").forEach(function(b){b.addEventListener("click",function(){var id=b.getAttribute("data-oact");api('/operations/'+id,{method:'PATCH',body:{active:true}}).then(function(){toast("Operación activada");reloadOps();}).catch(err);});});
  }

  // ---- Mantenedores (crear / editar / desactivar) --------------------------
  function byId(arr,id){for(var i=0;i<arr.length;i++){if(arr[i].id===id)return arr[i];}return null;}
  function opName(id){var o=byId(D.ops,id);return o?(o.name||o.id):id;}
  function reloadUsers(){return api('/users').then(function(u){D.users=u;renderUsers();}).catch(err);}
  function reloadLocations(){return api('/operations/'+op+'/locations').then(function(ls){D.locations=ls;locByCode={};locById={};ls.forEach(function(l){locByCode[l.code]=l;locById[l.id]=l;});renderLocations();renderKpis();renderZone();}).catch(err);}
  function reloadOps(){return api('/operations').then(function(ops){D.ops=ops;fill($("#op"),ops.map(function(o){return {v:o.id,t:o.name||o.id};}));$("#op").value=op;renderOps();}).catch(err);}

  // ----- Clientes (sellers) -----
  function renderClients(){
    var manage=can('seller');
    $("#cli-scope").textContent = role==="PLATFORM_ADMIN" ? ("Clientes de "+opName(op)+".") : ("Clientes de tu operación ("+opName(op)+").");
    $("#cli-body").innerHTML=D.sellers.length?D.sellers.map(function(s){
      var inactive=s.active===false;
      var acts=manage?('<div class="rowacts"><button class="mini" data-sedit="'+esc(s.id)+'">Editar</button>'
        +'<button class="mini" data-suser="'+esc(s.id)+'">＋ Usuario</button>'
        +(inactive?'<button class="mini" data-sact="'+esc(s.id)+'">Activar</button>':'<button class="mini danger" data-sdeact="'+esc(s.id)+'">Desactivar</button>')+'</div>'):'';
      return '<tr'+(inactive?' style="opacity:.55"':'')+'><td class="sku">'+esc(s.name)+'</td><td class="mono2">'+esc(s.id)+'</td><td>'+esc(PICK_LABEL[s.pickingStrategy]||s.pickingStrategy)+(s.consolidateByLocation?' <span class="rolechip" style="background:var(--surface-3)">Consolida ubic.</span>':'')+(s.autoAllocateOnIngest?' <span class="rolechip" style="background:var(--surface-3)">Reserva auto</span>':'')+'</td><td>'+esc(COUNT_LABEL[s.cycleCountStrategy]||s.cycleCountStrategy)+'</td><td><span class="chip st-'+(inactive?'CANCELLED':'AVAILABLE')+'"><span class="dot"></span>'+(inactive?'Inactivo':'Activo')+'</span></td><td>'+acts+'</td></tr>';
    }).join(""):'<tr><td colspan="6" class="empty">Sin clientes.</td></tr>';
    if(manage){
      $$("#cli-body [data-sedit]").forEach(function(b){b.addEventListener("click",function(){openSellerForm(byId(D.sellers,b.getAttribute("data-sedit")));});});
      $$("#cli-body [data-suser]").forEach(function(b){b.addEventListener("click",function(){openUserForm(null,{operationId:op,role:"CLIENT",sellerId:b.getAttribute("data-suser")});});});
      $$("#cli-body [data-sdeact]").forEach(function(b){b.addEventListener("click",function(){var s=byId(D.sellers,b.getAttribute("data-sdeact"));openConfirm("Desactivar cliente","El cliente "+s.name+" quedará inactivo.",function(){api('/sellers/'+s.id,{method:'PATCH',body:{active:false}}).then(function(){toast("Cliente desactivado");loadOp();}).catch(err);});});});
      $$("#cli-body [data-sact]").forEach(function(b){b.addEventListener("click",function(){var id=b.getAttribute("data-sact");api('/sellers/'+id,{method:'PATCH',body:{active:true}}).then(function(){toast("Cliente activado");loadOp();}).catch(err);});});
    }
  }
  function openSellerForm(s){
    var isEdit=!!s;
    var picks=[["FIFO","FIFO"],["FEFO","FEFO"],["LOT_DIRECTED","Lote/serie dirigido"]];
    var counts=[["ABC","ABC (rotación)"],["LOCATION","Por ubicación"],["RANDOM","Aleatorio"]];
    var pickOpts=picks.map(function(o){return '<option value="'+o[0]+'"'+((s&&s.pickingStrategy===o[0])?' selected':'')+'>'+o[1]+'</option>';}).join("");
    var countOpts=counts.map(function(o){return '<option value="'+o[0]+'"'+((s&&s.cycleCountStrategy===o[0])?' selected':'')+'>'+o[1]+'</option>';}).join("");
    var html='<div class="form">'
      +(isEdit?'':'<div class="fld"><label>Identificador (opcional)</label><input id="sf-id" placeholder="Ej: acme"><span class="hint">Si lo dejas vacío se genera solo.</span></div>')
      +'<div class="fld"><label>Nombre del cliente</label><input id="sf-name" value="'+esc(s?s.name:'')+'" placeholder="Ej: ACME Retail"></div>'
      +'<div class="row2"><div class="fld"><label>Estrategia de picking</label><select id="sf-pick">'+pickOpts+'</select></div>'
      +'<div class="fld"><label>Estrategia de conteo</label><select id="sf-count">'+countOpts+'</select></div></div>'
      +'<label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;background:var(--surface-2);border:1px solid var(--line);border-radius:9px;padding:11px 12px"><input type="checkbox" id="sf-consol"'+((s&&s.consolidateByLocation)?' checked':'')+' style="width:auto;margin-top:2px"><span><b style="font-size:13.5px">Consolidar por ubicación al reservar</b><br><span class="hint">Prefiere tomar todo de una sola ubicación cuando alcance (menos recorrido y menos "puntas"). Respeta FIFO/FEFO como desempate; si ninguna ubicación alcanza sola, combina varias.</span></span></label>'
      +'<div class="fld"><label>Prioridad de courier en la cola de preparación</label><textarea id="sf-courier" rows="4" placeholder="Un courier por línea, en orden de prioridad. Ej:\nRapiboy\nDHL\nBlueExpress\nChilexpress" style="width:100%;padding:8px;border-radius:9px;border:1px solid var(--line);background:var(--surface-2);color:var(--ink);font-family:inherit;font-size:13px">'+esc(((s&&s.courierPriority)||[]).join("\n"))+'</textarea><span class="hint">La cola de preparación ordena primero por estos couriers (el de arriba primero) y, dentro de cada uno, del pedido más antiguo al más nuevo (FIFO). Si lo dejas vacío, la cola va solo por antigüedad.</span></div>'
      // SLA del cliente: deadline de preparación cuando el courier no tiene hora de corte.
      +'<div class="fld"><label>SLA de preparación (horas desde el ingreso)</label><input id="sf-sla" type="number" min="0" max="720" value="'+esc((s&&s.slaHoras)||'')+'" placeholder="Ej: 6 — vacío = sin promesa horaria"><span class="hint">Cuando una orden de este cliente entra con un courier que no tiene hora de corte configurada en la operación, su deadline de preparación es el ingreso más estas horas.</span></div>'
      +'<label style="display:flex;align-items:flex-start;gap:10px;cursor:pointer;background:var(--surface-2);border:1px solid var(--line);border-radius:9px;padding:11px 12px"><input type="checkbox" id="sf-autoalloc"'+((s&&s.autoAllocateOnIngest)?' checked':'')+' style="width:auto;margin-top:2px"><span><b style="font-size:13.5px">Reservar stock apenas ingresa la orden</b><br><span class="hint">Las órdenes de este cliente se reservan de inmediato al ingresar, sin pasar por revisión (quedan en Reservada, listas para pickear). Si no hay stock suficiente, la orden queda Ingresada para revisar.</span></span></label>'
      +'<div class="ferr" id="sf-err"></div>'
      +'<div class="acts"><span class="hint">Operación: '+esc(opName(op))+'</span><div style="display:flex;gap:10px"><button class="btn" id="sf-cancel">Cancelar</button><button class="btn pri" id="sf-save">'+(isEdit?'Guardar':'Crear cliente')+'</button></div></div>'
      +'</div>';
    openModal(isEdit?"Editar cliente":"Nuevo cliente",html);
    $("#sf-cancel").addEventListener("click",closeModal);
    $("#sf-save").addEventListener("click",function(){
      var name=$("#sf-name").value.trim();
      if(!name){$("#sf-err").textContent="El nombre es obligatorio.";return;}
      var courierPriority=($("#sf-courier")?$("#sf-courier").value:"").split(/[\n,;]+/).map(function(x){return x.trim();}).filter(Boolean);
      var body={name:name,pickingStrategy:$("#sf-pick").value,cycleCountStrategy:$("#sf-count").value,consolidateByLocation:$("#sf-consol").checked,courierPriority:courierPriority,slaHoras:Number(($("#sf-sla")||{}).value||0)||0,autoAllocateOnIngest:$("#sf-autoalloc").checked};
      var p;
      if(isEdit){p=api('/sellers/'+s.id,{method:'PATCH',body:body});}
      else{var id=$("#sf-id").value.trim();p=api('/sellers',{method:'POST',body:Object.assign({operationId:op},id?{id:id}:{},body)});}
      p.then(function(res){closeModal();toast(isEdit?"Cliente actualizado":"Cliente creado");loadOp().then(function(){if(!isEdit&&res&&res.id){openConfirm("Crear usuario del cliente","¿Quieres crear ahora el usuario de acceso (Cliente) para "+name+"?",function(){openUserForm(null,{operationId:op,role:"CLIENT",sellerId:res.id});});}});}).catch(function(e){$("#sf-err").textContent=e.message;});
    });
  }
  function num(v){var n=parseInt(v,10);return isNaN(n)?undefined:n;}
  function loadSellersFor(opId){return opId===op?Promise.resolve(D.sellers):api('/operations/'+opId+'/sellers').catch(function(){return [];});}

  // ----- Ubicación -----
  function openLocForm(loc){
    var isEdit=!!loc;
    var zoneOpts=ZONES.map(function(z){return '<option value="'+z[0]+'"'+((loc&&loc.zoneType===z[0])?' selected':'')+'>'+z[1]+'</option>';}).join("");
    var html='<div class="form">'
      +'<div class="fld"><label>Código de la ubicación</label><input id="lf-code" value="'+esc(loc?loc.code:'')+'" placeholder="Ej: A-01-1-A"><span class="hint">Identificador del bin (el que se pistolea).</span></div>'
      +'<div class="row2"><div class="fld"><label>Zona</label><select id="lf-zone">'+zoneOpts+'</select></div>'
      +'<div class="fld"><label>Bodega</label><input id="lf-wh" value="'+esc(loc?loc.warehouseId:'W1')+'"></div></div>'
      +'<div class="row2"><div class="fld"><label>Capacidad (unidades)</label><input id="lf-cap" type="number" min="0" value="'+esc(loc?loc.capacity:0)+'"><span class="hint">0 = sin límite.</span></div>'
      +'<div class="fld"><label>Cercanía a picking</label><input id="lf-rank" type="number" min="1" value="'+esc(loc?loc.pickRank:1)+'"><span class="hint">1 = más cerca (clase A).</span></div></div>'
      +'<div class="ferr" id="lf-err"></div>'
      +'<div class="acts"><span class="hint">Operación: '+esc(opName(op))+'</span><div style="display:flex;gap:10px"><button class="btn" id="lf-cancel">Cancelar</button><button class="btn pri" id="lf-save">'+(isEdit?'Guardar cambios':'Crear ubicación')+'</button></div></div>'
      +'</div>';
    openModal(isEdit?"Editar ubicación":"Nueva ubicación",html);
    $("#lf-cancel").addEventListener("click",closeModal);
    $("#lf-save").addEventListener("click",function(){
      var code=$("#lf-code").value.trim();
      if(!code){$("#lf-err").textContent="El código es obligatorio.";return;}
      var body={code:code,zoneType:$("#lf-zone").value,warehouseId:$("#lf-wh").value.trim()||'W1',capacity:num($("#lf-cap").value),pickRank:num($("#lf-rank").value)};
      var p=isEdit?api('/locations/'+loc.id,{method:'PATCH',body:body}):api('/locations',{method:'POST',body:Object.assign({operationId:op},body)});
      p.then(function(){closeModal();toast(isEdit?"Ubicación actualizada":"Ubicación creada");reloadLocations();}).catch(function(e){$("#lf-err").textContent=e.message;});
    });
  }

  // ----- Operación -----
  function openOpForm(o){
    var isEdit=!!o;
    var html='<div class="form">'
      +(isEdit?'':'<div class="fld"><label>Identificador (opcional)</label><input id="of-id" placeholder="Ej: op-lima"><span class="hint">Si lo dejas vacío se genera solo.</span></div>')
      +'<div class="fld"><label>Nombre de la operación</label><input id="of-name" value="'+esc(o?(o.name||''):'')+'" placeholder="Ej: Bodega Lima"></div>'
      +'<div class="ferr" id="of-err"></div>'
      +'<div class="acts"><span class="hint">'+(isEdit?esc(o.id):'Nueva bodega / administrador aislado')+'</span><div style="display:flex;gap:10px"><button class="btn" id="of-cancel">Cancelar</button><button class="btn pri" id="of-save">'+(isEdit?'Guardar':'Crear operación')+'</button></div></div>'
      +'</div>';
    openModal(isEdit?"Editar operación":"Nueva operación",html);
    $("#of-cancel").addEventListener("click",closeModal);
    $("#of-save").addEventListener("click",function(){
      var name=$("#of-name").value.trim();
      if(!name){$("#of-err").textContent="El nombre es obligatorio.";return;}
      var p;
      if(isEdit){p=api('/operations/'+o.id,{method:'PATCH',body:{name:name}});}
      else{var id=$("#of-id").value.trim();p=api('/operations',{method:'POST',body:id?{id:id,name:name}:{name:name}});}
      p.then(function(res){closeModal();toast(isEdit?"Operación actualizada":"Operación creada");reloadOps().then(function(){if(!isEdit&&res&&res.id){openConfirm("Crear administrador","¿Quieres crear ahora el administrador de "+name+"?",function(){openUserForm(null,{operationId:res.id,role:"ADMIN"});});}});}).catch(function(e){$("#of-err").textContent=e.message;});
    });
  }

  // ----- Usuario -----
  function openUserForm(user,preset){
    preset=preset||{};
    var isEdit=!!user;
    var isPlatform=role==="PLATFORM_ADMIN";
    var roleChoices=isPlatform?["PLATFORM_ADMIN","ADMIN","SUPERVISOR","OPERATOR","CLIENT"]:["ADMIN","SUPERVISOR","OPERATOR","CLIENT"];
    var curRole=user?user.role:(preset.role||"OPERATOR");
    var curOp=user?(user.operationId||""):(preset.operationId||op);
    var roleOpts=roleChoices.map(function(r){return '<option value="'+r+'"'+(r===curRole?' selected':'')+'>'+ROLE_LABEL[r]+'</option>';}).join("");
    // campo operación: plataforma elige; admin fijo a la suya
    var opField;
    if(isEdit){
      opField='<div class="fld"><label>Operación</label><input value="'+esc(user.operationId||'Plataforma')+'" disabled></div>';
    }else if(isPlatform){
      var oo=D.ops.map(function(o){return '<option value="'+esc(o.id)+'"'+(o.id===curOp?' selected':'')+'>'+esc(o.name||o.id)+'</option>';}).join("");
      opField='<div class="fld" id="uf-opwrap"><label>Operación</label><select id="uf-op">'+oo+'</select></div>';
    }else{
      opField='<div class="fld"><label>Operación</label><input value="'+esc(opName(me.operationId))+'" disabled></div>';
    }
    var html='<div class="form">'
      +'<div class="row2"><div class="fld"><label>Nombre</label><input id="uf-name" value="'+esc(user?user.name:'')+'"></div>'
      +'<div class="fld"><label>Email</label><input id="uf-email" value="'+esc(user?user.email:'')+'"'+(isEdit?' disabled':'')+'></div></div>'
      +'<div class="row2"><div class="fld"><label>Rol</label><select id="uf-role">'+roleOpts+'</select></div>'+opField+'</div>'
      +'<div class="fld" id="uf-sellerwrap" style="display:none"><label>Cliente (seller)</label><select id="uf-seller"></select><span class="hint">Requerido para el rol Cliente.</span></div>'
      +(isEdit?'':'<div class="fld"><label>Contraseña inicial (opcional)</label><input id="uf-pass" type="password" autocomplete="new-password" placeholder="mínimo 6 caracteres"><span class="hint">Si la dejas vacía, el usuario queda con invitación pendiente hasta que le fijes una.</span></div>')
      +'<div class="ferr" id="uf-err"></div>'
      +'<div class="acts"><span class="hint">'+(isEdit?'Editar usuario':'Nuevo usuario')+'</span><div style="display:flex;gap:10px"><button class="btn" id="uf-cancel">Cancelar</button><button class="btn pri" id="uf-save">'+(isEdit?'Guardar cambios':'Crear usuario')+'</button></div></div>'
      +'</div>';
    openModal(isEdit?"Editar usuario":"Nuevo usuario",html);
    $("#uf-cancel").addEventListener("click",closeModal);

    function selectedOp(){ if(isEdit)return user.operationId; if(isPlatform){var s=$("#uf-op");return s?s.value:curOp;} return me.operationId; }
    function refreshSeller(){
      var r=$("#uf-role").value, wrap=$("#uf-sellerwrap");
      if(r!=="CLIENT"){wrap.style.display="none";return;}
      wrap.style.display="";
      loadSellersFor(selectedOp()).then(function(sellers){
        var cur=user?user.sellerId:(preset.sellerId||null);
        $("#uf-seller").innerHTML=sellers.length?sellers.map(function(s){return '<option value="'+esc(s.id)+'"'+(s.id===cur?' selected':'')+'>'+esc(s.name)+'</option>';}).join(""):'<option value="">(esta operación no tiene clientes)</option>';
      });
    }
    // plataforma: si elige rol PLATFORM_ADMIN, la operación no aplica
    function refreshOpEnable(){
      if(isEdit||!isPlatform)return;
      var r=$("#uf-role").value, ow=$("#uf-op");
      if(ow){ow.disabled=(r==="PLATFORM_ADMIN");}
    }
    $("#uf-role").addEventListener("change",function(){refreshSeller();refreshOpEnable();});
    if($("#uf-op"))$("#uf-op").addEventListener("change",refreshSeller);
    refreshSeller();refreshOpEnable();

    $("#uf-save").addEventListener("click",function(){
      var name=$("#uf-name").value.trim(), email=$("#uf-email").value.trim(), r=$("#uf-role").value;
      $("#uf-err").textContent="";
      if(!name){$("#uf-err").textContent="El nombre es obligatorio.";return;}
      if(!isEdit&&!email){$("#uf-err").textContent="El email es obligatorio.";return;}
      var sellerId=(r==="CLIENT")?($("#uf-seller").value||null):null;
      if(r==="CLIENT"&&!sellerId){$("#uf-err").textContent="El rol Cliente necesita un seller.";return;}
      var p;
      if(isEdit){
        p=api('/users/'+user.id,{method:'PATCH',body:{name:name,role:r,sellerId:sellerId}});
      }else{
        var opId=(r==="PLATFORM_ADMIN")?null:selectedOp();
        var pass=($("#uf-pass")&&$("#uf-pass").value)||"";
        if(pass&&pass.length<6){$("#uf-err").textContent="La contraseña debe tener al menos 6 caracteres.";return;}
        var reg={name:name,email:email,role:r,operationId:opId,sellerId:sellerId};
        if(pass)reg.password=pass;
        p=api('/users',{method:'POST',body:reg});
      }
      p.then(function(){closeModal();toast(isEdit?"Usuario actualizado":"Usuario creado");reloadUsers();}).catch(function(e){$("#uf-err").textContent=e.message;});
    });
  }

  // ---- Modal / drawer / export / búsqueda / util ---------------------------
  // ---- Falta de stock: ventana centrada con el detalle POR ORDEN ----------------
  // Un aviso pasajero no sirve aquí: hay que ver qué producto falta, cuánto, y si el
  // stock existe pero está en el dock de recepción sin guardar (el caso más común).
  function faltantesTable(faltantes){
    var hayRecepcion=faltantes.some(function(f){return f.enRecepcion>0;});
    return '<div class="tablewrap"><table class="short-t"><thead><tr>'
      +'<th>Producto</th><th class="num">Pide</th><th class="num">Disponible</th><th class="num">Falta</th><th>Dónde está</th>'
      +'</tr></thead><tbody>'
      +faltantes.map(function(f){
        var donde;
        if(f.enRecepcion>0){
          // Además del total en el dock, DE QUÉ recepción viene y cuánto de cada una,
          // para poder ir a buscarla sin revisar las recepciones una por una.
          donde='<span class="short-hint">'+f.enRecepcion+' un en recepción sin guardar</span>';
          if(f.recepciones&&f.recepciones.length){
            donde+='<div class="short-recs">'+f.recepciones.map(function(r){
              var nombre=r.referencia||r.id;
              var extra=[r.proveedor,r.fecha?fmtDate(r.fecha):null].filter(Boolean).join(' · ');
              return '<div class="short-rec"><span class="rc">'+esc(nombre)+'</span>'
                +'<span class="rq">'+r.cantidad+' un</span>'
                +(extra?'<span class="rx">'+esc(extra)+'</span>':'')+'</div>';
            }).join('')+'</div>';
          }
        } else if(f.enOtrasZonas>0){ donde='<span class="muted">'+f.enOtrasZonas+' un en zonas no reservables</span>'; }
        else { donde='<span class="muted">sin stock</span>'; }
        return '<tr><td><b class="sku">'+esc(f.sku)+'</b>'+(f.descripcion?'<div class="muted" style="font-size:12px">'+esc(f.descripcion)+'</div>':'')
          +(f.lot?'<div class="muted" style="font-size:11.5px">Lote '+esc(f.lot)+'</div>':'')+'</td>'
          +'<td class="num">'+f.requerido+'</td><td class="num">'+f.reservable+'</td>'
          +'<td class="num" style="color:var(--crit);font-weight:700">'+f.falta+'</td>'
          +'<td>'+donde+'</td></tr>';
      }).join('')
      +'</tbody></table></div>'
      +(hayRecepcion?'<p class="muted" style="margin:12px 0 0;line-height:1.5">Parte de lo que falta ya está en la bodega, en el dock de <b>recepción</b>, con la recepción de la que vino. Solo se puede reservar el stock guardado en almacenaje o picking: guárdalo desde <b>Almacenado</b> y vuelve a reservar.</p>':'');
  }
  /** Muestra el detalle de faltantes de UNA orden. Devuelve true si supo mostrarlo. */
  function showStockShortage(err,ordenRef){
    var d=err&&err.data; var fs=d&&d.faltantes;
    if(!fs||!fs.length)return false;
    var ref=(d&&d.orden)||ordenRef||'';
    var hayRecepcion=fs.some(function(f){return f.enRecepcion>0;});
    var html='<div class="form" style="gap:14px">'
      +'<p style="margin:0;line-height:1.5">No se pudo reservar '+(ref?('la orden <b>'+esc(ref)+'</b>'):'la orden')+': falta stock de <b>'+fs.length+' producto(s)</b>.</p>'
      +faltantesTable(fs)
      +'<div class="acts" style="justify-content:flex-end"><div style="display:flex;gap:10px">'
      +(hayRecepcion?'<button class="btn" id="sh-putaway">Ir a Almacenado</button>':'')
      +'<button class="btn pri" id="sh-close">Entendido</button></div></div>'
      +'</div>';
    openModal('No se pudo reservar la orden',html,true);
    $("#sh-close").addEventListener("click",closeModal);
    if($("#sh-putaway"))$("#sh-putaway").addEventListener("click",function(){closeModal();go('putaway');});
    return true;
  }
  /** Error de reserva: ventana con detalle si lo hay; si no, el aviso de siempre. */
  function reserveError(e,ordenRef){ if(!showStockShortage(e,ordenRef))toast(e.message); }

  // ---- Autocompletado reutilizable ------------------------------------------
  // Un solo componente para todos los campos donde antes había un desplegable: acepta
  // pegar o escribir, filtra sobre la lista que le pase quien lo usa, y se dibuja en una
  // capa fija para que no lo recorte el scroll de un formulario. Lo usan el producto de
  // una orden, y el producto y las ubicaciones del formulario de mover stock.
  var AC = (function () {
    var box=null, list=[], idx=-1, inp=null, cfg=null;
    function close(){ if(box&&box.parentNode)box.parentNode.removeChild(box); box=null; list=[]; idx=-1; inp=null; cfg=null; }
    function place(){
      if(!box||!inp)return; var r=inp.getBoundingClientRect();
      box.style.left=Math.round(r.left)+'px'; box.style.width=Math.round(r.width)+'px';
      var below=window.innerHeight-r.bottom;
      if(below<180&&r.top>below){ box.style.top=''; box.style.bottom=Math.round(window.innerHeight-r.top+4)+'px'; }
      else { box.style.bottom=''; box.style.top=Math.round(r.bottom+4)+'px'; }
    }
    function mark(txt,q){
      txt=String(txt==null?'':txt); if(!q)return esc(txt);
      var i=txt.toLowerCase().indexOf(String(q).toLowerCase());
      if(i<0)return esc(txt);
      return esc(txt.slice(0,i))+'<b>'+esc(txt.slice(i,i+q.length))+'</b>'+esc(txt.slice(i+q.length));
    }
    function paint(q){
      if(!box)return;
      box.innerHTML=list.length
        ? list.map(function(it,i){ return '<div class="ac-it'+(i===idx?' on':'')+'" data-i="'+i+'">'+cfg.row(it,q)+'</div>'; }).join('')
        : '<div class="ac-empty">'+esc(cfg.empty||'Sin coincidencias')+'</div>';
      Array.prototype.forEach.call(box.querySelectorAll('.ac-it'),function(el){
        el.addEventListener('mousedown',function(ev){ ev.preventDefault(); pick(parseInt(el.getAttribute('data-i'),10)); });
        el.addEventListener('mouseenter',function(){ idx=parseInt(el.getAttribute('data-i'),10);
          Array.prototype.forEach.call(box.querySelectorAll('.ac-it'),function(x,j){x.classList.toggle('on',j===idx);}); });
      });
    }
    function open(input,c){
      inp=input; cfg=c;
      var q=input.value.trim();
      list=c.match(q)||[]; idx=list.length?0:-1;
      if(!box){ box=document.createElement('div'); box.className='ac-box'; document.body.appendChild(box); }
      paint(q); place();
    }
    function pick(i){
      if(i<0||!list[i]||!cfg)return;
      var it=list[i], c=cfg, el=inp; close(); c.pick(it,el);
    }
    window.addEventListener('resize',close);
    document.addEventListener('scroll',function(){ if(box)place(); },true);
    return {
      mark: mark,
      close: close,
      /** Vuelve a calcular las opciones si la lista de ese campo está abierta
       *  (p. ej. cuando los datos llegaron después de abrirla). */
      refresh: function(input){ if(box&&inp===input&&cfg)open(input,cfg); },
      attach: function(input,c){
        if(!input)return;
        input.setAttribute('autocomplete','off'); input.setAttribute('spellcheck','false');
        input.addEventListener('input',function(){ if(c.onType)c.onType(input); open(input,c); });
        input.addEventListener('focus',function(){ open(input,c); });
        input.addEventListener('blur',function(){ setTimeout(function(){ if(inp===input)close(); if(c.onBlur)c.onBlur(input); },120); });
        input.addEventListener('keydown',function(e){
          if(e.key==='ArrowDown'||e.key==='ArrowUp'){
            if(!box)open(input,c);
            if(!list.length)return;
            e.preventDefault();
            idx=(idx+(e.key==='ArrowDown'?1:-1)+list.length)%list.length;
            paint(input.value.trim());
            var on=box.querySelector('.ac-it.on'); if(on&&on.scrollIntoView)on.scrollIntoView({block:'nearest'});
          } else if(e.key==='Enter'){ if(box&&idx>=0){ e.preventDefault(); pick(idx); } }
          else if(e.key==='Escape'){ if(box){ e.preventDefault(); close(); } }
        });
      }
    };
  })();

  function openModal(title,html,wide){$("#m-title").textContent=title;$("#m-body").innerHTML=html;var p=$("#m-panel");if(p){p.classList.toggle("wide",wide===true);p.classList.toggle("xl",wide==='xl');}$("#modal").classList.add("on");}
  function closeModal(){$("#modal").classList.remove("on");}
  $("#m-x").addEventListener("click",closeModal);
  $("#modal").addEventListener("click",function(e){if(e.target===$("#modal"))closeModal();});
  function openConfirm(title,msg,ok){openModal(title,'<p class="muted" style="margin:0 0 18px">'+esc(msg)+'</p><div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn" id="m-no">No</button><button class="btn danger" id="m-yes">Sí, confirmar</button></div>');$("#m-yes").addEventListener("click",function(){closeModal();ok();});$("#m-no").addEventListener("click",closeModal);}
  // Confirmación con mensaje HTML y etiqueta de acción personalizable (aviso, no destructiva).
  function confirmBox(title,htmlMsg,okLabel,ok,danger){openModal(title,'<div class="muted" style="margin:0 0 18px;line-height:1.5">'+htmlMsg+'</div><div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn" id="m-no">Cancelar</button><button class="btn '+(danger?'danger':'pri')+'" id="m-yes">'+esc(okLabel||'Continuar')+'</button></div>');$("#m-yes").addEventListener("click",function(){closeModal();ok();});$("#m-no").addEventListener("click",closeModal);}
  function exportCSV(title,header,rows){var csv=[header.join(",")].concat(rows.map(function(r){return r.join(",");})).join("\n");openModal("Exportar — "+title,'<p class="muted" style="margin:0 0 10px">Copia estos datos (CSV).</p><textarea rows="9" readonly>'+esc(csv)+'</textarea><div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px"><button class="btn" id="m-no">Cerrar</button><button class="btn pri" id="m-copy">Copiar</button></div>');$("#m-no").addEventListener("click",closeModal);$("#m-copy").addEventListener("click",function(){var ta=$("#m-body textarea");ta.select();try{document.execCommand("copy");}catch(e){}toast("Copiado");});}
  $("#inv-export").addEventListener("click",function(){var t=document.getElementById("inv-body");tableToXlsx(t?t.closest("table"):null,"ninjawms-inventario.xlsx","Inventario");});
  $("#ord-export").addEventListener("click",exportOrders);

  $("#gq").addEventListener("input",function(){
    var q=this.value.toLowerCase().trim(),res=$("#gres"); if(!q){res.classList.remove("on");return;}
    var hits=[];
    D.inv.forEach(function(b){if(b.sku.toLowerCase().indexOf(q)>=0)hits.push({t:b.sku+" · "+code(b.locationId),k:"Inventario",pg:"inventory"});});
    D.ord.forEach(function(o){var id=o.externalOrderId||o.id;if(id.toLowerCase().indexOf(q)>=0)hits.push({t:id+" · "+STN[o.status],k:"Órdenes",pg:"orders"});});
    D.locations.forEach(function(l){if(l.code.toLowerCase().indexOf(q)>=0)hits.push({t:l.code+" · "+zoneName(l.zoneType),k:"Ubicaciones",pg:"locations"});});
    var uniq={},list=[];hits.forEach(function(h){var kk=h.t+h.pg;if(!uniq[kk]){uniq[kk]=1;list.push(h);}});
    res.innerHTML=list.length?list.slice(0,6).map(function(h){return '<a data-pg="'+h.pg+'"><span>'+esc(h.t)+'</span><span class="muted">'+h.k+'</span></a>';}).join(""):'<a><span class="muted">Sin resultados</span></a>';
    res.classList.add("on");
    $$("#gres a[data-pg]").forEach(function(a){a.addEventListener("click",function(){go(a.getAttribute("data-pg"));res.classList.remove("on");$("#gq").value="";});});
  });
  document.addEventListener("click",function(e){if(!e.target.closest(".gsearch"))$("#gres").classList.remove("on");});

  function wireTips(root){var tt=$("#tt");root.querySelectorAll("[data-tip]").forEach(function(el){el.addEventListener("mousemove",function(e){tt.textContent=el.getAttribute("data-tip");tt.style.opacity="1";tt.style.left=(e.clientX+12)+"px";tt.style.top=(e.clientY-10)+"px";});el.addEventListener("mouseleave",function(){tt.style.opacity="0";});});}
  var toastT; function toast(m){var t=$("#toast");$("#toast-i").textContent="✓  "+m;t.classList.add("on");clearTimeout(toastT);toastT=setTimeout(function(){t.classList.remove("on");},2600);}
  function err(e){toast((e&&e.message)||"Error de conexión");}

  // ----- Agente proactivo (Fase 1): reglas + alertas -----
  var AGT_SEV={crit:{c:'var(--crit)',t:'Crítico'},warn:{c:'var(--signal,#F0A24A)',t:'Alerta'},info:{c:'var(--primary)',t:'Info'}};
  function agtScope(){return 'operationId='+encodeURIComponent(op);}
  function agtCanSee(){return !!token&&!!op&&(role==='ADMIN'||role==='SUPERVISOR'||role==='PLATFORM_ADMIN');}
  function agtBadge(n){var b=$('#nav-agente');if(b){b.textContent=n?String(n):'';b.style.display=n?'':'none';}}
  /**
   * Dispara un ciclo del agente desde donde se pida y refresca lo que esté en pantalla.
   * Vive aparte porque el botón está en dos pestañas (configuración y alertas).
   */
  function agtCiclo(btn, despues){
    if(!op)return;
    if(btn)btn.disabled=true;
    api('/agent/sweep',{method:'POST',body:{operationId:op}}).then(function(r){
      if(btn)btn.disabled=false;
      var b=r&&r.barrido;
      toast(r&&r.skipped?('Ciclo omitido: '+r.skipped):(b?('Ciclo: '+b.nuevas+' alerta(s) nueva(s), '+b.ejecutadas+' ejecutada(s), '+b.propuestas+' propuesta(s), '+b.sombra+' en sombra'):'Ciclo ejecutado'));
      if(despues)despues();
    }).catch(function(e){ if(btn)btn.disabled=false; toast(e.message); });
  }
  /**
   * Pestaña AGENTE: solo configuración — estado y autonomía, ventanas horarias,
   * instrucciones y reglas. El diario y las alertas viven en su propia pantalla
   * (son bitácora y bandeja de trabajo, no ajustes que uno viene a tocar).
   */
  function renderAgente(){
    if(!op)return;
    var ev=$('#agt-eval');
    if(ev)ev.onclick=function(){ agtCiclo(ev, renderAgente); };
    api('/agent/status?operationId='+encodeURIComponent(op)).then(function(st){ paintAgentStatus(st); paintAgentAgenda(st); }).catch(function(){});
    api('/agent/rules?'+agtScope()).then(paintAgentRules).catch(function(){});
    api('/agent/instructions?operationId='+encodeURIComponent(op)).then(paintAgentInstructions).catch(function(){});
    agtRefrescaInsignia();
  }
  /** Pestaña ALERTAS ACTIVAS. */
  function renderAgAlertas(){
    if(!op)return;
    var ev=$('#aga-eval');
    if(ev)ev.onclick=function(){ agtCiclo(ev, renderAgAlertas); };
    api('/agent/alerts?'+agtScope()).then(paintAgentAlerts).catch(function(){});
  }
  /** Pestaña DIARIO DEL AGENTE. */
  function renderAgDiario(){
    if(!op)return;
    var b=$('#agd-now');
    if(b&&!b.__bound){ b.__bound=true; b.addEventListener('click',renderAgDiario); }
    api('/agent/journal?operationId='+encodeURIComponent(op)+'&limit=40').then(paintAgentJournal).catch(function(){});
  }
  /**
   * La insignia del menú cuenta alertas abiertas, así que hay que saber cuántas hay
   * aunque no estemos en esa pestaña. paintAgentAlerts ya la actualiza cuando la
   * pantalla está montada; esto cubre el resto de los casos sin pintar nada.
   */
  function agtRefrescaInsignia(){
    if(!op)return;
    api('/agent/alerts?'+agtScope()).then(function(d){ agtBadge(((d&&d.abiertas)||[]).length); }).catch(function(){});
  }
  var AGT_LEVELS=[['0','0 · Observador — solo vigila y propone'],['1','1 · Asistido — asigna y balancea solo; el resto propone'],['2','2 · Supervisado — además avanza órdenes, crea recepciones/órdenes y configura automatismos'],['3','3 · Autónomo — todo dentro de límites; escala excepciones']];
  function paintAgentStatus(st){
    var box=$('#agt-status'); if(!box||!st)return;
    var s=st.settings||{};
    var lc=st.lastCycle; var lcTxt=lc?(fmtDate(lc.at)+' · '+((lc.summary&&(lc.summary.nuevas||0))+' alerta(s), '+(lc.summary&&(lc.summary.ejecutadas||0))+' ejecutada(s), '+(lc.summary&&(lc.summary.sombra||0))+' sombra'+((lc.summary&&lc.summary.llm)?', LLM':''))):'aún sin ciclos desde el arranque';
    var canEdit=can('master');
    box.innerHTML='<div class="apprv-box '+(s.paused?'warn':'ok')+'" style="margin-bottom:12px"><div class="apprv-t">'+(s.paused?'⏸ Agente en pausa':(st.scheduler&&st.scheduler.enabled?'● Agente corriendo en el servidor cada '+st.scheduler.intervalSec+' s':'○ Scheduler desactivado en el servidor'))+(s.shadowMode?' · MODO SOMBRA':'')+'</div><div class="hint">Último ciclo: '+esc(lcTxt)+' · Llamadas LLM hoy: '+(st.llmCallsToday||0)+'/'+(s.maxLlmCallsPerDay||0)+'</div></div>'
      +'<div class="form" style="gap:10px">'
      +'<div class="row2"><div class="fld"><label>Nivel de autonomía</label><select id="ags-level"'+(canEdit?'':' disabled')+'>'+AGT_LEVELS.map(function(l){return '<option value="'+l[0]+'"'+(String(s.autonomyLevel)===l[0]?' selected':'')+'>'+esc(l[1])+'</option>';}).join('')+'</select><span class="hint">Cada acción tiene un nivel mínimo; bajo ese nivel queda propuesta para que la confirmes.</span></div>'
      +'<div class="fld"><label>Modo del copiloto</label><select id="ags-mode"'+(canEdit?'':' disabled')+'><option value="confirm"'+(s.actionMode!=='direct'?' selected':'')+'>Confirmación (las acciones quedan propuestas)</option><option value="direct"'+(s.actionMode==='direct'?' selected':'')+'>Directo (ejecuta según el nivel)</option></select></div></div>'
      +'<div class="row2"><label style="display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" id="ags-shadow" '+(s.shadowMode?'checked':'')+(canEdit?'':' disabled')+' style="width:auto"> <b>Modo sombra</b> <span class="hint">— decide y registra lo que haría, sin ejecutar</span></label>'
      +'<label style="display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" id="ags-paused" '+(s.paused?'checked':'')+(canEdit?'':' disabled')+' style="width:auto"> <b>Pausar agente</b> <span class="hint">— no inicia nada nuevo</span></label></div>'
      +'<div class="row2"><div class="fld"><label>Máx. acciones por ciclo</label><input id="ags-maxc" type="number" min="0" value="'+(s.maxActionsPerCycle||0)+'"'+(canEdit?'':' disabled')+'></div><div class="fld"><label>Máx. acciones por hora</label><input id="ags-maxh" type="number" min="0" value="'+(s.maxActionsPerHour||0)+'"'+(canEdit?'':' disabled')+'></div></div>'
      +'<div class="row2"><div class="fld"><label>Correo para alertas críticas y excepciones</label><input id="ags-email" type="email" value="'+esc(s.notifyEmail||'')+'" placeholder="supervisor@empresa.cl"'+(canEdit?'':' disabled')+'></div><div class="fld"><label>Webhook (POST con las alertas nuevas)</label><input id="ags-wh" type="url" value="'+esc(s.notifyWebhookUrl||'')+'" placeholder="https://…"'+(canEdit?'':' disabled')+'></div></div>'
      +'<div class="row2"><label style="display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" id="ags-llm" '+(s.llmPlanning?'checked':'')+(canEdit?'':' disabled')+' style="width:auto"> <b>Planificación con IA</b> <span class="hint">— el agente razona con el LLM conectado y propone/ejecuta según la política</span></label>'
      +'<div style="display:flex;gap:8px"><div class="fld" style="flex:1"><label>Cada (min)</label><input id="ags-llmmin" type="number" min="1" value="'+(s.llmEveryMin||15)+'"'+(canEdit?'':' disabled')+'></div><div class="fld" style="flex:1"><label>Máx. llamadas/día</label><input id="ags-llmmax" type="number" min="0" value="'+(s.maxLlmCallsPerDay||0)+'"'+(canEdit?'':' disabled')+'></div></div></div>'
      +(canEdit?'<div class="acts"><span class="hint">Los cambios rigen desde el próximo ciclo.</span><button class="btn pri" id="ags-save">Guardar ajustes</button></div>':'')
      +'</div>';
    if($('#ags-save'))$('#ags-save').addEventListener('click',function(){
      var body={operationId:op,autonomyLevel:parseInt($('#ags-level').value,10),actionMode:$('#ags-mode').value,shadowMode:$('#ags-shadow').checked,paused:$('#ags-paused').checked,maxActionsPerCycle:parseInt($('#ags-maxc').value,10)||0,maxActionsPerHour:parseInt($('#ags-maxh').value,10)||0,notifyEmail:$('#ags-email').value.trim()||null,notifyWebhookUrl:$('#ags-wh').value.trim()||null,llmPlanning:$('#ags-llm').checked,llmEveryMin:parseInt($('#ags-llmmin').value,10)||15,maxLlmCallsPerDay:parseInt($('#ags-llmmax').value,10)||0};
      api('/agent/settings',{method:'PATCH',body:body}).then(function(){toast('Ajustes del agente guardados');renderAgente();}).catch(function(e){toast(e.message);});
    });
  }

  // ---- Ventanas horarias del agente ----------------------------------------
  // El agente barre reglas cada pocos minutos: eso es determinista y gratis. Lo
  // que cuesta es consultar al LLM, y no siempre se quiere corriendo de
  // madrugada o un domingo. Acá se define cuándo puede.
  var AGW_DIAS=['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
  var AGW_TZ=['America/Santiago','America/Lima','America/Bogota','America/Mexico_City','America/Argentina/Buenos_Aires','America/Sao_Paulo','Europe/Madrid','UTC'];
  var AGW=null; // borrador en edición

  function agwFila(v,i,canEdit){
    return '<div class="agw" data-i="'+i+'">'
      +'<div class="fld" style="min-width:210px"><label>Días</label><div class="agw-dias">'
      + AGW_DIAS.map(function(n,d){ return '<button type="button" class="agw-dia'+(v.dias.indexOf(d)>=0?' on':'')+'" data-dia="'+d+'"'+(canEdit?'':' disabled')+'>'+n+'</button>'; }).join('')
      +'</div></div>'
      +'<div class="fld"><label>Desde</label><input type="time" class="agw-desde" value="'+esc(v.desde)+'"'+(canEdit?'':' disabled')+' style="width:120px"></div>'
      +'<div class="fld"><label>Hasta</label><input type="time" class="agw-hasta" value="'+esc(v.hasta)+'"'+(canEdit?'':' disabled')+' style="width:120px"></div>'
      +'<span class="hint" style="align-self:center">'+(agwCruza(v)?'cruza la medianoche':'')+'</span>'
      +(canEdit?'<button class="mini agw-del" data-del="'+i+'">Quitar</button>':'')
      +'</div>';
  }
  function agwCruza(v){ return String(v.hasta||'') <= String(v.desde||''); }

  /**
   * La próxima apertura se muestra en la hora de la OPERACIÓN, no en la del
   * navegador: si configuraste 08:00 en Santiago, tiene que decir 08:00 aunque
   * estés mirando el panel desde Madrid.
   */
  function agwHoraLocal(iso,tz){
    try{
      return new Date(iso).toLocaleString('es-CL',{timeZone:tz,weekday:'short',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})+' ('+tz+')';
    }catch(e){ return fmtDate(iso); }
  }

  function paintAgentAgenda(st){
    var box=$('#agt-agenda'); if(!box||!st)return;
    var canEdit=can('master');
    AGW=JSON.parse(JSON.stringify((st.settings&&st.settings.agenda)||{activo:false,tz:'America/Santiago',alcance:'llm',ventanas:[]}));
    if(!AGW.ventanas)AGW.ventanas=[];
    var v=st.ventana||{};
    var estado=AGW.activo
      ? '<div class="agw-estado '+(v.dentro?'on':'off')+'">'+(v.dentro?'Dentro de ventana — el agente puede consultar al LLM':'Fuera de ventana'+(v.proximaAperturaIso?' — abre '+esc(agwHoraLocal(v.proximaAperturaIso,AGW.tz)):''))+'</div>'
      : '<div class="agw-estado on">Sin restricción horaria — el agente puede consultar al LLM a cualquier hora</div>';

    box.innerHTML=estado
      +'<div class="form" style="gap:10px">'
      +'<label style="display:flex;gap:8px;align-items:center;cursor:pointer"><input type="checkbox" id="agw-on" '+(AGW.activo?'checked':'')+(canEdit?'':' disabled')+' style="width:auto"> <b>Restringir el agente a ventanas horarias</b></label>'
      +'<div id="agw-cfg"'+(AGW.activo?'':' hidden')+'>'
      +'<div class="row2"><div class="fld"><label>Zona horaria de la operación</label><select id="agw-tz"'+(canEdit?'':' disabled')+'>'
      + AGW_TZ.concat(AGW_TZ.indexOf(AGW.tz)<0?[AGW.tz]:[]).map(function(z){return '<option value="'+esc(z)+'"'+(z===AGW.tz?' selected':'')+'>'+esc(z)+'</option>';}).join('')
      +'</select><span class="hint">Las horas de abajo son de acá, no UTC. El horario de verano se ajusta solo.</span></div>'
      +'<div class="fld"><label>Fuera de la ventana</label><select id="agw-alcance"'+(canEdit?'':' disabled')+'>'
      +'<option value="llm"'+(AGW.alcance!=='todo'?' selected':'')+'>Pausar solo las consultas al LLM (recomendado)</option>'
      +'<option value="todo"'+(AGW.alcance==='todo'?' selected':'')+'>Pausar el agente completo</option>'
      +'</select><span class="hint">Con la primera opción el barrido de reglas y las alertas siguen corriendo siempre: son gratis y cuidan la operación.</span></div></div>'
      +'<div id="agw-list" style="margin-top:12px">'+(AGW.ventanas.length?AGW.ventanas.map(function(w,i){return agwFila(w,i,canEdit);}).join(''):'<div class="muted" style="padding:8px 2px">Sin ventanas. Agrega al menos una: con la restricción activa y ninguna ventana, el agente no consultaría nunca.</div>')+'</div>'
      +(canEdit?'<button class="btn" id="agw-add" style="margin-top:4px">＋ Agregar ventana</button>':'')
      +'</div>'
      +(canEdit?'<div class="acts"><span class="hint">«Ejecutar ciclo ahora» ignora el horario: si lo pides tú, corre.</span><button class="btn pri" id="agw-save">Guardar ventanas</button></div>':'')
      +'</div>';

    function leer(){
      AGW.activo=$('#agw-on').checked;
      if($('#agw-tz'))AGW.tz=$('#agw-tz').value;
      if($('#agw-alcance'))AGW.alcance=$('#agw-alcance').value;
      AGW.ventanas=$$('#agw-list .agw').map(function(el){
        return {
          dias:$$('.agw-dia.on',el).map(function(b){return parseInt(b.getAttribute('data-dia'),10);}),
          desde:$('.agw-desde',el).value, hasta:$('.agw-hasta',el).value,
        };
      });
    }
    function repintar(){ leer(); paintAgentAgenda({settings:{agenda:AGW},ventana:st.ventana}); }

    if($('#agw-on'))$('#agw-on').addEventListener('change',function(){
      leer();
      if(AGW.activo&&!AGW.ventanas.length)AGW.ventanas=[{dias:[1,2,3,4,5],desde:'08:00',hasta:'20:00'}];
      paintAgentAgenda({settings:{agenda:AGW},ventana:st.ventana});
    });
    if($('#agw-add'))$('#agw-add').addEventListener('click',function(){ leer(); AGW.ventanas.push({dias:[1,2,3,4,5],desde:'08:00',hasta:'20:00'}); paintAgentAgenda({settings:{agenda:AGW},ventana:st.ventana}); });
    $$('#agw-list [data-del]').forEach(function(b){ b.addEventListener('click',function(){ leer(); AGW.ventanas.splice(parseInt(b.getAttribute('data-del'),10),1); paintAgentAgenda({settings:{agenda:AGW},ventana:st.ventana}); }); });
    $$('#agw-list .agw-dia').forEach(function(b){ b.addEventListener('click',function(){ b.classList.toggle('on'); leer(); }); });
    $$('#agw-list .agw-desde, #agw-list .agw-hasta').forEach(function(x){ x.addEventListener('change',repintar); });
    if($('#agw-tz'))$('#agw-tz').addEventListener('change',leer);
    if($('#agw-alcance'))$('#agw-alcance').addEventListener('change',leer);

    if($('#agw-save'))$('#agw-save').addEventListener('click',function(){
      leer();
      api('/agent/settings',{method:'PATCH',body:{operationId:op,agenda:AGW}})
        .then(function(){ toast('Ventanas horarias guardadas'); renderAgente(); })
        .catch(function(e){ toast(e.message); });
    });
  }


  /**
   * Ajusta el viewBox del logotipo al ancho REAL del texto una vez que las
   * fuentes terminaron de cargar. Sin esto quedaba atado a un viewBox fijo
   * calculado con Sora: si la fuente no llegaba, el navegador caía a una
   * tipografía más ancha (system-ui mide 225 donde Sora mide 193) y la "S" de
   * WMS quedaba cortada. Ahora se mide y se acomoda, sea cual sea la fuente.
   */
  function ajustarLogo(){
    var svg=document.querySelector('.brandlogo-svg'); if(!svg)return;
    var t=svg.querySelector('text'); if(!t)return;
    function medir(){
      try{
        var bb=t.getBBox();
        if(!bb||!bb.width)return;
        var m=4; // respiro a la derecha para el remate de la última letra
        svg.setAttribute('viewBox','0 0 '+Math.ceil(bb.width+m)+' 46');
      }catch(e){ /* si getBBox falla (nodo oculto), queda el viewBox holgado */ }
    }
    medir();
    if(document.fonts&&document.fonts.ready&&document.fonts.ready.then)document.fonts.ready.then(medir);
    setTimeout(medir,1200); // red por si fonts.ready no está disponible
  }

  // ---- Torre en vivo (v115) ---------------------------------------------------
  // Las dos mitades de la misma historia en una pantalla: qué está ejecutando el
  // agente y cómo queda repartido el trabajo. Se refresca sola cada 15 s; se
  // detiene al salir de la página para no consultar de fondo.
  var TORRE={timer:null,reloj:null,en:null,ultimo:0,MS:15000};
  document.addEventListener('visibilitychange',function(){
    if(document.hidden)return;
    if(document.querySelector('.page[data-pg="torre"].on'))renderTorre().then(torreTick);
  });

  function torreTick(){
    clearTimeout(TORRE.timer);
    if(!document.querySelector('.page[data-pg="torre"].on')){ clearInterval(TORRE.reloj); return; }
    TORRE.timer=setTimeout(function(){ renderTorre().then(torreTick); }, TORRE.MS);
  }
  function torreFrescura(){
    var el=$("#torre-live"); if(!el)return;
    clearInterval(TORRE.reloj);
    function pinta(){
      if(!TORRE.ultimo){ el.textContent=''; return; }
      var seg=Math.max(0,Math.round((Date.now()-TORRE.ultimo)/1000));
      el.textContent='En vivo · hace '+(seg<60?seg+' s':Math.floor(seg/60)+' min');
      el.classList.toggle('stale',seg>45);
    }
    pinta(); TORRE.reloj=setInterval(pinta,1000);
  }

  function renderTorre(){
    if(!op)return Promise.resolve();
    var btn=$("#torre-now");
    if(btn&&!btn.__bound){ btn.__bound=true; btn.addEventListener('click',function(){ TORRE.ultimo=0; renderTorre().then(torreTick); }); }
    if(TORRE.en)return TORRE.en;                       // una consulta a la vez
    TORRE.en=Promise.all([
      api('/agent/journal?operationId='+encodeURIComponent(op)+'&limit=40').catch(function(){return [];}),
      api('/assignments/load?operationId='+encodeURIComponent(op)).catch(function(){return {operarios:[],pendientesSinAsignar:{}};}),
    ]).then(function(r){
      TORRE.en=null; TORRE.ultimo=Date.now(); torreFrescura();
      torreDiario(r[0]||[]);
      torreCarga(r[1]||{});
    }, function(){ TORRE.en=null; });
    return TORRE.en;
  }

  /** Reusa el mismo armado por ciclo del Agente: una sola forma de leer el diario. */
  function torreDiario(list){
    var box=$("#torre-diario"); if(!box)return;
    var sub=$("#torre-diario-sub");
    var ciclos=(list||[]).filter(function(e){return e.kind==='cycle';}).length;
    if(sub)sub.textContent=ciclos?('últimos '+ciclos+' ciclo(s)'):'sin ciclos todavía';
    var antes=$("#agt-journal");
    // paintAgentJournal escribe en #agt-journal; se le presta el nodo un instante.
    var tmp=document.createElement('div'); tmp.id='agt-journal';
    box.innerHTML=''; box.appendChild(tmp);
    if(antes)antes.id='agt-journal-real';
    try{ paintAgentJournal(list); } finally { if(antes)antes.id='agt-journal'; tmp.removeAttribute('id'); }
  }

  function torreCarga(load){
    var ops=load.operarios||[], T=load.totales, P=load.promedios;
    var sub=$("#torre-carga-sub"); if(sub)sub.textContent=ops.length?(ops.length+' operario(s)'):'sin operarios';
    var maxH=Math.max.apply(null,[1].concat(ops.map(function(o){return o.horasEstimadas||0;})));
    var cuerpo=$("#torre-carga");
    if(cuerpo)cuerpo.innerHTML=ops.length?ops.map(function(o){
      var h=o.horasEstimadas||0, hot=h>=6;
      return '<tr><td>'+esc(o.nombre||o.operario)
        +'<div class="torre-bar'+(hot?' hot':'')+'"><span class="t"><i style="width:'+Math.round((h/maxH)*100)+'%"></i></span></div></td>'
        +'<td class="num">'+o.tareasAbiertas+'</td><td class="num">'+fmtInt(o.unidades)+'</td>'
        +'<td class="num"'+(hot?' style="color:var(--bad,#c0392b);font-weight:800"':'')+'>'+(o.horasEstimadas!=null?o.horasEstimadas+' h':'—')+'</td></tr>';
    }).join(''):'<tr><td colspan="4" class="empty">Sin operarios en la operación.</td></tr>';
    var pie=$("#torre-carga-foot");
    if(pie)pie.innerHTML=(T&&ops.length)
      ? '<tr class="tot"><td>Total ('+T.operarios+')</td><td class="num">'+T.tareasAbiertas+'</td><td class="num">'+fmtInt(T.unidades)+'</td><td class="num">'+T.horasEstimadas+' h</td></tr>'
        +'<tr class="prom"><td>Promedio por operario</td><td class="num">'+P.tareasAbiertas+'</td><td class="num">'+fmtInt(P.unidades)+'</td><td class="num">'+P.horasEstimadas+' h</td></tr>'
      : '';
    var pend=load.pendientesSinAsignar||{};
    var hay=Object.keys(pend).filter(function(k){return pend[k];});
    var pbox=$("#torre-pend");
    if(pbox)pbox.innerHTML=hay.length
      ? '<div class="torre-pend">'+hay.map(function(k){return '<span>'+esc(ASG_TYPE_LABEL[k]||k)+' <b>'+pend[k]+'</b></span>';}).join('')+'</div>'
      : '<div class="muted" style="padding:4px 2px">Todo el trabajo pendiente está asignado.</div>';
  }

  function paintAgentInstructions(list){
    var box=$('#agt-instr'); if(!box)return; list=list||[];
    var canEdit=can('master');
    box.innerHTML=(list.length?list.map(function(i){return '<div style="display:flex;gap:10px;align-items:center;padding:7px 0;border-bottom:1px solid var(--line-2,var(--line))"><div style="flex:1;font-size:13px">'+esc(i.text)+' <span class="hint">'+(i.expiresAt?'hasta '+esc(String(i.expiresAt).slice(0,10)):'sin vencimiento')+(i.actor&&!/^[0-9a-f-]{20,}$/i.test(i.actor)?' · '+esc(i.actor):'')+'</span></div>'+(canEdit?'<button class="mini" data-agtretire="'+esc(i.id)+'">Retirar</button>':'')+'</div>';}).join(''):'<div class="muted" style="padding:6px 2px">Sin instrucciones vigentes. Ej.: "hoy priorizar Chilexpress", "no despachar Tienda X hasta que apruebe".</div>')
      +(canEdit?'<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap"><input id="agt-instr-txt" placeholder="Nueva instrucción para el agente…" style="flex:1;min-width:220px"><input id="agt-instr-days" type="number" min="0" value="0" title="Días de vigencia (0 = hasta retirar)" style="width:90px"><button class="btn pri" id="agt-instr-add">Guardar</button></div>':'');
    if($('#agt-instr-add'))$('#agt-instr-add').addEventListener('click',function(){var t=$('#agt-instr-txt').value.trim();if(!t){toast('Escribe la instrucción');return;}api('/agent/instructions',{method:'POST',body:{operationId:op,texto:t,diasVigencia:parseInt($('#agt-instr-days').value,10)||0}}).then(function(){toast('Instrucción guardada');renderAgente();}).catch(function(e){toast(e.message);});});
    $$('#agt-instr [data-agtretire]').forEach(function(b){b.addEventListener('click',function(){api('/agent/instructions/'+encodeURIComponent(b.getAttribute('data-agtretire'))+'/retire',{method:'POST',body:{operationId:op}}).then(function(){toast('Instrucción retirada');renderAgente();}).catch(function(e){toast(e.message);});});});
  }
  var AGT_KIND={cycle:'Ciclo',decision:'Decisión',instruction:'Instrucción',outcome:'Resultado',tools:'Consulta',note:'Nota'};
  var AGJ_EST={
    ejecutada:{t:'Ejecutada',c:'#0E9F6E'},
    propuesta:{t:'Propuesta',c:'#B45309'},
    sombra:{t:'Sombra',c:'#6366F1'},
    error:{t:'Falló',c:'#DC2626'},
  };

  /**
   * Diario del agente, agrupado por ciclo. Cada ciclo es una "respuesta" del
   * agente y lleva su tabla de acciones: qué hizo, sobre qué, y si lo ejecutó,
   * lo dejó propuesto, lo simuló en sombra o falló. Antes esto era una lista
   * plana de frases donde no se distinguía una cosa de la otra.
   *
   * En móvil la tabla se convierte en tarjetas por CSS (cada celda lleva su
   * etiqueta): no depende de JavaScript ni del transformador global de tablas.
   */
  function paintAgentJournal(list){
    var box=$('#agt-journal'); if(!box)return;
    list=(list||[]).filter(function(e){return e.kind!=='tools';});
    if(!list.length){box.innerHTML='<div class="muted" style="padding:6px 2px">El diario se llena con cada ciclo del agente: qué evaluó, qué decidió y qué habría hecho en modo sombra.</div>';return;}

    // La lista viene de más nueva a más vieja. Las acciones se anotan ANTES del
    // resumen del ciclo, así que caen justo después de él en este orden.
    var bloques=[], actual=null;
    list.forEach(function(e){
      if(e.kind==='cycle'){ actual={ciclo:e,acciones:[],notas:[]}; bloques.push(actual); return; }
      if(!actual){ actual={ciclo:null,acciones:[],notas:[]}; bloques.push(actual); }
      var a=e.data&&e.data.accion;
      if(a)actual.acciones.push({at:e.at,a:a});
      else actual.notas.push(e);
    });

    box.innerHTML=bloques.map(function(b){
      var c=b.ciclo, sum=(c&&c.data)||{};
      var chips=[];
      if(c){
        if(sum.nuevas)chips.push(['alerta(s) nueva(s)',sum.nuevas]);
        if(sum.ejecutadas)chips.push(['ejecutada(s)',sum.ejecutadas]);
        if(sum.propuestas)chips.push(['propuesta(s)',sum.propuestas]);
        if(sum.sombra)chips.push(['en sombra',sum.sombra]);
        if(sum.notificadas)chips.push(['notificada(s)',sum.notificadas]);
      }
      var cab='<div class="agj-h">'
        +'<span class="agj-when">'+esc(c?fmtDate(c.at):'ciclo en curso')+'</span>'
        +'<span class="agj-tag'+(c?'':' pend')+'">'+(c?'Ciclo':'En curso')+'</span>'
        +(c&&sum.llm?'<span class="agj-tag llm">IA</span>':'')
        +(c?'<span class="agj-by">'+(String(sum.by||'')==='scheduler'?'automático':'a mano')+'</span>':'')
        +'</div>'
        +(c?'<div class="agj-txt">'+esc(c.text)+'</div>':'')
        +(chips.length?'<div class="agj-kpis">'+chips.map(function(k){return '<span><b>'+k[1]+'</b> '+esc(k[0])+'</span>';}).join('')+'</div>':'');

      var tabla;
      if(b.acciones.length){
        tabla='<table class="agj-t m-skip"><thead><tr><th>Acción</th><th>Regla</th><th>Sobre</th><th>Estado</th><th>Resultado</th></tr></thead><tbody>'
          +b.acciones.map(function(x){
            var e=AGJ_EST[x.a.estado]||{t:x.a.estado||'—',c:'var(--ink-3)'};
            return '<tr>'
              +'<td data-label="Acción"><b>'+esc(x.a.etiqueta||x.a.herramienta||'—')+'</b></td>'
              +'<td data-label="Regla">'+esc(x.a.regla||'—')+'</td>'
              +'<td data-label="Sobre">'+esc(x.a.entidad||'—')+'</td>'
              +'<td data-label="Estado"><span class="agj-est" style="color:'+e.c+'">'+esc(e.t)+'</span></td>'
              +'<td data-label="Resultado" class="agj-res">'+esc(x.a.resultado||'—')+'</td>'
              +'</tr>';
          }).join('')+'</tbody></table>';
      } else {
        tabla='<div class="agj-vacio">Sin acciones ejecutadas ni propuestas en este ciclo.</div>';
      }
      var notas=b.notas.length?'<div class="agj-notas">'+b.notas.map(function(n){
        return '<div><span class="agj-nk">'+esc(AGT_KIND[n.kind]||n.kind)+'</span> '+esc(n.text)+'</div>';
      }).join('')+'</div>':'';
      return '<div class="agj">'+cab+tabla+notas+'</div>';
    }).join('');
  }
  function paintAgentAlerts(d){
    var box=$('#agt-alerts');var al=(d&&d.abiertas)||[];
    agtBadge(al.length);
    var sub=$('#agt-alerts-sub');if(sub)sub.textContent=al.length?(al.length+' activa(s)'):'Sin alertas — todo en orden';
    if(!box)return;
    if(!al.length){box.innerHTML='<div class="muted" style="padding:6px 2px">No hay alertas activas. El agente avisará aquí cuando una regla se cumpla.</div>';return;}
    box.innerHTML=al.map(function(a){
      var sv=AGT_SEV[a.severity]||AGT_SEV.info;
      var act='';
      if(a.actionStatus==='done'){act='<div style="font-size:12px;margin-top:6px;color:var(--good,#127a3d)">✓ Ejecutado'+(a.actionResult?' — '+esc(a.actionResult):'')+'</div>';}
      else if(a.actionStatus==='error'){act='<div style="font-size:12px;margin-top:6px;color:var(--crit)">✕ '+esc(a.actionResult||'no se pudo ejecutar')+'</div>';}
      return '<div style="display:flex;gap:12px;padding:12px 13px;border:1px solid var(--line);border-left:4px solid '+sv.c+';border-radius:10px;margin-bottom:9px">'
        +'<div style="flex:1;min-width:0">'
        +'<div style="font-weight:700;font-size:13.5px">'+esc(a.title)+' <span class="rolechip" style="background:var(--surface-3);color:'+sv.c+';font-size:10.5px">'+sv.t+'</span>'+(a.actionStatus==='proposed'&&a.actionResult&&/sombra/.test(a.actionResult)?' <span class="rolechip" style="background:var(--surface-3);font-size:10.5px">sombra</span>':'')+'</div>'
        +'<div class="muted" style="font-size:12.5px;margin:3px 0 4px">'+esc(a.detail)+'</div>'
        +(a.action?'<div style="font-size:12.5px"><b style="color:'+sv.c+'">Sugerencia:</b> '+esc(a.action)+'</div>':'')
        +act
        +'</div>'
        +'<div style="display:flex;flex-direction:column;gap:6px;align-self:center;flex:none">'
        +((a.actionStatus==='proposed'||a.actionStatus==='error')&&a.actionTool?'<button class="btn pri" data-agtexec="'+esc(a.id)+'" style="padding:5px 11px" title="'+esc(a.actionLabel||'')+'">'+(a.actionStatus==='error'?'Reintentar':'Confirmar y ejecutar')+'</button>':'')
        +(a.link?'<button class="btn" data-agtgo="'+esc(a.link)+'" style="padding:5px 11px">Ir →</button>':'')
        +'<button class="btn" data-agtack="'+esc(a.id)+'" style="padding:5px 11px">Descartar</button>'
        +'</div></div>';
    }).join('');
    $$('#agt-alerts [data-agtgo]').forEach(function(x){x.addEventListener('click',function(){go(x.getAttribute('data-agtgo'));});});
    $$('#agt-alerts [data-agtack]').forEach(function(x){x.addEventListener('click',function(){api('/agent/alerts/'+encodeURIComponent(x.getAttribute('data-agtack'))+'/ack',{method:'POST',body:{operationId:op}}).then(function(){toast('Alerta descartada');renderAgAlertas();}).catch(function(e){toast(e.message);});});});
    $$('#agt-alerts [data-agtexec]').forEach(function(x){x.addEventListener('click',function(){x.disabled=true;api('/agent/alerts/'+encodeURIComponent(x.getAttribute('data-agtexec'))+'/execute',{method:'POST',body:{operationId:op}}).then(function(r){toast(r&&r.ok?('Ejecutado'+(r.result?': '+r.result:'')):('No se pudo: '+((r&&r.error)||'')));renderAgAlertas();}).catch(function(e){toast(e.message);renderAgAlertas();});});});
  }
  function paintAgentRules(list){
    var box=$('#agt-rules');if(!box)return;list=list||[];
    box.innerHTML=list.map(function(r){
      var sv=AGT_SEV[r.severity]||AGT_SEV.info;
      var actVal=r.actionType==='execute'?(r.actionMode==='directo'?'directo':'confirmar'):'alert';
      var actSel='';
      if(r.autoAction){
        actSel='<label style="font-size:11px;color:var(--ink-2)">Acción<br>'
          +'<select data-agtact="'+esc(r.ruleKey)+'" title="'+esc(r.autoAction.label)+'" style="margin-top:3px;padding:5px 7px;border:1px solid var(--line);border-radius:7px;background:var(--surface-2);color:var(--ink);max-width:170px">'
          +'<option value="alert"'+(actVal==='alert'?' selected':'')+'>Solo avisar</option>'
          +'<option value="confirmar"'+(actVal==='confirmar'?' selected':'')+'>Ejecutar (confirmar)</option>'
          +'<option value="directo"'+(actVal==='directo'?' selected':'')+'>Ejecutar (directo)</option>'
          +'</select></label>';
      } else {
        actSel='<label style="font-size:11px;color:var(--ink-2)">Acción<br><span class="muted" style="display:inline-block;margin-top:8px;font-size:11.5px">Solo avisar</span></label>';
      }
      return '<div class="agr" style="display:flex;gap:14px;align-items:flex-start;padding:12px 2px;border-bottom:1px solid var(--line)">'
        +'<input type="checkbox" data-agten="'+esc(r.ruleKey)+'"'+(r.enabled?' checked':'')+' style="width:20px;height:20px;flex:none;margin-top:2px;accent-color:var(--primary)">'
        +'<div style="flex:1;min-width:0">'
        +'<div style="font-weight:600;font-size:13.5px">'+esc(r.name)+' <span class="rolechip" style="background:var(--surface-3);color:'+sv.c+';font-size:10px">'+sv.t+'</span></div>'
        +'<div class="muted" style="font-size:12px">'+esc(r.description)+(r.autoAction?' · <b style="color:var(--ink-2)">Acción:</b> '+esc(r.autoAction.label):'')+'</div>'
        +'</div>'
        +'<div class="agr-ctl" style="flex:none;display:flex;gap:14px;align-items:flex-start;flex-wrap:wrap;justify-content:flex-end">'
        +'<label style="font-size:11px;color:var(--ink-2)">Umbral<br><span style="display:inline-flex;align-items:center;gap:5px;margin-top:3px"><input type="number" min="0" value="'+r.threshold+'" data-agtth="'+esc(r.ruleKey)+'" style="width:66px;padding:5px 7px;border:1px solid var(--line);border-radius:7px;background:var(--surface-2);color:var(--ink)"><span class="muted" style="font-size:11px">'+esc(r.unit)+'</span></span></label>'
        +'<label style="font-size:11px;color:var(--ink-2)">Enfriamiento<br><span style="display:inline-flex;align-items:center;gap:5px;margin-top:3px"><input type="number" min="0" value="'+r.cooldownMin+'" data-agtcd="'+esc(r.ruleKey)+'" style="width:66px;padding:5px 7px;border:1px solid var(--line);border-radius:7px;background:var(--surface-2);color:var(--ink)"><span class="muted" style="font-size:11px">min</span></span></label>'
        +actSel
        +'</div></div>';
    }).join('');
    function patch(key,body){api('/agent/rules/'+encodeURIComponent(key),{method:'PATCH',body:Object.assign({operationId:op},body)}).then(function(){toast('Regla actualizada');renderAgente();}).catch(function(e){toast(e.message);renderAgente();});}
    $$('#agt-rules [data-agten]').forEach(function(x){x.addEventListener('change',function(){patch(x.getAttribute('data-agten'),{enabled:x.checked});});});
    $$('#agt-rules [data-agtth]').forEach(function(x){x.addEventListener('change',function(){patch(x.getAttribute('data-agtth'),{threshold:parseInt(x.value,10)||0});});});
    $$('#agt-rules [data-agtcd]').forEach(function(x){x.addEventListener('change',function(){patch(x.getAttribute('data-agtcd'),{cooldownMin:parseInt(x.value,10)||0});});});
    $$('#agt-rules [data-agtact]').forEach(function(x){x.addEventListener('change',function(){var v=x.value;patch(x.getAttribute('data-agtact'),v==='alert'?{actionType:'alert'}:{actionType:'execute',actionMode:v});});});
  }
  function agtActivePage(){var p=document.querySelector('.page[data-pg="agente"]');return p&&p.classList.contains('on');}
  function agtPoll(){ if(!agtCanSee())return; api('/agent/alerts?'+agtScope()).then(function(d){ if(agtActivePage())paintAgentAlerts(d); else agtBadge((d&&d.abiertas||[]).length); }).catch(function(){}); }

  var TITLES={dashboard:["Dashboard","Resumen operativo"],aidash:["Dashboard AI","Arma tu propio tablero conversando: datos en vivo, cada 30 s"],copilot:["Copiloto","Insights y respuestas con datos en vivo"],voz:["Copiloto de voz","Conversa por voz con tu operación y opera en automático"],inventory:["Inventario","Stock por SKU y ubicación"],orders:["Órdenes","Fulfillment y estados"],packaging:["Embalajes","Insumos de embalaje de la bodega"],pickqueue:["Cola de preparación","Picking en orden forzado: courier y FIFO"],inbound:["Recepción","Entradas de mercadería"],returns:["Devoluciones","Logística reversa: QA y disposición"],products:["Productos","Mantenedor de SKUs y kits"],putaway:["Almacenado","Guardar recepción en almacenaje"],assembly:["Armado de kit","Ensamblar kits desde sus componentes"],locations:["Ubicaciones","Ocupación de la bodega"],movements:["Movimientos","Kardex del ledger de inventario"],counts:["Conteo cíclico","Tareas propuestas"],billing:["Facturación","Tarifario y facturas 3PL por cliente"],costos:["Rentabilidad","Costo por actividad, margen por cliente y eficiencia estándar vs. real"],chat:["Canal clientes","Chat interno con cada cliente de la bodega"],voicechannel:["Canal operaciones","Mensajes de voz entre operarios y administración"],branding:["Marca","White-label de la operación (documentos y panel)"],clients:["Clientes","Cuentas de cliente (sellers)"],users:["Usuarios","Roles y permisos"],operations:["Operaciones","Tenants de la plataforma"],usage:["Uso de plataforma","Nivel de uso por operación"],announcements:["Anuncios","Barra superior y clics"],webhooks:["Webhooks","Suscripciones por evento"],activity:["Actividad","Registro por usuario: quién hizo qué y cuándo"],aiaudit:["Auditoría IA","Recomendaciones y acciones de agentes (gobernanza)"],asignaciones:["Asignaciones","Balanceo de carga de tareas entre operarios"],agente:["Agente","Estado y autonomía, ventanas horarias, instrucciones y reglas"],agdiario:["Diario del agente","Ciclos, decisiones y resultados del agente"],agalertas:["Alertas activas","Lo que el agente detectó y sigue sin resolver"],torre:["Torre en vivo","Lo que el agente ejecuta y cómo queda la carga, en una pantalla"],plan:["Plan","Tu plan, uso y límites"],pkgmatrix:["Empaquetado","Matriz de módulos y planes"]};
  function go(pg){var allowed=NAV_BY_ROLE[role]||[];if(allowed.indexOf(pg)<0||moduleHidden(pg))pg="dashboard";
    if(moduleLocked(pg)){var f=MODULE_FEATURE[pg];toast('🔒 '+(FEATURE_NAME[f]||f)+' no está incluido en tu plan. Mejóralo para habilitarlo.');if(allowed.indexOf('plan')>=0)pg='plan';else return;}
    if(mcMode){mcMode=false;if($("#seller")&&$("#seller").value==='__all__')$("#seller").value=seller||'';}$$(".nav").forEach(function(n){n.classList.toggle("on",n.getAttribute("data-pg")===pg);});$$(".page").forEach(function(p){p.classList.toggle("on",p.getAttribute("data-pg")===pg);});$("#pg-title").textContent=TITLES[pg][0];$("#pg-sub").textContent=TITLES[pg][1];window.scrollTo(0,0);if(pg==="dashboard"){loadDash().then(dashTick);}else{clearTimeout(dashTimer);}
    if(pg==="aidash"){renderAiDash();aidTick();}else{clearTimeout(AID.timer);}if(pg==="pickqueue")renderPickQueue();if(pg==="packaging")renderPackaging();if(pg==="branding")renderBranding();if(pg==="returns")renderReturns();if(pg==="billing")renderBilling();if(pg==="costos")renderCostos();if(pg==="chat")renderChat();if(pg==="voicechannel")renderVoiceChannel();if(pg==="copilot")renderCopilot();if(pg==="voz")renderVoice();if(pg==="usage")renderUsage();if(pg==="announcements")renderAnnouncements();if(pg==="webhooks")renderWebhooks();if(pg==="activity")renderUserActivity();if(pg==="aiaudit")renderAiAudit();if(pg==="asignaciones")renderAssignments();if(pg==="agente")renderAgente();if(pg==="agalertas")renderAgAlertas();if(pg==="agdiario")renderAgDiario();if(pg==="torre"){renderTorre();torreTick();}else{clearTimeout(TORRE.timer);}if(pg==="plan")renderPlan();if(pg==="pkgmatrix")renderPkgMatrix();expandActiveCat(pg);if(window.NinjaTour)NinjaTour.onPage(pg);if(typeof paintLive==='function')paintLive();}
  $$(".nav").forEach(function(n){n.addEventListener("click",function(){go(n.getAttribute("data-pg"));});});
  // Cabeceras de categoría: despliegan/pliegan su submenú.
  $$('.navcat-h').forEach(function(h){h.addEventListener('click',function(){toggleNavCat(h.parentElement);});});
  $("#loc-new").addEventListener("click",function(){openLocForm(null);});
  if($("#loc-import"))$("#loc-import").addEventListener("click",openLocationImport);
  if($("#loc-export"))$("#loc-export").addEventListener("click",function(){downloadAuth('/operations/'+encodeURIComponent(op)+'/location-import/export','ubicaciones-ninjawms.xlsx',"Ubicaciones exportadas");});
  $("#usr-new").addEventListener("click",function(){openUserForm(null);});
  $("#ops-new").addEventListener("click",function(){openOpForm(null);});
  $("#inb-new").addEventListener("click",function(){openReceiveForm();});
  if($("#inb-import"))$("#inb-import").addEventListener("click",openReceiptImport);
  $("#cli-new").addEventListener("click",function(){openSellerForm(null);});
  if($("#cli-demo"))$("#cli-demo").addEventListener("click",openDemoSandbox);
  /**
   * Sandbox de demostración del agente: crea un cliente de juguete con productos,
   * ubicaciones, stock, 20 órdenes en todos los estados con deadlines variados y
   * tareas pendientes de todos los tipos, para mostrar al agente trabajando sobre
   * datos reales sin tocar a los clientes de verdad.
   */
  function openDemoSandbox(){
    // El administrador decide el tamaño. Los mínimos del servidor están para que
    // la semilla siempre alcance a cubrir los escenarios que le dan trabajo al
    // agente; si pide menos, el servidor lo sube y lo informa.
    openModal('Sandbox de demostración del agente',
      '<p style="margin:0 0 12px">Se creará un <b>cliente nuevo</b> con datos de demostración. Elige el tamaño:</p>'
      +'<div class="form"><div class="row2">'
      +'<div class="fld"><label>Órdenes</label><input id="sbx-ord" type="number" min="6" max="400" value="20"><span class="hint">mínimo 6 · máximo 400</span></div>'
      +'<div class="fld"><label>Productos (SKUs)</label><input id="sbx-prod" type="number" min="2" max="60" value="5"><span class="hint">mínimo 2 · máximo 60</span></div>'
      +'</div><div class="row2">'
      +'<div class="fld"><label>Ubicaciones</label><input id="sbx-ubic" type="number" min="3" max="200" value="10"><span class="hint">incluye el dock de recepción · mínimo 3</span></div>'
      +'<div class="fld"><label>Insumos de embalaje</label><input value="5" disabled><span class="hint">siempre 5, con distintos niveles de stock</span></div>'
      +'</div></div>'
      +'<p class="muted" style="margin:12px 0 0;font-size:12.5px">Además trae tareas pendientes de los siete tipos, tres operarios (uno cargado, uno ocioso y uno inactivo con tareas abiertas), un lote por vencer y una orden sin stock suficiente. '
      +'No toca a tus clientes reales y puedes montar otro ciclo cuando quieras: cada corrida crea su propio cliente y sus propias ubicaciones.</p>'
      +'<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px"><button class="btn" id="sbx-no">Cancelar</button><button class="btn pri" id="sbx-go">Crear sandbox</button></div>');
    $("#sbx-no").addEventListener('click',closeModal);
    $("#sbx-go").addEventListener('click',function(){
      var body={
        ordenes:parseInt($("#sbx-ord").value,10)||undefined,
        productos:parseInt($("#sbx-prod").value,10)||undefined,
        ubicaciones:parseInt($("#sbx-ubic").value,10)||undefined,
      };
      this.disabled=true; this.textContent='Sembrando…';
      toast('Sembrando datos de demostración…');
      api('/operations/'+op+'/demo-sandbox',{method:'POST',body:body}).then(function(r){
        return loadOp().then(function(){return r;});
      }).then(function(r){
        var t=r.tareasPendientes||{}, d=r.deadlines||{}, g=r.garantias||[];
        var cubiertos=g.filter(function(x){return x.cubierto;});
        openModal('Sandbox listo · '+esc(r.sellerName||''),
          '<p class="muted" style="margin:0 0 12px">Ya puedes cambiar al cliente <b>'+esc(r.sellerName||'')+'</b> en el selector de arriba y mirar el agente, la cola de preparación y las alertas.</p>'
          +'<div class="kv"><span>Productos</span><b>'+r.productos+'</b></div>'
          +'<div class="kv"><span>Ubicaciones</span><b>'+r.ubicaciones+'</b></div>'
          +'<div class="kv"><span>Insumos de embalaje</span><b>'+(r.embalajes||5)+'</b></div>'
          +'<div class="kv"><span>Órdenes</span><b>'+r.ordenes+' · '+esc(Object.keys(r.porEstado||{}).map(function(k){return (STN[k]||k)+' '+r.porEstado[k];}).join(' · '))+'</b></div>'
          +'<div class="kv"><span>Deadlines</span><b>'+d.vencidas+' vencidas · '+d.criticas+' críticas · '+d.enRiesgo+' en riesgo · '+d.holgadas+' holgadas · '+d.sinDeadline+' sin compromiso</b></div>'
          +'<div class="kv"><span>Tareas pendientes</span><b>'+esc(Object.keys(t).filter(function(k){return t[k];}).map(function(k){return (ASG_TYPE_LABEL[k]||k)+' '+t[k];}).join(' · ')||'—')+'</b></div>'
          +'<div class="kv"><span>Operarios</span><b>'+esc((r.operarios||[]).join(' · '))+'</b></div>'
          +(g.length?'<div style="margin-top:14px"><div style="font-weight:800;font-size:12.5px;margin-bottom:6px">Qué puede hacer el agente con esto ('+cubiertos.length+' de '+g.length+' escenarios)</div>'
            +'<table class="agj-t m-skip"><thead><tr><th>Escenario</th><th>Órdenes</th><th>Acción del agente</th></tr></thead><tbody>'
            +g.map(function(x){ return '<tr style="'+(x.cubierto?'':'opacity:.5')+'">'
              +'<td data-label="Escenario"><b>'+esc(String(x.escenario).replace(/_/g,' '))+'</b></td>'
              +'<td data-label="Órdenes">'+(x.cubierto?x.cantidad:'—')+'</td>'
              +'<td data-label="Acción">'+esc(x.accionDelAgente)+'</td></tr>'; }).join('')
            +'</tbody></table></div>':'')
          +((r.ajustes||[]).length?'<p class="muted" style="margin:12px 0 0;font-size:12.5px"><b>Ajustes:</b> '+esc(r.ajustes.join(' · '))+'</p>':'')
          +((r.avisos||[]).length?'<p class="muted" style="margin:8px 0 0;font-size:12.5px">'+esc(r.avisos.join(' · '))+'</p>':'')
          +'<div style="display:flex;justify-content:flex-end;margin-top:14px"><button class="btn pri" id="m-ok">Cerrar</button></div>');
        $("#m-ok").addEventListener('click',closeModal);
      }).catch(function(e){ toast(e.message); closeModal(); });
    });
  }

  if($("#wh-new"))$("#wh-new").addEventListener("click",function(){openWebhookForm(null);});
  $("#ord-new").addEventListener("click",function(){openOrderForm(null);});
  if($("#ord-import"))$("#ord-import").addEventListener("click",openBulkImport);
  if($("#ord-reserve-all"))$("#ord-reserve-all").addEventListener("click",openReserveMasiva);
  if($("#pkg-new"))$("#pkg-new").addEventListener("click",function(){openPkgForm(null);});
  if($("#ret-new"))$("#ret-new").addEventListener("click",openNewReturn);
  // Tablas ordenables por clic en la cabecera (orden inicial: fecha, más reciente primero).
  wireSort('orders','fecha',-1,renderOrders);
  wireSort('returns','fecha',-1,renderReturns);
  wireSort('inbound','fecha',-1,renderInbound);
  $("#inv-move").addEventListener("click",function(){openPutawayForm();});
  // Salir vive al final del sidebar (antes estaba en la barra superior).
  function cerrarSesion(){
    token=null;me=null;role=null;op=null;seller=null;
    $("#lg-email").value="";$("#lg-pass").value="";$("#lg-err").textContent="";
    // Al volver, la portada arranca de nuevo con la caja cerrada.
    // Primero se muestra la portada y recién después se reinicia: si el canvas
    // se monta mientras el overlay está oculto, mide 0 y la caja no se dibuja.
    $("#loginov").classList.remove("off");
    if(window.__loginReset)window.__loginReset();
  }
  if($("#btn-logout"))$("#btn-logout").addEventListener("click",cerrarSesion);
  if($("#side-logout"))$("#side-logout").addEventListener("click",cerrarSesion);

  /**
   * Sidebar colapsable: en pantallas grandes se puede reducir a solo iconos para
   * ganar ancho. La preferencia se recuerda en el navegador de cada persona.
   */
  (function sidebarCollapse(){
    var KEY='wms.admin.sidecollapsed';
    var layout=document.querySelector('.layout'), btn=$("#side-toggle");
    if(!layout||!btn)return;
    function pinta(on){
      layout.classList.toggle('sidecollapsed',on);
      btn.textContent=on?'»':'«';
      btn.title=on?'Expandir el menú':'Colapsar el menú';
      btn.setAttribute('aria-label',btn.title);
    }
    var guardado=false; try{ guardado=localStorage.getItem(KEY)==='1'; }catch(e){}
    pinta(guardado);
    btn.addEventListener('click',function(){
      var on=!layout.classList.contains('sidecollapsed');
      pinta(on);
      try{ localStorage.setItem(KEY,on?'1':'0'); }catch(e){}
    });
  })();
  $("#btn-mypass").addEventListener("click",function(){
    var html='<div class="form">'
      +'<div class="fld"><label>Contraseña actual</label><input id="mp-cur" type="password" autocomplete="current-password"></div>'
      +'<div class="fld"><label>Nueva contraseña</label><input id="mp-new" type="password" autocomplete="new-password" placeholder="mínimo 6 caracteres"></div>'
      +'<div class="ferr" id="mp-err"></div>'
      +'<div class="acts"><span class="hint"></span><div style="display:flex;gap:10px"><button class="btn" id="mp-cancel">Cancelar</button><button class="btn pri" id="mp-save">Cambiar</button></div></div>'
      +'</div>';
    openModal("Cambiar mi contraseña",html);
    $("#mp-cancel").addEventListener("click",closeModal);
    $("#mp-save").addEventListener("click",function(){
      var cur=$("#mp-cur").value||"", nw=$("#mp-new").value||"";
      if(nw.length<6){$("#mp-err").textContent="La nueva contraseña debe tener al menos 6 caracteres.";return;}
      api('/auth/change-password',{method:'POST',body:{currentPassword:cur,newPassword:nw}}).then(function(){closeModal();toast("Contraseña cambiada");}).catch(function(e){$("#mp-err").textContent=e.message;});
    });
  });

  // ===== Registro self-serve · verificación · reset (PLG Fase 0) =============
  var resetToken=null;
  var pendingVerifyToken=null; // solo presente en local/dev (sin SMTP): permite verificar sin salir del panel
  function lgShow(view){
    $$(".lgview").forEach(function(v){ v.hidden = v.getAttribute("data-view")!==view; });
    $("#loginov").classList.remove("off");
    ["lg-err","rg-err","fg-err","rs-err"].forEach(function(id){ var e=$("#"+id); if(e)e.textContent=""; });
  }
  $$("#loginov [data-go]").forEach(function(b){ b.addEventListener("click",function(){ lgShow(b.getAttribute("data-go")); }); });

  /**
   * Portada del login: el nombre y el eslogan se escriben solos, después de que la
   * caja se arma y el formulario sale de adentro. Puro adorno: si algo falla, el
   * texto queda completo igual y nadie se queda sin poder entrar.
   */
  (function heroType(){
    var nm=document.getElementById('lh-name'), sl=document.getElementById('lh-slogan');
    if(!nm||!sl)return;
    var reduce=false; try{ reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches; }catch(e){}
    var NOMBRE=[['Ninja','a'],[' WMS','b']], SLOGAN='AI Native WMS';
    function full(){
      nm.innerHTML='<span class="a">Ninja</span><span class="b"> WMS</span>';
      sl.textContent=SLOGAN;
      $$('#loginov .lh-caret').forEach(function(c){c.classList.add('done');});
    }
    if(reduce)full();
    var plano=NOMBRE.map(function(x){return x[0];}).join(''), i=0;
    var tecleando=!reduce;
    function pintaNombre(n){
      var out='', usado=0;
      for(var k=0;k<NOMBRE.length;k++){
        var txt=NOMBRE[k][0], toma=Math.max(0,Math.min(txt.length,n-usado));
        if(toma>0)out+='<span class="'+NOMBRE[k][1]+'">'+txt.slice(0,toma)+'</span>';
        usado+=txt.length;
      }
      nm.innerHTML=out;
    }
    function tecleaNombre(){
      i++; pintaNombre(i);
      if(i<plano.length)return setTimeout(tecleaNombre, 85);
      var c1=$$('#loginov .lh-caret')[0]; if(c1)c1.classList.add('done');
      setTimeout(tecleaSlogan, 320);
    }
    var j=0;
    function tecleaSlogan(){
      j++; sl.textContent=SLOGAN.slice(0,j);
      if(j<SLOGAN.length)return setTimeout(tecleaSlogan, 62);
    }
    if(tecleando)setTimeout(tecleaNombre, 1500); // apenas la caja termina de armarse

    // La caja se abre con un clic (o con el teclado). Si alguien se queda mirando,
    // se abre sola a los 12 s: nadie puede quedarse afuera por no entender el gesto.
    var stage=document.getElementById('loginstage'), boton=document.getElementById('lh-open');
    if(!stage||!boton)return;

    // Caja real en 3D. Si WebGL no está, la librería no cargó o el usuario pidió
    // menos movimiento, montar() devuelve null y queda la caja SVG de siempre.
    var escena=null;
    // La clase va ANTES de montar: el canvas está oculto hasta tenerla y el
    // renderer necesita medirlo para no arrancar en 2x2 píxeles.
    stage.classList.add('has3d');
    try{
      if(window.NinjaLogin3D)escena=window.NinjaLogin3D.montar(document.getElementById('lh-canvas'),{});
    }catch(e){ escena=null; }
    if(escena){ window.__login3d=escena; requestAnimationFrame(function(){ try{ window.dispatchEvent(new Event('resize')); }catch(e){} }); }
    else stage.classList.remove('has3d');

    var abierta=false;
    function abrir(){
      if(abierta)return; abierta=true;
      if(escena)escena.abrir();
      stage.classList.remove('closed'); stage.classList.add('open');
      setTimeout(function(){ var e=document.getElementById('lg-email'); if(e&&window.innerWidth>720)e.focus(); }, 900);
    }
    boton.addEventListener('click',abrir);
    document.addEventListener('keydown',function(e){ if(!abierta&&(e.key==='Enter'||e.key===' '))abrir(); });
    var reloj=setTimeout(abrir, 12000);
    if(reduce)abrir();

    /**
     * Volver al login tras cerrar sesión. Sin esto la caja quedaba marcada como
     * "ya abierta" y el clic no hacía nada: el usuario se quedaba mirando una
     * portada vacía sin forma de volver a entrar.
     */
    window.__loginReset=function(){
      clearTimeout(reloj);
      abierta=false;
      stage.classList.remove('open'); stage.classList.remove('viajando'); stage.classList.add('closed');
      if(escena){
        try{ escena.destruir(); }catch(e){}
        // Canvas nuevo: reusar el viejo deja colgando el contexto WebGL anterior.
        var viejo=document.getElementById('lh-canvas');
        if(viejo){ viejo.parentNode.replaceChild(viejo.cloneNode(false), viejo); }
        escena=window.NinjaLogin3D?window.NinjaLogin3D.montar(document.getElementById('lh-canvas'),{}):null;
        window.__login3d=escena;
        if(!escena)stage.classList.remove('has3d');
        else requestAnimationFrame(function(){ try{ window.dispatchEvent(new Event('resize')); }catch(e){} });
      }
      reloj=setTimeout(abrir, 12000);
      if(reduce)abrir();
    };
  })();

  // Aterrizaje común tras autenticarse (login o registro).
  function afterAuth(r){ token=r.token; me=r.user; role=me.role; entrarAlWms(function(){ $("#loginov").classList.add("off"); init(); syncVerifyBar(); }); }

  // Crear cuenta
  function doRegister(){
    var company=$("#rg-company").value.trim(), name=$("#rg-name").value.trim();
    var email=$("#rg-email").value.trim(), pass=$("#rg-pass").value, track=$("#rg-track").value;
    $("#rg-err").textContent="";
    if(!company||!name||!email||!pass){ $("#rg-err").textContent="Completa todos los campos."; return; }
    if(pass.length<6){ $("#rg-err").textContent="La contraseña debe tener al menos 6 caracteres."; return; }
    var btn=$("#rg-btn"); btn.disabled=true; btn.textContent="Creando…";
    api('/auth/register',{method:'POST',body:{companyName:company,name:name,email:email,password:pass,track:track}}).then(function(r){
      $("#rg-pass").value="";
      pendingVerifyToken = (r.verification && r.verification.devToken) || null; // en local viene el token para verificar aquí mismo
      afterAuth(r);
    }).catch(function(e){ $("#rg-err").textContent=e.message; }).then(function(){ btn.disabled=false; btn.textContent="Crear cuenta gratis"; });
  }
  if($("#rg-btn"))$("#rg-btn").addEventListener("click",doRegister);
  if($("#rg-pass"))$("#rg-pass").addEventListener("keydown",function(e){if(e.key==="Enter")doRegister();});

  // Olvidé mi contraseña
  function doForgot(){
    var email=$("#fg-email").value.trim(); $("#fg-err").textContent="";
    if(!email){ $("#fg-err").textContent="Ingresa tu email."; return; }
    var btn=$("#fg-btn"); btn.disabled=true;
    api('/auth/request-password-reset',{method:'POST',body:{email:email}}).then(function(){
      var ok=$("#fg-ok"); ok.hidden=false; ok.textContent="Si ese email tiene una cuenta, te enviamos un enlace para restablecer tu contraseña. Revisa tu correo.";
      $("#fg-email").value="";
    }).catch(function(e){ $("#fg-err").textContent=e.message; }).then(function(){ btn.disabled=false; });
  }
  if($("#fg-btn"))$("#fg-btn").addEventListener("click",doForgot);
  if($("#fg-email"))$("#fg-email").addEventListener("keydown",function(e){if(e.key==="Enter")doForgot();});

  // Elegir nueva contraseña (llega por enlace ?reset=)
  function doReset(){
    var pass=$("#rs-pass").value; $("#rs-err").textContent="";
    if(!pass||pass.length<6){ $("#rs-err").textContent="La contraseña debe tener al menos 6 caracteres."; return; }
    if(!resetToken){ $("#rs-err").textContent="El enlace no es válido."; return; }
    var btn=$("#rs-btn"); btn.disabled=true;
    api('/auth/reset-password',{method:'POST',body:{token:resetToken,password:pass}}).then(function(r){
      if(!r.ok){ $("#rs-err").textContent=r.error||"No se pudo restablecer."; return; }
      var ok=$("#rs-ok"); ok.hidden=false; ok.textContent="¡Listo! Tu contraseña quedó actualizada. Ahora inicia sesión.";
      $("#rs-pass").value=""; resetToken=null;
      setTimeout(function(){ lgShow("login"); },1400);
    }).catch(function(e){ $("#rs-err").textContent=e.message; }).then(function(){ btn.disabled=false; });
  }
  if($("#rs-btn"))$("#rs-btn").addEventListener("click",doReset);
  if($("#rs-pass"))$("#rs-pass").addEventListener("keydown",function(e){if(e.key==="Enter")doReset();});

  // Banner de "verifica tu email" dentro del panel
  function syncVerifyBar(){
    var bar=$("#verifybar"); if(!bar)return;
    var need = me && me.emailVerified===false;
    bar.classList.toggle("off",!need);
    if(need&&$("#vb-email")) $("#vb-email").textContent=me.email||"";
    // El botón "Verificar ahora" solo aparece en local (cuando el backend devolvió el token).
    var dv=$("#vb-devverify"); if(dv) dv.hidden = !(need && pendingVerifyToken);
  }
  if($("#vb-devverify"))$("#vb-devverify").addEventListener("click",function(){
    if(!pendingVerifyToken)return; var st=$("#vb-status"); if(st)st.textContent="Verificando…";
    api('/auth/verify-email',{method:'POST',body:{token:pendingVerifyToken}}).then(function(r){
      if(r&&r.ok){ if(me)me.emailVerified=true; pendingVerifyToken=null; syncVerifyBar(); toast("¡Email verificado!"); }
      else { if(st)st.textContent=(r&&r.error)||"No se pudo verificar"; }
    }).catch(function(e){ if(st)st.textContent=e.message; });
  });
  if($("#vb-resend"))$("#vb-resend").addEventListener("click",function(){
    if(!me)return; var st=$("#vb-status"); if(st)st.textContent="Enviando…";
    api('/auth/resend-verification',{method:'POST',body:{email:me.email}}).then(function(r){
      if(r&&r.verification&&r.verification.devToken){ pendingVerifyToken=r.verification.devToken; syncVerifyBar(); }
      if(st)st.textContent="Enviado ✓";
    }).catch(function(){ if(st)st.textContent=""; });
  });
  if($("#vb-x"))$("#vb-x").addEventListener("click",function(){ $("#verifybar").classList.add("off"); });

  // Resultado de verificación de email
  function verifyResult(ok,error){
    $("#vf-title").textContent = ok ? "¡Email verificado!" : "No pudimos verificar";
    $("#vf-msg").textContent = ok ? "Tu cuenta quedó confirmada. Ya puedes iniciar sesión." : (error||"El enlace no es válido o venció.");
    var b=$("#vf-btn"); if(b)b.hidden=false;
  }
  function cleanUrl(){ try{ history.replaceState({},document.title,location.pathname); }catch(e){} }

  // Boot: enlaces de verificación / reset que llegan por correo
  (function bootAuthLinks(){
    var qs; try{ qs=new URLSearchParams(location.search); }catch(e){ return; }
    var v=qs.get("verify"), rs=qs.get("reset");
    if(v){
      lgShow("verify");
      api('/auth/verify-email',{method:'POST',body:{token:v}}).then(function(r){ verifyResult(!!r.ok,r.error); }).catch(function(e){ verifyResult(false,e.message); });
      cleanUrl();
    } else if(rs){
      resetToken=rs; lgShow("reset"); cleanUrl();
    }
  })();
})();
