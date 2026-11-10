import path from 'node:path';
import {
  eventResultsFileSchema,
  standingsFileSchema,
  type EventResultsFile,
  type MotorEvent,
  type Series,
  type Session,
  type StandingsFile,
} from '@dm/shared';
import { readJson, writeJson } from './store.ts';
import type { Adapter, AdapterContext } from './types.ts';

/** Una sesión se considera terminada 30 minutos después de su fin publicado/estimado. */
const FINISH_GRACE_MS = 30 * 60_000;
/** Después de este número de intentos fallidos, una sesión de más de 5 días deja de buscarse. */
const MAX_ATTEMPTS = 5;
const RECENT_MS = 5 * 24 * 3600_000;

export type AttemptsLog = Record<string, { count: number; last: string }>;

export function pendingResultSessions(
  sessions: Session[],
  now: Date,
  attempts: AttemptsLog,
): Session[] {
  const nowMs = now.getTime();
  return sessions
    .filter((s) => !s.hasResults && Date.parse(s.endUtc) + FINISH_GRACE_MS < nowMs)
    .filter((s) => {
      const a = attempts[s.id];
      const recent = nowMs - Date.parse(s.endUtc) < RECENT_MS;
      return recent || !a || a.count < MAX_ATTEMPTS;
    })
    .sort((a, b) => b.startUtc.localeCompare(a.startUtc));
}

export function mergeEventResults(
  existing: EventResultsFile | null,
  incoming: EventResultsFile,
): EventResultsFile {
  const bySession = new Map((existing?.sessions ?? []).map((s) => [s.sessionId, s]));
  for (const s of incoming.sessions) if (s.rows.length > 0) bySession.set(s.sessionId, s);
  return { ...incoming, sessions: [...bySession.values()] };
}

export interface ResultsPhaseOutput {
  /** Ids de sesiones que ahora tienen resultado. */
  withResults: Set<string>;
  standingsAvailable: boolean;
}

/** Ejecuta adapter.results para una serie y escribe data/results y data/standings. */
export async function runResultsForSeries(
  series: Series,
  adapter: Adapter,
  ctx: AdapterContext,
  events: MotorEvent[],
  sessions: Session[],
  attempts: AttemptsLog,
  dataDir: string,
  dryRun: boolean,
): Promise<ResultsPhaseOutput> {
  const standingsFile = path.join(dataDir, 'standings', `${series.id}.json`);
  const existingStandings = await readJson<StandingsFile>(standingsFile, standingsFileSchema);
  const out: ResultsPhaseOutput = { withResults: new Set(), standingsAvailable: !!existingStandings };
  if (!adapter.results) return out;

  const pending = pendingResultSessions(sessions, ctx.now, attempts);
  const lastRaceEnd = sessions
    .filter((s) => s.type === 'carrera' && Date.parse(s.endUtc) < ctx.now.getTime())
    .map((s) => s.endUtc)
    .sort()
    .at(-1);
  const standingsStale =
    !existingStandings || (!!lastRaceEnd && lastRaceEnd > existingStandings.updatedAt);
  if (pending.length === 0 && !standingsStale) return out;

  const chunk = await adapter.results(series, ctx, { events, pendingSessions: pending, sessions, standingsStale });

  for (const file of chunk.results) {
    const target = path.join(dataDir, 'results', series.id, `${file.eventId}.json`);
    const merged = mergeEventResults(await readJson(target, eventResultsFileSchema), file);
    for (const s of merged.sessions) if (s.rows.length > 0) out.withResults.add(s.sessionId);
    if (!dryRun) await writeJson(target, eventResultsFileSchema.parse(merged));
  }
  const nowIso = ctx.now.toISOString();
  for (const s of pending) {
    if (out.withResults.has(s.id)) delete attempts[s.id];
    else attempts[s.id] = { count: (attempts[s.id]?.count ?? 0) + 1, last: nowIso };
  }
  if (chunk.standings) {
    if (!dryRun) await writeJson(standingsFile, standingsFileSchema.parse(chunk.standings));
    out.standingsAvailable = true;
  }
  return out;
}

/** Marca hasResults en las sesiones que tienen archivo de resultado ya escrito. */
export async function collectExistingResults(
  dataDir: string,
  events: MotorEvent[],
): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const e of events) {
    const file = await readJson<EventResultsFile>(path.join(dataDir, 'results', e.seriesId, `${e.id}.json`));
    for (const s of file?.sessions ?? []) if (s.rows.length > 0) ids.add(s.sessionId);
  }
  return ids;
}
