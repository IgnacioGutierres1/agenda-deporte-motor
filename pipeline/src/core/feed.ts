import { readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildIcs, localDate, type IcsAllDayEventInput, type IcsEventInput, type MotorEvent, type Series, type Session } from '@dm/shared';
import { writeText } from './store.ts';

/** Días hacia atrás y adelante incluidos en el calendario de suscripción. */
const PAST_DAYS = 2;
const FUTURE_DAYS = 60;

/** Nombre (sin extensión) del calendario general, con todas las categorías: data/feeds/deporte-motor.ics. */
export const MAIN_FEED = 'deporte-motor';

export interface FeedOptions {
  /** Solo estas series (por id). */
  onlySeries?: string[];
  /** Transmisión habitual por serie (config/broadcast.ar.json), para los eventos sin horarios. */
  broadcast?: Record<string, string[]>;
  /** Nombre del calendario (X-WR-CALNAME). Por defecto, "Deporte Motor". */
  calendarName?: string;
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
        // Rally con el recorrido publicado y sin horas de largada (Dakar): no es "horarios a confirmar".
        ...(e.stageCount ? { itinerary: true } : {}),
      };
    });

  return buildIcs([...timed, ...allDay], { now, calendarName: opts.calendarName ?? 'Deporte Motor' });
}

/**
 * Nombre del calendario de una categoría. X-WR-CALNAME es una propiedad extendida y varios clientes no le sacan
 * el escape de RFC 5545: "Turismo Pista (Clases 1, 2 y 3)" se vería como "Clases 1\, 2 y 3". Si el nombre tiene
 * coma o punto y coma se usa el nombre corto ("Turismo Pista"); si ese también los tiene, se cambian por espacios.
 */
export function seriesCalendarName(s: Pick<Series, 'name' | 'shortName'>): string {
  const plain = (t: string) => !/[,;]/.test(t);
  if (plain(s.name)) return s.name;
  if (s.shortName && plain(s.shortName)) return s.shortName;
  return s.name.replace(/\s*[,;]\s*/g, ' ').trim();
}

/** Los ids de serie son slugs (esquema); por las dudas, nada que no lo sea se usa como nombre de archivo. */
const FEED_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function groupBySeries<T extends { seriesId: string }>(items: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const list = out.get(item.seriesId);
    if (list) list.push(item);
    else out.set(item.seriesId, [item]);
  }
  return out;
}

/**
 * Un calendario de suscripción por categoría habilitada (id de la serie → .ics), con las mismas reglas que el
 * general y el nombre de la categoría como nombre del calendario.
 *
 * Se genera aunque la categoría no tenga nada en la ventana (calendario sin eventos): una suscripción ya hecha
 * no tiene que encontrarse con un 404 entre temporadas.
 */
export function buildSeriesFeeds(
  series: Series[],
  events: MotorEvent[],
  sessions: Session[],
  now: Date,
  opts: Pick<FeedOptions, 'broadcast'> = {},
): Map<string, string> {
  const eventsOf = groupBySeries(events);
  const sessionsOf = groupBySeries(sessions);
  const feeds = new Map<string, string>();
  for (const s of series) {
    if (!s.enabled || s.id === MAIN_FEED || !FEED_ID.test(s.id)) continue;
    feeds.set(
      s.id,
      buildFeed([s], eventsOf.get(s.id) ?? [], sessionsOf.get(s.id) ?? [], now, { broadcast: opts.broadcast, calendarName: seriesCalendarName(s) }),
    );
  }
  return feeds;
}

/** El .ics sin las marcas de generación (DTSTAMP), para saber si cambió algo más que la hora de la corrida. */
const withoutStamps = (ics: string) => ics.replace(/^DTSTAMP:.*$/gm, '');

export interface SeriesFeedsReport {
  /** Categorías cuyo .ics se escribió (nuevo o con cambios). */
  written: string[];
  /** Categorías cuyo .ics ya estaba igual (salvo la hora de generación) y no se tocó. */
  unchanged: string[];
  /** Calendarios borrados: categorías que ya no existen o están deshabilitadas. */
  removed: string[];
}

/**
 * Escribe data/feeds/{seriesId}.ics para cada categoría habilitada y borra los .ics de las que ya no existen o
 * están deshabilitadas (el calendario general no se toca). Un calendario que solo cambiaría en la hora de
 * generación no se reescribe: evita que cada corrida modifique decenas de archivos sin novedades.
 */
export async function writeSeriesFeeds(
  feedsDir: string,
  series: Series[],
  events: MotorEvent[],
  sessions: Session[],
  now: Date,
  opts: Pick<FeedOptions, 'broadcast'> = {},
): Promise<SeriesFeedsReport> {
  const feeds = buildSeriesFeeds(series, events, sessions, now, opts);
  const report: SeriesFeedsReport = { written: [], unchanged: [], removed: [] };
  for (const [id, ics] of feeds) {
    const file = path.join(feedsDir, `${id}.ics`);
    const current = await readFile(file, 'utf8').catch(() => null);
    if (current !== null && withoutStamps(current) === withoutStamps(ics)) {
      report.unchanged.push(id);
      continue;
    }
    await writeText(file, ics);
    report.written.push(id);
  }
  const files = await readdir(feedsDir).catch(() => [] as string[]);
  for (const name of files) {
    if (!name.endsWith('.ics')) continue;
    const id = name.slice(0, -'.ics'.length);
    if (id === MAIN_FEED || feeds.has(id)) continue;
    await rm(path.join(feedsDir, name), { force: true });
    report.removed.push(id);
  }
  return report;
}
