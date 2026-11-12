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

describe('lista de noticias', () => {
  const many = (n: number): NewsItem[] =>
    Array.from({ length: n }, (_, k) =>
      item(`m${k}`, `Nota ${k}`, ['f1'], {
        publishedAt: `2026-11-14T${String(10 - Math.floor(k / 6)).padStart(2, '0')}:${String(59 - (k % 6)).padStart(2, '0')}:00Z`,
        ...(k % 2 ? {} : { image: `https://example.org/${k}.jpg` }),
      }),
    );

  it('muestra 20 notas por tanda con "Ver más", y vuelve a la primera tanda al cambiar de lista', async () => {
    useNewsStore().$patch({ file: { ...file, items: many(45) } });
    const wrapper = await mountNews('/noticias?tab=ultimas');
    // 1 destacada + 20 filas
    expect(wrapper.findAll('.news-row')).toHaveLength(20);
    const more = wrapper.get('.news-more');
    expect(more.text()).toContain('Ver más');
    expect(more.text()).toContain('(24)');
    await more.trigger('click');
    expect(wrapper.findAll('.news-row')).toHaveLength(40);
    await wrapper.get('.news-more').trigger('click');
    expect(wrapper.findAll('.news-row')).toHaveLength(44);
    expect(wrapper.find('.news-more').exists()).toBe(false);
  });

  it('miniaturas diferidas; sin foto, el distintivo de la categoría', async () => {
    useNewsStore().$patch({ file: { ...file, items: many(5) } });
    const wrapper = await mountNews('/noticias?tab=ultimas');
    const thumbs = wrapper.findAll('.news-row .news-thumb img');
    expect(thumbs.length).toBeGreaterThan(0);
    for (const img of thumbs) {
      expect(img.attributes('loading')).toBe('lazy');
      expect(img.attributes('decoding')).toBe('async');
    }
    const rows = wrapper.findAll('.news-row');
    const noImage = rows.filter((r) => !r.find('img').exists());
    expect(noImage.length).toBeGreaterThan(0);
    expect(noImage.every((r) => r.find('.news-thumb .crest').exists())).toBe(true);
  });

  it('la misma noticia en otros medios: "También en", con el idioma si es otro', async () => {
    useNewsStore().$patch({
      file: {
        ...file,
        items: [
          item('a', 'Con foto', ['f1'], { image: 'https://example.org/a.jpg' }),
          item('b', 'Andrea Stella quiere que McLaren haga las paces con Las Vegas', ['f1'], {
            lang: 'es',
            alsoIn: [
              { source: 'Motorsport.com', url: 'https://www.motorsport.com/f1/news/x/', lang: 'en' },
              { source: 'Campeones', url: 'https://campeones.com.ar/x/', lang: 'es' },
            ],
          }),
        ],
      },
    });
    const wrapper = await mountNews('/noticias?tab=ultimas');
    const also = wrapper.get('.news-also');
    expect(also.text().replace(/\s+/g, ' ')).toBe('También en: Motorsport.com (EN), Campeones');
    expect(also.findAll('a').map((a) => a.attributes('href'))).toEqual(['https://www.motorsport.com/f1/news/x/', 'https://campeones.com.ar/x/']);
    // Fuera del link de la nota (no hay links anidados).
    expect(wrapper.find('.news-row .news-also').exists()).toBe(false);
  });
});
