import {
  addMinutes,
  normalizeCircuitName,
  normalizeEventName,
  spanishSessionName,
  stableHash,
  type EventKind,
  type MotorEvent,
  type Series,
  type Session,
  type SessionType,
  type Source,
  type Surface,
} from '@dm/shared';
import { countryEs } from '../generic/places.ts';

export type DurationsConfig = Record<string, Partial<Record<SessionType, number>>>;
export type BroadcastConfig = Record<string, string[]>;

export interface EventInput {
  series: Series;
  season: number;
  /** Clave única dentro de la temporada (número de ronda, slug del GP…). */
  key: string | number;
  name: string;
  round?: number;
  circuit: string;
  country: string;
  tz: string;
  dateStart: string;
  dateEnd: string;
  sessionsStatus: MotorEvent['sessionsStatus'];
  /** Si falta, se deduce del nombre (ver eventKindOf). */
  kind?: EventKind;
  /** Solo rally y rally raid. */
  surface?: Surface;
  /** Solo rally y rally raid: cantidad de tramos o etapas del itinerario (ScheduleChunk.stages). */
  stageCount?: number;
  source: Source;
}

export interface SessionInput {
  event: MotorEvent;
  type: SessionType;
  name: string;
  startUtc: string;
  /** Si no se conoce, se estima con config/durations.json y endEstimated = true. */
  endUtc?: string;
  localStartText?: string;
  /** Transmisión informada por la fuente. Si falta, se usa la habitual de config/broadcast.ar.json. */
  broadcast?: string[];
  source: Source;
  /** Desambiguador opcional cuando dos sesiones comparten nombre (p. ej. "Serie 1", "Serie 2"). */
  key?: string | number;
}

export interface Builders {
  event(input: EventInput): MotorEvent;
  session(input: SessionInput): Session;
  estimateMinutes(seriesId: string, type: SessionType): number;
  defaultBroadcast(seriesId: string): string[];
}

export function createBuilders(durations: DurationsConfig, broadcast: BroadcastConfig): Builders {
  const estimateMinutes = (seriesId: string, type: SessionType): number =>
    durations[seriesId]?.[type] ?? durations.default?.[type] ?? 60;
  const defaultBroadcast = (seriesId: string): string[] => broadcast[seriesId] ?? [];

  return {
    estimateMinutes,
    defaultBroadcast,
    event(i) {
      // El tipo se deduce del nombre original y el id sale de la clave (nunca del nombre ya normalizado).
      const kind = i.kind ?? eventKindOf(i.name);
      return normalizeEvent(
        {
          id: stableHash(i.series.id, i.season, i.key),
          seriesId: i.series.id,
          name: i.name,
          ...(i.round !== undefined ? { round: i.round } : {}),
          circuit: i.circuit,
          country: i.country,
          tz: i.tz,
          dateStart: i.dateStart,
          dateEnd: i.dateEnd,
          sessionsStatus: i.sessionsStatus,
          ...(kind ? { kind } : {}),
          ...(i.surface ? { surface: i.surface } : {}),
          ...(i.stageCount !== undefined ? { stageCount: i.stageCount } : {}),
          source: i.source,
        },
        i.series,
      );
    },
    session(i) {
      const fromSource = i.broadcast && i.broadcast.length > 0;
      const endUtc = i.endUtc ?? addMinutes(i.startUtc, estimateMinutes(i.event.seriesId, i.type));
      return normalizeSession({
        // El id usa el nombre tal como lo publica la fuente (el traducido puede cambiar si mejora el diccionario).
        id: stableHash(i.event.id, i.type, i.name, i.key),
        eventId: i.event.id,
        seriesId: i.event.seriesId,
        type: i.type,
        name: i.name,
        startUtc: i.startUtc,
        endUtc,
        endEstimated: !i.endUtc,
        ...(i.localStartText ? { localStartText: i.localStartText } : {}),
        broadcast: fromSource ? i.broadcast! : defaultBroadcast(i.event.seriesId),
        broadcastIsDefault: !fromSource,
        source: i.source,
        hasResults: false,
      });
    },
  };
}

/**
 * Nombre, circuito y país prolijos para publicar (ver @dm/shared names.ts): mayúsculas, acentos de lugares
 * argentinos, prefijos de ronda repetidos ("Round1 …"), sede "a confirmar" y país en español. No cambia el id.
 * Idempotente: también se aplica a los eventos que se conservan de corridas anteriores.
 */
export function normalizeEvent(e: MotorEvent, series: Pick<Series, 'group'> | undefined): MotorEvent {
  const country = countryEs(e.country, e.tz);
  const opts = {
    argentina: series?.group === 'argentina' || country === 'Argentina',
    // NASCAR, IndyCar e IMSA escriben en mayúsculas marcas y carreras a propósito ("DAYTONA 500", "XPEL").
    titleCase: series?.group !== 'usa',
  };
  return {
    ...e,
    name: normalizeEventName(e.name, { ...opts, ...(e.round !== undefined ? { round: e.round } : {}) }),
    circuit: normalizeCircuitName(e.circuit, opts),
    country,
  };
}

/**
 * Nombre de sesión en español, con el original de la fuente en originalName (solo si cambió). El id no cambia.
 * Idempotente: si ya tiene originalName, se vuelve a traducir desde ese.
 */
export function normalizeSession(s: Session): Session {
  const original = s.originalName ?? s.name;
  const name = spanishSessionName(original);
  const { originalName: _o, ...rest } = s;
  return { ...rest, name, ...(name !== original ? { originalName: original } : {}) };
}

/** Clasifica un nombre de sesión (en inglés o español) en un SessionType. */
export function classifySession(name: string): SessionType {
  const n = name.toLowerCase();
  if (/warm\s*-?\s*up/.test(n)) return 'warmup';
  if (/sprint\s*(qualifying|shootout|clasificaci)/.test(n)) return 'clasificacion';
  // "Qualification Race" (Macao): es una carrera que define la grilla de la principal, no una clasificación.
  if (/qualif\w*\s+race|carrera\s+clasificatoria/.test(n)) return 'sprint';
  if (/qualif|clasif|pole|shootout|super\s*pole|hyperpole|q1|q2/.test(n)) return 'clasificacion';
  if (/sprint/.test(n)) return 'sprint';
  if (/practi|entren|libre|fp\d|test|ensayo|shakedown/.test(n)) return 'practica';
  if (/\bserie|\bheat/.test(n)) return 'serie';
  if (/race|carrera|final|feature|grand prix|gran premio|\bgp\b/.test(n)) return 'carrera';
  return 'otro';
}

/**
 * Ensayos oficiales, pretemporada y prólogos ("Pre-Season Testing", "Official Test Days - Prologue",
 * "Barcelona Winter Test", "Official Tests - Barcelona", "Ensayos oficiales"…). Ojo: "Shakedown" es una sesión
 * de práctica dentro de una fecha, no un evento de ensayos.
 */
const TEST_EVENT =
  /\btest(?:s|ing)?\b|\bprolog(?:ue)?\b|\bpr[oó]logo\b|\bensayos?\s+(?:oficial|colectiv|de\s+pretemporada)|\bpruebas?\s+(?:oficial|colectiv|de\s+pretemporada)|\b(?:test|einstell)fahrten\b/i;

/** Tipo de evento según su nombre oficial: 'test' para ensayos y prólogos; undefined para una fecha normal. */
export function eventKindOf(name: string): EventKind | undefined {
  return TEST_EVENT.test(name) ? 'test' : undefined;
}

/**
 * Galas, entregas de premios, ceremonias y presentaciones que algunos calendarios oficiales listan entre las fechas
 * ("2026 End of Year Gala" del GT World Challenge America): no son eventos de pista y no se publican.
 * Cuidado con los nombres comerciales de carreras: "… 400 presented by …" o "GT Festival …" sí son fechas.
 */
const NON_RACE_EVENT =
  /\bgala\b|\bawards?\b|\bceremon(?:y|ies|ia)\b|\bbanquet\b|\bpremiaci[oó]n\b|\bentrega\s+de\s+premios\b|\bpresentation\b|\bpresentaci[oó]n\b|\bseason\s+launch\b|\blanzamiento\b/i;

/** true si el "evento" del calendario no es una competencia ni un ensayo (gala, premiación, presentación). */
export function isNonRaceEvent(name: string): boolean {
  return NON_RACE_EVENT.test(name);
}
