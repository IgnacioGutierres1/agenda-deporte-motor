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

    if (outcome.kind === 'error') {
      const oldEvents = (previous?.events ?? []).filter((e) => e.seriesId === s.id);
      const oldSessions = (previous?.sessions ?? []).filter((x) => x.seriesId === s.id);
      events.push(...oldEvents);
      sessions.push(...oldSessions);
      statuses.push({
        seriesId: s.id,
        state: oldEvents.length > 0 ? 'stale' : 'error',
        lastAttempt: nowIso,
        ...(prevStatus?.lastSuccess ? { lastSuccess: prevStatus.lastSuccess } : {}),
        message: outcome.error.message,
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
