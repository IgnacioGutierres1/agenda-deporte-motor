import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { DriversFile, StandingsFile } from '@dm/shared';
import AgendaView from '../src/views/AgendaView.vue';
import DriverView from '../src/views/DriverView.vue';
import StandingsPanel from '../src/components/StandingsPanel.vue';
import { routes } from '../src/router.ts';
import { useDriversStore } from '../src/stores/drivers.ts';
import { useResultsStore } from '../src/stores/results.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { useSettingsStore } from '../src/stores/settings.ts';
import { fixture, NOW, scheduleFixture, statusFixture } from './helpers.ts';

let pinia: Pinia;
const makeRouter = () => createRouter({ history: createMemoryHistory(), routes });

const driversFile: DriversFile = {
  version: 1,
  generatedAt: '2026-11-14T12:00:00Z',
  drivers: [
    {
      id: 'agustin-canapino',
      name: 'Agustín Canapino',
      entries: [
        { seriesId: 'tc', pos: 3, points: 471, wins: 2, number: '8', team: 'Chevrolet' },
        { seriesId: 'turismo-nacional', table: 'Clase 3', pos: 1, points: 320 },
      ],
      recent: [{ seriesId: 'tc', eventId: 'ev-tc-sannicolas', sessionId: 'a1b2c3d4e5f60001', startUtc: '2026-11-13T17:00:00Z', pos: 2 }],
    },
  ],
};

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
  useDriversStore().$patch({ file: driversFile, status: 'ok' });
});

describe('pilotos', () => {
  it('ficha: campeonatos, próxima carrera y últimos resultados; se puede seguir', async () => {
    const router = makeRouter();
    await router.push('/piloto/agustin-canapino');
    const wrapper = mount(DriverView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.find('.hero-title').text()).toBe('Agustín Canapino');
    expect(wrapper.find('.hero-sub').text()).toContain('Chevrolet');
    const text = wrapper.text();
    expect(text).toContain('P3');
    expect(text).toContain('Clase 3');
    expect(text).toContain('Fecha 14 – San Nicolás'); // próxima carrera (en curso) y último resultado
    expect(text).toContain('P2');
    await wrapper.get('.follow-btn').trigger('click');
    expect(useSettingsStore().followedDrivers).toEqual([
      { id: 'agustin-canapino', name: 'Agustín Canapino', seriesIds: ['tc', 'turismo-nacional'] },
    ]);
  });

  it('piloto inexistente: mensaje claro', async () => {
    const router = makeRouter();
    await router.push('/piloto/nadie-ninguno');
    const wrapper = mount(DriverView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.text()).toContain('No encontramos a este piloto');
  });

  it('los nombres de la tabla de pilotos llevan a su ficha (no los de marcas)', async () => {
    useResultsStore().$patch({ standings: { tc: { status: 'ok', data: fixture<StandingsFile>('standings/tc.json') } } });
    const router = makeRouter();
    const series = useScheduleStore().seriesById.get('tc')!;
    const wrapper = mount(StandingsPanel, { props: { series }, global: { plugins: [pinia, router] } });
    await flushPromises();
    const links = wrapper.findAll('a.driver-link').map((a) => a.attributes('href'));
    expect(links).toContain('/piloto/agustin-canapino');
    expect(links.length).toBe(3); // solo la tabla de pilotos
  });

  it('la agenda pone primero las categorías de los pilotos seguidos', async () => {
    useSettingsStore().$patch({ followedDrivers: [{ id: 'x', name: 'Piloto MotoGP', seriesIds: ['motogp'] }] });
    const router = makeRouter();
    await router.push('/');
    const wrapper = mount(AgendaView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.find('.following-block').findAll('.event-card-series').map((c) => c.text())).toEqual(['MotoGP']);
  });

  it('búsqueda por nombre sin acentos y por número', () => {
    const store = useDriversStore();
    expect(store.search('canapino').map((d) => d.id)).toEqual(['agustin-canapino']);
    expect(store.search('agustin cana').length).toBe(1);
    expect(store.search('8').length).toBe(0); // menos de 2 caracteres
  });
});
