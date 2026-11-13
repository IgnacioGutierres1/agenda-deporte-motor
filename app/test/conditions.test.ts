import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { EventResultsFile, ScheduleFile, SessionConditions, Source } from '@dm/shared';
import EventResults from '../src/components/EventResults.vue';
import { conditionsLabel, conditionsParts, conditionsSourceName, conditionsText } from '../src/lib/conditions.ts';
import { routes } from '../src/router.ts';
import { useResultsStore } from '../src/stores/results.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { NOW, scheduleFixture, statusFixture } from './helpers.ts';

const QATAR = 'ev-f1-qatar';
const source: Source = { url: 'https://example.com/resultados', title: 'Resultados oficiales', kind: 'api', method: 'directo', fetchedAt: '2026-11-29T20:00:00Z' };
const openF1: Source = {
  url: 'https://api.openf1.org/v1/weather?session_key=11428',
  title: 'OpenF1 — clima medido en pista (estación del live timing de F1; valor típico de la sesión)',
  kind: 'api',
  method: 'directo',
  fetchedAt: '2026-11-29T20:00:00Z',
};

describe('condiciones medidas: textos', () => {
  it('arma la línea solo con los datos que existen', () => {
    const full: SessionConditions = { airC: 24, trackC: 38, humidity: 45, track: 'Seca', weather: 'Despejado', windKmh: 9 };
    expect(conditionsParts(full)).toEqual(['Aire 24°', 'Pista 38°', 'Humedad 45 %', 'Viento 9 km/h', 'Pista seca', 'Despejado']);
    expect(conditionsText({ airC: 24, trackC: 38, humidity: 45, track: 'Seca' })).toBe('Aire 24° · Pista 38° · Humedad 45 % · Pista seca');
    expect(conditionsText({ trackC: 31 })).toBe('Pista 31°');
    expect(conditionsText({ weather: 'Lluvia' })).toBe('Lluvia');
  });

  it('redondea los decimales y no muestra nada si no hay datos', () => {
    expect(conditionsText({ airC: 16.2, trackC: 24.5, humidity: 85.7 })).toBe('Aire 16° · Pista 25° · Humedad 86 %');
    expect(conditionsText({ airC: -0.2 })).toBe('Aire 0°');
    expect(conditionsText({})).toBe('');
    expect(conditionsText({ source: openF1 })).toBe('');
    expect(conditionsText(undefined)).toBe('');
    expect(conditionsText({ airC: Number.NaN, track: ' ' })).toBe('');
  });

  it('rotula la medición y nombra la fuente cuando no es la de los resultados', () => {
    expect(conditionsLabel({ airC: 20 })).toBe('Medición oficial durante la sesión');
    expect(conditionsSourceName({ airC: 20 })).toBe('');
    expect(conditionsLabel({ airC: 20, source: openF1 })).toBe('Medición en pista durante la sesión');
    expect(conditionsSourceName({ airC: 20, source: openF1 })).toBe('OpenF1');
    expect(conditionsSourceName({ airC: 20, source: { ...openF1, title: '' } })).toBe('api.openf1.org');
  });
});

describe('Resultados del evento: línea de condiciones', () => {
  let pinia: Pinia;

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
  });

  /** Qatar (F1) con resultados de práctica, clasificación y carrera; cada sesión con distintas condiciones. */
  async function mountResults(conditions: { race?: SessionConditions; practice?: SessionConditions }) {
    const schedule: ScheduleFile = scheduleFixture();
    const sessions = schedule.sessions.filter((s) => s.eventId === QATAR);
    for (const s of sessions) s.hasResults = true;
    const practice = sessions.find((s) => s.type === 'practica')!;
    const race = sessions.find((s) => s.type === 'carrera')!;
    const results: EventResultsFile = {
      seriesId: 'f1',
      eventId: QATAR,
      updatedAt: '2026-11-29T20:00:00Z',
      sessions: [
        {
          sessionId: practice.id,
          rows: [{ pos: 1, driver: 'Franco Colapinto', team: 'Alpine', time: '1:22.100' }],
          ...(conditions.practice ? { conditions: conditions.practice } : {}),
          source,
        },
        {
          sessionId: race.id,
          rows: [
            { pos: 1, driver: 'Kimi Antonelli', team: 'Mercedes', time: '1:30:00.000' },
            { pos: 2, driver: 'George Russell', team: 'Mercedes', gap: '+1.234s' },
          ],
          ...(conditions.race ? { conditions: conditions.race } : {}),
          source,
        },
      ],
    };
    useScheduleStore().$patch({ schedule, now: '2026-11-30T12:00:00Z' });
    useResultsStore().results[`f1/${QATAR}`] = { status: 'ok', data: results };
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push(`/evento/${QATAR}?tab=resultados`);
    const event = schedule.events.find((e) => e.id === QATAR)!;
    const wrapper = mount(EventResults, { props: { event }, global: { plugins: [pinia, router] } });
    await flushPromises();
    return wrapper;
  }

  it('muestra la medición oficial bajo el título de la sesión y cambia con la sesión elegida', async () => {
    const wrapper = await mountResults({
      race: { airC: 31, trackC: 33, humidity: 61, track: 'Seca', weather: 'Despejado' },
      practice: { airC: 34, trackC: 42, humidity: 51, track: 'Mojada', weather: 'Lluvia leve' },
    });
    const card = wrapper.get('.card.flush');
    expect(card.get('.card-title').text()).toBe('Carrera');
    // La línea va entre el título y la tabla.
    expect(card.element.children[1]!.classList.contains('session-conditions')).toBe(true);
    expect(card.get('.session-conditions-values').text()).toBe('Aire 31° · Pista 33° · Humedad 61 % · Pista seca · Despejado');
    expect(card.get('.session-conditions-label').text()).toBe('Medición oficial durante la sesión');
    expect(card.find('.session-conditions a').exists()).toBe(false);

    await wrapper.findAll('.session-chips .pill').find((c) => c.text() === 'Práctica 1')!.trigger('click');
    expect(wrapper.get('.session-conditions-values').text()).toBe('Aire 34° · Pista 42° · Humedad 51 % · Pista mojada · Lluvia leve');
  });

  it('con fuente propia (F1: OpenF1) la nombra y la enlaza', async () => {
    const wrapper = await mountResults({ race: { airC: 16.2, trackC: 24.5, humidity: 86, windKmh: 9, weather: 'Sin lluvia', source: openF1 } });
    expect(wrapper.get('.session-conditions-values').text()).toBe('Aire 16° · Pista 25° · Humedad 86 % · Viento 9 km/h · Sin lluvia');
    expect(wrapper.get('.session-conditions-label').text().replace(/\s+/g, ' ')).toBe('Medición en pista durante la sesión · OpenF1');
    const link = wrapper.get('.session-conditions a');
    expect(link.attributes('href')).toBe(openF1.url);
    expect(link.attributes('target')).toBe('_blank');
  });

  it('sin condiciones (o sin ningún dato) no agrega la línea', async () => {
    const none = await mountResults({});
    expect(none.find('.session-conditions').exists()).toBe(false);
    expect(none.get('.card.flush .card-title').text()).toBe('Carrera');
    const empty = await mountResults({ race: { source: openF1 } });
    expect(empty.find('.session-conditions').exists()).toBe(false);
  });
});
