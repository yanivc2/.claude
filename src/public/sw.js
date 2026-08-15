// AP Control service worker — makes the app installable and keeps the static shell available
// offline. It deliberately caches ONLY static assets (styles, icons, manifest); pages and data
// always go to the network and are never cached, so financial data is never stored on-device
// or leaked between users on a shared device.

const CACHE = 'apc-static-v3';
const ASSETS = ['/style.css', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'];

// Small scanner assets, filled in on first use and then served cache-first. Each URL carries a
// ?v= version, which is what lets a new deploy replace a cached copy.
const RUNTIME = 'apc-scanner-v2';
const RUNTIME_PREFIXES = ['/scan-capture.js'];

const isRuntimeAsset = (pathname) => RUNTIME_PREFIXES.some((p) => pathname.startsWith(p));

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k !== RUNTIME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return; // never touch mutations
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (ASSETS.includes(url.pathname)) {
    // cache-first for the static shell
    event.respondWith(caches.match(request).then((r) => r || fetch(request)));
    return;
  }

  if (isRuntimeAsset(url.pathname)) {
    // Cache-first, filled on first use. Both URLs carry a ?v= version, so a new build asks for a
    // new key rather than being served a stale engine forever; the old key is then pruned so the
    // cache cannot grow without bound.
    event.respondWith(
      caches.open(RUNTIME).then((cache) =>
        cache.match(request).then(
          (hit) =>
            hit ||
            fetch(request).then((res) => {
              if (!res.ok) return res;
              cache.put(request, res.clone());
              prune(cache, url);
              return res;
            }),
        ),
      ),
    );
    return;
  }
  // everything else: default network behaviour (no caching of pages/data)
});

/** Drop older versions of the asset we just cached (same pathname, different ?v=). */
function prune(cache, keep) {
  cache.keys().then((keys) => {
    keys.forEach((req) => {
      const u = new URL(req.url);
      if (u.pathname === keep.pathname && u.search !== keep.search) cache.delete(req);
    });
  });
}
