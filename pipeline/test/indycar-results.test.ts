import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Series, Session } from '@dm/shared';
import {
  _test,
  apiTime,
  combineQualifying,
  indycarResults,
  indycarRows,
  indycarSchedule,
  indycarSessions,
  indycarSlug,
  type ApiSessionDetails,
} from '../src/generic/results-indycar.ts';
import { findRecipe } from '../src/generic/recipes.ts';
import type { CalendarEntry, RecipeContext } from '../src/generic/types.ts';
import { fixtureHttp } from './fixtures-http.ts';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'indycar');
const html = (f: string) => readFileSync(path.join(DIR, f), 'utf8');
const details = (id: number) => JSON.parse(html(`session-${id}.json`)) as ApiSessionDetails;

const IC = 'https://www.indycar.com';
const API = `${IC}/api/results`;

const series: Series = {
  id: 'indycar',
  name: 'NTT IndyCar Series',
  shortName: 'IndyCar',
  group: 'usa',
  officialUrls: [`${IC}/Schedule`, `${IC}/Standings`],
  strategy: 'generic',
  origin: 'default',
  enabled: true,
};

function ctx(routes: Record<string, string>): RecipeContext & { http: ReturnType<typeof fixtureHttp> } {
  return { season: 2026, series, http: fixtureHttp(routes), now: new Date('2026-11-14T12:00:00Z') };
}

const routes: Record<string, string> = {
  [`${IC}/Schedule/2026/Long-Beach`]: 'indycar/schedule-long-beach.html',
  [`${IC}/Schedule/2026/Milwaukee-Race1`]: 'indycar/schedule-milwaukee-race1.html',
  [`${IC}/Schedule/2026/Milwaukee-Race2`]: 'indycar/schedule-milwaukee-race2.html',
  [`${API}/SeasonDropDown?id=b856a4f1-e85c-4fac-8c36-fd58d962227a`]: 'indycar/season-dropdown.json',
};
for (const id of [6811, 6812, 6813, 6814, 6815, 6816, 6817, 6818, 6746, 6936, 6937, 6938, 6738, 6739]) {
  routes[`${API}/EventsSessionDetails?id=${id}`] = `indycar/session-${id}.json`;
}

const longBeach: CalendarEntry = {
  name: 'Acura Grand Prix of Long Beach',
  circuit: 'Streets of Long Beach',
  country: 'United States',
  tz: 'America/Los_Angeles',
  dateStart: '2026-04-17',
  dateEnd: '2026-04-19',
  url: `${IC}/Schedule/2026/Long-Beach`,
  meta: { pages: `${IC}/Schedule/2026/Long-Beach` },
};

const milwaukee: CalendarEntry = {
  name: 'Snap-on Milwaukee Mile 250',
  circuit: 'Milwaukee Mile',
  country: 'United States',
  tz: 'America/Chicago',
  dateStart: '2026-08-28',
  dateEnd: '2026-08-30',
  url: `${IC}/Schedule/2026/Milwaukee-Race1`,
  meta: { pages: `${IC}/Schedule/2026/Milwaukee-Race1 ${IC}/Schedule/2026/Milwaukee-Race2` },
};

/** Sesión del cronograma como la arma el flujo genérico (nombre traducido, original de la fuente). */
function session(id: string, originalName: string, startUtc: string): Session {
  return {
    id,
    eventId: 'ev',
    seriesId: 'indycar',
    type: 'practica',
    name: originalName,
    originalName,
    startUtc,
    endUtc: startUtc,
    endEstimated: true,
    broadcast: [],
    broadcastIsDefault: true,
    source: { url: '', title: '', kind: 'html', method: 'directo', fetchedAt: '' },
    hasResults: false,
  };
}

describe('IndyCar: cronograma de la página de cada fecha', () => {
  it('lee día, hora ET y sesión, con el link a sus resultados', () => {
    const items = indycarSchedule(html('schedule-long-beach.html'), `${IC}/Schedule/2026/Long-Beach`, 2026);
    expect(items.map((i) => [i.name, i.startUtc])).toEqual([
      ['Practice 1', '2026-04-17T22:00:00Z'],
      ['Practice 2', '2026-04-18T17:30:00Z'],
      ['Qualifying', '2026-04-18T22:30:00Z'],
      ['Warmup', '2026-04-19T17:00:00Z'],
      ['Race', '2026-04-19T21:30:00Z'],
    ]);
    expect(items[2]!.links).toEqual([`${IC}/results/ntt-indycar-series/2026/acura-grand-prix-of-long-beach/qualifying---firestone-fast-6`]);
  });

  it('Indy 500: junta las ventanas de una misma práctica y deja afuera lo que no es sesión de pista', () => {
    const items = indycarSchedule(html('schedule-indianapolis-500.html'), `${IC}/Schedule/2026/Indianapolis-500`, 2026);
    const names = items.map((i) => i.name);
    expect(names).toEqual([
      'Practice 1',
      'Practice 2',
      'Practice 3',
      'Fast Friday Practice',
      'Practice 6',
      'Qualifying (All Cars)',
      'Qualifying (Top-12)',
      'Qualifying (Firestone Fast 6)',
      'Practice 7',
      'Carb Day Final Practice',
      'Race',
    ]);
    // "Practice 1" figura a las 12 y a las 16 ET: es la misma sesión.
    expect(items[0]!.startUtc).toBe('2026-05-12T16:00:00Z');
    expect(items[3]!.links[0]).toMatch(/practice-4$/);
  });

  it('acepta páginas sin el rótulo de la serie (Phoenix) y descarta actividades sin resultado', () => {
    const items = indycarSchedule(html('schedule-phoenix.html'), `${IC}/Schedule/2026/Phoenix`, 2026);
    expect(items.map((i) => i.name)).toEqual(['Practice 1', 'Qualifications', 'High Line & Final Practice', 'Race']);
    expect(_test.sessionName('NTT INDYCAR SERIES - Pre-Race', 'indycar.com', true)).toBeNull();
    expect(_test.sessionName('Oscar Mayer Wienie 500', 'indycar.com', true)).toBeNull();
    expect(_test.sessionName('INDY NXT - Practice 1', 'indycar.com', true)).toBeNull();
    expect(_test.sessionName('INDY NXT - Practice 1', 'indynxt.com', true)).toBe('Practice 1');
  });

  it('Indy NXT, fecha doble: cada página tiene el fin de semana completo', () => {
    const items = indycarSchedule(html('nxt-schedule-barber-race1.html'), 'https://www.indynxt.com/Schedule/2026/Barber-Race1', 2026);
    expect(items.map((i) => `${i.name} ${i.startUtc}`)).toEqual([
      'Practice 2026-03-27T18:30:00Z',
      'Qualifying 2026-03-28T14:00:00Z',
      'Race 1 2026-03-28T17:00:00Z',
      'Race 2 2026-03-29T15:00:00Z',
    ]);
  });

  it('pastSessions/sessions: une las páginas de una fecha doble sin repetir sesiones, con la hora local del circuito', async () => {
    const found = await indycarSessions(milwaukee, ctx(routes));
    expect(found?.sessions.map((s) => `${s.name} ${s.startUtc} ${s.localStartText}`)).toEqual([
      'Practice 2026-08-28T22:00:00Z 17:00',
      'Qualifying 2026-08-29T15:00:00Z 10:00',
      'Race 2 2026-08-30T17:00:00Z 12:00',
      'Race 1 2026-08-30T22:00:00Z 17:00',
    ]);
  });
});

describe('IndyCar: tablas de la API de resultados', () => {
  it('slug de los links igual al del sitio', () => {
    expect(indycarSlug('Qualifying - Firestone Fast 6')).toBe('qualifying---firestone-fast-6');
    expect(indycarSlug("Children's of Alabama Indy Grand Prix")).toBe('childrens-of-alabama-indy-grand-prix');
    expect(indycarSlug('Final Practice (Carb Day)')).toBe('final-practice-(carb-day)');
  });

  it('tiempos sin ceros de más', () => {
    expect(apiTime('01:59:29.6163')).toBe('1:59:29.6163');
    expect(apiTime('00:51.6195')).toBe('51.6195');
    expect(apiTime('01:09.1363')).toBe('1:09.1363');
    expect(apiTime('--.----')).toBeUndefined();
    expect(apiTime('No Time')).toBeUndefined();
  });

  it('carrera: tiempo del ganador, diferencias, vueltas perdidas, puntos y abandonos', () => {
    const rows = indycarRows(details(6746));
    expect(rows).toHaveLength(25);
    expect(rows[0]).toEqual({ pos: 1, driver: 'Alex Palou', number: '10', team: 'Chip Ganassi Racing', laps: 90, time: '1:49:09.5058', bestLap: '1:09.8211', points: 51 });
    expect(rows[1]).toMatchObject({ pos: 2, driver: 'Felix Rosenqvist', gap: '+3.9663', points: 44 });
    expect(rows[23]).toMatchObject({ pos: 24, driver: 'Marcus Armstrong', laps: 89, gap: '+1 vuelta' });
    expect(rows[24]).toMatchObject({ pos: 25, driver: 'Marcus Ericsson', laps: 38, status: 'Mechanical', points: 5 });
  });

  it('clasificación en óvalo: tiempo total y diferencia; sin tiempo marcado', () => {
    const oval = indycarRows(details(6866));
    expect(oval[0]).toMatchObject({ pos: 1, driver: 'Alex Palou', time: '51.6195' });
    expect(oval[1]).toMatchObject({ pos: 2, driver: 'David Malukas', time: '51.9500', gap: '+0.3305' });
    const indy = indycarRows(details(6835));
    expect(indy[0]).toMatchObject({ pos: 1, driver: 'Alex Palou', time: '2:35.0066' });
    expect(indy.at(-1)).toMatchObject({ pos: 33, driver: 'Jack Harvey', status: 'Sin tiempo' });
  });

  it('clasificación por partes: orden de la combinada y en class la parte en que quedó cada piloto', () => {
    const parts = [6945, 6944, 6943, 6942, 6941].map((id) => ({ name: details(id).SessionName!, rows: indycarRows(details(id)) }));
    const rows = combineQualifying(parts);
    expect(rows).toHaveLength(25);
    expect(rows[0]).toMatchObject({ pos: 1, driver: 'Scott McLaughlin', class: 'Firestone Fast 6', classPos: 1, bestLap: '1:09.1363' });
    expect(rows[6]).toMatchObject({ pos: 7, driver: 'Kyle Kirkwood', class: 'Ronda 2 (Fast 12)', classPos: 7, bestLap: '1:09.5726' });
    expect(rows[12]).toMatchObject({ pos: 13, driver: "Pato O'Ward", class: 'Ronda 1 · Grupo 1', classPos: 7 });
    expect(rows[13]).toMatchObject({ pos: 14, driver: 'Will Power', class: 'Ronda 1 · Grupo 2', classPos: 7 });
    // Sin la combinada, el mismo orden sale de las partes.
    const rebuilt = combineQualifying(parts.slice(1));
    expect(rebuilt.map((r) => `${r.pos} ${r.driver}`)).toEqual(rows.map((r) => `${r.pos} ${r.driver}`));
  });
});

describe('IndyCar: results() de la receta', () => {
  it('Long Beach: prácticas, clasificación con sus partes, warmup y carrera', async () => {
    const c = ctx(routes);
    const sessions = [
      session('p1', 'Practice 1', '2026-04-17T22:00:00Z'),
      session('p2', 'Practice 2', '2026-04-18T17:30:00Z'),
      session('q', 'Qualifying', '2026-04-18T22:30:00Z'),
      session('w', 'Warmup', '2026-04-19T17:00:00Z'),
      session('r', 'Race', '2026-04-19T21:30:00Z'),
    ];
    const found = await indycarResults(longBeach, sessions, c);
    expect(found?.sessions.map((s) => [s.sessionId, s.rows.length])).toEqual([
      ['p1', 25],
      ['p2', 25],
      ['q', 25],
      ['w', 25],
      ['r', 25],
    ]);
    const q = found!.sessions[2]!;
    expect(q.rows[0]).toMatchObject({ pos: 1, driver: 'Felix Rosenqvist', class: 'Firestone Fast 6', bestLap: '1:07.4635' });
    expect(q.rows[6]).toMatchObject({ pos: 7, driver: 'Will Power', class: 'Ronda 2 (Fast 12)', bestLap: '1:07.5163' });
    expect(q.rows[24]).toMatchObject({ pos: 25, driver: 'Nolan Siegel', class: 'Ronda 1 · Grupo 2', classPos: 13 });
    expect(found!.sessions[4]!.source?.url).toBe(`${IC}/results/ntt-indycar-series/2026/acura-grand-prix-of-long-beach/race`);
    expect(found!.deferred).toBeUndefined();
  });

  it('fecha doble (Milwaukee): cada carrera con su resultado y la clasificación con las dos grillas', async () => {
    const sessions = [
      session('p', 'Practice', '2026-08-28T22:00:00Z'),
      session('q', 'Qualifying', '2026-08-29T15:00:00Z'),
      session('r2', 'Race 2', '2026-08-30T17:00:00Z'),
      session('r1', 'Race 1', '2026-08-30T22:00:00Z'),
    ];
    const found = await indycarResults(milwaukee, sessions, ctx(routes));
    const by = new Map(found!.sessions.map((s) => [s.sessionId, s]));
    expect(by.get('r1')!.source?.url).toMatch(/snap-on-makers-and-fixers-250\/race$/);
    expect(by.get('r2')!.source?.url).toMatch(/snap-on-milwaukee-mile-250\/race$/);
    const q = by.get('q')!.rows;
    expect(q.filter((r) => r.class === 'Carrera 1')[0]).toMatchObject({ pos: 1, classPos: 1, driver: 'Scott McLaughlin', time: '22.0738' });
    expect(q.filter((r) => r.class === 'Carrera 2')[0]).toMatchObject({ pos: 1, classPos: 1, driver: 'Alex Palou' });
    expect(by.get('p')!.rows).toHaveLength(25);
  });

  it('una fecha sin links de resultados todavía devuelve null', async () => {
    const c = ctx({ [`${IC}/Schedule/2026/Long-Beach`]: 'indycar/schedule-long-beach.html' });
    const page = html('schedule-long-beach.html').replace(/<a href="\/results[^"]*"[^>]*>/g, '<a>');
    c.http.text = async (url) => ({ url, status: 200, contentType: 'text/html', body: page });
    expect(await indycarResults(longBeach, [session('r', 'Race', '2026-04-19T21:30:00Z')], c)).toBeNull();
  });

  it('la receta de indycar.com e indynxt.com usa estos lectores', () => {
    const recipe = findRecipe(`${IC}/Schedule`);
    expect(recipe?.results).toBeTypeOf('function');
    expect(recipe?.pastSessions).toBeTypeOf('function');
    expect(findRecipe('https://www.indynxt.com/schedule')?.name).toBe('indycar');
  });
});
