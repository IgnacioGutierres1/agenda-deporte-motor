/**
 * Pilotos: identidad estable a partir del nombre tal como lo publica cada sitio oficial.
 * "Canapino, Agustin", "Agustín CANAPINO" y "Agustín Canapino" son el mismo piloto
 * (mismas palabras sin acentos ni mayúsculas, en cualquier orden).
 */
import aliasConfig from '../../config/driver-aliases.json' with { type: 'json' };
import { slugify } from './hash.ts';
import { accentGivenName, hasBrokenChars, repairBrokenChars } from './names.ts';

/** Una línea del campeonato de un piloto en una categoría. */
export interface DriverEntry {
  seriesId: string;
  /** Tabla, cuando la categoría tiene varias de pilotos ("Clase 2"). */
  table?: string;
  pos: number;
  points: number;
  wins?: number;
  number?: string;
  team?: string;
}

/** Un resultado reciente (carrera o sprint). */
export interface DriverResult {
  seriesId: string;
  eventId: string;
  sessionId: string;
  /** Inicio de la sesión, ISO UTC (para ordenar). */
  startUtc: string;
  pos: number | null;
  status?: string;
}

/** Inscripción en una categoría según la lista oficial de inscriptos (aunque no sume puntos). */
export interface DriverLineup {
  seriesId: string;
  team?: string;
  number?: string;
  vehicle?: string;
  class?: string;
}

export interface Driver {
  /** Id estable: palabras del nombre normalizadas y ordenadas ("agustin-canapino"). */
  id: string;
  name: string;
  /** País o nacionalidad publicada por alguna lista oficial de inscriptos. */
  country?: string;
  /** Campeonatos en los que figura en la tabla (con posición y puntos). */
  entries: DriverEntry[];
  /** Categorías en las que figura inscripto (listas oficiales de inscriptos). */
  lineups?: DriverLineup[];
  /**
   * Últimas carreras, de la más reciente a la más vieja. Solo viene en la ficha completa
   * (data/drivers/{shard}.json y data/drivers.json); el índice liviano no la trae.
   */
  recent?: DriverResult[];
}

/** Ficha completa de un piloto: lo del índice más sus últimas carreras. */
export interface DriverDetail extends Driver {
  recent: DriverResult[];
}

/** Una línea de un equipo en una categoría (tabla de equipos y/o lista de inscriptos). */
export interface TeamEntry {
  seriesId: string;
  /** Tabla de equipos en la que figura, si hay varias. */
  table?: string;
  pos?: number;
  points?: number;
  /** Números de auto que usa en esa categoría. */
  numbers?: string[];
  vehicles?: string[];
  classes?: string[];
}

export interface TeamDriver {
  id: string;
  name: string;
  seriesId: string;
  number?: string;
}

export interface Team {
  /** Id estable a partir del nombre (ver teamId). */
  id: string;
  name: string;
  entries: TeamEntry[];
  drivers: TeamDriver[];
}

/** Contenido de data/teams.json */
export interface TeamsFile {
  version: 1;
  generatedAt: string;
  teams: Team[];
}

/**
 * Clave de un equipo: "Team WRT", "TEAM WRT" y "Team WRT #31" son el mismo. Se quitan acentos, mayúsculas,
 * signos y el número de auto; el orden de las palabras sí importa (a diferencia de los pilotos).
 */
export function teamKey(raw: string): string {
  return tokens(raw.replace(/#\s*\d+/g, ' ')).join(' ');
}

export function teamId(raw: string): string {
  return slugify(teamKey(raw));
}

/** Contenido de data/drivers.json (todas las fichas completas; se sigue publicando por compatibilidad). */
export interface DriversFile {
  version: 1;
  generatedAt: string;
  drivers: DriverDetail[];
}

/**
 * Contenido de data/drivers-index.json: un renglón por piloto, sin las últimas carreras. Alcanza para
 * buscar, listar, recomendar y seguir pilotos; la ficha se pide aparte (ver driverShard).
 */
export interface DriversIndexFile {
  version: 1;
  generatedAt: string;
  drivers: Driver[];
}

/**
 * Contenido de data/drivers/{shard}.json: fichas completas de los pilotos de ese grupo, ordenadas por id.
 * No lleva fecha de generación para que el archivo solo cambie cuando cambia algún piloto.
 */
export interface DriverShardFile {
  version: 1;
  drivers: DriverDetail[];
}

/** Cantidad de grupos de fichas de pilotos (data/drivers/00.json … ff.json). */
export const DRIVER_SHARDS = 256;

/**
 * Grupo de la ficha de un piloto: "agustin-canapino" -> "3f" (FNV-1a de 32 bits del id, módulo 256).
 * Lo usan el pipeline para escribir y la app para pedir; si cambia, cambia la ruta de todos los archivos.
 */
export function driverShard(id: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % DRIVER_SHARDS).toString(16).padStart(2, '0');
}

/** Ruta (dentro de data/) del archivo con la ficha de un piloto. */
export function driverShardPath(id: string): string {
  return `drivers/${driverShard(id)}.json`;
}

const TEAM_TABLE = /equipo|team|constructor|propietario|owner|marca|manufacturer|fabricante|maker|escuder/i;

/** true si la tabla del campeonato es de pilotos (no de equipos, marcas, propietarios…). */
export function isDriverTable(title: string): boolean {
  return !TEAM_TABLE.test(title);
}

/** Un nombre de varios pilotos (tripulaciones de resistencia: "A / B / C") no identifica a uno solo. */
export function isSingleDriverName(raw: string): boolean {
  return !/[/;&]|\s-\s|\s\+\s/.test(raw) && /[A-Za-zÀ-ÿ]{2}/.test(raw);
}

/**
 * Pilotos de un nombre que puede ser una tripulación de resistencia: "Vanthoor / Estre / Christensen",
 * "A. Pier Guidi, J. Calado & A. Giovinazzi", "Auer - Engel". Un nombre con una sola coma y sin otros
 * separadores es UN piloto en forma "Apellido, Nombre" ("Canapino, Agustin", "DI PALMA, JOSE LUIS"): la coma
 * solo separa pilotos si hay otro separador o al menos dos comas. En una tripulación, un integrante con una
 * sola palabra ("Vanthoor / Estre") no identifica a nadie (no se une con "Kevin Estre" y crearía una ficha
 * suelta): se omite. Devuelve [] si no queda ningún nombre.
 */
export function splitDriverNames(raw: string): string[] {
  const t = raw.replace(/\s+/g, ' ').trim();
  const strong = /\s*(?:[/;&+]|\s-\s|\sand\s)\s*/i;
  const commas = (t.match(/,/g) ?? []).length;
  const parts = (strong.test(t) || commas >= 2 ? t.split(new RegExp(`${strong.source}|\\s*,\\s*`, 'i')) : [t])
    .map((p) => p.trim())
    .filter((p) => /[A-Za-zÀ-ÿ]{2}/.test(p));
  return parts.length > 1 ? parts.filter((p) => /\S\s+\S/.test(p)) : parts;
}

function tokens(raw: string): string[] {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Etiquetas entre paréntesis que no son parte del nombre: invitado (WCD, INV, G), novato (R, RC). */
const NAME_TAGS = /\s*\((?:wcd|inv|g|guest|r|rc|rookie)\)/gi;

/**
 * Quita lo que no es parte del nombre: marcas de nota al pie ("Alex Sedgwick***", "Name†"), etiquetas de
 * invitado o novato ("A. Danielsson (WCD)") y letras perdidas por la codificación que se pueden reparar
 * ("MENENDEZ, AGUST?N" -> "MENENDEZ, AGUSTÍN"). "(h)" (hijo) sí es parte del nombre.
 */
export function cleanDriverName(raw: string): string {
  return repairBrokenChars(raw)
    .replace(/[*†‡§¹²³⁴⁵]+/g, ' ')
    .replace(NAME_TAGS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** true si el nombre no se puede usar (letras rotas que no se pudieron reparar). */
export function isBrokenDriverName(raw: string): boolean {
  return hasBrokenChars(cleanDriverName(raw));
}

/** Palabras del nombre, sin acentos, en minúsculas y ordenadas: clave para unir variantes. */
export function driverKey(raw: string): string {
  return [...new Set(tokens(stripCode(cleanDriverName(raw))))].sort().join(' ');
}

/** Id a partir de las palabras del nombre, sin aplicar config/driver-aliases.json. */
export function baseDriverId(raw: string): string {
  return slugify(driverKey(raw));
}

interface DriverAliasConfig {
  aliases: Record<string, string>;
  doNotMerge: Array<{ id: string; series: string[]; as: string }>;
}

const DRIVER_ALIASES: Record<string, string> = (aliasConfig as DriverAliasConfig).aliases ?? {};
const DRIVER_SPLITS = new Map((aliasConfig as DriverAliasConfig).doNotMerge?.map((r) => [r.id, r]) ?? []);

/**
 * Id canónico (config/driver-aliases.json): una variante conocida del nombre ("Cam Waters") va al id de la otra
 * ("cameron-waters"); un homónimo conocido en otra categoría ("Josh Berry" en la 24H Series) va a su propio id.
 * Sin `seriesId` no se separan homónimos.
 */
export function resolveDriverId(id: string, seriesId?: string): string {
  const split = DRIVER_SPLITS.get(id);
  if (split && seriesId && split.series.includes(seriesId)) return split.as;
  return DRIVER_ALIASES[id] ?? id;
}

/** Homónimos conocidos que no se unen: pares [id, id del homónimo] (config/driver-aliases.json, doNotMerge). */
export function knownHomonyms(): Array<[string, string]> {
  return [...DRIVER_SPLITS.values()].map((r) => [r.id, r.as]);
}

/**
 * Id estable del piloto: palabras del nombre normalizadas y ordenadas, con los alias y homónimos de
 * config/driver-aliases.json. Pasar la categoría cuando se conoce (separa homónimos).
 */
export function driverId(raw: string, seriesId?: string): string {
  const id = baseDriverId(raw);
  return id ? resolveDriverId(id, seriesId) : '';
}

/**
 * "A. Palmowski PAL" -> "A. Palmowski" (código de 3 letras al final, como en F1 Academy). Solo si el código
 * son las primeras letras de otra palabra del nombre: en "Mikkel MAC" o "Alex AKA" (listas de SRO, con el
 * apellido en mayúsculas) las tres letras son el apellido.
 */
function stripCode(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.*[a-zà-ÿ].*)\s([A-Z]{3})$/);
  if (!m) return t;
  const prefixes = m[1]!.split(/[\s.]+/).flatMap((w) => {
    const plain = w.normalize('NFD').replace(/[̀-ͯ]/g, '');
    const german = w.replace(/ä/gi, 'ae').replace(/ö/gi, 'oe').replace(/ü/gi, 'ue');
    return [plain, german].map((x) => x.slice(0, 3).toUpperCase());
  });
  return prefixes.includes(m[2]!) ? m[1]! : t;
}

const LOWER_PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'da', 'das', 'do', 'dos', 'di', 'van', 'von', 'der', 'y']);

function titleWord(w: string, first: boolean): string {
  if (!/^[A-ZÀ-ÖØ-Þ'’.-]+$/.test(w) || w.length < 2) return w; // ya tiene minúsculas o es una inicial
  const lower = w.toLocaleLowerCase('es');
  if (!first && LOWER_PARTICLES.has(lower)) return lower;
  if (w.length <= 2) return w; // siglas de nombre ("AJ", "BJ")
  return lower.replace(/(^|[-'’])(\p{L})/gu, (_m, sep: string, c: string) => sep + c.toLocaleUpperCase('es'));
}

/** Opciones de driverDisplayName. */
export interface DisplayNameOptions {
  /**
   * Fuente en español (categorías argentinas): a los nombres de pila escritos en mayúsculas se les devuelve el
   * acento ("CORTINA, JOAQUIN" -> "Joaquín Cortina").
   */
  spanish?: boolean;
}

/**
 * Nombre legible: "CANAPINO, Agustin" -> "Agustin Canapino", "NICOLÁS JAIME" -> "Nicolás Jaime",
 * "A. Palmowski PAL" -> "A. Palmowski", "Gustavo (H) TADEI" -> "Gustavo Tadei (h)", "Alex Sedgwick***" ->
 * "Alex Sedgwick".
 */
export function driverDisplayName(raw: string, opts: DisplayNameOptions = {}): string {
  let t = stripCode(cleanDriverName(raw));
  // "(h)" = hijo: va al final, como se escribe en la Argentina.
  let junior = false;
  t = t.replace(/\s*\(h\)\s*/gi, () => {
    junior = true;
    return ' ';
  }).trim();
  const comma = t.split(',');
  let given: string[] | null = null;
  if (comma.length === 2 && comma[0]!.trim() && comma[1]!.trim()) {
    given = comma[1]!.trim().split(' ');
    t = `${comma[1]!.trim()} ${comma[0]!.trim()}`;
  }
  const words = t.split(' ');
  const out = words
    .map((w, i) => {
      // Acento del nombre de pila: todo lo que va después de la coma, o la primera palabra si no hay coma.
      const isGiven = given ? i < given.length : i === 0;
      const accented = opts.spanish && isGiven ? accentGivenName(w, !!given) : w;
      return titleWord(accented, i === 0);
    })
    .join(' ');
  return junior ? `${out} (h)` : out;
}

/** Qué tan "prolija" es la forma original de un nombre (para elegir cuál mostrar entre variantes). */
export function nameQuality(raw: string): number {
  let score = 0;
  if (/[a-zà-ÿ]/.test(raw)) score += 2; // no está todo en mayúsculas
  if (!raw.includes(',')) score += 1; // no está como "Apellido, Nombre"
  if (/[À-ÿ]/.test(raw)) score += 1; // conserva acentos
  if (!/[A-Z]\./.test(raw)) score += 1; // nombre completo, no inicial
  if (/[*†‡?�]/.test(raw)) score -= 2; // notas al pie o letras rotas
  return score;
}

/** Iniciales para el avatar ("Agustín Canapino" -> "AC"). */
export function driverInitials(name: string): string {
  const words = name.split(/\s+/).filter((w) => /\p{L}/u.test(w) && !LOWER_PARTICLES.has(w.toLowerCase()));
  if (words.length === 0) return '?';
  const first = words[0]!.replace(/[^\p{L}]/gu, '')[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]!.replace(/[^\p{L}]/gu, '')[0] ?? '') : '';
  return (first + last).toUpperCase();
}
