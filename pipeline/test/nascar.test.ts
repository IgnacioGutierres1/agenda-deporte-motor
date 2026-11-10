import { describe, expect, it } from 'vitest';
import { eventResultsFileSchema, eventSchema, sessionSchema, standingsFileSchema, type Series } from '@dm/shared';
import { createContext } from '../src/core/context.ts';
import { createLogger } from '../src/core/log.ts';
import { pendingResultSessions } from '../src/core/results.ts';
import { validateSessions } from '../src/validate.ts';
import { describeRun, nascarAdapter, nascarUtc, pickRun, type ApiRun } from '../src/adapters/nascar.ts';
import { trackInfo } from '../src/adapters/nascar-tracks.ts';
import { fixtureHttp } from './fixtures-http.ts';

const C = 'https://cf.nascar.com/cacher/2026';
const routes = {
  [`${C}/race_list_basic.json`]: 'nascar/race_list_basic.json',
  [`${C}/1/5601/weekend-feed.json`]: 'nascar/weekend-feed-1-5601.json',
  [`${C}/1/5596/weekend-feed.json`]: 'nascar/weekend-feed-1-5596.json',
  [`${C}/1/final/1-drivers-points.json`]: 'nascar/1-drivers-points.json',
  [`${C}/1/final/1-owners-points.json`]: 'nascar/1-owners-points.json',
  [`${C}/1/final/1-manufacturer-points.json`]: 'nascar/1-manufacturer-points.json',
};

function series(id: string, shortName: string): Series {
  return {
    id,
    name: shortName,
    shortName,
    group: 'usa',
    officialUrls: ['https://www.nascar.com/'],
    strategy: 'adapter',
    adapter: 'nascar',
    origin: 'default',
    enabled: true,
  };
}

function setup() {
  const http = fixtureHttp(routes);
  const ctx = createContext({
    now: new Date('2026-11-10T12:00:00Z'),
    http,
    log: createLogger('test', true),
    durations: { 'nascar-cup': { practica: 50, clasificacion: 60, carrera: 210 } },
    broadcast: { 'nascar-cup': ['Fox Sports'] },
  });
  return { http, ctx };
}

describe('NASCAR: helpers', () => {
  it('agrega la Z a las horas UTC del feed', () => {
    expect(nascarUtc('2026-11-08T20:00:00')).toBe('2026-11-08T20:00:00Z');
  });
  it('traduce las actividades del cronograma', () => {
    expect(describeRun('Qualifying (Impound)', 2)).toEqual({ type: 'clasificacion', name: 'Clasificación' });
    expect(describeRun('Practice 2', 1)).toEqual({ type: 'practica', name: 'Práctica 2' });
    expect(describeRun('Qualifying Race 1', 2)).toEqual({ type: 'serie', name: 'Carrera clasificatoria 1' });
    expect(describeRun('Race', 3)).toEqual({ type: 'carrera', name: 'Carrera' });
  });
  it('asigna zona horaria por circuito', () => {
    expect(trackInfo('Phoenix Raceway').tz).toBe('America/Phoenix');
    expect(trackInfo('Talladega Superspeedway').tz).toBe('America/Chicago');
    expect(trackInfo('Sonoma Raceway').tz).toBe('America/Los_Angeles');
    expect(trackInfo('Autódromo Hermanos Rodríguez')).toEqual({ tz: 'America/Mexico_City', country: 'MX' });
    expect(trackInfo('Martinsville Speedway').tz).toBe('America/New_York');
  });
  it('elige la tanda más cercana y, en empate, la ronda final', () => {
    const run = (id: number, name: string, utc: string, type = 2): ApiRun => ({
      timing_run_id: id,
      run_type: type,
      run_name: name,
      run_date_utc: utc,
      results: [{ car_number: '1', driver_name: 'X', finishing_position: 1 }],
    });
    const runs = [
      run(2, 'Pole Qualifying - Final Round', '2026-02-12T01:20:00'),
      run(1, 'Pole Qualifying - Round 1', '2026-02-12T01:20:00'),
      run(5, 'Practice 2', '2026-02-13T22:35:00', 1),
    ];
    expect(pickRun(runs, 2, '2026-02-12T01:15:00Z')?.timing_run_id).toBe(2);
    // Con varias prácticas en el cronograma, no se toma una tanda a más de 6 h.
    expect(pickRun(runs, 1, '2026-02-11T15:00:00Z', 3)).toBeUndefined();
    expect(pickRun(runs, 1, '2026-02-11T15:00:00Z', 1)?.timing_run_id).toBe(5);
  });
});

describe('NASCAR: horarios', () => {
  it('arma eventos y sesiones por serie, sin logística, en UTC', async () => {
    const { ctx } = setup();
    const cup = await nascarAdapter.schedule(series('nascar-cup', 'NASCAR Cup'), ctx);
    const xfinity = await nascarAdapter.schedule(series('nascar-xfinity', "NASCAR O'Reilly"), ctx);
    const truck = await nascarAdapter.schedule(series('nascar-truck', 'NASCAR Truck'), ctx);

    expect(cup.events.map((e) => e.name)).toEqual([
      'America 250 Florida Duel at DAYTONA',
      'DAYTONA 500',
      'Straight Talk Wireless 500',
      'NASCAR Cup Series Championship Race',
    ]);
    expect(xfinity.events.map((e) => e.name)).toEqual(["NASCAR O'Reilly Auto Parts Series Championship Race"]);
    expect(truck.events.map((e) => e.name)).toEqual(['NASCAR CRAFTSMAN Truck Series Championship Race']);

    // Homestead (Cup): 14 actividades en el feed, 3 sesiones deportivas.
    const home = cup.events[3]!;
    expect(home).toMatchObject({
      circuit: 'Homestead-Miami Speedway',
      country: 'Estados Unidos',
      tz: 'America/New_York',
      dateStart: '2026-11-06',
      dateEnd: '2026-11-08',
      sessionsStatus: 'published',
    });
    expect(home.source).toMatchObject({ url: `${C}/race_list_basic.json`, kind: 'api', method: 'directo' });
    const homeSessions = cup.sessions.filter((s) => s.eventId === home.id);
    expect(homeSessions.map((s) => [s.name, s.type, s.startUtc, s.localStartText])).toEqual([
      ['Práctica', 'practica', '2026-11-06T22:30:00Z', '17:30'],
      ['Clasificación', 'clasificacion', '2026-11-07T19:30:00Z', '14:30'],
      ['Carrera', 'carrera', '2026-11-08T20:00:00Z', '15:00'],
    ]);
    expect(homeSessions[2]).toMatchObject({ endUtc: '2026-11-08T23:30:00Z', endEstimated: true, broadcast: ['Fox Sports'] });

    // Daytona 500: 3 prácticas, clasificación y carrera.
    expect(cup.sessions.filter((s) => s.eventId === cup.events[1]!.id).map((s) => s.name)).toEqual([
      'Práctica 1',
      'Clasificación',
      'Práctica 2',
      'Práctica 3',
      'Carrera',
    ]);
    // Phoenix: hora local de Arizona (UTC-7, sin horario de verano).
    const phx = cup.sessions.find((s) => s.eventId === cup.events[2]!.id && s.type === 'carrera')!;
    expect(cup.events[2]!.tz).toBe('America/Phoenix');
    expect(phx.localStartText).toBe('12:30');
    // Duel: carrera clasificatoria; la fecha local es la del jueves aunque en UTC ya sea viernes.
    expect(cup.events[0]!.dateStart).toBe('2026-02-12');
    expect(cup.sessions.find((s) => s.eventId === cup.events[0]!.id)!.type).toBe('serie');
    expect(cup.events.map((e) => e.round)).toEqual([undefined, 1, 2, 3]);

    // Truck: la carrera termina el viernes local aunque en UTC sea sábado.
    expect(truck.events[0]).toMatchObject({ dateStart: '2026-11-05', dateEnd: '2026-11-06' });

    for (const c of [cup, xfinity, truck]) {
      for (const e of c.events) eventSchema.parse(e);
      for (const s of c.sessions) sessionSchema.parse(s);
      expect(validateSessions(c.sessions, c.events).issues).toEqual([]);
    }
    expect(xfinity.sessions).toHaveLength(3);
    expect(truck.sessions).toHaveLength(3);
  });
});

describe('NASCAR: resultados y campeonato', () => {
  it('mapea carrera, práctica, clasificación y puntos', async () => {
    const { ctx } = setup();
    const s = series('nascar-cup', 'NASCAR Cup');
    const chunk = await nascarAdapter.schedule(s, ctx);
    const pending = pendingResultSessions(chunk.sessions, ctx.now, {});
    expect(pending).toHaveLength(chunk.sessions.length);

    const res = await nascarAdapter.results!(s, ctx, {
      events: chunk.events,
      sessions: chunk.sessions,
      pendingSessions: pending,
      standingsStale: true,
    });
    const home = chunk.events[3]!;
    const daytona = chunk.events[1]!;
    const files = res.results.map((f) => eventResultsFileSchema.parse(f));
    // Duel y Phoenix no tienen fixture (404): se saltean sin cortar el resto.
    expect(files.map((f) => f.eventId).sort()).toEqual([home.id, daytona.id].sort());

    const homeFile = files.find((f) => f.eventId === home.id)!;
    const sid = (name: string) => chunk.sessions.find((x) => x.eventId === home.id && x.name === name)!.id;
    const race = homeFile.sessions.find((x) => x.sessionId === sid('Carrera'))!;
    expect(race.source.url).toBe(`${C}/1/5601/weekend-feed.json`);
    expect(race.rows[0]).toEqual({
      pos: 1,
      number: '12',
      driver: 'Ryan Blaney',
      team: 'Team Penske',
      vehicle: 'Ford',
      laps: 267,
      time: '3:00:00',
      points: 71,
    });
    expect(race.rows[1]).toMatchObject({ pos: 2, driver: 'Tyler Reddick', gap: '+0.314' });
    expect(race.rows[2]).toMatchObject({ pos: 26, gap: '+1 vuelta' });
    expect(race.rows[3]).toMatchObject({ driver: 'Chase Briscoe', status: 'Engine', pos: 39 });

    const quali = homeFile.sessions.find((x) => x.sessionId === sid('Clasificación'))!;
    expect(quali.rows[0]).toMatchObject({ pos: 1, driver: 'Chase Briscoe', bestLap: '32.396', vehicle: 'Toyota' });
    expect(quali.rows[1]).toMatchObject({ pos: 2, driver: 'Denny Hamlin', gap: '+0.017' });
    const practice = homeFile.sessions.find((x) => x.sessionId === sid('Práctica'))!;
    expect(practice.rows[0]).toMatchObject({ pos: 1, driver: 'Chase Briscoe', bestLap: '32.680' });

    // Daytona 500: el feed de carrera viene con posiciones en 0 → no se publica la carrera,
    // pero sí las prácticas y la clasificación (ronda final).
    const dayFile = files.find((f) => f.eventId === daytona.id)!;
    const dayNames = dayFile.sessions.map((x) => chunk.sessions.find((y) => y.id === x.sessionId)!.name).sort();
    expect(dayNames).toEqual(['Clasificación', 'Práctica 1', 'Práctica 2', 'Práctica 3']);

    const st = standingsFileSchema.parse(res.standings);
    expect(st.tables.map((t) => t.title)).toEqual(['Pilotos', 'Propietarios', 'Marcas']);
    expect(st.tables[0]!.rows[0]).toEqual({ pos: 1, name: 'Kyle Larson', number: '5', points: 2501, wins: 3 });
    expect(st.tables[1]!.rows[0]).toMatchObject({ pos: 1, name: 'Hendrick Motorsports #5', points: 2501 });
    expect(st.tables[2]!.rows[0]).toEqual({ pos: 1, name: 'Toyota', points: 1589, wins: 18 });
    expect(st.source.url).toBe(`${C}/1/final/1-drivers-points.json`);
  });
});
