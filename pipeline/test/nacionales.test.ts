import { describe, expect, it, vi } from 'vitest';
import { activityName, fechaNumber, headerDate } from '../src/generic/cronograma-ar.ts';
import { createGenericAdapter } from '../src/generic/index.ts';
import { findRecipe } from '../src/generic/recipes.ts';
import type { CalendarEntry } from '../src/generic/types.ts';
import { fakeGemini, fakeHttp, fixture, genericSeries, testContext } from './fakes.ts';

// Los PDF de los fixtures se guardan como el texto que extrae unpdf de los PDF oficiales (los PDF pesan cientos
// de KB): pdfToText devuelve ese texto tal cual. Un PDF de verdad (empieza con %PDF) se sigue leyendo con unpdf.
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

describe('cronogramas argentinos: partes comunes', () => {
  it('ubica el día por el nombre aunque el número esté mal copiado de otra fecha', () => {
    const window = { from: '2026-10-28', to: '2026-11-01' };
    expect(headerDate('Sábado 31-10', window)).toBe('2026-10-31');
    expect(headerDate('Domingo 11-10', window)).toBe('2026-11-01'); // así figura en el PDF de Concordia
    expect(headerDate('JUEVES 29 DE OCTUBRE DE 2026', window)).toBe('2026-10-29');
    expect(headerDate('SABADO 10/10', { from: '2026-10-07', to: '2026-10-11' })).toBe('2026-10-10');
    expect(headerDate('08.40 a 09.10 2 B 1° entrenamiento', window)).toBeUndefined();
  });

  it('lee el número de fecha de los títulos de las notas', () => {
    expect(fechaNumber('Cronograma de actividades: undécima fecha')).toBe(11);
    expect(fechaNumber('cronograma de actividades decima fecha')).toBe(10);
    expect(fechaNumber('10° FECHA - CAMPEONATO 2026')).toBe(10);
    expect(fechaNumber('Entradas para el GP Coronación')).toBeNull();
  });

  it('nombra la actividad como figura, sin vuelta previa ni vueltas y sin mayúsculas sostenidas', () => {
    expect(activityName('Vuelta Previa y Final– 15 vueltas o 35 minutos')).toEqual({ name: 'Final' });
    expect(activityName('ENTRENAMIENTO II – GRUPO A')).toEqual({ name: 'Entrenamiento II', group: 'A' });
    expect(activityName('CLASIFICACIÓN - 1a TANDA')).toEqual({ name: 'Clasificación - 1a tanda' });
    expect(activityName('2a SERIE- 5 vtas')).toEqual({ name: '2a serie' });
  });
});

describe('Turismo Nacional (APAT): cronograma sin IA', () => {
  const tn = genericSeries('tn', 'Turismo Nacional (Clase 2 y 3)', ['https://apat.org.ar/carreras', 'https://apat.org.ar/campeonato/ranking/c2'], {
    shortName: 'TN',
    group: 'argentina',
  });

  it('lee la tabla de la página de la fecha (San Martín, 10° fecha)', async () => {
    const http = fakeHttp({
      'https://apat.org.ar/carreras': fixture('apat-carreras.html'),
      'https://apat.org.ar/carreras/info/2026-10-11': fixture('apat-info-2026-10-11.html'),
    });
    const gemini = fakeGemini();
    const chunk = await createGenericAdapter({ gemini: () => gemini }).schedule(tn, testContext(http, '2026-10-06T12:00:00Z'));
    const event = chunk.events.find((e) => e.dateEnd === '2026-10-11')!;
    expect(event.sessionsStatus).toBe('published');
    const sessions = chunk.sessions.filter((s) => s.eventId === event.id);
    expect(sessions).toHaveLength(14);
    expect(sessions.slice(0, 2).map((s) => [s.name, s.type, s.localStartText, s.startUtc, s.endUtc])).toEqual([
      ['1er entrenamiento (Clase 2)', 'practica', '08.40', '2026-10-10T11:40:00Z', '2026-10-10T12:45:00Z'],
      ['1er entrenamiento (Clase 3)', 'practica', '09.50', '2026-10-10T12:50:00Z', '2026-10-10T13:55:00Z'],
    ]);
    expect(sessions.map((s) => s.name)).toContain('Clasificación - 1a tanda (Clase 2)');
    expect(sessions.slice(-2).map((s) => [s.name, s.type, s.startUtc])).toEqual([
      ['Final (Clase 2)', 'carrera', '2026-10-11T15:45:00Z'],
      ['Final (Clase 3)', 'carrera', '2026-10-11T17:00:00Z'],
    ]);
    expect(sessions.find((s) => s.name === '1a serie (Clase 2)')!.type).toBe('serie');
    expect(sessions[0]!.source).toMatchObject({ url: 'https://apat.org.ar/carreras/info/2026-10-11', kind: 'html', method: 'directo' });
    expect(gemini.requests).toHaveLength(0);
  });

  it('si la página no lo tiene, lo lee del PDF de la nota "Cronograma de actividades: undécima fecha"', async () => {
    const post = 'https://apat.org.ar/noticias/detalle/cronograma-de-actividades-undecima-fecha';
    const http = fakeHttp({
      'https://apat.org.ar/carreras': fixture('apat-carreras.html'),
      // La página de Concordia dice "El cronograma de esta fecha aún no está disponible", como la de Viedma.
      'https://apat.org.ar/carreras/info/2026-11-01': fixture('apat-info-2026-11-29.html'),
      'https://apat.org.ar/noticias': fixture('apat-noticias-2026-10-28.html'),
      [post]: fixture('apat-noticia-cronograma-undecima-fecha.html'),
      'https://apat.org.ar/documentos/descargar/1612': pdf('apat-cronograma-concordia-2026.txt'),
    });
    const gemini = fakeGemini();
    const chunk = await createGenericAdapter({ gemini: () => gemini }).schedule(tn, testContext(http, '2026-10-28T12:00:00Z'));
    const event = chunk.events.find((e) => e.dateEnd === '2026-11-01')!;
    expect(event.sessionsStatus).toBe('published');
    const sessions = chunk.sessions.filter((s) => s.eventId === event.id);
    // 8 entrenamientos, 9 clasificaciones (tandas por grupo), 6 series y 2 finales; nada de Turismo Internacional.
    expect(sessions).toHaveLength(25);
    expect(sessions.map((s) => s.name).filter((n) => /internacional|salida|podio|verificaci/i.test(n))).toEqual([]);
    expect(sessions[0]).toMatchObject({ name: '1° entrenamiento (Clase 2, grupo A)', type: 'practica', localStartText: '08.40', startUtc: '2026-10-31T11:40:00Z' });
    // El PDF encabeza el domingo como "Domingo 11-10": cae igual el 1° de noviembre.
    expect(sessions.slice(-2).map((s) => [s.name, s.type, s.startUtc])).toEqual([
      ['Final (Clase 2)', 'carrera', '2026-11-01T16:10:00Z'],
      ['Final (Clase 3)', 'carrera', '2026-11-01T17:10:00Z'],
    ]);
    expect(sessions[0]!.source).toMatchObject({ url: 'https://apat.org.ar/documentos/descargar/1612', kind: 'pdf', method: 'directo' });
    // Solo se abrió la nota del cronograma, no las demás noticias.
    expect(http.requested.filter((u) => u.includes('/noticias/detalle/'))).toEqual([post]);
    expect(gemini.requests).toHaveLength(0);
  });

  it('sin cronograma publicado (Viedma, la semana anterior) queda pendiente sin IA ni otras páginas', async () => {
    const http = fakeHttp({
      'https://apat.org.ar/carreras': fixture('apat-carreras.html'),
      'https://apat.org.ar/carreras/info/2026-11-29': fixture('apat-info-2026-11-29.html'),
      'https://apat.org.ar/noticias': fixture('apat-noticias-2026-11-12.html'),
    });
    const gemini = fakeGemini();
    const chunk = await createGenericAdapter({ gemini: () => gemini }).schedule(tn, testContext(http, '2026-11-12T12:00:00Z'));
    const event = chunk.events.find((e) => e.dateEnd === '2026-11-29')!;
    expect(event.sessionsStatus).toBe('pending');
    expect(chunk.sessions).toHaveLength(0);
    expect(gemini.requests).toHaveLength(0);
    expect(http.requested).toEqual([
      'https://apat.org.ar/carreras',
      'https://apat.org.ar/carreras/info/2026-11-29',
      'https://apat.org.ar/noticias',
      'https://apat.org.ar/noticias?page=2',
    ]);
  });
});

describe('TC2000: cronograma publicado como imagen', () => {
  const tc2000 = genericSeries('tc2000', 'TC2000', ['https://tc2000.com.ar/carreras.php?evento=calendario'], { group: 'argentina' });
  const IMAGE = 'https://www.tc2000.com.ar/images/noticias/2009/noticias-56564-2-2026-10-22.jpg';
  // Parte de la transcripción de la imagen oficial de General Roca (filas de TC2000).
  const transcription = [
    'CRONOGRAMA ACTIVIDADES',
    'INICIO | FINAL | TIEMPO | CATEGORÍA | SÁBADO 31.10.2026',
    '8:30 | 8:40 | 10 m. | TC2000 | Shakedown (todos juntos)',
    '10:35 | 10:55 | 20 m. | TC2000 | Práctica oficial 1 (grupo libre eleccion)',
    '15:40 | 16:15 | 35 m. | TC2000 | Clasificación 1 vuelta lanzada',
    'INICIO | FINAL | TIEMPO | CATEGORÍA | DOMINGO 01.11.2026',
    '9:45 | 9:55 | 10 m. | TC2000 | Warm -up',
    '13:05 | 13:45 | 40 m. | TC2000 | Carrera final - 35 minutos + 1 vuelta',
  ].join('\n');

  it('ubica la imagen de la página de cronograma de la fecha y la transcribe la IA', async () => {
    const http = fakeHttp({
      'https://tc2000.com.ar/carreras.php?evento=calendario': fixture('tc2000-calendario.html'),
      'https://tc2000.com.ar/carreras.php?accion=cronograma&id=421': fixture('tc2000-cronograma-421.html'),
      [IMAGE]: { body: new Uint8Array([255, 216, 255, 1]), contentType: 'image/jpeg' },
    });
    const gemini = fakeGemini({
      imagen: () => ({ images: [{ text: transcription }] }),
      cronograma: () => ({
        sessions: [
          { name: 'Shakedown', date: '2026-10-31', localStartText: '8:30', localEndText: '8:40' },
          { name: 'Clasificación 1 vuelta lanzada', date: '2026-10-31', localStartText: '15:40', localEndText: '16:15' },
          { name: 'Carrera final', date: '2026-11-01', localStartText: '13:05', localEndText: '13:45' },
        ],
      }),
    });
    const chunk = await createGenericAdapter({ gemini: () => gemini }).schedule(tc2000, testContext(http, '2026-10-25T12:00:00Z'));
    const event = chunk.events.find((e) => e.round === 10)!;
    expect(event.sessionsStatus).toBe('published');
    expect(chunk.sessions.map((s) => [s.name, s.type, s.startUtc])).toEqual([
      ['Shakedown', 'otro', '2026-10-31T11:30:00Z'],
      ['Clasificación 1 vuelta lanzada', 'clasificacion', '2026-10-31T18:40:00Z'],
      ['Carrera final', 'carrera', '2026-11-01T16:05:00Z'],
    ]);
    expect(chunk.sessions[0]!.source).toMatchObject({ url: IMAGE, kind: 'image', method: 'ia' });
    expect(gemini.requests.map((r) => r.label)).toEqual(['imagen tc2000', 'cronograma tc2000']);
  });

  it('"No hay datos sobre cronograma por el momento": pendiente, sin IA ni descargas de imágenes', async () => {
    const http = fakeHttp({
      'https://tc2000.com.ar/carreras.php?evento=calendario': fixture('tc2000-calendario.html'),
      'https://tc2000.com.ar/carreras.php?accion=cronograma&id=422': fixture('tc2000-cronograma-422.html'),
    });
    const gemini = fakeGemini();
    const chunk = await createGenericAdapter({ gemini: () => gemini }).schedule(tc2000, testContext(http, '2026-11-12T12:00:00Z'));
    expect(chunk.events.find((e) => e.round === 11)!.sessionsStatus).toBe('pending');
    expect(gemini.requests).toHaveLength(0);
    expect(http.requested).toEqual([
      'https://tc2000.com.ar/carreras.php?evento=calendario',
      'https://tc2000.com.ar/carreras.php?accion=cronograma&id=422',
    ]);
  });
});

describe('Turismo Pista (APTP): PDF del cronograma en la biblioteca de medios', () => {
  const tp = genericSeries('turismo-pista', 'Turismo Pista (Clases 1, 2 y 3)', ['https://aptpweb.com.ar/calendario-2026/', 'https://aptpweb.com.ar/noticias/'], {
    shortName: 'Turismo Pista',
    group: 'argentina',
  });
  const recipe = findRecipe(tp.officialUrls[0]!)!;
  const media = (after: string) =>
    `https://aptpweb.com.ar/wp-json/wp/v2/media?search=crono&after=${after}T00:00:00&per_page=20&orderby=date&order=desc&_fields=date,source_url,mime_type`;
  const PDF = 'https://aptpweb.com.ar/wp-content/uploads/2026/10/cronograma_fecha_9_TP_-1.pdf';
  const entry = (round: number, dateStart: string, dateEnd: string): CalendarEntry => ({
    name: `Fecha ${round}`,
    circuit: '',
    country: 'Argentina',
    tz: TZ,
    dateStart,
    dateEnd,
    round,
  });

  it('lee las tres clases del PDF y descarta TC 2000 y las actividades administrativas', async () => {
    const http = fakeHttp({ [media('2026-09-25')]: fixture('aptp-media-crono-fecha-9.json'), [PDF]: pdf('aptp-cronograma-fecha-9-2026.txt') });
    const ctx = { season: 2026, series: tp, http, now: new Date('2026-10-14T20:00:00Z') };
    const found = (await recipe.sessions!(entry(9, '2026-10-16', '2026-10-18'), ctx))!;
    expect(found.source).toMatchObject({ url: PDF, kind: 'pdf', method: 'directo' });
    expect(found.sessions).toHaveLength(42);
    expect(found.sessions[0]).toEqual({
      name: 'Entrenamiento I (Clase 1, grupo A)',
      startUtc: '2026-10-16T11:30:00Z',
      endUtc: '2026-10-16T12:00:00Z',
      localStartText: '08:30',
    });
    expect(found.sessions.map((s) => s.name).filter((n) => /boxes|reuni|sorteo|verificaci|todos/i.test(n))).toEqual([]);
    expect(found.sessions.slice(-3).map((s) => [s.name, s.startUtc])).toEqual([
      ['Final (Clase 1)', '2026-10-18T14:50:00Z'],
      ['Final (Clase 2)', '2026-10-18T15:25:00Z'],
      ['Final (Clase 3)', '2026-10-18T16:38:00Z'],
    ]);
  });

  it('sin archivo de cronograma subido (Rafaela, todavía no): null, y no hay imagen para la IA', async () => {
    const http = fakeHttp({ [media('2026-10-30')]: '[]' });
    const ctx = { season: 2026, series: tp, http, now: new Date('2026-11-12T12:00:00Z') };
    const rafaela = entry(10, '2026-11-20', '2026-11-22');
    expect(await recipe.sessions!(rafaela, ctx)).toBeNull();
    expect(await recipe.timetableImages!(rafaela, ctx)).toBeNull();
  });

  it('el cronograma de otra fecha (nombre con otro número) no se toma', async () => {
    const http = fakeHttp({ [media('2026-09-25')]: fixture('aptp-media-crono-fecha-9.json'), [PDF]: pdf('aptp-cronograma-fecha-9-2026.txt') });
    const ctx = { season: 2026, series: tp, http, now: new Date('2026-10-14T20:00:00Z') };
    expect(await recipe.sessions!(entry(10, '2026-10-16', '2026-10-18'), ctx)).toBeNull();
    expect(http.requested).not.toContain(PDF);
  });
});

describe('ACTC: cronograma de la API', () => {
  it('reconoce un cronograma publicado sin evento del calendario asociado por sus días', async () => {
    const api = JSON.parse(fixture('actc-schedules.json')) as { data: Record<string, unknown>[] };
    for (const s of api.data) s.calendarEvent = null;
    const http = fakeHttp({
      'https://actc.org.ar/tcp/calendario': fixture('actc-calendario.html'),
      'https://actc.org.ar/api/schedules': JSON.stringify(api),
    });
    const series = genericSeries('tc-pista', 'TC Pista', ['https://actc.org.ar/tcp/calendario'], { shortName: 'TC Pista' });
    const chunk = await createGenericAdapter({ gemini: () => fakeGemini() }).schedule(series, testContext(http, '2026-11-10T12:00:00Z'));
    expect(chunk.events.map((e) => e.sessionsStatus)).toEqual(['published', 'pending']);
    expect(chunk.sessions).toHaveLength(5);
  });
});
