// Service worker: guarda o app no aparelho para abrir sem internet.
// Os dados (MEs, fila de envio) ficam no IndexedDB, não aqui.
var CACHE = 'estoque-app-v1';
var SHELL = ['/app/', '/app/app.js', '/app/vendor/jsQR.js', '/app/manifest.webmanifest', '/app/icon.svg', '/app/icon-192.png', '/app/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('fetch', function (e) {
  var req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.indexOf('/app/') !== 0 || url.pathname === '/app/sw.js') return;
  // mostra o que está guardado na hora e atualiza em segundo plano
  e.respondWith(caches.open(CACHE).then(function (c) {
    return c.match(req, { ignoreSearch: true }).then(function (hit) {
      var rede = fetch(req).then(function (r) { if (r && r.ok) c.put(req, r.clone()); return r; });
      rede.catch(function () {});
      return hit || rede.catch(function () { return c.match('/app/'); });
    });
  }));
});
