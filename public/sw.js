/**
 * sw.js — 2026-05-27 PR D.f.
 *
 * Service worker for the Futurator Admin PWA. Two responsibilities:
 *
 *   1. push event → render a Notification with the payload from the
 *      push-sender.
 *   2. notificationclick event → open or focus a tab at the deep link.
 *
 * Lives in /public/sw.js so it's served from the origin root
 * (browsers reject service workers served from subpaths beyond their
 * scope). Registered by src/lib/push-subscribe.ts.
 *
 * Plain JS (not TS) because Next.js's static-export pipeline doesn't
 * transpile service-worker entry points. Keep this file simple — no
 * imports, no top-level await.
 */

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch (_err) {
    payload = { title: 'Futurator Admin', body: event.data.text() };
  }
  const title = payload.title || 'Futurator Admin';
  const options = {
    body: payload.body || '',
    tag: payload.tag,
    requireInteraction: Boolean(payload.requireInteraction),
    data: { url: payload.url, ...(payload.data || {}) },
    icon: '/icon-192.png',
    badge: '/badge-72.png',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients
      .matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        // Prefer focusing an existing tab on the same origin so we don't
        // open a fresh browser window each notification.
        for (const client of windowClients) {
          if ('focus' in client) {
            try {
              client.focus();
              if ('navigate' in client && url) {
                client.navigate(url);
              }
              return;
            } catch (_err) {
              // Fall through to clients.openWindow below.
            }
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(url);
        }
      }),
  );
});

// Skip waiting — we want new SW versions to activate immediately on the
// next page load so the operator gets push fixes without manually clearing.
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});
