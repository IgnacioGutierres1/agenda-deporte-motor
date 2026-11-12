import type {
  EventResultsFile,
  EventStagesFile,
  MotorEvent,
  ScheduleFile,
  Series,
  Session,
  StandingsFile,
} from '@dm/shared';
import type { Http } from './http.ts';
import type { Logger } from './log.ts';
import type { Builders } from './builders.ts';

export interface AdapterContext {
  now: Date;
  /** Temporada en curso (año de `now`), o la siguiente si nextSeason. */
  season: number;
  /**
   * true cuando se lee la temporada siguiente porque la en curso ya terminó (core/season.ts). Solo lectura
   * directa: el flujo genérico no gasta IA en un calendario de la temporada siguiente salvo que la página ya la
   * muestre (y con tope semanal). Si la temporada todavía no está publicada, el lector puede lanzar o devolver vacío.
   */
  nextSeason?: boolean;
  /** Días hacia adelante para los que se buscan cronogramas detallados. */
  horizonDays: number;
  http: Http;
  log: Logger;
  /** Ayudantes para crear eventos y sesiones con ids estables, fin estimado y transmisión habitual. */
  build: Builders;
  /** Corrida anterior (para comparar o reutilizar datos). */
  previous: ScheduleFile | null;
  /** Directorio de caché versionada (data/_cache). */
  cacheDir: string;
}

export interface ScheduleChunk {
  events: MotorEvent[];
  sessions: Session[];
  /**
   * Fechas dentro del horizonte que quedaron sin cronograma, con el motivo (lo informa el flujo genérico):
   * 'no-publicado' = el sitio todavía no lo publicó; 'ilegible' = hay un documento pero no se pudo leer.
   * Las fechas sin cronograma que no figuran acá se dan por no publicadas.
   */
  missingTimetables?: MissingTimetable[];
  /**
   * Rally y rally raid: itinerario de cada evento (tramos o etapas). run.ts lo escribe en
   * data/stages/{seriesId}/{eventId}.json; el evento debe llevar stageCount para que la app lo pida.
   */
  stages?: EventStagesFile[];
}

export interface MissingTimetable {
  eventId: string;
  reason: 'no-publicado' | 'ilegible';
}

export interface ResultsRequest {
  /** Eventos de la temporada de esta serie (de la corrida actual). */
  events: MotorEvent[];
  /** Sesiones finalizadas sin resultado todavía (ordenadas de la más reciente a la más vieja). */
  pendingSessions: Session[];
  /** Todas las sesiones de la serie (para mapear ids). */
  sessions: Session[];
  /** true si hubo una carrera final desde la última actualización del campeonato. */
  standingsStale: boolean;
}

export interface ResultsChunk {
  /** Resultados por evento. run.ts los fusiona con los archivos existentes. */
  results: EventResultsFile[];
  standings?: StandingsFile;
  /**
   * Sesiones que esta corrida no llegó a probar de verdad (la fuente pidió esperar con 429/5xx, o se agotó el cupo
   * de descargas de la corrida): no cuentan como intento fallido y se vuelven a buscar en la próxima.
   */
  deferred?: string[];
}

/**
 * Lector de una fuente oficial. Se invoca una vez por serie; si varias series comparten
 * la misma fuente (p. ej. MotoGP/Moto2/Moto3), usar ctx.http, que memoiza por URL en cada corrida.
 * Ante un error irrecuperable, lanzar: run.ts conserva el último dato bueno como "desactualizado".
 */
export interface Adapter {
  name: string;
  schedule(series: Series, ctx: AdapterContext): Promise<ScheduleChunk>;
  results?(series: Series, ctx: AdapterContext, req: ResultsRequest): Promise<ResultsChunk>;
  /**
   * true si el campeonato de la serie tiene lector directo (receta del sitio). Una tabla publicada que se
   * leyó con IA se relee entonces aunque esté al día, para reemplazarla por la lectura directa.
   */
  prefersDirectStandings?(series: Series): boolean;
  /**
   * ISO UTC del último arreglo del lector de resultados. Las sesiones que se dieron por perdidas (MAX_ATTEMPTS
   * intentos) ANTES de esa fecha vuelven a intentarse un par de veces más: así un lector mejorado recupera los
   * resultados viejos sin borrar a mano data/_cache/results-attempts.json.
   */
  resultsReaderSince?: string;
}
