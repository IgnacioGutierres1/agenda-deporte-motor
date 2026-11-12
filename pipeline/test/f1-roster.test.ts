import { describe, expect, it } from 'vitest';
import { driverId, teamId, type Series, type Source, type StandingsFile } from '@dm/shared';
import { buildDrivers, buildTeams } from '../src/core/drivers.ts';
import { createLogger } from '../src/core/log.ts';
import { findRosterRecipe, readRoster } from '../src/core/rosters.ts';
import { F1_DRIVERS_URL, f1DriverCards, f1DriverPage } from '../src/generic/formula1.ts';
import { findRecipe } from '../src/generic/recipes.ts';
import { fakeHttp, fixture } from './fake-http.ts';

const NOW = '2026-11-12T12:00:00Z';
const log = createLogger('', true);
const ctxFor = (http: ReturnType<typeof fakeHttp>, now = NOW) => ({ now: new Date(now), season: new Date(now).getUTCFullYear(), http, log });

const f1: Series = {
  id: 'f1',
  name: 'Fórmula 1',
  shortName: 'F1',
  group: 'f1-fia',
  officialUrls: ['https://www.formula1.com/en/racing/2026'],
  rosterUrls: [F1_DRIVERS_URL],
  strategy: 'adapter',
  adapter: 'f1',
  origin: 'default',
  enabled: true,
};

const SLUGS = ['kimi-antonelli', 'max-verstappen', 'franco-colapinto'];
const f1Http = (missing: string[] = []) =>
  fakeHttp({
    [F1_DRIVERS_URL]: fixture('f1/drivers-2026.html'),
    ...Object.fromEntries(SLUGS.filter((s) => !missing.includes(s)).map((s) => [`${F1_DRIVERS_URL}/${s}`, fixture(`f1/driver-${s}.html`)])),
  });

describe('inscriptos de Fórmula 1 (formula1.com)', () => {
  it('lee las tarjetas de la página de pilotos: nombre, equipo, bandera y temporada', () => {
    const cards = f1DriverCards(fixture('f1/drivers-2026.html'));
    // Ni el menú ("Drivers", "Hall of Fame") ni el payload RSC escapado cuentan como tarjetas.
    expect(cards).toEqual([
      { driver: 'Kimi Antonelli', url: `${F1_DRIVERS_URL}/kimi-antonelli`, team: 'Mercedes', country: 'Italy', season: 2026 },
      { driver: 'Max Verstappen', url: `${F1_DRIVERS_URL}/max-verstappen`, team: 'Red Bull Racing', country: 'Netherlands', season: 2026 },
      { driver: 'Franco Colapinto', url: `${F1_DRIVERS_URL}/franco-colapinto`, team: 'Alpine', country: 'Argentina', season: 2026 },
    ]);
  });

  it('lee país, equipo y número de la ficha (sin tomar números de las estadísticas)', () => {
    expect(f1DriverPage(fixture('f1/driver-franco-colapinto.html'))).toEqual({ number: '43', country: 'Argentina', team: 'Alpine' });
    expect(f1DriverPage(fixture('f1/driver-max-verstappen.html'))).toEqual({ number: '3', country: 'Netherlands', team: 'Red Bull Racing' });
    expect(f1DriverPage(fixture('f1/driver-kimi-antonelli.html')).number).toBe('12');
    expect(() => f1DriverPage('<html><body>sin ficha</body></html>')).toThrow(/encabezado/);
  });

  it('la fase de inscriptos encuentra la receta aunque la F1 sea una serie con adaptador', () => {
    expect(findRosterRecipe(F1_DRIVERS_URL)?.name).toBe('formula1');
    expect(findRosterRecipe('https://formula1.com/en/drivers/')?.name).toBe('formula1');
    // No entra en RECIPES: el calendario y el campeonato de la F1 siguen siendo del adaptador.
    expect(findRecipe(F1_DRIVERS_URL)).toBeUndefined();
    expect(findRosterRecipe('https://www.formula1.com/en/racing/2026')).toBeUndefined();
    // Las demás listas se siguen resolviendo con RECIPES.
    expect(findRosterRecipe('https://api.dtm.com/data?query=drivers')?.name).toBe(findRecipe('https://api.dtm.com/data?query=drivers')?.name);
  });

  it('arma la lista con número y país de cada piloto', async () => {
    const http = f1Http();
    const roster = await readRoster(f1, ctxFor(http));
    expect(roster).not.toBeNull();
    expect(roster!.season).toBe(2026);
    expect(roster!.source).toMatchObject({ url: F1_DRIVERS_URL, kind: 'html', method: 'directo' });
    expect(roster!.rows).toEqual([
      { driver: 'Kimi Antonelli', team: 'Mercedes', number: '12', country: 'Italy' },
      { driver: 'Max Verstappen', team: 'Red Bull Racing', number: '3', country: 'Netherlands' },
      { driver: 'Franco Colapinto', team: 'Alpine', number: '43', country: 'Argentina' },
    ]);
  });

  it('una ficha que no responde deja al piloto sin número; si no hay ningún número, conserva la lista anterior', async () => {
    const partial = await readRoster(f1, ctxFor(f1Http(['max-verstappen'])));
    expect(partial!.rows.find((r) => r.driver === 'Max Verstappen')).toEqual({ driver: 'Max Verstappen', team: 'Red Bull Racing', country: 'Netherlands' });
    await expect(readRoster(f1, ctxFor(f1Http(SLUGS)))).rejects.toThrow(/número/);
  });

  it('una grilla de hace dos temporadas no se publica como la actual', async () => {
    expect(await readRoster(f1, ctxFor(f1Http(), '2028-03-01T12:00:00Z'))).toBeNull();
  });

  it('une la lista con las tablas del campeonato: "#43" encuentra a Colapinto y los equipos se enlazan', async () => {
    const roster = (await readRoster(f1, ctxFor(f1Http())))!;
    const source: Source = { url: 'https://www.formula1.com/en/results/2026/drivers', title: 'F1', kind: 'html', method: 'directo', fetchedAt: NOW };
    const standings: StandingsFile = {
      seriesId: 'f1',
      season: 2026,
      updatedAt: NOW,
      source,
      tables: [
        {
          title: 'Pilotos',
          rows: [
            { pos: 1, name: 'Kimi Antonelli', team: 'Mercedes', points: 300 },
            { pos: 2, name: 'Max Verstappen', team: 'Red Bull Racing', points: 279 },
            { pos: 12, name: 'Franco Colapinto', team: 'Alpine', points: 27 },
          ],
        },
        {
          title: 'Constructores',
          rows: [
            { pos: 1, name: 'Mercedes', points: 500 },
            { pos: 3, name: 'Red Bull Racing', points: 400 },
            { pos: 6, name: 'Alpine', points: 60 },
          ],
        },
      ],
    };
    const input = { series: [f1], standings: [standings], results: [], sessions: [], rosters: [roster], generatedAt: NOW };
    const drivers = buildDrivers(input);
    // Cada piloto de la lista es el mismo de la tabla (misma ficha), con su número y su país.
    expect(drivers.drivers).toHaveLength(3);
    const colapinto = drivers.drivers.find((d) => d.id === driverId('Franco Colapinto'))!;
    expect(colapinto.country).toBe('Argentina');
    expect(colapinto.entries).toEqual([{ seriesId: 'f1', pos: 12, points: 27, team: 'Alpine' }]);
    expect(colapinto.lineups).toEqual([{ seriesId: 'f1', team: 'Alpine', number: '43' }]);
    expect(drivers.drivers.find((d) => d.id === driverId('Kimi Antonelli'))!.lineups?.[0]?.number).toBe('12');
    expect(drivers.drivers.find((d) => d.id === driverId('Max Verstappen'))!.lineups?.[0]?.number).toBe('3');

    // Lo mismo que hace la búsqueda de la app (app/src/lib/search.ts) con "#43": número de tabla o de inscripción.
    const byNumber = (n: string) => drivers.drivers.filter((d) => d.entries.some((e) => e.number === n) || (d.lineups ?? []).some((l) => l.number === n));
    expect(byNumber('43').map((d) => d.name)).toEqual(['Franco Colapinto']);

    const teams = buildTeams({ ...input, drivers });
    // Los nombres de la lista coinciden con los de la tabla de constructores: un solo equipo por escudería.
    expect(teams.teams.map((t) => t.id).sort()).toEqual(['alpine', 'mercedes', 'red-bull-racing']);
    const alpine = teams.teams.find((t) => t.id === teamId('Alpine'))!;
    expect(alpine.entries).toEqual([{ seriesId: 'f1', pos: 6, points: 60, numbers: ['43'] }]);
    expect(alpine.drivers).toEqual([{ id: driverId('Franco Colapinto'), name: 'Franco Colapinto', seriesId: 'f1', number: '43' }]);
  });
});
