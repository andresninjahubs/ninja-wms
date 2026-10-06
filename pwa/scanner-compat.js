/**
 * Lector de códigos de barras compatible con iPhone (Safari) y Android.
 *
 * La app usa la API estándar `BarcodeDetector`. Chrome en Android la trae de fábrica,
 * pero Safari (iPhone/iPad) NO, y algunos Android sin servicios de Google la exponen
 * sin formatos. En esos equipos instalamos un reemplazo 100% compatible basado en
 * ZXing compilado a WebAssembly (vendor/barcode-detector.js + vendor/zxing_reader.wasm,
 * licencia MIT), servido desde nuestro propio dominio: no depende de CDNs externos y
 * queda en la caché del service worker para funcionar con mala señal.
 *
 * window.__scanEngine = 'nativo' | 'zxing' (útil para soporte).
 */
(function () {
  var API = window.BarcodeDetectionAPI;
  if (!API || !API.BarcodeDetector) return;
  var WASM = new URL('./vendor/zxing_reader.wasm', document.baseURI).href;
  // Mismo objeto siempre: el módulo compara las opciones para no re-instanciar el wasm.
  var OVERRIDES = { locateFile: function (path, prefix) { return /\.wasm$/.test(path) ? WASM : prefix + path; } };
  try { API.prepareZXingModule({ overrides: OVERRIDES }); } catch (e) { /* versión sin prepare */ }

  var Zx = API.BarcodeDetector;
  function usarZxing() {
    window.BarcodeDetector = Zx;
    window.__scanEngine = 'zxing';
    // Precarga del motor (≈1 MB, una sola vez) sin frenar el arranque de la app.
    setTimeout(function () { try { API.prepareZXingModule({ overrides: OVERRIDES, fireImmediately: true }); } catch (e) { /* ignore */ } }, 1500);
  }
  var nativo = window.BarcodeDetector;
  if (!nativo) { usarZxing(); return; }
  window.__scanEngine = 'nativo';
  // Nativo presente pero sin EAN-13 (o roto): también se reemplaza.
  try {
    if (typeof nativo.getSupportedFormats === 'function') {
      nativo.getSupportedFormats().then(function (f) {
        if (!f || f.indexOf('ean_13') < 0 || f.indexOf('code_128') < 0) usarZxing();
      }).catch(usarZxing);
    }
  } catch (e) { usarZxing(); }
})();
