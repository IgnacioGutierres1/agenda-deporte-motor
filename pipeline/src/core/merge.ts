import type { MotorEvent, ScheduleFile, Series, SeriesStatus, Session } from '@dm/shared';
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

export function mergeRun(
  series: Series[],
  outcomes: Map<string, SeriesOutcome>,
  previous: ScheduleFile | null,
  previousStatus: Map<string, SeriesStatus>,
  nowIso: string,
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
    statuses.push({ seriesId: s.id, state: 'ok', lastAttempt: nowIso, lastSuccess: nowIso, sourceUrl, standingsAvailable });
  }

  events.sort((a, b) => a.dateStart.localeCompare(b.dateStart) || a.seriesId.localeCompare(b.seriesId));
  sessions.sort((a, b) => a.startUtc.localeCompare(b.startUtc) || a.seriesId.localeCompare(b.seriesId));
  return { events, sessions, statuses };
}
