import { describe, expect, it } from 'vitest';
import { driversFileSchema, type EventResultsFile, type Series, type Session, type Source, type StandingsFile } from '@dm/shared';
import { buildDrivers } from '../src/core/drivers.ts';

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
  it('une a un piloto entre categorías, ignora tablas de equipos y tripulaciones, y guarda sus últimas carreras', () => {
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
