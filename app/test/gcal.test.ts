import { describe, expect, it, vi } from 'vitest';
import type { ScheduleFile } from '@dm/shared';
import { auditCalendar, eventInstant, planFixes, type CalendarEvent } from '../src/gcal/audit.ts';
import { gcalEventId, toExpectedEvent, type ExpectedEvent } from '../src/gcal/mapping.ts';
import { CalendarApi, GcalError } from '../src/gcal/api.ts';
import { scheduleFixture } from './helpers.ts';

function expectedFromFixture(): ExpectedEvent[] {
  const s: ScheduleFile = scheduleFixture();
  const series = new Map(s.series.map((x) => [x.id, x]));
  const events = new Map(s.events.map((x) => [x.id, x]));
  return s.sessions
    .filter((x) => x.eventId === 'ev-tc-sannicolas')
    .map((session) => toExpectedEvent({ session, event: events.get(session.eventId), series: series.get(session.seriesId)! }));
}

/** Evento tal como lo devolvería Google después de una carga correcta. */
function asCalendarEvent(e: ExpectedEvent): CalendarEvent {
  return {
    id: e.body.id,
    status: 'confirmed',
    summary: e.body.summary,
    description: e.body.description,
    location: e.body.location,
    start: { dateTime: `${e.body.start.dateTime}-03:00`, timeZone: e.body.start.timeZone },
    end: { dateTime: `${e.body.end.dateTime}-03:00`, timeZone: e.body.end.timeZone },
  };
}

describe('mapping a Google Calendar', () => {
  it('usa hora local argentina con timeZone, nunca UTC', () => {
    const [e1] = expectedFromFixture();
    expect(e1!.body.start).toEqual({ dateTime: '2026-11-13T14:00:00', timeZone: 'America/Argentina/Buenos_Aires' });
    expect(e1!.body.end).toEqual({ dateTime: '2026-11-13T14:40:00', timeZone: 'America/Argentina/Buenos_Aires' });
    expect(e1!.body.start.dateTime).not.toMatch(/Z$/);
  });

  it('arma título, lugar, descripción, recordatorio e id', () => {
    const [e1] = expectedFromFixture();
    expect(e1!.body.summary).toBe('Turismo Carretera (San Nicolás) - Entrenamiento 1');
    expect(e1!.body.location).toBe('San Nicolás, Argentina');
    expect(e1!.body.description).toContain('Transmisión: TV Pública, Carburando');
    expect(e1!.body.description).toContain('https://www.actc.org.ar/tc/cronograma-san-nicolas.pdf');
    expect(e1!.body.reminders).toEqual({ useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] });
    expect(e1!.body.id).toBe('dma1b2c3d4e5f60001');
  });

  it('genera ids base32hex válidos aunque el id de sesión no sea hexadecimal', () => {
    expect(gcalEventId('ABCdef0123')).toBe('dmabcdef0123');
    expect(gcalEventId('sesión_xyz')).toMatch(/^dm[0-9a-v]{16}$/);
  });
});

describe('eventInstant', () => {
  it('interpreta offsets y hora de pared con zona', () => {
    expect(eventInstant({ dateTime: '2026-11-13T14:00:00-03:00' })).toBe('2026-11-13T17:00Z');
    expect(eventInstant({ dateTime: '2026-11-13T14:00:00', timeZone: 'America/Argentina/Buenos_Aires' })).toBe(
      '2026-11-13T17:00Z',
    );
    expect(eventInstant({ dateTime: '2026-11-13T17:00:00Z' })).toBe('2026-11-13T17:00Z');
    expect(eventInstant(undefined)).toBeNull();
  });
});

describe('auditoría post-carga', () => {
  it('todo OK cuando coincide', () => {
    const expected = expectedFromFixture();
    const r = auditCalendar(expected, expected.map(asCalendarEvent));
    expect(r.rows.map((x) => x.status)).toEqual(['OK', 'OK', 'OK']);
    expect(r.counts).toMatchObject({ OK: 3, expected: 3, found: 3, extras: 0 });
    expect(planFixes(r)).toEqual([]);
  });

  it('detecta el corrimiento de +3 h (UTC enviado como hora local)', () => {
    const expected = expectedFromFixture();
    const actual = expected.map(asCalendarEvent);
    // Error clásico: mandar 17:00 (UTC) con timeZone de Buenos Aires.
    actual[0]!.start = { dateTime: '2026-11-13T17:00:00-03:00', timeZone: 'America/Argentina/Buenos_Aires' };
    actual[0]!.end = { dateTime: '2026-11-13T17:40:00-03:00', timeZone: 'America/Argentina/Buenos_Aires' };
    const r = auditCalendar(expected, actual);
    expect(r.rows[0]!.status).toBe('DESFASADO');
    expect(r.rows[0]!.startDiff).toBe(180);
    expect(r.rows[0]!.issues).toContain('Inicio +3 h');
    expect(r.counts.DESFASADO).toBe(1);
  });

  it('detecta un desfase de −3 h', () => {
    const expected = expectedFromFixture();
    const actual = expected.map(asCalendarEvent);
    actual[1]!.start = { dateTime: '2026-11-14T09:00:00-03:00' };
    const r = auditCalendar(expected, actual);
    expect(r.rows[1]!.status).toBe('DESFASADO');
    expect(r.rows[1]!.issues).toContain('Inicio −3 h');
  });

  it('marca FALTANTE y ERROR (título o transmisión)', () => {
    const expected = expectedFromFixture();
    const actual = expected.map(asCalendarEvent);
    actual.splice(2, 1); // falta la Final
    actual[1]!.description = 'Transmisión: Otro canal';
    const r = auditCalendar(expected, actual);
    expect(r.rows.map((x) => x.status)).toEqual(['OK', 'ERROR', 'FALTANTE']);
    expect(r.rows[1]!.issues).toEqual(['Transmisión distinta']);
    const fixes = planFixes(r);
    expect(fixes.map((f) => [f.mode, f.eventId])).toEqual([
      ['update', 'dma1b2c3d4e5f60002'],
      ['insert', 'dma1b2c3d4e5f60003'],
    ]);
  });

  it('reconoce eventos cargados a mano por título y reporta sobrantes de la app', () => {
    const expected = expectedFromFixture();
    const actual = expected.map(asCalendarEvent);
    actual[0]!.id = 'manual123'; // mismo título, otro id
    actual.push({ id: 'dm0000000000000099', summary: 'TC (X) - Vieja', start: { dateTime: '2026-11-14T10:00:00-03:00' } });
    actual.push({ id: 'otroevento', summary: 'Cumpleaños' });
    actual.push({ id: 'dm0000000000000098', status: 'cancelled', summary: 'Borrado' });
    const r = auditCalendar(expected, actual);
    expect(r.rows[0]!.status).toBe('OK');
    expect(r.rows[0]!.actual!.id).toBe('manual123');
    expect(r.extras.map((e) => e.id)).toEqual(['dm0000000000000099']);
  });
});

describe('CalendarApi', () => {
  it('upsert: inserta y ante 409 actualiza con PUT', async () => {
    const [exp] = expectedFromFixture();
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: 'duplicate' } }), { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: exp!.body.id }), { status: 200 }));
    const api = new CalendarApi('tok', fetchFn);
    await expect(api.upsertEvent('cal@group', exp!.body)).resolves.toBe('actualizado');
    const [url1, init1] = fetchFn.mock.calls[0]!;
    expect(url1).toBe('https://www.googleapis.com/calendar/v3/calendars/cal%40group/events');
    expect(init1!.method).toBe('POST');
    expect((init1!.headers as Record<string, string>).Authorization).toBe('Bearer tok');
    const [url2, init2] = fetchFn.mock.calls[1]!;
    expect(url2).toBe(`https://www.googleapis.com/calendar/v3/calendars/cal%40group/events/${exp!.body.id}`);
    expect(init2!.method).toBe('PUT');
    expect(JSON.parse(init2!.body as string).start.timeZone).toBe('America/Argentina/Buenos_Aires');
  });

  it('error claro si falta el calendario "Deporte Motor"', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(JSON.stringify({ items: [{ id: 'x', summary: 'Personal' }] }), { status: 200 }));
    const api = new CalendarApi('tok', fetchFn);
    await expect(api.findCalendar()).rejects.toThrow(/No encontré el calendario "Deporte Motor"/);
  });

  it('propaga errores con estado', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}', { status: 401 }));
    const api = new CalendarApi('tok', fetchFn);
    await expect(api.listEvents('c', 'a', 'b')).rejects.toBeInstanceOf(GcalError);
  });
});
