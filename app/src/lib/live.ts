/**
 * Tiempos en vivo en la app: de dónde leer cada categoría (directo o por el proxy del Worker)
 * y cada cuánto. Los lectores de cada sistema de cronometraje viven en @dm/shared.
 */
import type { LiveBoard } from '@dm/shared';
import { WORKER_URL } from './push.ts';

export interface LiveFeed {
  /** URL a consultar (ya armada con el proxy si hace falta). */
  url: string;
  intervalMs: number;
  parse: (json: unknown, now: string) => LiveBoard | null;
}

export interface LiveTarget {
  /** Página oficial de tiempos en vivo de la categoría (si se conoce). */
  officialUrl?: string;
  /** Tabla dentro de la app (si la fuente lo permite). */
  feed?: LiveFeed;
}

/** URL a través del proxy del Worker (para fuentes que no permiten CORS). */
export function viaProxy(upstream: string): string | null {
  return WORKER_URL ? `${WORKER_URL}/api/proxy?url=${encodeURIComponent(upstream)}` : null;
}

/** Fuente de tiempos en vivo de una categoría. Se completa con la tabla de fuentes de @dm/shared. */
export function liveTargetFor(_seriesId: string): LiveTarget {
  return {};
}

export async function fetchBoard(feed: LiveFeed, now: string): Promise<LiveBoard | null> {
  const res = await fetch(feed.url, { cache: 'no-store', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return feed.parse(await res.json(), now);
}
