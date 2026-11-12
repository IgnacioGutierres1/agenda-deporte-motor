import { describe, expect, it } from 'vitest';
import aliasConfig from '../../config/driver-aliases.json' with { type: 'json' };
import {
  baseDriverId,
  cleanDriverName,
  driverDisplayName,
  driverId,
  driverInitials,
  driverKey,
  isBrokenDriverName,
  isDriverTable,
  isSingleDriverName,
  knownHomonyms,
  nameQuality,
  resolveDriverId,
} from '../src/drivers.ts';

describe('pilotos', () => {
  it('une las variantes de un mismo nombre publicadas por distintos sitios', () => {
    const variants = ['Agustín CANAPINO', 'Canapino, Agustin', 'Agustín Canapino', 'CANAPINO, Agustín'];
    expect(new Set(variants.map((n) => driverId(n)))).toEqual(new Set(['agustin-canapino']));
    expect(driverKey('A. Palmowski PAL')).toBe('a palmowski');
    // "(WCD)" (invitado) no es parte del nombre.
    expect(driverKey('C. Bättig (WCD) BAE')).toBe('battig c');
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

describe('nombres sucios, alias y homónimos (config/driver-aliases.json)', () => {
  it('quita notas al pie y etiquetas de invitado; "(h)" va al final', () => {
    expect(driverDisplayName('Alex Sedgwick***')).toBe('Alex Sedgwick');
    expect(driverId('Alex Sedgwick***')).toBe(driverId('Alex Sedgwick'));
    expect(driverDisplayName('A. Danielsson (WCD) DAN')).toBe('A. Danielsson');
    expect(driverDisplayName('Gustavo (H) TADEI')).toBe('Gustavo Tadei (h)');
    // El hijo no se une con el padre.
    expect(driverId('Gustavo (h) Tadei')).not.toBe(driverId('Gustavo Tadei'));
    expect(cleanDriverName('Name†')).toBe('Name');
  });

  it('repara letras perdidas y rechaza las que no se pueden reparar', () => {
    expect(driverId('MENENDEZ, AGUST?N')).toBe('agustin-menendez');
    expect(driverDisplayName('MENENDEZ, AGUST?N')).toBe('Agustín Menendez');
    expect(isBrokenDriverName('MENENDEZ, AGUST?N')).toBe(false);
    expect(isBrokenDriverName('P?REZ, JUAN')).toBe(true);
    expect(nameQuality('Alex Sedgwick***')).toBeLessThan(nameQuality('Alex Sedgwick'));
  });

  it('fuentes en español: acento del nombre de pila escrito en mayúsculas', () => {
    expect(driverDisplayName('CORTINA, JOAQUIN', { spanish: true })).toBe('Joaquín Cortina');
    expect(driverDisplayName('VAZQUEZ, JUAN MARTIN', { spanish: true })).toBe('Juan Martín Vazquez');
    // Sin coma no se sabe si "MARTIN" es nombre o apellido: no se toca.
    expect(driverDisplayName('MARTIN AGUSTIN', { spanish: true })).toBe('Martin Agustin');
    expect(driverDisplayName('NICOLAS PEZZUCCHI', { spanish: true })).toBe('Nicolás Pezzucchi');
    // Fuera de las categorías argentinas, tal cual.
    expect(driverDisplayName('CORTINA, JOAQUIN')).toBe('Joaquin Cortina');
    // Lo que la fuente escribió con minúsculas se respeta.
    expect(driverDisplayName('Joaquin Cortina', { spanish: true })).toBe('Joaquin Cortina');
  });

  it('variantes conocidas van al id canónico; homónimos conocidos se separan por categoría', () => {
    expect(driverId('Cam Waters')).toBe('cameron-waters');
    expect(driverId('Alexey Nesov')).toBe('aleksei-nesov');
    expect(driverId('Jamie Alan Day')).toBe('day-jamie');
    expect(baseDriverId('Cam Waters')).toBe('cam-waters');
    expect(driverId('Josh Berry')).toBe('berry-josh');
    expect(driverId('Josh Berry', 'nascar-cup')).toBe('berry-josh');
    expect(driverId('Josh Berry', '24h-series')).toBe('berry-josh-24h');
    expect(resolveDriverId('dario-franchitti', '24h-series')).toBe('dario-franchitti-24h');
  });

  it('config/driver-aliases.json es consistente', () => {
    const slug = /^[a-z0-9]+(-[a-z0-9]+)*$/;
    for (const [alias, canonical] of Object.entries(aliasConfig.aliases)) {
      expect(alias, alias).toMatch(slug);
      expect(canonical, canonical).toMatch(slug);
      // Sin cadenas: el destino no puede ser a su vez un alias.
      expect(aliasConfig.aliases, canonical).not.toHaveProperty(canonical);
    }
    for (const rule of aliasConfig.doNotMerge) {
      expect(rule.as).toMatch(slug);
      expect(rule.series.length).toBeGreaterThan(0);
      expect(aliasConfig.aliases).not.toHaveProperty(rule.id);
    }
    expect(knownHomonyms()).toContainEqual(['berry-josh', 'berry-josh-24h']);
  });
});
