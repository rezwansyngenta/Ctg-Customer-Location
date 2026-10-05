/* ============================================================
   Service worker — app shell cache for offline use
   ============================================================ */

const CACHE = 'pinpoint-v2';

/* config.js is intentionally absent: it holds the deployment URL, is
   gitignored, and is only ever needed while online. Including it in a
   single cache.addAll() call meant a missing file aborted the whole
   install, so the worker never activated and offline never worked. */
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './Syngenta_Logo.svg',
  './fonts/HindSiliguri-Bengali-400.woff2',
  './fonts/HindSiliguri-Bengali-700.woff2',
  './fonts/HindSiliguri-Latin-400.woff2',
  './fonts/HindSiliguri-Latin-700.woff2'
];

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    /* Add one by one: a single 404 must not abort the install. */
    await Promise.all(SHELL.map(url =>
      cache.add(new Request(url, { cache: 'reload' })).catch(err =>
        console.warn('[sw] skipped', url, err.message)
      )
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  /* Apps Script endpoint: never cached, never intercepted offline.
     Failing fast lets the app fall through to its IndexedDB queue. */
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleapis.com')) {
    return;
  }

  if (url.origin !== self.location.origin) return;

  /* config.js holds the deployment URL. Offline capture never needs it, and
     cache-first would serve a stale deployment URL forever after a redeploy.
     Serve from network, fall back to cache only if the network is gone. */
  if (url.pathname.endsWith('/config.js')) {
    e.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.status === 200) {
          const c = await caches.open(CACHE);
          c.put(req, fresh.clone());
        }
        return fresh;
      } catch (err) {
        const stale = await caches.match(req);
        if (stale) return stale;
        throw err;
      }
    })());
    return;
  }

  /* Cache-first for the shell, so an offline launch is instant. */
  e.respondWith((async () => {
    const cached = await caches.match(req, { ignoreSearch: true });
    if (cached) return cached;

    try {
      const res = await fetch(req);
      if (res && res.status === 200 && res.type === 'basic') {
        const copy = res.clone();
        const cache = await caches.open(CACHE);
        cache.put(req, copy);
      }
      return res;
    } catch (err) {
      /* Offline navigation still has to render the app. */
      if (req.mode === 'navigate') {
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});