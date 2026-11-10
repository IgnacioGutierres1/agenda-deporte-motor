/**
 * Auditoría post-carga (Fase 3 del gem): compara uno por uno los eventos del calendario con la grilla.
 * Módulo puro (sin red ni Vue) para poder probarlo.
 *
 * Estados:
 * - OK: está y coincide en inicio, fin (al minuto), título, lugar y transmisión.
 * - DESFASADO: está pero el inicio o el fin no coinciden (típico: ±3 h por mandar UTC con zona local).
 * - ERROR: horario correcto pero título, lugar o transmisión distintos.
 * - FALTANTE: no está en el calendario.
 * Los eventos creados por la app (id "dm…") que ya no están en la grilla se informan como sobrantes.
 */
import { DateTime } from 'luxon';
import { EVENT_ID_PREFIX, GCAL_TZ, type ExpectedEvent, type GcalEventBody } from './mapping.ts';

export type CalendarAuditStatus = 'OK' | 'ERROR' | 'DESFASADO' | 'FALTANTE';

export interface CalendarEventTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

/** Subconjunto de un recurso Event de la API de Google Calendar. */
export interface CalendarEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: CalendarEventTime;
  end?: CalendarEventTime;
}

export interface CalendarAuditRow {
  expected: ExpectedEvent;
  actual?: CalendarEvent;
  status: CalendarAuditStatus;
  issues: string[];
  /** Diferencia de inicio en minutos (calendario − oficial). */
  startDiff?: number;
  endDiff?: number;
}

export interface CalendarAuditResult {
  rows: CalendarAuditRow[];
  /** Eventos creados por la app que no corresponden a ninguna sesión de la grilla. */
  extras: CalendarEvent[];
  counts: Record<CalendarAuditStatus, number> & { expected: number; found: number; extras: number };
}

/** Instante UTC ("YYYY-MM-DDTHH:mmZ", precisión de minuto) de una fecha de evento de Calendar. */
export function eventInstant(t: CalendarEventTime | undefined, fallbackZone: string = GCAL_TZ): string | null {
  if (!t) return null;
  let dt: DateTime;
  if (t.dateTime) {
    const hasOffset = /([zZ]|[+-]\d{2}:?\d{2})$/.test(t.dateTime);
    dt = hasOffset
      ? DateTime.fromISO(t.dateTime, { setZone: true })
      : DateTime.fromISO(t.dateTime, { zone: t.timeZone ?? fallbackZone });
  } else if (t.date) {
    dt = DateTime.fromISO(t.date, { zone: t.timeZone ?? fallbackZone });
  } else {
    return null;
  }
  if (!dt.isValid) return null;
  return dt.toUTC().startOf('minute').toFormat("yyyy-LL-dd'T'HH:mm'Z'");
}

function minuteOf(isoUtc: string): string {
  return DateTime.fromISO(isoUtc, { zone: 'utc' }).startOf('minute').toFormat("yyyy-LL-dd'T'HH:mm'Z'");
}

function diff(a: string, b: string): number {
  return Math.round(
    DateTime.fromISO(b, { zone: 'utc' }).diff(DateTime.fromISO(a, { zone: 'utc' }), 'minutes').minutes,
  );
}

/** "+3 h", "−45 min", "+1 h 30 min" */
export function formatShift(minutes: number): string {
  const sign = minutes > 0 ? '+' : '−';
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  if (h && m) return `${sign}${h} h ${m} min`;
  if (h) return `${sign}${h} h`;
  return `${sign}${m} min`;
}

const norm = (s: string | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();

export function auditCalendar(
  expected: ExpectedEvent[],
  actual: CalendarEvent[],
  fallbackZone: string = GCAL_TZ,
): CalendarAuditResult {
  const live = actual.filter((e) => e.status !== 'cancelled');
  const byId = new Map(live.map((e) => [e.id, e]));
  const used = new Set<string>();

  // 1) por id; 2) por título exacto entre los que sobran (eventos cargados a mano o con otro id).
  const matches = expected.map((exp) => {
    const hit = byId.get(exp.body.id);
    if (hit) used.add(hit.id);
    return hit;
  });
  expected.forEach((exp, i) => {
    if (matches[i]) return;
    const hit = live.find((e) => !used.has(e.id) && norm(e.summary) === norm(exp.body.summary));
    if (hit) {
      used.add(hit.id);
      matches[i] = hit;
    }
  });

  const rows: CalendarAuditRow[] = expected.map((exp, i) => {
    const act = matches[i];
    if (!act) return { expected: exp, status: 'FALTANTE', issues: ['No está en el calendario'] };

    const issues: string[] = [];
    const start = eventInstant(act.start, fallbackZone);
    const end = eventInstant(act.end, fallbackZone);
    const startDiff = start ? diff(minuteOf(exp.startUtc), start) : undefined;
    const endDiff = end ? diff(minuteOf(exp.endUtc), end) : undefined;
    let shifted = false;
    if (startDiff === undefined) {
      issues.push('Sin hora de inicio');
      shifted = true;
    } else if (startDiff !== 0) {
      issues.push(`Inicio ${formatShift(startDiff)}`);
      shifted = true;
    }
    if (endDiff === undefined) {
      issues.push('Sin hora de fin');
      shifted = true;
    } else if (endDiff !== 0) {
      issues.push(`Fin ${formatShift(endDiff)}`);
      shifted = true;
    }
    if (norm(act.summary) !== norm(exp.body.summary)) issues.push('Título distinto');
    if (norm(act.location) !== norm(exp.body.location)) issues.push('Lugar distinto');
    if (!norm(act.description).includes(norm(`Transmisión: ${exp.broadcastText}`))) {
      issues.push('Transmisión distinta');
    }

    const status: CalendarAuditStatus = shifted ? 'DESFASADO' : issues.length ? 'ERROR' : 'OK';
    return { expected: exp, actual: act, status, issues, startDiff, endDiff };
  });

  const expectedIds = new Set(expected.map((e) => e.body.id));
  const extras = live.filter(
    (e) => e.id.startsWith(EVENT_ID_PREFIX) && !used.has(e.id) && !expectedIds.has(e.id),
  );

  const counts = { OK: 0, ERROR: 0, DESFASADO: 0, FALTANTE: 0, expected: expected.length, found: 0, extras: extras.length };
  for (const r of rows) {
    counts[r.status]++;
    if (r.actual) counts.found++;
  }
  return { rows, extras, counts };
}

export interface PlannedFix {
  /** insert: crear con el id de la sesión. update: reemplazar el evento existente (con su id). */
  mode: 'insert' | 'update';
  eventId: string;
  body: GcalEventBody;
  row: CalendarAuditRow;
}

/** Correcciones automáticas: faltantes se crean; desfasados y con error se reescriben. */
export function planFixes(result: CalendarAuditResult): PlannedFix[] {
  return result.rows
    .filter((r) => r.status !== 'OK')
    .map((r) =>
      r.actual
        ? { mode: 'update' as const, eventId: r.actual.id, body: { ...r.expected.body, id: r.actual.id }, row: r }
        : { mode: 'insert' as const, eventId: r.expected.body.id, body: r.expected.body, row: r },
    );
}
