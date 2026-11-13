/**
 * Wikidata: búsqueda de circuitos y lectura de sus datos (claims) con la API de acción.
 *  - searchTracks / searchTracksNear: búsqueda (por texto o por cercanía) limitada a elementos cuyo tipo (P31)
 *    es un circuito. Es la misma API que wbsearchentities, pero busca también en alias y descripciones de todos
 *    los idiomas y filtra por tipo, así que hace falta una sola consulta por circuito.
 *  - getEntities / getPlaces: wbgetentities de a varios ids por request.
 */
import type { Api } from './api.ts';

const API = 'https://www.wikidata.org/w/api.php';

/** Tipos (P31) que valen como circuito. Cualquier otro elemento se descarta aunque coincida el nombre. */
export const TRACK_TYPES: Record<string, string> = {
  Q2338524: 'autódromo',
  Q1777138: 'circuito de carreras',
  Q926439: 'circuito urbano',
  Q1232319: 'kartódromo',
  Q94196270: 'circuito de rallycross',
  Q357121: 'picódromo',
  Q113715571: 'circuito de motocross',
  Q105360482: 'circuito de motocross',
};

export interface WdEntity {
  id: string;
  /** Etiquetas por idioma. */
  labels: Record<string, string>;
  /** Etiquetas y alias en todos los idiomas, sin repetir (el nombre oficial suele estar en el idioma local). */
  names: string[];
  /** Descripciones en todos los idiomas, sin repetir. */
  descriptions: string[];
  /** P31 */
  types: string[];
  /** P17 */
  countries: string[];
  /** P131 */
  locatedIn?: string;
  lat?: number;
  lon?: number;
  lengthM?: number;
  capacity?: number;
  opened?: number;
  elevationM?: number;
  website?: string;
  /** P18: nombre del archivo en Commons. */
  image?: string;
  /** P15: plano del recorrido (archivo en Commons). */
  routeMap?: string;
  eswiki?: string;
  enwiki?: string;
  /** Cantidad de proyectos con artículo (sirve para desempatar: el más conocido). */
  sitelinks: number;
}

export interface WdPlace {
  id: string;
  /** Etiqueta en español o, si no hay, en inglés. */
  label?: string;
  /** Etiquetas y alias (es, en). */
  names: string[];
}

export function isTrack(e: WdEntity): boolean {
  return e.types.some((t) => t in TRACK_TYPES);
}

// ── Búsquedas ──

/** Filtro de CirrusSearch: solo elementos cuyo tipo (P31) es alguno de los de circuito. */
const TRACK_FILTER = `haswbstatement:${Object.keys(TRACK_TYPES)
  .map((q) => `P31=${q}`)
  .join('|')}`;

async function search(api: Api, query: string, limit: number): Promise<string[]> {
  const url = `${API}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srnamespace=0&srlimit=${limit}&srprop=&format=json`;
  const res = await api.get<{ query?: { search?: Array<{ title?: string }> } }>(url);
  return (res.query?.search ?? []).map((s) => s.title ?? '').filter(isQid);
}

/** Búsqueda de texto completo (etiquetas, alias y descripciones) entre los elementos que son circuitos. */
export function searchTracks(api: Api, text: string, limit = 6): Promise<string[]> {
  return search(api, `${text} ${TRACK_FILTER}`, limit);
}

/** Circuitos con coordenadas a menos de `km` de un punto (para los que se publican con el nombre de la ciudad). */
export function searchTracksNear(api: Api, lat: number, lon: number, km = 25, limit = 6): Promise<string[]> {
  return search(api, `${TRACK_FILTER} nearcoord:${km}km,${lat},${lon}`, limit);
}

// ── Entidades ──

const BATCH = 50;

/**
 * Datos de varios elementos (los inexistentes no vuelven). Un elemento redirigido queda con el id pedido.
 * Se piden las etiquetas y alias en todos los idiomas: sirven para reconocer el circuito por su nombre local.
 */
export async function getEntities(api: Api, ids: string[]): Promise<Map<string, WdEntity>> {
  const out = new Map<string, WdEntity>();
  const unique = [...new Set(ids.filter(isQid))];
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const url = `${API}?action=wbgetentities&ids=${chunk.join('%7C')}&props=labels%7Caliases%7Cdescriptions%7Cclaims%7Csitelinks&format=json`;
    const res = await api.get<{ entities?: Record<string, unknown> }>(url);
    for (const [key, raw] of Object.entries(res.entities ?? {})) {
      const entity = parseEntity(raw);
      if (!entity) continue;
      out.set(entity.id, entity);
      // Con una redirección la respuesta viene bajo el id de destino e indica desde cuál se llegó.
      const from = asRecord(asRecord(raw)?.redirects)?.from;
      if (typeof from === 'string') out.set(from, entity);
      if (key !== entity.id) out.set(key, entity);
    }
  }
  return out;
}

/** Etiquetas de países y localidades (sin claims: los países pesan más de 1 MB). */
export async function getPlaces(api: Api, ids: string[]): Promise<Map<string, WdPlace>> {
  const out = new Map<string, WdPlace>();
  const unique = [...new Set(ids.filter(isQid))];
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const url = `${API}?action=wbgetentities&ids=${chunk.join('%7C')}&props=labels%7Caliases&languages=es%7Cen&format=json`;
    const res = await api.get<{ entities?: Record<string, unknown> }>(url);
    for (const raw of Object.values(res.entities ?? {})) {
      const e = asRecord(raw);
      const id = e?.id;
      if (!e || typeof id !== 'string' || 'missing' in e) continue;
      const labels = readLabels(e.labels);
      out.set(id, { id, label: labels.es ?? labels.en, names: unique_([...Object.values(labels), ...readAliases(e.aliases)]) });
    }
  }
  return out;
}

// ── Lectura de una entidad ──

type Rec = Record<string, unknown>;

function asRecord(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function isQid(id: string): boolean {
  return /^Q\d+$/.test(id);
}

function unique_(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function readLabels(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [lang, v] of Object.entries(asRecord(raw) ?? {})) {
    const value = asRecord(v)?.value;
    if (typeof value === 'string' && value.trim()) out[lang] = value.trim();
  }
  return out;
}

function readAliases(raw: unknown): string[] {
  const out: string[] = [];
  for (const list of Object.values(asRecord(raw) ?? {})) {
    if (!Array.isArray(list)) continue;
    for (const a of list) {
      const value = asRecord(a)?.value;
      if (typeof value === 'string') out.push(value);
    }
  }
  return out;
}

/** Fecha de un calificador de tiempo (P580 inicio, P582 fin) como texto comparable, o '' si no está. */
function qualifierTime(claim: Rec, prop: string): string {
  const list = asRecord(claim.qualifiers)?.[prop];
  const time = Array.isArray(list) ? asRecord(asRecord(asRecord(list[0])?.datavalue)?.value)?.time : undefined;
  return typeof time === 'string' ? time : '';
}

/**
 * Valores vigentes de una propiedad: los de rango "preferido" si hay; si no, los normales. Nunca los obsoletos
 * ni los "valor desconocido". Se dejan de lado los que tienen fecha de fin (un país o un trazado anterior),
 * salvo que no quede otro, y van primero los de inicio más reciente.
 */
function values(claims: Rec | undefined, prop: string): unknown[] {
  const list = claims?.[prop];
  if (!Array.isArray(list)) return [];
  const usable = list
    .map(asRecord)
    .filter((c): c is Rec => !!c && c.rank !== 'deprecated' && asRecord(c.mainsnak)?.snaktype === 'value');
  const preferred = usable.filter((c) => c.rank === 'preferred');
  const ranked = preferred.length ? preferred : usable;
  const current = ranked.filter((c) => !qualifierTime(c, 'P582'));
  return (current.length ? current : ranked)
    .map((c, i) => ({ c, i, start: qualifierTime(c, 'P580') }))
    .sort((a, b) => b.start.localeCompare(a.start) || a.i - b.i)
    .map(({ c }) => asRecord(asRecord(c.mainsnak)?.datavalue)?.value);
}

function itemIds(claims: Rec | undefined, prop: string): string[] {
  return values(claims, prop)
    .map((v) => asRecord(v)?.id)
    .filter((id): id is string => typeof id === 'string' && isQid(id));
}

function firstString(claims: Rec | undefined, prop: string): string | undefined {
  const v = values(claims, prop).find((x): x is string => typeof x === 'string' && !!x.trim());
  return v?.trim();
}

const UNIT = 'http://www.wikidata.org/entity/';
/** Unidades de longitud -> metros. */
const TO_METERS: Record<string, number> = {
  Q11573: 1, // metro
  Q828224: 1000, // kilómetro
  Q253276: 1609.344, // milla
  Q3710: 0.3048, // pie
};

function quantity(claims: Rec | undefined, prop: string, units: Record<string, number> | null): number | undefined {
  for (const v of values(claims, prop)) {
    const q = asRecord(v);
    const amount = Number(q?.amount);
    if (!q || !Number.isFinite(amount)) continue;
    if (!units) return amount;
    const unit = typeof q.unit === 'string' ? q.unit.replace(UNIT, '') : '';
    const factor = units[unit];
    if (factor !== undefined) return amount * factor;
  }
  return undefined;
}

function year(claims: Rec | undefined, prop: string): number | undefined {
  for (const v of values(claims, prop)) {
    const time = asRecord(v)?.time;
    const m = typeof time === 'string' ? /^([+-])(\d{4,})-/.exec(time) : null;
    if (m) return Number(m[2]) * (m[1] === '-' ? -1 : 1);
  }
  return undefined;
}

export function parseEntity(raw: unknown): WdEntity | null {
  const e = asRecord(raw);
  const id = e?.id;
  if (!e || typeof id !== 'string' || !isQid(id) || 'missing' in e) return null;
  const claims = asRecord(e.claims);
  const labels = readLabels(e.labels);
  const sitelinks = asRecord(e.sitelinks) ?? {};
  const title = (site: string) => {
    const t = asRecord(sitelinks[site])?.title;
    return typeof t === 'string' && t ? t : undefined;
  };

  const entity: WdEntity = {
    id,
    labels,
    names: unique_([...Object.values(labels), ...readAliases(e.aliases)]),
    descriptions: unique_(Object.values(readLabels(e.descriptions))),
    types: itemIds(claims, 'P31'),
    countries: itemIds(claims, 'P17'),
    locatedIn: itemIds(claims, 'P131')[0],
    sitelinks: Object.keys(sitelinks).length,
  };

  const coords = values(claims, 'P625')
    .map(asRecord)
    .find((c) => c && (c.globe === undefined || c.globe === `${UNIT}Q2`));
  const lat = Number(coords?.latitude);
  const lon = Number(coords?.longitude);
  if (coords && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
    entity.lat = round(lat, 5);
    entity.lon = round(lon, 5);
  }

  const length = quantity(claims, 'P2043', TO_METERS);
  // Un trazado mide entre unos cientos de metros y unas decenas de km (Nordschleife: 20,8).
  if (length !== undefined && length >= 200 && length <= 80_000) entity.lengthM = Math.round(length);
  const capacity = quantity(claims, 'P1083', null);
  if (capacity !== undefined && capacity >= 1) entity.capacity = Math.round(capacity);
  // Inauguración: fecha de creación o, si no está, la de apertura oficial.
  const opened = year(claims, 'P571') ?? year(claims, 'P1619');
  if (opened !== undefined && opened > 1800) entity.opened = opened;
  const elevation = quantity(claims, 'P2044', TO_METERS);
  if (elevation !== undefined && elevation > -500 && elevation < 6000) entity.elevationM = Math.round(elevation);

  const website = firstString(claims, 'P856');
  if (website && /^https?:\/\/\S+$/.test(website)) entity.website = website;
  entity.image = firstString(claims, 'P18');
  entity.routeMap = firstString(claims, 'P15');
  entity.eswiki = title('eswiki');
  entity.enwiki = title('enwiki');
  for (const k of ['locatedIn', 'image', 'routeMap', 'eswiki', 'enwiki'] as const) {
    if (entity[k] === undefined) delete entity[k];
  }
  return entity;
}

function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
