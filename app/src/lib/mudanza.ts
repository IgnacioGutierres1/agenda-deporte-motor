/**
 * Mudanza de dirección: de la anterior (github.io) al dominio propio (gridagenda.com).
 *
 * Lo guardado en el dispositivo (categorías, pilotos y equipos seguidos, tema, zona…) vive en localStorage, que es
 * por dirección: en el dominio nuevo la app arranca vacía. Para no perderlo:
 *  - en la dirección vieja, cuando el dominio nuevo ya responde, se muestra un aviso con un enlace que lleva lo
 *    guardado en el fragmento de la URL (`#/?mudanza=…`; el fragmento no viaja al servidor);
 *  - en el dominio nuevo, al abrir ese enlace, se guarda antes de arrancar la app.
 *
 * Nunca viajan el token de GitHub ni el estado de los avisos (la suscripción también es por dirección: hay que
 * volver a activarlos). Lógica pura, sin Vue ni Pinia.
 */
import type { FollowedDriver, ThemeChoice } from '../stores/settings.ts';

/** Dirección principal de la app ("https://gridagenda.com"); vacío = sin dominio propio. */
export const APP_ORIGIN = (import.meta.env.VITE_APP_ORIGIN ?? '').trim().replace(/\/+$/, '');

export const MOVE_PARAM = 'mudanza';

/** Lo que se lleva de una dirección a la otra. */
export interface MovePayload {
  timeZone?: string;
  hiddenSeries?: string[];
  followedSeries?: string[];
  followedDrivers?: FollowedDriver[];
  followedTeams?: FollowedDriver[];
  notifyLead?: number;
  theme?: ThemeChoice;
  themeChosen?: boolean;
  showWeather?: boolean;
  googleClientId?: string;
  githubRepo?: string;
}

const MAX_ITEMS = 2000;
const MAX_TEXT = 200;
/** Tope del enlace (caracteres): de sobra para miles de seguidos, y lejos de los límites de los navegadores. */
const MAX_ENCODED = 200_000;

const isText = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= MAX_TEXT;

function textList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return [...new Set(v.filter(isText))].slice(0, MAX_ITEMS);
}

function refList(v: unknown): FollowedDriver[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: FollowedDriver[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    const r = item as Partial<FollowedDriver> | null;
    if (!r || !isText(r.id) || !isText(r.name) || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ id: r.id, name: r.name, seriesIds: textList(r.seriesIds) ?? [] });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

/**
 * Deja solo los campos conocidos y con el tipo esperado. Lo demás se descarta: el enlace es texto que puede venir
 * de cualquier lado, y lo que no está en esta lista (el token de GitHub, los avisos) no se toca nunca.
 */
export function sanitizeMove(raw: unknown): MovePayload {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: MovePayload = {};
  if (isText(s.timeZone)) out.timeZone = s.timeZone;
  const hidden = textList(s.hiddenSeries);
  if (hidden) out.hiddenSeries = hidden;
  const series = textList(s.followedSeries);
  if (series) out.followedSeries = series;
  const drivers = refList(s.followedDrivers);
  if (drivers) out.followedDrivers = drivers;
  const teams = refList(s.followedTeams);
  if (teams) out.followedTeams = teams;
  if (typeof s.notifyLead === 'number' && Number.isFinite(s.notifyLead) && s.notifyLead >= 0 && s.notifyLead <= 24 * 60) out.notifyLead = s.notifyLead;
  if (s.theme === 'dark' || s.theme === 'light' || s.theme === 'system') out.theme = s.theme;
  if (typeof s.themeChosen === 'boolean') out.themeChosen = s.themeChosen;
  if (typeof s.showWeather === 'boolean') out.showWeather = s.showWeather;
  if (typeof s.googleClientId === 'string' && s.googleClientId.length <= MAX_TEXT) out.googleClientId = s.googleClientId;
  if (typeof s.githubRepo === 'string' && s.githubRepo.length <= MAX_TEXT) out.githubRepo = s.githubRepo;
  return out;
}

/** JSON → base64url (UTF-8), apto para el fragmento de una URL. */
export function encodeMove(payload: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(sanitizeMove(payload)));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Inversa de encodeMove; null si el texto no es una mudanza válida. */
export function decodeMove(encoded: string): MovePayload | null {
  if (!encoded || encoded.length > MAX_ENCODED || !/^[\w-]+$/.test(encoded)) return null;
  try {
    const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const raw: unknown = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0))));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return sanitizeMove(raw);
  } catch {
    return null;
  }
}

/** ¿Hay algo que valga la pena llevar? (sin nada seguido ni oculto, el dominio nuevo arranca igual de vacío). */
export function hasSomethingToMove(p: MovePayload): boolean {
  return !!(p.followedSeries?.length || p.followedDrivers?.length || p.followedTeams?.length || p.hiddenSeries?.length);
}

/** "https://gridagenda.com/#/?mudanza=…" */
export function moveLink(payload: unknown, appOrigin: string = APP_ORIGIN): string {
  return `${appOrigin}/#/?${MOVE_PARAM}=${encodeMove(payload)}`;
}

/** Enlace al dominio nuevo: con lo guardado si hay algo que llevar; si no, la portada. */
export function moveTarget(settings: unknown, appOrigin: string = APP_ORIGIN): string {
  const payload = sanitizeMove(settings);
  return hasSomethingToMove(payload) ? moveLink(payload, appOrigin) : `${appOrigin}/`;
}

/**
 * ¿La app está abierta en una dirección que no es la principal? (la anterior de GitHub Pages).
 * En desarrollo (localhost) nunca.
 */
export function isLegacyLocation(loc: { origin: string; hostname: string }, appOrigin: string = APP_ORIGIN): boolean {
  if (!appOrigin || loc.origin === appOrigin) return false;
  return !['localhost', '127.0.0.1', '[::1]'].includes(loc.hostname);
}

/** ¿El dominio nuevo ya sirve la app? (antes del cambio de dirección no responde: no se avisa nada). */
export async function newSiteIsLive(appOrigin: string = APP_ORIGIN, fetchFn: typeof fetch = fetch): Promise<boolean> {
  if (!appOrigin) return false;
  try {
    const res = await fetchFn(`${appOrigin}/manifest.webmanifest`, { cache: 'no-store' });
    if (!res.ok) return false;
    const manifest = (await res.json()) as { name?: unknown };
    return typeof manifest.name === 'string';
  } catch {
    return false;
  }
}

/** Saca la mudanza del fragmento: "#/?mudanza=abc&x=1" -> { encoded: "abc", rest: "#/?x=1" }. */
export function takeMoveFromHash(hash: string): { encoded: string; rest: string } | null {
  const q = hash.indexOf('?');
  if (q < 0) return null;
  const params = new URLSearchParams(hash.slice(q + 1));
  const encoded = params.get(MOVE_PARAM);
  if (encoded === null) return null;
  params.delete(MOVE_PARAM);
  const left = params.toString();
  return { encoded, rest: `${hash.slice(0, q)}${left ? `?${left}` : ''}` };
}

export type MoveResult = 'applied' | 'invalid' | 'declined';

/** Resultado de la mudanza de esta apertura (lo fija main.ts antes de montar la app; App.vue lo muestra). */
export const moveState: { result: MoveResult | null } = { result: null };

export interface MoveEnv {
  location: { hash: string; pathname: string; search: string };
  history: { replaceState(data: unknown, unused: string, url: string): void };
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  confirm: (message: string) => boolean;
}

/** Clave de localStorage de los ajustes (prefijo de lib/storage.ts + id del store). */
export const SETTINGS_STORAGE_KEY = 'dm:settings';

/**
 * Si la app se abrió con un enlace de mudanza, guarda lo que trae (encima de lo guardado acá) y limpia la URL.
 * Se llama antes de crear los stores (main.ts), así la app arranca ya con esos ajustes.
 * Si en este dispositivo ya había cosas seguidas, pregunta antes de reemplazarlas.
 * Devuelve null si la URL no traía una mudanza.
 */
export function applyMoveFromUrl(env: MoveEnv): MoveResult | null {
  const taken = takeMoveFromHash(env.location.hash);
  if (!taken) return null;
  // La mudanza se saca de la URL siempre: que no quede en el historial ni se reaplique al recargar.
  env.history.replaceState(null, '', `${env.location.pathname}${env.location.search}${taken.rest}`);
  const payload = decodeMove(taken.encoded);
  if (!payload || !hasSomethingToMove(payload)) return 'invalid';

  let saved: Record<string, unknown> = {};
  try {
    const raw = env.storage.getItem(SETTINGS_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed as Record<string, unknown>;
  } catch {
    /* lo guardado no se pudo leer: se pisa */
  }
  if (hasSomethingToMove(sanitizeMove(saved))) {
    const ok = env.confirm('Este enlace trae categorías y ajustes de la dirección anterior de la app. ¿Reemplazar los que ya tenés acá?');
    if (!ok) return 'declined';
  }
  try {
    // Los avisos se activan de nuevo en esta dirección (la suscripción del navegador es por dirección).
    env.storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ...saved, ...payload, notifyEnabled: false }));
  } catch {
    return 'invalid';
  }
  return 'applied';
}
