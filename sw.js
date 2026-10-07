/* ============================================================
   Service worker — app shell cache for offline use
   ============================================================ */

/* Bump this on every release that changes a shell file. The activate
   handler below deletes every cache that is not named here, so a new name
   retires the old one on the next load. Without the bump, phones keep
   serving the previous app.js from cache indefinitely. */
const CACHE = 'pinpoint-v4';

/* config.js is intentionally absent: it holds the deployment URL, is
   gitignored, and is only ever needed while online. Including it in a
   single cache.addAll() call meant a missing file aborted the whole
   install, so the worker never activated and offline never worked. */
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js'
];

/* Skeletons for offline rendering that do NOT need to gate activation.
   If they sat in SHELL, every update re-fetched 160 KB of woff2 before
   skipWaiting could claim the page - on a slow phone that loses the race
   against the document's own script load, so a fresh refresh still served
   the previous app.js. The stale-while-revalidate handler caches these on
   the first online render instead, and offline fallback needs only
   index.html + css + js, which ARE in SHELL. */
const DEFERRED = [
  './manifest.json',
  './Syngenta_Logo.svg',
  './fonts/HindSiliguri-Bengali-400.woff2',
  './fonts/HindSiliguri-Bengali-700.woff2',
  './fonts/HindSiliguri-Latin-400.woff2',
  './fonts/HindSiliguri-Latin-700.woff2'
]

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

  /* Stale-while-revalidate for the shell: serve the cached copy instantly
     (an offline launch must not wait on the network) but refresh it in the
     background when there IS a network. Pure cache-first meant a phone kept
     running whatever app.js it had cached until someone remembered to bump
     CACHE - and a stale app.js queues submissions that never drain.

     Navigations are the one exception and deliberately network-first:
     every refresh reads the CURRENT index.html from the server, so a
     release reaches a phone on the first reload instead of after a
     stale-then-fresh two-load dance. Offline navigation still falls back
     to the cached shell. */
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req, { ignoreSearch: true });

    const refresh = fetch(req).then(res => {
      if (res && res.status === 200 && res.type === 'basic') {
        cache.put(req, res.clone());
      }
      return res;
    }).catch(() => null);

    if (req.mode === 'navigate') {
      const fresh = await refresh;
      if (fresh) return fresh;
      if (cached) return cached;
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
      throw new Error('offline and not cached: ' + req.url);
    }

    if (cached) {
      /* Do not await: the cached copy answers now, the update lands for
         the next load. */
      e.waitUntil(refresh);
      return cached;
    }

    const fresh = await refresh;
    if (fresh) return fresh;

    if (req.mode === 'navigate') {
      const fallback = await cache.match('./index.html');
      if (fallback) return fallback;
    }
    throw new Error('offline and not cached: ' + req.url);
  })());
});