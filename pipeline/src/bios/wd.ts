/**
 * Lecturas de Wikidata y Wikipedia para el historial de equipos y categorías (tanda 5), con el cliente de
 * Wikimedia de los circuitos (circuits/api.ts: una request por vez, pausa entre requests y respeto de los 429).
 *  - sparql: consultas al servicio SPARQL (una sola request trae cientos de elementos).
 *  - getItems: wbgetentities de a 50, con etiquetas en español e inglés, claims y artículos.
 *  - fetchSummaries: introducción en texto plano de hasta 20 artículos por request.
 *  - labelsOf: etiquetas en español (o inglés) y país de varios elementos en una consulta SPARQL.
 */
import type { BioSummary } from '@dm/shared';
import type { Api } from '../circuits/api.ts';
import { shortExtract, wikiUrl, type WikiLang } from '../circuits/wikipedia.ts';

const SPARQL = 'https://query.wikidata.org/sparql';
const WD_API = 'https://www.wikidata.org/w/api.php';
const BATCH = 50;

type Rec = Record<string, unknown>;

export function asRecord(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

export function isQid(id: unknown): id is string {
  return typeof id === 'string' && /^Q\d+$/.test(id);
}

/** "http://www.wikidata.org/entity/Q42" -> "Q42" */
export function qidOf(uri: string | undefined): string | undefined {
  const m = uri ? /\/entity\/(Q\d+)$/.exec(uri) : null;
  return m?.[1];
}

export type SparqlRow = Record<string, string>;

/** Filas de una consulta SPARQL, con el valor de cada variable como texto (las URI de elementos, tal cual). */
export async function sparql(api: Api, query: string): Promise<SparqlRow[]> {
  const url = `${SPARQL}?format=json&query=${encodeURIComponent(query.replace(/\s+/g, ' ').trim())}`;
  const res = await api.get<{ results?: { bindings?: Array<Record<string, { value?: string }>> } }>(url);
  return (res.results?.bindings ?? []).map((b) => {
    const row: SparqlRow = {};
    for (const [k, v] of Object.entries(b)) if (typeof v?.value === 'string') row[k] = v.value;
    return row;
  });
}

// ── Elementos ──

export interface WdItem {
  id: string;
  /** Etiquetas en español e inglés. */
  labels: { es?: string; en?: string };
  claims: Rec;
  /** Título del artículo en Wikipedia en español e inglés. */
  eswiki?: string;
  enwiki?: string;
  sitelinks: number;
}

/** Elementos por id (los inexistentes no vuelven; un redirigido queda también bajo el id pedido). */
export async function getItems(api: Api, ids: string[]): Promise<Map<string, WdItem>> {
  const out = new Map<string, WdItem>();
  const unique = [...new Set(ids.filter(isQid))];
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const url = `${WD_API}?action=wbgetentities&ids=${chunk.join('%7C')}&props=labels%7Cclaims%7Csitelinks&languages=es%7Cen&format=json`;
    const res = await api.get<{ entities?: Record<string, unknown> }>(url);
    for (const [key, raw] of Object.entries(res.entities ?? {})) {
      const item = parseItem(raw);
      if (!item) continue;
      out.set(item.id, item);
      if (key !== item.id) out.set(key, item);
      const from = asRecord(asRecord(raw)?.redirects)?.from;
      if (typeof from === 'string') out.set(from, item);
    }
  }
  return out;
}

export function parseItem(raw: unknown): WdItem | null {
  const e = asRecord(raw);
  if (!e || !isQid(e.id) || 'missing' in e) return null;
  const labels: WdItem['labels'] = {};
  for (const lang of ['es', 'en'] as const) {
    const v = asRecord(asRecord(e.labels)?.[lang])?.value;
    if (typeof v === 'string' && v.trim()) labels[lang] = v.trim();
  }
  const sitelinks = asRecord(e.sitelinks) ?? {};
  const title = (site: string) => {
    const t = asRecord(sitelinks[site])?.title;
    return typeof t === 'string' && t ? t : undefined;
  };
  const item: WdItem = { id: e.id, labels, claims: asRecord(e.claims) ?? {}, sitelinks: Object.keys(sitelinks).length };
  const es = title('eswiki');
  const en = title('enwiki');
  if (es) item.eswiki = es;
  if (en) item.enwiki = en;
  return item;
}

// ── Claims ──

/** Una declaración utilizable (no obsoleta, con valor) con sus fechas de inicio y fin. */
export interface Statement {
  value: unknown;
  rank: string;
  /** "+2005-00-00T00:00:00Z" o '' si no tiene. */
  start: string;
  end: string;
  qualifiers: Rec;
}

function qualifierTime(claim: Rec, prop: string): string {
  const list = asRecord(claim.qualifiers)?.[prop];
  const time = Array.isArray(list) ? asRecord(asRecord(asRecord(list[0])?.datavalue)?.value)?.time : undefined;
  return typeof time === 'string' ? time : '';
}

/** Todas las declaraciones utilizables de una propiedad, en el orden de Wikidata. */
export function statements(claims: Rec, prop: string): Statement[] {
  const list = claims[prop];
  if (!Array.isArray(list)) return [];
  return list
    .map(asRecord)
    .filter((c): c is Rec => !!c && c.rank !== 'deprecated' && asRecord(c.mainsnak)?.snaktype === 'value')
    .map((c) => ({
      value: asRecord(asRecord(c.mainsnak)?.datavalue)?.value,
      rank: String(c.rank ?? 'normal'),
      start: qualifierTime(c, 'P580'),
      end: qualifierTime(c, 'P582'),
      qualifiers: asRecord(c.qualifiers) ?? {},
    }));
}

/**
 * Valores vigentes: los preferidos si hay; si no, los normales; sin los que tienen fecha de fin (salvo que no
 * quede otro), los de inicio más reciente primero.
 */
export function currentValues(claims: Rec, prop: string): unknown[] {
  const all = statements(claims, prop);
  const preferred = all.filter((s) => s.rank === 'preferred');
  const ranked = preferred.length ? preferred : all;
  const open = ranked.filter((s) => !s.end);
  return (open.length ? open : ranked)
    .map((s, i) => ({ s, i }))
    .sort((a, b) => b.s.start.localeCompare(a.s.start) || a.i - b.i)
    .map(({ s }) => s.value);
}

export function itemIds(claims: Rec, prop: string, current = true): string[] {
  const vals = current ? currentValues(claims, prop) : statements(claims, prop).map((s) => s.value);
  return vals.map((v) => asRecord(v)?.id).filter(isQid);
}

export function firstString(claims: Rec, prop: string): string | undefined {
  const v = currentValues(claims, prop).find((x): x is string => typeof x === 'string' && !!x.trim());
  return v?.trim();
}

/** Año de una fecha de Wikidata ("+1950-05-13T00:00:00Z" -> 1950). */
export function yearOf(time: unknown): number | undefined {
  const m = typeof time === 'string' ? /^([+-])(\d{4,})-/.exec(time) : null;
  if (!m) return undefined;
  const y = Number(m[2]) * (m[1] === '-' ? -1 : 1);
  return y > 0 ? y : undefined;
}

/** Año de la primera fecha de la propiedad (la más vieja, para "fundación"). */
export function earliestYear(claims: Rec, prop: string): number | undefined {
  const years = statements(claims, prop)
    .map((s) => yearOf(asRecord(s.value)?.time))
    .filter((y): y is number => y !== undefined);
  return years.length ? Math.min(...years) : undefined;
}

// ── Etiquetas ──

export interface WdLabel {
  label: string;
  /** País del elemento (P17), si tiene. */
  country?: string;
}

/**
 * Etiqueta en español (o, si no hay, en inglés) de cada elemento, y la de su país actual (P17, sin los países
 * disueltos como el Reino de Inglaterra) cuando lo tiene: sirve
 * para sedes ("Brackley" + "Reino Unido"), países, personas y categorías. Una consulta cada 150 elementos.
 */
export async function labelsOf(api: Api, ids: string[]): Promise<Map<string, WdLabel>> {
  const out = new Map<string, WdLabel>();
  const unique = [...new Set(ids.filter(isQid))];
  for (let i = 0; i < unique.length; i += 150) {
    const chunk = unique.slice(i, i + 150);
    const rows = await sparql(
      api,
      `SELECT ?x ?es ?en ?ces ?cen WHERE {
        VALUES ?x { ${chunk.map((q) => `wd:${q}`).join(' ')} }
        OPTIONAL { ?x rdfs:label ?es FILTER(LANG(?es) = "es") }
        OPTIONAL { ?x rdfs:label ?en FILTER(LANG(?en) = "en") }
        OPTIONAL { ?x wdt:P17 ?c . FILTER NOT EXISTS { ?c wdt:P576 ?fin } ?c rdfs:label ?ces FILTER(LANG(?ces) = "es") }
        OPTIONAL { ?x wdt:P17 ?c2 . FILTER NOT EXISTS { ?c2 wdt:P576 ?fin2 } ?c2 rdfs:label ?cen FILTER(LANG(?cen) = "en") }
      }`,
    );
    for (const r of rows) {
      const id = qidOf(r.x);
      const label = r.es ?? r.en;
      if (!id || !label || out.has(id)) continue;
      const country = r.ces ?? r.cen;
      out.set(id, country && country !== label ? { label, country } : { label });
    }
  }
  return out;
}

// ── Wikipedia ──

interface ExtractPage {
  title?: string;
  missing?: boolean;
  extract?: string;
}

/**
 * Introducción en texto plano de varios artículos (20 por request). Devuelve el extracto por título pedido
 * (siguiendo normalizaciones y redirecciones).
 */
export async function fetchExtracts(api: Api, lang: WikiLang, titles: string[]): Promise<Map<string, { title: string; extract: string }>> {
  const out = new Map<string, { title: string; extract: string }>();
  const unique = [...new Set(titles.map((t) => t.trim()).filter(Boolean))];
  for (let i = 0; i < unique.length; i += 20) {
    const chunk = unique.slice(i, i + 20);
    const url =
      `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(chunk.join('|'))}` +
      '&prop=extracts&exintro=1&explaintext=1&exlimit=max&redirects=1&format=json&formatversion=2';
    const res = await api.get<{
      query?: { normalized?: Array<{ from: string; to: string }>; redirects?: Array<{ from: string; to: string }>; pages?: ExtractPage[] };
    }>(url);
    const alias = new Map<string, string>();
    for (const r of [...(res.query?.normalized ?? []), ...(res.query?.redirects ?? [])]) alias.set(r.from, r.to);
    const byTitle = new Map<string, string>();
    for (const p of res.query?.pages ?? []) if (p.title && !p.missing && p.extract) byTitle.set(p.title, p.extract);
    for (const asked of chunk) {
      let title = asked;
      for (let hop = 0; hop < 3 && alias.has(title); hop++) title = alias.get(title)!;
      const extract = byTitle.get(title);
      if (extract) out.set(asked, { title, extract });
    }
  }
  return out;
}

/**
 * Resumen de uno o dos párrafos: el primero y, si es corto, también el segundo (cada uno recortado en un final
 * de oración). Sin texto útil devuelve undefined.
 */
export function summaryText(extract: string | undefined, max = 700): string | undefined {
  if (!extract) return undefined;
  const paragraphs = extract
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 40 && !/^(?:=+|Coordenadas|Coordinates)/.test(p));
  const first = shortExtract(paragraphs[0], max);
  if (!first) return undefined;
  if (first.length >= 280 || !paragraphs[1] || first.endsWith('…')) return first;
  const second = shortExtract(paragraphs[1], max - first.length - 2);
  return second && !second.endsWith('…') ? `${first}\n\n${second}` : first;
}

/**
 * Resumen en español si hay artículo; si no, en inglés. Recibe los extractos ya pedidos (por título) y los
 * títulos del elemento.
 */
export function pickSummary(
  titles: { eswiki?: string; enwiki?: string },
  es: Map<string, { title: string; extract: string }>,
  en: Map<string, { title: string; extract: string }>,
): BioSummary | undefined {
  for (const [lang, title, pages] of [
    ['es', titles.eswiki, es],
    ['en', titles.enwiki, en],
  ] as const) {
    const page = title ? pages.get(title) : undefined;
    const text = summaryText(page?.extract);
    if (page && text) return { text, lang, url: wikiUrl(lang, page.title) };
  }
  return undefined;
}
