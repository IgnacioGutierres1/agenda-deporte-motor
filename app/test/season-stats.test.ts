import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { DriverDetail, DriverSeasonStats, TeamSeasonStats, TeamsFile } from '@dm/shared';
import DriverView from '../src/views/DriverView.vue';
import TeamView from '../src/views/TeamView.vue';
import { routes } from '../src/router.ts';
import { coverageText, statTiles } from '../src/lib/seasonStats.ts';
import { useDriversStore } from '../src/stores/drivers.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { useTeamsStore } from '../src/stores/teams.ts';
import { NOW, scheduleFixture, statusFixture } from './helpers.ts';

let pinia: Pinia;
const makeRouter = () => createRouter({ history: createMemoryHistory(), routes });

const f1: DriverSeasonStats = { seriesId: 'f1', season: 2026, races: 20, wins: 3, podiums: 12, top5: 14, top10: 16, dnfs: 4, bestPos: 1, avgPos: 4, poles: 2, sprintWins: 1 };
const tc: DriverSeasonStats = { seriesId: 'tc', season: 2026, races: 1, wins: 0, podiums: 0, top5: 0, top10: 0, dnfs: 1 };
const wec: DriverSeasonStats = { seriesId: 'wec', season: 2026, races: 8, wins: 0, podiums: 0, top5: 0, top10: 0, dnfs: 1, bestPos: 19, overall: true };

const pairs = (s: Parameters<typeof statTiles>[0]) => statTiles(s).map((t) => [t.label, t.value, ...(t.sub ? [t.sub] : [])]);

describe('mosaicos de la temporada', () => {
  it('piloto: todos los números, con los sprints debajo de las victorias y el promedio con coma', () => {
    expect(pairs(f1)).toEqual([
      ['Carreras', '20'],
      ['Victorias', '3', '+ 1 sprint'],
      ['Podios', '12'],
      ['Poles', '2'],
      ['Top 5', '14'],
      ['Top 10', '16'],
      ['Mejor puesto', 'P1'],
      ['Promedio', '4,0'],
      ['Abandonos', '4'],
    ]);
    expect(pairs({ ...f1, sprintWins: 4 })[1]).toEqual(['Victorias', '3', '+ 4 sprints']);
  });

  it('oculta lo que no tiene dato: sin poles, mejor puesto ni promedio no hay mosaico (no es un cero)', () => {
    expect(pairs(tc).map((p) => p[0])).toEqual(['Carreras', 'Victorias', 'Podios', 'Top 5', 'Top 10', 'Abandonos']);
    // Con clasificaciones publicadas, cero poles sí es un dato.
    expect(pairs({ ...tc, poles: 0 })).toContainEqual(['Poles', '0']);
  });

  it('categoría con clases: solo carreras, mejor puesto en la general y abandonos', () => {
    expect(pairs(wec)).toEqual([
      ['Carreras', '8'],
      ['Mejor puesto en la general', 'P19'],
      ['Abandonos', '1'],
    ]);
  });

  it('equipo: sin top 5, top 10 ni promedio', () => {
    const team: TeamSeasonStats = { seriesId: 'f1', season: 2026, races: 20, wins: 12, podiums: 24, dnfs: 3, bestPos: 1, poles: 12, sprintWins: 4 };
    expect(pairs(team).map((p) => p[0])).toEqual(['Carreras', 'Victorias', 'Podios', 'Poles', 'Mejor puesto', 'Abandonos']);
  });

  it('aclaración de cobertura', () => {
    expect(coverageText(1)).toBe('1 carrera con resultado');
    expect(coverageText(20)).toBe('20 carreras con resultado');
  });
});

describe('La temporada en números en las fichas', () => {
  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
  });

  const driver: DriverDetail = {
    id: 'max-verstappen',
    name: 'Max Verstappen',
    entries: [{ seriesId: 'f1', pos: 3, points: 300, team: 'Red Bull Racing' }],
    recent: [],
    stats: [f1, wec],
  };

  async function mountDriver(detail: DriverDetail) {
    useDriversStore().$patch({ details: { [detail.id]: detail } });
    const router = makeRouter();
    await router.push(`/piloto/${detail.id}`);
    const wrapper = mount(DriverView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return wrapper;
  }

  it('piloto: una tarjeta con un bloque por categoría y de dónde salen los números', async () => {
    const wrapper = await mountDriver(driver);
    const card = wrapper.get('.season-stats');
    expect(card.get('.card-title').text()).toBe('La temporada en números');
    const groups = card.findAll('.stats-group');
    expect(groups).toHaveLength(2);

    expect(groups[0]!.get('.stats-head').text()).toContain('Temporada 2026 · 20 carreras con resultado');
    expect(groups[0]!.get('.stats-head').attributes('href')).toBe('/categoria/f1?tab=resultados');
    const tiles = groups[0]!.findAll('.stat-tile').map((t) => `${t.get('dt').text()}: ${t.findAll('dd').map((d) => d.text()).join(' ')}`);
    expect(tiles).toEqual(['Carreras: 20', 'Victorias: 3 + 1 sprint', 'Podios: 12', 'Poles: 2', 'Top 5: 14', 'Top 10: 16', 'Mejor puesto: P1', 'Promedio: 4,0', 'Abandonos: 4']);

    // Categoría con clases: sin victorias ni podios, y se explica por qué.
    const wecTiles = groups[1]!.findAll('.stat-tile dt').map((t) => t.text());
    expect(wecTiles).toEqual(['Carreras', 'Mejor puesto en la general', 'Abandonos']);
    expect(groups[1]!.text()).toContain('Categoría con clases');
    expect(groups[0]!.text()).not.toContain('Categoría con clases');
    expect(card.get('.card-foot').text()).toContain('resultados publicados en la app');
  });

  it('piloto sin números (o con la ficha del índice, que no los trae): no hay tarjeta', async () => {
    const { stats: _s, ...plain } = driver;
    const wrapper = await mountDriver(plain);
    expect(wrapper.find('.season-stats').exists()).toBe(false);
    expect(wrapper.find('.hero-title').text()).toBe('Max Verstappen');
  });

  it('equipo: los números de sus autos', async () => {
    const teams: TeamsFile = {
      version: 1,
      generatedAt: NOW,
      teams: [
        {
          id: 'mercedes',
          name: 'Mercedes',
          entries: [{ seriesId: 'f1', pos: 1, points: 600 }],
          drivers: [],
          stats: [{ seriesId: 'f1', season: 2026, races: 20, wins: 12, podiums: 24, dnfs: 3, bestPos: 1, poles: 12, sprintWins: 4 }],
        },
        { id: 'sin-numeros', name: 'Sin Números', entries: [{ seriesId: 'f1' }], drivers: [] },
      ],
    };
    useTeamsStore().$patch({ file: teams, status: 'ok' });
    const router = makeRouter();
    await router.push('/equipo/mercedes');
    const wrapper = mount(TeamView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    const card = wrapper.get('.season-stats');
    expect(card.findAll('.stat-tile').map((t) => `${t.get('dt').text()}: ${t.findAll('dd').map((d) => d.text()).join(' ')}`)).toEqual([
      'Carreras: 20',
      'Victorias: 12 + 4 sprints',
      'Podios: 24',
      'Poles: 12',
      'Mejor puesto: P1',
      'Abandonos: 3',
    ]);
    expect(card.get('.card-foot').text()).toContain('cuentan autos');

    await router.push('/equipo/sin-numeros');
    await flushPromises();
    expect(wrapper.find('.hero-title').text()).toBe('Sin Números');
    expect(wrapper.find('.season-stats').exists()).toBe(false);
  });
});
