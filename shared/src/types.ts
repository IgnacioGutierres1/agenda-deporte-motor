/**
 * Modelo de datos compartido entre el pipeline (que genera los JSON de data/)
 * y la app (que los lee). Todas las horas se guardan en UTC (ISO 8601 con "Z").
 */

export type SeriesGroup =
  | 'f1-fia'
  | 'moto'
  | 'usa'
  | 'gt-endurance'
  | 'argentina'
  | 'otros';

/** adapter: lector programado específico. generic: flujo genérico con IA sobre el documento oficial. */
export type Strategy = 'adapter' | 'generic';

/** default: las 22 del gem. user: agregada desde la app. discovered: hallada por el descubrimiento. */
export type Origin = 'default' | 'user' | 'discovered';

export type SourceKind = 'api' | 'html' | 'pdf';

/** directo: leído sin IA. ia: transcripto por Gemini desde el documento oficial descargado. */
export type SourceMethod = 'directo' | 'ia';

export interface Source {
  url: string;
  title: string;
  kind: SourceKind;
  method: SourceMethod;
  /** ISO UTC del momento en que el pipeline leyó el documento. */
  fetchedAt: string;
}

export interface Series {
  /** Identificador estable en kebab-case, p. ej. "f1", "tc-pista". */
  id: string;
  name: string;
  /** Nombre corto para la grilla, p. ej. "F1", "TC Pista". */
  shortName: string;
  group: SeriesGroup;
  /** Número del ítem del checklist del gem (1–22). Varias series pueden compartir ítem. */
  checklistItem?: number;
  /** Sitios oficiales: el primero es el calendario de la temporada. */
  officialUrls: string[];
  strategy: Strategy;
  /** Nombre del lector cuando strategy === 'adapter'. */
  adapter?: string;
  origin: Origin;
  enabled: boolean;
  /** Color de acento para la UI (hex). */
  color?: string;
}

export type SessionType =
  | 'practica'
  | 'clasificacion'
  | 'sprint'
  | 'serie'
  | 'carrera'
  | 'warmup'
  | 'otro';

export interface MotorEvent {
  /** Hash estable de serie + temporada + nombre/ronda. */
  id: string;
  seriesId: string;
  name: string;
  round?: number;
  circuit: string;
  country: string;
  /** Zona IANA del circuito, p. ej. "Asia/Qatar". */
  tz: string;
  /** Fechas locales del circuito, YYYY-MM-DD. */
  dateStart: string;
  dateEnd: string;
  /** published: ya hay cronograma con horarios. pending: solo se conoce la fecha. */
  sessionsStatus: 'published' | 'pending';
  source: Source;
}

export interface Session {
  /** Hash estable de serie + evento + nombre de sesión. */
  id: string;
  eventId: string;
  seriesId: string;
  type: SessionType;
  /** Nombre tal como lo publica la fuente (o normalizado en español). */
  name: string;
  startUtc: string;
  endUtc: string;
  /** true cuando la fuente no publica la hora de fin y se estimó con config/durations.json. */
  endEstimated: boolean;
  /** Hora local del circuito tal como figura en la fuente, p. ej. "14:00". */
  localStartText?: string;
  broadcast: string[];
  /** true si la transmisión sale de config/broadcast.ar.json y no de la fuente. */
  broadcastIsDefault: boolean;
  source: Source;
  /** ISO UTC de la última vez que cambió el horario respecto de una corrida anterior. */
  changedAt?: string;
  /** Hora de inicio anterior cuando cambió. */
  previousStartUtc?: string;
  hasResults: boolean;
}

export interface ResultRow {
  pos: number | null;
  /** Estado cuando no hay posición: DNF, DNS, DSQ, NC… */
  status?: string;
  number?: string;
  driver: string;
  team?: string;
  vehicle?: string;
  laps?: number;
  time?: string;
  gap?: string;
  bestLap?: string;
  points?: number;
}

export interface SessionResult {
  sessionId: string;
  rows: ResultRow[];
  source: Source;
}

/** Contenido de data/results/{seriesId}/{eventId}.json */
export interface EventResultsFile {
  seriesId: string;
  eventId: string;
  updatedAt: string;
  sessions: SessionResult[];
}

export interface StandingsRow {
  pos: number;
  name: string;
  team?: string;
  number?: string;
  points: number;
  wins?: number;
}

export interface StandingsTable {
  /** p. ej. "Pilotos", "Equipos", "Marcas". */
  title: string;
  rows: StandingsRow[];
}

/** Contenido de data/standings/{seriesId}.json */
export interface StandingsFile {
  seriesId: string;
  season: number;
  updatedAt: string;
  tables: StandingsTable[];
  source: Source;
}

/** Contenido de data/schedule.json */
export interface ScheduleFile {
  version: 1;
  generatedAt: string;
  series: Series[];
  events: MotorEvent[];
  sessions: Session[];
}

export type SeriesState = 'ok' | 'stale' | 'error' | 'disabled';

export interface SeriesStatus {
  seriesId: string;
  state: SeriesState;
  /** ISO UTC del último intento. */
  lastAttempt: string;
  /** ISO UTC de la última lectura exitosa. */
  lastSuccess?: string;
  message?: string;
  sourceUrl?: string;
  standingsAvailable: boolean;
}

/** Contenido de data/status.json */
export interface StatusFile {
  version: 1;
  generatedAt: string;
  series: SeriesStatus[];
}

/** Competencia hallada por el descubrimiento automático. */
export interface DiscoveredItem {
  /** Id de la serie descubierta (se agrega a schedule.json con origin "discovered"). */
  seriesId: string;
  name: string;
  officialUrl: string;
  /** Primera fecha conocida, YYYY-MM-DD. */
  firstSeen: string;
  nextEventDate?: string;
  source: Source;
}

/** Contenido de data/discovered.json */
export interface DiscoveredFile {
  version: 1;
  generatedAt: string;
  items: DiscoveredItem[];
}

/** Contenido de config/series.user.json (lo edita la app vía API de GitHub). */
export interface UserSeriesConfig {
  /** Series agregadas por el usuario. */
  added: Array<Pick<Series, 'id' | 'name' | 'shortName' | 'officialUrls'> & Partial<Series>>;
  /** Ids desactivados (de las default o descubiertas). */
  disabled: string[];
  /** Ids descubiertos fijados como permanentes. */
  pinned: string[];
  /** Ids descubiertos ocultados (no vuelven a aparecer). */
  hidden: string[];
}
