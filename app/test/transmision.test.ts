import { beforeEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import BroadcastLinks from '../src/components/BroadcastLinks.vue';
import SessionSheet from '../src/components/SessionSheet.vue';
import { routes } from '../src/router.ts';
import { broadcastItems } from '../src/lib/broadcast.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { NOW, scheduleFixture, statusFixture } from './helpers.ts';

const AR = 'America/Argentina/Buenos_Aires';
let pinia: Pinia;
const makeRouter = () => createRouter({ history: createMemoryHistory(), routes });

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
  document.body.innerHTML = '';
});

describe('canales de transmisión ("dónde verlo")', () => {
  it('broadcastItems: cada canal con su enlace, sin vacíos ni repetidos', () => {
    expect(broadcastItems(['Disney+', ' ', 'Fox Sports', 'Disney+', 'YouTube'], 'Top Race')).toEqual([
      { name: 'Disney+', link: { url: 'https://www.disneyplus.com/es-ar', kind: 'official' } },
      { name: 'Fox Sports', link: null },
      { name: 'YouTube', link: { url: 'https://www.youtube.com/results?search_query=Top%20Race', kind: 'search' } },
    ]);
  });

  it('los que tienen sitio oficial son enlaces que abren en otra pestaña; el resto, texto', () => {
    const wrapper = mount(BroadcastLinks, { props: { names: ['Disney+', 'Fox Sports', 'F1 TV Pro'], seriesName: 'Fórmula 1' } });
    const links = wrapper.findAll('[data-test="broadcast-link"]');
    expect(links.map((l) => [l.text(), l.attributes('href')])).toEqual([
      ['Disney+', 'https://www.disneyplus.com/es-ar'],
      ['F1 TV Pro', 'https://f1tv.formula1.com/'],
    ]);
    for (const l of links) {
      expect(l.attributes('target')).toBe('_blank');
      expect(l.attributes('rel')).toBe('noopener noreferrer');
      expect(l.attributes('aria-label')).toContain('se abre en otra pestaña');
      // Ícono de enlace externo.
      expect(l.findAll('svg')).toHaveLength(1);
    }
    expect(wrapper.findAll('[data-test="broadcast-text"]').map((t) => t.text())).toEqual(['Fox Sports']);
    expect(wrapper.find('.broadcast-note').exists()).toBe(false);
  });

  it('un "YouTube X" sin canal confirmado abre una búsqueda y lo aclara', () => {
    const wrapper = mount(BroadcastLinks, { props: { names: ['YouTube DTM', 'YouTube Top Race'] } });
    const [dtm, topRace] = wrapper.findAll('[data-test="broadcast-link"]');
    expect(dtm!.attributes('href')).toBe('https://www.youtube.com/@DTM');
    expect(dtm!.classes()).not.toContain('is-search');
    expect(topRace!.attributes('href')).toBe('https://www.youtube.com/results?search_query=Top%20Race');
    expect(topRace!.classes()).toContain('is-search');
    expect(topRace!.attributes('aria-label')).toContain('buscar en YouTube');
    expect(wrapper.get('.broadcast-note').text()).toContain('búsqueda en YouTube');
  });

  it('sin canales dice "A confirmar"', () => {
    const wrapper = mount(BroadcastLinks, { props: { names: [] } });
    expect(wrapper.text()).toBe('A confirmar');
    expect(wrapper.find('a').exists()).toBe(false);
  });

  it('hoja de sesión: canales como enlaces, con la aclaración de "canal habitual" cuando no lo informa la fuente', () => {
    const store = useScheduleStore();
    store.setPreset('proximos-4-findes');
    const habitual = store.items.find((i) => i.session.id === 'b1b2c3d4e5f60002')!; // MotoGP · Carrera (ESPN, Disney+)
    const wrapper = mount(SessionSheet, {
      props: { item: habitual, timeZone: AR, now: NOW, inline: true },
      global: { plugins: [pinia, makeRouter()] },
    });
    expect(wrapper.findAll('[data-test="broadcast-link"]').map((l) => [l.text(), l.attributes('href')])).toEqual([
      ['ESPN', 'https://www.espn.com.ar/'],
      ['Disney+', 'https://www.disneyplus.com/es-ar'],
    ]);
    expect(wrapper.text()).toContain('Canal habitual de la categoría en Argentina');

    const informada = store.items.find((i) => i.session.id === 'a1b2c3d4e5f60001')!; // TC · Entrenamiento 1 (lo informa la fuente)
    const other = mount(SessionSheet, {
      props: { item: informada, timeZone: AR, now: NOW, inline: true },
      global: { plugins: [pinia, makeRouter()] },
    });
    expect(other.findAll('[data-test="broadcast-link"]').map((l) => l.text())).toEqual(['TV Pública', 'Carburando']);
    expect(other.text()).not.toContain('Canal habitual de la categoría');
  });
});
