import { describe, expect, it } from 'vitest';
import { eventResultsFileSchema, type Session } from '@dm/shared';
import { createGenericAdapter } from '../src/generic/index.ts';
import { parseClock, timeAppears, validateResultRows, validateStandingsRows } from '../src/generic/ai.ts';
import { findRecipe } from '../src/generic/recipes.ts';
import { guessTimeZone, parseDateRangeText } from '../src/generic/places.ts';
import { validateSessions } from '../src/validate.ts';
import { fakeGemini, fakeHttp, fixture, genericSeries, testContext } from './fakes.ts';

const CAL = 'https://gt.example.org/calendar';
const EVENT_BA = 'https://gt.example.org/events/buenos-aires';
const RESULTS = 'https://gt.example.org/results';
const NOW = '2026-11-10T12:00:00Z';

const exampleGt = genericSeries('example-gt', 'Example GT', [CAL, RESULTS]);

/** Respuesta de Gemini para el cronograma de Buenos Aires: tres sesiones reales y una inventada. */
const timetableReply = () => ({
  sessions: [
    { name: 'Free Practice 1', category: 'Example GT', date: '2026-11-20', localStartText: '09:30', localEndText: '10:30' },
    { name: 'Qualifying', category: 'Example GT', date: '2026-11-21', localStartText: '14:05', localEndText: '14:35' },
    { name: 'Race', category: 'Example GT', date: '2026-11-22', localStartText: '13.00', localEndText: null },
    { name: 'Warm Up', category: 'Example GT', date: '2026-11-22', localStartText: '08:45' },
  ],
});

function gtHttp() {
  return fakeHttp({
    [CAL]: fixture('calendar-jsonld.html'),
    [EVENT_BA]: fixture('event-buenos-aires.html'),
    [RESULTS]: fixture('results-buenos-aires.html'),
  });
}

describe('fechas y husos (lectores deterministas)', () => {
  it('interpreta los formatos de fecha de los calendarios oficiales', () => {
    expect(parseDateRangeText('28 - 31 May 2026', 2026)).toEqual({ start: '2026-05-28', end: '2026-05-31' });
    expect(parseDateRangeText('30 October 2026 - 1 November 2026', 2026)).toEqual({ start: '2026-10-30', end: '2026-11-01' });
    expect(parseDateRangeText('18.-19.04.2026', 2026)).toEqual({ start: '2026-04-18', end: '2026-04-19' });
    expect(parseDateRangeText('15 y 16 de noviembre', 2026)).toEqual({ start: '2026-11-15', end: '2026-11-16' });
    expect(parseDateRangeText('13/11/26', 2026)).toEqual({ start: '2026-11-13', end: '2026-11-13' });
    expect(parseDateRangeText('Mar 7', 2026)).toEqual({ start: '2026-03-07', end: '2026-03-07' });
  });

  it('elige la zona del circuito, incluso en países con varios husos', () => {
    expect(guessTimeZone('Australia', 'Adelaide Grand Final')).toBe('Australia/Adelaide');
    expect(guessTimeZone('United States', 'Monterey, California')).toBe('America/Los_Angeles');
    expect(guessTimeZone('ITA')).toBe('Europe/Rome');
    expect(guessTimeZone('Narnia')).toBeNull();
  });

  it('lee horas en 12 y 24 h y exige que figuren literalmente', () => {
    expect(parseClock('5:00 PM')).toBe('17:00');
    expect(parseClock('9.30')).toBe('09:30');
    expect(parseClock('12:15 a.m.')).toBe('00:15');
    expect(timeAppears('9:30', 'Practice 09:30 - 10:30')).toBe(true);
    expect(timeAppears('5:00 PM', 'Race 5:00PM ET')).toBe(true);
    expect(timeAppears('5:00 AM', 'Race 5:00PM ET')).toBe(false);
    expect(timeAppears('4:05', 'Final 14:05')).toBe(false);
  });
});

describe('recetas de sitios oficiales', () => {
  it('SRO: eventos futuros y pasados con fechas, ronda, zona y link', async () => {
    const url = 'https://www.gt-world-challenge-australia.com/calendar';
    const recipe = findRecipe(url)!;
    const entries = await recipe.calendar!(
      { url, kind: 'html', raw: fixture('sro-calendar.html'), text: '', title: '', hash: '' },
      { season: 2026, series: exampleGt, http: gtHttp(), now: new Date(NOW) },
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({ name: 'Phillip Island', dateStart: '2026-10-30', dateEnd: '2026-11-01', round: 9, tz: 'Australia/Melbourne' });
    expect(entries[1]).toMatchObject({
      name: 'Adelaide Grand Final',
      dateStart: '2026-11-26',
      dateEnd: '2026-11-29',
      round: 11,
      tz: 'Australia/Adelaide',
      url: 'https://www.gt-world-challenge-australia.com/event/28/adelaide-grand-final',
    });
  });

  it('ACTC: calendario del payload de Next.js y cronograma desde la API oficial, filtrado por categoría', async () => {
    const http = fakeHttp({
      'https://actc.org.ar/tcp/calendario': fixture('actc-calendario.html'),
      'https://actc.org.ar/api/schedules': fixture('actc-schedules.json'),
    });
    const series = genericSeries('tc-pista', 'TC Pista', ['https://actc.org.ar/tcp/calendario'], { shortName: 'TC Pista' });
    const gemini = fakeGemini();
    const chunk = await createGenericAdapter({ gemini: () => gemini }).schedule(series, testContext(http, NOW));
    expect(chunk.events.map((e) => [e.name, e.dateStart, e.dateEnd, e.sessionsStatus])).toEqual([
      ['Fecha 14 — Río Cuarto', '2026-11-13', '2026-11-15', 'published'],
      ['Fecha 15 — La Plata', '2026-12-04', '2026-12-06', 'pending'],
    ]);
    expect(chunk.sessions.map((s) => [s.name, s.type, s.localStartText, s.startUtc])).toEqual([
      ['1er. Entrenamiento TCP (Grupo A)', 'practica', '09:25', '2026-11-14T12:25:00Z'],
      ['1er. Entrenamiento TCP (Grupo B)', 'practica', '10:00', '2026-11-14T13:00:00Z'],
      ['Clasificación TCP (2° Tercio)', 'clasificacion', '16:09', '2026-11-14T19:09:00Z'],
      ['1ra. Serie TCP', 'serie', '10:05', '2026-11-15T13:05:00Z'],
      ['FINAL TCP', 'carrera', '12:55', '2026-11-15T15:55:00Z'],
    ]);
    expect(chunk.sessions[0]!.source).toMatchObject({ kind: 'api', method: 'directo', url: 'https://actc.org.ar/cronogramas/sch-rc' });
    expect(chunk.sessions[4]!.endEstimated).toBe(false);
    expect(gemini.requests).toHaveLength(0);
  });
});

describe('flujo genérico: calendario + cronograma con IA', () => {
  it('lee el calendario sin IA (JSON-LD) y transcribe el cronograma descartando horas inventadas', async () => {
    const gemini = fakeGemini({ cronograma: timetableReply });
    const ctx = testContext(gtHttp(), NOW);
    const chunk = await createGenericAdapter({ gemini: () => gemini }).schedule(exampleGt, ctx);

    expect(chunk.events.map((e) => [e.dateStart, e.tz, e.sessionsStatus, e.source.method])).toEqual([
      ['2026-11-20', 'America/Argentina/Buenos_Aires', 'published', 'directo'],
      ['2026-12-11', 'America/Sao_Paulo', 'pending', 'directo'],
    ]);
    // "Warm Up 08:45" no figura en el documento: se descarta.
    expect(chunk.sessions.map((s) => [s.name, s.startUtc, s.endUtc, s.endEstimated, s.localStartText])).toEqual([
      ['Práctica libre 1', '2026-11-20T12:30:00Z', '2026-11-20T13:30:00Z', false, '09:30'],
      ['Clasificación', '2026-11-21T17:05:00Z', '2026-11-21T17:35:00Z', false, '14:05'],
      ['Carrera', '2026-11-22T16:00:00Z', '2026-11-22T17:00:00Z', true, '13.00'],
    ]);
    expect(chunk.sessions[0]!.source).toMatchObject({ url: EVENT_BA, kind: 'html', method: 'ia' });
    expect(validateSessions(chunk.sessions, chunk.events).issues).toEqual([]);

    // A Gemini se le pasa el texto compacto del documento y el nombre de la serie.
    expect(gemini.requests).toHaveLength(1);
    expect(gemini.requests[0]!.text).toContain('Example GT - Qualifying | 14:05');
    expect(gemini.requests[0]!.prompt).toContain('"Example GT"');
  });

  it('usa la caché: si el documento no cambió no vuelve a llamar a Gemini', async () => {
    const gemini = fakeGemini({ cronograma: timetableReply });
    const adapter = createGenericAdapter({ gemini: () => gemini });
    const first = testContext(gtHttp(), NOW);
    const a = await adapter.schedule(exampleGt, first);
    const b = await adapter.schedule(exampleGt, testContext(gtHttp(), NOW, first.cacheDir));
    expect(gemini.requests).toHaveLength(1);
    expect(b.sessions).toEqual(a.sessions);

    // Sin clave también se aprovecha la caché.
    const offline = fakeGemini({}, { available: false });
    const c = await createGenericAdapter({ gemini: () => offline }).schedule(exampleGt, testContext(gtHttp(), NOW, first.cacheDir));
    expect(c.sessions).toHaveLength(3);
  });

  it('sin clave: el calendario determinista igual produce eventos (horarios a confirmar)', async () => {
    const offline = fakeGemini({}, { available: false });
    const chunk = await createGenericAdapter({ gemini: () => offline }).schedule(exampleGt, testContext(gtHttp(), NOW));
    expect(chunk.events).toHaveLength(2);
    expect(chunk.events.every((e) => e.sessionsStatus === 'pending')).toBe(true);
    expect(chunk.sessions).toEqual([]);
  });

  it('sin clave: si el calendario necesita IA, la serie falla con un mensaje claro', async () => {
    const url = 'https://zonal.example.org/calendario';
    const series = genericSeries('zonal', 'Campeonato Zonal', [url]);
    const offline = fakeGemini({}, { available: false });
    const http = fakeHttp({ [url]: fixture('calendar-plain.html') });
    await expect(createGenericAdapter({ gemini: () => offline }).schedule(series, testContext(http, NOW))).rejects.toThrow(
      /^Falta GEMINI_API_KEY/,
    );
  });

  it('calendario sin estructura: Gemini lo lee y el cronograma sale de una nota del índice de noticias', async () => {
    const url = 'https://zonal.example.org/calendario';
    const news = 'https://zonal.example.org/noticias';
    const article = 'https://zonal.example.org/noticias/1203-cronograma-rafaela';
    const series = genericSeries('zonal', 'Campeonato Zonal', [url, news], { shortName: 'Zonal' });
    const http = fakeHttp({
      [url]: fixture('calendar-plain.html'),
      [news]: fixture('news-index.html'),
      [article]: fixture('news-cronograma-rafaela.html'),
    });
    const gemini = fakeGemini({
      calendario: () => ({
        events: [
          { name: 'Fecha 11', circuit: 'Autódromo Ciudad de Rafaela', city: 'Rafaela', country: 'Argentina', timeZone: 'America/Argentina/Cordoba', dateStart: '2026-11-21', dateEnd: '2026-11-22', round: 11, url: 'https://zonal.example.org/fechas/rafaela' },
          { name: 'Fecha 12', circuit: 'Autódromo de Concordia', country: 'Argentina', timeZone: 'America/Argentina/Buenos_Aires', dateStart: '2026-12-12', dateEnd: '2026-12-13', round: 12 },
          { name: 'Fecha 13', circuit: 'Autódromo Inventado', country: 'Argentina', dateStart: '2026-12-19', dateEnd: '2026-12-20', round: 13 },
        ],
      }),
      cronograma: () => ({
        sessions: [
          { name: '1er. Entrenamiento', date: '2026-11-21', localStartText: '9:00', localEndText: '9:25' },
          { name: 'Clasificación', date: '2026-11-21', localStartText: '16:00' },
          { name: 'Final', date: '2026-11-22', localStartText: '13:15' },
        ],
      }),
    });
    const chunk = await createGenericAdapter({ gemini: () => gemini }).schedule(series, testContext(http, NOW));

    // El evento inventado (no figura en la página) se descarta.
    expect(chunk.events.map((e) => [e.round, e.sessionsStatus, e.source.method])).toEqual([
      [11, 'published', 'ia'],
      [12, 'pending', 'ia'],
    ]);
    expect(chunk.sessions.map((s) => [s.name, s.startUtc])).toEqual([
      ['1er. Entrenamiento', '2026-11-21T12:00:00Z'],
      ['Clasificación', '2026-11-21T19:00:00Z'],
      ['Final', '2026-11-22T16:15:00Z'],
    ]);
    expect(chunk.sessions[0]!.source.url).toBe(article);
    // A Gemini le llega la página sin scripts, estilos ni navegación.
    const calendarText = gemini.requests.find((r) => r.label?.startsWith('calendario'))!.text!;
    expect(calendarText).toContain('Fecha 11');
    expect(calendarText).not.toContain('tracking');
    expect(calendarText).not.toContain('Inicio');
  });
});

describe('resultados con IA', () => {
  it('valida pilotos y posiciones antes de aceptar una tabla', () => {
    const doc = fixture('results-buenos-aires.html');
    const ok = [
      { pos: 1, driver: 'Ana Pérez', number: '7' },
      { pos: 2, driver: 'Juan Gómez', number: '22' },
      { pos: null, status: 'DNF', driver: 'Pedro Ruiz' },
    ];
    expect(validateResultRows(ok, doc)).toBeNull();
    expect(validateResultRows([{ pos: 1, driver: 'Ana Pérez' }, { pos: 3, driver: 'Juan Gómez' }], doc)).toMatch(/consecutivas/);
    expect(validateResultRows([{ pos: 1, driver: 'Piloto Fantasma' }], doc)).toMatch(/no figura/);
    expect(validateResultRows([{ pos: 1, driver: 'Ana Pérez', number: '99' }], doc)).toMatch(/número/);
    expect(
      validateStandingsRows({ title: 'Pilotos', rows: [{ pos: 1, name: 'Ana Pérez', points: 50 }, { pos: 1, name: 'Juan Gómez', points: 50 }] }, doc),
    ).toBeNull();
  });

  it('transcribe resultados de sesiones terminadas y descarta tablas que no pasan los controles', async () => {
    const adapter = createGenericAdapter({ gemini: () => fakeGemini({ cronograma: timetableReply }) });
    const ctx = testContext(gtHttp(), NOW);
    const chunk = await adapter.schedule(exampleGt, ctx);
    const baSessions = chunk.sessions.filter((s) => s.eventId === chunk.events[0]!.id);

    const gemini = fakeGemini({
      resultados: () => ({
        sessions: [
          {
            sessionName: 'Race',
            rows: [
              { pos: 1, number: '7', driver: 'Ana Pérez', team: 'Equipo Sur', laps: 40, time: '1:02:33.456' },
              { pos: 2, number: '22', driver: 'Juan Gómez', team: 'Racing Norte', laps: 40, gap: '+3.210' },
              { pos: 3, number: '14', driver: 'Lucía Díaz', team: 'Equipo Sur', laps: 40, gap: '+8.004' },
              { pos: null, status: 'DNF', number: '5', driver: 'Pedro Ruiz', laps: 12 },
            ],
          },
          { sessionName: 'Qualifying', rows: [{ pos: 1, driver: 'Piloto Fantasma' }] },
        ],
      }),
    });
    const later = testContext(gtHttp(), '2026-11-23T12:00:00Z', ctx.cacheDir);
    const out = await createGenericAdapter({ gemini: () => gemini }).results!(exampleGt, later, {
      events: chunk.events,
      pendingSessions: [...baSessions].reverse(),
      sessions: chunk.sessions,
      standingsStale: false,
    });
    expect(out.results).toHaveLength(1);
    const file = eventResultsFileSchema.parse(out.results[0]);
    const race = baSessions.find((s: Session) => s.originalName === 'Race')!;
    expect(file.sessions.map((s) => s.sessionId)).toEqual([race.id]);
    expect(file.sessions[0]!.rows).toHaveLength(4);
    expect(file.sessions[0]!.source).toMatchObject({ url: RESULTS, method: 'ia' });
  });

  it('sin clave, los resultados se omiten sin error', async () => {
    const out = await createGenericAdapter({ gemini: () => fakeGemini({}, { available: false }) }).results!(
      exampleGt,
      testContext(gtHttp(), NOW),
      { events: [], pendingSessions: [], sessions: [], standingsStale: true },
    );
    expect(out).toEqual({ results: [] });
  });
});
