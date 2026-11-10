/**
 * Lógica pura de la Agenda (pantalla principal al estilo FotMob): franja de días,
 * "Finde" y agrupación de sesiones por evento. Sin Vue ni Pinia.
 */
import { DateTime } from 'luxon';
import { resolvePeriod, type MotorEvent, type Period, type ScheduleFile, type Series } from '@dm/shared';
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
  return d.setLocale('es-AR').toFormat('ccc, d LLL').replace(/\./g, '');
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
