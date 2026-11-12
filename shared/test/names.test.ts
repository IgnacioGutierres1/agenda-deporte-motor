import { describe, expect, it } from 'vitest';
import {
  hasBrokenChars,
  isLikelyAcronym,
  isVenueToConfirm,
  normalizeCircuitName,
  normalizeEventName,
  repairBrokenChars,
  restoreArPlaceAccents,
  spanishSessionName,
  titleCaseCaps,
} from '../src/index.ts';

describe('mayúsculas', () => {
  it('pasa a "Título" solo las palabras en mayúsculas y respeta las siglas', () => {
    expect(titleCaseCaps('Fecha 14 — RIO CUARTO')).toBe('Fecha 14 — Rio Cuarto');
    expect(titleCaseCaps('Michelin 24H DUBAI')).toBe('Michelin 24H Dubai');
    expect(titleCaseCaps('Michelin 12H SPA-FRANCORCHAMPS')).toBe('Michelin 12H Spa-Francorchamps');
    expect(titleCaseCaps('CONCEPCIÓN DEL URUGUAY')).toBe('Concepción del Uruguay');
    expect(titleCaseCaps('Fecha 5 — TERMAS DE RÍO HONDO')).toBe('Fecha 5 — Termas de Río Hondo');
    expect(titleCaseCaps('Michelin 6H ABU DHABI')).toBe('Michelin 6H Abu Dhabi');
    expect(titleCaseCaps('Michelin 12H RED BULL RING 2027')).toBe('Michelin 12H Red Bull Ring 2027');
    expect(titleCaseCaps('ADAC RAVENOL 24h Nürburgring')).toBe('ADAC Ravenol 24h Nürburgring');
    expect(titleCaseCaps('NLS1: 71. ADAC Westfalenfahrt (4h)')).toBe('NLS1: 71. ADAC Westfalenfahrt (4h)');
    expect(titleCaseCaps('PT Grand Prix of Thailand')).toBe('PT Grand Prix of Thailand');
    expect(titleCaseCaps("O'REILLY AUTO PARTS")).toBe("O'Reilly Auto Parts");
    expect(titleCaseCaps('VANTELIN TEAM TOM’S')).toBe('Vantelin Team Tom’s');
  });

  it('equipos: siglas de hasta cinco letras en mayúsculas, palabras comunes en "Título"', () => {
    expect(titleCaseCaps('KCMG')).toBe('KCMG');
    expect(titleCaseCaps('KTMS')).toBe('KTMS');
    expect(titleCaseCaps('ZIGGO SPORT TEMPESTA BY ARGT')).toBe('Ziggo Sport Tempesta by ARGT');
    expect(titleCaseCaps('HCM UCHINO RACING')).toBe('HCM Uchino Racing');
    expect(titleCaseCaps('HEART OF RACING TEAM')).toBe('Heart of Racing Team');
    expect(titleCaseCaps('AF CORSE')).toBe('AF Corse');
    expect(titleCaseCaps('TRACY SPORTS with RCIT')).toBe('Tracy Sports with RCIT');
    expect(titleCaseCaps('CADILLAC HERTZ TEAM JOTA')).toBe('Cadillac Hertz Team Jota');
  });

  it('distingue siglas de palabras por su forma', () => {
    for (const w of ['KCMG', 'KTMS', 'ARGT', 'TKRI', 'JLOC', 'KDDI', 'TGMGP', 'WRT', 'GT3', 'LMP2', '24H', 'ADAC', 'NASCAR'])
      expect(isLikelyAcronym(w), w).toBe(true);
    for (const w of ['TEAM', 'CORSE', 'SPORT', 'FUJI', 'PLATA', 'FIRST', 'CLASS', 'HIGH', 'IRON', 'DHABI', 'BULL', 'RÍO', 'LA', 'SAN'])
      expect(isLikelyAcronym(w), w).toBe(false);
  });
});

describe('eventos, circuitos y lugares', () => {
  it('acentos de lugares argentinos conocidos', () => {
    expect(restoreArPlaceAccents('Fecha 12 — San Nicolas')).toBe('Fecha 12 — San Nicolás');
    expect(restoreArPlaceAccents('Ciudad de Parana (Parana, Entre Rios)')).toBe('Ciudad de Paraná (Paraná, Entre Ríos)');
    expect(restoreArPlaceAccents('Santiago Del Estereo')).toBe('Santiago del Estero');
    expect(restoreArPlaceAccents('Ciudad de Viedma')).toBe('Ciudad de Viedma');
    // "Paranaense" no es "Paraná".
    expect(restoreArPlaceAccents('Club Paranaense')).toBe('Club Paranaense');
  });

  it('nombres de evento: mayúsculas, acentos y prefijos de ronda repetidos', () => {
    const ar = { argentina: true };
    expect(normalizeEventName('Fecha 14 — RIO CUARTO', { ...ar, round: 14 })).toBe('Fecha 14 — Río Cuarto');
    expect(normalizeEventName('Fecha 12 — SAN NICOLAS', ar)).toBe('Fecha 12 — San Nicolás');
    expect(normalizeEventName('Autódromo Ciudad de Viedma (VIEDMA, Río Negro)', ar)).toBe('Autódromo Ciudad de Viedma (Viedma, Río Negro)');
    expect(normalizeEventName('Autódromo Ciudad de San Martín (SAN MARTÍN , Est. Lib. Grl. San Martín, Mendoza)', ar)).toBe(
      'Autódromo Ciudad de San Martín (San Martín, Est. Lib. Grl. San Martín, Mendoza)',
    );
    expect(normalizeEventName('Round1 OKAYAMA GT 300km RACE', { round: 1 })).toBe('Okayama GT 300 km');
    expect(normalizeEventName('Round8 MOTEGI GT 250km RACE GRAND FINAL', { round: 8 })).toBe('Motegi GT 250 km Grand Final');
    expect(normalizeEventName('Rd.3 AUTOPOLIS', { round: 3 })).toBe('Autopolis');
    expect(normalizeEventName('Rd.11-12 SUZUKA CIRCUIT', { round: 11 })).toBe('Fechas 11 y 12 — Suzuka Circuit');
    expect(normalizeEventName('Rd.3-6-7 FUJI SPEEDWAY', { round: 6 })).toBe('Fechas 3, 6 y 7 — Fuji Speedway');
    // Sin ronda conocida (o distinta), el prefijo se conserva: es el único dato de la ronda.
    expect(normalizeEventName('Round2 FUJI')).toBe('Round2 Fuji');
    expect(normalizeEventName('Fecha 12 A Confirmar', { ...ar, round: 12 })).toBe('Fecha 12 (sede a confirmar)');
    expect(normalizeEventName('Michelin 24H DUBAI')).toBe('Michelin 24H Dubai');
    // NASCAR / IndyCar / IMSA: las mayúsculas son la grafía oficial de la marca.
    expect(normalizeEventName('DAYTONA 500', { titleCase: false })).toBe('DAYTONA 500');
  });

  it('es idempotente', () => {
    for (const [name, round] of [
      ['Round1 OKAYAMA GT 300km RACE', 1],
      ['Rd.11-12 SUZUKA CIRCUIT', 11],
      ['Fecha 12 A Confirmar', 12],
      ['Fecha 14 — RIO CUARTO', 14],
    ] as const) {
      const once = normalizeEventName(name, { round, argentina: true });
      expect(normalizeEventName(once, { round, argentina: true })).toBe(once);
    }
  });

  it('circuitos: sede a confirmar y mayúsculas', () => {
    expect(normalizeCircuitName('A CONFIRMAR')).toBe('A confirmar');
    expect(normalizeCircuitName('TBA')).toBe('A confirmar');
    expect(isVenueToConfirm('Por confirmar')).toBe(true);
    expect(normalizeCircuitName('FUJI SPEEDWAY')).toBe('Fuji Speedway');
    expect(normalizeCircuitName('Juan Manuel Fangio-ROSARIO', { argentina: true })).toBe('Juan Manuel Fangio-Rosario');
    expect(normalizeCircuitName('Parque Ciudad de Rio Cuarto', { argentina: true })).toBe('Parque Ciudad de Río Cuarto');
    expect(normalizeCircuitName('Circuit Zandvoort ')).toBe('Circuit Zandvoort');
  });
});

describe('sesiones en español', () => {
  const cases: Array<[string, string]> = [
    ['Practice 1', 'Práctica 1'],
    ['Practice', 'Práctica'],
    ['Free Practice 2', 'Práctica libre 2'],
    ['FP1', 'Práctica libre 1'],
    ['Práctica Libre 1', 'Práctica libre 1'],
    ['Qualifying', 'Clasificación'],
    ['Qualifying A', 'Clasificación A'],
    ['Sprint Qualifying', 'Clasificación sprint'],
    ['Sprint Shootout', 'Clasificación sprint'],
    ['Sprint Race', 'Sprint'],
    ['Sprint', 'Sprint'],
    ['Feature Race', 'Carrera principal'],
    ['Feature Race 2', 'Carrera principal 2'],
    ['Race', 'Carrera'],
    ['Race 36', 'Carrera 36'],
    ['Reverse Grid Race', 'Carrera de grilla invertida'],
    ['Warm-up', 'Warm Up'],
    ['Day 1', 'Día 1'],
    ['Qualifications 1 - GT3', 'Clasificación 1 - GT3'],
    ['Qualifications 2 - Hypercar & LMP2', 'Clasificación 2 - Hypercar & LMP2'],
    ['Group A - Qualifying', 'Grupo A - Clasificación'],
    ['Qualifying - A Driver', 'Clasificación - Piloto A'],
    ['Rd.11 Qualifying Q1 Group A', 'Fecha 11 · Clasificación Q1 Grupo A'],
    ['Top 10 Shootout (Race 36)', 'Top 10 Shootout (Carrera 36)'],
    ['Qualifying (Race 35)', 'Clasificación (Carrera 35)'],
    ['FIA F4 World Cup - Qualification Race', 'FIA F4 World Cup - Carrera clasificatoria'],
    ['FIA F4 World Cup - Main Race', 'FIA F4 World Cup - Carrera principal'],
    ['Guia Race TCR - Race 1', 'Guia Race TCR - Carrera 1'],
    // Lo que no se reconoce entero queda como está.
    ['Hyperpole - HYPERCAR', 'Hyperpole - HYPERCAR'],
    ['Qualifying Bronze', 'Qualifying Bronze'],
    ['Race of Champions', 'Race of Champions'],
    ['Racecourse Walk', 'Racecourse Walk'],
    // Ya en español: igual.
    ['Práctica / Clasificación', 'Práctica / Clasificación'],
    ['Carrera clasificatoria 1', 'Carrera clasificatoria 1'],
    ['Clasificación Q2', 'Clasificación Q2'],
  ];
  it.each(cases)('%s -> %s', (from, to) => {
    expect(spanishSessionName(from)).toBe(to);
    expect(spanishSessionName(to)).toBe(to);
  });
});

describe('letras rotas', () => {
  it('repara "?" en nombres de pila conocidos y detecta lo que no se puede reparar', () => {
    expect(repairBrokenChars('MENENDEZ, AGUST?N')).toBe('MENENDEZ, AGUSTÍN');
    expect(repairBrokenChars('BENITO, NICOL?S')).toBe('BENITO, NICOLÁS');
    expect(repairBrokenChars('LEIMGRUBER, TOB?AS')).toBe('LEIMGRUBER, TOBÍAS');
    expect(repairBrokenChars('Joaqu�n Cortina')).toBe('Joaquín Cortina');
    expect(repairBrokenChars('P?REZ, JUAN')).toBe('P?REZ, JUAN');
    expect(hasBrokenChars('P?REZ, JUAN')).toBe(true);
    expect(hasBrokenChars('¿Quién?')).toBe(false);
    expect(hasBrokenChars('MENENDEZ, AGUSTÍN')).toBe(false);
  });
});
