// TXOKO Formación — Service Worker for Push Notifications
// This file MUST be at the root of the site (same level as index.html)

self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(self.clients.claim());
});

self.addEventListener('push', (e) => {
  let data = { title: 'TXOKO Formación', body: '', icon: '/favicon.ico', tag: 'txoko' };

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

  e.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// When user taps the notification, open or focus the app
self.addEventListener('notificationclick', (e) => {
  e.notification.close();

  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      // If app is already open, focus it
      for (const client of clients) {
        if (client.url.includes('Txoko') && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open it
      return self.clients.openWindow('./');
    })
  );
});
