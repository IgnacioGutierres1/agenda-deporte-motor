import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Driver, DriversIndexFile, NewsItem, RosterFile, StandingsFile, TeamsFile } from '@dm/shared';
import CircuitView from '../src/views/CircuitView.vue';
import DriverView from '../src/views/DriverView.vue';
import EventView from '../src/views/EventView.vue';
import SearchView from '../src/views/SearchView.vue';
import TeamView from '../src/views/TeamView.vue';
import RosterPanel from '../src/components/RosterPanel.vue';
import { routes } from '../src/router.ts';
import { refreshEverything } from '../src/lib/refresh.ts';
import { searchDrivers, searchTeams } from '../src/lib/search.ts';
import { deriveTeams, newsForTeam, teamNeedles } from '../src/lib/teams.ts';
import { useDriversStore } from '../src/stores/drivers.ts';
import { useNewsStore } from '../src/stores/news.ts';
import { useResultsStore } from '../src/stores/results.ts';
import { useRostersStore } from '../src/stores/rosters.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { useTeamsStore } from '../src/stores/teams.ts';
import { fixture, NOW, scheduleFixture, statusFixture } from './helpers.ts';

let pinia: Pinia;
const makeRouter = () => createRouter({ history: createMemoryHistory(), routes });
const source = { url: 'https://example.org/inscriptos', title: 'Inscriptos', kind: 'html' as const, method: 'directo' as const, fetchedAt: NOW };

const drivers: Driver[] = [
  {
    id: 'agustin-canapino',
    name: 'Agustín Canapino',
    entries: [{ seriesId: 'turismo-nacional', table: 'Clase 3', pos: 1, points: 320, number: '86', team: 'Salvita Racing' }],
    recent: [],
  },
  {
    id: 'rossi-valentino',
    name: 'Valentino Rossi',
    country: 'Italy',
    entries: [],
    lineups: [{ seriesId: 'f2', team: 'Team WRT', number: '46', vehicle: 'BMW M4 GT3', class: 'Pro' }],
    recent: [],
  },
  {
    id: 'augusto-farfus',
    name: 'Augusto Farfus',
    entries: [],
    lineups: [{ seriesId: 'f2', team: 'TEAM WRT', number: '46', class: 'Pro' }],
    recent: [],
  },
];
const driversFile: DriversIndexFile = { version: 1, generatedAt: NOW, drivers };

const teamsFile: TeamsFile = {
  version: 1,
  generatedAt: NOW,
  teams: [
    {
      id: 'team-wrt',
      name: 'Team WRT',
      entries: [{ seriesId: 'f2', table: 'Equipos', pos: 2, points: 150, numbers: ['46'], vehicles: ['BMW M4 GT3'], classes: ['Pro'] }],
      drivers: [
        { id: 'rossi-valentino', name: 'Valentino Rossi', seriesId: 'f2', number: '46' },
        { id: 'augusto-farfus', name: 'Augusto Farfus', seriesId: 'f2', number: '46' },
      ],
    },
  ],
};

const news = (id: string, title: string, seriesIds: string[]): NewsItem => ({
  id,
  title,
  url: `https://example.org/${id}`,
  source: 'X',
  sourceKind: 'medio',
  publishedAt: NOW,
  seriesIds,
});

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const notFound = () => new Response('no', { status: 404 });

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
});
afterEach(() => vi.unstubAllGlobals());

describe('equipos: lógica pura', () => {
  it('sin teams.json arma los equipos con los pilotos (tablas e inscripciones)', () => {
    const teams = deriveTeams(drivers);
    expect(teams.map((t) => t.id).sort()).toEqual(['salvita-racing', 'team-wrt']);
    const wrt = teams.find((t) => t.id === 'team-wrt')!;
    expect(wrt.entries).toEqual([{ seriesId: 'f2', numbers: ['46'], vehicles: ['BMW M4 GT3'], classes: ['Pro'] }]);
    expect(wrt.drivers.map((d) => d.id)).toEqual(['rossi-valentino', 'augusto-farfus']);
  });

  it('noticias del equipo: lo nombran en el título y son de sus categorías', () => {
    const team = teamsFile.teams[0]!;
    expect(teamNeedles('Team WRT')).toEqual(['team wrt', 'wrt']);
    expect(teamNeedles('Scuderia Ferrari HP', ['Ferrari AF Corse'])).not.toContain('ferrari');
    expect(teamNeedles('Scuderia Ferrari HP', ['McLaren'])).toContain('ferrari');
    const items = [
      news('a', 'WRT gana en Lusail', ['f2']),
      news('b', 'WRT gana en Daytona', ['nascar-cup']),
      news('c', 'Newgarden firma con Penske', ['f2']),
      news('d', 'Cowrtz no es WRT-algo', ['f2']),
    ];
    expect(newsForTeam(items, team).map((n) => n.id)).toEqual(['a', 'd']);
  });

  it('búsqueda: pilotos solo inscriptos, por número de auto, y equipos', () => {
    expect(searchDrivers(drivers, 'rossi').map((d) => d.id)).toEqual(['rossi-valentino']);
    expect(searchDrivers(drivers, '#46').map((d) => d.id)).toEqual(['augusto-farfus', 'rossi-valentino']);
    expect(searchDrivers(drivers, '86').map((d) => d.id)).toEqual(['agustin-canapino']);
    expect(searchTeams(teamsFile.teams, 'wrt').map((t) => t.id)).toEqual(['team-wrt']);
    expect(searchTeams(teamsFile.teams, '#46').map((t) => t.id)).toEqual(['team-wrt']);
  });
});

describe('equipos: pantallas', () => {
  it('sin teams.json (404) el store queda "missing" y usa los equipos de drivers.json', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (String(url).includes('drivers.json') ? json(driversFile) : notFound())),
    );
    const store = useTeamsStore();
    await store.load();
    await flushPromises();
    expect(store.status).toBe('missing');
    expect(store.derived).toBe(true);
    expect(store.byId.get('salvita-racing')?.drivers[0]?.id).toBe('agustin-canapino');

    const router = makeRouter();
    await router.push('/equipo/salvita-racing');
    const wrapper = mount(TeamView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.find('.hero-title').text()).toBe('Salvita Racing');
    expect(wrapper.text()).toContain('todavía no hay índice de equipos');
    expect(wrapper.find('a[href="/piloto/agustin-canapino"]').exists()).toBe(true);
  });

  it('ficha del equipo: categorías con posición, números, autos, pilotos y noticias', async () => {
    useTeamsStore().$patch({ file: teamsFile, status: 'ok' });
    useDriversStore().$patch({ file: driversFile, status: 'ok' });
    useNewsStore().$patch({ status: 'ok', file: { version: 1, generatedAt: NOW, items: [news('a', 'WRT gana en Lusail', ['f2'])] } });
    const router = makeRouter();
    await router.push('/equipo/team-wrt');
    const wrapper = mount(TeamView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain('P2');
    expect(text).toContain('150 pts');
    expect(text).toContain('#46');
    expect(text).toContain('BMW M4 GT3');
    expect(text).toContain('Valentino Rossi');
    expect(text).toContain('Ronda 13 – Lusail'); // próxima carrera de F2
    expect(text).toContain('WRT gana en Lusail');
  });

  it('piloto solo inscripto: país, "Inscripto en" y link al equipo', async () => {
    useDriversStore().$patch({ file: driversFile, status: 'ok' });
    const router = makeRouter();
    await router.push('/piloto/rossi-valentino');
    const wrapper = mount(DriverView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    const text = wrapper.text();
    expect(text).toContain('🇮🇹 Italia');
    expect(text).toContain('Inscripto en');
    expect(text).not.toContain('Campeonato');
    expect(text).toContain('BMW M4 GT3');
    expect(wrapper.find('a[href="/equipo/team-wrt"]').exists()).toBe(true);
    expect(text).toContain('Ronda 13 – Lusail');
  });

  it('buscar muestra equipos y encuentra pilotos inscriptos', async () => {
    useTeamsStore().$patch({ file: teamsFile, status: 'ok' });
    useDriversStore().$patch({ file: driversFile, status: 'ok' });
    useNewsStore().$patch({ status: 'ok', file: { version: 1, generatedAt: NOW, items: [] } });
    const router = makeRouter();
    await router.push({ path: '/buscar', query: { q: 'wrt' } });
    const wrapper = mount(SearchView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.findAll('.section-title').map((h) => h.text())).toEqual(['Equipos']);
    expect(wrapper.text()).toContain('F2 P2 #46');
  });
});

describe('plantel y circuitos', () => {
  it('plantel desde la lista de inscriptos, con filtro de clase', async () => {
    const roster: RosterFile = {
      seriesId: 'f2',
      season: 2026,
      updatedAt: NOW,
      source,
      rows: [
        { driver: 'Valentino Rossi', team: 'Team WRT', number: '46', vehicle: 'BMW M4 GT3', class: 'Pro' },
        { driver: 'Augusto Farfus', team: 'Team WRT', number: '46', class: 'Pro' },
        { driver: 'Otro Piloto', team: 'Otro Equipo', number: '7', class: 'Am' },
      ],
    };
    useRostersStore().$patch({ rosters: { f2: { status: 'ok', data: roster } } });
    const router = makeRouter();
    const series = useScheduleStore().seriesById.get('f2')!;
    const wrapper = mount(RosterPanel, { props: { series }, global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.findAll('.roster-team-title').map((h) => h.text())).toEqual(['Team WRT', 'Otro Equipo']);
    expect(wrapper.text()).toContain('3 pilotos · 2 equipos');
    const am = wrapper.findAll('.pill').find((p) => p.text() === 'Am')!;
    await am.trigger('click');
    expect(wrapper.findAll('.roster-team-title').map((h) => h.text())).toEqual(['Otro Equipo']);
  });

  it('sin lista de inscriptos (404) usa la tabla del campeonato', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (String(url).includes('standings/tc.json') ? json(fixture<StandingsFile>('standings/tc.json')) : notFound())),
    );
    const router = makeRouter();
    const series = useScheduleStore().seriesById.get('tc')!;
    const wrapper = mount(RosterPanel, { props: { series }, global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(useRostersStore().rosters.tc?.status).toBe('missing');
    expect(wrapper.text()).toContain('Todavía no hay lista oficial de inscriptos');
    expect(wrapper.findAll('.roster-team-title').map((h) => h.text())).toEqual(['Ford', 'Chevrolet']);
    expect(wrapper.find('a[href="/piloto/agustin-canapino"]').exists()).toBe(true);
  });

  it('sin lista ni tabla: mensaje claro', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => notFound()));
    const router = makeRouter();
    const series = useScheduleStore().seriesById.get('motogp')!;
    const wrapper = mount(RosterPanel, { props: { series }, global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Todavía no hay lista de inscriptos de');
  });

  it('el evento lleva a la página del circuito, que junta todas las categorías', async () => {
    const router = makeRouter();
    await router.push('/evento/ev-f1-qatar');
    const event = mount(EventView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(event.find('a.circuit-link').attributes('href')).toBe('/circuito/lusail');

    await router.push('/circuito/lusail');
    const circuit = mount(CircuitView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(circuit.find('.hero-title').text()).toBe('Lusail');
    expect(circuit.text()).toContain('Gran Premio de Qatar');
    expect(circuit.text()).toContain('Ronda 13 – Lusail');
  });

  it('Actualizar vuelve a pedir planteles y equipos abiertos', async () => {
    useRostersStore().$patch({ rosters: { tc: { status: 'missing' } } });
    useTeamsStore().$patch({ status: 'missing' });
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        requested.push(String(url));
        if (String(url).includes('schedule.json')) return json(scheduleFixture());
        if (String(url).includes('teams.json')) return json(teamsFile);
        return notFound();
      }),
    );
    await refreshEverything();
    expect(requested.some((u) => u.includes('rosters/tc.json'))).toBe(true);
    expect(requested.some((u) => u.includes('teams.json'))).toBe(true);
    expect(useTeamsStore().status).toBe('ok');
  });
});
