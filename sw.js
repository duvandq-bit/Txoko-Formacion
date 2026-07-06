// TXOKO Formación — Service Worker (v5.6)
// Lives at the site root (same level as index.html). Provides:
//   • App-shell cache with stale-while-revalidate for offline support
//   • Web Push notifications
//   • Notification click → focus existing window in scope, or open one

const VERSION = 'v7.90';
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
  './icon.svg'
];

// ─── Install: pre-cache the shell ───────────────────────────────
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_URLS).catch(() => null))
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
self.addEventListener('push', (e) => {
  let data = { title: 'TXOKO Formación', body: '', icon: 'icon.svg', tag: 'txoko' };

  if (e.data) {
    try {
      const json = e.data.json();
      data.title = json.title || data.title;
      data.body = json.body || '';
      data.tag = json.tag || 'txoko';
      data.data = json.data || {};
    } catch (err) {
      data.body = e.data.text();
    }
  }

  const options = {
    body: data.body,
    icon: data.icon,
    badge: data.icon,
    tag: data.tag,
    vibrate: [200, 100, 200],
    requireInteraction: false,
    data: data.data || {},
    actions: []
  };

  e.waitUntil(self.registration.showNotification(data.title, options));
});

// ─── Notification click: focus existing window in scope, or open one ──
// Uses the SW scope (registration origin + path) instead of a hardcoded
// substring — works regardless of where the app is hosted.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();

  const scopeUrl = new URL(self.registration.scope);
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        try {
          const u = new URL(client.url);
          // Same origin AND path is within (or equal to) our scope
          if (u.origin === scopeUrl.origin && u.pathname.startsWith(scopeUrl.pathname) && 'focus' in client) {
            return client.focus();
          }
        } catch (_) { /* ignore malformed URLs */ }
      }
      return self.clients.openWindow(scopeUrl.href);
    })
  );
});
