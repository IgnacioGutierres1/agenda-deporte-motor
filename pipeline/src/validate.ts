import { DateTime } from 'luxon';
import type { MotorEvent, Session } from '@dm/shared';

/**
 * Duración máxima admitida: el tiempo límite de la Baja 1000 (40 h desde la largada, que es el cierre oficial de la
 * carrera) + margen. Las de 24 h quedan holgadas.
 */
const MAX_MINUTES = 42 * 60;
const MIN_MINUTES = 5;

export interface ValidationIssue {
  sessionId: string;
  reason: string;
}

/**
 * Controles básicos que aplican a todas las fuentes:
 * - la sesión cae dentro de las fechas del evento (con 1 día de margen por husos horarios),
 * - fin posterior al inicio y duración razonable.
 */
export function validateSession(session: Session, event: MotorEvent | undefined): string | null {
  if (!event) return 'La sesión no tiene evento asociado';
  if (session.endUtc <= session.startUtc) return 'El fin no es posterior al inicio';
  const minutes = DateTime.fromISO(session.endUtc).diff(DateTime.fromISO(session.startUtc), 'minutes').minutes;
  if (minutes < MIN_MINUTES || minutes > MAX_MINUTES) return `Duración fuera de rango (${Math.round(minutes)} min)`;

  const from = DateTime.fromISO(event.dateStart, { zone: event.tz }).startOf('day').minus({ days: 1 });
  const to = DateTime.fromISO(event.dateEnd, { zone: event.tz }).endOf('day').plus({ days: 1 });
  const start = DateTime.fromISO(session.startUtc);
  if (start < from || start > to) {
    return `La sesión (${session.startUtc}) no cae dentro de las fechas del evento (${event.dateStart} a ${event.dateEnd})`;
  }
  return null;
}

export function validateSessions(
  sessions: Session[],
  events: MotorEvent[],
): { valid: Session[]; issues: ValidationIssue[] } {
  const byId = new Map(events.map((e) => [e.id, e]));
  const valid: Session[] = [];
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  for (const s of sessions) {
    if (seen.has(s.id)) {
      issues.push({ sessionId: s.id, reason: 'Sesión duplicada' });
      continue;
    }
    const reason = validateSession(s, byId.get(s.eventId));
    if (reason) issues.push({ sessionId: s.id, reason });
    else {
      valid.push(s);
      seen.add(s.id);
    }
  }
  return { valid, issues };
}

/** Normaliza texto para comparaciones literales (espacios, mayúsculas, acentos, guiones). */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .trim();
}

/**
 * Control anti-alucinación del flujo con IA: el fragmento extraído (hora local, nombre de piloto…)
 * tiene que aparecer literalmente en el documento oficial descargado.
 * Para horas acepta variantes equivalentes ("9:30", "09:30", "9.30", "09h30").
 */
export function appearsInDocument(fragment: string, documentText: string): boolean {
  const doc = normalizeForMatch(documentText);
  const frag = normalizeForMatch(fragment);
  if (!frag) return false;
  const time = frag.match(/^(\d{1,2})\s*[:.h]\s*(\d{2})$/);
  if (!time) return doc.includes(frag);

  // Horas: se aceptan separadores equivalentes y se exige que no haya dígitos pegados ("4:05" ≠ "14:05").
  const hours = Number(time[1]);
  const minutes = time[2];
  const hourVariants = [String(hours), String(hours).padStart(2, '0')];
  const variants = hourVariants.flatMap((h) => [`${h}:${minutes}`, `${h}.${minutes}`, `${h}h${minutes}`]);
  return variants.some((v) => new RegExp(`(^|[^0-9])${escapeRegExp(v)}([^0-9]|$)`).test(doc));
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
