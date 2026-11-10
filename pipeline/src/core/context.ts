import type { ScheduleFile } from '@dm/shared';
import { createBuilders, type BroadcastConfig, type DurationsConfig } from './builders.ts';
import { createHttp, type Http } from './http.ts';
import { createLogger, type Logger } from './log.ts';
import { CACHE_DIR } from './paths.ts';
import type { AdapterContext } from './types.ts';

export interface ContextOptions {
  now?: Date;
  horizonDays?: number;
  durations?: DurationsConfig;
  broadcast?: BroadcastConfig;
  previous?: ScheduleFile | null;
  http?: Http;
  log?: Logger;
  cacheDir?: string;
}

export function createContext(opts: ContextOptions = {}): AdapterContext {
  const now = opts.now ?? new Date();
  return {
    now,
    season: now.getUTCFullYear(),
    horizonDays: opts.horizonDays ?? 21,
    http: opts.http ?? createHttp(),
    log: opts.log ?? createLogger(),
    build: createBuilders(opts.durations ?? {}, opts.broadcast ?? {}),
    previous: opts.previous ?? null,
    cacheDir: opts.cacheDir ?? CACHE_DIR,
  };
}
