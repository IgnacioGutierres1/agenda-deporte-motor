/**
 * Wikimedia Commons: miniatura y atribución (autor, licencia, página del archivo) de las imágenes de un circuito.
 * Las imágenes se enlazan, no se copian; sin licencia conocida la imagen no se usa.
 */
import type { CircuitImage } from '@dm/shared';
import { textOf } from '../extract/html.ts';
import type { Api } from './api.ts';

const API = 'https://commons.wikimedia.org/w/api.php';
const BATCH = 25;

/** Clave de un archivo: sin prefijo "File:", con espacios y la primera letra en mayúscula (como lo normaliza MediaWiki). */
export function fileKey(name: string): string {
  const t = name
    .replace(/^\s*(?:File|Image|Archivo|Imagen|Fichero)\s*:/i, '')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : '';
}

/** Nombre de archivo de una URL de upload.wikimedia.org de Commons ("…/commons/f/f8/Monza_track_map.svg"). */
export function fileFromUploadUrl(url: string | undefined): string | undefined {
  const m = url ? /\/wikipedia\/commons\/(?:thumb\/)?[0-9a-f]\/[0-9a-f]{2}\/([^/?#]+)/.exec(url) : null;
  if (!m) return undefined;
  try {
    return fileKey(decodeURIComponent(m[1]!));
  } catch {
    return undefined;
  }
}

const LICENSES: Record<string, string> = {
  'public domain': 'Dominio público',
  pd: 'Dominio público',
  'no restrictions': 'Sin restricciones conocidas',
  'copyrighted free use': 'Uso libre',
  attribution: 'Uso libre con atribución',
};

/** Autor en texto plano a partir del HTML de Commons ("<a href=…>Will Pittenger</a>"). */
export function cleanCredit(html: string | undefined): string {
  if (!html) return '';
  let t = textOf(
    html
      .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ')
      // Bloques ocultos de las plantillas de Commons (traducciones, microformatos).
      .replace(/<(span|div)\b[^>]*style="[^"]*display:\s*none[^"]*"[^>]*>[\s\S]*?<\/\1>/gi, ' '),
  );
  t = t
    .replace(/\b(Unknown author|Autor desconocido|Unknown)(\s*\1)+/gi, '$1')
    // Restos de la firma de Wikipedia y de las plantillas de Commons.
    .replace(/(?:^|\s)(?:[a-z]{2,3}:)?(?:User|Usuario):\s*/gi, ' ')
    .replace(/\s*\(\s*(?:talk|discusión|d|uploads|contribs|contribuciones)\s*\)/gi, ' ')
    .replace(/\s*\d{1,2}:\d{2},\s+\d{1,2}\s+\p{L}+\s+\d{4}\s*\(UTC\)/giu, ' ')
    .replace(/\s*This W3C-(?:un)?specified vector image was created with [^.]+\.?/gi, ' ')
    .replace(/\s*\b(?:Own work|Trabajo propio)\b/gi, ' ')
    .replace(/\s+([,;.])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  if (/^(unknown author|unknown|autor desconocido|anonymous|an[oó]nimo)$/i.test(t)) return 'Autor desconocido';
  if (t.length > 120) t = `${t.slice(0, 117).replace(/\s+\S*$/, '')}…`;
  return t;
}

interface ImageInfo {
  thumburl?: string;
  thumbwidth?: number;
  thumbheight?: number;
  url?: string;
  width?: number;
  height?: number;
  descriptionurl?: string;
  extmetadata?: Record<string, { value?: unknown } | undefined>;
}

interface ImagePage {
  title?: string;
  missing?: boolean;
  imageinfo?: ImageInfo[];
}

function meta(info: ImageInfo, key: string): string {
  const v = info.extmetadata?.[key]?.value;
  return typeof v === 'string' ? v : '';
}

/** Saca los parámetros de seguimiento que agrega la API (utm_*). */
function cleanUrl(url: string): string {
  return url.replace(/\?utm_[^#]*$/, '');
}

export function toCircuitImage(info: ImageInfo): CircuitImage | null {
  const url = info.thumburl ?? info.url;
  const page = info.descriptionurl;
  const license = textOf(meta(info, 'LicenseShortName'));
  if (!url || !page || !license || meta(info, 'NonFree') === 'true') return null;
  const width = info.thumburl ? info.thumbwidth : info.width;
  const height = info.thumburl ? info.thumbheight : info.height;
  const size =
    typeof width === 'number' && typeof height === 'number' && width > 0 && height > 0
      ? { width: Math.round(width), height: Math.round(height) }
      : {};
  return {
    url: cleanUrl(url),
    ...size,
    credit: cleanCredit(meta(info, 'Artist')) || cleanCredit(meta(info, 'Credit')) || 'Wikimedia Commons',
    license: LICENSES[license.toLowerCase()] ?? license,
    page,
  };
}

/**
 * Miniatura (~960 px) y atribución de cada archivo. Devuelve un mapa por fileKey(nombre); los archivos que no
 * existen en Commons o no informan licencia no aparecen.
 */
export async function fetchImages(api: Api, files: string[], width = 960): Promise<Map<string, CircuitImage>> {
  const out = new Map<string, CircuitImage>();
  const keys = [...new Set(files.map(fileKey).filter(Boolean))];
  for (let i = 0; i < keys.length; i += BATCH) {
    const titles = keys.slice(i, i + BATCH).map((k) => `File:${k}`);
    const url =
      `${API}?action=query&titles=${encodeURIComponent(titles.join('|'))}&prop=imageinfo` +
      `&iiprop=url%7Csize%7Cextmetadata&iiurlwidth=${width}` +
      '&iiextmetadatafilter=Artist%7CCredit%7CLicenseShortName%7CNonFree&format=json&formatversion=2';
    const res = await api.get<{ query?: { pages?: ImagePage[] } }>(url);
    for (const page of res.query?.pages ?? []) {
      const info = page.imageinfo?.[0];
      if (!page.title || page.missing || !info) continue;
      const image = toCircuitImage(info);
      if (image) out.set(fileKey(page.title), image);
    }
  }
  return out;
}

// ── ¿Plano o foto? ──

const NOT_CONTENT = /\b(logo|logotipo|flag|bandera|icon|icono|escudo|coat of arms|emblem|wordmark|locator|location map|relief)\b/i;
const PLAN_WORDS =
  /(^|[^a-z])(map|mapa|maps|trackmap|layout|layouts|track|trazado|trazados|plano|plan|circuit map|tracciato|strecke|streckenverlauf|configuration|configuraci[oó]n)([^a-z]|$)/i;

/** true si el nombre del archivo indica un plano del trazado (un SVG que no es logo, o "map", "layout", "track"…). */
export function isPlanFile(name: string): boolean {
  const n = fileKey(name);
  if (!n || NOT_CONTENT.test(n)) return false;
  return /\.svg$/i.test(n) || PLAN_WORDS.test(n.replace(/\.[a-z]+$/i, ''));
}

/**
 * true si una imagen de la ficha del artículo es un dibujo (PNG o GIF que no es logo): la imagen principal de la
 * ficha de un circuito es el plano por convención ("Yas Marina Circuit.png", "Kyalami 16.png").
 */
export function isDiagramFile(name: string): boolean {
  const n = fileKey(name);
  return /\.(png|gif)$/i.test(n) && !NOT_CONTENT.test(n);
}

/** true si puede ser una foto del circuito: imagen de mapa de bits que no es logo ni plano. */
export function isPhotoFile(name: string): boolean {
  const n = fileKey(name);
  return /\.(jpe?g|png|webp|tiff?)$/i.test(n) && !NOT_CONTENT.test(n) && !isPlanFile(n);
}
