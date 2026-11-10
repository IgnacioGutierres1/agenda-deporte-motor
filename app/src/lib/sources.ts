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
