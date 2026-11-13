/**
 * Trazados de circuitos (OpenStreetMap).
 *
 * Casos sintéticos (elementos armados acá con la forma de una respuesta de Overpass, `out tags geom`) para cada regla,
 * y respuestas reales recortadas en test/fixtures/tracks.
 */
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { circuitTrackFileSchema, type CircuitsFile } from '@dm/shared';
import { HttpError, type Http, type HttpResponse } from '../src/core/http.ts';
import { fixture } from './fake-http.ts';
import { createLogger } from '../src/core/log.ts';
import { OSM_CREDIT, OVERPASS_URL, buildTrack, fetchTrack, selectTrack, type OverpassElement } from '../src/circuits/track.ts';
import { OVERPASS_USER_AGENT, createOverpassHttp, runTracks } from '../src/circuits/tracks-run.ts';

const CENTER = { lat: 43.2506, lon: 5.7917 };
const R = 6_371_008.8;
type M = [number, number];

/** Way de Overpass a partir de puntos en metros alrededor del centro (x al este, y al norte). */
function way(id: number, pts: M[], tags: Record<string, string> = {}): OverpassElement {
  const cos = Math.cos((CENTER.lat * Math.PI) / 180);
  return {
    type: 'way',
    id,
    tags: { highway: 'raceway', ...tags },
    geometry: pts.map(([x, y]) => ({
      lat: CENTER.lat + (y / R) * (180 / Math.PI),
      lon: CENTER.lon + (x / (R * cos)) * (180 / Math.PI),
    })),
  };
}

/** Arco de `from` a `to` grados sobre un círculo, cada 10°. */
function arc(cx: number, cy: number, r: number, from: number, to: number): M[] {
  const pts: M[] = [];
  const step = from < to ? 10 : -10;
  for (let a = from; step > 0 ? a <= to : a >= to; a += step) {
    pts.push([cx + r * Math.cos((a * Math.PI) / 180), cy + r * Math.sin((a * Math.PI) / 180)]);
  }
  return pts;
}

/** Óvalo de 1000 × 400 m (rectas de 600 m, curvas de radio 200) centrado en (cx, cy): unos 2457 m. */
function oval(cx = 0, cy = 0): { bottom: M[]; right: M[]; top: M[]; left: M[] } {
  return {
    bottom: [
      [cx - 300, cy - 200],
      [cx + 300, cy - 200],
    ],
    right: arc(cx + 300, cy, 200, -90, 90),
    top: [
      [cx + 300, cy + 200],
      [cx - 300, cy + 200],
    ],
    left: arc(cx - 300, cy, 200, 90, 270),
  };
}

function ovalWays(cx = 0, cy = 0, tags: Record<string, string> = {}, firstId = 1): OverpassElement[] {
  const o = oval(cx, cy);
  return [way(firstId, o.bottom, tags), way(firstId + 1, o.right, tags), way(firstId + 2, o.top, tags), way(firstId + 3, o.left, tags)];
}

const points = (d: string): M[] => {
  const n = d.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
  return Array.from({ length: n.length / 2 }, (_, i) => [n[2 * i]!, n[2 * i + 1]!]);
};

describe('buildTrack', () => {
  it('une ways contiguos en un lazo cerrado y lo normaliza a un lienzo de 1000 con norte arriba', () => {
    const track = buildTrack(ovalWays(), CENTER)!;
    expect(track.paths).toHaveLength(1);
    expect(track.secondary).toBeUndefined();
    expect(track.credit).toBe(OSM_CREDIT);
    expect(track.license).toBe('ODbL');
    // El óvalo mide 1000 × 400 m: el lado mayor ocupa el lienzo menos el margen de 20 por lado.
    expect(track.width).toBe(1000);
    expect(track.height).toBeCloseTo(424, 0);
    expect(track.metersPerUnit).toBeCloseTo(1000 / 960, 2);
    // Formato del contrato ("M x y L x y …"), un decimal como mucho, sin "Z".
    expect(track.paths[0]).toMatch(/^M -?\d+(\.\d)? -?\d+(\.\d)?( L -?\d+(\.\d)? -?\d+(\.\d)?)+$/);
    const pts = points(track.paths[0]!);
    expect(pts[0]).toEqual(pts[pts.length - 1]);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(20);
      expect(x).toBeLessThanOrEqual(980);
      expect(y).toBeGreaterThanOrEqual(20);
      expect(y).toBeLessThanOrEqual(track.height - 20 + 0.1);
    }
  });

  it('norte arriba: lo que está al norte queda con y menor', () => {
    // Triángulo con la punta al norte.
    const track = buildTrack(
      [
        way(1, [
          [-200, -100],
          [200, -100],
          [0, 300],
          [-200, -100],
        ]),
      ],
      CENTER,
    )!;
    const pts = points(track.paths[0]!);
    const top = pts.reduce((a, b) => (b[1] < a[1] ? b : a));
    expect(top[1]).toBe(20);
    // La punta está en el medio del ancho.
    expect(top[0]).toBeCloseTo(track.width / 2, 0);
  });

  it('la calle de boxes va como secundaria aunque sea un poco más larga que la recta', () => {
    const o = oval();
    // Boxes: sale de la recta de abajo, corre paralela 30 m adentro y vuelve.
    const bottom: M[] = [
      [-300, -200],
      [-250, -200],
      [250, -200],
      [300, -200],
    ];
    const pit: M[] = [
      [-250, -200],
      [-200, -170],
      [200, -170],
      [250, -200],
    ];
    const elements = [way(1, bottom), way(2, o.right), way(3, o.top), way(4, o.left), way(5, pit, { name: 'Pit Lane' })];
    const sel = selectTrack(elements, CENTER)!;
    // El principal es el óvalo (≈2457 m), no el recorrido por boxes (≈2473 m).
    expect(sel.mainLen).toBeGreaterThan(2440);
    expect(sel.mainLen).toBeLessThan(2465);
    expect(sel.secondary).toHaveLength(1);
    const track = buildTrack(elements, CENTER)!;
    expect(track.secondary).toHaveLength(1);
  });

  it('con variantes elige el lazo más largo, y con la longitud oficial el que más se le parece', () => {
    const o = oval();
    // Un atajo que corta el óvalo por el medio (de la recta de arriba a la de abajo).
    const bottom1: M[] = [
      [-300, -200],
      [0, -200],
    ];
    const bottom2: M[] = [
      [0, -200],
      [300, -200],
    ];
    const top1: M[] = [
      [300, 200],
      [0, 200],
    ];
    const top2: M[] = [
      [0, 200],
      [-300, 200],
    ];
    const shortcut: M[] = [
      [0, -200],
      [0, 200],
    ];
    const elements = [way(1, bottom1), way(2, bottom2), way(3, o.right), way(4, top1), way(5, top2), way(6, o.left), way(7, shortcut)];
    const full = selectTrack(elements, CENTER)!;
    expect(full.mainLen).toBeCloseTo(2457, -1);
    expect(full.secondary).toHaveLength(1);
    // Media vuelta + atajo: 300 + 628 + 300 + 400 ≈ 1628 m.
    const half = selectTrack(elements, CENTER, { lengthM: 1630 })!;
    expect(half.mainLen).toBeCloseTo(1628, -1);
    // Una longitud oficial que no se parece a ningún lazo no decide nada…
    expect(selectTrack(elements, CENTER, { lengthM: 3000 })!.mainLen).toBeCloseTo(2457, -1);
    // …pero si el lazo mide menos de la mitad (o más del doble) es otra cosa: no hay trazado.
    expect(selectTrack(elements, CENTER, { lengthM: 9000 })).toBeNull();
    expect(selectTrack(elements, CENTER, { lengthM: 1000 })).toBeNull();
  });

  it('respeta el sentido de circulación (oneway): una variante a contramano no entra al lazo', () => {
    const o = oval();
    // Óvalo antihorario: la recta de abajo va de oeste a este. El desvío sale del extremo este y vuelve al oeste.
    const bottom1: M[] = [
      [-300, -200],
      [0, -200],
    ];
    const bottom2: M[] = [
      [0, -200],
      [300, -200],
    ];
    const detour: M[] = [
      [300, -200],
      [150, -500],
      [0, -200],
    ];
    const build = (tags: Record<string, string>) => [
      way(1, bottom1, tags),
      way(2, bottom2, tags),
      way(3, o.right, tags),
      way(4, o.top, tags),
      way(5, o.left, tags),
      way(6, detour, tags),
    ];
    // Sin sentido, el lazo más largo usa el desvío; con oneway, el desvío va a contramano y queda afuera.
    expect(selectTrack(build({}), CENTER)!.mainLen).toBeGreaterThan(2600);
    expect(selectTrack(build({ oneway: 'yes' }), CENTER)!.mainLen).toBeCloseTo(2457, -1);
    // oneway=-1 es el mismo sentido dibujado al revés.
    const reversed = build({ oneway: '-1' }).map((w) => ({ ...w, geometry: [...w.geometry!].reverse() }));
    expect(selectTrack(reversed, CENTER)!.mainLen).toBeCloseTo(2457, -1);
  });

  it('con la longitud oficial encuentra un trazado que pasa dos veces por el mismo cruce (un ocho a nivel)', () => {
    // Dos círculos de 200 m de radio que se tocan en el origen, cada uno partido en dos mitades.
    const left1 = arc(-200, 0, 200, 0, 180);
    const left2 = arc(-200, 0, 200, 180, 360);
    const right1 = arc(200, 0, 200, 180, 360);
    const right2 = arc(200, 0, 200, 0, 180);
    const tags = { oneway: 'yes' };
    const elements = [way(1, left1, tags), way(2, left2, tags), way(3, right1, tags), way(4, right2, tags)];
    // Sin longitud oficial, el lazo simple más largo es uno de los círculos.
    expect(selectTrack(elements, CENTER)!.mainLen).toBeCloseTo(1253, -1);
    // Con la longitud del ocho completo, el ocho.
    expect(selectTrack(elements, CENTER, { lengthM: 2513 })!.mainLen).toBeCloseTo(2507, -1);
  });

  it('descarta el kartódromo y las pistas ajenas por tags y por nombre', () => {
    const kartBySport = ovalWays(900, 0, { sport: 'karting' }, 10);
    const kartByName = ovalWays(0, 700, { name: 'Kartódromo Internacional' }, 20);
    const track = selectTrack([...ovalWays(), ...kartBySport, ...kartByName], CENTER)!;
    expect(track.mainLen).toBeCloseTo(2457, -1);
    expect(track.secondary).toHaveLength(0);
    // Si lo único que hay es el kartódromo, no hay trazado.
    expect(buildTrack(ovalWays(0, 0, { sport: 'karting' }), CENTER)).toBeNull();
    expect(buildTrack(ovalWays(0, 0, { sport: 'motocross' }), CENTER)).toBeNull();
    // Trazados históricos (el óvalo peraltado de Monza), de tierra o de escuelas de manejo tampoco.
    expect(buildTrack(ovalWays(0, 0, { historic: 'ruins' }), CENTER)).toBeNull();
    expect(buildTrack(ovalWays(0, 0, { surface: 'dirt' }), CENTER)).toBeNull();
    expect(buildTrack(ovalWays(0, 0, { name: 'Piste de Glisse' }), CENTER)).toBeNull();
    expect(buildTrack(ovalWays(0, 0, { name: 'Driving Center Castellet' }), CENTER)).toBeNull();
    // sport=motor es la pista, y "motor;karting" también.
    expect(buildTrack(ovalWays(0, 0, { sport: 'motor' }), CENTER)).not.toBeNull();
    expect(buildTrack(ovalWays(0, 0, { sport: 'motor;karting' }), CENTER)).not.toBeNull();
  });

  it('no inventa: sin ways, con un tramo abierto o con una pista mapeada como área devuelve null', () => {
    expect(buildTrack([], CENTER)).toBeNull();
    const o = oval();
    expect(buildTrack([way(1, o.bottom), way(2, o.right), way(3, o.top)], CENTER)).toBeNull();
    expect(buildTrack([way(1, [...o.bottom, ...o.right, ...o.top, ...o.left, o.bottom[0]!], { area: 'yes' })], CENTER)).toBeNull();
    // Otros elementos y otros highway no cuentan.
    expect(buildTrack([{ type: 'node', id: 1 }, { ...way(2, o.bottom), tags: { highway: 'service' } }], CENTER)).toBeNull();
  });

  it('lejos de las coordenadas solo acepta una pista grande (no el kartódromo de al lado)', () => {
    // Lazo chico (≈ 630 m) a 2 km: no es el circuito.
    expect(buildTrack([way(1, [...arc(2000, 0, 100, 0, 360)])], CENTER)).toBeNull();
    // El óvalo de 2457 m a 2 km sí.
    expect(buildTrack(ovalWays(2300, 0), CENTER)).not.toBeNull();
    // Y si hay una pista cerca, gana la cercana aunque la lejana sea más larga.
    const big: M[] = [
      [1800, -600],
      [3000, -600],
      [3000, 600],
      [1800, 600],
      [1800, -600],
    ];
    expect(selectTrack([...ovalWays(), way(20, big)], CENTER)!.mainLen).toBeCloseTo(2457, -1);
  });

  it('une extremos que quedaron a pocos metros (ways mapeados sin compartir el nodo)', () => {
    const o = oval();
    const left = o.left.slice();
    // El último punto de la curva izquierda queda a 6 m del comienzo de la recta.
    left[left.length - 1] = [-300, -206];
    expect(buildTrack([way(1, o.bottom), way(2, o.right), way(3, o.top), way(4, left)], CENTER)).not.toBeNull();
    // A 40 m ya no es el mismo punto.
    left[left.length - 1] = [-300, -240];
    expect(buildTrack([way(1, o.bottom), way(2, o.right), way(3, o.top), way(4, left)], CENTER)).toBeNull();
  });

  it('lo secundario que se va lejos del trazado principal no entra al dibujo', () => {
    const o = oval();
    const bottom1: M[] = [
      [-300, -200],
      [0, -200],
    ];
    const bottom2: M[] = [
      [0, -200],
      [300, -200],
    ];
    // Un enlace largo que sale de la recta, se va 2 km al sur y vuelve al mismo lugar.
    const far: M[] = [
      [0, -200],
      [200, -2200],
      [-200, -2200],
      [0, -200],
    ];
    const sel = selectTrack([way(1, bottom1), way(2, bottom2), way(3, o.right), way(4, o.top), way(5, o.left), way(6, far)], CENTER, {
      lengthM: 2457,
    })!;
    expect(sel.mainLen).toBeCloseTo(2457, -1);
    expect(sel.secondary).toHaveLength(0);
  });

  it('un circuito con muchos puntos y variantes queda en un archivo chico', () => {
    // Lazo ondulado de ~4 km con un punto cada pocos metros, más ocho enlaces internos.
    const ring: M[] = [];
    for (let a = 0; a < 360; a += 0.5) {
      const r = 600 + 120 * Math.sin((a * 7 * Math.PI) / 180);
      ring.push([r * Math.cos((a * Math.PI) / 180), r * Math.sin((a * Math.PI) / 180)]);
    }
    const elements: OverpassElement[] = [];
    for (let i = 0; i < 7; i++) elements.push(way(i + 1, ring.slice(i * 90, i * 90 + 91)));
    elements.push(way(8, [...ring.slice(630), ring[0]!]));
    // Cuatro enlaces que cruzan por el centro, de un lado al otro del lazo.
    for (let i = 0; i < 4; i++) elements.push(way(20 + i, [ring[i * 90]!, [0, 0], ring[i * 90 + 360]!]));
    const track = buildTrack(elements, CENTER)!;
    expect(track).not.toBeNull();
    const file = { id: 'prueba', updatedAt: '2026-11-12T00:00:00Z', ...track, source: { url: 'https://www.openstreetmap.org/', title: 'OpenStreetMap', kind: 'api', method: 'directo', fetchedAt: '2026-11-12T00:00:00Z' } };
    expect(() => circuitTrackFileSchema.parse(file)).not.toThrow();
    expect(JSON.stringify(file).length).toBeLessThan(6000);
  });
});

/** Respuestas reales de Overpass (13/11/2026), recortadas a los tags que usa el código. © Colaboradores de OpenStreetMap, ODbL. */
describe('buildTrack con datos reales de OpenStreetMap', () => {
  const real = (id: string): OverpassElement[] => (JSON.parse(fixture(`tracks/${id}.json`)) as { elements: OverpassElement[] }).elements;
  const sizeOf = (track: object): number =>
    JSON.stringify({
      id: 'x',
      updatedAt: '2026-11-13T00:00:00Z',
      ...track,
      source: { url: 'https://www.openstreetmap.org/#map=15/00.00000/00.00000', title: 'OpenStreetMap', kind: 'api', method: 'directo', fetchedAt: '2026-11-13T00:00:00Z' },
    }).length;

  it('Monza: el trazado de 5,8 km, sin el óvalo peraltado histórico', () => {
    const center = { lat: 45.62056, lon: 9.28944 };
    const sel = selectTrack(real('monza'), center, { lengthM: 5793 })!;
    expect(sel.mainLen).toBeGreaterThan(5700);
    expect(sel.mainLen).toBeLessThan(5900);
    // El óvalo (historic=ruins) mide 4,25 km: si entrara como secundario, lo secundario pasaría de 4 km.
    const secondary = sel.secondary.reduce((n, l) => n + l.reduce((m, p, i) => (i ? m + Math.hypot(p[0] - l[i - 1]![0], p[1] - l[i - 1]![1]) : 0), 0), 0);
    expect(secondary).toBeLessThan(2000);
    const track = buildTrack(real('monza'), center, { lengthM: 5793 })!;
    expect(sizeOf(track)).toBeLessThan(6000);
    // Monza es más alto que ancho (la recta principal corre de norte a sur).
    expect(track.height).toBeGreaterThan(track.width);
  });

  it('Paul Ricard: entre decenas de variantes, kartódromo, motocross y pista de derrape, el trazado de 5842 m', () => {
    const center = { lat: 43.250555555556, lon: 5.7916666666667 };
    const elements = real('paul-ricard');
    const sel = selectTrack(elements, center, { lengthM: 5842 })!;
    expect(Math.abs(sel.mainLen - 5842)).toBeLessThan(60);
    // Sin zigzag por los enlaces: pocas líneas secundarias.
    expect(sel.secondary.length).toBeLessThanOrEqual(6);
    const track = buildTrack(elements, center, { lengthM: 5842 })!;
    expect(sizeOf(track)).toBeLessThan(6000);
    // La búsqueda entre tantas variantes lleva ~1 s: margen para cuando la máquina está cargada.
  }, 20_000);

  it('Silverstone: "National Pit Straight" es la recta principal, no la calle de boxes', () => {
    const sel = selectTrack(real('silverstone'), { lat: 52.075, lon: -1.0166666666666666 }, { lengthM: 5891 })!;
    expect(Math.abs(sel.mainLen - 5891)).toBeLessThan(60);
  });

  it('Indianápolis: con la longitud oficial del óvalo (2,5 millas) dibuja el óvalo y no el mixto', () => {
    const center = { lat: 39.79485, lon: -86.23482 };
    const sel = selectTrack(real('indianapolis-motor-speedway'), center, { lengthM: 4023 })!;
    expect(sel.mainLen).toBeGreaterThan(4040);
    expect(sel.mainLen).toBeLessThan(4100);
    const track = buildTrack(real('indianapolis-motor-speedway'), center, { lengthM: 4023 })!;
    // El óvalo es un rectángulo de norte a sur.
    expect(track.height / track.width).toBeGreaterThan(1.8);
  });

  it('Termas de Río Hondo, sin longitud oficial: el lazo más largo', () => {
    const track = buildTrack(real('termas-de-rio-hondo'), { lat: -27.50586111, lon: -64.91447222 })!;
    expect(track.paths).toHaveLength(1);
    expect(track.metersPerUnit).toBeGreaterThan(1);
    expect(sizeOf(track)).toBeLessThan(6000);
  });

  it('callejeros sin trazado de carrera mapeado: Mónaco y Las Vegas devuelven null (no se inventa)', () => {
    expect(buildTrack(real('monaco'), { lat: 43.73472, lon: 7.42056 }, { lengthM: 3337 })).toBeNull();
    // En Las Vegas hay un lazo de 1 km mapeado como pista: con 6,2 km oficiales, no es el circuito.
    expect(buildTrack(real('las-vegas-strip'), { lat: 36.11003, lon: -115.16181 }, { lengthM: 6201 })).toBeNull();
  });
});

/** Http falso: responde cada pedido con la función dada y registra los cuerpos enviados. */
function overpassHttp(reply: (call: number, body: string) => unknown): Http & { bodies: string[] } {
  const bodies: string[] = [];
  const json = async <T>(url: string, init?: RequestInit): Promise<HttpResponse<T>> => {
    bodies.push(String(init?.body ?? ''));
    expect(url).toBe(OVERPASS_URL);
    expect(init?.method).toBe('POST');
    const body = reply(bodies.length, bodies[bodies.length - 1]!);
    if (body instanceof Error) throw body;
    return { url, status: 200, contentType: 'application/json', body: body as T };
  };
  const never = async (): Promise<never> => {
    throw new Error('no se usa');
  };
  return { bodies, json, text: never, bytes: never };
}

describe('fetchTrack', () => {
  it('consulta los ways highway=raceway alrededor de las coordenadas', async () => {
    const http = overpassHttp(() => ({ elements: ovalWays() }));
    const track = await fetchTrack(CENTER.lat, CENTER.lon, http);
    expect(track?.paths).toHaveLength(1);
    const query = decodeURIComponent(http.bodies[0]!.replace(/^data=/, ''));
    expect(query).toBe('[out:json][timeout:25];way["highway"="raceway"](around:3000,43.2506,5.7917);out tags geom;');
  });

  it('sin pistas devuelve null; si Overpass cortó la consulta, es un error y no "sin trazado"', async () => {
    expect(await fetchTrack(1, 2, overpassHttp(() => ({ elements: [] })))).toBeNull();
    const cut = overpassHttp(() => ({ elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 26 seconds.' }));
    await expect(fetchTrack(1, 2, cut)).rejects.toThrow(/no completó/);
  });

  it('ante 429/504 espera y reintenta; otros errores no se reintentan', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number): Promise<void> => void waits.push(ms);
    const busy = overpassHttp((call) => (call < 3 ? new HttpError(OVERPASS_URL, call === 1 ? 429 : 504, 'ocupado') : { elements: ovalWays() }));
    expect(await fetchTrack(CENTER.lat, CENTER.lon, busy, { sleep })).not.toBeNull();
    expect(busy.bodies).toHaveLength(3);
    expect(waits).toEqual([30_000, 60_000]);

    const always = overpassHttp(() => new HttpError(OVERPASS_URL, 429, 'ocupado'));
    await expect(fetchTrack(1, 2, always, { sleep, retries: 1 })).rejects.toThrow('ocupado');
    expect(always.bodies).toHaveLength(2);

    const refused = overpassHttp(() => new HttpError(OVERPASS_URL, 406, 'HTTP 406'));
    await expect(fetchTrack(1, 2, refused, { sleep })).rejects.toThrow('HTTP 406');
    expect(refused.bodies).toHaveLength(1);
  });
});

describe('createOverpassHttp', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('se identifica como la app (overpass-api.de responde 406 al User-Agent "Mozilla/5.0 (compatible; …)")', async () => {
    const seen: Record<string, string>[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      seen.push(init?.headers as Record<string, string>);
      return new Response('{"elements":[]}', { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const res = await createOverpassHttp().json<{ elements: unknown[] }>(OVERPASS_URL, { method: 'POST', body: 'data=x' });
    expect(res.body.elements).toEqual([]);
    expect(seen[0]!['User-Agent']).toBe(OVERPASS_USER_AGENT);
    expect(OVERPASS_USER_AGENT).not.toMatch(/mozilla/i);
  });
});

describe('runTracks', () => {
  const NOW = new Date('2026-11-12T12:00:00Z');
  const log = createLogger('test', true);
  const sleep = async (): Promise<void> => {};

  async function setup(circuits: Partial<CircuitsFile['circuits'][number]>[]): Promise<string> {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dm-tracks-'));
    const file: CircuitsFile = {
      version: 1,
      generatedAt: '2026-11-12T00:00:00Z',
      circuits: circuits.map((c) => ({ id: 'x', name: 'X', checkedAt: '2026-11-12T00:00:00Z', ...c })),
    };
    await writeFile(path.join(dir, 'circuits.json'), JSON.stringify(file));
    return dir;
  }
  const read = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
  const flags = async (dir: string): Promise<Record<string, boolean | undefined>> =>
    Object.fromEntries((await read<CircuitsFile>(path.join(dir, 'circuits.json'))).circuits.map((c) => [c.id, c.hasTrack]));

  it('sin circuits.json no hace nada', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dm-tracks-'));
    const http = overpassHttp(() => ({ elements: [] }));
    expect((await runTracks({ http, log, dataDir: dir, now: NOW, sleep })).queried).toBe(0);
    expect(http.bodies).toHaveLength(0);
  });

  it('escribe el trazado, marca hasTrack y recuerda los que no tienen', async () => {
    const dir = await setup([
      { id: 'paul-ricard', name: 'Paul Ricard', lat: CENTER.lat, lon: CENTER.lon, lengthM: 2457 },
      { id: 'monaco', name: 'Mónaco', lat: 43.7347, lon: 7.4206 },
      { id: 'ciudad', name: 'Solo ciudad', lat: -34.6, lon: -58.4, coordsApprox: true },
      { id: 'sin-coords', name: 'Sin coordenadas' },
    ]);
    const http = overpassHttp((_, body) => ({ elements: body.includes('43.2506') ? ovalWays() : [] }));
    const result = await runTracks({ http, log, dataDir: dir, now: NOW, sleep });
    expect(result).toMatchObject({ queried: 2, written: ['paul-ricard'], without: ['monaco'], failed: [], pending: 0 });

    const track = circuitTrackFileSchema.parse(await read(path.join(dir, 'tracks', 'paul-ricard.json')));
    expect(track).toMatchObject({ id: 'paul-ricard', updatedAt: '2026-11-12T12:00:00Z', credit: OSM_CREDIT, license: 'ODbL' });
    expect(track.source).toMatchObject({ title: 'OpenStreetMap', kind: 'api', method: 'directo' });
    expect(track.source.url).toBe('https://www.openstreetmap.org/#map=15/43.25060/5.79170');
    expect(await flags(dir)).toEqual({ 'paul-ricard': true, monaco: false, ciudad: undefined, 'sin-coords': undefined });

    // Segunda corrida: no se vuelve a preguntar por ninguno.
    const again = overpassHttp(() => ({ elements: [] }));
    expect((await runTracks({ http: again, log, dataDir: dir, now: new Date('2026-11-20T12:00:00Z'), sleep })).queried).toBe(0);
    expect(again.bodies).toHaveLength(0);

    // Pasado el plazo se vuelve a preguntar por el que no tenía; el que ya tiene archivo, nunca.
    const later = overpassHttp(() => ({ elements: [] }));
    const r3 = await runTracks({ http: later, log, dataDir: dir, now: new Date('2027-06-01T12:00:00Z'), sleep });
    expect(r3).toMatchObject({ queried: 1, without: ['monaco'] });

    // --force vuelve a consultar todo lo que tiene coordenadas exactas.
    const forced = overpassHttp(() => ({ elements: ovalWays() }));
    expect((await runTracks({ http: forced, log, dataDir: dir, now: NOW, sleep, force: true })).queried).toBe(2);
  });

  it('si circuits.json perdió la marca pero el archivo existe, la repone sin consultar', async () => {
    const dir = await setup([{ id: 'monza', name: 'Monza', lat: 45.62, lon: 9.289 }]);
    await mkdir(path.join(dir, 'tracks'));
    await writeFile(path.join(dir, 'tracks', 'monza.json'), '{}');
    const http = overpassHttp(() => ({ elements: [] }));
    expect((await runTracks({ http, log, dataDir: dir, now: NOW, sleep })).queried).toBe(0);
    expect(await flags(dir)).toEqual({ monza: true });
  });

  it('respeta el tope por corrida y pausa entre consultas', async () => {
    const dir = await setup([1, 2, 3, 4].map((n) => ({ id: `c${n}`, name: `C${n}`, lat: 10 + n, lon: 20 })));
    const pauses: number[] = [];
    const http = overpassHttp(() => ({ elements: [] }));
    const result = await runTracks({ http, log, dataDir: dir, now: NOW, limit: 3, sleep: async (ms) => void pauses.push(ms) });
    expect(result).toMatchObject({ queried: 3, pending: 1 });
    expect(pauses).toEqual([2500, 2500]);
  });

  it('un error no se anota como "sin trazado", y dos seguidos cortan la corrida', async () => {
    const dir = await setup([1, 2, 3, 4].map((n) => ({ id: `c${n}`, name: `C${n}`, lat: 10 + n, lon: 20 })));
    const http = overpassHttp(() => new HttpError(OVERPASS_URL, 406, 'HTTP 406'));
    const result = await runTracks({ http, log, dataDir: dir, now: NOW, sleep });
    expect(result).toMatchObject({ queried: 2, failed: ['c1', 'c2'], without: [], pending: 2 });
    expect(await flags(dir)).toEqual({ c1: undefined, c2: undefined, c3: undefined, c4: undefined });
    // La próxima corrida vuelve a intentarlos.
    const ok = overpassHttp(() => ({ elements: [] }));
    expect((await runTracks({ http: ok, log, dataDir: dir, now: NOW, sleep })).queried).toBe(4);
  });

  it('--dry-run no escribe nada', async () => {
    const dir = await setup([{ id: 'paul-ricard', name: 'Paul Ricard', lat: CENTER.lat, lon: CENTER.lon }]);
    const http = overpassHttp(() => ({ elements: ovalWays() }));
    const result = await runTracks({ http, log, dataDir: dir, now: NOW, sleep, dryRun: true });
    expect(result.written).toEqual(['paul-ricard']);
    await expect(readFile(path.join(dir, 'tracks', 'paul-ricard.json'))).rejects.toThrow();
    expect(await flags(dir)).toEqual({ 'paul-ricard': undefined });
  });
});
