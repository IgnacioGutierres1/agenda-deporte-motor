/**
 * Datos de la ficha que salen de Wikidata (una consulta SPARQL por lote): fecha y lugar de nacimiento, nacionalidad
 * (etiquetas en español), foto (P18) y enlaces oficiales y redes.
 */
import type { Api } from '../circuits/api.ts';
import { fileKey } from '../circuits/commons.ts';

const SPARQL = 'https://query.wikidata.org/sparql';

export interface PersonDetails {
  qid: string;
  /** YYYY-MM-DD, solo si Wikidata tiene el día. */
  birthDate?: string;
  birthPlace?: string;
  /** Etiqueta en español y país (ISO) de cada nacionalidad: primero la deportiva (P1532), después la ciudadanía. */
  nationalities: Array<{ label: string; iso?: string; sport: boolean }>;
  /** País (ISO) del lugar de nacimiento, para elegir entre varias ciudadanías. */
  birthIso?: string;
  /** Archivos de Commons (P18). */
  images: string[];
  links: { label: string; url: string }[];
}

export function detailsQuery(qids: string[]): string {
  return `SELECT ?item ?birth ?prec ?place ?placeLabel ?pc ?pcLabel ?pcIso ?sport ?sportLabel ?sportIso ?cit ?citLabel ?citIso
 ?image ?website ?instagram ?x ?facebook ?youtube ?tiktok WHERE {
VALUES ?item { ${qids.map((q) => `wd:${q}`).join(' ')} }
OPTIONAL { ?item p:P569 [ a wikibase:BestRank ; psv:P569 [ wikibase:timeValue ?birth ; wikibase:timePrecision ?prec ] ] }
OPTIONAL { ?item wdt:P19 ?place . OPTIONAL { ?place wdt:P17 ?pc . OPTIONAL { ?pc wdt:P297 ?pcIso } } }
OPTIONAL { ?item wdt:P1532 ?sport . OPTIONAL { ?sport wdt:P297 ?sportIso } }
OPTIONAL { ?item wdt:P27 ?cit . OPTIONAL { ?cit wdt:P297 ?citIso } }
OPTIONAL { ?item wdt:P18 ?image }
OPTIONAL { ?item wdt:P856 ?website }
OPTIONAL { ?item wdt:P2003 ?instagram }
OPTIONAL { ?item wdt:P2002 ?x }
OPTIONAL { ?item wdt:P2013 ?facebook }
OPTIONAL { ?item wdt:P2397 ?youtube }
OPTIONAL { ?item wdt:P7085 ?tiktok }
SERVICE wikibase:label { bd:serviceParam wikibase:language "es,en". }
}`;
}

type Binding = Record<string, { value?: string } | undefined>;

const v = (b: Binding, k: string): string | undefined => {
  const x = b[k]?.value;
  return typeof x === 'string' && x.trim() ? x.trim() : undefined;
};
const qidOf = (uri: string | undefined): string | undefined => (uri ? /\/(Q\d+)$/.exec(uri)?.[1] : undefined);
/** Etiqueta real (el servicio de etiquetas devuelve el Q-id cuando no hay etiqueta en español ni en inglés). */
const label = (b: Binding, k: string): string | undefined => {
  const l = v(b, k);
  return l && !/^Q\d+$/.test(l) ? l : undefined;
};

/** Nombre de archivo de un valor de P18 ("http://commons.wikimedia.org/wiki/Special:FilePath/Foo%20bar.jpg"). */
export function commonsFile(uri: string): string | undefined {
  const m = /Special:FilePath\/(.+)$/.exec(uri);
  if (!m) return undefined;
  try {
    return fileKey(decodeURIComponent(m[1]!));
  } catch {
    return undefined;
  }
}

const LINKS: Array<[key: string, label: string, url: (id: string) => string | undefined]> = [
  ['website', 'Sitio oficial', (u) => (/^https?:\/\/\S+$/.test(u) ? u : undefined)],
  ['instagram', 'Instagram', (u) => (/^[\w.]+$/.test(u) ? `https://www.instagram.com/${u}/` : undefined)],
  ['x', 'X', (u) => (/^\w+$/.test(u) ? `https://x.com/${u}` : undefined)],
  ['facebook', 'Facebook', (u) => (/^[\w.-]+$/.test(u) ? `https://www.facebook.com/${u}` : undefined)],
  ['youtube', 'YouTube', (u) => (/^UC[\w-]+$/.test(u) ? `https://www.youtube.com/channel/${u}` : undefined)],
  ['tiktok', 'TikTok', (u) => (/^[\w.]+$/.test(u) ? `https://www.tiktok.com/@${u}` : undefined)],
];

export async function fetchDetails(api: Api, qids: string[]): Promise<Map<string, PersonDetails>> {
  const out = new Map<string, PersonDetails>();
  const unique = [...new Set(qids)];
  for (let i = 0; i < unique.length; i += 40) {
    const chunk = unique.slice(i, i + 40);
    const url = `${SPARQL}?format=json&query=${encodeURIComponent(detailsQuery(chunk).replace(/\s+/g, ' '))}`;
    const res = await api.get<{ results?: { bindings?: Binding[] } }>(url);
    const rows = new Map<string, Binding[]>();
    for (const b of res.results?.bindings ?? []) {
      const qid = qidOf(v(b, 'item'));
      if (qid) rows.set(qid, [...(rows.get(qid) ?? []), b]);
    }
    for (const [qid, bs] of rows) out.set(qid, readDetails(qid, bs));
  }
  return out;
}

export function readDetails(qid: string, bs: Binding[]): PersonDetails {
  const d: PersonDetails = { qid, nationalities: [], images: [], links: [] };
  // Fecha con precisión de día (11): las de solo año o mes no se publican.
  const birth = bs.map((b) => ({ t: v(b, 'birth'), p: Number(v(b, 'prec')) })).find((x) => x.t && x.p >= 11);
  const date = birth?.t ? /^(\d{4}-\d{2}-\d{2})T/.exec(birth.t)?.[1] : undefined;
  if (date) d.birthDate = date;

  const place = bs.map((b) => ({ place: label(b, 'placeLabel'), country: label(b, 'pcLabel'), iso: v(b, 'pcIso') })).find((x) => x.place);
  if (place?.place) {
    d.birthPlace = place.country && place.country !== place.place ? `${place.place}, ${place.country}` : place.place;
    if (place.iso) d.birthIso = place.iso;
  }

  const seen = new Set<string>();
  const addNat = (l: string | undefined, iso: string | undefined, sport: boolean) => {
    if (!l || seen.has(l)) return;
    seen.add(l);
    d.nationalities.push(iso ? { label: l, iso, sport } : { label: l, sport });
  };
  for (const b of bs) addNat(label(b, 'sportLabel'), v(b, 'sportIso'), true);
  for (const b of bs) addNat(label(b, 'citLabel'), v(b, 'citIso'), false);

  d.images = [...new Set(bs.map((b) => v(b, 'image')).filter((x): x is string => !!x).map(commonsFile).filter((x): x is string => !!x))];

  for (const [key, l, build] of LINKS) {
    const value = bs.map((b) => v(b, key)).find(Boolean);
    const url = value ? build(value) : undefined;
    if (url) d.links.push({ label: l, url });
  }
  return d;
}

/** Nacionalidad a mostrar: la deportiva; si no hay, la ciudadanía del país publicado, la del lugar de nacimiento o la primera. */
export function nationalityOf(d: PersonDetails, iso: string | undefined): string | undefined {
  const sport = d.nationalities.find((n) => n.sport);
  if (sport) return sport.label;
  const cits = d.nationalities.filter((n) => !n.sport);
  return (
    (iso && cits.find((n) => n.iso === iso)?.label) ??
    (d.birthIso && cits.find((n) => n.iso === d.birthIso)?.label) ??
    cits[0]?.label
  );
}

/** Foto a usar entre varias (P18): la del año más reciente en el nombre del archivo, si lo dice. */
export function pickImage(files: string[]): string | undefined {
  const year = (f: string) => Math.max(0, ...[...f.matchAll(/(?:^|\D)((?:19|20)\d{2})(?!\d)/g)].map((m) => Number(m[1])));
  return [...files].sort((a, b) => year(b) - year(a) || a.localeCompare(b))[0];
}
