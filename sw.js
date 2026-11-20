// The offline copy. The page comes from the network first, so an update shows on the next load, and from the cache
// when the network fails; the manifest and the icons come from the cache. Built by tools/build.mjs: edit src/sw.js.
const CACHE = 'triage-83fc00d59970';
const FILES = ["./","index.html","manifest.webmanifest","icons/icon.svg","icons/icon-192.png","icons/icon-512.png","icons/maskable-512.png"];
const scope = new URL(self.registration.scope);
const OWN = FILES.map((f) => new URL(f, scope).href);

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('triage-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== scope.origin) return;
  if (req.mode === 'navigate') {
    if (url.pathname !== scope.pathname && url.pathname !== `${scope.pathname}index.html`) return;
    e.respondWith(fetch(req)
      .then((res) => (res.ok
        ? caches.open(CACHE).then((c) => c.put('index.html', res.clone())).catch(() => {}).then(() => res)
        : res))
      .catch(() => caches.match('index.html', { cacheName: CACHE }).then((hit) => hit || Response.error())));
    return;
  }
  // A miss means the cache lost a file (every site on this origin shares CacheStorage): fetch it and put it back.
  const key = url.origin + url.pathname;
  e.respondWith(caches.match(req, { cacheName: CACHE, ignoreSearch: true }).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok && OWN.includes(key)) {
      const copy = res.clone(); // now, before the page reads the body
      e.waitUntil(caches.open(CACHE).then((c) => c.put(key, copy)).catch(() => {}));
    }
    return res;
  })).catch(() => Response.error()));
});
