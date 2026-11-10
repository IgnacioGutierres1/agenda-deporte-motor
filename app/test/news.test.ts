import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { NewsFile, NewsItem } from '@dm/shared';
import NewsView from '../src/views/NewsView.vue';
import { routes } from '../src/router.ts';
import { newsForDriver, newsForSeries, useNewsStore } from '../src/stores/news.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { useSettingsStore } from '../src/stores/settings.ts';
import { NOW, scheduleFixture, statusFixture } from './helpers.ts';

let pinia: Pinia;
const item = (id: string, title: string, seriesIds: string[], extra: Partial<NewsItem> = {}): NewsItem => ({
  id,
  title,
  url: `https://example.org/${id}`,
  source: 'Medio',
  sourceKind: 'medio',
  publishedAt: '2026-11-14T10:00:00Z',
  seriesIds,
  ...extra,
});
const file: NewsFile = {
  version: 1,
  generatedAt: '2026-11-14T12:00:00Z',
  items: [
    item('n1', 'Canapino ganó la serie en San Nicolás', ['tc'], { source: 'ACTC', sourceKind: 'oficial', image: 'https://example.org/a.jpg' }),
    item('n2', 'Márquez campeón en Valencia', ['motogp']),
    item('n3', 'Verstappen y el GP de Qatar', ['f1']),
  ],
};

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
  useNewsStore().$patch({ file, status: 'ok' });
});

async function mountNews(path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(path);
  const wrapper = mount(NewsView, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return wrapper;
}

describe('noticias', () => {
  it('"Para ti" muestra lo de las categorías y pilotos seguidos; links a la nota original', async () => {
    useSettingsStore().$patch({ followedSeries: ['tc'], followedDrivers: [{ id: 'x', name: 'Marc Marquez', seriesIds: ['motogp'] }] });
    const wrapper = await mountNews('/noticias');
    const hero = wrapper.get('.news-hero');
    expect(hero.text()).toContain('Canapino ganó');
    expect(hero.attributes('href')).toBe('https://example.org/n1');
    expect(hero.attributes('target')).toBe('_blank');
    expect(wrapper.findAll('.news-row').map((r) => r.text())).toEqual([expect.stringContaining('Márquez campeón')]);
    expect(wrapper.text()).not.toContain('Verstappen');
  });

  it('sin nada seguido, "Para ti" muestra todas; "Por categoría" filtra', async () => {
    let wrapper = await mountNews('/noticias');
    expect(wrapper.findAll('.news-row')).toHaveLength(2);
    wrapper = await mountNews('/noticias?tab=categorias&serie=f1');
    expect(wrapper.findAll('.news-row').map((r) => r.text())).toEqual([expect.stringContaining('Verstappen')]);
    expect(wrapper.findAll('.session-chips .pill')).toHaveLength(3);
  });

  it('filtros por categoría y por piloto', () => {
    expect(newsForSeries(file.items, ['f1', 'tc']).map((n) => n.id)).toEqual(['n1', 'n3']);
    expect(newsForDriver(file.items, 'Marc Marquez', ['motogp']).map((n) => n.id)).toEqual(['n2']);
    expect(newsForDriver(file.items, 'Agustín Canapino', ['tc']).map((n) => n.id)).toEqual(['n1']);
    expect(newsForDriver(file.items, 'Agustín Canapino', ['f1'])).toEqual([]);
  });
});
