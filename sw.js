// TXOKO Formación — Service Worker (v5.6)
// Lives at the site root (same level as index.html). Provides:
//   • App-shell cache with stale-while-revalidate for offline support
//   • Web Push notifications
//   • Notification click → focus existing window in scope, or open one

const VERSION = 'v7.202';
const CACHE_NAME = `txoko-shell-${VERSION}`;

// Files cached as the app shell. Keep this list short — large data should be
// fetched live and cached opportunistically by the runtime handler below.
// Lazy-loaded data (data/*.json, ~600 KB across wines, vinos-content, LQA
// and ghost scenarios) is NOT pre-cached: each file is fetched on-demand the
// first time its feature is opened (or idle-preloaded for wines), and the
// stale-while-revalidate handler below stores it automatically.
const SHELL_URLS = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './badge-96.png'
];

// ─── Install: pre-cache the shell ───────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      // no-cache: el precacheo del shell debe venir de la RED, no del cache
      // HTTP intermedio — clave para el push de actualización (la versión
      // nueva queda lista en segundo plano antes de abrir la app).
      .then(cache => cache.addAll(SHELL_URLS.map(u => new Request(u, { cache: 'no-cache' }))).catch(() => null))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate: drop old caches, take control ────────────────────
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('txoko-shell-') && k !== CACHE_NAME)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// The app shell (the HTML document + its CSS/manifest) must never drift out of
// sync across a deploy. A navigation request and styles.css are matched here so
// they can use network-first below.
function isShellRequest(req, url) {
  if (req.mode === 'navigate') return true;               // the HTML document
  const p = url.pathname;
  return p === '/' || p.endsWith('/') ||
         /\/(index\.html|styles\.css|manifest\.json)$/.test(p);
}

// ─── Fetch: network-first for the shell, stale-while-revalidate for the rest ──
// The shell (HTML + styles.css + manifest) is served NETWORK-FIRST so an online
// user always gets the freshly deployed version — HTML and CSS together, never a
// mismatched pair — with the cache as an offline-only fallback. Everything else
// (lazy-loaded data JSON, icons) keeps stale-while-revalidate for speed.
// Skips: non-GET, cross-origin, Supabase API/RPC calls (always live).
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // CDN, Supabase, fonts → bypass
  if (url.pathname.startsWith('/rest/') || url.pathname.startsWith('/functions/')) return;

  // ── Shell → network-first (fresh deploy wins; cache only if offline) ──
  if (isShellRequest(req, url)) {
    e.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        try {
          const fresh = await fetch(req);
          if (fresh && fresh.ok && fresh.type === 'basic') {
            cache.put(req, fresh.clone()).catch(() => null);
          }
          return fresh;
        } catch (_) {
          // Offline: serve the cached document/asset, falling back to index.html
          const cached = await cache.match(req) || (req.mode === 'navigate' ? await cache.match('./index.html') : null);
          return cached || new Response('Offline', { status: 503, statusText: 'Offline' });
        }
      })
    );
    return;
  }

  // ── Everything else → stale-while-revalidate ──
  e.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      const cached = await cache.match(req);
      const networkPromise = fetch(req).then(res => {
        // Only cache successful, basic responses
        if (res && res.ok && res.type === 'basic') {
          cache.put(req, res.clone()).catch(() => null);
        }
        return res;
      }).catch(() => null);

      // Return cache immediately if we have it; otherwise wait for network.
      return cached || networkPromise || new Response('Offline', { status: 503, statusText: 'Offline' });
    })
  );
});

// ─── Push: show notification ────────────────────────────────────
// Android requires raster icons here: `icon` is the full-color logo shown in
// the expanded card, `badge` the white-on-transparent silhouette drawn in the
// status bar (an SVG in either slot falls back to a generic grey circle).
// Payload extras (all optional, v3 fn passes them through): image (big
// picture, e.g. a chat photo), renotify (mentions re-alert even when the tag
// coalesces), data.tab (deep link opened on tap).
self.addEventListener('push', (e) => {
  let data = { title: 'TXOKO Formación', body: '', tag: 'txoko', image: null, renotify: false, data: {} };

  if (e.data) {
    try {
      const json = e.data.json();
      data.title = json.title || data.title;
      data.body = json.body || '';
      data.tag = json.tag || 'txoko';
      data.image = json.image || null;
      data.renotify = !!json.renotify;
      data.data = json.data || {};
    } catch (err) {
      data.body = e.data.text();
    }
  }

  // Deep link: explicit data.tab wins; otherwise infer from the tag so chat
  // taps land in La Terraza even through the v2 fn (title/body/tag only).
  if (!data.data.tab && data.tag === 'chat') data.data.tab = 'chat';

  // El aviso de actualización (tag 'app-update') es lo más discreto que iOS
  // permite en un push: sin vibración, sin sonido, sin re-alerta — un banner
  // callado. Los demás avisos (chat, menciones) mantienen su vibración.
  const _quiet = data.tag === 'app-update';
  const options = {
    body: data.body,
    icon: './icon-192.png',
    badge: './badge-96.png',
    tag: data.tag,
    renotify: _quiet ? false : data.renotify,
    silent: _quiet,
    vibrate: _quiet ? [] : (data.renotify ? [200, 100, 200, 100, 200] : [200, 100, 200]),
    requireInteraction: false,
    data: data.data,
    actions: [{ action: 'open', title: data.data.tab === 'chat' ? 'Abrir Terraza' : 'Abrir' }]
  };
  if (data.image) options.image = data.image;

  // ── Push de ACTUALIZACIÓN (tag 'app-update') ──
  // El push despierta este SW aunque la app esté cerrada: registration
  // .update() descarga el sw.js nuevo, cuyo install precachea el shell
  // fresco (no-cache). El usuario recibe la notificación y, al abrir, la
  // versión nueva ya está instalada — sin descargas ni esperas.
  const jobs = [self.registration.showNotification(data.title, options)];
  if (data.tag === 'app-update') jobs.push(self.registration.update().catch(() => null));
  e.waitUntil(Promise.all(jobs));
});

// ─── Notification click: focus existing window in scope, or open one ──
// Uses the SW scope (registration origin + path) instead of a hardcoded
// substring — works regardless of where the app is hosted. If the payload
// carried a deep link (data.tab), an open window is told to navigate there
// via postMessage; a fresh window gets it as a #tab= hash the app reads on
// boot after auto-login.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();

  const tab = (e.notification.data || {}).tab || null;
  const scopeUrl = new URL(self.registration.scope);
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        try {
          const u = new URL(client.url);
          // Same origin AND path is within (or equal to) our scope
          if (u.origin === scopeUrl.origin && u.pathname.startsWith(scopeUrl.pathname) && 'focus' in client) {
            if (tab) client.postMessage({ type: 'openTab', tab });
            return client.focus();
          }
        } catch (_) { /* ignore malformed URLs */ }
      }
      return self.clients.openWindow(scopeUrl.href + (tab ? '#tab=' + encodeURIComponent(tab) : ''));
    })
  );
});
