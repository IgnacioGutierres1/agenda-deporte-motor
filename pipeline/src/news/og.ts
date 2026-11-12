/**
 * Foto de portada para las notas cuyo feed no trae imagen (formula1.com, SoloTC, APTP):
 * se lee la etiqueta og:image de la página de la nota.
 *
 * Para no cargar a los sitios: pocas páginas por corrida (las notas más nuevas primero), de a dos,
 * y cada link se consulta una sola vez (el resultado, haya foto o no, queda en
 * data/_cache/news-images.json hasta que la nota sale de la ventana).
 */
import type { NewsItem } from '@dm/shared';
import type { Http } from '../core/http.ts';
import { attr } from '../extract/html.ts';
import { canonicalKey } from './group.ts';
import { httpImage } from './parse.ts';

export interface ImageCacheEntry {
  image: string | null;
  checkedAt: string;
}

/** Link canónico de la nota → foto encontrada (o null si la página no tiene). */
export type ImageCache = Record<string, ImageCacheEntry>;

export interface FillImagesOptions {
  http: Http;
  cache: ImageCache;
  /** Máximo de páginas a leer en esta corrida (0 = ninguna; solo se usa la caché). */
  limit: number;
  now: Date;
  /** Las entradas de la caché más viejas que esto se descartan. */
  keepDays: number;
  /** Encabezados extra por nota (los mismos que el feed de su fuente). */
  headersFor?: (item: NewsItem) => Record<string, string> | undefined;
}

export interface FillImagesResult {
  fetched: number;
  found: number;
  fromCache: number;
  failed: number;
}

/** Completa `image` en las notas sin foto (modifica los objetos). */
export async function fillMissingImages(items: NewsItem[], opts: FillImagesOptions): Promise<FillImagesResult> {
  const res: FillImagesResult = { fetched: 0, found: 0, fromCache: 0, failed: 0 };
  const pending: NewsItem[] = [];
  for (const item of items) {
    if (item.image) continue;
    const hit = opts.cache[canonicalKey(item.url)];
    if (hit) {
      if (hit.image) {
        item.image = hit.image;
        res.fromCache++;
      }
      continue;
    }
    pending.push(item);
  }

  const queue = [...pending]
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, Math.max(0, opts.limit));
  const checkedAt = opts.now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      res.fetched++;
      let image: string | null = null;
      try {
        const page = await opts.http.text(item.url, {
          headers: { Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5', ...(opts.headersFor?.(item) ?? {}) },
        });
        image = ogImage(page.body, page.url || item.url) ?? null;
      } catch {
        // Página caída o bloqueada: queda sin foto (y no se vuelve a pedir).
        res.failed++;
      }
      opts.cache[canonicalKey(item.url)] = { image, checkedAt };
      if (image) {
        item.image = image;
        res.found++;
      }
    }
  };
  await Promise.all([worker(), worker()]);

  // Caché acotada: solo links que todavía pueden estar en la ventana.
  const since = new Date(opts.now.getTime() - opts.keepDays * 86_400_000).toISOString();
  for (const [k, v] of Object.entries(opts.cache)) if (v.checkedAt < since) delete opts.cache[k];
  return res;
}

/** og:image (o twitter:image) del <head> de una página, en un tamaño razonable para la app. */
export function ogImage(html: string, base: string): string | undefined {
  const head = html.slice(0, 300_000).split(/<\/head>/i)[0] ?? '';
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  for (const name of ['og:image:secure_url', 'og:image', 'twitter:image', 'twitter:image:src']) {
    for (const m of metas) {
      const key = (attr(m, 'property') ?? attr(m, 'name') ?? '').toLowerCase();
      if (key !== name) continue;
      const url = httpImage(attr(m, 'content'), base);
      if (url) return smallerImage(url);
    }
  }
  return undefined;
}

/** formula1.com sirve la portada a 2048 px: para la lista alcanza con 960. */
export function smallerImage(url: string): string {
  if (/^https:\/\/media\.formula1\.com\/image\/upload\//.test(url)) return url.replace(/([,/])w_\d{4,}\b/, '$1w_960');
  return url;
}
