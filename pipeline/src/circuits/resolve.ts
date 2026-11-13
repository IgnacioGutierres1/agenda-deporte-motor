/**
 * Arma la ficha (CircuitInfo) de un lote de circuitos. Todo el lote avanza junto, etapa por etapa, para pedir de
 * a muchos elementos por request (el límite de Wikimedia es por cantidad de requests):
 *   1. búsqueda en Wikidata por la clave del circuito (una por circuito sin identificar), lectura de los
 *      candidatos y elección del elemento (tipo, país, nombre o lugar);
 *   2. ciudad (Open-Meteo) de los que no aparecieron: si el "circuito" es el nombre de una ciudad, se busca el
 *      circuito que está cerca de ella; si tampoco, quedan las coordenadas aproximadas de la ciudad;
 *   3. Wikipedia en español e inglés (extracto y ficha del artículo) y Commons (foto y plano con su atribución).
 * Si una request falla, falla el lote entero (el que llama conserva lo que tenía).
 */
import { circuitKey, type CircuitImage, type CircuitInfo } from '@dm/shared';
import type { Logger } from '../core/log.ts';
import type { Api } from './api.ts';
import { fetchImages, fileKey, isDiagramFile, isPhotoFile, isPlanFile } from './commons.ts';
import { cityQueries, geocodeCity, type GeoHit } from './geocode.ts';
import type { CircuitGroup } from './group.ts';
import { findDirection, parseInfobox, type InfoboxData } from './infobox.ts';
import { countryMatches, pickMatch, pickNearby, whyNot, type MatchLevel } from './match.ts';
import type { CircuitOverride } from './overrides.ts';
import { fetchPages, shortExtract, wikiUrl, type WikiPage } from './wikipedia.ts';
import { getEntities, getPlaces, isTrack, searchTracks, searchTracksNear, type WdEntity, type WdPlace } from './wikidata.ts';

export interface ResolveInput {
  group: CircuitGroup;
  override?: CircuitOverride;
  /** Elemento de Wikidata ya identificado en una corrida anterior (se relee sin volver a buscar). */
  knownWikidata?: string;
  /** true si ahí solo corren categorías de rally: el "circuito" es la ciudad base y no se busca un autódromo. */
  cityOnly?: boolean;
}

/** Cómo se llegó al elemento de Wikidata (para la tabla de revisión). */
export type MatchHow = 'manual' | 'anterior' | 'nombre exacto' | 'nombre' | 'lugar' | 'ambiguo' | 'sin buscar' | '-';

export interface CircuitReport {
  id: string;
  name: string;
  country: string;
  how: MatchHow;
  wikidata?: string;
  /** Etiqueta del elemento elegido. */
  label?: string;
  /** País del elemento elegido. */
  entityCountry?: string;
  /** Candidatos válidos entre los que no se pudo decidir. */
  ambiguous?: string[];
  /** Candidatos descartados, con el motivo (cuando no se eligió ninguno). */
  discarded?: string[];
  note?: string;
}

export interface Resolved {
  info: CircuitInfo;
  report: CircuitReport;
}

export interface ResolveOptions {
  nowIso: string;
  log: Logger;
}

const HOW: Record<MatchLevel, MatchHow> = { 3: 'nombre exacto', 2: 'nombre', 1: 'lugar' };
/** Radio en el que se busca "el circuito de la ciudad". */
const NEAR_KM = 25;
/** Nombres que no son el autódromo de la ciudad aunque la nombren. */
const NOT_THE_CITY_TRACK = /callejer|street|urbano|kart|\bcity\b|\bstadium\b|\bestadio\b/i;

interface Work {
  input: ResolveInput;
  how: MatchHow;
  /** Ids candidatos, en el orden de las búsquedas. */
  candidates: string[];
  entity?: WdEntity;
  ambiguous?: WdEntity[];
  geo?: GeoHit;
  note?: string;
}

export async function resolveCircuits(api: Api, inputs: ResolveInput[], opts: ResolveOptions): Promise<Resolved[]> {
  const { log } = opts;
  const work: Work[] = inputs.map((input) => ({ input, how: '-', candidates: [] }));
  // Elemento ya decidido: el indicado a mano o el de una corrida anterior (null a mano = "no buscar").
  const fixedId = (w: Work): string | undefined => {
    const manual = w.input.override?.wikidata;
    return manual === null ? undefined : (manual ?? w.input.knownWikidata);
  };
  const searchable = (w: Work) => !fixedId(w) && w.input.override?.wikidata !== null && !w.input.cityOnly;

  // 1. Búsqueda entre los circuitos de Wikidata por la clave ("termas rio hondo").
  for (const w of work) {
    if (!searchable(w)) {
      if (!fixedId(w)) w.how = 'sin buscar';
      continue;
    }
    w.candidates = await searchTracks(api, searchKey(w.input.group.key));
  }
  const entities = await getEntities(api, work.flatMap((w) => [...w.candidates, ...(fixedId(w) ? [fixedId(w)!] : [])]));
  const places = new Map<string, WdPlace>();
  const loadPlaces = async (list: WdEntity[]) => {
    const ids = list.flatMap((e) => [...e.countries, ...(e.locatedIn ? [e.locatedIn] : [])]).filter((id) => !places.has(id));
    for (const [id, p] of await getPlaces(api, ids)) places.set(id, p);
  };
  await loadPlaces([...new Set(entities.values())].filter((e) => isTrack(e) || work.some((w) => fixedId(w) === e.id)));

  const choose = (w: Work) => {
    const outcome = pickMatch(
      { key: searchKey(w.input.group.key), country: w.input.group.country },
      w.candidates.map((id) => entities.get(id)).filter((e): e is WdEntity => !!e),
      places,
    );
    if (outcome.match) {
      w.entity = outcome.match.entity;
      w.how = HOW[outcome.match.level];
      w.ambiguous = undefined;
    } else if (outcome.ambiguous) {
      w.ambiguous = outcome.ambiguous;
      w.how = 'ambiguo';
    }
  };

  for (const w of work) {
    const id = fixedId(w);
    if (!id) {
      if (searchable(w)) choose(w);
      continue;
    }
    const manual = !!w.input.override?.wikidata;
    const entity = entities.get(id);
    if (!entity) {
      w.note = `Wikidata no devolvió ${id}`;
      log.warn(`${w.input.group.id}: ${w.note}`);
      continue;
    }
    w.entity = entity;
    w.how = manual ? 'manual' : 'anterior';
    // Un elemento indicado a mano no se discute, pero se avisa si no parece un circuito de ese país.
    if (manual && !isTrack(entity)) w.note = 'el elemento indicado no figura como circuito en Wikidata';
    else if (manual && countryMatches(w.input.group.country, entity, places) === false) w.note = 'el elemento indicado es de otro país';
    if (w.note) log.warn(`${w.input.group.id} (${id}): ${w.note}`);
  }

  // 2. Ciudad de los que no aparecieron o no tienen coordenadas (Open-Meteo). Muchos "circuitos" se publican con
  //    el nombre de la ciudad ("Junín", "Salta"): se busca el circuito de ese país que está cerca de ella.
  const geocode = async (w: Work) => {
    const placeLabel = w.entity?.locatedIn ? places.get(w.entity.locatedIn)?.label : undefined;
    const city = w.input.override?.city;
    const queries = city ? [city] : [...(placeLabel ? [placeLabel] : []), ...cityQueries(w.input.group.name)];
    for (const query of queries) {
      const hit = await geocodeCity(api, query, w.input.group.country);
      if (hit) return hit;
    }
    return undefined;
  };
  const nearby = new Map<Work, string[]>();
  for (const w of work) {
    if (w.input.override?.lat !== undefined || w.entity?.lat !== undefined) continue;
    w.geo = await geocode(w);
    // Un callejero o un kartódromo no es "el autódromo de la ciudad": ahí no se busca por cercanía.
    if (!w.geo || w.entity || w.ambiguous || !searchable(w) || NOT_THE_CITY_TRACK.test(w.input.group.name)) continue;
    nearby.set(w, await searchTracksNear(api, w.geo.lat, w.geo.lon, NEAR_KM));
  }
  if (nearby.size) {
    const fresh = await getEntities(api, [...nearby.values()].flat().filter((id) => !entities.has(id)));
    for (const [id, e] of fresh) entities.set(id, e);
    await loadPlaces([...new Set(fresh.values())].filter(isTrack));
    for (const [w, ids] of nearby) {
      const found = ids.map((id) => entities.get(id)).filter((e): e is WdEntity => !!e);
      const outcome = pickNearby(w.input.group.country, w.geo!, found, places, NEAR_KM);
      w.candidates.push(...ids.filter((id) => !w.candidates.includes(id)));
      if (outcome.match) {
        w.entity = outcome.match.entity;
        w.how = 'lugar';
        // Las coordenadas del circuito reemplazan a las de la ciudad.
        if (w.entity.lat !== undefined) w.geo = undefined;
      } else if (outcome.ambiguous) {
        w.ambiguous = outcome.ambiguous;
        w.how = 'ambiguo';
      }
    }
  }

  // 3. Wikipedia (extracto y ficha del artículo) y Commons (foto y plano).
  const withEntity = work.filter((w) => w.entity);
  const titles = (site: 'eswiki' | 'enwiki') => withEntity.map((w) => w.entity![site]).filter((t): t is string => !!t);
  const esPages = await fetchPages(api, 'es', titles('eswiki'));
  const enPages = await fetchPages(api, 'en', titles('enwiki'));

  const articles = new Map<Work, Article>();
  for (const w of withEntity) {
    const es = w.entity!.eswiki ? esPages.get(w.entity!.eswiki) : undefined;
    const en = w.entity!.enwiki ? enPages.get(w.entity!.enwiki) : undefined;
    articles.set(w, {
      es,
      en,
      esBox: es?.wikitext ? parseInfobox(es.wikitext) : undefined,
      enBox: en?.wikitext ? parseInfobox(en.wikitext) : undefined,
    });
  }
  const wanted = new Map<Work, { maps: string[]; photos: string[] }>();
  for (const w of withEntity) wanted.set(w, imageCandidates(w.entity!, articles.get(w)!));
  const images = await fetchImages(api, [...wanted.values()].flatMap((c) => [...c.maps, ...c.photos]));

  return work.map((w) => {
    const article = articles.get(w);
    const files = wanted.get(w);
    const pick = (names: string[] | undefined) => {
      for (const n of names ?? []) {
        const image = images.get(fileKey(n));
        if (image) return image;
      }
      return undefined;
    };
    const map = pick(files?.maps);
    // La misma imagen no va como plano y como foto (los planos que no entraron entre los candidatos a plano).
    const photo = pick(files?.photos?.filter((n) => !map || images.get(fileKey(n))?.page !== map.page));
    const info = assemble(w, places, article, map, photo, opts.nowIso);
    return { info, report: report(w, places, entities) };
  });
}

/**
 * Clave para buscar y comparar: la del circuito sin el año que algunas categorías agregan al nombre de la
 * carrera ("Michelin 24H Barcelona 2027" -> "barcelona").
 */
export function searchKey(key: string): string {
  const words = key.split(' ').filter((w) => !/^(19|20)\d\d$/.test(w));
  return words.length ? circuitKey(words.join(' ')) || key : key;
}

interface Article {
  es?: WikiPage;
  en?: WikiPage;
  esBox?: InfoboxData;
  enBox?: InfoboxData;
}

/**
 * Archivos a consultar en Commons, en orden de preferencia.
 * Plano: P15 o, si no hay, la imagen de la ficha o la principal del artículo cuando el nombre indica un plano
 * (o, en la ficha, un PNG/GIF: la imagen de la ficha de un circuito es el plano).
 * Foto: P18 (si no es un plano) o la primera imagen del artículo que parezca una foto.
 */
export function imageCandidates(entity: WdEntity, article: Article): { maps: string[]; photos: string[] } {
  const fromArticles = [
    ...(article.enBox?.images ?? []),
    ...(article.en?.image ? [article.en.image] : []),
    ...(article.esBox?.images ?? []),
    ...(article.es?.image ? [article.es.image] : []),
  ];
  const unique = (list: Array<string | undefined>) => {
    const seen = new Set<string>();
    return list.filter((n): n is string => {
      const key = n ? fileKey(n) : '';
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };
  const all = [...fromArticles, entity.image];
  const boxImages = [...(article.enBox?.images ?? []), ...(article.esBox?.images ?? [])];
  const maps = unique([
    entity.routeMap,
    ...all.filter((n) => n && isPlanFile(n)),
    ...boxImages.filter(isDiagramFile),
  ]).slice(0, 3);
  // Lo que va como plano no se repite como foto.
  const mapKeys = new Set(maps.map(fileKey));
  const photos = unique([entity.image, ...fromArticles].filter((n) => n && isPhotoFile(n) && !mapKeys.has(fileKey(n))));
  return { maps, photos: photos.slice(0, 2) };
}

function assemble(
  w: Work,
  places: Map<string, WdPlace>,
  article: Article | undefined,
  map: CircuitImage | undefined,
  photo: CircuitImage | undefined,
  nowIso: string,
): CircuitInfo {
  const { group, override } = w.input;
  const e = w.entity;
  const info: CircuitInfo = {
    id: group.id,
    // Algunas etiquetas de Wikidata van en minúscula ("circuito callejero de Detroit"): se muestra con mayúscula.
    name: override?.name ?? capitalize(e?.labels.es ?? e?.labels.en ?? e?.labels.mul ?? group.name),
    checkedAt: nowIso,
  };
  if (e) info.wikidata = e.id;

  if (override?.lat !== undefined && override.lon !== undefined) {
    info.lat = override.lat;
    info.lon = override.lon;
  } else if (e?.lat !== undefined && e.lon !== undefined) {
    info.lat = e.lat;
    info.lon = e.lon;
  } else if (w.geo) {
    info.lat = w.geo.lat;
    info.lon = w.geo.lon;
    info.coordsApprox = true;
  }

  const en = article?.enBox;
  const es = article?.esBox;
  // Localidad: la de la ficha del artículo (en Wikidata P131 a veces es la provincia o el estado).
  const city =
    override?.city?.split(',')[0]?.trim() ||
    es?.city ||
    en?.city ||
    (e?.locatedIn ? places.get(e.locatedIn)?.label : undefined) ||
    w.geo?.name;
  if (city) info.city = city;

  const set = <K extends keyof CircuitInfo>(key: K, value: CircuitInfo[K] | undefined) => {
    if (value !== undefined) info[key] = value;
  };
  set('lengthM', e?.lengthM ?? en?.lengthM ?? es?.lengthM);
  set('turns', en?.turns ?? es?.turns);
  set('opened', e?.opened ?? en?.opened ?? es?.opened);
  set('capacity', e?.capacity ?? en?.capacity ?? es?.capacity);
  set('elevationM', e?.elevationM);
  // El sentido de giro solo si las dos Wikipedias no se contradicen.
  const dirEn = article?.en?.wikitext ? findDirection(article.en.wikitext) : undefined;
  const dirEs = article?.es?.wikitext ? findDirection(article.es.wikitext) : undefined;
  if (!(dirEn && dirEs && dirEn !== dirEs)) set('direction', dirEn ?? dirEs);
  set('lapRecord', en?.lapRecord ?? es?.lapRecord);

  const summaryEs = shortExtract(article?.es?.extract);
  const summaryEn = summaryEs ? undefined : shortExtract(article?.en?.extract);
  if (summaryEs ?? summaryEn) {
    info.summary = summaryEs ?? summaryEn;
    info.summaryLang = summaryEs ? 'es' : 'en';
  }
  set('website', e?.website);
  if (e?.eswiki && article?.es) info.wikipediaUrl = wikiUrl('es', article.es.title);
  else if (e?.enwiki && article?.en) info.wikipediaUrl = wikiUrl('en', article.en.title);
  set('photo', photo);
  set('map', map);
  return ordered(info);
}

const FIELD_ORDER: Array<keyof CircuitInfo> = [
  'id',
  'name',
  'wikidata',
  'lat',
  'lon',
  'coordsApprox',
  'city',
  'lengthM',
  'turns',
  'opened',
  'capacity',
  'elevationM',
  'direction',
  'lapRecord',
  'summary',
  'summaryLang',
  'website',
  'wikipediaUrl',
  'photo',
  'map',
  'hasTrack',
  'checkedAt',
];

/** Mismo orden de campos siempre (para que el JSON cambie solo cuando cambian los datos). */
export function ordered(info: CircuitInfo): CircuitInfo {
  const out: Record<string, unknown> = {};
  for (const key of FIELD_ORDER) if (info[key] !== undefined) out[key] = info[key];
  return out as unknown as CircuitInfo;
}

function report(w: Work, places: Map<string, WdPlace>, entities: Map<string, WdEntity>): CircuitReport {
  const { group } = w.input;
  const e = w.entity;
  const label = (x: WdEntity) => x.labels.es ?? x.labels.en ?? x.labels.mul ?? x.names[0] ?? '';
  const r: CircuitReport = { id: group.id, name: group.name, country: group.country, how: w.how };
  if (e) {
    r.wikidata = e.id;
    r.label = label(e);
    r.entityCountry = e.countries.map((id) => places.get(id)?.label ?? id).join('/');
  } else if (w.ambiguous) {
    r.ambiguous = w.ambiguous.map((a) => `${a.id} ${label(a)}`.trim());
  } else {
    const key = { key: searchKey(group.key), country: group.country };
    const discarded = w.candidates
      .map((id) => entities.get(id))
      .filter((x): x is WdEntity => !!x)
      .map((x) => `${x.id} ${label(x)} (${whyNot(key, x, places)})`);
    if (discarded.length) r.discarded = discarded;
  }
  if (w.note) r.note = w.note;
  return r;
}

function capitalize(text: string): string {
  return text ? text[0]!.toLocaleUpperCase('es') + text.slice(1) : text;
}
