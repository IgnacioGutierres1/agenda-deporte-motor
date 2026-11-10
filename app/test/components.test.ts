import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import AgendaView from '../src/views/AgendaView.vue';
import CategoryView from '../src/views/CategoryView.vue';
import EventView from '../src/views/EventView.vue';
import SessionSheet from '../src/components/SessionSheet.vue';
import { routes } from '../src/router.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { useSettingsStore } from '../src/stores/settings.ts';
import { useResultsStore } from '../src/stores/results.ts';
import { NOW, scheduleFixture, statusFixture } from './helpers.ts';

let pinia: Pinia;

function makeRouter() {
  return createRouter({ history: createMemoryHistory(), routes });
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
  document.body.innerHTML = '';
});

describe('AgendaView', () => {
  async function mountAgenda(path = '/') {
    const router = makeRouter();
    await router.push(path);
    const wrapper = mount(AgendaView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return wrapper;
  }

  it('muestra el día de hoy agrupado por evento, con la sesión en vivo', async () => {
    const wrapper = await mountAgenda();
    expect(wrapper.find('.day-tab.active').text()).toBe('Hoy');
    const cards = wrapper.findAll('.event-card');
    // En vivo primero: TC (clasificación en curso); después MotoGP.
    expect(cards.map((c) => c.find('.event-card-series').text())).toEqual(['TC', 'MotoGP']);
    const live = wrapper.find('.session-line.live');
    expect(live.text()).toContain('En vivo');
    expect(live.text()).toContain('Clasificación');
    // Sin categorías seguidas: sugerencia para elegir.
    expect(wrapper.find('.following-block').text()).toContain('Tocá ★');
  });

  it('las categorías seguidas van primero y "Ocultar todas" pliega el resto', async () => {
    useSettingsStore().$patch({ followedSeries: ['motogp'] });
    const wrapper = await mountAgenda();
    const following = wrapper.find('.following-block');
    expect(following.findAll('.event-card-series').map((c) => c.text())).toEqual(['MotoGP']);
    await wrapper.get('.toggle-all').trigger('click');
    expect(wrapper.text()).toContain('Mostrar todas');
    expect(wrapper.text()).toContain('Hoy corren TC');
    expect(wrapper.findAll('.event-card')).toHaveLength(1);
  });

  it('"Finde" junta las sesiones del fin de semana y los horarios a confirmar', async () => {
    const wrapper = await mountAgenda();
    await wrapper.get('.weekend-tab').trigger('click');
    await flushPromises();
    expect(wrapper.findAll('.session-line')).toHaveLength(6);
    expect(wrapper.find('.pending-card').text()).toContain('TC Pista');
    expect(wrapper.find('.today-fab').exists()).toBe(true);
  });

  it('muestra un estado vacío amable si no hay datos publicados', async () => {
    useScheduleStore().$patch({ schedule: null, missing: true });
    const wrapper = await mountAgenda();
    expect(wrapper.text()).toContain('Todavía no hay datos publicados');
  });
});

describe('CategoryView', () => {
  async function mountCategory(path: string) {
    const router = makeRouter();
    await router.push(path);
    const wrapper = mount(CategoryView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return wrapper;
  }

  it('resumen con el próximo evento y botón para seguir', async () => {
    const wrapper = await mountCategory('/categoria/f1');
    expect(wrapper.find('.hero-title').text()).toBe('Fórmula 1');
    expect(wrapper.text()).toContain('Gran Premio de Qatar');
    expect(wrapper.text()).toContain('Próxima: Práctica 1');
    await wrapper.get('.follow-btn').trigger('click');
    expect(useSettingsStore().followedSeries).toEqual(['f1']);
    expect(wrapper.get('.follow-btn').text()).toBe('Siguiendo');
  });

  it('si la categoría no tiene tabla publicada no la pide y lo explica', async () => {
    const results = useResultsStore();
    const spy = vi.spyOn(results, 'loadStandings');
    const wrapper = await mountCategory('/categoria/tc-pista?tab=tabla');
    expect(wrapper.text()).toContain('Todavía no hay tabla de campeonato de TC Pista');
    expect(spy).not.toHaveBeenCalled();
  });

  it('las direcciones viejas de campeonatos llevan a la categoría', async () => {
    const router = makeRouter();
    await router.push('/campeonatos/f1?tab=resultados');
    expect(router.currentRoute.value.fullPath).toBe('/categoria/f1?tab=resultados');
  });
});

describe('EventView', () => {
  it('lista los horarios por día con su estado', async () => {
    const router = makeRouter();
    await router.push('/evento/ev-tc-sannicolas');
    const wrapper = mount(EventView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.find('.hero-title').text()).toBe('Fecha 14 – San Nicolás');
    expect(wrapper.find('.hero-status').text()).toContain('En vivo: Clasificación');
    expect(wrapper.findAll('.day-card')).toHaveLength(3);
  });
});

describe('SessionSheet', () => {
  it('muestra la fuente oficial con link, método y la conversión de hora', async () => {
    const router = makeRouter();
    const store = useScheduleStore();
    store.setPreset('proximos-4-findes');
    const item = store.items.find((i) => i.session.id === 'e1b2c3d4e5f60001')!; // F2 Sprint en Lusail
    const wrapper = mount(SessionSheet, {
      props: { item, timeZone: 'America/Argentina/Buenos_Aires', now: NOW, inline: true },
      global: { plugins: [pinia, router] },
    });
    const link = wrapper.get('[data-test="source-link"]');
    expect(link.attributes('href')).toBe('https://www.fiaformula2.com/Results?raceid=1100');
    expect(link.attributes('target')).toBe('_blank');
    expect(wrapper.text()).toContain('Lectura directa');
    expect(wrapper.get('[data-test="conversion"]').text()).toBe('14:00 en Lusail → 08:00 ARG');
  });

  it('indica la extracción con IA', () => {
    const store = useScheduleStore();
    const item = store.items.find((i) => i.session.id === 'a1b2c3d4e5f60002')!;
    const wrapper = mount(SessionSheet, {
      props: { item, timeZone: 'America/Argentina/Buenos_Aires', now: NOW, inline: true },
      global: { plugins: [pinia, makeRouter()] },
    });
    expect(wrapper.text()).toContain('Extraído con IA del documento oficial');
    expect(wrapper.text()).toContain('PDF oficial');
  });
});
