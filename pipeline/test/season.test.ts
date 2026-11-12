import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { scheduleFileSchema, stableHash, type MotorEvent, type Source } from '@dm/shared';
import { loadConfig } from '../src/core/config.ts';
import { CONFIG_DIR } from '../src/core/paths.ts';
import { acceptNextSeason, scheduleWithNextSeason, seasonOver, seasonUrl, seriesForSeason } from '../src/core/season.ts';
import { eventKindOf, isNonRaceEvent } from '../src/core/builders.ts';
import { seasonStarted } from '../src/core/results.ts';
import { createGenericAdapter } from '../src/generic/index.ts';
import type { Adapter, AdapterContext, ScheduleChunk } from '../src/core/types.ts';
import { fakeGemini, fakeHttp, fixture, genericSeries, testContext } from './fakes.ts';

const NOW = '2026-11-12T12:00:00Z';
const src: Source = { url: 'https://x.org', title: 'x', kind: 'html', method: 'directo', fetchedAt: NOW };
const ev = (id: string, dateStart: string, dateEnd = dateStart): MotorEvent => ({
  id,
  seriesId: 's',
  name: id,
  circuit: id,
  country: '',
  tz: 'UTC',
  dateStart,
  dateEnd,
  sessionsStatus: 'pending',
  source: src,
});

describe('URL con {season}', () => {
  it('reemplaza el marcador y deja igual las URL sin marcador', () => {
    expect(seasonUrl('https://www.fiawec.com/en/season/{season}', 2027)).toBe('https://www.fiawec.com/en/season/2027');
    expect(seasonUrl('https://www.24hseries.com/races', 2027)).toBe('https://www.24hseries.com/races');
    const s = genericSeries('sf', 'Super Formula', ['https://superformula.net/sf3/race_taxonomy/{season}', 'https://superformula.net/sf3/driver_taxonomy/{season}?standings'], {
      rosterUrls: ['https://superformula.net/sf3/team_taxonomy/{season}'],
    });
    expect(seriesForSeason(s, 2027)).toMatchObject({
      officialUrls: ['https://superformula.net/sf3/race_taxonomy/2027', 'https://superformula.net/sf3/driver_taxonomy/2027?standings'],
      rosterUrls: ['https://superformula.net/sf3/team_taxonomy/2027'],
    });
    const plain = genericSeries('x', 'X', ['https://x.org/calendar']);
    expect(seriesForSeason(plain, 2027)).toBe(plain);
  });

  it('la config por defecto ya no tiene años fijos en las URL y valida con el esquema', async () => {
    const { series } = await loadConfig(CONFIG_DIR, mkdtempSync(path.join(tmpdir(), 'dm-data-')));
    const urls = series.flatMap((s) => [...s.officialUrls, ...(s.rosterUrls ?? [])]);
    expect(urls.filter((u) => /20[2-9]\d/.test(u))).toEqual([]);
    const wec = seriesForSeason(series.find((s) => s.id === 'wec')!, 2027);
    expect(wec.officialUrls[0]).toBe('https://www.fiawec.com/en/season/2027');
    const f1 = seriesForSeason(series.find((s) => s.id === 'f1')!, 2026);
    expect(f1.officialUrls[0]).toBe('https://www.formula1.com/en/racing/2026');
  });
});

describe('temporada siguiente (core/season.ts)', () => {
  const current: ScheduleChunk = { events: [ev('a', '2026-03-06', '2026-03-08'), ev('b', '2026-09-04', '2026-09-06')], sessions: [] };

  it('la temporada terminó cuando ningún evento termina hoy o después', () => {
    expect(seasonOver(current.events, '2026-11-12')).toBe(true);
    expect(seasonOver([...current.events, ev('c', '2026-11-12')], '2026-11-12')).toBe(false);
    expect(seasonOver([], '2026-11-12')).toBe(false);
  });

  it('acepta solo eventos nuevos y futuros; descarta un calendario terminado con el año cambiado', () => {
    const next: ScheduleChunk = {
      events: [ev('a', '2026-03-06', '2026-03-08'), ev('old', '2026-10-01'), ev('n1', '2027-03-05', '2027-03-07'), ev('n2', '2027-05-14', '2027-05-16')],
      sessions: [],
    };
    expect(acceptNextSeason(current, next, '2026-11-12').chunk.events.map((e) => e.id)).toEqual(['n1', 'n2']);
    // Página sin año: el lector le puso 2027 a las fechas de 2026 (mismos día y mes).
    const copy: ScheduleChunk = { events: [ev('c1', '2027-03-06', '2027-03-08'), ev('c2', '2027-09-04', '2027-09-06')], sessions: [] };
    const r = acceptNextSeason(current, copy, '2026-11-12');
    expect(r.chunk.events).toEqual([]);
    expect(r.rejected).toMatch(/repiten día y mes/);
  });

  it('lee la siguiente solo si la en curso terminó; si no está publicada, no pasa nada', async () => {
    const calls: Array<{ season: number; next?: boolean }> = [];
    const fake = (next: () => ScheduleChunk): Adapter => ({
      name: 'fake',
      async schedule(_s, ctx) {
        calls.push({ season: ctx.season, next: ctx.nextSeason });
        return ctx.nextSeason ? next() : current;
      },
    });
    const ctx = testContext(fakeHttp({}), NOW);
    const series = genericSeries('s', 'S', ['https://x.org']);
    const out = await scheduleWithNextSeason(fake(() => ({ events: [ev('n1', '2027-03-05', '2027-03-07')], sessions: [] })), series, ctx);
    expect(calls).toEqual([{ season: 2026, next: undefined }, { season: 2027, next: true }]);
    expect(out.events.map((e) => e.id)).toEqual(['a', 'b', 'n1']);

    const failing = await scheduleWithNextSeason(fake(() => { throw new Error('HTTP 404'); }), series, ctx);
    expect(failing).toEqual(current);

    calls.length = 0;
    const running = await scheduleWithNextSeason(fake(() => current), series, testContext(fakeHttp({}), '2026-06-01T00:00:00Z'));
    expect(calls).toHaveLength(1);
    expect(running).toEqual(current);
  });
});

describe('temporada siguiente con el flujo genérico (páginas reales)', () => {
  const indycar = genericSeries('indycar', 'NTT IndyCar Series', ['https://www.indycar.com/Schedule', 'https://www.indycar.com/Standings']);
  const routes = {
    'https://www.indycar.com/Schedule?year=2026': fixture('indycar-schedule-2026.html'),
    'https://www.indycar.com/Schedule?year=2027': fixture('indycar-schedule-2027.html'),
  };

  it('IndyCar: con la temporada 2026 terminada publica las fechas 2027 y conservan su id el 1 de enero', async () => {
    const gemini = fakeGemini();
    const adapter = createGenericAdapter({ gemini: () => gemini });
    const nov = await scheduleWithNextSeason(adapter, indycar, testContext(fakeHttp(routes), NOW));
    // La página de 2026 trae arriba las próximas fechas (de 2027): para la temporada 2026 no cuentan.
    expect(nov.events.map((e) => `${e.dateEnd} ${e.name}`)).toEqual([
      '2026-08-30 Snap-on Makers and Fixers 250',
      '2026-09-06 Mission Foods Grand Prix of Monterey',
      '2027-03-07 Streets of St. Petersburg',
      '2027-03-13 Phoenix Raceway',
      '2027-03-21 Streets of Arlington',
    ]);
    expect(gemini.requests).toHaveLength(0);

    // 5 de enero de 2027: 2027 ya es la temporada en curso; mismos ids.
    const jan = await createGenericAdapter({ gemini: () => gemini }).schedule(indycar, testContext(fakeHttp(routes), '2027-01-05T12:00:00Z'));
    const novIds = nov.events.filter((e) => e.dateStart >= '2027').map((e) => e.id);
    expect(jan.events.map((e) => e.id)).toEqual(novIds);
    // Clave = slug de la URL del evento: no cambia cuando se anuncie el nombre comercial de la fecha.
    expect(novIds[0]).toBe(stableHash('indycar', 2027, 'st-petersburg'));
    scheduleFileSchema.shape.events.parse(nov.events);
  });

  it('24H Series: el calendario de /races ya trae una fecha 2027 (data-year) y entra sin IA', async () => {
    const gemini = fakeGemini();
    const series = genericSeries('24h-series', '24H Series (Creventic)', ['https://www.24hseries.com/races']);
    const out = await scheduleWithNextSeason(
      createGenericAdapter({ gemini: () => gemini }),
      series,
      testContext(fakeHttp({ 'https://www.24hseries.com/races': fixture('creventic-races.html') }), '2026-12-20T12:00:00Z'),
    );
    const next = out.events.filter((e) => e.dateStart >= '2027');
    expect(next.length).toBeGreaterThan(0);
    expect(next.every((e) => e.id !== stableHash('24h-series', 2026, e.name))).toBe(true);
    expect(gemini.requests).toHaveLength(0);
  });

  it('sin receta: IA para la temporada siguiente solo si la página nombra ese año, y una vez por semana', async () => {
    const CAL = 'https://cup.example.org/calendar';
    const ld = (events: Array<[string, string, string]>) =>
      `<html><head><title>Calendar</title><script type="application/ld+json">${JSON.stringify(
        events.map(([name, startDate, endDate]) => ({ '@type': 'SportsEvent', name, startDate, endDate, location: { name } })),
      )}</script></head><body>`;
    const done = ld([['Round 1 Monza', '2026-04-10', '2026-04-12'], ['Round 2 Imola', '2026-09-04', '2026-09-06']]);
    const announced = `${done}<h2>2027 calendar</h2><p>Monza 16-18 April 2027</p><p>Mugello 2027 TBC</p></body></html>`;
    const series = genericSeries('cup', 'Example Cup', [CAL]);
    const reply = () => ({ events: [{ name: 'Monza', circuit: 'Monza', country: 'Italy', dateStart: '2027-04-16', dateEnd: '2027-04-18' }] });
    const cacheDir = mkdtempSync(path.join(tmpdir(), 'dm-cache-'));

    // La página todavía no nombra 2027: ningún pedido.
    const quiet = fakeGemini({ calendario: reply });
    await scheduleWithNextSeason(createGenericAdapter({ gemini: () => quiet }), series, testContext(fakeHttp({ [CAL]: `${done}</body></html>` }), NOW, cacheDir));
    expect(quiet.requests).toHaveLength(0);

    // Ya lo anuncia: un pedido y la fecha 2027 se publica.
    const gemini = fakeGemini({ calendario: reply });
    const out = await scheduleWithNextSeason(createGenericAdapter({ gemini: () => gemini }), series, testContext(fakeHttp({ [CAL]: announced }), NOW, cacheDir));
    expect(gemini.requests).toHaveLength(1);
    expect(gemini.requests[0]!.prompt).toContain('2027');
    expect(out.events.map((e) => e.dateStart)).toEqual(['2026-04-10', '2026-09-04', '2027-04-16']);

    // Tres días después, con la página cambiada (la caché por documento no alcanza): no se vuelve a pedir.
    const again = fakeGemini({ calendario: reply });
    await scheduleWithNextSeason(createGenericAdapter({ gemini: () => again }), series, testContext(fakeHttp({ [CAL]: announced + '<p>2027!</p>' }), '2026-11-15T12:00:00Z', cacheDir));
    expect(again.requests).toHaveLength(0);
  });

  it('con receta de calendario no se gasta IA en la temporada siguiente aunque la página nombre ese año', async () => {
    const gemini = fakeGemini();
    // Página real de 2026 servida como si fuera la de 2028 y nombrando 2028: la receta no encuentra fechas 2028.
    const http = fakeHttp({ 'https://www.indycar.com/Schedule?year=2028': `${fixture('indycar-schedule-2026.html')}<p>2028 2028 2028</p>` });
    const ctx: AdapterContext = { ...testContext(http, NOW), season: 2028, nextSeason: true };
    await expect(createGenericAdapter({ gemini: () => gemini }).schedule(indycar, ctx)).rejects.toThrow(/No se encontraron eventos 2028/);
    expect(gemini.requests).toHaveLength(0);
  });
});

describe('eventos que no son carreras', () => {
  it('ensayos y prólogos se marcan como test; galas y presentaciones se descartan', () => {
    for (const n of ['Pre-Season Testing', 'Barcelona Winter Test', 'Official Tests - Barcelona', 'Official Test Days - Prologue', 'CrowdStrike 24 Hours of Spa - Prologue', 'Official Prologue - IMOLA', 'Ensayos oficiales', 'NLS Test- und Einstellfahrten']) {
      expect(eventKindOf(n), n).toBe('test');
    }
    for (const n of ['Qatar 1812km', 'Contest 500', 'GT Festival Phillip Island', 'Gran Premio Coronación']) expect(eventKindOf(n), n).toBeUndefined();
    for (const n of ['2026 End of Year Gala', 'Awards Ceremony', 'Presentación de la temporada', 'Season Launch']) expect(isNonRaceEvent(n), n).toBe(true);
    for (const n of ['Pennzoil 400 presented by Jiffy Lube', 'FaithFest 250 presented by Mercer Transportation', 'GT Festival Sydney']) {
      expect(isNonRaceEvent(n), n).toBe(false);
    }
  });

  it('GT World Challenge America: la gala de fin de año no se publica como evento (página real)', async () => {
    const CAL = 'https://www.gt-world-challenge-america.com/calendar';
    const series = genericSeries('gtwc-america', 'Fanatec GT World Challenge America', [CAL]);
    const out = await createGenericAdapter({ gemini: () => fakeGemini() }).schedule(series, testContext(fakeHttp({ [CAL]: fixture('sro-america-calendar-2026-11.html') }), NOW));
    expect(out.events.length).toBeGreaterThan(5);
    expect(out.events.some((e) => /gala/i.test(e.name))).toBe(false);
  });

  it('el campeonato nuevo espera a que se corra la primera fecha (los ensayos no cuentan)', () => {
    const events = [{ ...ev('t', '2027-02-20'), kind: 'test' as const }, ev('r1', '2027-03-05', '2027-03-07')];
    expect(seasonStarted(events, 2027, new Date('2027-02-25T00:00:00Z'))).toBe(false);
    expect(seasonStarted(events, 2027, new Date('2027-03-05T10:00:00Z'))).toBe(true);
  });
});

