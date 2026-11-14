import { describe, expect, it } from 'vitest';
import type { Session } from '@dm/shared';
import { createGenericAdapter } from '../src/generic/index.ts';
import { ACO_TIMING_RESULTS, acoRaceSessions, acoResultRows, acoResultsPageSessions } from '../src/generic/results-aco.ts';
import { imsaResultRows, imsaResultsApi } from '../src/generic/results-imsa.ts';
import { fakeGemini, fakeHttp, fixture, genericSeries, testContext } from './fakes.ts';

const WEC = 'https://www.fiawec.com/en/season/2026';
const MONZA = 'https://www.fiawec.com/en/race/6-hours-of-monza-2026';
const ALMS = 'https://www.asianlemansseries.com/en/season/2026';
const CASTELLET = 'https://www.asianlemansseries.com/en/race/4-hours-of-le-castellet-by-alms-2026';
const IMSA = 'https://www.imsa.com/schedule?series=weathertech';

const wec = genericSeries('wec', 'FIA World Endurance Championship', [WEC], { shortName: 'WEC' });
const alms = genericSeries('alms', 'Asian Le Mans Series', [ALMS], { shortName: 'ALMS', group: 'asia' });
const imsa = genericSeries('imsa', 'IMSA WeatherTech SportsCar Championship', [IMSA], { shortName: 'IMSA' });

const label = (s: Session) => s.originalName ?? s.name;

describe('ACO: cronograma de la página de la carrera', () => {
  it('nombre, hora UTC, hora local e id de cada sesión (link de resultados o de repetición)', () => {
    const list = acoRaceSessions(fixture('aco-race-le-castellet-alms-2026-schedule.html'), CASTELLET);
    expect(list.map((s) => [s.name, s.startUtc, s.localStartText, s.sessionId])).toEqual([
      ['Free Practice 1', '2026-11-13T09:10:00Z', '10:10', '8314'],
      ['Free Practice 2', '2026-11-13T12:30:00Z', '13:30', '8315'],
      ['Qualifications 1 - GT3', '2026-11-13T15:05:00Z', '16:05', '8316'],
      ['Qualifications 2 - GT3', '2026-11-13T15:25:00Z', '16:25', '8319'],
      ['Qualifications 1 - Hypercar & LMP2', '2026-11-13T15:50:00Z', '16:50', '8318'],
      ['Qualifications 2 - Hypercar & LMP2', '2026-11-13T16:10:00Z', '17:10', '8321'],
      // Las carreras todavía no tienen link: el id sale del selector de la página de resultados.
      ['Race 1', '2026-11-14T12:15:00Z', '13:15', undefined],
      ['Race 2', '2026-11-15T12:15:00Z', '13:15', undefined],
    ]);
    expect(list[2]!.resultsUrl).toBe('https://www.asianlemansseries.com/en/page/results?raceId=5073&sessionId=8316');
    expect(acoResultsPageSessions(fixture('aco-results-page-alms-5073.html')).slice(0, 3)).toEqual([
      { name: 'RACE 2', sessionId: '8323' },
      { name: 'RACE 1', sessionId: '8322' },
      { name: 'QUALIFICATIONS 2 - HYPERCAR & LMP2', sessionId: '8321' },
    ]);
  });

  it('clasificación del cronometraje: clase, puesto en clase, tripulación, auto, vueltas, diferencia y mejor vuelta', () => {
    const rows = acoResultRows(JSON.parse(fixture('aco-timing-8321.json')));
    expect(rows).toEqual([
      { pos: 1, number: '90', driver: 'Luis Perez Companc / Yifei Ye / Nicklas Nielsen', team: 'AF Corse', vehicle: 'Ferrari 499P', laps: 8, bestLap: '1:50.794', class: 'Hypercar', classPos: 1 },
      { pos: 2, number: '47', driver: 'Roberto Lacorte / Nicola Lacorte / Antonio Fuoco', team: 'Cetilar Racing', vehicle: 'Ferrari 499P', laps: 8, gap: '+0.611', bestLap: '1:51.405', class: 'Hypercar', classPos: 2 },
      { pos: 3, number: '11', driver: 'Georgios Kolovos / Victor Martins / Charles Milesi', team: 'Proton Competition', vehicle: 'Oreca 07 - Gibson', laps: 6, gap: '+1.161', bestLap: '1:51.955', class: 'LMP2', classPos: 1 },
      { pos: 4, number: '22', driver: 'Giorgio Roda / Ian Aguilera / Sting Ray Robb', team: 'United Autosports', vehicle: 'Oreca 07 - Gibson', laps: 4, gap: '+1.376', bestLap: '1:52.170', class: 'LMP2', classPos: 2 },
    ]);
    expect(acoResultRows({ message: 'No data' })).toEqual([]);
    expect(() => acoResultRows({ foo: 1 })).toThrow(/classification/);
  });
});

describe('ACO: resultados por lectura directa (flujo genérico)', () => {
  it('Asian LMS en Paul Ricard: cada clasificación por separado; la Carrera 1 sin datos todavía no cuenta', async () => {
    const http = fakeHttp({
      [ALMS]: fixture('alms-season-2026.html'),
      [CASTELLET]: fixture('aco-race-le-castellet-alms-2026-schedule.html'),
      'https://www.asianlemansseries.com/en/page/results?raceId=5073': fixture('aco-results-page-alms-5073.html'),
      [`${ACO_TIMING_RESULTS}8316`]: fixture('aco-timing-8316.json'),
      [`${ACO_TIMING_RESULTS}8321`]: fixture('aco-timing-8321.json'),
      [`${ACO_TIMING_RESULTS}8322`]: '{"message":"No data"}',
    });
    const gemini = fakeGemini();
    const adapter = createGenericAdapter({ gemini: () => gemini });
    const ctx = testContext(http, '2026-11-14T17:00:00Z');
    const chunk = await adapter.schedule(alms, ctx);
    const event = chunk.events.find((e) => e.name === '4 Hours of Le Castellet')!;
    const sessions = chunk.sessions.filter((s) => s.eventId === event.id);
    const pending = sessions.filter((s) => s.endUtc < '2026-11-14T17:00:00Z');
    expect(pending.map(label)).toContain('Race 1');

    const out = await adapter.results!(alms, ctx, { events: chunk.events, pendingSessions: pending, sessions, standingsStale: false });
    const byName = new Map(out.results[0]!.sessions.map((r) => [label(sessions.find((s) => s.id === r.sessionId)!), r]));
    expect([...byName.keys()].sort()).toEqual(['Qualifications 1 - GT3', 'Qualifications 2 - Hypercar & LMP2']);
    const q1 = byName.get('Qualifications 1 - GT3')!;
    expect(q1.rows[0]).toEqual({
      pos: 1, number: '9', driver: 'Steve Jans / Anthony Bartone / Fabian Schiller', team: 'Getspeed', vehicle: 'Mercedes-AMG GT3 Evo',
      laps: 7, bestLap: '2:02.879', class: 'GT3', classPos: 1,
    });
    expect(q1.rows[1]).toMatchObject({ pos: 2, number: '58', gap: '+0.066', classPos: 2 });
    // Sin vueltas cronometradas: va al final, sin diferencia ni mejor vuelta.
    expect(q1.rows.at(-1)).toMatchObject({ pos: 28, number: '88', laps: 0 });
    expect(q1.rows.at(-1)!.bestLap).toBeUndefined();
    expect(q1.source).toMatchObject({ url: 'https://www.asianlemansseries.com/en/page/results?raceId=5073&sessionId=8316', kind: 'api', method: 'directo' });
    expect(byName.get('Qualifications 2 - Hypercar & LMP2')!.rows.map((r) => [r.number, r.class, r.classPos])).toEqual([
      ['90', 'Hypercar', 1], ['47', 'Hypercar', 2], ['11', 'LMP2', 1], ['22', 'LMP2', 2],
    ]);
    // La Carrera 1 se buscó por el selector (8322) y todavía no tiene datos: no se publica nada.
    expect(http.requested).toContain(`${ACO_TIMING_RESULTS}8322`);
    expect(out.deferred ?? []).toEqual([]);
    expect(gemini.requests).toHaveLength(0);
  });

  it('WEC: una fecha ya corrida sin sesiones guardadas las reconstruye del cronograma y lee la carrera', async () => {
    const http = fakeHttp({
      [WEC]: fixture('fiawec-season-2026.html'),
      [MONZA]: fixture('aco-race-monza-2026-schedule.html'),
      [`${ACO_TIMING_RESULTS}8292`]: fixture('aco-timing-8292.json'),
    });
    const gemini = fakeGemini();
    const adapter = createGenericAdapter({ gemini: () => gemini });
    const ctx = testContext(http, '2026-11-14T12:00:00Z');
    const chunk = await adapter.schedule(wec, ctx);
    const monza = chunk.events.find((e) => e.name === '6 Hours of Monza')!;
    const sessions = chunk.sessions.filter((s) => s.eventId === monza.id);
    expect(sessions.map((s) => [label(s), s.startUtc, s.localStartText])).toEqual([
      ['Free Practice 1', '2026-11-06T09:30:00Z', '10:30'],
      ['Free Practice 2', '2026-11-06T13:30:00Z', '14:30'],
      ['Free Practice 3', '2026-11-07T09:30:00Z', '10:30'],
      ['Qualifying - LMGT3', '2026-11-07T13:20:00Z', '14:20'],
      ['Hyperpole - LMGT3', '2026-11-07T13:40:00Z', '14:40'],
      ['Qualifying - HYPERCAR', '2026-11-07T14:00:00Z', '15:00'],
      ['Hyperpole - HYPERCAR', '2026-11-07T14:20:00Z', '15:20'],
      ['Race', '2026-11-08T10:00:00Z', '11:00'],
    ]);

    const out = await adapter.results!(wec, ctx, { events: chunk.events, pendingSessions: sessions, sessions, standingsStale: false });
    expect(out.results).toHaveLength(1);
    const race = out.results[0]!.sessions;
    expect(race.map((r) => label(sessions.find((s) => s.id === r.sessionId)!))).toEqual(['Race']);
    expect(race[0]!.rows.map((r) => [r.pos, r.number, r.class, r.classPos, r.laps, r.gap ?? null])).toEqual([
      [1, '38', 'Hypercar', 1, 191, null],
      [2, '36', 'Hypercar', 2, 191, '+5.607'],
      [3, '51', 'Hypercar', 3, 191, '+35.767'],
      [15, '92', 'LMGT3', 1, 173, '+18 Laps'],
      [16, '23', 'LMGT3', 2, 173, '+18 Laps'],
      [28, '12', 'Hypercar', 4, 188, '+3 Laps'],
    ]);
    expect(race[0]!.rows[0]!.driver).toBe('Earl Bamber / Sébastien Bourdais / Jack Aitken');
    expect(race[0]!.source.url).toBe('https://www.fiawec.com/en/page/resultats-1?raceId=5066&sessionId=8292');
    expect(gemini.requests).toHaveLength(0);
  });
});

describe('IMSA: resultados desde /api/imsa-results', () => {
  const api = (event?: number, session?: number) => imsaResultsApi(1, 2026, event, session);

  it('carrera: tiempo del ganador, vueltas perdidas con la general y abandono; clasificación: diferencia con el primero de la clase', () => {
    const race = imsaResultRows(JSON.parse(fixture('imsa-results-2026-322.json')), { type: 'R', raceTime: '24:01:20.108' });
    expect(race[0]).toEqual({
      pos: 1, number: '7', driver: 'Felipe Nasr / Laurin Heinrich / Julien Andlauer', team: 'Porsche Penske Motorsport', vehicle: 'Porsche 963',
      laps: 705, bestLap: '1:36.414', class: 'GTP', classPos: 1, time: '24:01:20.108',
    });
    const dnf = race.find((r) => r.status === 'DNF')!;
    expect(dnf.pos).not.toBeNull();
    expect(dnf.gap).toMatch(/^\+\d+ Laps?$/);

    const quali = imsaResultRows(JSON.parse(fixture('imsa-results-2026-322-2927.json')), { type: 'Q' });
    expect(quali.map((r) => [r.pos, r.class, r.classPos, r.number, r.bestLap, r.gap ?? null])).toEqual([
      [1, 'GTP', 1, '31', '1:33.939', null],
      [2, 'GTP', 2, '93', '1:34.041', '+0.102'],
      [12, 'LMP2', 1, '43', '1:39.952', null],
      [13, 'LMP2', 2, '99', '1:39.960', '+0.008'],
      // GTD Pro y GTD clasifican juntos: la general las mezcla, la diferencia es con el primero de cada clase.
      [25, 'GTD Pro', 1, '3', '1:45.106', null],
      [26, 'GTD', 1, '27', '1:45.113', null],
      [27, 'GTD', 2, '57', '1:45.187', '+0.074'],
      [30, 'GTD Pro', 2, '1', '1:45.276', '+0.170'],
    ]);
  });

  it('temporada terminada (sin /2026/schedule): calendario, sesiones y resultados desde la API', async () => {
    const http = fakeHttp({
      [api()]: fixture('imsa-results-2026.json'),
      [api(322)]: fixture('imsa-results-2026-322.json'),
      [api(322, 2927)]: fixture('imsa-results-2026-322-2927.json'),
      [api(322, 2947)]: fixture('imsa-results-2026-322.json'),
    });
    const gemini = fakeGemini();
    const adapter = createGenericAdapter({ gemini: () => gemini });
    const ctx = testContext(http, '2026-11-14T12:00:00Z');
    const chunk = await adapter.schedule(imsa, ctx);
    // Los demás eventos de la temporada no responden en el fake (404) y se omiten.
    expect(chunk.events.map((e) => [e.name, e.round, e.circuit, e.tz, e.dateStart, e.dateEnd])).toEqual([
      ['Rolex 24 at Daytona', 1, 'Daytona International Speedway', 'America/New_York', '2026-01-22', '2026-01-24'],
    ]);
    // La API solo da el día: hora local estimada (9, 11, 13…; la carrera no antes del mediodía), sin hora publicada.
    expect(chunk.sessions.map((s) => [label(s), s.type, s.startUtc, s.localStartText])).toEqual([
      ['Practice 1', 'practica', '2026-01-22T14:00:00Z', undefined],
      ['Practice 2', 'practica', '2026-01-22T16:00:00Z', undefined],
      ['Qualifying', 'clasificacion', '2026-01-22T18:00:00Z', undefined],
      ['Practice 3', 'practica', '2026-01-23T14:00:00Z', undefined],
      ['Race', 'carrera', '2026-01-24T17:00:00Z', undefined],
    ]);

    const out = await adapter.results!(imsa, ctx, { events: chunk.events, pendingSessions: chunk.sessions, sessions: chunk.sessions, standingsStale: false });
    const got = new Map(out.results[0]!.sessions.map((r) => [label(chunk.sessions.find((s) => s.id === r.sessionId)!), r]));
    expect([...got.keys()].sort()).toEqual(['Qualifying', 'Race']);
    expect(got.get('Race')!.rows[0]).toMatchObject({ pos: 1, number: '7', class: 'GTP', classPos: 1, time: '24:01:20.108' });
    expect(got.get('Qualifying')!.rows[0]).toMatchObject({ pos: 1, number: '31', class: 'GTP', bestLap: '1:33.939' });
    expect(got.get('Race')!.source).toMatchObject({ url: 'https://www.imsa.com/weathertech/results', kind: 'api', method: 'directo' });
    expect(gemini.requests).toHaveLength(0);
  });
});
