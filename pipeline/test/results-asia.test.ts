import { describe, expect, it } from 'vitest';
import type { Session } from '@dm/shared';
import { macau } from '../src/generic/macau.ts';
import { conditionsOf, formatSeconds, gapText, lapTime } from '../src/generic/results-asia-kit.ts';
import { macauDriverName, macauPdfRows, macauResultDocs, macauSessionKey, type PdfItem } from '../src/generic/results-macau.ts';
import { supercarsResultRows, supercarsResults } from '../src/generic/results-supercars.ts';
import { superformulaResults } from '../src/generic/results-superformula.ts';
import { supergtClassRows, supergtResultMenu, supergtResults, supergtResultUrl } from '../src/generic/results-supergt.ts';
import { supercars, supercarsSessionName, supercarsSessions } from '../src/generic/supercars.ts';
import { superformula } from '../src/generic/superformula.ts';
import { supergt } from '../src/generic/supergt.ts';
import { supertaikyu } from '../src/generic/supertaikyu.ts';
import type { CalendarEntry, RecipeContext } from '../src/generic/types.ts';
import { fakeHttp, fixture, genericSeries } from './fakes.ts';

const NOW = new Date('2026-11-14T12:00:00Z');
const ctx = (routes: Record<string, string>, season = 2026): RecipeContext => ({
  season,
  series: genericSeries('x', 'X', ['https://example.com']),
  http: fakeHttp(routes),
  now: NOW,
});

const session = (id: string, name: string, startUtc = '2026-01-01T00:00:00Z', type: Session['type'] = 'practica'): Session => ({
  id,
  eventId: 'e',
  seriesId: 's',
  type,
  name,
  startUtc,
  endUtc: startUtc,
  endEstimated: false,
  broadcast: [],
  broadcastIsDefault: true,
  source: { url: 'https://example.com', title: '', kind: 'html', method: 'directo', fetchedAt: '2026-11-14T00:00:00Z' },
  hasResults: false,
});

const entry = (extra: Partial<CalendarEntry>): CalendarEntry => ({
  name: 'Fecha',
  circuit: '',
  country: 'Japan',
  tz: 'Asia/Tokyo',
  dateStart: '2026-11-06',
  dateEnd: '2026-11-08',
  ...extra,
});

describe('resultados: utilidades', () => {
  it('condiciones, tiempos y diferencias de los sitios japoneses y de Natsoft', () => {
    expect(conditionsOf('Sunny/Cloudy', 'Dry')).toEqual({ weather: 'Despejado / Nublado', track: 'Seca' });
    expect(conditionsOf('Cloudy & Rain', 'Wet/Dry')).toEqual({ weather: 'Nublado / Lluvia', track: 'Mojada / Seca' });
    expect(conditionsOf('', '')).toBeUndefined();
    expect(lapTime("1'20.654")).toBe('1:20.654');
    expect(lapTime('2:04’03.577')).toBe('2:04:03.577');
    expect(lapTime('1h05’17.129')).toBe('1:05:17.129');
    expect(lapTime('')).toBeUndefined();
    expect(gapText('19.602')).toBe('+19.602');
    expect(gapText('1 Lap')).toBe('+1 vuelta');
    expect(gapText('4Laps')).toBe('+4 vueltas');
    expect(formatSeconds(69.4947)).toBe('1:09.495');
    expect(formatSeconds(6210.5616)).toBe('1:43:30.562');
  });

  it('las recetas de Asia tienen lectura de resultados y de sesiones de fechas ya corridas', () => {
    for (const r of [supergt, superformula, supercars]) {
      expect(r.results).toBeTypeOf('function');
      expect(r.pastSessions).toBeTypeOf('function');
    }
    // Super Taikyu publica los resultados como PDF escaneados: solo reconstruye sesiones (los resultados, con IA).
    expect(supertaikyu.pastSessions).toBeTypeOf('function');
    expect(supertaikyu.results).toBeUndefined();
    expect(macau.results).toBeTypeOf('function');
  });
});

describe('SUPER GT: resultados por clase (supergt.net/en/result)', () => {
  const routes: Record<string, string> = { [supergtResultUrl(2026, 8, 'gt500')]: fixture('supergt-result-r8-gt500-3.html') };
  for (const cls of ['gt500', 'gt300']) {
    for (const n of [1, 2, 3]) routes[supergtResultUrl(2026, 8, cls, n)] = fixture(`supergt-result-r8-${cls}-${n}.html`);
  }
  const r8 = entry({ name: 'Round8 MOTEGI', round: 8 });

  it('menú de sesiones de la fecha con su número y día', () => {
    expect(supergtResultMenu(fixture('supergt-result-r8-gt500-3.html'), 8)).toEqual([
      { raceNum: 1, kind: 'practice', monthDay: '11-6', label: '11-6(Fri)Practice' },
      { raceNum: 2, kind: 'qualifying', monthDay: '11-8', label: '11-8(Sun)Qualifying' },
      { raceNum: 3, kind: 'race', monthDay: '11-8', label: '11-8(Sun)Race' },
    ]);
    // El menú de otra fecha no sirve.
    expect(supergtResultMenu(fixture('supergt-result-r8-gt500-3.html'), 3)).toEqual([]);
  });

  it('une GT500 y GT300 en cada sesión: práctica por tiempo, clasificación por clase, carrera por vueltas', async () => {
    const sessions = [
      session('p', 'Exclusive Practice', '2026-11-06T00:30:00Z'),
      session('q', 'Qualifying', '2026-11-08T00:45:00Z', 'clasificacion'),
      session('w', 'Warm Up', '2026-11-08T03:30:00Z', 'warmup'),
      session('r', 'Race', '2026-11-08T05:00:00Z', 'carrera'),
    ];
    const found = await supergtResults(r8, sessions, ctx(routes));
    expect(found!.sessions.map((s) => s.sessionId)).toEqual(['p', 'q', 'r']);
    const race = found!.sessions.find((s) => s.sessionId === 'r')!;
    expect(race.conditions).toEqual({ weather: 'Despejado', track: 'Seca' });
    expect(race.source?.url).toBe(supergtResultUrl(2026, 8, 'gt500', 3));
    expect(race.rows[0]).toEqual({
      pos: 1,
      number: '100',
      driver: 'Naoki Yamamoto / Tadasuke Makino',
      team: 'STANLEY TEAM KUNIMITSU',
      vehicle: 'STANLEY HRC PRELUDE-GT',
      laps: 53,
      class: 'GT500',
      classPos: 1,
      bestLap: '1:38.218',
    });
    expect(race.rows[1]).toMatchObject({ pos: 2, number: '17', gap: '+1.705', classPos: 2 });
    // GT300 detrás de los GT500 clasificados, con su puesto de clase.
    expect(race.rows[4]).toMatchObject({ pos: 5, number: '88', driver: 'Takashi Kogure / Daniil Kvyat', laps: 50, class: 'GT300', classPos: 1 });
    expect(race.rows.filter((r) => r.pos === null).map((r) => [r.number, r.class, r.status])).toEqual([
      ['39', 'GT500', 'DNS'],
      ['9', 'GT300', 'DNS'],
      ['4', 'GT300', 'DNS'],
    ]);
    const quali = found!.sessions.find((s) => s.sessionId === 'q')!;
    expect(quali.rows.map((r) => [r.pos, r.number, r.class, r.classPos, r.time])).toEqual([
      [1, '100', 'GT500', 1, '1:36.135'],
      [2, '36', 'GT500', 2, '1:36.413'],
      [3, '64', 'GT500', 3, '1:36.458'],
      [4, '17', 'GT500', 4, '1:36.481'],
      [5, '88', 'GT300', 1, '1:45.082'],
      [6, '11', 'GT300', 2, '1:45.149'],
      [7, '96', 'GT300', 3, '1:45.170'],
      [8, '61', 'GT300', 4, '1:45.204'],
    ]);
    const practice = found!.sessions.find((s) => s.sessionId === 'p')!;
    expect(practice.conditions).toEqual({ weather: 'Despejado', track: 'Mojada / Seca' });
    expect(practice.rows[0]).toMatchObject({ pos: 1, number: '64', laps: 26, time: '1:37.449', class: 'GT500' });
  });

  it('GT300 en dos grupos de clasificación: el grupo va en la clase', () => {
    const { rows } = supergtClassRows(fixture('supergt-result-r1-gt300-q1.html'), 'gt300', 'qualifying');
    expect(rows[0]).toMatchObject({ pos: 1, number: '777', class: 'GT300 (Grupo A)', classPos: 1, time: '1:25.431', laps: 4 });
    expect(rows[0]!.vehicle).toBe('Aston Martin Vantage GT3 EVO');
    expect(rows.find((r) => r.number === '60')).toMatchObject({ pos: 1, class: 'GT300 (Grupo B)', classPos: 1, time: '1:25.576' });
    expect(rows.at(-1)).toMatchObject({ pos: null, number: '20', status: 'DNS' });
  });

  it('fecha sin resultados publicados: null', async () => {
    expect(await supergtResults(entry({ round: 9 }), [session('r', 'Race')], ctx(routes))).toBeNull();
  });
});

describe('SUPER FORMULA: resultados en la página de la fecha', () => {
  const url = 'https://superformula.net/sf3/race/24415/';

  it('práctica, grupos de Q1, clasificación oficial y carrera', async () => {
    const sessions = [
      session('fp1', 'Free Practice 1'),
      session('q1a', 'Rd.1 Qualifying Q1 Group A'),
      session('q2', 'Rd.1 Qualifying Q2'),
      session('race', 'Rd.1 Race'),
      session('r2', 'Rd.2 Race'),
    ];
    const found = await superformulaResults(entry({ url }), sessions, ctx({ [url]: fixture('superformula-results-rd1-2.html') }));
    const by = new Map(found!.sessions.map((s) => [s.sessionId, s]));
    // La Rd.2 no está en el recorte: no se inventa.
    expect([...by.keys()]).toEqual(['fp1', 'q1a', 'q2', 'race']);
    expect(by.get('fp1')!.rows[1]).toEqual({
      pos: 2,
      number: '1',
      driver: 'Ayumu Iwasa',
      team: 'AUTOBACS MUGEN',
      vehicle: 'HONDA/M-TEC HR-417E',
      laps: 32,
      time: '1:30.500',
      gap: '+0.125',
    });
    const q1a = by.get('q1a')!;
    expect(q1a.rows).toHaveLength(12);
    expect(q1a.rows[0]).toMatchObject({ pos: 1, number: '1', time: '1:30.833' });
    expect(q1a.rows.at(-1)).toMatchObject({ pos: 12, number: '7', time: '1:40.995', gap: '+10.162' });
    expect(q1a.conditions).toEqual({ weather: 'Nublado / Lluvia', track: 'Seca / Mojada' });
    const q2 = by.get('q2')!;
    expect(q2.rows).toHaveLength(24);
    expect(q2.rows.slice(0, 2).map((r) => [r.pos, r.driver, r.time])).toEqual([
      [1, 'Ayumu Iwasa', '1:29.847'],
      [2, 'Kakunoshin Ohta', '1:29.946'],
    ]);
    expect(q2.rows.at(-1)).toMatchObject({ pos: null, number: '14', status: 'NC' });
    const race = by.get('race')!;
    expect(race.rows[0]).toMatchObject({ pos: 1, driver: 'Kakunoshin Ohta', laps: 23, time: '2:04:03.577', bestLap: '1:49.667' });
    expect(race.rows[1]).toMatchObject({ pos: 2, driver: 'Ayumu Iwasa', gap: '+0.669' });
    expect(race.rows.filter((r) => r.status === 'DNF').map((r) => r.number)).toEqual(['10', '19', '7', '4']);
    expect(race.conditions).toEqual({ weather: 'Lluvia', track: 'Mojada' });
  });

  it('clasificación en tres partes (Q1 por grupos, Q2 y Q3) con dos puntos de ancho completo en las condiciones', async () => {
    const u = 'https://superformula.net/sf3/race/24428/';
    const sessions = [session('a', 'Rd.8 Qualifying Q1 Group A'), session('q2', 'Rd.8 Qualifying Q2'), session('q3', 'Rd.8 Qualifying Q3')];
    const found = await superformulaResults(entry({ url: u }), sessions, ctx({ [u]: fixture('superformula-results-rd8.html') }));
    const by = new Map(found!.sessions.map((s) => [s.sessionId, s]));
    expect(by.get('a')!.rows[0]).toMatchObject({ pos: 1, number: '5', time: '1:05.625' });
    expect(by.get('q2')!.rows).toHaveLength(12);
    expect(by.get('q2')!.rows[0]).toMatchObject({ pos: 1, number: '6', time: '1:04.994' });
    expect(by.get('q3')!.rows).toHaveLength(24);
    expect(by.get('q3')!.rows[0]).toMatchObject({ pos: 1, number: '16', driver: 'Tomoki Nojiri', time: '1:04.864' });
    expect(by.get('q3')!.conditions).toEqual({ weather: 'Nublado', track: 'Seca' });
  });
});

describe('Supercars: resultados de Natsoft en la página de cada sesión', () => {
  const B = 'https://www.supercars.com';
  const schedule = fixture('supercars-schedule-2026-sandown.html');
  const routes = {
    [`${B}/events/2026-sandown/schedule`]: schedule,
    [`${B}/results/2026/2026-sandown/R7`]: fixture('supercars-result-2026-sandown-R7.html'),
    [`${B}/results/2026/2026-sandown/Q5`]: fixture('supercars-result-2026-sandown-Q5.html'),
  };

  it('"Top Ten Shootout" se nombra igual que "TTSO"', () => {
    expect(supercarsSessionName('Boost Mobile Top Ten Shootout (Race 33)')).toBe('Top 10 Shootout (Race 33)');
  });

  it('clasificación y carrera de Sandown: tiempos, diferencias, puntos y no clasificados', async () => {
    const sessions = supercarsSessions(schedule, 'Australia/Melbourne').map((s, i) => session(`s${i}`, s.name, s.startUtc));
    expect(sessions.map((s) => s.name)).toEqual([
      'Practice 1',
      'Practice 2',
      'Qualifying (Race 33)',
      'Top 10 Shootout (Race 33)',
      'Race 33',
      'Qualifying (Race 34)',
      'Top 10 Shootout (Race 34)',
      'Race 34',
    ]);
    const found = await supercarsResults(entry({ name: 'Sandown', tz: 'Australia/Melbourne', meta: { slug: '2026-sandown' } }), sessions, ctx(routes));
    // Solo las sesiones con página de resultados en el recorte.
    expect(found!.sessions.map((s) => s.sessionId)).toEqual(['s2', 's4']);
    const race = found!.sessions[1]!;
    expect(race.source?.url).toBe(`${B}/results/2026/2026-sandown/R7`);
    expect(race.rows[0]).toEqual({
      pos: 1,
      number: '17',
      driver: 'Brodie Kostecki',
      team: 'Shell V-Power Racing Team',
      vehicle: 'Ford Mustang GT',
      laps: 79,
      time: '1:43:30.562',
      bestLap: '1:09.495',
      points: 150,
    });
    expect(race.rows[1]).toMatchObject({ pos: 2, driver: 'Matthew Payne', gap: '+5.363', points: 138 });
    expect(race.rows.at(-2)).toMatchObject({ pos: 23, driver: 'Jackson Walls', gap: '+9 vueltas' });
    expect(race.rows.at(-1)).toMatchObject({ pos: null, status: 'NC', driver: 'Aaron Cameron', laps: 12 });
    const quali = found!.sessions[0]!;
    expect(quali.rows[0]).toMatchObject({ pos: 1, number: '19', driver: 'Matthew Payne', laps: 16, time: '1:08.408' });
    expect(quali.rows[1]).toMatchObject({ pos: 2, gap: '+0.128' });
  });

  it('una página de otra sesión no se toma como la pedida', () => {
    expect(supercarsResultRows(fixture('supercars-result-2026-sandown-R7.html'), 'Q5')).toBeNull();
  });
});

describe('Gran Premio de Macao: PDF de cronometraje', () => {
  it('lista de resultados por categoría y sesión (la clasificación combinada no es una sesión)', () => {
    const docs = macauResultDocs(JSON.parse(fixture('macau-result-list-2025.json')));
    expect(docs.filter((d) => d.category === 'FIA FR World Cup').map((d) => d.key)).toEqual(['fp1', 'fp2', 'q1', 'q2', 'qr', 'r1']);
    expect(docs.filter((d) => d.category === 'Guia Race TCR').map((d) => d.key)).toEqual(['fp1', 'fp2', 'q1', 'q2', 'r1', 'r2']);
    // "Warm Up" sin PDF no figura.
    expect(docs.filter((d) => d.category === 'Motorcycle Grand Prix').map((d) => d.key)).toEqual(['fp1', 'q1', 'r1']);
    expect(['Qualifying 2', 'Qualification Race', 'Main Race', 'Race 2', 'Free Practice'].map(macauSessionKey)).toEqual(['q2', 'qr', 'r1', 'r2', 'fp1']);
  });

  it('nombres "APELLIDO Nombre" o "Nombre APELLIDO"', () => {
    expect(macauDriverName('VANTHOOR Laurens')).toBe('Laurens Vanthoor');
    expect(macauDriverName('Nestor GIROLAMI')).toBe('Nestor Girolami');
    expect(macauDriverName('AL DHAHERI Rashid')).toBe('Rashid Al Dhaheri');
  });

  it('carrera: total del ganador, diferencias, no clasificados y clima del pie', () => {
    const { rows, conditions } = macauPdfRows(JSON.parse(fixture('macau-2025-tcr-race1-items.json')) as PdfItem[]);
    expect(conditions).toEqual({ airC: 25, humidity: 63, track: 'Seca' });
    expect(rows[0]).toEqual({
      pos: 1,
      number: '129',
      driver: 'Nestor Girolami',
      team: 'BRC HYUNDAI N SQUADRA CORSE',
      vehicle: 'Elantra N TCR',
      laps: 10,
      time: '25:21.264',
      bestLap: '2:30.853',
    });
    expect(rows[3]).toMatchObject({ pos: 4, number: '186', vehicle: 'Civic Type R FL5 TCR', gap: '+2.152' });
    expect(rows.at(-1)).toMatchObject({ pos: null, status: 'NC', number: '105', driver: 'Norbert Michelisz', laps: 2 });
  });

  it('práctica: mejor vuelta y diferencia al primero', () => {
    const { rows, conditions } = macauPdfRows(JSON.parse(fixture('macau-2025-fr-fp1-items.json')) as PdfItem[]);
    expect(conditions).toEqual({ airC: 20, humidity: 76, track: 'Mojada' });
    expect(rows.map((r) => [r.pos, r.number, r.driver, r.laps, r.time, r.gap])).toEqual([
      [1, '23', 'Taito Kato', 13, '2:16.412', undefined],
      [2, '11', 'Freddie Slater', 14, '2:16.456', '+0.044'],
      [3, '7', 'Mari Boya', 12, '2:16.583', '+0.171'],
    ]);
  });
});
