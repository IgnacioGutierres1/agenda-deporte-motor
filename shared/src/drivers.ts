/**
 * Pilotos: identidad estable a partir del nombre tal como lo publica cada sitio oficial.
 * "Canapino, Agustin", "Agustín CANAPINO" y "Agustín Canapino" son el mismo piloto
 * (mismas palabras sin acentos ni mayúsculas, en cualquier orden).
 */
import { slugify } from './hash.ts';

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

export interface Driver {
  /** Id estable: palabras del nombre normalizadas y ordenadas ("agustin-canapino"). */
  id: string;
  name: string;
  entries: DriverEntry[];
  /** Últimas carreras, de la más reciente a la más vieja. */
  recent: DriverResult[];
}

/** Contenido de data/drivers.json */
export interface DriversFile {
  version: 1;
  generatedAt: string;
  drivers: Driver[];
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

function tokens(raw: string): string[] {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Palabras del nombre, sin acentos, en minúsculas y ordenadas: clave para unir variantes. */
export function driverKey(raw: string): string {
  return [...new Set(tokens(stripCode(raw)))].sort().join(' ');
}

export function driverId(raw: string): string {
  return slugify(driverKey(raw));
}

/** "A. Palmowski PAL" -> "A. Palmowski" (código de 3 letras al final, como en F1 Academy). */
function stripCode(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.*[a-zà-ÿ].*)\s[A-Z]{3}$/);
  return m ? m[1]! : t;
}

const LOWER_PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'da', 'das', 'do', 'dos', 'di', 'van', 'von', 'der', 'y']);

function titleWord(w: string, first: boolean): string {
  if (!/^[A-ZÀ-ÖØ-Þ'’.-]+$/.test(w) || w.length < 2) return w; // ya tiene minúsculas o es una inicial
  const lower = w.toLocaleLowerCase('es');
  if (!first && LOWER_PARTICLES.has(lower)) return lower;
  if (w.length <= 2) return w; // siglas de nombre ("AJ", "BJ")
  return lower.replace(/(^|[-'’])(\p{L})/gu, (_m, sep: string, c: string) => sep + c.toLocaleUpperCase('es'));
}

/**
 * Nombre legible: "CANAPINO, Agustin" -> "Agustin Canapino", "NICOLÁS JAIME" -> "Nicolás Jaime",
 * "A. Palmowski PAL" -> "A. Palmowski".
 */
export function driverDisplayName(raw: string): string {
  let t = stripCode(raw);
  const comma = t.split(',');
  if (comma.length === 2 && comma[0]!.trim() && comma[1]!.trim()) t = `${comma[1]!.trim()} ${comma[0]!.trim()}`;
  return t
    .split(' ')
    .map((w, i) => titleWord(w, i === 0))
    .join(' ');
}

/** Qué tan "prolija" es la forma original de un nombre (para elegir cuál mostrar entre variantes). */
export function nameQuality(raw: string): number {
  let score = 0;
  if (/[a-zà-ÿ]/.test(raw)) score += 2; // no está todo en mayúsculas
  if (!raw.includes(',')) score += 1; // no está como "Apellido, Nombre"
  if (/[À-ÿ]/.test(raw)) score += 1; // conserva acentos
  if (!/\b[A-Z]\./.test(raw)) score += 1; // nombre completo, no inicial
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
