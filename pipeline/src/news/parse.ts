/**
 * Lector de feeds RSS 2.0 / RSS 1.0 (RDF) / Atom sin dependencias.
 * Las secciones CDATA se enmascaran antes de buscar etiquetas, así el HTML de una nota
 * (<img>, <link>, <title>…) nunca se confunde con la estructura del feed.
 */
import { DateTime } from 'luxon';
import { absoluteUrl, attr, decodeEntities, textOf } from '../extract/html.ts';

export interface RawFeedItem {
  title: string;
  /** Link a la nota (absoluto, http/https). */
  url: string;
  /** ISO UTC; null si el feed no la informa. */
  publishedAt: string | null;
  /** Texto plano completo de la bajada (sin recortar). */
  summary: string;
  image?: string;
  categories: string[];
}

/** Decodifica los bytes del feed según el charset del encabezado HTTP o del prólogo XML. */
export function decodeFeed(bytes: Uint8Array, contentType = ''): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 200));
  const declared =
    contentType.match(/charset=["']?([\w-]+)/i)?.[1] ?? head.match(/<\?xml[^>]*encoding=["']([\w-]+)["']/i)?.[1];
  let label = (declared ?? 'utf-8').toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes).replace(/^﻿/, '');
  } catch {
    label = 'utf-8';
    return new TextDecoder(label).decode(bytes).replace(/^﻿/, '');
  }
}

export function isFeed(xml: string): boolean {
  return /<(?:rss|feed|rdf:RDF)\b/i.test(xml.slice(0, 5000));
}

/** Lee los ítems de un feed. `baseUrl` resuelve links e imágenes relativos. */
export function parseFeed(xml: string, baseUrl: string): RawFeedItem[] {
  if (!isFeed(xml)) throw new Error('La respuesta no es un feed RSS/Atom');
  const { masked, cdata } = maskCdata(xml.replace(/<!--[\s\S]*?-->/g, ''));
  const isAtom = /<feed\b/i.test(masked.slice(0, 5000)) && !/<rss\b/i.test(masked.slice(0, 5000));
  const blockRe = isAtom ? /<entry\b[^>]*>([\s\S]*?)<\/entry>/gi : /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  const out: RawFeedItem[] = [];
  for (const m of masked.matchAll(blockRe)) {
    const item = (isAtom ? readAtomEntry : readRssItem)(new Block(m[1] ?? '', cdata), baseUrl);
    if (item) out.push(item);
  }
  return out;
}

// ---------------------------------------------------------------------------

const CDATA_TOKEN = /\u0000(\d+)\u0000/g;

function maskCdata(xml: string): { masked: string; cdata: string[] } {
  const cdata: string[] = [];
  const masked = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, inner: string) => {
    cdata.push(inner);
    return `\u0000${cdata.length - 1}\u0000`;
  });
  return { masked, cdata };
}

/** Un ítem/entrada con acceso a sus etiquetas hijas. */
class Block {
  constructor(
    readonly src: string,
    private readonly cdata: string[],
  ) {}

  /** Valor (texto) de la primera etiqueta con ese nombre: CDATA tal cual, el resto con entidades XML decodificadas. */
  value(name: string): string | undefined {
    const m = this.src.match(tagRe(name));
    return m ? this.unmask(m[2] ?? '') : undefined;
  }

  /** Atributos de cada aparición de la etiqueta (abierta o autocerrada). */
  tags(name: string): Array<{ attrs: string; inner: string }> {
    const re = new RegExp(`<${escapeName(name)}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${escapeName(name)}>)`, 'gi');
    return [...this.src.matchAll(re)].map((m) => ({ attrs: m[1] ?? '', inner: this.unmask(m[2] ?? '') }));
  }

  unmask(s: string): string {
    let out = '';
    let last = 0;
    for (const m of s.matchAll(CDATA_TOKEN)) {
      out += decodeEntities(s.slice(last, m.index));
      out += this.cdata[Number(m[1])] ?? '';
      last = m.index! + m[0].length;
    }
    return out + decodeEntities(s.slice(last));
  }
}

function escapeName(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tagRe(name: string): RegExp {
  return new RegExp(`<${escapeName(name)}(\\s[^>]*)?>([\\s\\S]*?)</${escapeName(name)}>`, 'i');
}

function readRssItem(b: Block, baseUrl: string): RawFeedItem | null {
  const title = textOf(b.value('title') ?? '');
  let link = (b.value('link') ?? '').trim();
  if (!link) {
    const guid = b.tags('guid')[0];
    if (guid && !/isPermaLink\s*=\s*["']false/i.test(guid.attrs)) link = guid.inner.trim();
  }
  const url = link ? absoluteUrl(link, baseUrl) : null;
  if (!title || !url) return null;

  const description = b.value('description') ?? '';
  const content = b.value('content:encoded') ?? '';
  return {
    title,
    url,
    publishedAt: parseDate(b.value('pubDate') ?? b.value('dc:date') ?? b.value('published') ?? ''),
    summary: htmlSummary(description || content),
    image: findImage(b, [description, content], url),
    categories: b
      .tags('category')
      .map((c) => textOf(c.inner))
      .filter(Boolean),
  };
}

function readAtomEntry(b: Block, baseUrl: string): RawFeedItem | null {
  const title = textOf(b.value('title') ?? '');
  const links = b.tags('link');
  const alt =
    links.find((l) => (attr(l.attrs, 'rel') ?? 'alternate') === 'alternate' && /html/i.test(attr(l.attrs, 'type') ?? 'html')) ??
    links.find((l) => !attr(l.attrs, 'rel'));
  const href = alt ? attr(alt.attrs, 'href') : undefined;
  const url = href ? absoluteUrl(decodeEntities(href), baseUrl) : null;
  if (!title || !url) return null;

  const summary = b.value('summary') ?? '';
  const content = b.value('content') ?? '';
  return {
    title,
    url,
    publishedAt: parseDate(b.value('published') ?? b.value('updated') ?? b.value('dc:date') ?? ''),
    summary: htmlSummary(summary || content),
    image: findImage(b, [summary, content], url),
    categories: b
      .tags('category')
      .map((c) => decodeEntities(attr(c.attrs, 'term') ?? attr(c.attrs, 'label') ?? '') || textOf(c.inner))
      .filter(Boolean),
  };
}

/** Fechas RFC 822 (RSS) o ISO 8601 (Atom) → ISO UTC. */
export function parseDate(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let dt = DateTime.fromRFC2822(s, { setZone: true });
  if (!dt.isValid) dt = DateTime.fromISO(s, { setZone: true });
  if (!dt.isValid) {
    // Variantes frecuentes: día con nombre largo, "UT", zonas en texto, etc.
    const ms = Date.parse(s.replace(/\bUT\b/, 'GMT'));
    if (Number.isNaN(ms)) return null;
    dt = DateTime.fromMillis(ms, { zone: 'utc' });
  }
  return dt.toUTC().startOf('second').toISO({ suppressMilliseconds: true });
}

/** Texto plano de la bajada: sin el pie automático de WordPress ni etiquetas sueltas al inicio. */
export function htmlSummary(html: string): string {
  // "Sport news<p>…" (FIA): rótulo suelto antes del primer párrafo.
  const h = html.replace(/^\s*[A-Za-z]+(?: [A-Za-z]+){0,2}\s*(?=<(?:p|div)\b)/, '');
  let text = textOf(h.replace(/<\/(p|div|h\d|li)>/gi, ' </$1>'));
  text = text
    .replace(/\s*(?:La entrada .+? se public[oó] primero en .+?\.?|The post .+? appeared first on .+?\.?)\s*$/i, '')
    .replace(/\s*Este artículo es un contenido original del sitio \S+\s*$/i, '')
    .replace(/\s*(?:Sigue leyendo|Seguir leyendo|Leer más|Read more|Continue reading|Keep reading)\s*$/i, '')
    .replace(/\s*(?:\[(?:…|\.\.\.|&hellip;)\]|…|\.\.\.)\s*$/u, '…')
    .trim();
  return text;
}

/** Recorta en un límite de palabra, con "…". */
export function clip(text: string, max = 240): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/u, '')}…`;
}

const NOT_CONTENT_IMAGE =
  /logo|icon|favicon|sponsor|banner|publicidad|advert|avatar|emoji|gravatar|placeholder|spinner|loading|pixel|tracking|feedburner|share|button/i;

/** Link http(s) absoluto de una imagen de contenido (no GIF, SVG, logo, ícono ni publicidad). */
export function httpImage(src: string | undefined, base: string): string | undefined {
  if (!src || src.startsWith('data:')) return undefined;
  const url = absoluteUrl(decodeEntities(src), base);
  if (!url) return undefined;
  const path = decodeURIComponent(new URL(url).pathname);
  if (/\.(gif|svg)$/i.test(path) || NOT_CONTENT_IMAGE.test(path)) return undefined;
  return url;
}

function looksLikeImage(attrs: string, url: string): boolean {
  const medium = attr(attrs, 'medium') ?? '';
  const type = attr(attrs, 'type') ?? '';
  if (/^image/i.test(medium) || /^image\//i.test(type)) return true;
  if (medium || type) return false;
  return /\.(jpe?g|png|webp|avif)(\?|$)/i.test(url);
}

/**
 * Imagen de portada: media:content / media:thumbnail / enclosure / <link rel="enclosure">,
 * y si no hay, la primera <img> de contenido (no publicidad ni íconos) de la bajada o el cuerpo.
 */
function findImage(b: Block, html: string[], base: string): string | undefined {
  // media:content (también dentro de media:group): la más ancha.
  const media = b
    .tags('media:content')
    .map((t) => ({ t, url: httpImage(attr(t.attrs, 'url'), base) }))
    .filter((x): x is { t: { attrs: string; inner: string }; url: string } => !!x.url && looksLikeImage(x.t.attrs, x.url))
    .sort((a, b2) => Number(attr(b2.t.attrs, 'width') ?? 0) - Number(attr(a.t.attrs, 'width') ?? 0));
  if (media[0]) return media[0].url;

  for (const t of b.tags('media:thumbnail')) {
    const url = httpImage(attr(t.attrs, 'url'), base);
    if (url) return url;
  }
  for (const t of b.tags('enclosure')) {
    const url = httpImage(attr(t.attrs, 'url'), base);
    if (url && looksLikeImage(t.attrs, url)) return url;
  }
  for (const t of b.tags('link')) {
    if (attr(t.attrs, 'rel') !== 'enclosure') continue;
    const url = httpImage(attr(t.attrs, 'href'), base);
    if (url && looksLikeImage(t.attrs, url)) return url;
  }
  for (const fragment of html) {
    const img = firstContentImage(fragment, base);
    if (img) return img;
  }
  return undefined;
}

/** Primera <img> que no sea publicidad, ícono ni miniatura (por tamaño declarado o proporción de banner). */
export function firstContentImage(html: string, base: string): string | undefined {
  for (const m of html.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = m[1] ?? '';
    const src = [attr(attrs, 'data-src'), attr(attrs, 'data-lazy-src'), attr(attrs, 'src')].find(
      (s) => s && !s.startsWith('data:'),
    );
    const url = httpImage(src, base);
    if (!url) continue;
    const w = Number(attr(attrs, 'width')) || 0;
    const h = Number(attr(attrs, 'height')) || 0;
    if ((w && w < 200) || (h && h < 120) || (w && h && w / h > 3.2)) continue;
    return url;
  }
  return undefined;
}
