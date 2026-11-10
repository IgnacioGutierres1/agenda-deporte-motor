import { describe, expect, it } from 'vitest';
import { implausibleDateRange } from '../src/generic/ai.ts';
import { createGenericAdapter } from '../src/generic/index.ts';
import { jsonLdSessions } from '../src/generic/locate.ts';
import { findRecipe } from '../src/generic/recipes.ts';
import { fakeGemini, fakeHttp, fixture, genericSeries, testContext } from './fakes.ts';

const WEC = 'https://www.fiawec.com/en/season/2026';
const WEC_RACE = 'https://www.fiawec.com/en/race/';
const ELMS = 'https://www.europeanlemansseries.com/en/season/2026';
const ELMS_RACE = 'https://www.europeanlemansseries.com/en/race/';

const wec = genericSeries('wec', 'FIA World Endurance Championship', [WEC], { shortName: 'WEC' });
const elms = genericSeries('elms', 'European Le Mans Series', [ELMS], { shortName: 'ELMS' });

function wecHttp() {
  // Solo algunas páginas de carrera: las demás dan 404 y la temporada solo muestra su mes.
  return fakeHttp({
    [WEC]: fixture('fiawec-season-2026.html'),
    [`${WEC_RACE}official-prologue-imola-2026`]: fixture('fiawec-race-prologue-2026.html'),
    [`${WEC_RACE}6-hours-of-fuji-2026`]: fixture('fiawec-race-fuji-2026.html'),
    [`${WEC_RACE}6-hours-of-monza-2026`]: fixture('fiawec-race-monza-2026.html'),
  });
}

describe('ACO (WEC / ELMS): fechas desde la página de cada carrera', () => {
  it('WEC: la temporada solo muestra meses; las fechas salen del JSON-LD de cada carrera y nunca se usa el mes entero', async () => {
    const http = wecHttp();
    const gemini = fakeGemini();
    const chunk = await createGenericAdapter({ gemini: () => gemini }).schedule(wec, testContext(http, '2026-11-05T12:00:00Z'));

    // Las carreras sin página legible (404 en el fake) solo tienen el mes: se omiten en vez de ocupar todo el mes.
    expect(chunk.events.map((e) => [e.name, e.round, e.dateStart, e.dateEnd, e.tz, e.country, e.sessionsStatus, e.source.method])).toEqual([
      ['Official Prologue - IMOLA', undefined, '2026-04-14', '2026-04-14', 'Europe/Rome', 'Italy', 'pending', 'directo'],
      ['6 Hours of Fuji', 1, '2026-09-25', '2026-09-27', 'Asia/Tokyo', 'Japan', 'pending', 'directo'],
      ['6 Hours of Monza', 2, '2026-11-06', '2026-11-08', 'Europe/Rome', 'Italy', 'published', 'directo'],
    ]);
    // Las carreras de la temporada siguiente (tira de 2027) y los links de la tabla de campeonato no suman eventos.
    expect(http.requested.some((u) => u.includes('-2027'))).toBe(false);

    // Cronograma de Monza: subEvent del JSON-LD (sin IA), con el sufijo del evento recortado.
    expect(chunk.sessions.map((s) => [s.name, s.type, s.startUtc, s.localStartText])).toEqual([
      ['Free Practice 1', 'practica', '2026-11-06T09:30:00Z', '10:30'],
      ['Free Practice 2', 'practica', '2026-11-06T13:30:00Z', '14:30'],
      ['Free Practice 3', 'practica', '2026-11-07T09:30:00Z', '10:30'],
      ['Qualifying - LMGT3', 'clasificacion', '2026-11-07T13:20:00Z', '14:20'],
      ['Hyperpole - LMGT3', 'clasificacion', '2026-11-07T13:40:00Z', '14:40'],
      ['Qualifying - HYPERCAR', 'clasificacion', '2026-11-07T14:00:00Z', '15:00'],
      ['Hyperpole - HYPERCAR', 'clasificacion', '2026-11-07T14:20:00Z', '15:20'],
      ['Race', 'carrera', '2026-11-08T10:00:00Z', '11:00'],
    ]);
    expect(chunk.sessions[0]!.source).toMatchObject({ url: `${WEC_RACE}6-hours-of-monza-2026`, kind: 'html', method: 'directo' });
    expect(gemini.requests).toHaveLength(0);
  });

  it('WEC: las horas del JSON-LD son locales del circuito aunque el offset diga París', async () => {
    const recipe = findRecipe(WEC)!;
    const ctx = { season: 2026, series: wec, http: wecHttp(), now: new Date('2026-09-20T12:00:00Z') };
    const found = await recipe.sessions!(
      { name: '6 Hours of Fuji', circuit: 'Fuji Speedway', country: 'Japan', tz: 'Asia/Tokyo', dateStart: '2026-09-25', dateEnd: '2026-09-27', url: `${WEC_RACE}6-hours-of-fuji-2026` },
      ctx,
    );
    // "Race - 6 Hours of Fuji" figura como 2026-09-27T11:00:00+02:00: es 11:00 en Japón (02:00 UTC), no 09:00 UTC.
    expect(found!.sessions.find((s) => s.name === 'Race')).toEqual({ name: 'Race', startUtc: '2026-09-27T02:00:00Z', localStartText: '11:00' });
  });

  it('las horas de relleno (00:00) de un programa todavía no publicado se omiten', () => {
    const doc = { url: `${WEC_RACE}qatar-1812km-2027`, kind: 'html' as const, raw: fixture('fiawec-race-qatar-2027.html'), text: '', title: '', hash: '' };
    expect(jsonLdSessions(doc, { wallClockZone: 'Asia/Qatar' }).sessions).toEqual([
      { name: 'Race', startUtc: '2027-03-27T10:00:00Z', localStartText: '13:00' },
    ]);
  });

  it('ELMS: tarjetas con el día de carrera; la página de la carrera da las fechas exactas, si no, viernes a domingo', async () => {
    const http = fakeHttp({
      [ELMS]: fixture('elms-season-2026.html'),
      [`${ELMS_RACE}4-hours-of-imola-2026`]: fixture('elms-race-imola-2026.html'),
    });
    const chunk = await createGenericAdapter({ gemini: () => fakeGemini() }).schedule(elms, testContext(http, '2026-11-10T12:00:00Z'));
    expect(chunk.events.map((e) => [e.name, e.round, e.circuit, e.dateStart, e.dateEnd, e.tz])).toEqual([
      ['4 Hours of Imola', 1, 'Imola', '2026-07-03', '2026-07-05', 'Europe/Rome'],
      // Página de la carrera no disponible (404 en el fake): el día de la tarjeta ("10 October") y los dos anteriores.
      ['4 Hours of Portimão', 2, 'Autódromo Internacional do Algarve', '2026-10-08', '2026-10-10', 'Europe/Lisbon'],
    ]);
  });
});

describe('calendario con IA: rangos de fechas inverosímiles', () => {
  it('rechaza el mes entero y los rangos de más de un mes; acepta eventos largos reales', () => {
    expect(implausibleDateRange('2026-11-01', '2026-11-30')).toMatch(/mes entero/);
    expect(implausibleDateRange('2026-02-01', '2026-02-28')).toMatch(/mes entero/);
    expect(implausibleDateRange('2026-04-01', '2026-05-31')).not.toBeNull();
    expect(implausibleDateRange('2026-01-01', '2026-12-31')).not.toBeNull();
    // Fin de semana que empieza un día 1, Dakar (dos semanas), 24H con días de ensayo, semana que termina a fin de mes.
    expect(implausibleDateRange('2026-11-01', '2026-11-03')).toBeNull();
    expect(implausibleDateRange('2026-01-03', '2026-01-17')).toBeNull();
    expect(implausibleDateRange('2026-01-14', '2026-01-18')).toBeNull();
    expect(implausibleDateRange('2026-06-24', '2026-06-30')).toBeNull();
  });

  it('descarta los eventos que Gemini completó con el mes entero (la página solo indicaba el mes)', async () => {
    const url = 'https://zonal.example.org/calendario';
    const series = genericSeries('zonal', 'Campeonato Zonal', [url]);
    const http = fakeHttp({ [url]: fixture('calendar-plain.html') });
    const gemini = fakeGemini({
      calendario: () => ({
        events: [
          { name: 'Fecha 11', circuit: 'Autódromo Ciudad de Rafaela', country: 'Argentina', dateStart: '2026-11-01', dateEnd: '2026-11-30', round: 11 },
          { name: 'Fecha 12', circuit: 'Autódromo de Concordia', country: 'Argentina', dateStart: '2026-12-12', dateEnd: '2026-12-13', round: 12 },
        ],
      }),
    });
    const chunk = await createGenericAdapter({ gemini: () => gemini }).schedule(series, testContext(http, '2026-11-10T12:00:00Z'));
    expect(chunk.events.map((e) => [e.round, e.dateStart, e.dateEnd])).toEqual([[12, '2026-12-12', '2026-12-13']]);
  });

  it('si todos los eventos quedan sin días concretos, la serie falla (y conserva sus datos anteriores)', async () => {
    const url = 'https://zonal.example.org/calendario';
    const series = genericSeries('zonal', 'Campeonato Zonal', [url]);
    const http = fakeHttp({ [url]: fixture('calendar-plain.html') });
    const gemini = fakeGemini({
      calendario: () => ({
        events: [
          { name: 'Fecha 11', dateStart: '2026-11-01', dateEnd: '2026-11-30' },
          { name: 'Fecha 12', dateStart: '2026-12-01', dateEnd: '2026-12-31' },
        ],
      }),
    });
    await expect(createGenericAdapter({ gemini: () => gemini }).schedule(series, testContext(http, '2026-11-10T12:00:00Z'))).rejects.toThrow(
      /No se encontraron eventos/,
    );
    // No se pide además la lectura de imágenes del calendario.
    expect(gemini.requests.map((r) => r.label)).toEqual(['calendario zonal']);
  });
});
