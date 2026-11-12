import { describe, expect, it } from 'vitest';
import {
  formatTime,
  localToUtc,
  normalizeTime,
  toLocalWallIso,
  toUtcIso,
} from '../src/time.ts';
import { eventInPeriod, overlaps, resolvePeriod } from '../src/period.ts';
import { stableHash, slugify } from '../src/hash.ts';

describe('time', () => {
  it('convierte hora local de circuito a UTC respetando horario de verano', () => {
    // Silverstone en julio: BST (UTC+1)
    expect(localToUtc('2026-07-05', '15:00', 'Europe/London')).toBe('2026-07-05T14:00:00Z');
    // Silverstone en enero: GMT (UTC+0)
    expect(localToUtc('2026-01-05', '15:00', 'Europe/London')).toBe('2026-01-05T15:00:00Z');
    // Lusail: UTC+3 todo el año
    expect(localToUtc('2026-11-29', '19:00', 'Asia/Qatar')).toBe('2026-11-29T16:00:00Z');
    // Daytona en noviembre (después del cambio de horario): EST UTC-5
    expect(localToUtc('2026-11-08', '15:00', 'America/New_York')).toBe('2026-11-08T20:00:00Z');
  });

  it('formatea en hora argentina', () => {
    expect(formatTime('2026-11-29T16:00:00Z')).toBe('13:00');
  });

  it('normaliza variantes de hora', () => {
    expect(normalizeTime('9.30')).toBe('09:30');
    expect(normalizeTime('09h30')).toBe('09:30');
    expect(normalizeTime('0930')).toBe('09:30');
    expect(() => normalizeTime('25:00')).toThrow();
  });

  it('genera hora de pared local para Google Calendar (sin offset ni Z)', () => {
    expect(toLocalWallIso('2026-10-16T16:55:00Z')).toBe('2026-10-16T13:55:00');
  });

  it('normaliza ISO con offset', () => {
    expect(toUtcIso('2026-02-03T10:00:00+0800')).toBe('2026-02-03T02:00:00Z');
  });
});

describe('period', () => {
  // Martes 10/11/2026 12:00 ARG
  const tuesday = '2026-11-10T15:00:00Z';
  // Sábado 14/11/2026 12:00 ARG
  const saturday = '2026-11-14T15:00:00Z';

  it('este finde desde un martes = viernes a lunes siguientes', () => {
    expect(resolvePeriod('este-finde', tuesday)).toEqual({
      startUtc: '2026-11-13T03:00:00Z',
      endUtc: '2026-11-16T03:00:00Z',
    });
  });

  it('este finde desde un sábado = finde en curso', () => {
    expect(resolvePeriod('este-finde', saturday).startUtc).toBe('2026-11-13T03:00:00Z');
  });

  it('incluir jueves adelanta el inicio', () => {
    expect(resolvePeriod('este-finde', tuesday, { includeThursday: true }).startUtc).toBe(
      '2026-11-12T03:00:00Z',
    );
  });

  it('próximos 2 y 4 findes', () => {
    expect(resolvePeriod('proximos-2-findes', tuesday).endUtc).toBe('2026-11-23T03:00:00Z');
    expect(resolvePeriod('proximos-4-findes', tuesday).endUtc).toBe('2026-12-07T03:00:00Z');
  });

  it('próximo mes desde hoy', () => {
    expect(resolvePeriod('proximo-mes', tuesday)).toEqual({
      startUtc: '2026-11-10T03:00:00Z',
      endUtc: '2026-12-10T03:00:00Z',
    });
  });

  it('personalizado con fechas inclusivas y validación', () => {
    expect(resolvePeriod('personalizado', tuesday, { from: '2026-11-27', to: '2026-11-29' })).toEqual({
      startUtc: '2026-11-27T03:00:00Z',
      endUtc: '2026-11-30T03:00:00Z',
    });
    expect(() => resolvePeriod('personalizado', tuesday, { from: '2026-11-29', to: '2026-11-27' })).toThrow();
  });

  it('superposición de intervalos y eventos', () => {
    const p = resolvePeriod('este-finde', tuesday);
    expect(overlaps(p, '2026-11-15T17:00:00Z', '2026-11-15T19:00:00Z')).toBe(true);
    expect(overlaps(p, '2026-11-16T03:00:00Z', '2026-11-16T04:00:00Z')).toBe(false);
    expect(eventInPeriod(p, '2026-11-12', '2026-11-13', 'Asia/Qatar')).toBe(true);
    expect(eventInPeriod(p, '2026-11-20', '2026-11-22', 'Asia/Qatar')).toBe(false);
  });

  it('un evento que empieza al día siguiente no cuenta para hoy (límite exacto)', () => {
    const AR = 'America/Argentina/Buenos_Aires';
    const jueves = { startUtc: '2026-11-12T03:00:00Z', endUtc: '2026-11-13T03:00:00Z' };
    expect(eventInPeriod(jueves, '2026-11-13', '2026-11-15', AR)).toBe(false);
    expect(eventInPeriod(jueves, '2026-11-12', '2026-11-12', AR)).toBe(true);
    const domingo = { startUtc: '2026-11-15T03:00:00Z', endUtc: '2026-11-16T03:00:00Z' };
    expect(eventInPeriod(domingo, '2026-11-13', '2026-11-15', AR)).toBe(true);
    expect(eventInPeriod({ startUtc: '2026-11-16T03:00:00Z', endUtc: '2026-11-17T03:00:00Z' }, '2026-11-13', '2026-11-15', AR)).toBe(false);
  });
});

describe('hash', () => {
  it('es estable e insensible a mayúsculas/espacios', () => {
    expect(stableHash('f1', 2026, 'Qatar GP')).toBe(stableHash('F1', '2026', ' qatar gp '));
    expect(stableHash('a')).not.toBe(stableHash('b'));
    expect(stableHash('x')).toMatch(/^[0-9a-f]{16}$/);
  });

  it('slugify', () => {
    expect(slugify('Gran Premio de Qatar – Lusail')).toBe('gran-premio-de-qatar-lusail');
    expect(slugify('Autódromo Oscar Cabalén')).toBe('autodromo-oscar-cabalen');
  });
});
