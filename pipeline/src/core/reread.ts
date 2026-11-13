/**
 * Relectura de resultados ya publicados cuando el lector de una categoría se arregla y la lectura vieja perdía un
 * dato (p. ej. F1: "NC" sin distinguir abandono de "no largó"). Lo declara el lector en Adapter.resultsReread y lo
 * aplica runResultsForSeries (core/results.ts): las sesiones elegidas se piden junto con las pendientes y la lectura
 * nueva reemplaza a la publicada.
 */
import path from 'node:path';
import type { EventResultsFile, MotorEvent, Session, SessionResult } from '@dm/shared';
import { readJson } from './store.ts';

export interface ResultsReread {
  /**
   * ISO UTC hasta el que se relee: solo las lecturas anteriores (source.fetchedAt). Conviene una fecha posterior a la
   * publicación del arreglo; mientras tanto, una sesión que después de releerse sigue cumpliendo `matches` se relee
   * en cada corrida.
   */
  before: string;
  /** true si el resultado publicado tiene el dato que el lector viejo leía mal. */
  matches(session: Session, published: SessionResult): boolean;
}

/** Sesiones con resultado publicado de la categoría que el lector pide volver a leer. */
export async function sessionsToReread(
  dataDir: string,
  seriesId: string,
  events: MotorEvent[],
  sessions: Session[],
  reread: ResultsReread,
): Promise<Session[]> {
  const byId = new Map(sessions.map((s) => [s.id, s]));
  const out: Session[] = [];
  for (const e of events) {
    if (e.seriesId !== seriesId) continue;
    const file = await readJson<EventResultsFile>(path.join(dataDir, 'results', seriesId, `${e.id}.json`));
    for (const published of file?.sessions ?? []) {
      const session = byId.get(published.sessionId);
      if (session && published.source.fetchedAt < reread.before && reread.matches(session, published)) out.push(session);
    }
  }
  return out;
}
