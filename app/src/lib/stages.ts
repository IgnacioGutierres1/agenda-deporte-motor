/**
 * Rally (por tramos, como el WRC) y rally raid (por etapas, como el Dakar): lógica pura del itinerario que el
 * pipeline publica en data/stages/{seriesId}/{eventId}.json (EventStagesFile). Resumen, agrupación por día,
 * estado de cada tramo según la hora, barras de terreno y los renglones de "día completo" de la Agenda.
 * Sin Vue ni Pinia.
 */
import { DateTime } from 'luxon';
import {
  formatTime,
  localDate,
  overlaps,
  type EventStagesFile,
  type MotorEvent,
  type Period,
  type RallyStage,
  type ScheduleFile,
  type Series,
  type StageKind,
  type Surface,
} from '@dm/shared';
import { fixMonthAbbr } from './format.ts';

// ── Superficie ──

/** Etiqueta corta para distintivos (la completa está en SURFACE_LABELS de @dm/shared). */
export const SURFACE_SHORT: Record<Surface, string> = {
  asfalto: 'Asfalto',
  tierra: 'Tierra',
  nieve: 'Nieve',
  arena: 'Arena',
  mixto: 'Mixto',
};

/** Ícono de AppIcon de cada superficie. */
export const SURFACE_ICONS: Record<Surface, string> = {
  asfalto: 'road',
  tierra: 'terrain',
  nieve: 'snow',
  arena: 'dunes',
  mixto: 'layers',
};

// ── Tramos o etapas ──

/** El evento tiene itinerario publicado (existe su archivo de data/stages). */
export function hasStages(event: Pick<MotorEvent, 'stageCount'> | null | undefined): boolean {
  return (event?.stageCount ?? 0) > 0;
}

/** 'tramos': rally con varios tramos por día (WRC). 'etapas': rally raid con una etapa por día (Dakar). */
export type ItineraryKind = 'tramos' | 'etapas';

export const ITINERARY_LABELS: Record<ItineraryKind, string> = { tramos: 'Tramos', etapas: 'Etapas' };

/** Renglones que no son un tramo del rally: el shakedown (ensayo), los enlaces y el descanso. */
const NOT_A_STAGE: StageKind[] = ['shakedown', 'enlace', 'descanso'];

/** Tramo o etapa cronometrada que cuenta para el rally (el shakedown no). */
export function isCompetitive(stage: Pick<RallyStage, 'kind'>): boolean {
  return !NOT_A_STAGE.includes(stage.kind);
}

/** Días del evento, contando el primero y el último. */
export function eventDays(event: Pick<MotorEvent, 'dateStart' | 'dateEnd'>): number {
  const days = Math.round((Date.parse(`${event.dateEnd}T00:00:00Z`) - Date.parse(`${event.dateStart}T00:00:00Z`)) / 86_400_000) + 1;
  return Number.isFinite(days) && days > 0 ? days : 1;
}

/**
 * Tramos o etapas. Con el itinerario cargado: "tramos" si algún día tiene más de uno. Sin el archivo (para
 * rotular la pestaña antes de descargarlo): rally raid si la superficie es arena o si no hay más renglones que días.
 */
export function itineraryKind(
  event: Pick<MotorEvent, 'dateStart' | 'dateEnd' | 'stageCount' | 'surface'>,
  stages?: RallyStage[] | null,
): ItineraryKind {
  if (stages?.length) {
    const perDay = new Map<string, number>();
    for (const s of stages) if (isCompetitive(s)) perDay.set(s.date, (perDay.get(s.date) ?? 0) + 1);
    return [...perDay.values()].some((n) => n > 1) ? 'tramos' : 'etapas';
  }
  if (event.surface === 'arena') return 'etapas';
  return (event.stageCount ?? 0) > eventDays(event) + 1 ? 'tramos' : 'etapas';
}

/** "18 tramos", "1 tramo", "12 etapas". */
export function stageCountText(n: number, kind: ItineraryKind): string {
  const word = kind === 'tramos' ? (n === 1 ? 'tramo' : 'tramos') : n === 1 ? 'etapa' : 'etapas';
  return `${n} ${word}`;
}

/** "23,67 km", "305,3 km", "4.429 km": menos decimales cuanto más larga la distancia. */
export function formatKm(km: number): string {
  const digits = km >= 1000 ? 0 : km >= 100 ? 1 : 2;
  return `${km.toLocaleString('es-AR', { maximumFractionDigits: digits })} km`;
}

/** Orden del itinerario: por día y, dentro del día, por hora de largada si las dos se conocen (si no, el de la fuente). */
export function sortStages(stages: RallyStage[]): RallyStage[] {
  return stages
    .map((stage, i) => ({ stage, i }))
    .sort(
      (a, b) =>
        a.stage.date.localeCompare(b.stage.date) ||
        (a.stage.startUtc && b.stage.startUtc ? a.stage.startUtc.localeCompare(b.stage.startUtc) : 0) ||
        a.i - b.i,
    )
    .map((x) => x.stage);
}

// ── Resumen ──

export interface StagesSummary {
  kind: ItineraryKind;
  surface?: Surface;
  surfaceNote?: string;
  /** Tramos o etapas cronometrados (sin shakedown, enlaces ni descanso; los cancelados no cuentan). */
  count: number;
  cancelled: number;
  /** Kilómetros cronometrados: el total de la fuente o, si no lo da, la suma de los tramos no cancelados. */
  competitiveKm?: number;
  /** Kilómetros totales con enlaces (el de la fuente o la suma de los días, si todos lo informan). */
  totalKm?: number;
  /** Días con algún renglón en el itinerario. */
  days: number;
}

export function stagesSummary(
  file: Pick<EventStagesFile, 'stages' | 'surface' | 'surfaceNote' | 'competitiveKm' | 'totalKm'>,
  event: Pick<MotorEvent, 'dateStart' | 'dateEnd' | 'stageCount' | 'surface'>,
): StagesSummary {
  const competitive = file.stages.filter(isCompetitive);
  const run = competitive.filter((s) => !s.cancelled);
  const withKm = run.filter((s) => s.distanceKm !== undefined);
  const sum = (list: RallyStage[], key: 'distanceKm' | 'totalKm') => Math.round(list.reduce((n, s) => n + (s[key] ?? 0), 0) * 100) / 100;
  const competitiveKm = file.competitiveKm ?? (withKm.length ? sum(withKm, 'distanceKm') : undefined);
  const dayTotals = file.stages.filter((s) => s.kind !== 'descanso' && s.kind !== 'shakedown');
  const totalKm =
    file.totalKm ?? (dayTotals.length && dayTotals.every((s) => s.totalKm !== undefined) ? sum(dayTotals, 'totalKm') : undefined);
  const surface = file.surface ?? event.surface;
  return {
    kind: itineraryKind(event, file.stages),
    ...(surface ? { surface } : {}),
    ...(file.surfaceNote ? { surfaceNote: file.surfaceNote } : {}),
    count: run.length,
    cancelled: competitive.length - run.length,
    ...(competitiveKm !== undefined ? { competitiveKm } : {}),
    ...(totalKm !== undefined ? { totalKm } : {}),
    days: new Set(file.stages.map((s) => s.date)).size,
  };
}

// ── Estado de cada tramo ──

/**
 * past: ya largó (o su día ya pasó). live: en curso. today: sin hora publicada y se corre hoy.
 * next: el próximo en largar. upcoming: el resto.
 */
export type StageState = 'past' | 'live' | 'today' | 'next' | 'upcoming';

const MIN = 60_000;

/**
 * Cuánto se considera "en curso" un tramo desde que larga el primer auto, si antes no largó el siguiente:
 * una hora y media en un tramo de rally, tres horas el shakedown (varias pasadas) y diez horas una etapa de
 * rally raid (cientos de kilómetros). La fuente publica solo la largada.
 */
export function liveWindowMs(stage: Pick<RallyStage, 'kind' | 'distanceKm'>): number {
  if (stage.kind === 'shakedown') return 180 * MIN;
  return (stage.distanceKm ?? 0) >= 80 ? 600 * MIN : 90 * MIN;
}

/**
 * Estado de cada renglón, en el mismo orden que `stages`.
 * - Con hora de largada: "en curso" es el último que largó (hasta que largue el siguiente o pase su ventana),
 *   los anteriores quedan como ya largados y el primero que falta es el próximo.
 * - Sin hora (rally raid): se compara la fecha de la etapa con el día de hoy del usuario (`today`, YYYY-MM-DD).
 * Los cancelados, los enlaces y el descanso nunca son "en curso" ni "próximo".
 */
export function stageStates(stages: RallyStage[], now: string, today: string): StageState[] {
  const nowMs = Date.parse(now);
  const states: StageState[] = stages.map((s) => {
    if (s.startUtc) return Date.parse(s.startUtc) <= nowMs ? 'past' : 'upcoming';
    if (s.date < today) return 'past';
    return s.date === today && !s.cancelled ? 'today' : 'upcoming';
  });
  // En curso: el último con hora que ya largó, dentro de su ventana.
  let live = -1;
  stages.forEach((s, i) => {
    if (!s.startUtc || s.cancelled || states[i] !== 'past') return;
    if (live < 0 || s.startUtc >= stages[live]!.startUtc!) live = i;
  });
  if (live >= 0 && nowMs < Date.parse(stages[live]!.startUtc!) + liveWindowMs(stages[live]!)) states[live] = 'live';
  // Próximo: el primero que todavía no largó (por hora o, sin hora, por fecha).
  const key = (s: RallyStage) => s.startUtc ?? `${s.date}T23:59:59Z`;
  let next = -1;
  stages.forEach((s, i) => {
    if (states[i] !== 'upcoming' || s.cancelled || s.kind === 'descanso' || s.kind === 'enlace') return;
    if (next < 0 || key(s) < key(stages[next]!)) next = i;
  });
  if (next >= 0) states[next] = 'next';
  return states;
}

/** Tramo en curso en este momento (para En vivo), si el itinerario tiene horas. */
export function liveStage(stages: RallyStage[], now: string): RallyStage | undefined {
  const states = stageStates(stages, now, now.slice(0, 10));
  return stages.find((_, i) => states[i] === 'live');
}

// ── Días ──

export interface StageDay {
  /** Fecha local del rally, YYYY-MM-DD. */
  date: string;
  /** "Viernes 13 de noviembre" */
  label: string;
  stages: RallyStage[];
  /** Tramos cronometrados del día (sin shakedown ni cancelados). */
  count: number;
  /** Kilómetros cronometrados del día, si los tramos los informan. */
  competitiveKm?: number;
}

/** "Viernes 13 de noviembre" a partir de una fecha YYYY-MM-DD (es una fecha de calendario: no se convierte de zona). */
export function stageDayLabel(date: string): string {
  const s = DateTime.fromISO(date).setLocale('es-AR').toFormat("cccc d 'de' LLLL");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Itinerario agrupado por día del rally (la fecha local que publica la fuente). */
export function groupStagesByDay(stages: RallyStage[]): StageDay[] {
  const days: StageDay[] = [];
  for (const stage of sortStages(stages)) {
    let day = days[days.length - 1];
    if (!day || day.date !== stage.date) {
      day = { date: stage.date, label: stageDayLabel(stage.date), stages: [], count: 0 };
      days.push(day);
    }
    day.stages.push(stage);
  }
  for (const day of days) {
    const run = day.stages.filter((s) => isCompetitive(s) && !s.cancelled);
    day.count = run.length;
    const withKm = run.filter((s) => s.distanceKm !== undefined);
    if (withKm.length) day.competitiveKm = Math.round(withKm.reduce((n, s) => n + s.distanceKm!, 0) * 100) / 100;
  }
  return days;
}

// ── Hora de largada ──

export interface StageTime {
  /** Hora en la zona del usuario ("21:33"); vacía si la fuente solo da la hora local sin fecha convertible. */
  user: string;
  /** Día de la semana abreviado si para el usuario cae en otro día que la fecha del rally ("jue"). */
  userDay?: string;
  /** Hora local del rally ("09:33"), si no coincide con la del usuario. */
  local?: string;
}

/** Hora de largada de un tramo para mostrar; null si la fuente no la publica. */
export function stageTime(stage: Pick<RallyStage, 'startUtc' | 'localStartText' | 'date'>, eventTz: string, zone: string): StageTime | null {
  if (!stage.startUtc) return stage.localStartText ? { user: '', local: stage.localStartText } : null;
  const user = formatTime(stage.startUtc, zone);
  const userDate = localDate(stage.startUtc, zone);
  const local = stage.localStartText ?? safeTime(stage.startUtc, eventTz);
  return {
    user,
    ...(userDate !== stage.date ? { userDay: DateTime.fromISO(userDate).setLocale('es-AR').toFormat('ccc').replace('.', '') } : {}),
    ...(local && (local !== user || userDate !== stage.date) ? { local } : {}),
  };
}

function safeTime(isoUtc: string, zone: string): string {
  const dt = DateTime.fromISO(isoUtc, { zone: 'utc' }).setZone(zone);
  return dt.isValid ? dt.toFormat('HH:mm') : '';
}

// ── Textos de un renglón ──

/** "Etapa 5 · Hail > Hail", "SS2 · Isegami's Tunnel 1", "Día de descanso · Riad". */
export function stageTitle(stage: Pick<RallyStage, 'code' | 'name' | 'kind'>): string {
  const name = stage.name.trim();
  if (stage.kind === 'descanso') return name && !/descanso/i.test(name) ? `Día de descanso · ${name}` : 'Día de descanso';
  const code = stage.code.trim();
  if (!name || name.toLowerCase() === code.toLowerCase()) return code;
  return `${code} · ${name}`;
}

/**
 * Distancia de un renglón: "356 km de especial" (etapa de rally raid), "23,67 km" (tramo),
 * "647 km de enlace" (traslado). Vacío si la fuente no da distancias.
 */
export function stageDistanceText(stage: Pick<RallyStage, 'kind' | 'distanceKm' | 'liaisonKm' | 'totalKm'>, kind: ItineraryKind): string {
  if (stage.kind === 'descanso') return '';
  if (stage.distanceKm !== undefined && stage.kind !== 'enlace') {
    return kind === 'etapas' ? `${formatKm(stage.distanceKm)} de especial` : formatKm(stage.distanceKm);
  }
  const liaison = stage.liaisonKm ?? stage.totalKm;
  return liaison !== undefined ? `${formatKm(liaison)} de enlace` : '';
}

/** "Enlace 213 km · Total 518 km" (lo que la fuente informe además del sector cronometrado). */
export function stageExtraKmText(stage: Pick<RallyStage, 'kind' | 'distanceKm' | 'liaisonKm' | 'totalKm'>): string {
  const parts: string[] = [];
  const timed = stage.distanceKm !== undefined && stage.kind !== 'enlace';
  if (timed && stage.liaisonKm !== undefined) parts.push(`Enlace ${formatKm(stage.liaisonKm)}`);
  if (timed && stage.totalKm !== undefined) parts.push(`Total ${formatKm(stage.totalKm)}`);
  return parts.join(' · ');
}

// ── Terreno ──

export interface TerrainBar {
  label: string;
  /** Porción de la etapa, de 0 a 100. */
  percent: number;
  km?: number;
  /** "45 %" */
  text: string;
}

/**
 * Barras de terreno de una etapa, de mayor a menor. Usa el porcentaje de la fuente; si solo da kilómetros,
 * lo calcula sobre el sector cronometrado (o sobre la suma de los kilómetros informados).
 */
export function terrainBars(stage: Pick<RallyStage, 'terrain' | 'distanceKm'>): TerrainBar[] {
  const items = (stage.terrain ?? []).filter((t) => t.label.trim() && ((t.percent ?? 0) > 0 || (t.km ?? 0) > 0));
  if (!items.length) return [];
  const kmSum = items.reduce((n, t) => n + (t.km ?? 0), 0);
  const base = Math.max(stage.distanceKm ?? 0, kmSum);
  const bars: TerrainBar[] = [];
  for (const t of items) {
    const percent = t.percent !== undefined && t.percent > 0 ? t.percent : base > 0 && t.km ? (t.km * 100) / base : 0;
    if (percent <= 0) continue;
    const clamped = Math.min(100, percent);
    const rounded = Math.round(clamped);
    bars.push({
      label: t.label.trim(),
      percent: clamped,
      ...(t.km ? { km: t.km } : {}),
      text: rounded < 1 ? '<1 %' : `${rounded} %`,
    });
  }
  return bars
    .map((bar, i) => ({ bar, i }))
    .sort((a, b) => b.bar.percent - a.bar.percent || a.i - b.i)
    .map((x) => x.bar);
}

// ── Agenda: la etapa de cada día como renglón de día completo ──

/** Fechas locales (YYYY-MM-DD) que abarca un período en la zona del usuario. */
export function periodDates(period: Period, zone: string): string[] {
  const out: string[] = [];
  let d = DateTime.fromISO(period.startUtc, { zone: 'utc' }).setZone(zone).startOf('day');
  const end = DateTime.fromISO(period.endUtc, { zone: 'utc' }).setZone(zone);
  // Tope de seguridad: la Agenda pide un día o un fin de semana.
  for (let i = 0; i < 62 && d < end; i++) {
    out.push(d.toISODate()!);
    d = d.plus({ days: 1 });
  }
  return out;
}

export interface StageEventItem {
  event: MotorEvent;
  series: Series;
}

const shiftDate = (date: string, days: number) => DateTime.fromISO(date).plus({ days }).toISODate() ?? date;

/**
 * Eventos con itinerario (de categorías visibles) que caen en esas fechas y no tienen ninguna sesión con horario
 * en el período: en la Agenda se muestran con la etapa de cada día en lugar de "horarios a confirmar".
 * Se toma un día de margen a cada lado: con horas de largada, un tramo puede caer en otro día para el usuario.
 */
export function stageEventsOn(
  schedule: ScheduleFile | null,
  dates: string[],
  period: Period,
  isVisible: (series: Series) => boolean,
): StageEventItem[] {
  if (!schedule || !dates.length) return [];
  const first = dates[0]!;
  const last = dates[dates.length - 1]!;
  const series = new Map(schedule.series.map((s) => [s.id, s]));
  const out: StageEventItem[] = [];
  for (const event of schedule.events) {
    if (!hasStages(event)) continue;
    if (shiftDate(event.dateEnd, 1) < first || shiftDate(event.dateStart, -1) > last) continue;
    const s = series.get(event.seriesId);
    if (!s || !isVisible(s)) continue;
    if (schedule.sessions.some((x) => x.eventId === event.id && overlaps(period, x.startUtc, x.endUtc))) continue;
    out.push({ event, series: s });
  }
  return out.sort((a, b) => a.event.dateStart.localeCompare(b.event.dateStart) || a.series.name.localeCompare(b.series.name, 'es'));
}

export interface StageDayRow {
  /** Día en el calendario del usuario, YYYY-MM-DD. */
  date: string;
  /** "Etapa 5 · Hail > Hail" o, si el día tiene varios tramos, "SS2 a SS8 · 7 tramos". */
  title: string;
  /** "356 km de especial · 920 km en total". */
  detail: string;
  /** Largada del primer tramo en la zona del usuario, si la fuente la publica. */
  time?: string;
  state: 'past' | 'today' | 'upcoming';
  cancelled: boolean;
}

/** Día del usuario en el que cae un renglón: el de su largada si tiene hora; si no, la fecha del rally. */
export function stageUserDate(stage: Pick<RallyStage, 'startUtc' | 'date'>, zone: string): string {
  return stage.startUtc ? localDate(stage.startUtc, zone) : stage.date;
}

/** Renglones de día completo de un itinerario para esas fechas (uno por día con algún tramo o etapa). */
export function stageDayRows(file: Pick<EventStagesFile, 'stages'>, dates: string[], today: string, zone: string): StageDayRow[] {
  const sorted = sortStages(file.stages);
  const rows: StageDayRow[] = [];
  for (const date of dates) {
    const all = sorted.filter((s) => stageUserDate(s, zone) === date);
    if (!all.length) continue;
    // Si el día tiene tramos del rally, el shakedown y los enlaces no hacen falta en el resumen.
    const own = all.filter(isCompetitive);
    const list = own.length ? own : all;
    const first = list[0]!;
    const last = list[list.length - 1]!;
    const kind: ItineraryKind = list.length > 1 ? 'tramos' : 'etapas';
    const start = list.find((s) => s.startUtc)?.startUtc;
    let title: string;
    let detail: string;
    if (list.length === 1) {
      title = stageTitle(first);
      const total = first.totalKm !== undefined && first.kind !== 'enlace' && first.totalKm !== first.distanceKm ? `${formatKm(first.totalKm)} en total` : '';
      detail = [stageDistanceText(first, kind), total].filter(Boolean).join(' · ');
    } else {
      title = `${first.code} ${list.length === 2 ? 'y' : 'a'} ${last.code} · ${stageCountText(list.length, kind)}`;
      const withKm = list.filter((s) => !s.cancelled && s.distanceKm !== undefined);
      detail = withKm.length ? `${formatKm(Math.round(withKm.reduce((n, s) => n + s.distanceKm!, 0) * 100) / 100)} cronometrados` : '';
    }
    rows.push({
      date,
      title,
      detail,
      ...(start ? { time: formatTime(start, zone) } : {}),
      state: date < today ? 'past' : date === today ? 'today' : 'upcoming',
      cancelled: list.every((s) => s.cancelled),
    });
  }
  return rows;
}

/** Renglón genérico de un día del evento para el que el itinerario no trae ninguna etapa. */
export function emptyStageDayRow(date: string, today: string): StageDayRow {
  return {
    date,
    title: 'Sin etapa publicada para este día',
    detail: '',
    state: date < today ? 'past' : date === today ? 'today' : 'upcoming',
    cancelled: false,
  };
}

/** Tarjeta de la Agenda de un rally sin horas de largada: el evento con la etapa de cada día pedido. */
export interface StageAgendaCard extends StageEventItem {
  key: string;
  rows: StageDayRow[];
}

/**
 * Tarjeta de un evento para esas fechas, o null si no le toca ninguna. Si el itinerario no trae nada para un
 * día en el que el evento está en disputa y no tiene horarios, queda un renglón genérico (no "a confirmar").
 */
export function stageAgendaCard(
  item: StageEventItem,
  file: Pick<EventStagesFile, 'stages'>,
  dates: string[],
  today: string,
  zone: string,
): StageAgendaCard | null {
  let rows = stageDayRows(file, dates, today, zone);
  if (!rows.length && item.event.sessionsStatus === 'pending') {
    rows = dates.filter((d) => d >= item.event.dateStart && d <= item.event.dateEnd).map((d) => emptyStageDayRow(d, today));
  }
  return rows.length ? { ...item, key: `etapas:${item.event.id}`, rows } : null;
}

// ── Textos del evento cuando hay itinerario pero no horarios ──

/** "sáb 2 de ene" */
function shortDate(date: string): string {
  return fixMonthAbbr(DateTime.fromISO(date).setLocale('es-AR').toFormat("ccc d 'de' LLL").replace(/\./g, ''));
}

/**
 * Estado de un evento con itinerario y sin sesiones con horario (el Dakar no publica horas de largada):
 * "Empieza el sáb 2 de ene", "En disputa · día 7 de 15" o "Finalizado". `today` es el día del usuario.
 */
export function stagesEventStatus(event: Pick<MotorEvent, 'dateStart' | 'dateEnd'>, today: string): { kind: 'next' | 'done'; text: string } {
  if (today < event.dateStart) return { kind: 'next', text: `Empieza el ${shortDate(event.dateStart)}` };
  if (today > event.dateEnd) return { kind: 'done', text: 'Finalizado' };
  const total = eventDays(event);
  const n = eventDays({ dateStart: event.dateStart, dateEnd: today });
  return { kind: 'next', text: total > 1 ? `En disputa · día ${n} de ${total}` : 'En disputa' };
}

/**
 * Aclaración para un evento sin sesiones con horario: "horarios a confirmar", salvo que tenga el itinerario
 * publicado (ahí el organizador no debe nada: el recorrido ya está).
 */
export function noTimesNote(event: Pick<MotorEvent, 'stageCount'>): string {
  return hasStages(event) ? 'recorrido publicado' : 'horarios a confirmar';
}
