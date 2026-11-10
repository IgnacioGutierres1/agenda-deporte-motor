import path from 'node:path';
import { z } from 'zod';
import {
  discoveredFileSchema,
  seriesSchema,
  userSeriesConfigSchema,
  type DiscoveredFile,
  type Series,
  type UserSeriesConfig,
} from '@dm/shared';
import { readJson } from './store.ts';
import { CONFIG_DIR, DATA_DIR } from './paths.ts';
import type { BroadcastConfig, DurationsConfig } from './builders.ts';

const EMPTY_USER: UserSeriesConfig = { added: [], disabled: [], pinned: [], hidden: [] };

/**
 * Combina las series por defecto, las agregadas por el usuario y las descubiertas.
 * - Las agregadas por el usuario usan el flujo genérico salvo que indiquen otra cosa.
 * - Las descubiertas se incluyen salvo que estén ocultas; si están fijadas pasan a origin "user".
 * - Las desactivadas quedan con enabled = false (se listan, pero no se leen).
 */
export function mergeSeries(
  defaults: Series[],
  user: UserSeriesConfig,
  discovered: DiscoveredFile | null,
): Series[] {
  const byId = new Map<string, Series>();
  for (const s of defaults) byId.set(s.id, { ...s });

  for (const a of user.added) {
    byId.set(a.id, {
      group: 'otros',
      strategy: 'generic',
      enabled: true,
      ...byId.get(a.id),
      ...a,
      origin: 'user',
    } as Series);
  }

  for (const d of discovered?.items ?? []) {
    if (byId.has(d.seriesId) || user.hidden.includes(d.seriesId)) continue;
    byId.set(d.seriesId, {
      id: d.seriesId,
      name: d.name,
      shortName: d.name,
      group: 'otros',
      officialUrls: [d.officialUrl],
      strategy: 'generic',
      origin: user.pinned.includes(d.seriesId) ? 'user' : 'discovered',
      enabled: true,
    });
  }

  for (const id of user.disabled) {
    const s = byId.get(id);
    if (s) s.enabled = false;
  }
  for (const id of user.hidden) byId.delete(id);

  return [...byId.values()];
}

export interface LoadedConfig {
  series: Series[];
  durations: DurationsConfig;
  broadcast: BroadcastConfig;
  user: UserSeriesConfig;
}

export async function loadConfig(configDir = CONFIG_DIR, dataDir = DATA_DIR): Promise<LoadedConfig> {
  const defaults = await readJson(path.join(configDir, 'series.default.json'), z.array(seriesSchema));
  if (!defaults) throw new Error('Falta config/series.default.json');
  const user =
    (await readJson(path.join(configDir, 'series.user.json'), userSeriesConfigSchema)) ?? EMPTY_USER;
  const discovered = await readJson(path.join(dataDir, 'discovered.json'), discoveredFileSchema);
  const durations = stripMeta(await readJson<DurationsConfig>(path.join(configDir, 'durations.json')));
  const broadcast = stripMeta(await readJson<BroadcastConfig>(path.join(configDir, 'broadcast.ar.json')));
  return { series: mergeSeries(defaults, user, discovered), durations, broadcast, user };
}

function stripMeta<T extends object>(obj: T | null): T {
  if (!obj) return {} as T;
  const { $comment: _ignored, ...rest } = obj as Record<string, unknown>;
  return rest as T;
}
