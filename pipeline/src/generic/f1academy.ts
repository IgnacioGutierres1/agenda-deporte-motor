/**
 * F1 Academy: sesiones de un evento cuando el calendario de f1academy.com todavía las marca "Unconfirmed"
 * (con horas de relleno, p. ej. 01:00 de todos los días). Se leen de las filas "F1 ACADEMY" del cronograma
 * oficial del fin de semana de formula1.com (ver adapters/f1-timetable.ts), con los nombres que usa el calendario
 * de la categoría ("Free Practice", "Reverse Grid Race"…) para que los ids no cambien cuando lo confirme.
 */
import { localToUtc, toUtcIso } from '@dm/shared';
import { classifySession } from '../core/builders.ts';
import { f1WeekendTimetable, pairByType, rowsFor, timetableSource } from '../adapters/f1-timetable.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, SessionsFound } from './types.ts';

/** Clave de CalendarEntry.meta con los nombres de las sesiones previstas, separados por "|". */
export const PLANNED_SESSIONS = 'plannedSessions';

/**
 * UTC de un horario del calendario de f1academy.com ("2026-08-21T14:00:00+01:00"). La hora local es la correcta
 * (coincide con el cronograma oficial de formula1.com), pero el offset es siempre el de invierno: Zandvoort en
 * agosto figura +01:00 en lugar de +02:00. Por eso se toma la hora local y se convierte con la zona del circuito.
 */
export function f1AcademyUtc(iso: string, tz: string): string {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? localToUtc(m[1]!, m[2]!, tz) : toUtcIso(iso);
}

export async function f1AcademyWeekendSessions(entry: CalendarEntry, ctx: RecipeContext): Promise<SessionsFound | null> {
  // Si formula1.com falla, el flujo genérico sigue con la página del evento como cualquier otra serie.
  const timetable = await f1WeekendTimetable(ctx.http, ctx.season, entry.dateStart, entry.dateEnd).catch(() => null);
  if (!timetable) return null;
  const rows = rowsFor(timetable, /f1\s*academy/i);
  if (rows.length === 0) return null;
  const planned = (entry.meta?.[PLANNED_SESSIONS] ?? '')
    .split('|')
    .filter(Boolean)
    .map((name) => ({ name }));
  const pairs = planned.length > 0 ? pairByType(planned, (p) => classifySession(p.name), rows) : null;
  const nameOf = new Map([...(pairs ?? [])].map(([p, row]) => [row, p.name]));
  const sessions: ExtractedSession[] = rows.map((r) => ({
    name: nameOf.get(r) ?? r.name,
    startUtc: r.startUtc,
    ...(r.endUtc ? { endUtc: r.endUtc } : {}),
    localStartText: r.localStartText,
  }));
  return { sessions, source: timetableSource(timetable, 'F1 Academy', ctx.now) };
}
