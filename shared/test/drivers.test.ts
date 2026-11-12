import { describe, expect, it } from 'vitest';
import {
  driverDisplayName,
  driverId,
  driverInitials,
  driverKey,
  isDriverTable,
  isSingleDriverName,
  nameQuality,
} from '../src/drivers.ts';

describe('pilotos', () => {
  it('une las variantes de un mismo nombre publicadas por distintos sitios', () => {
    const variants = ['Agustín CANAPINO', 'Canapino, Agustin', 'Agustín Canapino', 'CANAPINO, Agustín'];
    expect(new Set(variants.map(driverId))).toEqual(new Set(['agustin-canapino']));
    expect(driverKey('A. Palmowski PAL')).toBe('a palmowski');
    expect(driverKey('C. Bättig (WCD) BAE')).toBe('battig c wcd');
    // Apellido de tres letras en mayúsculas (listas de SRO): no es un código.
    expect(driverId('Mikkel MAC')).toBe('mac-mikkel');
    expect(driverId('Alex AKA')).toBe('aka-alex');
    expect(driverDisplayName('Mikkel MAC')).toBe('Mikkel Mac');
    expect(driverId('Kimi Antonelli')).not.toBe(driverId('Andrea Kimi Antonelli'));
  });

  it('arma un nombre legible', () => {
    expect(driverDisplayName('CANAPINO, Agustin')).toBe('Agustin Canapino');
    expect(driverDisplayName('Agustín CANAPINO')).toBe('Agustín Canapino');
    expect(driverDisplayName('NICOLÁS JAIME')).toBe('Nicolás Jaime');
    expect(driverDisplayName('HERMIDA ALONSO, FEDERICO')).toBe('Federico Hermida Alonso');
    expect(driverDisplayName('Gabriel P. de Leon')).toBe('Gabriel P. de Leon');
    expect(driverDisplayName('AGUSTIN DE LA VEGA')).toBe('Agustin de la Vega');
    expect(driverDisplayName('A. Palmowski PAL')).toBe('A. Palmowski');
    expect(driverDisplayName('Kimi Antonelli')).toBe('Kimi Antonelli');
    expect(driverDisplayName('AJ Allmendinger')).toBe('AJ Allmendinger');
  });

  it('prefiere la variante más prolija del nombre', () => {
    expect(nameQuality('Agustín Canapino')).toBeGreaterThan(nameQuality('CANAPINO, Agustin'));
    expect(nameQuality('Agustín Canapino')).toBeGreaterThan(nameQuality('Agustín CANAPINO') - 1);
  });

  it('distingue tablas de pilotos de las de equipos y marcas', () => {
    for (const t of ['Pilotos', 'Clase 2', 'NTT INDYCAR SERIES CHAMPIONSHIP', '2026 F1 Academy Standings']) expect(isDriverTable(t)).toBe(true);
    for (const t of ['Equipos', 'Constructores', 'Propietarios', 'Marcas', 'GT World Challenge Europe Powered by AWS Teams']) {
      expect(isDriverTable(t)).toBe(false);
    }
  });

  it('descarta tripulaciones de varios pilotos y arma iniciales', () => {
    expect(isSingleDriverName('Vanthoor / Estre / Campbell')).toBe(false);
    expect(isSingleDriverName('Max Verstappen')).toBe(true);
    expect(driverInitials('Agustín Canapino')).toBe('AC');
    expect(driverInitials('Agustin de la Vega')).toBe('AV');
    expect(driverInitials('Marc Marquez')).toBe('MM');
  });
});

describe('grupos de fichas de pilotos', () => {
  it('el shard es estable (lo comparten el pipeline y la app) y reparte parejo', async () => {
    const { driverShard, driverShardPath, DRIVER_SHARDS } = await import('../src/drivers.ts');
    expect(driverShard('agustin-canapino')).toMatch(/^[0-9a-f]{2}$/);
    expect(driverShard('agustin-canapino')).toBe(driverShard('agustin-canapino'));
    expect(driverShardPath('max-verstappen')).toBe(`drivers/${driverShard('max-verstappen')}.json`);
    // Valor fijo: si cambia el hash, cambian las rutas publicadas y las apps instaladas piden otros archivos.
    expect(driverShard('a')).toBe('2c');
    const counts = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      const k = driverShard(`piloto-${i}`);
      counts.set(k, (counts.get(k) ?? 0) + 1);
    }
    expect(counts.size).toBeGreaterThan(DRIVER_SHARDS * 0.9);
    expect(Math.max(...counts.values())).toBeLessThan(30);
  });
});
