import { describe, expect, it } from 'vitest';
import type { RosterRow, StandingsFile } from '@dm/shared';
import { countryFlag, countryName, groupRoster, rosterClasses, rosterFromStandings } from '../src/lib/roster.ts';
import { fixture } from './helpers.ts';

const rows: RosterRow[] = [
  { driver: 'Dries VANTHOOR', team: 'BMW M Team WRT', number: '20', vehicle: 'BMW M Hybrid V8', class: 'Hypercar', country: 'BE' },
  { driver: 'Raffaele Marciello', team: 'BMW M Team WRT', number: '20', vehicle: 'BMW M Hybrid V8', class: 'Hypercar' },
  { driver: 'Kevin Magnussen', team: 'BMW M Team WRT', number: '15', vehicle: 'BMW M Hybrid V8', class: 'Hypercar' },
  { driver: 'Valentino Rossi', team: 'Team WRT', number: '46', vehicle: 'BMW M4 LMGT3', class: 'LMGT3', country: 'Italy' },
  { driver: 'Augusto Farfus', team: 'TEAM WRT #46', number: '46', class: 'LMGT3' },
  { driver: 'Sin Equipo', number: '99', class: 'LMGT3' },
];

describe('plantel', () => {
  it('agrupa por equipo y por auto, en el orden de la lista', () => {
    const groups = groupRoster(rows);
    expect(groups.map((g) => g.name)).toEqual(['BMW M Team WRT', 'Team WRT', '']);
    const wrt = groups[0]!;
    expect(wrt.teamId).toBe('bmw-m-team-wrt');
    expect(wrt.cars.map((c) => c.number)).toEqual(['20', '15']);
    expect(wrt.cars[0]!.drivers).toEqual([
      { name: 'Dries Vanthoor', id: 'dries-vanthoor', country: 'BE' },
      { name: 'Raffaele Marciello', id: 'marciello-raffaele' },
    ]);
    // "Team WRT" y "TEAM WRT #46" son el mismo equipo y el mismo auto.
    expect(groups[1]!.cars).toHaveLength(1);
    expect(groups[1]!.cars[0]!.drivers.map((d) => d.name)).toEqual(['Valentino Rossi', 'Augusto Farfus']);
    expect(groups[1]!.cars[0]!.vehicle).toBe('BMW M4 LMGT3');
  });

  it('filtra por clase', () => {
    expect(rosterClasses(rows)).toEqual(['Hypercar', 'LMGT3']);
    const gt3 = groupRoster(rows, 'LMGT3');
    expect(gt3.flatMap((g) => g.cars.map((c) => c.number))).toEqual(['46', '99']);
  });

  it('sin lista de inscriptos usa la tabla de pilotos (no la de marcas)', () => {
    const { rows: fromTable, teams } = rosterFromStandings(fixture<StandingsFile>('standings/tc.json'));
    expect(fromTable.map((r) => r.driver)).toEqual(['Julián Santero', 'Mariano Werner', 'Agustín Canapino']);
    expect(fromTable[0]).toEqual({ driver: 'Julián Santero', team: 'Ford', number: '1' });
    expect(teams).toEqual([]);
  });

  it('con varias tablas de pilotos, el título es la clase; las tablas de equipos dan los equipos', () => {
    const standings: StandingsFile = {
      seriesId: 'tn',
      season: 2026,
      updatedAt: '2026-11-10T00:00:00Z',
      tables: [
        { title: 'Clase 2', rows: [{ pos: 1, name: 'A Uno', points: 10 }] },
        { title: 'Clase 3', rows: [{ pos: 1, name: 'B Dos', points: 10 }] },
        { title: 'Equipos', rows: [{ pos: 1, name: 'Salvita Racing', points: 10 }] },
        { title: 'Marcas', rows: [{ pos: 1, name: 'Toyota', points: 10 }] },
      ],
      source: { url: 'https://example.org', title: 'x', kind: 'html', method: 'directo', fetchedAt: '2026-11-10T00:00:00Z' },
    };
    const out = rosterFromStandings(standings);
    expect(rosterClasses(out.rows)).toEqual(['Clase 2', 'Clase 3']);
    expect(out.teams).toEqual(['Salvita Racing']);
  });

  it('bandera por código ISO o nombre en inglés', () => {
    expect(countryFlag('AR')).toBe('🇦🇷');
    expect(countryFlag('Argentina')).toBe('🇦🇷');
    expect(countryFlag(undefined)).toBe('');
    expect(countryName('it')).toBe('Italia');
    expect(countryName('Argentina')).toBe('Argentina');
  });
});

describe('países en castellano', () => {
  it('traduce nombres en inglés y códigos, con bandera', async () => {
    const { countryName, countryFlag } = await import('../src/lib/roster.ts');
    expect(countryName('Germany')).toBe('Alemania');
    expect(countryName('Great Britain')).toBe('Reino Unido');
    expect(countryName('IT')).toBe('Italia');
    expect(countryFlag('France')).toBe('🇫🇷');
    expect(countryName('Atlantis')).toBe('Atlantis');
    expect(countryFlag('Atlantis')).toBe('');
  });
});
