import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import SearchView from '../src/views/SearchView.vue';
import { routes } from '../src/router.ts';
import { useDriversStore } from '../src/stores/drivers.ts';
import { useNewsStore } from '../src/stores/news.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { NOW, scheduleFixture, statusFixture } from './helpers.ts';

let pinia: Pinia;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
  useDriversStore().$patch({
    status: 'ok',
    file: {
      version: 1,
      generatedAt: NOW,
      drivers: [{ id: 'agustin-canapino', name: 'Agustín Canapino', entries: [{ seriesId: 'tc', pos: 3, points: 471 }], recent: [] }],
    },
  });
  useNewsStore().$patch({
    status: 'ok',
    file: {
      version: 1,
      generatedAt: NOW,
      items: [
        {
          id: 'n1',
          title: 'Canapino ganó en San Nicolás',
          url: 'https://example.org/n1',
          source: 'ACTC',
          sourceKind: 'oficial',
          publishedAt: NOW,
          seriesIds: ['tc'],
        },
      ],
    },
  });
});

async function search(q: string) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push({ path: '/buscar', query: { q } });
  const wrapper = mount(SearchView, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return wrapper;
}

describe('buscar', () => {
  it('encuentra pilotos, eventos y noticias sin importar acentos', async () => {
    const wrapper = await search('canapino');
    const sections = wrapper.findAll('.section-title').map((h) => h.text());
    expect(sections).toEqual(['Pilotos', 'Noticias']);
    expect(wrapper.text()).toContain('Agustín Canapino');

    const byPlace = await search('san nicolas');
    expect(byPlace.findAll('.section-title').map((h) => h.text())).toEqual(['Circuitos', 'Eventos', 'Noticias']);
    expect(byPlace.text()).toContain('Fecha 14 – San Nicolás');
  });

  it('encuentra categorías y avisa cuando no hay resultados', async () => {
    const wrapper = await search('formula');
    expect(wrapper.findAll('.series-row').map((r) => r.text())).toEqual(
      expect.arrayContaining([expect.stringContaining('Fórmula 1')]),
    );
    expect((await search('xyzzy')).text()).toContain('Sin resultados');
  });
});
