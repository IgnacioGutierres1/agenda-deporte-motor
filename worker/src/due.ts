/**
 * Qué avisos corresponde mandar en una ventana de tiempo (lógica pura, sin red ni KV).
 *
 * El cron corre cada 5 minutos. En la corrida de las HH:MM se avisan las sesiones que empiezan en
 * [HH:MM + anticipación, HH:MM + anticipación + 5 min). Así cada sesión cae en una sola ventana y no
 * hace falta guardar qué se avisó (el plan gratuito de KV tiene pocas escrituras por día).
 */
import type { MotorEvent, ScheduleFile, Series, Session } from '@dm/shared';

export const WINDOW_MS = 5 * 60_000;
export const LEAD_OPTIONS = [5, 15, 30, 60, 120] as const;

export interface SubscriptionKeys {
  p256dh: string;
  auth: string;
}

export interface PushSubscriptionJSON {
  endpoint: string;
  keys: SubscriptionKeys;
}

/** Suscripción guardada: un dispositivo con sus categorías (seguidas + las de sus pilotos). */
export interface SubscriberRecord {
  id: string;
  subscription: PushSubscriptionJSON;
  seriesIds: string[];
  /** Minutos de anticipación del aviso. */
  leadMinutes: number;
  /** Zona horaria del dispositivo, para mostrar la hora en el aviso. */
  timeZone: string;
  updatedAt: string;
}

export interface Notification {
  subscriberId: string;
  sessionId: string;
  title: string;
  body: string;
  /** Ruta de la app a abrir al tocar el aviso. */
  path: string;
}

/** Inicio de la ventana (múltiplo de 5 minutos) para la hora programada del cron. */
export function windowStart(scheduledTimeMs: number): number {
  return Math.floor(scheduledTimeMs / WINDOW_MS) * WINDOW_MS;
}

function formatTime(iso: string, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('es-AR', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat('es-AR', { timeZone: 'America/Argentina/Buenos_Aires', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(iso));
  }
}

function leadText(minutes: number): string {
  if (minutes >= 60 && minutes % 60 === 0) return minutes === 60 ? '1 hora' : `${minutes / 60} horas`;
  return `${minutes} minutos`;
}

export function dueNotifications(schedule: ScheduleFile, subscribers: SubscriberRecord[], windowStartMs: number): Notification[] {
  const series = new Map<string, Series>(schedule.series.map((s) => [s.id, s]));
  const events = new Map<string, MotorEvent>(schedule.events.map((e) => [e.id, e]));
  const bySeries = new Map<string, Session[]>();
  for (const s of schedule.sessions) {
    const list = bySeries.get(s.seriesId) ?? [];
    list.push(s);
    bySeries.set(s.seriesId, list);
  }

  const out: Notification[] = [];
  for (const sub of subscribers) {
    const from = windowStartMs + sub.leadMinutes * 60_000;
    const to = from + WINDOW_MS;
    for (const seriesId of new Set(sub.seriesIds)) {
      const s = series.get(seriesId);
      if (!s?.enabled) continue;
      for (const session of bySeries.get(seriesId) ?? []) {
        const start = Date.parse(session.startUtc);
        if (!(start >= from && start < to)) continue;
        const event = events.get(session.eventId);
        const where = event ? ` · ${event.name}` : '';
        out.push({
          subscriberId: sub.id,
          sessionId: session.id,
          title: `${s.shortName || s.name}: ${session.name} en ${leadText(sub.leadMinutes)}`,
          body: `${formatTime(session.startUtc, sub.timeZone)} h${where}${session.broadcast.length ? ` · TV: ${session.broadcast.join(', ')}` : ''}`,
          path: `#/evento/${session.eventId}`,
        });
      }
    }
  }
  return out;
}

/** Valida y normaliza el cuerpo de /api/subscribe. Devuelve un mensaje de error o el registro. */
export function parseSubscribeBody(body: unknown, id: string, nowIso: string): SubscriberRecord | string {
  if (!body || typeof body !== 'object') return 'Cuerpo inválido';
  const b = body as Record<string, unknown>;
  const sub = b.subscription as Record<string, unknown> | undefined;
  const keys = sub?.keys as Record<string, unknown> | undefined;
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || sub.endpoint.length > 1000) {
    return 'Suscripción inválida';
  }
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return 'Faltan las claves de la suscripción';
  const seriesIds = Array.isArray(b.seriesIds) ? b.seriesIds.filter((x): x is string => typeof x === 'string' && /^[a-z0-9-]{1,40}$/.test(x)) : [];
  if (seriesIds.length > 80) return 'Demasiadas categorías';
  const lead = Number(b.leadMinutes);
  const leadMinutes = (LEAD_OPTIONS as readonly number[]).includes(lead) ? lead : 30;
  const timeZone = typeof b.timeZone === 'string' && b.timeZone.length < 60 ? b.timeZone : 'America/Argentina/Buenos_Aires';
  return {
    id,
    subscription: { endpoint: sub.endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth } },
    seriesIds: [...new Set(seriesIds)],
    leadMinutes,
    timeZone,
    updatedAt: nowIso,
  };
}
