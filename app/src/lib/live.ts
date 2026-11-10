/**
 * Tiempos en vivo en la app: de dónde leer cada categoría (directo o por el proxy del Worker)
 * y cada cuánto. Las fuentes y los lectores de cada sistema de cronometraje viven en @dm/shared.
 *
 * - NASCAR: feed oficial con CORS abierto, en vivo de verdad.
 * - Speedhive (TC2000, Top Race, TN, Turismo Pista…): no hay vivo abierto; se muestra la última
 *   sesión publicada por el cronometrador (aparece unos minutos después de terminar cada sesión).
 * - MotoGP: el lector existe, pero su servidor (CloudFront) rechaza los pedidos que salen de
 *   Cloudflare, así que por ahora solo link oficial.
 * - Resto: link al cronometraje oficial.
 */
import {
  liveSource,
  NASCAR_LIVE_FEED_URL,
  parseNascarLive,
  parseSpeedhiveClassification,
  pickSpeedhiveEvents,
  pickSpeedhiveSessions,
  speedhiveClassificationUrl,
  speedhiveEventUrl,
  speedhiveOrgEventsUrl,
  LIVE_POLL_SECONDS,
  type LiveBoard,
  type SpeedhiveSelector,
} from '@dm/shared';
import { WORKER_URL } from './push.ts';

export interface LiveTarget {
  /** Página oficial de tiempos en vivo de la categoría. */
  officialUrl?: string;
  /** Aclaración sobre el link (pago, solo resultados…). */
  officialNote?: string;
  /** Carga la tabla (null = no hay sesión de esta categoría en la fuente). */
  load?: (now: Date) => Promise<LiveBoard | null>;
  intervalMs: number;
  /** 'live' = tiempos en vivo; 'results' = última sesión publicada (no es vivo). */
  kind: 'live' | 'results' | 'none';
}

/** URL a través del proxy del Worker (para fuentes que no permiten CORS). */
export function viaProxy(upstream: string): string | null {
  return WORKER_URL ? `${WORKER_URL}/api/proxy?url=${encodeURIComponent(upstream)}` : null;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { cache: 'no-store', headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** Última sesión publicada en Speedhive para la categoría (3 pedidos encadenados, todos por el proxy). */
async function loadSpeedhive(seriesId: string, selector: SpeedhiveSelector, now: Date): Promise<LiveBoard | null> {
  for (const orgId of selector.orgIds) {
    // Los cronometradores suben muchos eventos por fin de semana (karting, zonales…): se piden los últimos 30.
    const eventsUrl = viaProxy(speedhiveOrgEventsUrl(orgId, 30));
    if (!eventsUrl) return null;
    const events = pickSpeedhiveEvents(await getJson(eventsUrl), selector, now);
    for (const event of events.slice(0, 2)) {
      const eventUrl = viaProxy(speedhiveEventUrl(event.id))!;
      const sessions = pickSpeedhiveSessions(await getJson(eventUrl), selector, now);
      const last = [...sessions].sort((a, b) => b.startUtc.localeCompare(a.startUtc))[0];
      if (!last) continue;
      const classification = await getJson(viaProxy(speedhiveClassificationUrl(last.id))!);
      const board = parseSpeedhiveClassification(classification, now, { session: last, eventName: event.name, seriesId });
      if (board?.rows.length) return board;
    }
  }
  return null;
}

export function liveTargetFor(seriesId: string): LiveTarget {
  const src = liveSource(seriesId);
  if (!src) return { intervalMs: 0, kind: 'none' };
  const base = { officialUrl: src.officialUrl, ...(src.officialNote ? { officialNote: src.officialNote } : {}) };
  if (src.provider === 'nascar') {
    return {
      ...base,
      kind: 'live',
      intervalMs: LIVE_POLL_SECONDS.nascar * 1000,
      // Un solo feed para Cup/O'Reilly/Truck: el lector informa la categoría y se descarta si no es esta.
      load: async (now) => {
        const board = parseNascarLive(await getJson(NASCAR_LIVE_FEED_URL), now);
        return board && board.seriesId === seriesId ? board : null;
      },
    };
  }
  if (src.provider === 'speedhive' && src.speedhive && WORKER_URL) {
    const selector = src.speedhive;
    return { ...base, kind: 'results', intervalMs: LIVE_POLL_SECONDS.speedhive * 1000, load: (now) => loadSpeedhive(seriesId, selector, now) };
  }
  return { ...base, kind: 'none', intervalMs: 0 };
}
