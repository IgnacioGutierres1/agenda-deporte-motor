import { describe, expect, it } from 'vitest';
import { agendaPeriod, dayStrip, nextEventOf, pastEventsOf } from '../src/lib/agenda.ts';
import { NOW, scheduleFixture } from './helpers.ts';

const AR = 'America/Argentina/Buenos_Aires';

describe('agenda', () => {
  it('franja: Finde primero, luego días con Ayer/Hoy/Mañana', () => {
    const strip = dayStrip(NOW, AR, 2, 2);
    expect(strip.map((d) => d.label)).toEqual(['Finde', 'jue, 12 nov', 'Ayer', 'Hoy', 'Mañana', 'lun, 16 nov']);
    expect(strip[3]!.value).toBe('2026-11-14');
  });

  it('un día es de 00:00 a 24:00 en la zona elegida', () => {
    expect(agendaPeriod('2026-11-14', NOW, AR)).toEqual({ startUtc: '2026-11-14T03:00:00Z', endUtc: '2026-11-15T03:00:00Z' });
  });

  it('próximo evento y eventos disputados de una categoría', () => {
    const schedule = scheduleFixture();
    const tc = nextEventOf(schedule, 'tc', NOW)!;
    expect(tc.event.id).toBe('ev-tc-sannicolas');
    expect(tc.live).toBe(true);
    expect(tc.nextSession?.name).toBe('Clasificación');
    expect(nextEventOf(schedule, 'nascar-cup', NOW)?.nextSession).toBeUndefined();
    expect(pastEventsOf(schedule, 'tc', NOW).map((e) => e.id)).toEqual(['ev-tc-sannicolas']);
  });
});
