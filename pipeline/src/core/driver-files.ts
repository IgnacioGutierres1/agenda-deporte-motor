/**
 * Archivos de pilotos y equipos que publica el pipeline:
 *  - data/drivers-index.json: índice liviano (sin las últimas carreras) para buscar, listar, recomendar y seguir.
 *  - data/drivers/{shard}.json: fichas completas agrupadas por un hash del id (256 grupos de ~8 pilotos),
 *    para que la ficha de un piloto baje unos pocos KB. Sin fecha de generación: un grupo solo se reescribe
 *    si cambió alguno de sus pilotos (cada corrida commitea data/, así no se tocan cientos de archivos).
 *  - data/drivers.json y data/teams.json: completos, como antes (versiones viejas de la app los leen).
 * Todos van con un elemento por renglón: más livianos que con sangría y con diffs legibles en git.
 */
import { readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  driverShard,
  driverShardFileSchema,
  driversFileSchema,
  driversIndexFileSchema,
  teamsFileSchema,
  type Driver,
  type DriverShardFile,
  type DriversFile,
  type DriversIndexFile,
  type TeamsFile,
} from '@dm/shared';
import { writeText } from './store.ts';

/**
 * JSON con un elemento de la lista por renglón:
 * {"version":1,"generatedAt":"…","drivers":[
 * {…},
 * {…}
 * ]}
 */
export function stringifyList(head: Record<string, unknown>, key: string, items: unknown[]): string {
  const prefix = JSON.stringify({ ...head, [key]: [] }).slice(0, -3);
  if (!items.length) return `${prefix}[]}\n`;
  return `${prefix}[\n${items.map((i) => JSON.stringify(i)).join(',\n')}\n]}\n`;
}

/** Índice liviano: cada piloto sin sus últimas carreras. */
export function driversIndex(file: DriversFile): DriversIndexFile {
  return {
    version: 1,
    generatedAt: file.generatedAt,
    drivers: file.drivers.map(({ recent: _r, ...d }): Driver => d),
  };
}

/** Fichas completas agrupadas por shard ("00" … "ff"), cada grupo ordenado por id. */
export function driverShards(file: DriversFile): Map<string, DriverShardFile> {
  const out = new Map<string, DriverShardFile>();
  for (const d of [...file.drivers].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const key = driverShard(d.id);
    let shard = out.get(key);
    if (!shard) out.set(key, (shard = { version: 1, drivers: [] }));
    shard.drivers.push(d);
  }
  return out;
}

export interface DriverFilesStats {
  /** Grupos de fichas escritos (nuevos o con cambios). */
  written: number;
  /** Grupos que ya estaban iguales. */
  unchanged: number;
  /** Grupos que quedaron vacíos y se borraron. */
  removed: number;
}

/** Escribe solo si el contenido cambió (devuelve true si escribió). */
async function writeIfChanged(file: string, content: string): Promise<boolean> {
  const current = await readFile(file, 'utf8').catch(() => null);
  if (current === content) return false;
  await writeText(file, content);
  return true;
}

/** Valida y escribe drivers.json, drivers-index.json, drivers/*.json y teams.json. */
export async function writeDriverFiles(dataDir: string, drivers: DriversFile, teams: TeamsFile): Promise<DriverFilesStats> {
  const index = driversIndex(drivers);
  const shards = driverShards(drivers);
  driversFileSchema.parse(drivers);
  driversIndexFileSchema.parse(index);
  teamsFileSchema.parse(teams);
  for (const shard of shards.values()) driverShardFileSchema.parse(shard);

  const head = { version: 1, generatedAt: drivers.generatedAt };
  await writeText(path.join(dataDir, 'drivers.json'), stringifyList(head, 'drivers', drivers.drivers));
  await writeText(path.join(dataDir, 'drivers-index.json'), stringifyList(head, 'drivers', index.drivers));
  await writeText(path.join(dataDir, 'teams.json'), stringifyList({ version: 1, generatedAt: teams.generatedAt }, 'teams', teams.teams));

  const dir = path.join(dataDir, 'drivers');
  const stats: DriverFilesStats = { written: 0, unchanged: 0, removed: 0 };
  for (const [key, shard] of shards) {
    if (await writeIfChanged(path.join(dir, `${key}.json`), stringifyList({ version: 1 }, 'drivers', shard.drivers))) stats.written++;
    else stats.unchanged++;
  }
  // Grupos que quedaron sin pilotos (o archivos de otro formato): se borran.
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const key = name.replace(/\.json$/, '');
    if (shards.has(key) && name.endsWith('.json')) continue;
    await rm(path.join(dir, name), { force: true });
    stats.removed++;
  }
  return stats;
}
