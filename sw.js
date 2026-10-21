// Offline cache: everything Lull needs is stored on first visit.
const VERSION = 'lull-v2';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'engine.js',
  'bubble.js',
  'store.js',
  'manifest.webmanifest',
  'icons/icon-180.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'fonts/spectral-latin-300-normal.woff2',
  'fonts/spectral-latin-300-italic.woff2',
  'fonts/spectral-latin-400-normal.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Serve from the cache first, refresh it in the background when online.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(VERSION).then(async (cache) => {
      const hit = (await cache.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? await cache.match('index.html') : null);
      const net = fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            cache.put(req, copy);
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});
