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
/**
 * Los sitios oficiales suelen actualizar el campeonato horas o días después de la carrera:
 * durante este lapso tras la última carrera el campeonato se vuelve a leer en cada corrida.
 */
const STANDINGS_REFRESH_MS = 3 * 24 * 3600_000;
/** Red de seguridad: un campeonato de más de una semana se relee siempre. */
const STANDINGS_MAX_AGE_MS = 7 * 24 * 3600_000;

export type AttemptsLog = Record<string, { count: number; last: string }>;

/**
 * true si hay que (re)leer el campeonato: no existe, tiene más de una semana, es anterior a la última
 * carrera terminada o la última carrera terminó hace menos de STANDINGS_REFRESH_MS.
 * La última carrera sale de las sesiones de carrera; si el cronograma no se conoce ("a confirmar",
 * frecuente en las categorías nacionales), del último día de los eventos ya terminados.
 * (Con IA no gasta cupo de más: la caché por hash del documento evita llamar a Gemini si la página no cambió.)
 */
export function standingsStale(
  existing: Pick<StandingsFile, 'updatedAt'> | null,
  sessions: Session[],
  events: Pick<MotorEvent, 'dateEnd'>[],
  now: Date,
): boolean {
  if (!existing) return true;
  const nowMs = now.getTime();
  const updated = Date.parse(existing.updatedAt);
  if (nowMs - updated > STANDINGS_MAX_AGE_MS) return true;
  const ends = [
    ...sessions.filter((s) => s.type === 'carrera').map((s) => Date.parse(s.endUtc)),
    ...events.map((e) => Date.parse(`${e.dateEnd}T23:59:59Z`)),
  ].filter((t) => t < nowMs);
  const lastRaceEnd = Math.max(...ends, -Infinity);
  if (!Number.isFinite(lastRaceEnd)) return false;
  return updated < lastRaceEnd || nowMs - lastRaceEnd < STANDINGS_REFRESH_MS;
}

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

/** Intentos que recupera una sesión abandonada cuando el lector de su serie mejoró después. */
const RETRIES_AFTER_FIX = 2;

/**
 * Sesiones abandonadas (MAX_ATTEMPTS intentos fallidos) cuyo último intento es anterior a `since` (el último arreglo
 * del lector): se les devuelven RETRIES_AFTER_FIX intentos. Como cada intento actualiza `last`, el ajuste se
 * aplica una sola vez: si vuelven a fallar quedan abandonadas de nuevo. Devuelve cuántas se reactivaron.
 */
export function retryAfterReaderFix(attempts: AttemptsLog, sessions: Pick<Session, 'id'>[], since: string): number {
  const sinceMs = Date.parse(since);
  if (!Number.isFinite(sinceMs)) return 0;
  let n = 0;
  for (const s of sessions) {
    const a = attempts[s.id];
    if (!a || a.count < MAX_ATTEMPTS || !(Date.parse(a.last) < sinceMs)) continue;
    attempts[s.id] = { count: MAX_ATTEMPTS - RETRIES_AFTER_FIX, last: a.last };
    n++;
  }
  return n;
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

  if (adapter.resultsReaderSince) {
    const revived = retryAfterReaderFix(attempts, sessions, adapter.resultsReaderSince);
    if (revived > 0) ctx.log.info(`${revived} sesión(es) sin resultado se vuelven a buscar con el lector actualizado`);
  }
  const pending = pendingResultSessions(sessions, ctx.now, attempts);
  // Una tabla leída con IA se reemplaza por la lectura directa en cuanto el sitio tiene receta (p. ej. GT World
  // Challenge, que antes se leía con Gemini y solo traía la tabla de equipos).
  const upgrade = existingStandings?.source.method === 'ia' && !!adapter.prefersDirectStandings?.(series);
  const stale = upgrade || standingsStale(existingStandings, sessions, events, ctx.now);
  if (pending.length === 0 && !stale) return out;

  const chunk = await adapter.results(series, ctx, { events, pendingSessions: pending, sessions, standingsStale: stale });

  for (const file of chunk.results) {
    const target = path.join(dataDir, 'results', series.id, `${file.eventId}.json`);
    const merged = mergeEventResults(await readJson(target, eventResultsFileSchema), file);
    for (const s of merged.sessions) if (s.rows.length > 0) out.withResults.add(s.sessionId);
    if (!dryRun) await writeJson(target, eventResultsFileSchema.parse(merged));
  }
  const nowIso = ctx.now.toISOString();
  const deferred = new Set(chunk.deferred ?? []);
  for (const s of pending) {
    if (out.withResults.has(s.id)) delete attempts[s.id];
    else if (deferred.has(s.id)) continue;
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
