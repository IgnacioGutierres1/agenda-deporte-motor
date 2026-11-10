/**
 * Avisos push: suscripción del dispositivo en el Worker de Cloudflare.
 * El Worker guarda la suscripción con las categorías y la anticipación, y manda los avisos.
 */

export const WORKER_URL = (import.meta.env.VITE_WORKER_URL ?? '').replace(/\/+$/, '');

export type PushSupport = 'ok' | 'no-worker' | 'unsupported' | 'ios-install' | 'denied';

/** iPhone/iPad: los avisos web solo funcionan con la app instalada en la pantalla de inicio (iOS 16.4+). */
export function isIosBrowser(): boolean {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (ua.includes('Macintosh') && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return ios && !standalone;
}

export function pushSupport(): PushSupport {
  if (!WORKER_URL) return 'no-worker';
  if (isIosBrowser()) return 'ios-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

function base64UrlToBytes(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${WORKER_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Error ${res.status} del servidor de avisos`);
  return data;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const reg = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('La app todavía no terminó de instalarse; probá de nuevo en unos segundos.')), 10_000)),
  ]);
  return reg;
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport() !== 'ok') return null;
  return (await registration()).pushManager.getSubscription();
}

export interface PushPrefs {
  seriesIds: string[];
  leadMinutes: number;
  timeZone: string;
}

/** Pide permiso, suscribe el dispositivo y lo registra en el Worker. */
export async function enablePush(prefs: PushPrefs): Promise<void> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('No se dio permiso para mostrar avisos.');
  const reg = await registration();
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    const { publicKey } = await api<{ publicKey: string }>('/api/vapid');
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToBytes(publicKey) });
  }
  await syncPush(prefs, sub);
}

/** Actualiza en el Worker las categorías y la anticipación de este dispositivo. */
export async function syncPush(prefs: PushPrefs, sub?: PushSubscription | null): Promise<void> {
  const s = sub ?? (await currentSubscription());
  if (!s) return;
  await api('/api/subscribe', { subscription: s.toJSON(), ...prefs });
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await api('/api/unsubscribe', { endpoint: sub.endpoint }).catch(() => undefined);
  await sub.unsubscribe();
}

export async function testPush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) throw new Error('Este dispositivo no tiene los avisos activados.');
  const r = await api<{ ok: boolean; status: number }>('/api/test', { endpoint: sub.endpoint });
  if (!r.ok) throw new Error(`El servicio de avisos respondió ${r.status}.`);
}
