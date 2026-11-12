/**
 * Modelo de datos compartido entre el pipeline (que genera los JSON de data/)
 * y la app (que los lee). Todas las horas se guardan en UTC (ISO 8601 con "Z").
 */

export type SeriesGroup =
  | 'f1-fia'
  | 'moto'
  | 'usa'
  | 'gt-endurance'
  | 'asia'
  | 'rally'
  | 'argentina'
  | 'otros';

/** adapter: lector programado específico. generic: flujo genérico con IA sobre el documento oficial. */
export type Strategy = 'adapter' | 'generic';

/** default: las 22 del gem. user: agregada desde la app. discovered: hallada por el descubrimiento. */
export type Origin = 'default' | 'user' | 'discovered';

/** image: el dato se leyó de una imagen oficial (Gemini transcribe el texto de la imagen). */
export type SourceKind = 'api' | 'html' | 'pdf' | 'image';

/** directo: leído sin IA. ia: transcripto por IA (Gemini o, de respaldo, Groq) desde el documento oficial descargado. */
export type SourceMethod = 'directo' | 'ia';

export interface Source {
  url: string;
  title: string;
  kind: SourceKind;
  method: SourceMethod;
  /** ISO UTC del momento en que el pipeline leyó el documento. */
  fetchedAt: string;
  /**
   * Solo method "ia": proveedor/modelo que transcribió el dato (p. ej. "gemini/gemini-3.6-flash",
   * "groq/openai/gpt-oss-120b"; varios unidos con " + "). Falta en datos anteriores a la cadena de IA.
   */
  model?: string;
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
  /**
   * Páginas oficiales con la lista de inscriptos (pilotos, equipos, números y autos) de la temporada.
   * Las lee una receta sin IA y se publican en data/rosters/{id}.json.
   */
  rosterUrls?: string[];
}

export type SessionType =
  | 'practica'
  | 'clasificacion'
  | 'sprint'
  | 'serie'
  | 'carrera'
  | 'warmup'
  /** Rally y rally raid: bloque de tramos de un día (WRC) o etapa (Dakar). El detalle va en data/stages. */
  | 'etapa'
  | 'otro';

export interface MotorEvent {
  /** Hash estable de serie + temporada + nombre/ronda. */
  id: string;
  seriesId: string;
  name: string;
  round?: number;
  /** Nombre del circuito o sede ("A confirmar" si todavía no se conoce). */
  circuit: string;
  /** País en español ("Estados Unidos", "Reino Unido"); vacío si la fuente no lo informa. */
  country: string;
  /** Zona IANA del circuito, p. ej. "Asia/Qatar". */
  tz: string;
  /** Fechas locales del circuito, YYYY-MM-DD. */
  dateStart: string;
  dateEnd: string;
  /** published: ya hay cronograma con horarios. pending: solo se conoce la fecha. */
  sessionsStatus: 'published' | 'pending';
  /**
   * Tipo de evento cuando no es una fecha del campeonato. 'test': ensayos oficiales, pretemporada o prólogo
   * (F1 "Pre-Season Testing", WEC "Official Prologue", GT Open "Winter Test"…): no suman puntos ni tienen ronda,
   * y no van al .ics de suscripción como evento de día completo (sí sus sesiones, si las tienen).
   * Ausente = fecha normal del campeonato. Opcional: los datos viejos no lo traen.
   */
  kind?: EventKind;
  /** Solo rally y rally raid: superficie predominante de la prueba. */
  surface?: Surface;
  /**
   * Solo rally y rally raid: cantidad de tramos o etapas publicados en data/stages/{seriesId}/{eventId}.json.
   * Su presencia le avisa a la app que ese archivo existe (pestaña "Etapas").
   */
  stageCount?: number;
  source: Source;
}

/** Ver MotorEvent.kind. */
export type EventKind = 'test';

export interface Session {
  /** Hash estable de serie + evento + nombre de sesión. */
  id: string;
  eventId: string;
  seriesId: string;
  type: SessionType;
  /** Nombre en español ("Práctica 1", "Clasificación", "Carrera principal"): traducido si la fuente está en otro idioma. */
  name: string;
  /**
   * Nombre tal como lo publica la fuente, solo si difiere de `name` ("Practice 1", "Feature Race"). Sirve para
   * unir resultados y tiempos en vivo que vienen con el nombre original. Ausente en datos viejos.
   */
  originalName?: string;
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
  /** Condiciones medidas por la organización durante la sesión, si la fuente de resultados las publica. */
  conditions?: SessionConditions;
  source: Source;
}

/** Condiciones medidas en pista durante una sesión (dato oficial, no pronóstico). */
export interface SessionConditions {
  /** Temperatura del aire, °C. */
  airC?: number;
  /** Temperatura del asfalto, °C. */
  trackC?: number;
  /** Humedad relativa, %. */
  humidity?: number;
  /** Estado de la pista en español: "Seca", "Mojada", "Húmeda". */
  track?: string;
  /** Estado del cielo en español: "Despejado", "Nublado", "Lluvia". */
  weather?: string;
  windKmh?: number;
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
  /**
   * País o nacionalidad del piloto (nombre en inglés o código ISO), si la tabla lo publica. El índice de pilotos
   * lo usa solo si ninguna lista de inscriptos lo da: en la 24H Series hay pilotos que no figuran en ninguna
   * lista publicada (la del último evento sale sin tripulaciones).
   */
  country?: string;
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

/** Un piloto inscripto en la temporada, tal como lo publica la lista oficial de inscriptos. */
export interface RosterRow {
  driver: string;
  team?: string;
  number?: string;
  vehicle?: string;
  /** Clase dentro de la categoría ("Hypercar", "LMGT3", "GT500", "Pro-Am"). */
  class?: string;
  /** País o nacionalidad tal como la publica la fuente (nombre en inglés o código ISO). */
  country?: string;
}

/** Contenido de data/rosters/{seriesId}.json */
export interface RosterFile {
  seriesId: string;
  season: number;
  updatedAt: string;
  rows: RosterRow[];
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
  /**
   * Motivo legible del estado: el error de la fuente o, con la serie OK, qué cronogramas faltan ("El organizador
   * todavía no publicó el cronograma de X" / "No se pudo leer el cronograma de Y").
   */
  message?: string;
  sourceUrl?: string;
  standingsAvailable: boolean;
  /**
   * Cobertura de cronogramas: de las fechas dentro del horizonte de búsqueda de cronogramas (desde ayer hasta
   * horizonDays días adelante), cuántas ya tienen sesiones con horario. Solo si hay alguna fecha en el horizonte.
   */
  timetables?: TimetableCoverage;
}

export interface TimetableCoverage {
  /** Fechas en el horizonte con cronograma publicado. */
  found: number;
  /** Fechas en el horizonte. */
  due: number;
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

/** Nota de una fuente oficial o de un medio especializado (data/news.json). */
export interface NewsItem {
  /** Hash estable del link. */
  id: string;
  title: string;
  /** Link a la nota original (siempre se lee en el sitio de la fuente). */
  url: string;
  /** Nombre de la fuente ("Formula 1", "ACTC", "Motorsport.com"). */
  source: string;
  sourceKind: 'oficial' | 'medio';
  /** ISO UTC de publicación. */
  publishedAt: string;
  /** Imagen de portada publicada por la fuente (link, no se copia). */
  image?: string;
  /** Bajada corta en texto plano. */
  summary?: string;
  /** Categorías a las que se refiere (por la fuente o por palabras clave del título). */
  seriesIds: string[];
  lang?: string;
  /** La misma nota en otros medios o idiomas (agrupada para no repetirla en la lista). */
  alsoIn?: NewsAlternate[];
}

/** Otra versión de la misma nota (otro medio u otra edición/idioma del mismo medio). */
export interface NewsAlternate {
  source: string;
  url: string;
  lang?: string;
}

/** Contenido de data/news.json */
export interface NewsFile {
  version: 1;
  generatedAt: string;
  items: NewsItem[];
}

// ── Rally y rally raid ──

/** Superficie de un rally o de un tramo. 'mixto' = asfalto y tierra; 'arena' = desierto (rally raid). */
export type Surface = 'asfalto' | 'tierra' | 'nieve' | 'arena' | 'mixto';

/** Qué es cada renglón del itinerario de un rally. */
export type StageKind = 'shakedown' | 'prologo' | 'especial' | 'superespecial' | 'power' | 'enlace' | 'descanso';

/** Porción de una etapa por tipo de terreno (Dakar: "Arena 45 %", "Dunas 10 %"…). */
export interface StageTerrain {
  /** En español: "Arena", "Dunas", "Tierra", "Piedras", "Asfalto"… */
  label: string;
  percent?: number;
  km?: number;
}

/** Un tramo cronometrado (WRC) o una etapa (Dakar). */
export interface RallyStage {
  /** "SS1", "Shakedown", "Prólogo", "Etapa 3". */
  code: string;
  /** Nombre del tramo ("Col de Turini") o recorrido de la etapa ("Loulé > Loulé"). */
  name: string;
  kind: StageKind;
  /** Fecha local YYYY-MM-DD. */
  date: string;
  /** Largada del primer auto, ISO UTC, si la fuente la publica. */
  startUtc?: string;
  /** Hora local tal como figura en la fuente ("08:03"). */
  localStartText?: string;
  /** Kilómetros cronometrados (especial). */
  distanceKm?: number;
  /** Kilómetros de enlace. */
  liaisonKm?: number;
  /** Total del día (especial + enlace), si la fuente lo da. */
  totalKm?: number;
  surface?: Surface;
  terrain?: StageTerrain[];
  /** Imagen oficial del mapa del tramo o la etapa (link, no se copia). */
  mapUrl?: string;
  /** Descripción corta de la fuente. */
  note?: string;
  cancelled?: boolean;
  /** Sesión de la agenda a la que pertenece (bloque del día o etapa). */
  sessionId?: string;
}

/** Contenido de data/stages/{seriesId}/{eventId}.json */
export interface EventStagesFile {
  seriesId: string;
  eventId: string;
  updatedAt: string;
  surface?: Surface;
  /** Aclaración de la superficie: "Asfalto con nieve y hielo". */
  surfaceNote?: string;
  /** Kilómetros cronometrados de toda la prueba. */
  competitiveKm?: number;
  /** Kilómetros totales (con enlaces). */
  totalKm?: number;
  /** Mapa general del recorrido (link a la imagen oficial). */
  routeMapUrl?: string;
  /** Crédito del mapa, si hace falta. */
  routeMapCredit?: string;
  stages: RallyStage[];
  source: Source;
}

// ── Circuitos ──

/** Imagen de Wikimedia Commons (se enlaza, no se copia) con su atribución. */
export interface CircuitImage {
  /** URL de la imagen a un ancho razonable para la app (~960 px). */
  url: string;
  width?: number;
  height?: number;
  /** Autor ("Will Pittenger"). */
  credit: string;
  /** Licencia corta ("CC BY-SA 4.0", "Dominio público"). */
  license: string;
  /** Página del archivo en Commons (para la atribución). */
  page: string;
}

export interface CircuitLapRecord {
  /** "1:27.097" */
  time: string;
  driver?: string;
  vehicle?: string;
  year?: number;
  /** Categoría del récord ("F1", "MotoGP"). */
  series?: string;
}

/** Ficha de un circuito del calendario (data/circuits.json), armada con Wikidata/Wikipedia. */
export interface CircuitInfo {
  /** Id del circuito en la app: slug de circuitKey(nombre). */
  id: string;
  /** Nombre oficial o más conocido, en español si existe. */
  name: string;
  /** Id de Wikidata ("Q171424"), si se identificó. */
  wikidata?: string;
  lat?: number;
  lon?: number;
  /** true si las coordenadas son las de la ciudad (no se identificó el circuito): alcanzan para el clima. */
  coordsApprox?: boolean;
  /** Ciudad o localidad. */
  city?: string;
  /** Longitud del trazado principal, en metros. */
  lengthM?: number;
  turns?: number;
  /** Año de inauguración. */
  opened?: number;
  capacity?: number;
  /** Altitud, metros sobre el nivel del mar. */
  elevationM?: number;
  /** "Horario" o "Antihorario". */
  direction?: string;
  lapRecord?: CircuitLapRecord;
  /** Extracto corto en español (o inglés si no hay), texto plano. */
  summary?: string;
  /** Idioma del extracto ('es' | 'en'). */
  summaryLang?: string;
  website?: string;
  wikipediaUrl?: string;
  photo?: CircuitImage;
  /** Plano del trazado (imagen de Commons). */
  map?: CircuitImage;
  /** true si existe data/tracks/{id}.json con el trazado dibujable (OpenStreetMap). */
  hasTrack?: boolean;
  /** ISO UTC de la última consulta (para no volver a consultar en cada corrida). */
  checkedAt: string;
}

/** Contenido de data/circuits.json */
export interface CircuitsFile {
  version: 1;
  generatedAt: string;
  circuits: CircuitInfo[];
}

/** Contenido de data/tracks/{circuitId}.json: trazado dibujable del circuito (OpenStreetMap). */
export interface CircuitTrackFile {
  id: string;
  updatedAt: string;
  /** Tamaño del lienzo en unidades del path (norte arriba). */
  width: number;
  height: number;
  /** Paths SVG ("M x y L x y …") de la pista; el primero es el trazado principal. */
  paths: string[];
  /** Calle de boxes y variantes secundarias, si se distinguen. */
  secondary?: string[];
  /** Metros por unidad del lienzo (para dibujar la escala). */
  metersPerUnit?: number;
  /** "© Colaboradores de OpenStreetMap" */
  credit: string;
  /** "ODbL" */
  license: string;
  source: Source;
}
