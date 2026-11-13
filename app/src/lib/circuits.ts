/**
 * Circuitos de la app: agrupa los eventos del calendario por circuito. La clave normalizada (circuitKey) vive en
 * @dm/shared para que el pipeline arme data/circuits.json con los mismos ids.
 * Lógica pura, sin Vue ni Pinia.
 */
import { circuitBaseKey, circuitId, circuitKey, slugify, type MotorEvent } from '@dm/shared';

export { circuitId, circuitKey };

export interface Circuit {
  id: string;
  key: string;
  /** Nombre para mostrar (la variante más usada y más "limpia"). */
  name: string;
  /** Todas las variantes con que lo publican las categorías. */
  names: string[];
  country: string;
  seriesIds: string[];
  /** Eventos ordenados por fecha. */
  events: MotorEvent[];
}

/** Variantes que son nombre de carrera más que de circuito: se usan solo si no hay otra. */
const EVENTY = /\d+\s*h\b|hours|heures|\d+\s*km|michelin|crowdstrike|supercup|festival|prologue|\brace$|\(/i;

function mostCommon(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es')).map(([v]) => v);
}

/** Agrupa los eventos por circuito. */
export function buildCircuits(events: MotorEvent[]): Circuit[] {
  const byKey = new Map<string, MotorEvent[]>();
  for (const e of events) {
    const key = circuitKey(e.circuit);
    if (!key) continue;
    const list = byKey.get(key);
    if (list) list.push(e);
    else byKey.set(key, [e]);
  }
  const out: Circuit[] = [];
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
    const name = names.find((n) => !EVENTY.test(n)) ?? names[0]!;
    out.push({
      id: slugify(key),
      key,
      name,
      names,
      country: mostCommon(list.map((e) => e.country.trim()).filter(Boolean))[0] ?? '',
      seriesIds: [...new Set(list.map((e) => e.seriesId))],
      events: [...list].sort((a, b) => a.dateStart.localeCompare(b.dateStart) || a.seriesId.localeCompare(b.seriesId)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}
