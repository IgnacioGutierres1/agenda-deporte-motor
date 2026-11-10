import type { SourceKind, SourceMethod } from '@dm/shared';

export const METHOD_LABELS: Record<SourceMethod, string> = {
  directo: 'Lectura directa',
  ia: 'Extraído con IA del documento oficial',
};

export const KIND_LABELS: Record<SourceKind, string> = {
  api: 'API oficial',
  html: 'Página oficial',
  pdf: 'PDF oficial',
};

/** Dominio legible de una URL ("actc.org.ar"). */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
