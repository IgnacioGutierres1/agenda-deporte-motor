import { describe, expect, it } from 'vitest';
import { buildDrivers } from '../src/core/drivers.ts';
import { acoStandingsTables, acoTableTitle } from '../src/generic/aco-standings.ts';
import { createGenericAdapter } from '../src/generic/index.ts';
import { imsaCalendar, imsaDateRange, imsaSessions, imsaStandingsApi, imsaStandingsSeason, imsaStandingsTables } from '../src/generic/imsa.ts';
import { dtmDriverName, dtmStandingsTables, findRecipe } from '../src/generic/recipes.ts';
import { standingsFileSchema, type StandingsFile } from '@dm/shared';
import { fakeGemini, fakeHttp, fixture, genericSeries, testContext } from './fakes.ts';

const NOW = '2026-11-12T12:00:00Z';
const WEC_STANDINGS = 'https://www.fiawec.com/en/page/manufacturers-classification';
const ELMS_STANDINGS = 'https://www.europeanlemansseries.com/en/page/classification-2';
const ALMS_STANDINGS = 'https://www.asianlemansseries.com/en/page/classification';

const wec = genericSeries('wec', 'FIA World Endurance Championship', ['https://www.fiawec.com/en/season/2026', `${WEC_STANDINGS}?standings`], { shortName: 'WEC' });
const elms = genericSeries('elms', 'European Le Mans Series', ['https://www.europeanlemansseries.com/en/season/2026', `${ELMS_STANDINGS}?standings`], { shortName: 'ELMS' });
const dtm = genericSeries('dtm', 'DTM', ['https://www.dtm.com/en/calendar', 'https://www.dtm.com/en/standings'], { shortName: 'DTM' });

const onlyStandings = { events: [], pendingSessions: [], sessions: [], standingsStale: true };

async function readStandings(series: typeof wec, routes: Record<string, string>, now = NOW) {
  const gemini = fakeGemini({}, { available: false });
  const http = fakeHttp(routes);
  const out = await createGenericAdapter({ gemini: () => gemini }).results!(series, testContext(http, now), onlyStandings);
  return { out, http, gemini };
}

describe('ACO (WEC / ELMS / Asian LMS): campeonato por lectura directa', () => {
  it('títulos en castellano a partir del botón de cada tabla', () => {
    expect(acoTableTitle('FIA Hypercar World Endurance Manufacturers’ Championship')).toBe('Marcas Hypercar');
    expect(acoTableTitle('FIA Hypercar World Endurance Drivers Championship')).toBe('Pilotos Hypercar');
    expect(acoTableTitle('FIA Endurance Trophy for LMGT3 Teams')).toBe('Equipos LMGT3');
    expect(acoTableTitle('LMP2 Pro/Am Drivers Classification')).toBe('Pilotos LMP2 Pro/Am');
    expect(acoTableTitle('GT Teams Classification')).toBe('Equipos GT');
  });

  it('WEC 2026: cuatro tablas sin IA, con la tripulación de cada auto y el campeón de Hypercar', async () => {
    const { out, gemini } = await readStandings(wec, { [WEC_STANDINGS]: fixture('aco-wec-standings-2026.html') });
    const file = standingsFileSchema.parse(out.standings);
    expect(file.season).toBe(2026);
    expect(file.source).toMatchObject({ url: WEC_STANDINGS, method: 'directo' });
    expect(file.tables.map((t) => [t.title, t.rows.length])).toEqual([
      ['Pilotos Hypercar', 3],
      ['Pilotos LMGT3', 3],
      ['Marcas Hypercar', 3],
      ['Equipos LMGT3', 3],
    ]);
    expect(file.tables[0]!.rows[0]).toEqual({ pos: 1, name: 'BRENDON HARTLEY / RYŌ HIRAKAWA / SÉBASTIEN BUEMI', number: '8', points: 115 });
    // Los pilotos de LMGT3 llevan el equipo de la tabla de equipos de su clase (mismo número de auto).
    expect(file.tables[1]!.rows[0]).toMatchObject({ pos: 1, name: 'JONNY EDGAR', number: '33', team: 'TF SPORT', points: 107 });
    expect(file.tables[2]!.rows[0]).toEqual({ pos: 1, name: 'TOYOTA', points: 215 });
    expect(gemini.requests).toHaveLength(0);
  });

  it('WEC: una temporada que todavía no está en el selector no está publicada', async () => {
    const { out } = await readStandings(wec, { [WEC_STANDINGS]: fixture('aco-wec-standings-2026.html') }, '2027-03-01T12:00:00Z');
    expect(out.standings).toBeUndefined();
  });

  it('ELMS 2026: pilotos y equipos de cada clase; el índice de pilotos separa las tripulaciones', async () => {
    const { out } = await readStandings(elms, { [ELMS_STANDINGS]: fixture('aco-elms-standings-2026.html') });
    const file = standingsFileSchema.parse(out.standings) as StandingsFile;
    expect(file.tables.map((t) => t.title)).toEqual([
      'Pilotos LMP2',
      'Pilotos LMP3',
      'Pilotos LMP2 Pro/Am',
      'Pilotos LMGT3',
      'Equipos LMP2',
      'Equipos LMP3',
      'Equipos LMP2 Pro/Am',
      'Equipos LMGT3',
    ]);
    expect(file.tables[0]!.rows[0]).toMatchObject({ name: 'BENJAMIN HANLEY / GRÉGOIRE SAUCY / GRIFFIN PEEBLES', team: 'UNITED AUTOSPORTS', points: 111 });
    const index = buildDrivers({ series: [elms], standings: [file], results: [], sessions: [], generatedAt: NOW });
    expect(index.drivers.find((d) => d.name === 'Grégoire Saucy')?.entries[0]).toMatchObject({ seriesId: 'elms', table: 'Pilotos LMP2', pos: 1, number: '22' });
  });

  it('Asian LMS: la página todavía muestra la 2025-26 (y filas sin nombre); para la 2026-27 no hay tabla', async () => {
    const alms = genericSeries('alms', 'Asian Le Mans Series', ['https://www.asianlemansseries.com/en/season/2026', `${ALMS_STANDINGS}?standings`]);
    const recipe = findRecipe(`${ALMS_STANDINGS}?standings`)!;
    const http = fakeHttp({ [ALMS_STANDINGS]: fixture('aco-alms-standings-2025.html') });
    const ctx = { season: 2026, series: alms, http, now: new Date(NOW) };
    expect(await recipe.standings!(`${ALMS_STANDINGS}?standings`, ctx)).toBeNull();
    // La misma página leída como 2025: las filas sin pilotos cargados se omiten sin romper la tabla.
    const found = await recipe.standings!(`${ALMS_STANDINGS}?standings`, { ...ctx, season: 2025 });
    expect(found!.tables.find((t) => t.title === 'Pilotos LMP2')!.rows[0]).toMatchObject({ pos: 1, name: 'GEORGE KURTZ / LOUIS DELÉTRAZ / MALTHE JAKOBSEN', points: 109 });
    const lmp3 = acoStandingsTables(fixture('aco-alms-standings-2025.html')).find((t) => t.title === 'Pilotos LMP3')!;
    expect(lmp3.rows.map((r) => [r.pos, r.points])).toEqual([[1, 96], [2, 86]]);
    expect(lmp3.rows.every((r) => r.name)).toBe(true);
  });
});

describe('DTM: campeonato desde la API de dtm.com', () => {
  it('nombres "APELLIDO Nombre" en el orden habitual', () => {
    expect(dtmDriverName('PREINING Thomas')).toBe('Thomas PREINING');
    expect(dtmDriverName('VAN DER LINDE Kelvin')).toBe('Kelvin VAN DER LINDE');
    expect(dtmDriverName('Lucas Auer')).toBe('Lucas Auer');
  });

  it('pilotos, equipos y marcas de 2026; null para una temporada sin tabla', async () => {
    const api = (y: number) => `https://api.dtm.com/data?query=wigeStandings&raceSeries=DTM&startDate=${y}-01-01&endDate=${y}-12-31`;
    const { out } = await readStandings(dtm, { [api(2026)]: fixture('dtm-standings-2026.json') });
    const file = standingsFileSchema.parse(out.standings);
    expect(file.tables.map((t) => [t.title, t.rows.length])).toEqual([
      ['Pilotos', 4],
      ['Equipos', 4],
      ['Marcas', 4],
    ]);
    expect(file.tables[0]!.rows[0]).toEqual({ pos: 1, name: 'Thomas PREINING', points: 225, country: 'Austria' });
    expect(file.tables[2]!.rows[0]).toEqual({ pos: 1, name: 'Mercedes-AMG', points: 440 });
    expect(file.source).toMatchObject({ url: 'https://www.dtm.com/en/standings', kind: 'api', method: 'directo' });
    expect(dtmStandingsTables({ wigeStandingses: [] }, 2027)).toBeNull();
  });
});

describe('IMSA: sitio nuevo (imsa.com/{año}/schedule)', () => {
  it('fechas del aria-label de cada tarjeta', () => {
    expect(imsaDateRange('April 30, 2027 through May 2, 2027')).toEqual({ start: '2027-04-30', end: '2027-05-02' });
    expect(imsaDateRange('January 23, 2027')).toEqual({ start: '2027-01-23', end: '2027-01-23' });
  });

  it('calendario del WeatherTech (sin las tarjetas de otros campeonatos), con zona horaria y rondas sin el Roar', () => {
    const url = 'https://www.imsa.com/2027/schedule?series=weathertech';
    const entries = imsaCalendar(fixture('imsa-schedule-2027.html'), url, 'weathertech', 2027);
    expect(entries.map((e) => [e.name, e.round, e.circuit, e.country, e.tz, e.dateStart, e.dateEnd])).toEqual([
      ['Roar Before The Rolex 24', undefined, 'Daytona International Speedway', 'United States', 'America/New_York', '2027-01-22', '2027-01-24'],
      ['Rolex 24 At Daytona', 1, 'Daytona International Speedway', 'United States', 'America/New_York', '2027-01-28', '2027-01-31'],
      ['Chevrolet Detroit Sports Car Classic', 2, 'Detroit Street Circuit', 'United States', 'America/Detroit', '2027-06-04', '2027-06-05'],
      ['Chevrolet Grand Prix', 3, 'Canadian Tire Motorsport Park', 'Canada', 'America/Toronto', '2027-07-09', '2027-07-11'],
    ]);
    expect(entries[1]!.url).toBe('https://www.imsa.com/events/2027-rolex-24-at-daytona?tab=schedule&series=weathertech');
    // Otro campeonato de la misma página.
    expect(imsaCalendar(fixture('imsa-schedule-2027.html'), url, 'imsa-michelin-pilot-challenge', 2027).map((e) => e.name)).toEqual(['Rolex 24 At Daytona']);
  });

  it('cronograma del panel del campeonato, con horas en UTC', () => {
    const html = fixture('imsa-event-road-atlanta-2026.html');
    expect(imsaSessions(html, 'weathertech')).toEqual([
      { name: 'Practice 1', startUtc: '2026-10-01T14:40:00Z' },
      { name: 'Practice 2', startUtc: '2026-10-01T19:20:00Z' },
      { name: 'Practice 3', startUtc: '2026-10-01T23:30:00Z' },
      { name: 'Qualifying', startUtc: '2026-10-02T18:15:00Z' },
      { name: 'Motul Petit Le Mans', startUtc: '2026-10-03T16:10:00Z' },
    ]);
    expect(imsaSessions(html, 'imsa-michelin-pilot-challenge')[0]).toEqual({ name: 'Practice 1', startUtc: '2026-09-30T16:25:00Z' });
    expect(imsaSessions(html, 'mx5-cup')).toEqual([]);
  });

  it('terminada la temporada (el sitio ya no publica /2026/schedule) la temporada vigente es la siguiente', async () => {
    const imsa = genericSeries('imsa', 'IMSA WeatherTech SportsCar Championship', ['https://www.imsa.com/schedule?series=weathertech'], { shortName: 'IMSA' });
    const http = fakeHttp({ 'https://www.imsa.com/2027/schedule?series=weathertech': fixture('imsa-schedule-2027.html') });
    const chunk = await createGenericAdapter({ gemini: () => fakeGemini() }).schedule(imsa, testContext(http, NOW));
    expect(chunk.events.map((e) => [e.name, e.round, e.dateStart])).toEqual([
      ['Roar Before The Rolex 24', undefined, '2027-01-22'],
      ['Rolex 24 At Daytona', 1, '2027-01-28'],
      ['Chevrolet Detroit Sports Car Classic', 2, '2027-06-04'],
      ['Chevrolet Grand Prix', 3, '2027-07-09'],
    ]);
    expect(http.requested).toContain('https://www.imsa.com/2026/schedule?series=weathertech');
  });
});

describe('IMSA: campeonato por lectura directa (/api/imsa-standings)', () => {
  const IMSA_STANDINGS = 'https://www.imsa.com/weathertech/standings';
  const imsa = genericSeries('imsa', 'IMSA WeatherTech SportsCar Championship', ['https://www.imsa.com/schedule?series=weathertech', IMSA_STANDINGS], { shortName: 'IMSA' });
  const json = (type: string, season: number) => fixture(`imsa-standings-${type}-${season}.json`);
  const bodies = () => ({
    driver: JSON.parse(json('driver', 2026)) as unknown,
    team: JSON.parse(json('team', 2026)) as unknown,
    manufacturer: JSON.parse(json('manufacturer', 2026)) as unknown,
  });

  it('pilotos (uno por fila, con equipo, número y país), equipos y marcas por clase, en castellano', () => {
    const tables = imsaStandingsTables(bodies());
    expect(tables.map((t) => [t.title, t.rows.length])).toEqual([
      ['Pilotos GTP', 8],
      ['Pilotos LMP2', 8],
      ['Pilotos GTD Pro', 8],
      ['Pilotos GTD', 8],
      ['Equipos GTP', 4],
      ['Equipos LMP2', 4],
      ['Equipos GTD Pro', 4],
      ['Equipos GTD', 4],
      ['Marcas GTP', 3],
      ['Marcas GTD Pro', 3],
      ['Marcas GTD', 3],
    ]);
    const gtp = tables[0]!.rows;
    expect(gtp[0]).toEqual({ pos: 1, name: 'Jack Aitken', team: 'Cadillac Whelen', number: '31', points: 3020, country: 'GB' });
    // Compañeros de auto empatados comparten la posición; la siguiente no salta (3, 3, 4).
    expect(gtp.slice(2, 5).map((r) => [r.pos, r.name, r.number])).toEqual([
      [3, 'Renger van der Zande', '93'],
      [3, 'Nick Yelloly', '93'],
      [4, 'Kevin Estre', '6'],
    ]);
    // La ficha dice #7 y en la tabla de equipos recortada no está ese auto de Penske: mejor sin número que uno ajeno.
    expect(gtp[1]).toEqual({ pos: 2, name: 'Laurin Heinrich', team: 'Porsche Penske Motorsport', points: 2859, country: 'DE' });
    // "4" en la ficha y "04" en el auto (CrowdStrike by APR).
    expect(tables[1]!.rows[0]).toMatchObject({ pos: 1, name: 'George Kurtz', number: '04' });
    expect(tables[5]!.rows[0]).toEqual({ pos: 1, name: 'Crowdstrike Racing by APR', number: '04', points: 2322 });
    expect(tables[8]!.rows.map((r) => [r.pos, r.name, r.points])).toEqual([
      [1, 'Cadillac', 3244],
      [2, 'Porsche', 3156],
      [3, 'Acura', 2973],
    ]);
  });

  it('temporada de la respuesta; null si todavía no tiene tabla; error si el formato cambió', () => {
    expect(imsaStandingsSeason(JSON.parse(json('driver', 2026)), 'driver', 1)).toBe(2026);
    expect(imsaStandingsSeason(JSON.parse(json('driver', 2027)), 'driver', 1)).toBeNull();
    expect(() => imsaStandingsSeason({ data: [] }, 'driver', 1)).toThrow('respuesta inesperada');
    expect(() => imsaStandingsSeason(JSON.parse(json('team', 2026)), 'driver', 1)).toThrow('respuesta inesperada');
  });

  it('con el calendario ya en 2027 y la tabla 2027 vacía, publica la de 2026 con su año', async () => {
    const { out, http, gemini } = await readStandings(imsa, {
      'https://www.imsa.com/2027/schedule?series=weathertech': fixture('imsa-schedule-2027.html'),
      [imsaStandingsApi(1, 'driver', 2027)]: json('driver', 2027),
      [imsaStandingsApi(1, 'driver', 2026)]: json('driver', 2026),
      [imsaStandingsApi(1, 'team', 2026)]: json('team', 2026),
      [imsaStandingsApi(1, 'manufacturer', 2026)]: json('manufacturer', 2026),
    });
    const file = standingsFileSchema.parse(out.standings);
    expect(file.season).toBe(2026);
    expect(file.tables[0]!.title).toBe('Pilotos GTP');
    expect(file.source).toMatchObject({
      url: IMSA_STANDINGS,
      title: 'IMSA WeatherTech SportsCar Championship — Point Standings 2026',
      kind: 'api',
      method: 'directo',
    });
    expect(http.requested).not.toContain(imsaStandingsApi(1, 'team', 2027));
    expect(gemini.requests).toHaveLength(0);
    const index = buildDrivers({ series: [imsa], standings: [file], results: [], sessions: [], generatedAt: NOW });
    const aitken = index.drivers.find((d) => d.name === 'Jack Aitken');
    expect(aitken?.country).toBe('GB');
    expect(aitken?.entries[0]).toMatchObject({ seriesId: 'imsa', table: 'Pilotos GTP', pos: 1, number: '31', team: 'Cadillac Whelen' });
  });

  it('sin tabla ni de la temporada pedida ni de la anterior: null (sin IA)', async () => {
    const empty = json('driver', 2027);
    const { out, gemini } = await readStandings(imsa, {
      'https://www.imsa.com/2027/schedule?series=weathertech': fixture('imsa-schedule-2027.html'),
      [imsaStandingsApi(1, 'driver', 2027)]: empty,
      [imsaStandingsApi(1, 'driver', 2026)]: empty.replace(/2027/g, '2026'),
    });
    expect(out.standings).toBeUndefined();
    expect(gemini.requests).toHaveLength(0);
  });
});
