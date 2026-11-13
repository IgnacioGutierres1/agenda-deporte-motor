/**
 * Trazado dibujable de un circuito a partir de OpenStreetMap (Overpass): ways `highway=raceway` alrededor de
 * las coordenadas del circuito.
 *
 * - Proyección local equirectangular (con cos(lat)), norte arriba, normalizada a un lienzo de 1000 unidades.
 * - Los ways que comparten nodos se unen en tramos; con los tramos se arma un grafo y se busca el lazo cerrado
 *   más largo cerca del centro: ese es el trazado principal. El resto del mismo conjunto conexo (calle de
 *   boxes, variantes) va como secundario.
 * - Kartódromos, pistas de motocross y pistas ajenas se descartan por tags, nombre o por no estar conectadas.
 * - Solo se publican lazos cerrados: un circuito callejero o mapeado a medias devuelve null (no se inventa nada).
 *
 * Datos © Colaboradores de OpenStreetMap, licencia ODbL.
 */
import type { CircuitTrackFile } from '@dm/shared';
import { HttpError, type Http } from '../core/http.ts';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
export const OSM_CREDIT = '© Colaboradores de OpenStreetMap';
export const OSM_LICENSE = 'ODbL';

/** Radio de búsqueda alrededor de las coordenadas, en metros. */
export const SEARCH_RADIUS_M = 3000;
/** Diferencia aceptada con la longitud oficial para elegir la variante por largo. */
const TARGET_TOLERANCE = 0.1;
/** Penalización de cada tramo al comparar con la longitud oficial (equivale a un 0,3 % de diferencia). */
const CHAIN_PENALTY = 0.003;
/** Lo mismo sin longitud oficial: metros que descuenta cada tramo al buscar el lazo más largo. */
const CHAIN_PENALTY_M = 100;
/** Con longitud oficial, el lazo elegido tiene que medir entre la mitad y el doble. */
const LENGTH_RATIO = 2;
/** Largo total de lo secundario, como fracción del trazado principal. */
const SECONDARY_MAX = 0.8;
/** Lado mayor del lienzo (incluye el margen). */
const CANVAS = 1000;
/** Margen del lienzo, para que el trazo no quede cortado contra el borde. */
const PAD = 20;
/** Tolerancia de Douglas-Peucker, en metros. */
const SIMPLIFY_M = 3;
/** Tamaño máximo del archivo (objetivo): si se pasa, se simplifica más y se recorta lo secundario. */
const MAX_BYTES = 5500;
/** Un lazo más corto que esto no es una pista de carreras. */
const MIN_LOOP_M = 300;
/** El lazo principal tiene que pasar a menos de esta distancia de las coordenadas… */
const NEAR_M = 1000;
/** …o, si está más lejos, ser lo bastante largo como para no ser un kartódromo vecino. */
const FAR_MIN_LOOP_M = 1500;
/** Extremos sueltos a menos de esta distancia se consideran unidos (ways mapeados sin compartir el nodo). */
const SNAP_M = 12;
/** Tope de pasos de cada búsqueda de lazos (Paul Ricard, con decenas de variantes, usa unos 4,6 millones: ~0,4 s). */
const MAX_STEPS = 8_000_000;
const EARTH_R = 6_371_008.8;

export interface LatLon {
  lat: number;
  lon: number;
}

/** Elemento de una respuesta de Overpass con `out tags geom`. */
export interface OverpassElement {
  type: string;
  id: number;
  tags?: Record<string, string>;
  geometry?: (LatLon | null)[];
}

export interface TrackHints {
  /** Longitud oficial del trazado principal (Wikidata), si se conoce: desempata entre variantes. */
  lengthM?: number;
}

/** Lo que aporta OpenStreetMap a data/tracks/{id}.json (el resto lo completa la corrida). */
export type TrackData = Omit<CircuitTrackFile, 'id' | 'updatedAt' | 'source'>;

type Pt = [number, number];

interface Way {
  pts: Pt[];
  keys: string[];
  pit: boolean;
  /** oneway: solo se recorre en el orden de pts. */
  oneway: boolean;
}

/** Tramo entre dos cruces (uno o más ways encadenados). */
interface Chain {
  a: number;
  b: number;
  pts: Pt[];
  len: number;
  pit: boolean;
  /** Sentido de circulación: 1 solo de a hacia b, -1 solo de b hacia a, 0 cualquiera. */
  dir: 1 | -1 | 0;
}

interface Selection {
  /** Lazo principal, cerrado (primer punto = último), en metros. */
  main: Pt[];
  mainLen: number;
  secondary: Pt[][];
}

// Listas armadas con los tags reales de los autódromos probados (ver test/fixtures/tracks).
const MOTOR_SPORT = /^(motor|motorsport|motor_sport|motor_racing|auto_racing|car_racing|motorcycle|motorcycling|racing)$/;
const FOREIGN_SPORT = /kart|motocross|bmx|cycling|bicycle|horse|running|athletics|rc_car|model|skating|speedway|dog|equestrian/;
const FOREIGN_NAME =
  /kart|motocross|moto ?cross|\bmx\b|bmx|supermoto|minimoto|pocket ?bike|picódromo|picodromo|drag ?strip|\bslot\b|radio ?control|glisse|skid ?pad|driving ?(center|centre|school)|tout[- ]terrain|off[- ]?road|todo ?terreno|4x4|drift/i;
/** Pistas de tierra (rallycross, motocross, off road): no son el trazado del autódromo. */
const UNPAVED = /^(dirt|gravel|grass|ground|sand|mud|earth|unpaved|compacted|fine_gravel|clay)$/;
const PIT_NAME = /\bpits?\b|pit ?lane|pitlane|pit ?road|\bboxes\b|\bbox\b|boxengasse|voie des stands|corsia box/i;
/** La recta principal suele llamarse "de boxes" ("National Pit Straight", "Recta de boxes", "Ligne droite des stands"). */
const STRAIGHT_NAME = /straight|recta|rettilineo|rettifilo|ligne droite|gerade|\breta\b/i;

/** true si el way es de otra cosa (karting, motocross, pista de bicis…) y no del autódromo. */
function isForeign(tags: Record<string, string>): boolean {
  // sport puede traer varios valores ("motor;karting"): si alguno es automovilismo, la pista se queda.
  const sports = (tags.sport ?? '').toLowerCase().split(';').map((s) => s.trim()).filter(Boolean);
  if (!sports.some((s) => MOTOR_SPORT.test(s)) && sports.some((s) => FOREIGN_SPORT.test(s))) return true;
  const raceway = (tags.raceway ?? '').toLowerCase();
  if (/kart|motocross|bmx|dirt|rc/.test(raceway)) return true;
  // Trazados históricos (el óvalo peraltado de Monza) o en desuso no se dibujan.
  if (tags.historic || tags.disused === 'yes' || tags.abandoned === 'yes') return true;
  if (UNPAVED.test((tags.surface ?? '').toLowerCase())) return true;
  return FOREIGN_NAME.test(tags.name ?? '');
}

function isPit(tags: Record<string, string>): boolean {
  if (/pit/.test((tags.raceway ?? '').toLowerCase())) return true;
  if (/pit/.test((tags.service ?? '').toLowerCase())) return true;
  const name = tags.name ?? '';
  return PIT_NAME.test(name) && !STRAIGHT_NAME.test(name);
}

const dist = (p: Pt, q: Pt): number => Math.hypot(p[0] - q[0], p[1] - q[1]);

function length(pts: Pt[]): number {
  let total = 0;
  for (let i = 1; i < pts.length; i++) total += dist(pts[i - 1]!, pts[i]!);
  return total;
}

/** Ways de pista proyectados a metros alrededor del centro (x al este, y al norte). */
function projectWays(elements: OverpassElement[], center: LatLon): Way[] {
  const cos = Math.cos((center.lat * Math.PI) / 180);
  const rad = Math.PI / 180;
  const ways: Way[] = [];
  for (const el of elements) {
    const tags = el.tags ?? {};
    if (el.type !== 'way' || tags.highway !== 'raceway' || tags.area === 'yes' || isForeign(tags)) continue;
    const pts: Pt[] = [];
    const keys: string[] = [];
    for (const g of el.geometry ?? []) {
      if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) continue;
      const key = `${g.lat.toFixed(7)},${g.lon.toFixed(7)}`;
      if (keys[keys.length - 1] === key) continue;
      keys.push(key);
      pts.push([(g.lon - center.lon) * rad * cos * EARTH_R, (g.lat - center.lat) * rad * EARTH_R]);
    }
    if (pts.length < 2) continue;
    // La mayoría de los autódromos tienen el trazado mapeado con oneway=yes: el sentido acota mucho la búsqueda.
    const oneway = tags.oneway === '-1' ? -1 : /^(yes|true|1)$/.test(tags.oneway ?? '') ? 1 : 0;
    if (oneway === -1) {
      pts.reverse();
      keys.reverse();
    }
    ways.push({ pts, keys, pit: isPit(tags), oneway: oneway !== 0 });
  }
  return ways;
}

/**
 * Une extremos sueltos que quedaron a pocos metros de otro way (mapeados sin compartir el nodo): el extremo
 * pasa a usar la clave del punto vecino, así el grafo los ve conectados.
 */
function snapLooseEnds(ways: Way[]): void {
  const uses = new Map<string, number>();
  for (const w of ways) for (const k of w.keys) uses.set(k, (uses.get(k) ?? 0) + 1);
  for (const w of ways) {
    for (const end of [0, w.keys.length - 1]) {
      const key = w.keys[end]!;
      if ((uses.get(key) ?? 0) > 1) continue;
      const p = w.pts[end]!;
      let best: { key: string; pt: Pt; d: number } | null = null;
      for (const other of ways) {
        for (let i = 0; i < other.pts.length; i++) {
          // En el mismo way solo vale el otro extremo (un lazo que no llegó a cerrarse).
          if (other === w && i !== (end === 0 ? w.keys.length - 1 : 0)) continue;
          const d = dist(p, other.pts[i]!);
          if (d > 0 && d <= SNAP_M && (!best || d < best.d)) best = { key: other.keys[i]!, pt: other.pts[i]!, d };
        }
      }
      if (!best) continue;
      if (end === 0) {
        w.keys.unshift(best.key);
        w.pts.unshift(best.pt);
      } else {
        w.keys.push(best.key);
        w.pts.push(best.pt);
      }
      uses.set(best.key, (uses.get(best.key) ?? 0) + 1);
    }
  }
}

/** Parte los ways en los cruces y encadena los tramos que siguen de largo. */
function buildChains(ways: Way[]): { chains: Chain[]; vertices: number } {
  const uses = new Map<string, number>();
  const ends = new Set<string>();
  for (const w of ways) {
    for (const k of w.keys) uses.set(k, (uses.get(k) ?? 0) + 1);
    ends.add(w.keys[0]!);
    ends.add(w.keys[w.keys.length - 1]!);
  }
  const isNode = (k: string): boolean => ends.has(k) || (uses.get(k) ?? 0) > 1;

  // Segmentos entre nodos (extremos o puntos compartidos).
  const ids = new Map<string, number>();
  const idOf = (k: string): number => {
    let id = ids.get(k);
    if (id === undefined) ids.set(k, (id = ids.size));
    return id;
  };
  const segs: Chain[] = [];
  for (const w of ways) {
    let start = 0;
    for (let i = 1; i < w.keys.length; i++) {
      if (!isNode(w.keys[i]!) && i < w.keys.length - 1) continue;
      const pts = w.pts.slice(start, i + 1);
      segs.push({ a: idOf(w.keys[start]!), b: idOf(w.keys[i]!), pts, len: length(pts), pit: w.pit, dir: w.oneway ? 1 : 0 });
      start = i;
    }
  }

  // Un nodo con exactamente dos segmentos del mismo tipo no es un cruce: los segmentos se encadenan.
  const at = new Map<number, number[]>();
  segs.forEach((s, i) => {
    for (const v of s.a === s.b ? [s.a] : [s.a, s.b]) at.set(v, [...(at.get(v) ?? []), i]);
  });
  const passes = (v: number): boolean => {
    const list = at.get(v) ?? [];
    return list.length === 2 && segs[list[0]!]!.pit === segs[list[1]!]!.pit && segs[list[0]!]!.a !== segs[list[0]!]!.b && segs[list[1]!]!.a !== segs[list[1]!]!.b;
  };
  const used = new Array<boolean>(segs.length).fill(false);
  const chains: Chain[] = [];
  const walk = (first: number, from: number): Chain => {
    let seg = segs[first]!;
    used[first] = true;
    let pts = seg.a === from ? seg.pts.slice() : seg.pts.slice().reverse();
    let cur = seg.a === from ? seg.b : seg.a;
    // Sentidos de los segmentos respecto del recorrido (de from hacia cur).
    const dirs = new Set<number>([seg.a === from ? seg.dir : -seg.dir]);
    while (cur !== from && passes(cur)) {
      const next = (at.get(cur) ?? []).find((i) => !used[i]);
      if (next === undefined) break;
      seg = segs[next]!;
      used[next] = true;
      pts = pts.concat((seg.a === cur ? seg.pts : seg.pts.slice().reverse()).slice(1));
      dirs.add(seg.a === cur ? seg.dir : -seg.dir);
      cur = seg.a === cur ? seg.b : seg.a;
    }
    // Sentidos contradictorios (error de mapeo): el tramo queda sin sentido.
    const dir = dirs.has(1) && !dirs.has(-1) ? 1 : dirs.has(-1) && !dirs.has(1) ? -1 : 0;
    return { a: from, b: cur, pts, len: length(pts), pit: segs[first]!.pit, dir };
  };
  // Primero desde los cruces de verdad; lo que queda son lazos sin ningún cruce.
  for (const [v, list] of at) if (!passes(v)) for (const i of list) if (!used[i]) chains.push(walk(i, v));
  segs.forEach((s, i) => {
    if (!used[i]) chains.push(walk(i, s.a));
  });
  return { chains, vertices: ids.size };
}

/** Componentes conexas: índice de componente de cada tramo. */
function components(chains: Chain[], vertices: number): number[] {
  const parent = Array.from({ length: vertices }, (_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]!]!;
    return x;
  };
  for (const c of chains) parent[find(c.a)] = find(c.b);
  return chains.map((c) => find(c.a));
}

/** Saca los tramos sin salida (quedan solo los que forman parte de algún lazo o lo conectan). */
function withoutDeadEnds(chains: Chain[]): Chain[] {
  let rest = chains;
  for (;;) {
    const degree = new Map<number, number>();
    for (const c of rest) {
      degree.set(c.a, (degree.get(c.a) ?? 0) + 1);
      degree.set(c.b, (degree.get(c.b) ?? 0) + 1);
    }
    const next = rest.filter((c) => c.a === c.b || ((degree.get(c.a) ?? 0) > 1 && (degree.get(c.b) ?? 0) > 1));
    if (next.length === rest.length) return rest;
    rest = next;
  }
}

interface Loop {
  chains: Chain[];
  pts: Pt[];
  len: number;
}

interface LoopSize {
  len: number;
  chains: number;
}

interface LoopSearch {
  /** Techo de longitud: se podan los caminos que ya se pasaron. */
  maxLen?: number;
  /** Respeta el sentido de circulación (oneway). */
  directed?: boolean;
  /**
   * Permite pasar dos veces por el mismo cruce (nunca por el mismo tramo). Hace falta donde el trazado completo
   * cruza a nivel los enlaces de sus variantes (Paul Ricard); sin techo de longitud la búsqueda explota.
   */
  revisit?: boolean;
}

/**
 * Lazos del grafo; devuelve el mejor según `better`, que compara longitud y cantidad de tramos. Con la longitud oficial como techo
 * la búsqueda termina aun en autódromos con decenas de variantes mapeadas.
 */
function bestLoop(
  chains: Chain[],
  better: (cand: LoopSize, best: LoopSize | null) => boolean,
  { maxLen = Infinity, directed = true, revisit = false }: LoopSearch = {},
): Loop | null {
  const at = new Map<number, Chain[]>();
  for (const c of chains) {
    at.set(c.a, [...(at.get(c.a) ?? []), c]);
    if (c.b !== c.a) at.set(c.b, [...(at.get(c.b) ?? []), c]);
  }
  // Los tramos largos primero: los lazos largos aparecen antes si la búsqueda llega al tope.
  for (const list of at.values()) list.sort((x, y) => y.len - x.len);
  let best: { path: { chain: Chain; from: number }[]; len: number } | null = null;
  let steps = 0;
  const starts = [...at.keys()].sort((x, y) => x - y);
  for (const start of starts) {
    const visited = new Set<number>([start]);
    const used = new Set<Chain>();
    const path: { chain: Chain; from: number }[] = [];
    let len = 0;
    const dfs = (v: number): void => {
      for (const chain of at.get(v) ?? []) {
        if (++steps > MAX_STEPS) return;
        if (used.has(chain) || len + chain.len > maxLen) continue;
        if (directed && ((chain.dir === 1 && chain.a !== v) || (chain.dir === -1 && chain.b !== v))) continue;
        const w = chain.a === v ? chain.b : chain.a;
        if (w === start) {
          if (better({ len: len + chain.len, chains: path.length + 1 }, best && { len: best.len, chains: best.path.length })) {
            best = { path: [...path, { chain, from: v }], len: len + chain.len };
          }
          // Pasando dos veces por los cruces, el lazo puede seguir de largo por el de partida (un ocho a nivel).
          if (!revisit) continue;
        }
        // Cada lazo se enumera desde su cruce de menor índice.
        if (w < start || (!revisit && visited.has(w))) continue;
        visited.add(w);
        used.add(chain);
        path.push({ chain, from: v });
        len += chain.len;
        dfs(w);
        len -= chain.len;
        path.pop();
        used.delete(chain);
        visited.delete(w);
      }
    };
    dfs(start);
    if (steps > MAX_STEPS) break;
  }
  if (!best) return null;
  const found: { path: { chain: Chain; from: number }[]; len: number } = best;
  let pts: Pt[] = [];
  for (const { chain, from } of found.path) {
    const seg = chain.a === from ? chain.pts : chain.pts.slice().reverse();
    pts = pts.length ? pts.concat(seg.slice(1)) : seg.slice();
  }
  return { chains: found.path.map((p) => p.chain), pts, len: found.len };
}

/** Distancia mínima de un conjunto de tramos al centro (el origen de la proyección). */
function distanceToCenter(chains: Chain[]): number {
  let min = Infinity;
  for (const c of chains) for (const p of c.pts) min = Math.min(min, Math.hypot(p[0], p[1]));
  return min;
}

function bbox(lines: Pt[][]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const line of lines) {
    for (const [x, y] of line) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, minY, maxX, maxY };
}

/** Elige el lazo principal y lo secundario, en metros. null si no hay un circuito cerrado reconocible. */
export function selectTrack(elements: OverpassElement[], center: LatLon, hints: TrackHints = {}): Selection | null {
  const ways = projectWays(elements, center);
  if (!ways.length) return null;
  snapLooseEnds(ways);
  const { chains, vertices } = buildChains(ways);
  const comp = components(chains, vertices);

  // Con la longitud oficial se elige el lazo que más se le parece (si alguno queda a ±10 %); si no, el más largo.
  const target = hints.lengthM && hints.lengthM > MIN_LOOP_M ? hints.lengthM : null;
  // Sin longitud oficial, el más largo; cada tramo descuenta unos metros para no preferir un zigzag por los enlaces
  // interiores a la vuelta por afuera.
  const net = (c: LoopSize): number => c.len - CHAIN_PENALTY_M * c.chains;
  const longest = (c: LoopSize, best: LoopSize | null): boolean => c.len >= MIN_LOOP_M && (best === null || net(c) > net(best));
  // Donde hay muchas variantes, varias combinaciones de enlaces suman casi lo mismo que el trazado oficial: cada
  // tramo cuenta como un pequeño desvío, así gana el recorrido por los tramos largos y no el zigzag por los enlaces.
  const score = (c: LoopSize): number => Math.abs(c.len - target!) / target! + CHAIN_PENALTY * c.chains;
  const closest = (c: LoopSize, best: LoopSize | null): boolean => c.len >= MIN_LOOP_M && (best === null || score(c) < score(best));
  const fits = (loop: Loop | null): loop is Loop => !!loop && !!target && Math.abs(loop.len - target) <= target * TARGET_TOLERANCE;
  const search = (core: Chain[]): Loop | null => {
    if (target) {
      // El que más se acerca a la longitud oficial, con y sin sentido de circulación: donde dos trazados comparten
      // tramos y corren en sentidos opuestos (el óvalo y el mixto de Indianápolis) el sentido mapeado solo
      // permite uno. Pasar dos veces por un cruce solo se prueba con sentido (sin él, la búsqueda explota).
      const maxLen = target * (1 + TARGET_TOLERANCE);
      const directed = bestLoop(core, closest, { maxLen });
      const candidates = [
        directed,
        fits(directed) ? null : bestLoop(core, closest, { maxLen, revisit: true }),
        bestLoop(core, closest, { maxLen, directed: false }),
      ].filter(fits);
      const size = (l: Loop): LoopSize => ({ len: l.len, chains: l.chains.length });
      if (candidates.length) return candidates.reduce((a, b) => (score(size(b)) < score(size(a)) ? b : a));
    }
    // Sin longitud oficial (o si ningún lazo se le parece), el más largo; sin sentido solo si con sentido no hay lazo.
    return bestLoop(core, longest) ?? bestLoop(core, longest, { directed: false });
  };
  const better = (a: Loop, b: Loop): boolean => {
    if (target) {
      const da = Math.abs(a.len - target);
      const db = Math.abs(b.len - target);
      if (Math.min(da, db) <= target * TARGET_TOLERANCE) return da < db;
    }
    return a.len > b.len;
  };

  let chosen: { loop: Loop; group: Chain[]; near: boolean } | null = null;
  for (const id of new Set(comp)) {
    const group = chains.filter((_, i) => comp[i] === id);
    const core = withoutDeadEnds(group);
    // La calle de boxes corre pegada a la recta y es apenas más larga: sin esto, el lazo más largo se iría por boxes.
    const loop = search(core.filter((c) => !c.pit)) ?? search(core);
    if (!loop) continue;
    const near = distanceToCenter(group) <= NEAR_M;
    if (!near && loop.len < FAR_MIN_LOOP_M) continue;
    // Lo que pasa cerca de las coordenadas le gana a lo lejano; a igual cercanía, el mejor lazo.
    if (!chosen || (near && !chosen.near) || (near === chosen.near && better(loop, chosen.loop))) {
      chosen = { loop, group, near };
    }
  }
  if (!chosen) return null;
  const main = chosen.loop;
  // Un lazo de la mitad (o el doble) de la longitud oficial es otra cosa: un tramo suelto de un callejero, un
  // kartódromo sin etiquetar. Mejor sin dibujo que con el equivocado.
  if (target && (main.len < target / LENGTH_RATIO || main.len > target * LENGTH_RATIO)) return null;

  // Secundario: boxes y variantes que salen del trazado principal y vuelven a él (los enlaces entre variantes
  // y lo que se va lejos no entran: en autódromos como Paul Ricard serían una maraña), hasta un largo total.
  const box = bbox([main.pts]);
  const margin = 0.15 * Math.max(box.maxX - box.minX, box.maxY - box.minY);
  const inMain = new Set(main.chains);
  const onMain = new Set(main.chains.flatMap((c) => [c.a, c.b]));
  let budget = main.len * SECONDARY_MAX;
  const secondary = withoutDeadEnds(chosen.group)
    .filter((c) => !inMain.has(c) && c.len >= 25 && onMain.has(c.a) && onMain.has(c.b))
    .filter((c) => c.pts.every(([x, y]) => x >= box.minX - margin && x <= box.maxX + margin && y >= box.minY - margin && y <= box.maxY + margin))
    .sort((a, b) => Number(b.pit) - Number(a.pit) || b.len - a.len)
    .filter((c) => (budget -= c.len) >= 0)
    .map((c) => c.pts);
  return { main: main.pts, mainLen: main.len, secondary };
}

/** Douglas-Peucker sobre una polilínea abierta. */
function simplify(pts: Pt[], tolerance: number): Pt[] {
  if (pts.length <= 2) return pts.slice();
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop()!;
    const [ax, ay] = pts[from]!;
    const [bx, by] = pts[to]!;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let worstD = tolerance;
    for (let i = from + 1; i < to; i++) {
      const [px, py] = pts[i]!;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > worstD) {
        worstD = d;
        worst = i;
      }
    }
    if (worst > 0) {
      keep[worst] = true;
      stack.push([from, worst], [worst, to]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Simplifica un lazo cerrado (primer punto = último) partiéndolo en dos mitades. */
function simplifyLoop(pts: Pt[], tolerance: number): Pt[] {
  const ring = pts.slice(0, -1);
  if (ring.length < 4) return pts.slice();
  let far = 0;
  for (let i = 1; i < ring.length; i++) if (dist(ring[0]!, ring[i]!) > dist(ring[0]!, ring[far]!)) far = i;
  const first = simplify(ring.slice(0, far + 1), tolerance);
  const second = simplify([...ring.slice(far), ring[0]!], tolerance);
  return [...first, ...second.slice(1)];
}

/**
 * El lazo se publica sin "Z" (el contrato es "M x y L x y …"): para que la unión no se note con ningún tipo de
 * trazo, empieza y termina en el medio de su tramo recto más largo.
 */
function startOnLongestStraight(loop: Pt[]): Pt[] {
  const ring = loop.slice(0, -1);
  let at = 0;
  let longest = -1;
  for (let i = 0; i < ring.length; i++) {
    const d = dist(ring[i]!, ring[(i + 1) % ring.length]!);
    if (d > longest) {
      longest = d;
      at = i;
    }
  }
  const p = ring[at]!;
  const q = ring[(at + 1) % ring.length]!;
  const mid: Pt = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  return [mid, ...ring.slice(at + 1), ...ring.slice(0, at + 1), mid];
}

const num = (n: number): string => String(Math.round(n * 10) / 10);

/**
 * Arma los datos de data/tracks/{id}.json con los elementos de una respuesta de Overpass.
 * Devuelve null si no hay un trazado cerrado cerca del centro.
 */
export function buildTrack(elements: OverpassElement[], center: LatLon, hints: TrackHints = {}): TrackData | null {
  const sel = selectTrack(elements, center, hints);
  if (!sel) return null;

  // El lienzo lo define el trazado principal junto con lo secundario (que ya está acotado a su alrededor).
  const box = bbox([sel.main, ...sel.secondary]);
  const spanX = box.maxX - box.minX;
  const spanY = box.maxY - box.minY;
  const metersPerUnit = Math.max(spanX, spanY) / (CANVAS - 2 * PAD);
  if (!(metersPerUnit > 0)) return null;
  const toPath = (pts: Pt[]): string =>
    pts.map(([x, y], i) => `${i ? 'L' : 'M'} ${num((x - box.minX) / metersPerUnit + PAD)} ${num((box.maxY - y) / metersPerUnit + PAD)}`).join(' ');

  let secondary = sel.secondary;
  for (let tolerance = Math.max(SIMPLIFY_M, metersPerUnit); ; tolerance *= 1.4) {
    const data: TrackData = {
      width: Math.round((spanX / metersPerUnit + 2 * PAD) * 10) / 10,
      height: Math.round((spanY / metersPerUnit + 2 * PAD) * 10) / 10,
      paths: [toPath(startOnLongestStraight(simplifyLoop(sel.main, tolerance)))],
      ...(secondary.length ? { secondary: secondary.map((s) => toPath(simplify(s, tolerance))) } : {}),
      metersPerUnit: Math.round(metersPerUnit * 1000) / 1000,
      credit: OSM_CREDIT,
      license: OSM_LICENSE,
    };
    if (JSON.stringify(data).length <= MAX_BYTES) return data;
    // Todavía pesa mucho: primero se simplifica más; si ni así alcanza, se saca la variante más corta.
    if (tolerance > 6 * metersPerUnit) {
      if (!secondary.length) return data;
      secondary = secondary.slice(0, -1);
      tolerance = Math.max(SIMPLIFY_M, metersPerUnit) / 1.4;
    }
  }
}

export function overpassQuery(lat: number, lon: number, radiusM = SEARCH_RADIUS_M): string {
  return `[out:json][timeout:25];way["highway"="raceway"](around:${radiusM},${lat},${lon});out tags geom;`;
}

export interface FetchTrackOptions extends TrackHints {
  /** Reintentos con el servidor ocupado: 429, 502, 503 y 504 (por defecto 2). */
  retries?: number;
  /** Espera antes del primer reintento; se duplica en cada uno (por defecto 30 s). */
  retryWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface OverpassResponse {
  elements?: OverpassElement[];
  /** Overpass responde 200 con `remark` cuando la consulta se cortó (timeout, memoria). */
  remark?: string;
}

/**
 * Consulta Overpass y arma el trazado. null = no hay un trazado dibujable en OpenStreetMap.
 * Con el servidor ocupado (429, 502, 503, 504) espera y reintenta; cualquier otro error se propaga (no es "sin
 * trazado").
 */
export async function fetchTrack(lat: number, lon: number, http: Http, opts: FetchTrackOptions = {}): Promise<TrackData | null> {
  const retries = opts.retries ?? 2;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const body = `data=${encodeURIComponent(overpassQuery(lat, lon))}`;
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await http.json<OverpassResponse>(OVERPASS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      const elements = res.body.elements ?? [];
      if (res.body.remark && /error|timed out|out of memory/i.test(res.body.remark)) {
        throw new Error(`Overpass no completó la consulta: ${res.body.remark}`);
      }
      return buildTrack(elements, { lat, lon }, opts);
    } catch (err) {
      const busy = err instanceof HttpError && [429, 502, 503, 504].includes(err.status);
      if (!busy || attempt >= retries) throw err;
      await sleep((opts.retryWaitMs ?? 30_000) * 2 ** attempt);
    }
  }
}
