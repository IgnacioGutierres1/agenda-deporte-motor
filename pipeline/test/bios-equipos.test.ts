import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { seriesHistoryFileSchema, teamBiosFileSchema } from '@dm/shared';
import { classNote, parseSeason, pickTable, readChampions, type ChampionsSource } from '../src/bios/champions.ts';
import { computeRecords, linkTeam, type AppIndex } from '../src/bios/series.ts';
import { chooseItem, findCandidates, indexCandidates, teamKind, titlesFor, type Candidate } from '../src/bios/teams.ts';
import { runTeamBios } from '../src/bios/teams-run.ts';
import { parseItem, summaryText, type WdItem } from '../src/bios/wd.ts';
import { parseWikiTables } from '../src/bios/wikitable.ts';
import { createLogger } from '../src/core/log.ts';
import { HttpError, type Http } from '../src/core/http.ts';
import { fixture } from './fake-http.ts';

const tables = (name: string) => parseWikiTables(fixture(`bios/${name}`));
const read = (name: string, src: Omit<ChampionsSource, 'lang' | 'page'>) => {
  const all = tables(name);
  const table = pickTable(all, src, src.season);
  expect(table).toBeDefined();
  return readChampions(table!, { lang: 'en', page: 'x', ...src }, src.teams ? pickTable(all, src.teams) : undefined);
};

describe('lector de tablas de Wikipedia', () => {
  it('lee la tabla de campeones de F2 (encabezados, banderas y notas fuera)', () => {
    const [t] = tables('f2-campeones.html');
    expect(t!.headings).toEqual(["Drivers' Championship"]);
    expect(t!.header.slice(0, 3)).toEqual(['Season', 'Driver', 'Team']);
    expect(t!.rows[0]!.slice(0, 3).map((c) => c.text)).toEqual(['2017', 'Charles Leclerc', 'Prema Racing']);
    expect(t!.rows[0]![1]!.links).toEqual(['Charles Leclerc']);
  });

  it('expande rowspan: la temporada de la NASCAR se repite en cada fila', () => {
    const [t] = tables('nascar-cup-campeones.html');
    expect(t!.rows.every((r) => /^\d{4}$/.test(r[0]!.text))).toBe(true);
  });
});

describe('campeones', () => {
  it('F2: piloto y equipo por temporada', () => {
    const rows = read('f2-campeones.html', { driver: '^Driver', team: '^Team' });
    expect(rows.map((r) => [r.season, r.driver, r.team])).toEqual([
      [2017, 'Charles Leclerc', 'Prema Racing'],
      [2018, 'George Russell', 'ART Grand Prix'],
      [2019, 'Nyck de Vries', 'ART Grand Prix'],
      [2020, 'Mick Schumacher', 'Prema Racing'],
      [2021, 'Oscar Piastri', 'Prema Racing'],
    ]);
  });

  it('NASCAR Cup: el equipo entre paréntesis, la marca y una sola fila por campeón', () => {
    const rows = read('nascar-cup-campeones.html', { driver: '^Driver', team: '^Owner', teamParen: true, vehicle: '^Man', vehicleIsMake: true });
    expect(rows[0]).toMatchObject({ season: 1949, driver: 'Red Byron', team: 'Raymond Parks', vehicle: 'Oldsmobile', make: 'Oldsmobile' });
    const seasons = rows.map((r) => r.season);
    expect(new Set(seasons).size).toBe(seasons.length);
    expect(rows.find((r) => r.season === 1960)).toMatchObject({ driver: 'Rex White' });
  });

  it('WEC: un renglón por piloto se une en una tripulación', () => {
    const rows = read('wec-campeones.html', { driver: '^Drivers', team: '^Team', vehicle: 'Manufacturer' });
    expect(rows[0]).toMatchObject({
      season: 2012,
      driver: 'Marcel Fässler / André Lotterer / Benoît Tréluyer',
      team: 'Audi Sport Team Joest',
      vehicle: 'Audi',
    });
  });

  it('IMSA: tabla ancha por clase, con encabezados intermedios y los equipos de la otra tabla', () => {
    const rows = read('imsa-campeones.html', { section: '^Drivers$', classes: true, teams: { section: '^Teams$' } });
    const y2014 = rows.filter((r) => r.season === 2014);
    expect(y2014[0]).toMatchObject({ driver: 'João Barbosa / Christian Fittipaldi', team: 'Action Express Racing', note: 'Clase P', primary: true });
    expect(y2014.slice(1).every((r) => !r.primary)).toBe(true);
    const gtp = rows.find((r) => r.season === 2026 && r.primary);
    expect(gtp).toMatchObject({ driver: 'Jack Aitken', team: 'Cadillac Whelen', note: 'Clase GTP' });
    // Ninguna clase aparece como piloto (las filas de encabezado no son campeones).
    expect(rows.some((r) => /^(?:GTP|LMP2|GTD|DPi)$/.test(r.driver ?? ''))).toBe(false);
  });

  it('TC: la marca es la primera palabra del auto', () => {
    const rows = read('tc-campeones.html', { section: '^Campeones$', season: '^Año', driver: '^Piloto', vehicle: '^Marca', vehicleIsMake: true, makeWord: true });
    expect(rows[0]).toMatchObject({ season: 1937, driver: 'Eduardo Pedrazzini', vehicle: 'Ford V8', make: 'Ford' });
  });

  it('temporadas y notas', () => {
    expect(parseSeason('2025–26')).toEqual({ season: 2025, span: '2025-26' });
    expect(parseSeason('1984–/1996')).toEqual({ season: 1984 });
    expect(parseSeason('Season')).toBeNull();
    expect(classNote('Overall')).toBe('General');
    expect(classNote('GTD')).toBe('Clase GTD');
    expect(classNote('Am Drivers (2016) Bronze Drivers (2018–2019) Independent Cup (2023–)')).toBe('Independent Cup');
  });

  it('récords: más títulos (contando a cada integrante), equipos, primero y vigente', () => {
    const row = (season: number, driver: string, team?: string) => ({ season, driver, team, primary: true, countTeam: true });
    const records = computeRecords([
      row(2024, 'A. Uno / B. Dos', 'Equipo X'),
      row(2023, 'A. Uno', 'Equipo X'),
      row(2022, 'C. Tres', 'Equipo Y'),
      { season: 2022, driver: 'Z. Clase B', primary: false },
    ]);
    expect(records).toEqual([
      { label: 'Más títulos', value: 'A. Uno (2)' },
      { label: 'Más títulos de equipos', value: 'Equipo X (2)' },
      { label: 'Primer campeón', value: 'C. Tres (2022)' },
      { label: 'Campeón vigente', value: 'A. Uno / B. Dos (2024)' },
      { label: 'Campeones distintos', value: '3' },
    ]);
  });

  it('vincula el equipo campeón con el de la app por el artículo o por el nombre', () => {
    const index: AppIndex = {
      drivers: new Set(),
      teams: [
        { id: 'oracle-red-bull-racing', name: 'Oracle Red Bull Racing', series: ['f1'] },
        { id: 'prema-racing', name: 'PREMA Racing', series: ['f2'] },
        { id: 'team-penske', name: 'Team Penske', series: ['nascar-cup'] },
      ],
      teamArticles: new Map([['en:Red Bull Racing', 'oracle-red-bull-racing']]),
    };
    expect(linkTeam(index, 'f1', 'Red Bull', ['Red Bull Racing'])).toBe('oracle-red-bull-racing');
    expect(linkTeam(index, 'f2', 'Prema Racing')).toBe('prema-racing');
    expect(linkTeam(index, 'nascar-cup', 'Penske Racing')).toBe('team-penske');
    expect(linkTeam(index, 'f2', 'ART Grand Prix')).toBeUndefined();
  });
});

// ── Equipos ──

const cand = (id: string, names: string[], kind: Candidate['kind'] = 'car', extra: Partial<Candidate> = {}): Candidate => ({
  id,
  names: new Set(names),
  kind,
  sitelinks: 10,
  ...extra,
});

function item(id: string, claims: Record<string, string[]> = {}, extra: Partial<WdItem> = {}): WdItem {
  const c: Record<string, unknown> = {};
  for (const [prop, ids] of Object.entries(claims)) {
    c[prop] = ids.map((q) => ({ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { value: { id: q } } } }));
  }
  return { id, labels: {}, claims: c, sitelinks: 10, ...extra };
}

describe('identificación de equipos', () => {
  const cands = [
    cand('Q1', ['Hendrick Motorsports']),
    cand('Q2', ['Red Bull Racing'], 'car'),
    cand('Q3', ['Gresini Racing'], 'moto'),
    cand('Q4', ['Modena'], 'car', { f1Only: true }),
    cand('Q5', ['Iron Lynx']),
    cand('Q6', ['Iron Lynx']),
  ];
  const index = indexCandidates(cands);
  const seriesQids = new Map([['f1', 'Q1968'], ['motogp', 'Q10858737'], ['nascar-cup', 'Q2707177']]);

  it('nombre igual y un solo candidato: se acepta', () => {
    const team = { id: 'hendrick-motorsports', name: 'Hendrick Motorsports', series: ['nascar-cup'] };
    const m = findCandidates(index, team.name)!;
    expect(m.how).toBe('exacto');
    expect(chooseItem(team, m, new Map([['Q1', item('Q1')]]), seriesQids)).toMatchObject({ qid: 'Q1', why: 'único' });
  });

  it('nombre contenido: solo con la categoría o el país confirmados', () => {
    const team = { id: 'bk8-gresini-racing-motogp', name: 'BK8 Gresini Racing MotoGP', series: ['motogp'] };
    const m = findCandidates(index, team.name)!;
    expect(m.how).toBe('contenido');
    expect(chooseItem(team, m, new Map([['Q3', item('Q3')]]), seriesQids)).toBeNull();
    expect(chooseItem(team, m, new Map([['Q3', item('Q3', { P118: ['Q10858737'] })]]), seriesQids)).toMatchObject({ qid: 'Q3', why: 'categoría' });
  });

  it('el deporte tiene que coincidir y una escudería de F1 solo vale para la F1', () => {
    expect(teamKind(['motogp'])).toBe('moto');
    expect(teamKind(['dakar'])).toBe('any');
    const moto = { id: 'x', name: 'Red Bull Racing', series: ['motogp'] };
    expect(chooseItem(moto, findCandidates(index, moto.name)!, new Map([['Q2', item('Q2')]]), seriesQids)).toBeNull();
    const gt = { id: 'modena-motorsports', name: 'Modena', series: ['24h-series'] };
    expect(chooseItem(gt, findCandidates(index, gt.name)!, new Map([['Q4', item('Q4')]]), seriesQids)).toBeNull();
  });

  it('dos candidatos con el mismo nombre y sin confirmación: ninguno', () => {
    const team = { id: 'iron-lynx', name: 'Iron Lynx', series: ['wec'] };
    const m = findCandidates(index, team.name)!;
    expect(m.list).toHaveLength(2);
    expect(chooseItem(team, m, new Map([['Q5', item('Q5')], ['Q6', item('Q6')]]), seriesQids)).toBeNull();
  });

  it('títulos del equipo desde las listas de campeones', () => {
    const titles = titlesFor(
      'team-penske',
      [{ seriesId: 'nascar-cup', champions: [{ season: 2024, teamId: 'team-penske' }, { season: 2023, teamId: 'team-penske' }, { season: 2022, teamId: 'x' }] }],
      new Map([['nascar-cup', 'NASCAR Cup Series']]),
    );
    expect(titles).toEqual([
      { season: 2024, series: 'NASCAR Cup Series', seriesId: 'nascar-cup' },
      { season: 2023, series: 'NASCAR Cup Series', seriesId: 'nascar-cup' },
    ]);
  });

  it('resumen de uno o dos párrafos', () => {
    expect(summaryText('Corto.\n\nPrimer párrafo con suficiente texto para ser un resumen de verdad, de más de cuarenta letras.')).toBe(
      'Primer párrafo con suficiente texto para ser un resumen de verdad, de más de cuarenta letras.',
    );
    expect(parseItem({ id: 'Q1', labels: { es: { value: 'Uno' } }, sitelinks: { eswiki: { title: 'Uno' } }, claims: {} })).toMatchObject({ id: 'Q1', eswiki: 'Uno', labels: { es: 'Uno' } });
  });
});

// ── Paso completo con un Http falso ──

function routeHttp(routes: Array<[pattern: string | RegExp, body: unknown]>): Http & { calls: string[] } {
  const calls: string[] = [];
  const get = async (url: string) => {
    calls.push(url);
    const decoded = decodeURIComponent(url);
    const route = routes.find(([p]) => (typeof p === 'string' ? decoded.includes(p) : p.test(decoded)));
    if (!route) throw new HttpError(url, 404, `HTTP 404 en ${url}`);
    return { url, status: 200, contentType: 'application/json', body: route[1] };
  };
  return {
    calls,
    json: get as Http['json'],
    text: async () => {
      throw new Error('solo JSON');
    },
    bytes: async () => {
      throw new Error('solo JSON');
    },
  };
}

describe('runTeamBios', () => {
  it('arma las fichas de equipos y la historia de la categoría, con los títulos vinculados', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'bios-'));
    const dataDir = path.join(dir, 'data');
    const configDir = path.join(dir, 'config');
    await mkdir(dataDir, { recursive: true });
    await mkdir(configDir, { recursive: true });
    await writeFile(
      path.join(dataDir, 'teams.json'),
      JSON.stringify({
        version: 1,
        generatedAt: '2026-11-13T00:00:00Z',
        teams: [
          { id: 'prema-racing', name: 'PREMA Racing', entries: [{ seriesId: 'f2' }], drivers: [] },
          { id: 'equipo-ignoto', name: 'Equipo Ignoto', entries: [{ seriesId: 'f2' }], drivers: [] },
        ],
      }),
    );
    await writeFile(
      path.join(configDir, 'series-history.json'),
      JSON.stringify({ f2: { wikidata: 'Q29383721', organizer: 'FIA', champions: [{ lang: 'en', page: 'FIA Formula 2 Championship', driver: '^Driver', team: '^Team' }] } }),
    );
    await writeFile(path.join(configDir, 'team-bios.json'), JSON.stringify({ 'prema-racing': 'Q2115327', 'equipo-ignoto': null }));
    await writeFile(path.join(configDir, 'series.default.json'), JSON.stringify({ series: [] }));

    const prema = {
      id: 'Q2115327',
      labels: { en: { value: 'Prema Racing' } },
      sitelinks: { enwiki: { title: 'Prema Racing' } },
      claims: {
        P571: [{ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { value: { time: '+1983-00-00T00:00:00Z' } } } }],
        P17: [{ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { value: { id: 'Q38' } } } }],
        P159: [{ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { value: { id: 'Q1234' } } } }],
        P154: [{ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { value: 'Prema logo.svg' } } }],
        P856: [{ rank: 'normal', mainsnak: { snaktype: 'value', datavalue: { value: 'https://www.premapowerteam.com' } } }],
      },
    };
    const f2 = { id: 'Q29383721', labels: {}, sitelinks: { enwiki: { title: 'FIA Formula 2 Championship' } }, claims: {} };
    const http = routeHttp([
      ['ids=Q2115327', { entities: { Q2115327: prema } }],
      ['ids=Q29383721', { entities: { Q29383721: f2 } }],
      [
        'query.wikidata.org',
        {
          results: {
            bindings: [
              { x: { value: 'http://www.wikidata.org/entity/Q38' }, es: { value: 'Italia' } },
              { x: { value: 'http://www.wikidata.org/entity/Q1234' }, es: { value: 'Grisignano di Zocco' }, ces: { value: 'Italia' } },
            ],
          },
        },
      ],
      [
        'commons.wikimedia.org',
        {
          query: {
            pages: [
              {
                title: 'File:Prema logo.svg',
                imageinfo: [
                  {
                    thumburl: 'https://upload.wikimedia.org/x/320px-Prema_logo.svg.png',
                    thumbwidth: 320,
                    thumbheight: 100,
                    descriptionurl: 'https://commons.wikimedia.org/wiki/File:Prema_logo.svg',
                    extmetadata: { LicenseShortName: { value: 'Public domain' }, Artist: { value: 'Prema' } },
                  },
                ],
              },
            ],
          },
        },
      ],
      [
        'action=parse',
        { parse: { title: 'FIA Formula 2 Championship', text: fixture('bios/f2-campeones.html') } },
      ],
      [
        'prop=extracts',
        {
          query: {
            pages: [
              { title: 'Prema Racing', extract: 'Prema Racing is an Italian auto racing team founded in 1983 and based in Grisignano di Zocco.' },
              { title: 'FIA Formula 2 Championship', extract: 'The FIA Formula 2 Championship is a second-tier single-seater championship organised by the FIA.' },
            ],
          },
        },
      ],
    ]);

    const res = await runTeamBios({ log: createLogger('', true), http, now: new Date('2026-11-14T12:00:00Z'), dataDir, configDir, pauseMs: 0, sleep: async () => {} });
    expect(res?.error).toBeUndefined();
    expect(res?.teams.map((t) => [t.id, t.wikidata])).toEqual([
      ['equipo-ignoto', null],
      ['prema-racing', 'Q2115327'],
    ]);

    const teams = teamBiosFileSchema.parse(JSON.parse(await readFile(path.join(dataDir, 'bios', 'teams.json'), 'utf8')));
    expect(teams.teams).toHaveLength(1);
    expect(teams.teams[0]).toMatchObject({
      id: 'prema-racing',
      wikidata: 'Q2115327',
      founded: 1983,
      country: 'Italia',
      base: 'Grisignano di Zocco, Italia',
      website: 'https://www.premapowerteam.com',
      summary: { lang: 'en', url: 'https://en.wikipedia.org/wiki/Prema_Racing' },
      logo: { license: 'Dominio público', page: 'https://commons.wikimedia.org/wiki/File:Prema_logo.svg' },
    });
    expect(teams.teams[0]!.titles?.map((t) => t.season)).toEqual([2021, 2020, 2017]);

    const series = seriesHistoryFileSchema.parse(JSON.parse(await readFile(path.join(dataDir, 'bios', 'series.json'), 'utf8')));
    const h = series.series[0]!;
    expect(h).toMatchObject({ seriesId: 'f2', organizer: 'FIA', founded: 2017, championsSource: { title: 'FIA Formula 2 Championship' } });
    expect(h.champions[0]).toEqual({ season: 2021, driver: 'Oscar Piastri', team: 'Prema Racing', teamId: 'prema-racing' });
    expect(h.records).toContainEqual({ label: 'Más títulos de equipos', value: 'Prema Racing (3)' });

    // Segunda corrida: nada vencido, ninguna consulta.
    const before = http.calls.length;
    const again = await runTeamBios({ log: createLogger('', true), http, now: new Date('2026-11-15T12:00:00Z'), dataDir, configDir, pauseMs: 0, sleep: async () => {} });
    expect(again?.requests).toBe(0);
    expect(http.calls.length).toBe(before);
  });
});
