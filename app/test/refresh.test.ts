import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { NewsFile, StandingsFile } from '@dm/shared';
import StandingsPanel from '../src/components/StandingsPanel.vue';
import { routes } from '../src/router.ts';
import { refreshEverything } from '../src/lib/refresh.ts';
import { useNewsStore } from '../src/stores/news.ts';
import { useResultsStore } from '../src/stores/results.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { fixture, NOW, scheduleFixture, statusFixture } from './helpers.ts';

let pinia: Pinia;
const standings = fixture<StandingsFile>('standings/tc.json');
const news: NewsFile = { version: 1, generatedAt: NOW, items: [] };

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
});
afterEach(() => vi.unstubAllGlobals());

function respond(url: string): Response {
  const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  if (url.includes('schedule.json')) return json(scheduleFixture());
  if (url.includes('status.json')) return json(statusFixture());
  if (url.includes('news.json')) return json({ ...news, generatedAt: '2026-11-14T16:00:00Z' });
  if (url.includes('standings/tc.json')) {
    const fresh = structuredClone(standings);
    fresh.tables[0]!.rows[0]!.points = 999;
    return json(fresh);
  }
  return new Response('no', { status: 404 });
}

describe('Actualizar', () => {
  it('vuelve a pedir lo abierto (agenda, campeonato, noticias) sin dejar la tabla en "Cargando…"', async () => {
    useResultsStore().$patch({ standings: { tc: { status: 'ok', data: standings } } });
    useNewsStore().$patch({ file: news, status: 'ok' });
    const requested: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        requested.push(String(input));
        return respond(String(input));
      }),
    );
    const router = createRouter({ history: createMemoryHistory(), routes });
    const series = useScheduleStore().seriesById.get('tc')!;
    const wrapper = mount(StandingsPanel, { props: { series }, global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.find('.standings-table').exists()).toBe(true);

    const pending = refreshEverything();
    await Promise.resolve();
    // Mientras se actualiza, la tabla anterior sigue visible.
    expect(wrapper.text()).not.toContain('Cargando campeonato');
    const result = await pending;
    await flushPromises();

    expect(result.error).toBeNull();
    expect(requested.some((u) => u.includes('schedule.json'))).toBe(true);
    expect(requested.some((u) => u.includes('standings/tc.json'))).toBe(true);
    expect(requested.some((u) => u.includes('news.json'))).toBe(true);
    // Los datos nuevos reemplazan a los anteriores.
    expect(wrapper.text()).toContain('999');
    expect(useNewsStore().file?.generatedAt).toBe('2026-11-14T16:00:00Z');
  });

  it('si falla la red, se conservan los datos que ya había', async () => {
    useResultsStore().$patch({ standings: { tc: { status: 'ok', data: standings } } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await refreshEverything();
    expect(useResultsStore().standings.tc?.status).toBe('ok');
    expect(useResultsStore().standings.tc?.data).toEqual(standings);
  });
});
