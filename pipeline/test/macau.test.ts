import { describe, expect, it } from 'vitest';
import { macau, macauProgrammeUrl, macauSessionName } from '../src/generic/macau.ts';
import type { RecipeContext } from '../src/generic/types.ts';
import { fakeHttp, fixture, genericSeries } from './fakes.ts';

const SCHEDULE = 'https://www.macau.grandprix.gov.mo/en/info/schedule';
const SETTING = 'https://www.macau.grandprix.gov.mo/api/setting?_locale=en';
const series = genericSeries('macau-gp', 'Gran Premio de Macao', [SCHEDULE]);

function ctx(season: number, routes: Record<string, string>): RecipeContext {
  return { season, series, http: fakeHttp(routes), now: new Date('2026-11-11T12:00:00Z') };
}

const doc = (season: number, raw: string) => ({ url: macauProgrammeUrl(season), kind: 'api' as const, raw, text: raw, title: '', hash: '' });

describe('Gran Premio de Macao (API del programa oficial)', () => {
  it('reconoce el sitio y pide el programa de la temporada', () => {
    expect(macau.match(SCHEDULE)).toBe(true);
    expect(macau.match('https://macau.grandprix.gov.mo/en/')).toBe(true);
    expect(macau.match('https://www.fiaformulae.com/')).toBe(false);
    expect(macau.calendarUrl!(SCHEDULE, 2026)).toBe('https://www.macau.grandprix.gov.mo/api/game/event_day?_locale=en&year=2026');
  });

  it('un solo evento de jueves a domingo, con las sesiones en pista de cada categoría', async () => {
    const c = ctx(2026, { [SETTING]: fixture('macau-setting.json') });
    const entries = await macau.calendar!(doc(2026, fixture('macau-event-day-2026.json')), c);
    expect(entries).toHaveLength(1);
    const e = entries[0]!;
    expect([e.name, e.circuit, e.country, e.tz, e.dateStart, e.dateEnd, e.url]).toEqual([
      '73rd Macau Grand Prix', 'Guia Circuit', 'Macau', 'Asia/Macau', '2026-11-19', '2026-11-22', SCHEDULE,
    ]);
    const sessions = e.sessions!;
    // Sin inspecciones, cierres/aperturas del circuito, "Special Event" ni la danza del león.
    expect(sessions).toHaveLength(35);
    expect(new Set(sessions.map((s) => s.name)).size).toBe(35);
    expect(sessions.some((s) => /circuit|inspection|special|lion/i.test(s.name))).toBe(false);
    expect(sessions[0]).toEqual({
      name: 'Motorcycle Grand Prix - Free Practice 1',
      startUtc: '2026-11-18T23:45:00Z',
      endUtc: '2026-11-19T00:15:00Z',
      localStartText: '07:45',
    });
    const pick = (name: string) => sessions.find((s) => s.name === name);
    expect(pick('FIA FR World Cup - Qualifying 1')).toMatchObject({ startUtc: '2026-11-19T08:00:00Z', localStartText: '16:00' });
    expect(pick('FIA FR World Cup - Qualifying Race')).toMatchObject({ startUtc: '2026-11-21T08:15:00Z', endUtc: '2026-11-21T09:20:00Z' });
    expect(pick('Guia Race TCR - Qualifying 2')).toMatchObject({ startUtc: '2026-11-20T05:05:00Z' });
    expect(pick('Motorcycle Grand Prix - Warm Up')).toMatchObject({ startUtc: '2026-11-20T23:10:00Z' });
    expect(pick('Greater Bay Area GT Cup - Race')).toMatchObject({ startUtc: '2026-11-22T00:00:00Z' });
    // Las carreras principales figuran solo con la cantidad de vueltas.
    expect(sessions.slice(-2).map((s) => [s.name, s.localStartText, s.startUtc])).toEqual([
      ['FIA GT World Cup - Race', '12:35', '2026-11-22T04:35:00Z'],
      ['FIA FR World Cup - Race', '15:30', '2026-11-22T07:30:00Z'],
    ]);
  });

  it('sessions(): relee el programa de la API; null si todavía no está publicado', async () => {
    const c = ctx(2026, { [macauProgrammeUrl(2026)]: fixture('macau-event-day-2026.json') });
    const entry = { name: 'Macau Grand Prix', circuit: 'Guia Circuit', country: 'Macau', tz: 'Asia/Macau', dateStart: '2026-11-19', dateEnd: '2026-11-22' };
    const found = await macau.sessions!(entry, c);
    expect(found!.sessions).toHaveLength(35);
    expect(found!.source).toMatchObject({ url: SCHEDULE, kind: 'api', method: 'directo', fetchedAt: '2026-11-11T12:00:00Z' });

    const empty = ctx(2027, { [macauProgrammeUrl(2027)]: fixture('macau-event-day-2027.json') });
    expect(await macau.sessions!({ ...entry, dateStart: '2027-11-18', dateEnd: '2027-11-21' }, empty)).toBeNull();
  });

  it('sin programa publicado usa las fechas anunciadas solo si son de la temporada pedida', async () => {
    const c2027 = ctx(2027, { [SETTING]: fixture('macau-setting.json') });
    expect(await macau.calendar!(doc(2027, fixture('macau-event-day-2027.json')), c2027)).toEqual([]);

    const c2026 = ctx(2026, { [SETTING]: fixture('macau-setting.json') });
    expect(await macau.calendar!(doc(2026, '{"code":0,"message":"success","data":[]}'), c2026)).toEqual([
      { name: '73rd Macau Grand Prix', circuit: 'Guia Circuit', country: 'Macau', tz: 'Asia/Macau', dateStart: '2026-11-19', dateEnd: '2026-11-22', url: SCHEDULE },
    ]);
  });

  it('nombres de sesión: variantes de guiones, vueltas y sesiones canceladas', () => {
    expect(macauSessionName('Macau Grand Prix - FIA FR World Cup -Qualifying 1')).toBe('FIA FR World Cup - Qualifying 1');
    expect(macauSessionName('Macau Formula 4 Race - FIA F4 World Cup- Qualification Race (8 laps)')).toBe('FIA F4 World Cup - Qualification Race');
    expect(macauSessionName('Greater Bay Area GT Cup (GT 4) - Race - (9 laps)')).toBe('Greater Bay Area GT Cup - Race');
    expect(macauSessionName('Macau Motorcycle Grand Prix - 57th Edition - Qualifying  (Cancelled)')).toBeNull();
    expect(macauSessionName('**\tCircuit Opened')).toBeNull();
    expect(macauSessionName('Special Event')).toBeNull();
  });
});
