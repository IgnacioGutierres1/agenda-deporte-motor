import type { MotorEvent, ScheduleFile, Series, SeriesStatus, Session, TimetableCoverage } from '@dm/shared';
import type { ScheduleChunk } from './types.ts';

export type SeriesOutcome =
  | { kind: 'ok'; chunk: ScheduleChunk }
  | { kind: 'error'; error: Error }
  | { kind: 'disabled' };

export interface MergeResult {
  events: MotorEvent[];
  sessions: Session[];
  statuses: SeriesStatus[];
}

/**
 * Fusiona lo leído en esta corrida con la corrida anterior:
 * - Serie OK: se reemplazan sus eventos/sesiones; si un horario cambió se marca changedAt/previousStartUtc;
 *   se conserva hasResults de las sesiones ya existentes.
 * - Serie con error: se conservan sus datos anteriores y queda en estado "stale" (o "error" si no había nada).
 * - Serie desactivada: no se publica.
 */
/** Un modelo de respaldo (no Gemini) que trae menos de esta fracción de las fechas anteriores no las reemplaza. */
const BACKUP_MIN_SHARE = 0.75;

/**
 * Si el calendario de esta corrida lo leyó un modelo de IA de respaldo (Groq…) y trae bastantes menos fechas que
 * la corrida anterior, es más probable que haya leído mal (p. ej. 4 de las 10 imágenes del calendario de Turismo
 * Pista) que que se hayan cancelado fechas: se conservan las anteriores y la serie queda "desactualizada".
 * Devuelve el motivo, o null si la lectura se puede usar.
 */
export function backupShrink(seriesId: string, chunk: ScheduleChunk, previous: ScheduleFile | null): string | null {
  const fresh = chunk.events;
  const model = fresh.find((e) => e.source.method === 'ia' && e.source.model)?.source.model;
  if (!model || /^gemini/i.test(model) || model.split(' + ').every((m) => /^gemini/i.test(m))) return null;
  // Solo contra fechas de los mismos años (al cambiar de temporada la cantidad no se compara).
  const years = new Set(fresh.map((e) => e.dateStart.slice(0, 4)));
  const old = (previous?.events ?? []).filter((e) => e.seriesId === seriesId && years.has(e.dateStart.slice(0, 4)));
  if (old.length < 3 || fresh.length >= old.length * BACKUP_MIN_SHARE) return null;
  return `Lectura con modelo de respaldo (${model}) incompleta: ${fresh.length} de ${old.length} fechas; se conservan las anteriores`;
}

const shiftDay = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** "A", "A y B", "A, B y C". */
const listNames = (names: string[]) => (names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} y ${names.at(-1)}`);

/**
 * Cobertura de cronogramas de una serie leída bien: de las fechas dentro del horizonte (el mismo que usa el flujo
 * genérico para buscar cronogramas: desde ayer hasta horizonDays días adelante), cuántas tienen sesiones. Si falta
 * alguno, el motivo legible ("todavía no publicó" o "no se pudo leer", según lo informe el lector).
 * null si no hay fechas en el horizonte.
 */
export function timetableCoverage(
  chunk: ScheduleChunk,
  todayIso: string,
  horizonDays: number,
): { timetables: TimetableCoverage; message?: string } | null {
  const today = todayIso.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null;
  const from = shiftDay(today, -1);
  const to = shiftDay(today, horizonDays);
  const due = chunk.events.filter((e) => e.dateEnd >= from && e.dateStart <= to);
  if (due.length === 0) return null;
  const withSessions = new Set(chunk.sessions.map((x) => x.eventId));
  const missing = due.filter((e) => !withSessions.has(e.id));
  const timetables = { found: due.length - missing.length, due: due.length };
  if (missing.length === 0) return { timetables };
  const reasons = new Map((chunk.missingTimetables ?? []).map((m) => [m.eventId, m.reason]));
  const unreadable = missing.filter((e) => reasons.get(e.id) === 'ilegible').map((e) => e.name);
  const unpublished = missing.filter((e) => reasons.get(e.id) !== 'ilegible').map((e) => e.name);
  const parts = [
    ...(unpublished.length ? [`El organizador todavía no publicó el cronograma de ${listNames(unpublished)}`] : []),
    ...(unreadable.length ? [`No se pudo leer el cronograma de ${listNames(unreadable)}`] : []),
  ];
  return { timetables, message: `${parts.join('. ')}.` };
}

export function mergeRun(
  series: Series[],
  outcomes: Map<string, SeriesOutcome>,
  previous: ScheduleFile | null,
  previousStatus: Map<string, SeriesStatus>,
  nowIso: string,
  horizonDays = 21,
): MergeResult {
  const prevSessions = new Map((previous?.sessions ?? []).map((s) => [s.id, s]));
  const events: MotorEvent[] = [];
  const sessions: Session[] = [];
  const statuses: SeriesStatus[] = [];

  for (const s of series) {
    const outcome = outcomes.get(s.id) ?? { kind: 'disabled' as const };
    const prevStatus = previousStatus.get(s.id);
    const sourceUrl = s.officialUrls[0];
    const standingsAvailable = prevStatus?.standingsAvailable ?? false;

    if (outcome.kind === 'disabled') {
      statuses.push({ seriesId: s.id, state: 'disabled', lastAttempt: nowIso, sourceUrl, standingsAvailable });
      continue;
    }

    const shrunk = outcome.kind === 'ok' ? backupShrink(s.id, outcome.chunk, previous) : null;
    if (outcome.kind === 'error' || shrunk) {
      const reason = outcome.kind === 'error' ? outcome.error.message : shrunk!;
      const oldEvents = (previous?.events ?? []).filter((e) => e.seriesId === s.id);
      const oldSessions = (previous?.sessions ?? []).filter((x) => x.seriesId === s.id);
      events.push(...oldEvents);
      sessions.push(...oldSessions);
      statuses.push({
        seriesId: s.id,
        state: oldEvents.length > 0 ? 'stale' : 'error',
        lastAttempt: nowIso,
        ...(prevStatus?.lastSuccess ? { lastSuccess: prevStatus.lastSuccess } : {}),
        message: reason,
        sourceUrl,
        standingsAvailable,
      });
      continue;
    }

    events.push(...outcome.chunk.events);
    for (const fresh of outcome.chunk.sessions) {
      const old = prevSessions.get(fresh.id);
      const merged: Session = { ...fresh, hasResults: fresh.hasResults || (old?.hasResults ?? false) };
      if (old && old.startUtc !== fresh.startUtc) {
        merged.changedAt = nowIso;
        merged.previousStartUtc = old.startUtc;
      } else if (old?.changedAt) {
        merged.changedAt = old.changedAt;
        if (old.previousStartUtc) merged.previousStartUtc = old.previousStartUtc;
      }
      sessions.push(merged);
    }
    const coverage = timetableCoverage(outcome.chunk, nowIso, horizonDays);
    statuses.push({
      seriesId: s.id,
      state: 'ok',
      lastAttempt: nowIso,
      lastSuccess: nowIso,
      ...(coverage?.message ? { message: coverage.message } : {}),
      sourceUrl,
      standingsAvailable,
      ...(coverage ? { timetables: coverage.timetables } : {}),
    });
  }

  events.sort((a, b) => a.dateStart.localeCompare(b.dateStart) || a.seriesId.localeCompare(b.seriesId));
  sessions.sort((a, b) => a.startUtc.localeCompare(b.startUtc) || a.seriesId.localeCompare(b.seriesId));
  return { events, sessions, statuses };
}
