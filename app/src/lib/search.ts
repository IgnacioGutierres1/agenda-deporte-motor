/**
 * Búsquedas puras (sin acentos ni mayúsculas) que usan Buscar, Siguiendo y los stores.
 */
import type { Driver, Team } from '@dm/shared';
import type { Circuit } from './circuits.ts';

export const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

export function queryWords(query: string): string[] {
  return normalize(query.trim()).split(/\s+/).filter(Boolean);
}

export function matchesAll(hay: string, words: string[]): boolean {
  const h = normalize(hay);
  return words.every((w) => h.includes(w));
}

/** Número de auto tal como se escribe al buscar ("#7" o "7"). */
const carNumber = (q: string) => q.replace(/^#/, '');

/**
 * Pilotos por nombre o número de auto (en una tabla o en una inscripción). Primero los mejor
 * ubicados; los que solo están inscriptos (sin tabla) van después.
 */
export function searchDrivers(drivers: Driver[], query: string, limit = 30): Driver[] {
  const q = normalize(query.trim());
  if (q.length < 2) return [];
  const words = q.split(/\s+/);
  const num = carNumber(q);
  const best = (d: Driver) => Math.min(...d.entries.map((e) => e.pos));
  return drivers
    .filter(
      (d) =>
        words.every((w) => normalize(d.name).includes(w)) ||
        d.entries.some((e) => e.number === num) ||
        (d.lineups ?? []).some((l) => l.number === num),
    )
    .sort((a, b) => best(a) - best(b) || a.name.localeCompare(b.name, 'es'))
    .slice(0, limit);
}

/** Equipos por nombre o por número de auto. */
export function searchTeams(teams: Team[], query: string, limit = 10): Team[] {
  const words = queryWords(query);
  if (words.join(' ').length < 2) return [];
  const num = carNumber(words.join(' '));
  const best = (t: Team) => Math.min(...t.entries.map((e) => e.pos ?? Infinity));
  return teams
    .filter((t) => matchesAll(t.name, words) || t.entries.some((e) => e.numbers?.includes(num)))
    .sort((a, b) => best(a) - best(b) || b.drivers.length - a.drivers.length || a.name.localeCompare(b.name, 'es'))
    .slice(0, limit);
}

/** Circuitos por cualquiera de sus nombres o su país. */
export function searchCircuits(circuits: Circuit[], query: string, limit = 8): Circuit[] {
  const words = queryWords(query);
  if (words.join(' ').length < 2) return [];
  return circuits
    .filter((c) => matchesAll(`${c.names.join(' ')} ${c.country}`, words))
    .sort((a, b) => b.events.length - a.events.length || a.name.localeCompare(b.name, 'es'))
    .slice(0, limit);
}
