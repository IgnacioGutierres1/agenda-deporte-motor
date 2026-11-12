/**
 * Lógica pura de la Agenda (pantalla principal al estilo FotMob): franja de días,
 * "Finde" y agrupación de sesiones por evento. Sin Vue ni Pinia.
 */
import { DateTime } from 'luxon';
import { resolvePeriod, type MotorEvent, type Period, type ScheduleFile, type Series, type Session } from '@dm/shared';
import { fixMonthAbbr } from './format.ts';
import { seriesSort, type GridItem, type PendingItem } from './grid.ts';

/** Día elegido en la franja: fecha local YYYY-MM-DD, o "finde" (fin de semana en curso o el próximo). */
export type AgendaDay = string;
export const WEEKEND = 'finde';

export interface StripDay {
  /** YYYY-MM-DD o "finde". */
  value: AgendaDay;
  /** "Hoy", "Ayer", "Mañana", "jue, 12 nov" o "Finde". */
  label: string;
}

export function todayIn(now: string, zone: string): string {
  return DateTime.fromISO(now, { zone: 'utc' }).setZone(zone).toISODate()!;
}

/** Franja de días: "Finde", y desde `back` días atrás hasta `ahead` días adelante. */
export function dayStrip(now: string, zone: string, back = 7, ahead = 30): StripDay[] {
  const today = DateTime.fromISO(todayIn(now, zone), { zone });
  const out: StripDay[] = [{ value: WEEKEND, label: 'Finde' }];
  for (let i = -back; i <= ahead; i++) {
    const d = today.plus({ days: i });
    out.push({ value: d.toISODate()!, label: dayLabel(i, d) });
  }
  return out;
}

function dayLabel(offset: number, d: DateTime): string {
  if (offset === 0) return 'Hoy';
  if (offset === -1) return 'Ayer';
  if (offset === 1) return 'Mañana';
  return fixMonthAbbr(d.setLocale('es-AR').toFormat('ccc, d LLL').replace(/\./g, ''));
}

/** Período (UTC) de un día local o del fin de semana. */
export function agendaPeriod(day: AgendaDay, now: string, zone: string): Period {
  if (day === WEEKEND) return resolvePeriod('este-finde', now, { zone });
  const start = DateTime.fromISO(day, { zone }).startOf('day');
  return {
    startUtc: start.toUTC().toISO({ suppressMilliseconds: true })!,
    endUtc: start.plus({ days: 1 }).toUTC().toISO({ suppressMilliseconds: true })!,
  };
}

/** Tarjeta de la agenda: un evento de una categoría con sus sesiones del día (como una competencia en FotMob). */
export interface AgendaCard {
  key: string;
  series: Series;
  event: MotorEvent | undefined;
  items: GridItem[];
  live: boolean;
}

/** Agrupa las sesiones por evento, ordenando las tarjetas por la primera sesión y luego por categoría. */
export function groupByEvent(items: GridItem[]): AgendaCard[] {
  const cards = new Map<string, AgendaCard>();
  for (const item of items) {
    const key = item.event?.id ?? `${item.series.id}:${item.session.eventId}`;
    let card = cards.get(key);
    if (!card) {
      card = { key, series: item.series, event: item.event, items: [], live: false };
      cards.set(key, card);
    }
    card.items.push(item);
    card.live ||= item.live;
  }
  return [...cards.values()].sort(
    (a, b) =>
      Number(b.live) - Number(a.live) ||
      a.items[0]!.session.startUtc.localeCompare(b.items[0]!.session.startUtc) ||
      seriesSort(a.series, b.series),
  );
}

/** Próximo evento (en curso o futuro) de una categoría, con su primera sesión pendiente si la hay. */
export interface NextEvent {
  event: MotorEvent;
  /** Primera sesión que todavía no terminó. */
  nextSession?: { name: string; startUtc: string };
  live: boolean;
}

export function nextEventOf(schedule: ScheduleFile | null, seriesId: string, now: string): NextEvent | null {
  if (!schedule) return null;
  const events = schedule.events
    .filter((e) => e.seriesId === seriesId && e.dateEnd >= todayIn(now, e.tz))
    .sort((a, b) => a.dateStart.localeCompare(b.dateStart));
  const event = events[0];
  if (!event) return null;
  const sessions = schedule.sessions
    .filter((s) => s.eventId === event.id && s.endUtc > now)
    .sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  const first = sessions[0];
  return {
    event,
    ...(first ? { nextSession: { name: first.name, startUtc: first.startUtc } } : {}),
    live: !!first && first.startUtc <= now,
  };
}

/** Eventos de una categoría ya disputados (empezados), del más reciente al más viejo. */
export function pastEventsOf(schedule: ScheduleFile | null, seriesId: string, now: string): MotorEvent[] {
  if (!schedule) return [];
  return schedule.events
    .filter((e) => e.seriesId === seriesId && e.dateStart <= todayIn(now, e.tz))
    .sort((a, b) => b.dateStart.localeCompare(a.dateStart));
}

/** Pendientes de categorías seguidas primero. */
export function splitFollowed<T extends { series: Series }>(list: T[], followed: string[]): { followed: T[]; rest: T[] } {
  const set = new Set(followed);
  return { followed: list.filter((x) => set.has(x.series.id)), rest: list.filter((x) => !set.has(x.series.id)) };
}

export type { PendingItem };

// ---------------------------------------------------------------------------
// Días dentro de una tarjeta, madrugada y "próxima sesión" (estado vacío)
// ---------------------------------------------------------------------------

/** Sesiones de una tarjeta de un mismo día local (para los subtítulos "Viernes 13" de la vista Finde). */
export interface SessionDayGroup {
  /** YYYY-MM-DD en la zona de visualización. */
  date: string;
  /** "Viernes 13" */
  label: string;
  items: GridItem[];
}

/** "Viernes 13" a partir de una fecha local YYYY-MM-DD. */
export function shortDayLabel(date: string, zone: string): string {
  const s = DateTime.fromISO(date, { zone }).setLocale('es-AR').toFormat('cccc d');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Agrupa las sesiones (ya ordenadas) por día local, para que los cambios de día se vean dentro de la tarjeta. */
export function groupSessionsByDay(items: GridItem[], zone: string): SessionDayGroup[] {
  const out: SessionDayGroup[] = [];
  for (const item of items) {
    const date = DateTime.fromISO(item.session.startUtc, { zone: 'utc' }).setZone(zone).toISODate()!;
    let group = out[out.length - 1];
    if (!group || group.date !== date) {
      group = { date, label: shortDayLabel(date, zone), items: [] };
      out.push(group);
    }
    group.items.push(item);
  }
  return out;
}

/** true si la sesión empieza de madrugada (00:00 a 06:59) en la zona del usuario. */
export function isLateNight(isoUtc: string, zone: string): boolean {
  return DateTime.fromISO(isoUtc, { zone: 'utc' }).setZone(zone).hour < 7;
}

/** "hoy", "mañana", "el viernes 20" (dentro de la semana) o "el vie 4 dic". */
export function relativeDay(date: string, today: string, zone: string): string {
  const d = DateTime.fromISO(date, { zone }).setLocale('es-AR');
  const diff = Math.round(d.diff(DateTime.fromISO(today, { zone }), 'days').days);
  if (diff === 0) return 'hoy';
  if (diff === 1) return 'mañana';
  if (diff === -1) return 'ayer';
  if (diff > 1 && diff < 7) return `el ${d.toFormat('cccc d')}`;
  return `el ${fixMonthAbbr(d.toFormat('ccc d LLL').replace(/\./g, ''))}`;
}

/** Próxima sesión (de las categorías visibles) que empieza desde un instante dado. */
export interface NextSession {
  session: Session;
  series: Series;
  event: MotorEvent | undefined;
}

export function nextSessionFrom(
  schedule: ScheduleFile | null,
  fromUtc: string,
  isVisible: (series: Series) => boolean,
): NextSession | null {
  if (!schedule) return null;
  const series = new Map(schedule.series.map((s) => [s.id, s]));
  let best: Session | null = null;
  for (const session of schedule.sessions) {
    if (session.startUtc < fromUtc) continue;
    const s = series.get(session.seriesId);
    if (!s || !isVisible(s)) continue;
    if (!best || session.startUtc < best.startUtc) best = session;
  }
  if (!best) return null;
  return { session: best, series: series.get(best.seriesId)!, event: schedule.events.find((e) => e.id === best!.eventId) };
}

/** Texto del estado vacío de un día: "Hoy no hay sesiones", "Este fin de semana no hay sesiones"… */
export function emptyDayText(day: AgendaDay, today: string, zone: string): string {
  if (day === WEEKEND) return 'Este fin de semana no hay sesiones';
  if (day === today) return 'Hoy no hay sesiones';
  const rel = relativeDay(day, today, zone);
  if (rel === 'mañana' || rel === 'ayer') return `${rel.charAt(0).toUpperCase()}${rel.slice(1)} no hay sesiones`;
  return `No hay sesiones ${rel}`;
}

/**
 * Título de los eventos sin cronograma: deja claro que corren ese fin de semana,
 * no que tienen actividad a esa hora del día elegido.
 */
export function pendingTitle(day: AgendaDay, now: string, zone: string): string {
  if (day === WEEKEND) return 'Este fin de semana, horarios a confirmar';
  const finde = resolvePeriod('este-finde', now, { zone });
  const start = DateTime.fromISO(day, { zone }).startOf('day').toUTC().toISO({ suppressMilliseconds: true })!;
  if (start >= finde.startUtc && start < finde.endUtc) return 'Este fin de semana, horarios a confirmar';
  return 'Horarios a confirmar';
}
