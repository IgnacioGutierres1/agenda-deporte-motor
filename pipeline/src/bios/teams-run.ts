/**
 * Paso del pipeline para el historial de equipos y categorías:
 *   data/bios/series.json  (SeriesHistoryFile, ver series.ts)
 *   data/bios/teams.json   (TeamBiosFile, ver teams.ts)
 *
 * - Incremental: cada corrida consulta solo lo nuevo o vencido, con tope (SERIES_PER_RUN categorías y
 *   TEAMS_PER_RUN equipos). Las categorías se vuelven a leer cada 30 días (cada 7 si a la lista le falta el
 *   campeón de la temporada pasada) o cuando cambia su entrada en config/series-history.json; los equipos
 *   identificados, cada 90 días; los no identificados, cada 45; los corregidos a mano en config/team-bios.json,
 *   en cuanto cambia la corrección.
 * - Lo que se consultó de cada equipo (elemento elegido o ninguno, cómo, artículos) queda en
 *   data/_cache/bios-teams.json: así un equipo sin elemento no se vuelve a buscar en cada corrida.
 * - Los títulos de cada equipo salen de las listas de campeones (champion.teamId) y se recalculan siempre.
 * - Nunca lanza: ante un corte de Wikimedia (429/403) se guarda lo avanzado y el resto queda para la próxima.
 *
 * Uso manual (llenado inicial, sin tope): npx tsx pipeline/src/bios/teams-run.ts [--force] [--only=f1,ferrari]
 *   [--series-only | --teams-only] [--limit=N] [--dry-run] [--cache=carpeta]
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  driversIndexFileSchema,
  seriesHistoryFileSchema,
  seriesSchema,
  teamBiosFileSchema,
  teamsFileSchema,
  type SeriesHistory,
  type SeriesHistoryFile,
  type TeamBio,
  type TeamBiosFile,
} from '@dm/shared';
import { z } from 'zod';
import { createApi, type Api, type ResponseCache } from '../circuits/api.ts';
import type { Http } from '../core/http.ts';
import { createLogger, type Logger } from '../core/log.ts';
import { CONFIG_DIR, DATA_DIR } from '../core/paths.ts';
import { readJson, writeJson } from '../core/store.ts';
import { buildSeriesHistories, linkDriver, linkTeam, loadSeriesHistoryConfig, type AppIndex, type SeriesHistorySpec } from './series.ts';
import {
  buildTeamBios,
  chooseItem,
  fetchCandidates,
  findCandidates,
  indexCandidates,
  PRIORITY_SERIES,
  titlesFor,
  type MatchHow,
  type TeamInput,
} from './teams.ts';
import { getItems, type WdItem } from './wd.ts';

/** Categorías por corrida (cada una, 1 a 4 páginas de Wikipedia). */
export const SERIES_PER_RUN = 6;
/** Equipos por corrida (se consultan en bloque: unas 15 requests para 60 equipos). */
export const TEAMS_PER_RUN = 60;
const SERIES_MAX_AGE_DAYS = 30;
const SERIES_STALE_DAYS = 7;
const TEAM_MAX_AGE_DAYS = 90;
const TEAM_UNMATCHED_DAYS = 45;
/** Una ficha de un equipo que ya no está en data/teams.json se conserva este tiempo (puede volver). */
const ORPHAN_DAYS = 365;
const DAY = 86_400_000;

// ── Caché de lo consultado ──

const teamCacheSchema = z.object({
  checkedAt: z.string(),
  wikidata: z.string().nullable(),
  how: z.string().optional(),
  eswiki: z.string().optional(),
  enwiki: z.string().optional(),
});
const cacheFileSchema = z.object({
  teams: z.record(teamCacheSchema).default({}),
  series: z.record(z.object({ checkedAt: z.string(), hash: z.string() })).default({}),
});
export type BiosCache = z.infer<typeof cacheFileSchema>;

export interface RunBiosOptions {
  log: Logger;
  /** Cliente HTTP (tests). Por defecto, uno propio sin reintentos automáticos (ver circuits/api.ts). */
  http?: Http;
  now?: Date;
  dataDir?: string;
  configDir?: string;
  dryRun?: boolean;
  /** Nombres de las categorías (para los títulos de los equipos). */
  seriesNames?: Map<string, string>;
  seriesLimit?: number;
  teamLimit?: number;
  /** Volver a consultar todo, aunque no haya vencido. */
  force?: boolean;
  /** Solo estos ids (de categoría o de equipo), aunque no hayan vencido. */
  only?: string[];
  skipSeries?: boolean;
  skipTeams?: boolean;
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  cache?: ResponseCache;
}

export interface RunBiosResult {
  series: string[];
  teams: Array<{ id: string; name: string; wikidata: string | null; how?: string }>;
  pendingSeries: number;
  pendingTeams: number;
  requests: number;
  error?: string;
}

function toIso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function specHash(spec: SeriesHistorySpec): string {
  return createHash('sha1').update(JSON.stringify(spec)).digest('hex').slice(0, 12);
}

/** Actualiza data/bios/series.json y data/bios/teams.json. Nunca lanza. */
export async function runTeamBios(opts: RunBiosOptions): Promise<RunBiosResult | null> {
  try {
    return await update(opts);
  } catch (err) {
    opts.log.error(`Historial de equipos y categorías: ${err instanceof Error ? err.message : String(err)}; se conservan los archivos`);
    return null;
  }
}

async function update(opts: RunBiosOptions): Promise<RunBiosResult> {
  const { log } = opts;
  const now = opts.now ?? new Date();
  const nowIso = toIso(now);
  const dataDir = opts.dataDir ?? DATA_DIR;
  const configDir = opts.configDir ?? CONFIG_DIR;
  const seriesFile = path.join(dataDir, 'bios', 'series.json');
  const teamsFile = path.join(dataDir, 'bios', 'teams.json');
  const cacheFile = path.join(dataDir, '_cache', 'bios-teams.json');

  const config = await loadSeriesHistoryConfig(configDir);
  const overrides = await loadTeamOverrides(configDir);
  const seriesNames = opts.seriesNames ?? (await loadSeriesNames(configDir));
  const appTeams = (await readJson(path.join(dataDir, 'teams.json'), teamsFileSchema).catch(() => null))?.teams ?? [];
  const driversIndex = await readJson(path.join(dataDir, 'drivers-index.json'), driversIndexFileSchema).catch(() => null);
  const cache: BiosCache = cacheFileSchema.parse((await readJson(cacheFile).catch(() => null)) ?? {});
  const prevSeries = await readJson(seriesFile, seriesHistoryFileSchema).catch((err) => {
    log.warn(`data/bios/series.json ilegible, se ignora: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });
  const prevTeams = await readJson(teamsFile, teamBiosFileSchema).catch((err) => {
    log.warn(`data/bios/teams.json ilegible, se ignora: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  });

  const seriesById = new Map((prevSeries?.series ?? []).map((s) => [s.seriesId, s]));
  const bioById = new Map((prevTeams?.teams ?? []).map((t) => [t.id, t]));
  const index: AppIndex = {
    drivers: new Set((driversIndex?.drivers ?? []).map((d) => d.id)),
    teams: appTeams.map((t) => ({ id: t.id, name: t.name, series: [...new Set(t.entries.map((e) => e.seriesId))] })),
    teamArticles: teamArticles(cache),
  };

  let api: Api | undefined;
  const getApi = () => (api ??= createApi({ http: opts.http, log, pauseMs: opts.pauseMs, sleep: opts.sleep, cache: opts.cache }));
  let error: string | undefined;
  const result: RunBiosResult = { series: [], teams: [], pendingSeries: 0, pendingTeams: 0, requests: 0 };
  let seriesChanged = false;
  let teamsChanged = false;

  // ── Equipos ──
  if (!opts.skipTeams) {
    const priority = (t: TeamInput) => {
      const ranks = t.series.map((s) => PRIORITY_SERIES.indexOf(s)).filter((r) => r >= 0);
      return ranks.length ? Math.min(...ranks) : PRIORITY_SERIES.length;
    };
    const isDue = (t: TeamInput): boolean => {
      if (opts.only) return opts.only.includes(t.id);
      const seen = cache.teams[t.id];
      if (!seen || opts.force) return true;
      if (t.id in overrides && (overrides[t.id] ?? null) !== seen.wikidata) return true;
      const age = now.getTime() - Date.parse(seen.checkedAt);
      return age > (seen.wikidata ? TEAM_MAX_AGE_DAYS : TEAM_UNMATCHED_DAYS) * DAY;
    };
    const due = index.teams
      .filter(isDue)
      .sort((a, b) => priority(a) - priority(b) || (cache.teams[a.id]?.checkedAt ?? '').localeCompare(cache.teams[b.id]?.checkedAt ?? '') || a.id.localeCompare(b.id));
    const limit = opts.teamLimit ?? TEAMS_PER_RUN;
    const selected = limit > 0 ? due.slice(0, limit) : due;
    if (selected.length) {
      try {
        const done = await resolveTeams(getApi(), selected, overrides, cache, config, opts.force ?? false, log);
        const picks = done.filter((d) => d.wikidata).map((d) => ({ id: d.team.id, qid: d.wikidata! }));
        const seriesByQid = new Map(Object.entries(config).flatMap(([id, s]) => (s.wikidata ? [[s.wikidata, { id, name: seriesNames.get(id) ?? id }]] : [])));
        const bios = await buildTeamBios(getApi(), picks, done.items, { nowIso, seriesByQid });
        const bioOf = new Map(bios.map((b) => [b.id, b]));
        for (const d of done) {
          const item = d.wikidata ? done.items.get(d.wikidata) : undefined;
          cache.teams[d.team.id] = {
            checkedAt: nowIso,
            wikidata: d.wikidata,
            ...(d.how ? { how: d.how } : {}),
            ...(item?.eswiki ? { eswiki: item.eswiki } : {}),
            ...(item?.enwiki ? { enwiki: item.enwiki } : {}),
          };
          const bio = bioOf.get(d.team.id);
          if (bio) bioById.set(d.team.id, bio);
          else if (!d.wikidata) bioById.delete(d.team.id);
          result.teams.push({ id: d.team.id, name: d.team.name, wikidata: d.wikidata, ...(d.how ? { how: d.how } : {}) });
        }
        teamsChanged = true;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        log.error(`Se corta la consulta de equipos: ${error}`);
      }
    }
    result.pendingTeams = due.length - result.teams.length;
  }

  // ── Categorías ──
  if (!opts.skipSeries && !error) {
    // Con las fichas nuevas, los campeones se vinculan también por el artículo enlazado.
    index.teamArticles = teamArticles(cache);
    const isDue = ([id, spec]: [string, SeriesHistorySpec]): boolean => {
      if (opts.only) return opts.only.includes(id);
      const seen = cache.series[id];
      if (!seen || opts.force || seen.hash !== specHash(spec) || !seriesById.has(id)) return true;
      const age = now.getTime() - Date.parse(seen.checkedAt);
      const last = seriesById.get(id)?.champions[0]?.season ?? 0;
      return age > SERIES_MAX_AGE_DAYS * DAY || (last < now.getUTCFullYear() - 1 && age > SERIES_STALE_DAYS * DAY);
    };
    const due = Object.entries(config)
      .filter(isDue)
      .sort((a, b) => (cache.series[a[0]]?.checkedAt ?? '').localeCompare(cache.series[b[0]]?.checkedAt ?? ''));
    const limit = opts.seriesLimit ?? SERIES_PER_RUN;
    const selected = limit > 0 ? due.slice(0, limit) : due;
    // De a tres: cada tanda terminada queda guardada aunque la siguiente se corte.
    for (let i = 0; i < selected.length; i += 3) {
      const chunk = selected.slice(i, i + 3);
      try {
        const built = await buildSeriesHistories(getApi(), chunk, { nowIso, index }, (m) => log.warn(m));
        for (const h of built) {
          seriesById.set(h.seriesId, keepIfEmpty(seriesById.get(h.seriesId), h));
          cache.series[h.seriesId] = { checkedAt: nowIso, hash: specHash(config[h.seriesId]!) };
          result.series.push(h.seriesId);
        }
        seriesChanged = true;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        log.error(`Se corta la consulta de categorías: ${error}`);
        break;
      }
    }
    result.pendingSeries = due.length - result.series.length;
  }

  // Las listas guardadas se vuelven a vincular con los equipos de la app (pueden haber aparecido equipos nuevos).
  const seriesList = [...seriesById.values()].sort((a, b) => a.seriesId.localeCompare(b.seriesId));
  if (relinkChampions(seriesList, index)) seriesChanged = true;

  // Títulos de cada equipo (de las listas de campeones) y fichas solo con títulos.
  const inApp = new Set(appTeams.map((t) => t.id));
  const titled = new Set(seriesList.flatMap((s) => s.champions.map((c) => c.teamId).filter((x): x is string => !!x)));
  for (const id of titled) if (!bioById.has(id) && inApp.has(id)) bioById.set(id, { id, updatedAt: nowIso });
  const teamsOut: TeamBio[] = [];
  for (const bio of [...bioById.values()].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!inApp.has(bio.id) && now.getTime() - Date.parse(bio.updatedAt) > ORPHAN_DAYS * DAY) continue;
    const titles = titlesFor(bio.id, seriesList, seriesNames);
    const next: TeamBio = { ...bio };
    delete next.titles;
    if (titles.length) next.titles = titles;
    if (Object.keys(next).length <= 2 && !titles.length) continue; // sin nada que mostrar
    teamsOut.push(ordered(next));
  }
  const titlesChanged = JSON.stringify(teamsOut) !== JSON.stringify(prevTeams?.teams ?? []);

  if (!opts.dryRun) {
    if (seriesChanged) {
      const file: SeriesHistoryFile = { version: 1, generatedAt: nowIso, series: seriesList };
      seriesHistoryFileSchema.parse(file);
      await writeJson(seriesFile, file);
    }
    if (teamsChanged || titlesChanged) {
      const file: TeamBiosFile = { version: 1, generatedAt: nowIso, teams: teamsOut };
      teamBiosFileSchema.parse(file);
      await writeJson(teamsFile, file);
    }
    if (seriesChanged || teamsChanged) await writeJson(cacheFile, sortedCache(cache));
  }

  result.requests = api?.requests ?? 0;
  if (error) result.error = error;
  const withLogo = teamsOut.filter((t) => t.logo).length;
  log.info(
    `Categorías: ${result.series.length} leídas, ${result.pendingSeries} pendientes, ${seriesList.filter((s) => s.champions.length).length} con campeones. ` +
      `Equipos: ${result.teams.length} consultados (${result.teams.filter((t) => t.wikidata).length} identificados), ${result.pendingTeams} pendientes; ` +
      `${teamsOut.length} fichas, ${withLogo} con logo` +
      (api ? ` (${api.requests} requests)` : ''),
  );
  return result;
}

/** Una lectura que no trajo campeones (página caída o tabla movida) no borra la lista anterior. */
function keepIfEmpty(prev: SeriesHistory | undefined, next: SeriesHistory): SeriesHistory {
  if (!prev || next.champions.length) return next;
  return { ...next, champions: prev.champions, ...(prev.records ? { records: prev.records } : {}), ...(prev.championsSource ? { championsSource: prev.championsSource } : {}) };
}

interface Resolved {
  team: TeamInput;
  wikidata: string | null;
  how?: string;
}

/**
 * Elemento de Wikidata de cada equipo: el de config/team-bios.json, el ya identificado (se relee por su id) o
 * el que se encuentre entre los candidatos. Devuelve también los datos de los elementos elegidos.
 */
async function resolveTeams(
  api: Api,
  teams: TeamInput[],
  overrides: Record<string, string | null>,
  cache: BiosCache,
  config: Record<string, SeriesHistorySpec>,
  rematch: boolean,
  log: Logger,
): Promise<Resolved[] & { items: Map<string, WdItem> }> {
  const seriesQids = new Map(Object.entries(config).flatMap(([id, s]) => (s.wikidata ? [[id, s.wikidata]] : [])));
  const known = new Map<string, { qid: string | null; how: string }>();
  for (const t of teams) {
    if (t.id in overrides) known.set(t.id, { qid: overrides[t.id] ?? null, how: 'manual' });
    else if (!rematch && cache.teams[t.id]?.wikidata) known.set(t.id, { qid: cache.teams[t.id]!.wikidata, how: cache.teams[t.id]!.how ?? 'anterior' });
  }
  const toSearch = teams.filter((t) => !known.has(t.id));
  const matches = new Map<string, ReturnType<typeof findCandidates>>();
  if (toSearch.length) {
    const index = indexCandidates(await fetchCandidates(api));
    for (const t of toSearch) matches.set(t.id, findCandidates(index, t.name));
  }
  const ids = [
    ...[...known.values()].map((k) => k.qid).filter((q): q is string => !!q),
    ...[...matches.values()].flatMap((m) => (m ? m.list.slice(0, 4).map((c) => c.id) : [])),
  ];
  const items = await getItems(api, ids);
  const out = [] as unknown as Resolved[] & { items: Map<string, WdItem> };
  out.items = items;
  for (const t of teams) {
    const k = known.get(t.id);
    if (k) {
      out.push({ team: t, wikidata: k.qid && items.has(k.qid) ? k.qid : null, how: k.how });
      continue;
    }
    const m = matches.get(t.id);
    const choice = m ? chooseItem(t, { how: m.how, list: m.list.slice(0, 4) }, items, seriesQids) : null;
    if (m && !choice) log.info(`${t.name}: ${m.list.length} candidato(s) por ${m.how as MatchHow}, ninguno seguro (${m.list.slice(0, 4).map((c) => c.id).join(', ')})`);
    out.push({ team: t, wikidata: choice?.qid ?? null, ...(choice ? { how: `${choice.how}/${choice.why}` } : {}) });
  }
  return out;
}

/** Artículo de Wikipedia de cada equipo identificado ("en:Red Bull Racing" -> "red-bull-racing"). */
function teamArticles(cache: BiosCache): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, t] of Object.entries(cache.teams).sort(([a], [b]) => a.localeCompare(b))) {
    if (!t.wikidata) continue;
    if (t.enwiki && !out.has(`en:${t.enwiki}`)) out.set(`en:${t.enwiki}`, id);
    if (t.eswiki && !out.has(`es:${t.eswiki}`)) out.set(`es:${t.eswiki}`, id);
  }
  return out;
}

/** Vincula con la app los campeones guardados que todavía no tienen equipo o piloto. Devuelve cuántos cambiaron. */
function relinkChampions(series: SeriesHistory[], index: AppIndex): number {
  let changed = 0;
  for (const s of series) {
    for (const c of s.champions) {
      if (c.team && !c.teamId) {
        const id = linkTeam(index, s.seriesId, c.team);
        if (id) {
          c.teamId = id;
          changed++;
        }
      }
      if (c.driver && !c.driverId) {
        const id = linkDriver(index, s.seriesId, c.driver);
        if (id) {
          c.driverId = id;
          changed++;
        }
      }
    }
  }
  return changed;
}

function ordered(bio: TeamBio): TeamBio {
  const keys: Array<keyof TeamBio> = ['id', 'wikidata', 'summary', 'logo', 'founded', 'base', 'country', 'principal', 'titles', 'history', 'website', 'updatedAt'];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (bio[k] !== undefined) out[k] = bio[k];
  return out as unknown as TeamBio;
}

function sortedCache(cache: BiosCache): BiosCache {
  const sort = <T>(r: Record<string, T>) => Object.fromEntries(Object.entries(r).sort(([a], [b]) => a.localeCompare(b)));
  return { teams: sort(cache.teams), series: sort(cache.series) };
}

/** config/team-bios.json: id del equipo -> elemento de Wikidata (o null para no buscarlo). */
export async function loadTeamOverrides(configDir = CONFIG_DIR): Promise<Record<string, string | null>> {
  const raw = await readJson<Record<string, unknown>>(path.join(configDir, 'team-bios.json'));
  if (!raw) return {};
  const { $comment: _ignored, ...rest } = raw;
  return z.record(z.string().regex(/^Q\d+$/).nullable()).parse(rest);
}

/** Nombre de cada categoría (config/series.default.json). */
async function loadSeriesNames(configDir: string): Promise<Map<string, string>> {
  const raw = await readJson<unknown>(path.join(configDir, 'series.default.json')).catch(() => null);
  const list = z.array(seriesSchema.pick({ id: true, name: true })).safeParse(Array.isArray(raw) ? raw : ((raw as { series?: unknown[] } | null)?.series ?? []));
  return new Map((list.success ? list.data : []).map((s) => [s.id, s.name]));
}

// ── Uso manual ──

/** Respuestas guardadas en una carpeta (un archivo por URL), para depurar sin repetir consultas. */
export function fileCache(dir: string): ResponseCache {
  const fileOf = (url: string) => path.join(dir, `${createHash('sha1').update(url).digest('hex')}.json`);
  return {
    async get(url) {
      try {
        return (JSON.parse(await readFile(fileOf(url), 'utf8')) as { body: unknown }).body;
      } catch {
        return undefined;
      }
    },
    async set(url, body) {
      await mkdir(dir, { recursive: true });
      await writeFile(fileOf(url), JSON.stringify({ url, body }), 'utf8');
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  const flag = (name: string) => args.includes(`--${name}`);
  const value = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const cacheDir = value('cache');
  const limit = Number(value('limit') ?? 0);
  const res = await runTeamBios({
    log: createLogger('historial'),
    force: flag('force'),
    dryRun: flag('dry-run'),
    only: value('only')?.split(',').filter(Boolean),
    skipSeries: flag('teams-only'),
    skipTeams: flag('series-only'),
    seriesLimit: limit,
    teamLimit: limit,
    cache: cacheDir ? fileCache(path.resolve(cacheDir)) : undefined,
  });
  if (res) {
    for (const t of res.teams) console.log([t.id, t.name, t.wikidata ?? '-', t.how ?? ''].join(' | '));
  }
  if (!res || res.error) process.exit(1);
}

