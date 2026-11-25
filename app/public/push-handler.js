/* Avisos push de Grid Agenda (lo importa el service worker generado por vite-plugin-pwa). */

/**
 * Dirección que abre el aviso. `path` ("#/evento/…") es relativo a esta instalación: así el mismo aviso abre la
 * app en gridagenda.com o en la dirección anterior, según dónde esté instalada. `url` es de avisos viejos.
 */
function targetUrl(data) {
  const scope = self.registration.scope;
  if (typeof data.path === 'string' && data.path) {
    try {
      return new URL(data.path, scope).href;
    } catch {
      /* sigue con url */
    }
  }
  return data.url || scope;
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'Grid Agenda', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Grid Agenda';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      icon: 'icons/icon-192.png',
      badge: 'icons/icon-192.png',
      tag: data.tag || undefined,
      data: { url: targetUrl(data) },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.startsWith(self.registration.scope) && 'focus' in client) {
          return client.navigate(url).then((c) => (c || client).focus());
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
