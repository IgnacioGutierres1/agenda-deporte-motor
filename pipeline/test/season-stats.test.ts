import { describe, expect, it } from 'vitest';
import {
  driverId,
  driversFileSchema,
  driversIndexFileSchema,
  teamsFileSchema,
  type DriverSeasonStats,
  type EventResultsFile,
  type MotorEvent,
  type ResultRow,
  type RosterFile,
  type Series,
  type Session,
  type SessionResult,
  type Source,
  type StandingsFile,
} from '@dm/shared';
import { driversIndex } from '../src/core/driver-files.ts';
import { buildDrivers, buildTeams } from '../src/core/drivers.ts';
import {
  applyOfficialWins,
  buildSeasonStats,
  buildTeamSeasonStats,
  distinctSessions,
  isMultiClass,
  lapMs,
  poleRows,
  raceOutcome,
} from '../src/core/season-stats.ts';

const source: Source = { url: 'https://example.org/', title: 'x', kind: 'html', method: 'directo', fetchedAt: '2026-11-10T00:00:00Z' };
const series = (id: string, group: Series['group'] = 'otros'): Series => ({
  id,
  name: id.toUpperCase(),
  shortName: id.toUpperCase(),
  group,
  officialUrls: ['https://example.org/'],
  strategy: 'generic',
  origin: 'default',
  enabled: true,
});
const event = (id: string, seriesId: string, dateStart: string, extra: Partial<MotorEvent> = {}): MotorEvent => ({
  id,
  seriesId,
  name: id,
  round: 1,
  circuit: 'Circuito',
  country: 'Argentina',
  tz: 'America/Argentina/Buenos_Aires',
  dateStart,
  dateEnd: dateStart,
  sessionsStatus: 'published',
  source,
  ...extra,
});
const session = (id: string, eventId: string, seriesId: string, type: Session['type'], startUtc: string, name: string = type): Session => ({
  id,
  eventId,
  seriesId,
  type,
  name,
  startUtc,
  endUtc: startUtc.replace(':00Z', ':30Z'),
  endEstimated: true,
  broadcast: [],
  broadcastIsDefault: true,
  source,
  hasResults: true,
});
const result = (sessionId: string, rows: ResultRow[]): SessionResult => ({ sessionId, rows, source });
const file = (seriesId: string, eventId: string, sessions: SessionResult[]): EventResultsFile => ({
  seriesId,
  eventId,
  updatedAt: '2026-11-10T00:00:00Z',
  sessions,
});
/** Renglones a partir de nombres en orden de llegada: "Ana Uno" es P1, etc. Un objeto se usa tal cual. */
const rows = (...list: Array<string | ResultRow>): ResultRow[] =>
  list.map((x, i) => (typeof x === 'string' ? { pos: i + 1, driver: x } : x));
const standings = (seriesId: string, tables: StandingsFile['tables'], season = 2026): StandingsFile => ({
  seriesId,
  season,
  updatedAt: '2026-11-10T00:00:00Z',
  tables,
  source,
});
const roster = (seriesId: string, list: RosterFile['rows']): RosterFile => ({ seriesId, season: 2026, updatedAt: '2026-11-10T00:00:00Z', rows: list, source });

/** Todos los nombres tienen ficha (id por nombre). */
const everyone = (name: string, seriesId: string) => driverId(name, seriesId) || null;
const statsOf = (out: Map<string, DriverSeasonStats[]>, name: string, seriesId?: string): DriverSeasonStats | undefined =>
  (out.get(driverId(name)) ?? []).find((s) => !seriesId || s.seriesId === seriesId);

describe('estado de un renglón de carrera', () => {
  it('distingue no largó, abandono, descalificado, clasificado y sin dato', () => {
    expect(raceOutcome({ pos: 4 })).toBe('finished');
    // No largó: no es carrera ni abandono.
    for (const status of ['DNS', 'dns', 'DNQ', 'WD', 'No largó', 'NOTSTARTED']) expect(raceOutcome({ pos: null, status })).toBe('not-started');
    // Abandonos, con o sin posición (NASCAR y F1 clasifican a quien abandona).
    for (const status of ['DNF', 'RET', 'Accident', 'Engine', 'Too Slow', 'NOTONRESTARTGRID', 'OUTOFLAPS']) {
      expect(raceOutcome({ pos: null, status })).toBe('retired');
    }
    expect(raceOutcome({ pos: 17, status: 'DNF' })).toBe('retired');
    expect(raceOutcome({ pos: 38, status: 'Accident', laps: 12 })).toBe('retired');
    expect(raceOutcome({ pos: null, status: 'DNF', laps: 0 })).toBe('retired');
    // Descalificado: corrió, pero no es un abandono.
    for (const status of ['DSQ', 'DQ', 'EX', 'DISQUALIFIED']) expect(raceOutcome({ pos: null, status })).toBe('disqualified');
    expect(raceOutcome({ pos: 37, status: 'DSQ' })).toBe('disqualified');
    // No clasificado con vueltas: largó. Con 0 vueltas no se sabe si largó.
    expect(raceOutcome({ pos: null, status: 'NC', laps: 45 })).toBe('retired');
    expect(raceOutcome({ pos: null, status: 'NC' })).toBe('retired');
    expect(raceOutcome({ pos: null, status: 'NC', laps: 0 })).toBe('unknown');
    // Sin posición y sin estado (los que no entraron a la carrera en NASCAR).
    expect(raceOutcome({ pos: null, laps: 0 })).toBe('unknown');
    expect(raceOutcome({ pos: null, status: 'Sin tiempo' })).toBe('unknown');
  });
});

describe('números de la temporada', () => {
  it('cuenta carreras, victorias, podios, top 5 y 10, mejor puesto, promedio y abandonos', () => {
    const field = ['Ana Uno', 'Beto Dos', 'Caro Tres', 'Dani Cuatro', 'Eva Cinco', 'Fede Seis', 'Gabi Siete', 'Hugo Ocho', 'Ines Nueve', 'Juan Diez', 'Kari Once'];
    const out = buildSeasonStats(
      {
        series: [series('tc2000')],
        events: [event('e1', 'tc2000', '2026-03-01'), event('e2', 'tc2000', '2026-04-01', { round: 2 }), event('e3', 'tc2000', '2026-05-01', { round: 3 })],
        sessions: [
          session('r1', 'e1', 'tc2000', 'carrera', '2026-03-01T15:00:00Z'),
          session('r2', 'e2', 'tc2000', 'carrera', '2026-04-01T15:00:00Z'),
          session('r3', 'e3', 'tc2000', 'carrera', '2026-05-01T15:00:00Z'),
        ],
        results: [
          file('tc2000', 'e1', [result('r1', rows(...field))]),
          file('tc2000', 'e2', [result('r2', rows('Beto Dos', 'Caro Tres', 'Ana Uno', { pos: null, status: 'DNF', driver: 'Kari Once', laps: 3 }))]),
          file('tc2000', 'e3', [result('r3', rows('Caro Tres', 'Dani Cuatro', 'Beto Dos', 'Eva Cinco', 'Fede Seis', 'Ana Uno', { pos: null, status: 'DNS', driver: 'Kari Once', laps: 0 }))]),
        ],
      },
      everyone,
    );
    expect(statsOf(out, 'Ana Uno')).toEqual({ seriesId: 'tc2000', season: 2026, races: 3, wins: 1, podiums: 2, top5: 2, top10: 3, dnfs: 0, bestPos: 1, avgPos: 3.3 });
    // P11, abandono y una que no largó: dos carreras, un abandono, y la que no largó no cuenta.
    expect(statsOf(out, 'Kari Once')).toEqual({ seriesId: 'tc2000', season: 2026, races: 2, wins: 0, podiums: 0, top5: 0, top10: 0, dnfs: 1, bestPos: 11, avgPos: 11 });
    // Sin clasificaciones con resultado no hay dato de poles (no es "0 poles").
    expect(statsOf(out, 'Ana Uno')).not.toHaveProperty('poles');
  });

  it('un piloto que solo figura como "no largó" no tiene números', () => {
    const out = buildSeasonStats(
      {
        series: [series('f2')],
        sessions: [session('r1', 'e1', 'f2', 'carrera', '2026-03-01T15:00:00Z')],
        results: [file('f2', 'e1', [result('r1', rows('Ana Uno', { pos: null, status: 'DNS', driver: 'Beto Dos' }))])],
      },
      everyone,
    );
    expect(out.has(driverId('Beto Dos'))).toBe(false);
    expect(statsOf(out, 'Ana Uno')?.races).toBe(1);
  });

  it('descalificado: carrera disputada sin puesto y sin abandono; "NC" con 0 vueltas y sin estado no se cuentan', () => {
    const out = buildSeasonStats(
      {
        series: [series('f3')],
        sessions: [session('r1', 'e1', 'f3', 'carrera', '2026-03-01T15:00:00Z')],
        results: [
          file('f3', 'e1', [
            result(
              'r1',
              rows(
                'Ana Uno',
                { pos: null, status: 'DSQ', driver: 'Beto Dos' },
                { pos: null, status: 'NC', driver: 'Caro Tres', laps: 0 },
                { pos: null, driver: 'Dani Cuatro', laps: 0 },
                { pos: null, status: 'NC', driver: 'Eva Cinco', laps: 40 },
              ),
            ),
          ]),
        ],
      },
      everyone,
    );
    expect(statsOf(out, 'Beto Dos')).toEqual({ seriesId: 'f3', season: 2026, races: 1, wins: 0, podiums: 0, top5: 0, top10: 0, dnfs: 0 });
    expect(out.has(driverId('Caro Tres'))).toBe(false);
    expect(out.has(driverId('Dani Cuatro'))).toBe(false);
    expect(statsOf(out, 'Eva Cinco')).toMatchObject({ races: 1, dnfs: 1 });
  });

  it('F1 y MotoGP: el sprint no es una carrera (victorias aparte); en F2 sí', () => {
    const sessions = (id: string) => [
      session(`${id}-sprint`, `${id}-e1`, id, 'sprint', '2026-03-07T15:00:00Z', 'Sprint'),
      session(`${id}-race`, `${id}-e1`, id, 'carrera', '2026-03-08T15:00:00Z', 'Carrera'),
    ];
    const results = (id: string) => [
      file(id, `${id}-e1`, [result(`${id}-sprint`, rows('Ana Uno', 'Beto Dos', 'Caro Tres')), result(`${id}-race`, rows('Beto Dos', 'Ana Uno', 'Caro Tres'))]),
    ];
    const out = buildSeasonStats(
      {
        series: [series('f1'), series('motogp'), series('f2')],
        sessions: ['f1', 'motogp', 'f2'].flatMap(sessions),
        results: ['f1', 'motogp', 'f2'].flatMap(results),
      },
      everyone,
    );
    for (const id of ['f1', 'motogp']) {
      expect(statsOf(out, 'Ana Uno', id)).toEqual({ seriesId: id, season: 2026, races: 1, wins: 0, podiums: 1, top5: 1, top10: 1, dnfs: 0, bestPos: 2, avgPos: 2, sprintWins: 1 });
      expect(statsOf(out, 'Beto Dos', id)).toMatchObject({ races: 1, wins: 1, podiums: 1 });
      expect(statsOf(out, 'Beto Dos', id)).not.toHaveProperty('sprintWins');
    }
    expect(statsOf(out, 'Ana Uno', 'f2')).toEqual({ seriesId: 'f2', season: 2026, races: 2, wins: 1, podiums: 2, top5: 2, top10: 2, dnfs: 0, bestPos: 1, avgPos: 1.5 });
    // Un piloto en varias categorías: una entrada por categoría, en el orden de la configuración.
    expect(out.get(driverId('Ana Uno'))!.map((s) => s.seriesId)).toEqual(['f1', 'motogp', 'f2']);
  });

  it('nacionales con series y final: solo la final es una carrera', () => {
    const out = buildSeasonStats(
      {
        series: [series('tc', 'argentina')],
        events: [event('e1', 'tc', '2026-03-01')],
        sessions: [
          session('q', 'e1', 'tc', 'clasificacion', '2026-02-28T15:00:00Z', 'Clasificación'),
          session('s1', 'e1', 'tc', 'serie', '2026-03-01T12:00:00Z', '1ª Serie'),
          session('s2', 'e1', 'tc', 'serie', '2026-03-01T12:30:00Z', '2ª Serie'),
          session('f', 'e1', 'tc', 'carrera', '2026-03-01T16:00:00Z', 'Final'),
        ],
        results: [
          file('tc', 'e1', [
            result('q', rows({ pos: 1, driver: 'CANAPINO, Agustin', time: '1:31.204' }, { pos: 2, driver: 'WERNER, Mariano', time: '1:31.300' })),
            result('s1', rows('CANAPINO, Agustin')),
            result('s2', rows('WERNER, Mariano')),
            result('f', rows('WERNER, Mariano', 'CANAPINO, Agustin')),
          ]),
        ],
      },
      everyone,
    );
    expect(statsOf(out, 'Agustín Canapino')).toEqual({ seriesId: 'tc', season: 2026, races: 1, wins: 0, podiums: 1, top5: 1, top10: 1, dnfs: 0, bestPos: 2, avgPos: 2, poles: 1 });
    expect(statsOf(out, 'Mariano Werner')).toMatchObject({ races: 1, wins: 1, poles: 0 });
  });

  it('NASCAR: no cuentan exhibiciones ni Duels, el que no entró a la carrera no largó y la carrera postergada va una vez', () => {
    const out = buildSeasonStats(
      {
        series: [series('nascar-truck', 'usa')],
        events: [
          event('clash', 'nascar-truck', '2026-02-01', { round: undefined }),
          event('duel', 'nascar-truck', '2026-02-12', { round: undefined }),
          event('e1', 'nascar-truck', '2026-02-15', { round: 1 }),
          event('e2', 'nascar-truck', '2026-05-22', { round: 2 }),
        ],
        sessions: [
          session('clash-r', 'clash', 'nascar-truck', 'carrera', '2026-02-01T20:00:00Z'),
          session('duel-r', 'duel', 'nascar-truck', 'serie', '2026-02-12T20:00:00Z'),
          session('e1-q', 'e1', 'nascar-truck', 'clasificacion', '2026-02-14T20:00:00Z'),
          session('e1-r', 'e1', 'nascar-truck', 'carrera', '2026-02-15T20:00:00Z'),
          // Postergada por lluvia: quedó con los tres horarios y el mismo resultado.
          session('e2-q', 'e2', 'nascar-truck', 'clasificacion', '2026-05-22T20:00:00Z'),
          session('e2-r1', 'e2', 'nascar-truck', 'carrera', '2026-05-22T23:00:00Z'),
          session('e2-r2', 'e2', 'nascar-truck', 'carrera', '2026-05-24T01:00:00Z'),
          session('e2-r3', 'e2', 'nascar-truck', 'carrera', '2026-05-24T14:00:00Z'),
        ],
        results: [
          file('nascar-truck', 'clash', [result('clash-r', rows('Ana Uno', 'Beto Dos'))]),
          file('nascar-truck', 'duel', [result('duel-r', rows('Ana Uno', 'Beto Dos'))]),
          file('nascar-truck', 'e1', [
            result('e1-q', rows({ pos: 1, driver: 'Beto Dos', time: '48.210' }, { pos: 2, driver: 'Ana Uno' })),
            result(
              'e1-r',
              rows('Beto Dos', { pos: 2, driver: 'Ana Uno', status: 'Accident', laps: 90 }, { pos: 3, driver: 'Caro Tres', status: 'DSQ' }, { pos: null, driver: 'Dani Cuatro', laps: 0 }),
            ),
          ]),
          file('nascar-truck', 'e2', [
            // Clasificación suspendida: la grilla se ordenó por reglamento. NASCAR le acredita la pole al primero igual.
            result('e2-q', rows({ pos: 1, driver: 'Ana Uno', status: 'Sin tiempo' }, { pos: 2, driver: 'Beto Dos', status: 'Sin tiempo' })),
            ...['e2-r1', 'e2-r2', 'e2-r3'].map((id) => result(id, rows('Ana Uno', 'Beto Dos'))),
          ]),
        ],
      },
      everyone,
    );
    expect(statsOf(out, 'Ana Uno')).toEqual({ seriesId: 'nascar-truck', season: 2026, races: 2, wins: 1, podiums: 2, top5: 2, top10: 2, dnfs: 1, bestPos: 1, avgPos: 1.5, poles: 1 });
    expect(statsOf(out, 'Beto Dos')).toMatchObject({ races: 2, wins: 1, poles: 1 });
    // Descalificado con puesto (NASCAR lo deja último): carrera con ese puesto, sin abandono.
    expect(statsOf(out, 'Caro Tres')).toMatchObject({ races: 1, dnfs: 0, bestPos: 3 });
    expect(out.has(driverId('Dani Cuatro'))).toBe(false);
  });

  it('solo la última temporada con resultados; los ensayos no cuentan', () => {
    const out = buildSeasonStats(
      {
        series: [series('imsa-x')],
        events: [
          event('old', 'imsa-x', '2026-10-01', { round: 10 }),
          event('test', 'imsa-x', '2027-01-10', { round: undefined, kind: 'test' }),
          event('new', 'imsa-x', '2027-01-25', { round: 1 }),
        ],
        sessions: [
          session('old-r', 'old', 'imsa-x', 'carrera', '2026-10-01T15:00:00Z'),
          session('test-r', 'test', 'imsa-x', 'carrera', '2027-01-10T15:00:00Z'),
          session('new-r', 'new', 'imsa-x', 'carrera', '2027-01-25T15:00:00Z'),
        ],
        results: [
          file('imsa-x', 'old', [result('old-r', rows('Ana Uno', 'Beto Dos'))]),
          file('imsa-x', 'test', [result('test-r', rows('Ana Uno', 'Beto Dos'))]),
          file('imsa-x', 'new', [result('new-r', rows('Beto Dos', 'Ana Uno'))]),
        ],
      },
      everyone,
    );
    expect(statsOf(out, 'Ana Uno')).toMatchObject({ season: 2027, races: 1, wins: 0 });
    expect(statsOf(out, 'Beto Dos')).toMatchObject({ season: 2027, races: 1, wins: 1 });
  });

  it('solo pilotos con ficha', () => {
    const out = buildSeasonStats(
      {
        series: [series('f2')],
        sessions: [session('r1', 'e1', 'f2', 'carrera', '2026-03-01T15:00:00Z')],
        results: [file('f2', 'e1', [result('r1', rows('Ana Uno', 'Beto Dos'))])],
      },
      (name) => (name === 'Ana Uno' ? 'ana-uno' : null),
    );
    expect([...out.keys()]).toEqual(['ana-uno']);
  });
});

describe('categorías con clases y tripulaciones', () => {
  it('reconoce las categorías con clases por la lista o por los inscriptos', () => {
    expect(isMultiClass('wec')).toBe(true);
    expect(isMultiClass('f1')).toBe(false);
    expect(isMultiClass('f1', roster('f1', [{ driver: 'A B' }, { driver: 'C D' }]))).toBe(false);
    expect(isMultiClass('otra', roster('otra', [{ driver: 'A B', class: 'Pro' }, { driver: 'C D', class: 'pro' }]))).toBe(false);
    expect(isMultiClass('otra', roster('otra', [{ driver: 'A B', class: 'Pro' }, { driver: 'C D', class: 'Am' }]))).toBe(true);
  });

  it('WEC: la tripulación suma a cada piloto y solo se publica lo que es cierto en la general', () => {
    const out = buildSeasonStats(
      {
        series: [series('wec', 'gt-endurance')],
        events: [event('spa', 'wec', '2026-05-09')],
        sessions: [session('q', 'spa', 'wec', 'clasificacion', '2026-05-08T15:00:00Z'), session('r', 'spa', 'wec', 'carrera', '2026-05-09T12:00:00Z')],
        results: [
          file('wec', 'spa', [
            result('q', rows({ pos: 1, driver: 'Kevin ESTRE / Laurens VANTHOOR', time: '2:01.300' })),
            result(
              'r',
              rows(
                'Kevin ESTRE / Laurens VANTHOOR / Matt CAMPBELL',
                // Ganadores de LMGT3: 19.º en la general.
                { pos: 19, driver: 'Valentino ROSSI / Kelvin VAN DER LINDE' },
                { pos: null, status: 'DNF', driver: 'Robert KUBICA / Yifei YE' },
              ),
            ),
          ]),
        ],
      },
      everyone,
    );
    // El ganador de la clase LMGT3 no aparece con "0 victorias": la app no muestra victorias en una categoría con clases.
    expect(statsOf(out, 'Valentino Rossi')).toEqual({ seriesId: 'wec', season: 2026, races: 1, wins: 0, podiums: 0, top5: 0, top10: 0, dnfs: 0, bestPos: 19, overall: true });
    for (const name of ['Kevin Estre', 'Laurens Vanthoor', 'Matt Campbell']) {
      const s = statsOf(out, name)!;
      expect(s).toMatchObject({ races: 1, bestPos: 1, dnfs: 0, overall: true });
      // Ni promedio ni poles: en la general no dicen nada de la clase.
      expect(s).not.toHaveProperty('avgPos');
      expect(s).not.toHaveProperty('poles');
    }
    expect(statsOf(out, 'Robert Kubica')).toEqual({ seriesId: 'wec', season: 2026, races: 1, wins: 0, podiums: 0, top5: 0, top10: 0, dnfs: 1, overall: true });
  });

  it('una categoría que no está en la lista pero inscribe varias clases también va solo con la general', () => {
    const input = {
      series: [series('copa-gt')],
      sessions: [session('r', 'e1', 'copa-gt', 'carrera', '2026-05-09T12:00:00Z')],
      results: [file('copa-gt', 'e1', [result('r', rows('Ana Uno', 'Beto Dos'))])],
    };
    expect(statsOf(buildSeasonStats(input, everyone), 'Ana Uno')).not.toHaveProperty('overall');
    const withRoster = { ...input, rosters: [roster('copa-gt', [{ driver: 'Ana Uno', class: 'Pro' }, { driver: 'Beto Dos', class: 'Am' }])] };
    expect(statsOf(buildSeasonStats(withRoster, everyone), 'Beto Dos')).toMatchObject({ overall: true, bestPos: 2 });
  });

  it('un piloto en dos autos de la misma carrera cuenta una carrera, con su mejor resultado', () => {
    const out = buildSeasonStats(
      {
        series: [series('tcr')],
        sessions: [session('r', 'e1', 'tcr', 'carrera', '2026-05-09T12:00:00Z')],
        results: [
          file('tcr', 'e1', [
            result('r', rows({ pos: null, status: 'DNF', driver: 'Ana Uno / Beto Dos' }, { pos: 4, driver: 'Ana Uno / Caro Tres' }, { pos: 7, driver: 'Ana Uno / Dani Cuatro' })),
          ]),
        ],
      },
      everyone,
    );
    expect(statsOf(out, 'Ana Uno')).toEqual({ seriesId: 'tcr', season: 2026, races: 1, wins: 0, podiums: 0, top5: 1, top10: 1, dnfs: 0, bestPos: 4, avgPos: 4 });
    expect(statsOf(out, 'Beto Dos')).toMatchObject({ races: 1, dnfs: 1 });
  });
});

describe('poles', () => {
  const q = (id: string, name: string, startUtc: string, originalName?: string): Session => ({
    ...session(id, 'e1', 'x', 'clasificacion', startUtc, name),
    ...(originalName ? { originalName } : {}),
  });
  const map = (...list: SessionResult[]) => new Map(list.map((r) => [r.sessionId, r]));
  const timed = (...list: Array<[string, string]>): ResultRow[] => list.map(([driver, time], i) => ({ pos: i + 1, driver, ...(i === 0 ? { time } : { gap: time }) }));
  const names = (list: ResultRow[]) => list.map((r) => r.driver);

  it('tiempos de vuelta', () => {
    expect(lapMs('1:20.923')).toBe(80923);
    expect(lapMs('58.3')).toBe(58300);
    expect(lapMs('+0.130')).toBeNull();
    expect(lapMs(undefined)).toBeNull();
  });

  it('una clasificación: el primero', () => {
    const sessions = [q('q', 'Clasificación', '2026-03-07T15:00:00Z')];
    expect(names(poleRows(sessions, map(result('q', timed(['Ana Uno', '1:20.000'], ['Beto Dos', '+0.1'])))))).toEqual(['Ana Uno']);
    // Suspendida y ordenada por reglamento (NASCAR): la pole es del primero aunque no tenga tiempo.
    expect(names(poleRows(sessions, map(result('q', rows({ pos: 1, driver: 'Ana Uno', status: 'Sin tiempo' })))))).toEqual(['Ana Uno']);
    // Un primero descalificado no, y sin resultado tampoco.
    expect(poleRows(sessions, map(result('q', rows({ pos: 1, driver: 'Ana Uno', status: 'DSQ' }, { pos: 2, driver: 'Beto Dos' }))))).toEqual([]);
    expect(poleRows(sessions, map())).toEqual([]);
  });

  it('la clasificación del sprint no da pole', () => {
    const sessions = [q('sq', 'Clasificación sprint', '2026-03-06T15:00:00Z', 'Sprint Qualifying'), q('q', 'Clasificación', '2026-03-07T15:00:00Z', 'Qualifying')];
    const results = map(result('sq', timed(['Beto Dos', '1:21.000'])), result('q', timed(['Ana Uno', '1:20.000'])));
    expect(names(poleRows(sessions, results))).toEqual(['Ana Uno']);
  });

  it('MotoGP: solo Q2; si Q2 todavía no tiene resultado, nadie', () => {
    const sessions = [q('q1', 'Clasificación Q1', '2026-03-07T10:00:00Z'), q('q2', 'Clasificación Q2', '2026-03-07T10:25:00Z')];
    const q1 = result('q1', timed(['Beto Dos', '1:29.288'], ['Caro Tres', '+0.2']));
    const q2 = result('q2', timed(['Ana Uno', '1:29.634'], ['Beto Dos', '+0.1'], ['Caro Tres', '+0.2']));
    expect(names(poleRows(sessions, map(q1, q2)))).toEqual(['Ana Uno']);
    expect(poleRows(sessions, map(q1))).toEqual([]);
  });

  it('por grupos (Mónaco): una sola pole, la del mejor tiempo', () => {
    const sessions = [q('a', 'Clasificación A', '2026-06-05T13:10:00Z'), q('b', 'Clasificación B', '2026-06-05T13:34:00Z')];
    const a = result('a', timed(['Ana Uno', '1:20.923'], ['Caro Tres', '+0.2']));
    const b = result('b', timed(['Beto Dos', '1:21.053'], ['Dani Cuatro', '+0.2']));
    expect(names(poleRows(sessions, map(a, b)))).toEqual(['Ana Uno']);
    // Falta un grupo, o no hay tiempos para comparar: no se sabe.
    expect(poleRows(sessions, map(a))).toEqual([]);
    expect(poleRows(sessions, map(a, result('b', rows('Beto Dos', 'Dani Cuatro'))))).toEqual([]);
  });

  it('dos clasificaciones con los mismos pilotos (una por carrera): una pole cada una', () => {
    const sessions = [q('q1', 'Clasificación 1', '2026-09-24T10:00:00Z'), q('q2', 'Clasificación 2', '2026-09-24T10:30:00Z')];
    const first = result('q1', timed(['Ana Uno', '1:55.383'], ['Beto Dos', '+0.2'], ['Caro Tres', '+0.3']));
    const second = result('q2', timed(['Beto Dos', '1:53.728'], ['Ana Uno', '+0.2'], ['Caro Tres', '+0.3']));
    expect(names(poleRows(sessions, map(first, second)))).toEqual(['Ana Uno', 'Beto Dos']);
  });

  it('una ronda final con parte de los pilotos (Top 10 Shootout) deja sin pole a la ronda previa', () => {
    const sessions = [q('q', 'Clasificación', '2026-10-10T02:00:00Z'), q('s', 'Top 10 Shootout', '2026-10-10T05:00:00Z')];
    const all = ['Ana Uno', 'Beto Dos', 'Caro Tres', 'Dani Cuatro', 'Eva Cinco'];
    const results = map(result('q', timed(...all.map((n): [string, string] => [n, '2:05.000']))), result('s', timed(['Caro Tres', '2:04.100'], ['Ana Uno', '+0.2'])));
    expect(names(poleRows(sessions, results))).toEqual(['Caro Tres']);
  });
});

describe('la tabla oficial manda en las victorias', () => {
  const base: DriverSeasonStats = { seriesId: 'motogp', season: 2026, races: 18, wins: 5, podiums: 6, top5: 9, top10: 14, dnfs: 2, bestPos: 1, avgPos: 4.2 };
  const entry = (wins?: number, table?: string) => ({ seriesId: 'motogp', pos: 1, points: 400, ...(wins !== undefined ? { wins } : {}), ...(table ? { table } : {}) });
  const season = () => 2026;

  it('sin diferencia, sin tabla con victorias o con otra temporada: quedan las calculadas', () => {
    expect(applyOfficialWins([base], [entry(5)], season)).toEqual([base]);
    expect(applyOfficialWins([base], [entry()], season)).toEqual([base]);
    expect(applyOfficialWins([base], [], season)).toEqual([base]);
    expect(applyOfficialWins([base], [entry(9)], () => 2025)).toEqual([base]);
    expect(applyOfficialWins([base], [entry(9)], () => undefined)).toEqual([base]);
  });

  it('si la tabla dice más (falta un resultado), van las oficiales y los podios no quedan por debajo', () => {
    expect(applyOfficialWins([base], [entry(7)], season)).toEqual([{ ...base, wins: 7, podiums: 7 }]);
    const short: DriverSeasonStats = { ...base, races: 2, wins: 0, podiums: 0, top5: 0, top10: 1, bestPos: 8 };
    expect(applyOfficialWins([short], [entry(2)], season)).toEqual([{ ...short, wins: 2, podiums: 2, top5: 2, top10: 2, bestPos: 1 }]);
  });

  it('si la tabla dice menos, van las oficiales y el resto no se toca', () => {
    expect(applyOfficialWins([base], [entry(4)], season)).toEqual([{ ...base, wins: 4 }]);
  });

  it('con varias tablas de pilotos en la categoría no se sabe cuál sumar', () => {
    expect(applyOfficialWins([base], [entry(7, 'General'), entry(3, 'Sprint Cup')], season)).toEqual([base]);
  });

  it('en una categoría con clases no se tocan', () => {
    const overall: DriverSeasonStats = { seriesId: 'wec', season: 2026, races: 8, wins: 0, podiums: 0, top5: 0, top10: 0, dnfs: 1, bestPos: 19, overall: true };
    expect(applyOfficialWins([overall], [{ seriesId: 'wec', pos: 1, points: 150, wins: 3 }], season)).toEqual([overall]);
  });
});

describe('sesiones repetidas', () => {
  it('se queda con el último horario de una carrera cargada varias veces', () => {
    const sessions = new Map(
      [
        session('a', 'e1', 'x', 'carrera', '2026-05-22T23:00:00Z'),
        session('b', 'e1', 'x', 'carrera', '2026-05-24T14:00:00Z'),
        session('c', 'e1', 'x', 'carrera', '2026-05-25T14:00:00Z'),
        session('p', 'e1', 'x', 'practica', '2026-05-22T14:00:00Z'),
      ].map((s) => [s.id, s]),
    );
    const f = file('x', 'e1', [
      result('a', rows('Ana Uno', 'Beto Dos')),
      result('b', rows('Ana Uno', 'Beto Dos')),
      // Otra carrera del mismo evento, con otro resultado.
      result('c', rows('Beto Dos', 'Ana Uno')),
      result('p', rows('Ana Uno', 'Beto Dos')),
    ]);
    expect(distinctSessions(f, sessions, new Set(['carrera'] as const)).map((x) => x.session.id)).toEqual(['b', 'c']);
  });
});

describe('fichas de pilotos con números de la temporada', () => {
  const input = {
    series: [series('motogp', 'moto'), series('wec', 'gt-endurance')],
    standings: [
      standings('motogp', [
        {
          title: 'Pilotos',
          rows: [
            { pos: 1, name: 'Marc Marquez', points: 431, wins: 2 },
            { pos: 2, name: 'Jorge Martin', points: 371, wins: 0 },
          ],
        },
      ]),
      standings('wec', [{ title: 'Pilotos Hypercar', rows: [{ pos: 1, name: 'Marc Marquez / Kevin Estre', points: 150 }] }]),
    ],
    events: [event('gp1', 'motogp', '2026-03-01'), event('spa', 'wec', '2026-05-09')],
    sessions: [
      session('gp1-q2', 'gp1', 'motogp', 'clasificacion', '2026-02-28T10:00:00Z', 'Clasificación Q2'),
      session('gp1-s', 'gp1', 'motogp', 'sprint', '2026-02-28T14:00:00Z', 'Sprint'),
      session('gp1-r', 'gp1', 'motogp', 'carrera', '2026-03-01T13:00:00Z', 'Carrera'),
      session('gp1-r-bis', 'gp1', 'motogp', 'carrera', '2026-03-01T15:00:00Z', 'Carrera'),
      session('spa-r', 'spa', 'wec', 'carrera', '2026-05-09T12:00:00Z', 'Carrera'),
    ],
    results: [
      file('motogp', 'gp1', [
        result('gp1-q2', rows({ pos: 1, driver: 'Jorge Martin', time: '1:28.652' }, 'Marc Marquez')),
        result('gp1-s', rows('Marc Marquez', 'Jorge Martin')),
        result('gp1-r', rows('Marc Marquez', { pos: null, status: 'DNF', driver: 'Jorge Martin', laps: 12 }, 'Piloto Sin Ficha')),
        result('gp1-r-bis', rows('Marc Marquez', { pos: null, status: 'DNF', driver: 'Jorge Martin', laps: 12 }, 'Piloto Sin Ficha')),
      ]),
      file('wec', 'spa', [result('spa-r', rows({ pos: 3, driver: 'Marc MARQUEZ / Kevin ESTRE' }))]),
    ],
    generatedAt: '2026-11-10T00:00:00Z',
  };

  it('van en la ficha completa (no en el índice), con las victorias de la tabla oficial', () => {
    const built = buildDrivers(input);
    expect(driversFileSchema.parse(built)).toBeTruthy();
    const marquez = built.drivers.find((d) => d.id === 'marc-marquez')!;
    expect(marquez.stats).toEqual([
      // La tabla oficial dice 2 victorias (falta el resultado de una carrera): mandan, y los podios acompañan.
      { seriesId: 'motogp', season: 2026, races: 1, wins: 2, podiums: 2, top5: 2, top10: 2, dnfs: 0, bestPos: 1, avgPos: 1, poles: 0, sprintWins: 1 },
      { seriesId: 'wec', season: 2026, races: 1, wins: 0, podiums: 1, top5: 1, top10: 1, dnfs: 0, bestPos: 3, overall: true },
    ]);
    const martin = built.drivers.find((d) => d.id === 'jorge-martin')!;
    expect(martin.stats).toEqual([{ seriesId: 'motogp', season: 2026, races: 1, wins: 0, podiums: 0, top5: 0, top10: 0, dnfs: 1, poles: 1 }]);
    // Estre no corrió en MotoGP: solo su categoría.
    expect(built.drivers.find((d) => d.id === 'estre-kevin')!.stats!.map((s) => s.seriesId)).toEqual(['wec']);
    // La carrera cargada dos veces aparece una sola vez en las últimas carreras, con el último horario.
    expect(marquez.recent.filter((r) => r.eventId === 'gp1' && r.sessionId.startsWith('gp1-r'))).toEqual([
      { seriesId: 'motogp', eventId: 'gp1', sessionId: 'gp1-r-bis', startUtc: '2026-03-01T15:00:00Z', pos: 1 },
    ]);

    const index = driversIndex(built);
    expect(driversIndexFileSchema.parse(index)).toBeTruthy();
    for (const d of index.drivers) {
      expect(d).not.toHaveProperty('stats');
      expect(d).not.toHaveProperty('recent');
    }
  });

  it('un piloto sin carreras con resultado no lleva el campo', () => {
    const built = buildDrivers({ ...input, results: [], sessions: [] });
    for (const d of built.drivers) expect(d).not.toHaveProperty('stats');
  });
});

describe('números de la temporada de un equipo', () => {
  const row = (pos: number | null, driver: string, team: string, extra: Partial<ResultRow> = {}): ResultRow => ({ pos, driver, team, ...extra });

  it('cuenta lo que hicieron sus autos en cada carrera, no la temporada de sus pilotos', () => {
    const input = {
      series: [series('f1'), series('wec', 'gt-endurance')],
      events: [event('gp1', 'f1', '2026-03-08'), event('gp2', 'f1', '2026-03-22', { round: 2 }), event('spa', 'wec', '2026-05-09')],
      sessions: [
        session('gp1-q', 'gp1', 'f1', 'clasificacion', '2026-03-07T15:00:00Z', 'Clasificación'),
        session('gp1-s', 'gp1', 'f1', 'sprint', '2026-03-07T11:00:00Z', 'Sprint'),
        session('gp1-r', 'gp1', 'f1', 'carrera', '2026-03-08T15:00:00Z', 'Carrera'),
        session('gp2-r', 'gp2', 'f1', 'carrera', '2026-03-22T15:00:00Z', 'Carrera'),
        session('spa-r', 'spa', 'wec', 'carrera', '2026-05-09T12:00:00Z', 'Carrera'),
      ],
      results: [
        file('f1', 'gp1', [
          result('gp1-q', [row(1, 'Ana Uno', 'MERCEDES', { time: '1:20.000' }), row(2, 'Beto Dos', 'Mercedes')]),
          result('gp1-s', [row(1, 'Beto Dos', 'Mercedes'), row(2, 'Caro Tres', 'McLaren')]),
          result('gp1-r', [
            row(1, 'Ana Uno', 'Mercedes'),
            row(2, 'Beto Dos', 'Mercedes'),
            row(null, 'Caro Tres', 'McLaren', { status: 'DNS', laps: 0 }),
            row(null, 'Dani Cuatro', 'McLaren', { status: 'DNS', laps: 0 }),
            { pos: 3, driver: 'Sin Equipo' },
          ]),
        ]),
        // Caro Tres pasó a Mercedes: lo que hizo con McLaren no se le suma a Mercedes ni al revés.
        file('f1', 'gp2', [result('gp2-r', [row(1, 'Caro Tres', 'Mercedes'), row(null, 'Ana Uno', 'Mercedes', { status: 'DNF', laps: 3 }), row(4, 'Dani Cuatro', 'McLaren')])]),
        file('wec', 'spa', [result('spa-r', [row(2, 'Ana Uno / Beto Dos / Caro Tres', 'Team WRT #31'), row(null, 'Dani Cuatro / Eva Cinco', 'TEAM WRT', { status: 'DNF' })])]),
      ],
    };
    const out = buildTeamSeasonStats(input);
    // 1-2 en una carrera: una victoria y dos podios. La pole y el sprint, aparte.
    expect(out.get('mercedes')).toEqual([{ seriesId: 'f1', season: 2026, races: 2, wins: 2, podiums: 3, dnfs: 1, bestPos: 1, poles: 1, sprintWins: 1 }]);
    // En la primera fecha no largó ninguno de sus autos: no es una carrera del equipo.
    expect(out.get('mclaren')).toEqual([{ seriesId: 'f1', season: 2026, races: 1, wins: 0, podiums: 0, dnfs: 0, bestPos: 4, poles: 0 }]);
    // Una tripulación es un auto (un podio, no tres); con clases, solo lo de la general.
    expect(out.get('team-wrt')).toEqual([{ seriesId: 'wec', season: 2026, races: 1, wins: 0, podiums: 1, dnfs: 1, bestPos: 2, overall: true }]);
    expect([...out.keys()].sort()).toEqual(['mclaren', 'mercedes', 'team-wrt']);

    const standingsFiles = [
      standings('f1', [
        { title: 'Pilotos', rows: [{ pos: 1, name: 'Ana Uno', points: 25, team: 'Mercedes' }] },
        { title: 'Constructores', rows: [{ pos: 1, name: 'Mercedes', points: 43 }] },
      ]),
    ];
    const all = { ...input, standings: standingsFiles, generatedAt: '2026-11-10T00:00:00Z' };
    const teams = buildTeams({ ...all, drivers: buildDrivers(all) });
    expect(teamsFileSchema.parse(teams)).toBeTruthy();
    // Solo los equipos que ya tienen ficha; McLaren no figura en ninguna tabla ni lista.
    expect(teams.teams.map((t) => [t.id, t.stats?.[0]?.wins])).toEqual([['mercedes', 2]]);
  });
});
