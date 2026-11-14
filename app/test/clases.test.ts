import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import {
  eventResultsFileSchema,
  driverShardPath,
  type DriverDetail,
  type DriversIndexFile,
  type EventResultsFile,
  type MotorEvent,
  type ScheduleFile,
  type Series,
  type Session,
  type SessionType,
} from '@dm/shared';
import EventResults from '../src/components/EventResults.vue';
import DriverView from '../src/views/DriverView.vue';
import { routes } from '../src/router.ts';
import { useDriversStore } from '../src/stores/drivers.ts';
import { useResultsStore } from '../src/stores/results.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import {
  classPodium,
  classPosOf,
  classRows,
  classWinners,
  crewMembers,
  driverClassResult,
  hasClasses,
  resultClasses,
} from '../src/lib/classes.ts';
import { highlights } from '../src/lib/context.ts';
import { podiumLine } from '../src/lib/podium.ts';
import { finishedWithoutResults, officialResultsUrl } from '../src/lib/resultsInfo.ts';
import { fixture, scheduleFixture, statusFixture } from './helpers.ts';

/**
 * Resultados con clases (Asian Le Mans Series): tripulaciones, puesto en la clase publicado o calculado, selector de
 * clase, podio por clase y sesiones terminadas sin resultado en la app. Los resultados del fixture son de prueba
 * (formato real del contrato, filas armadas para cubrir los casos).
 */

let pinia: Pinia;
const EVENT = 'ev-alms-castellet';
const RACE = 'alms0000000race1';
const QUALI = 'alms000000quali1';
const PRACTICE = 'alms00000practi1';
/** Domingo a la noche: la carrera, la clasificación y la práctica ya terminaron. */
const AFTER = '2026-11-14T20:00:00Z';

const results = (): EventResultsFile => fixture<EventResultsFile>('results/alms/ev-alms-castellet.json');
const rows = () => results().sessions[0]!.rows;

const source = { url: 'https://www.asianlemansseries.com/en/season/2026', title: 'ALMS', kind: 'html', method: 'directo', fetchedAt: '2026-11-10T00:00:00Z' } as const;

function session(id: string, type: SessionType, name: string, startUtc: string, endUtc: string, hasResults: boolean): Session {
  return { id, eventId: EVENT, seriesId: 'alms', type, name, startUtc, endUtc, endEstimated: false, broadcast: [], broadcastIsDefault: false, source, hasResults };
}

/** La agenda de prueba más la fecha de Le Castellet de la Asian Le Mans Series. */
function almsSchedule(opts: { raceHasResults?: boolean } = {}): ScheduleFile {
  const schedule = scheduleFixture();
  const alms: Series = {
    ...schedule.series[0]!,
    id: 'alms',
    name: 'Asian Le Mans Series',
    shortName: 'ALMS',
    group: 'gt-endurance',
    officialUrls: ['https://www.asianlemansseries.com/en/season/2026', 'https://www.asianlemansseries.com/en/page/classification?standings'],
    strategy: 'generic',
    color: '#c8102e',
  };
  delete (alms as Partial<Series>).adapter;
  const event: MotorEvent = {
    ...schedule.events[0]!,
    id: EVENT,
    seriesId: 'alms',
    name: '4 Hours of Le Castellet',
    circuit: 'Paul Ricard',
    country: 'Francia',
    tz: 'Europe/Paris',
    dateStart: '2026-11-13',
    dateEnd: '2026-11-15',
  };
  delete (event as Partial<MotorEvent>).round;
  schedule.series.push(alms);
  schedule.events.push(event);
  schedule.sessions.push(
    session(PRACTICE, 'practica', 'Práctica libre 1', '2026-11-13T09:10:00Z', '2026-11-13T10:40:00Z', false),
    session(QUALI, 'clasificacion', 'Clasificación 1 - Hypercar & LMP2', '2026-11-13T15:50:00Z', '2026-11-13T16:05:00Z', false),
    session(RACE, 'carrera', 'Carrera 1', '2026-11-14T12:15:00Z', '2026-11-14T16:15:00Z', opts.raceHasResults ?? true),
    session('alms0000000race2', 'carrera', 'Carrera 2', '2026-11-15T12:15:00Z', '2026-11-15T16:15:00Z', false),
  );
  return schedule;
}

async function mountResults(opts: { withFile?: boolean; index?: DriversIndexFile | 'missing'; session?: string } = {}) {
  const schedule = almsSchedule({ raceHasResults: opts.withFile ?? true });
  useScheduleStore().$patch({ schedule, status: statusFixture(), now: AFTER });
  if (opts.withFile ?? true) useResultsStore().results[`alms/${EVENT}`] = { status: 'ok', data: results() };
  if (opts.index === 'missing') useDriversStore().$patch({ status: 'missing' });
  else if (opts.index) useDriversStore().$patch({ file: opts.index, status: 'ok' });
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(`/evento/${EVENT}?tab=resultados`);
  const event = schedule.events.find((e) => e.id === EVENT)!;
  const wrapper = mount(EventResults, {
    props: { event, ...(opts.session ? { focusSession: opts.session } : {}) },
    global: { plugins: [pinia, router] },
  });
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  // Ningún archivo de datos real: lo que no esté en el store da 404.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 404 })));
});
afterEach(() => vi.unstubAllGlobals());

describe('lógica de clases', () => {
  it('el fixture cumple el esquema (class y classPos)', () => {
    expect(eventResultsFileSchema.safeParse(results()).success).toBe(true);
  });

  it('clases en el orden en que aparecen en la general', () => {
    expect(resultClasses(rows())).toEqual(['Hypercar', 'LMP2', 'GT3']);
    expect(hasClasses(rows())).toBe(true);
    // Una sola clase (o ninguna) no es "con clases".
    expect(hasClasses(rows().filter((r) => r.class === 'LMP2'))).toBe(false);
    expect(hasClasses([{ pos: 1, driver: 'Max Verstappen' }])).toBe(false);
  });

  it('puesto en la clase: el publicado o, si falta, el que sale de la general; los que no clasificaron, sin puesto', () => {
    const lmp2 = classRows(rows(), 'LMP2');
    expect(lmp2.map((r) => [r.number, r.pos, r.classPos])).toEqual([
      ['22', 2, 1],
      ['25', 4, 2],
      ['30', 5, 3],
    ]);
    const gt3 = classRows(rows(), 'GT3');
    expect(gt3.map((r) => r.classPos)).toEqual([1, 2, 3]);
    const hyper = classRows(rows(), 'Hypercar');
    expect(hyper.map((r) => [r.number, r.classPos])).toEqual([
      ['1', 1],
      ['7', 2],
      ['50', undefined],
    ]);
    const all = rows();
    expect(classPosOf(all, all[4]!)).toBe(3);
    expect(classPosOf(all, all[8]!)).toBeUndefined();
  });

  it('podio y ganador de cada clase', () => {
    expect(classPodium(rows(), 'LMP2').map((r) => r.number)).toEqual(['22', '25', '30']);
    expect(classPodium(rows(), 'Hypercar').map((r) => r.number)).toEqual(['1', '7']);
    expect(classWinners(rows()).map((w) => [w.class, w.row.number])).toEqual([
      ['Hypercar', '1'],
      ['LMP2', '22'],
      ['GT3', '91'],
    ]);
  });

  it('tripulaciones: cada integrante con su id; un piloto solo, entero', () => {
    expect(crewMembers('Kevin Estre / Laurens Vanthoor / Matt Campbell')).toEqual([
      { name: 'Kevin Estre', id: 'estre-kevin' },
      { name: 'Laurens Vanthoor', id: 'laurens-vanthoor' },
      { name: 'Matt Campbell', id: 'campbell-matt' },
    ]);
    expect(crewMembers('Canapino, Agustin')).toEqual([{ name: 'Canapino, Agustin', id: 'agustin-canapino' }]);
  });

  it('clase y puesto en la clase de un piloto de una tripulación (ficha del piloto)', () => {
    expect(driverClassResult(rows(), 'agustin-canapino', 'alms')).toEqual({ class: 'LMP2', classPos: 3, pos: 5 });
    expect(driverClassResult(rows(), 'nadie', 'alms')).toBeNull();
    // Sin clases no hay nada que agregar.
    expect(driverClassResult([{ pos: 1, driver: 'Agustín Canapino' }], 'agustin-canapino')).toBeNull();
  });

  it('podio en una línea: el ganador de cada clase', () => {
    expect(podiumLine(rows())).toBe('Hypercar: Estre/Vanthoor/Campbell · LMP2: Jarvis/Garg/Siegel · GT3: Lietz/Schuring/Shahin');
    // Sin clases, como siempre.
    expect(podiumLine([{ pos: 1, driver: 'Kimi Antonelli' }, { pos: 2, driver: 'George Russell' }])).toBe('1. Antonelli · 2. Russell');
  });

  it('Contexto: en una carrera con clases, un ganador por clase', () => {
    const schedule = almsSchedule();
    const sessions = schedule.sessions.filter((s) => s.eventId === EVENT);
    const h = highlights(results(), sessions);
    expect(h.map((x) => [x.label, x.class, x.driverId])).toEqual([
      ['Ganador', 'Hypercar', ''],
      ['Ganador', 'LMP2', ''],
      ['Ganador', 'GT3', ''],
    ]);
  });
});

describe('sesiones terminadas sin resultado', () => {
  it('las que ya terminaron y no tienen filas; las que no terminaron, no', () => {
    const sessions = almsSchedule().sessions.filter((s) => s.eventId === EVENT);
    expect(finishedWithoutResults(sessions, results(), AFTER).map((s) => s.id)).toEqual([PRACTICE, QUALI]);
    // Sin archivo, manda la marca del calendario.
    expect(finishedWithoutResults(sessions, undefined, AFTER).map((s) => s.id)).toEqual([PRACTICE, QUALI]);
    // Archivo no publicado: también la carrera.
    expect(finishedWithoutResults(sessions, { sessions: [] }, AFTER).map((s) => s.id)).toEqual([PRACTICE, QUALI, RACE]);
    expect(finishedWithoutResults(sessions, results(), '2026-11-13T12:00:00Z').map((s) => s.id)).toEqual([PRACTICE]);
  });

  it('enlace oficial: la página de resultados si la hay, nunca la de campeonato', () => {
    expect(officialResultsUrl({ officialUrls: ['https://racing.porsche.com/series/mobil-1-supercup', 'https://racing.porsche.com/mobil-1-supercup/results-season-2026'] })).toBe(
      'https://racing.porsche.com/mobil-1-supercup/results-season-2026',
    );
    expect(officialResultsUrl({ officialUrls: ['https://www.fiawec.com/en/season/2026', 'https://www.fiawec.com/en/page/manufacturers-classification?standings'] })).toBe(
      'https://www.fiawec.com/en/season/2026',
    );
    expect(officialResultsUrl({ officialUrls: ['https://actc.org.ar/tc/calendario', 'https://actc.org.ar/tc/campeonato'] })).toBe('https://actc.org.ar/tc/calendario');
    expect(officialResultsUrl(undefined)).toBe('');
  });
});

describe('Resultados del evento con clases', () => {
  const index: DriversIndexFile = {
    version: 1,
    generatedAt: AFTER,
    drivers: [{ id: 'agustin-canapino', name: 'Agustín Canapino', entries: [{ seriesId: 'tc', pos: 1, points: 300 }] }],
  };

  it('selector General + clases, chip de clase en cada fila y ganadores por clase', async () => {
    const wrapper = await mountResults({ index });
    const classChips = wrapper.findAll('.class-chips .pill');
    expect(classChips.map((c) => c.text())).toEqual(['General', 'Hypercar', 'LMP2', 'GT3']);
    expect(wrapper.get('.class-chips .pill.active').text()).toBe('General');
    const firstRow = wrapper.findAll('table.results tbody tr')[0]!;
    expect(firstRow.get('.class-chip').text()).toBe('Hypercar');
    expect(wrapper.findAll('table.results tbody tr')).toHaveLength(9);
    // Podio de la general y, debajo, el ganador de cada clase.
    expect(wrapper.findAll('.podium-step .podium-pos').map((p) => p.text())).toEqual(['2', '1', '3']);
    expect(wrapper.findAll('.class-winner').map((w) => w.text())).toEqual([
      expect.stringContaining('Hypercar'),
      expect.stringContaining('LMP2Jarvis / Garg / Siegel · United Autosports'),
      expect.stringContaining('GT3'),
    ]);
  });

  it('al elegir una clase: tabla con el puesto en la clase y en la general, y podio de la clase', async () => {
    const wrapper = await mountResults({ index });
    await wrapper.findAll('.class-chips .pill').find((c) => c.text() === 'LMP2')!.trigger('click');
    const trs = wrapper.findAll('table.results tbody tr');
    expect(trs).toHaveLength(3);
    expect(trs.map((tr) => tr.findAll('td').slice(0, 1).map((td) => td.text())[0])).toEqual(['1', '2', '3']);
    expect(wrapper.findAll('table.results thead th').map((th) => th.text())).toContain('Gral.');
    expect(trs[2]!.findAll('td')[2]!.text()).toBe('5');
    // Sin chip de clase en las filas: ya está filtrada.
    expect(wrapper.find('table.results .class-chip').exists()).toBe(false);
    expect(wrapper.get('.podium-title').text()).toBe('Podio · Carrera 1 · LMP2');
    expect(wrapper.findAll('.podium-step').map((s) => s.find('.podium-pos').text())).toEqual(['2', '1', '3']);
    expect(wrapper.findAll('.podium-step')[1]!.text()).toContain('Jarvis/Garg/Siegel');
    // "Al Harthy": la partícula va con el apellido.
    expect(wrapper.findAll('.podium-step')[0]!.text()).toContain('Al Harthy/Caygill/Masson');
  });

  it('tripulaciones: cada piloto enlazado por separado, solo si está en la app', async () => {
    const wrapper = await mountResults({ index });
    const crew = wrapper.findAll('table.results tbody tr')[4]!;
    const links = crew.findAll('a.crew-member');
    expect(links.map((a) => [a.text(), a.attributes('href')])).toEqual([['Agustín Canapino', '/piloto/agustin-canapino']]);
    expect(crew.get('.crew-names').text()).toBe('Matías Pérez Companc / Ricardo Juncos / Agustín Canapino');
    // La fila de una tripulación no es un link entero.
    expect(crew.classes()).not.toContain('linked');
  });

  it('sin índice de pilotos publicado, los integrantes se enlazan igual', async () => {
    const wrapper = await mountResults({ index: 'missing' });
    expect(wrapper.findAll('table.results tbody tr')[0]!.findAll('a.crew-member')).toHaveLength(3);
  });

  it('sesión terminada sin resultado: chip propio y aviso con el enlace oficial', async () => {
    const wrapper = await mountResults({ index });
    const chips = wrapper.findAll('.session-chips:not(.class-chips) .pill');
    expect(chips.map((c) => [c.text(), c.classes().includes('unavailable')])).toEqual([
      ['Carrera 1', false],
      ['Práctica libre 1', true],
      ['Clasificación 1 - Hypercar & LMP2', true],
    ]);
    await chips[2]!.trigger('click');
    const notice = wrapper.get('.results-unavailable');
    expect(notice.text()).toContain('Resultado todavía no disponible en la app');
    expect(notice.get('a').attributes('href')).toBe('https://www.asianlemansseries.com/en/season/2026');
    expect(notice.get('a').text()).toContain('asianlemansseries.com');
    expect(wrapper.find('table.results').exists()).toBe(false);
  });

  it('sin ningún resultado pero con sesiones terminadas: no dice "todavía no hay resultados", muestra cada sesión', async () => {
    const wrapper = await mountResults({ withFile: false });
    expect(wrapper.text()).not.toContain('Todavía no hay resultados de este evento');
    expect(wrapper.findAll('.session-chips .pill.unavailable').map((c) => c.text())).toEqual([
      'Carrera 1',
      'Práctica libre 1',
      'Clasificación 1 - Hypercar & LMP2',
    ]);
    // Por defecto, la última que terminó.
    expect(wrapper.get('.results-unavailable h3').text()).toBe('Carrera 1');
  });
});

describe('ficha del piloto en una categoría con clases', () => {
  it('últimas carreras: el puesto en la clase, con la clase y el puesto en la general', async () => {
    const detail: DriverDetail = {
      id: 'agustin-canapino',
      name: 'Agustín Canapino',
      entries: [],
      lineups: [{ seriesId: 'alms', team: 'Juncos Racing', number: '30', class: 'LMP2' }],
      recent: [{ seriesId: 'alms', eventId: EVENT, sessionId: RACE, startUtc: '2026-11-14T12:15:00Z', pos: 5 }],
      stats: [{ seriesId: 'alms', races: 1, wins: 0, podiums: 0, top5: 1, top10: 1, dnfs: 0, bestPos: 5, overall: true }],
    };
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        const rel = String(input).replace(/^.*\/data\//, '');
        requested.push(rel);
        if (rel === driverShardPath('agustin-canapino')) {
          return new Response(JSON.stringify({ version: 1, drivers: [detail] }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (rel === `results/alms/${EVENT}.json`) {
          return new Response(JSON.stringify(results()), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('no', { status: 404 });
      }),
    );
    useScheduleStore().$patch({ schedule: almsSchedule(), status: statusFixture(), now: AFTER });
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/piloto/agustin-canapino');
    const wrapper = mount(DriverView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    await flushPromises();
    expect(requested).toContain(`results/alms/${EVENT}.json`);
    const recent = wrapper.get(`a.list-row[href="/evento/${EVENT}?tab=resultados&session=${RACE}"]`);
    expect(recent.get('.pos-badge').text()).toBe('P3');
    expect(recent.get('.class-chip').text()).toBe('LMP2');
    expect(recent.text()).toContain('LMP2 P5 en la general');
  });
});
