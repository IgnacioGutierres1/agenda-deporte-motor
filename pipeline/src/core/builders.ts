import {
  addMinutes,
  stableHash,
  type MotorEvent,
  type Series,
  type Session,
  type SessionType,
  type Source,
} from '@dm/shared';

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
      return {
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
        source: i.source,
      };
    },
    session(i) {
      const fromSource = i.broadcast && i.broadcast.length > 0;
      const endUtc = i.endUtc ?? addMinutes(i.startUtc, estimateMinutes(i.event.seriesId, i.type));
      return {
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
      };
    },
  };
}

/** Clasifica un nombre de sesión (en inglés o español) en un SessionType. */
export function classifySession(name: string): SessionType {
  const n = name.toLowerCase();
  if (/warm\s*-?\s*up/.test(n)) return 'warmup';
  if (/sprint\s*(qualifying|shootout|clasificaci)/.test(n)) return 'clasificacion';
  if (/qualif|clasif|pole|shootout|super\s*pole|hyperpole|q1|q2/.test(n)) return 'clasificacion';
  if (/sprint/.test(n)) return 'sprint';
  if (/practi|entren|libre|fp\d|test|ensayo/.test(n)) return 'practica';
  if (/\bserie|\bheat/.test(n)) return 'serie';
  if (/race|carrera|final|feature|grand prix|gran premio|\bgp\b/.test(n)) return 'carrera';
  return 'otro';
}
