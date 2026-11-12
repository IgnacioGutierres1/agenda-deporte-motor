import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { EventResultsFile, ScheduleFile } from '@dm/shared';
import AgendaView from '../src/views/AgendaView.vue';
import CategoryView from '../src/views/CategoryView.vue';
import EventView from '../src/views/EventView.vue';
import LiveView from '../src/views/LiveView.vue';
import { routes } from '../src/router.ts';
import { useResultsStore } from '../src/stores/results.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { NOW, scheduleFixture, statusFixture } from './helpers.ts';

let pinia: Pinia;
const makeRouter = () => createRouter({ history: createMemoryHistory(), routes });

const QATAR = 'ev-f1-qatar';
const source = { url: 'https://example.com', title: 'F1', kind: 'api', method: 'directo', fetchedAt: '2026-11-29T20:00:00Z' } as const;

/** Qatar con resultados de la práctica y de la carrera (la carrera, con un NC delante en la tabla). */
function qatarWithResults(): { schedule: ScheduleFile; results: EventResultsFile } {
  const schedule = scheduleFixture();
  const sessions = schedule.sessions.filter((s) => s.eventId === QATAR);
  for (const s of sessions) s.hasResults = true;
  const practice = sessions.find((s) => s.type === 'practica')!;
  const race = sessions.find((s) => s.type === 'carrera')!;
  return {
    schedule,
    results: {
      seriesId: 'f1',
      eventId: QATAR,
      updatedAt: '2026-11-29T20:00:00Z',
      sessions: [
        { sessionId: practice.id, rows: [{ pos: 1, driver: 'Franco Colapinto', team: 'Alpine', time: '1:22.100' }], source },
        {
          sessionId: race.id,
          rows: [
            { pos: null, status: 'NC', driver: 'Lance Stroll', team: 'Aston Martin' },
            { pos: 1, driver: 'Kimi Antonelli', team: 'Mercedes', time: '1:30:00.000', bestLap: '1:24.500' },
            { pos: 2, driver: 'George Russell', team: 'Mercedes', gap: '+1.234s', bestLap: '1:24.100' },
            { pos: 3, driver: 'Max Verstappen', team: 'Red Bull Racing', gap: '+5.000s' },
          ],
          source,
        },
      ],
    },
  };
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
});

async function mountAt(component: object, path: string) {
  const router = makeRouter();
  await router.push(path);
  const wrapper = mount(component, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return wrapper;
}

describe('cuenta regresiva', () => {
  it('Agenda (Finde): destaca la próxima sesión del período con su cuenta regresiva', async () => {
    const wrapper = await mountAt(AgendaView, '/');
    await wrapper.get('.weekend-tab').trigger('click');
    await flushPromises();
    const next = wrapper.findAll('.session-line.next');
    expect(next).toHaveLength(1);
    // Sábado 15:30 UTC -> domingo 13:00 UTC.
    expect(next[0]!.find('.countdown-badge').text()).toBe('en 21 h 30 min');
    // La sesión en vivo no se destaca como próxima.
    expect(wrapper.find('.session-line.live.next').exists()).toBe(false);
  });

  it('Agenda: el día sin sesiones muestra la próxima con "Empieza en …"', async () => {
    const wrapper = await mountAt(AgendaView, '/');
    useScheduleStore().setAgendaDay('2026-11-17');
    await flushPromises();
    expect(wrapper.get('.empty-day-next .countdown-badge').text()).toBe('Empieza en 12 d');
  });

  it('se actualiza con el "ahora" del store (sin temporizador por fila)', async () => {
    const wrapper = await mountAt(EventView, `/evento/${QATAR}`);
    expect(wrapper.get('.hero-countdown').text()).toBe('Empieza en 12 d');
    useScheduleStore().$patch({ now: '2026-11-27T11:15:00Z' });
    await flushPromises();
    expect(wrapper.get('.hero-countdown').text()).toBe('Empieza en 2 h 15 min');
    useScheduleStore().$patch({ now: '2026-11-27T13:18:00Z' });
    await flushPromises();
    expect(wrapper.get('.hero-countdown').text()).toBe('Empieza en 12 min');
  });

  it('Resumen de la categoría: "Próximo evento" con cuenta regresiva', async () => {
    const wrapper = await mountAt(CategoryView, '/categoria/f1');
    expect(wrapper.get('.next-event .countdown-badge').text()).toBe('Empieza en 12 d');
  });

  it('En vivo: las próximas 24 horas con "en X"', async () => {
    const wrapper = await mountAt(LiveView, '/en-vivo');
    const times = wrapper.findAll('.upcoming-time .countdown-badge').map((b) => b.text());
    expect(times.length).toBeGreaterThan(0);
    expect(times[0]).toMatch(/^en \d+ (h|min)/);
  });
});

describe('resultados de un vistazo', () => {
  function withQatarResults(now = '2026-11-30T12:00:00Z') {
    const { schedule, results } = qatarWithResults();
    useScheduleStore().$patch({ schedule, now });
    useResultsStore().results[`f1/${QATAR}`] = { status: 'ok', data: results };
  }

  it('Resultados del evento: la carrera elegida por defecto y primera en los chips, con podio y vuelta rápida', async () => {
    withQatarResults();
    const wrapper = await mountAt(EventView, `/evento/${QATAR}?tab=resultados`);
    const chips = wrapper.findAll('.session-chips .pill');
    expect(chips.map((c) => c.text())).toEqual(['Carrera', 'Práctica 1']);
    expect(wrapper.get('.session-chips .pill.active').text()).toBe('Carrera');
    const steps = wrapper.findAll('.podium-step');
    // Orden visual: 2.º, 1.º, 3.º; el NC de la tabla no entra.
    expect(steps.map((s) => s.find('.podium-pos').text())).toEqual(['2', '1', '3']);
    expect(steps[1]!.text()).toContain('Kimi Antonelli');
    expect(steps[1]!.text()).toContain('Mercedes');
    expect(steps[1]!.text()).toContain('1:30:00.000');
    expect(steps[0]!.text()).toContain('+1.234s');
    expect(wrapper.get('.podium-fastest').text()).toContain('George Russell · 1:24.100');

    // En la práctica no hay tarjeta de podio.
    await chips[1]!.trigger('click');
    expect(wrapper.find('.podium-card').exists()).toBe(false);
  });

  it('Horarios: con todo terminado, "Ganador" en el encabezado', async () => {
    withQatarResults();
    const wrapper = await mountAt(EventView, `/evento/${QATAR}`);
    expect(wrapper.find('.hero-countdown').exists()).toBe(false);
    expect(wrapper.get('.hero-winner').text()).toBe('Ganador: Kimi Antonelli · Mercedes');
  });

  it('Horarios: sin el ganador mientras falten sesiones', async () => {
    withQatarResults('2026-11-28T12:00:00Z');
    const wrapper = await mountAt(EventView, `/evento/${QATAR}`);
    expect(wrapper.find('.hero-winner').exists()).toBe(false);
    expect(wrapper.get('.hero-countdown').text()).toBe('Empieza en 1 d 4 h');
  });

  it('Resultados de la categoría: el podio en una línea', async () => {
    withQatarResults();
    const wrapper = await mountAt(CategoryView, '/categoria/f1?tab=resultados');
    await flushPromises();
    expect(wrapper.get('.podium-line').text()).toBe('1. Antonelli · 2. Russell · 3. Verstappen');
  });
});
