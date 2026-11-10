import type { Source, SourceKind } from '@dm/shared';
import type { AdapterContext } from '../core/types.ts';

/** ISO UTC sin milisegundos del momento de la corrida. */
export function fetchedAt(ctx: AdapterContext): string {
  return ctx.now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function directSource(
  ctx: AdapterContext,
  url: string,
  title: string,
  kind: SourceKind = 'api',
): Source {
  return { url, title, kind, method: 'directo', fetchedAt: fetchedAt(ctx) };
}

const regionNames = new Intl.DisplayNames(['es'], { type: 'region' });

/** Nombre del país en español a partir del código ISO 3166 alfa-2 ("PT" -> "Portugal"). */
export function countryName(iso: string | undefined, fallback = ''): string {
  if (!iso || !/^[A-Za-z]{2}$/.test(iso)) return fallback;
  try {
    return regionNames.of(iso.toUpperCase()) ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Zona IANA en su forma canónica ("EUROPE/MADRID" -> "Europe/Madrid").
 * Lanza si la zona no existe.
 */
export function canonicalZone(zone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: zone.trim() }).resolvedOptions().timeZone;
}

/** "41:29.173" | "01:52.278" -> sin ceros a la izquierda en los minutos ("1:52.278"). */
export function trimLapTime(t: string | null | undefined): string | undefined {
  if (!t) return undefined;
  return t.trim().replace(/^0(\d:)/, '$1');
}

/** Segundos -> "32.680" o "1:05.123". */
export function formatSeconds(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  const ss = s.toFixed(3).padStart(6, '0');
  return m > 0 ? `${m}:${ss}` : s.toFixed(3);
}

export function lapsLabel(n: number): string {
  return `+${n} ${n === 1 ? 'vuelta' : 'vueltas'}`;
}
