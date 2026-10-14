/*
 * Minimal service worker for TempMail.cc.
 *
 * Strategy:
 *  - Static assets (css/js/img/fonts): cache-first. They carry ?v= version
 *    query strings, so a deploy changes the URL and the cache self-invalidates.
 *  - Navigations (HTML) and everything else: network-first, falling back to
 *    the cache when offline.
 *
 * Never cache: the socket.io endpoint (handled by connect-src, and non-GET
 * requests are never touched anyway).
 */
const VERSION = 'v1';
const CACHE = `tempmail-${VERSION}`;
const PRECACHE = [
  '/',
  '/manifest.webmanifest',
  '/favicon.png',
  '/logo.png',
  '/css/modern.css',
  '/css/prism.css',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;

  // Socket.io polling requests must always hit the network.
  if (new URL(req.url).pathname.startsWith('/socket.io/')) return;

  // Static assets are versioned via query string -> safe to cache-first.
  if (/\.(css|js|png|jpg|jpeg|svg|ico|webp|woff2?)$/i.test(new URL(req.url).pathname)) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
        return res;
      }))
    );
    return;
  }

  // Navigations & everything else: network-first, cache fallback when offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match('/')))
  );
});
