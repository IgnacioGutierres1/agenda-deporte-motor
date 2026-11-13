/**
 * Coordenadas aproximadas de una ciudad con el geocoding abierto de Open-Meteo. Se usan cuando el "circuito" no
 * se pudo identificar (o es la ciudad base de un rally): alcanzan para el clima y quedan marcadas como aproximadas.
 */
import { countryCode, normalizeKey } from '../generic/places.ts';
import type { Api } from './api.ts';

const API = 'https://geocoding-api.open-meteo.com/v1/search';

export interface GeoHit {
  /** Nombre de la localidad en español. */
  name: string;
  lat: number;
  lon: number;
  /** Provincia o estado. */
  admin1?: string;
}

interface RawHit {
  name?: string;
  latitude?: number;
  longitude?: number;
  feature_code?: string;
  country_code?: string;
  country?: string;
  admin1?: string;
  population?: number;
}

/** Cuántas veces más habitantes tiene que tener una localidad para elegirla entre varias del mismo nombre. */
const SAME_NAME_FACTOR = 8;

/** Palabras que hacen de "circuito" al nombre de una ciudad ("Autódromo Ciudad de Concordia" -> "Concordia"). */
const VENUE_PREFIX =
  /^(?:aut[oó]dromo|circuito|circuit|kart[oó]dromo|callejero|street circuit)\s+(?:(?:internacional|municipal|provincial|parque|ciudad|callejero)\s+)*(?:de\s+la\s+|de\s+los\s+|de\s+las\s+|de\s+|del\s+)?/i;

/**
 * Textos a probar como ciudad, del más fiel al más recortado: el nombre tal cual (geocodeCity entiende
 * "General Roca, Río Negro" como ciudad y provincia), sin las palabras de circuito y solo su primera parte.
 */
export function cityQueries(name: string): string[] {
  const out: string[] = [];
  const add = (text: string) => {
    const t = text.replace(/\s+/g, ' ').trim();
    if (t.length >= 3 && !/^\d+$/.test(t) && !out.some((o) => normalizeKey(o) === normalizeKey(t))) out.push(t);
  };
  const base = name.replace(/\([^)]*\)/g, ' ');
  add(base);
  add(base.replace(VENUE_PREFIX, ''));
  add((base.split(/\s*[,/;]\s*|\s+[-–—]\s+/)[0] ?? '').replace(VENUE_PREFIX, ''));
  return out;
}

/**
 * Busca una localidad por nombre dentro del país del evento. `query` puede indicar la provincia después de una
 * coma ("San Jorge, Santa Fe"). Sin país conocido solo vale una coincidencia exacta del nombre.
 */
export async function geocodeCity(api: Api, query: string, country: string): Promise<GeoHit | null> {
  const [rawName = '', ...rest] = query.split(',');
  const name = rawName.trim();
  const region = normalizeKey(rest.join(' '));
  if (name.length < 2) return null;
  const res = await api.get<{ results?: RawHit[] }>(`${API}?name=${encodeURIComponent(name)}&language=es&count=10&format=json`);
  const iso = countryCode(country);
  const countryKey = normalizeKey(country);
  const wanted = normalizeKey(name);

  const hits = (res.results ?? []).filter((h): h is RawHit & { name: string; latitude: number; longitude: number } => {
    if (typeof h.name !== 'string' || typeof h.latitude !== 'number' || typeof h.longitude !== 'number') return false;
    // Solo localidades y divisiones administrativas (no aeropuertos, ríos ni cerros).
    if (h.feature_code && !/^(PPL|ADM)/.test(h.feature_code)) return false;
    if (region && !normalizeKey(h.admin1 ?? '').includes(region)) return false;
    if (iso) return h.country_code === iso;
    if (countryKey) return normalizeKey(h.country ?? '') === countryKey;
    return normalizeKey(h.name) === wanted;
  });
  // La API ordena por relevancia y también devuelve parecidos: vale el que se llama igual o, si no, el primero
  // cuyo nombre contiene todas las palabras buscadas ("San Nicolás" -> "San Nicolás de los Arroyos").
  const words = wanted.split(' ');
  const exact = hits.filter((h) => normalizeKey(h.name) === wanted);
  // Varias localidades con el mismo nombre en el país ("San Martín"): sin la provincia no se sabe cuál es,
  // salvo que una sea mucho más grande que las demás ("Junín").
  const towns = exact.filter((h) => !h.feature_code || h.feature_code.startsWith('PPL')).sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
  if (!region && towns.length > 1 && (towns[0]!.population ?? 0) < SAME_NAME_FACTOR * Math.max(1, towns[1]!.population ?? 0)) {
    return null;
  }
  const hit =
    towns[0] ??
    exact[0] ??
    hits.find((h) => {
      const have = new Set(normalizeKey(h.name).split(' '));
      return words.every((w) => have.has(w));
    });
  if (!hit) return null;
  const out: GeoHit = { name: hit.name, lat: round(hit.latitude), lon: round(hit.longitude) };
  if (hit.admin1) out.admin1 = hit.admin1;
  return out;
}

function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
