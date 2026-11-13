/**
 * "La temporada en números": estadísticas de cada piloto por categoría, calculadas solo con los resultados ya
 * publicados en data/results (no descarga nada ni usa IA). Es mejor publicar menos que publicar un número falso:
 *
 *  - Qué carreras cuentan. Las sesiones de tipo carrera y sprint de la última temporada con resultados de la
 *    categoría. No cuentan los ensayos (`kind: 'test'`), las series clasificatorias (tipo `serie`: series del TC,
 *    Duels de Daytona) ni, en una categoría que numera sus fechas, los eventos sin número de fecha (exhibiciones:
 *    Clash y All-Star de NASCAR). Una carrera postergada que quedó en el cronograma con dos horarios y el mismo
 *    resultado cuenta una sola vez.
 *  - Sprint. En F1 y MotoGP el sprint no es un Gran Premio: la estadística oficial (victorias, podios, promedio)
 *    cuenta solo los Grandes Premios, así que ahí el sprint queda afuera y sus victorias van aparte (`sprintWins`).
 *    En el resto (F2, F3…) la carrera sprint es una carrera más del campeonato.
 *  - Estados sin posición (ver raceOutcome). No largó (DNS, DNQ…): no es carrera ni abandono. Abandono (DNF,
 *    "Accident", "Engine"…) y no clasificado (NC con vueltas): carrera y abandono. Descalificado: carrera, sin
 *    puesto y sin abandono. Sin dato para saber si largó (sin posición y sin estado, o "NC" con 0 vueltas): no se
 *    cuenta. Un abandono que igual quedó clasificado (NASCAR, F1 con el 90 % de la distancia) cuenta su puesto.
 *  - Tripulaciones ("A / B / C"): el resultado del auto vale para cada piloto (splitDriverNames). Si un piloto
 *    figura en dos autos de la misma carrera, cuenta una carrera con su mejor resultado.
 *  - Categorías con clases (WEC, IMSA, GT World Challenge…): los resultados traen la posición en la general y no
 *    en la clase, así que un ganador de clase aparecería con "0 victorias". Para esas se publican solo carreras,
 *    abandonos y mejor puesto en la general, marcadas con `overall` (ver isMultiClass).
 *  - Poles: primer puesto en la clasificación que define la pole (ver poleRows).
 *  - Victorias: si la tabla oficial las publica y difieren de las calculadas, manda la tabla (ver applyOfficialWins).
 */
import {
  splitDriverNames,
  teamId,
  type DriverEntry,
  type DriverSeasonStats,
  type EventResultsFile,
  type MotorEvent,
  type ResultRow,
  type RosterFile,
  type Series,
  type Session,
  type SessionResult,
  type SessionType,
  type TeamSeasonStats,
} from '@dm/shared';

/**
 * Categorías donde corren varias clases en la misma carrera y el resultado publicado es el de la general.
 * Se suman solas las que publican una lista de inscriptos con más de una clase (ver isMultiClass). TN y Turismo
 * Pista no van acá: sus clases corren carreras separadas, así que el puesto ya es el de la clase.
 */
export const MULTI_CLASS_SERIES: ReadonlySet<string> = new Set([
  'wec',
  'elms',
  'alms',
  'imsa',
  'gtwc-europe',
  'gtwc-america',
  'gtwc-asia',
  'gtwc-australia',
  'igtc',
  '24h-series',
  'nls',
  'gt-open',
  'super-gt',
  'super-taikyu',
]);

/** Categorías donde el sprint no cuenta como carrera en la estadística oficial (solo los Grandes Premios). */
export const SPRINT_APART_SERIES: ReadonlySet<string> = new Set(['f1', 'motogp']);

/** true si en la categoría corren varias clases juntas: está en la lista o su lista de inscriptos trae más de una. */
export function isMultiClass(seriesId: string, roster?: Pick<RosterFile, 'rows'>): boolean {
  if (MULTI_CLASS_SERIES.has(seriesId)) return true;
  const classes = new Set((roster?.rows ?? []).map((r) => r.class?.trim().toLowerCase()).filter(Boolean));
  return classes.size > 1;
}

/** Qué le pasó a un piloto en una carrera, según su renglón del resultado. */
export type RaceOutcome = 'finished' | 'retired' | 'disqualified' | 'not-started' | 'unknown';

const NOT_STARTED = new Set([
  'DNS',
  'DNQ',
  'DNPQ',
  'DNP',
  'NS',
  'NP',
  'WD',
  'NOTSTARTED',
  'DID NOT START',
  'WITHDRAWN',
  'WITHDREW',
  'NO LARGO',
  'NO PARTIO',
]);
const DISQUALIFIED = new Set(['DSQ', 'DQ', 'EX', 'EXC', 'EXCL', 'DISQUALIFIED', 'EXCLUDED', 'DESCALIFICADO', 'EXCLUIDO']);
const NOT_CLASSIFIED = new Set(['NC', 'NOT CLASSIFIED', 'NO CLASIFICADO']);
/** Estados que no dicen nada de la carrera ("Sin tiempo" es de prácticas y clasificaciones). */
const NO_INFO = new Set(['', 'SIN TIEMPO', 'RUNNING', 'FINISHED', 'CLASSIFIED']);

/** Sin acentos, en mayúsculas y con espacios simples: para comparar estados y nombres tal como vienen. */
const plain = (s: string | undefined) =>
  (s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();

/**
 * Resultado de un renglón de carrera:
 *  - 'not-started': no largó (DNS, DNQ, retirado antes de la carrera). No es una carrera disputada ni un abandono.
 *  - 'disqualified': corrió y lo excluyeron. Es una carrera disputada, no un abandono.
 *  - 'retired': abandonó (DNF o el motivo: "Accident", "Engine"…) o largó y no quedó clasificado (NC con vueltas,
 *    "NOTONRESTARTGRID" de MotoGP). Con o sin posición: NASCAR y a veces F1 clasifican a quien abandona.
 *  - 'finished': tiene posición y ningún estado de abandono.
 *  - 'unknown': sin posición y sin dato para saber si largó. Sin estado (los que no clasificaron para la carrera en
 *    NASCAR vienen así) o "NC" con 0 vueltas (puede ser un abandono en la primera vuelta o uno que no largó).
 *    No se cuenta: ni como carrera ni como abandono.
 */
export function raceOutcome(row: Pick<ResultRow, 'pos' | 'status' | 'laps'>): RaceOutcome {
  const status = plain(row.status);
  if (NOT_STARTED.has(status)) return 'not-started';
  if (DISQUALIFIED.has(status)) return 'disqualified';
  if (row.pos !== null) return NO_INFO.has(status) || NOT_CLASSIFIED.has(status) ? 'finished' : 'retired';
  if (NO_INFO.has(status)) return 'unknown';
  if (NOT_CLASSIFIED.has(status)) return row.laps === 0 ? 'unknown' : 'retired';
  return 'retired';
}

export interface ScheduledResult {
  session: Session;
  result: SessionResult;
}

/** Clasificación de una sesión como texto, para reconocer la misma sesión cargada dos veces. */
const signature = (r: SessionResult) => r.rows.map((x) => `${x.pos ?? '-'}|${x.driver}`).join(';');

/**
 * Sesiones con resultado de un evento, de los tipos pedidos y sin repetidas, en orden de horario. Una carrera
 * postergada queda en el cronograma con cada horario que tuvo y el mismo resultado en todos (NASCAR Truck en
 * North Wilkesboro 2026: tres veces); se queda con la del último horario, que es cuando se corrió.
 */
export function distinctSessions(
  file: EventResultsFile,
  sessions: Map<string, Session>,
  types: ReadonlySet<SessionType>,
): ScheduledResult[] {
  const byKey = new Map<string, ScheduledResult>();
  for (const result of file.sessions) {
    const session = sessions.get(result.sessionId);
    if (!session || !types.has(session.type) || result.rows.length === 0) continue;
    const key = `${session.type}#${signature(result)}`;
    const known = byKey.get(key);
    if (!known || session.startUtc > known.session.startUtc) byKey.set(key, { session, result });
  }
  return [...byKey.values()].sort((a, b) => a.session.startUtc.localeCompare(b.session.startUtc));
}

/** "1:20.923" -> 80923 (ms); "58.321" -> 58321; null si no es un tiempo de vuelta. */
export function lapMs(time: string | undefined): number | null {
  const m = (time ?? '').trim().match(/^(?:(\d+):)?(\d{1,2})[.,](\d{1,3})$/);
  if (!m) return null;
  return (Number(m[1] ?? 0) * 60 + Number(m[2])) * 1000 + Number(m[3]!.padEnd(3, '0'));
}

const sessionLabel = (s: Session) => `${s.name} ${s.originalName ?? ''}`;
const qualifyingPhase = (s: Session) => Number(sessionLabel(s).match(/\bQ\s?([1-9])\b/i)?.[1] ?? 0);
const driverNames = (r: SessionResult) => new Set(r.rows.map((x) => plain(x.driver)));

/**
 * Renglones que se llevan una pole en un evento. `qualifying` son TODAS las clasificaciones del evento según el
 * cronograma (con o sin resultado):
 *  - la clasificación del sprint no da pole;
 *  - con rondas Q1/Q2/Q3 (MotoGP) solo cuenta la última;
 *  - una sesión posterior con una parte (hasta el 80 %) de los pilotos de otra es su ronda final (Top 10 Shootout,
 *    Superpole): la anterior no da pole;
 *  - por grupos (F2 y F3 en Mónaco o Monza: la mitad de los pilotos en cada sesión) hay una sola pole, la del mejor
 *    tiempo; si los tiempos no se pueden comparar, nadie;
 *  - dos clasificaciones con los mismos pilotos (una por carrera principal) dan una pole cada una;
 *  - el primero cuenta aunque no tenga tiempo: con la clasificación suspendida NASCAR ordena la grilla por
 *    reglamento, publica al primero "Sin tiempo" y le acredita la pole igual (contrastado con su tabla oficial).
 * Si de varias clasificaciones falta el resultado de alguna no se sabe cuál definía la pole: nadie.
 * No mira sanciones de grilla (en F1 la pole oficial es de quien larga primero): es el más rápido de la clasificación.
 */
export function poleRows(qualifying: Session[], results: Map<string, SessionResult>): ResultRow[] {
  let sessions = qualifying.filter((s) => s.type === 'clasificacion' && !/sprint/i.test(sessionLabel(s)));
  const lastPhase = Math.max(0, ...sessions.map(qualifyingPhase));
  if (lastPhase > 0) sessions = sessions.filter((s) => qualifyingPhase(s) === lastPhase);
  sessions = [...sessions].sort((a, b) => a.startUtc.localeCompare(b.startUtc));

  // La misma clasificación cargada con dos horarios cuenta una vez.
  const distinct = new Map<string, SessionResult>();
  for (const s of sessions) {
    const result = results.get(s.id);
    if (result && result.rows.length > 0) distinct.set(signature(result), result);
    else if (sessions.length > 1) return [];
  }
  let lists = [...distinct.values()];

  // Rondas previas: se descartan las que tienen una ronda final posterior con parte de sus pilotos.
  lists = lists.filter((early, i) => {
    const names = driverNames(early);
    return !lists.slice(i + 1).some((late) => {
      const finalists = driverNames(late);
      return finalists.size <= names.size * 0.8 && [...finalists].every((n) => names.has(n));
    });
  });

  const leader = (r: SessionResult) => r.rows.find((x) => x.pos === 1 && !DISQUALIFIED.has(plain(x.status)));
  const disjoint = (a: SessionResult, b: SessionResult) => {
    const names = driverNames(a);
    return !b.rows.some((x) => names.has(plain(x.driver)));
  };
  const byGroups = lists.length > 1 && lists.every((a, i) => lists.every((b, j) => i === j || disjoint(a, b)));
  if (!byGroups) return lists.map(leader).filter((x): x is ResultRow => !!x);

  const leaders = lists.map(leader);
  const times = leaders.map((x) => lapMs(x?.time));
  if (leaders.some((x) => !x) || times.some((t) => t === null)) return [];
  const best = Math.min(...(times as number[]));
  // Empate exacto entre grupos: no se sabe quién larga primero.
  return times.filter((t) => t === best).length === 1 ? [leaders[times.indexOf(best)]!] : [];
}

export interface SeasonStatsInput {
  series: Series[];
  /** Eventos del cronograma. Sin ellos no se descartan ensayos ni exhibiciones y la temporada sale de la sesión. */
  events?: MotorEvent[];
  sessions: Session[];
  results: EventResultsFile[];
  rosters?: RosterFile[];
}

const RACE: ReadonlySet<SessionType> = new Set<SessionType>(['carrera']);
const SPRINT: ReadonlySet<SessionType> = new Set<SessionType>(['sprint']);
const RACE_AND_SPRINT: ReadonlySet<SessionType> = new Set<SessionType>(['carrera', 'sprint']);
const QUALIFYING: ReadonlySet<SessionType> = new Set<SessionType>(['clasificacion']);

/** Lo que cuenta de una fecha del campeonato para las estadísticas. */
interface CountedEvent {
  seriesId: string;
  season: number;
  /** Categoría con clases: las posiciones son de la general. */
  overall: boolean;
  /** Carreras (y sprints, donde son una carrera más). */
  races: SessionResult[];
  /** Sprints de las categorías donde van aparte (F1, MotoGP). */
  sprints: SessionResult[];
  /** Renglones con pole (vacío en categorías con clases). */
  poles: ResultRow[];
}

/**
 * Fechas que cuentan, ya filtradas: del campeonato (ni ensayos ni exhibiciones), de la última temporada con
 * resultados de cada categoría y con sus sesiones sin repetir.
 */
function countedEvents(input: SeasonStatsInput): CountedEvent[] {
  const sessions = new Map(input.sessions.map((s) => [s.id, s]));
  const events = new Map((input.events ?? []).map((e) => [e.id, e]));
  const rosters = new Map((input.rosters ?? []).map((r) => [r.seriesId, r]));
  const numbersRounds = new Set((input.events ?? []).filter((e) => e.round !== undefined).map((e) => e.seriesId));
  const qualifyingByEvent = new Map<string, Session[]>();
  for (const s of input.sessions) {
    if (s.type !== 'clasificacion') continue;
    const list = qualifyingByEvent.get(s.eventId);
    if (list) list.push(s);
    else qualifyingByEvent.set(s.eventId, [s]);
  }

  const out: CountedEvent[] = [];
  const lastSeason = new Map<string, number>();
  for (const file of input.results) {
    const seriesId = file.seriesId;
    const event = events.get(file.eventId);
    if (event?.kind === 'test') continue;
    if (event && event.round === undefined && numbersRounds.has(seriesId)) continue;
    // La temporada sale de la fecha del evento; cuentan las fechas con carreras, sprints o clasificaciones con resultado.
    const first = [...distinctSessions(file, sessions, RACE_AND_SPRINT), ...distinctSessions(file, sessions, QUALIFYING)][0];
    if (!first) continue;
    const season = Number((event?.dateStart ?? first.session.startUtc).slice(0, 4));
    if (season > (lastSeason.get(seriesId) ?? 0)) lastSeason.set(seriesId, season);

    const sprintApart = SPRINT_APART_SERIES.has(seriesId);
    const overall = isMultiClass(seriesId, rosters.get(seriesId));
    const results = new Map(file.sessions.map((s) => [s.sessionId, s]));
    out.push({
      seriesId,
      season,
      overall,
      races: distinctSessions(file, sessions, sprintApart ? RACE : RACE_AND_SPRINT).map((x) => x.result),
      sprints: sprintApart ? distinctSessions(file, sessions, SPRINT).map((x) => x.result) : [],
      poles: overall ? [] : poleRows(qualifyingByEvent.get(file.eventId) ?? [], results),
    });
  }
  return out.filter((e) => e.season === lastSeason.get(e.seriesId));
}

interface Tally {
  season: number;
  overall: boolean;
  races: number;
  wins: number;
  podiums: number;
  top5: number;
  top10: number;
  dnfs: number;
  best: number;
  posSum: number;
  posCount: number;
  poles: number;
  sprintWins: number;
}

/** Números por categoría y por clave (id de piloto o de equipo), más qué categorías tienen poles con resultado. */
class Tallies {
  readonly bySeries = new Map<string, Map<string, Tally>>();
  readonly withPoles = new Set<string>();

  of(e: CountedEvent, key: string): Tally {
    let keys = this.bySeries.get(e.seriesId);
    if (!keys) this.bySeries.set(e.seriesId, (keys = new Map()));
    let t = keys.get(key);
    if (!t) {
      t = { season: e.season, overall: e.overall, races: 0, wins: 0, podiums: 0, top5: 0, top10: 0, dnfs: 0, best: 0, posSum: 0, posCount: 0, poles: 0, sprintWins: 0 };
      keys.set(key, t);
    }
    return t;
  }

  /** Suma un resultado con posición (o sin ella) a los números. */
  static addFinish(t: Tally, pos: number | null, outcome: RaceOutcome): void {
    if (outcome === 'retired') t.dnfs++;
    if (pos === null) return;
    t.posSum += pos;
    t.posCount++;
    if (!t.best || pos < t.best) t.best = pos;
    if (pos === 1) t.wins++;
    if (pos <= 3) t.podiums++;
    if (pos <= 5) t.top5++;
    if (pos <= 10) t.top10++;
  }
}

/** Orden entre dos renglones del mismo piloto en una carrera: primero el de mejor puesto, después el que abandonó. */
function rowRank(pos: number | null, outcome: RaceOutcome): number {
  if (pos !== null) return pos;
  return outcome === 'retired' ? 1e6 : 1e6 + 1;
}

const started = (outcome: RaceOutcome) => outcome !== 'not-started' && outcome !== 'unknown';
const sprintWinners = (sprint: SessionResult) => sprint.rows.filter((r) => r.pos === 1 && raceOutcome(r) !== 'disqualified');

/**
 * Estadísticas por piloto (id de ficha) y categoría. `resolve` devuelve el id de la ficha de un nombre tal como
 * viene en el resultado, o null si ese piloto no tiene ficha. Cada piloto recibe sus categorías en el orden de la
 * configuración. Las victorias son las calculadas: applyOfficialWins las ajusta después con la tabla oficial.
 */
export function buildSeasonStats(
  input: SeasonStatsInput,
  resolve: (rawName: string, seriesId: string) => string | null,
): Map<string, DriverSeasonStats[]> {
  const tallies = new Tallies();
  /** Fichas de los pilotos de un renglón (uno, o los de la tripulación). */
  const idsOf = (rows: ResultRow[], seriesId: string): Set<string> => {
    const ids = new Set<string>();
    for (const row of rows) {
      for (const name of splitDriverNames(row.driver)) {
        const id = resolve(name, seriesId);
        if (id) ids.add(id);
      }
    }
    return ids;
  };

  for (const e of countedEvents(input)) {
    for (const race of e.races) {
      // Mejor renglón de cada piloto en la carrera (puede figurar en dos autos).
      const best = new Map<string, { pos: number | null; outcome: RaceOutcome }>();
      for (const row of race.rows) {
        const outcome = raceOutcome(row);
        if (!started(outcome)) continue;
        for (const id of idsOf([row], e.seriesId)) {
          const known = best.get(id);
          if (!known || rowRank(row.pos, outcome) < rowRank(known.pos, known.outcome)) best.set(id, { pos: row.pos, outcome });
        }
      }
      for (const [id, { pos, outcome }] of best) {
        const t = tallies.of(e, id);
        t.races++;
        Tallies.addFinish(t, pos, outcome);
      }
    }
    for (const sprint of e.sprints) for (const id of idsOf(sprintWinners(sprint), e.seriesId)) tallies.of(e, id).sprintWins++;
    if (e.poles.length > 0) tallies.withPoles.add(e.seriesId);
    for (const id of idsOf(e.poles, e.seriesId)) tallies.of(e, id).poles++;
  }

  const out = new Map<string, DriverSeasonStats[]>();
  for (const s of input.series) {
    for (const [driver, t] of tallies.bySeries.get(s.id) ?? []) {
      // Una entrada por categoría con carreras disputadas.
      if (t.races === 0) continue;
      const stats: DriverSeasonStats = {
        seriesId: s.id,
        season: t.season,
        races: t.races,
        wins: t.wins,
        podiums: t.podiums,
        top5: t.top5,
        top10: t.top10,
        dnfs: t.dnfs,
        ...(t.best ? { bestPos: t.best } : {}),
        ...(!t.overall && t.posCount ? { avgPos: Math.round((t.posSum / t.posCount) * 10) / 10 } : {}),
        ...(!t.overall && tallies.withPoles.has(s.id) ? { poles: t.poles } : {}),
        ...(t.sprintWins ? { sprintWins: t.sprintWins } : {}),
        ...(t.overall ? { overall: true as const } : {}),
      };
      const list = out.get(driver);
      if (list) list.push(stats);
      else out.set(driver, [stats]);
    }
  }
  return out;
}

/**
 * Estadísticas por equipo (teamId del nombre que trae cada renglón) y categoría: lo que hicieron sus autos en cada
 * carrera, no la suma de lo que hicieron sus pilotos en toda la temporada (un piloto que cambió de equipo, o que
 * corre algunas fechas para otro, le sumaría al equipo carreras que no corrió con él). Una tripulación es un auto:
 * cuenta una vez. `races` son las carreras con algún auto del equipo en pista y `wins` las que ganó; podios y
 * abandonos cuentan autos (un 1-2 son dos podios). Los renglones sin equipo no suman a nadie.
 */
export function buildTeamSeasonStats(input: SeasonStatsInput): Map<string, TeamSeasonStats[]> {
  const tallies = new Tallies();
  const idOf = (row: ResultRow) => (row.team ? teamId(row.team) : '');

  for (const e of countedEvents(input)) {
    for (const race of e.races) {
      const inRace = new Set<string>();
      for (const row of race.rows) {
        const id = idOf(row);
        const outcome = raceOutcome(row);
        if (!id || !started(outcome)) continue;
        const t = tallies.of(e, id);
        if (!inRace.has(id)) t.races++;
        inRace.add(id);
        Tallies.addFinish(t, row.pos, outcome);
      }
    }
    for (const sprint of e.sprints) for (const id of new Set(sprintWinners(sprint).map(idOf))) if (id) tallies.of(e, id).sprintWins++;
    if (e.poles.length > 0) tallies.withPoles.add(e.seriesId);
    for (const id of new Set(e.poles.map(idOf))) if (id) tallies.of(e, id).poles++;
  }

  const out = new Map<string, TeamSeasonStats[]>();
  for (const s of input.series) {
    for (const [team, t] of tallies.bySeries.get(s.id) ?? []) {
      if (t.races === 0) continue;
      const stats: TeamSeasonStats = {
        seriesId: s.id,
        season: t.season,
        races: t.races,
        wins: t.wins,
        podiums: t.podiums,
        dnfs: t.dnfs,
        ...(t.best ? { bestPos: t.best } : {}),
        ...(!t.overall && tallies.withPoles.has(s.id) ? { poles: t.poles } : {}),
        ...(t.sprintWins ? { sprintWins: t.sprintWins } : {}),
        ...(t.overall ? { overall: true as const } : {}),
      };
      const list = out.get(team);
      if (list) list.push(stats);
      else out.set(team, [stats]);
    }
  }
  return out;
}

/**
 * La tabla oficial manda: si el campeonato de la misma temporada publica las victorias del piloto y no coinciden
 * con las calculadas (falta el resultado de alguna carrera, la tabla todavía no sumó la última, hubo una exclusión
 * posterior), se muestran las de la tabla, que es lo que ya dice la ficha en "Campeonato". Como una victoria es
 * también un podio, un top 5 y un top 10, esos números no pueden quedar por debajo.
 * Solo si el piloto figura en una única tabla de pilotos de la categoría (con varias no se sabe cuál sumar) y la
 * categoría no es de clases (ahí las victorias no se muestran).
 */
export function applyOfficialWins(
  stats: DriverSeasonStats[],
  entries: DriverEntry[],
  standingsSeason: (seriesId: string) => number | undefined,
): DriverSeasonStats[] {
  return stats.map((s) => {
    if (s.overall) return s;
    const tables = entries.filter((e) => e.seriesId === s.seriesId);
    const official = tables.length === 1 ? tables[0]!.wins : undefined;
    if (official === undefined || official === s.wins || standingsSeason(s.seriesId) !== s.season) return s;
    if (official < s.wins) return { ...s, wins: official };
    const podiums = Math.max(s.podiums, official);
    const top5 = Math.max(s.top5, podiums);
    return { ...s, wins: official, podiums, top5, top10: Math.max(s.top10, top5), bestPos: 1 };
  });
}
