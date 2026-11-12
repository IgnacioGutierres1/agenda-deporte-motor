import { describe, expect, it } from 'vitest';
import type { Series } from '@dm/shared';
import { createFiaJuniorAdapter, fiaJuniorAdapter } from '../src/adapters/fia-junior.ts';
import {
  classificationKey,
  classificationsBySession,
  fiaEventOptions,
  matchFiaEvent,
  parseFiaDocumentList,
  type PdfItem,
} from '../src/adapters/fia-documents.ts';
import { createContext } from '../src/core/context.ts';
import { createLogger } from '../src/core/log.ts';
import { fakeHttp, fixture } from './fake-http.ts';

function makeSeries(id: 'f2' | 'f3'): Series {
  return {
    id,
    name: id === 'f2' ? 'FIA Fórmula 2' : 'FIA Fórmula 3',
    shortName: id.toUpperCase(),
    group: 'f1-fia',
    officialUrls: [`https://www.fiaformula${id[1]}.com/Calendar`],
    strategy: 'adapter',
    adapter: 'fia-junior',
    origin: 'default',
    enabled: true,
  };
}
const f2 = makeSeries('f2');
const f3 = makeSeries('f3');

const F2 = 'https://www.fiaformula2.com';
const F3 = 'https://www.fiaformula3.com';
const F1 = 'https://www.formula1.com';
const FIA = 'https://www.fia.com';
const QATAR_SCHEDULE = `${F1}/en/latest/article/formula-1-qatar-airways-qatar-grand-prix-2026.3XJyoYSnpJEcuZovstTdcG`;
const FIA_F2 = `${FIA}/documents/championships/formula-2-championship-44`;
const FIA_F2_BAKU = `${FIA_F2}/season/season-2026-2072/event/Baku`;
const FIA_PDF = `${FIA}/system/files/decision-document/2026_baku_event_-_f2_`;

/** Cronograma del fin de semana en formula1.com (tarjetas del calendario, ronda de Qatar y su nota). */
function f1QatarRoutes(): Record<string, string> {
  return {
    [`${F1}/en/racing/2026`]: fixture('f1/season-2026-cards.html'),
    [`${F1}/en/racing/2026/qatar`]: fixture('f1/round-qatar-full-schedule.html'),
    [QATAR_SCHEDULE]: fixture('f1/schedule-qatar.html'),
  };
}

function f2Routes(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    [`${F2}/en/racing/2026`]: fixture('fia-junior/f2-calendar-2026.html'),
    [`${F2}/en/racing/2026/melbourne`]: fixture('fia-junior/f2-melbourne.html'),
    [`${F2}/en/racing/2026/madrid`]: fixture('fia-junior/f2-madrid.html'),
    [`${F2}/en/racing/2026/lusail`]: fixture('fia-junior/f2-lusail.html'),
    [`${F2}/en/racing/2026/yas-marina`]: fixture('fia-junior/f2-yas-marina.html'),
    ...overrides,
  };
}

function ctxWith(http: ReturnType<typeof fakeHttp>) {
  return createContext({
    now: new Date('2026-11-10T12:00:00.000Z'),
    http,
    log: createLogger('test', true),
    durations: { f2: { practica: 45, clasificacion: 30, sprint: 45, carrera: 60 } },
  });
}

describe('lector F2/F3 (fiaformula2.com / fiaformula3.com)', () => {
  it('lee las rondas del calendario con su número y el cronograma propio de F2', async () => {
    const http = fakeHttp(f2Routes());
    const { events, sessions } = await fiaJuniorAdapter.schedule(f2, ctxWith(http));
    expect(events.map((e) => [e.round, e.source.url.split('/').at(-1)])).toEqual([
      [1, 'melbourne'],
      [11, 'madrid'],
      [13, 'lusail'],
      [14, 'yas-marina'],
    ]);
    // formula1.com solo se consulta por el cronograma del fin de semana de las rondas "TBC" (REGLA F2).
    expect([...new Set(http.calls.filter((u) => !u.startsWith(F2)))]).toEqual([`${F1}/en/racing/2026`]);

    const madrid = events.find((e) => e.round === 11)!;
    expect(madrid).toMatchObject({
      circuit: 'Madring',
      country: 'España',
      tz: 'Europe/Madrid',
      dateStart: '2026-09-11',
      dateEnd: '2026-09-13',
      sessionsStatus: 'published',
    });
    expect(madrid.source).toMatchObject({
      url: 'https://www.fiaformula2.com/en/racing/2026/madrid',
      kind: 'html',
      method: 'directo',
      fetchedAt: '2026-11-10T12:00:00Z',
    });
    const ms = sessions.filter((s) => s.eventId === madrid.id);
    expect(ms.map((s) => [s.type, s.name, s.localStartText, s.startUtc, s.endUtc, s.endEstimated])).toEqual([
      ['practica', 'Práctica', '11:05', '2026-09-11T09:05:00Z', '2026-09-11T09:50:00Z', false],
      ['clasificacion', 'Clasificación', '15:00', '2026-09-11T13:00:00Z', '2026-09-11T13:30:00Z', false],
      ['sprint', 'Sprint', '14:15', '2026-09-12T12:15:00Z', '2026-09-12T13:05:00Z', false],
      ['carrera', 'Carrera principal', '11:25', '2026-09-13T09:25:00Z', '2026-09-13T10:30:00Z', false],
    ]);
  });

  it('convierte con el horario de verano del circuito (Melbourne, +11)', async () => {
    const http = fakeHttp(f2Routes());
    const { events, sessions } = await fiaJuniorAdapter.schedule(f2, ctxWith(http));
    const mel = events.find((e) => e.round === 1)!;
    expect(mel.tz).toBe('Australia/Melbourne');
    const practice = sessions.find((s) => s.eventId === mel.id && s.type === 'practica')!;
    expect(practice.localStartText).toBe('10:00');
    expect(practice.startUtc).toBe('2026-03-05T23:00:00Z');
  });

  it('las rondas con cronograma "TBC" (Lusail, Yas Marina) quedan pendientes y sin sesiones', async () => {
    const http = fakeHttp(f2Routes());
    const { events, sessions } = await fiaJuniorAdapter.schedule(f2, ctxWith(http));
    const lusail = events.find((e) => e.round === 13)!;
    const yas = events.find((e) => e.round === 14)!;
    expect(lusail).toMatchObject({ sessionsStatus: 'pending', tz: 'Asia/Qatar', dateStart: '2026-11-27', dateEnd: '2026-11-29' });
    expect(yas).toMatchObject({ sessionsStatus: 'pending', tz: 'Asia/Dubai', dateStart: '2026-12-04', dateEnd: '2026-12-06' });
    expect(sessions.some((s) => s.eventId === lusail.id || s.eventId === yas.id)).toBe(false);
  });

  it('una ronda "TBC" toma las filas de F2 del cronograma oficial del fin de semana (formula1.com)', async () => {
    const http = fakeHttp({ ...f2Routes(), ...f1QatarRoutes() });
    const { events, sessions } = await fiaJuniorAdapter.schedule(f2, ctxWith(http));
    const lusail = events.find((e) => e.round === 13)!;
    expect(lusail).toMatchObject({ sessionsStatus: 'published', tz: 'Asia/Qatar', dateStart: '2026-11-27', dateEnd: '2026-11-29' });
    // El evento sigue apuntando al sitio de F2 (de ahí se leen los resultados).
    expect(lusail.source.url).toBe('https://www.fiaformula2.com/en/racing/2026/lusail');
    const ls = sessions.filter((s) => s.eventId === lusail.id);
    // Nombres de F2 (los ids no cambian cuando el sitio confirme) y horas de la tabla "FIA Formula 2" (UTC+3).
    expect(ls.map((s) => [s.type, s.name, s.localStartText, s.startUtc, s.endUtc, s.endEstimated])).toEqual([
      ['practica', 'Práctica', '14:00', '2026-11-27T11:00:00Z', '2026-11-27T11:45:00Z', false],
      ['clasificacion', 'Clasificación', '18:00', '2026-11-27T15:00:00Z', '2026-11-27T15:30:00Z', false],
      ['sprint', 'Sprint', '19:40', '2026-11-28T16:40:00Z', '2026-11-28T17:30:00Z', false],
      ['carrera', 'Carrera principal', '15:00', '2026-11-29T12:00:00Z', '2026-11-29T13:05:00Z', false],
    ]);
    expect(ls[0]!.source).toMatchObject({ url: QATAR_SCHEDULE, kind: 'html', method: 'directo' });
    // Abu Dhabi: formula1.com todavía no tiene su página en el fixture -> sigue "a confirmar".
    const yas = events.find((e) => e.round === 14)!;
    expect(yas.sessionsStatus).toBe('pending');
  });

  it('no usa el cronograma del fin de semana si las sesiones no coinciden con las de F2', async () => {
    // Sin la fila de la carrera principal, el emparejamiento por tipo falla y la ronda queda "TBC".
    const article = fixture('f1/schedule-qatar.html').replace(/<tr><td>FIA Formula 2<\/td><td>Feature Race[\s\S]*?<\/tr>/, '');
    const http = fakeHttp({ ...f2Routes(), ...f1QatarRoutes(), [QATAR_SCHEDULE]: article });
    const { events } = await fiaJuniorAdapter.schedule(f2, ctxWith(http));
    expect(events.find((e) => e.round === 13)!.sessionsStatus).toBe('pending');
  });

  it('descarta sesiones que no son de la categoría pedida', async () => {
    const page = fixture('fia-junior/f2-madrid.html').replaceAll('\\"value\\":\\"f2/race', '\\"value\\":\\"f1/race');
    const http = fakeHttp(f2Routes({ [`${F2}/en/racing/2026/madrid`]: page }));
    const { events, sessions } = await fiaJuniorAdapter.schedule(f2, ctxWith(http));
    const madrid = events.find((e) => e.round === 11)!;
    expect(sessions.filter((s) => s.eventId === madrid.id).map((s) => s.name)).toEqual(['Práctica', 'Clasificación']);
  });

  it('F3 usa su propio sitio y conserva sesiones con nombres numerados', async () => {
    const http = fakeHttp({
      [`${F3}/en/racing/2026`]: fixture('fia-junior/f3-calendar-2026.html'),
      [`${F3}/en/racing/2026/madrid`]: fixture('fia-junior/f3-madrid.html'),
    });
    const { events, sessions } = await fiaJuniorAdapter.schedule(f3, ctxWith(http));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ round: 9, seriesId: 'f3' });
    expect(events[0]!.source.url).toBe('https://www.fiaformula3.com/en/racing/2026/madrid');
    expect(sessions.map((s) => [s.type, s.name])).toEqual([
      ['practica', 'Práctica'],
      ['clasificacion', 'Clasificación 1'],
      ['clasificacion', 'Clasificación 2'],
      ['sprint', 'Sprint'],
      ['carrera', 'Carrera principal 1'],
      ['carrera', 'Carrera principal 2'],
    ]);
    expect(new Set(sessions.map((s) => s.id)).size).toBe(6);
  });

  it('rechaza series desconocidas', async () => {
    const http = fakeHttp({});
    await expect(fiaJuniorAdapter.schedule({ ...f2, id: 'f4' }, ctxWith(http))).rejects.toThrow(/f4/);
  });

  it('lee los resultados embebidos en la página de la ronda y el campeonato', async () => {
    const http = fakeHttp(
      f2Routes({
        [`${F2}/en/standings/2026/drivers`]: fixture('fia-junior/f2-standings-drivers.html'),
        [`${F2}/en/standings/2026/teams`]: fixture('fia-junior/f2-standings-teams.html'),
      }),
    );
    const ctx = ctxWith(http);
    const { events, sessions } = await fiaJuniorAdapter.schedule(f2, ctx);
    const madrid = events.find((e) => e.round === 11)!;
    const pending = sessions.filter((s) => s.eventId === madrid.id).reverse();
    const out = await fiaJuniorAdapter.results!(f2, ctx, { events, sessions, pendingSessions: pending, standingsStale: true });

    expect(out.results).toHaveLength(1);
    const file = out.results[0]!;
    expect(file).toMatchObject({ seriesId: 'f2', eventId: madrid.id, updatedAt: '2026-11-10T12:00:00Z' });
    expect(file.sessions).toHaveLength(1);
    const feature = file.sessions[0]!;
    expect(feature.sessionId).toBe(pending[0]!.id);
    expect(feature.source.url).toBe('https://www.fiaformula2.com/en/racing/2026/madrid');
    expect(feature.rows[0]).toEqual({
      pos: 1,
      driver: 'Dino Beganovic',
      number: '7',
      team: 'DAMS Lucas Oil',
      laps: 31,
      time: '1:3:29.190',
      points: 25,
    });
    expect(feature.rows[1]).toMatchObject({ pos: 2, driver: 'Alexander Dunne', gap: '+7.320s', points: 19 });
    expect(feature.rows.at(-1)).toMatchObject({ pos: null, status: 'DNF', driver: 'Kush Maini', laps: 1 });

    const [drivers, teams] = out.standings!.tables;
    expect(drivers).toMatchObject({ title: 'Pilotos' });
    expect(drivers!.rows[0]).toEqual({ pos: 1, name: 'Rafael Câmara', points: 207 });
    expect(teams).toMatchObject({ title: 'Equipos' });
    expect(teams!.rows.map((r) => r.name)).toEqual(['Campos Racing', 'Invicta Racing', 'Rodin Motorsport']);
    expect(out.standings!.source.url).toBe('https://www.fiaformula2.com/en/standings/2026/drivers');
  });
});

describe('resultados de F2 desde las clasificaciones de la FIA (fia.com/documents)', () => {
  /** El PDF falso es el texto posicionado (JSON) que unpdf extrajo del PDF real. */
  const pdfItems = async (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as PdfItem[];

  function bakuRoutes(): Record<string, string> {
    return {
      [`${F2}/en/racing/2026`]: '<span>ROUND 12</span><a href="/en/racing/2026/baku">round</a>',
      [`${F2}/en/racing/2026/baku`]: fixture('fia-junior/f2-baku.html'),
      [FIA_F2]: fixture('fia-junior/fia-docs-f2-2026.html'),
      [FIA_F2_BAKU]: fixture('fia-junior/fia-docs-f2-baku.html'),
      [`${FIA_PDF}race_1_sprint_-_final_classification.pdf`]: fixture('fia-junior/fia-baku-f2-sprint.items.json'),
      [`${FIA_PDF}qualifying_1_-_final_classification.pdf`]: fixture('fia-junior/fia-baku-f2-qualifying-1.items.json'),
    };
  }

  it('lee sprint y clasificación de los PDF (la página de la ronda solo trae la última carrera)', async () => {
    const http = fakeHttp(bakuRoutes());
    const ctx = ctxWith(http);
    const adapter = createFiaJuniorAdapter({ pdfItems });
    const { events, sessions } = await adapter.schedule(f2, ctx);
    const baku = events[0]!;
    expect(sessions.map((s) => s.name)).toEqual([
      'Práctica',
      'Clasificación 1',
      'Clasificación 2',
      'Sprint',
      'Carrera principal 1',
      'Carrera principal 2',
    ]);
    // El nombre original de la fuente queda en originalName (y el id sale de ese).
    expect(sessions.map((s) => s.originalName)).toEqual([
      'Practice',
      'Qualifying 1',
      'Qualifying 2',
      'Sprint Race',
      'Feature Race 1',
      'Feature Race 2',
    ]);
    const pending = [...sessions].reverse();
    const out = await adapter.results!(f2, ctx, { events, sessions, pendingSessions: pending, standingsStale: false });
    expect(out.results).toHaveLength(1);
    const file = out.results[0]!;
    expect(file.eventId).toBe(baku.id);
    const byName = new Map(file.sessions.map((r) => [sessions.find((s) => s.id === r.sessionId)!.originalName!, r]));
    // Feature Race 2: embebida en la página; sprint y Qualifying 1: PDF final (no el provisorio).
    // Practice, Qualifying 2 y Feature Race 1 no tienen PDF en el fixture (404): quedan pendientes.
    expect([...byName.keys()].sort()).toEqual(['Feature Race 2', 'Qualifying 1', 'Sprint Race']);

    const sprint = byName.get('Sprint Race')!;
    expect(sprint.source).toMatchObject({
      url: `${FIA_PDF}race_1_sprint_-_final_classification.pdf`,
      kind: 'pdf',
      method: 'directo',
      title: 'FIA — FIA Formula 2 Azerbaijan Grand Prix: F2 Race 1 (Sprint) - final classification',
    });
    expect(sprint.rows).toHaveLength(22);
    expect(sprint.rows[0]).toEqual({
      pos: 1,
      number: '7',
      driver: 'Dino Beganovic',
      team: 'DAMS Lucas Oil',
      laps: 21,
      time: '45:48.207',
      points: 10,
    });
    expect(sprint.rows[1]).toMatchObject({ pos: 2, driver: 'Laurens van Hoepen', gap: '+1.058s', points: 8 });
    // Nombre con tilde del sitio de F2 (la FIA escribe "Rafael CAMARA").
    expect(sprint.rows[14]).toMatchObject({ pos: 15, number: '1', driver: 'Rafael Câmara', gap: '+26.204s' });
    // Clasificado sin terminar y no clasificados.
    expect(sprint.rows[18]).toMatchObject({ pos: 19, driver: 'Ritomo Miyata', status: 'DNF', laps: 20 });
    expect(sprint.rows.slice(-2)).toEqual([
      { pos: null, number: '2', driver: 'Joshua Dürksen', team: 'Invicta Racing', laps: 17, status: 'DNF' },
      { pos: null, number: '12', driver: 'Mari Boya', team: 'PREMA Racing', laps: 0, status: 'DNF' },
    ]);

    const q1 = byName.get('Qualifying 1')!;
    expect(q1.rows).toHaveLength(22);
    expect(q1.rows[0]).toEqual({ pos: 1, number: '15', driver: 'Alexander Dunne', team: 'Rodin Motorsport', laps: 8, time: '1:55.383' });
    expect(q1.rows[11]).toMatchObject({ pos: 12, driver: 'Tasanapol Inthraphuvasak', time: '1:56.239' });

    // Un solo pedido al tablero de la FIA por evento y ninguno a los PDF que no son de sesiones pendientes.
    expect(http.calls.filter((u) => u === FIA_F2_BAKU)).toHaveLength(1);
    expect(http.calls.some((u) => /provisional|grid/.test(u))).toBe(false);
  });

  it('elige el documento más firme de cada sesión y reconoce los nombres de la FIA', () => {
    const docs = parseFiaDocumentList(fixture('fia-junior/fia-docs-f2-baku.html'));
    const best = classificationsBySession(docs, 'f2');
    expect(Object.fromEntries([...best].map(([k, d]) => [k, d.url.split('_-_').slice(1).join('_-_')]))).toEqual({
      P: 'f2_practice_-_amended_classification.pdf',
      Q1: 'f2_qualifying_1_-_final_classification.pdf',
      Q2: 'f2_qualifying_2_-_final_classification.pdf',
      R1: 'f2_race_1_sprint_-_final_classification.pdf',
      R2: 'f2_race_2_feature_1_-_final_classification.pdf',
      R3: 'f2_race_3_feature_2_-_final_classification.pdf',
    });
    expect(classificationKey('Doc 44 - 2026 Monza Event - F3 Qualifying - Group B - Final Classification', 'f3')).toEqual({ key: 'Q2', rank: 3 });
    expect(classificationKey('DOC 36 - 2026 Budapest Event - F2 Race 1 - final classification', 'f2')).toEqual({ key: 'R1', rank: 3 });
    expect(classificationKey('F2 qualifying A - provisional classification', 'f2')).toEqual({ key: 'Q1', rank: 1 });
    expect(classificationKey('F3 Race 1 (Sprint) - Provisional classifiaction', 'f3')).toEqual({ key: 'R1', rank: 1 });
    expect(classificationKey('F3 Race 1 (Sprint) - Final classification', 'f2')).toBeNull();
    expect(classificationKey('INFRINGEMENT - Practice - Lap time classifications', 'f2')).toBeNull();
    expect(classificationKey('F2 Race 1 (Sprint) - final starting grid', 'f2')).toBeNull();

    const events = fiaEventOptions(fixture('fia-junior/fia-docs-f2-2026.html'), 2026);
    expect(events).toHaveLength(12);
    const pick = (slug: string, meeting: Record<string, string> = {}) => matchFiaEvent(events, meeting, slug)?.label;
    expect(pick('montreal')).toBe('Montréal');
    expect(pick('barcelona')).toBe('Barcelona-Catalunya');
    expect(pick('miami-gardens', { meetingLocation: 'Miami' })).toBe('Miami');
    expect(pick('monte-carlo', { meetingLocation: 'Monte Carlo', meetingCountryName: 'Monaco' })).toBe('Monaco');
    expect(pick('lusail', { meetingLocation: 'Lusail' })).toBeUndefined();
  });
});
