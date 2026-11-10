/**
 * Lector directo de NASCAR Cup / O'Reilly Auto Parts (ex Xfinity) / Craftsman Truck
 * (feeds oficiales de cf.nascar.com, los que usa nascar.com).
 *
 * Horarios:   GET https://cf.nascar.com/cacher/{año}/race_list_basic.json
 *             Objeto `series_1..3`; cada carrera trae `schedule[]` con `start_time_utc` (UTC sin "Z")
 *             y `run_type`: 0 = logística (garage, reuniones, presentaciones), 1 = práctica,
 *             2 = clasificación (o carrera clasificatoria, p. ej. los Duel de Daytona), 3 = carrera.
 * Resultados: GET https://cf.nascar.com/cacher/{año}/{serie}/{race_id}/weekend-feed.json
 *             `weekend_race[0].results` (carrera) y `weekend_runs[]` (prácticas y clasificación).
 * Campeonato: GET https://cf.nascar.com/cacher/{año}/{serie}/final/{serie}-drivers-points.json
 *             …/{serie}-owners-points.json y …/{serie}-manufacturer-points.json
 */
import {
  formatTime,
  localDate,
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
import type { Adapter, AdapterContext, ResultsChunk, ResultsRequest, ScheduleChunk } from '../core/types.ts';
import { trackInfo } from './nascar-tracks.ts';
import { countryName, directSource, fetchedAt, formatSeconds, lapsLabel } from './util.ts';

export const NASCAR_CACHER = 'https://cf.nascar.com/cacher';
const MAX_SESSIONS_PER_RUN = 40;

/** seriesId de la app -> número de serie de NASCAR. */
export const NASCAR_SERIES: Record<string, number> = {
  'nascar-cup': 1,
  'nascar-xfinity': 2,
  'nascar-truck': 3,
};

// ---------- Tipos mínimos de los feeds ----------

interface ApiScheduleItem {
  event_name: string;
  notes?: string;
  start_time_utc: string;
  run_type: number;
}

export interface ApiRace {
  race_id: number;
  series_id: number;
  race_season: number;
  race_name: string;
  race_type_id?: number;
  track_id?: number;
  track_name: string;
  race_date: string;
  total_race_time?: string | null;
  schedule?: ApiScheduleItem[] | null;
}

export interface ApiRaceResult {
  finishing_position: number;
  car_number: string;
  driver_fullname: string;
  driver_id?: number;
  team_name?: string | null;
  car_make?: string | null;
  laps_completed?: number | null;
  finishing_status?: string | null;
  points_earned?: number | null;
  disqualified?: boolean;
  diff_laps?: number | null;
  diff_time?: number | null;
}

export interface ApiRunResult {
  car_number: string;
  driver_id?: number;
  driver_name: string;
  manufacturer?: string | null;
  finishing_position: number;
  best_lap_time?: number | null;
  laps_completed?: number | null;
  delta_leader?: number | null;
  disqualified?: boolean;
}

export interface ApiRun {
  timing_run_id?: number;
  run_type: number;
  run_name: string;
  run_date_utc?: string | null;
  run_date?: string | null;
  results: ApiRunResult[];
}

export interface ApiWeekendFeed {
  weekend_race: Array<ApiRace & { results?: ApiRaceResult[] }>;
  weekend_runs?: ApiRun[];
}

interface ApiDriverPoints {
  position: number;
  driver_name: string;
  car_no?: string;
  points: number;
  wins?: number;
}

interface ApiOwnerPoints {
  position: number;
  owner_name: string;
  vehicle_number?: string;
  points: number;
  wins?: number;
}

interface ApiManufacturerPoints {
  position: number | string;
  manufacturer: string;
  points: number;
  wins?: number;
}

// ---------- Horarios ----------

interface SessionMeta {
  raceId: number;
  runType: number;
  startUtc: string;
}

interface BuiltSchedule extends ScheduleChunk {
  meta: Map<string, SessionMeta>;
}

export function scheduleUrl(season: number): string {
  return `${NASCAR_CACHER}/${season}/race_list_basic.json`;
}

export function weekendFeedUrl(season: number, seriesNo: number, raceId: number): string {
  return `${NASCAR_CACHER}/${season}/${seriesNo}/${raceId}/weekend-feed.json`;
}

/** "2026-11-08T20:00:00" (UTC sin zona) -> "2026-11-08T20:00:00Z". */
export function nascarUtc(s: string): string {
  const t = s.trim().replace(/\.\d+$/, '');
  return /(Z|[+-]\d{2}:?\d{2})$/.test(t) ? new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z') : `${t}Z`;
}

/** Tipo y nombre en español de una actividad del cronograma (run_type 1–3). */
export function describeRun(eventName: string, runType: number): { type: SessionType; name: string } {
  const raw = eventName.replace(/\(impound\)/gi, '').replace(/\s+/g, ' ').trim();
  if (runType === 3) return { type: 'carrera', name: 'Carrera' };
  const name = raw
    .replace(/final practice/i, 'Práctica final')
    .replace(/practice/gi, 'Práctica')
    .replace(/qualifying race/gi, 'Carrera clasificatoria')
    .replace(/qualifying/gi, 'Clasificación')
    .replace(/\brace\b/gi, 'Carrera');
  if (runType === 2) return { type: /race/i.test(raw) ? 'serie' : 'clasificacion', name: name || 'Clasificación' };
  return { type: 'practica', name: name || 'Práctica' };
}

function seriesNumber(series: Series): number {
  const n = NASCAR_SERIES[series.id];
  if (!n) throw new Error(`El lector de NASCAR no conoce la serie "${series.id}"`);
  return n;
}

async function buildSchedule(series: Series, ctx: AdapterContext): Promise<BuiltSchedule> {
  const n = seriesNumber(series);
  const url = scheduleUrl(ctx.season);
  const { body } = await ctx.http.json<Record<string, ApiRace[]>>(url);
  const races = body?.[`series_${n}`];
  if (!Array.isArray(races)) throw new Error(`El feed de NASCAR no trae series_${n} (${url})`);

  const source = directSource(ctx, url, `NASCAR – calendario oficial ${ctx.season} (${series.shortName})`);
  const events: MotorEvent[] = [];
  const sessions: Session[] = [];
  const meta = new Map<string, SessionMeta>();

  const sorted = [...races].sort((a, b) => a.race_date.localeCompare(b.race_date));
  let round = 0;
  for (const race of sorted) {
    const track = trackInfo(race.track_name);
    const items = (race.schedule ?? [])
      .filter((s) => s.run_type >= 1 && s.run_type <= 3 && s.start_time_utc)
      .map((s) => ({ ...s, startUtc: nascarUtc(s.start_time_utc) }))
      .sort((a, b) => a.startUtc.localeCompare(b.startUtc));

    const dates = items.map((s) => localDate(s.startUtc, track.tz)).sort();
    const fallbackDate = race.race_date.slice(0, 10);
    if (race.race_type_id === 1) round++;

    const event = ctx.build.event({
      series,
      season: ctx.season,
      key: race.race_id,
      name: race.race_name.trim(),
      ...(race.race_type_id === 1 ? { round } : {}),
      circuit: race.track_name.trim(),
      country: countryName(track.country, 'Estados Unidos'),
      tz: track.tz,
      dateStart: dates[0] ?? fallbackDate,
      dateEnd: dates.at(-1) ?? fallbackDate,
      sessionsStatus: items.length > 0 ? 'published' : 'pending',
      source,
    });
    events.push(event);

    const seen = new Map<string, number>();
    for (const item of items) {
      const { type, name } = describeRun(item.event_name, item.run_type);
      const k = (seen.get(name) ?? 0) + 1;
      seen.set(name, k);
      const session = ctx.build.session({
        event,
        type,
        name,
        startUtc: item.startUtc,
        localStartText: formatTime(item.startUtc, track.tz),
        source,
        ...(k > 1 ? { key: k } : {}),
      });
      sessions.push(session);
      meta.set(session.id, { raceId: race.race_id, runType: item.run_type, startUtc: item.startUtc });
    }
  }
  return { events, sessions, meta };
}

// ---------- Resultados ----------

export function mapRaceResults(race: { results?: ApiRaceResult[]; total_race_time?: string | null }): ResultRow[] {
  const results = race.results ?? [];
  // Feeds incompletos (todas las posiciones en 0) no se publican.
  if (!results.some((r) => r.finishing_position > 0)) return [];
  return [...results]
    .sort((a, b) => (a.finishing_position || 999) - (b.finishing_position || 999))
    .filter((r) => r.driver_fullname?.trim())
    .map((r) => {
      const row: ResultRow = {
        pos: r.finishing_position > 0 ? r.finishing_position : null,
        number: r.car_number,
        driver: r.driver_fullname.trim(),
      };
      const status = (r.finishing_status ?? '').trim();
      if (r.disqualified) row.status = 'DSQ';
      else if (status && status.toLowerCase() !== 'running') row.status = status;
      if (r.team_name) row.team = r.team_name;
      if (r.car_make) row.vehicle = r.car_make;
      if (typeof r.laps_completed === 'number') row.laps = r.laps_completed;
      if (row.pos === 1 && race.total_race_time) row.time = race.total_race_time;
      else if ((r.diff_laps ?? 0) > 0) row.gap = lapsLabel(r.diff_laps!);
      else if ((r.diff_time ?? 0) > 0) row.gap = `+${(r.diff_time! / 1000).toFixed(3)}`;
      if (typeof r.points_earned === 'number') row.points = r.points_earned;
      return row;
    });
}

export function mapRunResults(run: ApiRun, teamByDriver: Map<number, string>): ResultRow[] {
  return [...run.results]
    .sort((a, b) => (a.finishing_position || 999) - (b.finishing_position || 999))
    .filter((r) => r.driver_name?.trim())
    .map((r) => {
      const row: ResultRow = {
        pos: r.finishing_position > 0 ? r.finishing_position : null,
        number: r.car_number,
        driver: r.driver_name.trim(),
      };
      const team = r.driver_id !== undefined ? teamByDriver.get(r.driver_id) : undefined;
      if (team) row.team = team;
      if (r.manufacturer) row.vehicle = r.manufacturer;
      if (typeof r.laps_completed === 'number') row.laps = r.laps_completed;
      if (r.disqualified) row.status = 'DSQ';
      const best = r.best_lap_time && r.best_lap_time > 0 ? formatSeconds(r.best_lap_time) : undefined;
      if (best) {
        row.bestLap = best;
        if (row.pos === 1) row.time = best;
        else if (r.delta_leader) row.gap = `+${Math.abs(r.delta_leader).toFixed(3)}`;
      } else if (!row.status) {
        row.status = 'Sin tiempo';
      }
      return row;
    });
}

/**
 * Elige la tanda de `weekend_runs` que corresponde a una sesión del cronograma:
 * mismo run_type y horario más cercano; ante empate, la ronda final y luego el id de tanda más alto.
 * La hora de los feeds de resultados a veces difiere hasta un día de la del cronograma, así que
 * si el fin de semana tiene una sola sesión de ese tipo se acepta la tanda más cercana sin límite;
 * con varias (p. ej. Práctica 1/2/3 en Daytona) se exige una diferencia de hasta 6 horas para no
 * asignarle a una sesión los tiempos de otra.
 */
export function pickRun(
  runs: ApiRun[],
  runType: number,
  startUtc: string,
  sessionsOfType = 1,
): ApiRun | undefined {
  const target = Date.parse(startUtc);
  const maxDiff = sessionsOfType > 1 ? 6 * 3600_000 : Infinity;
  const scored = runs
    .filter((r) => r.run_type === runType && r.results?.length)
    .map((r) => {
      const t = r.run_date_utc ? Date.parse(nascarUtc(r.run_date_utc)) : NaN;
      return { r, diff: Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : Math.abs(t - target) };
    })
    .filter((x) => x.diff <= maxDiff)
    .sort(
      (a, b) =>
        Math.round((a.diff - b.diff) / 60_000) ||
        Number(/final round/i.test(b.r.run_name)) - Number(/final round/i.test(a.r.run_name)) ||
        (b.r.timing_run_id ?? 0) - (a.r.timing_run_id ?? 0),
    );
  return scored[0]?.r;
}

function isRaceLike(meta: SessionMeta, session: Session): boolean {
  return meta.runType === 3 || session.type === 'serie' || session.type === 'carrera';
}

async function standings(series: Series, ctx: AdapterContext): Promise<StandingsFile | undefined> {
  const n = seriesNumber(series);
  const base = `${NASCAR_CACHER}/${ctx.season}/${n}/final/${n}`;
  const driversUrl = `${base}-drivers-points.json`;
  const { body: drivers } = await ctx.http.json<ApiDriverPoints[]>(driversUrl);
  const driverRows: StandingsRow[] = (drivers ?? [])
    .filter((d) => d.position > 0 && d.driver_name?.trim())
    .map((d) => ({
      pos: d.position,
      name: d.driver_name.trim(),
      ...(d.car_no ? { number: d.car_no } : {}),
      points: d.points,
      ...(typeof d.wins === 'number' ? { wins: d.wins } : {}),
    }));
  if (driverRows.length === 0) return undefined;
  const tables: StandingsTable[] = [{ title: 'Pilotos', rows: driverRows }];

  try {
    const { body: owners } = await ctx.http.json<ApiOwnerPoints[]>(`${base}-owners-points.json`);
    const rows = (owners ?? [])
      .filter((o) => o.position > 0 && o.owner_name?.trim())
      .map((o) => ({
        pos: o.position,
        name: o.vehicle_number ? `${o.owner_name.trim()} #${o.vehicle_number}` : o.owner_name.trim(),
        ...(o.vehicle_number ? { number: o.vehicle_number } : {}),
        points: o.points,
        ...(typeof o.wins === 'number' ? { wins: o.wins } : {}),
      }));
    if (rows.length) tables.push({ title: 'Propietarios', rows });
  } catch (err) {
    ctx.log.warn(`Campeonato de propietarios: ${String(err)}`);
  }
  try {
    const { body: makers } = await ctx.http.json<ApiManufacturerPoints[]>(`${base}-manufacturer-points.json`);
    const rows = (makers ?? [])
      .map((m) => ({ ...m, position: Number(m.position) }))
      .filter((m) => Number.isInteger(m.position) && m.position > 0 && m.manufacturer?.trim())
      .map((m) => ({
        pos: m.position,
        name: m.manufacturer.trim(),
        points: m.points,
        ...(typeof m.wins === 'number' ? { wins: m.wins } : {}),
      }));
    if (rows.length) tables.push({ title: 'Marcas', rows });
  } catch (err) {
    ctx.log.warn(`Campeonato de marcas: ${String(err)}`);
  }

  return {
    seriesId: series.id,
    season: ctx.season,
    updatedAt: fetchedAt(ctx),
    tables,
    source: directSource(ctx, driversUrl, `NASCAR – puntos ${ctx.season} (${series.shortName})`),
  };
}

async function results(series: Series, ctx: AdapterContext, req: ResultsRequest): Promise<ResultsChunk> {
  const n = seriesNumber(series);
  const sched = await buildSchedule(series, ctx);
  const pending = req.pendingSessions.filter((s) => sched.meta.has(s.id)).slice(0, MAX_SESSIONS_PER_RUN);

  const byRace = new Map<number, Session[]>();
  for (const s of pending) {
    const id = sched.meta.get(s.id)!.raceId;
    byRace.set(id, [...(byRace.get(id) ?? []), s]);
  }

  const files: EventResultsFile[] = [];
  for (const [raceId, list] of byRace) {
    const url = weekendFeedUrl(ctx.season, n, raceId);
    let feed: ApiWeekendFeed;
    try {
      feed = (await ctx.http.json<ApiWeekendFeed>(url)).body;
    } catch (err) {
      ctx.log.warn(`Resultados de la carrera ${raceId}: ${String(err)}`);
      continue;
    }
    const race = feed.weekend_race?.[0];
    if (!race) continue;
    const teamByDriver = new Map<number, string>();
    for (const r of race.results ?? []) if (r.driver_id !== undefined && r.team_name) teamByDriver.set(r.driver_id, r.team_name);

    const file: EventResultsFile = { seriesId: series.id, eventId: list[0]!.eventId, updatedAt: fetchedAt(ctx), sessions: [] };
    for (const s of list) {
      const meta = sched.meta.get(s.id)!;
      let rows: ResultRow[];
      if (isRaceLike(meta, s)) rows = mapRaceResults(race);
      else {
        const sameType = [...sched.meta.values()].filter(
          (m) => m.raceId === raceId && m.runType === meta.runType,
        ).length;
        const run = pickRun(feed.weekend_runs ?? [], meta.runType, meta.startUtc, sameType);
        rows = run ? mapRunResults(run, teamByDriver) : [];
      }
      if (rows.length === 0) continue;
      file.sessions.push({
        sessionId: s.id,
        rows,
        source: directSource(ctx, url, `NASCAR – resultados ${race.race_name} (${s.name})`),
      });
    }
    if (file.sessions.length > 0) files.push(file);
  }

  const chunk: ResultsChunk = { results: files };
  if (req.standingsStale) {
    try {
      const st = await standings(series, ctx);
      if (st) chunk.standings = st;
    } catch (err) {
      ctx.log.warn(`Campeonato: ${String(err)}`);
    }
  }
  return chunk;
}

export const nascarAdapter: Adapter = {
  name: 'nascar',
  async schedule(series, ctx) {
    const { events, sessions } = await buildSchedule(series, ctx);
    return { events, sessions };
  },
  results,
};
