import { describe, expect, it } from 'vitest';
import { isDriverTable } from '@dm/shared';
import { supertaikyu, supertaikyuSessionName } from '../src/generic/supertaikyu.ts';
import type { RecipeContext } from '../src/generic/types.ts';
import { fakeHttp, fixture, genericSeries } from './fakes.ts';

const RACES = 'https://supertaikyu.com/race/index.html';
const R = (n: string) => `https://supertaikyu.com/race/round_${n}.html`;
const STANDING = 'https://supertaikyu.com/race/standing.html';
const series = genericSeries('super-taikyu', 'Super Taikyu', [RACES, STANDING]);

function ctx(season = 2026): RecipeContext {
  const http = fakeHttp({
    [RACES]: fixture('supertaikyu-race-index-2026.html'),
    [R('07')]: fixture('supertaikyu-round-07-2026.html'),
    [R('03')]: fixture('supertaikyu-round-03-2026.html'),
    [R('04')]: fixture('supertaikyu-round-04-2026.html'),
    [STANDING]: fixture('supertaikyu-standing-2026.html'),
  });
  return { season, series, http, now: new Date('2026-11-11T12:00:00Z') };
}

const racesDoc = () => ({ url: RACES, kind: 'html' as const, raw: fixture('supertaikyu-race-index-2026.html'), text: '', title: '', hash: '' });

describe('Super Taikyu (supertaikyu.com)', () => {
  it('calendario: siete fechas (sin los ensayos oficiales), con circuito y duración en inglés', async () => {
    expect(supertaikyu.match('https://supertaikyu.com/race/standing.html')).toBe(true);
    expect(supertaikyu.match('https://www.supergt.net/')).toBe(false);
    const cal = await supertaikyu.calendar!(racesDoc(), ctx());
    expect(cal.map((e) => [e.round, e.name, e.circuit, e.dateStart, e.dateEnd])).toEqual([
      [1, 'Super Taikyu Motegi', 'Mobility Resort Motegi', '2026-03-21', '2026-03-22'],
      [2, 'Suzuka 5 Hours', 'Suzuka Circuit', '2026-04-18', '2026-04-19'],
      [3, 'Fuji 24 Hours', 'Fuji Speedway', '2026-06-05', '2026-06-07'],
      [4, 'SUGO 4 Hours', 'Sportsland SUGO', '2026-07-04', '2026-07-05'],
      [5, 'Super Taikyu Autopolis', 'Autopolis', '2026-07-25', '2026-07-26'],
      [6, 'Super Taikyu Okayama', 'Okayama International Circuit', '2026-10-24', '2026-10-25'],
      [7, 'Super Taikyu Fuji', 'Fuji Speedway', '2026-11-14', '2026-11-15'],
    ]);
    expect(cal.every((e) => e.tz === 'Asia/Tokyo' && e.country === 'Japan')).toBe(true);
    expect(cal[6]!.url).toBe(R('07'));
    // Otra temporada: la página solo tiene la vigente.
    expect(await supertaikyu.calendar!(racesDoc(), ctx(2027))).toEqual([]);
  });

  it('cronograma de la fecha 7 (Fuji, 14-15/11): sin pit walk, largada ni la S耐チャレンジ', async () => {
    const entry = { name: 'Super Taikyu Fuji', circuit: 'Fuji Speedway', country: 'Japan', tz: 'Asia/Tokyo', dateStart: '2026-11-14', dateEnd: '2026-11-15', round: 7, url: R('07') };
    const found = await supertaikyu.sessions!(entry, ctx());
    expect(found!.sessions).toEqual([
      { name: 'Free Practice', startUtc: '2026-11-14T00:05:00Z', endUtc: '2026-11-14T00:45:00Z', localStartText: '09:05' },
      { name: 'Qualifying - A Driver', startUtc: '2026-11-14T05:15:00Z', endUtc: '2026-11-14T06:05:00Z', localStartText: '14:15' },
      { name: 'Qualifying - B Driver', startUtc: '2026-11-14T06:15:00Z', endUtc: '2026-11-14T07:00:00Z', localStartText: '15:15' },
      { name: 'Race', startUtc: '2026-11-15T03:30:00Z', endUtc: '2026-11-15T07:30:00Z', localStartText: '12:30' },
    ]);
    expect(found!.source).toMatchObject({ url: R('07'), kind: 'html', method: 'directo' });
    // La misma página leída para otra temporada (las páginas se reciclan cada año) no da sesiones.
    expect(await supertaikyu.sessions!(entry, ctx(2027))).toBeNull();
  });

  it('24 horas (termina al día siguiente) y fechas con dos grupos', async () => {
    const base = { circuit: '', country: 'Japan', tz: 'Asia/Tokyo' };
    const fuji = await supertaikyu.sessions!({ ...base, name: 'Fuji 24 Hours', dateStart: '2026-06-05', dateEnd: '2026-06-07', url: R('03') }, ctx());
    expect(fuji!.sessions.map((s) => s.name)).toEqual([
      'Qualifying - A Driver', 'Qualifying - B Driver', 'Qualifying - C Driver', 'Qualifying - D Driver', 'Free Practice', 'Warm Up', 'Race',
    ]);
    expect(fuji!.sessions.at(-1)).toEqual({ name: 'Race', startUtc: '2026-06-06T06:00:00Z', endUtc: '2026-06-07T06:00:00Z', localStartText: '15:00' });

    const sugo = await supertaikyu.sessions!({ ...base, name: 'SUGO 4 Hours', dateStart: '2026-07-04', dateEnd: '2026-07-05', url: R('04') }, ctx());
    expect(sugo!.sessions.map((s) => [s.name, s.startUtc])).toEqual([
      ['Qualifying Gr.2 - B Driver', '2026-07-03T23:00:00Z'],
      ['Qualifying Gr.2 - A Driver', '2026-07-03T23:25:00Z'],
      ['Qualifying Gr.2 - C/D Driver', '2026-07-04T00:05:00Z'],
      ['Race Gr.2', '2026-07-04T03:40:00Z'],
      ['Qualifying Gr.1 - B Driver', '2026-07-04T23:00:00Z'],
      ['Qualifying Gr.1 - A Driver', '2026-07-04T23:30:00Z'],
      ['Qualifying Gr.1 - C/D Driver', '2026-07-05T00:30:00Z'],
      ['Race Gr.1', '2026-07-05T04:00:00Z'],
    ]);
  });

  it('nombres de sesión de otras fechas', () => {
    expect(supertaikyuSessionName('スーパー耐久 4時間耐久レースRace1 決勝 （ST-X / ST-Q（#104） / ST-1）')).toBe('Race 1');
    expect(supertaikyuSessionName('S耐Gr-2 フリー走行 ST-USA・ST-3・ST-5F')).toBe('Free Practice Gr.2');
    expect(supertaikyuSessionName('スーパー耐久レース［3h］Gr.1決勝レース （ST-X / Z / TCR / USA ）')).toBe('Race Gr.1');
    expect(supertaikyuSessionName('公式予選（C・Dドライバー）')).toBe('Qualifying - C/D Driver');
    expect(supertaikyuSessionName('スーパー耐久レース in オートポリス ５時間耐久レース')).toBe('Race');
    expect(supertaikyuSessionName('S耐チャレンジ 決勝')).toBeNull();
    expect(supertaikyuSessionName('Kids PIT WALK・パレード走行')).toBeNull();
    expect(supertaikyuSessionName('S耐スタート進行 ・カウントダウンセレモニー ・グリッドウォーク')).toBeNull();
  });

  it('campeonato: una tabla de equipos por clase, sin los autos que todavía no sumaron', async () => {
    const found = await supertaikyu.standings!(STANDING, ctx());
    expect(found!.tables.map((t) => [t.title, t.rows.length])).toEqual([
      ['Equipos Clase ST-X', 6], ['Equipos Clase ST-Z', 12], ['Equipos Clase ST-TCR', 4], ['Equipos Clase ST-1', 2],
      ['Equipos Clase ST-2', 9], ['Equipos Clase ST-3', 2], ['Equipos Clase ST-4', 10], ['Equipos Clase ST-5F', 7],
      ['Equipos Clase ST-5R', 8],
    ]);
    // Son equipos (la tabla no trae pilotos): no entran al índice de pilotos.
    expect(found!.tables.every((t) => !isDriverTable(t.title))).toBe(true);
    expect(found!.tables[0]!.rows.slice(0, 2)).toEqual([
      { pos: 1, name: 'TKRI', number: '23', points: 144.5 },
      { pos: 2, name: 'Craft-Bamboo Racing', number: '33', points: 113 },
    ]);
    expect(found!.source).toMatchObject({ url: STANDING, kind: 'html', method: 'directo' });
    expect(await supertaikyu.standings!(STANDING, ctx(2027))).toBeNull();
  });

  it('inscriptos: la fecha más reciente con lista publicada, una fila por piloto', async () => {
    const found = await supertaikyu.roster!(RACES, ctx());
    expect(found!.source.url).toBe(R('07'));
    expect(found!.rows).toHaveLength(253);
    expect(found!.rows.slice(0, 2)).toEqual([
      { driver: 'DAISUKE', team: 'TKRI', number: '23', vehicle: 'TKRI松永建設AMG GT3', class: 'ST-X' },
      { driver: '片岡 龍也', team: 'TKRI', number: '23', vehicle: 'TKRI松永建設AMG GT3', class: 'ST-X' },
    ]);
    // El #777 tiene solo tres pilotos (la columna D vacía no suma una fila).
    expect(found!.rows.filter((r) => r.number === '777')).toHaveLength(3);
    expect(await supertaikyu.roster!(R('07'), ctx(2027))).toBeNull();
  });
});
