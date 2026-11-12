import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { driverShardPath, type DriverDetail, type DriversIndexFile, type TeamsFile } from '@dm/shared';
import DriverView from '../src/views/DriverView.vue';
import { routes } from '../src/router.ts';
import { refreshEverything } from '../src/lib/refresh.ts';
import { useDriversStore } from '../src/stores/drivers.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { useSettingsStore } from '../src/stores/settings.ts';
import { useTeamsStore } from '../src/stores/teams.ts';
import { NOW, scheduleFixture, statusFixture } from './helpers.ts';

let pinia: Pinia;

const canapino: DriverDetail = {
  id: 'agustin-canapino',
  name: 'Agustín Canapino',
  entries: [{ seriesId: 'tc', pos: 3, points: 471, number: '8', team: 'Chevrolet' }],
  recent: [{ seriesId: 'tc', eventId: 'ev-tc-sannicolas', sessionId: 'a1b2c3d4e5f60001', startUtc: '2026-11-13T17:00:00Z', pos: 2 }],
};
const { recent: _r, ...canapinoSummary } = canapino;
const index: DriversIndexFile = { version: 1, generatedAt: NOW, drivers: [canapinoSummary] };
const shardPath = driverShardPath('agustin-canapino');

type Files = Record<string, unknown>;
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

/** fetch falso: responde con `files` (por ruta dentro de data/) y anota lo pedido. `hold` demora una ruta. */
function stubFetch(files: Files, hold?: { path: string; release: Promise<void> }) {
  const requested: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const rel = String(input).replace(/^.*\/data\//, '');
      requested.push(rel);
      if (hold && rel === hold.path) await hold.release;
      return rel in files ? json(files[rel]) : new Response('no', { status: 404 });
    }),
  );
  return requested;
}

const makeRouter = () => createRouter({ history: createMemoryHistory(), routes });

async function mountDriver(id = 'agustin-canapino') {
  const router = makeRouter();
  await router.push(`/piloto/${id}`);
  return mount(DriverView, { global: { plugins: [pinia, router] } });
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
});
afterEach(() => vi.unstubAllGlobals());

describe('pilotos: índice liviano + fichas por grupo', () => {
  it('el link directo a una ficha baja solo su grupo de fichas, no el índice de todos', async () => {
    const requested = stubFetch({ [shardPath]: { version: 1, drivers: [canapino] }, 'drivers-index.json': index });
    const wrapper = await mountDriver();
    await flushPromises();
    expect(wrapper.find('.hero-title').text()).toBe('Agustín Canapino');
    expect(wrapper.text()).toContain('Fecha 14 – San Nicolás');
    expect(requested.filter((r) => r.startsWith('drivers'))).toEqual([shardPath]);
    expect(useDriversStore().detailStatus('agustin-canapino')).toBe('ok');
  });

  it('desde Buscar (índice ya cargado) muestra la ficha enseguida y las últimas carreras con esqueleto hasta que llegan', async () => {
    useDriversStore().$patch({ file: index, status: 'ok' });
    let release!: () => void;
    const hold = { path: shardPath, release: new Promise<void>((r) => (release = r)) };
    stubFetch({ [shardPath]: { version: 1, drivers: [canapino] } }, hold);
    const wrapper = await mountDriver();
    await flushPromises();
    expect(wrapper.find('.hero-title').text()).toBe('Agustín Canapino');
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('Todavía no hay resultados');
    release();
    await flushPromises();
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(false);
    expect(wrapper.find('a[href*="tab=resultados"]').exists()).toBe(true);
  });

  it('sin nada en memoria muestra un esqueleto (no "no encontramos") mientras baja la ficha', async () => {
    let release!: () => void;
    stubFetch({ [shardPath]: { version: 1, drivers: [canapino] } }, { path: shardPath, release: new Promise<void>((r) => (release = r)) });
    const wrapper = await mountDriver();
    await flushPromises();
    expect(wrapper.find('.driver-skeleton').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('No encontramos');
    release();
    await flushPromises();
    expect(wrapper.find('.driver-skeleton').exists()).toBe(false);
    expect(wrapper.find('.hero-title').text()).toBe('Agustín Canapino');
  });

  it('un id que no está en su grupo: "no encontramos" con sugerencias del índice (sin bajar otras fichas)', async () => {
    const requested = stubFetch({ [driverShardPath('canapino-agustn')]: { version: 1, drivers: [] }, 'drivers-index.json': index });
    const wrapper = await mountDriver('canapino-agustn');
    await flushPromises();
    expect(wrapper.text()).toContain('No encontramos a este piloto');
    expect(wrapper.text()).toContain('Agustín Canapino');
    expect(requested.filter((r) => r.startsWith('drivers'))).toEqual([driverShardPath('canapino-agustn'), 'drivers-index.json']);
  });

  it('datos viejos (sin índice ni fichas): usa drivers.json completo', async () => {
    const requested = stubFetch({ 'drivers.json': { version: 1, generatedAt: NOW, drivers: [canapino] } });
    const wrapper = await mountDriver();
    await flushPromises();
    expect(wrapper.find('.hero-title').text()).toBe('Agustín Canapino');
    expect(wrapper.find('a[href*="tab=resultados"]').exists()).toBe(true);
    expect(requested).toContain('drivers-index.json');
    expect(requested).toContain('drivers.json');
    expect(useDriversStore().search('canapino').map((d) => d.id)).toEqual(['agustin-canapino']);
  });

  it('el índice actualiza los pilotos seguidos y la búsqueda funciona sin las últimas carreras', async () => {
    useSettingsStore().$patch({ followedDrivers: [{ id: 'agustin-canapino', name: 'Canapino', seriesIds: [] }] });
    stubFetch({ 'drivers-index.json': index });
    await useDriversStore().load();
    expect(useDriversStore().status).toBe('ok');
    expect(useDriversStore().search('8').length).toBe(0);
    expect(useDriversStore().search('canapino')[0]).not.toHaveProperty('recent');
    expect(useSettingsStore().followedDrivers).toEqual([{ id: 'agustin-canapino', name: 'Agustín Canapino', seriesIds: ['tc'] }]);
  });

  it('equipos: con teams.json no hace falta bajar el índice de pilotos; sin él, se arman con el índice', async () => {
    const teams: TeamsFile = { version: 1, generatedAt: NOW, teams: [{ id: 'chevrolet', name: 'Chevrolet', entries: [{ seriesId: 'tc' }], drivers: [] }] };
    let requested = stubFetch({ 'teams.json': teams, 'drivers-index.json': index });
    await useTeamsStore().load();
    expect(requested).toEqual(['teams.json']);

    setActivePinia((pinia = createPinia()));
    requested = stubFetch({ 'drivers-index.json': index });
    await useTeamsStore().load();
    expect(requested).toEqual(['teams.json', 'drivers-index.json']);
    expect(useTeamsStore().status).toBe('missing');
    expect(useTeamsStore().byId.get('chevrolet')?.drivers.map((d) => d.id)).toEqual(['agustin-canapino']);
  });

  it('Actualizar vuelve a pedir el índice y las fichas abiertas, y conserva las anteriores si falla', async () => {
    stubFetch({ [shardPath]: { version: 1, drivers: [canapino] }, 'drivers-index.json': index });
    const drivers = useDriversStore();
    await drivers.load();
    await drivers.loadDetail('agustin-canapino');
    const fresh = { ...canapino, name: 'Agustín Canapino (nuevo)' };
    const requested = stubFetch({ [shardPath]: { version: 1, drivers: [fresh] }, 'drivers-index.json': index, 'schedule.json': scheduleFixture() });
    await refreshEverything();
    expect(requested).toContain(shardPath);
    expect(requested).toContain('drivers-index.json');
    expect(drivers.details['agustin-canapino']?.name).toBe('Agustín Canapino (nuevo)');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await refreshEverything();
    expect(drivers.details['agustin-canapino']?.name).toBe('Agustín Canapino (nuevo)');
    expect(drivers.detailStatus('agustin-canapino')).toBe('ok');
  });
});
