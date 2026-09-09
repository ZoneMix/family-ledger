/* Service worker for The Family Ledger */
const CACHE = 'family-ledger-v2';
const PRECACHE = [
  '/icons/icon.svg',
  '/manifest.json',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Never touch API calls — always straight to network
  if (url.pathname.startsWith('/api/')) return;
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  // Network-first for app shell (HTML/CSS/JS) — fall back to cache only if
  // offline. This ensures updates are immediately visible to users.
  const isAppShell = /\.(html|css|js|json)$/i.test(url.pathname) || url.pathname === '/';

  if (isAppShell) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response && response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Cache-first for images, fonts, icons
  event.respondWith(
    caches.match(request).then((cached) => {
      return cached || fetch(request).then((response) => {
        if (response && response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
