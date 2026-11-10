import { createHash } from 'node:crypto';
import type { SourceKind } from '@dm/shared';
import type { Http } from '../core/http.ts';
import { htmlToText } from './html.ts';

/** Imagen oficial descargada (calendario o cronograma publicado como imagen). */
export interface DocImage {
  url: string;
  mimeType: string;
  data: Uint8Array;
}

/** Documento oficial descargado, listo para extraer datos (con o sin IA). */
export interface FetchedDocument {
  url: string;
  kind: SourceKind;
  /** HTML crudo (kind html), JSON crudo (kind api) o '' (pdf, image). */
  raw: string;
  /** Texto legible: texto compacto del HTML, texto del PDF, JSON crudo o texto transcripto de las imágenes. Es contra lo que se valida la IA. */
  text: string;
  /** Bytes del PDF (para pasárselo a Gemini como inlineData). */
  pdf?: Uint8Array;
  /** Imágenes de las que se transcribió el texto (kind image). */
  images?: DocImage[];
  title: string;
  /** sha256 del contenido relevante (para la caché de extracción). */
  hash: string;
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Codifica espacios y otros caracteres que algunos sitios dejan sin codificar en sus links (p. ej. PDFs de SRO). */
export function safeUrl(url: string): string {
  try {
    return new URL(url.replace(/ /g, '%20')).toString();
  } catch {
    return url;
  }
}

export function looksLikePdf(url: string, contentType = ''): boolean {
  return /application\/pdf/i.test(contentType) || /\.pdf(\?|#|$)/i.test(url);
}

/** Texto de un PDF con unpdf (import diferido: solo se carga si hace falta). */
export async function pdfToText(bytes: Uint8Array): Promise<string> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  // unpdf/pdf.js toma posesión del buffer: se le pasa una copia.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: true });
  return Array.isArray(text) ? text.join('\n') : text;
}

/**
 * Descarga un documento oficial (HTML, PDF o JSON) por ctx.http (memoizado por URL en la corrida).
 * El hash se calcula sobre el texto legible: cambios cosméticos del HTML (tokens, scripts) no invalidan la caché.
 */
export async function fetchDocument(http: Http, url: string): Promise<FetchedDocument> {
  const target = safeUrl(url);
  if (looksLikePdf(target)) return fetchPdf(http, target);
  const res = await http.text(target);
  if (looksLikePdf(res.url, res.contentType)) return fetchPdf(http, target);
  const isJson = /json/i.test(res.contentType) || /^\s*[[{]/.test(res.body.slice(0, 10));
  if (isJson) {
    return { url: target, kind: 'api', raw: res.body, text: res.body, title: '', hash: sha256(res.body) };
  }
  const text = htmlToText(res.body, res.url || target);
  const title = (res.body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  return { url: target, kind: 'html', raw: res.body, text, title, hash: sha256(text) };
}

async function fetchPdf(http: Http, url: string): Promise<FetchedDocument> {
  const res = await http.bytes(url);
  const bytes = res.body;
  let text = '';
  try {
    text = await pdfToText(bytes);
  } catch {
    text = '';
  }
  const name = decodeURIComponent(url.split('/').pop() ?? 'documento.pdf');
  return { url, kind: 'pdf', raw: '', text, pdf: bytes, title: name, hash: sha256(bytes) };
}

/** Texto mínimo que tiene que tener un documento para que valga la pena pasárselo a Gemini. */
export function hasUsableText(doc: FetchedDocument): boolean {
  return doc.text.replace(/\s+/g, '').length >= 40;
}

/** Tope por imagen (Gemini acepta hasta 20 MB por pedido, en base64). */
const MAX_IMAGE_BYTES = 7_000_000;

function imageMime(url: string, contentType: string): string | null {
  const ct = contentType.split(';')[0]!.trim().toLowerCase();
  if (/^image\/(jpeg|png|webp)$/.test(ct)) return ct;
  const ext = url.split(/[?#]/)[0]!.split('.').pop()?.toLowerCase();
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png' || ext === 'webp') return `image/${ext}`;
  return null;
}

/** Descarga imágenes oficiales (las que fallan, no son imagen o pesan demasiado se omiten). */
export async function fetchImages(http: Http, urls: string[]): Promise<DocImage[]> {
  const out: DocImage[] = [];
  for (const url of urls) {
    try {
      const res = await http.bytes(safeUrl(url));
      const mimeType = imageMime(url, res.contentType);
      if (!mimeType || res.body.length === 0 || res.body.length > MAX_IMAGE_BYTES) continue;
      out.push({ url, mimeType, data: res.body });
    } catch {
      /* imagen no disponible: se sigue con las demás */
    }
  }
  return out;
}
