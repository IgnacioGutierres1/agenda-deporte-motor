/**
 * Agrupado de notas que cuentan lo mismo, para no repetirlas en la lista.
 *
 * 1. Repetidos de verdad (mismo link, o la misma nota del mismo medio publicada dos veces):
 *    se funden en una sola, sin dejar rastro.
 * 2. La misma noticia en otro medio u otro idioma (Motorsport.com en inglés y su edición
 *    latinoamericana, RACER y Motorsport.com con el mismo anuncio): queda una principal y las
 *    demás como `alsoIn` ("También en…").
 *
 * Criterio conservador: dos notas se agrupan solo si
 * - comparten la misma foto (y alguna palabra del título) y salieron con menos de 3 días de diferencia, o
 * - en el mismo idioma, los títulos comparten casi todas las palabras con contenido, o
 * - en idiomas distintos, comparten al menos 3 nombres propios/números escritos con mayúscula en
 *   los dos títulos (Andrea Stella, McLaren, Vegas),
 * y además salieron con menos de 36 h de diferencia y no hablan de sesiones distintas (pole vs.
 * carrera) ni de años distintos (temporada 2026 vs. 2027).
 * Un grupo nunca junta dos notas del mismo medio: si un medio publicó dos notas, son dos noticias.
 */
import type { NewsAlternate, NewsItem } from '@dm/shared';
import { contentTokens, normalizeTitle, properTokens } from './text.ts';

/** Clave para deduplicar: sin "www.", sin barra final, sin seguimiento, http = https. */
export function canonicalKey(raw: string): string {
  try {
    const u = new URL(cleanUrl(raw));
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = u.pathname.replace(/\/+$/, '') || '/';
    u.searchParams.sort();
    const q = u.searchParams.toString();
    return `${host}${pathname}${q ? `?${q}` : ''}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ocid|cmpid|ref|ref_src|ito|at_\w+)$/i;

/** Link sin parámetros de seguimiento ni ancla. */
export function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
    u.hash = '';
    return u.toString();
  } catch {
    return raw;
  }
}

/** Títulos casi idénticos (misma nota en dos ediciones de un medio, o retocada). */
export function similarTitles(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return true;
  const ta = new Set(na.split(' ').filter(Boolean));
  const tb = new Set(nb.split(' ').filter(Boolean));
  if (ta.size < 5 || tb.size < 5) return false;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter) >= 0.9;
}

/** Clave de una foto: host sin "www." ni "cdn-N." y la ruta, sin parámetros. */
export function imageKey(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname.toLowerCase().replace(/^(?:www|cdn-?\d*|img\d*|images?\d*)\./, '')}${u.pathname}`;
  } catch {
    return url;
  }
}

/** Palabras que distinguen sesiones: "pole de X" y "carrera de X" son noticias distintas. */
const SESSION_CLASSES: RegExp[] = [
  /^(?:pole|poles|qualifying|quali|qualifies|qualified|clasificacion|clasifico|clasificaciones)$/,
  /^(?:practice|practices|fp1|fp2|fp3|practica|practicas|entrenamiento|entrenamientos|ensayo|ensayos)$/,
  /^(?:sprint|sprints)$/,
  /^(?:test|tests|testing|prueba|pruebas|shakedown)$/,
];

const HOUR = 3_600_000;
const IMAGE_MAX_HOURS = 72;
const TITLE_MAX_HOURS = 36;
/** Una foto que aparece en más notas que esto es genérica (logo, foto de archivo): no sirve para agrupar. */
const IMAGE_MAX_USES = 3;
const SAME_LANG_MIN_DICE = 0.65;
/** Puntaje de dos notas ya agrupadas en una corrida anterior. */
const LINKED = 3;

interface Node {
  item: NewsItem;
  key: string;
  tokens: Set<string>;
  /** Foto sin el servidor de la CDN ni parámetros (Motorsport.com sirve la misma desde cdn-1, cdn-7…). */
  image?: string;
  proper: Set<string>;
  years: Set<string>;
  sessions: boolean[];
  time: number;
  /** Claves canónicas de las versiones ya agrupadas en corridas anteriores. */
  alsoKeys: Set<string>;
}

/** Puntaje de "es la misma noticia" entre notas de medios distintos (0 = no). */
export function storyScore(a: NewsItem, b: NewsItem, imageUses: (url: string) => number = () => 1): number {
  return linkScore(node(a), node(b), imageUses);
}

function node(item: NewsItem): Node {
  const tokens = new Set(contentTokens(item.title));
  return {
    item,
    key: canonicalKey(item.url),
    tokens,
    image: item.image ? imageKey(item.image) : undefined,
    proper: new Set(properTokens(item.title)),
    years: new Set([...tokens].filter((t) => /^(?:19|20)\d\d$/.test(t))),
    sessions: SESSION_CLASSES.map((re) => [...tokens].some((t) => re.test(t))),
    time: Date.parse(item.publishedAt),
    alsoKeys: new Set((item.alsoIn ?? []).map((x) => canonicalKey(x.url))),
  };
}

function linkScore(a: Node, b: Node, imageUses: (url: string) => number): number {
  if (a.item.source === b.item.source) return 0;
  // Ya agrupadas en una corrida anterior.
  if (a.alsoKeys.has(b.key) || b.alsoKeys.has(a.key)) return LINKED;

  const hours = Math.abs(a.time - b.time) / HOUR;
  let shared = 0;
  let sharedWords = 0;
  for (const t of a.tokens) {
    if (!b.tokens.has(t)) continue;
    shared++;
    if (!/^\d+$/.test(t)) sharedWords++;
  }

  const img = a.image;
  if (img && img === b.image && imageUses(img) <= IMAGE_MAX_USES && hours <= IMAGE_MAX_HOURS && sharedWords >= 1) return 2;

  if (hours > TITLE_MAX_HOURS) return 0;
  if (a.sessions.some((s, i) => s !== b.sessions[i])) return 0;
  // "Temporada 2026" y "temporada 2027" son notas distintas.
  if (a.years.size && b.years.size && ![...a.years].some((y) => b.years.has(y))) return 0;
  if (similarTitles(a.item.title, b.item.title)) return 1.5;

  const sameLang = (a.item.lang ?? '') === (b.item.lang ?? '');
  if (sameLang) {
    if (a.tokens.size < 4 || b.tokens.size < 4) return 0;
    const dice = (2 * shared) / (a.tokens.size + b.tokens.size);
    return dice >= SAME_LANG_MIN_DICE ? dice : 0;
  }
  // Idiomas distintos: lo que coincide son nombres propios y números (escritos con mayúscula en los dos).
  let sharedProper = 0;
  let sharedNames = 0;
  for (const t of a.proper) {
    if (!b.proper.has(t)) continue;
    sharedProper++;
    if (!/^\d+$/.test(t)) sharedNames++;
  }
  const ratio = sharedProper / Math.min(a.tokens.size, b.tokens.size);
  return sharedProper >= 3 && sharedNames >= 2 && ratio >= 0.4 ? 0.5 + 0.4 * ratio : 0;
}

/** Principal del grupo: primero en castellano, después la fuente oficial, después la primera publicada. */
function primaryOrder(a: NewsItem, b: NewsItem): number {
  return (
    Number(b.lang === 'es') - Number(a.lang === 'es') ||
    Number(b.sourceKind === 'oficial') - Number(a.sourceKind === 'oficial') ||
    a.publishedAt.localeCompare(b.publishedAt) ||
    a.source.localeCompare(b.source) ||
    a.url.localeCompare(b.url)
  );
}

/** Funde `extra` en `into` (categorías, foto, bajada en el mismo idioma, versiones). */
function absorb(into: NewsItem, extra: NewsItem, asAlternate: boolean): void {
  into.seriesIds = [...new Set([...into.seriesIds, ...extra.seriesIds])];
  if (!into.image && extra.image) into.image = extra.image;
  if (!into.summary && extra.summary && (into.lang ?? '') === (extra.lang ?? '')) into.summary = extra.summary;
  const alts: NewsAlternate[] = [...(into.alsoIn ?? [])];
  if (asAlternate) alts.push({ source: extra.source, url: extra.url, ...(extra.lang ? { lang: extra.lang } : {}) });
  alts.push(...(extra.alsoIn ?? []));
  const own = canonicalKey(into.url);
  const seenKeys = new Set([own]);
  const seenSources = new Set([into.source]);
  const out: NewsAlternate[] = [];
  for (const a of alts) {
    const k = canonicalKey(a.url);
    if (seenKeys.has(k) || seenSources.has(a.source)) continue;
    seenKeys.add(k);
    seenSources.add(a.source);
    out.push(a);
  }
  if (out.length) into.alsoIn = out;
  else delete into.alsoIn;
}

/** Repetidos del mismo link o del mismo medio: queda una sola nota (la oficial o, si no, la primera). */
export function mergeDuplicates(items: NewsItem[]): NewsItem[] {
  const ordered = [...items].sort(
    (a, b) =>
      Number(b.sourceKind === 'oficial') - Number(a.sourceKind === 'oficial') ||
      a.publishedAt.localeCompare(b.publishedAt) ||
      a.source.localeCompare(b.source) ||
      a.url.localeCompare(b.url),
  );
  const byKey = new Map<string, NewsItem>();
  const kept: NewsItem[] = [];
  for (const item of ordered) {
    const key = canonicalKey(item.url);
    const dup =
      byKey.get(key) ??
      kept.find(
        (k) =>
          k.source === item.source &&
          (similarTitles(k.title, item.title) || (!!k.image && !!item.image && imageKey(k.image) === imageKey(item.image) && sameSourceRetitle(k.title, item.title))),
      );
    if (dup) {
      absorb(dup, item, false);
      continue;
    }
    const copy: NewsItem = { ...item, seriesIds: [...item.seriesIds], ...(item.alsoIn ? { alsoIn: [...item.alsoIn] } : {}) };
    byKey.set(key, copy);
    kept.push(copy);
  }
  return kept;
}

/** Misma foto y título retocado ("Cindric Holds Off Noaker…" / "Cindric Holds Noaker… at Daytona"). */
function sameSourceRetitle(a: string, b: string): boolean {
  const ta = new Set(contentTokens(a));
  const tb = new Set(contentTokens(b));
  if (ta.size < 3 || tb.size < 3) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return (2 * inter) / (ta.size + tb.size) >= 0.6;
}

/**
 * Agrupa la misma noticia de medios distintos. Devuelve una nota por grupo (la principal, con las
 * demás en `alsoIn`), sin orden particular.
 */
export function groupStories(items: NewsItem[]): NewsItem[] {
  const nodes = items.map(node);
  const imageCount = new Map<string, number>();
  for (const n of nodes) if (n.image) imageCount.set(n.image, (imageCount.get(n.image) ?? 0) + 1);
  const imageUses = (url: string) => imageCount.get(url) ?? 0;

  const pairs: Array<{ a: number; b: number; score: number }> = [];
  for (let a = 0; a < nodes.length; a++) {
    for (let b = a + 1; b < nodes.length; b++) {
      const score = linkScore(nodes[a]!, nodes[b]!, imageUses);
      if (score > 0) pairs.push({ a, b, score });
    }
  }
  // De la coincidencia más segura a la menos; un grupo no puede tener dos notas del mismo medio.
  pairs.sort((x, y) => y.score - x.score || x.a - y.a || x.b - y.b);
  const parent = nodes.map((_, i) => i);
  const sources = nodes.map((n) => new Set([n.item.source, ...(n.item.alsoIn ?? []).map((x) => x.source)]));
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (const { a, b, score } of pairs) {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) continue;
    const sa = sources[ra]!;
    const sb = sources[rb]!;
    // Una versión ya agrupada antes que vuelve en el feed se reincorpora aunque su medio ya figure.
    if (score < LINKED && [...sb].some((s) => sa.has(s))) continue;
    parent[rb] = ra;
    for (const s of sb) sa.add(s);
  }

  const groups = new Map<number, NewsItem[]>();
  for (let i = 0; i < nodes.length; i++) {
    const r = find(i);
    const list = groups.get(r) ?? [];
    list.push(items[i]!);
    groups.set(r, list);
  }
  const out: NewsItem[] = [];
  for (const members of groups.values()) {
    members.sort(primaryOrder);
    const [first, ...rest] = members;
    const primary: NewsItem = { ...first!, seriesIds: [...first!.seriesIds], ...(first!.alsoIn ? { alsoIn: [...first!.alsoIn] } : {}) };
    for (const m of rest) absorb(primary, m, true);
    out.push(primary);
  }
  return out;
}
