import { describe, expect, it } from 'vitest';
import { eventResultsFileSchema, sessionSchema, standingsFileSchema, eventSchema, type Series } from '@dm/shared';
import { createContext } from '../src/core/context.ts';
import { createLogger } from '../src/core/log.ts';
import { pendingResultSessions } from '../src/core/results.ts';
import { validateSessions } from '../src/validate.ts';
import {
  apiDateToUtc,
  describeSession,
  mapClassification,
  mapConditions,
  pdfClassification,
  MOTOGP_API,
  motogpAdapter,
  parseStandingsXml,
  titleCase,
} from '../src/adapters/motogp.ts';
import { readFileSync } from 'node:fs';
import { fixtureHttp } from './fixtures-http.ts';

const R = `${MOTOGP_API}/results`;
const SEASON = 'e88b4e43-2209-47aa-8e83-0e0b1cedde6e';
const QAT_RESULTS = '5a880aba-62c4-413c-bb2d-b721683dd064';
const MGP_CAT = 'e8c110ad-64aa-4e8e-8a86-f2f152f6a942';

const routes = {
  [`${MOTOGP_API}/events?seasonYear=2026`]: 'motogp/events.json',
  [`${R}/seasons`]: 'motogp/results-seasons.json',
  [`${R}/events?seasonUuid=${SEASON}&isFinished=true`]: 'motogp/results-events.json',
  [`${R}/categories?eventUuid=${QAT_RESULTS}`]: 'motogp/results-categories.json',
  [`${R}/sessions?eventUuid=${QAT_RESULTS}&categoryUuid=${MGP_CAT}`]: 'motogp/results-sessions.json',
  [`${R}/session/67c2f209-bea0-47e9-9375-d7958fd4fe1d/classification?test=false`]: 'motogp/classification-rac.json',
  [`${R}/session/d1022c09-0af2-4e5d-b4ac-fba02562fb0c/classification?test=false`]: 'motogp/classification-fp1.json',
  [`${R}/standings?seasonUuid=${SEASON}&categoryUuid=${MGP_CAT}`]: 'motogp/standings.json',
  ['https://resources.motogp.com/files/results/2026/QAT/MotoGP/RAC/worldstanding.XML']: 'motogp/worldstanding.xml',
};

function series(id: string, shortName: string): Series {
  return {
    id,
    name: shortName,
    shortName,
    group: 'moto',
    officialUrls: ['https://www.motogp.com/en/calendar'],
    strategy: 'adapter',
    adapter: 'motogp',
    origin: 'default',
    enabled: true,
  };
}

function setup() {
  const http = fixtureHttp(routes);
  const ctx = createContext({
    now: new Date('2026-11-10T12:00:00Z'),
    http,
    log: createLogger('test', true),
    durations: { motogp: { carrera: 50, sprint: 30 } },
    broadcast: { motogp: ['ESPN'] },
  });
  return { http, ctx };
}

describe('MotoGP: helpers', () => {
  it('convierte fechas con offset sin dos puntos a UTC', () => {
    expect(apiDateToUtc('2026-11-06T14:45:00+0300')).toBe('2026-11-06T11:45:00Z');
    expect(apiDateToUtc('2026-11-20T09:00:00+0000')).toBe('2026-11-20T09:00:00Z');
  });
  it('nombra las sesiones en español', () => {
    expect(describeSession('FP1', 'Free Practice Nr. 1')).toEqual({ type: 'practica', name: 'Práctica Libre 1' });
    expect(describeSession('Q2', 'Qualifying Nr. 2')).toEqual({ type: 'clasificacion', name: 'Clasificación Q2' });
    expect(describeSession('SPR', 'Tissot Sprint')).toEqual({ type: 'sprint', name: 'Sprint' });
    expect(describeSession('WUP', 'Warm Up')).toEqual({ type: 'warmup', name: 'Warm Up' });
    expect(describeSession('RAC', 'Grand Prix')).toEqual({ type: 'carrera', name: 'Carrera' });
  });
  it('pasa el nombre del GP a formato título', () => {
    expect(titleCase('REPSOL GRAND PRIX OF PORTUGAL ')).toBe('Repsol Grand Prix of Portugal');
    expect(titleCase('PT GRAND PRIX OF THAILAND')).toBe('PT Grand Prix of Thailand');
  });
  it('lee equipos y constructores del XML (puntos x10)', () => {
    const tables = parseStandingsXml(
      '<worldstanding_team pos="1" team_name="Aprilia Racing" total_points="7285" />' +
        '<worldstanding_constructor pos="1" bike_name="Ducati" total_points="5690"></worldstanding_constructor>',
    );
    expect(tables).toEqual([
      { title: 'Equipos', rows: [{ pos: 1, name: 'Aprilia Racing', points: 728.5 }] },
      { title: 'Constructores', rows: [{ pos: 1, name: 'Ducati', points: 569 }] },
    ]);
  });
});

describe('MotoGP: horarios', () => {
  it('descarta pruebas y presentaciones y filtra las sesiones por categoría', async () => {
    const { ctx } = setup();
    const gp = await motogpAdapter.schedule(series('motogp', 'MotoGP'), ctx);
    const m2 = await motogpAdapter.schedule(series('moto2', 'Moto2'), ctx);
    const m3 = await motogpAdapter.schedule(series('moto3', 'Moto3'), ctx);

    expect(gp.events.map((e) => e.name)).toEqual([
      'Qatar Airways Grand Prix of Qatar',
      'Repsol Grand Prix of Portugal',
    ]);
    const qat = gp.events[0]!;
    expect(qat).toMatchObject({
      round: 20,
      circuit: 'Lusail International Circuit',
      country: 'Catar',
      tz: 'Asia/Qatar',
      dateStart: '2026-11-06',
      dateEnd: '2026-11-08',
      sessionsStatus: 'published',
    });
    expect(qat.source.url).toBe(
      'https://www.motogp.com/en/calendar/2026/event/qatar/3f3d3f5e-851c-42d2-887a-8ce8b41fa908',
    );
    expect(qat.source).toMatchObject({ kind: 'api', method: 'directo', fetchedAt: '2026-11-10T12:00:00Z' });

    const byEvent = (chunk: typeof gp, id: string) => chunk.sessions.filter((s) => s.eventId === id);
    // MotoGP: FP1, PR, FP2, Q1, Q2, SPR, WUP, RAC. Moto2/Moto3: FP1, PR, FP2, Q1, Q2, RAC.
    expect(byEvent(gp, qat.id).map((s) => s.name)).toEqual([
      'Práctica libre 1',
      'Práctica',
      'Práctica libre 2',
      'Clasificación Q1',
      'Clasificación Q2',
      'Sprint',
      'Warm Up',
      'Carrera',
    ]);
    expect(byEvent(m2, m2.events[0]!.id)).toHaveLength(6);
    expect(byEvent(m3, m3.events[0]!.id)).toHaveLength(6);

    for (const e of [...gp.events, ...m2.events]) eventSchema.parse(e);
    for (const s of [...gp.sessions, ...m2.sessions, ...m3.sessions]) sessionSchema.parse(s);
    expect(validateSessions(gp.sessions, gp.events).issues).toEqual([]);
  });

  it('convierte a UTC y usa el fin publicado salvo en carreras', async () => {
    const { ctx } = setup();
    const gp = await motogpAdapter.schedule(series('motogp', 'MotoGP'), ctx);
    const m3 = await motogpAdapter.schedule(series('moto3', 'Moto3'), ctx);
    const qatId = gp.events[0]!.id;
    const fp1 = gp.sessions.find((s) => s.eventId === qatId && s.name === 'Práctica libre 1')!;
    expect(fp1).toMatchObject({
      type: 'practica',
      startUtc: '2026-11-06T11:45:00Z',
      endUtc: '2026-11-06T12:30:00Z',
      endEstimated: false,
      localStartText: '14:45',
      broadcast: ['ESPN'],
      broadcastIsDefault: true,
    });
    const race = gp.sessions.find((s) => s.eventId === qatId && s.type === 'carrera')!;
    expect(race).toMatchObject({ startUtc: '2026-11-08T16:00:00Z', endUtc: '2026-11-08T16:50:00Z', endEstimated: true });
    // Portugal (UTC+0 en noviembre), Moto3 FP1 09:00 local.
    const porM3 = m3.sessions.find((s) => s.eventId === m3.events[1]!.id && s.name === 'Práctica libre 1')!;
    expect(porM3.startUtc).toBe('2026-11-20T09:00:00Z');
    expect(porM3.localStartText).toBe('09:00');
  });
});

describe('MotoGP: resultados y campeonato', () => {
  it('mapea la clasificación de carrera y práctica y el campeonato', async () => {
    const { ctx } = setup();
    const s = series('motogp', 'MotoGP');
    const chunk = await motogpAdapter.schedule(s, ctx);
    const pending = pendingResultSessions(chunk.sessions, ctx.now, {});
    // Solo Qatar terminó (Portugal es a futuro).
    expect(pending).toHaveLength(8);

    const res = await motogpAdapter.results!(s, ctx, {
      events: chunk.events,
      sessions: chunk.sessions,
      pendingSessions: pending,
      standingsStale: true,
    });
    expect(res.results).toHaveLength(1);
    const file = eventResultsFileSchema.parse(res.results[0]);
    expect(file.eventId).toBe(chunk.events[0]!.id);
    // Hay fixture solo para FP1 y carrera; el resto queda pendiente.
    expect(file.sessions).toHaveLength(2);

    const raceId = chunk.sessions.find((x) => x.eventId === file.eventId && x.type === 'carrera')!.id;
    const race = file.sessions.find((x) => x.sessionId === raceId)!;
    expect(race.source.url).toBe('https://www.motogp.com/en/gp-results/2026/qat/motogp/rac/classification');
    expect(race.rows[0]).toEqual({
      pos: 1,
      driver: 'Marco Bezzecchi',
      number: '72',
      team: 'Aprilia Racing',
      vehicle: 'Aprilia',
      laps: 22,
      time: '41:29.173',
      points: 25,
    });
    expect(race.rows[1]).toMatchObject({ pos: 2, driver: 'Marc Marquez', gap: '+3.083', points: 20 });
    expect(race.rows[2]).toMatchObject({ pos: null, status: 'DNF', driver: 'Diogo Moreira' });

    const fp1Id = chunk.sessions.find((x) => x.eventId === file.eventId && x.name === 'Práctica libre 1')!.id;
    const fp1 = file.sessions.find((x) => x.sessionId === fp1Id)!;
    expect(fp1.rows[0]).toMatchObject({ pos: 1, driver: 'Marc Marquez', bestLap: '1:52.278', time: '1:52.278' });
    expect(fp1.rows[1]).toMatchObject({ pos: 2, gap: '+0.110' });

    const st = standingsFileSchema.parse(res.standings);
    expect(st.source.url).toBe('https://www.motogp.com/en/world-standing/2026/motogp/championship-standings');
    expect(st.tables.map((t) => t.title)).toEqual(['Pilotos', 'Equipos', 'Constructores']);
    expect(st.tables[0]!.rows[0]).toEqual({
      pos: 1,
      name: 'Marc Marquez',
      team: 'Ducati Lenovo Team',
      number: '93',
      points: 431,
      wins: 7,
    });
    expect(st.tables[1]!.rows[0]).toEqual({ pos: 1, name: 'Aprilia Racing', points: 728 });
    expect(st.tables[2]!.rows[0]).toEqual({ pos: 1, name: 'Ducati', points: 569 });
  });

  it('no consulta resultados si no hay nada pendiente', async () => {
    const { ctx, http } = setup();
    const s = series('moto2', 'Moto2');
    const chunk = await motogpAdapter.schedule(s, ctx);
    const res = await motogpAdapter.results!(s, ctx, {
      events: chunk.events,
      sessions: chunk.sessions,
      pendingSessions: [],
      standingsStale: false,
    });
    expect(res).toEqual({ results: [] });
    expect(http.calls.some((u) => u.includes('/results/'))).toBe(false);
  });
});

describe('MotoGP: clasificación desde el PDF oficial', () => {
  // Warm Up de MotoGP en Indonesia 2026: la API lo da por terminado con la tabla vacía; el PDF la tiene.
  const text = readFileSync(new URL('./fixtures/motogp/wup-ina-classification.txt', import.meta.url), 'utf8');

  it('separa velocidad y puesto, y vueltas y equipo, que el texto del PDF pega', () => {
    const read = pdfClassification(text, new Map([['49', { name: 'Fabio Di Giannantonio', maker: 'Ducati' }]]));
    const rows = mapClassification(read.rows, 'WUP');
    expect(rows).toHaveLength(21);
    expect(rows[0]).toEqual({ pos: 1, driver: 'Marco Bezzecchi', number: '72', team: 'Aprilia Racing', vehicle: 'Aprilia', laps: 7, bestLap: '1:29.617', time: '1:29.617' });
    expect(rows[1]).toMatchObject({ pos: 2, driver: 'Raul Fernandez', number: '25', team: 'SuperFile Trackhouse MotoGP Team', laps: 6, gap: '+0.043' });
    expect(rows[5]).toMatchObject({ pos: 6, driver: 'Fabio Di Giannantonio', team: 'Pertamina Enduro VR46 Racing Team' });
    expect(rows[9]).toMatchObject({ pos: 10, number: '79', driver: 'Ai Ogura' });
    expect(rows[16]).toMatchObject({ pos: 17, driver: 'Maverick Viñales', vehicle: 'KTM' });
    expect(rows[20]).toMatchObject({ pos: 21, driver: 'Johann Zarco', gap: '+2.256' });
  });

  it('lee las condiciones del pie del PDF', () => {
    expect(mapConditions(pdfClassification(text).condition)).toEqual({ airC: 29, trackC: 55, humidity: 68, track: 'Seca' });
  });
});
