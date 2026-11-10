import { describe, expect, it } from 'vitest';
import { standingsFileSchema, type Series, type Session } from '@dm/shared';
import { standingsStale } from '../src/core/results.ts';
import { cleanStandingsTable } from '../src/generic/ai.ts';
import { createGenericAdapter } from '../src/generic/index.ts';
import { findRecipe, parseNumber } from '../src/generic/recipes.ts';
import { fakeGemini, fakeHttp, fixture, genericSeries, testContext } from './fakes.ts';

const NOW = '2026-11-10T12:00:00Z';

/** Pide solo el campeonato (sin sesiones pendientes) con un Gemini sin clave: todo tiene que salir sin IA. */
async function readStandings(series: Series, http: ReturnType<typeof fakeHttp>, now = NOW, gemini = fakeGemini({}, { available: false })) {
  const out = await createGenericAdapter({ gemini: () => gemini }).results!(series, testContext(http, now), {
    events: [],
    pendingSessions: [],
    sessions: [],
    standingsStale: true,
  });
  return out.standings ? standingsFileSchema.parse(out.standings) : undefined;
}

describe('campeonatos nacionales por lectura directa (sin Gemini)', () => {
  it('ACTC: lee la tabla del payload de Next.js, ordenada y sin los "$undefined"', async () => {
    const tc = genericSeries('tc', 'Turismo Carretera', ['https://actc.org.ar/tc/calendario', 'https://actc.org.ar/tc/campeonato']);
    const file = await readStandings(tc, fakeHttp({ 'https://actc.org.ar/tc/campeonato': fixture('actc-campeonato.html') }));
    expect(file).toBeDefined();
    expect(file!.season).toBe(2026);
    expect(file!.tables).toHaveLength(1);
    const t = file!.tables[0]!;
    expect(t.title).toBe('Pilotos');
    expect(t.rows.map((r) => [r.pos, r.name, r.number, r.points])).toEqual([
      [1, 'Agustín CANAPINO', '1', 347],
      [2, 'Otto FRITZLER', '256', 339],
      [3, 'Jonatan CASTELLANO', '101', 333],
      [4, 'Mariano WERNER', '11', 330],
    ]);
    expect(t.rows[0]).not.toHaveProperty('wins');
    expect(t.rows[0]).not.toHaveProperty('team');
    expect(file!.source).toMatchObject({ url: 'https://actc.org.ar/tc/campeonato', method: 'directo', kind: 'html' });
  });

  it('ACTC: la URL de cualquier categoría lleva a su página de campeonato', async () => {
    const http = fakeHttp({ 'https://actc.org.ar/tcpk/campeonato': fixture('actc-campeonato.html') });
    const found = await findRecipe('https://actc.org.ar/tcpk/campeonato')!.standings!('https://actc.org.ar/tcpk/campeonato', {
      season: 2026,
      series: genericSeries('tc-pickup', 'TC Pick Up', []),
      http,
      now: new Date(NOW),
    });
    expect(http.requested).toEqual(['https://actc.org.ar/tcpk/campeonato']);
    expect(found!.tables[0]!.rows).toHaveLength(4);
  });

  it('ACTC: si la tabla publicada es de otra temporada no escribe nada ni llama a Gemini', async () => {
    const tc = genericSeries('tc', 'Turismo Carretera', ['https://actc.org.ar/tc/calendario', 'https://actc.org.ar/tc/campeonato']);
    const gemini = fakeGemini({});
    const file = await readStandings(
      tc,
      fakeHttp({ 'https://actc.org.ar/tc/campeonato': fixture('actc-campeonato.html') }),
      '2027-01-10T12:00:00Z',
      gemini,
    );
    expect(file).toBeUndefined();
    expect(gemini.requests).toHaveLength(0);
  });

  it('APAT: una tabla por clase (Clase 2 y Clase 3) con número y equipo', async () => {
    const tn = genericSeries('tn', 'Turismo Nacional', ['https://apat.org.ar/carreras', 'https://apat.org.ar/campeonato/ranking/c2']);
    const http = fakeHttp({
      'https://apat.org.ar/campeonato/ranking/c2': fixture('apat-ranking-c2.html'),
      'https://apat.org.ar/campeonato/ranking/c3': fixture('apat-ranking-c3.html'),
    });
    const file = await readStandings(tn, http);
    expect(file!.tables.map((t) => t.title)).toEqual(['Clase 2', 'Clase 3']);
    const [c2, c3] = file!.tables;
    expect(c2!.rows).toHaveLength(5);
    expect(c2!.rows[0]).toEqual({ pos: 1, name: 'Vitar, Tomas', number: '177', team: 'GR Competicion', points: 316 });
    expect(c2!.rows.map((r) => r.pos)).toEqual([1, 2, 3, 4, 5]);
    expect(c3!.rows[0]).toEqual({ pos: 1, name: 'Canapino, Agustin', number: '86', team: 'Salvita Racing', points: 320 });
    expect(file!.source).toMatchObject({ url: 'https://apat.org.ar/campeonato/ranking/c2', method: 'directo' });
  });

  it('APAT: la URL vieja de "posiciones" (otro ranking) se cambia por la del campeonato', async () => {
    const http = fakeHttp({
      'https://apat.org.ar/campeonato/ranking/c2': fixture('apat-ranking-c2.html'),
      'https://apat.org.ar/campeonato/ranking/c3': fixture('apat-ranking-c3.html'),
    });
    const tn = genericSeries('tn', 'Turismo Nacional', ['https://apat.org.ar/carreras', 'https://apat.org.ar/campeonato/posiciones/c2']);
    const file = await readStandings(tn, http);
    expect(file!.tables).toHaveLength(2);
    expect(http.requested).not.toContain('https://apat.org.ar/campeonato/posiciones/c2');
  });

  it('TC2000: pilotos, equipos y marcas (también con los links reescritos por el proxy de Google)', async () => {
    const url = 'https://tc2000.com.ar/estadisticas.php?accion=posiciones';
    const tc2000 = genericSeries('tc2000', 'TC2000', ['https://tc2000.com.ar/carreras.php?evento=calendario', url]);
    for (const html of [
      fixture('tc2000-posiciones.html'),
      fixture('tc2000-posiciones.html').replace(/href="#tabs-/g, 'href="https://tc2000.com.ar/estadisticas.php#tabs-'),
    ]) {
      const file = await readStandings(tc2000, fakeHttp({ [url]: html }));
      expect(file!.tables.map((t) => [t.title, t.rows.length])).toEqual([
        ['Pilotos', 3],
        ['Equipos', 3],
        ['Marcas', 3],
      ]);
      expect(file!.tables[0]!.rows).toEqual([
        { pos: 1, name: 'Matias Rossi', points: 180 },
        { pos: 2, name: 'Franco Vivian', points: 149 },
        { pos: 3, name: 'Emiliano Stang', points: 138 },
      ]);
      expect(file!.tables[1]!.rows[0]).toEqual({ pos: 1, name: 'TOYOTA GAZOO Racing YPF Infinia', points: 318 });
      expect(file!.tables[2]!.rows[0]).toEqual({ pos: 1, name: 'Toyota', points: 225 });
    }
  });

  it('APTP: las tres clases de Turismo Pista, con puntos decimales y victorias', async () => {
    const tp = genericSeries('turismo-pista', 'Turismo Pista', [
      'https://aptpweb.com.ar/calendario-2026/',
      'https://aptpweb.com.ar/noticias/',
      'https://aptpweb.com.ar/campeonato-clase-1-2026/',
    ]);
    const http = fakeHttp(
      Object.fromEntries(
        ['1', '2', '3'].map((n) => [`https://aptpweb.com.ar/campeonato-clase-${n}-2026/`, fixture(`aptp-campeonato-clase-${n}-2026.html`)]),
      ),
    );
    const file = await readStandings(tp, http);
    expect(file!.tables.map((t) => t.title)).toEqual(['Clase 1', 'Clase 2', 'Clase 3']);
    expect(file!.tables[0]!.rows).toEqual([
      { pos: 1, name: 'CORTINA, JOAQUIN', number: '3', points: 258.5, wins: 4 },
      { pos: 2, name: 'RODRIGUEZ, LUCIO', number: '5', points: 255, wins: 1 },
      { pos: 3, name: 'BAYALA, LUCAS', number: '17', points: 206, wins: 0 },
      { pos: 4, name: 'BULL, ALEXIS', number: '13', points: 187.5, wins: 1 },
    ]);
    expect(file!.tables[2]!.rows[0]).toMatchObject({ name: 'HERMIDA ALONSO, FEDERICO', points: 247 });
    expect(file!.source.url).toBe('https://aptpweb.com.ar/campeonato-clase-1-2026/');
  });

  it('APTP: busca la página de la temporada en curso y, si todavía no existe, no escribe nada', async () => {
    const tp = genericSeries('turismo-pista', 'Turismo Pista', ['https://aptpweb.com.ar/calendario-2026/', 'https://aptpweb.com.ar/campeonato-clase-1-2026/']);
    const http = fakeHttp({ 'https://aptpweb.com.ar/campeonato-clase-1-2026/': fixture('aptp-campeonato-clase-1-2026.html') });
    const gemini = fakeGemini({});
    expect(await readStandings(tp, http, '2027-02-01T12:00:00Z', gemini)).toBeUndefined();
    expect(http.requested).toEqual(['https://aptpweb.com.ar/campeonato-clase-1-2027/']);
    expect(gemini.requests).toHaveLength(0);
  });

  it('si la página no tiene el formato esperado, prueba con Gemini y limpia los null que devuelve', async () => {
    const url = 'https://actc.org.ar/tc/campeonato';
    const tc = genericSeries('tc', 'Turismo Carretera', ['https://actc.org.ar/tc/calendario', url]);
    const page = '<html><body><table><tr><td>1</td><td>CANAPINO, AGUSTÍN</td><td>347</td></tr><tr><td>2</td><td>FRITZLER, OTTO</td><td>339</td></tr></table></body></html>';
    const gemini = fakeGemini({
      campeonato: () => ({
        tables: [
          {
            title: 'Pilotos',
            rows: [
              { pos: 1, name: 'CANAPINO, AGUSTÍN', points: 347, number: '1', wins: 1 },
              { pos: 2, name: 'FRITZLER, OTTO', points: 339, number: null, wins: null, team: null },
            ],
          },
        ],
      }),
    });
    const file = await readStandings(tc, fakeHttp({ [url]: page }), NOW, gemini);
    expect(gemini.requests).toHaveLength(1);
    expect(file!.source.method).toBe('ia');
    expect(file!.tables[0]!.rows[1]).toEqual({ pos: 2, name: 'FRITZLER, OTTO', points: 339 });
  });
});

describe('utilidades de campeonato', () => {
  it('lee números como los publican los sitios', () => {
    expect(parseNumber('258.5')).toBe(258.5);
    expect(parseNumber('258,5')).toBe(258.5);
    expect(parseNumber('1°')).toBe(1);
    expect(parseNumber('x4')).toBe(4);
    expect(parseNumber('')).toBeNull();
  });

  it('quita los campos null de las tablas leídas con IA', () => {
    const t = cleanStandingsTable({ title: 'P', rows: [{ pos: 1, name: 'A', points: 3, wins: null as unknown as number }] });
    expect(t.rows[0]).toEqual({ pos: 1, name: 'A', points: 3 });
  });

  it('decide cuándo releer el campeonato', () => {
    const race = (endUtc: string) => ({ type: 'carrera', endUtc }) as Session;
    const now = new Date('2026-11-10T12:00:00Z');
    expect(standingsStale(null, [], [], now)).toBe(true);
    // Leído después de la última carrera, que terminó hace más de 3 días: al día.
    expect(standingsStale({ updatedAt: '2026-11-08T12:00:00Z' }, [race('2026-11-02T20:00:00Z')], [], now)).toBe(false);
    // Anterior a la última carrera.
    expect(standingsStale({ updatedAt: '2026-11-01T12:00:00Z' }, [race('2026-11-02T20:00:00Z')], [], now)).toBe(true);
    // Carrera de hace 2 días: el sitio puede no haber actualizado todavía.
    expect(standingsStale({ updatedAt: '2026-11-09T12:00:00Z' }, [race('2026-11-08T20:00:00Z')], [], now)).toBe(true);
    // Sin sesiones conocidas: cuenta el último día de los eventos ya terminados.
    expect(standingsStale({ updatedAt: '2026-11-08T12:00:00Z' }, [], [{ dateEnd: '2026-11-09' }], now)).toBe(true);
    expect(standingsStale({ updatedAt: '2026-11-08T12:00:00Z' }, [], [{ dateEnd: '2026-11-22' }], now)).toBe(false);
    // Más de una semana sin releer.
    expect(standingsStale({ updatedAt: '2026-11-01T12:00:00Z' }, [], [], now)).toBe(true);
  });
});
