/**
 * F1 Academy: resultados de cada sesión desde la página oficial de resultados del evento
 * (https://www.f1academy.com/Racing-Series/Results?raceid=N, la URL del evento en el calendario). Es una página de
 * Next.js: __NEXT_DATA__ trae pageData.SessionResults[] con SessionName, SessionStartTime/EndTime (hora local con
 * offset), SessionType (PRACTICE, QUALIFYING, RESULT) y Results[] (FinishPosition, DriverForename/Surname, TeamName,
 * CarNumber, LapsCompleted, TimeOrFinishReason, Gap, Best, ResultStatus, DisplayFinishPosition).
 *
 * No es la misma plataforma que F2/F3 (fiaformula2.com pasó a otro sitio y sus resultados se leen con el adaptador
 * fia-junior, del payload RSC y de los PDF de la FIA): acá todo sale de esta página, una por evento.
 */
import type { ResultRow, Session } from '@dm/shared';
import { extractEmbeddedJson } from '../extract/html.ts';
import { f1AcademyUtc } from './f1academy.ts';
import { findObject, obj, str } from './kit.ts';
import { directSource, isTransient, lapsGap, pickSession, timeGap, type SourceSession } from './results-euro.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, ResultsFound, SessionResultFound, SessionsFound } from './types.ts';

interface F1aSession {
  name: string;
  type: string;
  startUtc?: string;
  endUtc?: string;
  localStartText?: string;
  available: boolean;
  results: Record<string, unknown>[];
}

/** Sesiones de la página de resultados (pageData.SessionResults). Lanza un error si la página no las trae. */
export function f1AcademySessions(html: string, tz: string): F1aSession[] {
  let data: Record<string, unknown> | null = null;
  for (const value of extractEmbeddedJson(html)) {
    data = findObject(value, (o) => Array.isArray(o.SessionResults));
    if (data) break;
  }
  if (!data) throw new Error('F1 Academy: la página de resultados no trae SessionResults');
  return (data.SessionResults as unknown[]).map(obj).map((s) => {
    const start = str(s.SessionStartTime);
    const end = str(s.SessionEndTime);
    return {
      name: str(s.SessionName).trim(),
      type: str(s.SessionType).toUpperCase(),
      ...(start ? { startUtc: f1AcademyUtc(start, tz), localStartText: start.slice(11, 16) } : {}),
      ...(end ? { endUtc: f1AcademyUtc(end, tz) } : {}),
      available: s.SessionResultsAvailable === true && s.HideSessionResult !== true && s.Unconfirmed !== true,
      results: ((s.Results as unknown[] | undefined) ?? []).map(obj),
    };
  });
}

/** "Alisha " + "Palmowski" -> "Alisha Palmowski"; "Shi (WCD)" (wildcard) -> "Shi". */
function driverName(r: Record<string, unknown>): string {
  const last = str(r.DriverSurname).replace(/\s*\([^)]*\)\s*/g, ' ');
  return `${str(r.DriverForename)} ${last}`.replace(/\s+/g, ' ').trim();
}

const STATUS: Record<string, string> = { RET: 'DNF', DNF: 'DNF', DNS: 'DNS', DSQ: 'DSQ', DQ: 'DSQ', EXC: 'DSQ', NC: 'NC' };

export function f1AcademyRows(session: Pick<F1aSession, 'type' | 'results'>): ResultRow[] {
  const race = session.type === 'RESULT';
  const sorted = [...session.results].sort((a, b) => (Number(a.FinishPosition) || 999) - (Number(b.FinishPosition) || 999));
  const rows: ResultRow[] = [];
  for (const r of sorted) {
    const driver = driverName(r);
    if (!driver) continue;
    const display = str(r.DisplayFinishPosition).trim().toUpperCase();
    const classified = /^\d+$/.test(display) && Number(r.FinishPosition) > 0;
    const row: ResultRow = { pos: classified ? Number(r.FinishPosition) : null, driver };
    if (!classified) row.status = STATUS[display] ?? STATUS[str(r.ResultStatus).toUpperCase()] ?? 'NC';
    if (str(r.CarNumber)) row.number = str(r.CarNumber);
    if (str(r.TeamName)) row.team = str(r.TeamName).trim();
    if (typeof r.LapsCompleted === 'number') row.laps = r.LapsCompleted;
    const time = str(r.TimeOrFinishReason).trim();
    if (race) {
      const gap = str(r.Gap).trim();
      const lapsDown = gap.match(/^\+?(\d+)\s*laps?$/i);
      if (row.pos === 1 && time) row.time = time;
      else if (row.pos !== null && lapsDown) row.gap = lapsGap(Number(lapsDown[1]));
      else if (row.pos !== null && timeGap(gap)) row.gap = timeGap(gap);
      if (str(r.Best)) row.bestLap = str(r.Best);
    } else if (/\d/.test(time)) {
      row.time = time;
    }
    rows.push(row);
  }
  return rows;
}

async function readPage(entry: CalendarEntry, ctx: RecipeContext): Promise<F1aSession[] | null> {
  if (!entry.url || !/[?&]raceid=\d+/i.test(entry.url)) return null;
  return f1AcademySessions((await ctx.http.text(entry.url)).body, entry.tz);
}

/**
 * Sesiones de una fecha ya corrida, de la página de resultados: mismos nombres y horas que el calendario oficial
 * (los dos salen de la misma base), así los ids coinciden con los que se habrían leído dentro del horizonte.
 */
export async function f1AcademyPastSessions(entry: CalendarEntry, ctx: RecipeContext): Promise<SessionsFound | null> {
  const page = await readPage(entry, ctx);
  const sessions: ExtractedSession[] = (page ?? [])
    .filter((s) => s.startUtc && s.name)
    .map((s) => ({
      name: s.name,
      startUtc: s.startUtc!,
      ...(s.endUtc ? { endUtc: s.endUtc } : {}),
      ...(s.localStartText ? { localStartText: s.localStartText } : {}),
    }));
  if (sessions.length === 0) return null;
  return { sessions, source: directSource(entry.url!, `Resultados F1 Academy — ${entry.name}`, 'html', ctx) };
}

export async function f1AcademyResults(entry: CalendarEntry, sessions: Session[], ctx: RecipeContext): Promise<ResultsFound | null> {
  let page: F1aSession[] | null;
  try {
    page = await readPage(entry, ctx);
  } catch (err) {
    if (isTransient(err)) return { sessions: [], source: directSource(entry.url!, `Resultados F1 Academy — ${entry.name}`, 'html', ctx), deferred: sessions.map((s) => s.id) };
    throw err;
  }
  if (!page) return null;
  const published = page.filter((s) => s.available && s.results.length > 0);
  if (published.length === 0) return null;
  const all: SourceSession[] = page.map((s) => ({ name: s.name, ...(s.startUtc ? { startUtc: s.startUtc } : {}) }));
  const out: SessionResultFound[] = [];
  for (const s of published) {
    const target = pickSession(sessions, { name: s.name, ...(s.startUtc ? { startUtc: s.startUtc } : {}) }, all);
    if (!target || out.some((o) => o.sessionId === target.id)) continue;
    const rows = f1AcademyRows(s);
    if (rows.length > 0) out.push({ sessionId: target.id, rows });
  }
  return { sessions: out, source: directSource(entry.url!, `Resultados F1 Academy — ${entry.name}`, 'html', ctx) };
}
