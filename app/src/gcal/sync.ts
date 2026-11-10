/** Orquestación de carga, auditoría y corrección sobre la API de Calendar. */
import type { Period } from '@dm/shared';
import { auditCalendar, planFixes, type CalendarAuditResult, type CalendarEvent } from './audit.ts';
import type { CalendarApi } from './api.ts';
import type { ExpectedEvent } from './mapping.ts';

export type Progress = (done: number, total: number) => void;

export interface UploadReport {
  inserted: number;
  updated: number;
  failed: Array<{ expected: ExpectedEvent; error: string }>;
}

export async function uploadEvents(
  api: CalendarApi,
  calendarId: string,
  expected: ExpectedEvent[],
  onProgress?: Progress,
): Promise<UploadReport> {
  const report: UploadReport = { inserted: 0, updated: 0, failed: [] };
  let done = 0;
  for (const exp of expected) {
    try {
      const r = await api.upsertEvent(calendarId, exp.body);
      if (r === 'insertado') report.inserted++;
      else report.updated++;
    } catch (e) {
      report.failed.push({ expected: exp, error: (e as Error).message });
    }
    onProgress?.(++done, expected.length);
  }
  return report;
}

/** Rango de consulta: el período, ampliado para cubrir sesiones que lo cruzan. */
export function auditRange(period: Period, expected: ExpectedEvent[]): { timeMin: string; timeMax: string } {
  let timeMin = period.startUtc;
  let timeMax = period.endUtc;
  for (const e of expected) {
    if (e.startUtc < timeMin) timeMin = e.startUtc;
    if (e.endUtc > timeMax) timeMax = e.endUtc;
  }
  return { timeMin, timeMax };
}

export async function auditCalendarRemote(
  api: CalendarApi,
  calendarId: string,
  expected: ExpectedEvent[],
  period: Period,
): Promise<CalendarAuditResult> {
  const { timeMin, timeMax } = auditRange(period, expected);
  // Se amplía ±4 h para encontrar también eventos corridos (el típico +3 h).
  const pad = (iso: string, h: number) => new Date(new Date(iso).getTime() + h * 3_600_000).toISOString();
  const actual = await api.listEvents(calendarId, pad(timeMin, -4), pad(timeMax, 4));
  return auditCalendar(expected, actual);
}

export async function applyFixes(
  api: CalendarApi,
  calendarId: string,
  result: CalendarAuditResult,
  onProgress?: Progress,
): Promise<{ fixed: number; failed: string[] }> {
  const fixes = planFixes(result);
  const failed: string[] = [];
  let fixed = 0;
  let done = 0;
  for (const f of fixes) {
    try {
      if (f.mode === 'update') await api.updateEvent(calendarId, f.eventId, f.body);
      else await api.upsertEvent(calendarId, f.body);
      fixed++;
    } catch (e) {
      failed.push(`${f.row.expected.label}: ${(e as Error).message}`);
    }
    onProgress?.(++done, fixes.length);
  }
  return { fixed, failed };
}

export async function deleteExtras(
  api: CalendarApi,
  calendarId: string,
  extras: CalendarEvent[],
): Promise<{ deleted: number; failed: string[] }> {
  const failed: string[] = [];
  let deleted = 0;
  for (const e of extras) {
    try {
      await api.deleteEvent(calendarId, e.id);
      deleted++;
    } catch (err) {
      failed.push(`${e.summary ?? e.id}: ${(err as Error).message}`);
    }
  }
  return { deleted, failed };
}
