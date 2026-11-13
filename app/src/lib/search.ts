/**
 * Búsquedas puras (sin acentos ni mayúsculas, con tolerancia a errores de tipeo) que usan Buscar,
 * Siguiendo y los stores.
 *
 * Cada palabra buscada tiene que coincidir con alguna palabra del nombre:
 *  - exacta ("canapino" → "Agustín Canapino"),
 *  - por prefijo o dentro del nombre ("canap", "2000" → "TC2000"),
 *  - aproximada (Damerau-Levenshtein: 1 error en palabras de 4 a 6 letras, 2 desde 7; "verstapen",
 *    "colapnto"), también contra el comienzo de la palabra ("colapnt").
 * Orden: exactas > prefijo > aproximadas; después la relevancia (lo seguido, las categorías principales,
 * las argentinas, el resto), la cantidad de errores, la mejor posición en el campeonato y el nombre.
 * Las claves normalizadas se calculan una sola vez por objeto (WeakMap): ~2.200 pilotos y ~540 equipos
 * se recorren en pocos milisegundos por tecla.
 */
import type { Driver, Series, Team } from '@dm/shared';
import type { Circuit } from './circuits.ts';
import { seriesSort } from './grid.ts';

export const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

export function queryWords(query: string): string[] {
  return normalize(query.trim()).split(/\s+/).filter(Boolean);
}

export function matchesAll(hay: string, words: string[]): boolean {
  const h = normalize(hay);
  return words.every((w) => h.includes(w));
}

// ---------------------------------------------------------------------------
// Coincidencias aproximadas
// ---------------------------------------------------------------------------

/**
 * Distancia de Damerau-Levenshtein (alineación óptima: inserción, borrado, cambio y letras
 * traspuestas). Si supera `max` devuelve `max + 1` sin terminar la cuenta.
 */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const n = a.length;
  const m = b.length;
  if (!n) return m;
  if (!m) return n;
  let prev2: number[] = new Array<number>(m + 1).fill(0);
  let prev: number[] = Array.from({ length: m + 1 }, (_, j) => j);
  let cur: number[] = new Array<number>(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    let rowMin = i;
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, prev2[j - 2]! + 1);
      cur[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    [prev2, prev, cur] = [prev, cur, prev2];
  }
  return prev[m]!;
}

/** Errores tolerados según el largo de lo escrito: ninguno hasta 3 letras, 1 hasta 6, 2 desde 7. */
export function maxTypos(length: number): number {
  return length <= 3 ? 0 : length <= 6 ? 1 : 2;
}

export type MatchKind = 'exact' | 'prefix' | 'fuzzy';

const KIND_RANK: Record<MatchKind, number> = { exact: 0, prefix: 1, fuzzy: 2 };

export interface TextKey {
  /** Texto normalizado completo (para buscar dentro). */
  full: string;
  /** Palabras normalizadas, sin signos. */
  words: string[];
}

export function textKey(text: string): TextKey {
  const full = normalize(text);
  return { full, words: full.split(/[^a-z0-9]+/).filter(Boolean) };
}

const keyCache = new WeakMap<object, TextKey>();

/** Clave normalizada de un objeto, calculada una sola vez. */
function cachedKey(obj: object, text: () => string): TextKey {
  let key = keyCache.get(obj);
  if (!key) {
    key = textKey(text());
    keyCache.set(obj, key);
  }
  return key;
}

export interface TextMatch {
  kind: MatchKind;
  /** Errores de tipeo (0 si no es aproximada). */
  dist: number;
}

function matchWord(word: string, key: TextKey): TextMatch | null {
  const clean = word.replace(/[^a-z0-9]/g, '');
  let best: TextMatch | null = null;
  for (const w of key.words) {
    if (w === clean) return { kind: 'exact', dist: 0 };
    if (!best && clean && w.startsWith(clean)) best = { kind: 'prefix', dist: 0 };
  }
  if (best) return best;
  // Dentro del nombre ("2000" en "TC2000"), desde 3 letras: con 2 aparecen demasiadas.
  if (word.length >= 3 && key.full.includes(word)) return { kind: 'prefix', dist: 0 };
  const tol = maxTypos(clean.length);
  if (!tol) return null;
  // Errores en el comienzo de la palabra (lo escrito puede estar incompleto): uno solo.
  const prefixTol = clean.length >= 5 ? 1 : 0;
  let dist = tol + 1;
  for (const w of key.words) {
    dist = Math.min(dist, editDistance(clean, w, tol));
    if (prefixTol && dist > prefixTol && w.length > clean.length + 1) {
      const d = Math.min(editDistance(clean, w.slice(0, clean.length), prefixTol), editDistance(clean, w.slice(0, clean.length + 1), prefixTol));
      if (d <= prefixTol) dist = d;
    }
    if (dist === 1) break;
  }
  return dist <= tol ? { kind: 'fuzzy', dist } : null;
}

/** Cómo coincide una búsqueda (ya separada en palabras) con un texto; null si no coincide. */
export function matchKey(words: string[], key: TextKey): TextMatch | null {
  if (!words.length) return null;
  let kind: MatchKind = 'exact';
  let dist = 0;
  for (const w of words) {
    const m = matchWord(w, key);
    if (!m) return null;
    if (KIND_RANK[m.kind] > KIND_RANK[kind]) kind = m.kind;
    dist += m.dist;
  }
  return { kind, dist };
}

/** Coincidencia de una búsqueda con un texto suelto (para "¿Quisiste decir…?"). */
export function matchText(text: string, query: string): TextMatch | null {
  return matchKey(queryWords(query), textKey(text));
}

// ---------------------------------------------------------------------------
// Relevancia
// ---------------------------------------------------------------------------

/** Categorías principales: van antes que el resto en los resultados y las sugerencias. */
export const MAJOR_SERIES = ['f1', 'motogp', 'tc', 'tc2000', 'wec', 'nascar-cup', 'indycar', 'wrc', 'dakar'];

export interface SearchContext {
  /** Categorías seguidas (también las de los pilotos y equipos seguidos). */
  followedSeries?: readonly string[];
  followedDrivers?: readonly string[];
  followedTeams?: readonly string[];
  /** Categorías argentinas (después de las principales). */
  argentineSeries?: readonly string[];
}

/** Relevancia de una categoría: 0 seguida, 1 principal, 2 argentina, 3 el resto (menor = primero). */
export function seriesTier(seriesId: string, ctx: SearchContext = {}): number {
  if (ctx.followedSeries?.includes(seriesId)) return 0;
  if (MAJOR_SERIES.includes(seriesId)) return 1;
  if (ctx.argentineSeries?.includes(seriesId)) return 2;
  return 3;
}

/** Comparador de categorías por relevancia (las principales en el orden de MAJOR_SERIES). */
export function seriesRelevanceSort(ctx: SearchContext = {}) {
  return (a: Series, b: Series): number => {
    const ta = seriesTier(a.id, ctx);
    const tb = seriesTier(b.id, ctx);
    if (ta !== tb) return ta - tb;
    if (ta === 1) return MAJOR_SERIES.indexOf(a.id) - MAJOR_SERIES.indexOf(b.id);
    return seriesSort(a, b);
  };
}

const minTier = (ids: Iterable<string>, ctx: SearchContext): number => {
  let t = 4;
  for (const id of ids) t = Math.min(t, seriesTier(id, ctx));
  return t;
};

export interface SearchHit<T> {
  item: T;
  kind: MatchKind;
  dist: number;
  /** Relevancia (-1 piloto o equipo seguido; ver seriesTier). */
  tier: number;
  /** Mejor posición en el campeonato (Infinity si no figura en tablas). */
  pos: number;
  /** Número de auto buscado, si la búsqueda fue por número. */
  number?: string;
  /** Categoría en la que usa ese número. */
  numberSeries?: string;
}

/** Con coincidencias exactas o por prefijo, de las aproximadas quedan solo las de un error. */
function pruneFuzzy<T>(hits: Array<SearchHit<T>>): Array<SearchHit<T>> {
  return hits.some((h) => h.kind !== 'fuzzy') ? hits.filter((h) => h.kind !== 'fuzzy' || h.dist <= 1) : hits;
}

function compareHits<T>(name: (t: T) => string) {
  return (a: SearchHit<T>, b: SearchHit<T>): number =>
    KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
    a.tier - b.tier ||
    a.dist - b.dist ||
    a.pos - b.pos ||
    name(a.item).localeCompare(name(b.item), 'es');
}

/** Número de auto si la búsqueda es solo un número ("#7", "#43" o "43"; un dígito suelto es muy corto). */
export function carNumberQuery(query: string): string {
  const m = query.trim().match(/^#\s*(\d{1,4})$|^(\d{2,4})$/);
  return m ? (m[1] ?? m[2])! : '';
}

const tooShort = (query: string) => normalize(query.trim()).replace(/\s+/g, '').length < 2 && !carNumberQuery(query);

// ---------------------------------------------------------------------------
// Pilotos, equipos, categorías y circuitos
// ---------------------------------------------------------------------------

const bestPos = (d: Driver, seriesId?: string): number => {
  let best = Infinity;
  for (const e of d.entries) if ((!seriesId || e.seriesId === seriesId) && e.pos < best) best = e.pos;
  return best;
};

const majorRank = (id: string) => (MAJOR_SERIES.includes(id) ? MAJOR_SERIES.indexOf(id) : MAJOR_SERIES.length);

/** Categoría más relevante en la que un piloto usa un número de auto ('' si no lo usa). */
export function numberSeriesOf(d: Driver, number: string, ctx: SearchContext = {}): string {
  const ids = [
    ...d.entries.filter((e) => e.number === number).map((e) => e.seriesId),
    ...(d.lineups ?? []).filter((l) => l.number === number).map((l) => l.seriesId),
  ];
  return ids.sort((a, b) => seriesTier(a, ctx) - seriesTier(b, ctx) || majorRank(a) - majorRank(b))[0] ?? '';
}

/** Pilotos que coinciden con la búsqueda (por nombre o número de auto), ya ordenados. */
export function rankDrivers(drivers: Driver[], query: string, ctx: SearchContext = {}, limit = 30): Array<SearchHit<Driver>> {
  if (tooShort(query)) return [];
  const hits: Array<SearchHit<Driver>> = [];
  const num = carNumberQuery(query);
  const followed = new Set(ctx.followedDrivers ?? []);
  if (num) {
    for (const d of drivers) {
      const numberSeries = numberSeriesOf(d, num, ctx);
      if (!numberSeries) continue;
      const tier = followed.has(d.id) ? -1 : seriesTier(numberSeries, ctx);
      hits.push({ item: d, kind: 'exact', dist: 0, tier, pos: bestPos(d, numberSeries), number: num, numberSeries });
    }
    // Dentro de las principales, en el orden de MAJOR_SERIES (F1 antes que NASCAR).
    return hits
      .sort(
        (a, b) =>
          a.tier - b.tier ||
          majorRank(a.numberSeries!) - majorRank(b.numberSeries!) ||
          a.pos - b.pos ||
          a.item.name.localeCompare(b.item.name, 'es'),
      )
      .slice(0, limit);
  }
  const words = queryWords(query);
  for (const d of drivers) {
    const m = matchKey(words, cachedKey(d, () => d.name));
    if (!m) continue;
    const tier = followed.has(d.id) ? -1 : minTier([...d.entries.map((e) => e.seriesId), ...(d.lineups ?? []).map((l) => l.seriesId)], ctx);
    hits.push({ item: d, ...m, tier, pos: bestPos(d) });
  }
  return pruneFuzzy(hits).sort(compareHits((d) => d.name)).slice(0, limit);
}

/** Pilotos por nombre (sin acentos, con errores de tipeo) o número de auto; ver rankDrivers. */
export function searchDrivers(drivers: Driver[], query: string, limit = 30, ctx: SearchContext = {}): Driver[] {
  return rankDrivers(drivers, query, ctx, limit).map((h) => h.item);
}

const teamSeries = (t: Team) => [...t.entries.map((e) => e.seriesId), ...t.drivers.map((d) => d.seriesId)];
const teamPos = (t: Team) => Math.min(Infinity, ...t.entries.map((e) => e.pos ?? Infinity));

export function rankTeams(teams: Team[], query: string, ctx: SearchContext = {}, limit = 10): Array<SearchHit<Team>> {
  if (tooShort(query)) return [];
  const num = carNumberQuery(query);
  const followed = new Set(ctx.followedTeams ?? []);
  const words = queryWords(query);
  const hits: Array<SearchHit<Team>> = [];
  for (const t of teams) {
    if (num) {
      const series = t.entries.filter((e) => e.numbers?.includes(num)).map((e) => e.seriesId);
      if (!series.length) continue;
      const tier = followed.has(t.id) ? -1 : minTier(series, ctx);
      hits.push({ item: t, kind: 'exact', dist: 0, tier, pos: teamPos(t), number: num, numberSeries: series[0] });
      continue;
    }
    const m = matchKey(words, cachedKey(t, () => t.name));
    if (!m) continue;
    hits.push({ item: t, ...m, tier: followed.has(t.id) ? -1 : minTier(teamSeries(t), ctx), pos: teamPos(t) });
  }
  return pruneFuzzy(hits).sort(compareHits((t) => t.name)).slice(0, limit);
}

/** Equipos por nombre o por número de auto. */
export function searchTeams(teams: Team[], query: string, limit = 10, ctx: SearchContext = {}): Team[] {
  return rankTeams(teams, query, ctx, limit).map((h) => h.item);
}

/** Categorías por nombre o nombre corto. */
export function rankSeries(series: Series[], query: string, ctx: SearchContext = {}, limit = 8): Array<SearchHit<Series>> {
  if (tooShort(query) || carNumberQuery(query)) return [];
  const words = queryWords(query);
  const hits: Array<SearchHit<Series>> = [];
  for (const s of series) {
    const m = matchKey(words, cachedKey(s, () => `${s.name} ${s.shortName}`));
    if (m) hits.push({ item: s, ...m, tier: seriesTier(s.id, ctx), pos: Infinity });
  }
  const bySeries = seriesRelevanceSort(ctx);
  return pruneFuzzy(hits).sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || a.dist - b.dist || bySeries(a.item, b.item)).slice(0, limit);
}

export function rankCircuits(circuits: Circuit[], query: string, ctx: SearchContext = {}, limit = 8): Array<SearchHit<Circuit>> {
  if (tooShort(query) || carNumberQuery(query)) return [];
  const words = queryWords(query);
  const hits: Array<SearchHit<Circuit>> = [];
  for (const c of circuits) {
    const m = matchKey(words, cachedKey(c, () => `${c.names.join(' ')} ${c.country}`));
    // pos: más eventos primero (en negativo, para ordenar de menor a mayor).
    if (m) hits.push({ item: c, ...m, tier: minTier(c.seriesIds, ctx), pos: -c.events.length });
  }
  return pruneFuzzy(hits).sort(compareHits((c) => c.name)).slice(0, limit);
}

/** Circuitos por cualquiera de sus nombres o su país. */
export function searchCircuits(circuits: Circuit[], query: string, limit = 8, ctx: SearchContext = {}): Circuit[] {
  return rankCircuits(circuits, query, ctx, limit).map((h) => h.item);
}

// ---------------------------------------------------------------------------
// Textos de los resultados
// ---------------------------------------------------------------------------

/**
 * Subtítulo de un piloto en los resultados: sus campeonatos y luego las inscripciones donde no suma.
 * Si se buscó un número, primero ese auto: "#43 · F1 · P12".
 */
export function driverSubtitle(d: Driver, shortName: (seriesId: string) => string, number = '', numberSeries = ''): string {
  const parts: string[] = [];
  let skip = '';
  if (number) {
    const entry = d.entries.find((e) => e.number === number && (!numberSeries || e.seriesId === numberSeries));
    const seriesId = numberSeries || entry?.seriesId || d.lineups?.find((l) => l.number === number)?.seriesId || '';
    if (seriesId) {
      const ranked = entry ?? d.entries.find((e) => e.seriesId === seriesId);
      parts.push(`#${number}`, `${shortName(seriesId)}${ranked?.table ? ' ' + ranked.table : ''}`);
      if (ranked) parts.push(`P${ranked.pos}`);
      skip = seriesId;
    }
  }
  const inTable = new Set(d.entries.map((e) => e.seriesId));
  for (const e of d.entries) {
    if (e.seriesId === skip) continue;
    parts.push(`${shortName(e.seriesId)}${e.table ? ' ' + e.table : ''} P${e.pos}`);
  }
  for (const l of d.lineups ?? []) {
    if (inTable.has(l.seriesId) || l.seriesId === skip) continue;
    parts.push(`${shortName(l.seriesId)}${l.number ? ' #' + l.number : ''}${l.team ? ' · ' + l.team : ''}`);
  }
  return parts.join(' · ');
}
