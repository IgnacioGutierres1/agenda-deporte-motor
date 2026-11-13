import { describe, expect, it } from 'vitest';
import { buildIcs, escapeIcsText, foldLine, nextIsoDate, toIcsDate, toIcsUtc, type IcsAllDayEventInput, type IcsEventInput } from '../src/ics.ts';
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

  it('aclara cuando la transmisión es la habitual y no la publicada por la fuente', () => {
    const ics = buildIcs([{ ...base, broadcastIsDefault: true }]);
    expect(ics).toContain('DESCRIPTION:Transmisión habitual: TV Pública\\, Motorplay\\nFuente:');
    expect(buildIcs([{ ...base, broadcast: [], broadcastIsDefault: true }])).toContain('DESCRIPTION:Transmisión: A confirmar');
  });
});

describe('ics: eventos sin horarios (día completo)', () => {
  const pending: IcsAllDayEventInput = {
    allDay: true,
    id: 'ev123',
    dateStart: '2026-11-13',
    dateEnd: '2026-11-15',
    seriesName: 'Turismo Carretera',
    circuit: 'Parque Ciudad de Río Cuarto',
    eventName: 'Fecha 14 – Río Cuarto',
    country: 'Argentina',
    broadcast: ['TV Pública', 'Motorplay'],
    broadcastIsDefault: true,
    sourceUrl: 'https://www.actc.org.ar/tc/calendario.html',
  };

  it('usa DTSTART/DTEND con VALUE=DATE y fin exclusivo', () => {
    const ics = buildIcs([pending], { now: new Date('2026-11-12T12:00:00Z') });
    expect(ics).toContain('UID:ev123@agendadeportemotor.local');
    expect(ics).toContain('DTSTART;VALUE=DATE:20261113\r\n');
    // El domingo 15 inclusive: el fin es el lunes 16.
    expect(ics).toContain('DTEND;VALUE=DATE:20261116\r\n');
    expect(ics).toContain('TRANSP:TRANSPARENT');
    expect(ics).not.toContain('TZID');
    expect(ics).not.toContain('VTIMEZONE');
  });

  it('titula como las sesiones con "(horarios a confirmar)" y lleva transmisión habitual y fuente', () => {
    const ics = buildIcs([pending]);
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain('SUMMARY:Turismo Carretera (Parque Ciudad de Río Cuarto) - Fecha 14 – Río Cuarto (horarios a confirmar)');
    expect(unfolded).toContain(
      'DESCRIPTION:Horarios a confirmar: la fuente oficial todavía no publicó el cronograma.\\nTransmisión habitual: TV Pública\\, Motorplay\\nFuente: https://www.actc.org.ar/tc/calendario.html',
    );
    expect(unfolded).toContain('LOCATION:Parque Ciudad de Río Cuarto\\, Argentina');
    // CRLF y plegado a 75 octetos también en estas líneas.
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
  });

  it('un rally con el recorrido publicado y sin horas de largada no lleva "(horarios a confirmar)"', () => {
    const dakar: IcsAllDayEventInput = {
      ...pending,
      id: 'dakar27',
      dateStart: '2027-01-02',
      dateEnd: '2027-01-16',
      seriesName: 'Rally Dakar',
      circuit: 'Arabia Saudita',
      eventName: 'Rally Dakar 2027',
      country: 'Arabia Saudita',
      broadcast: [],
      broadcastIsDefault: false,
      sourceUrl: 'https://www.dakar.com/es/recorrido',
      itinerary: true,
    };
    const unfolded = buildIcs([dakar]).replace(/\r\n /g, '');
    expect(unfolded).toContain('SUMMARY:Rally Dakar (Arabia Saudita) - Rally Dakar 2027\r\n');
    expect(unfolded).not.toContain('horarios a confirmar');
    expect(unfolded).not.toContain('Horarios a confirmar');
    expect(unfolded).toContain('DESCRIPTION:Rally por etapas: el organizador publica el recorrido de cada día\\, no la hora de largada.\\nTransmisión: A confirmar\\nFuente: https://www.dakar.com/es/recorrido');
    // Dos semanas de día completo: del 2 al 16 inclusive.
    expect(unfolded).toContain('DTSTART;VALUE=DATE:20270102');
    expect(unfolded).toContain('DTEND;VALUE=DATE:20270117');
  });

  it('una sesión de tipo etapa (bloque de tramos de un día) se exporta con su horario, como cualquier sesión', () => {
    const block: IcsEventInput = {
      ...base,
      id: '7a11000000000003',
      startUtc: '2026-11-12T22:33:00Z',
      endUtc: '2026-11-13T10:05:00Z',
      seriesName: 'Campeonato Mundial de Rally',
      circuit: 'Toyota',
      country: 'Japón',
      sessionName: 'Etapa del viernes: SS2 a SS8',
    };
    const unfolded = buildIcs([block]).replace(/\r\n /g, '');
    expect(unfolded).toContain('DTSTART:20261112T223300Z');
    expect(unfolded).toContain('DTEND:20261113T100500Z');
    expect(unfolded).toContain('SUMMARY:Campeonato Mundial de Rally (Toyota) - Etapa del viernes: SS2 a SS8');
  });

  it('un evento de un solo día termina al día siguiente; ordena antes que las sesiones del mismo día', () => {
    const oneDay = { ...pending, id: 'gala', dateStart: '2026-12-31', dateEnd: '2026-12-31' };
    const session = { ...base, id: 'ses', startUtc: '2026-12-31T10:00:00Z', endUtc: '2026-12-31T11:00:00Z' };
    const ics = buildIcs([session, oneDay]);
    expect(ics).toContain('DTSTART;VALUE=DATE:20261231');
    expect(ics).toContain('DTEND;VALUE=DATE:20270101');
    expect(ics.indexOf('UID:gala@')).toBeLessThan(ics.indexOf('UID:ses@'));
  });

  it('convierte y valida fechas', () => {
    expect(toIcsDate('2026-11-13')).toBe('20261113');
    expect(nextIsoDate('2028-02-28')).toBe('2028-02-29');
    expect(nextIsoDate('2026-12-31')).toBe('2027-01-01');
    expect(() => toIcsDate('2026-02-30')).toThrow(/inválida/);
    expect(() => toIcsDate('13/11/2026')).toThrow(/inválida/);
  });
});
