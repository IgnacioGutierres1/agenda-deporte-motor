/**
 * Lector directo de MotoGP / Moto2 / Moto3 (API oficial de motogp.com, pulselive).
 *
 * Horarios:   GET {API}/events?seasonYear={año}
 *             Cada evento trae `broadcasts[]` con las sesiones de las tres categorías
 *             (`category.acronym` MGP / MT2 / MT3), con inicio y fin publicados.
 * Resultados: GET {API}/results/seasons
 *             GET {API}/results/events?seasonUuid=…&isFinished=true   (`toad_api_uuid` = id del calendario)
 *             GET {API}/results/categories?eventUuid=…               (`legacy_id` 3/2/1)
 *             GET {API}/results/sessions?eventUuid=…&categoryUuid=…   (`type` + `number`, p. ej. FP+1, Q+2, RAC)
 *             GET {API}/results/session/{id}/classification?test=false
 * Campeonato: GET {API}/results/standings?seasonUuid=…&categoryUuid=… (pilotos, JSON)
 *             + el XML oficial `xmlFile` que trae esa respuesta (equipos y constructores).
 *
 * Las tres series comparten las mismas URL: ctx.http memoiza, así que se descargan una sola vez.
 */
import {
  formatTime,
  toUtcIso,
  type EventResultsFile,
  type MotorEvent,
  type ResultRow,
  type Series,
  type Session,
  type SessionType,
  type StandingsFile,
  type StandingsRow,
  type StandingsTable,
} from '@dm/shared';
import { classifySession } from '../core/builders.ts';
import type { Adapter, AdapterContext, ResultsChunk, ResultsRequest, ScheduleChunk } from '../core/types.ts';
import { canonicalZone, countryName, directSource, lapsLabel, trimLapTime } from './util.ts';

export const MOTOGP_API = 'https://api.motogp.pulselive.com/motogp/v1';
const WEB = 'https://www.motogp.com/en';
/** Tope de sesiones a consultar por corrida y serie. */
const MAX_SESSIONS_PER_RUN = 40;

interface CategoryInfo {
  /** Sigla en `broadcasts[].category.acronym`. */
  acronym: string;
  /** `legacy_id` en la API de resultados (y `timing_id` en el calendario). */
  legacyId: number;
  /** Segmento de URL en motogp.com. */
  slug: string;
}

export const MOTOGP_CATEGORIES: Record<string, CategoryInfo> = {
  motogp: { acronym: 'MGP', legacyId: 3, slug: 'motogp' },
  moto2: { acronym: 'MT2', legacyId: 2, slug: 'moto2' },
  moto3: { acronym: 'MT3', legacyId: 1, slug: 'moto3' },
};

// ---------- Tipos mínimos de la API ----------

interface ApiCategory {
  acronym: string;
  name?: string;
}

interface ApiBroadcast {
  id: string;
  shortname: string;
  name: string;
  type: string; // SESSION | MEDIA
  kind?: string;
  status?: string;
  date_start: string;
  date_end: string;
  category?: ApiCategory | null;
}

export interface ApiCalendarEvent {
  id: string;
  name: string;
  shortname?: string;
  kind: string; // GP | TEST | MEDIA
  sequence?: number;
  url?: string;
  status?: string;
  date_start: string;
  date_end: string;
  time_zone: string;
  country?: string;
  circuit?: { name?: string; country?: string; iso_code?: string } | null;
  categories?: ApiCategory[];
  broadcasts?: ApiBroadcast[];
}

interface ApiSeason {
  id: string;
  year: number;
}

interface ApiResultsEvent {
  id: string;
  short_name: string;
  toad_api_uuid?: string | null;
  test: boolean;
}

interface ApiResultsCategory {
  id: string;
  name: string;
  legacy_id: number;
}

interface ApiResultsSession {
  id: string;
  type: string;
  number: number | null;
  status?: string;
}

interface ApiRider {
  full_name: string;
  number?: number | null;
}

export interface ApiClassificationRow {
  position: number | null;
  rider: ApiRider;
  team?: { name?: string } | null;
  constructor?: { name?: string } | null;
  total_laps?: number | null;
  time?: string | null;
  points?: number | null;
  status?: string | null;
  best_lap?: { time?: string | null } | null;
  gap?: { first?: string | null; lap?: string | null; prev?: string | null } | null;
}

interface ApiStandingsRow {
  position: number | null;
  rider: ApiRider;
  team?: { name?: string } | null;
  points: number;
  race_wins?: number | null;
}

interface ApiStandings {
  file?: string;
  xmlFile?: string;
  classification: ApiStandingsRow[];
}

// ---------- Horarios ----------

interface SessionMeta {
  /** Id del evento en el calendario (= `toad_api_uuid` en resultados). */
  calendarEventId: string;
  /** Código de sesión: FP1, PR, Q2, SPR, WUP, RAC… */
  code: string;
  /** Sigla del evento (QAT, POR…). */
  eventShort: string;
}

interface BuiltSchedule extends ScheduleChunk {
  meta: Map<string, SessionMeta>;
}

/** Normaliza offsets "+0300" a "+03:00" y devuelve ISO UTC con Z. */
export function apiDateToUtc(s: string): string {
  return toUtcIso(s.trim().replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

const LOWER_WORDS = new Set(['of', 'the', 'and', 'de', 'del', 'la', 'do', 'da']);

/** "REPSOL GRAND PRIX OF PORTUGAL" -> "Repsol Grand Prix of Portugal" (siglas cortas se conservan). */
export function titleCase(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .map((w, i) => {
      const lower = w.toLowerCase();
      if (i > 0 && LOWER_WORDS.has(lower)) return lower;
      if (/^[A-Z]{2}$/.test(w)) return w; // PT, BK…
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(' ');
}

/** Tipo y nombre legible (en español) para un código de sesión de la API. */
export function describeSession(code: string, rawName: string): { type: SessionType; name: string } {
  const c = code.toUpperCase();
  let m: RegExpMatchArray | null;
  if ((m = c.match(/^FP(\d+)$/))) return { type: 'practica', name: `Práctica Libre ${m[1]}` };
  if (c === 'PR') return { type: 'practica', name: 'Práctica' };
  if ((m = c.match(/^Q(\d+)$/))) return { type: 'clasificacion', name: `Clasificación Q${m[1]}` };
  if (c === 'QP') return { type: 'clasificacion', name: 'Clasificación' };
  if (c === 'SPR') return { type: 'sprint', name: 'Sprint' };
  if (c === 'WUP') return { type: 'warmup', name: 'Warm Up' };
  if (c === 'RAC') return { type: 'carrera', name: 'Carrera' };
  if ((m = c.match(/^RAC(\d+)$/))) return { type: 'carrera', name: `Carrera ${m[1]}` };
  const name = rawName.trim() || code;
  return { type: classifySession(name), name };
}

/** URL pública del evento en motogp.com (el slug es decorativo; el id identifica el evento). */
export function eventWebUrl(season: number, ev: ApiCalendarEvent): string {
  const slug =
    (ev.url ?? ev.shortname ?? 'event')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'event';
  return `${WEB}/calendar/${season}/event/${slug}/${ev.id}`;
}

/** URL pública de la clasificación de una sesión en motogp.com. */
export function sessionResultsWebUrl(season: number, eventShort: string, catSlug: string, code: string): string {
  return `${WEB}/gp-results/${season}/${eventShort.toLowerCase()}/${catSlug}/${code.toLowerCase()}/classification`;
}

export function calendarUrl(season: number): string {
  return `${MOTOGP_API}/events?seasonYear=${season}`;
}

function categoryFor(series: Series): CategoryInfo {
  const cat = MOTOGP_CATEGORIES[series.id];
  if (!cat) throw new Error(`El lector de MotoGP no conoce la serie "${series.id}"`);
  return cat;
}

async function buildSchedule(series: Series, ctx: AdapterContext): Promise<BuiltSchedule> {
  const cat = categoryFor(series);
  const url = calendarUrl(ctx.season);
  const { body } = await ctx.http.json<ApiCalendarEvent[]>(url);
  if (!Array.isArray(body)) throw new Error(`Respuesta inesperada del calendario de MotoGP (${url})`);

  const events: MotorEvent[] = [];
  const sessions: Session[] = [];
  const meta = new Map<string, SessionMeta>();

  for (const ev of body) {
    // Solo grandes premios del campeonato: se descartan pruebas (TEST) y presentaciones (MEDIA).
    if (ev.kind !== 'GP') continue;
    const hasCategory =
      (ev.categories ?? []).some((c) => c.acronym === cat.acronym) ||
      (ev.broadcasts ?? []).some((b) => b.category?.acronym === cat.acronym);
    if (!hasCategory) continue;

    const tz = canonicalZone(ev.time_zone);
    const webUrl = eventWebUrl(ctx.season, ev);
    const name = titleCase(ev.name);
    const source = directSource(ctx, webUrl, `MotoGP.com – ${name}`);

    const broadcasts = (ev.broadcasts ?? []).filter(
      (b) =>
        b.type === 'SESSION' &&
        b.category?.acronym === cat.acronym &&
        !/cancel/i.test(b.name) &&
        !/cancel/i.test(b.status ?? ''),
    );

    const event = ctx.build.event({
      series,
      season: ctx.season,
      key: ev.id,
      name,
      ...(ev.sequence ? { round: ev.sequence } : {}),
      circuit: ev.circuit?.name?.trim() || name,
      country: countryName(ev.circuit?.iso_code ?? ev.country, ev.circuit?.country ?? ''),
      tz,
      dateStart: ev.date_start.slice(0, 10),
      dateEnd: ev.date_end.slice(0, 10),
      sessionsStatus: broadcasts.length > 0 ? 'published' : 'pending',
      source,
    });
    events.push(event);

    const seen = new Map<string, number>();
    for (const b of broadcasts) {
      const code = b.shortname.trim().toUpperCase();
      const { type, name: sessionName } = describeSession(code, b.name);
      const startUtc = apiDateToUtc(b.date_start);
      const endUtc = b.date_end ? apiDateToUtc(b.date_end) : undefined;
      const n = (seen.get(code) ?? 0) + 1;
      seen.set(code, n);
      const session = ctx.build.session({
        event,
        type,
        name: sessionName,
        startUtc,
        // Las carreras publican fin = inicio: en ese caso se estima con durations.json.
        ...(endUtc && endUtc > startUtc ? { endUtc } : {}),
        localStartText: formatTime(startUtc, tz),
        source,
        ...(n > 1 ? { key: n } : {}),
      });
      sessions.push(session);
      meta.set(session.id, {
        calendarEventId: ev.id,
        code,
        eventShort: ev.shortname ?? '',
      });
    }
  }
  return { events, sessions, meta };
}

// ---------- Resultados ----------

function rowFromClassification(r: ApiClassificationRow, isRace: boolean): ResultRow | null {
  const driver = r.rider?.full_name?.trim();
  if (!driver) return null;
  const row: ResultRow = {
    pos: typeof r.position === 'number' && r.position > 0 ? r.position : null,
    driver,
  };
  if (row.pos === null) {
    const st = (r.status ?? '').toUpperCase();
    if (!isRace) row.status = st === 'NOTSTARTED' ? 'DNS' : 'Sin tiempo';
    else if (st === 'NOTSTARTED') row.status = 'DNS';
    else if (st === 'OUTSTND' || st === 'NOTFINISHFIRST' || st === '') row.status = 'DNF';
    else row.status = st;
  }
  if (r.rider.number != null) row.number = String(r.rider.number);
  if (r.team?.name) row.team = r.team.name;
  // `constructor` existe en todo objeto (Object.prototype): solo vale si viene en el JSON.
  const maker = Object.hasOwn(r, 'constructor') ? r.constructor?.name : undefined;
  if (maker) row.vehicle = maker;
  if (typeof r.total_laps === 'number') row.laps = r.total_laps;
  const bestLap = trimLapTime(r.best_lap?.time);
  if (bestLap) row.bestLap = bestLap;

  const gapLaps = Number(r.gap?.lap ?? 0);
  const gapFirst = r.gap?.first;
  if (isRace) {
    if (row.pos === 1 && r.time) row.time = trimLapTime(r.time);
    else if (row.pos !== null && gapLaps > 0) row.gap = lapsLabel(gapLaps);
    else if (row.pos !== null && gapFirst && Number(gapFirst) > 0) row.gap = `+${gapFirst}`;
    if (typeof r.points === 'number') row.points = r.points;
  } else {
    if (row.pos === 1 && bestLap) row.time = bestLap;
    else if (gapFirst && Number(gapFirst) > 0) row.gap = `+${gapFirst}`;
  }
  return row;
}

export function mapClassification(rows: ApiClassificationRow[], code: string): ResultRow[] {
  const isRace = /^(RAC\d*|SPR)$/.test(code);
  return rows.map((r) => rowFromClassification(r, isRace)).filter((r): r is ResultRow => r !== null);
}

async function seasonUuid(ctx: AdapterContext): Promise<string> {
  const { body } = await ctx.http.json<ApiSeason[]>(`${MOTOGP_API}/results/seasons`);
  const s = body.find((x) => x.year === ctx.season);
  if (!s) throw new Error(`La API de resultados de MotoGP no tiene la temporada ${ctx.season}`);
  return s.id;
}

async function resultsEvents(ctx: AdapterContext, season: string): Promise<ApiResultsEvent[]> {
  const { body } = await ctx.http.json<ApiResultsEvent[]>(
    `${MOTOGP_API}/results/events?seasonUuid=${season}&isFinished=true`,
  );
  return body.filter((e) => !e.test);
}

async function categoryUuid(ctx: AdapterContext, eventUuid: string, cat: CategoryInfo): Promise<string | null> {
  const { body } = await ctx.http.json<ApiResultsCategory[]>(
    `${MOTOGP_API}/results/categories?eventUuid=${eventUuid}`,
  );
  return body.find((c) => c.legacy_id === cat.legacyId)?.id ?? null;
}

async function resultsSessions(ctx: AdapterContext, eventUuid: string, catUuid: string): Promise<ApiResultsSession[]> {
  const { body } = await ctx.http.json<ApiResultsSession[]>(
    `${MOTOGP_API}/results/sessions?eventUuid=${eventUuid}&categoryUuid=${catUuid}`,
  );
  return body;
}

export function sessionCode(s: { type: string; number: number | null }): string {
  return `${s.type}${s.number ?? ''}`.toUpperCase();
}

/** Atributos de las etiquetas de apertura `<tag …>` de un XML plano. */
function xmlTags(xml: string, tag: string): Array<Record<string, string>> {
  const out: Array<Record<string, string>> = [];
  const re = new RegExp(`<${tag}\\s([^>]*?)/?>`, 'g');
  for (const m of xml.matchAll(re)) {
    const attrs: Record<string, string> = {};
    for (const a of m[1]!.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]!] = decodeXml(a[2]!);
    out.push(attrs);
  }
  return out;
}

function decodeXml(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Tablas de equipos y constructores del XML oficial (los puntos vienen multiplicados por 10). */
export function parseStandingsXml(xml: string): StandingsTable[] {
  const toRow = (a: Record<string, string>, nameKey: string): StandingsRow | null => {
    const pos = Number(a.pos);
    const name = a[nameKey]?.trim();
    if (!name || !Number.isInteger(pos) || pos <= 0) return null;
    return { pos, name, points: Number(a.total_points ?? 0) / 10 };
  };
  const tables: StandingsTable[] = [];
  const teams = xmlTags(xml, 'worldstanding_team')
    .map((a) => toRow(a, 'team_name'))
    .filter((r): r is StandingsRow => r !== null);
  if (teams.length) tables.push({ title: 'Equipos', rows: teams });
  const makers = xmlTags(xml, 'worldstanding_constructor')
    .map((a) => toRow(a, 'bike_name'))
    .filter((r): r is StandingsRow => r !== null);
  if (makers.length) tables.push({ title: 'Constructores', rows: makers });
  return tables;
}

export function mapRiderStandings(rows: ApiStandingsRow[]): StandingsRow[] {
  return rows
    .filter((r) => typeof r.position === 'number' && r.position > 0 && r.rider?.full_name)
    .map((r) => ({
      pos: r.position!,
      name: r.rider.full_name.trim(),
      ...(r.team?.name ? { team: r.team.name } : {}),
      ...(r.rider.number != null ? { number: String(r.rider.number) } : {}),
      points: r.points,
      ...(typeof r.race_wins === 'number' ? { wins: r.race_wins } : {}),
    }));
}

async function standings(
  series: Series,
  ctx: AdapterContext,
  season: string,
  finished: ApiResultsEvent[],
): Promise<StandingsFile | undefined> {
  const cat = categoryFor(series);
  // La categoría (uuid) se toma de la última carrera disputada de la temporada.
  let catUuid: string | null = null;
  for (const ev of [...finished].reverse()) {
    catUuid = await categoryUuid(ctx, ev.id, cat);
    if (catUuid) break;
  }
  if (!catUuid) return undefined;

  const { body } = await ctx.http.json<ApiStandings>(
    `${MOTOGP_API}/results/standings?seasonUuid=${season}&categoryUuid=${catUuid}`,
  );
  const riders = mapRiderStandings(body.classification ?? []);
  if (riders.length === 0) return undefined;
  const tables: StandingsTable[] = [{ title: 'Pilotos', rows: riders }];

  if (body.xmlFile) {
    try {
      const xml = await ctx.http.text(body.xmlFile);
      tables.push(...parseStandingsXml(xml.body));
    } catch (err) {
      ctx.log.warn(`No se pudo leer el XML de campeonato (${body.xmlFile}): ${String(err)}`);
    }
  }
  return {
    seriesId: series.id,
    season: ctx.season,
    updatedAt: directSource(ctx, WEB, '').fetchedAt,
    tables,
    source: directSource(
      ctx,
      `${WEB}/world-standing/${ctx.season}/${cat.slug}/championship-standings`,
      `MotoGP.com – Campeonato ${ctx.season} (${series.shortName})`,
    ),
  };
}

async function results(series: Series, ctx: AdapterContext, req: ResultsRequest): Promise<ResultsChunk> {
  const cat = categoryFor(series);
  const sched = await buildSchedule(series, ctx);
  const pending = req.pendingSessions.filter((s) => sched.meta.has(s.id)).slice(0, MAX_SESSIONS_PER_RUN);
  if (pending.length === 0 && !req.standingsStale) return { results: [] };

  const season = await seasonUuid(ctx);
  const finished = await resultsEvents(ctx, season);
  const byCalendarId = new Map(finished.filter((e) => e.toad_api_uuid).map((e) => [e.toad_api_uuid!, e]));

  const files = new Map<string, EventResultsFile>();
  const updatedAt = directSource(ctx, WEB, '').fetchedAt;

  for (const s of pending) {
    const meta = sched.meta.get(s.id)!;
    const rEvent = byCalendarId.get(meta.calendarEventId);
    if (!rEvent) continue; // todavía no figura como terminado
    try {
      const catUuid = await categoryUuid(ctx, rEvent.id, cat);
      if (!catUuid) continue;
      const rs = (await resultsSessions(ctx, rEvent.id, catUuid)).find((x) => sessionCode(x) === meta.code);
      if (!rs) continue;
      const { body } = await ctx.http.json<{ classification?: ApiClassificationRow[] }>(
        `${MOTOGP_API}/results/session/${rs.id}/classification?test=false`,
      );
      const rows = mapClassification(body.classification ?? [], meta.code);
      if (rows.length === 0) continue;
      const short = rEvent.short_name || meta.eventShort;
      const file =
        files.get(s.eventId) ??
        ({ seriesId: series.id, eventId: s.eventId, updatedAt, sessions: [] } satisfies EventResultsFile);
      file.sessions.push({
        sessionId: s.id,
        rows,
        source: directSource(
          ctx,
          sessionResultsWebUrl(ctx.season, short, cat.slug, meta.code),
          `MotoGP.com – Resultados ${short} ${series.shortName} ${meta.code}`,
        ),
      });
      files.set(s.eventId, file);
    } catch (err) {
      ctx.log.warn(`Resultado de ${meta.eventShort} ${meta.code}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const chunk: ResultsChunk = { results: [...files.values()] };
  if (req.standingsStale) {
    const st = await standings(series, ctx, season, finished);
    if (st) chunk.standings = st;
  }
  return chunk;
}

export const motogpAdapter: Adapter = {
  name: 'motogp',
  async schedule(series, ctx) {
    const { events, sessions } = await buildSchedule(series, ctx);
    return { events, sessions };
  },
  results,
};
