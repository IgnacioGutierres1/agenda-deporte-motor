import { describe, expect, it } from 'vitest';
import type { ResultRow, Session, SessionResult, SessionType } from '@dm/shared';
import {
  eventWinner,
  fastestLap,
  lapSeconds,
  mainResultSession,
  orderResultSessions,
  podium,
  podiumLine,
  shortDriverName,
} from '../src/lib/podium.ts';

type S = Pick<Session, 'id' | 'type' | 'startUtc'>;
const s = (id: string, type: SessionType, startUtc: string): S => ({ id, type, startUtc });
const res = (sessionId: string, rows: ResultRow[] = [{ pos: 1, driver: 'X' }]) =>
  ({ sessionId, rows, source: {} }) as unknown as SessionResult;

const F1 = [
  s('fp1', 'practica', '2026-11-06T15:30:00Z'),
  s('fp2', 'practica', '2026-11-06T19:00:00Z'),
  s('fp3', 'practica', '2026-11-07T14:30:00Z'),
  s('q', 'clasificacion', '2026-11-07T18:00:00Z'),
  s('race', 'carrera', '2026-11-08T17:00:00Z'),
];

describe('podium', () => {
  const rows: ResultRow[] = [
    { pos: null, status: 'DNF', driver: 'Lance Stroll' },
    { pos: 2, driver: 'Max Verstappen', team: 'Red Bull Racing', gap: '+14.602s' },
    { pos: 1, driver: 'Lando Norris', team: 'McLaren', time: '1:35:23.504' },
    { pos: null, status: 'NC', driver: 'Valtteri Bottas' },
    { pos: 3, driver: 'Isack Hadjar', team: 'Red Bull Racing', gap: '+24.485s' },
    { pos: 4, driver: 'George Russell' },
  ];

  it('toma P1–P3 en orden e ignora filas sin posición (DNF, NC)', () => {
    expect(podium(rows).map((r) => r.driver)).toEqual(['Lando Norris', 'Max Verstappen', 'Isack Hadjar']);
    expect(podiumLine(rows)).toBe('1. Norris · 2. Verstappen · 3. Hadjar');
  });

  it('un DNF clasificado (con posición) cuenta por su posición', () => {
    const r: ResultRow[] = [
      { pos: 1, driver: 'Kimi Antonelli' },
      { pos: 2, driver: 'George Russell' },
      { pos: 3, status: 'DNF', driver: 'Max Verstappen' },
    ];
    expect(podiumLine(r)).toBe('1. Antonelli · 2. Russell · 3. Verstappen');
  });

  it('podio incompleto o vacío', () => {
    expect(podiumLine([{ pos: 1, driver: 'Franco Colapinto' }, { pos: null, status: 'DNS', driver: 'Otro Piloto' }])).toBe('1. Colapinto');
    expect(podiumLine([{ pos: null, status: 'NC', driver: 'Nadie Nunca' }])).toBe('');
    expect(podium([])).toEqual([]);
  });

  it('nombres cortos: apellido con partículas y sufijos, "Apellido, Nombre" y tripulaciones', () => {
    expect(shortDriverName('Laurens van Hoepen')).toBe('van Hoepen');
    expect(shortDriverName('Ricky Stenhouse Jr')).toBe('Stenhouse Jr');
    expect(shortDriverName('John H. Nemechek')).toBe('Nemechek');
    expect(shortDriverName('CANAPINO, Agustin')).toBe('Canapino');
    expect(shortDriverName('Kevin Estre / Laurens Vanthoor / Matt Campbell')).toBe('Estre/Vanthoor/Campbell');
    expect(shortDriverName('Senna')).toBe('Senna');
  });
});

describe('sesión principal y orden de los chips', () => {
  it('la principal es la carrera, aunque haya prácticas antes', () => {
    const results = [res('fp1'), res('fp2'), res('race'), res('q'), res('fp3')];
    expect(mainResultSession(results, F1)?.sessionId).toBe('race');
  });

  it('con dos carreras (Feature y Sprint de F2), la última "carrera"; sin carrera, la sprint', () => {
    const f2 = [
      s('p', 'practica', '2026-11-06T10:00:00Z'),
      s('sprint', 'sprint', '2026-11-07T15:00:00Z'),
      s('feat', 'carrera', '2026-11-08T13:00:00Z'),
    ];
    expect(mainResultSession([res('sprint'), res('feat'), res('p')], f2)?.sessionId).toBe('feat');
    expect(mainResultSession([res('sprint'), res('p')], f2)?.sessionId).toBe('sprint');
    const moto = [s('c1', 'carrera', '2026-11-08T11:00:00Z'), s('c2', 'carrera', '2026-11-08T13:00:00Z')];
    expect(mainResultSession([res('c2'), res('c1')], moto)?.sessionId).toBe('c2');
  });

  it('sin carreras con resultado: la última sesión; las sesiones sin filas no cuentan', () => {
    expect(mainResultSession([res('fp1'), res('q'), res('race', [])], F1)?.sessionId).toBe('q');
    expect(mainResultSession([], F1)).toBeUndefined();
  });

  it('chips: carreras primero y después el resto por hora', () => {
    const sprintWeekend = [
      s('fp1', 'practica', '2026-11-06T15:30:00Z'),
      s('sq', 'clasificacion', '2026-11-06T19:30:00Z'),
      s('sprint', 'sprint', '2026-11-07T14:00:00Z'),
      s('q', 'clasificacion', '2026-11-07T18:00:00Z'),
      s('race', 'carrera', '2026-11-08T17:00:00Z'),
    ];
    const order = orderResultSessions([res('race'), res('q'), res('fp1'), res('sprint'), res('sq')], sprintWeekend);
    expect(order.map((r) => r.sessionId)).toEqual(['sprint', 'race', 'fp1', 'sq', 'q']);
  });

  it('ganador del evento: P1 de la sesión principal', () => {
    const results = [
      res('fp1', [{ pos: 1, driver: 'Max Verstappen' }]),
      res('race', [{ pos: null, status: 'DNF', driver: 'Lance Stroll' }, { pos: 1, driver: 'Lando Norris', team: 'McLaren' }]),
    ];
    expect(eventWinner(results, F1)?.driver).toBe('Lando Norris');
    expect(eventWinner([], F1)).toBeNull();
  });
});

describe('vuelta rápida', () => {
  it('la menor "mejor vuelta", con o sin minutos', () => {
    const rows: ResultRow[] = [
      { pos: 1, driver: 'A Uno', bestLap: '1:21.807' },
      { pos: 2, driver: 'B Dos', bestLap: '1:21.493' },
      { pos: null, status: 'DNF', driver: 'C Tres', bestLap: '1:22.000' },
      { pos: 4, driver: 'D Cuatro' },
    ];
    expect(fastestLap(rows)).toEqual({ row: rows[1], time: '1:21.493' });
    expect(lapSeconds('59.5')).toBe(59.5);
    expect(lapSeconds('+0.3s')).toBeNaN();
  });

  it('sin la columna no hay vuelta rápida', () => {
    expect(fastestLap([{ pos: 1, driver: 'A Uno', time: '1:35:23.504' }])).toBeNull();
  });
});
