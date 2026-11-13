import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { EventResultsFile, MotorEvent, ResultRow, Session, SessionResult, Source } from '@dm/shared';
import { f1Adapter } from '../src/adapters/f1.ts';
import { htmlResultRows } from '../src/adapters/fom.ts';
import { sessionsToReread } from '../src/core/reread.ts';
import { raceOutcome } from '../src/core/season-stats.ts';

const source: Source = { url: 'https://example.org/', title: 'x', kind: 'html', method: 'directo', fetchedAt: '2026-11-10T00:00:00Z' };
const event = (id: string, seriesId: string, dateStart: string): MotorEvent => ({
  id,
  seriesId,
  name: id,
  round: 1,
  circuit: 'Circuito',
  country: 'Países Bajos',
  tz: 'Europe/Amsterdam',
  dateStart,
  dateEnd: dateStart,
  sessionsStatus: 'published',
  source,
});
const session = (id: string, eventId: string, seriesId: string, type: Session['type'], startUtc: string): Session => ({
  id,
  eventId,
  seriesId,
  type,
  name: type,
  startUtc,
  endUtc: startUtc.replace(':00Z', ':30Z'),
  endEstimated: true,
  broadcast: [],
  broadcastIsDefault: true,
  source,
  hasResults: true,
});
const file = (seriesId: string, eventId: string, sessions: SessionResult[]): EventResultsFile => ({ seriesId, eventId, updatedAt: '2026-11-10T00:00:00Z', sessions });
const rows = (...list: Array<string | ResultRow>): ResultRow[] => list.map((x, i) => (typeof x === 'string' ? { pos: i + 1, driver: x } : x));

describe('releer resultados publicados con un lector arreglado', () => {
  it('F1: "NC" ya no tapa si abandonó o no largó', () => {
    const table = {
      headers: ['Pos.', 'No.', 'Driver', 'Team', 'Laps', 'Time / Retired', 'Pts.'],
      rows: [
        ['1', '1', 'Lando Norris', 'McLaren', '72', '2:04:44.859', '25'],
        ['17', '23', 'Alexander Albon', 'Williams', '66', 'DNF', '0'],
        ['NC', '18', 'Lance Stroll', 'Aston Martin', '43', '+15 laps', '0'],
        ['NC', '3', 'Max Verstappen', 'Red Bull Racing', '0', 'DNF', '0'],
        ['NC', '81', 'Oscar Piastri', 'McLaren', '0', 'DNS', '0'],
        ['DQ', '5', 'Gabriel Bortoleto', 'Audi', '', 'DSQ', '0'],
      ],
    };
    const parsed = htmlResultRows(table);
    expect(parsed.map((r) => [r.driver, r.pos, r.status])).toEqual([
      ['Lando Norris', 1, undefined],
      ['Alexander Albon', 17, 'DNF'],
      ['Lance Stroll', null, 'NC'],
      ['Max Verstappen', null, 'DNF'],
      ['Oscar Piastri', null, 'DNS'],
      ['Gabriel Bortoleto', null, 'DQ'],
    ]);
    expect(parsed.map(raceOutcome)).toEqual(['finished', 'retired', 'retired', 'retired', 'not-started', 'disqualified']);
  });

  it('elige las sesiones publicadas antes del arreglo que cumplen la condición del lector', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'dm-reread-'));
    try {
      const old = { ...source, fetchedAt: '2026-08-23T18:00:00Z' };
      const fresh = { ...source, fetchedAt: '2026-12-02T08:00:00Z' };
      const nc: ResultRow = { pos: null, status: 'NC', driver: 'Max Verstappen', laps: 0 };
      await mkdir(path.join(dir, 'results', 'f1'), { recursive: true });
      const write = (eventId: string, list: SessionResult[]) =>
        writeFile(path.join(dir, 'results', 'f1', `${eventId}.json`), JSON.stringify(file('f1', eventId, list)));
      await write('e1', [
        { sessionId: 'e1-r', rows: rows('Ana Uno', nc), source: old },
        { sessionId: 'e1-q', rows: rows('Ana Uno', { pos: null, status: 'NC', driver: 'Max Verstappen' }), source: old },
      ]);
      // Leída después de la fecha del arreglo aunque siga con "NC": no se relee.
      await write('e2', [{ sessionId: 'e2-r', rows: rows('Ana Uno', nc), source: fresh }]);
      await write('e3', [{ sessionId: 'e3-r', rows: rows('Ana Uno', { pos: null, status: 'NC', driver: 'Beto Dos', laps: 40 }), source: old }]);
      const events = ['e1', 'e2', 'e3', 'e4'].map((id) => event(id, 'f1', '2026-08-23'));
      const sessions = [
        session('e1-r', 'e1', 'f1', 'carrera', '2026-08-23T13:00:00Z'),
        session('e1-q', 'e1', 'f1', 'clasificacion', '2026-08-22T13:00:00Z'),
        session('e2-r', 'e2', 'f1', 'carrera', '2026-08-30T13:00:00Z'),
        session('e3-r', 'e3', 'f1', 'carrera', '2026-09-06T13:00:00Z'),
      ];
      const picked = await sessionsToReread(dir, 'f1', events, sessions, f1Adapter.resultsReread!);
      expect(picked.map((s) => s.id)).toEqual(['e1-r']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
