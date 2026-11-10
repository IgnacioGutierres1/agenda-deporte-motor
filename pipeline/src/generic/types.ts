import type { Series, Source } from '@dm/shared';
import type { Http } from '../core/http.ts';
import type { FetchedDocument } from '../extract/document.ts';

/** Evento leído del calendario oficial (antes de convertirlo en MotorEvent). */
export interface CalendarEntry {
  name: string;
  circuit: string;
  country: string;
  /** Zona IANA del circuito. */
  tz: string;
  /** Fechas locales YYYY-MM-DD. */
  dateStart: string;
  dateEnd: string;
  round?: number;
  /** Página oficial del evento (donde suele estar el cronograma). */
  url?: string;
  /** Documento del cronograma, si el calendario ya lo enlaza (p. ej. PDF de GT Open). */
  timetableUrl?: string;
  /** Campeonato al que pertenece (calendarios multi-categoría, para el descubrimiento). */
  championship?: string;
  /** Sitio oficial del campeonato (calendarios multi-categoría). */
  championshipUrl?: string;
  /** Sesiones ya conocidas sin IA (JSON-LD, API oficial…). */
  sessions?: ExtractedSession[];
  /** Datos propios de cada lector. */
  meta?: Record<string, string>;
}

/** Sesión extraída (por lectura directa o por IA), con horas ya en UTC. */
export interface ExtractedSession {
  name: string;
  startUtc: string;
  endUtc?: string;
  /** Hora local tal como figura en el documento. */
  localStartText?: string;
}

export interface SessionsFound {
  sessions: ExtractedSession[];
  source: Source;
}

export interface RecipeContext {
  season: number;
  series: Series;
  http: Http;
  now: Date;
}

/**
 * Lector determinista para un sitio conocido (sin IA). Todas las funciones son opcionales:
 * lo que una receta no resuelve lo resuelve el flujo genérico (JSON-LD, links de PDF, Gemini).
 */
export interface SiteRecipe {
  name: string;
  /** true si la receta entiende esta URL de calendario. */
  match(url: string): boolean;
  /** URL a descargar para la temporada pedida (p. ej. agregar ?year=2026). */
  calendarUrl?(url: string, season: number): string;
  calendar?(doc: FetchedDocument, ctx: RecipeContext): CalendarEntry[];
  /** Sesiones por lectura directa (API oficial). null si todavía no hay cronograma publicado. */
  sessions?(entry: CalendarEntry, ctx: RecipeContext): Promise<SessionsFound | null>;
}
