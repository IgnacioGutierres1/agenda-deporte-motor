/**
 * Circuitos del calendario: agrupa los eventos por circuito con el mismo criterio que la app
 * (app/src/lib/circuits.ts, buildCircuits): misma clave, el nombre más usado y el país más frecuente.
 * Está repetido a propósito: el pipeline no importa nada de app/.
 */
import { circuitBaseKey, circuitKey, slugify, type MotorEvent } from '@dm/shared';

export interface CircuitGroup {
  /** Id de la ficha: slug de la clave (igual a circuitId(event.circuit)). */
  id: string;
  key: string;
  /** Nombre para mostrar (la variante más usada y más "limpia"). */
  name: string;
  /** Todas las variantes con que lo publican las categorías, de la más usada a la menos. */
  names: string[];
  /** País más frecuente entre sus eventos, en español ("Argentina"); '' si ninguno lo informa. */
  country: string;
  seriesIds: string[];
  /** Cantidad de eventos del calendario en ese circuito. */
  events: number;
}

/** Variantes que son nombre de carrera más que de circuito: se usan solo si no hay otra. */
const EVENTY = /\d+\s*h\b|hours|heures|\d+\s*km|michelin|crowdstrike|supercup|festival|prologue|\brace$|\(/i;

function mostCommon(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es')).map(([v]) => v);
}

type EventLike = Pick<MotorEvent, 'circuit' | 'country' | 'seriesId'>;

/** Agrupa los eventos por circuito (los "A confirmar" y similares no forman grupo). */
export function groupCircuits(events: EventLike[]): CircuitGroup[] {
  const byKey = new Map<string, EventLike[]>();
  for (const e of events) {
    const key = circuitKey(e.circuit);
    if (!key || !slugify(key)) continue;
    const list = byKey.get(key);
    if (list) list.push(e);
    else byKey.set(key, [e]);
  }
  const out: CircuitGroup[] = [];
  for (const [key, list] of byKey) {
    const counts = new Map<string, number>();
    for (const e of list) counts.set(e.circuit.trim(), (counts.get(e.circuit.trim()) ?? 0) + 1);
    // La variante más usada; a igualdad, la que ya es el nombre canónico ("Interlagos").
    const names = [...counts.keys()].sort(
      (a, b) =>
        counts.get(b)! - counts.get(a)! ||
        Number(circuitBaseKey(b) === key) - Number(circuitBaseKey(a) === key) ||
        a.localeCompare(b, 'es'),
    );
    out.push({
      id: slugify(key),
      key,
      name: names.find((n) => !EVENTY.test(n)) ?? names[0]!,
      names,
      country: mostCommon(list.map((e) => e.country.trim()).filter(Boolean))[0] ?? '',
      seriesIds: [...new Set(list.map((e) => e.seriesId))],
      events: list.length,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}
