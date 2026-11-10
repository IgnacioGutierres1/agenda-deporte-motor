import { createHash } from 'node:crypto';
import type { SourceKind } from '@dm/shared';
import type { Http } from '../core/http.ts';
import { htmlToText } from './html.ts';

/** Documento oficial descargado, listo para extraer datos (con o sin IA). */
export interface FetchedDocument {
  url: string;
  kind: SourceKind;
  /** HTML crudo (kind html), JSON crudo (kind api) o '' (pdf). */
  raw: string;
  /** Texto legible: texto compacto del HTML, texto del PDF o JSON crudo. Es contra lo que se valida la IA. */
  text: string;
  /** Bytes del PDF (para pasárselo a Gemini como inlineData). */
  pdf?: Uint8Array;
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
