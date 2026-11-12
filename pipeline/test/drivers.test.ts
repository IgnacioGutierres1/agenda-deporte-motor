import { describe, expect, it } from 'vitest';
import {
  driverDisplayName,
  driverId,
  driversFileSchema,
  splitDriverNames,
  teamsFileSchema,
  type EventResultsFile,
  type RosterFile,
  type Series,
  type Session,
  type Source,
  type StandingsFile,
} from '@dm/shared';
import { buildDrivers, buildTeams, teamDisplayName, teamTables } from '../src/core/drivers.ts';

const source: Source = { url: 'https://example.org/', title: 'x', kind: 'html', method: 'directo', fetchedAt: '2026-11-10T00:00:00Z' };
const series = (id: string): Series => ({
  id,
  name: id.toUpperCase(),
  shortName: id.toUpperCase(),
  group: 'argentina',
  officialUrls: ['https://example.org/'],
  strategy: 'generic',
  origin: 'default',
  enabled: true,
});
const standings = (seriesId: string, tables: StandingsFile['tables']): StandingsFile => ({
  seriesId,
  season: 2026,
  updatedAt: '2026-11-10T00:00:00Z',
  tables,
  source,
});
const session = (id: string, eventId: string, seriesId: string, type: Session['type'], startUtc: string): Session => ({
  id,
  eventId,
  seriesId,
  type,
  name: type,
  startUtc,
  endUtc: startUtc,
  endEstimated: true,
  broadcast: [],
  broadcastIsDefault: true,
  source,
  hasResults: true,
});

describe('índice de pilotos', () => {
  it('une a un piloto entre categorías, ignora tablas de equipos y tripulaciones sin nombres completos, y guarda sus últimas carreras', () => {
    const file = buildDrivers({
      series: [series('tc'), series('tn'), series('wec')],
      standings: [
        standings('tn', [
          { title: 'Clase 2', rows: [{ pos: 1, name: 'Vitar, Tomas', points: 316, number: '177', team: 'GR Competicion' }] },
          { title: 'Clase 3', rows: [{ pos: 1, name: 'Canapino, Agustin', points: 320, number: '86' }] },
        ]),
        standings('tc', [
          { title: 'Pilotos', rows: [{ pos: 1, name: 'Agustín CANAPINO', points: 347, number: '1' }] },
          { title: 'Equipos', rows: [{ pos: 1, name: 'Canapino Sport', points: 500 }] },
        ]),
        standings('wec', [{ title: 'Pilotos', rows: [{ pos: 1, name: 'Vanthoor / Estre', points: 150 }] }]),
      ],
      results: [
        {
          seriesId: 'tc',
          eventId: 'e1',
          updatedAt: '2026-11-10T00:00:00Z',
          sessions: [
            { sessionId: 's-final', rows: [{ pos: 2, driver: 'Agustín CANAPINO' }, { pos: 1, driver: 'Piloto Sin Tabla' }], source },
            { sessionId: 's-practica', rows: [{ pos: 1, driver: 'Agustín CANAPINO' }], source },
          ],
        },
      ] satisfies EventResultsFile[],
      sessions: [
        session('s-final', 'e1', 'tc', 'carrera', '2026-11-01T17:00:00Z'),
        session('s-practica', 'e1', 'tc', 'practica', '2026-10-31T13:00:00Z'),
      ],
      generatedAt: '2026-11-10T00:00:00Z',
    });

    expect(driversFileSchema.parse(file)).toBeTruthy();
    expect(file.drivers.map((d) => d.id)).toEqual(['agustin-canapino', 'tomas-vitar']);
    const canapino = file.drivers[0]!;
    expect(canapino.name).toBe('Agustín Canapino');
    // En el orden de la configuración (TC antes que TN) y con la clase cuando hay varias tablas.
    expect(canapino.entries).toEqual([
      { seriesId: 'tc', pos: 1, points: 347, number: '1' },
      { seriesId: 'tn', table: 'Clase 3', pos: 1, points: 320, number: '86' },
    ]);
    // Solo carreras (no prácticas).
    expect(canapino.recent).toEqual([{ seriesId: 'tc', eventId: 'e1', sessionId: 's-final', startUtc: '2026-11-01T17:00:00Z', pos: 2 }]);
    expect(file.drivers[1]!.name).toBe('Tomas Vitar');
  });
});

const roster = (seriesId: string, rows: RosterFile['rows']): RosterFile => ({ seriesId, season: 2026, updatedAt: '2026-11-10T00:00:00Z', rows, source });

describe('tripulaciones', () => {
  it('separa los pilotos de una tripulación sin romper "Apellido, Nombre"', () => {
    expect(splitDriverNames('Canapino, Agustin')).toEqual(['Canapino, Agustin']);
    expect(splitDriverNames('DI PALMA, JOSE LUIS')).toEqual(['DI PALMA, JOSE LUIS']);
    expect(splitDriverNames('HERMIDA ALONSO, FEDERICO')).toEqual(['HERMIDA ALONSO, FEDERICO']);
    expect(splitDriverNames('Jean-Eric Vergne')).toEqual(['Jean-Eric Vergne']);
    expect(splitDriverNames('Kevin Estre / Laurens Vanthoor / Matt Campbell')).toEqual(['Kevin Estre', 'Laurens Vanthoor', 'Matt Campbell']);
    expect(splitDriverNames('A. Pier Guidi, J. Calado & A. Giovinazzi')).toEqual(['A. Pier Guidi', 'J. Calado', 'A. Giovinazzi']);
    expect(splitDriverNames('Kevin Estre, Laurens Vanthoor, Matt Campbell')).toEqual(['Kevin Estre', 'Laurens Vanthoor', 'Matt Campbell']);
    expect(splitDriverNames('Lucas Auer - Maro Engel')).toEqual(['Lucas Auer', 'Maro Engel']);
    expect(splitDriverNames('Maro Engel; Luca Stolz')).toEqual(['Maro Engel', 'Luca Stolz']);
    // Solo apellidos: no identifican a nadie.
    expect(splitDriverNames('Vanthoor / Estre')).toEqual([]);
    expect(splitDriverNames('Kevin Estre / Vanthoor')).toEqual(['Kevin Estre']);
    expect(splitDriverNames(' / ')).toEqual([]);
    // La identidad y el nombre visible de "Apellido, Nombre" siguen igual.
    expect(driverId('Canapino, Agustin')).toBe('agustin-canapino');
    expect(driverDisplayName('Canapino, Agustin')).toBe('Agustin Canapino');
  });

  it('una tripulación en la tabla y en los resultados suma a cada piloto', () => {
    const file = buildDrivers({
      series: [series('wec')],
      standings: [standings('wec', [{ title: 'Hypercar', rows: [{ pos: 1, name: 'Kevin Estre / Laurens Vanthoor', number: '6', points: 150 }] }])],
      results: [
        {
          seriesId: 'wec',
          eventId: 'wec-spa',
          updatedAt: '2026-11-10T00:00:00Z',
          sessions: [{ sessionId: 's1', rows: [{ pos: 3, driver: 'Kevin ESTRE / Laurens VANTHOOR / Matt CAMPBELL' }], source }],
        },
      ],
      sessions: [session('s1', 'wec-spa', 'wec', 'carrera', '2026-05-09T12:00:00Z')],
      generatedAt: '2026-11-10T00:00:00Z',
    });
    // Campbell no está en ninguna tabla ni lista de inscriptos: no se crea su ficha desde un resultado.
    expect(file.drivers.map((d) => d.id)).toEqual(['estre-kevin', 'laurens-vanthoor']);
    for (const d of file.drivers) {
      expect(d.entries).toEqual([{ seriesId: 'wec', pos: 1, points: 150, number: '6' }]);
      expect(d.recent).toEqual([{ seriesId: 'wec', eventId: 'wec-spa', sessionId: 's1', startUtc: '2026-05-09T12:00:00Z', pos: 3 }]);
    }
  });
});

describe('listas de inscriptos en el índice de pilotos', () => {
  it('suma pilotos que solo están inscriptos, con país, equipo, número, auto y clase', () => {
    const file = buildDrivers({
      series: [series('gtwc-europe'), series('elms'), series('dtm')],
      standings: [standings('gtwc-europe', [{ title: 'Pilotos Endurance Cup', rows: [{ pos: 1, name: 'Maro Engel', points: 86 }] }])],
      results: [],
      sessions: [],
      rosters: [
        roster('dtm', [{ driver: 'Maro Engel', team: 'Mercedes-AMG Team Ravenol', number: '80', vehicle: 'Mercedes-AMG GT3', country: 'Germany' }]),
        roster('gtwc-europe', [
          { driver: 'Maro ENGEL', team: 'Mercedes - AMG Team MANN-FILTER', number: '48', vehicle: 'Mercedes-AMG GT3 EVO', class: 'Pro', country: 'Germany' },
          // Repetido en otra carrera con el mismo auto: una sola línea.
          { driver: 'Maro ENGEL', team: 'Mercedes-AMG Team Mann-Filter', number: '48', class: 'Pro' },
        ]),
        roster('elms', [{ driver: 'Georgios Kolovos', team: 'PROTON COMPETITION', number: '9', class: 'LMP2', country: 'Germany' }]),
      ],
      generatedAt: '2026-11-10T00:00:00Z',
    });
    expect(driversFileSchema.parse(file)).toBeTruthy();
    expect(file.drivers.map((d) => [d.id, d.name])).toEqual([
      ['georgios-kolovos', 'Georgios Kolovos'],
      ['engel-maro', 'Maro Engel'],
    ]);
    const [kolovos, engel] = file.drivers;
    expect(kolovos).toEqual({
      id: 'georgios-kolovos',
      name: 'Georgios Kolovos',
      country: 'Germany',
      entries: [],
      lineups: [{ seriesId: 'elms', team: 'PROTON COMPETITION', number: '9', class: 'LMP2' }],
      recent: [],
    });
    expect(engel!.country).toBe('Germany');
    expect(engel!.entries).toEqual([{ seriesId: 'gtwc-europe', pos: 1, points: 86 }]);
    // En el orden de la configuración.
    expect(engel!.lineups).toEqual([
      { seriesId: 'gtwc-europe', team: 'Mercedes - AMG Team MANN-FILTER', number: '48', vehicle: 'Mercedes-AMG GT3 EVO', class: 'Pro' },
      { seriesId: 'dtm', team: 'Mercedes-AMG Team Ravenol', number: '80', vehicle: 'Mercedes-AMG GT3' },
    ]);
  });

  it('sin listas de inscriptos no agrega el campo lineups', () => {
    const file = buildDrivers({
      series: [series('tc')],
      standings: [standings('tc', [{ title: 'Pilotos', rows: [{ pos: 1, name: 'Agustín CANAPINO', points: 347 }] }])],
      results: [],
      sessions: [],
      generatedAt: '2026-11-10T00:00:00Z',
    });
    expect(file.drivers[0]).not.toHaveProperty('lineups');
    expect(file.drivers[0]).not.toHaveProperty('country');
  });
});

describe('índice de equipos', () => {
  it('elige las tablas de equipos: constructores solo si no hay otra, nunca marcas', () => {
    const f1 = standings('f1', [{ title: 'Pilotos', rows: [] }, { title: 'Constructores', rows: [] }]);
    const motogp = standings('motogp', [{ title: 'Pilotos', rows: [] }, { title: 'Equipos', rows: [] }, { title: 'Constructores', rows: [] }]);
    const nascar = standings('nascar-cup', [{ title: 'Pilotos', rows: [] }, { title: 'Propietarios', rows: [] }, { title: 'Marcas', rows: [] }]);
    const igtc = standings('igtc', [{ title: 'Pilotos', rows: [] }, { title: 'Marcas', rows: [] }]);
    expect(teamTables(f1).map((t) => t.title)).toEqual(['Constructores']);
    expect(teamTables(motogp).map((t) => t.title)).toEqual(['Equipos']);
    expect(teamTables(nascar).map((t) => t.title)).toEqual(['Propietarios']);
    expect(teamTables(igtc)).toEqual([]);
  });

  it('nombres en mayúsculas legibles, sin el número de auto', () => {
    expect(teamDisplayName('PROTON COMPETITION')).toBe('Proton Competition');
    expect(teamDisplayName('AF CORSE')).toBe('AF Corse');
    expect(teamDisplayName('CROWDSTRIKE RACING BY APR')).toBe('Crowdstrike Racing by APR');
    expect(teamDisplayName('HEART OF RACING TEAM')).toBe('Heart of Racing Team');
    expect(teamDisplayName('Hendrick Motorsports #5')).toBe('Hendrick Motorsports');
    expect(teamDisplayName('TOYOTA GAZOO Racing YPF Infinia')).toBe('TOYOTA GAZOO Racing YPF Infinia');
  });

  it('une tablas de equipos, equipo de cada piloto y listas de inscriptos', () => {
    const input = {
      series: [series('nascar-cup'), series('gtwc-europe'), series('elms')],
      standings: [
        standings('nascar-cup', [
          { title: 'Pilotos', rows: [{ pos: 1, name: 'Kyle Larson', number: '5', points: 2000 }] },
          {
            title: 'Propietarios',
            rows: [
              { pos: 1, name: 'Hendrick Motorsports #5', points: 2000 },
              { pos: 4, name: 'Hendrick Motorsports #24', points: 1500 },
            ],
          },
          { title: 'Marcas', rows: [{ pos: 1, name: 'Chevrolet', points: 3000 }] },
        ]),
        standings('gtwc-europe', [
          { title: 'Equipos', rows: [{ pos: 3, name: 'Proton Competition', points: 100 }] },
          { title: 'Equipos Endurance Cup', rows: [{ pos: 5, name: 'Proton Competition', points: 50 }] },
          { title: 'Pilotos', rows: [{ pos: 1, name: 'Maro Engel', points: 86 }] },
        ]),
      ],
      results: [],
      sessions: [],
      rosters: [
        roster('gtwc-europe', [{ driver: 'Dennis OLSEN', team: 'Proton Competition', number: '911', vehicle: 'Porsche 911 GT3 R (992)', class: 'Pro' }]),
        roster('elms', [
          { driver: 'Georgios Kolovos', team: 'PROTON COMPETITION', number: '9', class: 'LMP2' },
          { driver: 'Sebastian Priaulx', team: 'PROTON COMPETITION', number: '9', class: 'LMP2' },
        ]),
      ],
      generatedAt: '2026-11-10T00:00:00Z',
    };
    const drivers = buildDrivers(input);
    const file = buildTeams({ ...input, drivers });
    expect(teamsFileSchema.parse(file)).toBeTruthy();
    expect(file.teams.map((t) => [t.id, t.name])).toEqual([
      ['hendrick-motorsports', 'Hendrick Motorsports'],
      ['proton-competition', 'Proton Competition'],
    ]);
    const [hendrick, proton] = file.teams;
    expect(hendrick!.entries).toEqual([{ seriesId: 'nascar-cup', pos: 1, points: 2000, numbers: ['5', '24'] }]);
    expect(proton!.entries).toEqual([
      // Números, autos y clases van en la línea de la primera tabla del equipo en esa categoría.
      { seriesId: 'gtwc-europe', table: 'Equipos', pos: 3, points: 100, numbers: ['911'], vehicles: ['Porsche 911 GT3 R (992)'], classes: ['Pro'] },
      { seriesId: 'gtwc-europe', table: 'Equipos Endurance Cup', pos: 5, points: 50 },
      { seriesId: 'elms', numbers: ['9'], classes: ['LMP2'] },
    ]);
    expect(proton!.drivers).toEqual([
      { id: 'dennis-olsen', name: 'Dennis Olsen', seriesId: 'gtwc-europe', number: '911' },
      { id: 'georgios-kolovos', name: 'Georgios Kolovos', seriesId: 'elms', number: '9' },
      { id: 'priaulx-sebastian', name: 'Sebastian Priaulx', seriesId: 'elms', number: '9' },
    ]);
  });
});
