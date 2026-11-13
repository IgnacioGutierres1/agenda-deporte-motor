import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import SettingsView from '../src/views/SettingsView.vue';
import { routes } from '../src/router.ts';
import { persistStore } from '../src/lib/storage.ts';
import { clearWeatherCache } from '../src/lib/weather.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { PERSISTED_SETTINGS, migrateSettings, useSettingsStore } from '../src/stores/settings.ts';
import { useWeatherStore } from '../src/stores/weather.ts';
import { NOW, scheduleFixture, statusFixture } from './helpers.ts';
import { stubWeatherFetch } from './weather-helpers.ts';

const AR = 'America/Argentina/Buenos_Aires';
let pinia: Pinia;

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
  window.localStorage.clear();
  clearWeatherCache();
});

afterEach(() => vi.unstubAllGlobals());

describe('Ajustes: Mostrar clima', () => {
  const mountSettings = async () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/ajustes');
    const wrapper = mount(SettingsView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return wrapper;
  };

  it('activado por defecto, con la explicación de dónde sale y qué se envía', async () => {
    const wrapper = await mountSettings();
    expect(useSettingsStore().showWeather).toBe(true);
    const toggle = wrapper.get('[data-test="weather-switch"]');
    expect(toggle.attributes('role')).toBe('switch');
    expect(toggle.attributes('aria-checked')).toBe('true');
    expect(toggle.text()).toBe('Mostrar clima');
    const section = toggle.element.closest('section')!;
    expect(section.querySelector('h2')!.textContent).toBe('Clima');
    expect(section.textContent).toContain('Open-Meteo.com');
    expect(section.textContent).toContain('solo envía las coordenadas del circuito');
    expect(section.textContent).toContain('nunca tu ubicación ni tus datos');
    expect(section.querySelector('a')!.getAttribute('href')).toBe('https://open-meteo.com/');
  });

  it('apagarlo borra los pronósticos guardados; se puede volver a encender', async () => {
    const stub = stubWeatherFetch();
    vi.stubGlobal('fetch', vi.fn(stub.fetchFn));
    await useWeatherStore().ensure(-33.37, -60.25);
    expect(stub.weatherCalls()).toHaveLength(1);
    expect(window.localStorage.getItem('dm:weather:-33.37,-60.25')).toBeTruthy();
    expect(Object.keys(useWeatherStore().forecasts)).toEqual(['-33.37,-60.25']);
    expect(useWeatherStore().status['-33.37,-60.25']).toBe('ok');

    const wrapper = await mountSettings();
    const toggle = wrapper.get('[data-test="weather-switch"]');
    await toggle.trigger('click');
    expect(useSettingsStore().showWeather).toBe(false);
    expect(toggle.attributes('aria-checked')).toBe('false');
    expect(wrapper.get('.switch').classes()).not.toContain('on');
    expect(window.localStorage.getItem('dm:weather:-33.37,-60.25')).toBeNull();
    expect(useWeatherStore().forecasts).toEqual({});

    await toggle.trigger('click');
    expect(useSettingsStore().showWeather).toBe(true);
    expect(toggle.attributes('aria-checked')).toBe('true');
    expect(wrapper.get('.switch').classes()).toContain('on');
  });

  it('se guarda con los demás ajustes; lo guardado por versiones anteriores queda con el clima activado', async () => {
    expect(PERSISTED_SETTINGS).toContain('showWeather');
    // Ajustes guardados antes de que existiera el clima.
    const old = { theme: 'dark', themeChosen: true, timeZone: AR, followedSeries: ['tc'], notifyLead: 60 };
    expect(migrateSettings(old)).toEqual(old);
    window.localStorage.setItem('dm:settings', JSON.stringify(old));
    const s = useSettingsStore();
    persistStore(s, PERSISTED_SETTINGS, migrateSettings);
    expect(s).toMatchObject({ showWeather: true, theme: 'dark', followedSeries: ['tc'], notifyLead: 60 });

    s.setShowWeather(false);
    await flushPromises();
    expect(JSON.parse(window.localStorage.getItem('dm:settings')!)).toMatchObject({ showWeather: false, theme: 'dark', followedSeries: ['tc'] });

    // La próxima vez que se abre la app, sigue apagado.
    setActivePinia(createPinia());
    const next = useSettingsStore();
    persistStore(next, PERSISTED_SETTINGS, migrateSettings);
    expect(next.showWeather).toBe(false);
    // Y la migración del tema (ajustes muy viejos) no pisa el clima.
    expect(migrateSettings({ theme: 'dark', showWeather: false })).toEqual({ theme: 'dark', themeChosen: true, showWeather: false });
  });
});
