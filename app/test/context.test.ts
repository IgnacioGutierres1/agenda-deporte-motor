import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { EventResultsFile, MotorEvent, NewsItem, RosterRow, Session, SessionType, StandingsFile, StandingsTable } from '@dm/shared';
import EventView from '../src/views/EventView.vue';
import { routes } from '../src/router.ts';
import {
  eventMaxPoints,
  eventNeedles,
  gapTable,
  highlights,
  marginText,
  newsReference,
  pickNews,
  POINTS_RULES,
  racesAfter,
  remainingText,
  rosterSummary,
  roundInfo,
  seasonEvents,
  sessionCounts,
  standingsTiming,
  surnameNeedles,
  titleMath,
  whoToWatch,
  durationText,
} from '../src/lib/context.ts';
import { useNewsStore } from '../src/stores/news.ts';
import { useResultsStore } from '../src/stores/results.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { useSettingsStore } from '../src/stores/settings.ts';
import { NOW, fixture, scheduleFixture, statusFixture } from './helpers.ts';

const source = { url: 'https://example.org/x', title: 'Oficial', kind: 'html' as const, method: 'directo' as const, fetchedAt: NOW };

const ev = (id: string, seriesId: string, dateStart: string, round?: number, name = `Evento ${id}`): MotorEvent => ({
  id,
  seriesId,
  name,
  ...(round !== undefined ? { round } : {}),
  circuit: 'Circuito',
  country: 'País',
  tz: 'UTC',
  dateStart,
  dateEnd: dateStart,
  sessionsStatus: 'published',
  source,
});

let n = 0;
const ses = (eventId: string, type: SessionType, startUtc: string, minutes = 60, extra: Partial<Session> = {}): Session => ({
  id: `s${++n}`,
  eventId,
  seriesId: 'x',
  type,
  name: type,
  startUtc,
  endUtc: new Date(Date.parse(startUtc) + minutes * 60_000).toISOString().replace('.000Z', 'Z'),
  endEstimated: false,
  broadcast: [],
  broadcastIsDefault: false,
  source,
  hasResults: false,
  ...extra,
});

const table = (rows: Array<[string, number, string?]>, title = 'Pilotos'): StandingsTable => ({
  title,
  rows: rows.map(([name, points, team], i) => ({ pos: i + 1, name, points, ...(team ? { team } : {}) })),
});

describe('temporada', () => {
  const events = [
    ev('t1', 'f1', '2026-02-11'), // ensayos, sin número
    ev('a1', 'f1', '2026-03-06', 1),
    ev('a2', 'f1', '2026-03-13', 2),
    ev('a3', 'f1', '2026-03-27', 3),
    ev('b1', 'f1', '2027-03-05', 1),
    ev('x1', 'alms', '2026-11-13', 1),
    ev('x2', 'alms', '2027-01-15', 2),
    ev('x3', 'alms', '2027-02-19', 3),
    ev('tn1', 'tn', '2026-03-01'),
    ev('tn2', 'tn', '2026-04-01'),
    ev('tn0', 'tn', '2025-12-01'),
  ];

  it('separa temporadas cuando la numeración vuelve a empezar y deja afuera los ensayos', () => {
    expect(seasonEvents(events, events[2]!).map((e) => e.id)).toEqual(['a1', 'a2', 'a3']);
    expect(seasonEvents(events, events[0]!)).toEqual([]);
    // La Asian Le Mans cruza el año.
    expect(roundInfo(events, events[5]!)).toMatchObject({ n: 1, of: 3, byCalendar: false });
  });

  it('calcula fecha N de M, las que quedan y la anterior', () => {
    const info = roundInfo(events, events[2]!)!;
    expect(info).toMatchObject({ n: 2, of: 3 });
    expect(info.after.map((e) => e.id)).toEqual(['a3']);
    expect(info.previous?.id).toBe('a1');
    expect(roundInfo(events, events[1]!)!.previous).toBeUndefined();
  });

  it('sin numeración usa el orden en el calendario del año', () => {
    expect(roundInfo(events, events[9]!)).toMatchObject({ n: 2, of: 2, byCalendar: true });
  });

  it('describe cuánto falta', () => {
    expect(remainingText(0)).toBe('Última fecha de la temporada');
    expect(remainingText(1)).toBe('Anteúltima fecha: después queda 1 más');
    expect(remainingText(4)).toBe('Después de esta quedan 4 fechas');
  });

  it('cuenta carreras que quedan solo si todas las fechas tienen cronograma', () => {
    const sessions = [ses('a2', 'sprint', '2026-03-14T10:00:00Z'), ses('a2', 'carrera', '2026-03-15T10:00:00Z'), ses('a3', 'carrera', '2026-03-29T10:00:00Z')];
    expect(racesAfter(sessions, [events[2]!, events[3]!])).toBe(3);
    expect(racesAfter(sessions, [events[2]!, events[4]!])).toBeNull();
  });
});

describe('antes o después de la carrera', () => {
  const event = ev('e', 'f1', '2026-11-06');
  const sessions = [
    ses('e', 'clasificacion', '2026-11-07T18:00:00Z'),
    ses('e', 'sprint', '2026-11-07T14:00:00Z', 30),
    ses('e', 'carrera', '2026-11-08T17:00:00Z', 120),
  ];

  it('compara la lectura de la tabla con el fin de las carreras', () => {
    expect(standingsTiming('2026-11-05T10:00:00Z', event, sessions)).toBe('before');
    expect(standingsTiming('2026-11-07T20:00:00Z', event, sessions)).toBe('partial');
    expect(standingsTiming('2026-11-08T19:00:00Z', event, sessions)).toBe('after');
  });

  it('sin cronograma usa los días del evento', () => {
    const tc = { ...ev('tc', 'tc', '2026-11-13'), dateEnd: '2026-11-15' };
    expect(standingsTiming('2026-11-10T19:13:39Z', tc, [])).toBe('before');
    expect(standingsTiming('2026-11-14T12:00:00Z', tc, [])).toBe('unknown');
    expect(standingsTiming('2026-11-17T12:00:00Z', tc, [])).toBe('after');
  });
});

describe('diferencias y cuentas del título', () => {
  it('muestra los primeros con la diferencia y suma a los seguidos que están más atrás', () => {
    const t = table([
      ['Kimi Antonelli', 390, 'Mercedes'],
      ['Max Verstappen', 279, 'Red Bull Racing'],
      ['George Russell', 262, 'Mercedes'],
      ['Lando Norris', 250, 'McLaren'],
      ['Franco Colapinto', 20, 'Alpine'],
    ]);
    const g = gapTable(t, 2, { driverIds: ['colapinto-franco'], teamIds: [] });
    expect(g.rows.map((r) => [r.name, r.gap, r.followed])).toEqual([
      ['Kimi Antonelli', 0, false],
      ['Max Verstappen', 111, false],
      ['Franco Colapinto', 370, true],
    ]);
    // Nombres prolijos aunque la fuente publique el apellido en mayúsculas.
    expect(gapTable(table([['Agustín CANAPINO', 347]]), 1, { driverIds: [] }).rows[0]!.name).toBe('Agustín Canapino');
    // Equipos seguidos: se resaltan sus pilotos.
    expect(gapTable(t, 1, { driverIds: [], teamIds: ['mclaren'] }).rows.map((r) => r.name)).toEqual(['Kimi Antonelli', 'Lando Norris']);
  });

  const motogp = [ev('pt', 'motogp', '2026-11-20', 21), ev('va', 'motogp', '2026-11-27', 22)];
  const fmt = (id: string, day: string) => [
    ses(id, 'clasificacion', `${day}T11:15:00Z`, 15),
    ses(id, 'sprint', `${day}T15:00:00Z`, 30),
    ses(id, 'carrera', `${day.slice(0, 8)}${String(Number(day.slice(8)) + 1).padStart(2, '0')}T13:00:00Z`, 50),
  ];
  const sessions = [...fmt('pt', '2026-11-21'), ...fmt('va', '2026-11-28')];
  const standings = table([
    ['Marc Marquez', 431],
    ['Jorge Martin', 371],
    ['Marco Bezzecchi', 357],
    ['Alex Marquez', 300],
  ]);

  it('MotoGP: 37 puntos por fecha (sprint + carrera)', () => {
    expect(eventMaxPoints(POINTS_RULES.motogp!, motogp[0]!, sessions.filter((s) => s.eventId === 'pt'))).toBe(37);
    const m = titleMath('motogp', standings, motogp[0]!, [motogp[1]!], sessions, '2026-11-12T00:00:00Z')!;
    expect(m).toMatchObject({ thisEvent: 37, afterEvent: 37, clinched: false, canClinchHere: true });
    expect(m.contenders.map((r) => r.name)).toEqual(['Jorge Martin', 'Marco Bezzecchi']);
    // Martín está a 60: después de Portugal quedan 37, así que a Márquez le alcanza con no perder más de 22 con él.
    expect(m.needs.map((x) => [x.rival.name, x.margin])).toEqual([
      ['Jorge Martin', -22],
      ['Marco Bezzecchi', -36],
    ]);
    expect(marginText(-22, 'Jorge Martin')).toBe('no perder más de 22 puntos con Jorge Martin');
    expect(marginText(5, 'X')).toBe('sacarle 5 puntos o más a X');
    expect(marginText(0, 'X')).toBe('no perder puntos con X');
  });

  it('con la tabla de entre carreras solo cuenta lo que falta de la fecha', () => {
    const m = titleMath('motogp', standings, motogp[0]!, [motogp[1]!], sessions, '2026-11-21T18:00:00Z')!;
    expect(m.thisEvent).toBe(25);
  });

  it('F1 usa el formato publicado (con o sin sprint) y no inventa sin cronograma', () => {
    const f1 = [ev('lv', 'f1', '2026-11-19', 21), ev('qa', 'f1', '2026-11-27', 22), ev('ad', 'f1', '2026-12-04', 23)];
    const s = [ses('lv', 'carrera', '2026-11-22T04:00:00Z', 120), ses('qa', 'sprint', '2026-11-28T14:00:00Z'), ses('qa', 'carrera', '2026-11-29T16:00:00Z')];
    const t = table([
      ['Kimi Antonelli', 390],
      ['Max Verstappen', 330],
    ]);
    // Abu Dabi sin cronograma: F1 no tiene formato fijo.
    expect(titleMath('f1', t, f1[0]!, [f1[1]!, f1[2]!], s, '2026-11-12T00:00:00Z')).toBeNull();
    s.push(ses('ad', 'carrera', '2026-12-06T13:00:00Z', 120));
    const m = titleMath('f1', t, f1[0]!, [f1[1]!, f1[2]!], s, '2026-11-12T00:00:00Z')!;
    expect(m).toMatchObject({ thisEvent: 25, afterEvent: 58, canClinchHere: true });
    // 60 de ventaja y después de Las Vegas quedan 58: le alcanza con no perder más de 1 punto.
    expect(m.needs[0]!.margin).toBe(-1);
    // Última fecha: le alcanza con no perder más de 59 con el segundo.
    const last = titleMath('f1', t, f1[2]!, [], s, '2026-11-30T00:00:00Z')!;
    expect(last).toMatchObject({ thisEvent: 25, afterEvent: 0, canClinchHere: false, clinched: true });
  });

  it('F2 sin cronograma supone sprint + principal + pole', () => {
    expect(eventMaxPoints(POINTS_RULES.f2!, ev('q', 'f2', '2026-11-27', 13), [])).toBe(39);
  });

  it('sin puntaje configurado no hace cuentas', () => {
    expect(titleMath('tc', standings, motogp[0]!, [], sessions, NOW)).toBeNull();
    expect(titleMath('nascar-cup', standings, motogp[0]!, [], sessions, NOW)).toBeNull();
  });
});

describe('formato, resultados y a quién mirar', () => {
  it('resume las sesiones y la duración', () => {
    const s = [ses('e', 'practica', '2026-11-13T09:00:00Z'), ses('e', 'practica', '2026-11-13T12:00:00Z'), ses('e', 'clasificacion', '2026-11-13T15:00:00Z'), ses('e', 'carrera', '2026-11-14T12:00:00Z', 240)];
    expect(sessionCounts(s)).toBe('2 prácticas · 1 clasificación · 1 carrera');
    expect(durationText(240)).toBe('4 h');
    expect(durationText(90)).toBe('1 h 30 min');
    expect(durationText(40)).toBe('40 min');
  });

  it('cuenta autos y pilotos por clase de la lista de inscriptos', () => {
    const rows: RosterRow[] = [
      { driver: 'A Uno', team: 'T1', number: '3', class: 'LMP2' },
      { driver: 'B Dos', team: 'T1', number: '3', class: 'LMP2' },
      { driver: 'C Tres', team: 'T2', number: '7', class: 'GT' },
      { driver: 'D Cuatro', team: 'T2', number: '8', class: 'GT' },
    ];
    expect(rosterSummary(rows)).toEqual({
      cars: 3,
      drivers: 4,
      classes: [
        { name: 'LMP2', cars: 1, drivers: 2 },
        { name: 'GT', cars: 2, drivers: 2 },
      ],
    });
  });

  const sessions = [
    ses('e', 'practica', '2026-11-06T15:30:00Z'),
    ses('e', 'clasificacion', '2026-11-07T18:00:00Z'),
    ses('e', 'carrera', '2026-11-08T17:00:00Z', 120),
  ];
  const results: EventResultsFile = {
    seriesId: 'f1',
    eventId: 'e',
    updatedAt: NOW,
    sessions: sessions.map((s, i) => ({
      sessionId: s.id,
      rows: [{ pos: 1, driver: ['Max Verstappen', 'Kimi Antonelli', 'Lando Norris'][i]!, team: 'Equipo' }],
      source,
    })),
  };

  it('el primero de cada sesión: más rápido, pole y ganador', () => {
    expect(highlights(results, sessions).map((h) => [h.label, h.driver, h.driverId])).toEqual([
      ['Más rápido', 'Max Verstappen', 'max-verstappen'],
      ['Pole', 'Kimi Antonelli', 'antonelli-kimi'],
      ['Ganador', 'Lando Norris', 'lando-norris'],
    ]);
    expect(highlights(results, sessions, true)).toHaveLength(1);
  });

  it('a quién mirar: seguidos, líderes y ganadores, sin repetir', () => {
    const winners = highlights(results, sessions, true);
    const items = whoToWatch({
      followed: { driverIds: ['colapinto-franco'], teamIds: ['alpine'] },
      tables: [table([['Kimi Antonelli', 390, 'Mercedes'], ['Lando Norris', 300, 'McLaren'], ['Franco Colapinto', 20, 'Alpine']])],
      teamTables: [table([['Mercedes', 600], ['Alpine', 40]], 'Constructores')],
      winnersBefore: [...winners, { ...winners[0]!, driver: 'Kimi Antonelli', driverId: 'antonelli-kimi', sessionId: 'otro' }],
      previousName: 'São Paulo Grand Prix',
    });
    expect(items.map((i) => [i.kind, i.name, i.reason])).toEqual([
      ['piloto', 'Franco Colapinto', 'Lo seguís'],
      ['equipo', 'Alpine', 'Lo seguís'],
      ['piloto', 'Kimi Antonelli', 'Líder del campeonato'],
      ['piloto', 'Lando Norris', 'Ganó carrera en São Paulo Grand Prix'],
    ]);
  });
});

describe('equipos seguidos', () => {
  it('resalta al equipo y suma a sus pilotos (tabla o inscriptos)', () => {
    const items = whoToWatch({
      followed: { driverIds: [], teamIds: ['team-wrt'] },
      followedNames: new Map([['team-wrt', 'Team WRT']]),
      tables: [],
      roster: [
        { driver: 'Charles Weerts / Sheldon van der Linde', team: 'Team WRT #32', number: '32', class: 'GT' },
        { driver: 'Otro Piloto', team: 'Otro Equipo', number: '9' },
      ],
    });
    expect(items.map((i) => [i.kind, i.name, i.reason, i.followed])).toEqual([
      ['equipo', 'Team WRT', 'Lo seguís', true],
      ['piloto', 'Charles Weerts', 'Corre para Team WRT, que seguís', true],
      ['piloto', 'Sheldon van der Linde', 'Corre para Team WRT, que seguís', true],
    ]);
  });
});

describe('notas recientes', () => {
  const item = (id: string, title: string, publishedAt: string, seriesIds = ['f1']): NewsItem => ({
    id,
    title,
    url: `https://example.org/${id}`,
    source: 'Medio',
    sourceKind: 'medio',
    publishedAt,
    seriesIds,
  });
  const event = { ...ev('lv', 'f1', '2026-11-19', 21, 'Las Vegas Grand Prix'), circuit: 'Las Vegas Strip Circuit', country: 'Estados Unidos' };

  it('saca palabras útiles del evento y apellidos', () => {
    expect(eventNeedles(event)).toEqual(['vegas', 'estados', 'unidos']);
    expect(surnameNeedles(['Franco Colapinto', 'Alpine'])).toEqual(['colapinto', 'alpine']);
  });

  it('prefiere las que nombran el evento o a los seguidos, de la categoría y de la última semana', () => {
    const items = [
      item('a', 'Hamilton habla de su futuro', '2026-11-11T10:00:00Z'),
      item('b', 'Todo listo para Las Vegas', '2026-11-10T10:00:00Z'),
      item('c', 'Colapinto confirmado', '2026-11-09T10:00:00Z'),
      item('d', 'Las Vegas en MotoGP', '2026-11-11T10:00:00Z', ['motogp']),
      item('e', 'Vieja nota de Las Vegas', '2026-10-01T10:00:00Z'),
      item('f', 'Otra', '2026-11-11T11:00:00Z'),
    ];
    const got = pickNews(items, 'f1', '2026-11-12T00:00:00Z', { eventWords: eventNeedles(event), followedWords: ['colapinto'], limit: 3 });
    expect(got.map((x) => x.id)).toEqual(['b', 'c', 'f']);
  });

  it('para un evento viejo toma las notas de esa semana', () => {
    expect(newsReference(event, '2026-12-30T00:00:00Z')).toBe('2026-11-21T23:59:59.000Z');
    expect(newsReference(event, '2026-11-12T00:00:00Z')).toBe('2026-11-12T00:00:00.000Z');
  });
});

describe('pestaña Contexto', () => {
  let pinia: Pinia;
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
    useNewsStore().$patch({ status: 'ok', file: { version: 1, generatedAt: NOW, items: [] } });
    useSettingsStore().$patch({ followedDrivers: [{ id: 'agustin-canapino', name: 'Agustín Canapino', seriesIds: ['tc'] }] });
    const standings = fixture<StandingsFile>('standings/tc.json');
    const results = fixture<EventResultsFile>('results/tc/ev-tc-sannicolas.json');
    useResultsStore().$patch({
      standings: { tc: { status: 'ok', data: standings } },
      results: { 'tc/ev-tc-sannicolas': { status: 'ok', data: results } },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it('arma la ficha con el campeonato, el formato, a quién mirar y las fuentes', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/evento/ev-tc-sannicolas?tab=contexto');
    const wrapper = mount(EventView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.find('.underline-tab.active').text()).toBe('Contexto');
    const text = wrapper.text();
    expect(text).toContain('Qué se juega');
    expect(text).toContain('Tabla antes de la carrera');
    expect(text).toContain('Julián Santero');
    expect(text).toContain('−14,5');
    expect(text).toContain('A quién mirar');
    expect(text).toContain('Lo seguís');
    expect(text).toContain('Formato');
    expect(text).toContain('Fuentes');
    // TC no tiene cuentas del título (Copa de Oro): solo diferencias.
    expect(wrapper.find('.ctx-math').exists()).toBe(false);
  });
});
