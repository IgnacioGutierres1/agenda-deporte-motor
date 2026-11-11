/**
 * Versiones nuevas de la app (PWA).
 *
 * La app queda guardada en el dispositivo para funcionar sin conexión; el navegador solo busca una
 * versión nueva al abrirla desde cero, y la versión nueva queda "esperando" hasta que se le pide
 * que se active (mensaje SKIP_WAITING del service worker generado por vite-plugin-pwa). Si ya
 * estaba descargada al abrir la app, nadie se lo pedía y la app seguía vieja para siempre.
 *
 * Acá: se busca una versión nueva al tocar "Actualizar", cada 30 minutos y al volver a la app;
 * si hay una esperando se activa, y cuando toma el control la página se recarga una sola vez.
 */

let registration: ServiceWorkerRegistration | undefined;
let swUrl = '';
let lastCheck = 0;
let reloading = false;

const CHECK_EVERY_MS = 30 * 60_000;
const MIN_GAP_MS = 60_000;

export type UpdateCheck = 'updating' | 'current' | 'offline' | 'unavailable';

/** Pide a la versión nueva (ya descargada) que tome el control. */
function activateWaiting(r: ServiceWorkerRegistration): boolean {
  if (!r.waiting) return false;
  r.waiting.postMessage({ type: 'SKIP_WAITING' });
  return true;
}

/** Busca una versión nueva publicada. 'updating' = se está instalando y la app se va a recargar. */
export async function checkForAppUpdate(force = false): Promise<UpdateCheck> {
  const r = registration;
  if (!r) return 'unavailable';
  if (activateWaiting(r) || r.installing) return 'updating';
  if (!navigator.onLine) return 'offline';
  if (!force && Date.now() - lastCheck < MIN_GAP_MS) return 'current';
  lastCheck = Date.now();
  try {
    // Si el servidor no responde, update() fallaría sin aviso: se prueba antes.
    const resp = await fetch(swUrl, { cache: 'no-store', headers: { 'cache-control': 'no-cache' } });
    if (resp.status !== 200) return 'current';
    await r.update();
  } catch {
    return 'offline';
  }
  return activateWaiting(r) || r.installing ? 'updating' : 'current';
}

/** Se llama al registrar el service worker (main.ts). */
export function watchForAppUpdates(url: string, r: ServiceWorkerRegistration | undefined): void {
  if (!r) return;
  registration = r;
  swUrl = url;

  // Una versión nueva terminó de descargarse: se activa (solo si ya había una versión controlando la app).
  r.addEventListener('updatefound', () => {
    const sw = r.installing;
    sw?.addEventListener('statechange', () => {
      if (sw.state === 'installed' && navigator.serviceWorker.controller) activateWaiting(r);
    });
  });
  // La versión nueva tomó el control: se recarga para usarla (una sola vez).
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });
  // Había una versión esperando desde antes de abrir la app.
  activateWaiting(r);

  window.setInterval(() => void checkForAppUpdate(), CHECK_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkForAppUpdate();
  });
}
