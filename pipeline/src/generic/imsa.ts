/**
 * IMSA (imsa.com): lector determinista del sitio nuevo (Astro), que se lee sin bloqueos. Las páginas viejas
 * (/weathertech/schedule/, /weathertech/results) quedaron detrás de un desafío de Cloudflare (HTTP 403).
 *
 * - Calendario: /{año}/schedule, una tarjeta <article> por evento y campeonato, con nombre (<h3>), lugar
 *   ("Detroit Street Circuit, Detroit, MI"), fechas en aria-label ("June 4, 2027 through June 5, 2027") y el link
 *   al cronograma del campeonato (/events/2027-detroit-street-circuit?tab=schedule&series=weathertech).
 * - Cronograma: la pestaña "schedule" del evento, con un panel por campeonato (id="panel-weathertech") y cada
 *   sesión como <p>Practice 1</p><time datetime="2026-10-01T14:40:00Z">.
 * - Campeonato: la página /weathertech/standings carga sus tablas de /api/imsa-standings (JSON), una consulta
 *   por tipo (pilotos, equipos, marcas) con un grupo por clase (GTP, LMP2, GTD Pro, GTD).
 */
import type { StandingsRow, StandingsTable } from '@dm/shared';
import { HttpError } from '../core/http.ts';
import { decodeEntities, textOf } from '../extract/html.ts';
import { isoDate, monthNumber } from './places.ts';
import { checkStandingsTable, host, isoNow, obj, pageOrNull, standingsSource, str, stripComments, tzFor } from './kit.ts';
import { IMSA_RESULTS_SERIES, imsaPastSessions, imsaResults, imsaResultsApi, imsaResultsCalendar, imsaApiEvents, imsaApiJson } from './results-imsa.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, SiteRecipe, StandingsFound } from './types.ts';

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

// ─── Campeonato ───────────────────────────────────────────────────────────────────────────────

/** series_id de la API según la URL de posiciones del campeonato (/weathertech/standings). */
const IMSA_SERIES_IDS: Record<string, number> = { weathertech: 1 };

export type ImsaStandingsType = 'driver' | 'team' | 'manufacturer';

const IMSA_KIND: Record<ImsaStandingsType, string> = { driver: 'Pilotos', team: 'Equipos', manufacturer: 'Marcas' };

/** JSON que carga la página de posiciones: una consulta por tipo de tabla y temporada. */
export const imsaStandingsApi = (seriesId: number, type: ImsaStandingsType, season: number) =>
  `${ORIGIN}/api/imsa-standings?series_id=${seriesId}&type=${type}&season_id=${season}`;

/** Grupos (uno por clase) de una respuesta de la API; lanza un error si no tiene el formato esperado. */
function imsaGroups(body: unknown, type: ImsaStandingsType): Record<string, unknown>[] {
  const o = obj(body);
  if (o.type !== type || !Array.isArray(o.standings)) throw new Error(`IMSA: respuesta inesperada de /api/imsa-standings (${type})`);
  return o.standings.map(obj);
}

/** Campeonato de la respuesta (nombre y temporada), según su series_id. */
function imsaSeriesInfo(body: unknown, seriesId: number): Record<string, unknown> {
  const list = obj(body).series;
  return obj((Array.isArray(list) ? list : []).map(obj).find((s) => s.id === seriesId));
}

/**
 * Temporada de una respuesta con filas, o null si la temporada pedida todavía no tiene tabla (la API responde
 * igual, con `standings: []`). La temporada sale de las clases o del campeonato de la respuesta.
 */
export function imsaStandingsSeason(body: unknown, type: ImsaStandingsType, seriesId: number): number | null {
  const groups = imsaGroups(body, type);
  if (!groups.some((g) => Array.isArray(g.standings) && g.standings.length > 0)) return null;
  const o = obj(body);
  const fromClasses = Array.isArray(o.classes) ? Number(obj(o.classes[0]).season) : NaN;
  const fromSeries = Number(imsaSeriesInfo(body, seriesId).season);
  const season = [fromClasses, fromSeries, Number(o.default_season_id)].find((n) => Number.isInteger(n) && n > 1900);
  if (season === undefined) throw new Error('IMSA: la tabla del campeonato no dice de qué temporada es');
  return season;
}

const teamKey = (name: string) => name.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * Número del auto de un piloto. La API no lo da en la fila del piloto: se toma el número de su ficha
 * (driver_number) si coincide con un auto de su equipo en la clase (tabla de equipos); "4" vale por "04" si es
 * el único auto de ese número. La ficha no siempre está al día (Ricky Taylor figura con el #10 y corrió el #52
 * de Bryan Herta en LMP2): sin coincidencia, la fila va sin número.
 */
function driverNumber(profileNumber: string, team: string, cars: { team: string; number: string }[]): string | undefined {
  if (!profileNumber) return undefined;
  const own = cars.filter((c) => c.team === teamKey(team)).map((c) => c.number);
  if (own.includes(profileNumber)) return profileNumber;
  const same = own.filter((n) => /^\d+$/.test(n) && Number(n) === Number(profileNumber));
  return same.length === 1 ? same[0] : undefined;
}

/** Fila de la API -> fila de la tabla. */
function imsaRow(r: Record<string, unknown>, type: ImsaStandingsType, cars: { team: string; number: string }[]): StandingsRow {
  const team = obj(r.team);
  const base = { pos: Number(r.position), points: typeof r.points === 'number' ? r.points : NaN };
  if (type === 'manufacturer') return { ...base, name: str(obj(r.manufacturer).name).trim() };
  if (type === 'team') {
    const number = str(team.car_number).trim();
    return { ...base, name: str(team.name).trim(), ...(number ? { number } : {}) };
  }
  const driver = obj(r.driver);
  const profile = obj(driver.profile);
  const teamName = str(team.name).trim();
  const number = driverNumber(str(obj(profile.driver_number).number).trim(), teamName, cars);
  // Nacionalidad: la ficha del piloto la publica como "hometown" (la bandera que muestra el sitio).
  const hometown = obj(obj(obj(profile.bio).quick_facts).hometown);
  const country = str(obj(hometown.country_picker).code).trim() || str(hometown.country).trim();
  return {
    ...base,
    name: str(driver.name).replace(/\s+/g, ' ').trim(),
    ...(teamName ? { team: teamName } : {}),
    ...(number ? { number } : {}),
    ...(country ? { country } : {}),
  };
}

/**
 * Tablas del campeonato a partir de las respuestas de la API: primero las de pilotos (como en el resto de las
 * categorías), después equipos y marcas, cada tipo en el orden de clases del sitio ("Pilotos GTP", "Equipos
 * LMP2", "Marcas GTD Pro"…). Los pilotos van uno por fila, como los publica IMSA: los de un mismo auto comparten
 * posición (1, 2, 3, 3, 4…) cuando sumaron lo mismo. La tabla de equipos (por auto) da el número de cada piloto.
 */
export function imsaStandingsTables(bodies: Partial<Record<ImsaStandingsType, unknown>>): StandingsTable[] {
  const cars = new Map<string, { team: string; number: string }[]>();
  if (bodies.team !== undefined) {
    for (const g of imsaGroups(bodies.team, 'team')) {
      const list = (Array.isArray(g.standings) ? g.standings : []).map(obj).map((r) => ({
        team: teamKey(str(obj(r.team).name)),
        number: str(obj(r.team).car_number).trim(),
      }));
      cars.set(str(g.shortcode) || str(g.name), list);
    }
  }
  const tables: StandingsTable[] = [];
  for (const type of ['driver', 'team', 'manufacturer'] as const) {
    if (bodies[type] === undefined) continue;
    for (const g of imsaGroups(bodies[type], type)) {
      const cls = str(g.shortcode).trim() || str(g.name).trim();
      const rows = (Array.isArray(g.standings) ? g.standings : []).map(obj).map((r) => imsaRow(r, type, cars.get(cls) ?? []));
      if (rows.length === 0) continue;
      // Posiciones "densas" en los empates (1, 1, 2…): solo se exige que arranquen en 1 y no bajen.
      tables.push(checkStandingsTable({ title: cls ? `${IMSA_KIND[type]} ${cls}` : IMSA_KIND[type], rows }, true));
    }
  }
  return tables;
}

/**
 * Lector del campeonato. Terminada la temporada, el sitio pasa el calendario al año siguiente pero la tabla
 * sigue siendo la del año terminado (en noviembre de 2026 la API de 2027 responde vacía): si la temporada
 * pedida no tiene tabla, se publica la anterior con su año (results.ts la conserva hasta que se corra la
 * primera fecha de la nueva). null si ninguna de las dos está publicada.
 */
async function imsaStandings(url: string, ctx: RecipeContext): Promise<StandingsFound | null> {
  const slug = new URL(url).pathname.split('/').filter(Boolean)[0] ?? '';
  const seriesId = IMSA_SERIES_IDS[slug];
  if (!seriesId) throw new Error(`IMSA: campeonato desconocido en ${url}`);
  for (const season of [ctx.season, ctx.season - 1]) {
    const drivers = (await ctx.http.json<unknown>(imsaStandingsApi(seriesId, 'driver', season))).body;
    const shown = imsaStandingsSeason(drivers, 'driver', seriesId);
    if (shown === null) continue;
    if (shown !== season) throw new Error(`IMSA: se pidió la tabla ${season} y la API respondió la de ${shown}`);
    const team = (await ctx.http.json<unknown>(imsaStandingsApi(seriesId, 'team', season))).body;
    const manufacturer = (await ctx.http.json<unknown>(imsaStandingsApi(seriesId, 'manufacturer', season))).body;
    const tables = imsaStandingsTables({ driver: drivers, team, manufacturer });
    if (!tables.some((t) => t.title.startsWith('Pilotos'))) throw new Error('IMSA: la tabla del campeonato no trae pilotos');
    const name = str(imsaSeriesInfo(drivers, seriesId).name) || ctx.series.name;
    return {
      tables,
      source: { ...standingsSource(url, `${name} — Point Standings ${season}`, ctx), kind: 'api' },
      season,
    };
  }
  return null;
}

/**
 * Temporadas terminadas cuyo calendario se arma desde la API de resultados (el sitio ya no publica la página
 * /{año}/schedule). Lo decide season() y lo usa calendarUrl(), que no recibe el contexto. Clave "{campeonato}:{año}".
 */
const fromResults = new Set<string>();

/** La API de resultados tiene eventos de esta temporada (temporada terminada pero publicada). */
async function hasResults(ctx: RecipeContext, season: number, series: string): Promise<boolean> {
  const seriesId = IMSA_RESULTS_SERIES[series];
  if (!seriesId) return false;
  try {
    return imsaApiEvents(await imsaApiJson(ctx, imsaResultsApi(seriesId, season))).length > 0;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return false;
    throw err;
  }
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
   * y solo muestra el del año siguiente. Mientras la API de resultados tenga la temporada del año en curso, esa
   * sigue siendo la vigente (su calendario sale de los resultados y la del año siguiente entra como "temporada
   * siguiente", ver core/season.ts); si no, la vigente es la siguiente.
   */
  async season(ctx) {
    const series = imsaSeriesKey(ctx.series.officialUrls[0] ?? '');
    // Un error suelto en la página del año (el sitio a veces responde 403 tras muchos pedidos seguidos) no decide
    // nada: se prueba igual el año siguiente, y si tampoco responde se queda la temporada del calendario.
    fromResults.delete(`${series}:${ctx.season}`);
    const current = await publishes(ctx, ctx.season, series).catch(() => null);
    if (current) return ctx.season;
    // Sin calendario del año: si la API de resultados tiene la temporada, sigue siendo la vigente. Si la API no
    // responde (403 pasajero) también se queda: leer el calendario falla y la serie conserva los datos anteriores,
    // en vez de pasar a la temporada siguiente en una corrida y volver en la otra.
    // También si la página del año dio error (null): el sitio pone sus páginas detrás de un desafío de Cloudflare
    // (403) para algunos clientes, pero la API de resultados responde.
    if (!current && (await hasResults(ctx, ctx.season, series).catch(() => current === false))) {
      fromResults.add(`${series}:${ctx.season}`);
      return ctx.season;
    }
    const next = await publishes(ctx, ctx.season + 1, series).catch(() => false);
    return next ? ctx.season + 1 : ctx.season;
  },
  calendarUrl: (url, season) => {
    const series = imsaSeriesKey(url);
    const seriesId = IMSA_RESULTS_SERIES[series];
    return fromResults.has(`${series}:${season}`) && seriesId ? imsaResultsApi(seriesId, season) : scheduleUrl(season, series);
  },
  calendar(doc, ctx) {
    const series = imsaSeriesKey(ctx.series.officialUrls[0] ?? doc.url);
    const seriesId = IMSA_RESULTS_SERIES[series];
    // Temporada terminada: calendario desde la API de resultados.
    if (doc.kind === 'api' && seriesId) return imsaResultsCalendar(JSON.parse(doc.raw), seriesId, ctx.season, ctx);
    return imsaCalendar(doc.raw, doc.url, series, ctx.season);
  },
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
  standings: imsaStandings,
  /** Resultados y sesiones de fechas ya corridas: API de resultados del sitio (results-imsa.ts). */
  results: (entry, sessions, ctx) => imsaResults(imsaSeriesKey(ctx.series.officialUrls[0] ?? ''), entry, sessions, ctx),
  pastSessions: (entry, ctx) => imsaPastSessions(imsaSeriesKey(ctx.series.officialUrls[0] ?? ''), entry, ctx),
};
