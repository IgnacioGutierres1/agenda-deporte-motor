import type { RosterRow, Series, Source, StandingsTable } from '@dm/shared';
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
  /**
   * Clave estable del evento dentro de la temporada, si el sitio da una que no cambia (slug de la URL del evento).
   * Sin ella se usa la ronda o el nombre, que a veces cambia cuando se anuncia el nombre comercial de la fecha.
   */
  key?: string;
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

/** Imágenes oficiales del cronograma, ubicadas sin IA. */
export interface TimetableImages {
  /** Página oficial donde están publicadas. */
  url: string;
  title: string;
  images: string[];
}

/** Tablas de campeonato leídas sin IA. */
export interface StandingsFound {
  tables: StandingsTable[];
  source: Source;
  /**
   * Temporada de las tablas, si no es la pedida: IMSA sigue publicando el campeonato 2026 terminado cuando su
   * calendario ya es el de 2027. El archivo del campeonato se guarda con este año.
   */
  season?: number;
}

/** Lista oficial de inscriptos leída sin IA. */
export interface RosterFound {
  rows: RosterRow[];
  source: Source;
  /**
   * Temporada que publica la página, si no es la pedida: ELMS sigue mostrando la lista de 2026 en enero de 2027,
   * y la del Asian LMS lleva el año en que empieza (2025 para la temporada 2025/26).
   */
  season?: number;
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
  /** true si la receta entiende esta URL oficial (calendario o posiciones). */
  match(url: string): boolean;
  /**
   * Temporada vigente de la serie cuando no coincide con el año en curso: campeonatos de invierno como la
   * Asian Le Mans Series, cuya temporada 2026 corre de noviembre de 2026 a febrero de 2027. El flujo genérico
   * la usa como ctx.season en todo lo de la serie (URL del calendario, ids de eventos, campeonato), así los
   * eventos no cambian de id al pasar de año. Sin esta función, la temporada es el año en curso.
   */
  season?(ctx: RecipeContext): Promise<number>;
  /** URL a descargar para la temporada pedida (p. ej. agregar ?year=2026). */
  calendarUrl?(url: string, season: number): string;
  /** Puede ser asíncrono si el calendario solo lista los eventos y las fechas salen de la página de cada uno. */
  calendar?(doc: FetchedDocument, ctx: RecipeContext): CalendarEntry[] | Promise<CalendarEntry[]>;
  /** Sesiones por lectura directa (API oficial). null si todavía no hay cronograma publicado. */
  sessions?(entry: CalendarEntry, ctx: RecipeContext): Promise<SessionsFound | null>;
  /**
   * Cronograma publicado solo como imagen en un lugar fijo del sitio (p. ej. TC2000): la receta ubica las
   * imágenes sin IA y el flujo genérico las transcribe (solo para eventos dentro del horizonte).
   * null si todavía no está publicado.
   */
  timetableImages?(entry: CalendarEntry, ctx: RecipeContext): Promise<TimetableImages | null>;
  /**
   * Qué hacer cuando sessions()/timetableImages() no encuentran el cronograma: 'none' = nada (el sitio lo
   * publica siempre en los lugares que ya miró la receta, así que todavía no está publicado; evita gastar IA
   * en imágenes de la página del evento que no son el cronograma); 'generic' = buscarlo con el flujo genérico
   * (página del evento, notas de prensa). Por defecto: 'none' si la receta tiene sessions() y el evento no
   * tiene página propia; si no, 'generic'.
   */
  timetableFallback?: 'none' | 'generic';
  /**
   * Campeonato por lectura directa a partir de la URL de posiciones de la serie (officialUrls[1..]).
   * null si el sitio todavía no publica la tabla de la temporada pedida; lanza un error si la página
   * no tiene el formato esperado (entonces se intenta con Gemini).
   */
  standings?(url: string, ctx: RecipeContext): Promise<StandingsFound | null>;
  /**
   * Inscriptos de la temporada a partir de una URL de Series.rosterUrls. null si la lista de la temporada
   * todavía no está publicada; lanza un error si la página no tiene el formato esperado.
   */
  roster?(url: string, ctx: RecipeContext): Promise<RosterFound | null>;
}
