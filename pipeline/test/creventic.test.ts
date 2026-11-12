import { describe, expect, it } from 'vitest';
import { rosterFileSchema, standingsFileSchema, type RosterFile, type Source, type StandingsFile } from '@dm/shared';
import { buildDrivers, buildTeams } from '../src/core/drivers.ts';
import { readRoster } from '../src/core/rosters.ts';
import { createLogger } from '../src/core/log.ts';
import {
  championshipSeason,
  championshipShortName,
  creventic,
  creventicChampionships,
  creventicTables,
} from '../src/generic/creventic.ts';
import { createGenericAdapter } from '../src/generic/index.ts';
import { findRecipe } from '../src/generic/recipes.ts';
import type { RecipeContext } from '../src/generic/types.ts';
import { fakeGemini, fakeHttp, fixture, genericSeries, testContext } from './fakes.ts';

const NOW = '2026-11-12T12:00:00Z';
const SITE = 'https://www.24hseries.com';
const DASH = 'https://dashboard.24hseries.com/vendors/24hseries/standings.php';
const series = genericSeries('24h-series', '24H Series (Creventic)', [`${SITE}/races`, `${SITE}/standings`], { rosterUrls: [`${SITE}/races`] });

/** Página de posiciones (solo el iframe) y el dashboard: csID=4 muestra la serie europea, como el sitio real. */
const standingsRoutes = () => ({
  [`${SITE}/standings`]: fixture('creventic-standings.html'),
  [`${DASH}?csID=4`]: fixture('creventic-dashboard-europe-2026.html'),
  [`${DASH}?championship=12`]: fixture('creventic-dashboard-europe-2026.html'),
  [`${DASH}?championship=11`]: fixture('creventic-dashboard-middle-east-2026.html'),
});

/** Calendario y tres eventos: Mugello y Dubái con tripulaciones, Barcelona solo con los autos; el resto no existe (404). */
const rosterRoutes = () => ({
  [`${SITE}/races`]: fixture('creventic-races.html'),
  [`${SITE}/races/michelin-12h-mugello-2026`]: fixture('creventic-race-mugello-2026.html'),
  [`${SITE}/races/michelin-24h-barcelona-2026`]: fixture('creventic-race-barcelona-2026.html'),
  [`${SITE}/races/michelin-24h-dubai-2026`]: fixture('creventic-race-dubai-2026.html'),
});

const ctx = (routes: Record<string, string>, season = 2026): RecipeContext & { http: ReturnType<typeof fakeHttp> } => ({
  season,
  series,
  http: fakeHttp(routes),
  now: new Date(NOW),
});

describe('24H Series (Creventic): campeonato', () => {
  it('reconoce el sitio y la URL de posiciones; temporada y nombre corto de cada campeonato', () => {
    expect(findRecipe(`${SITE}/standings`)?.name).toBe('24h-series');
    expect(creventic.match('https://24hseries.com/races')).toBe(true);
    expect(championshipSeason('Michelin 24H SERIES Europe 2026')).toBe(2026);
    // El Middle East Trophy de los primeros años cruzaba el año: cuenta para la temporada en que terminó.
    expect(championshipSeason('Middle East Trophy Powered by Hankook 2023/2024')).toBe(2024);
    expect(championshipSeason('Standings')).toBeNull();
    expect(championshipShortName('Michelin 24H SERIES MIDDLE EAST TROPHY 2026')).toBe('Middle East Trophy');
    expect(championshipShortName('24H SERIES powered by Hankook European Series 2023')).toBe('Europa');
    expect(creventicChampionships(fixture('creventic-dashboard-europe-2026.html')).slice(0, 3)).toEqual([
      { id: '12', label: 'Michelin 24H SERIES Europe 2026' },
      { id: '11', label: 'Michelin 24H SERIES MIDDLE EAST TROPHY 2026' },
      { id: '10', label: 'Michelin 24H SERIES Europe 2025' },
    ]);
  });

  it('tablas por clase: empates "1, 1, 1, 2", equipos por auto, nacionalidad, sin autos sin puntos, clases vacías ni subcopas', () => {
    const tables = creventicTables(fixture('creventic-dashboard-middle-east-2026.html'), '');
    expect(tables.map((t) => `${t.title} (${t.rows.length})`)).toEqual([
      'Pilotos GT3 (5)',
      'Pilotos TCE (5)',
      'Equipos GT3 (5)',
      'Equipos TCE (4)',
    ]);
    expect(tables[0]!.rows.slice(0, 4)).toEqual([
      { pos: 1, name: 'Anthony McIntosh', points: 96, country: 'United States' },
      { pos: 2, name: 'Antares Au', points: 76, country: 'Hong Kong' },
      { pos: 2, name: 'Loek Hartog', points: 76, country: 'Netherlands' },
      // ISO3 que places.ts no conoce.
      { pos: 3, name: 'Stanislav Minsky', points: 68, country: 'Kyrgyzstan' },
    ]);
    // "Herberth Motorsport (10)": el número del auto va aparte, así el equipo se une con sus otros autos.
    expect(tables[2]!.rows.slice(0, 2)).toEqual([
      { pos: 1, name: 'Team WRT', number: '669', points: 96 },
      { pos: 2, name: 'Herberth Motorsport', number: '10', points: 76 },
    ]);
    // Los autos sin puntos (posición "*" o total 0) no entran: el fixture tiene de los dos.
    const all = tables.flatMap((t) => t.rows);
    expect(all.every((r) => r.points > 0)).toBe(true);
    expect(all.some((r) => r.name === 'KCMG')).toBe(false);
  });

  it('lee los dos campeonatos de la temporada (Europa y Middle East Trophy) siguiendo el iframe, sin Gemini', async () => {
    const http = fakeHttp(standingsRoutes());
    const out = await createGenericAdapter({ gemini: () => fakeGemini({}, { available: false }) }).results!(series, testContext(http, NOW), {
      events: [],
      pendingSessions: [],
      sessions: [],
      standingsStale: true,
    });
    const file = standingsFileSchema.parse(out.standings);
    expect(file.season).toBe(2026);
    expect(file.tables.map((t) => t.title)).toEqual([
      'Pilotos GT3 (Europa)',
      'Pilotos TCE (Europa)',
      'Equipos GT3 (Europa)',
      'Equipos TCE (Europa)',
      'Pilotos GT3 (Middle East Trophy)',
      'Pilotos TCE (Middle East Trophy)',
      'Equipos GT3 (Middle East Trophy)',
      'Equipos TCE (Middle East Trophy)',
    ]);
    // El esquema conserva la nacionalidad (antes la descartaba).
    expect(file.tables[0]!.rows[0]).toEqual({ pos: 1, name: 'Pierre Kaffer', points: 134, country: 'Germany' });
    expect(file.tables[2]!.rows[0]).toEqual({ pos: 1, name: 'Sainteloc Junior Team', number: '18', points: 134 });
    expect(file.source).toMatchObject({ url: `${DASH}?championship=12`, method: 'directo', kind: 'html' });
  });

  it('una temporada sin campeonato publicado devuelve null (no es un error)', async () => {
    const c = ctx(standingsRoutes(), 2027);
    expect(await creventic.standings!(`${SITE}/standings`, c)).toBeNull();
    expect(c.http.requested).toEqual([`${SITE}/standings`, `${DASH}?csID=4`]);
  });

  it('una página sin el iframe del dashboard es un formato inesperado', async () => {
    await expect(creventic.standings!(`${SITE}/standings`, ctx({ [`${SITE}/standings`]: '<html><body>Standings</body></html>' }))).rejects.toThrow(/dashboard/);
  });
});

describe('24H Series (Creventic): inscriptos', () => {
  it('une las listas de todos los eventos de la temporada; los que solo publican los autos no aportan', async () => {
    const found = (await creventic.roster!(`${SITE}/races`, ctx(rosterRoutes())))!;
    expect(found.source).toMatchObject({ url: `${SITE}/races/michelin-12h-mugello-2026`, method: 'directo' });
    expect(found.rows).toHaveLength(18);
    expect(found.rows[0]).toEqual({
      driver: 'Pierre Kaffer',
      team: 'Sainteloc Junior Team',
      number: '18',
      vehicle: 'Audi R8 LMS GT3 EVO II',
      class: 'GT3-Pro/Am',
      country: 'Germany',
    });
    expect(found.rows.find((r) => r.driver === 'Jules Gounon')).toMatchObject({ team: 'Grove Racing by Getspeed', number: '4', class: 'GT3', country: 'France' });
    // Grenada es la bandera publicada para Lomko (ISO3 que places.ts no conoce).
    expect(found.rows.find((r) => r.driver === 'Vladislav Lomko')?.country).toBe('Grenada');
  });

  it('null si ningún evento de la temporada publicó tripulaciones', async () => {
    const onlyCars = { [`${SITE}/races`]: fixture('creventic-races.html'), [`${SITE}/races/michelin-24h-barcelona-2026`]: fixture('creventic-race-barcelona-2026.html') };
    expect(await creventic.roster!(`${SITE}/races`, ctx(onlyCars))).toBeNull();
    expect(await creventic.roster!(`${SITE}/races`, ctx(rosterRoutes(), 2030))).toBeNull();
  });

  it('el flujo común deja la lista válida para data/rosters', async () => {
    const roster = await readRoster(series, { now: new Date(NOW), season: 2026, http: fakeHttp(rosterRoutes()), log: createLogger('', true) });
    expect(rosterFileSchema.parse(roster).rows).toHaveLength(18);
  });
});

describe('24H Series (Creventic): índice de pilotos', () => {
  const source: Source = { url: SITE, title: 'x', kind: 'html', method: 'directo', fetchedAt: NOW };
  const standings = (seriesId: string, tables: StandingsFile['tables']): StandingsFile => ({ seriesId, season: 2026, updatedAt: NOW, tables, source });

  it('un piloto de la 24H Series se une con el mismo en otra categoría; el país de la lista de inscriptos manda sobre el de la tabla', async () => {
    const own = creventicTables(fixture('creventic-dashboard-europe-2026.html'), 'Europa');
    const roster: RosterFile = {
      seriesId: '24h-series',
      season: 2026,
      updatedAt: NOW,
      rows: (await creventic.roster!(`${SITE}/races`, ctx(rosterRoutes())))!.rows,
      source,
    };
    // Otra categoría publica otra nacionalidad para Kaffer: las listas de inscriptos mandan sobre la tabla.
    const other: RosterFile = { ...roster, seriesId: 'gtwc-europe', rows: [{ driver: 'Pierre KAFFER', team: 'Team X', number: '7', country: 'Austria' }] };
    const input = {
      series: [genericSeries('gtwc-europe', 'GTWC Europe', [SITE]), series],
      standings: [standings('gtwc-europe', [{ title: 'Pilotos', rows: [{ pos: 3, name: 'Maro Engel', points: 80 }] }]), standings('24h-series', own)],
      results: [],
      sessions: [],
      rosters: [roster, other],
      generatedAt: NOW,
    };
    const file = buildDrivers(input);
    const engel = file.drivers.find((d) => d.id === 'engel-maro')!;
    expect(engel.entries.map((e) => e.seriesId)).toEqual(['gtwc-europe']);
    expect(engel.lineups).toEqual([{ seriesId: '24h-series', team: 'GetSpeed Team PCX Racing', number: '28', vehicle: 'Mercedes-AMG GT3 EVO', class: 'GT3-Pro/Am' }]);
    expect(engel.country).toBe('Germany');

    const kaffer = file.drivers.find((d) => d.id === 'kaffer-pierre')!;
    expect(kaffer.entries.map((e) => e.table)).toEqual(['Pilotos GT3 (Europa)']);
    expect(kaffer.country).toBe('Austria');
    // Solo en la tabla (sin lista de inscriptos): el país sale de la tabla.
    expect(file.drivers.find((d) => d.name === 'Torsten Kratz')?.country).toBe('Germany');

    const teams = buildTeams({ ...input, drivers: file });
    const sainteloc = teams.teams.find((t) => t.name === 'Sainteloc Junior Team')!;
    expect(sainteloc.entries[0]).toMatchObject({ seriesId: '24h-series', table: 'Equipos GT3 (Europa)', pos: 1, numbers: ['18'] });
  });
});
