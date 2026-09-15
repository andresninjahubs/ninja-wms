/**
 * Service worker de la PWA operador.
 * Cachea el "shell" de la app para que abra sin conexión; las llamadas a la API
 * van siempre a la red (el stock no se cachea, debe ser fresco).
 */
const CACHE = 'wms-operador-v3';
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
  // Solo el SHELL de la app (bajo el scope del service worker) va cache-first.
  // TODO lo demás (API: sellers, assignments, operations, auth, labor…) va SIEMPRE a la red.
  const scope = new URL(self.registration.scope).pathname;
  if (e.request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(scope)) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
