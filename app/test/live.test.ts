import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import LiveSessionCard from '../src/components/LiveSessionCard.vue';
import { routes } from '../src/router.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import type { GridItem } from '../src/lib/grid.ts';
import { NOW, scheduleFixture, statusFixture } from './helpers.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const nascarFeed = JSON.parse(readFileSync(path.join(here, '../../shared/test/fixtures/live/nascar-cup-5601-final.json'), 'utf8'));

let pinia: Pinia;
beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
});
afterEach(() => vi.unstubAllGlobals());

function itemFor(seriesId: string): GridItem {
  const store = useScheduleStore();
  const series = store.seriesById.get(seriesId)!;
  const base = store.schedule!.sessions[0]!;
  return {
    session: { ...base, id: `s-${seriesId}`, seriesId, name: 'Race', eventId: 'ev-x' },
    event: undefined,
    series,
    live: true,
    finished: false,
  };
}

async function mountCard(item: GridItem) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  const wrapper = mount(LiveSessionCard, { props: { item, now: NOW }, global: { plugins: [pinia, router] } });
  await flushPromises();
  await flushPromises();
  return wrapper;
}

describe('en vivo', () => {
  it('NASCAR: tabla en vivo desde el feed oficial (sin proxy)', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(nascarFeed), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountCard(itemFor('nascar-cup'));
    expect(String(fetchMock.mock.calls[0]![0])).toBe('https://cf.nascar.com/live/feeds/live-feed.json');
    const rows = wrapper.findAll('.live-table tbody tr');
    expect(rows.length).toBe(nascarFeed.vehicles.length);
    expect(wrapper.find('.live-board-head').text()).toBeTruthy();
    expect(wrapper.find('a[href="https://www.nascar.com/leaderboard"]').exists()).toBe(true);
  });

  it('NASCAR: si el feed es de otra división no la mezcla', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...nascarFeed, series_id: 3 }), { status: 200 })));
    const wrapper = await mountCard(itemFor('nascar-cup'));
    expect(wrapper.find('.live-table').exists()).toBe(false);
    expect(wrapper.text()).toContain('La fuente oficial todavía no muestra esta sesión');
  });

  it('sin fuente abierta: link al cronometraje oficial, sin consultar nada', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = await mountCard(itemFor('f1'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('Ver tiempos en vivo oficiales');
    expect(wrapper.find('.card-foot a').attributes('href')).toMatch(/^https:\/\//);
  });
});
