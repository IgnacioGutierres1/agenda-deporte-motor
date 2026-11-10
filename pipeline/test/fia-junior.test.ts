import { describe, expect, it } from 'vitest';
import type { Series } from '@dm/shared';
import { fiaJuniorAdapter } from '../src/adapters/fia-junior.ts';
import { createContext } from '../src/core/context.ts';
import { createLogger } from '../src/core/log.ts';
import { fakeHttp, fixture } from './fake-http.ts';

function makeSeries(id: 'f2' | 'f3'): Series {
  return {
    id,
    name: id === 'f2' ? 'FIA Fórmula 2' : 'FIA Fórmula 3',
    shortName: id.toUpperCase(),
    group: 'f1-fia',
    officialUrls: [`https://www.fiaformula${id[1]}.com/Calendar`],
    strategy: 'adapter',
    adapter: 'fia-junior',
    origin: 'default',
    enabled: true,
  };
}
const f2 = makeSeries('f2');
const f3 = makeSeries('f3');

const F2 = 'https://www.fiaformula2.com';
const F3 = 'https://www.fiaformula3.com';

function f2Routes(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [`${F2}/en/racing/2026`]: fixture('fia-junior/f2-calendar-2026.html'),
    [`${F2}/en/racing/2026/melbourne`]: fixture('fia-junior/f2-melbourne.html'),
    [`${F2}/en/racing/2026/madrid`]: fixture('fia-junior/f2-madrid.html'),
    [`${F2}/en/racing/2026/lusail`]: fixture('fia-junior/f2-lusail.html'),
    [`${F2}/en/racing/2026/yas-marina`]: fixture('fia-junior/f2-yas-marina.html'),
    ...overrides,
  };
}

function ctxWith(http: ReturnType<typeof fakeHttp>) {
  return createContext({
    now: new Date('2026-11-10T12:00:00.000Z'),
    http,
    log: createLogger('test', true),
    durations: { f2: { practica: 45, clasificacion: 30, sprint: 45, carrera: 60 } },
  });
}

describe('lector F2/F3 (fiaformula2.com / fiaformula3.com)', () => {
  it('lee las rondas del calendario con su número y el cronograma propio de F2', async () => {
    const http = fakeHttp(f2Routes());
    const { events, sessions } = await fiaJuniorAdapter.schedule(f2, ctxWith(http));
    expect(events.map((e) => [e.round, e.source.url.split('/').at(-1)])).toEqual([
      [1, 'melbourne'],
      [11, 'madrid'],
      [13, 'lusail'],
      [14, 'yas-marina'],
    ]);
    // Nunca se consulta formula1.com (REGLA F2).
    expect(http.calls.every((u) => u.startsWith(F2))).toBe(true);

    const madrid = events.find((e) => e.round === 11)!;
    expect(madrid).toMatchObject({
      circuit: 'Madring',
      country: 'Spain',
      tz: 'Europe/Madrid',
      dateStart: '2026-09-11',
      dateEnd: '2026-09-13',
      sessionsStatus: 'published',
    });
    expect(madrid.source).toMatchObject({
      url: 'https://www.fiaformula2.com/en/racing/2026/madrid',
      kind: 'html',
      method: 'directo',
      fetchedAt: '2026-11-10T12:00:00Z',
    });
    const ms = sessions.filter((s) => s.eventId === madrid.id);
    expect(ms.map((s) => [s.type, s.name, s.localStartText, s.startUtc, s.endUtc, s.endEstimated])).toEqual([
      ['practica', 'Practice', '11:05', '2026-09-11T09:05:00Z', '2026-09-11T09:50:00Z', false],
      ['clasificacion', 'Qualifying', '15:00', '2026-09-11T13:00:00Z', '2026-09-11T13:30:00Z', false],
      ['sprint', 'Sprint Race', '14:15', '2026-09-12T12:15:00Z', '2026-09-12T13:05:00Z', false],
      ['carrera', 'Feature Race', '11:25', '2026-09-13T09:25:00Z', '2026-09-13T10:30:00Z', false],
    ]);
  });

  it('convierte con el horario de verano del circuito (Melbourne, +11)', async () => {
    const http = fakeHttp(f2Routes());
    const { events, sessions } = await fiaJuniorAdapter.schedule(f2, ctxWith(http));
    const mel = events.find((e) => e.round === 1)!;
    expect(mel.tz).toBe('Australia/Melbourne');
    const practice = sessions.find((s) => s.eventId === mel.id && s.type === 'practica')!;
    expect(practice.localStartText).toBe('10:00');
    expect(practice.startUtc).toBe('2026-03-05T23:00:00Z');
  });

  it('las rondas con cronograma "TBC" (Lusail, Yas Marina) quedan pendientes y sin sesiones', async () => {
    const http = fakeHttp(f2Routes());
    const { events, sessions } = await fiaJuniorAdapter.schedule(f2, ctxWith(http));
    const lusail = events.find((e) => e.round === 13)!;
    const yas = events.find((e) => e.round === 14)!;
    expect(lusail).toMatchObject({ sessionsStatus: 'pending', tz: 'Asia/Qatar', dateStart: '2026-11-27', dateEnd: '2026-11-29' });
    expect(yas).toMatchObject({ sessionsStatus: 'pending', tz: 'Asia/Dubai', dateStart: '2026-12-04', dateEnd: '2026-12-06' });
    expect(sessions.some((s) => s.eventId === lusail.id || s.eventId === yas.id)).toBe(false);
  });

  it('descarta sesiones que no son de la categoría pedida', async () => {
    const page = fixture('fia-junior/f2-madrid.html').replaceAll('\\"value\\":\\"f2/race', '\\"value\\":\\"f1/race');
    const http = fakeHttp(f2Routes({ [`${F2}/en/racing/2026/madrid`]: page }));
    const { events, sessions } = await fiaJuniorAdapter.schedule(f2, ctxWith(http));
    const madrid = events.find((e) => e.round === 11)!;
    expect(sessions.filter((s) => s.eventId === madrid.id).map((s) => s.name)).toEqual(['Practice', 'Qualifying']);
  });

  it('F3 usa su propio sitio y conserva sesiones con nombres numerados', async () => {
    const http = fakeHttp({
      [`${F3}/en/racing/2026`]: fixture('fia-junior/f3-calendar-2026.html'),
      [`${F3}/en/racing/2026/madrid`]: fixture('fia-junior/f3-madrid.html'),
    });
    const { events, sessions } = await fiaJuniorAdapter.schedule(f3, ctxWith(http));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ round: 9, seriesId: 'f3' });
    expect(events[0]!.source.url).toBe('https://www.fiaformula3.com/en/racing/2026/madrid');
    expect(sessions.map((s) => [s.type, s.name])).toEqual([
      ['practica', 'Practice'],
      ['clasificacion', 'Qualifying 1'],
      ['clasificacion', 'Qualifying 2'],
      ['sprint', 'Sprint Race'],
      ['carrera', 'Feature Race 1'],
      ['carrera', 'Feature Race 2'],
    ]);
    expect(new Set(sessions.map((s) => s.id)).size).toBe(6);
  });

  it('rechaza series desconocidas', async () => {
    const http = fakeHttp({});
    await expect(fiaJuniorAdapter.schedule({ ...f2, id: 'f4' }, ctxWith(http))).rejects.toThrow(/f4/);
  });

  it('lee los resultados embebidos en la página de la ronda y el campeonato', async () => {
    const http = fakeHttp(
      f2Routes({
        [`${F2}/en/standings/2026/drivers`]: fixture('fia-junior/f2-standings-drivers.html'),
        [`${F2}/en/standings/2026/teams`]: fixture('fia-junior/f2-standings-teams.html'),
      }),
    );
    const ctx = ctxWith(http);
    const { events, sessions } = await fiaJuniorAdapter.schedule(f2, ctx);
    const madrid = events.find((e) => e.round === 11)!;
    const pending = sessions.filter((s) => s.eventId === madrid.id).reverse();
    const out = await fiaJuniorAdapter.results!(f2, ctx, { events, sessions, pendingSessions: pending, standingsStale: true });

    expect(out.results).toHaveLength(1);
    const file = out.results[0]!;
    expect(file).toMatchObject({ seriesId: 'f2', eventId: madrid.id, updatedAt: '2026-11-10T12:00:00Z' });
    expect(file.sessions).toHaveLength(1);
    const feature = file.sessions[0]!;
    expect(feature.sessionId).toBe(pending[0]!.id);
    expect(feature.source.url).toBe('https://www.fiaformula2.com/en/racing/2026/madrid');
    expect(feature.rows[0]).toEqual({
      pos: 1,
      driver: 'Dino Beganovic',
      number: '7',
      team: 'DAMS Lucas Oil',
      laps: 31,
      time: '1:3:29.190',
      points: 25,
    });
    expect(feature.rows[1]).toMatchObject({ pos: 2, driver: 'Alexander Dunne', gap: '+7.320s', points: 19 });
    expect(feature.rows.at(-1)).toMatchObject({ pos: null, status: 'DNF', driver: 'Kush Maini', laps: 1 });

    const [drivers, teams] = out.standings!.tables;
    expect(drivers).toMatchObject({ title: 'Pilotos' });
    expect(drivers!.rows[0]).toEqual({ pos: 1, name: 'Rafael Câmara', points: 207 });
    expect(teams).toMatchObject({ title: 'Equipos' });
    expect(teams!.rows.map((r) => r.name)).toEqual(['Campos Racing', 'Invicta Racing', 'Rodin Motorsport']);
    expect(out.standings!.source.url).toBe('https://www.fiaformula2.com/en/standings/2026/drivers');
  });
});
