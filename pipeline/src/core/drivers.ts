/**
 * Índice de pilotos (data/drivers.json) y de equipos (data/teams.json) para la app.
 *
 * Se arma con lo que ya está publicado: las tablas de campeonato de cada categoría, las listas oficiales
 * de inscriptos (data/rosters) y los resultados de carreras/sprints. Un mismo piloto en varias categorías
 * (p. ej. Canapino en TC, TC Pick Up y TN) queda como una sola ficha, unido por las palabras de su nombre;
 * las tripulaciones de resistencia ("A / B / C") se separan en sus pilotos.
 * No usa IA ni descarga nada.
 */
import path from 'node:path';
import {
  baseDriverId,
  driverDisplayName,
  driverId,
  isBrokenDriverName,
  isDriverTable,
  nameQuality,
  rosterFileSchema,
  splitDriverNames,
  teamId,
  teamKey,
  titleCaseCaps,
  type DriverDetail,
  type DriverLineup,
  type DriversFile,
  type EventResultsFile,
  type MotorEvent,
  type RosterFile,
  type Series,
  type Session,
  type StandingsFile,
  type StandingsTable,
  type Team,
  type TeamDriver,
  type TeamEntry,
  type TeamsFile,
} from '@dm/shared';
import { readJson } from './store.ts';

/** Resultados recientes que se guardan por piloto. */
export const RECENT_RESULTS = 6;
const RACE_TYPES = new Set(['carrera', 'sprint']);

interface Building extends DriverDetail {
  /** Calidad de la variante del nombre que se está mostrando. */
  quality: number;
  lineups: DriverLineup[];
}

export interface IndexInput {
  series: Series[];
  standings: StandingsFile[];
  results: EventResultsFile[];
  sessions: Session[];
  /** Listas oficiales de inscriptos (data/rosters). */
  rosters?: RosterFile[];
  generatedAt: string;
}

const seriesOrder = (series: Series[]) => {
  const order = new Map(series.map((s, i) => [s.id, i]));
  return (id: string) => order.get(id) ?? 999;
};

export function buildDrivers(input: IndexInput): DriversFile {
  const rank = seriesOrder(input.series);
  const drivers = new Map<string, Building>();
  const groupOf = new Map(input.series.map((s) => [s.id, s.group]));

  /**
   * Calidad de una variante del nombre: la más prolija gana (minúsculas, acentos, nombre completo). A igualdad,
   * la que ya corresponde al id canónico (config/driver-aliases.json: "Jef Machiels" antes que "Jeff Machiels").
   */
  const qualityOf = (rawName: string, id: string) => nameQuality(rawName) + (baseDriverId(rawName) === id ? 0.5 : 0);
  const display = (rawName: string, seriesId: string) =>
    driverDisplayName(rawName, { spanish: groupOf.get(seriesId) === 'argentina' });

  /** Ficha del piloto (la crea si no existe). null si el nombre no sirve (vacío o con letras rotas sin reparar). */
  const get = (rawName: string, seriesId: string): Building | null => {
    if (isBrokenDriverName(rawName)) return null;
    const id = driverId(rawName, seriesId);
    if (!id) return null;
    let d = drivers.get(id);
    const quality = qualityOf(rawName, id);
    if (!d) {
      d = { id, name: display(rawName, seriesId), entries: [], lineups: [], recent: [], quality };
      drivers.set(id, d);
    } else if (quality > d.quality) {
      d.name = display(rawName, seriesId);
      d.quality = quality;
    }
    return d;
  };

  // País publicado en alguna tabla: se usa al final, solo si ninguna lista de inscriptos lo dio.
  const tableCountry = new Map<string, string>();

  for (const file of input.standings) {
    const tables = file.tables.filter((t) => isDriverTable(t.title));
    for (const table of tables) {
      const tableName = tables.length > 1 ? table.title : undefined;
      for (const row of table.rows) {
        // Una tripulación ("Vanthoor / Estre") suma la misma línea a cada uno de sus pilotos.
        for (const name of splitDriverNames(row.name)) {
          const d = get(name, file.seriesId);
          if (!d) continue;
          if (row.country && !tableCountry.has(d.id)) tableCountry.set(d.id, row.country);
          // Si aparece dos veces en la misma tabla (homónimos), se queda la mejor posición.
          if (d.entries.some((e) => e.seriesId === file.seriesId && e.table === tableName)) continue;
          d.entries.push({
            seriesId: file.seriesId,
            ...(tableName ? { table: tableName } : {}),
            pos: row.pos,
            points: row.points,
            ...(row.wins !== undefined ? { wins: row.wins } : {}),
            ...(row.number ? { number: row.number } : {}),
            ...(row.team ? { team: teamDisplayName(row.team) } : {}),
          });
        }
      }
    }
  }

  // Inscriptos: suman pilotos que todavía no figuran en ninguna tabla (o cuya categoría no publica tabla de pilotos).
  const rosters = [...(input.rosters ?? [])].sort((a, b) => rank(a.seriesId) - rank(b.seriesId));
  for (const file of rosters) {
    for (const row of file.rows) {
      for (const name of splitDriverNames(row.driver)) {
        const d = get(name, file.seriesId);
        if (!d) continue;
        if (!d.country && row.country) d.country = row.country;
        const same = (l: DriverLineup) =>
          l.seriesId === file.seriesId && (l.number ?? '') === (row.number ?? '') && teamKey(l.team ?? '') === teamKey(row.team ?? '');
        if (d.lineups.some(same)) continue;
        d.lineups.push({
          seriesId: file.seriesId,
          ...(row.team ? { team: teamDisplayName(row.team) } : {}),
          ...(row.number ? { number: row.number } : {}),
          ...(row.vehicle ? { vehicle: row.vehicle } : {}),
          ...(row.class ? { class: row.class } : {}),
        });
      }
    }
  }

  for (const [id, country] of tableCountry) {
    const d = drivers.get(id)!;
    if (!d.country) d.country = country;
  }

  const sessions = new Map(input.sessions.map((s) => [s.id, s]));
  for (const file of input.results) {
    for (const sr of file.sessions) {
      const session = sessions.get(sr.sessionId);
      if (!session || !RACE_TYPES.has(session.type)) continue;
      for (const row of sr.rows) {
        // Solo pilotos que figuran en algún campeonato o lista de inscriptos (evita fichas sueltas de resultados parciales).
        for (const name of splitDriverNames(row.driver)) {
          if (isBrokenDriverName(name)) continue;
          const d = drivers.get(driverId(name, file.seriesId));
          if (!d || d.recent.some((r) => r.sessionId === sr.sessionId)) continue;
          // Un resultado con el nombre más prolijo (acentos, minúsculas) también mejora el que se muestra.
          const quality = qualityOf(name, d.id);
          if (quality > d.quality) {
            d.name = display(name, file.seriesId);
            d.quality = quality;
          }
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
  }

  const list: DriverDetail[] = [...drivers.values()]
    .filter((d) => d.entries.length > 0 || d.lineups.length > 0)
    .map(({ quality: _q, lineups, ...d }) => ({
      ...d,
      entries: d.entries.sort((a, b) => rank(a.seriesId) - rank(b.seriesId) || a.pos - b.pos),
      ...(lineups.length ? { lineups: lineups.sort((a, b) => rank(a.seriesId) - rank(b.seriesId)) } : {}),
      recent: d.recent.sort((a, b) => b.startUtc.localeCompare(a.startUtc)).slice(0, RECENT_RESULTS),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return { version: 1, generatedAt: input.generatedAt, drivers: list };
}

// ─── Equipos ──────────────────────────────────────────────────────────────────────────────────

/** Marcas o fabricantes ("Marcas", "GT3 Manufacturers"): no son equipos. */
const BRAND_TABLE = /marca|manufacturer|fabricante|maker|brand/i;
const TEAM_TABLE = /equipo|team|propietario|owner|escuder/i;

/**
 * Tablas de equipos de un campeonato. "Constructores" cuenta como tabla de equipos solo si la categoría no
 * publica otra (en F1 los constructores son los equipos; en MotoGP son las marcas y los equipos van aparte).
 */
export function teamTables(file: StandingsFile): StandingsTable[] {
  const candidates = file.tables.filter((t) => !isDriverTable(t.title) && !BRAND_TABLE.test(t.title));
  const teams = candidates.filter((t) => TEAM_TABLE.test(t.title));
  return teams.length ? teams : candidates.filter((t) => /constructor/i.test(t.title));
}

/**
 * Nombre de equipo prolijo cuando el sitio lo publica todo en mayúsculas: "PROTON COMPETITION" -> "Proton
 * Competition", "HEART OF RACING TEAM" -> "Heart of Racing Team". Las siglas quedan en mayúsculas ("AF Corse",
 * "KCMG", "KTMS", "Ziggo Sport Tempesta by ARGT"; ver isLikelyAcronym). Si el sitio ya usa minúsculas, tal cual.
 */
export function teamDisplayName(raw: string): string {
  const t = raw.replace(/#\s*[0-9A-Za-z]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (/[a-zà-ÿ]/.test(t)) return t;
  return titleCaseCaps(t);
}

function teamNameQuality(raw: string): number {
  let score = 0;
  if (/[a-zà-ÿ]/.test(raw)) score += 2;
  if (/[À-ÿ]/.test(raw)) score += 1;
  if (!/#/.test(raw)) score += 1;
  return score;
}

interface TeamBuilding {
  id: string;
  name: string;
  quality: number;
  entries: TeamEntry[];
  drivers: TeamDriver[];
}

const addUnique = (list: string[] | undefined, value: string | undefined): string[] | undefined => {
  if (!value) return list;
  const out = list ?? [];
  if (!out.includes(value)) out.push(value);
  return out;
};

/** Equipos a partir de las tablas de equipos, el equipo de cada piloto en las tablas y las listas de inscriptos. */
export function buildTeams(input: IndexInput & { drivers: DriversFile }): TeamsFile {
  const rank = seriesOrder(input.series);
  const teams = new Map<string, TeamBuilding>();
  const driverNames = new Map(input.drivers.drivers.map((d) => [d.id, d.name]));

  const get = (rawName: string): TeamBuilding | null => {
    const id = teamId(rawName);
    if (!id) return null;
    let t = teams.get(id);
    const quality = teamNameQuality(rawName);
    if (!t) {
      t = { id, name: teamDisplayName(rawName), quality, entries: [], drivers: [] };
      teams.set(id, t);
    } else if (quality > t.quality) {
      t.name = teamDisplayName(rawName);
      t.quality = quality;
    }
    return t;
  };

  /** Línea del equipo en la categoría donde van números, autos y clases: la de su primera tabla, o una sin tabla. */
  const infoEntry = (t: TeamBuilding, seriesId: string): TeamEntry => {
    let e = t.entries.find((x) => x.seriesId === seriesId);
    if (!e) {
      e = { seriesId };
      t.entries.push(e);
    }
    return e;
  };

  const link = (t: TeamBuilding, rawDriver: string, seriesId: string, number?: string) => {
    for (const name of splitDriverNames(rawDriver)) {
      if (isBrokenDriverName(name)) continue;
      const id = driverId(name, seriesId);
      if (!id) continue;
      const known = t.drivers.find((d) => d.id === id && d.seriesId === seriesId);
      if (known) {
        if (!known.number && number) known.number = number;
        continue;
      }
      t.drivers.push({ id, name: driverNames.get(id) ?? driverDisplayName(name), seriesId, ...(number ? { number } : {}) });
    }
  };

  for (const file of input.standings) {
    const tables = teamTables(file);
    for (const table of tables) {
      const tableName = tables.length > 1 ? table.title : undefined;
      for (const row of table.rows) {
        const t = get(row.name);
        if (!t) continue;
        const number = row.number ?? row.name.match(/#\s*([0-9A-Za-z]+)/)?.[1];
        // Tablas por auto (propietarios de NASCAR: "Hendrick Motorsports #5"): una línea por equipo con todos sus números.
        let e = t.entries.find((x) => x.seriesId === file.seriesId && x.table === tableName);
        if (!e) {
          e = { seriesId: file.seriesId, ...(tableName ? { table: tableName } : {}), pos: row.pos, points: row.points };
          t.entries.push(e);
        }
        e.numbers = addUnique(e.numbers, number);
      }
    }
    for (const table of file.tables.filter((x) => isDriverTable(x.title))) {
      for (const row of table.rows) {
        if (!row.team) continue;
        const t = get(row.team);
        if (!t) continue;
        const e = infoEntry(t, file.seriesId);
        e.numbers = addUnique(e.numbers, row.number);
        link(t, row.name, file.seriesId, row.number);
      }
    }
  }

  for (const file of input.rosters ?? []) {
    for (const row of file.rows) {
      if (!row.team) continue;
      const t = get(row.team);
      if (!t) continue;
      const e = infoEntry(t, file.seriesId);
      e.numbers = addUnique(e.numbers, row.number);
      e.vehicles = addUnique(e.vehicles, row.vehicle);
      e.classes = addUnique(e.classes, row.class);
      link(t, row.driver, file.seriesId, row.number);
    }
  }

  const byNumber = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
  const list: Team[] = [...teams.values()]
    .map(({ quality: _q, ...t }) => ({
      ...t,
      entries: t.entries
        .map((e) => ({ ...e, ...(e.numbers ? { numbers: e.numbers.sort(byNumber) } : {}) }))
        .sort((a, b) => rank(a.seriesId) - rank(b.seriesId)),
      drivers: t.drivers.sort((a, b) => rank(a.seriesId) - rank(b.seriesId) || byNumber(a.number ?? '', b.number ?? '') || a.name.localeCompare(b.name, 'es')),
    }))
    .sort((a, b) => a.name.localeCompare(b.name, 'es'));
  return { version: 1, generatedAt: input.generatedAt, teams: list };
}

/**
 * Lee las tablas, listas de inscriptos y resultados publicados en data/ y arma los dos índices.
 * `fresh` reemplaza las listas de inscriptos recién leídas en esta corrida (con --dry-run no se escriben).
 */
export async function buildIndexFromData(
  dataDir: string,
  series: Series[],
  events: MotorEvent[],
  sessions: Session[],
  generatedAt: string,
  fresh: Map<string, RosterFile> = new Map(),
): Promise<{ drivers: DriversFile; teams: TeamsFile }> {
  const standings: StandingsFile[] = [];
  const rosters: RosterFile[] = [];
  for (const s of series) {
    const file = await readJson<StandingsFile>(path.join(dataDir, 'standings', `${s.id}.json`));
    if (file) standings.push(file);
    if (!s.enabled) continue;
    const roster = fresh.get(s.id) ?? (await readJson(path.join(dataDir, 'rosters', `${s.id}.json`), rosterFileSchema).catch(() => null));
    if (roster) rosters.push(roster);
  }
  const withResults = new Set(sessions.filter((s) => s.hasResults).map((s) => s.eventId));
  const results: EventResultsFile[] = [];
  for (const e of events) {
    if (!withResults.has(e.id)) continue;
    const file = await readJson<EventResultsFile>(path.join(dataDir, 'results', e.seriesId, `${e.id}.json`));
    if (file) results.push(file);
  }
  const input: IndexInput = { series, standings, results, sessions, rosters, generatedAt };
  const drivers = buildDrivers(input);
  return { drivers, teams: buildTeams({ ...input, drivers }) };
}
