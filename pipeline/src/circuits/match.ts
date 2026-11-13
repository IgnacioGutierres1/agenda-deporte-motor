/**
 * Elige, entre los candidatos de Wikidata, el elemento que corresponde a un circuito del calendario.
 * Precisión antes que cobertura: un circuito mal identificado es peor que uno sin ficha. Para valer, un candidato
 * tiene que ser un circuito (P31), estar en el país del evento (P17) y coincidir por nombre o por lugar; si
 * quedan varios parecidos y ninguno se destaca, no se elige ninguno (se resuelve con config/circuits.json).
 */
import { circuitKey } from '@dm/shared';
import { countryName, normalizeKey } from '../generic/places.ts';
import type { CircuitGroup } from './group.ts';
import { isTrack, type WdEntity, type WdPlace } from './wikidata.ts';

/**
 * Nivel de coincidencia:
 *  3 = el nombre o un alias del elemento da la misma clave que el circuito ("Monza Circuit" -> monza);
 *  2 = todas las palabras de la clave están en el nombre (o al revés: "Chang International Circuit" en
 *      "chang buriram");
 *  1 = la clave es el lugar donde está el circuito ("Olavarría" -> autódromo de Olavarría).
 */
export type MatchLevel = 1 | 2 | 3;

export interface Match {
  entity: WdEntity;
  level: MatchLevel;
}

export interface MatchOutcome {
  match?: Match;
  /** Candidatos válidos entre los que no se pudo decidir. */
  ambiguous?: WdEntity[];
}

/**
 * Otros nombres con que Wikidata informa un país (sus etiquetas no siempre traen el nombre corto) y territorios
 * que informa como parte de otro.
 */
const ALSO_IN: Record<string, string[]> = {
  china: ['republica popular china', 'people s republic of china'],
  macao: ['china', 'republica popular china', 'people s republic of china'],
  'hong kong': ['china', 'republica popular china', 'people s republic of china'],
};

/** Palabras que no distinguen un circuito de otro (para la coincidencia "al revés"). */
const GENERIC = new Set(
  (
    'raceway speedway superspeedway motor motorsport motorsports motorsportpark park ring race racing track course ' +
    'road complex municipal kartodromo callejero urbano city town new old national nacional provincial provincia ' +
    'sports sportsland land arena stadium estadio center centre international'
  ).split(' '),
);

/**
 * true/false si el país del elemento coincide o no con el del evento; null si el evento no informa país (no se
 * puede validar).
 */
export function countryMatches(country: string, entity: WdEntity, places: Map<string, WdPlace>): boolean | null {
  const wanted = new Set([country, countryName(country)].map(normalizeKey).filter(Boolean));
  if (!wanted.size) return null;
  for (const w of [...wanted]) for (const extra of ALSO_IN[w] ?? []) wanted.add(extra);
  return entity.countries.some((id) => (places.get(id)?.names ?? []).some((n) => wanted.has(normalizeKey(n))));
}

function tokens(text: string): string[] {
  return circuitKey(text).split(' ').filter(Boolean);
}

/** Coincidencia por nombre (3 o 2), o 0. */
export function nameLevel(key: string, names: string[]): 0 | 2 | 3 {
  const keyTokens = key.split(' ').filter(Boolean);
  const keySet = new Set(keyTokens);
  let best: 0 | 2 = 0;
  for (const name of names) {
    const have = tokens(name);
    if (!have.length) continue;
    if (have.join(' ') === key) return 3;
    const haveSet = new Set(have);
    if (keyTokens.every((t) => haveSet.has(t))) best = 2;
    // Al revés: el nombre entero está en la clave y aporta al menos una palabra propia.
    else if (have.every((t) => keySet.has(t)) && have.some((t) => t.length >= 4 && !GENERIC.has(t))) best = 2;
  }
  return best;
}

/** true si la clave del circuito es el lugar del elemento (localidad P131 o su descripción). */
export function placeLevel(key: string, entity: WdEntity, places: Map<string, WdPlace>): boolean {
  const keyTokens = key.split(' ').filter(Boolean);
  const texts = [...(entity.locatedIn ? (places.get(entity.locatedIn)?.names ?? []) : []), ...entity.descriptions];
  return texts.some((text) => {
    const have = new Set(tokens(text));
    return keyTokens.every((t) => have.has(t));
  });
}

/** Distancia entre dos puntos, en km. */
export function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Para un "circuito" publicado con el nombre de la ciudad ("Junín", "Salta"): el circuito de ese país que está a
 * menos de `km` de la ciudad. Si hay más de uno vale solo el que es claramente el más conocido.
 */
export function pickNearby(
  country: string,
  center: { lat: number; lon: number },
  candidates: WdEntity[],
  places: Map<string, WdPlace>,
  km = 25,
): MatchOutcome {
  const seen = new Set<string>();
  const near = candidates
    .filter((e) => {
      if (seen.has(e.id) || !isTrack(e) || e.lat === undefined || e.lon === undefined) return false;
      seen.add(e.id);
      return countryMatches(country, e, places) === true && distanceKm(center, { lat: e.lat, lon: e.lon }) <= km;
    })
    .sort((a, b) => b.sitelinks - a.sitelinks);
  const [best, second] = near;
  if (!best) return {};
  if (second && best.sitelinks < 3 * Math.max(1, second.sitelinks)) return { ambiguous: near };
  return { match: { entity: best, level: 1 } };
}

/** Por qué un candidato no vale para un circuito (para la tabla de revisión). */
export function whyNot(group: Pick<CircuitGroup, 'key' | 'country'>, entity: WdEntity, places: Map<string, WdPlace>): string {
  if (!isTrack(entity)) return 'no es un circuito';
  if (countryMatches(group.country, entity, places) === false) return 'otro país';
  return 'no coincide el nombre';
}

/** Elige el candidato (en el orden en que los devolvió la búsqueda) o informa que no se pudo decidir. */
export function pickMatch(
  group: Pick<CircuitGroup, 'key' | 'country'>,
  candidates: WdEntity[],
  places: Map<string, WdPlace>,
): MatchOutcome {
  const scored: Array<Match & { order: number }> = [];
  const seen = new Set<string>();
  candidates.forEach((entity, order) => {
    if (seen.has(entity.id) || !isTrack(entity)) return;
    seen.add(entity.id);
    const inCountry = countryMatches(group.country, entity, places);
    if (inCountry === false) return;
    const level: 0 | MatchLevel = nameLevel(group.key, entity.names) || (placeLevel(group.key, entity, places) ? 1 : 0);
    if (!level) return;
    // Sin país para validar solo vale la coincidencia exacta del nombre.
    if (inCountry === null && level < 3) return;
    scored.push({ entity, level, order });
  });
  scored.sort((a, b) => b.level - a.level || b.entity.sitelinks - a.entity.sitelinks || a.order - b.order);
  const best = scored[0];
  if (!best) return {};
  const rivals = scored.filter((s) => s !== best && s.level === best.level);
  if (rivals.length && best.level < 3) {
    // Varios circuitos parecidos: vale el primero solo si es claramente el más conocido.
    const factor = best.level === 1 ? 3 : 2;
    if (best.entity.sitelinks < factor * Math.max(1, rivals[0]!.entity.sitelinks)) {
      return { ambiguous: [best, ...rivals].map((s) => s.entity) };
    }
  }
  return { match: { entity: best.entity, level: best.level } };
}
