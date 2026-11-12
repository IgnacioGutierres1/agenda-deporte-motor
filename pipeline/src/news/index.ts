/**
 * Noticias: lee los feeds RSS/Atom de config/news.json (fuentes oficiales y medios especializados),
 * etiqueta cada nota con sus categorías, agrupa la misma noticia de distintos medios y arma data/news.json.
 *
 * - Solo se guarda título, link, fecha, una bajada corta en texto plano y el link a la imagen que
 *   publica la propia fuente (no se copia). La nota siempre se lee en el sitio original.
 * - Cada feed se lee por separado: si uno falla, el resto sigue y sus notas anteriores se conservan.
 * - Las notas de corridas anteriores se mantienen mientras estén dentro de la ventana de días
 *   (muchos feeds solo muestran las últimas 10–15 notas).
 * - Topes por día, por medio y por categoría: la ventana de días es real y ninguna categoría tapa al resto.
 */
import path from 'node:path';
import { newsFileSchema, stableHash, type NewsFile, type NewsItem } from '@dm/shared';
import type { Http } from '../core/http.ts';
import type { Logger } from '../core/log.ts';
import { DATA_DIR } from '../core/paths.ts';
import { readJson, writeJson } from '../core/store.ts';
import { loadNewsConfig, type NewsConfig, type NewsFeed } from './config.ts';
import { createContextTagger, type ContextSources, type ContextTagger } from './context.ts';
import { canonicalKey, cleanUrl, groupStories, mergeDuplicates } from './group.ts';
import { fillMissingImages, type ImageCache } from './og.ts';
import { clip, decodeFeed, parseFeed } from './parse.ts';
import { tagSeries, tagUrl } from './tag.ts';
import { normalizeTitle } from './text.ts';

export { canonicalKey, cleanUrl, similarTitles } from './group.ts';
export { normalizeTitle } from './text.ts';

export interface FeedStat {
  id: string;
  name: string;
  ok: boolean;
  /** Notas leídas del feed en esta corrida. */
  fetched: number;
  /** Notas de esta fuente que quedaron en el archivo (incluye las conservadas de antes). */
  kept: number;
  error?: string;
}

export interface CollectNewsOptions {
  config: NewsConfig;
  http: Http;
  log: Logger;
  now?: Date;
  previous?: NewsFile | null;
  concurrency?: number;
  /** Pilotos, equipos y fechas para etiquetar por nombres y circuitos. */
  context?: ContextSources;
  /** Caché de og:image (se modifica). */
  imageCache?: ImageCache;
}

export interface CollectNewsResult {
  /** null si no se pudo leer ningún feed (hay que conservar el archivo anterior). */
  file: NewsFile | null;
  stats: FeedStat[];
  images?: { fetched: number; found: number; fromCache: number; failed: number };
}

const ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5';

export async function collectNews(opts: CollectNewsOptions): Promise<CollectNewsResult> {
  const { config, http, log } = opts;
  const now = opts.now ?? new Date();
  const nowIso = toIso(now);
  const feeds = config.feeds.filter((f) => f.enabled !== false);
  const prevById = new Map((opts.previous?.items ?? []).map((i) => [i.id, i]));
  const tagger = opts.context ? createContextTagger(opts.context) : undefined;

  const stats = new Map<string, FeedStat>();
  const fresh: NewsItem[] = [];

  await pool(feeds, opts.concurrency ?? 6, async (feed) => {
    const flog = log.child(feed.id);
    try {
      const res = await http.bytes(feed.url, { headers: { Accept: ACCEPT, ...(feed.headers ?? {}) } });
      const xml = decodeFeed(res.body, res.contentType);
      const raw = parseFeed(xml, res.url || feed.url);
      const items = raw.map((r) =>
        toNewsItem(feed, r, { nowIso, maxChars: config.summaryMaxChars, prevById, tagger }),
      );
      fresh.push(...items);
      stats.set(feed.id, { id: feed.id, name: feed.name, ok: true, fetched: items.length, kept: 0 });
      if (!items.length) flog.warn('El feed no trajo notas');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      flog.warn(`No se pudo leer el feed: ${msg}`);
      stats.set(feed.id, { id: feed.id, name: feed.name, ok: false, fetched: 0, kept: 0, error: msg });
    }
  });

  const orderedStats = feeds.map((f) => stats.get(f.id)!);
  if (!orderedStats.some((s) => s.ok)) return { file: null, stats: orderedStats };

  // Notas anteriores de fuentes que siguen configuradas y que esta corrida no volvió a ver.
  const sources = new Set(feeds.map((f) => f.name));
  const freshIds = new Set(fresh.map((i) => i.id));
  const carried = (opts.previous?.items ?? [])
    .filter((i) => sources.has(i.source) && !freshIds.has(i.id))
    // Las que quedaron sin categoría se reintentan por nombres y circuitos (pilotos y fechas cambian).
    .map((i) => (!i.seriesIds.length && tagger ? { ...i, seriesIds: tagger.tag(i.title, i.publishedAt) } : i));

  const items = selectNews([...fresh, ...carried], {
    now,
    maxAgeDays: config.maxAgeDays,
    maxItems: config.maxItems,
    maxPerFeed: config.maxPerFeed,
    maxPerFeedPerDay: config.maxPerFeedPerDay,
    maxPerSeriesPerDay: config.maxPerSeriesPerDay,
  });

  // Fotos de las notas cuyo feed no trae (og:image de la página, con caché y pocas por corrida).
  let images: CollectNewsResult['images'];
  if (config.imageFetchesPerRun > 0 || opts.imageCache) {
    const headersBySource = new Map(feeds.map((f) => [f.name, f.headers]));
    images = await fillMissingImages(items, {
      http,
      cache: opts.imageCache ?? {},
      limit: config.imageFetchesPerRun,
      now,
      keepDays: config.maxAgeDays + 2,
      headersFor: (i) => headersBySource.get(i.source),
    });
  }

  const kept = new Map<string, number>();
  for (const i of items) kept.set(i.source, (kept.get(i.source) ?? 0) + 1);
  for (const s of orderedStats) s.kept = kept.get(s.name) ?? 0;

  const file: NewsFile = { version: 1, generatedAt: nowIso, items };
  newsFileSchema.parse(file);
  return { file, stats: orderedStats, images };
}

export interface RunNewsOptions {
  http: Http;
  log: Logger;
  now?: Date;
  dataDir?: string;
  configDir?: string;
  dryRun?: boolean;
}

/**
 * Lee los feeds y escribe data/news.json. Nunca lanza: cualquier problema se registra y se
 * conserva el archivo anterior (las noticias no pueden hacer fallar la corrida).
 */
export async function runNews(opts: RunNewsOptions): Promise<CollectNewsResult | null> {
  const { log } = opts;
  try {
    const config = await loadNewsConfig(opts.configDir);
    if (!config) {
      log.warn('Sin config/news.json: no se leen noticias');
      return null;
    }
    const dataDir = opts.dataDir ?? DATA_DIR;
    const file = path.join(dataDir, 'news.json');
    let previous: NewsFile | null = null;
    try {
      previous = await readJson(file, newsFileSchema);
    } catch (err) {
      log.warn(`data/news.json anterior ilegible, se ignora: ${err instanceof Error ? err.message : String(err)}`);
    }
    const context = await loadContext(dataDir, log);
    const cacheFile = path.join(dataDir, '_cache', 'news-images.json');
    const imageCache = (await readJson<ImageCache>(cacheFile).catch(() => null)) ?? {};

    const result = await collectNews({ config, http: opts.http, log, now: opts.now, previous, context, imageCache });
    const ok = result.stats.filter((s) => s.ok).length;
    if (!result.file) {
      log.error(`No se pudo leer ningún feed de noticias (${result.stats.length}); se conserva data/news.json`);
      return result;
    }
    if (!opts.dryRun) {
      await writeJson(file, result.file);
      await writeJson(cacheFile, imageCache);
    }
    const kb = Math.round(Buffer.byteLength(JSON.stringify(result.file, null, 2)) / 1024);
    const img = result.images;
    log.info(
      `${result.file.items.length} notas de ${ok}/${result.stats.length} fuentes (${kb} KB)` +
        (img ? `; fotos de la página: ${img.found}/${img.fetched} nuevas, ${img.fromCache} de la caché` : ''),
    );
    return result;
  } catch (err) {
    log.error(`Noticias: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Pilotos, equipos y fechas (si todavía no existen, el etiquetado por contexto no se usa). */
async function loadContext(dataDir: string, log: Logger): Promise<ContextSources> {
  const read = async <T>(name: string): Promise<T | null> => {
    try {
      return await readJson<T>(path.join(dataDir, name));
    } catch (err) {
      log.warn(`No se pudo leer ${name} para etiquetar noticias: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  };
  const [drivers, teams, schedule] = await Promise.all([
    read<{ drivers?: ContextSources['drivers'] }>('drivers.json'),
    read<{ teams?: ContextSources['teams'] }>('teams.json'),
    read<{ events?: ContextSources['events'] }>('schedule.json'),
  ]);
  return { drivers: drivers?.drivers, teams: teams?.teams, events: schedule?.events };
}

// ---------------------------------------------------------------------------

interface ToItemCtx {
  nowIso: string;
  maxChars: number;
  prevById: Map<string, NewsItem>;
  tagger?: ContextTagger;
}

export function toNewsItem(
  feed: Pick<NewsFeed, 'name' | 'kind' | 'lang' | 'seriesIds'>,
  raw: { title: string; url: string; publishedAt: string | null; summary: string; image?: string; categories: string[] },
  ctx: ToItemCtx,
): NewsItem {
  const url = cleanUrl(raw.url);
  const id = stableHash(canonicalKey(url));
  const summaryText = stripLeadingTitle(raw.summary, raw.title);
  // Sin fecha en el feed (formula1.com): la de la primera vez que se vio la nota.
  let publishedAt = raw.publishedAt ?? ctx.prevById.get(id)?.publishedAt ?? ctx.nowIso;
  if (publishedAt > ctx.nowIso) publishedAt = ctx.nowIso; // fechas futuras = programadas o zona mal informada
  const item: NewsItem = {
    id,
    title: raw.title,
    url,
    source: feed.name,
    sourceKind: feed.kind,
    publishedAt,
    seriesIds: tagItem(feed, raw, summaryText, url, publishedAt, ctx.tagger),
    lang: feed.lang,
  };
  if (raw.image) item.image = raw.image;
  if (summaryText && normalizeTitle(summaryText) !== normalizeTitle(raw.title)) {
    item.summary = clip(summaryText, ctx.maxChars);
  }
  return item;
}

/**
 * Categorías de una nota, de la evidencia más fuerte a la más débil (cada paso solo si el anterior no encontró nada):
 * 1. la fuente (feed de una sola categoría), el título, las etiquetas del feed y la URL;
 * 2. pilotos/equipos inequívocos y circuitos de fechas cercanas nombrados en el título o las etiquetas;
 * 3. la bajada (que suele nombrar otras categorías de pasada: "como en IMSA…").
 */
function tagItem(
  feed: Pick<NewsFeed, 'lang' | 'seriesIds'>,
  raw: { title: string; categories: string[] },
  summary: string,
  url: string,
  publishedAt: string,
  tagger: ContextTagger | undefined,
): string[] {
  const found = new Set([
    ...(feed.seriesIds ?? []),
    ...tagSeries({ title: raw.title, categories: raw.categories, lang: feed.lang, context: summary }),
    ...tagUrl(url),
  ]);
  if (!found.size && tagger) {
    for (const text of [raw.title, ...raw.categories]) for (const s of tagger.tag(text, publishedAt)) found.add(s);
  }
  if (!found.size && summary) {
    const context = [raw.title, ...raw.categories].join(' \n ');
    for (const s of tagSeries({ title: '', summary, lang: feed.lang, context })) found.add(s);
  }
  return [...found];
}

/** Algunos WordPress repiten el título como primer párrafo de la bajada. */
function stripLeadingTitle(summary: string, title: string): string {
  const s = summary.trim();
  const t = title.trim();
  if (t && s.toLowerCase().startsWith(t.toLowerCase())) return s.slice(t.length).replace(/^[\s:.–—-]+/u, '');
  return s;
}

export interface SelectOptions {
  now: Date;
  maxAgeDays: number;
  maxItems: number;
  maxPerFeed: number;
  /** Topes por día (hora argentina). Sin ellos solo valen el tope por fuente y el total. */
  maxPerFeedPerDay?: number;
  maxPerSeriesPerDay?: number;
}

/**
 * Ventana de días, deduplicado (link y título), agrupado de la misma noticia de distintos medios,
 * topes por día, por fuente y total, y orden por fecha.
 */
export function selectNews(items: NewsItem[], opts: SelectOptions): NewsItem[] {
  const since = toIso(new Date(opts.now.getTime() - opts.maxAgeDays * 86_400_000));
  const recent = items.filter((i) => i.publishedAt >= since);
  let stories = groupStories(mergeDuplicates(recent));
  stories.sort(byDateDesc);
  if (opts.maxPerFeedPerDay || opts.maxPerSeriesPerDay) stories = applyDailyQuotas(stories, opts);

  const perFeed = new Map<string, number>();
  const out: NewsItem[] = [];
  for (const item of stories) {
    const n = perFeed.get(item.source) ?? 0;
    if (n >= opts.maxPerFeed) continue;
    perFeed.set(item.source, n + 1);
    out.push(item);
    if (out.length >= opts.maxItems) break;
  }
  return out;
}

const UNTAGGED = '_';

/**
 * Por cada día (hora argentina): tope por medio y por categoría y, si entre todos los días hay más
 * notas que maxItems, un mismo tope de notas por día (el mayor que entra), así los días más
 * recientes no se quedan con todo el lugar. Cuando un día tiene más notas que lugar, entran primero
 * las más relevantes (contadas por varios medios, oficiales, en castellano, con foto, con categoría).
 */
export function applyDailyQuotas(items: NewsItem[], opts: SelectOptions): NewsItem[] {
  const days = new Map<string, NewsItem[]>();
  for (const i of items) {
    const day = argentinaDay(i.publishedAt);
    const list = days.get(day) ?? [];
    list.push(i);
    days.set(day, list);
  }
  const eligible: NewsItem[][] = [];
  for (const list of days.values()) {
    list.sort((a, b) => relevance(b) - relevance(a) || byDateDesc(a, b));
    const bySource = new Map<string, number>();
    const bySeries = new Map<string, number>();
    const ok: NewsItem[] = [];
    for (const item of list) {
      if (opts.maxPerFeedPerDay && (bySource.get(item.source) ?? 0) >= opts.maxPerFeedPerDay) continue;
      const series = item.seriesIds.length ? item.seriesIds : [UNTAGGED];
      if (opts.maxPerSeriesPerDay && series.some((s) => (bySeries.get(s) ?? 0) >= opts.maxPerSeriesPerDay!)) continue;
      bySource.set(item.source, (bySource.get(item.source) ?? 0) + 1);
      for (const s of series) bySeries.set(s, (bySeries.get(s) ?? 0) + 1);
      ok.push(item);
    }
    eligible.push(ok);
  }
  // Mayor tope diario con el que el total no pasa de maxItems.
  const fits = (cap: number) => eligible.reduce((n, l) => n + Math.min(l.length, cap), 0) <= opts.maxItems;
  let cap = Math.max(0, ...eligible.map((l) => l.length));
  if (!fits(cap)) {
    let lo = 0;
    let hi = cap;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    cap = lo;
  }
  return eligible.flatMap((l) => l.slice(0, cap)).sort(byDateDesc);
}

function relevance(i: NewsItem): number {
  return (
    (i.alsoIn?.length ?? 0) * 2 +
    Number(i.sourceKind === 'oficial') +
    Number(i.lang === 'es') +
    (i.image ? 0.5 : 0) +
    (i.seriesIds.length ? 1 : 0)
  );
}

function byDateDesc(a: NewsItem, b: NewsItem): number {
  return b.publishedAt.localeCompare(a.publishedAt) || a.title.localeCompare(b.title);
}

/** Fecha (AAAA-MM-DD) en hora argentina (UTC−3, sin horario de verano). */
function argentinaDay(iso: string): string {
  return new Date(Date.parse(iso) - 3 * 3_600_000).toISOString().slice(0, 10);
}

function toIso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(size, queue.length) }, async () => {
    while (queue.length) await fn(queue.shift()!);
  });
  await Promise.all(workers);
}
