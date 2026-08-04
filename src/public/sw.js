// AP Control service worker — makes the app installable and keeps the static shell available
// offline. It deliberately caches ONLY static assets (styles, icons, manifest); pages and data
// always go to the network and are never cached, so financial data is never stored on-device
// or leaked between users on a shared device.

const CACHE = 'apc-static-v2';
const ASSETS = ['/style.css', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never touch mutations
  const url = new URL(request.url);
  if (url.origin === self.location.origin && ASSETS.includes(url.pathname)) {
    // cache-first for the static shell
    event.respondWith(caches.match(request).then((r) => r || fetch(request)));
  }
  // everything else: default network behaviour (no caching of pages/data)
});
