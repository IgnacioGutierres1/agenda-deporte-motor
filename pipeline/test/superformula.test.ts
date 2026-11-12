import { describe, expect, it } from 'vitest';
import { superformula, superformulaSessionName } from '../src/generic/superformula.ts';
import type { RecipeContext } from '../src/generic/types.ts';
import { fakeHttp, fixture, genericSeries } from './fakes.ts';

const BASE = 'https://superformula.net/sf3';
const series = genericSeries('super-formula', 'SUPER FORMULA', [`${BASE}/race_taxonomy/2026`, `${BASE}/driver_taxonomy/2026?standings`], {
  rosterUrls: [`${BASE}/team_taxonomy/2026`],
});

function ctx(routes: Record<string, string>, season = 2026): RecipeContext {
  return { season, series, http: fakeHttp(routes), now: new Date('2026-11-11T12:00:00Z') };
}

const calendarDoc = () => ({
  url: `${BASE}/race_taxonomy/2026/`,
  kind: 'html' as const,
  raw: fixture('superformula-calendar-2026.html'),
  text: '',
  title: '',
  hash: '',
});

describe('SUPER FORMULA (superformula.net)', () => {
  it('reconoce el sitio y arma la URL del calendario de la temporada', () => {
    expect(superformula.match(`${BASE}/race_taxonomy/2026`)).toBe(true);
    expect(superformula.match('https://supergt.net/en/calendar')).toBe(false);
    expect(superformula.calendarUrl!(`${BASE}/race_taxonomy/2026`, 2027)).toBe(`${BASE}/race_taxonomy/2027/`);
  });

  it('calendario 2026: fechas de las tarjetas, sin ensayos, una entrada por fin de semana', async () => {
    const entries = await superformula.calendar!(calendarDoc(), ctx({}));
    expect(entries.map((e) => [e.round, e.name, e.dateStart, e.dateEnd, e.country, e.tz])).toEqual([
      [1, 'Rd.1-2 MOBILITY RESORT MOTEGI', '2026-04-03', '2026-04-05', 'Japan', 'Asia/Tokyo'],
      [3, 'Rd.3 AUTOPOLIS', '2026-04-25', '2026-04-26', 'Japan', 'Asia/Tokyo'],
      [4, 'Rd.4-5 SUZUKA CIRCUIT', '2026-05-22', '2026-05-24', 'Japan', 'Asia/Tokyo'],
      // La carrera de la Rd.3 se corrió en Fuji: el evento toma la primera ronda propia (6).
      [6, 'Rd.3-6-7 FUJI SPEEDWAY', '2026-07-17', '2026-07-19', 'Japan', 'Asia/Tokyo'],
      [8, 'Rd.8 Sportsland SUGO', '2026-08-08', '2026-08-09', 'Japan', 'Asia/Tokyo'],
      [9, 'Rd.9-10 FUJI SPEEDWAY', '2026-10-09', '2026-10-11', 'Japan', 'Asia/Tokyo'],
      [11, 'Rd.11-12 SUZUKA CIRCUIT', '2026-11-20', '2026-11-22', 'Japan', 'Asia/Tokyo'],
    ]);
    expect(entries.at(-1)).toMatchObject({ circuit: 'SUZUKA CIRCUIT', url: `${BASE}/race/24434/` });
  });

  it('calendario de otra temporada: no devuelve eventos', async () => {
    expect(await superformula.calendar!(calendarDoc(), ctx({}, 2027))).toEqual([]);
  });

  it('nombres de sesión en inglés y distintos para cada carrera del fin de semana', () => {
    expect(superformulaSessionName('FP1(フリー走行)')).toBe('Free Practice 1');
    expect(superformulaSessionName('フリー走行(FP2)')).toBe('Free Practice 2');
    expect(superformulaSessionName('FP2 A組(フリー走行)')).toBe('Free Practice 2 Group A');
    expect(superformulaSessionName('Rd.1 予選Q1 Gr.B')).toBe('Rd.1 Qualifying Q1 Group B');
    expect(superformulaSessionName('Rd.9 予選Q1 GrA<br />')).toBe('Rd.9 Qualifying Q1 Group A');
    expect(superformulaSessionName('Rd.1決勝レース')).toBe('Rd.1 Race');
    expect(superformulaSessionName('ピットウォーク')).toBeNull();
    expect(superformulaSessionName('JEGT AFTER RACE GRID PARTY')).toBeNull();
  });

  it('cronograma de Suzuka (Rd.11-12, 20 al 22 de noviembre): dos carreras con nombres distintos, en UTC', async () => {
    const entries = await superformula.calendar!(calendarDoc(), ctx({}));
    const suzuka = entries.find((e) => e.round === 11)!;
    const found = await superformula.sessions!(suzuka, ctx({ [`${BASE}/race/24434/`]: fixture('superformula-race-rd11-12.html') }));
    expect(found!.sessions).toEqual([
      { name: 'Free Practice 1', startUtc: '2026-11-20T01:40:00Z', endUtc: '2026-11-20T02:45:00Z', localStartText: '10:40' },
      { name: 'Free Practice 2', startUtc: '2026-11-20T05:15:00Z', endUtc: '2026-11-20T06:40:00Z', localStartText: '14:15' },
      { name: 'Rd.11 Qualifying Q1 Group A', startUtc: '2026-11-21T00:50:00Z', endUtc: '2026-11-21T01:00:00Z', localStartText: '09:50' },
      { name: 'Rd.11 Qualifying Q1 Group B', startUtc: '2026-11-21T01:05:00Z', endUtc: '2026-11-21T01:15:00Z', localStartText: '10:05' },
      { name: 'Rd.11 Qualifying Q2', startUtc: '2026-11-21T01:25:00Z', endUtc: '2026-11-21T01:35:00Z', localStartText: '10:25' },
      // La carrera solo publica la largada ("14:25-[31周/最大75分]").
      { name: 'Rd.11 Race', startUtc: '2026-11-21T05:25:00Z', localStartText: '14:25' },
      { name: 'Rd.12 Qualifying Q1 Group A', startUtc: '2026-11-22T00:15:00Z', endUtc: '2026-11-22T00:25:00Z', localStartText: '09:15' },
      { name: 'Rd.12 Qualifying Q1 Group B', startUtc: '2026-11-22T00:30:00Z', endUtc: '2026-11-22T00:40:00Z', localStartText: '09:30' },
      { name: 'Rd.12 Qualifying Q2', startUtc: '2026-11-22T00:50:00Z', endUtc: '2026-11-22T01:00:00Z', localStartText: '09:50' },
      { name: 'Rd.12 Race', startUtc: '2026-11-22T04:50:00Z', localStartText: '13:50' },
    ]);
    expect(found!.source).toMatchObject({ url: `${BASE}/race/24434/`, kind: 'html', method: 'directo' });
  });

  it('cronograma de Fuji con tres carreras (Rd.3 reprogramada, 6 y 7): ignora las tablas de eventos y resultados', async () => {
    const entries = await superformula.calendar!(calendarDoc(), ctx({}));
    const fuji = entries.find((e) => e.round === 6)!;
    const found = await superformula.sessions!(fuji, ctx({ [`${BASE}/race/24425/`]: fixture('superformula-race-rd3-6-7.html') }));
    const names = found!.sessions.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    expect(found!.sessions.filter((s) => s.name.endsWith('Race')).map((s) => [s.name, s.startUtc])).toEqual([
      ['Rd.6 Race', '2026-07-18T07:15:00Z'],
      ['Rd.3 Race', '2026-07-19T01:05:00Z'],
      ['Rd.7 Race', '2026-07-19T06:35:00Z'],
    ]);
    expect(names).toContain('Free Practice 2 Group B');
  });

  it('cronograma: sin página (404) devuelve null', async () => {
    const entries = await superformula.calendar!(calendarDoc(), ctx({}));
    expect(await superformula.sessions!(entries[0]!, ctx({}))).toBeNull();
  });

  it('posiciones: pilotos (con equipo por número de auto) y equipos', async () => {
    const c = ctx({
      [`${BASE}/driver_taxonomy/2026/?standings`]: fixture('superformula-driver-standings-2026.html'),
      [`${BASE}/team_taxonomy/2026/?standings`]: fixture('superformula-team-standings-2026.html'),
      [`${BASE}/team_taxonomy/2026/`]: fixture('superformula-teams-2026.html'),
    });
    const found = await superformula.standings!(`${BASE}/driver_taxonomy/2026?standings`, c);
    expect(found!.tables.map((t) => [t.title, t.rows.length])).toEqual([
      ['Pilotos', 27],
      ['Equipos', 16],
    ]);
    expect(found!.tables[0]!.rows.slice(0, 3)).toEqual([
      { pos: 1, name: 'Kakunoshin Ohta', team: 'DOCOMO TEAM DANDELION RACING', number: '6', points: 122 },
      { pos: 2, name: 'Ayumu Iwasa', team: 'TEAM MUGEN AUTOBACS', number: '1', points: 89.5 },
      { pos: 3, name: 'Igor Omura Fraga', team: 'PONOS NAKAJIMA RACING', number: '65', points: 77 },
    ]);
    expect(found!.tables[1]!.rows.slice(0, 2)).toEqual([
      { pos: 1, name: 'DOCOMO TEAM DANDELION RACING', points: 153 },
      { pos: 2, name: 'TEAM MUGEN AUTOBACS', points: 101 },
    ]);
    expect(found!.source).toMatchObject({ url: `${BASE}/driver_taxonomy/2026/?standings`, kind: 'html', method: 'directo' });
  });

  it('posiciones de una temporada que todavía no existe (404): null', async () => {
    expect(await superformula.standings!(`${BASE}/driver_taxonomy/2026?standings`, ctx({}, 2027))).toBeNull();
  });

  it('inscriptos: un piloto por auto con equipo y número', async () => {
    const found = await superformula.roster!(`${BASE}/team_taxonomy/2026`, ctx({ [`${BASE}/team_taxonomy/2026/`]: fixture('superformula-teams-2026.html') }));
    expect(found!.rows).toHaveLength(24);
    expect(found!.rows.slice(0, 3)).toEqual([
      { driver: 'Ayumu Iwasa', team: 'TEAM MUGEN AUTOBACS', number: '1' },
      { driver: 'Tomoki Nojiri', team: 'TEAM MUGEN AUTOBACS', number: '16' },
      { driver: 'Luke Browning', team: 'REALIZE KONDO RACING', number: '3' },
    ]);
    expect(found!.rows.find((r) => r.number === '97')).toEqual({ driver: 'Roman Staněk', team: 'ナビクル Buzz MK RACING', number: '97' });
    expect(found!.source).toMatchObject({ url: `${BASE}/team_taxonomy/2026/`, kind: 'html', method: 'directo' });
    expect(await superformula.roster!(`${BASE}/team_taxonomy/2026`, ctx({}, 2027))).toBeNull();
  });
});
