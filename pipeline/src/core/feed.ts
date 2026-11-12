import { buildIcs, localDate, type IcsAllDayEventInput, type IcsEventInput, type MotorEvent, type Series, type Session } from '@dm/shared';

/** Días hacia atrás y adelante incluidos en el calendario de suscripción. */
const PAST_DAYS = 2;
const FUTURE_DAYS = 60;

export interface FeedOptions {
  /** Solo estas series (por id). */
  onlySeries?: string[];
  /** Transmisión habitual por serie (config/broadcast.ar.json), para los eventos sin horarios. */
  broadcast?: Record<string, string[]>;
}

/** Fecha local de un instante en la zona del circuito; si la zona no es válida, la fecha UTC. */
function dateIn(isoUtc: string, tz: string): string {
  try {
    return localDate(isoUtc, tz) || isoUtc.slice(0, 10);
  } catch {
    return isoUtc.slice(0, 10);
  }
}

/**
 * Genera el .ics de suscripción (data/feeds/deporte-motor.ics) con las mismas reglas que la descarga.
 *
 * Además de las sesiones con horario, cada evento futuro todavía sin cronograma (sessionsStatus 'pending' y
 * ninguna sesión) va como evento de día completo con UID = id del evento: cuando se publican los horarios ese
 * evento deja de emitirse y los calendarios suscriptos lo reemplazan por las sesiones al refrescar. Los ensayos
 * (MotorEvent.kind 'test') no van como día completo.
 */
export function buildFeed(
  series: Series[],
  events: MotorEvent[],
  sessions: Session[],
  now: Date,
  opts: FeedOptions = {},
): string {
  const seriesById = new Map(series.map((s) => [s.id, s]));
  const eventsById = new Map(events.map((e) => [e.id, e]));
  const included = (seriesId: string) => !!seriesById.get(seriesId)?.enabled && (!opts.onlySeries || opts.onlySeries.includes(seriesId));
  const nowIso = now.toISOString();
  const from = new Date(now.getTime() - PAST_DAYS * 86_400_000).toISOString();
  const to = new Date(now.getTime() + FUTURE_DAYS * 86_400_000).toISOString();
  const selected = sessions.filter((s) => s.startUtc >= from && s.startUtc <= to && included(s.seriesId));
  const timed: IcsEventInput[] = selected.map((s) => {
    const ev = eventsById.get(s.eventId);
    return {
      id: s.id,
      startUtc: s.startUtc,
      endUtc: s.endUtc,
      seriesName: seriesById.get(s.seriesId)?.name ?? s.seriesId,
      circuit: ev?.circuit ?? '',
      country: ev?.country ?? '',
      sessionName: s.name,
      broadcast: s.broadcast,
      broadcastIsDefault: s.broadcastIsDefault,
      sourceUrl: s.source.url,
      fromImage: s.source.kind === 'image',
    };
  });

  // Eventos sin horarios: desde hoy (los que terminan hoy todavía cuentan) hasta el mismo horizonte que las sesiones.
  // Los ensayos (kind 'test') no van como día completo: sin horarios no aportan nada al calendario y se confundían
  // con carreras; si publican sesiones, esas sí van (arriba).
  const withSessions = new Set(sessions.map((s) => s.eventId));
  const allDay: IcsAllDayEventInput[] = events
    .filter(
      (e) =>
        e.sessionsStatus === 'pending' &&
        e.kind !== 'test' &&
        !withSessions.has(e.id) &&
        included(e.seriesId) &&
        e.dateEnd >= dateIn(nowIso, e.tz) &&
        e.dateStart <= dateIn(to, e.tz),
    )
    .map((e) => {
      const broadcast = opts.broadcast?.[e.seriesId] ?? [];
      return {
        allDay: true,
        id: e.id,
        dateStart: e.dateStart,
        dateEnd: e.dateEnd,
        seriesName: seriesById.get(e.seriesId)?.name ?? e.seriesId,
        circuit: e.circuit,
        eventName: e.name,
        country: e.country,
        broadcast,
        broadcastIsDefault: broadcast.length > 0,
        sourceUrl: e.source.url,
      };
    });

  return buildIcs([...timed, ...allDay], { now, calendarName: 'Deporte Motor' });
}
