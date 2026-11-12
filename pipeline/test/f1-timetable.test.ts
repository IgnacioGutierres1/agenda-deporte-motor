import { describe, expect, it } from 'vitest';
import { f1CalendarRanges, matchF1Round, parseTimetableArticle } from '../src/adapters/f1-timetable.ts';
import { createGenericAdapter } from '../src/generic/index.ts';
import { fixture as rootFixture } from './fake-http.ts';
import { fakeGemini, fakeHttp, fixture, genericSeries, testContext } from './fakes.ts';

const F1 = 'https://www.formula1.com';
const LV_SCHEDULE = `${F1}/en/latest/article/formula-1-heineken-las-vegas-grand-prix-2026.1qmWzcBwKK5hkTbYbhVC22`;
const F1A_CAL = 'https://www.f1academy.com/Racing-Series/Calendar';

describe('cronograma oficial del fin de semana (formula1.com)', () => {
  it('ubica la ronda de F1 por las fechas de las tarjetas del calendario', () => {
    const ranges = f1CalendarRanges(rootFixture('f1/season-2026-cards.html'), 2026);
    expect(ranges).toEqual([
      { slug: 'las-vegas', dateStart: '2026-11-19', dateEnd: '2026-11-21' },
      { slug: 'qatar', dateStart: '2026-11-27', dateEnd: '2026-11-29' },
      { slug: 'united-arab-emirates', dateStart: '2026-12-04', dateEnd: '2026-12-06' },
    ]);
    expect(matchF1Round(ranges, '2026-11-19', '2026-11-21')).toBe('las-vegas');
    // F1 Academy suele empezar un día antes que F1 (jueves): alcanza con que se superpongan.
    expect(matchF1Round(ranges, '2026-11-26', '2026-11-29')).toBe('qatar');
    expect(matchF1Round(ranges, '2026-10-22', '2026-10-25')).toBeNull();
  });

  it('lee las tablas por día con la zona del circuito (Las Vegas, de noche: UTC del día siguiente)', () => {
    const rows = parseTimetableArticle(rootFixture('f1/schedule-las-vegas.html'), 'America/Los_Angeles', '2026-11-19');
    // Sin conferencias, desfiles ni himno.
    expect(rows.every((r) => !/press|parade|anthem|presentation/i.test(r.fullName))).toBe(true);
    const f1 = rows.find((r) => r.series === 'FORMULA 1' && r.name === 'FIRST PRACTICE SESSION')!;
    // Igual que el cronograma de F1 que publica la ronda (Practice 1: 2026-11-20T00:30Z).
    expect(f1).toMatchObject({ localDate: '2026-11-19', localStartText: '16:30', startUtc: '2026-11-20T00:30:00Z' });
    const academy = rows.filter((r) => r.series === 'F1 ACADEMY');
    expect(academy.map((r) => [r.type, r.name, r.localStartText, r.startUtc, r.endUtc])).toEqual([
      ['practica', 'Practice Session', '18:00', '2026-11-20T02:00:00Z', '2026-11-20T02:40:00Z'],
      ['clasificacion', 'Qualifying Session', '21:30', '2026-11-20T05:30:00Z', '2026-11-20T06:00:00Z'],
      ['carrera', 'Reverse Race', '18:15', '2026-11-21T02:15:00Z', '2026-11-21T02:50:00Z'],
      ['carrera', 'Feature Race', '16:20', '2026-11-22T00:20:00Z', '2026-11-22T00:55:00Z'],
    ]);
  });
});

describe('F1 Academy (f1academy.com + cronograma de formula1.com)', () => {
  const series = genericSeries('f1-academy', 'F1 Academy', [F1A_CAL]);

  function http() {
    return fakeHttp({
      [F1A_CAL]: fixture('f1academy-calendar-2026.html'),
      [`${F1}/en/racing/2026`]: rootFixture('f1/season-2026-cards.html'),
      [`${F1}/en/racing/2026/las-vegas`]: rootFixture('f1/round-las-vegas-full-schedule.html'),
      [LV_SCHEDULE]: rootFixture('f1/schedule-las-vegas.html'),
    });
  }

  it('con las sesiones "Unconfirmed" usa las filas "F1 ACADEMY" con los nombres de la categoría, sin IA', async () => {
    const gemini = fakeGemini({});
    const chunk = await createGenericAdapter({ gemini: () => gemini }).schedule(series, testContext(http(), '2026-11-12T12:00:00Z'));
    const lv = chunk.events.find((e) => e.name === 'Las Vegas')!;
    expect(lv).toMatchObject({ round: 6, dateStart: '2026-11-19', dateEnd: '2026-11-21', sessionsStatus: 'published' });
    const sessions = chunk.sessions.filter((s) => s.eventId === lv.id);
    expect(sessions.map((s) => [s.type, s.name, s.localStartText, s.startUtc, s.endUtc, s.endEstimated])).toEqual([
      ['practica', 'Free Practice', '18:00', '2026-11-20T02:00:00Z', '2026-11-20T02:40:00Z', false],
      ['clasificacion', 'Qualifying', '21:30', '2026-11-20T05:30:00Z', '2026-11-20T06:00:00Z', false],
      ['carrera', 'Reverse Grid Race', '18:15', '2026-11-21T02:15:00Z', '2026-11-21T02:50:00Z', false],
      ['carrera', 'Feature Race', '16:20', '2026-11-22T00:20:00Z', '2026-11-22T00:55:00Z', false],
    ]);
    expect(sessions[0]!.source).toMatchObject({ url: LV_SCHEDULE, kind: 'html', method: 'directo' });
    expect(gemini.callsMade()).toBe(0);
  });

  it('las sesiones confirmadas se leen de f1academy.com con la hora local y la zona del circuito (Austin, CDT)', async () => {
    const chunk = await createGenericAdapter({ gemini: () => fakeGemini({}) }).schedule(series, testContext(http(), '2026-10-20T12:00:00Z'));
    const austin = chunk.events.find((e) => e.name === 'Austin')!;
    const sessions = chunk.sessions.filter((s) => s.eventId === austin.id);
    // El sitio publica "12:25-06:00" (offset de invierno): en octubre Austin está en UTC-5.
    expect(sessions[0]).toMatchObject({ name: 'Free Practice', localStartText: '12:25', startUtc: '2026-10-22T17:25:00Z' });
    // Feature Race: 12:00 local, igual que el cronograma oficial de formula1.com (17:00Z).
    expect(sessions.at(-1)).toMatchObject({ name: 'Feature Race', startUtc: '2026-10-25T17:00:00Z' });
    expect(sessions[0]!.source.url).toBe(F1A_CAL);
  });
});
