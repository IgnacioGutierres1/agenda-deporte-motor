/**
 * Condiciones medidas en pista durante una sesión ya corrida (`SessionResult.conditions`): textos para la pestaña
 * Resultados. Es el dato que midió la organización, no el pronóstico.
 */
import type { SessionConditions } from '@dm/shared';
import { hostOf } from './sources.ts';

const isNumber = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/** -0 no se muestra como "-0°". */
const whole = (n: number): number => Math.round(n) || 0;

/**
 * Partes de la línea de condiciones, solo con los datos que existan:
 * ["Aire 24°", "Pista 38°", "Humedad 45 %", "Viento 9 km/h", "Pista seca", "Despejado"].
 */
export function conditionsParts(c: SessionConditions | null | undefined): string[] {
  if (!c) return [];
  const parts: string[] = [];
  if (isNumber(c.airC)) parts.push(`Aire ${whole(c.airC)}°`);
  if (isNumber(c.trackC)) parts.push(`Pista ${whole(c.trackC)}°`);
  if (isNumber(c.humidity)) parts.push(`Humedad ${whole(c.humidity)} %`);
  if (isNumber(c.windKmh)) parts.push(`Viento ${whole(c.windKmh)} km/h`);
  const track = c.track?.trim();
  if (track) parts.push(`Pista ${track.toLowerCase()}`);
  const weather = c.weather?.trim();
  if (weather) parts.push(weather);
  return parts;
}

/** "Aire 24° · Pista 38° · Humedad 45 % · Pista seca"; vacío si no hay ningún dato. */
export function conditionsText(c: SessionConditions | null | undefined): string {
  return conditionsParts(c).join(' · ');
}

/**
 * Rótulo de la línea. Sin fuente propia, las condiciones son de la misma fuente oficial que el resultado (la que
 * se cita al pie de la tabla). Con fuente propia (F1: OpenF1), se nombra de dónde sale la medición.
 */
export function conditionsLabel(c: SessionConditions): string {
  return c.source ? 'Medición en pista durante la sesión' : 'Medición oficial durante la sesión';
}

/** Nombre corto de la fuente propia de las condiciones ("OpenF1"), si la hay. */
export function conditionsSourceName(c: SessionConditions): string {
  if (!c.source) return '';
  return c.source.title.split(/\s[—–-]\s/)[0]?.trim() || hostOf(c.source.url);
}
