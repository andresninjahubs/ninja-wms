/**
 * Service worker de la PWA operador.
 * Cachea el "shell" de la app para que abra sin conexión; las llamadas a la API
 * van siempre a la red (el stock no se cachea, debe ser fresco).
 */
const CACHE = 'wms-operador-v2';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Nunca cachear la API: red directa.
  if (/\/(sellers|auth|locations|users)(\/|$)/.test(url.pathname)) return;
  // Shell: cache-first.
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
