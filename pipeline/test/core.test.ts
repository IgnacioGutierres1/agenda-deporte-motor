import { describe, expect, it } from 'vitest';
import type { ScheduleFile, Series, Source } from '@dm/shared';
import { classifySession, createBuilders } from '../src/core/builders.ts';
import { mergeSeries } from '../src/core/config.ts';
import { mergeRun } from '../src/core/merge.ts';
import { pendingResultSessions } from '../src/core/results.ts';
import { appearsInDocument, validateSessions } from '../src/validate.ts';

const source: Source = {
  url: 'https://example.org/timetable',
  title: 'Timetable',
  kind: 'html',
  method: 'directo',
  fetchedAt: '2026-11-10T12:00:00Z',
};

const series: Series = {
  id: 'f2',
  name: 'FIA Fórmula 2',
  shortName: 'F2',
  group: 'f1-fia',
  officialUrls: ['https://www.fiaformula2.com/Calendar'],
  strategy: 'adapter',
  adapter: 'fia-junior',
  origin: 'default',
  enabled: true,
};

const build = createBuilders({ default: { carrera: 60 }, f2: { carrera: 55 } }, { f2: ['Disney+'] });
const event = build.event({
  series,
  season: 2026,
  key: 13,
  name: 'Qatar',
  round: 13,
  circuit: 'Lusail International Circuit',
  country: 'Qatar',
  tz: 'Asia/Qatar',
  dateStart: '2026-11-27',
  dateEnd: '2026-11-29',
  sessionsStatus: 'published',
  source,
});
const race = build.session({
  event,
  type: 'carrera',
  name: 'Feature Race',
  startUtc: '2026-11-29T10:00:00Z',
  localStartText: '13:00',
  source,
});

describe('builders', () => {
  it('estima el fin y usa la transmisión habitual cuando la fuente no la informa', () => {
    expect(race.endUtc).toBe('2026-11-29T10:55:00Z');
    expect(race.endEstimated).toBe(true);
    expect(race.broadcast).toEqual(['Disney+']);
    expect(race.broadcastIsDefault).toBe(true);
  });

  it('genera ids estables', () => {
    const again = build.session({ event, type: 'carrera', name: 'Feature Race', startUtc: '2026-11-29T11:00:00Z', source });
    expect(again.id).toBe(race.id);
  });

  it('clasifica nombres de sesión', () => {
    expect(classifySession('Free Practice 1')).toBe('practica');
    expect(classifySession('Sprint Qualifying')).toBe('clasificacion');
    expect(classifySession('Sprint Race')).toBe('sprint');
    expect(classifySession('Feature Race')).toBe('carrera');
    expect(classifySession('Clasificación')).toBe('clasificacion');
    expect(classifySession('2ª Serie')).toBe('serie');
    expect(classifySession('Final')).toBe('carrera');
    expect(classifySession('Warm Up')).toBe('warmup');
  });
});

describe('validate', () => {
  it('descarta sesiones fuera de las fechas del evento y duplicadas', () => {
    const outside = { ...race, id: 'x', startUtc: '2026-12-05T10:00:00Z', endUtc: '2026-12-05T11:00:00Z' };
    const { valid, issues } = validateSessions([race, race, outside], [event]);
    expect(valid).toHaveLength(1);
    expect(issues.map((i) => i.reason)).toEqual([
      'Sesión duplicada',
      expect.stringContaining('no cae dentro'),
    ]);
  });

  it('control literal: la hora debe figurar en el documento', () => {
    const doc = 'Sábado 28 | Clasificación 9.30 | Carrera 14:05 hs';
    expect(appearsInDocument('09:30', doc)).toBe(true);
    expect(appearsInDocument('14:05', doc)).toBe(true);
    expect(appearsInDocument('14:50', doc)).toBe(false);
    expect(appearsInDocument('Clasificacion', doc)).toBe(true);
    expect(appearsInDocument('4:05', doc)).toBe(false);
  });
});

describe('mergeRun', () => {
  const previous: ScheduleFile = {
    version: 1,
    generatedAt: '2026-11-09T12:00:00Z',
    series: [series],
    events: [event],
    sessions: [{ ...race, startUtc: '2026-11-29T09:00:00Z', endUtc: '2026-11-29T09:55:00Z', hasResults: false }],
  };

  it('marca cambios de horario', () => {
    const out = mergeRun(
      [series],
      new Map([['f2', { kind: 'ok', chunk: { events: [event], sessions: [race] } }]]),
      previous,
      new Map(),
      '2026-11-10T12:00:00Z',
    );
    expect(out.sessions[0]?.changedAt).toBe('2026-11-10T12:00:00Z');
    expect(out.sessions[0]?.previousStartUtc).toBe('2026-11-29T09:00:00Z');
    expect(out.statuses[0]?.state).toBe('ok');
  });

  it('ante un error conserva el último dato bueno como desactualizado', () => {
    const out = mergeRun(
      [series],
      new Map([['f2', { kind: 'error', error: new Error('HTTP 503') }]]),
      previous,
      new Map([['f2', { seriesId: 'f2', state: 'ok', lastAttempt: 'x', lastSuccess: '2026-11-09T12:00:00Z', standingsAvailable: true }]]),
      '2026-11-10T12:00:00Z',
    );
    expect(out.sessions).toHaveLength(1);
    expect(out.statuses[0]).toMatchObject({ state: 'stale', message: 'HTTP 503', lastSuccess: '2026-11-09T12:00:00Z' });
  });

  it('un modelo de respaldo que lee muchas menos fechas no reemplaza las anteriores', () => {
    const many = (n: number, model: string, method: 'ia' | 'directo' = 'ia') =>
      Array.from({ length: n }, (_, i) => ({
        ...event,
        id: `e${i}`,
        dateStart: `2026-0${(i % 9) + 1}-10`,
        dateEnd: `2026-0${(i % 9) + 1}-12`,
        source: { ...event.source, method, model },
      }));
    const prev: ScheduleFile = { ...previous, events: many(10, 'gemini-3.6-flash'), sessions: [] };
    const groq = mergeRun([series], new Map([['f2', { kind: 'ok', chunk: { events: many(4, 'groq/qwen/qwen3.8-27b'), sessions: [] } }]]), prev, new Map(), 'now');
    expect(groq.events).toHaveLength(10);
    expect(groq.statuses[0]).toMatchObject({ state: 'stale' });
    expect(groq.statuses[0]?.message).toContain('4 de 10 fechas');
    // Gemini, o un respaldo que lee casi todo, sí reemplaza.
    expect(mergeRun([series], new Map([['f2', { kind: 'ok', chunk: { events: many(4, 'gemini-3.6-flash'), sessions: [] } }]]), prev, new Map(), 'now').events).toHaveLength(4);
    expect(mergeRun([series], new Map([['f2', { kind: 'ok', chunk: { events: many(9, 'groq/openai/gpt-oss-120b'), sessions: [] } }]]), prev, new Map(), 'now').events).toHaveLength(9);
  });

  it('sin datos previos queda en error', () => {
    const out = mergeRun([series], new Map([['f2', { kind: 'error', error: new Error('x') }]]), null, new Map(), 'now');
    expect(out.statuses[0]?.state).toBe('error');
  });
});

describe('mergeSeries', () => {
  it('agrega, desactiva, fija y oculta', () => {
    const merged = mergeSeries(
      [series],
      {
        added: [{ id: 'formula-e', name: 'Fórmula E', shortName: 'FE', officialUrls: ['https://www.fiaformulae.com/'] }],
        disabled: ['f2'],
        pinned: ['euro-nascar'],
        hidden: ['gt4-europe'],
      },
      {
        version: 1,
        generatedAt: '2026-11-10T00:00:00Z',
        items: [
          { seriesId: 'euro-nascar', name: 'NASCAR Euro', officialUrl: 'https://www.euronascar.com/', firstSeen: '2026-11-01', source },
          { seriesId: 'gt4-europe', name: 'GT4 Europe', officialUrl: 'https://www.gt4-european-series.com/', firstSeen: '2026-11-01', source },
        ],
      },
    );
    expect(merged.find((s) => s.id === 'f2')?.enabled).toBe(false);
    expect(merged.find((s) => s.id === 'formula-e')).toMatchObject({ origin: 'user', strategy: 'generic', enabled: true });
    expect(merged.find((s) => s.id === 'euro-nascar')?.origin).toBe('user');
    expect(merged.find((s) => s.id === 'gt4-europe')).toBeUndefined();
  });
});

describe('pendingResultSessions', () => {
  it('incluye sesiones terminadas sin resultado y abandona las viejas tras 5 intentos', () => {
    const now = new Date('2026-12-10T00:00:00Z');
    const old = { ...race, id: 'old' };
    const recent = { ...race, id: 'recent', startUtc: '2026-12-09T10:00:00Z', endUtc: '2026-12-09T11:00:00Z' };
    const future = { ...race, id: 'future', startUtc: '2026-12-11T10:00:00Z', endUtc: '2026-12-11T11:00:00Z' };
    const pending = pendingResultSessions([old, recent, future], now, { old: { count: 5, last: 'x' } });
    expect(pending.map((s) => s.id)).toEqual(['recent']);
  });
});
