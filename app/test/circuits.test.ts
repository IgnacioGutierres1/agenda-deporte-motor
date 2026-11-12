import { describe, expect, it } from 'vitest';
import type { MotorEvent } from '@dm/shared';
import { buildCircuits, circuitId, circuitKey } from '../src/lib/circuits.ts';

const ev = (id: string, seriesId: string, circuit: string, dateStart: string, country = 'France'): MotorEvent => ({
  id,
  seriesId,
  name: id,
  circuit,
  country,
  tz: 'Europe/Paris',
  dateStart,
  dateEnd: dateStart,
  sessionsStatus: 'pending',
  source: { url: 'https://example.org', title: 'x', kind: 'html', method: 'directo', fetchedAt: '2026-01-01T00:00:00Z' },
});

describe('circuitos: clave normalizada y alias', () => {
  it('une las variantes de un mismo circuito', () => {
    const same = (names: string[]) => new Set(names.map(circuitKey));
    expect(same(['Circuit Paul Ricard', 'Paul Ricard', 'Michelin 12H PAUL RICARD', 'Le Castellet'])).toEqual(new Set(['paul ricard']));
    expect(same(['Autódromo José Carlos Pace', 'Interlagos'])).toEqual(new Set(['interlagos']));
    expect(
      same(['Circuit de Spa-Francorchamps', 'Spa-Francorchamps', 'CrowdStrike 24 Hours of Spa', 'Porsche Mobil 1 Supercup – Spa Race']),
    ).toEqual(new Set(['spa francorchamps']));
    expect(same(['Circuit of The Americas', 'Circuit Of The Americas', 'Circuit des Amériques'])).toEqual(new Set(['americas']));
    expect(same(['Termas de Río Hondo', 'Circuito Termas de Rio Hondo', 'Autódromo Internacional de Termas de Río Hondo']).size).toBe(1);
    expect(same(['Ciudad San Nicolas', 'San Nicolás'])).toEqual(new Set(['san nicolas']));
    expect(same(['Suzuka Circuit', 'Suzuka 1000km'])).toEqual(new Set(['suzuka']));
  });

  it('es conservadora: no junta circuitos distintos del mismo lugar', () => {
    expect(circuitKey('Le Mans')).not.toBe(circuitKey('24 Heures du Mans'));
    expect(circuitKey('Juan Manuel Fangio-BALCARCE')).not.toBe(circuitKey('Juan Manuel Fangio-ROSARIO'));
    expect(circuitKey('Las Vegas Strip Circuit')).not.toBe(circuitKey('Las Vegas Motor Speedway'));
    expect(circuitKey('Atlanta Motor Speedway')).not.toBe(circuitKey('Michelin Raceway Road Atlanta'));
    expect(circuitKey('Michelin 24H DUBAI')).toBe('dubai');
  });

  it('sin circuito real no hay clave', () => {
    expect(circuitKey('A CONFIRMAR')).toBe('');
    expect(circuitKey('2026 End of Year Gala')).toBe('');
    expect(circuitId('Circuit Paul Ricard')).toBe('paul-ricard');
  });

  it('arma la lista de circuitos con el nombre más usado y sus eventos ordenados', () => {
    const circuits = buildCircuits([
      ev('a', 'gtwc-europe', 'Circuit Paul Ricard', '2026-04-10'),
      ev('b', 'elms', 'Paul Ricard', '2026-05-01'),
      ev('c', 'gt-open', 'Paul Ricard', '2026-07-17'),
      ev('d', '24h-series', 'Michelin 12H PAUL RICARD', '2026-06-05', ''),
      ev('e', 'tc', 'A confirmar', '2026-06-05'),
    ]);
    expect(circuits).toHaveLength(1);
    const c = circuits[0]!;
    expect(c.id).toBe('paul-ricard');
    expect(c.name).toBe('Paul Ricard');
    expect(c.country).toBe('France');
    expect(c.events.map((e) => e.id)).toEqual(['a', 'b', 'd', 'c']);
    expect(c.seriesIds).toEqual(['gtwc-europe', 'elms', 'gt-open', '24h-series']);
  });

  it('a igualdad de uso, muestra el nombre canónico del alias', () => {
    const [c] = buildCircuits([
      ev('f1', 'f1', 'Autódromo José Carlos Pace', '2026-11-06', 'Brazil'),
      ev('wec', 'wec', 'Interlagos', '2026-07-10', 'Brazil'),
    ]);
    expect(c!.name).toBe('Interlagos');
    expect(c!.names).toEqual(['Interlagos', 'Autódromo José Carlos Pace']);
  });
});
