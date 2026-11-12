import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  driverShard,
  driverShardFileSchema,
  driversFileSchema,
  driversIndexFileSchema,
  teamsFileSchema,
  type DriversFile,
  type TeamsFile,
} from '@dm/shared';
import { driverShards, driversIndex, stringifyList, writeDriverFiles } from '../src/core/driver-files.ts';

const drivers: DriversFile = {
  version: 1,
  generatedAt: '2026-11-10T00:00:00Z',
  drivers: [
    {
      id: 'agustin-canapino',
      name: 'Agustín Canapino',
      entries: [{ seriesId: 'tc', pos: 1, points: 347, number: '1' }],
      recent: [{ seriesId: 'tc', eventId: 'e1', sessionId: 's1', startUtc: '2026-11-01T17:00:00Z', pos: 2 }],
    },
    {
      id: 'max-verstappen',
      name: 'Max Verstappen',
      country: 'NED',
      entries: [{ seriesId: 'f1', pos: 3, points: 300, team: 'Red Bull' }],
      lineups: [{ seriesId: 'f1', team: 'Red Bull', number: '1', vehicle: 'RB22' }],
      recent: [],
    },
    { id: 'julian-santero', name: 'Julián Santero', entries: [{ seriesId: 'tc', pos: 2, points: 300 }], recent: [] },
  ],
};
const teams: TeamsFile = { version: 1, generatedAt: '2026-11-10T00:00:00Z', teams: [{ id: 'red-bull', name: 'Red Bull', entries: [{ seriesId: 'f1' }], drivers: [] }] };

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = '';
});

describe('archivos de pilotos', () => {
  it('JSON con un elemento por renglón, válido y más liviano que con sangría', () => {
    const text = stringifyList({ version: 1, generatedAt: drivers.generatedAt }, 'drivers', drivers.drivers);
    expect(JSON.parse(text)).toEqual(drivers);
    expect(text.split('\n')).toHaveLength(drivers.drivers.length + 3);
    expect(text.length).toBeLessThan(JSON.stringify(drivers, null, 2).length);
    expect(JSON.parse(stringifyList({ version: 1 }, 'drivers', []))).toEqual({ version: 1, drivers: [] });
  });

  it('el índice no trae las últimas carreras (y pasa el esquema estricto)', () => {
    const index = driversIndex(drivers);
    expect(index.drivers.every((d) => !('recent' in d))).toBe(true);
    const { recent: _r, ...verstappen } = drivers.drivers[1]!;
    expect(index.drivers[1]).toEqual(verstappen);
    expect(driversIndexFileSchema.parse(index)).toBeTruthy();
    // Con las últimas carreras no pasa: el índice tiene que seguir siendo liviano.
    expect(() => driversIndexFileSchema.parse(drivers)).toThrow();
  });

  it('agrupa las fichas completas por shard, ordenadas por id', () => {
    const shards = driverShards(drivers);
    const all = [...shards.values()].flatMap((s) => s.drivers);
    expect(all).toHaveLength(3);
    for (const [key, shard] of shards) {
      expect(driverShardFileSchema.parse(shard)).toBeTruthy();
      expect(shard.drivers.every((d) => driverShard(d.id) === key)).toBe(true);
      expect(shard.drivers.map((d) => d.id)).toEqual(shard.drivers.map((d) => d.id).sort());
    }
    expect(shards.get(driverShard('agustin-canapino'))!.drivers.find((d) => d.id === 'agustin-canapino')!.recent).toHaveLength(1);
  });

  it('escribe índice, fichas y archivos completos; solo reescribe los grupos que cambiaron y borra los vacíos', async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'dm-drivers-'));
    const first = await writeDriverFiles(dir, drivers, teams);
    const shardCount = driverShards(drivers).size;
    expect(first).toEqual({ written: shardCount, unchanged: 0, removed: 0 });
    expect(driversFileSchema.parse(JSON.parse(await readFile(path.join(dir, 'drivers.json'), 'utf8')))).toEqual(drivers);
    expect(teamsFileSchema.parse(JSON.parse(await readFile(path.join(dir, 'teams.json'), 'utf8')))).toEqual(teams);
    const index = driversIndexFileSchema.parse(JSON.parse(await readFile(path.join(dir, 'drivers-index.json'), 'utf8')));
    expect(index.drivers.map((d) => d.id)).toEqual(drivers.drivers.map((d) => d.id));

    // Otra corrida (otra fecha de generación) con un solo piloto cambiado: un solo grupo se reescribe.
    const canapinoFile = path.join(dir, 'drivers', `${driverShard('agustin-canapino')}.json`);
    const verstappenFile = path.join(dir, 'drivers', `${driverShard('max-verstappen')}.json`);
    const before = (await stat(verstappenFile)).mtimeMs;
    await writeFile(path.join(dir, 'drivers', 'zz.json'), '{}'); // grupo viejo que ya no existe
    const next: DriversFile = {
      ...drivers,
      generatedAt: '2026-11-11T00:00:00Z',
      drivers: drivers.drivers.map((d) => (d.id === 'agustin-canapino' ? { ...d, entries: [{ ...d.entries[0]!, points: 360 }] } : d)),
    };
    const second = await writeDriverFiles(dir, next, teams);
    expect(second).toEqual({ written: 1, unchanged: shardCount - 1, removed: 1 });
    expect(JSON.parse(await readFile(canapinoFile, 'utf8')).drivers.find((d: { id: string }) => d.id === 'agustin-canapino').entries[0].points).toBe(360);
    if (driverShard('max-verstappen') !== driverShard('agustin-canapino')) expect((await stat(verstappenFile)).mtimeMs).toBe(before);
    expect((await readdir(path.join(dir, 'drivers'))).sort()).toEqual([...driverShards(next).keys()].map((k) => `${k}.json`).sort());
  });
});
