/**
 * Corrida completa del pipeline:
 *   1. Carga las series (default + usuario + descubiertas).
 *   2. Lee el calendario y los cronogramas de cada serie habilitada (lector directo o flujo genérico).
 *   3. Valida, fusiona con la corrida anterior y detecta cambios de horario.
 *   4. Busca resultados de sesiones terminadas y actualiza campeonatos.
 *   5. Escribe data/schedule.json, data/status.json, data/results/**, data/standings/** y data/feeds/*.ics.
 *
 * Uso: npm run pipeline -- [--only=f1,motogp] [--skip-results] [--dry-run]
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  scheduleFileSchema,
  statusFileSchema,
  type ScheduleFile,
  type Series,
  type SeriesStatus,
  type StatusFile,
} from '@dm/shared';
import { adapters } from './adapters/index.ts';
import { genericAdapter } from './generic/index.ts';
import { loadConfig } from './core/config.ts';
import { createContext } from './core/context.ts';
import { buildFeed } from './core/feed.ts';
import { createLogger } from './core/log.ts';
import { mergeRun, type SeriesOutcome } from './core/merge.ts';
import { CACHE_DIR, DATA_DIR } from './core/paths.ts';
import { collectExistingResults, runResultsForSeries, type AttemptsLog } from './core/results.ts';
import { readJson, writeJson, writeText } from './core/store.ts';
import type { Adapter, AdapterContext } from './core/types.ts';
import { validateSessions } from './validate.ts';

export interface RunOptions {
  only?: string[];
  skipResults?: boolean;
  dryRun?: boolean;
  now?: Date;
  dataDir?: string;
  configDir?: string;
  concurrency?: number;
}

export function resolveAdapter(series: Series): Adapter {
  if (series.strategy === 'adapter') {
    const a = series.adapter ? adapters[series.adapter] : undefined;
    if (!a) throw new Error(`La serie ${series.id} indica el lector "${series.adapter}", que no existe`);
    return a;
  }
  return genericAdapter;
}

export async function run(opts: RunOptions = {}): Promise<{ schedule: ScheduleFile; status: StatusFile }> {
  const log = createLogger('pipeline');
  const dataDir = opts.dataDir ?? DATA_DIR;
  const cacheDir = opts.dataDir ? path.join(opts.dataDir, '_cache') : CACHE_DIR;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');

  const config = await loadConfig(opts.configDir, dataDir);
  const previous = await readJson(path.join(dataDir, 'schedule.json'), scheduleFileSchema);
  const previousStatus = await readJson(path.join(dataDir, 'status.json'), statusFileSchema);
  const prevStatusMap = new Map((previousStatus?.series ?? []).map((s) => [s.seriesId, s]));

  const ctx = createContext({
    now,
    durations: config.durations,
    broadcast: config.broadcast,
    previous,
    log,
    cacheDir,
  });

  const selected = config.series.filter((s) => !opts.only || opts.only.includes(s.id));
  const outcomes = new Map<string, SeriesOutcome>();

  // Con --only, las series no seleccionadas conservan sus datos anteriores tal cual.
  const untouched = opts.only ? config.series.filter((s) => !opts.only!.includes(s.id)) : [];

  await pool(selected, opts.concurrency ?? 4, async (series) => {
    if (!series.enabled) {
      outcomes.set(series.id, { kind: 'disabled' });
      return;
    }
    const slog = log.child(series.id);
    try {
      const adapter = resolveAdapter(series);
      const chunk = await adapter.schedule(series, { ...ctx, log: slog });
      const { valid, issues } = validateSessions(chunk.sessions, chunk.events);
      for (const i of issues) slog.warn(`Sesión descartada ${i.sessionId}: ${i.reason}`);
      outcomes.set(series.id, { kind: 'ok', chunk: { events: chunk.events, sessions: valid } });
      slog.info(`${chunk.events.length} eventos, ${valid.length} sesiones`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      slog.error(error.message);
      outcomes.set(series.id, { kind: 'error', error });
    }
  });

  const merged = mergeRun(selected, outcomes, previous, prevStatusMap, nowIso);
  for (const s of untouched) {
    merged.events.push(...(previous?.events ?? []).filter((e) => e.seriesId === s.id));
    merged.sessions.push(...(previous?.sessions ?? []).filter((x) => x.seriesId === s.id));
    const st = prevStatusMap.get(s.id);
    if (st) merged.statuses.push(st);
  }

  // Resultados y campeonatos
  const attemptsFile = path.join(cacheDir, 'results-attempts.json');
  const attempts = (await readJson<AttemptsLog>(attemptsFile)) ?? {};
  const withResults = await collectExistingResults(dataDir, merged.events);
  if (!opts.skipResults) {
    await pool(selected, opts.concurrency ?? 4, async (series) => {
      if (outcomes.get(series.id)?.kind !== 'ok') return;
      const slog = log.child(`${series.id}:resultados`);
      try {
        const out = await runResultsForSeries(
          series,
          resolveAdapter(series),
          { ...ctx, log: slog } as AdapterContext,
          merged.events.filter((e) => e.seriesId === series.id),
          merged.sessions
            .filter((s) => s.seriesId === series.id)
            .map((s) => ({ ...s, hasResults: s.hasResults || withResults.has(s.id) })),
          attempts,
          dataDir,
          !!opts.dryRun,
        );
        out.withResults.forEach((id) => withResults.add(id));
        const st = merged.statuses.find((x) => x.seriesId === series.id);
        if (st) st.standingsAvailable = out.standingsAvailable;
      } catch (err) {
        slog.error(`Resultados: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }
  for (const s of merged.sessions) if (withResults.has(s.id)) s.hasResults = true;

  const schedule: ScheduleFile = {
    version: 1,
    generatedAt: nowIso,
    series: config.series,
    events: merged.events,
    sessions: merged.sessions.sort((a, b) => a.startUtc.localeCompare(b.startUtc)),
  };
  const status: StatusFile = {
    version: 1,
    generatedAt: nowIso,
    series: sortStatuses(merged.statuses, config.series),
  };

  scheduleFileSchema.parse(schedule);
  statusFileSchema.parse(status);

  if (!opts.dryRun) {
    await writeJson(path.join(dataDir, 'schedule.json'), schedule);
    await writeJson(path.join(dataDir, 'status.json'), status);
    await writeJson(attemptsFile, attempts);
    await writeText(
      path.join(dataDir, 'feeds', 'deporte-motor.ics'),
      buildFeed(config.series, schedule.events, schedule.sessions, now),
    );
  }

  const counts = status.series.reduce<Record<string, number>>((acc, s) => {
    acc[s.state] = (acc[s.state] ?? 0) + 1;
    return acc;
  }, {});
  log.info(
    `Listo: ${schedule.events.length} eventos, ${schedule.sessions.length} sesiones. Estados: ${JSON.stringify(counts)}`,
  );
  return { schedule, status };
}

function sortStatuses(statuses: SeriesStatus[], series: Series[]): SeriesStatus[] {
  const order = new Map(series.map((s, i) => [s.id, i]));
  return [...statuses].sort((a, b) => (order.get(a.seriesId) ?? 999) - (order.get(b.seriesId) ?? 999));
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  });
  await Promise.all(workers);
}

function parseArgs(argv: string[]): RunOptions {
  const opts: RunOptions = {};
  for (const arg of argv) {
    if (arg.startsWith('--only=')) opts.only = arg.slice(7).split(',').filter(Boolean);
    else if (arg === '--skip-results') opts.skipResults = true;
    else if (arg === '--dry-run') opts.dryRun = true;
  }
  return opts;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  run(parseArgs(process.argv.slice(2))).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
