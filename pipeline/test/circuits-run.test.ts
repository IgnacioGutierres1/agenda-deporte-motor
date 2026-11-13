/**
 * Fichas de circuitos de punta a punta, con respuestas reales (recortadas) de Wikidata, Wikipedia, Commons y
 * Open-Meteo: armado de la ficha de un lote y la fase runCircuits (qué se consulta, qué se conserva, cortes).
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { circuitsFileSchema, type CircuitInfo, type CircuitsFile } from '@dm/shared';
import { createApi } from '../src/circuits/api.ts';
import { groupCircuits, mergeInfo, overrideChanged, runCircuits } from '../src/circuits/index.ts';
import { loadCircuitOverrides } from '../src/circuits/overrides.ts';
import { imageCandidates, resolveCircuits, searchKey, type ResolveInput } from '../src/circuits/resolve.ts';
import type { WdEntity } from '../src/circuits/wikidata.ts';
import { HttpError, type Http } from '../src/core/http.ts';
import { createLogger } from '../src/core/log.ts';
import { fixture } from './fake-http.ts';

const json = <T = any>(name: string): T => JSON.parse(fixture(`circuits/${name}`)) as T;
const log = createLogger('test', true);
const noSleep = async () => {};
const NOW = new Date('2026-11-12T21:00:00Z');
const NOW_ISO = '2026-11-12T21:00:00Z';

type Route = [pattern: string | RegExp, body: unknown];

/** Respuestas reales por tipo de consulta; lo que no está previsto responde vacío (búsquedas) o 404. */
const ROUTES: Route[] = [
  ['srsearch=monza haswbstatement', json('wd-search-monza.json')],
  ['srsearch=olavarria haswbstatement', json('wd-search-olavarria.json')],
  ['srsearch=junin haswbstatement', json('wd-search-junin.json')],
  ['nearcoord:25km,-34.5939,-60.9464', json('wd-near-junin.json')],
  ['list=search', { batchcomplete: '', query: { searchinfo: { totalhits: 0 }, search: [] } }],
  ['props=labels|aliases|descriptions|claims|sitelinks', json('wd-entities.json')],
  ['props=labels|aliases&languages=es|en', json('wd-places.json')],
  ['es.wikipedia.org/w/api.php', json('eswiki-pages.json')],
  ['en.wikipedia.org/w/api.php', json('enwiki-pages.json')],
  ['commons.wikimedia.org/w/api.php', json('commons-images.json')],
  ['v1/search?name=Junín&', json('geocoding-junin.json')],
  ['v1/search?name=Olavarría&', json('geocoding-olavarria.json')],
  ['v1/search?name=Jyväskylä&', json('geocoding-jyvaskyla.json')],
  ['geocoding-api.open-meteo.com', { generationtime_ms: 0.1 }],
];

function routeHttp(routes: Route[] = ROUTES): Http & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    json: (async (url: string) => {
      const decoded = decodeURIComponent(url);
      calls.push(decoded);
      const route = routes.find(([p]) => (typeof p === 'string' ? decoded.includes(p) : p.test(decoded)));
      if (!route) throw new HttpError(url, 404, `HTTP 404 en ${url}`);
      if (route[1] instanceof Error) throw route[1];
      return { url, status: 200, contentType: 'application/json', body: route[1] };
    }) as Http['json'],
    text: async () => {
      throw new Error('las fichas de circuitos solo piden JSON');
    },
    bytes: async () => {
      throw new Error('las fichas de circuitos solo piden JSON');
    },
  };
}

const EVENTS = [
  { circuit: 'Autodromo Nazionale Monza', country: 'Italia', seriesId: 'f1' },
  { circuit: 'Monza', country: 'Italia', seriesId: 'gtwce' },
  { circuit: 'Olavarría', country: 'Argentina', seriesId: 'tc2000' },
  { circuit: 'Junín', country: 'Argentina', seriesId: 'tc2000' },
  { circuit: 'Jyväskylä', country: 'Finlandia', seriesId: 'wrc' },
  { circuit: 'Kartódromo Inexistente', country: 'Argentina', seriesId: 'karting' },
  { circuit: 'A confirmar', country: 'Argentina', seriesId: 'tc2000' },
];
const SERIES = [
  { id: 'f1', group: 'f1-fia' as const },
  { id: 'tc2000', group: 'argentina' as const },
  { id: 'wrc', group: 'rally' as const },
];
const GROUPS = groupCircuits(EVENTS);
const input = (id: string, extra: Partial<ResolveInput> = {}): ResolveInput => ({ group: GROUPS.find((g) => g.id === id)!, ...extra });

async function resolve(inputs: ResolveInput[], http = routeHttp()) {
  const api = createApi({ http, pauseMs: 0, sleep: noSleep });
  const resolved = await resolveCircuits(api, inputs, { nowIso: NOW_ISO, log });
  return { http, byId: new Map(resolved.map((r) => [r.info.id, r])) };
}

describe('resolveCircuits: ficha de un lote de circuitos', () => {
  it('arma la ficha completa de Monza con Wikidata, Wikipedia y Commons', async () => {
    const { byId } = await resolve([input('monza')]);
    const { info, report } = byId.get('monza')!;
    expect(report).toMatchObject({ how: 'nombre exacto', wikidata: 'Q171417', label: 'Autodromo Nazionale di Monza', entityCountry: 'Italia' });
    expect(info).toMatchObject({
      id: 'monza',
      name: 'Autodromo Nazionale di Monza',
      wikidata: 'Q171417',
      lat: 45.62056,
      lon: 9.28944,
      city: 'Monza',
      lengthM: 5793,
      turns: 11,
      opened: 1922,
      capacity: 118865,
      summaryLang: 'es',
      website: 'https://www.monzanet.it',
      wikipediaUrl: 'https://es.wikipedia.org/wiki/Autodromo_Nazionale_di_Monza',
      checkedAt: NOW_ISO,
    });
    expect(info.coordsApprox).toBeUndefined();
    expect(info.summary).toMatch(/^El Autodromo Nazionale di Monza es un autódromo/);
    // El récord sale de la ficha en inglés (trazado principal).
    expect(info.lapRecord).toEqual({ time: '1:20.901', driver: 'Lando Norris', vehicle: 'McLaren MCL39', year: 2025, series: 'F1' });
    expect(info.map).toEqual({
      url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f8/Monza_track_map.svg/960px-Monza_track_map.svg.png',
      width: 960,
      height: 490,
      credit: 'Will Pittenger',
      license: 'CC BY-SA 3.0',
      page: 'https://commons.wikimedia.org/wiki/File:Monza_track_map.svg',
    });
    expect(info.photo?.page).toBe(
      'https://commons.wikimedia.org/wiki/File:1975_Italian_GP_race_start_-_Niki_Lauda_%26_Clay_Regazzoni_(Ferrari_312T).jpg',
    );
    expect(info.photo?.credit).toBeTruthy();
    expect(info.photo?.license).toBeTruthy();
    // El orden de los campos es siempre el mismo y el resultado cumple el contrato.
    expect(Object.keys(info).slice(0, 3)).toEqual(['id', 'name', 'wikidata']);
    expect(Object.keys(info).at(-1)).toBe('checkedAt');
    circuitsFileSchema.parse({ version: 1, generatedAt: NOW_ISO, circuits: [info] });
  });

  it('un lote entero cuesta una búsqueda por circuito y una request por fuente para todos juntos', async () => {
    const { http, byId } = await resolve([input('monza'), input('olavarria'), input('junin'), input('jyvaskyla', { cityOnly: true }), input('kartodromo-inexistente')]);
    const count = (part: string) => http.calls.filter((u) => u.includes(part)).length;
    // Búsquedas por clave: una por circuito que se busca (la ciudad base de un rally no se busca).
    expect(http.calls.filter((u) => u.includes('list=search') && !u.includes('nearcoord'))).toHaveLength(4);
    expect(count('srsearch=jyvaskyla')).toBe(0);
    expect(count('es.wikipedia.org')).toBe(1);
    expect(count('en.wikipedia.org')).toBe(1);
    expect(count('commons.wikimedia.org')).toBe(1);

    // "Olavarría" es el nombre de la ciudad: el autódromo aparece porque uno de sus nombres la menciona.
    const olavarria = byId.get('olavarria')!;
    expect(olavarria.report).toMatchObject({ how: 'nombre', wikidata: 'Q15194186', entityCountry: 'Argentina' });
    expect(olavarria.info).toMatchObject({ name: 'Autódromo Hermanos Emiliozzi', city: 'Olavarría', summaryLang: 'es' });
    expect(olavarria.info.map?.page).toBe('https://commons.wikimedia.org/wiki/File:Aut%C3%B3dromo_Hermanos_Emiliozzi.svg');
    expect(olavarria.info.photo).toBeUndefined();
    expect(olavarria.info.coordsApprox).toBeUndefined();

    // "Junín": la búsqueda por nombre no trae nada; se ubica la ciudad y se busca el circuito cercano.
    const junin = byId.get('junin')!;
    expect(count('nearcoord:25km,-34.5939,-60.9464')).toBe(1);
    expect(junin.report).toMatchObject({ how: 'lugar', wikidata: 'Q5712988', label: 'Autódromo Eusebio Marcilla' });
    expect(junin.info).toMatchObject({ name: 'Autódromo Eusebio Marcilla', lat: -34.64987, lon: -61.01736, city: 'Junín' });
    expect(junin.info.coordsApprox).toBeUndefined();
    expect(junin.info.photo?.page).toContain('Eusebio_Marcilla.jpg');
    expect(junin.info.map?.page).toContain('Eusebio_Marcilla,_Junin.svg');

    // Ciudad base de un rally: sin ficha de Wikidata, con las coordenadas aproximadas de la ciudad.
    const rally = byId.get('jyvaskyla')!;
    expect(rally.report.how).toBe('sin buscar');
    expect(rally.info).toEqual({ id: 'jyvaskyla', name: 'Jyväskylä', lat: 62.2415, lon: 25.7209, coordsApprox: true, city: 'Jyväskylä', checkedAt: NOW_ISO });

    // Sin circuito ni ciudad: queda el nombre, para no volver a consultarlo en cada corrida.
    expect(byId.get('kartodromo-inexistente')!.info).toEqual({ id: 'kartodromo-inexistente', name: 'Kartódromo Inexistente', checkedAt: NOW_ISO });
  });

  it('correcciones manuales: elemento indicado, "no buscar", coordenadas, nombre y ciudad', async () => {
    const { http, byId } = await resolve([
      // El elemento indicado a mano vale aunque el nombre no coincida (y no se busca).
      input('kartodromo-inexistente', { override: { wikidata: 'Q5712988', name: 'Autódromo de Junín' } }),
      input('olavarria', { override: { wikidata: null, city: 'Olavarría, Buenos Aires' } }),
      input('monza', { override: { lat: 45.6, lon: 9.3, city: 'Monza (Lombardía)' } }),
      input('junin', { override: { wikidata: 'Q999999' } }),
    ]);
    expect(http.calls.filter((u) => u.includes('list=search'))).toHaveLength(1);
    const manual = byId.get('kartodromo-inexistente')!;
    expect(manual.report).toMatchObject({ how: 'manual', wikidata: 'Q5712988' });
    expect(manual.info).toMatchObject({ name: 'Autódromo de Junín', wikidata: 'Q5712988', lat: -34.64987 });

    const none = byId.get('olavarria')!;
    expect(none.report.how).toBe('sin buscar');
    expect(none.info).toEqual({ id: 'olavarria', name: 'Olavarría', lat: -36.8938, lon: -60.3232, coordsApprox: true, city: 'Olavarría', checkedAt: NOW_ISO });

    expect(byId.get('monza')!.info).toMatchObject({ wikidata: 'Q171417', lat: 45.6, lon: 9.3, city: 'Monza (Lombardía)' });
    expect(byId.get('monza')!.info.coordsApprox).toBeUndefined();

    // Un elemento que Wikidata no devuelve: se avisa y queda sin ficha (con la ciudad, si se encuentra).
    const missing = byId.get('junin')!;
    expect(missing.report.note).toMatch(/Q999999/);
    expect(missing.info.wikidata).toBeUndefined();
    expect(missing.info.coordsApprox).toBe(true);
  });

  it('un circuito ya identificado se relee por su id, sin buscar', async () => {
    const { http, byId } = await resolve([input('junin', { knownWikidata: 'Q5712988' })]);
    expect(http.calls.some((u) => u.includes('list=search'))).toBe(false);
    expect(http.calls.some((u) => u.includes('open-meteo'))).toBe(false);
    expect(byId.get('junin')!.report.how).toBe('anterior');
    expect(byId.get('junin')!.info.wikidata).toBe('Q5712988');
  });

  it('si una fuente falla, falla el lote (no se arma una ficha a medias)', async () => {
    const broken: Route[] = [['es.wikipedia.org/w/api.php', new HttpError('x', 500, 'HTTP 500')], ...ROUTES];
    await expect(resolve([input('monza')], routeHttp(broken))).rejects.toThrow(/500/);
  });

  it('searchKey saca el año del nombre de la carrera; imageCandidates ordena plano y foto', () => {
    expect(searchKey('barcelona 2027')).toBe('barcelona');
    expect(searchKey('le castellet 2027')).toBe('paul ricard');
    expect(searchKey('monza')).toBe('monza');
    expect(searchKey('2027')).toBe('2027');

    const entity = { image: 'Vista aérea.jpg', routeMap: 'Plano oficial.png' } as WdEntity;
    const article = {
      enBox: { images: ['Track map.svg', 'Logo del circuito.png', 'Grandstand.jpg'] },
      es: { title: 'X', image: 'Otro_trazado.svg' },
    };
    expect(imageCandidates(entity, article)).toEqual({
      maps: ['Plano oficial.png', 'Track map.svg', 'Otro_trazado.svg'],
      photos: ['Vista aérea.jpg', 'Grandstand.jpg'],
    });
    // Si la imagen de Wikidata (P18) es el plano, va como plano y no como foto.
    expect(imageCandidates({ image: 'Circuit layout.svg' } as WdEntity, {})).toEqual({ maps: ['Circuit layout.svg'], photos: [] });
    // Un PNG en la ficha del artículo es el plano (Yas Marina, Kyalami) y no se repite como foto.
    expect(
      imageCandidates({ image: 'Yas Marina aerial.jpg' } as WdEntity, {
        enBox: { images: ['Yas Marina Circuit.png', 'Yas Marina Circuit logo.png'] },
        en: { title: 'Yas Marina Circuit', image: 'Yas_Marina_Circuit.png' },
      }),
    ).toEqual({ maps: ['Yas Marina Circuit.png'], photos: ['Yas Marina aerial.jpg'] });
  });
});

describe('runCircuits: data/circuits.json', () => {
  async function workspace(previous?: CircuitsFile, overrides?: unknown) {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'circuits-'));
    const dataDir = path.join(dir, 'data');
    const configDir = path.join(dir, 'config');
    await mkdir(dataDir);
    await mkdir(configDir);
    const file = path.join(dataDir, 'circuits.json');
    if (previous) await writeFile(file, JSON.stringify(previous, null, 2) + '\n');
    if (overrides !== undefined) await writeFile(path.join(configDir, 'circuits.json'), typeof overrides === 'string' ? overrides : JSON.stringify(overrides));
    const read = async () => circuitsFileSchema.parse(JSON.parse(await readFile(file, 'utf8'))) as CircuitsFile;
    const raw = () => readFile(file, 'utf8').catch(() => null);
    return { dataDir, configDir, file, read, raw };
  }
  const run = (ws: { dataDir: string; configDir: string }, http: Http, extra: Partial<Parameters<typeof runCircuits>[0]> = {}) =>
    runCircuits({ events: EVENTS, series: SERIES, log, http, now: NOW, pauseMs: 0, sleep: noSleep, ...ws, ...extra });
  const info = (id: string, extra: Partial<CircuitInfo> = {}): CircuitInfo => ({ id, name: id, checkedAt: '2026-11-01T00:00:00Z', ...extra });

  it('primera corrida: escribe una ficha por circuito del calendario, ordenadas por id', async () => {
    const ws = await workspace();
    const http = routeHttp();
    const res = await run(ws, http);
    expect(res).toMatchObject({ pending: 0, error: undefined });
    expect(res!.reports).toHaveLength(5);
    const file = await ws.read();
    expect(file.generatedAt).toBe(NOW_ISO);
    expect(file.circuits.map((c) => c.id)).toEqual(['junin', 'jyvaskyla', 'kartodromo-inexistente', 'monza', 'olavarria']);
    expect(file.circuits.filter((c) => c.wikidata).map((c) => c.wikidata)).toEqual(['Q5712988', 'Q171417', 'Q15194186']);
    // El rally (wrc) no dispara una búsqueda de autódromo.
    expect(http.calls.some((u) => u.includes('srsearch=jyvaskyla'))).toBe(false);
    expect(await ws.raw()).toMatch(/\n$/);

    // Segunda corrida el mismo día: nada vencido, ninguna request, el archivo no se toca.
    const before = await ws.raw();
    const again = routeHttp();
    const res2 = await run(ws, again, { now: new Date('2026-11-13T09:00:00Z') });
    expect(again.calls).toHaveLength(0);
    expect(res2!.reports).toHaveLength(0);
    expect(await ws.raw()).toBe(before);
  });

  it('tope por corrida: primero los circuitos sin ficha; el resto queda pendiente', async () => {
    const previous: CircuitsFile = { version: 1, generatedAt: '2026-10-01T00:00:00Z', circuits: [info('monza', { wikidata: 'Q171417', checkedAt: '2026-10-01T00:00:00Z' })] };
    const ws = await workspace(previous);
    const res = await run(ws, routeHttp(), { limit: 2 });
    expect(res!.reports.map((r) => r.id).sort()).toEqual(['junin', 'jyvaskyla']);
    expect(res!.pending).toBe(3);
    const file = await ws.read();
    expect(file.circuits.map((c) => c.id)).toEqual(['junin', 'jyvaskyla', 'monza']);
    expect(file.circuits.find((c) => c.id === 'monza')!.checkedAt).toBe('2026-10-01T00:00:00Z');
  });

  it('refresca las fichas de más de 30 días por su id de Wikidata y conserva hasTrack y lo que ya no viene', async () => {
    const old = '2026-10-01T00:00:00Z';
    const previous: CircuitsFile = {
      version: 1,
      generatedAt: old,
      circuits: [
        info('junin', { wikidata: 'Q5712988', hasTrack: true, elevationM: 81, direction: 'Horario', checkedAt: old }),
        info('jyvaskyla', { lat: 62.2415, lon: 25.7209, coordsApprox: true, checkedAt: '2026-11-10T00:00:00Z' }),
        info('kartodromo-inexistente', { checkedAt: '2026-11-10T00:00:00Z' }),
        info('monza', { wikidata: 'Q171417', checkedAt: '2026-11-10T00:00:00Z' }),
        info('olavarria', { wikidata: 'Q15194186', checkedAt: '2026-11-10T00:00:00Z' }),
        info('circuito-viejo', { checkedAt: '2026-01-01T00:00:00Z' }),
        info('circuito-reciente', { hasTrack: true, checkedAt: '2026-09-01T00:00:00Z' }),
      ],
    };
    const ws = await workspace(previous);
    const http = routeHttp();
    const res = await run(ws, http);
    expect(res!.reports.map((r) => `${r.id}:${r.how}`)).toEqual(['junin:anterior']);
    expect(http.calls.some((u) => u.includes('list=search'))).toBe(false);
    const file = await ws.read();
    const junin = file.circuits.find((c) => c.id === 'junin')!;
    expect(junin).toMatchObject({ name: 'Autódromo Eusebio Marcilla', hasTrack: true, elevationM: 81, direction: 'Horario', lat: -34.64987, checkedAt: NOW_ISO });
    // Los que no vencieron quedan como estaban; una ficha fuera del calendario se conserva unos meses.
    expect(file.circuits.find((c) => c.id === 'monza')).toEqual(previous.circuits[3]);
    expect(file.circuits.some((c) => c.id === 'circuito-reciente')).toBe(true);
    expect(file.circuits.some((c) => c.id === 'circuito-viejo')).toBe(false);
  });

  it('toma hasTrack del archivo en disco al guardar (lo escribe otra fase mientras tanto)', async () => {
    const ws = await workspace();
    const http = routeHttp();
    const json = http.json;
    // Mientras se consulta, otra fase marca el trazado de Monza en el archivo.
    http.json = (async (url: string) => {
      if (decodeURIComponent(url).includes('commons.wikimedia.org')) {
        const onDisk: CircuitsFile = { version: 1, generatedAt: NOW_ISO, circuits: [info('monza', { hasTrack: true })] };
        await writeFile(ws.file, JSON.stringify(onDisk));
      }
      return json(url);
    }) as Http['json'];
    await run(ws, http, { only: ['monza'] });
    const monza = (await ws.read()).circuits.find((c) => c.id === 'monza')!;
    expect(monza).toMatchObject({ wikidata: 'Q171417', hasTrack: true });
    expect(Object.keys(monza).slice(-2)).toEqual(['hasTrack', 'checkedAt']);
  });

  it('aplica config/circuits.json y vuelve a consultar cuando una corrección cambia', async () => {
    const previous: CircuitsFile = {
      version: 1,
      generatedAt: NOW_ISO,
      circuits: GROUPS.map((g) => info(g.id, { checkedAt: NOW_ISO })),
    };
    const ws = await workspace(previous, {
      $comment: 'correcciones',
      'kartodromo-inexistente': { wikidata: 'Q5712988' },
      olavarria: { wikidata: null },
      monza: { name: 'Monza' },
    });
    const res = await run(ws, routeHttp());
    // Solo se consultan los que la corrección cambia ("no buscar" coincide con lo guardado: sin ficha).
    expect(res!.reports.map((r) => `${r.id}:${r.how}`).sort()).toEqual(['kartodromo-inexistente:manual', 'monza:nombre exacto']);
    const file = await ws.read();
    expect(file.circuits.find((c) => c.id === 'kartodromo-inexistente')).toMatchObject({ wikidata: 'Q5712988', name: 'Autódromo Eusebio Marcilla' });
    expect(file.circuits.find((c) => c.id === 'monza')).toMatchObject({ wikidata: 'Q171417', name: 'Monza' });
    // Ya aplicadas, no se vuelven a consultar.
    const again = routeHttp();
    await run(ws, again);
    expect(again.calls).toHaveLength(0);
  });

  it('si Wikimedia rechaza o limita las consultas, corta sin romper y conserva lo anterior', async () => {
    const previous: CircuitsFile = { version: 1, generatedAt: '2026-11-01T00:00:00Z', circuits: [info('monza', { wikidata: 'Q171417', lat: 45.62, lon: 9.29 })] };
    for (const status of [403, 429, 500]) {
      const ws = await workspace(previous);
      const before = await ws.raw();
      const http = routeHttp([['wikidata.org', new HttpError('https://www.wikidata.org/w/api.php', status, `HTTP ${status}`)], ...ROUTES]);
      const res = await run(ws, http);
      expect(res!.error, String(status)).toMatch(new RegExp(String(status)));
      expect(res!.pending).toBe(4);
      expect(res!.file.circuits).toEqual(previous.circuits);
      expect(await ws.raw()).toBe(before);
      // Un rechazo (403) no se reintenta ni se esquiva: una sola request.
      if (status === 403) expect(http.calls).toHaveLength(1);
    }
  });

  it('guarda cada lote terminado: un corte a mitad de camino no pierde lo ya consultado', async () => {
    const ws = await workspace();
    // Falla la búsqueda de "olavarria" (último lote, por orden de id).
    const http = routeHttp([['srsearch=olavarria', new HttpError('x', 500, 'HTTP 500')], ...ROUTES]);
    const res = await run(ws, http, { batchSize: 2 });
    expect(res!.error).toMatch(/500/);
    expect(res!.pending).toBe(1);
    expect((await ws.read()).circuits.map((c) => c.id)).toEqual(['junin', 'jyvaskyla', 'kartodromo-inexistente', 'monza']);
  });

  it('no escribe con --dry-run, y un config/circuits.json mal escrito no rompe la corrida', async () => {
    const dry = await workspace();
    const res = await run(dry, routeHttp(), { dryRun: true });
    expect(res!.file.circuits).toHaveLength(5);
    expect(await dry.raw()).toBeNull();

    const bad = await workspace(undefined, { monza: { wikidata: 'no-es-un-id' } });
    const http = routeHttp();
    expect(await run(bad, http)).toBeNull();
    expect(http.calls).toHaveLength(0);
    expect(await bad.raw()).toBeNull();
  });

  it('mergeInfo y overrideChanged', () => {
    const prev = info('x', { wikidata: 'Q1', lat: 1, lon: 2, coordsApprox: true, turns: 10, hasTrack: true });
    // Mismo elemento: lo nuevo pisa, lo que no viene se conserva; coordenadas exactas sacan el "aproximadas".
    expect(mergeInfo(prev, info('x', { wikidata: 'Q1', lat: 3, lon: 4, checkedAt: NOW_ISO }))).toEqual({
      id: 'x',
      name: 'x',
      wikidata: 'Q1',
      lat: 3,
      lon: 4,
      turns: 10,
      hasTrack: true,
      checkedAt: NOW_ISO,
    });
    // Otro elemento: no se mezclan datos de dos circuitos (solo queda hasTrack).
    expect(mergeInfo(prev, info('x', { wikidata: 'Q2', checkedAt: NOW_ISO }))).toEqual({ id: 'x', name: 'x', wikidata: 'Q2', hasTrack: true, checkedAt: NOW_ISO });
    // La nueva consulta no encontró el elemento: queda la ficha anterior, salvo que se haya pedido "no buscar".
    expect(mergeInfo(prev, info('x', { checkedAt: NOW_ISO }))).toEqual({ ...prev, checkedAt: NOW_ISO });
    expect(mergeInfo(prev, info('x', { checkedAt: NOW_ISO }), { wikidata: null })).toEqual({ id: 'x', name: 'x', hasTrack: true, checkedAt: NOW_ISO });
    // Una foto de antes que ahora es el plano no queda repetida.
    const image = { url: 'https://upload.wikimedia.org/x.png', credit: 'A', license: 'CC0', page: 'https://commons.wikimedia.org/wiki/File:X.png' };
    expect(mergeInfo({ ...prev, photo: image }, info('x', { wikidata: 'Q1', map: image, checkedAt: NOW_ISO })).photo).toBeUndefined();

    expect(overrideChanged(prev, undefined)).toBe(false);
    expect(overrideChanged(prev, { wikidata: 'Q1' })).toBe(false);
    expect(overrideChanged(prev, { wikidata: 'Q2' })).toBe(true);
    expect(overrideChanged(prev, { wikidata: null })).toBe(true);
    expect(overrideChanged(prev, { lat: 1, lon: 2 })).toBe(true);
    expect(overrideChanged({ ...prev, coordsApprox: undefined }, { lat: 1, lon: 2 })).toBe(false);
    expect(overrideChanged(prev, { city: 'Lugar, Provincia' })).toBe(true);
    expect(overrideChanged({ ...prev, city: 'Lugar' }, { city: 'Lugar, Provincia' })).toBe(false);
  });

  it('la configuración real es válida y nombra circuitos del calendario', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const overrides = await loadCircuitOverrides(path.join(root, 'config'));
    expect(Object.keys(overrides).length).toBeGreaterThan(0);
    for (const o of Object.values(overrides)) expect(o.wikidata === undefined || o.wikidata === null || /^Q\d+$/.test(o.wikidata)).toBe(true);
  });
});
