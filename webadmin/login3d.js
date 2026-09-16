/**
 * Portada del login: una caja de cartón de verdad, en 3D.
 * ---------------------------------------------------------------------------
 * La caja se arma sola, espera el clic de la persona, se abre, y de adentro sale
 * el formulario. Al entrar, la cámara VIAJA hacia dentro de la caja: es el gesto
 * de "entrar al WMS": la cámara cae dentro de la caja en 1,4 s.
 *
 * Reglas que se respetan sí o sí:
 *   - Si no hay WebGL, o la librería no carga, o la persona pidió menos movimiento,
 *     esto no se monta y queda la portada CSS de siempre. Nadie se queda afuera
 *     por un adorno.
 *   - Todo se sirve desde el propio servidor (vendor/three.min.js), sin CDN.
 */
(function () {
  var API = {};
  window.NinjaLogin3D = API;

  function reduceMotion() {
    try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { return false; }
  }
  function hayWebGL() {
    try {
      var c = document.createElement('canvas');
      return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
    } catch (e) { return false; }
  }

  /**
   * Textura de cartón corrugado dibujada a mano en un canvas: fibra, corrugado,
   * manchas y un borde más oscuro. Es lo que separa "una caja" de "un cubo café".
   */
  function texturaCarton(THREE, tono) {
    var s = 512, c = document.createElement('canvas');
    c.width = c.height = s;
    var g = c.getContext('2d');
    g.fillStyle = tono || '#C8A268';
    g.fillRect(0, 0, s, s);
    // Fibra: ruido fino.
    var img = g.getImageData(0, 0, s, s), d = img.data;
    for (var i = 0; i < d.length; i += 4) {
      var n = (Math.random() - 0.5) * 26;
      d[i] += n; d[i + 1] += n * 0.9; d[i + 2] += n * 0.7;
    }
    g.putImageData(img, 0, 0);
    // Corrugado: líneas suaves y parejas.
    g.globalAlpha = 0.07;
    for (var x = 0; x < s; x += 7) {
      g.fillStyle = x % 14 === 0 ? '#6E4F2A' : '#F0D9AE';
      g.fillRect(x, 0, 3, s);
    }
    // Manchas de uso.
    g.globalAlpha = 0.05;
    for (var k = 0; k < 26; k++) {
      g.fillStyle = Math.random() > 0.5 ? '#8A6636' : '#EBD6B0';
      var r = 8 + Math.random() * 46;
      g.beginPath(); g.arc(Math.random() * s, Math.random() * s, r, 0, 6.283); g.fill();
    }
    g.globalAlpha = 1;
    var t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    if (THREE.SRGBColorSpace) t.colorSpace = THREE.SRGBColorSpace;
    return t;
  }

  /** Un panel de cartón con bisagra: el grupo es el eje, la malla cuelga de él. */
  function panel(THREE, mat, ancho, alto, grosor, offsetY) {
    var g = new THREE.Group();
    g.rotation.order = 'YXZ';   // primero el giro propio (x), después la orientación (y)
    var m = new THREE.Mesh(new THREE.BoxGeometry(ancho, grosor, alto), mat);
    m.position.z = alto / 2;
    m.position.y = offsetY || 0;
    m.castShadow = true; m.receiveShadow = true;
    g.add(m);
    return g;
  }

  API.montar = function (canvas, opts) {
    opts = opts || {};
    if (!canvas || !hayWebGL() || reduceMotion() || !window.THREE) return null;
    var THREE = window.THREE;

    var ren = new THREE.WebGLRenderer({ canvas: canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    ren.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    ren.shadowMap.enabled = true;
    ren.shadowMap.type = THREE.PCFSoftShadowMap;
    if (THREE.ACESFilmicToneMapping) { ren.toneMapping = THREE.ACESFilmicToneMapping; ren.toneMappingExposure = 1.05; }
    if (THREE.SRGBColorSpace) ren.outputColorSpace = THREE.SRGBColorSpace;

    var esc = new THREE.Scene();
    var cam = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    cam.position.set(0, 2.35, 5.3);
    cam.lookAt(0, 0.1, 0);

    // Luz: una clave cálida con sombra, relleno frío y ambiente. El contraste es
    // lo que hace que el cartón parezca cartón.
    esc.add(new THREE.HemisphereLight(0xdff0ff, 0x3b2d1f, 0.55));
    esc.add(new THREE.AmbientLight(0xffffff, 0.25));
    var key = new THREE.DirectionalLight(0xfff0d8, 2.1);
    key.position.set(3.4, 6.2, 4.2);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.near = 1; key.shadow.camera.far = 20;
    key.shadow.camera.left = -5; key.shadow.camera.right = 5;
    key.shadow.camera.top = 5; key.shadow.camera.bottom = -5;
    key.shadow.bias = -0.0012;
    esc.add(key);
    var fill = new THREE.DirectionalLight(0x9fd8ff, 0.5);
    fill.position.set(-4, 2.5, -2.5);
    esc.add(fill);

    // Piso invisible que solo recibe la sombra: ancla la caja al suelo.
    var piso = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.ShadowMaterial({ opacity: 0.22 }));
    piso.rotation.x = -Math.PI / 2;
    piso.position.y = -1.02;
    piso.receiveShadow = true;
    esc.add(piso);

    var texFuera = texturaCarton(THREE, '#C8A268');
    var texDentro = texturaCarton(THREE, '#A9834F');
    var matFuera = new THREE.MeshStandardMaterial({ map: texFuera, roughness: 0.94, metalness: 0 });
    var matDentro = new THREE.MeshStandardMaterial({ map: texDentro, roughness: 0.98, metalness: 0 });

    var caja = new THREE.Group();
    esc.add(caja);

    var W = 2.5, H = 1.85, D = 2.0, T = 0.055;  // ancho, alto, fondo, grosor
    // Fondo y cuatro paredes.
    var fondo = new THREE.Mesh(new THREE.BoxGeometry(W, T, D), matFuera);
    fondo.position.y = -H / 2; fondo.receiveShadow = true; fondo.castShadow = true;
    caja.add(fondo);
    function pared(w, h, d, x, y, z) {
      var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), matFuera);
      m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true;
      caja.add(m); return m;
    }
    pared(W, H, T, 0, 0, -D / 2);           // atrás
    pared(W, H, T, 0, 0, D / 2);            // adelante
    pared(T, H, D, -W / 2, 0, 0);           // izquierda
    pared(T, H, D, W / 2, 0, 0);            // derecha
    // Interior más oscuro: le da profundidad a la boca abierta.
    var interior = new THREE.Mesh(new THREE.BoxGeometry(W - T * 2.2, H - T * 2, D - T * 2.2), matDentro);
    interior.material.side = THREE.DoubleSide || 2;
    interior.position.y = 0.02;
    caja.add(interior);

    // Cuatro solapas con bisagra en el borde superior de cada pared.
    var flaps = {};
    function agregarFlap(nombre, ancho, largo, pos, rotY) {
      var g = panel(THREE, matFuera, ancho, largo, T, 0);
      g.position.set(pos[0], pos[1], pos[2]);
      g.rotation.y = rotY || 0;
      caja.add(g);
      flaps[nombre] = g;
      return g;
    }
    var yTop = H / 2;
    agregarFlap('atras', W, D / 2 - T, [0, yTop, -D / 2], 0);
    agregarFlap('adelante', W, D / 2 - T, [0, yTop, D / 2], Math.PI);
    agregarFlap('izq', D, W / 2 - T, [-W / 2, yTop, 0], Math.PI / 2);
    agregarFlap('der', D, W / 2 - T, [W / 2, yTop, 0], -Math.PI / 2);

    // Cinta de embalar sobre la unión de las solapas largas (cerrada).
    var cinta = new THREE.Mesh(new THREE.BoxGeometry(W * 0.99, T * 0.6, 0.34),
      new THREE.MeshStandardMaterial({ color: 0xcdb38a, roughness: 0.55, metalness: 0.02, transparent: true, opacity: 0.92 }));
    cinta.position.set(0, yTop + T * 0.9, 0);
    cinta.castShadow = true;
    caja.add(cinta);

    // Luz interior: se enciende al abrir, como si adentro hubiera algo que vale.
    var luzDentro = new THREE.PointLight(0xd9fff1, 0, 4.2, 2);
    luzDentro.position.set(0, -0.15, 0);
    caja.add(luzDentro);

    // ---- Estado y animación ---------------------------------------------------
    var t0 = performance.now();
    var tAbrir = 0, tEntrar = 0, hover = 0;
    var cbEntrada = null;

    function ease(x) { return 1 - Math.pow(1 - x, 3); }
    function easeIn(x) { return x * x * x; }

    // En cuadros angostos (móvil) hace falta abrir el lente, si no las solapas
    // se salen por los costados.
    var estado = 'armando';   // armando → cerrada → abriendo → abierta → entrando
    var fovBase = 38;
    function medir() {
      var r = canvas.getBoundingClientRect();
      var w = Math.max(1, r.width), h = Math.max(1, r.height);
      ren.setSize(w, h, false);
      cam.aspect = w / h;
      fovBase = cam.aspect < 1.55 ? 38 + (1.55 - cam.aspect) * 26 : 38;
      if (estado !== 'entrando') cam.fov = fovBase;
      cam.updateProjectionMatrix();
    }
    medir();
    window.addEventListener('resize', medir);

    // Armado: las solapas parten abiertas y se cierran; la caja "aparece".
    var cerradoAtras = -0.02, abierto = 2.35;
    function setFlaps(v) {
      // v=0 → cerradas y planas; v creciente → se abren hacia arriba y afuera.
      flaps.adelante.rotation.x = -v;
      flaps.atras.rotation.x = -v;
      flaps.izq.rotation.x = -v * 0.92;
      flaps.der.rotation.x = -v * 0.92;
    }
    setFlaps(abierto);

    function frame(now) {
      var t = (now - t0) / 1000;
      if (estado === 'armando') {
        var p = Math.min(1, t / 1.15);
        caja.position.y = (1 - ease(p)) * -1.6;
        caja.rotation.y = -0.55 + ease(p) * 0.22;
        setFlaps(abierto - ease(Math.max(0, (p - 0.35) / 0.65)) * (abierto - cerradoAtras));
        cinta.scale.x = Math.max(0.001, ease(Math.max(0, (p - 0.75) / 0.25)));
        if (p >= 1) { estado = 'cerrada'; if (opts.onArmada) opts.onArmada(); }
      } else if (estado === 'cerrada') {
        // Respira: flota apenas y gira muy lento. Quieta se ve muerta.
        caja.position.y = Math.sin(t * 1.15) * 0.055;
        caja.rotation.y = -0.33 + Math.sin(t * 0.42) * 0.09 + hover * 0.06;
        caja.rotation.z = Math.sin(t * 0.8) * 0.012;
      } else if (estado === 'abriendo' || estado === 'abierta') {
        var q = Math.min(1, (now - tAbrir) / 900);
        var v = cerradoAtras + ease(q) * (abierto - cerradoAtras);
        setFlaps(v);
        cinta.scale.x = Math.max(0.001, 1 - Math.min(1, q * 3));
        luzDentro.intensity = ease(q) * 2.6;
        caja.position.y = Math.sin(t * 1.15) * 0.03;
        caja.rotation.y = -0.33 + (1 - ease(q)) * 0.0 + Math.sin(t * 0.42) * 0.05;
        // La cámara se acerca un poco al abrirse: invita a mirar adentro.
        // Al abrirse la caja crece hacia arriba: la cámara se aleja un poco y
        // sube la mirada, si no las solapas se salen del cuadro.
        cam.position.z = 5.3 + ease(q) * 0.75;
        cam.position.y = 2.35 + ease(q) * 0.3;
        cam.lookAt(0, 0.35 + ease(q) * 0.25, 0);
        if (q >= 1 && estado === 'abriendo') { estado = 'abierta'; if (opts.onAbierta) opts.onAbierta(); }
      } else if (estado === 'entrando') {
        // El viaje: la cámara cae dentro de la caja. Dura 1,4 s.
        var e = Math.min(1, (now - tEntrar) / 1400);
        var k = easeIn(e);
        cam.position.z = 6.05 - k * 6.2;
        cam.position.y = 2.65 - k * 2.6;
        cam.fov = fovBase + k * 46;
        cam.updateProjectionMatrix();
        cam.lookAt(0, -0.1, 0);
        luzDentro.intensity = 2.6 + k * 16;
        if (e >= 1) { if (cbEntrada) { var f = cbEntrada; cbEntrada = null; f(); } return; }
      }
      ren.render(esc, cam);
      requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);

    canvas.addEventListener('mouseenter', function () { hover = 1; });
    canvas.addEventListener('mouseleave', function () { hover = 0; });

    return {
      abrir: function () {
        if (estado !== 'cerrada' && estado !== 'armando') return false;
        estado = 'abriendo'; tAbrir = performance.now();
        return true;
      },
      /** Viaje hacia dentro de la caja. Llama a `listo` al terminar (1,4 s). */
      entrar: function (listo) {
        if (estado === 'entrando') return;
        estado = 'entrando'; tEntrar = performance.now(); cbEntrada = listo;
      },
      destruir: function () {
        window.removeEventListener('resize', medir);
        try { ren.dispose(); } catch (e) {}
      },
    };
  };
})();
