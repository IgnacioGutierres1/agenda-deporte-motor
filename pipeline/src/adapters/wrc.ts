/**
 * Lector del Campeonato Mundial de Rally (WRC).
 *
 * Fuentes, en orden de prioridad (cada dato lleva la suya en `source`):
 * - FIA (wrc-fia.ts): calendario de la temporada (fechas, nombre oficial, país, rallies cancelados), clasificación
 *   general de cada rally y campeonato de pilotos, copilotos y constructores. Oficial y legible sin IA.
 * - wrc.com (wrc-site.ts, sitio del promotor): calendario de la temporada vigente mientras la FIA no abre la suya, e
 *   itinerario oficial de cada rally en cuanto lo publica. Se lee solo de forma directa: si rechaza al cliente
 *   (HTTP 403 de Akamai, p. ej. desde GitHub Actions), se sigue con las otras fuentes sin error.
 * - Wikipedia (wrc-wikipedia.ts): ciudad base y superficie de cada rally (ninguna fuente oficial las publica de forma
 *   legible), itinerario de los rallies que wrc.com no tiene (los ya corridos) y el calendario si las oficiales no lo
 *   publican. Rotulado "Wikipedia: <artículo>".
 *
 * Agenda: un rally tiene muchos tramos, así que no hay una sesión por tramo sino bloques: el Shakedown
 * ("practica"), un bloque "etapa" por día ("Etapa del viernes: SS2 a SS8", desde la largada del primer tramo
 * hasta el fin estimado del último) y la Power Stage aparte ("carrera"). El detalle de cada tramo va en
 * data/stages/wrc/{evento}.json (ScheduleChunk.stages), con la sesión a la que pertenece.
 *
 * Fin estimado: la fuente solo da la hora de largada del primer auto de cada tramo. El bloque del día termina
 * `durations.wrc.etapa` minutos después de la largada de su último tramo; Shakedown y Power Stage duran lo que
 * indique config/durations.json ("practica" y "carrera").
 *
 * Resultados: la clasificación general acumulada de la FIA después del último tramo de cada bloque. El resultado de la
 * sesión final (Power Stage, tipo "carrera") es la CLASIFICACIÓN FINAL DEL RALLY, no la del tramo: así lo rotula su
 * fuente.
 */
import { DateTime } from 'luxon';
import {
  addMinutes,
  localToUtc,
  type EventResultsFile,
  type EventStagesFile,
  type MotorEvent,
  type RallyStage,
  type Series,
  type Session,
  type Source,
  type Surface,
} from '@dm/shared';
import { HttpError } from '../core/http.ts';
import { createLogger } from '../core/log.ts';
import type { Adapter, AdapterContext, ResultsChunk, ResultsRequest, ScheduleChunk } from '../core/types.ts';
import { guessTimeZone } from '../generic/places.ts';
import { mapLimit } from './fom.ts';
import { countryName, directSource, fetchedAt } from './util.ts';
import { fetchWrcCalendar, fetchWrcItinerary, WRC_CALENDAR_URL, type WrcSiteEvent } from './wrc-site.ts';
import {
  crewRows,
  fiaWrcCalendarUrl,
  fiaWrcStandingsUrl,
  parseFiaCalendar,
  parseFiaClassifications,
  parseFiaEntryList,
  parseFiaStandings,
  type FiaEntry,
  type FiaRally,
} from './wrc-fia.ts';
import {
  fetchWikiPages,
  parseRallyArticle,
  parseSeasonCalendar,
  type ItineraryStage,
  type WikiCalendarRow,
  type WikiPage,
} from './wrc-wikipedia.ts';

/** Rallies (páginas de clasificaciones de la FIA, ~600 KB cada una) que se leen por corrida. */
const MAX_RESULT_EVENTS = 4;

export interface WrcOptions {
  /** Tope de rallies cuyas clasificaciones se leen por corrida (inyectable en las pruebas). */
  maxResultEvents?: number;
}

/** La clasificación de un bloque se lee recién este tiempo después de su fin estimado (que hayan pasado todos los autos). */
const SETTLE_MS = 2 * 3600_000;
/** Si pasado este tiempo el último tramo de un bloque sigue sin clasificación, se da por cancelado. */
const CANCELLED_AFTER_MS = 12 * 3600_000;

export function wrcSeasonArticle(season: number): string {
  return `${season} World Rally Championship`;
}

// ─── Países anfitriones ───────────────────────────────────────────────────────────────────────

interface Host {
  iso2: string;
  /** Códigos de bandera que usa Wikipedia ({{flagicon|MON}}): COI o ISO 3166 alfa-3. */
  flags: string[];
  /** Nombres en inglés con que la tabla de Wikipedia nombra el país de la sede. */
  names: string[];
  tz: string;
}

/** Países del calendario del WRC (actuales y recientes). La zona es la de la sede habitual del rally. */
const HOSTS: Host[] = [
  { iso2: 'MC', flags: ['MON', 'MCO'], names: ['Monaco'], tz: 'Europe/Monaco' },
  { iso2: 'FR', flags: ['FRA'], names: ['France'], tz: 'Europe/Paris' },
  { iso2: 'SE', flags: ['SWE'], names: ['Sweden'], tz: 'Europe/Stockholm' },
  { iso2: 'KE', flags: ['KEN'], names: ['Kenya'], tz: 'Africa/Nairobi' },
  { iso2: 'HR', flags: ['CRO', 'HRV'], names: ['Croatia'], tz: 'Europe/Zagreb' },
  { iso2: 'ES', flags: ['ESP'], names: ['Spain'], tz: 'Europe/Madrid' },
  { iso2: 'PT', flags: ['POR', 'PRT'], names: ['Portugal'], tz: 'Europe/Lisbon' },
  { iso2: 'JP', flags: ['JPN'], names: ['Japan'], tz: 'Asia/Tokyo' },
  { iso2: 'GR', flags: ['GRC', 'GRE'], names: ['Greece'], tz: 'Europe/Athens' },
  { iso2: 'IT', flags: ['ITA'], names: ['Italy'], tz: 'Europe/Rome' },
  { iso2: 'EE', flags: ['EST'], names: ['Estonia'], tz: 'Europe/Tallinn' },
  { iso2: 'LV', flags: ['LAT', 'LVA'], names: ['Latvia'], tz: 'Europe/Riga' },
  { iso2: 'PL', flags: ['POL'], names: ['Poland'], tz: 'Europe/Warsaw' },
  { iso2: 'FI', flags: ['FIN'], names: ['Finland'], tz: 'Europe/Helsinki' },
  { iso2: 'BE', flags: ['BEL'], names: ['Belgium'], tz: 'Europe/Brussels' },
  { iso2: 'DE', flags: ['GER', 'DEU'], names: ['Germany'], tz: 'Europe/Berlin' },
  { iso2: 'GB', flags: ['GBR', 'UK'], names: ['Great Britain', 'United Kingdom'], tz: 'Europe/London' },
  { iso2: 'IE', flags: ['IRL'], names: ['Ireland'], tz: 'Europe/Dublin' },
  { iso2: 'TR', flags: ['TUR'], names: ['Turkey', 'Türkiye'], tz: 'Europe/Istanbul' },
  { iso2: 'SA', flags: ['SAU', 'KSA'], names: ['Saudi Arabia'], tz: 'Asia/Riyadh' },
  { iso2: 'US', flags: ['USA'], names: ['United States'], tz: 'America/New_York' },
  { iso2: 'MX', flags: ['MEX'], names: ['Mexico'], tz: 'America/Mexico_City' },
  { iso2: 'PY', flags: ['PAR', 'PRY'], names: ['Paraguay'], tz: 'America/Asuncion' },
  { iso2: 'CL', flags: ['CHL', 'CHI'], names: ['Chile'], tz: 'America/Santiago' },
  { iso2: 'AR', flags: ['ARG'], names: ['Argentina'], tz: 'America/Argentina/Cordoba' },
  { iso2: 'NZ', flags: ['NZL'], names: ['New Zealand'], tz: 'Pacific/Auckland' },
  { iso2: 'AU', flags: ['AUS'], names: ['Australia'], tz: 'Australia/Sydney' },
];

/** Sedes cuyo huso no es el habitual del país. */
const PLACE_ZONES: Array<[RegExp, string]> = [[/canari|las palmas|tenerife/i, 'Atlantic/Canary']];

const hostByIso = (iso2: string) => HOSTS.find((h) => h.iso2 === iso2.toUpperCase());
const hostByFlag = (flag: string) => HOSTS.find((h) => h.flags.includes(flag.toUpperCase()) || h.iso2 === flag.toUpperCase());
const hostByName = (name: string) => HOSTS.find((h) => h.names.some((n) => n.toLowerCase() === name.trim().toLowerCase()));

// ─── Superficie ───────────────────────────────────────────────────────────────────────────────

/**
 * Superficie del rally a partir del rótulo de Wikipedia ("Gravel", "Tarmac", "Snow", "Mixed") y, si es mixta, del
 * detalle (nota al pie o ficha: "run on a tarmac and snow surface"). Montecarlo (asfalto con nieve) queda como
 * asfalto con la aclaración; "mixto" se reserva para asfalto y tierra.
 */
export function surfaceOf(label: string, detail = ''): { surface?: Surface; note?: string } {
  const kinds = (t: string) => ({ tarmac: /tarmac|asphalt/i.test(t), gravel: /gravel|dirt/i.test(t), snow: /snow|\bice\b/i.test(t) });
  const count = (k: ReturnType<typeof kinds>) => Number(k.tarmac) + Number(k.gravel) + Number(k.snow);
  const mixed = /mixed/i.test(label);
  let k = kinds(label);
  if (mixed || count(k) === 0) {
    const d = kinds(`${label} ${detail}`);
    if (count(d) === 0) return mixed ? { surface: 'mixto' } : /sand|desert/i.test(`${label} ${detail}`) ? { surface: 'arena' } : {};
    k = d;
  }
  if (k.tarmac && k.gravel) return { surface: 'mixto' };
  if (k.tarmac && k.snow) return { surface: 'asfalto', note: 'Asfalto y nieve' };
  if (k.gravel && k.snow) return { surface: 'tierra', note: 'Tierra y nieve' };
  if (k.snow) return { surface: 'nieve' };
  if (k.tarmac) return { surface: 'asfalto' };
  return k.gravel ? { surface: 'tierra' } : {};
}

// ─── Calendario ───────────────────────────────────────────────────────────────────────────────

interface Rally {
  /** Clave del evento dentro de la temporada: el país anfitrión (no cambia si cambia la fuente del calendario). */
  key: string;
  round: number;
  name: string;
  iso2: string;
  dateStart: string;
  dateEnd: string;
  fia?: FiaRally;
  site?: WrcSiteEvent;
  wiki?: WikiCalendarRow;
}

/** Rally cancelado según la fuente del calendario (no se publica). */
interface CancelledRally {
  name: string;
  dateStart: string;
  dateEnd: string;
}

interface SeasonCalendar {
  rallies: Rally[];
  cancelled: CancelledRally[];
  /** Fuente de fechas, nombre y país. */
  source: Source;
  /** Artículo de Wikipedia del que salen la sede y la superficie (si se pudo leer su tabla). */
  wikiTitle?: string;
}

const dayDiff = (a: string, b: string) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000;

/** "WRC Croatia Rally 2026" -> "Croatia Rally" (la FIA y wrc.com agregan la sigla y el año a algunos nombres). */
export function cleanRallyName(name: string, season: number): string {
  return name
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^WRC\s+/i, '')
    .replace(new RegExp(`\\s+${season}$`), '')
    .trim();
}

/**
 * Empareja cada rally con una fila de otra fuente: mismo país y fechas cercanas (las fuentes difieren en uno o dos
 * días: Canarias 2026 figura del 22 al 26 de abril en la FIA y del 23 al 26 en Wikipedia) o, sin país, mismas fechas.
 */
function matcher<T extends { dateStart: string }>(rows: T[], iso2Of: (row: T) => string): (iso2: string, dateStart: string) => T | undefined {
  const used = new Set<T>();
  return (iso2, dateStart) => {
    const free = rows.filter((r) => !used.has(r));
    const hit =
      free.find((r) => iso2 && iso2Of(r) === iso2 && dayDiff(r.dateStart, dateStart) <= 4) ??
      free.find((r) => dayDiff(r.dateStart, dateStart) <= 1);
    if (hit) used.add(hit);
    return hit;
  };
}

/** Calendario de wrc.com para la temporada pedida ([] si el sitio no responde o muestra otra temporada). */
async function readSiteCalendar(ctx: AdapterContext, season: number): Promise<WrcSiteEvent[]> {
  try {
    return (await fetchWrcCalendar(ctx.http)).filter((e) => e.dateStart.startsWith(String(season)));
  } catch (err) {
    // Típico desde GitHub Actions: 403 de Akamai. No es un error de la serie: siguen la FIA y Wikipedia.
    ctx.log.info(`wrc.com no respondió (${(err as Error).message}); se sigue con la FIA y Wikipedia`);
    return [];
  }
}

/**
 * Calendario de la temporada. Fechas, nombres y países: la FIA; si la FIA todavía no abrió la temporada, wrc.com; si
 * tampoco, Wikipedia. Sede y superficie: Wikipedia (ninguna fuente oficial las publica de forma legible).
 */
async function readCalendar(ctx: AdapterContext, season: number): Promise<SeasonCalendar> {
  const fiaUrl = fiaWrcCalendarUrl(season);
  let fia: FiaRally[] = [];
  try {
    fia = parseFiaCalendar((await ctx.http.text(fiaUrl)).body, season);
  } catch (err) {
    // 404: la FIA todavía no abrió la página de esa temporada. Otro error se propaga (se conserva lo anterior).
    if (!(err instanceof HttpError && err.status === 404)) throw err;
  }
  const site = await readSiteCalendar(ctx, season);
  const article = wrcSeasonArticle(season);
  let seasonPage: WikiPage | undefined;
  try {
    seasonPage = (await fetchWikiPages(ctx.http, [article])).get(article);
  } catch (err) {
    // Wikipedia corta con 429 si se le pide mucho: si hay calendario oficial se sigue sin sede ni superficie nuevas
    // (se conservan las de la corrida anterior); si no hay ninguno, el error de abajo lo explica.
    ctx.log.warn(`No se pudo leer «${article}» en Wikipedia: ${(err as Error).message}`);
  }
  const wiki = seasonPage ? parseSeasonCalendar(seasonPage.text, season) : [];
  const wikiFor = matcher(wiki, (w) => hostByFlag(w.flag)?.iso2 ?? '');
  const siteFor = matcher(site, (s) => s.iso2);

  let rallies: Rally[];
  let cancelled: CancelledRally[];
  let source: Source;
  if (fia.length > 0) {
    rallies = fia
      .filter((f) => !f.cancelled)
      .sort((a, b) => a.dateStart.localeCompare(b.dateStart))
      .map((f, i) => {
        const w = wikiFor(f.iso2, f.dateStart);
        const s = siteFor(f.iso2, f.dateStart);
        return {
          key: '',
          round: i + 1,
          name: cleanRallyName(f.name, season),
          iso2: f.iso2,
          dateStart: f.dateStart,
          dateEnd: f.dateEnd,
          fia: f,
          ...(s ? { site: s } : {}),
          ...(w ? { wiki: w } : {}),
        };
      });
    cancelled = fia.filter((f) => f.cancelled);
    source = directSource(ctx, fiaUrl, `FIA: calendario del WRC ${season}`, 'html');
  } else if (site.length > 0) {
    const live = site.filter((s) => !/cancel/.test(s.status));
    rallies = live.map((s, i) => {
      const w = wikiFor(s.iso2, s.dateStart);
      return {
        key: '',
        round: s.round ?? i + 1,
        name: cleanRallyName(s.title, season),
        iso2: s.iso2,
        dateStart: s.dateStart,
        dateEnd: s.dateEnd,
        site: s,
        ...(w ? { wiki: w } : {}),
      };
    });
    cancelled = site.filter((s) => /cancel/.test(s.status)).map((s) => ({ name: s.title, dateStart: s.dateStart, dateEnd: s.dateEnd }));
    source = directSource(ctx, WRC_CALENDAR_URL, `WRC.com: calendario ${season}`, 'html');
  } else {
    if (!seasonPage || wiki.length === 0) {
      throw new Error(`Sin calendario ${season} del WRC: ni la FIA, ni wrc.com, ni Wikipedia lo publican todavía`);
    }
    rallies = wiki.map((w) => ({ key: '', round: w.round, name: w.name, iso2: hostByFlag(w.flag)?.iso2 ?? '', dateStart: w.dateStart, dateEnd: w.dateEnd, wiki: w }));
    cancelled = [];
    source = directSource(ctx, seasonPage.url, `Wikipedia: ${seasonPage.title}`, 'api');
  }

  const seen = new Map<string, number>();
  for (const r of rallies) {
    const base = (r.iso2 || r.wiki?.flag || `ronda-${r.round}`).toLowerCase();
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    r.key = n > 1 ? `${base}-${n}` : base;
  }
  return { rallies, cancelled, source, ...(seasonPage && wiki.length > 0 ? { wikiTitle: seasonPage.title } : {}) };
}

// ─── Itinerario: tramos y bloques de la agenda ────────────────────────────────────────────────

const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const weekday = (date: string) => WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]!;

/**
 * Zona para convertir las horas del itinerario. Si el artículo declara un huso ("UTC+1") distinto del que da la
 * zona del evento ese día (sede con otro huso, o reglas de horario de verano que cambiaron), se usa el declarado:
 * las horas son las del artículo.
 */
function zoneForTimes(tz: string, date: string, statedOffset: number | undefined): string {
  if (statedOffset === undefined) return tz;
  const actual = DateTime.fromISO(`${date}T12:00`, { zone: tz }).offset;
  if (actual === statedOffset) return tz;
  const abs = Math.abs(statedOffset);
  const minutes = abs % 60;
  return `UTC${statedOffset < 0 ? '-' : '+'}${Math.floor(abs / 60)}${minutes ? `:${String(minutes).padStart(2, '0')}` : ''}`;
}

interface StageRange {
  first: number;
  last: number;
}

interface BuiltItinerary {
  stages: RallyStage[];
  sessions: Session[];
  /** Sesión -> tramos que abarca (primero y último). */
  blocks: Map<string, StageRange>;
  competitiveKm?: number;
}

/** Sesión con id estable (sale del nombre base) y nombre para mostrar con el rango de tramos. */
function blockSession(
  ctx: AdapterContext,
  input: Parameters<AdapterContext['build']['session']>[0],
  display: string,
  estimatedEnd: boolean,
): Session {
  const s = ctx.build.session(input);
  return { ...s, name: display, ...(estimatedEnd ? { endEstimated: true } : {}) };
}

/** Itinerario elegido para un rally, con su fuente. */
interface ItinerarySource {
  stages: ItineraryStage[];
  /** Huso declarado por la fuente (solo Wikipedia lo dice explícitamente). */
  utcOffsetMinutes?: number;
  overallKm?: number;
  /** Página del itinerario y rótulo de la fuente ("WRC.com: …", "Wikipedia: …"). */
  url: string;
  title: string;
  kind: Source['kind'];
}

function buildItinerary(series: Series, ctx: AdapterContext, event: MotorEvent, itinerary: ItinerarySource): BuiltItinerary {
  const source = directSource(ctx, itinerary.url, `${itinerary.title} (itinerario)`, itinerary.kind);
  const rows: Array<ItineraryStage & { startUtc?: string; sessionId?: string }> = itinerary.stages.map((s) => ({
    ...s,
    ...(s.time ? { startUtc: localToUtc(s.date, s.time, zoneForTimes(event.tz, s.date, itinerary.utcOffsetMinutes)) } : {}),
  }));
  const specials = rows.filter((s) => s.kind !== 'shakedown');
  // La Power Stage la marca la fuente; si no, es el último tramo del rally (reglamento del WRC) cuando cae el día final.
  const last = specials.at(-1);
  if (last && !specials.some((s) => s.kind === 'power') && last.date === event.dateEnd) last.kind = 'power';

  const sessions: Session[] = [];
  const blocks = new Map<string, StageRange>();

  // Shakedown
  rows
    .filter((s) => s.kind === 'shakedown' && s.startUtc)
    .forEach((s, i) => {
      const session = ctx.build.session({
        event,
        type: 'practica',
        name: 'Shakedown',
        startUtc: s.startUtc!,
        localStartText: s.time!,
        source,
        ...(i > 0 ? { key: i + 1 } : {}),
      });
      sessions.push(session);
      s.sessionId = session.id;
    });

  // Power Stage: sesión aparte si tiene hora; si no, queda dentro del bloque de su día.
  const power = specials.find((s) => s.kind === 'power' && s.startUtc);

  // Un bloque por día con los tramos cronometrados (sin la Power Stage).
  const stageMinutes = ctx.build.estimateMinutes(series.id, 'etapa');
  const days = new Map<string, typeof specials>();
  for (const s of specials) {
    if (s === power) continue;
    days.set(s.date, [...(days.get(s.date) ?? []), s]);
  }
  const usedWeekdays = new Set<string>();
  for (const [date, list] of days) {
    const timed = list.filter((s) => s.startUtc).sort((a, b) => a.startUtc!.localeCompare(b.startUtc!));
    if (timed.length === 0) continue;
    const first = timed[0]!;
    const end = timed.at(-1)!;
    const day = weekday(date);
    const range = list.length > 1 ? `${list[0]!.code} a ${list.at(-1)!.code}` : list[0]!.code;
    const session = blockSession(
      ctx,
      {
        event,
        type: 'etapa',
        name: `Etapa del ${day}`,
        startUtc: first.startUtc!,
        endUtc: addMinutes(end.startUtc!, stageMinutes),
        localStartText: first.time!,
        source,
        // Solo un rally de más de una semana repite el día: ahí la fecha desambigua.
        ...(usedWeekdays.has(day) ? { key: date } : {}),
      },
      `Etapa del ${day}: ${range}`,
      true,
    );
    usedWeekdays.add(day);
    sessions.push(session);
    for (const s of list) s.sessionId = session.id;
    const numbers = list.map((s) => s.number ?? 0);
    blocks.set(session.id, { first: Math.min(...numbers), last: Math.max(...numbers) });
  }

  if (power) {
    const session = blockSession(
      ctx,
      { event, type: 'carrera', name: 'Power Stage', startUtc: power.startUtc!, localStartText: power.time!, source },
      `Power Stage (${power.code})`,
      false,
    );
    sessions.push(session);
    power.sessionId = session.id;
    // El resultado de esta sesión es la clasificación final del rally (general tras el último tramo corrido).
    if (power.number) blocks.set(session.id, { first: 1, last: power.number });
  }

  const stages: RallyStage[] = rows.map((s) => ({
    code: s.code,
    name: s.name,
    kind: s.kind,
    date: s.date,
    ...(s.startUtc ? { startUtc: s.startUtc } : {}),
    ...(s.time ? { localStartText: s.time } : {}),
    ...(s.km !== undefined ? { distanceKm: s.km } : {}),
    ...(s.sessionId ? { sessionId: s.sessionId } : {}),
  }));
  const km = specials.every((s) => s.km !== undefined) ? Math.round(specials.reduce((sum, s) => sum + s.km!, 0) * 100) / 100 : undefined;
  return { stages, sessions, blocks, ...(km !== undefined && specials.length > 0 ? { competitiveKm: km } : {}) };
}

/** Tramos de un bloque según el nombre publicado ("Etapa del viernes: SS2 a SS7", "Power Stage (SS17)"). */
export function blockFromName(session: Pick<Session, 'type' | 'name'>): StageRange | null {
  const m = session.name.match(/SS(\d+)(?:\s+a\s+SS(\d+))?/);
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  return session.type === 'carrera' ? { first: 1, last: b } : { first: a, last: b };
}

// ─── Temporada completa ───────────────────────────────────────────────────────────────────────

interface EventMeta {
  classificationsUrl?: string;
  entryListUrl?: string;
  blocks: Map<string, StageRange>;
}

interface BuiltSeason extends ScheduleChunk {
  stages: EventStagesFile[];
  cancelled: CancelledRally[];
  meta: Map<string, EventMeta>;
}

/** Evento mínimo para calcular el id de un rally (sale de la serie, la temporada y la clave). */
function shell(r: Rally, season: number, series: Series, source: Source) {
  return { series, season, key: r.key, name: r.name, circuit: '', country: '', tz: 'UTC', dateStart: r.dateStart, dateEnd: r.dateEnd, sessionsStatus: 'pending' as const, source };
}

function shiftDay(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** Itinerarios publicados en wrc.com (rally -> itinerario); si el sitio rechaza al cliente, se dejan de pedir. */
async function readSiteItineraries(ctx: AdapterContext, rallies: Rally[]): Promise<Map<Rally, ItinerarySource>> {
  const out = new Map<Rally, ItinerarySource>();
  let blocked = false;
  await mapLimit(
    rallies.filter((r) => r.site),
    3,
    async (r) => {
      if (blocked) return;
      try {
        const found = await fetchWrcItinerary(ctx.http, r.site!.slug);
        if (found) out.set(r, { stages: found.stages, url: found.url, title: `WRC.com: ${r.site!.title}`, kind: 'api' });
      } catch (err) {
        if (err instanceof HttpError && (err.status === 403 || err.status === 429)) {
          if (!blocked) ctx.log.info(`wrc.com no entrega itinerarios (${err.message}); se usan los de Wikipedia`);
          blocked = true;
        } else if (!(err instanceof HttpError && err.status === 404)) {
          ctx.log.warn(`${r.name}: no se pudo leer el itinerario de wrc.com: ${(err as Error).message}`);
        }
      }
    },
  );
  return out;
}

/**
 * Sesiones de la corrida anterior de un rally que esta vez no trae itinerario (p. ej. wrc.com dejó de responder y
 * Wikipedia todavía no tiene el artículo): se conservan si el rally no cambió de fechas, así no se pierden sus
 * horarios ni sus resultados. El archivo de etapas queda como estaba (run.ts no lo toca).
 */
function previousSessions(ctx: AdapterContext, event: MotorEvent): { event: MotorEvent; sessions: Session[] } | null {
  const before = ctx.previous?.events.find((e) => e.id === event.id);
  if (!before?.stageCount || before.dateStart !== event.dateStart || before.dateEnd !== event.dateEnd) return null;
  const sessions = (ctx.previous?.sessions ?? []).filter((s) => s.eventId === event.id);
  return sessions.length > 0 ? { event: before, sessions } : null;
}

async function buildSeason(series: Series, ctx: AdapterContext, season: number): Promise<BuiltSeason> {
  const cal = await readCalendar(ctx, season);
  // Artículos de cada rally (los que todavía no existen simplemente no vuelven): un pedido para todos.
  let pages = new Map<string, WikiPage>();
  try {
    pages = await fetchWikiPages(ctx.http, cal.rallies.map((r) => r.wiki?.article ?? '').filter(Boolean));
  } catch (err) {
    ctx.log.warn(`No se pudieron leer los artículos de los rallies ${season} en Wikipedia: ${(err as Error).message}`);
  }
  const official = await readSiteItineraries(ctx, cal.rallies);
  const out: BuiltSeason = { events: [], sessions: [], stages: [], cancelled: cal.cancelled, meta: new Map() };

  for (const r of cal.rallies) {
    const host = hostByIso(r.iso2);
    const hqHost = r.wiki?.hqCountry ? hostByName(r.wiki.hqCountry) : undefined;
    const place = r.wiki?.hq ?? '';
    // Sin la tabla de Wikipedia en esta lectura (p. ej. un 429), la sede, la zona y la superficie salen de la corrida
    // anterior del mismo rally.
    const before = r.wiki ? undefined : ctx.previous?.events.find((e) => e.id === ctx.build.event(shell(r, season, series, cal.source)).id);
    const tz = before?.tz ?? PLACE_ZONES.find(([re]) => re.test(place))?.[1] ?? (hqHost ?? host)?.tz ?? guessTimeZone(r.iso2, place);
    if (!tz) ctx.log.warn(`${r.name}: país sin zona horaria conocida (${r.iso2 || r.wiki?.flag || '?'}); se usa UTC`);
    // Sede fuera del país anfitrión (Montecarlo tiene base en Gap, Francia): se aclara el país de la sede.
    const abroad = hqHost && host && hqHost.iso2 !== host.iso2 ? ` (${countryName(hqHost.iso2)})` : '';
    let circuit = r.wiki?.city ? `${r.wiki.city}${abroad}` : 'A confirmar';

    // Itinerario: el oficial (wrc.com) si está publicado; si no, el del artículo de Wikipedia.
    const page = r.wiki?.article ? pages.get(r.wiki.article) : undefined;
    const article = page ? parseRallyArticle(page.text, r.dateStart) : null;
    const candidates: ItinerarySource[] = [];
    const fromSite = official.get(r);
    if (fromSite) candidates.push(fromSite);
    if (page && article && article.stages.length > 0) {
      candidates.push({
        stages: article.stages,
        ...(article.utcOffsetMinutes !== undefined ? { utcOffsetMinutes: article.utcOffsetMinutes } : {}),
        ...(article.overallKm !== undefined ? { overallKm: article.overallKm } : {}),
        url: page.url,
        title: `Wikipedia: ${page.title}`,
        kind: 'api',
      });
    }
    const itinerary =
      candidates.find((c) => {
        const ok = c.stages.every((s) => s.date >= shiftDay(r.dateStart, -2) && s.date <= shiftDay(r.dateEnd, 1));
        if (!ok) ctx.log.warn(`${r.name}: el itinerario de ${c.title} no coincide con las fechas del rally (${r.dateStart} a ${r.dateEnd}); se descarta`);
        return ok;
      }) ?? null;
    const surface = surfaceOf(r.wiki?.surface || article?.surface || '', `${r.wiki?.surfaceNote ?? ''} ${article?.surface ?? ''}`);
    if (before) {
      if (before.circuit) circuit = before.circuit;
      if (!surface.surface && before.surface) surface.surface = before.surface;
    }
    const venue = cal.source.title.startsWith('Wikipedia')
      ? ''
      : r.wiki && cal.wikiTitle
        ? ` (sede y superficie: Wikipedia, «${cal.wikiTitle}»)`
        : before
          ? ' (sede y superficie: Wikipedia, lectura anterior)'
          : '';
    const specials = itinerary?.stages.filter((s) => s.kind !== 'shakedown').length ?? 0;

    const input = {
      series,
      season,
      key: r.key,
      name: r.name,
      round: r.round,
      circuit,
      country: countryName(r.iso2, r.wiki?.hqCountry ?? ''),
      tz: tz ?? 'UTC',
      dateStart: r.dateStart,
      dateEnd: r.dateEnd,
      ...(surface.surface ? { surface: surface.surface } : {}),
      source: { ...cal.source, title: `${cal.source.title}${venue}` },
    };
    let event = ctx.build.event({
      ...input,
      sessionsStatus: itinerary?.stages.some((s) => s.time) ? 'published' : 'pending',
      ...(itinerary ? { stageCount: specials } : {}),
    });
    const meta: EventMeta = {
      ...(r.fia?.classificationsUrl ? { classificationsUrl: r.fia.classificationsUrl } : {}),
      ...(r.fia?.entryListUrl ? { entryListUrl: r.fia.entryListUrl } : {}),
      blocks: new Map(),
    };
    out.meta.set(event.id, meta);

    if (!itinerary) {
      const kept = previousSessions(ctx, event);
      if (kept) {
        event = ctx.build.event({ ...input, sessionsStatus: kept.event.sessionsStatus, stageCount: kept.event.stageCount });
        out.sessions.push(...kept.sessions);
        for (const s of kept.sessions) {
          const range = blockFromName(s);
          if (range && s.type !== 'practica') meta.blocks.set(s.id, range);
        }
        ctx.log.info(`${r.name}: sin itinerario en esta lectura; se conservan los horarios de la corrida anterior`);
      }
      out.events.push(event);
      continue;
    }
    out.events.push(event);

    if (itinerary.utcOffsetMinutes !== undefined && zoneForTimes(event.tz, r.dateStart, itinerary.utcOffsetMinutes) !== event.tz) {
      ctx.log.warn(`${r.name}: el itinerario declara UTC${itinerary.utcOffsetMinutes >= 0 ? '+' : ''}${itinerary.utcOffsetMinutes / 60} y la zona ${event.tz} da otro huso; se usa el declarado`);
    }
    const built = buildItinerary(series, ctx, event, itinerary);
    out.sessions.push(...built.sessions);
    meta.blocks = built.blocks;
    out.stages.push({
      seriesId: series.id,
      eventId: event.id,
      updatedAt: fetchedAt(ctx),
      ...(surface.surface ? { surface: surface.surface } : {}),
      ...(surface.note ? { surfaceNote: surface.note } : {}),
      ...(built.competitiveKm !== undefined ? { competitiveKm: built.competitiveKm } : {}),
      ...(itinerary.overallKm !== undefined ? { totalKm: itinerary.overallKm } : {}),
      stages: built.stages,
      source: directSource(ctx, itinerary.url, itinerary.title, itinerary.kind),
    });
  }
  return out;
}

// ─── Resultados y campeonato ──────────────────────────────────────────────────────────────────

const retryLater = (err: unknown) => err instanceof HttpError && (err.status === 429 || err.status >= 500);

async function results(series: Series, ctx: AdapterContext, req: ResultsRequest, maxEvents: number): Promise<ResultsChunk> {
  const nowIso = fetchedAt(ctx);
  const files: EventResultsFile[] = [];
  const deferred: string[] = [];
  const eventsById = new Map(req.events.map((e) => [e.id, e]));
  // Solo los bloques con tramos cronometrados tienen clasificación (el Shakedown no).
  const wanted = req.pendingSessions.filter((s) => s.type === 'etapa' || s.type === 'carrera');
  const seasons = new Map<number, Promise<BuiltSeason>>();
  let budget = maxEvents;
  let throttled = false;

  for (const eventId of [...new Set(wanted.map((s) => s.eventId))]) {
    const event = eventsById.get(eventId);
    const sessions = wanted.filter((s) => s.eventId === eventId);
    if (!event) continue;
    // Todavía pueden estar pasando autos por el último tramo del bloque: se espera sin gastar intentos.
    const settled = sessions.filter((s) => ctx.now.getTime() - Date.parse(s.endUtc) >= SETTLE_MS);
    deferred.push(...sessions.filter((s) => !settled.includes(s)).map((s) => s.id));
    if (settled.length === 0) continue;
    if (budget <= 0 || throttled) {
      deferred.push(...settled.map((s) => s.id));
      continue;
    }

    const season = Number(event.dateStart.slice(0, 4));
    // Misma lectura que el calendario (ctx.http la tiene memorizada); sus avisos ya salieron en esa fase.
    if (!seasons.has(season)) seasons.set(season, buildSeason(series, { ...ctx, log: createLogger('', true) }, season));
    let meta: EventMeta | undefined;
    try {
      meta = (await seasons.get(season)!).meta.get(eventId);
    } catch (err) {
      ctx.log.warn(`No se pudo releer el calendario ${season}: ${(err as Error).message}`);
      deferred.push(...settled.map((s) => s.id));
      continue;
    }
    if (!meta?.classificationsUrl) continue; // sin página de la FIA para ese rally

    budget--;
    try {
      const stages = parseFiaClassifications((await ctx.http.text(meta.classificationsUrl)).body);
      let entries = new Map<string, FiaEntry>();
      if (stages.length > 0 && meta.entryListUrl) {
        try {
          entries = parseFiaEntryList((await ctx.http.text(meta.entryListUrl)).body);
        } catch (err) {
          // Sin la lista de inscriptos quedan los nombres abreviados del cronometraje ("O. Solberg").
          ctx.log.warn(`${event.name}: no se pudo leer la lista de inscriptos de la FIA: ${(err as Error).message}`);
        }
      }
      const file: EventResultsFile = { seriesId: series.id, eventId, updatedAt: nowIso, sessions: [] };
      for (const session of settled) {
        const range = meta.blocks.get(session.id);
        if (!range) continue;
        const run = stages.filter((st) => st.overall.length > 0 && st.number >= range.first && st.number <= range.last);
        let stage = run.find((st) => st.number === range.last);
        if (!stage) {
          // El último tramo del bloque no tiene tabla: se canceló o la FIA todavía no la cargó. Se espera sin gastar
          // intentos y, pasado medio día, vale la clasificación tras el último tramo que sí se corrió.
          if (ctx.now.getTime() - Date.parse(session.endUtc) < CANCELLED_AFTER_MS) {
            deferred.push(session.id);
            continue;
          }
          stage = run.at(-1);
        }
        if (!stage) continue;
        // La sesión final (Power Stage) publica la clasificación final del rally, no la del tramo.
        const what =
          session.type === 'carrera' ? `clasificación final del rally (general tras SS${stage.number})` : `clasificación general tras SS${stage.number}`;
        file.sessions.push({
          sessionId: session.id,
          rows: crewRows(stage.overall, entries),
          source: {
            url: meta.classificationsUrl,
            title: `FIA: ${event.name} — ${what}${stage.unofficial ? ' (tiempos no oficiales)' : ''}`,
            kind: 'html',
            method: 'directo',
            fetchedAt: nowIso,
          },
        });
      }
      if (file.sessions.length > 0) files.push(file);
    } catch (err) {
      if (retryLater(err)) {
        if (!throttled) ctx.log.warn(`La FIA pidió esperar (${(err as Error).message}): las clasificaciones que faltan quedan para la próxima corrida`);
        throttled = true;
        deferred.push(...settled.map((s) => s.id));
      } else if (!(err instanceof HttpError && err.status === 404)) {
        ctx.log.warn(`${event.name}: no se pudieron leer las clasificaciones de la FIA: ${(err as Error).message}`);
      }
    }
  }

  const chunk: ResultsChunk = { results: files, ...(deferred.length ? { deferred } : {}) };
  if (req.standingsStale && !throttled) {
    const url = fiaWrcStandingsUrl(ctx.season);
    try {
      const tables = parseFiaStandings((await ctx.http.text(url)).body);
      if (tables.length > 0) {
        chunk.standings = {
          seriesId: series.id,
          season: ctx.season,
          updatedAt: nowIso,
          tables,
          source: directSource(ctx, url, `FIA: campeonato del WRC ${ctx.season}`, 'html'),
        };
      }
    } catch (err) {
      if (!(err instanceof HttpError && err.status === 404)) ctx.log.warn(`No se pudo leer el campeonato en ${url}: ${(err as Error).message}`);
    }
  }
  return chunk;
}

export function createWrcAdapter(opts: WrcOptions = {}): Adapter {
  return {
    name: 'wrc',
    async schedule(series, ctx): Promise<ScheduleChunk> {
      const built = await buildSeason(series, ctx, ctx.season);
      for (const c of built.cancelled) ctx.log.info(`${c.name} (${c.dateStart} a ${c.dateEnd}): cancelado según el calendario oficial; no se publica`);
      ctx.log.info(`Temporada ${ctx.season}: ${built.events.length} rallies, ${built.stages.length} con itinerario`);
      return { events: built.events, sessions: built.sessions, ...(built.stages.length ? { stages: built.stages } : {}) };
    },
    results: (series, ctx, req) => results(series, ctx, req, opts.maxResultEvents ?? MAX_RESULT_EVENTS),
  };
}

export const wrcAdapter: Adapter = createWrcAdapter();
