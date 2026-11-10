/**
 * Utilidades mínimas para leer HTML sin dependencias (sin DOM): texto compacto con links,
 * JSON-LD, JSON embebido (Next.js, Nuxt, RSC) y troceo por clase CSS para lectores deterministas.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  laquo: '«',
  raquo: '»',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  aacute: 'á',
  eacute: 'é',
  iacute: 'í',
  oacute: 'ó',
  uacute: 'ú',
  Aacute: 'Á',
  Eacute: 'É',
  Iacute: 'Í',
  Oacute: 'Ó',
  Uacute: 'Ú',
  ntilde: 'ñ',
  Ntilde: 'Ñ',
  uuml: 'ü',
  ouml: 'ö',
  auml: 'ä',
  Uuml: 'Ü',
  Ouml: 'Ö',
  Auml: 'Ä',
  szlig: 'ß',
  ordm: 'º',
  ordf: 'ª',
  deg: '°',
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED_ENTITIES[code] ?? m;
  });
}

/** Texto plano de un fragmento HTML (sin etiquetas, entidades decodificadas, espacios colapsados). */
export function textOf(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

export function absoluteUrl(href: string, base: string): string | null {
  try {
    const u = new URL(decodeEntities(href.trim()), base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

export interface Link {
  url: string;
  text: string;
}

/** Todos los links <a href> del documento, absolutos y con su texto (o title/alt si no tiene texto). */
export function extractLinks(html: string, baseUrl: string): Link[] {
  const out: Link[] = [];
  const seen = new Set<string>();
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const attrs = m[1] ?? '';
    const href = attr(attrs, 'href');
    if (!href) continue;
    const url = absoluteUrl(href, baseUrl);
    if (!url) continue;
    let text = textOf(m[2] ?? '');
    if (!text) text = decodeEntities(attr(attrs, 'title') ?? attr(m[2] ?? '', 'alt') ?? '');
    const key = `${url} ${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ url, text });
  }
  return out;
}

export function attr(tagOrAttrs: string, name: string): string | undefined {
  const m = tagOrAttrs.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

/**
 * Versión compacta de una página para pasarle a Gemini: sin scripts, estilos, navegación ni pie;
 * conserva encabezados, filas de tablas (celdas separadas por " | ") y links como "texto <url>".
 */
export function htmlToText(html: string, baseUrl: string, maxChars = 60_000): string {
  let h = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(nav|footer)\b[\s\S]*?<\/\1>/gi, ' ');
  h = h.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (_m, attrs: string, inner: string) => {
    const href = attr(attrs, 'href');
    const url = href ? absoluteUrl(href, baseUrl) : null;
    const text = textOf(inner);
    if (!url) return ` ${text} `;
    return ` ${text} <${url}> `;
  });
  h = h
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|table|ul|ol|dt|dd|caption)>/gi, '\n')
    .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n${'#'.repeat(Number(n))} `);
  const text = decodeEntities(h.replace(/<[^>]*>/g, ' '))
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v ]+/g, ' ').replace(/(\s*\|\s*)+$/, '').trim())
    .filter((l) => l && l !== '|')
    .join('\n');
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** Bloques <script type="application/ld+json"> aplanados (incluye @graph). */
export function parseJsonLd(html: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    try {
      const data: unknown = JSON.parse((m[1] ?? '').trim());
      const stack = Array.isArray(data) ? [...data] : [data];
      while (stack.length) {
        const item = stack.shift();
        if (!item || typeof item !== 'object') continue;
        const obj = item as Record<string, unknown>;
        if (Array.isArray(obj['@graph'])) stack.push(...(obj['@graph'] as unknown[]));
        out.push(obj);
      }
    } catch {
      // JSON-LD inválido: se ignora.
    }
  }
  return out;
}

/**
 * JSON embebido en la página: __NEXT_DATA__, window.__NUXT__ (si es JSON), payload RSC de Next.js
 * (self.__next_f.push) y scripts application/json. Devuelve los valores ya parseados.
 */
export function extractEmbeddedJson(html: string): unknown[] {
  const out: unknown[] = [];
  const tryParse = (s: string) => {
    try {
      out.push(JSON.parse(s));
    } catch {
      /* no es JSON */
    }
  };
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    tryParse((m[1] ?? '').trim());
  }
  // Payload RSC (Next.js App Router): concatenar los fragmentos y buscar objetos/arrays JSON dentro.
  const chunks: string[] = [];
  for (const m of html.matchAll(/self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)/g)) {
    try {
      chunks.push(JSON.parse(m[1]!) as string);
    } catch {
      /* fragmento ilegible */
    }
  }
  if (chunks.length) out.push(...jsonValuesInText(chunks.join('')));
  return out;
}

/**
 * Extrae los valores JSON de nivel superior (objetos o arrays) que aparecen dentro de un texto
 * arbitrario, p. ej. las líneas "1:[...]" del payload RSC. Se limita a valores de más de 40 caracteres.
 */
export function jsonValuesInText(text: string): unknown[] {
  const out: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c !== '{' && c !== '[') {
      i++;
      continue;
    }
    const end = matchBracket(text, i);
    if (end > i + 40) {
      try {
        out.push(JSON.parse(text.slice(i, end + 1)));
        i = end + 1;
        continue;
      } catch {
        /* sigue buscando */
      }
    }
    i++;
  }
  return out;
}

function matchBracket(text: string, start: number): number {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Trocea el HTML en bloques que empiezan en cada elemento cuyo atributo class contiene `className`
 * (como palabra completa). Cada bloque llega hasta el comienzo del siguiente o hasta `maxLen`.
 */
export function blocksByClass(html: string, className: string, maxLen = 6000): string[] {
  const re = new RegExp(`<[a-z][a-z0-9]*\\b[^>]*class\\s*=\\s*["'][^"']*(?<![\\w-])${escapeRe(className)}(?![\\w-])[^"']*["'][^>]*>`, 'gi');
  const starts = [...html.matchAll(re)].map((m) => m.index!);
  return starts.map((s, i) => html.slice(s, Math.min(starts[i + 1] ?? html.length, s + maxLen)));
}

/** Texto del primer elemento con esa clase dentro del fragmento (contenido hasta su cierre aproximado). */
export function textByClass(fragment: string, className: string): string {
  const re = new RegExp(
    `<([a-z][a-z0-9]*)\\b[^>]*class\\s*=\\s*["'][^"']*(?<![\\w-])${escapeRe(className)}(?![\\w-])[^"']*["'][^>]*>([\\s\\S]*?)<\\/\\1>`,
    'i',
  );
  const m = fragment.match(re);
  return m ? textOf(m[2] ?? '') : '';
}

export function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Nombres de archivo que no son contenido (logos, íconos, publicidad, miniaturas de WordPress). */
const NOT_CONTENT_IMAGE =
  /logo|icon|favicon|sponsor|banner|publicidad|avatar|emoji|gravatar|placeholder|spinner|loading|pixel|tracking|-\d{2,3}x\d{2,3}\.[a-z]+$/i;

/**
 * Imágenes de contenido de una página (sin navegación, encabezado ni pie): candidatas a ser
 * el calendario o el cronograma publicado como imagen. Solo JPG/PNG/WebP, sin logos ni miniaturas.
 */
export function contentImages(html: string, baseUrl: string): string[] {
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|head|nav|header|footer)\b[\s\S]*?<\/\1>/gi, ' ');
  const out: string[] = [];
  for (const m of body.matchAll(/<img\b([^>]*)>/gi)) {
    const attrs = m[1] ?? '';
    const src = [attr(attrs, 'data-src'), attr(attrs, 'data-lazy-src'), attr(attrs, 'src')].find(
      (s) => s && !s.startsWith('data:'),
    );
    if (!src) continue;
    const url = absoluteUrl(src, baseUrl);
    if (!url || out.includes(url)) continue;
    const file = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '');
    if (!/\.(jpe?g|png|webp)$/i.test(file) || NOT_CONTENT_IMAGE.test(file)) continue;
    const w = Number(attr(attrs, 'width'));
    const h = Number(attr(attrs, 'height'));
    if ((w && w < 200) || (h && h < 150)) continue;
    out.push(url);
  }
  return out;
}
