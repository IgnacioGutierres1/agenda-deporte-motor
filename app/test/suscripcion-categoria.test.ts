import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Series } from '@dm/shared';
import CalendarSubscribe from '../src/components/CalendarSubscribe.vue';
import CategoryView from '../src/views/CategoryView.vue';
import ExportView from '../src/views/ExportView.vue';
import { routes } from '../src/router.ts';
import { absoluteDataUrl, dataFileExists, seriesFeedPath, webcalUrl } from '../src/lib/data.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { useSettingsStore } from '../src/stores/settings.ts';
import { NOW, scheduleFixture, statusFixture } from './helpers.ts';

let pinia: Pinia;
const makeRouter = () => createRouter({ history: createMemoryHistory(), routes });

/** Respuesta mínima de un HEAD a data/feeds/*.ics. */
const head = (status: number, type = 'text/calendar; charset=utf-8') =>
  ({ status, ok: status >= 200 && status < 300, headers: { get: () => type } }) as unknown as Response;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
  window.localStorage.clear();
  document.body.innerHTML = '';
  vi.stubGlobal('fetch', vi.fn(async () => head(200)));
});

afterEach(() => vi.unstubAllGlobals());

describe('URL de los calendarios de suscripción', () => {
  it('por categoría, también bajo la sub-ruta de GitHub Pages', () => {
    expect(seriesFeedPath('tc-pista')).toBe('feeds/tc-pista.ics');
    const origin = 'https://usuario.github.io';
    const base = '/agenda-deporte-motor/';
    expect(absoluteDataUrl(seriesFeedPath('tc-pista'), origin, base)).toBe('https://usuario.github.io/agenda-deporte-motor/data/feeds/tc-pista.ics');
    expect(webcalUrl(seriesFeedPath('f1'), origin, base)).toBe('webcal://usuario.github.io/agenda-deporte-motor/data/feeds/f1.ics');
    // La base sin barra final da lo mismo.
    expect(webcalUrl(undefined, origin, '/agenda-deporte-motor')).toBe('webcal://usuario.github.io/agenda-deporte-motor/data/feeds/deporte-motor.ics');
    // En la raíz del dominio (desarrollo, dominio propio).
    expect(webcalUrl(seriesFeedPath('f1'), 'http://localhost:5173')).toBe('webcal://localhost:5173/data/feeds/f1.ics');
    expect(absoluteDataUrl(seriesFeedPath('f1'), 'http://localhost:5173')).toBe('http://localhost:5173/data/feeds/f1.ics');
  });

  it('dataFileExists: distingue publicado, 404, la portada devuelta por un servidor estático y "no se sabe"', async () => {
    const fetchFn = vi.fn(async () => head(200));
    expect(await dataFileExists('feeds/f1.ics', fetchFn)).toBe(true);
    expect(fetchFn).toHaveBeenCalledWith('/data/feeds/f1.ics', { method: 'HEAD', cache: 'no-store' });
    expect(await dataFileExists('feeds/x.ics', async () => head(404))).toBe(false);
    expect(await dataFileExists('feeds/x.ics', async () => head(200, 'text/html'))).toBe(false);
    expect(await dataFileExists('feeds/x.ics', async () => head(503))).toBeNull();
    expect(
      await dataFileExists('feeds/x.ics', async () => {
        throw new TypeError('sin conexión');
      }),
    ).toBeNull();
  });
});

describe('CalendarSubscribe', () => {
  const seriesOf = (id: string): Series => useScheduleStore().seriesById.get(id)!;
  const feedUrl = (id: string) => `${window.location.origin}/data/feeds/${id}.ics`;

  it('abre una hoja con el enlace webcal, la URL https para Google Calendar y los pasos', async () => {
    const wrapper = mount(CalendarSubscribe, { props: { series: seriesOf('f1'), inline: true } });
    expect(wrapper.get('[data-test="calendar-subscribe"]').text()).toContain('Suscribirme al calendario de esta categoría');
    expect(wrapper.find('[data-test="webcal-link"]').exists()).toBe(false);

    await wrapper.get('[data-test="calendar-subscribe"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[role="dialog"]').attributes('aria-label')).toBe('Calendario de F1');
    expect(wrapper.get('[data-test="webcal-link"]').attributes('href')).toBe(feedUrl('f1').replace(/^https?:/, 'webcal:'));
    expect(wrapper.get('[data-test="feed-url"]').text()).toBe(feedUrl('f1'));
    expect(wrapper.get('.calendar-steps').text()).toContain('Otros calendarios');
    expect(wrapper.get('.calendar-steps').text()).toContain('Desde URL');
    // El calendario existe: sin aviso.
    expect(fetch).toHaveBeenCalledWith('/data/feeds/f1.ics', { method: 'HEAD', cache: 'no-store' });
    expect(wrapper.find('[data-test="feed-missing"]').exists()).toBe(false);
  });

  it('"Copiar enlace" copia la URL https y lo confirma', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const wrapper = mount(CalendarSubscribe, { props: { series: seriesOf('motogp'), inline: true } });
    await wrapper.get('[data-test="calendar-subscribe"]').trigger('click');
    const button = wrapper.get('[data-test="copy-link"]');
    expect(button.text()).toBe('Copiar enlace');
    await button.trigger('click');
    await flushPromises();
    expect(writeText).toHaveBeenCalledWith(feedUrl('motogp'));
    expect(button.text()).toBe('Enlace copiado');
  });

  it('si no se puede copiar, explica cómo hacerlo a mano', async () => {
    // Sin portapapeles ni execCommand (como en un navegador que lo bloquea).
    vi.stubGlobal('navigator', {});
    const wrapper = mount(CalendarSubscribe, { props: { series: seriesOf('motogp'), inline: true } });
    await wrapper.get('[data-test="calendar-subscribe"]').trigger('click');
    await wrapper.get('[data-test="copy-link"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="copy-link"]').text()).toBe('Copiar enlace');
    expect(wrapper.text()).toContain('No se pudo copiar');
  });

  it('avisa si el calendario de la categoría todavía no está publicado', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => head(404)));
    const wrapper = mount(CalendarSubscribe, { props: { series: seriesOf('copa-truck'), inline: true } });
    await wrapper.get('[data-test="calendar-subscribe"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="feed-missing"]').text()).toContain('todavía no está publicado');
  });

  it('una categoría deshabilitada no tiene calendario: no muestra nada', () => {
    const wrapper = mount(CalendarSubscribe, { props: { series: seriesOf('top-race') } });
    expect(wrapper.find('[data-test="calendar-subscribe"]').exists()).toBe(false);
  });
});

describe('accesos a la suscripción por categoría', () => {
  it('página de la categoría: en Resumen y en Calendario, y abre la hoja', async () => {
    const router = makeRouter();
    await router.push('/categoria/f1');
    const wrapper = mount(CategoryView, { global: { plugins: [pinia, router] }, attachTo: document.body });
    await flushPromises();
    const access = wrapper.get('[data-test="calendar-subscribe"]');
    expect(access.text()).toContain('Suscribirme al calendario de esta categoría');
    await access.trigger('click');
    await flushPromises();
    const sheet = document.body.querySelector('[role="dialog"]')!;
    expect(sheet.getAttribute('aria-label')).toBe('Calendario de F1');
    expect(sheet.querySelector('[data-test="webcal-link"]')!.getAttribute('href')).toMatch(/^webcal:\/\/.*\/data\/feeds\/f1\.ics$/);

    await router.push('/categoria/f1?tab=calendario');
    await flushPromises();
    expect(wrapper.find('[data-test="calendar-subscribe"]').exists()).toBe(true);
    await router.push('/categoria/f1?tab=tabla');
    await flushPromises();
    expect(wrapper.find('[data-test="calendar-subscribe"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('Exportar: lista las categorías seguidas (habilitadas) con su suscripción individual', async () => {
    useSettingsStore().$patch({ followedSeries: ['motogp', 'top-race', 'no-existe', 'tc'] });
    const router = makeRouter();
    await router.push('/exportar');
    const wrapper = mount(ExportView, { global: { plugins: [pinia, router] }, attachTo: document.body });
    await flushPromises();
    const rows = wrapper.get('[data-test="series-feeds"]').findAll('li');
    // Top Race está deshabilitada y "no-existe" ya no está en los datos.
    expect(rows.map((r) => r.find('.grow').text())).toEqual(['MotoGP', 'Turismo Carretera']);
    // El calendario general sigue estando.
    expect(wrapper.get('.subscribe-card a.btn-primary').attributes('href')).toMatch(/^webcal:\/\/.*deporte-motor\.ics$/);

    await rows[0]!.get('[data-test="calendar-subscribe"]').trigger('click');
    await flushPromises();
    const sheet = document.body.querySelector('[role="dialog"]')!;
    expect(sheet.querySelector('[data-test="feed-url"]')!.textContent).toBe(`${window.location.origin}/data/feeds/motogp.ics`);
    wrapper.unmount();
  });

  it('Exportar: sin categorías seguidas explica cómo sumarlas', async () => {
    const router = makeRouter();
    await router.push('/exportar');
    const wrapper = mount(ExportView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    const card = wrapper.get('[data-test="series-feeds"]');
    expect(card.findAll('li')).toHaveLength(0);
    expect(card.text()).toContain('Todavía no seguís ninguna');
  });
});
