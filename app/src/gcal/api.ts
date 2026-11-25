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
  primary?: boolean;
  deleted?: boolean;
  backgroundColor?: string;
}

/** Un calendario del usuario en el que la app puede escribir. */
export interface CalendarChoice {
  id: string;
  /** Nombre como lo ve el usuario en Google Calendar. */
  name: string;
  /** El calendario principal de la cuenta. */
  primary: boolean;
  /** Se llama como el calendario sugerido ("Deporte Motor"). */
  suggested: boolean;
  color?: string;
}

const WRITE_ROLES = ['owner', 'writer'];

function toChoice(c: CalendarListEntry): CalendarChoice {
  const name = (c.summaryOverride || c.summary || c.id).trim();
  return { id: c.id, name, primary: c.primary === true, suggested: name === CALENDAR_NAME, ...(c.backgroundColor ? { color: c.backgroundColor } : {}) };
}

/** Orden de la lista para elegir: primero el sugerido, después el principal, el resto por nombre. */
export function sortCalendars(list: CalendarChoice[]): CalendarChoice[] {
  const rank = (c: CalendarChoice) => (c.suggested ? 0 : c.primary ? 1 : 2);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'es'));
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

  /** Calendarios de la cuenta en los que se puede escribir (propios o compartidos con permiso de edición). */
  async listWritableCalendars(): Promise<CalendarChoice[]> {
    const out: CalendarChoice[] = [];
    let pageToken: string | undefined;
    do {
      const q = new URLSearchParams({ maxResults: '250', minAccessRole: 'writer' });
      if (pageToken) q.set('pageToken', pageToken);
      const { data } = await this.request<{ items?: CalendarListEntry[]; nextPageToken?: string }>(
        'GET',
        `/users/me/calendarList?${q}`,
      );
      for (const c of data.items ?? []) if (!c.deleted) out.push(toChoice(c));
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out;
  }

  /** ¿El calendario sigue en la cuenta y se puede escribir en él? (pudo borrarse o perder el permiso). */
  async canWrite(calendarId: string): Promise<boolean> {
    try {
      const { data } = await this.request<CalendarListEntry>('GET', `/users/me/calendarList/${encodeURIComponent(calendarId)}`);
      return !data.deleted && WRITE_ROLES.includes(data.accessRole ?? '');
    } catch (e) {
      if (e instanceof GcalError && e.status === 404) return false;
      throw e;
    }
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
