/**
 * Historial de pilotos: trayectoria desde las tablas de Wikipedia (wikitexto real recortado), identificación segura
 * en Wikidata, fotos oficiales (páginas y feeds reales recortados) y la fase runDriverBios de punta a punta.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { driverBiosShardFileSchema, driverShard, type Driver, type DriverBio, type Series } from '@dm/shared';
import { createApi } from '../src/circuits/api.ts';
import { careerFromWikitext, seriesIdFor, titlesOf } from '../src/bios/career.ts';
import { nationalityOf, pickImage, readDetails } from '../src/bios/details.ts';
import { appCareer, countryIso, nameVariants, runDriverBios, searchableName, selectDue, withAppSeason } from '../src/bios/drivers.ts';
import { chooseCandidate, type Candidate, type CandidateEvidence } from '../src/bios/identify.ts';
import { parseF1Drivers, parseMotoGpRiders, parseNascarDrivers } from '../src/bios/official-photos.ts';
import { summaryOf } from '../src/bios/wiki.ts';
import { HttpError, type Http } from '../src/core/http.ts';
import { createLogger } from '../src/core/log.ts';
import { fakeHttp, fixture } from './fake-http.ts';

const log = createLogger('test', true);
const NOW = new Date('2026-11-14T09:00:00Z');
const NOW_ISO = '2026-11-14T09:00:00Z';
const wiki = (name: string) => fixture(`bios/${name}`);

describe('trayectoria desde Wikipedia', () => {
  it('lee el "Racing career summary" de Colapinto con rowspan, equipos y categorías de la app', () => {
    const career = careerFromWikitext(wiki('colapinto-en.wiki'));
    expect(career).toHaveLength(20);
    // De la más reciente a la más vieja.
    expect(career.map((r) => r.season)).toEqual([...career.map((r) => r.season)].sort((a, b) => b - a));
    expect(career[0]).toEqual({ season: 2026, series: 'Formula One', seriesId: 'f1', team: 'BWT Alpine Formula One Team', source: 'wikipedia' });
    expect(career).toContainEqual({
      season: 2024,
      series: 'FIA Formula 2 Championship',
      seriesId: 'f2',
      team: 'MP Motorsport',
      pos: 9,
      points: 96,
      races: 20,
      wins: 1,
      podiums: 3,
      poles: 0,
      source: 'wikipedia',
    });
    // 2019: dos filas con el equipo en rowspan.
    const y2019 = career.filter((r) => r.season === 2019);
    expect(y2019.map((r) => r.team)).toEqual(['Drivex School', 'Drivex School', expect.any(String)]);
    expect(titlesOf(career)).toEqual([{ season: 2019, series: 'F4 Spanish Championship' }]);
  });

  it('en MotoGP usa la tabla "By season" (año en plantilla, clase como categoría) y no "By class" ni premios', () => {
    const career = careerFromWikitext(wiki('marquez-en.wiki'));
    expect(career).toHaveLength(19);
    expect(career.at(-1)).toMatchObject({ season: 2008, series: '125cc', team: 'Repsol KTM 125cc', pos: 13, points: 63 });
    expect(career.find((r) => r.season === 2012)).toMatchObject({ series: 'Moto2', seriesId: 'moto2', pos: 1, champion: true });
    const titles = titlesOf(career);
    expect(titles.filter((t) => t.seriesId === 'motogp').map((t) => t.season)).toEqual([2026, 2025, 2019, 2018, 2017, 2016, 2014, 2013]);
  });

  it('en español: "Resumen de carrera" sin estadísticas, con "Campeón de…" y sin la tabla de karting', () => {
    const castellano = careerFromWikitext(wiki('castellano-es.wiki'));
    expect(castellano).toHaveLength(40);
    expect(castellano.find((r) => r.season === 2022 && r.seriesId === 'tn')).toEqual({
      season: 2022,
      series: 'Clase 3 del Turismo Nacional',
      seriesId: 'tn',
      pos: 1,
      champion: true,
      source: 'wikipedia',
    });
    const rossi = careerFromWikitext(wiki('rossi-es.wiki'));
    expect(rossi.some((r) => /Sudam|ICA/.test(r.series))).toBe(false);
    expect(rossi.at(-1)).toMatchObject({ season: 2000, series: 'Fórmula Renault Argentina', pos: 45, points: 2 });
    expect(rossi.find((r) => r.season === 2024 && r.seriesId === 'tc2000')).toMatchObject({ series: 'TC2000', pos: 2, points: 279 });
  });

  it('el Junior WRC no es el WRC aunque el enlace vaya a la temporada del mundial', () => {
    const career = careerFromWikitext(wiki('ogier-en.wiki'));
    const jwrc = career.find((r) => r.season === 2008 && r.series.startsWith('Junior'))!;
    expect(jwrc).toMatchObject({ series: 'Junior World Rally Championship', champion: true });
    expect(jwrc.seriesId).toBeUndefined();
    expect(titlesOf(career).filter((t) => t.seriesId === 'wrc')).toHaveLength(9);
  });

  it('traduce nombres de categorías a seriesId según la época', () => {
    expect(seriesIdFor('FIA Formula 2 Championship', '2024 FIA Formula 2 Championship', 2024)).toBe('f2');
    expect(seriesIdFor('Formula 2', undefined, 1978)).toBeUndefined();
    expect(seriesIdFor('TC 2000', undefined, 2008)).toBe('tc2000');
    expect(seriesIdFor('TC 2000', undefined, 2016)).toBeUndefined();
    expect(seriesIdFor('Súper TC2000', undefined, 2016)).toBe('tc2000');
    expect(seriesIdFor('Super GT - GT500', '2022 Super GT Series', 2022)).toBe('super-gt');
    expect(seriesIdFor('NASCAR Xfinity Series', undefined, 2025)).toBe('nascar-xfinity');
    expect(seriesIdFor('Blancpain GT Series Endurance Cup', undefined, 2016)).toBe('gtwc-europe');
    expect(seriesIdFor('24 Hours of Le Mans', undefined, 2024)).toBeUndefined();
    expect(seriesIdFor('Turismo Nacional - Clase 3', undefined, 2023)).toBe('tn');
  });
});

describe('identificación en Wikidata', () => {
  const cand = (qid: string, extra: Partial<Candidate> = {}): Candidate => ({
    qid,
    names: ['Carlos Sainz'],
    isos: ['ES'],
    enwiki: qid,
    ...extra,
  });
  const ev = (entries: Array<[string, Partial<CandidateEvidence>]>) =>
    new Map(entries.map(([q, e]) => [q, { careerSeries: [], mentions: false, ...e }]));

  it('entre padre e hijo elige al que tiene la categoría en su trayectoria', () => {
    const sr = cand('Q211204', { birthYear: 1962 });
    const jr = cand('Q544856', { birthYear: 1994 });
    const choice = chooseCandidate(
      { name: 'Carlos Sainz', iso: 'ES', seriesIds: ['f1'] },
      [sr, jr],
      ev([
        ['Q211204', { careerSeries: ['wrc', 'dakar'], mentions: true }],
        ['Q544856', { careerSeries: ['f1'], mentions: true }],
      ]),
      NOW,
    );
    expect(choice).toEqual({ qid: 'Q544856', reason: 'trayectoria con sus categorías', strong: true });
  });

  it('con evidencia débil exige que coincida el país publicado', () => {
    const berry = cand('Q21932103', { names: ['Josh Berry', 'Joshua William Berry'], isos: [] });
    const evidence = ev([['Q21932103', { careerSeries: ['nascar-cup'], mentions: true }]]);
    const homonym = chooseCandidate({ name: 'Josh Berry', iso: 'AU', seriesIds: ['24h-series'] }, [berry], evidence, NOW);
    expect(homonym.qid).toBeUndefined();
    const scott = cand('Q2691261', { names: ['Scott Martin'], isos: ['GB'] });
    const ok = chooseCandidate({ name: 'Scott Martin', iso: 'GB', seriesIds: ['wrc'] }, [scott], ev([['Q2691261', { mentions: true }]]), NOW);
    expect(ok.qid).toBe('Q2691261');
  });

  it('descarta nombres distintos, edades imposibles y candidatos sin artículo', () => {
    const driver = { name: 'Jorge Martin', seriesIds: ['motogp'] };
    expect(chooseCandidate(driver, [cand('Q722881', { names: ['Jorge Martínez', 'Aspar'] })], ev([]), NOW).reason).toMatch(/mismo nombre/);
    expect(chooseCandidate(driver, [cand('Q1', { names: ['Jorge Martín'], birthYear: 1890 })], ev([]), NOW).reason).toMatch(/edad/);
    const noArticle: Candidate = { qid: 'Q2', names: ['Jorge Martin'], isos: [] };
    expect(chooseCandidate(driver, [noArticle], ev([]), NOW).qid).toBeUndefined();
    const two = [cand('Q3', { names: ['Jorge Martin'] }), cand('Q4', { names: ['Jorge Martin'] })];
    expect(chooseCandidate(driver, two, ev([['Q3', { careerSeries: ['motogp'] }], ['Q4', { careerSeries: ['motogp'] }]]), NOW).reason).toMatch(/ambiguo/);
  });

  it('no busca nombres con iniciales o de una sola palabra', () => {
    expect(searchableName('A. Danielsson')).toBe(false);
    expect(searchableName('- Bankcy')).toBe(false);
    expect(searchableName('Juan B. de Benedictis')).toBe(false);
    expect(searchableName('Agustín Canapino')).toBe(true);
    expect(nameVariants('Lynn Alex')).toEqual(['Lynn Alex', 'Alex Lynn']);
    expect(nameVariants('Mortensen Martin Vedel')).toContain('Martin Vedel Mortensen');
    expect(countryIso('Great Britain')).toBe('GB');
    expect(countryIso('GB-ENG')).toBe('GB');
    expect(countryIso('IE')).toBe('IE');
  });
});

describe('datos de Wikidata y resumen', () => {
  const uri = (q: string) => ({ value: `http://www.wikidata.org/entity/${q}` });
  it('lee fecha (solo con día), lugar, nacionalidad, foto y redes', () => {
    const d = readDetails('Q88463514', [
      {
        item: uri('Q88463514'),
        birth: { value: '2003-05-27T00:00:00Z' },
        prec: { value: '11' },
        placeLabel: { value: 'Pilar' },
        pcLabel: { value: 'Argentina' },
        pcIso: { value: 'AR' },
        citLabel: { value: 'Italia' },
        citIso: { value: 'IT' },
        image: { value: 'http://commons.wikimedia.org/wiki/Special:FilePath/Franco%20Colapinto%202024.jpg' },
        instagram: { value: 'francolapinto' },
        x: { value: 'FranColapinto' },
      },
      { item: uri('Q88463514'), citLabel: { value: 'Argentina' }, citIso: { value: 'AR' }, image: { value: 'http://commons.wikimedia.org/wiki/Special:FilePath/Colapinto%202025%20Monaco.jpg' } },
    ]);
    expect(d).toMatchObject({ birthDate: '2003-05-27', birthPlace: 'Pilar, Argentina', birthIso: 'AR' });
    expect(nationalityOf(d, undefined)).toBe('Argentina');
    expect(nationalityOf(d, 'IT')).toBe('Italia');
    expect(pickImage(d.images)).toBe('Colapinto 2025 Monaco.jpg');
    expect(d.links).toEqual([
      { label: 'Instagram', url: 'https://www.instagram.com/francolapinto/' },
      { label: 'X', url: 'https://x.com/FranColapinto' },
    ]);
    const yearOnly = readDetails('Q1', [{ item: uri('Q1'), birth: { value: '1965-01-01T00:00:00Z' }, prec: { value: '9' } }]);
    expect(yearOnly.birthDate).toBeUndefined();
  });

  it('el resumen saca la pronunciación y se queda con uno o dos párrafos', () => {
    const s = summaryOf({
      lang: 'en',
      title: 'Franco Colapinto',
      wikitext: '',
      extract:
        'Franco Alejandro Colapinto (Spanish pronunciation: [ˈfɾaŋko kolaˈpinto]; born 27 May 2003) is an Argentine racing driver who competes in Formula One for Alpine.\nColapinto won the F4 Spanish Championship in 2019 with Drivex.',
    });
    expect(s).toEqual({
      text: 'Franco Alejandro Colapinto (born 27 May 2003) is an Argentine racing driver who competes in Formula One for Alpine.\n\nColapinto won the F4 Spanish Championship in 2019 with Drivex.',
      lang: 'en',
      url: 'https://en.wikipedia.org/wiki/Franco_Colapinto',
    });
  });
});

describe('fotos oficiales', () => {
  it('Fórmula 1: foto de la tarjeta de cada piloto en formula1.com', () => {
    const photos = parseF1Drivers(fixture('bios/f1-drivers.html'));
    expect(photos.size).toBe(2);
    expect(photos.get('colapinto-franco')).toEqual({
      url: expect.stringMatching(/^https:\/\/media\.formula1\.com\/image\/upload\/.+\/common\/f1\/2026\/alpine\/fracol01\/2026alpinefracol01right\.webp$/),
      credit: 'Formula1.com',
      license: '© Formula One World Championship Limited',
      page: 'https://www.formula1.com/en/drivers/franco-colapinto',
    });
  });

  it('MotoGP: foto de perfil de la API de pilotos', () => {
    const photos = parseMotoGpRiders(JSON.parse(fixture('bios/motogp-riders.json')));
    expect(photos.get('marc-marquez')).toEqual({
      url: expect.stringMatching(/^https:\/\/photos\.motogp\.com\/riders\/.+\/profile\/main-\d+\.png$/),
      credit: 'MotoGP.com',
      license: '© Dorna Sports, S.L.',
      page: 'https://www.motogp.com/en/riders/profile/marc-marquez',
    });
    expect(photos.size).toBe(4);
  });

  it('NASCAR: foto del feed de pilotos, sin la genérica', () => {
    const photos = parseNascarDrivers(JSON.parse(fixture('bios/nascar-drivers.json')));
    expect(photos.has('abbey-jeffrey')).toBe(false);
    expect(photos.get('kyle-larson')).toEqual({
      url: 'https://www.nascar.com/wp-content/uploads/sites/7/2026/01/26/Kyle-Larson-Helmet_resized.png',
      credit: 'NASCAR.com',
      license: '© NASCAR Digital Media, LLC',
      page: 'https://www.nascar.com/drivers/kyle-larson',
    });
    expect(photos.get('alan-lawless')?.page).toBe('https://www.nascar.com/drivers/');
  });
});

describe('temporada en curso con los datos de la app', () => {
  const driver: Driver = {
    id: 'agustin-canapino',
    name: 'Agustín Canapino',
    entries: [
      { seriesId: 'tc', pos: 1, points: 347 },
      { seriesId: 'tn', table: 'Clase 3', pos: 1, points: 320, team: 'Salvita Racing' },
    ],
    lineups: [{ seriesId: 'tc', team: 'Canning Motorsports' }],
  };
  const app = {
    seasons: new Map([
      ['tc', 2026],
      ['tn', 2026],
    ]),
    names: new Map([
      ['tc', 'Turismo Carretera'],
      ['tn', 'Turismo Nacional (Clase 2 y 3)'],
    ]),
    details: new Map([
      ['agustin-canapino', { ...driver, recent: [], stats: [{ seriesId: 'tc', races: 14, wins: 3, podiums: 7, top5: 9, top10: 12, dnfs: 1, poles: 2 }] }],
    ]),
  };

  it('arma una fila por campeonato con las estadísticas de la temporada', () => {
    expect(appCareer(driver, app)).toEqual([
      { season: 2026, series: 'Turismo Carretera', seriesId: 'tc', source: 'app', pos: 1, points: 347, races: 14, wins: 3, podiums: 7, poles: 2 },
      { season: 2026, series: 'Turismo Nacional (Clase 3)', seriesId: 'tn', source: 'app', team: 'Salvita Racing', pos: 1, points: 320 },
    ]);
  });

  it('solo completa lo que Wikipedia no tiene (o tiene sin puesto ni puntos)', () => {
    const bio: DriverBio = {
      id: 'agustin-canapino',
      updatedAt: NOW_ISO,
      career: [
        { season: 2026, series: 'Turismo Carretera', seriesId: 'tc', team: 'Canning Motorsports', source: 'wikipedia' },
        { season: 2026, series: 'Turismo Nacional - Class 3', seriesId: 'tn', pos: 3, points: 100, source: 'wikipedia' },
        { season: 2025, series: 'Turismo Carretera', seriesId: 'tc', pos: 1, champion: true, source: 'wikipedia' },
        { season: 2026, series: 'Viejo', seriesId: 'tc', source: 'app' },
      ],
    };
    const next = withAppSeason(bio, appCareer(driver, app));
    expect(next.career).toEqual([
      { season: 2026, series: 'Turismo Nacional - Class 3', seriesId: 'tn', pos: 3, points: 100, source: 'wikipedia' },
      { season: 2026, series: 'Turismo Carretera', seriesId: 'tc', source: 'app', pos: 1, points: 347, races: 14, wins: 3, podiums: 7, poles: 2, team: 'Canning Motorsports' },
      { season: 2025, series: 'Turismo Carretera', seriesId: 'tc', pos: 1, champion: true, source: 'wikipedia' },
    ]);
  });
});

// ── De punta a punta ──

type Route = [pattern: string | RegExp, body: unknown];

function routeHttp(routes: Route[]): Http & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    json: (async (url: string) => {
      const decoded = decodeURIComponent(url);
      calls.push(decoded);
      const route = routes.find(([p]) => (typeof p === 'string' ? decoded.includes(p) : p.test(decoded)));
      if (!route) throw new HttpError(url, 404, `HTTP 404 en ${url}`);
      return { url, status: 200, contentType: 'application/json', body: route[1] };
    }) as Http['json'],
    text: async () => {
      throw new Error('solo JSON');
    },
    bytes: async () => {
      throw new Error('solo JSON');
    },
  };
}

const sparql = (bindings: Array<Record<string, string>>) => ({
  results: { bindings: bindings.map((b) => Object.fromEntries(Object.entries(b).map(([k, value]) => [k, { value }]))) },
});
const WD = 'http://www.wikidata.org/entity/';

const ROUTES: Route[] = [
  [
    'EntitySearch',
    sparql([
      { name: 'Franco Colapinto', item: `${WD}Q88463514` },
      { name: 'Josh Berry', item: `${WD}Q21932103` },
    ]),
  ],
  [
    'GROUP_CONCAT(DISTINCT ?iso)',
    sparql([
      {
        item: `${WD}Q88463514`,
        born: '2003-05-27T00:00:00Z',
        isos: 'AR IT',
        labels: 'Franco Colapinto|Franco Alejandro Colapinto',
        enwiki: 'https://en.wikipedia.org/wiki/Franco_Colapinto',
      },
      { item: `${WD}Q21932103`, born: '1990-10-22T00:00:00Z', isos: '', labels: 'Josh Berry|Joshua William Berry', enwiki: 'https://en.wikipedia.org/wiki/Josh_Berry' },
    ]),
  ],
  [
    'wikibase:BestRank',
    sparql([
      {
        item: `${WD}Q88463514`,
        birth: '2003-05-27T00:00:00Z',
        prec: '11',
        placeLabel: 'Pilar',
        pcLabel: 'Argentina',
        pcIso: 'AR',
        citLabel: 'Argentina',
        citIso: 'AR',
        image: 'http://commons.wikimedia.org/wiki/Special:FilePath/Franco%20Colapinto%202024.jpg',
      },
    ]),
  ],
  [
    'en.wikipedia.org/w/api.php',
    {
      batchcomplete: true,
      query: {
        pages: [
          {
            title: 'Franco Colapinto',
            extract: 'Franco Alejandro Colapinto (born 27 May 2003) is an Argentine racing driver who competes in Formula One for Alpine.',
            revisions: [{ slots: { main: { content: fixture('bios/colapinto-en.wiki') } } }],
          },
          {
            title: 'Josh Berry',
            extract: 'Joshua William Berry (born October 22, 1990) is an American professional stock car racing driver.',
            revisions: [{ slots: { main: { content: '==Career==\nBerry competes in the NASCAR Cup Series for the Wood Brothers.' } } }],
          },
        ],
      },
    },
  ],
  [
    'commons.wikimedia.org/w/api.php',
    {
      query: {
        pages: [
          {
            title: 'File:Franco Colapinto 2024.jpg',
            imageinfo: [
              {
                thumburl: 'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Franco_Colapinto_2024.jpg/480px-Franco_Colapinto_2024.jpg',
                thumbwidth: 480,
                thumbheight: 640,
                descriptionurl: 'https://commons.wikimedia.org/wiki/File:Franco_Colapinto_2024.jpg',
                extmetadata: { Artist: { value: '<a href="//commons.wikimedia.org/wiki/User:Yu_Chu_Chin">Yu Chu Chin</a>' }, LicenseShortName: { value: 'CC BY-SA 4.0' } },
              },
            ],
          },
        ],
      },
    },
  ],
];

const SERIES = [
  { id: 'f1', name: 'Fórmula 1' },
  { id: '24h-series', name: '24H Series (Creventic)' },
  { id: 'nascar-cup', name: 'NASCAR Cup Series' },
] as Series[];

async function setup(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bios-'));
  const drivers: Driver[] = [
    { id: 'colapinto-franco', name: 'Franco Colapinto', country: 'Argentina', entries: [{ seriesId: 'f1', pos: 12, points: 27, team: 'Alpine' }] },
    { id: 'berry-josh', name: 'Josh Berry', entries: [{ seriesId: 'nascar-cup', pos: 22, points: 651 }] },
    { id: 'berry-josh-24h', name: 'Josh Berry', country: 'Australia', entries: [], lineups: [{ seriesId: '24h-series', team: 'EBM' }] },
    { id: 'a-danielsson', name: 'A. Danielsson', entries: [{ seriesId: 'f1-academy', pos: 21, points: 0 }] },
  ];
  await mkdir(path.join(dir, 'standings'), { recursive: true });
  await writeFile(path.join(dir, 'drivers-index.json'), JSON.stringify({ version: 1, generatedAt: NOW_ISO, drivers }));
  await writeFile(path.join(dir, 'standings', 'f1.json'), JSON.stringify({ seriesId: 'f1', season: 2026, tables: [] }));
  await writeFile(path.join(dir, 'standings', 'nascar-cup.json'), JSON.stringify({ seriesId: 'nascar-cup', season: 2026, tables: [] }));
  return dir;
}

async function readBio(dir: string, id: string): Promise<DriverBio | undefined> {
  const raw = await readFile(path.join(dir, 'bios', 'drivers', `${driverShard(id)}.json`), 'utf8').catch(() => null);
  return raw ? driverBiosShardFileSchema.parse(JSON.parse(raw)).bios.find((b) => b.id === id) : undefined;
}

describe('runDriverBios', () => {
  it('identifica, arma las fichas, suma la foto oficial y anota los descartes', async () => {
    const dir = await setup();
    const http = routeHttp(ROUTES);
    const api = createApi({ http, pauseMs: 0, sleep: async () => {} });
    const official = fakeHttp({ 'https://cf.nascar.com/cacher/drivers.json': fixture('bios/nascar-drivers.json') });
    const r = await runDriverBios({ log, dataDir: dir, now: NOW, api, http: official, series: SERIES });
    expect(r).toMatchObject({ processed: 3, identified: 2, rejected: 1, pending: 0 });

    const colapinto = await readBio(dir, 'colapinto-franco');
    expect(colapinto).toMatchObject({
      id: 'colapinto-franco',
      wikidata: 'Q88463514',
      birthDate: '2003-05-27',
      birthPlace: 'Pilar, Argentina',
      nationality: 'Argentina',
      summary: { lang: 'en', url: 'https://en.wikipedia.org/wiki/Franco_Colapinto' },
      photo: { credit: 'Yu Chu Chin', license: 'CC BY-SA 4.0', width: 480 },
      titles: [{ season: 2019, series: 'F4 Spanish Championship' }],
      updatedAt: NOW_ISO,
    });
    // 2026: la fila de Wikipedia sin puesto se completa con la de la app.
    expect(colapinto!.career![0]).toMatchObject({ season: 2026, seriesId: 'f1', source: 'app', pos: 12, points: 27, team: 'Alpine' });

    // Josh Berry de NASCAR: ficha por la mención de su categoría, con la foto libre ausente → foto oficial.
    const berry = await readBio(dir, 'berry-josh');
    expect(berry).toMatchObject({ wikidata: 'Q21932103', photo: { credit: 'NASCAR.com', page: 'https://www.nascar.com/drivers/josh-berry/' } });
    // El homónimo australiano de la 24H Series no se queda con esa ficha.
    expect(await readBio(dir, 'berry-josh-24h')).toBeUndefined();

    const cache = JSON.parse(await readFile(path.join(dir, '_cache', 'bios-drivers.json'), 'utf8'));
    expect(cache['berry-josh-24h']).toMatchObject({ name: 'Josh Berry', checkedAt: NOW_ISO });
    expect(cache['berry-josh-24h'].wikidata).toBeUndefined();
    expect(cache['a-danielsson']).toBeUndefined();
    // Una sola consulta de cada tipo para el lote.
    expect(http.calls.filter((u) => u.includes('EntitySearch'))).toHaveLength(1);

    // La corrida siguiente no consulta nada (todo al día) pero mantiene las fichas.
    const again = createApi({ http: routeHttp([]), pauseMs: 0, sleep: async () => {} });
    const r2 = await runDriverBios({ log, dataDir: dir, now: new Date('2026-11-20T09:00:00Z'), api: again, http: fakeHttp({}), series: SERIES });
    expect(r2).toMatchObject({ processed: 0, written: 0 });
    expect(again.requests).toBe(0);
  });

  it('elige primero los campeonatos principales y respeta los plazos de renovación', () => {
    const drivers: Driver[] = [
      { id: 'x-gt', name: 'Uno Gt', entries: [{ seriesId: 'gtwc-europe', pos: 1, points: 1 }] },
      { id: 'x-lineup', name: 'Dos Inscripto', entries: [], lineups: [{ seriesId: 'f1' }] },
      { id: 'x-tc', name: 'Tres Tc', entries: [{ seriesId: 'tc', pos: 1, points: 1 }] },
      { id: 'x-f1', name: 'Cuatro Funo', entries: [{ seriesId: 'f1', pos: 1, points: 1 }] },
    ];
    const bios = new Map<string, DriverBio>([['x-tc', { id: 'x-tc', updatedAt: '2026-11-01T00:00:00Z' }]]);
    const cache = { 'x-gt': { name: 'Uno Gt', checkedAt: '2026-10-01T00:00:00Z', reason: 'sin candidatos' } };
    expect(selectDue(drivers, bios, cache, NOW).map((d) => d.id)).toEqual(['x-f1', 'x-lineup']);
    const later = new Date('2026-12-30T00:00:00Z');
    expect(selectDue(drivers, bios, cache, later).map((d) => d.id)).toEqual(['x-f1', 'x-tc', 'x-gt', 'x-lineup']);
  });
});
