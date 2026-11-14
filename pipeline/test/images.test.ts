import { describe, expect, it } from 'vitest';
import { buildIcs } from '@dm/shared';
import { createHttp } from '../src/core/http.ts';
import { createGemini, type GeminiSchema } from '../src/extract/gemini.ts';
import { contentImages } from '../src/extract/html.ts';
import { createGenericAdapter } from '../src/generic/index.ts';
import { fakeGemini, fakeHttp, fixture, genericSeries, testContext } from './fakes.ts';

const NOW = '2026-11-10T12:00:00Z';
const PNG = { body: new Uint8Array([137, 80, 78, 71, 1]), contentType: 'image/png' };
const JPG = { body: new Uint8Array([255, 216, 255, 2]), contentType: 'image/jpeg' };

describe('sitios que bloquean al cliente', () => {
  it('un 403 se informa tal cual, sin reintentar por otro camino; otros errores tampoco', async () => {
    const asked: string[] = [];
    const http = createHttp({
      retries: 0,
      fetchImpl: async (url) => {
        asked.push(String(url));
        return new Response('no', { status: 403 });
      },
    });
    await expect(http.text('https://tc2000.com.ar/carreras.php?evento=calendario')).rejects.toThrow(
      'HTTP 403 en https://tc2000.com.ar/carreras.php?evento=calendario',
    );
    await expect(http.bytes('https://www.tc2000.com.ar/images/crono.jpg')).rejects.toThrow('HTTP 403');
    expect(asked).toEqual(['https://tc2000.com.ar/carreras.php?evento=calendario', 'https://www.tc2000.com.ar/images/crono.jpg']);
    let calls = 0;
    const http404 = createHttp({
      retries: 0,
      fetchImpl: async () => {
        calls++;
        return new Response('no', { status: 404 });
      },
    });
    await expect(http404.text('https://x.example.com/')).rejects.toThrow('HTTP 404');
    expect(calls).toBe(1);
  });
});

describe('imágenes de contenido', () => {
  it('toma imágenes del contenido y descarta logos, miniaturas, publicidad y navegación', () => {
    const html = `
      <header><img src="/hero-cronograma.jpg"></header>
      <nav><img src="/menu.png"></nav>
      <main>
        <img width="330" height="400" src="/uploads/fecha_10.png">
        <img src="/uploads/logo_tp.png">
        <img width="100" height="100" src="/uploads/piloto-100x100.jpg">
        <img width="1000" height="90" src="/uploads/publicidades.jpg">
        <img src="data:image/png;base64,AAA" data-src="/uploads/crono.jpg">
        <img src="/uploads/anim.gif">
        <img src="/uploads/fecha_10.png">
      </main>
      <footer><img src="/sponsors.png"></footer>`;
    expect(contentImages(html, 'https://tp.example.org/calendario/')).toEqual([
      'https://tp.example.org/uploads/fecha_10.png',
      'https://tp.example.org/uploads/crono.jpg',
    ]);
  });

  it('Gemini recibe las imágenes inline y en alta resolución', async () => {
    const schema: GeminiSchema = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } } };
    let body: Record<string, any> = {};
    const g = createGemini({
      env: { GEMINI_API_KEY: 'k', GEMINI_DELAY_MS: '0' },
      sleep: async () => {},
      fetchImpl: async (_url, init) => {
        body = JSON.parse(String(init!.body));
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] }), { status: 200 });
      },
    });
    await g.generateJson({ prompt: 'Transcribí', schema, images: [{ mimeType: 'image/png', data: new Uint8Array([1, 2, 3]) }] });
    expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: 'image/png', data: 'AQID' } });
    expect(body.generationConfig.mediaResolution).toBe('MEDIA_RESOLUTION_HIGH');
  });
});

describe('flujo genérico con imágenes oficiales', () => {
  it('calendario publicado como imágenes: se transcriben y los eventos quedan marcados como leídos de imagen', async () => {
    const url = 'https://tp.example.org/calendario-2026/';
    const page = `<html><head><title>Calendario / 2026 - Turismo Pista</title></head><body><main>
      <h1>Calendario / 2026</h1><p>Noticias de la categoría</p>
      <img width="330" height="400" src="/uploads/fecha_9.png"><img width="330" height="400" src="/uploads/fecha_10.png">
      </main></body></html>`;
    const http = fakeHttp({
      [url]: page,
      'https://tp.example.org/uploads/fecha_9.png': PNG,
      'https://tp.example.org/uploads/fecha_10.png': PNG,
    });
    const gemini = fakeGemini({
      imagen: (req) => {
        expect(req.images).toHaveLength(2);
        return {
          images: [
            { text: 'FECHA 9\nOCTUBRE 16, 17 y 18\nConcepción del Uruguay\nEntre Ríos' },
            { text: 'FECHA 10\nNOVIEMBRE 20, 21 y 22\nRafaela\nSanta Fe' },
          ],
        };
      },
      // Sobre el texto de la página no hay fechas; sobre la transcripción de las imágenes, sí.
      calendario: (req) =>
        req.text!.includes('=== Imagen')
          ? {
              events: [
                { name: 'Fecha 9', circuit: 'Concepción del Uruguay', country: 'Argentina', dateStart: '2026-10-16', dateEnd: '2026-10-18', round: 9 },
                { name: 'Fecha 10', circuit: 'Rafaela', country: 'Argentina', dateStart: '2026-11-20', dateEnd: '2026-11-22', round: 10 },
                { name: 'Fecha 11', circuit: 'Autódromo Inventado', country: 'Argentina', dateStart: '2026-12-04', dateEnd: '2026-12-06', round: 11 },
              ],
            }
          : { events: [] },
    });
    const series = genericSeries('turismo-pista', 'Turismo Pista', [url], { shortName: 'Turismo Pista' });
    const ctx = testContext(http, NOW);
    const chunk = await createGenericAdapter({ gemini: () => gemini }).schedule(series, ctx);

    expect(chunk.events.map((e) => [e.round, e.dateStart, e.source.kind, e.source.method])).toEqual([
      [9, '2026-10-16', 'image', 'ia'],
      [10, '2026-11-20', 'image', 'ia'],
    ]);
    expect(chunk.events[0]!.source.url).toBe(url);
    // La transcripción incluye el título de la página (de ahí sale el año).
    const calendarFromImages = gemini.requests.find((r) => r.label?.startsWith('calendario') && r.text?.includes('=== Imagen'));
    expect(calendarFromImages?.text).toContain('Calendario / 2026');

    // Segunda corrida con las mismas imágenes: todo sale de la caché, sin llamar a Gemini.
    const calls = gemini.requests.length;
    await createGenericAdapter({ gemini: () => gemini }).schedule(series, testContext(http, NOW, ctx.cacheDir));
    expect(gemini.requests.length).toBe(calls);
  });

  it('cronograma publicado como imagen: horas validadas contra la transcripción y sesiones marcadas como leídas de imagen', async () => {
    const url = 'https://zonal.example.org/calendario';
    const eventPage = 'https://zonal.example.org/fechas/rafaela';
    const cronoPage = 'https://zonal.example.org/carreras.php?accion=cronograma&id=421';
    const image = 'https://zonal.example.org/images/noticias/crono-421.jpg';
    const http = fakeHttp({
      [url]: fixture('calendar-plain.html'),
      [eventPage]: '<html><body><main><h1>Rafaela</h1><a href="/carreras.php?accion=cronograma&id=421">Cronograma</a></main></body></html>',
      [cronoPage]: `<html><body><main><h2>CRONOGRAMA 2026</h2><img alt="" src="${image}"></main></body></html>`,
      [image]: JPG,
    });
    const gemini = fakeGemini({
      calendario: () => ({
        events: [
          { name: 'Fecha 11', circuit: 'Autódromo Ciudad de Rafaela', city: 'Rafaela', country: 'Argentina', timeZone: 'America/Argentina/Cordoba', dateStart: '2026-11-21', dateEnd: '2026-11-22', round: 11, url: eventPage },
        ],
      }),
      imagen: () => ({
        images: [
          {
            text:
              'CRONOGRAMA ACTIVIDADES\nSÁBADO 21.11.2026\nINICIO | FINAL | CATEGORÍA | ACTIVIDAD\n' +
              '10:35 | 10:55 | ZONAL | Práctica oficial 1\n15:40 | 16:15 | ZONAL | Clasificación 1 vuelta lanzada\n' +
              'DOMINGO 22.11.2026\n13:05 | 13:45 | ZONAL | Carrera final - 35 minutos + 1 vuelta',
          },
        ],
      }),
      cronograma: (req) => {
        // La extracción trabaja sobre la transcripción, no sobre la imagen.
        expect(req.images).toBeUndefined();
        expect(req.text).toContain('15:40 | 16:15');
        return {
          sessions: [
            { name: 'Práctica oficial 1', date: '2026-11-21', localStartText: '10:35', localEndText: '10:55' },
            { name: 'Clasificación 1 vuelta lanzada', date: '2026-11-21', localStartText: '15:40', localEndText: '16:15' },
            { name: 'Carrera final', date: '2026-11-22', localStartText: '13:05', localEndText: '13:45' },
            { name: 'Warm up', date: '2026-11-22', localStartText: '9:45' }, // no figura en la imagen
          ],
        };
      },
    });
    const series = genericSeries('zonal', 'Campeonato Zonal', [url], { shortName: 'Zonal' });
    const chunk = await createGenericAdapter({ gemini: () => gemini }).schedule(series, testContext(http, NOW));

    expect(chunk.sessions.map((s) => [s.name, s.startUtc, s.endUtc, s.endEstimated])).toEqual([
      ['Práctica oficial 1', '2026-11-21T13:35:00Z', '2026-11-21T13:55:00Z', false],
      ['Clasificación 1 vuelta lanzada', '2026-11-21T18:40:00Z', '2026-11-21T19:15:00Z', false],
      ['Carrera final', '2026-11-22T16:05:00Z', '2026-11-22T16:45:00Z', false],
    ]);
    const source = chunk.sessions[0]!.source;
    expect(source).toMatchObject({ url: image, kind: 'image', method: 'ia' });
    expect(source.title).toBe('Cronograma Zonal — Fecha 11 (imagen oficial)');
    expect(http.requested).toContain(image);
  });

  it('el .ics aclara que el horario se leyó de una imagen', () => {
    const ics = buildIcs([
      { id: 'a', startUtc: '2026-11-22T16:05:00Z', endUtc: '2026-11-22T16:45:00Z', seriesName: 'TC2000', circuit: 'Olavarría', sessionName: 'Final', country: 'Argentina', broadcast: [], sourceUrl: 'https://x.org/c.jpg', fromImage: true },
    ]);
    expect(ics.replace(/\r\n /g, '')).toContain('Fuente: https://x.org/c.jpg (leído de imagen)');
  });
});

describe('calendario en imágenes: lectura determinista de la transcripción', () => {
  // Transcripción real que devolvió Gemini para https://aptpweb.com.ar/calendario-2026/ (10/11/2026).
  const OCR = [
    'FECHA 1\n30, 31 de ENERO y FEBRERO 01\nRoberto Mouras\nLa Plata\nTurismo Pista',
    'FECHA 2\n27, 28 de FEBRERO y MARZO 01\nToay\nLa Pampa\nTurismo Pista',
    'FECHA 7\nAGOSTO 07, 08 y 09\n#TP300Pilotos\nSan Nicolás\nBuenos Aires\nTurismo Pista',
    'FECHA 10\nNOVIEMBRE 20, 21 y 22\nRafaela\nSanta Fe\nTurismo Pista',
    'APTP\nAsociación Pilotos Turismo Pista\nTurismo Pista',
  ];
  const doc = {
    url: 'https://aptpweb.com.ar/calendario-2026/',
    kind: 'image' as const,
    raw: '',
    title: 'Calendario / 2026 - Turismo Pista | APTP (imagen)',
    hash: 'h',
    text: ['Calendario / 2026', ...OCR.map((t, i) => `=== Imagen ${i + 1} ===\n${t}`)].join('\n\n'),
  };

  it('arma cada fecha con número, días (incluso entre dos meses) y lugar', async () => {
    const { imageCalendarEntries } = await import('../src/generic/locate.ts');
    const entries = imageCalendarEntries(doc, 2026, {
      country: 'Argentina',
      defaultTz: 'America/Argentina/Buenos_Aires',
      seriesNames: ['Turismo Pista (Clases 1, 2 y 3)', 'Turismo Pista'],
    });
    expect(entries.map((e) => [e.round, e.name, e.dateStart, e.dateEnd])).toEqual([
      [1, 'Fecha 1 Roberto Mouras', '2026-01-30', '2026-02-01'],
      [2, 'Fecha 2 Toay', '2026-02-27', '2026-03-01'],
      [7, 'Fecha 7 San Nicolás', '2026-08-07', '2026-08-09'],
      [10, 'Fecha 10 Rafaela', '2026-11-20', '2026-11-22'],
    ]);
    expect(entries.every((e) => e.tz.startsWith('America/Argentina/'))).toBe(true);
  });

  it('en el flujo, una categoría argentina no necesita el segundo pedido a Gemini', async () => {
    const url = 'https://tp.example.org/calendario-2026/';
    const page = `<html><head><title>Calendario / 2026</title></head><body><main><p>Noticias de la categoría y más texto de relleno para la página.</p>
      ${OCR.map((_, i) => `<img width="330" height="400" src="/u/fecha_${i + 1}.png">`).join('')}</main></body></html>`;
    const routes: Record<string, string | typeof PNG> = { [url]: page };
    OCR.forEach((_, i) => (routes[`https://tp.example.org/u/fecha_${i + 1}.png`] = PNG));
    const gemini = fakeGemini({
      calendario: () => ({ events: [] }),
      imagen: () => ({ images: OCR.map((text) => ({ text })) }),
    });
    const series = genericSeries('turismo-pista', 'Turismo Pista (Clases 1, 2 y 3)', [url], { shortName: 'Turismo Pista', group: 'argentina' });
    const chunk = await createGenericAdapter({ gemini: () => gemini }).schedule(series, testContext(fakeHttp(routes), NOW));
    expect(chunk.events.map((e) => [e.round, e.source.kind])).toEqual([
      [1, 'image'],
      [2, 'image'],
      [7, 'image'],
      [10, 'image'],
    ]);
    // Un pedido por el texto de la página y uno para transcribir las imágenes; ninguno más.
    expect(gemini.requests.map((r) => r.label)).toEqual(['calendario turismo-pista', 'imagen turismo-pista']);
  });
});
