/**
 * Fase de inscriptos: para cada serie con Series.rosterUrls, la receta del sitio (sin IA) lee la lista oficial
 * de pilotos, equipos, números y autos, y la publica en data/rosters/{id}.json. Las listas cambian poco: se
 * releen cada ROSTER_MAX_AGE_MS o cuando cambia el año. Cualquier error se registra y se conserva el archivo
 * anterior: nunca corta la corrida.
 */
import path from 'node:path';
import { driverKey, rosterFileSchema, teamKey, type RosterFile, type RosterRow, type Series } from '@dm/shared';
import { formula1Roster } from '../generic/formula1.ts';
import { findRecipe } from '../generic/recipes.ts';
import type { RosterFound, SiteRecipe } from '../generic/types.ts';
import type { Http } from './http.ts';
import type { Logger } from './log.ts';
import { seasonUrl, seriesForSeason } from './season.ts';
import { readJson, writeJson } from './store.ts';

export const ROSTER_MAX_AGE_MS = 3 * 24 * 3600_000;

/**
 * Lectores de inscriptos de series con adaptador propio (F1): no están en RECIPES porque el calendario y el
 * campeonato de esas series no pasan por el flujo genérico.
 */
const ROSTER_ONLY: SiteRecipe[] = [formula1Roster];

/** Receta que lee la lista de inscriptos de una URL de Series.rosterUrls. */
export function findRosterRecipe(url: string): SiteRecipe | undefined {
  return ROSTER_ONLY.find((r) => r.match(url)) ?? findRecipe(url);
}

/** true si hay que (re)leer la lista: no existe, tiene más de tres días o se leyó el año anterior. */
export function rosterStale(existing: Pick<RosterFile, 'updatedAt'> | null, now: Date): boolean {
  if (!existing) return true;
  const updated = new Date(existing.updatedAt);
  if (Number.isNaN(updated.getTime())) return true;
  return now.getTime() - updated.getTime() > ROSTER_MAX_AGE_MS || updated.getUTCFullYear() < now.getUTCFullYear();
}

export interface RostersContext {
  now: Date;
  season: number;
  http: Http;
  log: Logger;
  /**
   * Temporada vigente de una serie si no es el año en curso (Asian LMS: la 2026-27 sigue siendo 2026 en enero
   * de 2027). run.ts usa withSeriesSeason, la misma que el calendario y el campeonato.
   */
  seasonFor?(series: Series): Promise<number>;
}

/**
 * Lee la lista de una serie uniendo todas sus URL. null si ninguna está publicada todavía.
 * Lanza un error si alguna página no tiene el formato esperado o no hay receta para la URL.
 */
export async function readRoster(series: Series, ctx: RostersContext): Promise<RosterFile | null> {
  const current = (await ctx.seasonFor?.(series)) ?? ctx.season;
  const found: RosterFound[] = [];
  for (const url of (series.rosterUrls ?? []).map((u) => seasonUrl(u, current))) {
    const recipe = findRosterRecipe(url);
    if (!recipe?.roster) throw new Error(`No hay lector de inscriptos para ${url}`);
    const r = await recipe.roster(url, { season: current, series: seriesForSeason(series, current), http: ctx.http, now: ctx.now });
    if (r) found.push(r);
  }
  if (found.length === 0) return null;
  const season = Math.max(...found.map((f) => f.season ?? current));
  // Varias URL (o una lista con el mismo auto repetido): un piloto por auto.
  const rows = new Map<string, RosterRow>();
  for (const f of found.filter((x) => (x.season ?? current) === season)) {
    for (const r of f.rows) rows.set(`${driverKey(r.driver)}|${r.number ?? ''}|${teamKey(r.team ?? '')}`, r);
  }
  return rosterFileSchema.parse({
    seriesId: series.id,
    season,
    updatedAt: ctx.now.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    rows: [...rows.values()],
    source: found[0]!.source,
  });
}

/**
 * Actualiza las listas vencidas de las series dadas. Devuelve las leídas en esta corrida (para armar el índice
 * de pilotos aunque sea --dry-run).
 */
export async function runRosters(
  series: Series[],
  ctx: RostersContext,
  dataDir: string,
  dryRun: boolean,
  concurrency = 4,
): Promise<Map<string, RosterFile>> {
  const fresh = new Map<string, RosterFile>();
  const queue = series.filter((s) => s.enabled && (s.rosterUrls?.length ?? 0) > 0);
  const work = async (s: Series) => {
    const log = ctx.log.child(`${s.id}:inscriptos`);
    const file = path.join(dataDir, 'rosters', `${s.id}.json`);
    try {
      const existing = await readJson(file, rosterFileSchema).catch(() => null);
      if (!rosterStale(existing, ctx.now)) return;
      const roster = await readRoster(s, ctx);
      if (!roster) {
        log.info('Lista de inscriptos todavía no publicada');
        return;
      }
      if (roster.rows.length === 0) throw new Error('la lista de inscriptos está vacía');
      fresh.set(s.id, roster);
      if (!dryRun) await writeJson(file, roster);
      log.info(`${roster.rows.length} pilotos inscriptos (${roster.season}, lectura directa)`);
    } catch (err) {
      log.warn(`Inscriptos sin actualizar: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) await work(queue.shift()!);
  });
  await Promise.all(workers);
  return fresh;
}
