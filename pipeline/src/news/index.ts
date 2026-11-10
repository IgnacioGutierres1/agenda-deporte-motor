/**
 * Noticias: lee los feeds RSS/Atom de config/news.json (fuentes oficiales y medios especializados),
 * etiqueta cada nota con sus categorías, deduplica y arma data/news.json.
 *
 * - Solo se guarda título, link, fecha, una bajada corta en texto plano y el link a la imagen que
 *   publica la propia fuente (no se copia). La nota siempre se lee en el sitio original.
 * - Cada feed se lee por separado: si uno falla, el resto sigue y sus notas anteriores se conservan.
 * - Las notas de corridas anteriores se mantienen mientras estén dentro de la ventana de días
 *   (muchos feeds solo muestran las últimas 10–15 notas).
 */
import path from 'node:path';
import { newsFileSchema, stableHash, type NewsFile, type NewsItem } from '@dm/shared';
import type { Http } from '../core/http.ts';
import type { Logger } from '../core/log.ts';
import { DATA_DIR } from '../core/paths.ts';
import { readJson, writeJson } from '../core/store.ts';
import { loadNewsConfig, type NewsConfig, type NewsFeed } from './config.ts';
import { clip, decodeFeed, parseFeed } from './parse.ts';
import { tagSeries, tagUrl } from './tag.ts';

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
}

export interface CollectNewsResult {
  /** null si no se pudo leer ningún feed (hay que conservar el archivo anterior). */
  file: NewsFile | null;
  stats: FeedStat[];
}

const ACCEPT = 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, */*;q=0.5';

export async function collectNews(opts: CollectNewsOptions): Promise<CollectNewsResult> {
  const { config, http, log } = opts;
  const now = opts.now ?? new Date();
  const nowIso = toIso(now);
  const feeds = config.feeds.filter((f) => f.enabled !== false);
  const prevById = new Map((opts.previous?.items ?? []).map((i) => [i.id, i]));

  const stats = new Map<string, FeedStat>();
  const fresh: NewsItem[] = [];

  await pool(feeds, opts.concurrency ?? 6, async (feed) => {
    const flog = log.child(feed.id);
    try {
      const res = await http.bytes(feed.url, { headers: { Accept: ACCEPT, ...(feed.headers ?? {}) } });
      const xml = decodeFeed(res.body, res.contentType);
      const raw = parseFeed(xml, res.url || feed.url);
      const items = raw.map((r) =>
        toNewsItem(feed, r, { nowIso, maxChars: config.summaryMaxChars, prevById }),
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
  const carried = (opts.previous?.items ?? []).filter((i) => sources.has(i.source) && !freshIds.has(i.id));

  const items = selectNews([...fresh, ...carried], {
    now,
    maxAgeDays: config.maxAgeDays,
    maxItems: config.maxItems,
    maxPerFeed: config.maxPerFeed,
  });

  const kept = new Map<string, number>();
  for (const i of items) kept.set(i.source, (kept.get(i.source) ?? 0) + 1);
  for (const s of orderedStats) s.kept = kept.get(s.name) ?? 0;

  const file: NewsFile = { version: 1, generatedAt: nowIso, items };
  newsFileSchema.parse(file);
  return { file, stats: orderedStats };
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
    const file = path.join(opts.dataDir ?? DATA_DIR, 'news.json');
    let previous: NewsFile | null = null;
    try {
      previous = await readJson(file, newsFileSchema);
    } catch (err) {
      log.warn(`data/news.json anterior ilegible, se ignora: ${err instanceof Error ? err.message : String(err)}`);
    }
    const result = await collectNews({ config, http: opts.http, log, now: opts.now, previous });
    const ok = result.stats.filter((s) => s.ok).length;
    if (!result.file) {
      log.error(`No se pudo leer ningún feed de noticias (${result.stats.length}); se conserva data/news.json`);
      return result;
    }
    if (!opts.dryRun) await writeJson(file, result.file);
    log.info(`${result.file.items.length} notas de ${ok}/${result.stats.length} fuentes`);
    return result;
  } catch (err) {
    log.error(`Noticias: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// ---------------------------------------------------------------------------

interface ToItemCtx {
  nowIso: string;
  maxChars: number;
  prevById: Map<string, NewsItem>;
}

export function toNewsItem(
  feed: Pick<NewsFeed, 'name' | 'kind' | 'lang' | 'seriesIds'>,
  raw: { title: string; url: string; publishedAt: string | null; summary: string; image?: string; categories: string[] },
  ctx: ToItemCtx,
): NewsItem {
  const url = cleanUrl(raw.url);
  const id = stableHash(canonicalKey(url));
  const summaryText = stripLeadingTitle(raw.summary, raw.title);
  const tags = tagSeries({ title: raw.title, summary: summaryText, categories: raw.categories, lang: feed.lang });
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
    seriesIds: [...new Set([...(feed.seriesIds ?? []), ...tags, ...tagUrl(url)])],
    lang: feed.lang,
  };
  if (raw.image) item.image = raw.image;
  if (summaryText && normalizeTitle(summaryText) !== normalizeTitle(raw.title)) {
    item.summary = clip(summaryText, ctx.maxChars);
  }
  return item;
}

/** Algunos WordPress repiten el título como primer párrafo de la bajada. */
function stripLeadingTitle(summary: string, title: string): string {
  const s = summary.trim();
  const t = title.trim();
  if (t && s.toLowerCase().startsWith(t.toLowerCase())) return s.slice(t.length).replace(/^[\s:.–—-]+/u, '');
  return s;
}

const TRACKING_PARAMS = /^(utm_\w+|fbclid|gclid|mc_cid|mc_eid|ocid|cmpid|ref|ref_src|ito|at_\w+)$/i;

/** Link sin parámetros de seguimiento ni ancla. */
export function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw);
    for (const k of [...u.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) u.searchParams.delete(k);
    u.hash = '';
    return u.toString();
  } catch {
    return raw;
  }
}

/** Clave para deduplicar: sin "www.", sin barra final, sin seguimiento, http = https. */
export function canonicalKey(raw: string): string {
  try {
    const u = new URL(cleanUrl(raw));
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const pathname = u.pathname.replace(/\/+$/, '') || '/';
    u.searchParams.sort();
    const q = u.searchParams.toString();
    return `${host}${pathname}${q ? `?${q}` : ''}`;
  } catch {
    return raw.trim().toLowerCase();
  }
}

export function normalizeTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleTokens(title: string): Set<string> {
  return new Set(normalizeTitle(title).split(' ').filter(Boolean));
}

/** Títulos casi idénticos (misma nota en dos ediciones de un medio, o retocada). */
export function similarTitles(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (na === nb) return true;
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  if (ta.size < 5 || tb.size < 5) return false;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  return inter / (ta.size + tb.size - inter) >= 0.9;
}

export interface SelectOptions {
  now: Date;
  maxAgeDays: number;
  maxItems: number;
  maxPerFeed: number;
}

/** Ventana de días, deduplicado (link y título), orden por fecha y topes por fuente y total. */
export function selectNews(items: NewsItem[], opts: SelectOptions): NewsItem[] {
  const since = toIso(new Date(opts.now.getTime() - opts.maxAgeDays * 86_400_000));
  const recent = items.filter((i) => i.publishedAt >= since);

  // Ante duplicados gana la fuente oficial y, entre iguales, la publicación original (la más vieja).
  const ordered = [...recent].sort(
    (a, b) =>
      Number(b.sourceKind === 'oficial') - Number(a.sourceKind === 'oficial') ||
      a.publishedAt.localeCompare(b.publishedAt) ||
      a.source.localeCompare(b.source) ||
      a.url.localeCompare(b.url),
  );
  const byKey = new Map<string, NewsItem>();
  const kept: NewsItem[] = [];
  for (const item of ordered) {
    const key = canonicalKey(item.url);
    const dup = byKey.get(key) ?? kept.find((k) => similarTitles(k.title, item.title));
    if (dup) {
      dup.seriesIds = [...new Set([...dup.seriesIds, ...item.seriesIds])];
      if (!dup.image && item.image) dup.image = item.image;
      if (!dup.summary && item.summary) dup.summary = item.summary;
      continue;
    }
    const copy = { ...item, seriesIds: [...item.seriesIds] };
    byKey.set(key, copy);
    kept.push(copy);
  }

  kept.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.title.localeCompare(b.title));
  const perFeed = new Map<string, number>();
  const out: NewsItem[] = [];
  for (const item of kept) {
    const n = perFeed.get(item.source) ?? 0;
    if (n >= opts.maxPerFeed) continue;
    perFeed.set(item.source, n + 1);
    out.push(item);
    if (out.length >= opts.maxItems) break;
  }
  return out;
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
