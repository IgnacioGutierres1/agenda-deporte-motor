import type { Source, SourceKind, SourceMethod } from '@dm/shared';

export const METHOD_LABELS: Record<SourceMethod, string> = {
  directo: 'Lectura directa',
  ia: 'Extraído con IA del documento oficial',
};

export const KIND_LABELS: Record<SourceKind, string> = {
  api: 'API oficial',
  html: 'Página oficial',
  pdf: 'PDF oficial',
  image: 'Imagen oficial (leído de imagen)',
};

/** Etiqueta corta del método: "lectura directa", "extraído con IA" o "leído de imagen". */
export function shortMethodLabel(source: Pick<Source, 'kind' | 'method'>): string {
  if (source.kind === 'image') return 'leído de imagen';
  return source.method === 'ia' ? 'extraído con IA' : 'lectura directa';
}

/** Dominio legible de una URL ("actc.org.ar"). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}

/**
 * Motivo entendible de un error de lectura de la fuente oficial (el mensaje técnico, como
 * "HTTP 403 en https://…", queda para "Detalles").
 */
export function friendlySourceError(message: string | undefined): string {
  const m = message ?? '';
  if (/\b(401|403)\b|forbidden|denied|cloudflare|captcha/i.test(m)) return 'El sitio oficial no deja leer el calendario automáticamente.';
  if (/\b404\b|not found|no encontrad/i.test(m)) return 'La página del calendario cambió de lugar.';
  if (/\b429\b|too many|rate/i.test(m)) return 'El sitio oficial pidió esperar antes de volver a leerlo.';
  if (/\b5\d\d\b/.test(m)) return 'El sitio oficial tuvo un error.';
  if (/timeout|timed out|tard[oó]|abort/i.test(m)) return 'El sitio oficial tardó demasiado en responder.';
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|network|fetch failed|certificate|ssl/i.test(m)) return 'No se pudo conectar con el sitio oficial.';
  if (/gemini|quota|cuota|\bIA\b/i.test(m)) return 'No se pudo interpretar el calendario con IA (límite diario).';
  return 'No se pudo interpretar el calendario publicado.';
}
