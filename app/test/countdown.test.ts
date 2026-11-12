import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countdown, countdownLabel, formatMinutesLeft } from '../src/lib/countdown.ts';
import { msToNextMinute, startClock } from '../src/lib/clock.ts';

const START = '2026-11-20T00:30:00Z';
const END = '2026-11-20T01:30:00Z';

describe('countdown', () => {
  it('días y horas: "en 6 d 9 h"', () => {
    expect(countdown(START, END, '2026-11-13T15:30:00Z')).toEqual({ state: 'upcoming', text: 'en 6 d 9 h', minutes: 9180 });
    expect(countdownLabel(START, END, '2026-11-13T15:30:00Z')).toBe('Empieza en 6 d 9 h');
  });

  it('horas y minutos: "en 2 h 15 min"; horas justas sin minutos', () => {
    expect(countdown(START, END, '2026-11-19T22:15:00Z').text).toBe('en 2 h 15 min');
    expect(countdown(START, END, '2026-11-19T22:30:00Z').text).toBe('en 2 h');
  });

  it('menos de una hora: minutos redondeados hacia arriba, nunca "en 0 min"', () => {
    expect(countdown(START, END, '2026-11-20T00:18:00Z').text).toBe('en 12 min');
    expect(countdown(START, END, '2026-11-20T00:17:30Z').text).toBe('en 13 min');
    expect(countdown(START, END, '2026-11-20T00:29:59Z').text).toBe('en 1 min');
    expect(countdown(START, END, '2026-11-19T23:30:00Z').text).toBe('en 1 h');
    expect(countdown(START, END, '2026-11-19T23:30:01Z').text).toBe('en 1 h');
  });

  it('un día justo, sin horas; desde 10 días, solo días', () => {
    expect(countdown(START, END, '2026-11-19T00:30:00Z').text).toBe('en 1 d');
    expect(countdown(START, END, '2026-11-10T20:00:00Z').text).toBe('en 9 d 4 h');
    expect(countdown(START, END, '2026-11-07T20:00:00Z').text).toBe('en 12 d');
  });

  it('en curso entre el inicio y el fin; terminó después del fin', () => {
    expect(countdown(START, END, START)).toMatchObject({ state: 'live', text: 'En curso' });
    expect(countdown(START, END, '2026-11-20T01:00:00Z').state).toBe('live');
    expect(countdown(START, END, END)).toMatchObject({ state: 'finished', text: 'Terminó' });
    expect(countdownLabel(START, END, END)).toBe('Terminó');
  });

  it('sin hora de fin, una sesión empezada se considera en curso', () => {
    expect(countdown(START, undefined, '2026-11-21T00:00:00Z').state).toBe('live');
  });

  it('acepta Date o milisegundos y no se rompe con fechas inválidas', () => {
    expect(countdown(START, END, new Date('2026-11-20T00:18:00Z')).text).toBe('en 12 min');
    expect(countdown(START, END, Date.parse('2026-11-20T00:18:00Z')).text).toBe('en 12 min');
    expect(countdown('no-es-fecha', END, START)).toEqual({ state: 'upcoming', text: '', minutes: 0 });
    expect(countdownLabel('no-es-fecha', END, START)).toBe('');
  });

  it('no depende de la zona horaria (es una diferencia entre instantes)', () => {
    expect(countdown('2026-03-29T01:30:00Z', undefined, '2026-03-28T23:30:00Z').text).toBe('en 2 h');
  });

  it('formatMinutesLeft', () => {
    expect(formatMinutesLeft(0.2)).toBe('en 1 min');
    expect(formatMinutesLeft(59)).toBe('en 59 min');
    expect(formatMinutesLeft(24 * 60 + 59)).toBe('en 1 d');
    expect(formatMinutesLeft(25 * 60)).toBe('en 1 d 1 h');
  });
});

describe('reloj compartido', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T10:00:42.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeDoc() {
    const listeners: Array<() => void> = [];
    return {
      visibilityState: 'visible' as DocumentVisibilityState,
      addEventListener: (_: string, fn: () => void) => listeners.push(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.splice(listeners.indexOf(fn), 1),
      fire() {
        listeners.forEach((fn) => fn());
      },
      listeners,
    };
  }

  it('msToNextMinute apunta al cambio de minuto (con un margen)', () => {
    expect(msToNextMinute(Date.parse('2026-11-12T10:00:42.000Z'))).toBe(18_250);
    expect(msToNextMinute(Date.parse('2026-11-12T10:00:00.000Z'))).toBe(60_250);
  });

  it('un solo temporizador: avisa al empezar cada minuto, se pausa oculto y retoma al volver', () => {
    const doc = fakeDoc();
    const tick = vi.fn();
    const stop = startClock(tick, { doc: doc as unknown as Document });
    vi.advanceTimersByTime(18_000);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(300);
    expect(tick).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(tick).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);

    doc.visibilityState = 'hidden';
    doc.fire();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5 * 60_000);
    expect(tick).toHaveBeenCalledTimes(2);

    doc.visibilityState = 'visible';
    doc.fire();
    expect(tick).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);

    stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(doc.listeners).toHaveLength(0);
  });
});
