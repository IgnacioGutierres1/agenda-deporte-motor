/**
 * IMSA (imsa.com): lector determinista del sitio nuevo (Astro), que se lee sin bloqueos. Las páginas viejas
 * (/weathertech/schedule/, /weathertech/results) quedaron detrás de un desafío de Cloudflare (HTTP 403).
 *
 * - Calendario: /{año}/schedule, una tarjeta <article> por evento y campeonato, con nombre (<h3>), lugar
 *   ("Detroit Street Circuit, Detroit, MI"), fechas en aria-label ("June 4, 2027 through June 5, 2027") y el link
 *   al cronograma del campeonato (/events/2027-detroit-street-circuit?tab=schedule&series=weathertech).
 * - Cronograma: la pestaña "schedule" del evento, con un panel por campeonato (id="panel-weathertech") y cada
 *   sesión como <p>Practice 1</p><time datetime="2026-10-01T14:40:00Z">.
 */
import { decodeEntities, textOf } from '../extract/html.ts';
import { isoDate, monthNumber } from './places.ts';
import { host, isoNow, pageOrNull, stripComments, tzFor } from './kit.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, SiteRecipe } from './types.ts';

const ORIGIN = 'https://www.imsa.com';
const IMSA_TEST = /\broar\b|\btest\b/i;

/** Campeonato del sitio de IMSA a partir de la URL oficial (?series=…); por defecto, el WeatherTech. */
export function imsaSeriesKey(url: string): string {
  try {
    return new URL(url).searchParams.get('series') || 'weathertech';
  } catch {
    return 'weathertech';
  }
}

const scheduleUrl = (season: number, series: string) => `${ORIGIN}/${season}/schedule?series=${encodeURIComponent(series)}`;

/** "April 30, 2027 through May 2, 2027" (o una sola fecha) -> { start, end }. */
export function imsaDateRange(label: string): { start: string; end: string } | null {
  const dates = [...label.matchAll(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/g)]
    .map((m) => {
      const month = monthNumber(m[1]!);
      return month ? isoDate(Number(m[3]), month, Number(m[2])) : null;
    })
    .filter((d): d is string => !!d);
  if (dates.length === 0) return null;
  const start = dates[0]!;
  const end = dates[1] && dates[1] >= start ? dates[1] : start;
  return { start, end };
}

/** Eventos de un campeonato en la página /{año}/schedule (la página lista todos los campeonatos de IMSA). */
export function imsaCalendar(html: string, pageUrl: string, series: string, season: number): CalendarEntry[] {
  const out: CalendarEntry[] = [];
  const seen = new Set<string>();
  for (const m of stripComments(html).matchAll(/<article\b[\s\S]*?<\/article>/gi)) {
    const card = m[0];
    const link = card.match(new RegExp(`href="(/events/([^"?]+)\\?tab=schedule&(?:amp;)?series=${series}(?:&[^"]*)?)"`));
    if (!link) continue;
    const slug = link[2]!;
    const dates = imsaDateRange(decodeEntities(card.match(/aria-label="([^"]*\d{4}[^"]*)"/)?.[1] ?? ''));
    if (!dates || !dates.start.startsWith(String(season)) || seen.has(slug)) continue;
    seen.add(slug);
    const name = textOf(card.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1] ?? '');
    const place = textOf(card.match(/<hgroup\b[^>]*>[\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? '');
    const circuit = place.split(',')[0]?.trim() || name;
    const country = /,\s*(ON|Ontario|QC|Quebec|BC|British Columbia)$/i.test(place) || /canadian tire|mosport/i.test(place) ? 'Canada' : 'United States';
    out.push({
      name: name || circuit,
      circuit,
      country,
      tz: tzFor(country, `${place} ${name}`, country === 'Canada' ? 'America/Toronto' : 'America/New_York'),
      dateStart: dates.start,
      dateEnd: dates.end,
      url: new URL(link[1]!.replace(/&amp;/g, '&'), pageUrl).toString(),
      meta: { slug },
    });
  }
  out.sort((a, b) => a.dateStart.localeCompare(b.dateStart));
  // Ronda = orden en el calendario, sin contar los ensayos (Roar Before the Rolex 24).
  let round = 0;
  for (const e of out) if (!IMSA_TEST.test(e.name)) e.round = ++round;
  return out;
}

/** Sesiones del campeonato en la pestaña de cronograma del evento (panel id="panel-{series}"). */
export function imsaSessions(html: string, series: string): ExtractedSession[] {
  const page = stripComments(html);
  const start = page.indexOf(`id="panel-${series}"`);
  if (start < 0) return [];
  const next = page.indexOf('id="panel-', start + 10);
  const panel = page.slice(start, next < 0 ? undefined : next);
  const out: ExtractedSession[] = [];
  for (const m of panel.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>\s*<time\b[^>]*datetime="([^"]+)"/gi)) {
    const name = textOf(m[1] ?? '');
    const at = Date.parse(m[2]!);
    if (!name || !Number.isFinite(at)) continue;
    out.push({ name, startUtc: new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z') });
  }
  return out;
}

/** El sitio todavía publica el calendario de esta temporada (con eventos del campeonato). */
async function publishes(ctx: RecipeContext, season: number, series: string): Promise<boolean> {
  const html = await pageOrNull(ctx, scheduleUrl(season, series));
  return !!html && imsaCalendar(html, scheduleUrl(season, series), series, season).length > 0;
}

export const imsa: SiteRecipe = {
  name: 'imsa',
  match: (url) => host(url) === 'imsa.com',
  /**
   * Al terminar la temporada el sitio deja de publicar su calendario (/2026/schedule da 404 en noviembre de 2026)
   * y solo muestra el del año siguiente: entonces la temporada vigente es la siguiente.
   */
  async season(ctx) {
    const series = imsaSeriesKey(ctx.series.officialUrls[0] ?? '');
    if (await publishes(ctx, ctx.season, series)) return ctx.season;
    return (await publishes(ctx, ctx.season + 1, series)) ? ctx.season + 1 : ctx.season;
  },
  calendarUrl: (url, season) => scheduleUrl(season, imsaSeriesKey(url)),
  calendar: (doc, ctx) => imsaCalendar(doc.raw, doc.url, imsaSeriesKey(ctx.series.officialUrls[0] ?? doc.url), ctx.season),
  async sessions(entry, ctx) {
    if (!entry.url) return null;
    const html = await pageOrNull(ctx, entry.url);
    if (!html) return null;
    const sessions = imsaSessions(html, imsaSeriesKey(entry.url));
    if (sessions.length === 0) return null;
    return {
      sessions,
      source: { url: entry.url, title: `Schedule IMSA — ${entry.name}`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) },
    };
  },
  // La pestaña del evento es el único lugar donde IMSA publica el cronograma: si no está, todavía no salió.
  timetableFallback: 'none',
};
