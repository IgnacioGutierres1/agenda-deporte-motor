import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Driver, DriversFile, Team, TeamsFile } from '@dm/shared';
import AgendaView from '../src/views/AgendaView.vue';
import FollowingView from '../src/views/FollowingView.vue';
import TeamView from '../src/views/TeamView.vue';
import { routes } from '../src/router.ts';
import { recommend } from '../src/lib/recommend.ts';
import { teamMainEntry, teamNumbers, teamSeriesIds } from '../src/lib/teams.ts';
import { useDriversStore } from '../src/stores/drivers.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { useSettingsStore } from '../src/stores/settings.ts';
import { useTeamsStore } from '../src/stores/teams.ts';
import { NOW, scheduleFixture, statusFixture } from './helpers.ts';

const AR = 'America/Argentina/Buenos_Aires';
let pinia: Pinia;
const makeRouter = () => createRouter({ history: createMemoryHistory(), routes });
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
const notFound = () => new Response('no', { status: 404 });

const wrt: Team = {
  id: 'team-wrt',
  name: 'Team WRT',
  entries: [
    { seriesId: 'f2', table: 'Equipos', pos: 1, points: 152.5, numbers: ['31', '46'], classes: ['Pro'] },
    { seriesId: 'f2', table: 'Equipos Sprint Cup', pos: 3, points: 60 },
    { seriesId: 'motogp', numbers: ['32'] },
  ],
  drivers: [
    { id: 'rossi-valentino', name: 'Valentino Rossi', seriesId: 'f2', number: '46' },
    { id: 'augusto-farfus', name: 'Augusto Farfus', seriesId: 'f2', number: '46' },
    { id: 'charles-weerts', name: 'Charles Weerts', seriesId: 'f2', number: '31' },
  ],
};
const teamsFile: TeamsFile = { version: 1, generatedAt: NOW, teams: [wrt] };
const drivers: Driver[] = [
  { id: 'rossi-valentino', name: 'Valentino Rossi', entries: [{ seriesId: 'f2', pos: 7, points: 80 }], recent: [] },
  { id: 'augusto-farfus', name: 'Augusto Farfus', entries: [{ seriesId: 'f2', pos: 2, points: 140 }], recent: [] },
  { id: 'charles-weerts', name: 'Charles Weerts', entries: [], recent: [] },
];
const driversFile: DriversFile = { version: 1, generatedAt: NOW, drivers };

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
});

afterEach(() => vi.unstubAllGlobals());

describe('seguir equipos: store', () => {
  it('seguir y dejar de seguir; sus categorías cuentan para la agenda y los avisos', () => {
    const s = useSettingsStore();
    s.$patch({ followedSeries: ['tc'], followedDrivers: [{ id: 'x', name: 'X', seriesIds: ['tc', 'f1'] }] });
    s.toggleFollowTeam({ id: 'team-wrt', name: 'Team WRT', seriesIds: ['f2', 'motogp'] });
    expect(s.isTeamFollowed('team-wrt')).toBe(true);
    expect(s.followedTeams).toEqual([{ id: 'team-wrt', name: 'Team WRT', seriesIds: ['f2', 'motogp'] }]);
    expect(s.followedSeriesIds).toEqual(['tc', 'f1', 'f2', 'motogp']);
    // Lo que se manda al Worker: misma lista, ordenada.
    expect(s.notifySeriesIds).toEqual(['f1', 'f2', 'motogp', 'tc']);
    s.toggleFollowTeam({ id: 'team-wrt', name: 'Team WRT', seriesIds: [] });
    expect(s.followedTeams).toEqual([]);
    expect(s.notifySeriesIds).toEqual(['f1', 'tc']);
  });

  it('al cargar teams.json se actualizan nombre y categorías de los equipos seguidos', async () => {
    useSettingsStore().$patch({
      followedTeams: [
        { id: 'team-wrt', name: 'TEAM WRT', seriesIds: ['wec'] },
        { id: 'equipo-viejo', name: 'Equipo Viejo', seriesIds: ['tc'] },
      ],
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (String(url).includes('teams.json') ? json(teamsFile) : String(url).includes('drivers.json') ? json(driversFile) : notFound())),
    );
    await useTeamsStore().load();
    expect(useSettingsStore().followedTeams).toEqual([
      { id: 'team-wrt', name: 'Team WRT', seriesIds: ['f2', 'motogp'] },
      { id: 'equipo-viejo', name: 'Equipo Viejo', seriesIds: ['tc'] }, // no está en el índice: se conserva
    ]);
  });

  it('helpers: categorías, línea principal y números', () => {
    expect(teamSeriesIds(wrt)).toEqual(['f2', 'motogp']);
    expect(teamMainEntry(wrt)).toMatchObject({ seriesId: 'f2', pos: 1 });
    expect(teamNumbers(wrt, 'f2')).toEqual(['31', '46']);
    expect(teamNumbers({ ...wrt, entries: [] }, 'f2')).toEqual(['46', '31']); // de los pilotos
  });
});

describe('seguir equipos: pantallas', () => {
  beforeEach(() => {
    useTeamsStore().$patch({ file: teamsFile, status: 'ok' });
    useDriversStore().$patch({ file: driversFile, status: 'ok' });
  });

  it('ficha del equipo: botón Seguir', async () => {
    const router = makeRouter();
    await router.push('/equipo/team-wrt');
    const wrapper = mount(TeamView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    const btn = wrapper.get('.follow-btn');
    expect(btn.text()).toBe('Seguir');
    await btn.trigger('click');
    expect(useSettingsStore().followedTeams).toEqual([{ id: 'team-wrt', name: 'Team WRT', seriesIds: ['f2', 'motogp'] }]);
    expect(wrapper.get('.follow-btn').text()).toBe('Siguiendo');
  });

  it('Siguiendo → Equipos: tarjeta con posición principal, números y próxima carrera; búsqueda con ★', async () => {
    useSettingsStore().$patch({ followedTeams: [{ id: 'team-wrt', name: 'Team WRT', seriesIds: ['f2', 'motogp'] }] });
    const router = makeRouter();
    await router.push('/siguiendo?tab=equipos');
    const wrapper = mount(FollowingView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.findAll('[role="tab"]').map((t) => t.text())).toEqual(['Categorías', 'Pilotos', 'Equipos']);
    const card = wrapper.get('.follow-card');
    expect(card.attributes('href')).toBe('/equipo/team-wrt');
    expect(card.text()).toContain('Team WRT');
    expect(card.text()).toContain('P1 · F2 · 152,5 pts');
    expect(card.text()).toContain('#31 #46');
    expect(card.text()).toContain('Gran Premio de la Comunitat Valenciana'); // MotoGP corre antes que F2

    await wrapper.get('input[type="search"]').setValue('wrt');
    const row = wrapper.get('.list-card li');
    expect(row.text()).toContain('F2 P1 #31 #46 · MotoGP #32');
    await row.get('.follow-btn').trigger('click');
    expect(useSettingsStore().followedTeams).toEqual([]);
  });

  it('sin equipos seguidos: mensaje para empezar', async () => {
    const router = makeRouter();
    await router.push('/siguiendo?tab=equipos');
    const wrapper = mount(FollowingView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.text()).toContain('Todavía no seguís ningún equipo.');
  });

  it('la agenda pone primero las categorías de los equipos seguidos', async () => {
    useSettingsStore().$patch({ followedTeams: [{ id: 'team-wrt', name: 'Team WRT', seriesIds: ['motogp'] }] });
    const router = makeRouter();
    await router.push('/');
    const wrapper = mount(AgendaView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.find('.following-block').findAll('.event-card-series').map((c) => c.text())).toEqual(['MotoGP']);
  });
});

describe('seguir equipos: recomendaciones', () => {
  const base = { schedule: scheduleFixture(), now: NOW, zone: AR, followedSeries: [] as string[], drivers, teams: [wrt] };

  it('sugiere los pilotos del equipo seguido, primero los mejor ubicados', () => {
    const recs = recommend({ ...base, followedDrivers: [], followedTeams: [{ id: 'team-wrt', name: 'Team WRT', seriesIds: ['f2'] }] });
    expect(recs.filter((r) => r.reason === 'Porque seguís Team WRT').map((r) => [r.kind, r.id])).toEqual([
      ['driver', 'augusto-farfus'],
      ['driver', 'rossi-valentino'],
    ]);
  });

  it('no recomienda un equipo que ya se sigue ni pilotos ya seguidos', () => {
    const recs = recommend({
      ...base,
      followedDrivers: [{ id: 'augusto-farfus', name: 'Augusto Farfus', seriesIds: ['f2'] }],
      followedTeams: [{ id: 'team-wrt', name: 'Team WRT', seriesIds: ['f2'] }],
    });
    expect(recs.some((r) => r.kind === 'team' && r.id === 'team-wrt')).toBe(false);
    expect(recs.some((r) => r.id === 'augusto-farfus')).toBe(false);
    // Rossi ya sale como compañero de Farfus: no se repite.
    expect(recs.filter((r) => r.kind === 'driver').map((r) => [r.id, r.reason])).toEqual([
      ['rossi-valentino', 'Compañero de Farfus en F2'],
      ['charles-weerts', 'Porque seguís Team WRT'],
    ]);
    // Sin seguir el equipo, sí se sugiere como "Equipo de …".
    const withoutTeam = recommend({ ...base, followedDrivers: [{ id: 'augusto-farfus', name: 'Augusto Farfus', seriesIds: ['f2'] }] });
    expect(withoutTeam[0]).toMatchObject({ kind: 'team', id: 'team-wrt', reason: 'Equipo de Augusto Farfus' });
  });
});
