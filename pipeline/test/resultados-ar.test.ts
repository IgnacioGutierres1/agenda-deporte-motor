import { eventResultsFileSchema, type Session } from '@dm/shared';
import { describe, expect, it, vi } from 'vitest';
import { createGenericAdapter } from '../src/generic/index.ts';
import { findRecipe } from '../src/generic/recipes.ts';
import { actcEventDocs, actcHtmlRows, actcPdfRows, actcResultItems } from '../src/generic/results-actc.ts';
import { arRows, arSessionKey, matchArSessions, pastSessionsFromDocs, withKnownNames } from '../src/generic/results-ar.ts';
import { apatResultSessions, apatResultsDate } from '../src/generic/results-apat.ts';
import { aptpPageMatches, aptpResultSessions } from '../src/generic/results-aptp.ts';
import { tc2000Sessions, tc2000When } from '../src/generic/results-tc2000.ts';
import type { CalendarEntry, RecipeContext } from '../src/generic/types.ts';
import { fakeGemini, fakeHttp, fixture, genericSeries, testContext } from './fakes.ts';

// Los PDF de los fixtures se guardan como el texto que extrae unpdf de los PDF oficiales: pdfToText devuelve ese
// texto tal cual (un PDF de verdad, que empieza con %PDF, se sigue leyendo con unpdf).
vi.mock('../src/extract/document.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/extract/document.ts')>();
  return {
    ...mod,
    pdfToText: async (bytes: Uint8Array) => {
      const text = new TextDecoder().decode(bytes);
      return text.startsWith('%PDF') ? mod.pdfToText(bytes) : text;
    },
  };
});

const TZ = 'America/Argentina/Buenos_Aires';
const pdf = (name: string) => ({ body: fixture(name), contentType: 'application/pdf' });

/** Sesión mínima para unir resultados (id = nombre). */
const session = (name: string, startUtc = '2026-10-24T12:00:00Z'): Session => ({
  id: name,
  eventId: 'e',
  seriesId: 's',
  type: 'otro',
  name,
  startUtc,
  endUtc: startUtc,
  endEstimated: true,
  broadcast: [],
  broadcastIsDefault: true,
  source: { url: 'https://example.com', title: 'x', kind: 'html', method: 'directo', fetchedAt: '2026-10-24T00:00:00Z' },
  hasResults: false,
});

describe('resultados argentinos: claves de sesión', () => {
  it('reconoce tipo, número, clase y grupo con los nombres de los documentos y de los cronogramas', () => {
    expect(arSessionKey('1ER ENTRENAMIENTO TC')).toEqual({ kind: 'practica', n: 1, cls: null, group: null });
    expect(arSessionKey('3ERA  SERIE RESULTADOS')).toMatchObject({ kind: 'serie', n: 3 });
    expect(arSessionKey('SERIE 3 TC')).toMatchObject({ kind: 'serie', n: 3 });
    expect(arSessionKey('SERIE UNICA')).toMatchObject({ kind: 'serie', n: 1 });
    expect(arSessionKey('FINAL TC PISTA RECTIFICADA')).toMatchObject({ kind: 'final', n: null });
    expect(arSessionKey('Clasificación TC (2° cuarto)')).toEqual({ kind: 'clasificacion', n: null, cls: null, group: '2° cuarto' });
    expect(arSessionKey('1er. Entrenamiento TC (Grupo A)')).toEqual({ kind: 'practica', n: 1, cls: null, group: 'A' });
    expect(arSessionKey('Clasificación - 1a tanda (Clase 2)')).toEqual({ kind: 'clasificacion', n: 1, cls: '2', group: null });
    expect(arSessionKey('1º CLASIFICACIÓN C2')).toEqual({ kind: 'clasificacion', n: 1, cls: '2', group: null });
    expect(arSessionKey('PRIMERA SERIE C3')).toMatchObject({ kind: 'serie', n: 1, cls: '3' });
    expect(arSessionKey('Entrenamiento II (Clase 1, grupo A)')).toEqual({ kind: 'practica', n: 2, cls: '1', group: 'A' });
    expect(arSessionKey('E1')).toMatchObject({ kind: 'practica', n: 1 });
    expect(arSessionKey('Clasif.2')).toMatchObject({ kind: 'clasificacion', n: 2 });
    expect(arSessionKey('Q2 (mejores 10)')).toMatchObject({ kind: 'clasificacion', n: 2 });
    expect(arSessionKey('Practica Libre 1')).toMatchObject({ kind: 'practica', n: 1 });
    expect(arSessionKey('Carrera Final')).toMatchObject({ kind: 'final' });
    expect(arSessionKey('Warm Up')).toMatchObject({ kind: 'warmup' });
    // Combinados, grillas y parciales no son una sesión.
    for (const name of ['GENERAL CLASIFICACIÓN C2', 'Clasif.Gral', 'Gral. Entrenamientos', 'GRILLA FINAL TC', 'FINAL TC PARCIALES', 'EG']) {
      expect(arSessionKey(name)).toBeNull();
    }
  });

  it('el resultado combinado de una tanda partida en grupos va a la última parte; cada sesión recibe uno solo', () => {
    const sessions = [
      session('1er. Entrenamiento TC (Grupo A)', '2026-09-12T14:05:00Z'),
      session('1er. Entrenamiento TC (Grupo B)', '2026-09-12T14:30:00Z'),
      session('Clasificación TC (2° cuarto)', '2026-09-12T19:48:00Z'),
      session('Clasificación TC (1° cuarto)', '2026-09-12T20:27:00Z'),
      session('1ra. Serie TC', '2026-09-13T13:55:00Z'),
      session('FINAL TC', '2026-09-13T17:00:00Z'),
    ];
    const docs = ['1ER ENTRENAMIENTO', 'CLASIFICACION', '1ERA SERIE TC', 'FINAL TC'].map((t) => ({ key: arSessionKey(t)!, t }));
    const pairs = matchArSessions(docs, sessions).map(([s, d]) => [d.t, s.name]);
    expect(pairs).toEqual([
      ['1ER ENTRENAMIENTO', '1er. Entrenamiento TC (Grupo B)'],
      ['CLASIFICACION', 'Clasificación TC (1° cuarto)'],
      ['1ERA SERIE TC', '1ra. Serie TC'],
      ['FINAL TC', 'FINAL TC'],
    ]);
  });

  it('las clases no se cruzan y el nombre igual manda (TN)', () => {
    const sessions = ['1er entrenamiento (Clase 2)', '1er entrenamiento (Clase 3)', 'Clasificación - 2a tanda (Clase 2)', 'Clasificación (Clase 3)'].map((n) => session(n));
    const docs = ['1º ENTRENAMIENTO C3', '2º CLASIFICACIÓN C2', 'CLASIFICACIÓN C3'].map((t) => ({ key: arSessionKey(t)!, t }));
    expect(matchArSessions(docs, sessions).map(([s, d]) => [d.t, s.name])).toEqual([
      ['1º ENTRENAMIENTO C3', '1er entrenamiento (Clase 3)'],
      ['2º CLASIFICACIÓN C2', 'Clasificación - 2a tanda (Clase 2)'],
      ['CLASIFICACIÓN C3', 'Clasificación (Clase 3)'],
    ]);
  });
});

describe('resultados argentinos: filas', () => {
  it('carrera: tiempo del ganador, diferencias calculadas, a vueltas y sin largar', () => {
    const rows = arRows(actcPdfRows(fixture('actc-final-rosario-2026.txt')), true);
    expect(rows.slice(0, 2)).toEqual([
      { pos: 1, number: '3', driver: 'LAMBIRIS MAURICIO', vehicle: 'MUSTANG', laps: 25, time: '43:54.210' },
      { pos: 2, number: '117', driver: 'ROSSI MATIAS', vehicle: 'TOYOTA', laps: 25, gap: '+2.287' },
    ]);
    expect(rows.find((r) => r.number === '154')).toMatchObject({ pos: 37, laps: 19, gap: '+6 vueltas' });
    expect(rows.find((r) => r.number === '140')).toMatchObject({ pos: 44, gap: '+24 vueltas' });
    expect(rows.slice(-2)).toEqual([
      { pos: null, status: 'DNS', number: '172', driver: 'ALVAREZ SANTIAGO', vehicle: 'CAMARO' },
      { pos: null, status: 'DNS', number: '5', driver: 'AGRELO MARCELO', vehicle: 'TORINO' },
    ]);
  });

  it('clasificación y entrenamiento: mejor vuelta y diferencia con el primero, en cualquier orden de columnas', () => {
    const q = arRows(actcPdfRows(fixture('actc-clasificacion-rosario-2026.txt')), false);
    expect(q[1]).toEqual({ pos: 2, number: '117', driver: 'ROSSI MATIAS', vehicle: 'TOYOTA', laps: 4, bestLap: '1:35.284', gap: '+0.192' });
    // Paraná: "Mejor tiempo | Dif. | Vtas".
    const p = arRows(actcPdfRows(fixture('actc-entrenamiento-parana-2026.txt')), false);
    expect(p[0]).toEqual({ pos: 1, number: '147', driver: 'DIANDA MARCO', vehicle: 'CHALLENGER', laps: 10, bestLap: '1:24.030' });
    expect(p[2]).toMatchObject({ number: '6', driver: 'TRUCCO JUAN MARTIN', vehicle: 'CHALLENGER', laps: 9, gap: '+0.162' });
  });

  it('lee los otros formatos de ACTC: LapSync, clasificación por tercios, Orbits por columnas y la vista "Ver"', () => {
    const lap = arRows(actcPdfRows(fixture('actc-final-tcm-lapsync-2026.txt')), true);
    expect(lap[0]).toEqual({ pos: 1, number: '118', driver: 'MAGGINI, FABRIZIO', vehicle: 'FORD', laps: 16, time: '24:07.699' });
    expect(lap[1]).toMatchObject({ number: '176', gap: '+0.548' });
    expect(lap.find((r) => r.number === '46')).toMatchObject({ pos: 10, laps: 14, gap: '+2 vueltas' });

    const pk = arRows(actcPdfRows(fixture('actc-clasificacion-tcpk-tercios-2026.txt')), false);
    expect(pk[0]).toEqual({ pos: 1, number: '1', driver: 'CANAPINO AGUSTIN', vehicle: 'CHEVROLET', bestLap: '1:27.640' });

    const orbits = arRows(actcPdfRows(fixture('actc-serie-orbits-tcm-2026.txt')), true);
    expect(orbits).toHaveLength(15);
    expect(orbits[0]).toEqual({ pos: 1, number: '176', driver: 'JAIME NICOLAS', vehicle: 'DODGE', laps: 5, time: '9:00.377' });
    expect(orbits[1]).toMatchObject({ number: '141', driver: 'LUENGO FRANCISCO', gap: '+0.377' });

    const ver = arRows(actcHtmlRows(fixture('actc-ver-87.html')), true);
    expect(ver[0]).toEqual({ pos: 1, number: '109', driver: 'NICOLAS MOSCARDINI', vehicle: 'FORD', laps: 25, time: '43:03.342' });
    // La diferencia se calcula con los tiempos (la vista publica otra cosa en esa columna).
    expect(ver[1]).toMatchObject({ pos: 2, number: '16', gap: '+2.018' });
  });

  it('usa el nombre del campeonato oficial cuando coincide el número y las palabras', () => {
    const rows = withKnownNames(
      [
        { pos: 1, number: '11', driver: 'WERNER MARIANO' },
        { pos: 2, number: '11', driver: 'OTRO PILOTO' },
        { pos: 3, number: '157', driver: 'DE BENEDICTIS JUAN B' },
        { pos: 4, number: '53', driver: 'CATALA N M AG N I J U AN TOM AS' },
        { pos: 5, number: '107', driver: 'MART¡NEZ, TOBIAS' },
      ],
      [
        { number: '11', name: 'Mariano WERNER' },
        { number: '157', name: 'Juan Bautista DE BENEDICTIS' },
        { number: '53', name: 'Juan Tomás CATALÁN MAGNI' },
        { number: '107', name: 'Tobías MARTÍNEZ' },
      ],
    );
    expect(rows.map((r) => r.driver)).toEqual(['Mariano WERNER', 'OTRO PILOTO', 'Juan Bautista DE BENEDICTIS', 'Juan Tomás CATALÁN MAGNI', 'Tobías MARTÍNEZ']);
  });

  it('sesiones de una fecha ya corrida: hora oficial si la hay, si no estimada y sin superponerse', () => {
    const entry = { dateStart: '2026-10-23', dateEnd: '2026-10-25', tz: TZ };
    const doc = (name: string, extra = {}) => ({ key: arSessionKey(name)!, name, ...extra });
    const sessions = pastSessionsFromDocs(
      [
        doc('Final', { date: '2026-10-25', published: '16:52' }),
        doc('1° Serie', { date: '2026-10-25', published: '12:27' }),
        doc('2° Serie', { date: '2026-10-25', published: '12:28' }),
        doc('Clasificación', { date: '2026-10-24', published: '21:40' }), // subida a la noche: no sirve
        doc('1° Entrenamiento', { date: '2026-10-24', start: '10:35', end: '11:20' }),
      ],
      entry,
    );
    expect(sessions).toEqual([
      { name: '1° Entrenamiento', startUtc: '2026-10-24T13:35:00Z', endUtc: '2026-10-24T14:20:00Z', localStartText: '10:35' },
      { name: 'Clasificación', startUtc: '2026-10-24T12:00:00Z' },
      { name: '1° Serie', startUtc: '2026-10-25T15:02:00Z' },
      { name: '2° Serie', startUtc: '2026-10-25T15:27:00Z' },
      { name: 'Final', startUtc: '2026-10-25T18:57:00Z' },
    ].sort((a, b) => a.startUtc.localeCompare(b.startUtc)));
  });
});

const recipeCtx = (http: ReturnType<typeof fakeHttp>, series: Parameters<typeof genericSeries>, now = '2026-11-14T12:00:00Z'): RecipeContext => ({
  season: 2026,
  series: genericSeries(...series),
  http,
  now: new Date(now),
});

describe('ACTC: resultados desde la lista oficial y los PDF del cronometraje', () => {
  const LIST = 'https://actc.org.ar/tc/resultados';
  const rosario: CalendarEntry = {
    name: 'Fecha 13 — Rosario', circuit: 'Rosario', country: 'Argentina', tz: TZ, dateStart: '2026-10-23', dateEnd: '2026-10-25', round: 13,
    meta: { code: 'tc', raceDate: '2026-10-25' },
  };
  const http = () =>
    fakeHttp({
      [LIST]: fixture('actc-resultados-tc.html'),
      'https://actc.org.ar/tc/campeonato': fixture('actc-campeonato.html'),
      'https://tiempos.actc.org.ar/descargar/20261025_165254_FINAL_TC.pdf': pdf('actc-final-rosario-2026.txt'),
      'https://tiempos.actc.org.ar/descargar/20261024_173658_CLASIFICACION.pdf': pdf('actc-clasificacion-rosario-2026.txt'),
    });

  it('elige los documentos de la fecha: sin parciales ni grillas, el último de cada tanda y lo de Excel solo si no hay PDF', () => {
    const { year, items } = actcResultItems(fixture('actc-resultados-tc.html'));
    expect(year).toBe(2026);
    expect(actcEventDocs(items, rosario).map((d) => d.item.title)).toEqual(['1ER ENTRENAMIENTO', '2DO ENTRENAMIENTOS', 'CLASIFICACION', '1ERA SERIE TC', '2DA SERIE TC', '3ERA SERIE TC', 'FINAL TC']);
    expect(actcEventDocs(items, rosario).find((d) => d.key.kind === 'final')!.item.id).toBe(1091);
    // Calafate: la final solo está en Excel (se lee de la vista "Ver"); "SERIES TC" es un combinado.
    const calafate = actcEventDocs(items, { dateStart: '2026-02-13', dateEnd: '2026-02-15' });
    expect(calafate.map((d) => [d.item.title, d.item.pdfUrl])).toEqual([['FINAL TC', null]]);
  });

  it('arma las sesiones de la fecha ya corrida y lee sus resultados sin IA', async () => {
    const h = http();
    const ctx = recipeCtx(h, ['tc', 'Turismo Carretera', ['https://actc.org.ar/tc/calendario', 'https://actc.org.ar/tc/campeonato']]);
    const recipe = findRecipe('https://actc.org.ar/tc/calendario')!;
    const past = await recipe.pastSessions!(rosario, ctx);
    expect(past!.sessions.map((s) => s.name)).toEqual(['1° Entrenamiento', '2° Entrenamiento', 'Clasificación', '1° Serie', '2° Serie', '3° Serie', 'Final']);
    // Hora estimada con la de publicación del PDF ("20261025_165254_FINAL_TC.pdf": 16:52 menos 45 minutos y un margen).
    expect(past!.sessions.at(-1)).toEqual({ name: 'Final', startUtc: '2026-10-25T18:57:00Z' });
    const sessions = past!.sessions.map((s) => session(s.name, s.startUtc));
    const found = await recipe.results!(rosario, sessions, ctx);
    expect(found!.sessions.map((s) => s.sessionId)).toEqual(['Clasificación', 'Final']); // los demás PDF no están (404)
    const final = found!.sessions.find((s) => s.sessionId === 'Final')!;
    expect(final.rows[0]).toEqual({ pos: 1, number: '3', driver: 'LAMBIRIS MAURICIO', vehicle: 'MUSTANG', laps: 25, time: '43:54.210' });
    expect(final.rows[2]).toMatchObject({ number: '11', driver: 'Mariano WERNER' }); // nombre del campeonato
    expect(final.source).toMatchObject({ url: 'https://tiempos.actc.org.ar/descargar/20261025_165254_FINAL_TC.pdf', kind: 'pdf', method: 'directo' });
  });

  it('una fecha sin documentos todavía: null (sin pedir PDF)', async () => {
    const h = http();
    const ctx = recipeCtx(h, ['tc', 'Turismo Carretera', ['https://actc.org.ar/tc/calendario']]);
    const recipe = findRecipe('https://actc.org.ar/tc/calendario')!;
    const laPlata = { ...rosario, name: 'Fecha 15 — La Plata', dateStart: '2026-12-04', dateEnd: '2026-12-06' };
    expect(await recipe.pastSessions!(laPlata, ctx)).toBeNull();
    expect(await recipe.results!(laPlata, [session('Final')], ctx)).toBeNull();
    expect(new Set(h.requested)).toEqual(new Set([LIST]));
  });
});

describe('TC2000: página de tiempos de la fecha', () => {
  const URL_421 = 'https://tc2000.com.ar/carreras.php?accion=tiempos&id=421';
  const roca: CalendarEntry = {
    name: 'Fecha 10 General Roca', circuit: 'General Roca', country: 'Argentina', tz: TZ, dateStart: '2026-10-30', dateEnd: '2026-11-01', round: 10,
    url: 'https://tc2000.com.ar/carreras.php?accion=historial&id=421&temp=', meta: { id: '421' },
  };

  it('lee el horario de los encabezados en sus distintas formas', () => {
    expect(tc2000When('Sábado 31 de octubre de 2026, 10:35 a 11:20hs')).toEqual({ date: '2026-10-31', start: '10:35', end: '11:20' });
    expect(tc2000When('Sábado 14 de marzo de 2026, de 10:20hs a 11:10hs')).toEqual({ date: '2026-03-14', start: '10:20', end: '11:10' });
    expect(tc2000When('Domingo 15 de marzo de 2026, de 10.05 hs. a 10.15 hs.')).toEqual({ date: '2026-03-15', start: '10:05', end: '10:15' });
  });

  it('sesiones con horario oficial (sin el combinado de entrenamientos) y sus tablas', async () => {
    expect(tc2000Sessions(fixture('tc2000-tiempos-421.html')).map((s) => [s.name, s.date, s.start, s.rows.length])).toEqual([
      ['Shakedown', '2026-10-31', '08:30', 5],
      ['Clasificación', '2026-10-31', '15:40', 5],
      ['Carrera Final', '2026-11-01', '13:05', 5],
    ]);
    const h = fakeHttp({ [URL_421]: fixture('tc2000-tiempos-421.html') });
    const ctx = recipeCtx(h, ['tc2000', 'TC2000', ['https://tc2000.com.ar/carreras.php?evento=calendario']]);
    const recipe = findRecipe('https://tc2000.com.ar/carreras.php?evento=calendario')!;
    const past = await recipe.pastSessions!(roca, ctx);
    expect(past!.sessions.map((s) => [s.name, s.startUtc, s.localStartText])).toEqual([
      ['Shakedown', '2026-10-31T11:30:00Z', '08:30'],
      ['Clasificación', '2026-10-31T18:40:00Z', '15:40'],
      ['Carrera Final', '2026-11-01T16:05:00Z', '13:05'],
    ]);
    // Con los nombres del cronograma transcripto por la IA ("Carrera final - 35 minutos + 1 vuelta").
    const found = await recipe.results!(roca, [session('Clasificación 1 vuelta lanzada'), session('Carrera final - 35 minutos + 1 vuelta')], ctx);
    const race = found!.sessions.find((s) => s.sessionId.startsWith('Carrera'))!;
    expect(race.rows[0]).toEqual({ pos: 1, driver: 'Valentín Yankelevich', vehicle: 'Toyota Corolla Cross GR-S', laps: 21, time: '36:07.254' });
    expect(race.rows[1]).toMatchObject({ pos: 2, driver: 'Matias Rossi', gap: '+1.495' });
    // El que abandonó: a vueltas (la página pone 0.000 en la diferencia).
    expect(race.rows.at(-1)).toMatchObject({ driver: 'Federico Iribarne', laps: 4, gap: '+17 vueltas' });
    expect(found!.sessions.find((s) => s.sessionId.startsWith('Clasif'))!.rows[0]).toMatchObject({ pos: 1, driver: 'Franco Vivian', bestLap: '1:33.462' });
  });
});

describe('Turismo Nacional (APAT): páginas de resultados por clase', () => {
  const concordia: CalendarEntry = {
    name: 'Concordia', circuit: 'Autódromo Ciudad de Concordia', country: 'Argentina', tz: TZ, dateStart: '2026-10-30', dateEnd: '2026-11-01',
    url: 'https://apat.org.ar/carreras/info/2026-11-01',
  };

  it('tablas por sesión, sin el combinado de clasificaciones, con el excluido al final', () => {
    const html = fixture('apat-resultados-c2-2026-11-01.html');
    expect(apatResultsDate(html)).toBe('2026-11-01');
    const sessions = apatResultSessions(html, 'c2');
    expect(sessions.map((s) => [s.name, s.publishedDate, s.published])).toEqual([
      ['Final (Clase 2)', '2026-11-01', '18:37'],
      ['1° Serie (Clase 2)', '2026-11-01', '14:41'],
      ['1° Clasificación (Clase 2)', '2026-10-31', '19:13'],
      ['2° Clasificación (Clase 2)', '2026-10-31', '21:57'],
      ['1° Entrenamiento (Clase 2)', '2026-10-31', '13:04'],
    ]);
    const final = arRows(sessions[0]!.rows, true);
    expect(final[0]).toEqual({ pos: 1, number: '177', driver: 'VITAR TOMAS', vehicle: 'Nissan March', laps: 14, time: '26:59.152' });
    expect(final[1]).toMatchObject({ pos: 2, number: '155', gap: '+0.676' });
    expect(final.at(-1)).toMatchObject({ pos: null, status: 'DSQ', number: '2' });
    // En las series, la columna Marca dice "*TN - CLASE 2".
    expect(sessions[1]!.rows[0]!.vehicle).toBeUndefined();
  });

  it('resultados de la fecha con los nombres del campeonato; sin página de la fecha, nada', async () => {
    const h = fakeHttp({
      'https://apat.org.ar/resultados/c2/2026-11-01': fixture('apat-resultados-c2-2026-11-01.html'),
      'https://apat.org.ar/campeonato/ranking/c2': fixture('apat-ranking-c2.html'),
      // La de la Clase 3 todavía muestra otra fecha: no se toma.
      'https://apat.org.ar/resultados/c3/2026-11-01': fixture('apat-resultados-c2-2026-11-01.html').replaceAll('01/11/2026', '11/10/2026'),
    });
    const ctx = recipeCtx(h, ['tn', 'Turismo Nacional', ['https://apat.org.ar/carreras', 'https://apat.org.ar/campeonato/ranking/c2']]);
    const recipe = findRecipe('https://apat.org.ar/carreras')!;
    const found = await recipe.results!(concordia, [session('Final (Clase 2)'), session('Final (Clase 3)'), session('Clasificación - 2a tanda (Clase 2)')], ctx);
    expect(found!.sessions.map((s) => s.sessionId)).toEqual(['Final (Clase 2)', 'Clasificación - 2a tanda (Clase 2)']);
    expect(found!.sessions[0]!.rows[0]!.driver).toBe('Vitar, Tomas');
    const viedma = { ...concordia, dateStart: '2026-11-27', dateEnd: '2026-11-29', url: 'https://apat.org.ar/carreras/info/2026-11-29' };
    expect(await recipe.results!(viedma, [session('Final (Clase 2)')], ctx)).toBeNull();
  });
});

describe('Turismo Pista (APTP): página de resultados por fecha y clase', () => {
  const concepcion: CalendarEntry = {
    name: 'Fecha 9 Concepción del Uruguay', circuit: 'Concepción del Uruguay', country: 'Argentina', tz: TZ, dateStart: '2026-10-16', dateEnd: '2026-10-18', round: 9,
  };

  it('pestañas de sesión (sin los combinados) y control del fin de semana', async () => {
    const html = fixture('aptp-resultados-fecha-9-c1-2026.html');
    expect(aptpPageMatches(html, '2026-10-18')).toBe(true);
    expect(aptpPageMatches(html, '2026-11-22')).toBe(false);
    const sessions = aptpResultSessions(html, '1');
    expect(sessions.map((s) => s.name)).toEqual(['Final (Clase 1)', '1° Serie (Clase 1)', '1° Clasificación (Clase 1)', '1° Entrenamiento (Clase 1)']);
    const final = arRows(sessions[0]!.rows, true);
    expect(final[0]).toEqual({ pos: 1, number: '3', driver: 'CORTINA, JOAQUÍN', vehicle: 'UNO', laps: 13, time: '24:13.825' });
    expect(final.at(-1)).toMatchObject({ pos: null, status: 'DSQ' });

    const h = fakeHttp({ 'https://aptpweb.com.ar/resultados-fecha-9-c1-2026/': html });
    const ctx = recipeCtx(h, ['turismo-pista', 'Turismo Pista', ['https://aptpweb.com.ar/calendario-2026/']]);
    const recipe = findRecipe('https://aptpweb.com.ar/calendario-2026/')!;
    const past = await recipe.pastSessions!(concepcion, ctx);
    expect(past!.sessions).toHaveLength(4);
    expect(past!.sessions.every((s) => !s.localStartText)).toBe(true); // horas estimadas
    // Con los nombres del cronograma (PDF de la mediateca).
    const found = await recipe.results!(concepcion, [session('Entrenamiento I (Clase 1, grupo A)'), session('Final (Clase 1)')], ctx);
    expect(found!.sessions.map((s) => s.sessionId)).toEqual(['Final (Clase 1)', 'Entrenamiento I (Clase 1, grupo A)']);
  });
});

describe('flujo genérico: resultados por receta sin IA', () => {
  it('los resultados de TC2000 entran por directResults, sin pedirle nada a Gemini', async () => {
    const tc2000 = genericSeries('tc2000', 'TC2000', ['https://tc2000.com.ar/carreras.php?evento=calendario'], { group: 'argentina' });
    const h = fakeHttp({
      'https://tc2000.com.ar/carreras.php?evento=calendario': fixture('tc2000-calendario.html'),
      'https://tc2000.com.ar/carreras.php?accion=tiempos&id=421': fixture('tc2000-tiempos-421.html'),
    });
    const ctx = testContext(h, '2026-11-05T12:00:00Z');
    const recipe = findRecipe(tc2000.officialUrls[0]!)!;
    const cal = recipe.calendar!(
      { url: tc2000.officialUrls[0]!, raw: fixture('tc2000-calendario.html'), text: '', title: '', kind: 'html', hash: '' } as never,
      { season: 2026, series: tc2000, http: h, now: ctx.now },
    ) as CalendarEntry[];
    const entry = cal.find((e) => e.round === 10)!;
    const past = await recipe.pastSessions!(entry, { season: 2026, series: tc2000, http: h, now: ctx.now });
    const event = ctx.build.event({
      series: tc2000, season: 2026, key: 'r10', name: entry.name, circuit: entry.circuit, country: entry.country, tz: entry.tz,
      dateStart: entry.dateStart, dateEnd: entry.dateEnd, sessionsStatus: 'published', source: past!.source,
    });
    const sessions = past!.sessions.map((s) => ctx.build.session({ event, type: 'otro', name: s.name, startUtc: s.startUtc, source: past!.source }));
    const gemini = fakeGemini();
    const out = await createGenericAdapter({ gemini: () => gemini }).results!(tc2000, ctx, {
      events: [event], pendingSessions: sessions, sessions, standingsStale: false,
    });
    expect(gemini.requests).toHaveLength(0);
    const file = eventResultsFileSchema.parse(out.results[0]);
    expect(file.sessions).toHaveLength(3);
    expect(file.sessions[0]!.source).toMatchObject({ url: 'https://tc2000.com.ar/carreras.php?accion=tiempos&id=421', method: 'directo' });
  });
});
