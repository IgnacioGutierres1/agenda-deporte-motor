/**
 * Cuenta regresiva hasta una sesión: "en 6 d 9 h", "en 2 h 15 min", "en 12 min", "En curso", "Terminó".
 *
 * Es una diferencia entre dos instantes UTC, así que no depende de la zona horaria elegida: la hora absoluta
 * que se muestra al lado sí usa la zona de Ajustes. Los minutos se redondean hacia arriba (nunca "en 0 min":
 * a 30 segundos de la largada dice "en 1 min") y las horas y los días hacia abajo.
 */

export type CountdownState = 'upcoming' | 'live' | 'finished';

export interface Countdown {
  state: CountdownState;
  /** "en 2 h 15 min" (si falta), "En curso" o "Terminó". */
  text: string;
  /** Minutos que faltan para el inicio (redondeados hacia arriba); 0 si ya empezó. */
  minutes: number;
}

const MIN = 60_000;
/** Desde esta cantidad de días se omiten las horas: "en 12 d". */
const DAYS_ONLY_FROM = 10;

function toMs(t: string | number | Date): number {
  if (typeof t === 'number') return t;
  if (t instanceof Date) return t.getTime();
  return Date.parse(t);
}

/** "en 6 d 9 h" / "en 2 h 15 min" / "en 2 h" / "en 12 min" a partir de los minutos que faltan (> 0). */
export function formatMinutesLeft(minutes: number): string {
  const m = Math.max(1, Math.ceil(minutes));
  if (m < 60) return `en ${m} min`;
  if (m < 24 * 60) {
    const h = Math.floor(m / 60);
    const rest = m % 60;
    return rest ? `en ${h} h ${rest} min` : `en ${h} h`;
  }
  const d = Math.floor(m / (24 * 60));
  const h = Math.floor((m % (24 * 60)) / 60);
  return h && d < DAYS_ONLY_FROM ? `en ${d} d ${h} h` : `en ${d} d`;
}

/**
 * Estado y texto de la cuenta regresiva de una sesión que va de `startUtc` a `endUtc` (opcional: sin fin
 * conocido, una sesión empezada se considera en curso).
 */
export function countdown(startUtc: string, endUtc: string | undefined, now: string | number | Date): Countdown {
  const start = toMs(startUtc);
  const ref = toMs(now);
  if (Number.isNaN(start) || Number.isNaN(ref)) return { state: 'upcoming', text: '', minutes: 0 };
  const left = start - ref;
  if (left > 0) {
    const minutes = Math.ceil(left / MIN);
    return { state: 'upcoming', text: formatMinutesLeft(minutes), minutes };
  }
  const end = endUtc ? toMs(endUtc) : NaN;
  if (!Number.isNaN(end) && end <= ref) return { state: 'finished', text: 'Terminó', minutes: 0 };
  return { state: 'live', text: 'En curso', minutes: 0 };
}

/** Igual que `countdown`, con "Empieza" delante si falta: "Empieza en 6 d 9 h", "En curso", "Terminó". */
export function countdownLabel(startUtc: string, endUtc: string | undefined, now: string | number | Date): string {
  const c = countdown(startUtc, endUtc, now);
  return c.state === 'upcoming' && c.text ? `Empieza ${c.text}` : c.text;
}
