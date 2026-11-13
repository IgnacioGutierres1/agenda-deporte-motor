/**
 * Ficha "Contexto" de un evento: qué se juega, formato, a quién mirar, qué pasó antes y notas recientes.
 * Todo sale de los datos oficiales ya publicados (calendario, campeonatos, resultados, inscriptos y notas):
 * sin IA y sin inventar nada. Lógica pura, sin Vue ni Pinia.
 */
import {
  driverDisplayName,
  driverId,
  isDriverTable,
  splitDriverNames,
  teamId,
  type EventResultsFile,
  type MotorEvent,
  type NewsItem,
  type RosterRow,
  type SeriesGroup,
  type Session,
  type SessionType,
  type StandingsFile,
  type StandingsRow,
  type StandingsTable,
  type Surface,
} from '@dm/shared';
import { groupRoster, rosterClasses } from './roster.ts';
import { eventDays, hasStages, itineraryKind } from './stages.ts';

const RACE_TYPES: SessionType[] = ['carrera', 'sprint'];

export const isRace = (s: Pick<Session, 'type'>): boolean => RACE_TYPES.includes(s.type);

const byStart = (a: Pick<Session, 'startUtc'>, b: Pick<Session, 'startUtc'>) => a.startUtc.localeCompare(b.startUtc);
const byDate = (a: MotorEvent, b: MotorEvent) => a.dateStart.localeCompare(b.dateStart) || (a.round ?? 0) - (b.round ?? 0);

// ── Temporada: número de fecha, fechas que quedan y fecha anterior ──

/**
 * Eventos de la misma temporada que `event`, ordenados por fecha. Si la categoría numera sus fechas, la
 * temporada es la tira de eventos numerados en la que la numeración no vuelve a empezar (sirve para
 * campeonatos que cruzan el año, como la Asian Le Mans); los eventos sin número (ensayos) quedan afuera.
 * Si la categoría no numera ninguna fecha, la temporada es el año calendario.
 */
export function seasonEvents(events: MotorEvent[], event: MotorEvent): MotorEvent[] {
  const own = events.filter((e) => e.seriesId === event.seriesId).sort(byDate);
  const numbered = own.filter((e) => e.round !== undefined);
  if (!numbered.length) return own.filter((e) => e.dateStart.slice(0, 4) === event.dateStart.slice(0, 4));
  if (event.round === undefined) return [];
  const seasons: MotorEvent[][] = [];
  let current: MotorEvent[] = [];
  for (const e of numbered) {
    const last = current[current.length - 1];
    if (last && e.round! <= last.round!) {
      seasons.push(current);
      current = [];
    }
    current.push(e);
  }
  if (current.length) seasons.push(current);
  return seasons.find((s) => s.some((e) => e.id === event.id)) ?? [];
}

export interface RoundInfo {
  /** Número de fecha (el oficial o, si la categoría no numera, el orden en el calendario del año). */
  n: number;
  /** Cantidad de fechas de la temporada. */
  of: number;
  /** true si el número sale del orden en el calendario y no de la numeración oficial. */
  byCalendar: boolean;
  /** Fechas de la temporada posteriores a esta, en orden. */
  after: MotorEvent[];
  /** Fecha anterior de la misma temporada. */
  previous?: MotorEvent;
}

export function roundInfo(events: MotorEvent[], event: MotorEvent): RoundInfo | null {
  const season = seasonEvents(events, event);
  const i = season.findIndex((e) => e.id === event.id);
  if (i < 0) return null;
  const byCalendar = event.round === undefined;
  // Categoría de una sola prueba por año y sin numerar (el Dakar): "Fecha 1 de 1" no dice nada.
  if (byCalendar && season.length === 1) return null;
  const of = byCalendar ? season.length : Math.max(...season.map((e) => e.round ?? 0), season.length);
  return {
    n: byCalendar ? i + 1 : event.round!,
    of,
    byCalendar,
    after: season.slice(i + 1),
    ...(i > 0 ? { previous: season[i - 1] } : {}),
  };
}

/** "Última fecha", "Anteúltima fecha", "Después de esta quedan 5 fechas". */
export function remainingText(after: number): string {
  if (after === 0) return 'Última fecha de la temporada';
  if (after === 1) return 'Anteúltima fecha: después queda 1 más';
  return `Después de esta quedan ${after} fechas`;
}

/** Carreras (y sprints) de un evento, por horario. */
export function raceSessions(sessions: Session[], eventId: string): Session[] {
  return sessions.filter((s) => s.eventId === eventId && isRace(s)).sort(byStart);
}

/**
 * Carreras que quedan después de esta fecha, o null si alguna fecha todavía no tiene cronograma publicado
 * (no se sabe cuántas carreras tiene).
 */
export function racesAfter(sessions: Session[], after: MotorEvent[]): number | null {
  let total = 0;
  for (const e of after) {
    const n = raceSessions(sessions, e.id).length;
    if (!n) return null;
    total += n;
  }
  return total;
}

// ── El campeonato: antes o después de esta fecha ──

/**
 * before: la tabla se leyó antes de la primera carrera del evento. partial: entre carreras del evento
 * (p. ej. después del sprint). after: después de la última carrera (ya puede incluir este resultado).
 * unknown: sin cronograma y leída durante el fin de semana del evento.
 */
export type StandingsTiming = 'before' | 'partial' | 'after' | 'unknown';

export function standingsTiming(updatedAt: string, event: MotorEvent, eventSessions: Session[]): StandingsTiming {
  const races = eventSessions.filter(isRace);
  const at = Date.parse(updatedAt);
  if (races.length) {
    const done = races.filter((r) => Date.parse(r.endUtc) <= at).length;
    if (done === 0) return 'before';
    return done === races.length ? 'after' : 'partial';
  }
  // Sin horarios: se compara con los días del evento (medianoche UTC de margen hacia cada lado).
  if (at < Date.parse(`${event.dateStart}T00:00:00Z`) - 14 * 3_600_000) return 'before';
  if (at > Date.parse(`${event.dateEnd}T23:59:59Z`) + 14 * 3_600_000) return 'after';
  return 'unknown';
}

export const TIMING_LABELS: Record<StandingsTiming, string> = {
  before: 'Tabla antes de la carrera',
  partial: 'Tabla actualizada entre carreras de este evento',
  after: 'Tabla actualizada después de esta carrera',
  unknown: 'Tabla leída durante el fin de semana: puede incluir o no este resultado',
};

/** Lo mismo para un rally: no es "la carrera" ni dura un fin de semana (el Dakar, dos semanas). */
export const RALLY_TIMING_LABELS: Record<StandingsTiming, string> = {
  before: 'Tabla antes del rally',
  partial: 'Tabla actualizada durante este rally',
  after: 'Tabla actualizada después de este rally',
  unknown: 'Tabla leída durante el rally: puede incluir o no este resultado',
};

export function timingLabel(timing: StandingsTiming, rally = false): string {
  return (rally ? RALLY_TIMING_LABELS : TIMING_LABELS)[timing];
}

/** Rally o rally raid: la categoría es del grupo rally, o el evento trae superficie, itinerario o sesiones de etapa. */
export function isRallyEvent(
  event: Pick<MotorEvent, 'surface' | 'stageCount'>,
  sessions: Array<Pick<Session, 'type'>> = [],
  group?: SeriesGroup,
): boolean {
  return group === 'rally' || !!event.surface || hasStages(event) || sessions.some((s) => s.type === 'etapa');
}

export interface Followed {
  /** Ids de pilotos seguidos (driverId). */
  driverIds: string[];
  /** Ids de equipos seguidos (teamId). Opcional mientras Ajustes no los guarde. */
  teamIds?: string[];
}

export interface GapRow {
  pos: number;
  name: string;
  team?: string;
  number?: string;
  points: number;
  /** Puntos detrás del líder (0 para el líder). */
  gap: number;
  followed: boolean;
  /** Link a la ficha del piloto ('' si el nombre es una tripulación). */
  driverId: string;
}

export interface ChampionshipTable {
  title: string;
  rows: GapRow[];
}

/** Ids de piloto de un nombre (o de cada integrante de una tripulación "A / B"). */
export function driverIdsOf(name: string): string[] {
  return splitDriverNames(name).map((n) => driverId(n)).filter(Boolean);
}

export function isFollowedRow(row: Pick<StandingsRow, 'name' | 'team'>, followed: Followed): boolean {
  const drivers = new Set(followed.driverIds);
  const teams = new Set(followed.teamIds ?? []);
  if (driverIdsOf(row.name).some((id) => drivers.has(id))) return true;
  return !!row.team && teams.has(teamId(row.team));
}

/** Tablas de pilotos del campeonato (la primera es la principal; el resto, clases o copas). */
export function driverTables(file: StandingsFile): StandingsTable[] {
  return file.tables.filter((t) => isDriverTable(t.title) && t.rows.length);
}

/**
 * Los primeros `top` de una tabla con la diferencia con el líder, más los seguidos que estén más atrás
 * (resaltados).
 */
export function gapTable(table: StandingsTable, top: number, followed: Followed): ChampionshipTable {
  const rows = [...table.rows].sort((a, b) => a.pos - b.pos);
  const leader = rows[0]?.points ?? 0;
  const pick = rows.filter((r, i) => i < top || isFollowedRow(r, followed));
  return {
    title: table.title,
    rows: pick.map((r) => {
      const ids = driverIdsOf(r.name);
      return {
        pos: r.pos,
        // "Agustín CANAPINO" -> "Agustín Canapino" (las tripulaciones quedan como las publica la fuente).
        name: ids.length === 1 ? driverDisplayName(r.name) : r.name,
        ...(r.team ? { team: r.team } : {}),
        ...(r.number ? { number: r.number } : {}),
        points: r.points,
        gap: Math.round((leader - r.points) * 10) / 10,
        followed: isFollowedRow(r, followed),
        driverId: ids.length === 1 ? ids[0]! : '',
      };
    }),
  };
}

// ── Cuentas del título (solo para categorías con puntaje máximo conocido) ──

export interface PointsRule {
  /** Puntos máximos que puede sumar un piloto en cada tipo de carrera (incluye vuelta rápida si suma). */
  perRace: Partial<Record<SessionType, number>>;
  /** Puntos extra por fin de semana que no dependen de la carrera (pole). */
  perEvent?: number;
  /** Formato a suponer en una fecha sin cronograma publicado (si es fijo); sin esto, no se hacen cuentas. */
  defaultFormat?: SessionType[];
  /** Fechas con otro puntaje (p. ej. las 500 Millas): si queda alguna, no se hacen cuentas. */
  specialEvent?: RegExp;
  /** Explicación corta del puntaje. */
  note: string;
}

/**
 * Puntaje máximo por carrera de las categorías en las que se conoce con certeza (reglamentos 2026).
 * NASCAR (playoffs y etapas), TC (Copa de Oro) y las de resistencia (puntos por duración y clase) quedan
 * afuera a propósito: se muestran solo las diferencias.
 */
export const POINTS_RULES: Record<string, PointsRule> = {
  f1: { perRace: { carrera: 25, sprint: 8 }, note: '25 puntos por carrera y 8 por sprint' },
  motogp: { perRace: { carrera: 25, sprint: 12 }, defaultFormat: ['sprint', 'carrera'], note: '25 puntos por carrera y 12 por sprint' },
  moto2: { perRace: { carrera: 25 }, defaultFormat: ['carrera'], note: '25 puntos por carrera' },
  moto3: { perRace: { carrera: 25 }, defaultFormat: ['carrera'], note: '25 puntos por carrera' },
  f2: {
    perRace: { carrera: 26, sprint: 11 },
    perEvent: 2,
    defaultFormat: ['sprint', 'carrera'],
    note: '25 + 1 (vuelta rápida) en la principal, 10 + 1 en el sprint y 2 por la pole',
  },
  f3: {
    perRace: { carrera: 26, sprint: 11 },
    perEvent: 2,
    defaultFormat: ['sprint', 'carrera'],
    note: '25 + 1 (vuelta rápida) en la principal, 10 + 1 en el sprint y 2 por la pole',
  },
  indycar: {
    perRace: { carrera: 53 },
    perEvent: 1,
    defaultFormat: ['carrera'],
    specialEvent: /indianapolis 500|indy 500|500 millas/i,
    note: '50 por ganar + 3 por vueltas lideradas, y 1 por la pole',
  },
};

/** Puntos que todavía se pueden sumar en una fecha (las carreras que terminan después de `countedUntil`). */
export function eventMaxPoints(rule: PointsRule, event: MotorEvent, eventSessions: Session[], countedUntil?: string): number | null {
  if (rule.specialEvent?.test(event.name)) return null;
  const races = eventSessions.filter(isRace);
  const cut = countedUntil ? Date.parse(countedUntil) : -Infinity;
  if (!races.length) {
    if (!rule.defaultFormat) return null;
    return rule.defaultFormat.reduce((sum, t) => sum + (rule.perRace[t] ?? 0), 0) + (rule.perEvent ?? 0);
  }
  let total = 0;
  for (const r of races) {
    const p = rule.perRace[r.type];
    if (p === undefined) return null;
    if (Date.parse(r.endUtc) > cut) total += p;
  }
  // La pole se reparte antes de la primera carrera.
  if (rule.perEvent && Date.parse(races[0]!.startUtc) > cut) total += rule.perEvent;
  return total;
}

export interface TitleMath {
  /** Puntos en juego en esta fecha (lo que falta de ella si la tabla es de entre carreras). */
  thisEvent: number;
  /** Puntos en juego después de esta fecha. */
  afterEvent: number;
  leader: StandingsRow;
  /** Pilotos (sin contar al líder) que todavía pueden alcanzarlo. */
  contenders: StandingsRow[];
  /** El líder ya no puede ser alcanzado. */
  clinched: boolean;
  /** El líder puede asegurarse el título en esta fecha. */
  canClinchHere: boolean;
  /** Por cada rival con chances: cuánto tiene que sacarle el líder (negativo: cuánto puede perder). */
  needs: Array<{ rival: StandingsRow; margin: number }>;
  note: string;
}

/**
 * Cuentas del título con la tabla principal. `pending` son esta fecha y las siguientes; `countedUntil` es el
 * momento de la tabla (las carreras ya terminadas entonces no suman). Devuelve null si la categoría no tiene
 * puntaje configurado o si alguna fecha no tiene formato conocido.
 */
export function titleMath(
  seriesId: string,
  table: StandingsTable,
  event: MotorEvent,
  after: MotorEvent[],
  sessions: Session[],
  countedUntil: string,
): TitleMath | null {
  const rule = POINTS_RULES[seriesId];
  if (!rule) return null;
  const rows = [...table.rows].sort((a, b) => a.pos - b.pos);
  const leader = rows[0];
  if (!leader || rows.length < 2) return null;
  const sessionsOf = (id: string) => sessions.filter((s) => s.eventId === id);
  const thisEvent = eventMaxPoints(rule, event, sessionsOf(event.id), countedUntil);
  if (thisEvent === null) return null;
  let afterEvent = 0;
  for (const e of after) {
    const p = eventMaxPoints(rule, e, sessionsOf(e.id));
    if (p === null) return null;
    afterEvent += p;
  }
  const total = thisEvent + afterEvent;
  const rivals = rows.slice(1).filter((r) => r.name !== leader.name);
  // Empatar en puntos todavía deja chances (se desempata por victorias).
  const contenders = rivals.filter((r) => leader.points - r.points <= total);
  const needs = contenders.map((rival) => ({ rival, margin: Math.floor(afterEvent - (leader.points - rival.points)) + 1 }));
  return {
    thisEvent,
    afterEvent,
    leader,
    contenders,
    clinched: contenders.length === 0,
    canClinchHere: contenders.length > 0 && needs.every((n) => n.margin <= thisEvent),
    needs,
    note: rule.note,
  };
}

/** "le alcanza con sacarle 5 puntos a X" / "le alcanza con no perder más de 22 puntos con X". */
export function marginText(margin: number, rival: string): string {
  if (margin > 0) return `sacarle ${margin} ${margin === 1 ? 'punto' : 'puntos'} o más a ${rival}`;
  if (margin === 0) return `no perder puntos con ${rival}`;
  const m = -margin;
  return `no perder más de ${m} ${m === 1 ? 'punto' : 'puntos'} con ${rival}`;
}

// ── Formato del fin de semana ──

const TYPE_WORDS: Record<SessionType, [string, string]> = {
  practica: ['práctica', 'prácticas'],
  clasificacion: ['clasificación', 'clasificaciones'],
  sprint: ['sprint', 'sprints'],
  serie: ['serie', 'series'],
  carrera: ['carrera', 'carreras'],
  warmup: ['warm up', 'warm ups'],
  etapa: ['etapa', 'etapas'],
  otro: ['otra sesión', 'otras sesiones'],
};

const TYPE_ORDER: SessionType[] = ['practica', 'clasificacion', 'serie', 'warmup', 'sprint', 'etapa', 'carrera', 'otro'];

/** "3 prácticas · 1 clasificación · 1 carrera". */
export function sessionCounts(sessions: Session[]): string {
  const count = new Map<SessionType, number>();
  for (const s of sessions) count.set(s.type, (count.get(s.type) ?? 0) + 1);
  return TYPE_ORDER.filter((t) => count.get(t))
    .map((t) => {
      const n = count.get(t)!;
      return `${n} ${TYPE_WORDS[t][n === 1 ? 0 : 1]}`;
    })
    .join(' · ');
}

const SURFACE_PHRASE: Record<Surface, string> = {
  asfalto: 'sobre asfalto',
  tierra: 'sobre tierra',
  nieve: 'sobre nieve y hielo',
  arena: 'sobre arena y desierto',
  mixto: 'sobre asfalto y tierra',
};

/**
 * Formato de un evento en una línea. Una carrera de circuito: "3 prácticas · 1 clasificación · 1 carrera".
 * Un rally no tiene ese formato (sus sesiones son el shakedown, un bloque de tramos por día y la Power Stage):
 * "Rally por tramos cronometrados sobre asfalto · 4 días" o "Rally raid por etapas sobre arena y desierto · 15 días".
 * Vacío si no hay nada publicado todavía.
 */
export function eventFormatText(
  event: Pick<MotorEvent, 'dateStart' | 'dateEnd' | 'surface' | 'stageCount'>,
  sessions: Session[],
  group?: SeriesGroup,
): string {
  if (!isRallyEvent(event, sessions, group)) return sessionCounts(sessions);
  // Sin itinerario ni horarios todavía no se sabe si es por tramos o por etapas.
  if (!hasStages(event) && !sessions.length) return event.surface ? `Rally ${SURFACE_PHRASE[event.surface]}` : '';
  const kind = hasStages(event) ? itineraryKind(event) : 'tramos';
  const days = eventDays(event);
  return [
    `${kind === 'tramos' ? 'Rally por tramos cronometrados' : 'Rally raid por etapas'}${event.surface ? ` ${SURFACE_PHRASE[event.surface]}` : ''}`,
    days > 1 ? `${days} días` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Duración en minutos entre inicio y fin. */
export function durationMinutes(s: Pick<Session, 'startUtc' | 'endUtc'>): number {
  return Math.round((Date.parse(s.endUtc) - Date.parse(s.startUtc)) / 60_000);
}

/** "40 min", "2 h", "1 h 30 min". */
export function durationText(min: number): string {
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

export interface ClassCount {
  name: string;
  cars: number;
  drivers: number;
}

export interface RosterSummary {
  cars: number;
  drivers: number;
  classes: ClassCount[];
}

/** Autos y pilotos de la lista de inscriptos, en total y por clase. */
export function rosterSummary(rows: RosterRow[]): RosterSummary {
  const count = (only = '') => {
    const teams = groupRoster(rows, only);
    const cars = teams.reduce((n, t) => n + t.cars.length, 0);
    const drivers = new Set(teams.flatMap((t) => t.cars.flatMap((c) => c.drivers.map((d) => d.id || d.name)))).size;
    return { cars, drivers };
  };
  return {
    ...count(),
    classes: rosterClasses(rows).map((name) => ({ name, ...count(name) })),
  };
}

// ── Resultados: lo que ya pasó ──

export interface SessionHighlight {
  sessionId: string;
  sessionName: string;
  type: SessionType;
  /** "Ganador", "Pole", "Más rápido". */
  label: string;
  driver: string;
  team?: string;
  /** Link a la ficha ('' si es una tripulación). */
  driverId: string;
  startUtc: string;
}

/**
 * El primero de cada sesión con resultado: ganador de cada carrera, pole (la última clasificación antes de
 * una carrera) y el más rápido de cada práctica.
 */
export function highlights(file: EventResultsFile | undefined, eventSessions: Session[], onlyRaces = false): SessionHighlight[] {
  if (!file) return [];
  const sorted = [...eventSessions].sort(byStart);
  const out: SessionHighlight[] = [];
  for (const sr of file.sessions) {
    const session = sorted.find((s) => s.id === sr.sessionId);
    if (!session || (onlyRaces && !isRace(session))) continue;
    const first = sr.rows.find((r) => r.pos === 1);
    if (!first) continue;
    let label = 'Más rápido';
    if (isRace(session)) label = 'Ganador';
    // Bloque de tramos o etapa de un rally: el primero de la clasificación publicada (no una vuelta rápida).
    else if (session.type === 'etapa') label = 'Primero';
    else if (session.type === 'clasificacion') {
      const next = sorted.slice(sorted.indexOf(session) + 1).find((s) => s.type === 'clasificacion' || isRace(s));
      label = next && isRace(next) ? 'Pole' : 'Primero';
    }
    const ids = driverIdsOf(first.driver);
    out.push({
      sessionId: session.id,
      sessionName: session.name,
      type: session.type,
      label,
      driver: first.driver,
      ...(first.team ? { team: first.team } : {}),
      driverId: ids.length === 1 ? ids[0]! : '',
      startUtc: session.startUtc,
    });
  }
  return out.sort(byStart);
}

// ── A quién mirar ──

export interface WatchItem {
  /** Ficha: /piloto/:id o /equipo/:id. */
  kind: 'piloto' | 'equipo';
  id: string;
  name: string;
  reason: string;
  /** "P3 · 262 pts". */
  detail?: string;
  followed: boolean;
}

export interface WatchInput {
  followed: Followed;
  /** Nombres para mostrar de los seguidos (id -> nombre). */
  followedNames?: Map<string, string>;
  /** Tablas de pilotos (la primera es la principal). */
  tables: StandingsTable[];
  /** Tablas de equipos (para ubicar a los equipos seguidos). */
  teamTables?: StandingsTable[];
  roster?: RosterRow[];
  /** Ganadores de carreras de este evento. */
  winnersHere?: SessionHighlight[];
  /** Ganadores de la fecha anterior. */
  winnersBefore?: SessionHighlight[];
  previousName?: string;
  /** El evento es un rally: "Ganó este rally" en lugar de "Ganó esta carrera". */
  rally?: boolean;
  limit?: number;
}

const ptsText = (r: StandingsRow) => `P${r.pos} · ${r.points.toLocaleString('es-AR')} pts`;

/** Primero los seguidos, después los líderes de cada tabla y los últimos ganadores. */
export function whoToWatch(input: WatchInput): WatchItem[] {
  const out: WatchItem[] = [];
  const seen = new Set<string>();
  const add = (item: WatchItem) => {
    const key = `${item.kind}:${item.id}`;
    if (!item.id || seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };
  const multi = input.tables.length > 1;
  const followedDrivers = new Set(input.followed.driverIds);
  const followedTeams = new Set(input.followed.teamIds ?? []);

  // Pilotos seguidos que corren en la categoría (tabla o inscriptos).
  for (const t of input.tables) {
    for (const r of t.rows) {
      for (const id of driverIdsOf(r.name)) {
        if (!followedDrivers.has(id)) continue;
        add({
          kind: 'piloto',
          id,
          name: input.followedNames?.get(id) ?? driverDisplayName(r.name),
          reason: multi ? `Lo seguís · ${t.title}` : 'Lo seguís',
          detail: ptsText(r),
          followed: true,
        });
      }
    }
  }
  for (const r of input.roster ?? []) {
    for (const name of splitDriverNames(r.driver)) {
      const id = driverId(name);
      if (!followedDrivers.has(id)) continue;
      add({
        kind: 'piloto',
        id,
        name: input.followedNames?.get(id) ?? driverDisplayName(name),
        reason: 'Lo seguís',
        detail: [r.number ? `#${r.number}` : '', r.team ?? '', r.class ?? ''].filter(Boolean).join(' · '),
        followed: true,
      });
    }
  }
  // Equipos seguidos (tabla de equipos, equipos de la tabla de pilotos o inscriptos).
  if (followedTeams.size) {
    for (const t of input.teamTables ?? []) {
      for (const r of t.rows) {
        const id = teamId(r.name);
        if (followedTeams.has(id)) add({ kind: 'equipo', id, name: input.followedNames?.get(id) ?? r.name, reason: 'Lo seguís', detail: ptsText(r), followed: true });
      }
    }
    const teamNames = [
      ...input.tables.flatMap((t) => t.rows.map((r) => r.team)),
      ...(input.roster ?? []).map((r) => r.team),
    ].filter((n): n is string => !!n);
    for (const name of teamNames) {
      const id = teamId(name);
      if (followedTeams.has(id)) add({ kind: 'equipo', id, name: input.followedNames?.get(id) ?? name, reason: 'Lo seguís', followed: true });
    }
    // Sus pilotos (de la tabla principal o, si no hay, de los inscriptos), hasta 4.
    let added = 0;
    const addTeamDriver = (rawName: string, team: string, detail: string) => {
      const ids = driverIdsOf(rawName);
      const tid = teamId(team);
      if (ids.length !== 1 || !followedTeams.has(tid) || added >= 4 || seen.has(`piloto:${ids[0]}`)) return;
      added++;
      add({ kind: 'piloto', id: ids[0]!, name: rawName, reason: `Corre para ${input.followedNames?.get(tid) ?? team}, que seguís`, ...(detail ? { detail } : {}), followed: true });
    };
    for (const r of input.tables[0]?.rows ?? []) if (r.team) addTeamDriver(driverDisplayName(r.name), r.team, ptsText(r));
    for (const r of input.roster ?? []) {
      if (!r.team) continue;
      for (const name of splitDriverNames(r.driver)) addTeamDriver(driverDisplayName(name), r.team, [r.number ? `#${r.number}` : '', r.class ?? ''].filter(Boolean).join(' · '));
    }
  }
  // Líderes del campeonato (uno por tabla).
  for (const t of input.tables) {
    const leader = [...t.rows].sort((a, b) => a.pos - b.pos)[0];
    if (!leader) continue;
    for (const id of driverIdsOf(leader.name)) {
      add({ kind: 'piloto', id, name: driverDisplayName(leader.name), reason: multi ? `Líder · ${t.title}` : 'Líder del campeonato', detail: ptsText(leader), followed: false });
    }
  }
  const here = input.winnersHere ?? [];
  for (const w of here) {
    add({ kind: 'piloto', id: w.driverId, name: w.driver, reason: here.length > 1 ? `Ganó ${w.sessionName}` : input.rally ? 'Ganó este rally' : 'Ganó esta carrera', ...(w.team ? { detail: w.team } : {}), followed: false });
  }
  const before = input.winnersBefore ?? [];
  for (const w of before) {
    const where = input.previousName ? ` en ${input.previousName}` : before.length > 1 ? ' en la fecha anterior' : ' la fecha anterior';
    const what = before.length > 1 ? ` ${w.sessionName}` : '';
    add({ kind: 'piloto', id: w.driverId, name: w.driver, reason: `Ganó${what}${where}`, ...(w.team ? { detail: w.team } : {}), followed: false });
  }
  return out.slice(0, input.limit ?? 10);
}

// ── Notas recientes ──

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Palabras que no identifican un evento ("Grand Prix", "Fecha", "Hours"…). */
const EVENT_STOP = new Set([
  'grand', 'prix', 'gran', 'premio', 'fecha', 'hours', 'horas', 'race', 'round', 'carrera', 'the', 'of', 'de', 'del', 'la', 'el',
  'los', 'las', 'presented', 'by', 'autodromo', 'circuit', 'circuito', 'international', 'internacional', 'speedway', 'motor',
  'parque', 'ciudad', 'street', 'strip', 'grande', 'world', 'championship',
]);

/** Palabras del nombre del evento, el circuito y el país que sirven para reconocer notas sobre el evento. */
export function eventNeedles(event: Pick<MotorEvent, 'name' | 'circuit' | 'country'>): string[] {
  const words = norm(`${event.name} ${event.circuit} ${event.country}`)
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 4 && !EVENT_STOP.has(w) && !/^\d+$/.test(w));
  return [...new Set(words)];
}

/** Apellidos (última palabra de 4+ letras) de los nombres dados. */
export function surnameNeedles(names: string[]): string[] {
  return [
    ...new Set(
      names
        .map((n) => norm(n).split(/[^a-z0-9]+/).filter((w) => w.length >= 4).pop())
        .filter((w): w is string => !!w),
    ),
  ];
}

const hasWord = (text: string, w: string) => new RegExp(`(^|[^a-z0-9])${w}([^a-z0-9]|$)`).test(text);

/**
 * Hasta `limit` notas de la categoría publicadas en los `days` días previos a `ref`, primero las que nombran
 * el evento o el circuito y las que nombran a los pilotos o equipos seguidos; dentro de eso, las más nuevas.
 */
export function pickNews(
  items: NewsItem[],
  seriesId: string,
  ref: string,
  opts: { eventWords: string[]; followedWords?: string[]; days?: number; limit?: number },
): NewsItem[] {
  const end = Date.parse(ref);
  const start = end - (opts.days ?? 7) * 86_400_000;
  const scored = items
    .filter((n) => n.seriesIds.includes(seriesId))
    .filter((n) => {
      const t = Date.parse(n.publishedAt);
      return t >= start && t <= end + 3_600_000;
    })
    .map((n) => {
      const text = norm(`${n.title} ${n.summary ?? ''}`);
      const title = norm(n.title);
      let score = 0;
      if (opts.eventWords.some((w) => hasWord(title, w))) score += 2;
      else if (opts.eventWords.some((w) => hasWord(text, w))) score += 1;
      if ((opts.followedWords ?? []).some((w) => hasWord(text, w))) score += 2;
      return { n, score };
    });
  return scored
    .sort((a, b) => b.score - a.score || b.n.publishedAt.localeCompare(a.n.publishedAt))
    .slice(0, opts.limit ?? 5)
    .map((x) => x.n);
}

/** Momento de referencia para las notas: ahora, o unos días después del evento si ya pasó hace rato. */
export function newsReference(event: MotorEvent, now: string): string {
  const after = Date.parse(`${event.dateEnd}T23:59:59Z`) + 2 * 86_400_000;
  return new Date(Math.min(Date.parse(now), after)).toISOString();
}
