/**
 * Índice de pilotos (data/drivers.json) para la sección "Pilotos" de la app.
 *
 * Se arma con lo que ya está publicado: las tablas de campeonato de pilotos de cada categoría
 * y los resultados de carreras/sprints. Un mismo piloto en varias categorías (p. ej. Canapino en
 * TC, TC Pick Up y TN) queda como una sola ficha, unido por las palabras de su nombre.
 * No usa IA ni descarga nada.
 */
import path from 'node:path';
import {
  driverDisplayName,
  driverId,
  isDriverTable,
  isSingleDriverName,
  nameQuality,
  type Driver,
  type DriversFile,
  type EventResultsFile,
  type MotorEvent,
  type Series,
  type Session,
  type StandingsFile,
} from '@dm/shared';
import { readJson } from './store.ts';

/** Resultados recientes que se guardan por piloto. */
export const RECENT_RESULTS = 6;
const RACE_TYPES = new Set(['carrera', 'sprint']);

interface Building extends Driver {
  /** Calidad de la variante del nombre que se está mostrando. */
  quality: number;
}

export function buildDrivers(input: {
  series: Series[];
  standings: StandingsFile[];
  results: EventResultsFile[];
  sessions: Session[];
  generatedAt: string;
}): DriversFile {
  const order = new Map(input.series.map((s, i) => [s.id, i]));
  const drivers = new Map<string, Building>();

  const get = (rawName: string): Building | null => {
    if (!isSingleDriverName(rawName)) return null;
    const id = driverId(rawName);
    if (!id) return null;
    let d = drivers.get(id);
    const quality = nameQuality(rawName);
    if (!d) {
      d = { id, name: driverDisplayName(rawName), entries: [], recent: [], quality };
      drivers.set(id, d);
    } else if (quality > d.quality) {
      d.name = driverDisplayName(rawName);
      d.quality = quality;
    }
    return d;
  };

  for (const file of input.standings) {
    const tables = file.tables.filter((t) => isDriverTable(t.title));
    for (const table of tables) {
      for (const row of table.rows) {
        const d = get(row.name);
        if (!d) continue;
        // Si aparece dos veces en la misma tabla (homónimos), se queda la mejor posición.
        if (d.entries.some((e) => e.seriesId === file.seriesId && e.table === (tables.length > 1 ? table.title : undefined))) continue;
        d.entries.push({
          seriesId: file.seriesId,
          ...(tables.length > 1 ? { table: table.title } : {}),
          pos: row.pos,
          points: row.points,
          ...(row.wins !== undefined ? { wins: row.wins } : {}),
          ...(row.number ? { number: row.number } : {}),
          ...(row.team ? { team: row.team } : {}),
        });
      }
    }
  }

  const sessions = new Map(input.sessions.map((s) => [s.id, s]));
  for (const file of input.results) {
    for (const sr of file.sessions) {
      const session = sessions.get(sr.sessionId);
      if (!session || !RACE_TYPES.has(session.type)) continue;
      for (const row of sr.rows) {
        // Solo pilotos que figuran en algún campeonato (evita fichas sueltas de resultados parciales).
        const d = isSingleDriverName(row.driver) ? drivers.get(driverId(row.driver)) : undefined;
        if (!d) continue;
        d.recent.push({
          seriesId: file.seriesId,
          eventId: file.eventId,
          sessionId: sr.sessionId,
          startUtc: session.startUtc,
          pos: row.pos ?? null,
          ...(row.status ? { status: row.status } : {}),
        });
      }
    }
  }

  const list: Driver[] = [...drivers.values()]
    .filter((d) => d.entries.length > 0)
    .map(({ quality: _q, ...d }) => ({
      ...d,
      entries: d.entries.sort((a, b) => (order.get(a.seriesId) ?? 999) - (order.get(b.seriesId) ?? 999) || a.pos - b.pos),
      recent: d.recent.sort((a, b) => b.startUtc.localeCompare(a.startUtc)).slice(0, RECENT_RESULTS),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return { version: 1, generatedAt: input.generatedAt, drivers: list };
}

/** Lee las tablas y resultados publicados en data/ y arma el índice. */
export async function buildDriversFromData(
  dataDir: string,
  series: Series[],
  events: MotorEvent[],
  sessions: Session[],
  generatedAt: string,
): Promise<DriversFile> {
  const standings: StandingsFile[] = [];
  for (const s of series) {
    const file = await readJson<StandingsFile>(path.join(dataDir, 'standings', `${s.id}.json`));
    if (file) standings.push(file);
  }
  const withResults = new Set(sessions.filter((s) => s.hasResults).map((s) => s.eventId));
  const results: EventResultsFile[] = [];
  for (const e of events) {
    if (!withResults.has(e.id)) continue;
    const file = await readJson<EventResultsFile>(path.join(dataDir, 'results', e.seriesId, `${e.id}.json`));
    if (file) results.push(file);
  }
  return buildDrivers({ series, standings, results, sessions, generatedAt });
}
