/**
 * Sitio oficial del promotor del WRC (https://www.wrc.com).
 *
 * Se lee SOLO de forma directa (sin el proxy de respaldo de core/http.ts): wrc.com rechaza a algunos clientes
 * automáticos (HTTP 403 de Akamai, según la red; p. ej. desde GitHub Actions). Si no responde, el lector sigue con la
 * FIA y Wikipedia sin error.
 *
 * - Calendario: https://www.wrc.com/en/calendar. Su configuración (`/v3/config/pages?url=/en/calendar`) o, a veces, el
 *   HTML (`rb3-prerender-data-cache`) da el id de la temporada vigente; con él se pide el feed completo (también los
 *   rallies ya corridos) a la API pública del sitio (`/v3/api/…`). robots.txt permite las dos rutas.
 * - Itinerario: pestañas de cada rally (`…?rb3Schema=v1:pageTabs`) y contenido de la pestaña "Itinerary"
 *   (`…/v3/content/{id}?rb3Schema=v1:inlineContent`): una lista por día con renglones "15:35: SS 1 Col de Bleine /
 *   Aiglun (25.47 km)" en hora local de la sede.
 */
import type { Http } from '../core/http.ts';
import { isoDate, monthNumber } from '../generic/places.ts';
import type { ItineraryKind, ItineraryStage } from './wrc-wikipedia.ts';

export const WRC_SITE = 'https://www.wrc.com';
export const WRC_CALENDAR_URL = `${WRC_SITE}/en/calendar`;
/** Configuración de la página del calendario (paneles y feeds que usa); robots.txt la permite. */
export const WRC_CALENDAR_CONFIG_URL = `${WRC_SITE}/v3/config/pages?url=%2Fen%2Fcalendar`;
const API = `${WRC_SITE}/v3/api/graphql/v1/v3`;
/** wrc.com se lee solo de forma directa. */
const DIRECT = { noProxy: true } as const;

export interface WrcSiteEvent {
  /** Identificador en las URL del sitio ("wrc-rallye-monte-carlo-2027"). */
  slug: string;
  /** Título publicado ("WRC Rallye Monte-Carlo 2027"). */
  title: string;
  round?: number;
  /** Fechas locales de la sede. */
  dateStart: string;
  dateEnd: string;
  /** ISO 3166 alfa-2 ("MC", "GB"). */
  iso2: string;
  /** "confirmed", "cancelled"… */
  status: string;
  url: string;
}

interface Card {
  content?: { title?: string; standfirst?: string };
  event?: { startDate?: string; endDate?: string };
  status?: string;
  location?: { countryCode?: string };
  reference?: { uriSlug?: string };
}

export function wrcSeasonFeedUrl(seasonRrn: string): string {
  return `${API}/feed/en-INT?filter[type]=event-profiles&filter[relationships.season]=${seasonRrn}&page[limit]=30&rb3Locale=en&rb3Schema=v1:cardList`;
}

export function wrcTabsUrl(slug: string): string {
  return `${API}/query/en-INT?filter[type]=event-profiles&filter[uriSlug]=${slug}&rb3PageTabsBaseUrl=/en/events/${slug}/&rb3Locale=en&rb3Schema=v1:pageTabs`;
}

export function wrcContentUrl(id: string): string {
  return `${API}/content/${id}?rb3Locale=en&rb3Schema=v1:inlineContent`;
}

/** Tarjetas -> rallies (fecha local = la parte de fecha del ISO con offset de la sede). */
export function parseWrcCards(cards: Card[]): WrcSiteEvent[] {
  const out: WrcSiteEvent[] = [];
  for (const c of cards) {
    const slug = c.reference?.uriSlug;
    const start = c.event?.startDate?.slice(0, 10);
    const end = c.event?.endDate?.slice(0, 10) ?? start;
    const title = (c.content?.title ?? '').replace(/\s+/g, ' ').trim();
    if (!slug || !start || !end || !title || !/^\d{4}-\d{2}-\d{2}$/.test(start)) continue;
    const round = Number(c.content?.standfirst?.match(/\bround\s+(\d+)/i)?.[1]);
    out.push({
      slug,
      title,
      ...(Number.isInteger(round) && round > 0 ? { round } : {}),
      dateStart: start,
      dateEnd: end < start ? start : end,
      iso2: (c.location?.countryCode ?? '').toUpperCase(),
      status: (c.status ?? '').toLowerCase(),
      url: `${WRC_SITE}/en/events/${slug}`,
    });
  }
  return out.sort((a, b) => a.dateStart.localeCompare(b.dateStart));
}

/** Datos embebidos en la página del calendario: id de la temporada vigente y sus próximos rallies. */
export function parseWrcCalendarPage(html: string): { seasonRrn?: string; events: WrcSiteEvent[] } {
  const m = html.match(/<script[^>]*id="rb3-prerender-data-cache"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return { events: [] };
  let cache: Record<string, { data?: { data?: Card[] } }>;
  try {
    cache = JSON.parse(m[1]!) as typeof cache;
  } catch {
    return { events: [] };
  }
  const key = Object.keys(cache).find((k) => /filter\[type\]=event-profiles/.test(k) && /relationships\.season/.test(k));
  if (!key) return { events: [] };
  const seasonRrn = key.match(/rrn:content:event-seasons:[0-9a-f-]+:[A-Za-z-]+/)?.[0];
  return { ...(seasonRrn ? { seasonRrn } : {}), events: parseWrcCards(cache[key]?.data?.data ?? []) };
}

/** Id de la temporada que muestra el calendario, según la configuración de la página (JSON). */
export function seasonFromConfig(config: unknown): string | undefined {
  return JSON.stringify(config ?? null).match(/rrn:content:event-seasons:[0-9a-f-]+:[A-Za-z-]+/)?.[0];
}

/**
 * Rallies de la temporada vigente según wrc.com. El id de la temporada sale de la configuración de la página del
 * calendario (`/v3/config/pages?url=/en/calendar`); si no está, de los datos embebidos en el HTML (que el sitio no
 * siempre incluye). Con el id se pide el feed completo; si falla, quedan los rallies embebidos en la página.
 */
export async function fetchWrcCalendar(http: Http): Promise<WrcSiteEvent[]> {
  let seasonRrn: string | undefined;
  let embedded: WrcSiteEvent[] = [];
  try {
    seasonRrn = seasonFromConfig((await http.json<unknown>(WRC_CALENDAR_CONFIG_URL, DIRECT)).body);
  } catch {
    // sin configuración: se prueba con la página
  }
  if (!seasonRrn) {
    const page = parseWrcCalendarPage((await http.text(WRC_CALENDAR_URL, DIRECT)).body);
    seasonRrn = page.seasonRrn;
    embedded = page.events;
  }
  if (!seasonRrn) return embedded;
  try {
    const { body } = await http.json<{ data?: Card[] }>(wrcSeasonFeedUrl(seasonRrn), DIRECT);
    const all = parseWrcCards(body.data ?? []);
    return all.length >= embedded.length ? all : embedded;
  } catch (err) {
    if (embedded.length === 0) throw err;
    return embedded;
  }
}

// ─── Itinerario ───────────────────────────────────────────────────────────────────────────────

export interface WrcItineraryRef {
  id: string;
  /** Página pública de la pestaña ("https://www.wrc.com/en/events/…/itinerary-…"). */
  url: string;
}

/** Pestaña "Itinerary" del rally, si ya está publicada. */
export async function fetchWrcItineraryRef(http: Http, slug: string): Promise<WrcItineraryRef | null> {
  const { body } = await http.json<{ data?: { tabs?: Array<{ id?: string; label?: string; url?: string }> } }>(wrcTabsUrl(slug), DIRECT);
  const tab = body.data?.tabs?.find((t) => /itinerar/i.test(t.label ?? ''));
  return tab?.id && tab.url ? { id: tab.id, url: `${WRC_SITE}${tab.url}` } : null;
}

/** Textos del contenido en orden de aparición (los renglones de las listas y los títulos de cada día). */
function texts(node: unknown, out: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const n of node) texts(n, out);
  } else if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o.type === 'image' || o.type === 'partOfThisStory') return out;
    if (Array.isArray(o.elements) && o.elements.every((e) => e && typeof e === 'object' && 'text' in (e as object))) {
      out.push((o.elements as Array<{ text?: string }>).map((e) => e.text ?? '').join('').trim());
      return out;
    }
    if (typeof o.text === 'string') out.push(o.text.trim());
    for (const [k, v] of Object.entries(o)) if (k !== 'text') texts(v, out);
  }
  return out;
}

const DAY_HEADING = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-zÀ-ÿ]+)\s+(\d{4})/;
const STAGE_LINE =
  /^(\d{1,2})[:.h](\d{2})\s*[:\-–]?\s*(?:(?:SSS?|Stage)\s*(\d+)|(shakedown))\b\s*[-–:]?\s*(.*?)\s*(?:\(\s*(\d+(?:[.,]\d+)?)\s*km\s*\))?\s*$/i;
/** Tramos de hasta esta distancia se consideran superespeciales (ver wrc-wikipedia.ts). */
const SUPER_SPECIAL_MAX_KM = 4;

/** "GAP" -> "Gap"; nombres con minúsculas quedan como están. */
function tidyName(name: string): string {
  if (name !== name.toUpperCase() || !/\p{Lu}{2}/u.test(name)) return name;
  return name.toLocaleLowerCase('fr').replace(/(^|[\s/'’(-])(\p{L})/gu, (_m, sep: string, c: string) => sep + c.toLocaleUpperCase('fr'));
}

/** Itinerario de la pestaña "Itinerary" de wrc.com (tramos con hora local; asistencias y ceremonias se descartan). */
export function parseWrcItinerary(content: unknown): ItineraryStage[] {
  const stages: ItineraryStage[] = [];
  let date: string | null = null;
  for (const line of texts(content)) {
    const heading = line.match(DAY_HEADING);
    const stage = line.match(STAGE_LINE);
    if (!stage) {
      const month = heading ? monthNumber(heading[2]!) : null;
      if (heading && month) date = isoDate(Number(heading[3]), month, Number(heading[1]));
      continue;
    }
    if (!date) continue;
    const [, hh, mm, number, shakedown, rawName = '', rawKm] = stage;
    const power = /power\s*stage/i.test(rawName);
    const name = tidyName(
      rawName
        .replace(/\s*[-–]?\s*(?:\p{L}+\s+)?power\s*stage\s*$/iu, '')
        .replace(/^[-–:\s]+/, '')
        .trim(),
    );
    const km = rawKm ? Number(rawKm.replace(',', '.')) : undefined;
    const kind: ItineraryKind = shakedown
      ? 'shakedown'
      : power
        ? 'power'
        : /\bSSS\b|super\s*special/i.test(line) || (km !== undefined && km <= SUPER_SPECIAL_MAX_KM)
          ? 'superespecial'
          : 'especial';
    if (Number(hh) > 23 || Number(mm) > 59) continue;
    stages.push({
      code: number ? `SS${Number(number)}` : 'Shakedown',
      ...(number ? { number: Number(number) } : {}),
      name: name || (shakedown ? 'Shakedown' : `SS${Number(number)}`),
      kind,
      date,
      time: `${hh!.padStart(2, '0')}:${mm}`,
      ...(km !== undefined && Number.isFinite(km) ? { km } : {}),
    });
  }
  return stages;
}

/** Itinerario publicado del rally, o null si todavía no hay pestaña "Itinerary". */
export async function fetchWrcItinerary(http: Http, slug: string): Promise<{ stages: ItineraryStage[]; url: string } | null> {
  const ref = await fetchWrcItineraryRef(http, slug);
  if (!ref) return null;
  const { body } = await http.json<unknown>(wrcContentUrl(ref.id), DIRECT);
  const stages = parseWrcItinerary(body);
  return stages.length > 0 ? { stages, url: ref.url } : null;
}
