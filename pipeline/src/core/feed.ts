import { buildIcs, type MotorEvent, type Series, type Session } from '@dm/shared';

/** Días hacia atrás y adelante incluidos en el calendario de suscripción. */
const PAST_DAYS = 2;
const FUTURE_DAYS = 60;

/** Genera el .ics de suscripción (data/feeds/deporte-motor.ics) con las mismas reglas que la descarga. */
export function buildFeed(
  series: Series[],
  events: MotorEvent[],
  sessions: Session[],
  now: Date,
  onlySeries?: string[],
): string {
  const seriesById = new Map(series.map((s) => [s.id, s]));
  const eventsById = new Map(events.map((e) => [e.id, e]));
  const from = new Date(now.getTime() - PAST_DAYS * 86_400_000).toISOString();
  const to = new Date(now.getTime() + FUTURE_DAYS * 86_400_000).toISOString();
  const selected = sessions.filter(
    (s) =>
      s.startUtc >= from &&
      s.startUtc <= to &&
      seriesById.get(s.seriesId)?.enabled &&
      (!onlySeries || onlySeries.includes(s.seriesId)),
  );
  return buildIcs(
    selected.map((s) => {
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
        sourceUrl: s.source.url,
        fromImage: s.source.kind === 'image',
      };
    }),
    { now, calendarName: 'Deporte Motor' },
  );
}
