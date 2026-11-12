import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rosterFileSchema, type RosterFile } from '@dm/shared';
import { createLogger } from '../src/core/log.ts';
import { readRoster, rosterStale, runRosters } from '../src/core/rosters.ts';
import { findRecipe } from '../src/generic/recipes.ts';
import { acoCarPage, acoDriverCards, className, dtmRosterRows, orderNameBySlug, splitTeamNumber, sroEntryListRows } from '../src/generic/rosters.ts';
import { fakeHttp, fixture, genericSeries } from './fakes.ts';

const NOW = '2026-11-11T12:00:00Z';
const log = createLogger('', true);
const ctxFor = (http: ReturnType<typeof fakeHttp>, now = NOW) => ({ now: new Date(now), season: new Date(now).getUTCFullYear(), http, log });

const wec = genericSeries('wec', 'WEC', ['https://www.fiawec.com/en/season/2026'], { rosterUrls: ['https://www.fiawec.com/en/page/grid'] });
const elms = genericSeries('elms', 'ELMS', ['https://www.europeanlemansseries.com/en/season/2026'], {
  rosterUrls: ['https://www.europeanlemansseries.com/en/page/drivers'],
});
const gtwce = genericSeries('gtwc-europe', 'GTWC Europe', ['https://www.gt-world-challenge-europe.com/calendar'], {
  rosterUrls: ['https://www.gt-world-challenge-europe.com/entry-lists'],
});
const dtm = genericSeries('dtm', 'DTM', ['https://www.dtm.com/en/calendar'], { rosterUrls: ['https://api.dtm.com/data?query=drivers'] });

const wecHttp = () =>
  fakeHttp({
    'https://www.fiawec.com/en/page/grid': fixture('aco-wec-grid.html'),
    'https://www.fiawec.com/en/car/2026/35': fixture('aco-wec-car-35.html'),
    'https://www.fiawec.com/en/car/2026/23': fixture('aco-wec-car-23.html'),
    // El #36 no responde: se omite sin cortar la lista.
  });

describe('utilidades de listas de inscriptos', () => {
  it('ordena "Apellido Nombre" según el nombre del archivo de la foto', () => {
    const file = 'https://www.fiawec.com/uploads/2026-wec-35-antonio-felix-da-costa-right-69e1f232a7ad5929080471.png';
    expect(orderNameBySlug('Félix da Costa António', file)).toBe('António Félix da Costa');
    expect(orderNameBySlug('Habsburg Ferdinand', '2026-wec-35-ferdinand-habsburg-right-69e1.png')).toBe('Ferdinand Habsburg');
    expect(orderNameBySlug('Vergne Jean-Eric', '2026-wec-jean-eric-vergne-right.png')).toBe('Jean-Eric Vergne');
    // Si el archivo no tiene las mismas palabras, el nombre queda como se publica.
    expect(orderNameBySlug('Milesi Charles', '2026-wec-35-alpine-a424.png')).toBe('Milesi Charles');
  });

  it('separa equipo y número, y prolija las clases', () => {
    expect(splitTeamNumber('PROTON COMPETITION #9')).toEqual({ team: 'PROTON COMPETITION', number: '9' });
    expect(splitTeamNumber('ASTON MARTIN THOR TEAM #007')).toEqual({ team: 'ASTON MARTIN THOR TEAM', number: '007' });
    expect(splitTeamNumber('IRON LYNX')).toEqual({ team: 'IRON LYNX' });
    expect(className('LMP2 PRO/AM')).toBe('LMP2 Pro/Am');
    expect(className('HYPERCAR')).toBe('Hypercar');
    expect(className('LMGT3')).toBe('LMGT3');
    expect(className('PRO-AM')).toBe('Pro-Am');
  });

  it('decide cuándo releer una lista', () => {
    const now = new Date(NOW);
    expect(rosterStale(null, now)).toBe(true);
    expect(rosterStale({ updatedAt: '2026-11-10T12:00:00Z' }, now)).toBe(false);
    expect(rosterStale({ updatedAt: '2026-11-07T12:00:00Z' }, now)).toBe(true);
    // Cambio de año: se relee aunque tenga horas.
    expect(rosterStale({ updatedAt: '2026-12-31T22:00:00Z' }, new Date('2027-01-01T06:00:00Z'))).toBe(true);
  });
});

describe('ACO (WEC, ELMS)', () => {
  it('WEC: grilla de autos + ficha de cada auto (pilotos, modelo, clase, equipo y número)', async () => {
    const http = wecHttp();
    const roster = await readRoster(wec, ctxFor(http));
    expect(roster).not.toBeNull();
    expect(rosterFileSchema.parse(roster)).toBeTruthy();
    expect(roster!.season).toBe(2026);
    expect(http.requested).toContain('https://www.fiawec.com/en/car/2026/36');
    expect(roster!.rows.slice(0, 3)).toEqual([
      { driver: 'António Félix da Costa', team: 'ALPINE ENDURANCE TEAM', number: '35', vehicle: 'ALPINE A424', class: 'Hypercar' },
      { driver: 'Charles Milesi', team: 'ALPINE ENDURANCE TEAM', number: '35', vehicle: 'ALPINE A424', class: 'Hypercar' },
      { driver: 'Ferdinand Habsburg', team: 'ALPINE ENDURANCE TEAM', number: '35', vehicle: 'ALPINE A424', class: 'Hypercar' },
    ]);
    const gt = roster!.rows.filter((r) => r.number === '23');
    expect(gt).toHaveLength(3);
    expect(gt[0]).toMatchObject({ team: 'HEART OF RACING TEAM', class: 'LMGT3', vehicle: 'ASTON MARTIN Vantage AMR LMGT3' });
    expect(roster!.source).toMatchObject({ url: 'https://www.fiawec.com/en/page/grid', method: 'directo' });
  });

  it('WEC: ficha de un auto', () => {
    expect(acoCarPage(fixture('aco-wec-car-35.html'))).toEqual({
      drivers: ['António Félix da Costa', 'Charles Milesi', 'Ferdinand Habsburg'],
      vehicle: 'ALPINE A424',
    });
  });

  it('ELMS: tarjetas de pilotos con equipo, número, país y la clase del título anterior', async () => {
    const { rows, season } = acoDriverCards(fixture('aco-elms-drivers.html'));
    expect(season).toBe(2026);
    expect(rows).toEqual([
      { driver: 'Georgios Kolovos', team: 'PROTON COMPETITION', number: '9', class: 'LMP2', country: 'Germany' },
      { driver: 'Sebastian Priaulx', team: 'PROTON COMPETITION', number: '9', class: 'LMP2', country: 'Great Britain' },
      expect.objectContaining({ driver: 'Michael BIRCH', class: 'LMGT3' }),
    ]);
    const http = fakeHttp({ 'https://www.europeanlemansseries.com/en/page/drivers': fixture('aco-elms-drivers.html') });
    const roster = await readRoster(elms, ctxFor(http));
    expect(roster!.rows).toHaveLength(3);
  });

  it('ELMS: una lista de hace dos temporadas ya no se publica', async () => {
    const http = fakeHttp({ 'https://www.europeanlemansseries.com/en/page/drivers': fixture('aco-elms-drivers.html') });
    expect(await readRoster(elms, ctxFor(http, '2028-03-01T12:00:00Z'))).toBeNull();
  });
});

describe('SRO (listas de inscriptos por carrera)', () => {
  it('lee la tabla de inscriptos: número, equipo, pilotos con bandera, auto y clase (sin casilleros vacíos)', () => {
    const rows = sroEntryListRows(fixture('sro-entry-list-spa.html'));
    expect(rows.find((r) => r.driver === 'Maro ENGEL')).toEqual({
      driver: 'Maro ENGEL',
      team: 'Mercedes - AMG Team MANN-FILTER',
      number: '48',
      vehicle: 'Mercedes-AMG GT3 EVO',
      class: 'Pro',
      country: 'Germany',
    });
    expect(rows.filter((r) => r.number === '2')).toHaveLength(3); // el casillero "/" no es un piloto
  });

  it('une las listas de todas las carreras de la temporada (un piloto por auto)', async () => {
    const http = fakeHttp({
      'https://www.gt-world-challenge-europe.com/entry-lists': fixture('sro-entry-lists.html'),
      'https://www.gt-world-challenge-europe.com/entry-list/2026/circuit-paul-ricard': fixture('sro-entry-list-paul-ricard.html'),
      'https://www.gt-world-challenge-europe.com/entry-list/2026/crowdstrike-24-hours-of-spa': fixture('sro-entry-list-spa.html'),
    });
    const roster = await readRoster(gtwce, ctxFor(http));
    expect(roster!.season).toBe(2026);
    expect(roster!.rows.filter((r) => /engel/i.test(r.driver))).toHaveLength(1);
    // Paul Ricard (6 pilotos) + Spa (10, 6 repetidos).
    expect(roster!.rows).toHaveLength(10);
  });
});

describe('DTM (API oficial)', () => {
  it('toma la temporada más reciente y omite pilotos ocultos o de otras temporadas', async () => {
    const data = JSON.parse(fixture('dtm-drivers.json'));
    const found = dtmRosterRows(data, 2026);
    expect(found!.season).toBe(2026);
    expect(found!.rows).toEqual([
      { driver: 'Maro Engel', team: 'Mercedes-AMG Team Ravenol', number: '80', vehicle: 'Mercedes-AMG GT3', country: 'Germany' },
    ]);
    const http = fakeHttp({ 'https://api.dtm.com/data?query=drivers': fixture('dtm-drivers.json') });
    const roster = await readRoster(dtm, ctxFor(http));
    expect(roster!.source.kind).toBe('api');
    expect(roster!.rows).toHaveLength(1);
  });
});

describe('fase de inscriptos', () => {
  const tmp = () => mkdtempSync(path.join(tmpdir(), 'dm-rosters-'));
  const prev: RosterFile = {
    seriesId: 'elms',
    season: 2026,
    updatedAt: '2026-10-01T00:00:00Z',
    rows: [{ driver: 'Piloto Anterior' }],
    source: { url: 'https://www.europeanlemansseries.com/en/page/drivers', title: 'x', kind: 'html', method: 'directo', fetchedAt: '2026-10-01T00:00:00Z' },
  };

  it('escribe las listas vencidas y deja las recientes; un error conserva el archivo anterior', async () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'rosters'));
    writeFileSync(path.join(dir, 'rosters', 'elms.json'), JSON.stringify(prev));
    writeFileSync(path.join(dir, 'rosters', 'dtm.json'), JSON.stringify({ ...prev, seriesId: 'dtm', updatedAt: '2026-11-10T00:00:00Z' }));
    const http = fakeHttp({
      'https://www.fiawec.com/en/page/grid': fixture('aco-wec-grid.html'),
      'https://www.fiawec.com/en/car/2026/35': fixture('aco-wec-car-35.html'),
      'https://www.fiawec.com/en/car/2026/23': fixture('aco-wec-car-23.html'),
      'https://www.europeanlemansseries.com/en/page/drivers': '<html><body>sin tarjetas</body></html>',
    });
    const fresh = await runRosters([wec, elms, dtm, genericSeries('f1', 'F1', [])], ctxFor(http), dir, false);
    expect([...fresh.keys()]).toEqual(['wec']);
    expect(rosterFileSchema.parse(JSON.parse(readFileSync(path.join(dir, 'rosters', 'wec.json'), 'utf8'))).rows).toHaveLength(6);
    // ELMS falló (página sin tarjetas): queda la lista anterior. DTM está al día: ni se pide.
    expect(JSON.parse(readFileSync(path.join(dir, 'rosters', 'elms.json'), 'utf8')).rows).toEqual(prev.rows);
    expect(http.requested.some((u) => u.includes('dtm.com'))).toBe(false);
  });

  it('con --dry-run devuelve lo leído pero no escribe', async () => {
    const dir = tmp();
    const fresh = await runRosters([wec], ctxFor(wecHttp()), dir, true);
    expect(fresh.get('wec')!.rows.length).toBeGreaterThan(0);
    expect(existsSync(path.join(dir, 'rosters', 'wec.json'))).toBe(false);
  });

  it('las recetas con lector de inscriptos', () => {
    for (const url of [
      'https://www.fiawec.com/en/page/grid',
      'https://www.europeanlemansseries.com/en/page/drivers',
      'https://www.asianlemansseries.com/en/page/drivers',
      'https://www.gt-world-challenge-europe.com/entry-lists',
      'https://www.intercontinentalgtchallenge.com/entry-lists',
      'https://api.dtm.com/data?query=drivers',
    ]) {
      expect(findRecipe(url)?.roster, url).toBeTypeOf('function');
    }
  });
});
