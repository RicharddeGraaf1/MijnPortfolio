// Laat de app ook zonder verbinding openen. Koersen gaan nooit via deze cache:
// die bewaart de app zelf, met het tijdstip erbij.
const CACHE = 'mijnportfolio-v6';
const SHELL = [
  '/',
  '/style.css',
  '/js/app.js',
  '/js/chart.js',
  '/js/core.js',
  '/js/quotes.js',
  '/js/store.js',
  '/fonts/archivo.woff2',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Toon meteen wat er is en ververs op de achtergrond; de volgende keer openen is dan bijgewerkt.
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;

  const key = event.request.mode === 'navigate' ? '/' : event.request;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(key);
      const network = fetch(event.request).then((response) => {
        if (response.ok) cache.put(key, response.clone());
        return response;
      });
      if (cached) {
        network.catch(() => {});
        return cached;
      }
      return network;
    }),
  );
});
