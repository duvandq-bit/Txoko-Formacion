// TXOKO Formación — Service Worker (v5.6)
// Lives at the site root (same level as index.html). Provides:
//   • App-shell cache with stale-while-revalidate for offline support
//   • Web Push notifications
//   • Notification click → focus existing window in scope, or open one

const VERSION = 'v5.7';
const CACHE_NAME = `txoko-shell-${VERSION}`;

// Files cached as the app shell. Keep this list short — large data should be
// fetched live and cached opportunistically by the runtime handler below.
const SHELL_URLS = [
  './',
  './index.html',
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

// ─── Fetch: stale-while-revalidate for same-origin GET ──────────
// Strategy:
//   1. Serve from cache immediately if available (fast, works offline).
//   2. In parallel, fetch from network; on success, update the cache.
//   3. If no cache and network fails, fall through to default browser error.
// Skips: non-GET, cross-origin, Supabase API/RPC calls (always live).
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // CDN, Supabase, fonts → bypass
  if (url.pathname.startsWith('/rest/') || url.pathname.startsWith('/functions/')) return;

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
