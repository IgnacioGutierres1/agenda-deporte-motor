/**
 * Resultados de IMSA (imsa.com) sin IA: la página /weathertech/results carga sus tablas de /api/imsa-results
 * (JSON), con una consulta por temporada, evento y sesión:
 *
 * - ?series_id=1&season_id=2026 -> eventos de la temporada (id, nombre, circuito) y las sesiones del último;
 * - …&event_id=335 -> sesiones del evento (id, nombre, tipo P/Q/R, día "Thursday October 01, 2026" y, en carrera,
 *   la duración "10:00:50.625") y la clasificación de la carrera;
 * - …&event_id=335&session_id=3352 -> la clasificación de esa sesión, un grupo por clase (GTP, LMP2, GTD Pro, GTD)
 *   con puesto general y en clase, auto, equipo, pilotos, vueltas, mejor vuelta y estado (Running / Not Running).
 *
 * Al terminar la temporada el sitio deja de publicar su calendario (/2026/schedule da 404 en noviembre), pero los
 * resultados siguen: el calendario de la temporada terminada se arma desde esta API (imsaResultsCalendar). La API
 * no da la hora de las sesiones, solo el día: las de las fechas ya corridas se ubican a una hora estimada.
 * Los PDF/CSV de Al Kamel (imsa.alkamelsystems.com) solo llegan hasta 2024.
 */
import { localToUtc, type ResultRow, type Session, type Source } from '@dm/shared';
import { HttpError } from '../core/http.ts';
import { normalizeForMatch } from '../validate.ts';
import { isoNow, obj, str, tzFor } from './kit.ts';
import { isoDate, monthNumber } from './places.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, ResultsFound, SessionResultFound, SessionsFound } from './types.ts';

const ORIGIN = 'https://www.imsa.com';
const IMSA_TEST = /\broar\b|\btest\b/i;

/** series_id de la API de resultados según el campeonato de la URL oficial (?series=…). */
export const IMSA_RESULTS_SERIES: Record<string, number> = { weathertech: 1 };

/** Página pública de resultados de cada campeonato (fuente que se muestra). */
const RESULTS_PAGE: Record<string, string> = { weathertech: `${ORIGIN}/weathertech/results` };

export function imsaResultsApi(seriesId: number, season: number, eventId?: number | string, sessionId?: number | string): string {
  const q = new URLSearchParams({ series_id: String(seriesId), season_id: String(season) });
  if (eventId !== undefined) q.set('event_id', String(eventId));
  if (sessionId !== undefined) q.set('session_id', String(sessionId));
  return `${ORIGIN}/api/imsa-results?${q.toString()}`;
}

export interface ImsaApiEvent {
  id: number;
  name: string;
  track: string;
}

export interface ImsaApiSession {
  id: number;
  name: string;
  /** P, Q o R. */
  type: string;
  /** Día local (YYYY-MM-DD). */
  date: string | null;
  /** Duración de la carrera ("10:00:50.625"). */
  raceTime?: string;
}

/**
 * JSON de la API. Se pide como texto para compartir la memoización con la lectura del calendario (fetchDocument)
 * y sin el proxy de respaldo: si el sitio rechaza al cliente, no se insiste por otro camino.
 */
export async function imsaApiJson(ctx: RecipeContext, url: string): Promise<unknown> {
  return JSON.parse((await ctx.http.text(url, { noProxy: true })).body) as unknown;
}

/** Eventos de una respuesta de la API (lanza un error si no tiene el formato esperado). */
export function imsaApiEvents(body: unknown): ImsaApiEvent[] {
  const o = obj(body);
  if (!Array.isArray(o.events)) throw new Error('IMSA: respuesta inesperada de /api/imsa-results (sin "events")');
  return o.events.map(obj).map((e) => ({ id: Number(e.id), name: str(e.name).trim(), track: str(obj(e.track).name).trim() })).filter((e) => e.id > 0 && e.name);
}

/** "Thursday October 01, 2026" -> "2026-10-01". */
function apiDate(text: string): string | null {
  const m = text.match(/([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/);
  const month = m ? monthNumber(m[1]!) : null;
  return m && month ? isoDate(Number(m[3]), month, Number(m[2])) : null;
}

/** Sesiones de un evento en la respuesta de la API (las del evento pedido). */
export function imsaApiSessions(body: unknown, eventId: number): ImsaApiSession[] {
  const o = obj(body);
  if (!Array.isArray(o.sessions)) throw new Error('IMSA: respuesta inesperada de /api/imsa-results (sin "sessions")');
  return o.sessions
    .map(obj)
    .filter((s) => Number(s.event_id) === eventId)
    .map((s) => {
      const raceTime = str(s.time_of_race).trim();
      return { id: Number(s.id), name: str(s.name).trim(), type: str(s.type).trim().toUpperCase(), date: apiDate(str(s.start_time)), ...(raceTime ? { raceTime } : {}) };
    })
    .filter((s) => s.id > 0 && s.name);
}

const TYPE_ORDER: Record<string, number> = { P: 0, Q: 1, R: 2 };

/** Zona del circuito: la API solo da el nombre de la pista. */
function trackZone(track: string): { tz: string; country: string } {
  if (/canadian tire|mosport|\bctmp\b/i.test(track)) return { tz: 'America/Toronto', country: 'Canada' };
  if (/laguna seca|long beach/i.test(track)) return { tz: 'America/Los_Angeles', country: 'United States' };
  if (/road america/i.test(track)) return { tz: 'America/Chicago', country: 'United States' };
  if (/detroit/i.test(track)) return { tz: 'America/Detroit', country: 'United States' };
  if (/indianapolis/i.test(track)) return { tz: 'America/Indiana/Indianapolis', country: 'United States' };
  return { tz: tzFor('United States', track, 'America/New_York'), country: 'United States' };
}

/**
 * Calendario de una temporada terminada desde la API de resultados: un evento por cada uno con sesiones, con las
 * fechas de sus sesiones (primer y último día). `meta.resultsEventId` guarda el id del evento en la API.
 */
export async function imsaResultsCalendar(body: unknown, seriesId: number, season: number, ctx: RecipeContext): Promise<CalendarEntry[]> {
  const out: CalendarEntry[] = [];
  for (const ev of imsaApiEvents(body)) {
    // Un evento que la API lista pero no responde (404) se omite; cualquier otro error corta la lectura (el
    // calendario a medias haría desaparecer fechas de una corrida a otra).
    let evBody: unknown;
    try {
      evBody = await imsaApiJson(ctx, imsaResultsApi(seriesId, season, ev.id));
    } catch (err) {
      if (err instanceof HttpError && err.status === 404) continue;
      throw err;
    }
    const sessions = imsaApiSessions(evBody, ev.id);
    const days = sessions.map((s) => s.date).filter((d): d is string => !!d && d.startsWith(String(season))).sort();
    if (days.length === 0) continue;
    const { tz, country } = trackZone(ev.track);
    out.push({
      name: ev.name.replace(/^The\s+/, ''),
      circuit: ev.track || ev.name,
      country,
      tz,
      dateStart: days[0]!,
      dateEnd: days.at(-1)!,
      meta: { resultsEventId: String(ev.id) },
    });
  }
  out.sort((a, b) => a.dateStart.localeCompare(b.dateStart));
  // Ronda = orden en el calendario, sin contar los ensayos (Roar Before the Rolex 24, test de pretemporada).
  let round = 0;
  for (const e of out) if (!IMSA_TEST.test(e.name)) e.round = ++round;
  return out;
}

/** Id del evento en la API: el guardado en el calendario o, si no, el de igual nombre (o circuito) de esa temporada. */
async function resultsEventId(entry: CalendarEntry, seriesId: number, season: number, ctx: RecipeContext): Promise<number | null> {
  const saved = Number(entry.meta?.resultsEventId);
  if (saved > 0) return saved;
  const events = imsaApiEvents(await imsaApiJson(ctx, imsaResultsApi(seriesId, season)));
  const key = (t: string) => normalizeForMatch(t.replace(/^the\s+/i, '')).replace(/[^a-z0-9]+/g, ' ').trim();
  const name = key(entry.name);
  const exact = events.find((e) => key(e.name) === name);
  if (exact) return exact.id;
  const similar = events.filter((e) => key(e.name).includes(name) || name.includes(key(e.name)));
  if (similar.length === 1) return similar[0]!.id;
  const circuit = key(entry.circuit);
  const byTrack = events.filter((e) => e.track && (key(e.track).includes(circuit) || circuit.includes(key(e.track))));
  return byTrack.length === 1 ? byTrack[0]!.id : null;
}

/** Sesión de la API que corresponde a una pedida: por nombre y, si no, por tipo (y día, si hay varias). */
function matchApiSession(s: Session, list: ImsaApiSession[], tz: string): ImsaApiSession | undefined {
  const wanted = [s.originalName, s.name].filter((x): x is string => !!x).map(normalizeForMatch);
  const byName = list.find((a) => wanted.includes(normalizeForMatch(a.name)));
  if (byName) return byName;
  const letter = s.type === 'carrera' ? 'R' : s.type === 'clasificacion' ? 'Q' : s.type === 'practica' ? 'P' : '';
  const same = list.filter((a) => a.type === letter);
  if (same.length === 1) return same[0];
  const day = new Date(s.startUtc).toLocaleDateString('en-CA', { timeZone: tz });
  const sameDay = same.filter((a) => a.date === day);
  return sameDay.length === 1 ? sameDay[0] : undefined;
}

/** "1:33.939" -> segundos. */
function lapSeconds(text: string): number | null {
  const m = text.trim().match(/^(?:(\d+):)?(\d{1,2}(?:\.\d+)?)$/);
  return m ? Number(m[1] ?? 0) * 60 + Number(m[2]) : null;
}

/**
 * Filas de la clasificación de una sesión (todas las clases, en el orden de la general). La API no da diferencias:
 * en carrera, el ganador lleva el tiempo total y los demás las vueltas que perdieron con la general; en prácticas
 * y clasificación, la diferencia con la mejor vuelta del primero de su clase. "Not Running" = abandono (DNF).
 */
export function imsaResultRows(body: unknown, session: Pick<ImsaApiSession, 'type' | 'raceTime'>): ResultRow[] {
  const o = obj(body);
  if (!Array.isArray(o.classes)) throw new Error('IMSA: respuesta inesperada de /api/imsa-results (sin "classes")');
  const lines = o.classes.map(obj).flatMap((c) => {
    const cls = str(c.shortcode).trim() || str(c.name).trim();
    return (Array.isArray(c.results) ? c.results : []).map(obj).map((r) => ({ cls, r }));
  });
  lines.sort((a, b) => Number(a.r.position) - Number(b.r.position));
  const race = session.type === 'R';
  const leaderLaps = race ? Number(lines[0]?.r.number_laps) : NaN;
  const classBest = new Map<string, number>();
  const rows: ResultRow[] = [];
  for (const { cls, r } of lines) {
    const car = obj(r.car);
    const team = typeof r.team === 'string' ? r.team : str(obj(r.team).name);
    const drivers = (Array.isArray(r.drivers) ? r.drivers : []).map((d) => str(obj(d).name).replace(/\s+/g, ' ').trim()).filter(Boolean);
    const pos = Number(r.position);
    const row: ResultRow = { pos: Number.isInteger(pos) && pos > 0 ? pos : null, driver: drivers.join(' / ') };
    const number = str(car.car_number).trim();
    if (number) row.number = number;
    if (team.trim()) row.team = team.trim();
    const vehicle = str(car.car_name).trim();
    if (vehicle) row.vehicle = vehicle;
    const laps = Number(r.number_laps);
    if (Number.isInteger(laps) && laps >= 0) row.laps = laps;
    const best = str(r.fastest_lap).trim();
    if (best) row.bestLap = best;
    if (cls) row.class = cls;
    const classPos = Number(r.class_position);
    if (Number.isInteger(classPos) && classPos > 0) row.classPos = classPos;
    if (/not\s+running/i.test(str(r.status))) row.status = 'DNF';
    if (race) {
      if (row.pos === 1 && session.raceTime) row.time = session.raceTime;
      else if (Number.isInteger(laps) && leaderLaps > laps) row.gap = `+${leaderLaps - laps} ${leaderLaps - laps === 1 ? 'Lap' : 'Laps'}`;
    } else {
      const secs = lapSeconds(best);
      if (secs !== null) {
        const top = classBest.get(cls);
        if (top === undefined) classBest.set(cls, secs);
        else row.gap = `+${(secs - top).toFixed(3)}`;
      }
    }
    if (!row.driver && !row.number) continue;
    rows.push(row);
  }
  return rows;
}

const CLASS_IN_NAME = /(GTP|LMP2|GTD Pro|GTD)s*$/i;

/**
 * Si el cronograma separa una sesión por clase ("Qualifying - GTD") y la API la publica junta ("Qualifying"), la
 * sesión pedida se queda solo con las filas de su clase.
 */
function onlyClass(rows: ResultRow[], s: Session, api: ImsaApiSession): ResultRow[] {
  const cls = (s.originalName ?? s.name).match(CLASS_IN_NAME)?.[1];
  if (!cls || CLASS_IN_NAME.test(api.name)) return rows;
  const want = cls.toLowerCase();
  return rows.filter((r) => r.class?.toLowerCase() === want);
}

/** Pedido para reintentar en otra corrida: el sitio responde 403 pasajeros tras muchos pedidos seguidos. */
const transient = (err: unknown) => !(err instanceof HttpError) || err.status === 403 || err.status === 429 || err.status >= 500;

/** Temporada de un evento (la API se consulta por año). */
const eventSeason = (entry: CalendarEntry) => Number(entry.dateStart.slice(0, 4));

/** Resultados de las sesiones pedidas de un evento. null si la API todavía no tiene el evento. */
export async function imsaResults(series: string, entry: CalendarEntry, sessions: Session[], ctx: RecipeContext): Promise<ResultsFound | null> {
  const seriesId = IMSA_RESULTS_SERIES[series];
  if (!seriesId) return null;
  const season = eventSeason(entry);
  const eventId = await resultsEventId(entry, seriesId, season, ctx);
  if (!eventId) return null;
  const list = imsaApiSessions(await imsaApiJson(ctx, imsaResultsApi(seriesId, season, eventId)), eventId);
  if (list.length === 0) return null;
  const fetchedAt = isoNow(ctx.now);
  const page = RESULTS_PAGE[series] ?? `${ORIGIN}/${series}/results`;
  const found: SessionResultFound[] = [];
  const deferred: string[] = [];
  for (const s of sessions) {
    const api = matchApiSession(s, list, entry.tz);
    if (!api) continue;
    let body: unknown;
    try {
      body = await imsaApiJson(ctx, imsaResultsApi(seriesId, season, eventId, api.id));
    } catch (err) {
      if (transient(err)) deferred.push(s.id);
      else if (!(err instanceof HttpError && err.status === 404)) throw err;
      continue;
    }
    const rows = onlyClass(imsaResultRows(body, api), s, api);
    if (rows.length === 0) continue;
    const source: Source = { url: page, title: `IMSA — ${entry.name}: ${api.name} (resultados)`, kind: 'api', method: 'directo', fetchedAt };
    found.push({ sessionId: s.id, rows, source });
  }
  return {
    sessions: found,
    source: { url: page, title: `IMSA — ${entry.name} (resultados)`, kind: 'api', method: 'directo', fetchedAt },
    ...(deferred.length ? { deferred } : {}),
  };
}

/**
 * Hora local estimada de la sesión n del día (la API solo da el día): 9:00, 11:00, 13:00…; la carrera, no antes
 * del mediodía.
 */
const estimatedClock = (n: number, race: boolean) => `${String(Math.min(Math.max(9 + 2 * n, race ? 12 : 0), 21)).padStart(2, '0')}:00`;

/**
 * Sesiones de un evento ya corrido desde la API de resultados, con los nombres de la API (los que reconoce
 * imsaResults). La API no da la hora: se ubican a una hora estimada del día (sin hora local publicada).
 */
export async function imsaPastSessions(series: string, entry: CalendarEntry, ctx: RecipeContext): Promise<SessionsFound | null> {
  const seriesId = IMSA_RESULTS_SERIES[series];
  if (!seriesId) return null;
  const season = eventSeason(entry);
  const eventId = await resultsEventId(entry, seriesId, season, ctx);
  if (!eventId) return null;
  const list = imsaApiSessions(await imsaApiJson(ctx, imsaResultsApi(seriesId, season, eventId)), eventId)
    .filter((s) => s.date)
    .sort((a, b) => a.date!.localeCompare(b.date!) || (TYPE_ORDER[a.type] ?? 9) - (TYPE_ORDER[b.type] ?? 9) || a.name.localeCompare(b.name));
  const perDay = new Map<string, number>();
  const sessions: ExtractedSession[] = list.map((s) => {
    const n = perDay.get(s.date!) ?? 0;
    perDay.set(s.date!, n + 1);
    return { name: s.name, startUtc: localToUtc(s.date!, estimatedClock(n, s.type === 'R'), entry.tz) };
  });
  if (sessions.length === 0) return null;
  return {
    sessions,
    source: { url: RESULTS_PAGE[series] ?? `${ORIGIN}/${series}/results`, title: `IMSA — ${entry.name} (resultados)`, kind: 'api', method: 'directo', fetchedAt: isoNow(ctx.now) },
  };
}
