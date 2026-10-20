/* ============================================================
 * SALON ASTERIA INVENTORY — SERVICE WORKER
 *
 * The app shell is cached so the stockroom, where the Wi-Fi ends,
 * is not where the app stops working. API calls are never cached —
 * inventory data lives in localStorage (see cacheData in app.js)
 * and unsent writes live in the queue.
 *
 * Bump CACHE whenever a shell file changes.
 * ============================================================ */
const CACHE = 'asteria-shell-v4';

const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './manifest.webmanifest',
  './img/logo-mark.png',
  './img/logo-wordmark.png',
  './img/icon-192.png',
  './img/icon-512.png',
  './img/apple-touch-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* Only these are ever cached. An allow-list, not a deny-list: a cached
   inventory response is worse than no response, because it looks current. */
const STATIC = /\.(?:html|css|js|png|svg|webmanifest|ico|woff2?)$/i;

function isCacheable(url) {
  if (url.origin !== self.location.origin) return false;   // Apps Script, etc.
  const p = url.pathname;
  if (p.endsWith('/sw.js')) return false;                  // never cache ourselves
  if (p === '/' || p.endsWith('/')) return true;           // the shell itself
  return STATIC.test(p);
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Navigations: serve the shell immediately, refresh it in the background.
  if (req.mode === 'navigate') {
    e.respondWith(
      caches.match('./index.html').then(cached => {
        const net = fetch(req)
          .then(res => {
            if (res && res.ok) caches.open(CACHE).then(c => c.put('./index.html', res.clone()));
            return res;
          })
          .catch(() => cached);
        return cached || net;
      })
    );
    return;
  }

  // Anything that is not a static asset — every API call — goes straight to
  // the network and is never stored.
  if (!isCacheable(url)) return;

  // Static assets: cache first, then fill the cache on a miss.
  e.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(res => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy));
        }
        return res;
      });
    })
  );
});
