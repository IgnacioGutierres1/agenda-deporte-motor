/** Cliente mínimo de la API REST de Google Calendar v3 (fetch + token OAuth). */
import { CALENDAR_NAME, type GcalEventBody } from './mapping.ts';
import type { CalendarEvent } from './audit.ts';

const API = 'https://www.googleapis.com/calendar/v3';

export class GcalError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = 'GcalError';
  }
}

interface CalendarListEntry {
  id: string;
  summary?: string;
  summaryOverride?: string;
  accessRole?: string;
}

export class CalendarApi {
  constructor(
    private readonly token: string,
    private readonly fetchFn: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const res = await this.fetchFn(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return { status: 204, data: undefined as T };
    const data = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) {
      if (res.status === 401) throw new GcalError('La sesión de Google venció. Volvé a iniciar sesión.', 401);
      throw new GcalError(data.error?.message ?? `Error ${res.status} de Google Calendar`, res.status);
    }
    return { status: res.status, data };
  }

  /** Busca el calendario "Deporte Motor" entre los del usuario. */
  async findCalendar(name: string = CALENDAR_NAME): Promise<CalendarListEntry> {
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ maxResults: '250', minAccessRole: 'writer' });
      if (pageToken) q.set('pageToken', pageToken);
      const { data } = await this.request<{ items?: CalendarListEntry[]; nextPageToken?: string }>(
        'GET',
        `/users/me/calendarList?${q}`,
      );
      const hit = (data.items ?? []).find((c) => c.summaryOverride === name || c.summary === name);
      if (hit) return hit;
      pageToken = data.nextPageToken;
    } while (pageToken);
    throw new GcalError(
      `No encontré el calendario "${name}" en tu cuenta. Crealo en Google Calendar (Otros calendarios → Crear calendario) con ese nombre exacto y volvé a intentar.`,
    );
  }

  async listEvents(calendarId: string, timeMin: string, timeMax: string): Promise<CalendarEvent[]> {
    const out: CalendarEvent[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({
        timeMin,
        timeMax,
        singleEvents: 'true',
        showDeleted: 'false',
        maxResults: '2500',
      });
      if (pageToken) q.set('pageToken', pageToken);
      const { data } = await this.request<{ items?: CalendarEvent[]; nextPageToken?: string }>(
        'GET',
        `/calendars/${encodeURIComponent(calendarId)}/events?${q}`,
      );
      out.push(...(data.items ?? []));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  }

  async insertEvent(calendarId: string, body: GcalEventBody): Promise<CalendarEvent> {
    const { data } = await this.request<CalendarEvent>('POST', `/calendars/${encodeURIComponent(calendarId)}/events`, body);
    return data;
  }

  async updateEvent(calendarId: string, eventId: string, body: GcalEventBody): Promise<CalendarEvent> {
    const { data } = await this.request<CalendarEvent>(
      'PUT',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      body,
    );
    return data;
  }

  /** Inserta; si el id ya existe (409, incluso un evento borrado), lo actualiza. */
  async upsertEvent(calendarId: string, body: GcalEventBody): Promise<'insertado' | 'actualizado'> {
    try {
      await this.insertEvent(calendarId, body);
      return 'insertado';
    } catch (e) {
      if (e instanceof GcalError && e.status === 409) {
        await this.updateEvent(calendarId, body.id, body);
        return 'actualizado';
      }
      throw e;
    }
  }

  async deleteEvent(calendarId: string, eventId: string): Promise<void> {
    try {
      await this.request('DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`);
    } catch (e) {
      if (e instanceof GcalError && e.status === 410) return; // ya estaba borrado
      throw e;
    }
  }
}
