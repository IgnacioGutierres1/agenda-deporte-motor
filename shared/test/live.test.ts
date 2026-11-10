import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { formatClock, formatGapTime, formatRemaining } from '../src/live-format.ts';
import { cleanNascarDriverName, parseNascarLive } from '../src/live-nascar.ts';
import { motogpSessionDate, parseMotogpLive } from '../src/live-motogp.ts';
import { parseSpeedhiveClassification, pickSpeedhiveEvents, pickSpeedhiveSessions } from '../src/live-speedhive.ts';
import {
  LIVE_SOURCES,
  MOTOGP_LIVE_URL,
  NASCAR_LIVE_FEED_URL,
  PROXY_ALLOWLIST,
  isProxyAllowed,
  liveUpstreams,
  speedhiveClassificationUrl,
  speedhiveEventUrl,
} from '../src/live-sources.ts';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/live/${name}`, import.meta.url), 'utf8'));
const clone = <T>(v: T): T => structuredClone(v);
const NOW = new Date('2026-11-10T20:30:00Z');
const ODD_INPUTS: unknown[] = [null, undefined, 42, 'texto', [], [1, 2], { foo: 'bar' }, { vehicles: 'x' }, { head: null }, { rows: {} }];

describe('formato de tiempos', () => {
  it('normaliza tiempos de vuelta de cada fuente', () => {
    expect(formatClock(33.943)).toBe('33.943');
    expect(formatClock(92.5)).toBe('1:32.500');
    expect(formatClock(2369.127)).toBe('39:29.127');
    expect(formatClock("1'53.940")).toBe('1:53.940');
    expect(formatClock("41'29.173")).toBe('41:29.173');
    expect(formatClock('01:35.050')).toBe('1:35.050');
    expect(formatClock('00:59.123')).toBe('59.123');
    expect(formatClock('1:02:03.4')).toBe('1:02:03.4');
    for (const v of [0, -1, '0.000', '00.000', '', 'abc', null, undefined, Number.NaN, {}]) expect(formatClock(v)).toBeUndefined();
  });

  it('formatea diferencias y tiempo restante', () => {
    expect(formatGapTime('01.495')).toBe('+1.495');
    expect(formatGapTime('3.083')).toBe('+3.083');
    expect(formatGapTime(0.314)).toBe('+0.314');
    expect(formatGapTime("-10'56.250")).toBeUndefined();
    expect(formatGapTime('0.000')).toBeUndefined();
    expect(formatRemaining(754)).toBe('12:34');
    expect(formatRemaining(3723)).toBe('1:02:03');
    expect(formatRemaining(0)).toBeUndefined();
  });
});

describe('NASCAR', () => {
  const final = fixture('nascar-cup-5601-final.json');

  it('lee la carrera terminada (feed archivado real, Homestead 2026)', () => {
    const b = parseNascarLive(final, NOW)!;
    expect(b).toMatchObject({
      provider: 'nascar',
      seriesId: 'nascar-cup',
      eventName: 'Homestead Miami Speedway',
      sessionName: 'NASCAR Cup Series Championship Race',
      status: 'finished',
      flag: 'none',
      lap: 267,
      totalLaps: 267,
      updatedAt: NOW.toISOString(),
      sourceUrl: 'https://www.nascar.com/leaderboard',
    });
    expect(b.rows.map((r) => r.pos)).toEqual([1, 2, 3, 4, 5, 26, 33, 39, 40]);
    expect(b.rows[0]).toEqual({
      pos: 1,
      number: '12',
      driver: 'Ryan Blaney',
      vehicle: 'Ford',
      laps: 267,
      lastLap: '33.943',
      bestLap: '32.616',
    });
    expect(b.rows[1]).toMatchObject({ driver: 'Tyler Reddick', vehicle: 'Toyota', gap: '+0.314', interval: '+0.314' });
    expect(b.rows[2]).toMatchObject({ gap: '+0.553', interval: '+0.239' });
    expect(b.rows[5]).toMatchObject({ pos: 26, driver: 'Austin Dillon', gap: '1 V' });
    expect(b.rows[5]!.interval).toBeUndefined();
    expect(b.rows[6]).toMatchObject({ pos: 33, gap: '2 V' });
    expect(b.rows[7]).toMatchObject({ pos: 39, driver: 'Chase Briscoe', status: 'Fuera', gap: '190 V' });
    expect(b.rows[8]).toMatchObject({ driver: 'Corey Heim', lastLap: '39:29.127' });
    expect(b.rows.some((r) => r.inPit)).toBe(false);
  });

  it('interpreta banderas y estado durante la carrera', () => {
    const live = clone(final) as Record<string, any>;
    live.flag_state = 2;
    live.lap_number = 180;
    live.laps_to_go = 87;
    live.vehicles[3].is_on_track = false;
    const b = parseNascarLive(live, NOW)!;
    expect(b).toMatchObject({ status: 'live', flag: 'yellow', lap: 180 });
    expect(b.rows[3]!.inPit).toBe(true);
    expect(b.rows[7]!.inPit).toBeUndefined(); // fuera de carrera, no "en boxes"

    for (const [code, flag, status] of [
      [1, 'green', 'live'],
      [3, 'red', 'live'],
      [4, 'checkered', 'finished'],
      [8, 'none', 'not-started'],
    ] as const) {
      expect(parseNascarLive({ ...live, flag_state: code }, NOW)).toMatchObject({ flag, status });
    }
    expect(parseNascarLive({ ...live, flag_state: 9, lap_number: 0, vehicles: [] }, NOW)).toMatchObject({ status: 'not-started' });
    expect(parseNascarLive({ ...live, flag_state: 77 }, NOW)).toMatchObject({ status: 'unknown' });
    expect(parseNascarLive({ ...live, series_id: 3 }, NOW)!.seriesId).toBe('nascar-truck');
    expect(parseNascarLive({ ...live, series_id: 2 }, NOW)!.seriesId).toBe('nascar-xfinity');
  });

  it('devuelve null con el feed vacío entre fines de semana y no falla con basura', () => {
    expect(parseNascarLive(fixture('nascar-empty.json'), NOW)).toBeNull();
    for (const v of ODD_INPUTS) expect(() => parseNascarLive(v, NOW)).not.toThrow();
    const weird = parseNascarLive({ race_id: 1, vehicles: [{}, null, { driver: 'x', running_position: 'a', delta: 'z' }] }, NOW)!;
    expect(weird.rows).toHaveLength(2);
    expect(weird.rows[0]!.driver).toBe('—');
    expect(weird.status).toBe('unknown');
  });

  it('limpia las marcas del nombre', () => {
    expect(cleanNascarDriverName('* JJ Yeley(i)')).toBe('JJ Yeley');
    expect(cleanNascarDriverName('Justin Haley(i) (C)')).toBe('Justin Haley');
    expect(cleanNascarDriverName('Connor Zilisch #')).toBe('Connor Zilisch');
  });
});

describe('MotoGP', () => {
  const race = fixture('motogp-qatar-race.json');

  it('lee la carrera de Qatar (respuesta real de livetiming-lite)', () => {
    const b = parseMotogpLive(race, NOW)!;
    expect(b).toMatchObject({
      provider: 'motogp',
      seriesId: 'motogp',
      eventName: 'Qatar Airways Grand Prix of Qatar',
      sessionName: 'MotoGP · Grand Prix',
      status: 'finished',
      flag: 'checkered',
      lap: 22,
      totalLaps: 22,
      sourceUrl: 'https://timingpass.motogp.com/en/',
    });
    expect(b.remaining).toBeUndefined();
    expect(b.rows).toHaveLength(16);
    expect(b.rows[0]).toEqual({
      pos: 1,
      number: '72',
      driver: 'Marco Bezzecchi',
      team: 'Aprilia Racing',
      vehicle: 'Aprilia',
      laps: 22,
      lastLap: '1:53.940',
    });
    expect(b.rows[2]).toMatchObject({ driver: 'Raul Fernandez', gap: '+3.614', interval: '+0.531' });
    expect(b.rows.find((r) => r.number === '49')!.driver).toBe('Fabio Di Giannantonio');
    const binder = b.rows[14]!;
    expect(binder).toMatchObject({ pos: 15, driver: 'Brad Binder', status: 'Abandono', laps: 16 });
    expect(binder.gap).toBeUndefined();
    expect(binder.inPit).toBeUndefined();
    expect(motogpSessionDate(race)).toBe('2026-11-08');
  });

  it('práctica en curso: mejor vuelta, diferencias y tiempo restante', () => {
    const p = clone(race) as Record<string, any>;
    Object.assign(p.head, { category: 'Moto2', session_name: 'Practice 2', session_shortname: 'P2', session_status_id: 'S', session_status_name: 'S', remaining: '754' });
    const b = parseMotogpLive(p, NOW)!;
    expect(b).toMatchObject({ seriesId: 'moto2', status: 'live', remaining: '12:34', sessionName: 'Moto2 · Practice 2' });
    expect(b.flag).toBeUndefined();
    expect(b.lap).toBeUndefined();
    expect(b.rows[0]!.bestLap).toBe('41:29.173');
    expect(b.rows[1]!.gap).toBe('+3.083');

    p.head.session_status_id = 'I';
    expect(parseMotogpLive(p, NOW)).toMatchObject({ status: 'live', flag: 'red' });
    p.head.session_status_id = 'N';
    expect(parseMotogpLive(p, NOW)!.status).toBe('not-started');
  });

  it('carrera en curso: vueltas abajo y boxes', () => {
    const r = clone(race) as Record<string, any>;
    Object.assign(r.head, { session_status_id: 'S', session_status_name: 'S', remaining: '5', category: 'Moto3' });
    r.rider['5'].num_lap = 21;
    r.rider['6'].on_pit = true;
    const b = parseMotogpLive(r, NOW)!;
    expect(b).toMatchObject({ seriesId: 'moto3', status: 'live', lap: 17, totalLaps: 22 });
    expect(b.rows[4]!.gap).toBe('1 V');
    expect(b.rows[5]!.inPit).toBe(true);
  });

  it('no falla con entradas raras', () => {
    for (const v of ODD_INPUTS) expect(() => parseMotogpLive(v, NOW)).not.toThrow();
    expect(parseMotogpLive(null, NOW)).toBeNull();
    expect(parseMotogpLive({ rider: {} }, NOW)).toBeNull();
    const b = parseMotogpLive({ head: { category: 'MotoE' }, rider: { a: null, b: { order: 'x' } } }, NOW)!;
    expect(b.seriesId).toBeUndefined();
    expect(b.status).toBe('unknown');
    expect(b.rows).toEqual([{ pos: 1, driver: '—' }]);
  });
});

describe('Speedhive (resultados por sesión)', () => {
  const events = fixture('speedhive-org-318672-events.json');
  const event = fixture('speedhive-tc2000-event.json');
  const tc2000 = LIVE_SOURCES.tc2000!.speedhive!;
  const sunday = new Date('2026-11-01T18:00:00Z'); // 15:00 en Argentina, domingo de la fecha 10

  it('encuentra el evento de la categoría en la ventana de fechas', () => {
    expect(pickSpeedhiveEvents(events, tc2000, sunday).map((e) => e.id)).toEqual([3768894]);
    expect(pickSpeedhiveEvents(events, tc2000, NOW)).toEqual([]); // la fecha ya pasó
    expect(pickSpeedhiveEvents(events, { eventPattern: /TCR/ }, new Date('2026-11-08T15:00:00Z')).map((e) => e.id)).toEqual([3774738, 3774732]);
  });

  it('elige las sesiones ya empezadas del grupo, la más reciente primero', () => {
    const s = pickSpeedhiveSessions(event, tc2000, sunday);
    expect(s[0]).toEqual({ id: 13048284, name: 'FINAL TC2000', groupName: 'TC2000', type: 'race', startUtc: '2026-11-01T16:05:00Z' });
    expect(s.map((x) => x.name)).toEqual(['FINAL TC2000', 'APERTURA DE BOXES TC 2000', 'WARM UP', 'CLASIFICACION', 'PRACTICA OFICIAL 2', 'PRACTICA OFICIAL1', 'SHAKEDOWN']);
    const sat = pickSpeedhiveSessions(event, tc2000, new Date('2026-10-31T19:00:00Z'));
    expect(sat[0]!.name).toBe('CLASIFICACION');
    expect(pickSpeedhiveSessions(event, { groupPattern: /^TOP RACE$/ }, sunday)[0]!.name).toBe('CARRERA FINAL TOP RACE');
  });

  it('convierte la clasificación de una carrera', () => {
    const b = parseSpeedhiveClassification(fixture('speedhive-tc2000-final-classification.json'), NOW, {
      seriesId: 'tc2000',
      eventName: 'TC2000 - FECHA #10',
      session: { id: 13048284, name: 'FINAL TC2000', groupName: 'TC2000' },
    })!;
    expect(b).toMatchObject({
      provider: 'speedhive',
      seriesId: 'tc2000',
      eventName: 'TC2000 - FECHA #10',
      sessionName: 'TC2000 · FINAL TC2000',
      status: 'finished',
      sourceUrl: 'https://speedhive.mylaps.com/sessions/13048284',
    });
    expect(b.rows).toHaveLength(16);
    expect(b.rows[0]).toEqual({ pos: 1, number: '5', driver: 'Valentin Yankelevich', laps: 21, bestLap: '1:35.050' });
    expect(b.rows[1]).toMatchObject({ driver: 'Matias Rossi', gap: '+1.495' });
    expect(b.rows[7]!.driver).toBe('Gabriel Ponce de Leon');
    expect(b.rows[12]).toMatchObject({ pos: 13, gap: '7 V', status: 'No clasificado' });
  });

  it('convierte una clasificación (qualy) con diferencia al de adelante', () => {
    const b = parseSpeedhiveClassification(fixture('speedhive-tc2000-qualy-classification.json'), NOW, { seriesId: 'tc2000' })!;
    expect(b.rows[0]).toMatchObject({ pos: 1, driver: 'Franco Vivian', bestLap: '1:33.462' });
    expect(b.rows[2]).toMatchObject({ driver: 'Matias Rossi', gap: '+0.570', interval: '+0.250' });
    expect(b.rows.every((r) => r.status === undefined)).toBe(true);
    expect(b.sourceUrl).toBe(LIVE_SOURCES.tc2000!.officialUrl);
  });

  it('no falla con entradas raras', () => {
    for (const v of ODD_INPUTS) {
      expect(() => parseSpeedhiveClassification(v, NOW)).not.toThrow();
      expect(() => pickSpeedhiveEvents(v, tc2000, NOW)).not.toThrow();
      expect(() => pickSpeedhiveSessions(v, tc2000, NOW)).not.toThrow();
    }
    expect(parseSpeedhiveClassification(null, NOW)).toBeNull();
    expect(parseSpeedhiveClassification({ type: 'Race', rows: [] }, NOW)).toMatchObject({ status: 'unknown', rows: [] });
    expect(parseSpeedhiveClassification({ rows: [{ status: 'DNF', position: 2 }, { name: 'JUAN PEREZ' }] }, NOW)!.rows).toEqual([
      { pos: 2, driver: '—', status: 'Abandono' },
      { pos: 2, driver: 'Juan Perez' },
    ]);
  });
});

describe('fuentes en vivo', () => {
  const series = JSON.parse(readFileSync(new URL('../../config/series.default.json', import.meta.url), 'utf8')) as Array<{ id: string }>;

  it('tiene página oficial https para todas las categorías', () => {
    for (const s of series) {
      const src = LIVE_SOURCES[s.id];
      expect(src, s.id).toBeDefined();
      expect(src!.officialUrl, s.id).toMatch(/^https:\/\//);
    }
    expect(Object.keys(LIVE_SOURCES).sort()).toEqual(series.map((s) => s.id).sort());
  });

  it('indica qué pedir y si va por el proxy', () => {
    expect(liveUpstreams('nascar-truck')).toEqual([{ provider: 'nascar', kind: 'board', url: NASCAR_LIVE_FEED_URL, viaProxy: false, pollSeconds: 10 }]);
    expect(liveUpstreams('moto3')).toEqual([{ provider: 'motogp', kind: 'board', url: MOTOGP_LIVE_URL, viaProxy: true, pollSeconds: 15 }]);
    const tc = liveUpstreams('tc2000');
    expect(tc).toHaveLength(1);
    expect(tc[0]).toMatchObject({ provider: 'speedhive', kind: 'speedhive-org-events', viaProxy: true });
    expect(liveUpstreams('tc').length).toBe(2);
    expect(liveUpstreams('f1')).toEqual([]);
    expect(liveUpstreams('no-existe')).toEqual([]);
  });

  it('todo lo que va por el proxy está en la lista permitida, y nada más', () => {
    const viaProxy = Object.keys(LIVE_SOURCES).flatMap(liveUpstreams).filter((u) => u.viaProxy);
    expect(viaProxy.length).toBeGreaterThan(0);
    for (const u of viaProxy) expect(isProxyAllowed(u.url), u.url).toBe(true);
    expect(isProxyAllowed(speedhiveEventUrl(3768894))).toBe(true);
    expect(isProxyAllowed(speedhiveClassificationUrl(13048284))).toBe(true);
    for (const bad of [
      NASCAR_LIVE_FEED_URL,
      `${MOTOGP_LIVE_URL}?x=1`,
      'https://eventresults-api.speedhive.com/api/v0.2.3/eventresults/organizations/999/events?count=10',
      'https://eventresults-api.speedhive.com/api/v0.2.3/eventresults/sessions/1/lapdata/1/laps',
      'https://lt-api.speedhive.com/api/events/x/active',
      'https://evil.example/https://api.motogp.pulselive.com/motogp/v1/timing-gateway/livetiming-lite',
    ]) {
      expect(isProxyAllowed(bad), bad).toBe(false);
    }
    expect(PROXY_ALLOWLIST.length).toBe(4);
  });
});
