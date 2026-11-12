import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Driver, MotorEvent, Series, SeriesStatus, StandingsFile, Team } from '@dm/shared';
import {
  driverSubtitle,
  editDistance,
  matchText,
  rankDrivers,
  rankSeries,
  searchDrivers,
  searchTeams,
  type SearchContext,
} from '../src/lib/search.ts';
import { displayName, followCount, starterPack, standingsLeader } from '../src/lib/onboarding.ts';
import { recommend } from '../src/lib/recommend.ts';
import { initialTableIndex, tableChipRows, tableFacet, useTableChips } from '../src/lib/standingsTables.ts';
import { friendlySourceError } from '../src/lib/sources.ts';
import { navState } from '../src/lib/navState.ts';
import { routes } from '../src/router.ts';
import SearchView from '../src/views/SearchView.vue';
import StandingsPanel from '../src/components/StandingsPanel.vue';
import SourceProblem from '../src/components/SourceProblem.vue';
import NotFoundCard from '../src/components/NotFoundCard.vue';
import { useDriversStore } from '../src/stores/drivers.ts';
import { useResultsStore } from '../src/stores/results.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { useSettingsStore } from '../src/stores/settings.ts';
import { NOW, scheduleFixture, statusFixture } from './helpers.ts';

const AR = 'America/Argentina/Buenos_Aires';
const d = (id: string, name: string, entries: Driver['entries'], lineups?: Driver['lineups']): Driver => ({ id, name, entries, lineups, recent: [] });

const DRIVERS: Driver[] = [
  d('max-verstappen', 'Max Verstappen', [{ seriesId: 'f1', pos: 2, points: 279, team: 'Red Bull Racing' }], [{ seriesId: 'f1', number: '3' }]),
  d('colapinto-franco', 'Franco Colapinto', [{ seriesId: 'f1', pos: 12, points: 27, team: 'Alpine' }], [{ seriesId: 'f1', team: 'Alpine', number: '43' }]),
  d('agustin-canapino', 'Agustín Canapino', [{ seriesId: 'tc', pos: 1, points: 347, number: '1' }]),
  d('canapino-matias', 'Matías Canapino', [{ seriesId: 'tc', pos: 40, points: 95, number: '32' }]),
  d('anton-benjamin', 'Benjamín Antón', [{ seriesId: 'tc-pista', pos: 3, points: 300, number: '43' }]),
  d('jack-miller', 'Jack Miller', [{ seriesId: 'motogp', pos: 19, points: 50, number: '43' }]),
  d('erik-jones', 'Erik Jones', [{ seriesId: 'nascar-cup', pos: 23, points: 600, number: '43' }]),
  d('georgios-kolovos', 'Georgios Kolovos', [], [{ seriesId: 'alms', number: '43', team: 'Inter Europol' }]),
  d('matias-rossi', 'Matías Rossi', [{ seriesId: 'tc2000', pos: 1, points: 180 }, { seriesId: 'tc', pos: 5, points: 300 }]),
  d('max-hesse', 'Max Hesse', [{ seriesId: 'gtwc-europe', pos: 7, points: 40 }]),
  d('maxime-martin', 'Maxime Martin', [{ seriesId: 'wec', pos: 30, points: 4 }]),
];
const CTX: SearchContext = { argentineSeries: ['tc', 'tc-pista', 'tc2000', 'tn'] };
const ids = (list: Driver[]) => list.map((x) => x.id);

describe('búsqueda con errores de tipeo', () => {
  it('distancia de Damerau-Levenshtein (con letras traspuestas y corte)', () => {
    expect(editDistance('verstapen', 'verstappen')).toBe(1);
    expect(editDistance('colapnto', 'colapinto')).toBe(1);
    expect(editDistance('canpaino', 'canapino')).toBe(1); // traspuestas
    expect(editDistance('abc', 'xyz', 1)).toBe(2); // pasa el máximo: corta
  });

  it('encuentra a Verstappen, Colapinto y Canapino aunque estén mal escritos, sin importar acentos ni mayúsculas', () => {
    expect(ids(searchDrivers(DRIVERS, 'verstapen', 5, CTX))).toEqual(['max-verstappen']);
    expect(ids(searchDrivers(DRIVERS, 'colapnto', 5, CTX))).toEqual(['colapinto-franco']);
    expect(ids(searchDrivers(DRIVERS, 'canapin', 5, CTX))).toEqual(['agustin-canapino', 'canapino-matias']);
    expect(ids(searchDrivers(DRIVERS, 'AGUSTIN canápino', 5, CTX))).toEqual(['agustin-canapino']);
    expect(ids(searchDrivers(DRIVERS, 'franco colapint', 5, CTX))).toEqual(['colapinto-franco']);
    // Palabras cortas: sin tolerancia (evita ruido).
    expect(searchDrivers(DRIVERS, 'maz', 5, CTX)).toEqual([]);
  });

  it('orden: exactas > prefijo > aproximadas; después lo principal y la mejor posición', () => {
    const hits = rankDrivers(DRIVERS, 'max', CTX);
    expect(hits.map((h) => [h.item.id, h.kind])).toEqual([
      ['max-verstappen', 'exact'], // F1: categoría principal
      ['max-hesse', 'exact'],
      ['maxime-martin', 'prefix'],
    ]);
    // Los dos Canapino coinciden exacto: primero el mejor ubicado del TC.
    expect(ids(searchDrivers(DRIVERS, 'canapino', 5, CTX))).toEqual(['agustin-canapino', 'canapino-matias']);
    // Lo seguido va primero.
    expect(ids(searchDrivers(DRIVERS, 'canapino', 5, { ...CTX, followedDrivers: ['canapino-matias'] }))).toEqual([
      'canapino-matias',
      'agustin-canapino',
    ]);
  });

  it('por número: primero las principales (F1 antes que MotoGP y NASCAR), después las argentinas y el resto', () => {
    expect(ids(searchDrivers(DRIVERS, '#43', 10, CTX))).toEqual([
      'colapinto-franco',
      'jack-miller',
      'erik-jones',
      'anton-benjamin',
      'georgios-kolovos',
    ]);
    expect(ids(searchDrivers(DRIVERS, '43', 10, CTX))[0]).toBe('colapinto-franco');
    // Una categoría seguida pasa adelante.
    expect(ids(searchDrivers(DRIVERS, '#43', 10, { ...CTX, followedSeries: ['tc-pista'] }))[0]).toBe('anton-benjamin');
    // Un dígito suelto es muy corto; con # sí.
    expect(searchDrivers(DRIVERS, '3', 10, CTX)).toEqual([]);
    expect(ids(searchDrivers(DRIVERS, '#3', 10, CTX))).toEqual(['max-verstappen']);
  });

  it('el subtítulo de una búsqueda por número muestra el número, la categoría y la posición', () => {
    const short = (id: string) => ({ f1: 'F1', alms: 'ALMS' })[id] ?? id;
    const [hit] = rankDrivers(DRIVERS, '#43', CTX);
    expect(driverSubtitle(hit!.item, short, hit!.number, hit!.numberSeries)).toBe('#43 · F1 · P12');
    const kolovos = DRIVERS.find((x) => x.id === 'georgios-kolovos')!;
    expect(driverSubtitle(kolovos, short, '43', 'alms')).toBe('#43 · ALMS');
    expect(driverSubtitle(DRIVERS[1]!, short)).toBe('F1 P12');
  });

  it('equipos y categorías también toleran errores', () => {
    const teams: Team[] = [
      { id: 'ferrari', name: 'Ferrari', entries: [{ seriesId: 'f1', pos: 3, numbers: ['16', '44'] }], drivers: [] },
      { id: 'team-wrt', name: 'Team WRT', entries: [{ seriesId: 'wec', numbers: ['31'] }], drivers: [] },
    ];
    expect(searchTeams(teams, 'ferari', 5, CTX).map((t) => t.id)).toEqual(['ferrari']);
    expect(searchTeams(teams, '#44', 5, CTX).map((t) => t.id)).toEqual(['ferrari']);
    const series = scheduleFixture().series.filter((s) => s.enabled);
    expect(rankSeries(series, 'motogo', CTX).map((h) => h.item.id)).toEqual(['motogp']);
    // "tc": TC primero (principal), después TC Pista.
    expect(rankSeries(series, 'tc', CTX).map((h) => h.item.id).slice(0, 2)).toEqual(['tc', 'tc-pista']);
  });

  it('matchText dice si la coincidencia es aproximada (para "¿Quisiste decir…?")', () => {
    expect(matchText('Max Verstappen', 'verstapen')).toEqual({ kind: 'fuzzy', dist: 1 });
    expect(matchText('Max Verstappen', 'verst')?.kind).toBe('prefix');
    expect(matchText('Max Verstappen', 'hamilton')).toBeNull();
  });

  it('es rápida con ~2.200 pilotos', () => {
    const many: Driver[] = [];
    for (let i = 0; i < 2200; i++) many.push(d(`p${i}`, `Piloto${i} Apellido${i % 97}`, [{ seriesId: 'gt', pos: i + 1, points: 0 }]));
    many.push(...DRIVERS);
    searchDrivers(many, 'verstapen', 10, CTX); // calienta las claves
    const t0 = performance.now();
    for (const q of ['verstapen', 'colapnto', 'canapin', '#43']) searchDrivers(many, q, 10, CTX);
    expect(performance.now() - t0).toBeLessThan(400);
  });
});

describe('"Empezá por acá"', () => {
  const standings = (seriesId: string, name: string): StandingsFile => ({
    seriesId,
    season: 2026,
    updatedAt: NOW,
    tables: [{ title: 'Pilotos', rows: [{ pos: 1, name, points: 300 }, { pos: 2, name: 'Otro Piloto', points: 200 }] }],
    source: { url: 'https://example.org', title: 't', kind: 'html', method: 'directo', fetchedAt: NOW },
  });
  const series = (): Series[] => {
    const list = scheduleFixture().series;
    const tc = list.find((s) => s.id === 'tc')!;
    return [...list, { ...tc, id: 'tc2000', name: 'TC2000', shortName: 'TC2000' }];
  };

  it('categorías argentinas y principales, Colapinto, Canapino y los líderes de TC y TC2000 (sin repetir)', () => {
    const items = starterPack({
      series: series(),
      standings: { tc: standings('tc', 'Agustín CANAPINO'), tc2000: standings('tc2000', 'Matias Rossi') },
      racingThisWeekend: ['tc'],
    });
    expect(items.filter((i) => i.kind === 'series').map((i) => i.id)).toEqual(['f1', 'tc', 'tc2000', 'motogp', 'tc-pista', 'turismo-nacional']);
    expect(items.find((i) => i.id === 'tc')!.reason).toContain('corre este finde');
    expect(items.filter((i) => i.kind === 'driver').map((i) => [i.id, i.title, i.reason])).toEqual([
      ['colapinto-franco', 'Franco Colapinto', 'Argentino en F1'],
      ['agustin-canapino', 'Agustín Canapino', 'Líder del TC'],
      ['matias-rossi', 'Matias Rossi', 'Líder del TC2000'],
    ]);
  });

  it('con el índice de pilotos cargado, solo sugiere los que figuran y usa sus categorías', () => {
    const drivers = new Map(DRIVERS.filter((x) => x.id !== 'colapinto-franco').map((x) => [x.id, x]));
    const items = starterPack({ series: series(), standings: { tc2000: standings('tc2000', 'Matias Rossi') }, drivers });
    const people = items.filter((i) => i.kind === 'driver');
    expect(people.map((i) => i.id)).toEqual(['agustin-canapino', 'matias-rossi']);
    expect(people[0]!.reason).toBe('Ídolo del automovilismo argentino'); // sin tabla del TC: no se sabe si lidera
    expect(people[1]!.title).toBe('Matías Rossi'); // nombre del índice
    expect(people[1]!.seriesIds).toEqual(['tc2000', 'tc']);
  });

  it('líder de la tabla: primera de pilotos, nombre legible', () => {
    expect(displayName('Agustín CANAPINO')).toBe('Agustín Canapino');
    expect(standingsLeader(standings('tc', 'Agustín CANAPINO'))).toEqual({ id: 'agustin-canapino', name: 'Agustín Canapino' });
    expect(standingsLeader(standings('x', 'A / B'))).toBeNull();
    expect(followCount({ followedSeries: ['tc'], followedDrivers: [{}], followedTeams: [] })).toBe(2);
  });

  it('se oculta al seguir 3 cosas', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/buscar');
    const wrapper = mount(SearchView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Empezá por acá');
    useSettingsStore().$patch({ followedSeries: ['f1', 'tc', 'motogp'] });
    await flushPromises();
    expect(wrapper.text()).not.toContain('Empezá por acá');
  });
});

describe('recomendaciones: prioridad para un fan argentino', () => {
  it('si corren el TC y categorías asiáticas, el TC va primero', () => {
    const schedule = scheduleFixture();
    const tcEvent = schedule.events.find((e) => e.seriesId === 'tc' && e.dateStart <= '2026-11-14' && e.dateEnd >= '2026-11-14')!;
    for (const [id, name] of [
      ['alms', 'Asian Le Mans Series'],
      ['super-taikyu', 'ENEOS Super Taikyu Series'],
    ] as const) {
      schedule.series.push({ ...schedule.series.find((s) => s.id === 'tc')!, id, name, shortName: name, group: 'asia' });
      schedule.events.push({ ...(tcEvent as MotorEvent), id: `ev-${id}`, seriesId: id });
    }
    const recs = recommend({ schedule, now: NOW, zone: AR, followedSeries: [], followedDrivers: [] });
    const order = recs.map((r) => r.id);
    expect(order).toContain('tc');
    expect(order.indexOf('tc')).toBeLessThan(order.indexOf('alms') < 0 ? Infinity : order.indexOf('alms'));
    expect(order.slice(0, 2)).toEqual(['motogp', 'tc']);
    // Lo que ya ofrece "Empezá por acá" no se repite.
    const rest = recommend({ schedule, now: NOW, zone: AR, followedSeries: [], followedDrivers: [], excludeSeries: ['motogp', 'tc', 'tc-pista'] });
    expect(rest.map((r) => r.id)).toEqual(['alms', 'super-taikyu', 'copa-truck']);
  });
});

const H24 = ['GT3', '992', 'GTX', 'GT4', 'TCE', 'TCX'];
const titles24 = ['Europa', 'Middle East Trophy'].flatMap((g) => ['Pilotos', 'Equipos'].flatMap((k) => H24.map((c) => `${k} ${c} (${g})`)));

describe('tablas con clases', () => {
  it('separa tipo, campeonato y clase del título', () => {
    expect(tableFacet('Pilotos GT3 (Middle East Trophy)')).toEqual({ kind: 'Pilotos', group: 'Middle East Trophy', cls: 'GT3' });
    expect(tableFacet('Clase ST-X')).toEqual({ kind: '', group: '', cls: 'ST-X' });
    expect(tableFacet('Clase 1').cls).toBe('Clase 1');
    expect(tableFacet('Equipos')).toEqual({ kind: 'Equipos', group: '', cls: '' });
  });

  it('pastillas solo con muchas tablas o con clases', () => {
    expect(titles24).toHaveLength(24);
    expect(useTableChips(titles24)).toBe(true);
    expect(useTableChips(['Pilotos GT500', 'Pilotos GT300', 'Equipos GT500', 'Equipos GT300'])).toBe(true);
    expect(useTableChips(['Clase 1', 'Clase 2', 'Clase 3'])).toBe(true);
    expect(useTableChips(['Pilotos', 'Equipos', 'Constructores'])).toBe(false);
    expect(useTableChips(['Pilotos', 'Constructores'])).toBe(false);
  });

  it('filas: tipo, campeonato y clase; cambiar una conserva las demás', () => {
    const first = initialTableIndex(titles24);
    expect(titles24[first]).toBe('Pilotos GT3 (Europa)');
    const rows = tableChipRows(titles24, first);
    expect(rows.map((r) => [r.key, r.options.map((o) => o.label)])).toEqual([
      ['kind', ['Pilotos', 'Equipos']],
      ['group', ['Europa', 'Middle East Trophy']],
      ['cls', H24],
    ]);
    // De "Pilotos GT3 (Europa)" a Middle East Trophy: sigue en Pilotos GT3.
    const met = rows[1]!.options[1]!;
    expect(titles24[met.index]).toBe('Pilotos GT3 (Middle East Trophy)');
    const gt4 = tableChipRows(titles24, met.index)[2]!.options.find((o) => o.label === 'GT4')!;
    expect(titles24[gt4.index]).toBe('Pilotos GT4 (Middle East Trophy)');
    expect(initialTableIndex(titles24, 'Equipos TCX (Europa)')).toBe(titles24.indexOf('Equipos TCX (Europa)'));
    // GTWC Europe: tipo y copa ("General" sin nombre).
    const gtwc = ['Equipos', 'Pilotos', 'Equipos Endurance Cup', 'Pilotos Endurance Cup', 'Equipos Sprint Cup', 'Pilotos Sprint Cup'];
    const g = tableChipRows(gtwc, initialTableIndex(gtwc));
    expect(g.map((r) => r.options.map((o) => o.label))).toEqual([['Pilotos', 'Equipos'], ['General', 'Endurance Cup', 'Sprint Cup']]);
  });

  it('el panel muestra una tabla por vez y la elegida queda en el link', async () => {
    const pinia = createPinia();
    setActivePinia(pinia);
    useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
    const file: StandingsFile = {
      seriesId: '24h-series',
      season: 2026,
      updatedAt: NOW,
      tables: titles24.map((title) => ({ title, rows: [{ pos: 1, name: `Líder ${title}`, points: 10 }] })),
      source: { url: 'https://example.org', title: 't', kind: 'html', method: 'directo', fetchedAt: NOW },
    };
    useResultsStore().$patch({ standings: { '24h-series': { status: 'ok', data: file } } });
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/categoria/24h-series?tab=tabla');
    const series = { ...scheduleFixture().series[0]!, id: '24h-series', name: '24H Series', shortName: '24H Series' };
    const wrapper = mount(StandingsPanel, { props: { series }, global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.findAll('.standings-table')).toHaveLength(1);
    expect(wrapper.get('.standings-table h3').text()).toBe('Pilotos GT3 (Europa)');
    expect(wrapper.findAll('.standings-chips')).toHaveLength(3);
    const tcx = wrapper.findAll('.standings-chips')[2]!.findAll('button').find((b) => b.text() === 'TCX')!;
    await tcx.trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.tabla).toBe('Pilotos TCX (Europa)');
    expect(wrapper.get('.standings-table h3').text()).toBe('Pilotos TCX (Europa)');
  });
});

describe('errores de fuente y fichas inexistentes', () => {
  let pinia: Pinia;
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
  });

  it('el error técnico se explica y queda en "Detalles"', () => {
    expect(friendlySourceError('HTTP 403 en https://www.imsa.com/weathertech/schedule/')).toContain('no deja leer');
    expect(friendlySourceError('La página del calendario respondió 503.')).toContain('tuvo un error');
    const status: SeriesStatus = {
      seriesId: 'imsa',
      state: 'error',
      lastAttempt: NOW,
      message: 'HTTP 403 en https://www.imsa.com/weathertech/schedule/',
      sourceUrl: 'https://www.imsa.com/weathertech/schedule/',
      standingsAvailable: false,
    };
    const full = mount(SourceProblem, { props: { status }, global: { plugins: [pinia] } });
    expect(full.text()).toContain('No pudimos leer el calendario oficial (todavía no se pudo leer)');
    expect(full.get('details summary').text()).toBe('Detalles');
    expect(full.get('details').text()).toContain('HTTP 403');
    expect(full.get('a').attributes('href')).toBe('https://www.imsa.com/weathertech/schedule/');
    const note = mount(SourceProblem, { props: { status: { ...status, lastSuccess: '2026-11-11T15:30:00Z' }, hasEvents: true }, global: { plugins: [pinia] } });
    expect(note.text()).toContain('Datos de hace 3 días');
    const ok = mount(SourceProblem, { props: { status: { ...status, state: 'ok' } }, global: { plugins: [pinia] } });
    expect(ok.html()).not.toContain('source-problem');
  });

  it('piloto inexistente: botones, nombres parecidos y ninguna pestaña marcada', async () => {
    useDriversStore().$patch({ status: 'ok', file: { version: 1, generatedAt: NOW, drivers: DRIVERS } });
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/piloto/colapnto-franco');
    const wrapper = mount(NotFoundCard, { props: { kind: 'piloto', slug: 'colapnto-franco' }, global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(navState.notFound).toBe(true);
    expect(wrapper.findAll('.not-found-actions a').map((a) => a.text())).toEqual(['Buscar piloto', 'Ir a la agenda']);
    expect(wrapper.findAll('.list-row').map((a) => a.attributes('href'))).toEqual(['/piloto/colapinto-franco']);
    wrapper.unmount();
    expect(navState.notFound).toBe(false);
  });
});

describe('pantalla Buscar', () => {
  async function searchFor(q: string) {
    const pinia = createPinia();
    setActivePinia(pinia);
    useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
    useDriversStore().$patch({ status: 'ok', file: { version: 1, generatedAt: NOW, drivers: DRIVERS } });
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push({ path: '/buscar', query: { q } });
    const wrapper = mount(SearchView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return wrapper;
  }

  it('sin coincidencias exactas propone "¿Quisiste decir…?" y al tocarlo busca eso', async () => {
    const wrapper = await searchFor('verstapen');
    expect(wrapper.get('.did-you-mean').text()).toBe('¿Quisiste decir Max Verstappen?');
    await wrapper.get('.did-you-mean button').trigger('click');
    await flushPromises();
    expect(wrapper.find('.did-you-mean').exists()).toBe(false);
    expect((await searchFor('canapino')).find('.did-you-mean').exists()).toBe(false);
  });

  it('"#43": Colapinto primero, con el número en el subtítulo de una línea', async () => {
    const wrapper = await searchFor('#43');
    const first = wrapper.findAll('a.list-row')[0]!;
    expect(first.text()).toContain('Franco Colapinto');
    expect(first.get('.one-line').text()).toBe('#43 · F1 · P12');
  });
});
