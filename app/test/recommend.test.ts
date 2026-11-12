import { describe, expect, it } from 'vitest';
import type { Driver, Team } from '@dm/shared';
import { recommend } from '../src/lib/recommend.ts';
import { NOW, scheduleFixture } from './helpers.ts';

const AR = 'America/Argentina/Buenos_Aires';

const drivers: Driver[] = [
  { id: 'julian-santero', name: 'Julián Santero', entries: [{ seriesId: 'tc', pos: 1, points: 512 }], recent: [] },
  { id: 'agustin-canapino', name: 'Agustín Canapino', entries: [{ seriesId: 'tc', pos: 3, points: 471 }], recent: [] },
];

const teams: Team[] = [
  {
    id: 'chevrolet',
    name: 'Chevrolet',
    entries: [{ seriesId: 'tc', numbers: ['8', '12'] }],
    drivers: [
      { id: 'agustin-canapino', name: 'Agustín Canapino', seriesId: 'tc', number: '8' },
      { id: 'otro-piloto', name: 'Otro Piloto', seriesId: 'tc', number: '12' },
    ],
  },
];

describe('recomendaciones', () => {
  it('a partir de lo seguido: equipo, compañeros, líderes, mismo grupo, este finde y circuitos', () => {
    const recs = recommend({
      schedule: scheduleFixture(),
      now: NOW,
      zone: AR,
      followedSeries: ['tc'],
      followedDrivers: [{ id: 'agustin-canapino', name: 'Agustín Canapino', seriesIds: ['tc'] }],
      drivers,
      teams,
    });
    expect(recs.map((r) => [r.kind, r.id, r.reason])).toEqual([
      ['team', 'chevrolet', 'Equipo de Agustín Canapino'],
      ['driver', 'otro-piloto', 'Compañero de Canapino en TC'],
      ['driver', 'julian-santero', 'Líder de TC'],
      ['series', 'tc-pista', 'Porque seguís TC'],
      ['series', 'turismo-nacional', 'Porque seguís TC'],
      ['series', 'motogp', 'Corre este finde'],
      ['series', 'copa-truck', 'Corre este finde'],
      ['circuit', 'san-nicolas', 'Próxima fecha de TC'],
    ]);
    expect(recs.at(-1)!.title).toContain('también TC Pista');
    expect(recs.at(-1)!.to).toBe('/circuito/san-nicolas');
  });

  it('sin nada seguido sugiere lo que corre este finde, sin repetir ni incluir ocultas o deshabilitadas', () => {
    const recs = recommend({ schedule: scheduleFixture(), now: NOW, zone: AR, followedSeries: [], followedDrivers: [], hiddenSeries: ['motogp'] });
    expect(recs.every((r) => r.reason === 'Corre este finde')).toBe(true);
    expect(recs.map((r) => r.id)).not.toContain('motogp');
    expect(recs).toHaveLength(3);
    expect(new Set(recs.map((r) => r.id)).size).toBe(recs.length);
  });

  it('no recomienda lo que ya se sigue y respeta el límite', () => {
    const recs = recommend({
      schedule: scheduleFixture(),
      now: NOW,
      zone: AR,
      followedSeries: ['tc', 'tc-pista', 'motogp'],
      followedDrivers: [{ id: 'julian-santero', name: 'Julián Santero', seriesIds: ['tc'] }],
      drivers,
      limit: 2,
    });
    expect(recs).toHaveLength(2);
    for (const r of recs) expect(['tc', 'tc-pista', 'motogp', 'julian-santero']).not.toContain(r.id);
  });

  it('sin agenda no hay recomendaciones', () => {
    expect(recommend({ schedule: null, now: NOW, zone: AR, followedSeries: ['tc'], followedDrivers: [] })).toEqual([]);
  });
});
