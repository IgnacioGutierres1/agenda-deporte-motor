/**
 * Utilidades de los lectores de resultados de los sitios de Asia y Oceanía (SUPER GT, SUPER FORMULA, Supercars,
 * Macao): condiciones publicadas en inglés, tiempos y orden de la general en carreras con clases.
 */
import type { ResultRow, Session, SessionConditions } from '@dm/shared';

/** Estado del cielo en español a partir del texto oficial ("Sunny/Cloudy", "Cloudy & Rain", "Fine"). */
export function weatherEs(text: string): string | undefined {
  const parts = text
    .split(/\s*(?:\/|&|,|\band\b|→|->)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) =>
      /rain|shower|drizzle|雨/i.test(p)
        ? 'Lluvia'
        : /cloud|overcast|曇/i.test(p)
          ? 'Nublado'
          : /sun|fine|clear|晴/i.test(p)
            ? 'Despejado'
            : null,
    )
    .filter((p): p is NonNullable<typeof p> => !!p);
  const unique = [...new Set(parts)];
  return unique.length ? unique.join(' / ') : undefined;
}

/** Estado de la pista en español ("Dry", "Wet/Dry", "Semi-Wet", "Damp"). */
export function trackEs(text: string): string | undefined {
  const parts = text
    .split(/\s*(?:\/|&|,|\band\b|→|->)\s*/i)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => (/semi|damp|ハーフ/i.test(p) ? 'Húmeda' : /wet|ウェット/i.test(p) ? 'Mojada' : /dry|ドライ/i.test(p) ? 'Seca' : null))
    .filter((p): p is NonNullable<typeof p> => !!p);
  const unique = [...new Set(parts)];
  return unique.length ? unique.join(' / ') : undefined;
}

/** Condiciones a partir de los textos de cielo y pista; undefined si no hay nada reconocible. */
export function conditionsOf(weather: string, track: string): SessionConditions | undefined {
  const w = weatherEs(weather);
  const t = trackEs(track);
  if (!w && !t) return undefined;
  return { ...(w ? { weather: w } : {}), ...(t ? { track: t } : {}) };
}

/** Tiempo de vuelta tal como lo publican los sitios japoneses ("1'20.654", "1’20.654", "2:04’03.577") -> "1:20.654". */
export function lapTime(text: string): string | undefined {
  // "1h05’17.129" (carrera de más de una hora) -> "1:05:17.129".
  const t = text.replace(/[’'′]/g, ':').replace(/(\d)\s*h\s*(\d)/i, '$1:$2').replace(/\s+/g, '').trim();
  return /^\d+(?::\d{1,2})*\.\d+$/.test(t) ? t : undefined;
}

/** Segundos -> "1:09.495" / "1:43:30.562" (milésimas redondeadas). */
export function formatSeconds(total: number): string {
  const ms = Math.round(total * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(3).padStart(6, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** Diferencia publicada ("19.602", "1 Lap", "2 Laps", "4Laps") -> "+19.602" / "+1 vuelta" / "+2 vueltas". */
export function gapText(text: string): string | undefined {
  const t = text.trim();
  if (!t || t === '-') return undefined;
  const laps = t.match(/^\+?\s*(\d+)\s*(?:laps?|lp\.?|周)$/i);
  if (laps) return `+${laps[1]} ${laps[1] === '1' ? 'vuelta' : 'vueltas'}`;
  const time = lapTime(t.replace(/^\+/, ''));
  return time ? `+${time}` : undefined;
}

/** Nombre de la sesión tal como figura en la fuente (el que leyó el cronograma). */
export const sourceName = (s: Pick<Session, 'name' | 'originalName'>) => s.originalName ?? s.name;

/** Puesto dentro de la clase en el orden en que vienen las filas (las que no tienen puesto no cuentan). */
export function fillClassPositions(rows: ResultRow[]): ResultRow[] {
  const next = new Map<string, number>();
  return rows.map((r) => {
    if (!r.class || r.pos === null || r.classPos !== undefined) return r;
    const n = (next.get(r.class) ?? 0) + 1;
    next.set(r.class, n);
    return { ...r, classPos: n };
  });
}
