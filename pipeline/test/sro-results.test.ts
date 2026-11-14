import { describe, expect, it } from 'vitest';
import type { PdfItem } from '../src/adapters/fia-documents.ts';
import { createGenericAdapter } from '../src/generic/index.ts';
import { findRecipe } from '../src/generic/recipes.ts';
import { natsoftRows } from '../src/generic/results-sro-pdf.ts';
import { matchResultLinks, sroCalendarPage, sroHtmlRows, sroKey, sroResultLinks, sroTimetable } from '../src/generic/results-sro.ts';
import { fakeGemini, fakeHttp, fixture, genericSeries, testContext } from './fakes.ts';
import type { Session } from '@dm/shared';

const EU = 'https://www.gt-world-challenge-europe.com';
const MISANO = `${EU}/event/250/misano`;
const MISANO_RESULTS = `${EU}/results?filter_season_id=26&filter_meeting_id=250`;
const items = (name: string) => JSON.parse(fixture(name)) as PdfItem[];

describe('SRO: cronograma de la página del evento', () => {
  it('Europa: hora local con la zona del circuito, una tabla por día', () => {
    const s = sroTimetable(fixture('sro-event-misano.html'), { name: 'Misano', dateStart: '2026-07-16', tz: 'Europe/Rome' });
    expect(s.map((x) => [x.name, x.startUtc, x.localStartText])).toEqual([
      ['Official test sessions', '2026-07-16T11:00:00Z', '13:00'],
      ['Free Practice 1', '2026-07-17T12:50:00Z', '14:50'],
      ['Free Practice 2', '2026-07-17T18:10:00Z', '20:10'],
      ['Qualifying 1 - Group A', '2026-07-18T11:05:00Z', '13:05'],
      ['Qualifying 1 - Group B', '2026-07-18T11:20:00Z', '13:20'],
      ['Race 1', '2026-07-18T18:30:00Z', '20:30'],
      ['Qualifying 2 - Group A', '2026-07-19T08:05:00Z', '10:05'],
      ['Qualifying 2 - Group B', '2026-07-19T08:20:00Z', '10:20'],
      ['Qualifying 2', '2026-07-19T08:40:00Z', '10:40'],
      ['Race 2', '2026-07-19T12:30:00Z', '14:30'],
    ]);
  });

  it('Spa: sin Pit Walk ni desfile; la carrera de 24 horas lleva su fin', () => {
    const s = sroTimetable(fixture('sro-event-spa.html'), { name: 'CrowdStrike 24 Hours of Spa', dateStart: '2026-06-23', tz: 'Europe/Brussels' });
    expect(s.some((x) => /pit walk|parade/i.test(x.name))).toBe(false);
    expect(s.find((x) => x.name === 'Main Race')).toMatchObject({ startUtc: '2026-06-27T14:30:00Z', endUtc: '2026-06-28T14:30:00Z' });
    expect(s.find((x) => x.name === 'Qualifying Combined')?.startUtc).toBe('2026-06-25T20:40:00Z');
  });

  it('América: horas con am/pm; sin la sesión de autógrafos ni el grid walk', () => {
    const s = sroTimetable(fixture('sro-event-sonoma.html'), { name: 'Sonoma Raceway', dateStart: '2026-03-27', tz: 'America/Los_Angeles' });
    expect(s.map((x) => [x.name, x.startUtc])).toEqual([
      ['Practice 1', '2026-03-27T23:00:00Z'],
      ['Practice 2', '2026-03-28T18:00:00Z'],
      ['Practice 3', '2026-03-28T21:15:00Z'],
      ['Qualifying', '2026-03-29T15:50:00Z'],
      ['Race', '2026-03-29T20:45:00Z'],
    ]);
  });
});

describe('SRO: tablas de resultados (HTML)', () => {
  it('Europa, carrera: clase sin "Cup", puesto en la clase, vueltas de diferencia y NC', () => {
    const rows = sroHtmlRows(fixture('sro-results-misano-race1.html'), true);
    expect(rows[0]).toEqual({
      pos: 1, driver: 'Charles Weerts / Kelvin van der Linde', number: '32', team: 'Team WRT', vehicle: 'BMW M4 GT3 EVO',
      class: 'Pro', laps: 35, bestLap: '1:33.413', classPos: 1,
    });
    expect(rows[1]).toMatchObject({ pos: 2, number: '80', gap: '+19.659', classPos: 2 });
    expect(rows[4]).toMatchObject({ pos: 5, number: '99', class: 'Gold', classPos: 1 });
    // El sitio publica "-8:26.909" para el auto con 31 vueltas: se muestra la diferencia en vueltas.
    expect(rows.find((r) => r.number === '555')).toMatchObject({ pos: 41, laps: 31, gap: '+4 vueltas' });
    expect(rows.filter((r) => r.pos === null).map((r) => [r.number, r.status])).toEqual([['66', 'NC'], ['3', 'NC']]);
  });

  it('Europa, clasificación combinada de Spa: promedio de los pilotos y diferencia; DNS', () => {
    const rows = sroHtmlRows(fixture('sro-results-spa-qcombined.html'), false);
    expect(rows[0]).toMatchObject({ pos: 1, number: '51', driver: 'Alessio Rovera / Tommaso Mosca / Nicklas Nielsen', time: '2:17.068', class: 'Pro' });
    expect(rows[1]).toMatchObject({ pos: 2, time: '2:17.108', gap: '+0.040' });
    expect(rows.filter((r) => r.status === 'DNS').map((r) => r.number)).toEqual(['12', '65']);
  });

  it('Asia: la clase es la columna Cat; tiempo total del ganador y "1 Lap"', () => {
    const rows = sroHtmlRows(fixture('sro-results-sepang-race1.html'), true);
    expect(rows[0]).toMatchObject({ pos: 1, number: '911', class: 'Pro-Am', time: '1:01:18.375', laps: 26, classPos: 1 });
    expect(rows[1]).toMatchObject({ pos: 2, number: '29', class: 'Silver', gap: '+6.856', classPos: 1 });
    expect(rows.find((r) => r.pos === 21)).toMatchObject({ class: 'Am', gap: '+1 vuelta' });
    expect(rows.filter((r) => r.status === 'NC')).toHaveLength(2);
  });

  it('América: columna Best Lap; el auto que no largó queda DNS', () => {
    const rows = sroHtmlRows(fixture('sro-results-sonoma-race.html'), true);
    expect(rows[1]).toMatchObject({ pos: 2, number: '12', class: 'Pro', bestLap: '1:34.816', gap: '+0.922', laps: 109 });
    expect(rows.find((r) => r.number === '9')).toMatchObject({ pos: 17, gap: '+8 vueltas' });
    expect(rows.find((r) => r.number === '50')).toMatchObject({ pos: null, status: 'DNS' });
  });

  it('lista de sesiones: selector filter_race_id (HTML) o enlaces a PDF (Australia)', () => {
    const eu = sroResultLinks(fixture('sro-results-misano.html'), MISANO_RESULTS);
    expect(eu.find((l) => l.label === 'Race 1')).toEqual({ label: 'Race 1', url: `${MISANO_RESULTS}&filter_race_id=1783`, kind: 'html', id: 1783 });
    const au = sroResultLinks(fixture('sro-results-phillip-island.html'), 'https://www.gt-world-challenge-australia.com/results?filter_season_id=6&filter_meeting_id=22');
    expect(au.map((l) => [l.label, l.kind])).toContainEqual(['Race 1', 'pdf']);
    expect(au.find((l) => l.label === 'Practice 1')?.url).toBe(
      'https://www.gt-world-challenge-australia.com/images/results/22/Final%20Results%20GTWC%20Australia%20powered%20by%20AWS%20R1%20Free%20Practice%201%20(1).pdf',
    );
  });

  it('nombres equivalentes entre el cronograma, los resultados y otro sitio de SRO', () => {
    expect(sroKey('Pre Qualifying')).toBe(sroKey('Pre-Qualifying'));
    expect(sroKey('Pole Shootout (Top-10)')).toBe(sroKey('Superpole'));
    expect(sroKey('Super Pole')).toBe(sroKey('Superpole'));
    expect(sroKey('Race')).toBe(sroKey('Main Race'));
    expect(sroKey('Paid Test Session 1')).toBe(sroKey('Official Paid Test Session 1'));
    expect(sroKey('Combined Qualifying')).toBe(sroKey('Qualifying Combined'));
    expect(sroKey('Qualifying 2 - Group A')).not.toBe(sroKey('Qualifying 2'));
    const s = (id: string, name: string, startUtc: string) => ({ id, name, startUtc }) as Session;
    const links = [
      { label: 'Test Session', url: 'b', kind: 'html' as const, id: 9 },
      { label: 'Test Session', url: 'a', kind: 'html' as const, id: 3 },
      { label: 'Race', url: 'pdf', kind: 'pdf' as const },
      { label: 'Main Race', url: 'html', kind: 'html' as const, id: 7 },
    ];
    const m = matchResultLinks([s('t2', 'Test Session', '2026-10-08T14:45:00Z'), s('t1', 'Test Session', '2026-10-07T19:25:00Z'), s('r', 'Race', '2026-10-10T16:30:00Z')], links);
    expect([m.get('t1')?.url, m.get('t2')?.url, m.get('r')?.url]).toEqual(['a', 'b', 'html']);
  });
});

describe('SRO: clasificaciones en PDF de NATSOFT (Australia, Bathurst)', () => {
  it('carrera: tiempo del ganador, diferencia calculada, vueltas de menos y NC', () => {
    const rows = natsoftRows(items('sro-natsoft-phillip-island-race1.json'));
    expect(rows[0]).toEqual({
      pos: 1, driver: 'B. Feeney / B. Schumacher', number: '1', team: 'Kelso Electrical MPC', vehicle: 'Audi R8 LMS EVO ll',
      class: 'Pro-Am', laps: 31, bestLap: '1:26.9973', time: '1:00:01.3101', classPos: 1,
    });
    // "Tigani B.Leitch/S.Pires" viene en un solo texto del PDF: se separa por la posición de cada palabra.
    expect(rows[3]).toMatchObject({ pos: 4, number: '44', team: 'Geyer Valmont Racing by Tigani', driver: 'B. Leitch / S. Pires', gap: '+19.148' });
    expect(rows.find((r) => r.number === '15')).toMatchObject({ pos: 14, laps: 28, gap: '+3 vueltas' });
    expect(rows.at(-1)).toMatchObject({ pos: null, status: 'NC', number: '66', driver: 'Paul Lucchitti' });
  });

  it('Bathurst: tripulaciones en dos renglones, clases PRO/BRO/I/GT4 y la tabla que sigue en la página 2', () => {
    const rows = natsoftRows(items('sro-natsoft-bathurst-race.json'));
    expect(rows[0]).toMatchObject({ pos: 1, number: '888', driver: 'M. Engel / M. Grenier / M. Martin', team: 'Mercedes-AMG Team GMR', time: '12:01:39.8977', laps: 262 });
    expect(rows[1]).toMatchObject({ pos: 2, class: 'Bronze', classPos: 1, gap: '+1.037' });
    expect(rows.find((r) => r.number === '111')).toMatchObject({ class: 'Invitational', gap: '+26 vueltas' });
    expect(rows.find((r) => r.number === '42')).toMatchObject({ class: 'GT4', classPos: 1 });
    expect(rows.filter((r) => r.status === 'NC').map((r) => r.number)).toEqual(['95', '6', '222', '50', '64']);
    expect(rows.find((r) => r.number === '6')?.driver).toBe('J. Ojeda / F. Schiller / P. Ellis');
  });

  it('clasificación: un piloto por auto (Q1 / Q2), diferencia con la precisión del PDF', () => {
    const rows = natsoftRows(items('sro-natsoft-sydney-q1.json'));
    expect(rows.slice(0, 2)).toEqual([
      { pos: 1, driver: 'Alex Peroni', number: '268', team: 'Team BRM', vehicle: 'Audi R8 LMS EVO ll', class: 'Pro-Am', laps: 8, bestLap: '1:25.7995', classPos: 1 },
      { pos: 2, driver: 'Ryan Wood', number: '88', team: 'Team BRM / Wolfbrook Motorsport', vehicle: 'Audi R8 LMS EVO 11', class: 'Pro-Am', laps: 8, bestLap: '1:25.8181', gap: '+0.0186', classPos: 2 },
    ]);
  });
});

describe('SRO: calendario de la temporada pedida', () => {
  it('América ya muestra 2027: la temporada 2026 sale del selector de temporadas', async () => {
    const CAL = 'https://www.gt-world-challenge-america.com/calendar';
    const http = fakeHttp({ [`${CAL}?filter_season_id=11`]: fixture('sro-america-calendar-filter-2026.html') });
    const ctx = { season: 2026, series: genericSeries('gtwc-america', 'GTWC America', [CAL]), http, now: new Date('2026-11-14T12:00:00Z') };
    const y2026 = await sroCalendarPage(fixture('sro-america-calendar-2027.html'), CAL, ctx);
    expect(y2026.map((e) => [e.name, e.dateStart, e.url])).toEqual([
      ['Miami GT Opening Drive', '2026-02-12', 'https://www.gt-world-challenge-america.com/event/120/miami-gt-opening-drive'],
      ['Sonoma Raceway', '2026-03-27', 'https://www.gt-world-challenge-america.com/event/111/sonoma-raceway'],
    ]);
    const y2027 = await sroCalendarPage(fixture('sro-america-calendar-2027.html'), CAL, { ...ctx, season: 2027 });
    expect(y2027.map((e) => e.dateStart)).toEqual(['2027-04-02', '2027-05-07']);
    expect(http.requested).toHaveLength(1);
  });
});

describe('SRO: fecha ya corrida, de punta a punta (sesiones reconstruidas y resultados sin IA)', () => {
  const series = genericSeries('gtwc-europe', 'GT World Challenge Europe', [`${EU}/calendar`, `${EU}/standings`]);
  const routes = {
    [`${EU}/calendar`]: fixture('sro-europe-calendar-misano.html'),
    [MISANO]: fixture('sro-event-misano.html'),
    [MISANO_RESULTS]: fixture('sro-results-misano.html'),
    [`${MISANO_RESULTS}&filter_race_id=1783`]: fixture('sro-results-misano-race1.html'),
    [`${MISANO_RESULTS}&filter_race_id=1890`]: fixture('sro-results-misano-q1-combined.html'),
  };

  it('el cronograma suma la "Qualifying 1 Combined" y los resultados llegan a cada sesión', async () => {
    const NOW = '2026-11-14T12:00:00Z';
    const gemini = fakeGemini();
    const adapter = createGenericAdapter({ gemini: () => gemini });
    const ctx = testContext(fakeHttp(routes), NOW);
    const chunk = await adapter.schedule(series, ctx);
    expect(chunk.events.map((e) => [e.name, e.sessionsStatus])).toEqual([['Misano', 'published']]);
    const q1c = chunk.sessions.find((s) => (s.originalName ?? s.name) === 'Qualifying 1 Combined');
    expect(q1c).toMatchObject({ type: 'clasificacion', startUtc: '2026-07-18T11:20:00Z' });
    expect(chunk.sessions).toHaveLength(11);

    const pending = [...chunk.sessions].sort((a, b) => b.startUtc.localeCompare(a.startUtc));
    const res = await adapter.results!(series, ctx, { events: chunk.events, pendingSessions: pending, sessions: chunk.sessions, standingsStale: false });
    expect(gemini.requests).toHaveLength(0);
    const file = res.results[0]!;
    const original = (id: string) => {
      const x = chunk.sessions.find((y) => y.id === id);
      return x?.originalName ?? x?.name;
    };
    const byName = new Map(file.sessions.map((s) => [original(s.sessionId), s]));
    expect([...byName.keys()].sort()).toEqual(['Qualifying 1 Combined', 'Race 1']);
    expect(byName.get('Race 1')!.rows[0]).toMatchObject({ pos: 1, number: '32', class: 'Pro' });
    expect(byName.get('Race 1')!.source).toMatchObject({ url: `${MISANO_RESULTS}&filter_race_id=1783`, method: 'directo', kind: 'html' });
    expect(byName.get('Qualifying 1 Combined')!.rows[1]).toMatchObject({ pos: 2, number: '66', class: 'Silver', gap: '+0.099' });
  });

  it('la carrera se acepta recién después de su duración prevista (antes queda diferida)', async () => {
    const recipe = findRecipe(`${EU}/calendar`)!;
    const http = fakeHttp(routes);
    const race = { id: 'r1', eventId: 'e', seriesId: 'gtwc-europe', type: 'carrera', name: 'Carrera 1', originalName: 'Race 1', startUtc: '2026-07-18T18:30:00Z' } as Session;
    const entry = { name: 'Misano', circuit: 'Misano', country: 'Italia', tz: 'Europe/Rome', dateStart: '2026-07-16', dateEnd: '2026-07-19', url: MISANO };
    const early = await recipe.results!(entry, [race], { season: 2026, series, http, now: new Date('2026-07-18T20:00:00Z') });
    expect(early).toMatchObject({ sessions: [], deferred: ['r1'] });
    const late = await recipe.results!(entry, [race], { season: 2026, series, http, now: new Date('2026-07-18T22:00:00Z') });
    expect(late?.sessions.map((s) => s.sessionId)).toEqual(['r1']);
  });
});
