import { describe, expect, it } from 'vitest';
import { buildIcs, escapeIcsText, foldLine, toIcsUtc, type IcsEventInput } from '../src/ics.ts';
import { localToUtc } from '../src/time.ts';

const base: IcsEventInput = {
  id: 'abc123',
  startUtc: localToUtc('2026-10-16', '13:55', 'America/Argentina/Buenos_Aires'),
  endUtc: localToUtc('2026-10-16', '15:30', 'America/Argentina/Buenos_Aires'),
  seriesName: 'Turismo Carretera',
  circuit: 'Autódromo de San Nicolás',
  sessionName: 'Carrera Final',
  country: 'Argentina',
  broadcast: ['TV Pública', 'Motorplay'],
  sourceUrl: 'https://www.actc.org.ar/',
};

describe('ics', () => {
  it('aplica la fórmula del gem: hora ARG + 3 h = UTC con Z', () => {
    const ics = buildIcs([base], { now: new Date('2026-10-10T12:00:00Z') });
    expect(ics).toContain('DTSTART:20261016T165500Z');
    expect(ics).toContain('DTEND:20261016T183000Z');
    expect(ics).toContain('DTSTAMP:20261010T120000Z');
  });

  it('usa CRLF en todas las líneas y nunca LF suelto', () => {
    const ics = buildIcs([base]);
    expect(ics.endsWith('\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
    expect(ics.split('\r\n').length).toBeGreaterThan(10);
  });

  it('no usa VTIMEZONE ni TZID', () => {
    const ics = buildIcs([base]);
    expect(ics).not.toContain('VTIMEZONE');
    expect(ics).not.toContain('TZID');
  });

  it('respeta la estructura del evento del gem', () => {
    const ics = buildIcs([base]);
    expect(ics).toContain('UID:abc123@agendadeportemotor.local');
    expect(ics).toContain('SUMMARY:Turismo Carretera (Autódromo de San Nicolás) - Carrera Final');
    expect(ics).toContain('DESCRIPTION:Transmisión: TV Pública\\, Motorplay\\nFuente: https://www.actc');
    expect(ics).toContain('LOCATION:Autódromo de San Nicolás\\, Argentina');
    expect(ics).toContain('STATUS:CONFIRMED');
    expect(ics.indexOf('BEGIN:VEVENT')).toBeLessThan(ics.indexOf('END:VEVENT'));
  });

  it('ordena los eventos por hora de inicio', () => {
    const later = { ...base, id: 'z', startUtc: '2026-10-17T10:00:00Z', endUtc: '2026-10-17T11:00:00Z' };
    const ics = buildIcs([later, base]);
    expect(ics.indexOf('UID:abc123')).toBeLessThan(ics.indexOf('UID:z@'));
  });

  it('pliega líneas largas a 75 octetos sin romper caracteres', () => {
    const line = 'DESCRIPTION:' + 'á'.repeat(80);
    const folded = foldLine(line);
    for (const part of folded.split('\r\n')) {
      expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
    }
    expect(folded.replace(/\r\n /g, '')).toBe(line);
  });

  it('escapa caracteres especiales', () => {
    expect(escapeIcsText('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
  });

  it('convierte ISO con offset a UTC', () => {
    expect(toIcsUtc('2026-11-28T17:00:00+03:00')).toBe('20261128T140000Z');
  });
});
