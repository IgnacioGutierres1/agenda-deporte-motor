import { beforeEach, describe, expect, it } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import GridView from '../src/views/GridView.vue';
import SessionSheet from '../src/components/SessionSheet.vue';
import { routes } from '../src/router.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
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

describe('GridView', () => {
  it('muestra las sesiones del finde agrupadas por día, con estados', async () => {
    const router = makeRouter();
    await router.push('/');
    const wrapper = mount(GridView, { global: { plugins: [pinia, router] } });
    await flushPromises();

    const headers = wrapper.findAll('.day-header').map((h) => h.text());
    expect(headers).toEqual(['Viernes 13 de noviembre', 'Sábado 14 de noviembre', 'Domingo 15 de noviembre']);

    const rows = wrapper.findAll('.session-row');
    expect(rows).toHaveLength(6);
    expect(rows[0]!.text()).toContain('14:00');
    expect(rows[0]!.text()).toContain('TC');
    expect(rows[0]!.text()).toContain('Entrenamiento 1');
    expect(rows[0]!.text()).toContain('Ver resultado');

    const live = wrapper.find('.session-row.live');
    expect(live.text()).toContain('Clasificación');
    expect(live.text()).toContain('En vivo');
    expect(live.text()).toContain('fin aprox.');
    expect(live.text()).toContain('(habitual)');

    const changed = wrapper.find('.session-row.changed');
    expect(changed.text()).toContain('antes 13:30');

    expect(wrapper.text()).toContain('Descubierta');
    expect(wrapper.find('.pending').text()).toContain('Horarios a confirmar');
    expect(wrapper.find('.pending').text()).toContain('TC Pista');
  });

  it('muestra un estado vacío amable si no hay datos publicados', async () => {
    useScheduleStore().$patch({ schedule: null, missing: true });
    const router = makeRouter();
    await router.push('/');
    const wrapper = mount(GridView, { global: { plugins: [pinia, router] } });
    expect(wrapper.text()).toContain('Todavía no hay datos publicados');
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
