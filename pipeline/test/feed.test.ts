import { describe, expect, it } from 'vitest';
import type { MotorEvent, Series, Session, Source } from '@dm/shared';
import { buildFeed } from '../src/core/feed.ts';

const NOW = new Date('2026-11-12T12:00:00Z');
const source = (url: string): Source => ({ url, title: 'x', kind: 'html', method: 'directo', fetchedAt: '2026-11-12T00:00:00Z' });
const series = (id: string, name: string, enabled = true): Series => ({
  id,
  name,
  shortName: name,
  group: 'argentina',
  officialUrls: ['https://example.org/'],
  strategy: 'generic',
  origin: 'default',
  enabled,
});
const event = (id: string, seriesId: string, dateStart: string, dateEnd: string, status: MotorEvent['sessionsStatus'] = 'pending'): MotorEvent => ({
  id,
  seriesId,
  name: `Evento ${id}`,
  circuit: `Circuito ${id}`,
  country: 'Argentina',
  tz: 'America/Argentina/Buenos_Aires',
  dateStart,
  dateEnd,
  sessionsStatus: status,
  source: source(`https://example.org/${id}`),
});
const session = (id: string, ev: MotorEvent, startUtc: string, broadcastIsDefault = true): Session => ({
  id,
  eventId: ev.id,
  seriesId: ev.seriesId,
  type: 'carrera',
  name: 'Carrera',
  startUtc,
  endUtc: new Date(new Date(startUtc).getTime() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  endEstimated: false,
  broadcast: ['TV Pública'],
  broadcastIsDefault,
  source: source(`https://example.org/${ev.id}/cronograma`),
  hasResults: false,
});

const vevents = (ics: string) => ics.split('BEGIN:VEVENT').slice(1);
const uids = (ics: string) => vevents(ics).map((v) => v.match(/UID:([^\r]+)@/)![1]);

describe('feed de suscripción (.ics)', () => {
  const all = [series('tc', 'Turismo Carretera'), series('tn', 'Turismo Nacional'), series('off', 'Apagada', false)];
  const rioCuarto = event('rio-cuarto', 'tc', '2026-11-13', '2026-11-15');
  const sanNicolas = event('san-nicolas', 'tc', '2026-11-20', '2026-11-22', 'published');
  const past = event('pasado', 'tc', '2026-11-06', '2026-11-08');
  const today = event('hoy', 'tn', '2026-11-10', '2026-11-12');
  const far = event('lejos', 'tn', '2027-03-01', '2027-03-03');
  const disabled = event('apagada', 'off', '2026-11-20', '2026-11-22');
  // Marcado pendiente pero ya con alguna sesión: no se duplica como día completo.
  const partial = event('parcial', 'tn', '2026-11-27', '2026-11-29');
  const sessions = [session('s-sn', sanNicolas, '2026-11-22T17:00:00Z', false), session('s-parcial', partial, '2026-11-29T16:00:00Z')];
  const events = [rioCuarto, sanNicolas, past, today, far, disabled, partial];
  const broadcast = { tc: ['TV Pública', 'Motorplay'] };

  it('suma los eventos futuros sin horarios como día completo, sin pasados, apagados ni duplicados', () => {
    const ics = buildFeed(all, events, sessions, NOW, { broadcast });
    expect(uids(ics).sort()).toEqual(['hoy', 'rio-cuarto', 's-parcial', 's-sn']);
    const rc = vevents(ics).find((v) => v.includes('UID:rio-cuarto@'))!.replace(/\r\n /g, '');
    expect(rc).toContain('DTSTART;VALUE=DATE:20261113');
    expect(rc).toContain('DTEND;VALUE=DATE:20261116');
    expect(rc).toContain('SUMMARY:Turismo Carretera (Circuito rio-cuarto) - Evento rio-cuarto (horarios a confirmar)');
    expect(rc).toContain('Transmisión habitual: TV Pública\\, Motorplay\\nFuente: https://example.org/rio-cuarto');
    // Sin transmisión habitual configurada para la serie.
    expect(vevents(ics).find((v) => v.includes('UID:hoy@'))).toContain('Transmisión: A confirmar');
  });

  it('marca la transmisión habitual en las sesiones', () => {
    const ics = buildFeed(all, events, sessions, NOW, { broadcast });
    expect(vevents(ics).find((v) => v.includes('UID:s-sn@'))).toContain('DESCRIPTION:Transmisión: TV Pública\\n');
    expect(vevents(ics).find((v) => v.includes('UID:s-parcial@'))).toContain('DESCRIPTION:Transmisión habitual: TV Pública\\n');
  });

  it('cuando se publican los horarios, el evento de día completo deja de emitirse (mismo UID que desaparece)', () => {
    const before = buildFeed(all, [rioCuarto], [], NOW);
    expect(uids(before)).toEqual(['rio-cuarto']);
    const published = { ...rioCuarto, sessionsStatus: 'published' as const };
    const after = buildFeed(all, [published], [session('s-rc', published, '2026-11-15T17:00:00Z')], NOW);
    expect(uids(after)).toEqual(['s-rc']);
    // El id del evento es estable entre corridas: el mismo UID mientras siga sin horarios.
    expect(uids(buildFeed(all, [rioCuarto], [], new Date('2026-11-13T09:00:00Z')))).toEqual(['rio-cuarto']);
  });

  it('los ensayos (kind test) no van como día completo, pero sus sesiones sí', () => {
    const test = { ...event('ensayo', 'tc', '2026-11-17', '2026-11-18'), kind: 'test' as const };
    expect(uids(buildFeed(all, [test], [], NOW))).toEqual([]);
    const withTimes = { ...test, sessionsStatus: 'published' as const };
    expect(uids(buildFeed(all, [withTimes], [session('s-ensayo', withTimes, '2026-11-17T13:00:00Z')], NOW))).toEqual(['s-ensayo']);
  });

  it('un rally con el recorrido publicado y sin horas de largada va de día completo, sin "(horarios a confirmar)"', () => {
    const dakar: MotorEvent = { ...event('dakar', 'tc', '2026-12-05', '2026-12-19'), name: 'Rally Dakar', surface: 'arena', stageCount: 15 };
    const ics = buildFeed(all, [dakar, rioCuarto], [], NOW).replace(/\r\n /g, '');
    const v = vevents(ics).find((x) => x.includes('UID:dakar@'))!;
    expect(v).toContain('DTSTART;VALUE=DATE:20261205');
    expect(v).toContain('DTEND;VALUE=DATE:20261220');
    expect(v).toContain('SUMMARY:Turismo Carretera (Circuito dakar) - Rally Dakar\r\n');
    expect(v).not.toMatch(/horarios a confirmar/i);
    expect(v).toContain('Rally por etapas');
    // Un evento sin recorrido sigue igual.
    expect(vevents(ics).find((x) => x.includes('UID:rio-cuarto@'))).toContain('(horarios a confirmar)');
  });

  it('respeta onlySeries y mantiene CRLF', () => {
    const ics = buildFeed(all, events, sessions, NOW, { onlySeries: ['tn'] });
    expect(uids(ics).sort()).toEqual(['hoy', 's-parcial']);
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
  });
});
