import { describe, expect, it } from 'vitest';
import { supercars, supercarsSessionName, supercarsTeamStandings, supercarsTimeZone } from '../src/generic/supercars.ts';
import type { RecipeContext } from '../src/generic/types.ts';
import { fakeHttp, fixture, genericSeries } from './fakes.ts';

const BASE = 'https://www.supercars.com';
const series = genericSeries('supercars', 'Supercars', [`${BASE}/calendar`, `${BASE}/standings`]);

function ctx(season = 2026): RecipeContext {
  const http = fakeHttp({
    [`${BASE}/events/2026-adelaide/schedule`]: fixture('supercars-schedule-2026-adelaide.html'),
    [`${BASE}/standings/2026/supercars`]: fixture('supercars-standings-2026.html'),
    [`${BASE}/standings/2026/supercars/teams`]: fixture('supercars-standings-teams-2026.html'),
    [`${BASE}/standings/2027/supercars`]: fixture('supercars-standings-2027.html'),
    [`${BASE}/drivers`]: fixture('supercars-drivers-2026.html'),
  });
  return { season, series, http, now: new Date('2026-11-11T12:00:00Z') };
}

const calendarDoc = () => ({ url: `${BASE}/calendar`, kind: 'html' as const, raw: fixture('supercars-calendar.html'), text: '', title: '', hash: '' });

describe('Supercars (payload RSC de supercars.com)', () => {
  it('reconoce el sitio y la zona de cada estado', () => {
    expect(supercars.match(`${BASE}/standings`)).toBe(true);
    expect(supercars.match('https://supercars.com/calendar')).toBe(true);
    expect(supercars.calendarUrl!(`${BASE}/`, 2026)).toBe(`${BASE}/calendar`);
    expect(supercarsTimeZone('Tailem Bend, SA')).toBe('Australia/Adelaide');
    expect(supercarsTimeZone('Mallala, South Australia')).toBe('Australia/Adelaide');
    expect(supercarsTimeZone('Darwin, NT')).toBe('Australia/Darwin');
    expect(supercarsTimeZone('Christchurch, NZ')).toBe('Pacific/Auckland');
  });

  it('calendario 2026: 14 fechas en orden, con circuito, zona y país', async () => {
    const cal = await supercars.calendar!(calendarDoc(), ctx());
    expect(cal.map((e) => [e.round, e.name, e.circuit, e.tz, e.dateStart, e.dateEnd])).toEqual([
      [1, 'DUNLOP Sydney 500', 'Sydney Motorsport Park', 'Australia/Sydney', '2026-02-20', '2026-02-22'],
      [2, 'Melbourne SuperSprint', 'Albert Park Circuit', 'Australia/Melbourne', '2026-03-05', '2026-03-08'],
      [3, 'ITM Taupō Super 440', 'Taupo International Motorsport Park', 'Pacific/Auckland', '2026-04-10', '2026-04-12'],
      [4, 'ITM Christchurch Super 440', 'Ruapuna Park', 'Pacific/Auckland', '2026-04-17', '2026-04-19'],
      [5, 'Tyrepower Tasmania Super 440', 'Symmons Plains Raceway', 'Australia/Hobart', '2026-05-22', '2026-05-24'],
      [6, 'betr Darwin Triple Crown', 'Hidden Valley Raceway', 'Australia/Darwin', '2026-06-19', '2026-06-21'],
      [7, 'NTI Townsville 500', 'Reid Park Street Circuit', 'Australia/Brisbane', '2026-07-10', '2026-07-12'],
      [8, 'Bosch Power Tools Perth Super 440', 'Wanneroo Raceway', 'Australia/Perth', '2026-07-31', '2026-08-02'],
      [9, 'Century Batteries Ipswich Super 440', 'Queensland Raceway', 'Australia/Brisbane', '2026-08-21', '2026-08-25'],
      [10, 'AirTouch 500 at The Bend', 'The Bend Motorsport Park', 'Australia/Adelaide', '2026-09-11', '2026-09-13'],
      [11, 'Repco Bathurst 1000', 'Mount Panorama Circuit', 'Australia/Sydney', '2026-10-08', '2026-10-11'],
      [12, 'Boost Mobile Gold Coast 500', 'Surfers Paradise Street Circuit', 'Australia/Brisbane', '2026-10-23', '2026-10-25'],
      [13, 'Penrite Oil Sandown 500', 'Sandown Raceway', 'Australia/Melbourne', '2026-11-06', '2026-11-08'],
      [14, 'bp Adelaide Grand Final', 'Adelaide Parklands Circuit', 'Australia/Adelaide', '2026-11-26', '2026-11-29'],
    ]);
    expect(cal[2]!.country).toBe('New Zealand');
    expect(cal[13]).toMatchObject({ country: 'Australia', url: `${BASE}/events/2026-adelaide`, meta: { slug: '2026-adelaide' } });
    // 2027: la fecha exclusiva de Super2 (Mallala) no es del campeonato.
    const next = await supercars.calendar!(calendarDoc(), ctx(2027));
    expect(next).toHaveLength(14);
    expect(next.some((e) => /mallala/i.test(e.name))).toBe(false);
    // Christchurch 2027 figura con offset +10:00 en el sitio, pero la zona sale del lugar.
    expect(next.find((e) => /christchurch/i.test(e.name))!.tz).toBe('Pacific/Auckland');
  });

  it('cronograma de Adelaide: solo las sesiones del campeonato, sin patrocinadores en el nombre', async () => {
    const cal = await supercars.calendar!(calendarDoc(), ctx());
    const found = await supercars.sessions!(cal[13]!, ctx());
    expect(found!.sessions.map((s) => [s.name, s.localStartText, s.startUtc, s.endUtc])).toEqual([
      ['Practice 1', '15:15', '2026-11-26T04:45:00Z', '2026-11-26T05:15:00Z'],
      ['Practice 2', '10:00', '2026-11-26T23:30:00Z', '2026-11-27T00:00:00Z'],
      ['Qualifying (Race 35)', '13:10', '2026-11-27T02:40:00Z', '2026-11-27T03:15:00Z'],
      ['Race 35', '16:20', '2026-11-27T05:50:00Z', '2026-11-27T06:55:00Z'],
      ['Qualifying (Race 36)', '11:45', '2026-11-28T01:15:00Z', '2026-11-28T01:55:00Z'],
      ['Top 10 Shootout (Race 36)', '12:35', '2026-11-28T02:05:00Z', '2026-11-28T02:45:00Z'],
      ['Race 36', '15:20', '2026-11-28T04:50:00Z', '2026-11-28T07:00:00Z'],
      ['Qualifying (Race 37)', '11:45', '2026-11-29T01:15:00Z', '2026-11-29T01:55:00Z'],
      ['Top 10 Shootout (Race 37)', '12:35', '2026-11-29T02:05:00Z', '2026-11-29T02:40:00Z'],
      ['Race 37', '15:15', '2026-11-29T04:45:00Z', '2026-11-29T07:00:00Z'],
    ]);
    expect(found!.source).toMatchObject({ url: `${BASE}/events/2026-adelaide/schedule`, kind: 'html', method: 'directo' });
    // Cronograma todavía no publicado (404 en el fake).
    expect(await supercars.sessions!({ ...cal[0]!, meta: { slug: '2027-sydney' } }, ctx())).toBeNull();
  });

  it('nombres de sesión', () => {
    expect(supercarsSessionName('Boost Mobile Qualifying (Race 35)')).toBe('Qualifying (Race 35)');
    expect(supercarsSessionName('Boost Mobile TTSO (Race 30)')).toBe('Top 10 Shootout (Race 30)');
    expect(supercarsSessionName('Practice 2 (Additional Drivers)')).toBe('Practice 2 (Additional Drivers)');
    expect(supercarsSessionName('Warm Up')).toBe('Warm Up');
  });

  it('campeonato: pilotos y equipos de la temporada; null antes de la primera carrera', async () => {
    const found = await supercars.standings!(`${BASE}/standings`, ctx());
    // La tabla oficial de equipos 2026 saltea la posición 14: no pasa el control y queda solo la de pilotos.
    expect(found!.tables.map((t) => t.title)).toEqual(['Pilotos']);
    const [drivers] = found!.tables;
    expect(drivers!.title).toBe('Pilotos');
    expect(drivers!.rows).toHaveLength(33);
    expect(drivers!.rows.slice(0, 2)).toEqual([
      { pos: 1, name: 'Broc Feeney', team: 'Red Bull Ampol Racing', number: '88', points: 2107, wins: 6 },
      { pos: 2, name: 'Matthew Payne', team: 'Penrite Racing', number: '19', points: 2077, wins: 5 },
    ]);
    // Equipos tal como los publica el sitio: el wildcard de Supercheap (posición 0, sin carreras) no entra.
    const teams = supercarsTeamStandings(fixture('supercars-standings-teams-2026.html'));
    expect(teams).toHaveLength(16);
    expect(teams[0]).toEqual({ pos: 1, name: 'Penrite Racing', points: 5214 });
    expect(teams.map((t) => t.pos).slice(11, 14)).toEqual([12, 13, 15]);
    expect(found!.source).toMatchObject({ url: `${BASE}/standings/2026/supercars`, method: 'directo' });
    expect(await supercars.standings!(`${BASE}/standings`, ctx(2027))).toBeNull();
  });

  it('inscriptos: titulares, co-pilotos de los enduros y wildcards, sin repetir', async () => {
    const found = await supercars.roster!(`${BASE}/drivers`, ctx());
    expect(found!.rows.slice(0, 2)).toEqual([
      { driver: 'Matthew Payne', team: 'Penrite Racing', number: '19', vehicle: 'Ford Mustang GT' },
      { driver: 'Will Davison', team: 'Penrite Racing', number: '19', vehicle: 'Ford Mustang GT' },
    ]);
    expect(found!.rows.filter((r) => r.driver === 'Todd Hazelwood')).toHaveLength(1);
    expect(found!.rows.find((r) => r.driver === 'Craig Lowndes')).toMatchObject({ number: '15', team: 'Supercheap Auto Racing' });
    // "$undefined" (undefined serializado por Next.js) nunca queda como número.
    expect(found!.rows.some((r) => r.number?.startsWith('$'))).toBe(false);
    expect(found!.rows.length).toBeGreaterThan(40);
    expect(found!.source).toMatchObject({ url: `${BASE}/drivers`, kind: 'html', method: 'directo' });
    expect(await supercars.roster!(`${BASE}/drivers`, ctx(2027))).toBeNull();
  });
});
