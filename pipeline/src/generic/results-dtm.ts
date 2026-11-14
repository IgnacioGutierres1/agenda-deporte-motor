/**
 * DTM: resultados de todas las sesiones desde la API oficial de dtm.com (la misma consulta que usa
 * www.dtm.com/en/results): https://api.dtm.com/data?query=wigeResults&raceSeries=DTM&startDate=…&endDate=…
 * devuelve un registro por sesión con resultado ({ wigeEventId, startDate, endDate, sessionId, jsonText }), y en
 * jsonText la lista de sesiones del evento (sessions[]: sessionid, name, type, timeStart) y la clasificación
 * (result[]: position, number, name "APELLIDO Nombre", team, car, laps, time, gap, fastestlap, status, totalpoints).
 * Los datos los cronometra WIGE Solutions. Una sola consulta por temporada (memoizada por la corrida).
 */
import { toUtcIso, type ResultRow, type Session } from '@dm/shared';
import { dtmDriverName } from './recipes.ts';
import { dtmRoster } from './rosters.ts';
import { obj, str } from './kit.ts';
import { directSource, driverCase, lapsGap, pickSession, timeGap, type SourceSession } from './results-euro.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, ResultsFound, SessionResultFound, SessionsFound } from './types.ts';

const RESULTS_PAGE = 'https://www.dtm.com/en/results';
/** Sesiones del programa que no son de la categoría ni tienen clasificación propia. */
const NOT_A_SESSION = /safari|pit\s*stop|challenge|parade|autogra/i;

interface DtmSessionRecord {
  eventId: string;
  startDate: string;
  endDate: string;
  name: string;
  type: string;
  startUtc?: string;
  result: Record<string, unknown>[];
}

const resultsUrl = (season: number) =>
  `https://api.dtm.com/data?query=wigeResults&raceSeries=DTM&startDate=${season}-01-01&endDate=${season}-12-31`;

/** Registros de la API: uno por sesión con resultado. Lanza un error si la respuesta no tiene el formato esperado. */
export function dtmSessionRecords(data: unknown): DtmSessionRecord[] {
  const list = obj(data).wigeResultses;
  if (!Array.isArray(list)) throw new Error('DTM: la API de resultados no devolvió wigeResultses');
  const out: DtmSessionRecord[] = [];
  for (const raw of list.map(obj)) {
    let doc: Record<string, unknown>;
    try {
      doc = obj(JSON.parse(str(raw.jsonText)));
    } catch {
      continue;
    }
    const sessions = ((doc.sessions as unknown[] | undefined) ?? []).map(obj);
    const own = sessions.find((s) => str(s.sessionid) === str(doc.sessionid));
    const name = str(own?.name).trim();
    if (!name || NOT_A_SESSION.test(name)) continue;
    out.push({
      eventId: str(raw.wigeEventId),
      startDate: str(raw.startDate).slice(0, 10),
      endDate: str(raw.endDate).slice(0, 10),
      name,
      type: str(own?.type),
      ...(str(own?.timeStart) ? { startUtc: toUtcIso(str(own?.timeStart).replace(/\.\d+Z$/, 'Z')) } : {}),
      result: ((doc.result as unknown[] | undefined) ?? []).map(obj),
    });
  }
  return out;
}

/** Registros del evento del calendario: los del evento de WIGE cuyas fechas se superponen con las del calendario. */
function eventRecords(records: DtmSessionRecord[], entry: CalendarEntry): DtmSessionRecord[] {
  const ids = new Set(records.filter((r) => r.startDate <= entry.dateEnd && r.endDate >= entry.dateStart).map((r) => r.eventId));
  if (ids.size !== 1) return [];
  return records.filter((r) => ids.has(r.eventId));
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/**
 * Nombre del piloto como en la lista de pilotos de dtm.com ("Kelvin van der Linde") si el número coincide y el
 * apellido también; si no, el de la API de resultados ("VAN DER LINDE Kelvin") con el apellido en formato título.
 */
function driverName(raw: string, number: string, roster: Map<string, string>): string {
  const surname = raw.replace(/\s+/g, ' ').trim().match(/^((?:[\p{Lu}'’.-]{2,}\s+)*[\p{Lu}'’.-]{2,})\s/u)?.[1] ?? '';
  const known = roster.get(number);
  if (known && surname && fold(known).includes(fold(surname))) return known;
  return driverCase(dtmDriverName(raw));
}

/** Filas de una sesión. Los autos que abandonan figuran con puesto en la API; acá quedan sin puesto y con su estado. */
export function dtmRows(record: Pick<DtmSessionRecord, 'type' | 'result'>, roster: Map<string, string> = new Map()): ResultRow[] {
  const race = record.type === 'race';
  const sorted = [...record.result].sort((a, b) => (Number(a.position) || 999) - (Number(b.position) || 999));
  const rows: ResultRow[] = [];
  for (const r of sorted) {
    const driver = driverName(str(r.name), str(r.number), roster);
    if (!driver) continue;
    const status = str(r.status).trim().toUpperCase();
    const pos = !status && Number(r.position) > 0 ? Number(r.position) : null;
    const row: ResultRow = { pos, driver };
    if (pos === null) row.status = status || 'NC';
    if (str(r.number)) row.number = str(r.number);
    if (str(r.team)) row.team = str(r.team).trim();
    if (str(r.car)) row.vehicle = str(r.car).trim();
    if (typeof r.laps === 'number') row.laps = r.laps;
    if (race) {
      const gap = str(r.gap).trim();
      const lapsDown = gap.match(/^(\d+)\s*L$/i);
      if (pos === 1 && str(r.time)) row.time = str(r.time);
      else if (pos !== null && lapsDown) row.gap = lapsGap(Number(lapsDown[1]));
      else if (pos !== null && timeGap(gap)) row.gap = timeGap(gap);
      if (str(r.fastestlap)) row.bestLap = str(r.fastestlap);
      const points = Number(str(r.totalpoints));
      if (str(r.totalpoints) && Number.isFinite(points)) row.points = points;
    } else {
      const best = str(r.fastestlap) || str(r.time);
      if (best) row.time = best;
    }
    rows.push(row);
  }
  return rows;
}

async function seasonRecords(ctx: RecipeContext): Promise<DtmSessionRecord[]> {
  return dtmSessionRecords((await ctx.http.json<unknown>(resultsUrl(ctx.season))).body);
}

/** Sesiones de una fecha ya corrida: las que tienen resultado en la API, con su hora oficial de inicio. */
export async function dtmPastSessions(entry: CalendarEntry, ctx: RecipeContext): Promise<SessionsFound | null> {
  const records = eventRecords(await seasonRecords(ctx), entry);
  const sessions: ExtractedSession[] = records
    .filter((r) => r.startUtc)
    .sort((a, b) => a.startUtc!.localeCompare(b.startUtc!))
    .map((r) => ({ name: r.name, startUtc: r.startUtc! }));
  if (sessions.length === 0) return null;
  return { sessions, source: directSource(RESULTS_PAGE, `Resultados DTM — ${entry.name}`, 'api', ctx) };
}

export async function dtmResults(entry: CalendarEntry, sessions: Session[], ctx: RecipeContext): Promise<ResultsFound | null> {
  const records = eventRecords(await seasonRecords(ctx), entry);
  if (records.length === 0) return null;
  const roster = new Map<string, string>();
  try {
    for (const r of (await dtmRoster('https://api.dtm.com/data?query=drivers', ctx))?.rows ?? []) if (r.number) roster.set(r.number, r.driver);
  } catch {
    // Sin la lista de pilotos se usan los nombres de la API de resultados.
  }
  const all: SourceSession[] = records.map((r) => ({ name: r.name, ...(r.startUtc ? { startUtc: r.startUtc } : {}) }));
  const out: SessionResultFound[] = [];
  for (const r of records) {
    const target = pickSession(sessions, { name: r.name, ...(r.startUtc ? { startUtc: r.startUtc } : {}) }, all);
    if (!target || out.some((o) => o.sessionId === target.id)) continue;
    const rows = dtmRows(r, roster);
    if (rows.length > 0) out.push({ sessionId: target.id, rows });
  }
  return { sessions: out, source: directSource(RESULTS_PAGE, `Resultados DTM — ${entry.name}`, 'api', ctx) };
}
