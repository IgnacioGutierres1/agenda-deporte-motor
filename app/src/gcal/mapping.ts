/**
 * Conversión de sesiones de la grilla a eventos de Google Calendar (reglas del gem, Fase 2):
 * - Destino: calendario "Deporte Motor".
 * - Hora local de pared argentina + timeZone "America/Argentina/Buenos_Aires".
 *   NUNCA se manda la hora UTC con esa zona (provoca el corrimiento de +3 h).
 * - Recordatorio emergente 30 minutos antes (sin los predeterminados).
 * - Id derivado de la sesión para que recargar actualice en vez de duplicar.
 */
import { AR_TZ, icsSummary, stableHash, toLocalWallIso, type MotorEvent, type Series, type Session } from '@dm/shared';

export const CALENDAR_NAME = 'Deporte Motor';
export const GCAL_TZ = AR_TZ;
export const EVENT_ID_PREFIX = 'dm';
export const REMINDER_MINUTES = 30;

export interface GcalDateTime {
  dateTime: string;
  timeZone?: string;
}

export interface GcalEventBody {
  id: string;
  summary: string;
  description: string;
  location: string;
  start: GcalDateTime;
  end: GcalDateTime;
  reminders: { useDefault: boolean; overrides: Array<{ method: 'popup' | 'email'; minutes: number }> };
  status?: 'confirmed';
}

/** Lo que se espera encontrar en el calendario por cada sesión exportada. */
export interface ExpectedEvent {
  sessionId: string;
  /** "Fórmula 1 · Carrera" (para la tabla de auditoría). */
  label: string;
  startUtc: string;
  endUtc: string;
  broadcastText: string;
  body: GcalEventBody;
}

export interface SessionInput {
  session: Session;
  event: MotorEvent | undefined;
  series: Series;
}

/**
 * Id de evento válido para Google Calendar: base32hex (0-9, a-v), 5 a 1024 caracteres.
 * Los ids de sesión son hash hexadecimal, que ya es base32hex válido.
 */
export function gcalEventId(sessionId: string): string {
  const clean = sessionId.toLowerCase();
  const body = /^[0-9a-v]+$/.test(clean) ? clean : stableHash(sessionId);
  return `${EVENT_ID_PREFIX}${body}`;
}

export function broadcastText(session: Session): string {
  return session.broadcast.length ? session.broadcast.join(', ') : 'A confirmar';
}

export function buildDescription(session: Session): string {
  const habitual = session.broadcastIsDefault && session.broadcast.length ? ' (habitual)' : '';
  return `Transmisión: ${broadcastText(session)}${habitual}\nFuente: ${session.source.url}`;
}

export function toExpectedEvent({ session, event, series }: SessionInput): ExpectedEvent {
  const circuit = event?.circuit ?? '';
  const location = [circuit, event?.country].filter(Boolean).join(', ');
  return {
    sessionId: session.id,
    label: `${series.name} · ${session.name}`,
    startUtc: session.startUtc,
    endUtc: session.endUtc,
    broadcastText: broadcastText(session),
    body: {
      id: gcalEventId(session.id),
      summary: icsSummary({ seriesName: series.name, circuit, sessionName: session.name }),
      description: buildDescription(session),
      location,
      start: { dateTime: toLocalWallIso(session.startUtc, GCAL_TZ), timeZone: GCAL_TZ },
      end: { dateTime: toLocalWallIso(session.endUtc, GCAL_TZ), timeZone: GCAL_TZ },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: REMINDER_MINUTES }] },
      status: 'confirmed',
    },
  };
}
