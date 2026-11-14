/**
 * Identificación de un piloto en Wikidata. Se busca su nombre (consulta SPARQL agrupada que usa la búsqueda de
 * Wikidata, la misma que wbsearchentities: tolera acentos faltantes y mayúsculas) entre las personas cuya ocupación
 * es piloto de carreras, motociclista o copiloto (o subclases), o cuyo deporte es el automovilismo. Después se elige
 * un candidato SOLO si es seguro (chooseCandidate): mejor sin ficha que con la de un homónimo.
 */
import { baseDriverId } from '@dm/shared';
import type { Api } from '../circuits/api.ts';

const SPARQL = 'https://query.wikidata.org/sparql';
/** Largo máximo de la URL de una consulta (WDQS rechaza las GET muy largas). */
const MAX_URL = 6000;

/** Ocupaciones (y sus subclases) o deporte que valen como piloto. */
const RACING_FILTER =
  'FILTER EXISTS { { ?item wdt:P106/wdt:P279* wd:Q378622 } UNION { ?item wdt:P106/wdt:P279* wd:Q3014296 } ' +
  'UNION { ?item wdt:P106/wdt:P279* wd:Q2465611 } UNION { ?item wdt:P641/wdt:P279* wd:Q5367 } }';

export interface Candidate {
  qid: string;
  /** Etiquetas y alias (varios idiomas). */
  names: string[];
  birthYear?: number;
  /** Países (ISO 3166-1 alfa-2) de su ciudadanía y de su nacionalidad deportiva. */
  isos: string[];
  enwiki?: string;
  eswiki?: string;
}

interface SparqlResult {
  results?: { bindings?: Array<Record<string, { value?: string } | undefined>> };
}

function sparqlUrl(query: string): string {
  return `${SPARQL}?format=json&query=${encodeURIComponent(query.replace(/\s+/g, ' '))}`;
}

function val(b: Record<string, { value?: string } | undefined>, key: string): string | undefined {
  const v = b[key]?.value;
  return typeof v === 'string' && v ? v : undefined;
}

const qidOf = (uri: string | undefined): string | undefined => {
  const m = uri ? /\/(Q\d+)$/.exec(uri) : null;
  return m ? m[1] : undefined;
};

/** Título del artículo a partir de su URL ("https://es.wikipedia.org/wiki/Mat%C3%ADas_Rossi" → "Matías Rossi"). */
export function titleFromUrl(url: string | undefined): string | undefined {
  const m = url ? /\/wiki\/(.+)$/.exec(url) : null;
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]!).replace(/_/g, ' ');
  } catch {
    return undefined;
  }
}

export function searchQuery(names: string[]): string {
  return `SELECT ?name ?item WHERE {
VALUES ?name { ${names.map((n) => JSON.stringify(n)).join(' ')} }
VALUES ?lang { "en" "es" }
SERVICE wikibase:mwapi { bd:serviceParam wikibase:api "EntitySearch"; wikibase:endpoint "www.wikidata.org";
  mwapi:search ?name; mwapi:language ?lang; mwapi:limit "15". ?item wikibase:apiOutputItem mwapi:item. }
?item wdt:P31 wd:Q5 .
${RACING_FILTER}
}`;
}

/** Parte una lista en lotes cuya consulta no pase el largo máximo de URL. */
function chunksByUrl<T>(items: T[], build: (chunk: T[]) => string, max = 50): T[][] {
  const out: T[][] = [];
  let chunk: T[] = [];
  for (const item of items) {
    const next = [...chunk, item];
    if (chunk.length && (next.length > max || sparqlUrl(build(next)).length > MAX_URL)) {
      out.push(chunk);
      chunk = [item];
    } else {
      chunk = next;
    }
  }
  if (chunk.length) out.push(chunk);
  return out;
}

/** Ítems de pilotos que la búsqueda de Wikidata devuelve para cada nombre (sin verificar todavía). */
export async function searchNames(api: Api, names: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const unique = [...new Set(names)];
  for (const chunk of chunksByUrl(unique, searchQuery)) {
    const res = await api.get<SparqlResult>(sparqlUrl(searchQuery(chunk)));
    for (const b of res.results?.bindings ?? []) {
      const name = val(b, 'name');
      const qid = qidOf(val(b, 'item'));
      if (!name || !qid) continue;
      const list = out.get(name) ?? [];
      if (!list.includes(qid)) list.push(qid);
      out.set(name, list);
    }
  }
  return out;
}

export function infoQuery(qids: string[]): string {
  return `SELECT ?item (MIN(?birth) AS ?born) (GROUP_CONCAT(DISTINCT ?iso) AS ?isos)
 (GROUP_CONCAT(DISTINCT ?label; separator="|") AS ?labels) (SAMPLE(?en) AS ?enwiki) (SAMPLE(?es) AS ?eswiki) WHERE {
VALUES ?item { ${qids.map((q) => `wd:${q}`).join(' ')} }
OPTIONAL { ?item wdt:P569 ?birth }
OPTIONAL { ?item wdt:P27|wdt:P1532 ?c . ?c wdt:P297 ?iso }
OPTIONAL { ?item rdfs:label|skos:altLabel ?label . FILTER(LANG(?label) IN ("en", "es", "mul", "de", "fr", "it", "pt", "nl")) }
OPTIONAL { ?en schema:about ?item ; schema:isPartOf <https://en.wikipedia.org/> }
OPTIONAL { ?es schema:about ?item ; schema:isPartOf <https://es.wikipedia.org/> }
} GROUP BY ?item`;
}

/** Nombres, año de nacimiento, países y artículos de varios ítems. */
export async function candidateInfo(api: Api, qids: string[]): Promise<Map<string, Candidate>> {
  const out = new Map<string, Candidate>();
  for (const chunk of chunksByUrl([...new Set(qids)], infoQuery, 60)) {
    const res = await api.get<SparqlResult>(sparqlUrl(infoQuery(chunk)));
    for (const b of res.results?.bindings ?? []) {
      const qid = qidOf(val(b, 'item'));
      if (!qid) continue;
      const born = /^(-?\d{4})-/.exec(val(b, 'born') ?? '');
      const c: Candidate = {
        qid,
        names: (val(b, 'labels') ?? '').split('|').filter(Boolean),
        isos: (val(b, 'isos') ?? '').split(/\s+/).filter((x) => /^[A-Z]{2}$/.test(x)),
      };
      if (born) c.birthYear = Number(born[1]);
      const en = titleFromUrl(val(b, 'enwiki'));
      const es = titleFromUrl(val(b, 'eswiki'));
      if (en) c.enwiki = en;
      if (es) c.eswiki = es;
      out.set(qid, c);
    }
  }
  return out;
}

/** true si alguna etiqueta o alias del ítem es el nombre del piloto (mismas palabras, sin acentos ni orden). */
export function sameName(candidate: Candidate, driverName: string): boolean {
  const key = baseDriverId(driverName);
  return !!key && candidate.names.some((n) => baseDriverId(n) === key);
}

// ── Elección ──

/** Lo que se sabe del piloto en la app. */
export interface DriverClues {
  name: string;
  /** País publicado por las listas oficiales, como ISO alfa-2. */
  iso?: string;
  /** Categorías en las que figura (tablas e inscriptos). */
  seriesIds: string[];
}

/** Lo que dicen los artículos de un candidato. */
export interface CandidateEvidence {
  /** Categorías de la app que aparecen en la tabla de trayectoria de su artículo. */
  careerSeries: string[];
  /** El artículo menciona alguna de las categorías o equipos del piloto. */
  mentions: boolean;
}

export interface Choice {
  qid?: string;
  /** Por qué se eligió o se descartó (queda en la caché). */
  reason: string;
  /** Elegido por la trayectoria (evidencia fuerte). */
  strong?: true;
}

/** Un piloto en actividad: nacido entre 1930 y hace 12 años. */
export function plausibleAge(birthYear: number | undefined, now: Date): boolean {
  return birthYear === undefined || (birthYear >= 1930 && birthYear <= now.getUTCFullYear() - 12);
}

/**
 * Elige el ítem del piloto entre los candidatos, solo si es seguro:
 *  - el nombre coincide con una etiqueta o alias, la edad es razonable y tiene artículo en Wikipedia;
 *  - la tabla de trayectoria de su artículo incluye alguna de las categorías del piloto en la app (evidencia
 *    fuerte, la única que vale si hay varios candidatos o si la nacionalidad no coincide); o
 *  - es el único candidato (o el único del país publicado), coincide con la nacionalidad publicada (si la app la
 *    tiene) y su artículo menciona alguna de sus categorías o equipos.
 */
export function chooseCandidate(
  driver: DriverClues,
  candidates: Candidate[],
  evidence: Map<string, CandidateEvidence>,
  now: Date,
): Choice {
  if (!candidates.length) return { reason: 'sin candidatos en Wikidata' };
  const named = candidates.filter((c) => sameName(c, driver.name));
  if (!named.length) return { reason: 'ningún candidato con el mismo nombre' };
  const viable = named.filter((c) => plausibleAge(c.birthYear, now) && (c.enwiki || c.eswiki));
  if (!viable.length) return { reason: 'candidatos sin artículo o con edad imposible' };

  const strong = viable.filter((c) => (evidence.get(c.qid)?.careerSeries ?? []).some((s) => driver.seriesIds.includes(s)));
  if (strong.length === 1) return { qid: strong[0]!.qid, reason: 'trayectoria con sus categorías', strong: true };
  if (strong.length > 1) return { reason: `ambiguo: ${strong.map((c) => c.qid).join(', ')}` };

  const natConflict = (c: Candidate) => !!driver.iso && c.isos.length > 0 && !c.isos.includes(driver.iso);
  const natMatch = (c: Candidate) => !!driver.iso && c.isos.includes(driver.iso);
  // Con evidencia débil, si la app publica el país tiene que coincidir (no alcanza con que Wikidata no lo diga).
  const weak = viable.filter((c) => evidence.get(c.qid)?.mentions && !natConflict(c) && (!driver.iso || natMatch(c)));
  if (weak.length === 1 && (viable.length === 1 || natMatch(weak[0]!))) {
    return { qid: weak[0]!.qid, reason: 'artículo que menciona sus categorías' };
  }
  if (weak.length > 1) return { reason: `ambiguo: ${weak.map((c) => c.qid).join(', ')}` };
  return { reason: 'sin evidencia de que sea el mismo piloto' };
}
