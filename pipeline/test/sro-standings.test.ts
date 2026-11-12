import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { standingsFileSchema, type StandingsFile } from '@dm/shared';
import { runResultsForSeries } from '../src/core/results.ts';
import { createGenericAdapter } from '../src/generic/index.ts';
import { findRecipe, sroChosenTypes, sroStandingsTable, sroTableTitle } from '../src/generic/recipes.ts';
import { fakeGemini, fakeHttp, fixture, genericSeries, testContext } from './fakes.ts';

const NOW = '2026-11-11T12:00:00Z';
const BASE = 'https://www.gt-world-challenge-europe.com/standings';
const gtwce = genericSeries('gtwc-europe', 'GT World Challenge Europe', [
  'https://www.gt-world-challenge-europe.com/calendar',
  BASE,
]);
const url = (season: string, type: string) => `${BASE}?filter_season_id=${season}&filter_standing_type=${type}`;

/** Europa: la base y las seis tablas generales (general, Endurance Cup y Sprint Cup; pilotos y equipos). */
function europeHttp() {
  const routes: Record<string, string> = { [BASE]: fixture('sro-standings-europe.html') };
  for (const cup of ['0', '42', '43']) {
    routes[url('26', `${cup}_0_teams`)] = fixture('sro-standings-europe.html');
    routes[url('26', `${cup}_0_drivers`)] = fixture('sro-standings-europe-drivers.html');
  }
  return fakeHttp(routes);
}

describe('SRO: campeonato por lectura directa', () => {
  it('títulos y elección de tablas (generales, sin las subcopas)', () => {
    expect(sroTableTitle('GT World Challenge Europe Powered by AWS Drivers', '0_0_drivers')).toBe('Pilotos');
    expect(sroTableTitle('GT World Challenge Europe powered by AWS Endurance Cup Overall Team', '42_0_teams')).toBe('Equipos Endurance Cup');
    expect(sroTableTitle('GT World Challenge Asia GT3 Drivers Championship', '11_0_1_drivers')).toBe('Pilotos');
    expect(sroTableTitle('GT World Challenge America powered by AWS Pro-Am Teams', '16_30_teams')).toBe('Equipos Pro-Am');
    expect(sroTableTitle('GT3 Manufacturers', '4')).toBe('Marcas');
    expect(sroTableTitle('Drivers', '2')).toBe('Pilotos');

    const opt = (value: string, label: string) => ({ value, label, selected: false });
    const europe = [
      opt('0_0_teams', 'GT World Challenge Europe Powered by AWS Teams'),
      opt('0_0_drivers', 'GT World Challenge Europe Powered by AWS Drivers'),
      opt('0_81_drivers', 'GT World Challenge Europe Powered by AWS Gold Driver'),
      opt('42_0_drivers', 'GT World Challenge Europe powered by AWS Endurance Cup Overall Driver'),
      opt('42_80_drivers', 'GT World Challenge Europe powered by AWS Endurance Cup Bronze Driver'),
      opt('43_85_teams', 'GT World Challenge Europe powered by AWS Sprint Cup Pit Stop Challenge Team'),
    ];
    expect(sroChosenTypes(europe).map((o) => o.value)).toEqual(['0_0_teams', '0_0_drivers', '42_0_drivers']);
    // Australia no tiene tabla general de pilotos: se leen las clases (no se superponen).
    const australia = [
      opt('5_9_drivers', 'GT World Challenge Australia powered by AWS Pro-Am Drivers'),
      opt('5_10_drivers', 'GT World Challenge Australia powered by AWS Am Drivers'),
      opt('5_13_teams', 'GT World Challenge Australia powered by AWS Overall Teams Championship Teams'),
    ];
    expect(sroChosenTypes(australia).map((o) => o.value)).toEqual(['5_9_drivers', '5_10_drivers', '5_13_teams']);
    const igtc = [opt('2', 'Drivers'), opt('4', 'GT3 Manufacturers'), opt('7', 'Independent Cup')];
    expect(sroChosenTypes(igtc).map((o) => o.value)).toEqual(['2', '4']);
  });

  it('lee la fila de títulos dentro del <tbody> y acepta empates sin saltear posiciones (1, 1, 1, 2)', () => {
    const t = sroStandingsTable(fixture('sro-standings-europe-drivers.html'), 'Pilotos')!;
    expect(t.rows.map((r) => [r.pos, r.name, r.points])).toEqual([
      [1, 'Lucas Auer', 86],
      [1, 'Maro Engel', 86],
      [1, 'Luca Stolz', 86],
      [2, 'Nicki Thiim', 59],
    ]);
    const asia = sroStandingsTable(fixture('sro-standings-asia-drivers.html'), 'Pilotos')!;
    expect(asia.rows.map((r) => r.pos)).toEqual([1, 2, 2, 3, 4]);
  });

  it('Europa: seis tablas sin Gemini, con Maro Engel en la Endurance Cup', async () => {
    const http = europeHttp();
    const out = await createGenericAdapter({ gemini: () => fakeGemini({}, { available: false }) }).results!(gtwce, testContext(http, NOW), {
      events: [],
      pendingSessions: [],
      sessions: [],
      standingsStale: true,
    });
    const file = standingsFileSchema.parse(out.standings);
    expect(file.tables.map((t) => t.title)).toEqual([
      'Equipos',
      'Pilotos',
      'Equipos Endurance Cup',
      'Pilotos Endurance Cup',
      'Equipos Sprint Cup',
      'Pilotos Sprint Cup',
    ]);
    expect(file.tables[3]!.rows.find((r) => r.name === 'Maro Engel')).toMatchObject({ pos: 1, points: 86 });
    expect(file.tables[0]!.rows[0]).toEqual({ pos: 1, name: 'Team WRT', points: 152.5 });
    expect(file.source).toMatchObject({ url: BASE, method: 'directo', kind: 'html' });
  });

  it('una temporada que el sitio no tiene (o para la que responde con otra) no se publica', async () => {
    const recipe = findRecipe(BASE)!;
    const ctx = (now: string) => ({ season: new Date(now).getUTCFullYear(), series: gtwce, http: europeHttp(), now: new Date(now) });
    expect(await recipe.standings!(BASE, ctx('2031-03-01T00:00:00Z'))).toBeNull();
    // 2027 está en el selector, pero la página responde con 2026 seleccionado.
    const http = fakeHttp({ [BASE]: fixture('sro-standings-europe.html'), [url('27', '0_0_teams')]: fixture('sro-standings-europe.html') });
    expect(await recipe.standings!(BASE, { season: 2027, series: gtwce, http, now: new Date('2027-01-10T00:00:00Z') })).toBeNull();
  });

  it('un campeonato que se leyó con IA se relee en cuanto hay lectura directa, aunque esté al día', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dm-sro-'));
    mkdirSync(path.join(dir, 'standings'));
    const old: StandingsFile = {
      seriesId: 'gtwc-europe',
      season: 2026,
      updatedAt: '2026-11-11T06:00:00Z',
      tables: [{ title: 'GT World Challenge Europe Powered by AWS Teams', rows: [{ pos: 1, name: 'Team WRT', points: 152.5 }] }],
      source: { url: BASE, title: 'x', kind: 'html', method: 'ia', fetchedAt: '2026-11-11T06:00:00Z' },
    };
    const file = path.join(dir, 'standings', 'gtwc-europe.json');
    writeFileSync(file, JSON.stringify(old));
    const adapter = createGenericAdapter({ gemini: () => fakeGemini({}, { available: false }) });
    await runResultsForSeries(gtwce, adapter, testContext(europeHttp(), NOW), [], [], {}, dir, false);
    const now = standingsFileSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
    expect(now.source.method).toBe('directo');
    expect(now.tables).toHaveLength(6);

    // Ya leído en forma directa y al día: no se vuelve a pedir.
    const http = europeHttp();
    await runResultsForSeries(gtwce, adapter, testContext(http, NOW), [], [], {}, dir, false);
    expect(http.requested).toEqual([]);
  });
});
