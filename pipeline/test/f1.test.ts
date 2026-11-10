import { describe, expect, it } from 'vitest';
import type { Series } from '@dm/shared';
import { f1Adapter } from '../src/adapters/f1.ts';
import { sessionTimes } from '../src/adapters/fom.ts';
import { createContext } from '../src/core/context.ts';
import { createLogger } from '../src/core/log.ts';
import { fakeHttp, fixture } from './fake-http.ts';

const series: Series = {
  id: 'f1',
  name: 'Fórmula 1',
  shortName: 'F1',
  group: 'f1-fia',
  officialUrls: ['https://www.formula1.com/en/racing/2026'],
  strategy: 'adapter',
  adapter: 'f1',
  origin: 'default',
  enabled: true,
};

const BASE = 'https://www.formula1.com';
const SLUGS = ['pre-season-testing-1', 'australia', 'brazil', 'qatar', 'united-arab-emirates'];

function routes(overrides: Record<string, string> = {}): Record<string, string> {
  const r: Record<string, string> = { [`${BASE}/en/racing/2026`]: fixture('f1/season-2026.html') };
  for (const s of SLUGS) r[`${BASE}/en/racing/2026/${s}`] = fixture(`f1/round-${s}.html`);
  return { ...r, ...overrides };
}

function ctxWith(http: ReturnType<typeof fakeHttp>) {
  return createContext({
    now: new Date('2026-11-10T12:34:56.789Z'),
    http,
    log: createLogger('test', true),
    durations: { f1: { practica: 60, clasificacion: 60, sprint: 60, carrera: 120 } },
    broadcast: { f1: ['Disney+'] },
  });
}

describe('lector F1 (formula1.com)', () => {
  it('lee el calendario y el cronograma de cada ronda con horas UTC', async () => {
    const http = fakeHttp(routes());
    const { events, sessions } = await f1Adapter.schedule(series, ctxWith(http));
    expect(events).toHaveLength(5);

    const qatar = events.find((e) => e.name === 'Qatar Grand Prix')!;
    expect(qatar).toMatchObject({
      round: 22,
      circuit: 'Lusail International Circuit',
      country: 'Qatar',
      tz: 'Asia/Qatar',
      dateStart: '2026-11-27',
      dateEnd: '2026-11-29',
      sessionsStatus: 'published',
    });
    expect(qatar.source).toEqual({
      url: 'https://www.formula1.com/en/racing/2026/qatar',
      title: expect.stringContaining('QATAR GRAND PRIX 2026'),
      kind: 'html',
      method: 'directo',
      fetchedAt: '2026-11-10T12:34:56Z',
    });

    const qs = sessions.filter((s) => s.eventId === qatar.id);
    expect(qs.map((s) => [s.type, s.name, s.startUtc, s.localStartText])).toEqual([
      ['practica', 'Practice 1', '2026-11-27T13:30:00Z', '16:30'],
      ['practica', 'Practice 2', '2026-11-27T17:00:00Z', '20:00'],
      ['practica', 'Practice 3', '2026-11-28T14:30:00Z', '17:30'],
      ['clasificacion', 'Qualifying', '2026-11-28T18:00:00Z', '21:00'],
      ['carrera', 'Race', '2026-11-29T16:00:00Z', '19:00'],
    ]);
    const race = qs.at(-1)!;
    expect(race.endUtc).toBe('2026-11-29T18:00:00Z');
    expect(race.endEstimated).toBe(false);
    expect(race.broadcast).toEqual(['Disney+']);

    const abuDhabi = events.find((e) => e.name === 'Abu Dhabi Grand Prix')!;
    expect(abuDhabi).toMatchObject({ tz: 'Asia/Dubai', dateStart: '2026-12-04', country: 'United Arab Emirates' });
    expect(sessions.find((s) => s.eventId === abuDhabi.id && s.name === 'Race')!.startUtc).toBe('2026-12-06T13:00:00Z');
  });

  it('respeta el horario de verano del circuito (Melbourne, AEDT +11)', async () => {
    const http = fakeHttp(routes());
    const { events, sessions } = await f1Adapter.schedule(series, ctxWith(http));
    const aus = events.find((e) => e.tz === 'Australia/Melbourne')!;
    const fp1 = sessions.find((s) => s.eventId === aus.id && s.name === 'Practice 1')!;
    expect(fp1.localStartText).toBe('12:30');
    expect(fp1.startUtc).toBe('2026-03-06T01:30:00Z');
    // Con la hora local sola (sin offset) se convierte con la zona IANA: mismo resultado en verano…
    expect(sessionTimes({ session: 'p1', startTime: '2026-03-06T12:30:00' }, 'Australia/Melbourne')!.startUtc).toBe(
      '2026-03-06T01:30:00Z',
    );
    // …y una hora menos de diferencia después del fin del horario de verano (5/4/2026).
    expect(sessionTimes({ session: 'p1', startTime: '2026-04-10T12:30:00' }, 'Australia/Melbourne')!.startUtc).toBe(
      '2026-04-10T02:30:00Z',
    );
  });

  it('los ensayos de pretemporada no llevan número de ronda', async () => {
    const http = fakeHttp(routes());
    const { events, sessions } = await f1Adapter.schedule(series, ctxWith(http));
    const test = events.find((e) => e.name === 'Pre-Season Testing')!;
    expect(test.round).toBeUndefined();
    expect(sessions.filter((s) => s.eventId === test.id).map((s) => s.type)).toEqual(['practica', 'practica', 'practica']);
  });

  it('una ronda con horarios "TBC" queda pendiente y sin sesiones', async () => {
    const tbc = fixture('f1/round-qatar.html').replaceAll('\\"state\\":', '\\"sessionStatus\\":\\"TBC\\",\\"state\\":');
    const http = fakeHttp(routes({ [`${BASE}/en/racing/2026/qatar`]: tbc }));
    const { events, sessions } = await f1Adapter.schedule(series, ctxWith(http));
    const qatar = events.find((e) => e.name === 'Qatar Grand Prix')!;
    expect(qatar.sessionsStatus).toBe('pending');
    expect(qatar.dateStart).toBe('2026-11-27');
    expect(sessions.some((s) => s.eventId === qatar.id)).toBe(false);
  });

  it('falla si la página de la ronda no trae el cronograma', async () => {
    const http = fakeHttp(routes({ [`${BASE}/en/racing/2026/qatar`]: '<html><body>Mantenimiento</body></html>' }));
    await expect(f1Adapter.schedule(series, ctxWith(http))).rejects.toThrow(/cronograma/);
  });

  it('lee resultados de las sesiones terminadas y el campeonato', async () => {
    const res = `${BASE}/en/results/2026`;
    const http = fakeHttp(
      routes({
        [`${res}/races/1299/brazil/race-result`]: fixture('f1/results-brazil-race.html'),
        [`${res}/races/1299/brazil/qualifying`]: fixture('f1/results-brazil-qualifying.html'),
        [`${res}/drivers`]: fixture('f1/standings-drivers.html'),
        [`${res}/team`]: fixture('f1/standings-team.html'),
      }),
    );
    const ctx = ctxWith(http);
    const { events, sessions } = await f1Adapter.schedule(series, ctx);
    const brazil = events.find((e) => e.name === 'São Paulo Grand Prix')!;
    const pending = sessions
      .filter((s) => s.eventId === brazil.id && ['Race', 'Qualifying', 'Practice 1'].includes(s.name))
      .reverse();
    const out = await f1Adapter.results!(series, ctx, { events, sessions, pendingSessions: pending, standingsStale: true });

    expect(out.results).toHaveLength(1);
    const file = out.results[0]!;
    expect(file.eventId).toBe(brazil.id);
    // Practice 1 no tiene página en el fake (404): se omite sin fallar.
    expect(file.sessions.map((s) => sessions.find((x) => x.id === s.sessionId)!.name)).toEqual(['Race', 'Qualifying']);

    const race = file.sessions[0]!;
    expect(race.source.url).toBe(`${res}/races/1299/brazil/race-result`);
    expect(race.rows[0]).toEqual({
      pos: 1,
      driver: 'Lando Norris',
      number: '1',
      team: 'McLaren',
      laps: 71,
      time: '1:35:23.504',
      points: 25,
    });
    expect(race.rows[1]).toMatchObject({ pos: 2, driver: 'Max Verstappen', gap: '+14.602s', points: 18 });
    expect(race.rows.at(-1)).toMatchObject({ pos: null, status: 'NC', driver: 'Valtteri Bottas' });

    const quali = file.sessions[1]!;
    expect(quali.rows[0]).toMatchObject({ pos: 1, driver: 'Lando Norris', time: '1:27.470', laps: 24 });

    expect(out.standings).toMatchObject({ seriesId: 'f1', season: 2026, updatedAt: '2026-11-10T12:34:56Z' });
    const [drivers, teams] = out.standings!.tables;
    expect(drivers!.title).toBe('Pilotos');
    expect(drivers!.rows[0]).toEqual({ pos: 1, name: 'Kimi Antonelli', team: 'Mercedes', points: 390 });
    expect(teams!.title).toBe('Constructores');
    expect(teams!.rows[0]).toEqual({ pos: 1, name: 'Mercedes', points: 652 });
  });
});
