/**
 * Lógica pura de la grilla y de la auditoría de categorías (Bloque 1 del gem).
 * No depende de Vue ni de Pinia: los getters de los stores la usan y los tests la cubren a través de ellos.
 */
import {
  GROUP_LABELS,
  eventInPeriod,
  formatDayLabel,
  localDate,
  overlaps,
  type MotorEvent,
  type Period,
  type ScheduleFile,
  type Series,
  type SeriesGroup,
  type SeriesStatus,
  type Session,
  type StatusFile,
} from '@dm/shared';
import { hasStages } from './stages.ts';

export interface GridItem {
  session: Session;
  event: MotorEvent | undefined;
  series: Series;
  /** La sesión está en curso en este momento. */
  live: boolean;
  /** La sesión ya terminó. */
  finished: boolean;
}

export interface GridDay {
  /** Fecha local YYYY-MM-DD en la zona de visualización. */
  date: string;
  /** "sábado 28 de noviembre" */
  label: string;
  items: GridItem[];
}

export interface PendingItem {
  event: MotorEvent;
  series: Series;
}

export const GROUP_ORDER: SeriesGroup[] = ['f1-fia', 'moto', 'usa', 'gt-endurance', 'asia', 'rally', 'argentina', 'otros'];

export function seriesSort(a: Series, b: Series): number {
  const ga = GROUP_ORDER.indexOf(a.group);
  const gb = GROUP_ORDER.indexOf(b.group);
  if (ga !== gb) return ga - gb;
  const ca = a.checklistItem ?? 999;
  const cb = b.checklistItem ?? 999;
  if (ca !== cb) return ca - cb;
  return a.name.localeCompare(b.name, 'es');
}

/** Agrupa series por grupo, en el orden de GROUP_ORDER. */
export function groupSeries<T extends { series: Series }>(
  items: T[],
): Array<{ group: SeriesGroup; label: string; items: T[] }> {
  return GROUP_ORDER.map((group) => ({
    group,
    label: GROUP_LABELS[group],
    items: items.filter((i) => i.series.group === group),
  })).filter((g) => g.items.length > 0);
}

/** Sesiones de series visibles que se superponen con el período, en orden cronológico. */
export function sessionsInPeriod(
  schedule: ScheduleFile | null,
  period: Period,
  isVisible: (series: Series) => boolean,
  now: string,
): GridItem[] {
  if (!schedule) return [];
  const series = new Map(schedule.series.map((s) => [s.id, s]));
  const events = new Map(schedule.events.map((e) => [e.id, e]));
  const out: GridItem[] = [];
  for (const session of schedule.sessions) {
    const s = series.get(session.seriesId);
    if (!s || !isVisible(s)) continue;
    if (!overlaps(period, session.startUtc, session.endUtc)) continue;
    out.push({
      session,
      event: events.get(session.eventId),
      series: s,
      live: session.startUtc <= now && now < session.endUtc,
      finished: session.endUtc <= now,
    });
  }
  return out.sort(
    (a, b) =>
      a.session.startUtc.localeCompare(b.session.startUtc) ||
      a.series.name.localeCompare(b.series.name, 'es') ||
      a.session.name.localeCompare(b.session.name, 'es'),
  );
}

/** Agrupa por día local en la zona de visualización (las sesiones ya vienen ordenadas). */
export function groupByDay(items: GridItem[], zone: string): GridDay[] {
  const days: GridDay[] = [];
  for (const item of items) {
    const date = localDate(item.session.startUtc, zone);
    let day = days[days.length - 1];
    if (!day || day.date !== date) {
      day = { date, label: formatDayLabel(date, zone), items: [] };
      days.push(day);
    }
    day.items.push(item);
  }
  return days;
}

/** Eventos del período cuyo cronograma todavía no se publicó ("Horarios a confirmar"). */
export function pendingEventsInPeriod(
  schedule: ScheduleFile | null,
  period: Period,
  isVisible: (series: Series) => boolean,
): PendingItem[] {
  if (!schedule) return [];
  const series = new Map(schedule.series.map((s) => [s.id, s]));
  const out: PendingItem[] = [];
  for (const event of schedule.events) {
    if (event.sessionsStatus !== 'pending') continue;
    const s = series.get(event.seriesId);
    if (!s || !isVisible(s)) continue;
    if (!eventInPeriod(period, event.dateStart, event.dateEnd, event.tz)) continue;
    out.push({ event, series: s });
  }
  return out.sort((a, b) => a.event.dateStart.localeCompare(b.event.dateStart) || seriesSort(a.series, b.series));
}

// ---------------------------------------------------------------------------
// Auditoría de categorías (Bloque 1)
// ---------------------------------------------------------------------------

export type AuditState = 'activa' | 'pendiente' | 'receso' | 'error' | 'desactivada';

export const AUDIT_STATE_LABELS: Record<AuditState, string> = {
  activa: 'ACTIVA',
  pendiente: 'HORARIOS PENDIENTES',
  receso: 'EN RECESO / SIN FECHA',
  error: 'ERROR DE FUENTE',
  desactivada: 'DESACTIVADA',
};

export interface AuditRow {
  series: Series;
  state: AuditState;
  /** La fuente falló en la última corrida y se muestran datos anteriores. */
  stale: boolean;
  sessionCount: number;
  /** Eventos del período sin cronograma (los rallies con el recorrido publicado no cuentan: ver stageEvents). */
  pendingEvents: MotorEvent[];
  /** Rally o rally raid del período con el recorrido publicado (tramos o etapas), tenga o no horas de largada. */
  stageEvents: MotorEvent[];
  /** Eventos del período (con o sin horarios). */
  eventsInPeriod: MotorEvent[];
  /** Próximo evento después del período (para "en receso"). */
  nextEvent?: MotorEvent;
  status?: SeriesStatus;
  officialUrl?: string;
}

export function buildAuditRows(
  schedule: ScheduleFile | null,
  status: StatusFile | null,
  period: Period,
): AuditRow[] {
  if (!schedule) return [];
  const statusById = new Map((status?.series ?? []).map((s) => [s.seriesId, s]));
  const rows: AuditRow[] = [];
  for (const series of [...schedule.series].sort(seriesSort)) {
    const st = statusById.get(series.id);
    const sessionCount = schedule.sessions.filter(
      (s) => s.seriesId === series.id && overlaps(period, s.startUtc, s.endUtc),
    ).length;
    const seriesEvents = schedule.events
      .filter((e) => e.seriesId === series.id)
      .sort((a, b) => a.dateStart.localeCompare(b.dateStart));
    const eventsInPeriod = seriesEvents.filter((e) => eventInPeriod(period, e.dateStart, e.dateEnd, e.tz));
    // Un rally con el recorrido publicado no está "pendiente" aunque el organizador no dé horas de largada (Dakar).
    const stageEvents = eventsInPeriod.filter((e) => hasStages(e));
    const pendingEvents = eventsInPeriod.filter((e) => e.sessionsStatus === 'pending' && !hasStages(e));
    const periodEndDate = period.endUtc.slice(0, 10);
    const nextEvent = seriesEvents.find((e) => e.dateEnd >= periodEndDate && !eventsInPeriod.includes(e));

    let state: AuditState;
    if (!series.enabled || st?.state === 'disabled') state = 'desactivada';
    else if (st?.state === 'error' && sessionCount === 0 && eventsInPeriod.length === 0) state = 'error';
    else if (sessionCount > 0 || stageEvents.length > 0) state = 'activa';
    else if (eventsInPeriod.length > 0) state = 'pendiente';
    else state = 'receso';

    rows.push({
      series,
      state,
      stale: st?.state === 'stale' || (st?.state === 'error' && state !== 'error'),
      sessionCount,
      pendingEvents,
      stageEvents,
      eventsInPeriod,
      nextEvent,
      status: st,
      officialUrl: series.officialUrls[0] ?? st?.sourceUrl,
    });
  }
  return rows;
}

/** Color de acento de una serie (el de config o uno derivado del id). */
export function seriesColor(series: Pick<Series, 'id' | 'color'> | undefined): string {
  if (!series) return '#888';
  if (series.color) return series.color;
  let h = 0;
  for (const ch of series.id) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 65% 55%)`;
}
