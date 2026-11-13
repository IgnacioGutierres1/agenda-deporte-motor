import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { circuitId, type CircuitsFile } from '@dm/shared';
import AgendaView from '../src/views/AgendaView.vue';
import EventView from '../src/views/EventView.vue';
import SessionSheet from '../src/components/SessionSheet.vue';
import WeatherCard from '../src/components/WeatherCard.vue';
import WeatherIcon from '../src/components/WeatherIcon.vue';
import { routes } from '../src/router.ts';
import { clearWeatherCache, describeWeather } from '../src/lib/weather.ts';
import type { GridItem } from '../src/lib/grid.ts';
import { useCircuitInfoStore } from '../src/stores/circuitInfo.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { useSettingsStore } from '../src/stores/settings.ts';
import { useWeatherStore } from '../src/stores/weather.ts';
import { NOW, scheduleFixture, statusFixture } from './helpers.ts';
import { H, openMeteoResponse, stubWeatherFetch } from './weather-helpers.ts';

const AR = 'America/Argentina/Buenos_Aires';
/** El pronóstico de prueba arranca 2 días (UTC) antes de NOW (sábado 14/11 15:30 UTC), como el real. */
const FORECAST_START = Date.parse('2026-11-12T00:00:00Z');
const NOV15 = Date.parse('2026-11-15T00:00:00Z');

/** Domingo 15 (de 06 a 24 UTC) con 60 % de lluvia y chaparrones; el resto, parcialmente nublado y seco. */
function forecastBody(extra: Parameters<typeof openMeteoResponse>[0] = {}) {
  const sunday = (i: number) => {
    const t = FORECAST_START + i * H;
    return t > NOV15 + 6 * H && t <= NOV15 + 24 * H;
  };
  return openMeteoResponse({
    start: FORECAST_START,
    currentAt: Date.parse(NOW) - 15 * 60_000,
    current: { temperature_2m: 21.4, apparent_temperature: 20.6, weather_code: 1, wind_speed_10m: 14, relative_humidity_2m: 55, is_day: 1, shortwave_radiation: 700 },
    ...extra,
    hourly: {
      precipitation_probability: (i) => (sunday(i) ? 60 : 10),
      precipitation: (i) => (sunday(i) ? 0.5 : 0),
      weather_code: (i) => (sunday(i) ? 80 : 2),
      ...extra.hourly,
    },
  });
}

const circuits: CircuitsFile = {
  version: 1,
  generatedAt: NOW,
  circuits: [
    { id: circuitId('San Nicolás'), name: 'Autódromo San Nicolás Ciudad', lat: -33.3712, lon: -60.2478, checkedAt: NOW },
    // Lusail: solo se conocen las coordenadas de la ciudad.
    { id: circuitId('Lusail'), name: 'Lusail', lat: 25.49, lon: 51.45, coordsApprox: true, checkedAt: NOW },
    // Sin coordenadas: no hay clima.
    { id: circuitId('Ricardo Tormo'), name: 'Circuit Ricardo Tormo', checkedAt: NOW },
  ],
};

let pinia: Pinia;
const makeRouter = () => createRouter({ history: createMemoryHistory(), routes });

function useFetch(body: unknown = forecastBody()) {
  const stub = stubWeatherFetch(body);
  vi.stubGlobal('fetch', vi.fn(stub.fetchFn));
  return stub;
}

function gridItem(sessionId: string): GridItem {
  const schedule = scheduleFixture();
  const session = schedule.sessions.find((s) => s.id === sessionId)!;
  return {
    session,
    event: schedule.events.find((e) => e.id === session.eventId),
    series: schedule.series.find((s) => s.id === session.seriesId)!,
    live: session.startUtc <= NOW && NOW < session.endUtc,
    finished: session.endUtc <= NOW,
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
  pinia = createPinia();
  setActivePinia(pinia);
  useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
  useCircuitInfoStore().$patch({ file: circuits, status: 'ok' });
  window.localStorage.clear();
  clearWeatherCache();
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('WeatherIcon', () => {
  it('dibuja un SVG en línea para cada estado del cielo (de día y de noche)', () => {
    for (const code of [0, 1, 2, 3, 45, 53, 57, 61, 65, 73, 81, 95]) {
      for (const isDay of [true, false]) {
        const wrapper = mount(WeatherIcon, { props: { name: describeWeather(code, isDay).icon, size: 20 } });
        const svg = wrapper.get('svg');
        expect(svg.attributes('aria-hidden')).toBe('true');
        expect(svg.attributes('width')).toBe('20');
        expect(svg.findAll('path').length).toBeGreaterThan(0);
        expect(wrapper.html()).not.toContain('<img');
      }
    }
  });

  it('sol de día, luna de noche', () => {
    const day = mount(WeatherIcon, { props: { name: 'despejado' } });
    const night = mount(WeatherIcon, { props: { name: 'despejado-noche' } });
    expect(day.find('.wx-sun').exists()).toBe(true);
    expect(night.find('.wx-moon').exists()).toBe(true);
    expect(night.find('.wx-sun').exists()).toBe(false);
  });
});

describe('WeatherCard', () => {
  const mountCard = async (props: Record<string, unknown> = {}) => {
    const wrapper = mount(WeatherCard, {
      props: { lat: -33.3712, lon: -60.2478, tz: AR, ...props },
      global: { plugins: [pinia, makeRouter()] },
    });
    await flushPromises();
    return wrapper;
  };

  it('muestra ahora y los próximos días en la zona del circuito, con la fuente', async () => {
    const stub = useFetch();
    const wrapper = await mountCard();
    expect(stub.weatherCalls()).toHaveLength(1);
    expect(stub.weatherCalls()[0]).toContain('latitude=-33.37&longitude=-60.25');

    expect(wrapper.get('.card-title').text()).toBe('Clima en el circuito');
    // Ahora: el bloque actual de Open-Meteo (21,4 °C), con la hora local del circuito.
    expect(wrapper.get('.wx-now-temp').text()).toBe('21°');
    expect(wrapper.get('.wx-now').text()).toContain('Mayormente despejado');
    expect(wrapper.get('.wx-now').text()).toContain('Ahora · 12:30 en el circuito');
    expect(wrapper.get('.wx-stats').text()).toContain('Sensación21°');
    expect(wrapper.get('.wx-stats').text()).toContain('Viento14 km/h');
    expect(wrapper.get('.wx-stats').text()).toContain('Humedad55 %');

    // 7 días desde hoy (sábado 14 en Buenos Aires).
    const days = wrapper.findAll('.wx-day');
    expect(days.map((d) => d.get('.wx-day-name').text())).toEqual(['Hoy', 'Mañana', 'lun 16', 'mar 17', 'mié 18', 'jue 19', 'vie 20']);
    expect(days[0]!.text()).toContain('Parcialmente nublado');
    expect(days[0]!.find('.wx-day-rain').exists()).toBe(false);
    // El domingo llueve: probabilidad y milímetros.
    expect(days[1]!.text()).toContain('Chaparrones débiles');
    expect(days[1]!.get('.wx-day-rain').text()).toMatch(/^Lluvia 60 % · \d+(,\d)? mm$/);
    // Máxima y mínima del día local (10 °C a las 00 UTC que suben medio grado por hora).
    expect(days[0]!.findAll('.wx-day-temps > *').map((t) => t.text())).toEqual(['22°', '10°']);

    const source = wrapper.get('[data-test="weather-source"]');
    expect(source.text()).toBe('Clima: Open-Meteo.com');
    expect(source.attributes('href')).toBe('https://open-meteo.com/');
    expect(source.attributes('target')).toBe('_blank');
    expect(wrapper.find('[data-test="weather-approx"]').exists()).toBe(false);
  });

  it('la pista siempre va rotulada "Pista (estimada)" y con la aclaración de que no es una medición', async () => {
    useFetch();
    const wrapper = await mountCard();
    const track = wrapper.get('[data-test="track-temp"]');
    expect(track.get('dt').text()).toBe('Pista (estimada)');
    expect(track.get('dd').text()).toMatch(/^\d+°$/);
    // Mediodía con sol: bastante más caliente que el aire.
    expect(parseInt(track.get('dd').text(), 10)).toBeGreaterThan(30);
    expect(wrapper.get('.wx-foot').text()).toContain('Pista (estimada): cálculo propio');
    expect(wrapper.get('.wx-foot').text()).toContain('No es una medición');
  });

  it('con coordenadas de la ciudad avisa que es el clima de la zona', async () => {
    useFetch();
    const wrapper = await mountCard({ approx: true });
    expect(wrapper.get('[data-test="weather-approx"]').text()).toContain('Clima de la zona');
  });

  it('con las fechas de un evento muestra solo esos días', async () => {
    useFetch();
    const wrapper = await mountCard({ dateStart: '2026-11-13', dateEnd: '2026-11-15' });
    const days = wrapper.findAll('.wx-day');
    expect(days.map((d) => d.get('.wx-day-name').text())).toEqual(['vie 13', 'Hoy', 'Mañana']);
    expect(days[0]!.classes()).toContain('past');
    // El evento está en curso: también "Ahora".
    expect(wrapper.find('.wx-now').exists()).toBe(true);
  });

  it('un evento que empieza en unos días muestra sus días pero no "Ahora"', async () => {
    useFetch();
    const wrapper = await mountCard({ dateStart: '2026-11-20', dateEnd: '2026-11-22' });
    expect(wrapper.findAll('.wx-day').map((d) => d.get('.wx-day-name').text())).toEqual(['vie 20', 'sáb 21', 'dom 22']);
    expect(wrapper.find('.wx-now').exists()).toBe(false);
    // Sin "Ahora" no hay pista estimada ni su aclaración; la fuente sí.
    expect(wrapper.text()).not.toContain('Pista (estimada)');
    expect(wrapper.find('[data-test="weather-source"]').exists()).toBe(true);
  });

  it('un evento fuera del alcance del pronóstico no pide nada', async () => {
    const stub = useFetch();
    const future = await mountCard({ dateStart: '2027-02-12', dateEnd: '2027-02-14' });
    const old = await mountCard({ dateStart: '2026-10-02', dateEnd: '2026-10-04' });
    expect(stub.weatherCalls()).toHaveLength(0);
    expect(future.find('[data-test="weather-card"]').exists()).toBe(false);
    expect(old.find('[data-test="weather-card"]').exists()).toBe(false);
  });

  it('sin conexión no muestra nada (ni un error)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    const wrapper = await mountCard();
    expect(wrapper.find('[data-test="weather-card"]').exists()).toBe(false);
    expect(wrapper.text()).toBe('');
    expect(useWeatherStore().status['-33.37,-60.25']).toBe('none');
  });

  it('con "Mostrar clima" apagado no pide ni dibuja nada', async () => {
    useSettingsStore().setShowWeather(false);
    const stub = useFetch();
    const wrapper = await mountCard();
    expect(stub.urls).toEqual([]);
    expect(wrapper.find('[data-test="weather-card"]').exists()).toBe(false);

    // Al encenderlo, aparece.
    useSettingsStore().setShowWeather(true);
    await flushPromises();
    expect(stub.weatherCalls()).toHaveLength(1);
    expect(wrapper.find('[data-test="weather-card"]').exists()).toBe(true);
  });

  it('dos tarjetas del mismo circuito comparten una sola descarga', async () => {
    const stub = useFetch();
    const a = mount(WeatherCard, { props: { lat: -33.3712, lon: -60.2478, tz: AR }, global: { plugins: [pinia, makeRouter()] } });
    const b = mount(WeatherCard, { props: { lat: -33.37, lon: -60.25, tz: AR }, global: { plugins: [pinia, makeRouter()] } });
    await flushPromises();
    expect(stub.weatherCalls()).toHaveLength(1);
    expect(a.find('.wx-now').exists()).toBe(true);
    expect(b.find('.wx-now').exists()).toBe(true);
  });
});

describe('página del evento: pestaña Horarios', () => {
  const mountEvent = async (path: string) => {
    const router = makeRouter();
    await router.push(path);
    const wrapper = mount(EventView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return wrapper;
  };

  it('marca chica en las sesiones que no terminaron: ícono, temperatura y % de lluvia desde 20 %', async () => {
    const stub = useFetch();
    const wrapper = await mountEvent('/evento/ev-tc-sannicolas');
    // Un solo pedido para todo el evento (tarjeta + marcas).
    expect(stub.weatherCalls()).toHaveLength(1);

    const lines = wrapper.findAll('.session-line');
    expect(lines).toHaveLength(3);
    // Entrenamiento del viernes: ya terminó, sin marca.
    expect(lines[0]!.classes()).toContain('finished');
    expect(lines[0]!.find('[data-test="weather-mark"]').exists()).toBe(false);
    // Clasificación en vivo (15–16 UTC): 18° y 10 % de lluvia, que no se muestra.
    const live = lines[1]!.get('[data-test="weather-mark"]');
    expect(live.get('.wx-mark-temp').text()).toBe('18°');
    expect(live.find('.wx-mark-rain').exists()).toBe(false);
    expect(live.find('svg.weather-icon').exists()).toBe(true);
    // Final del domingo: 60 % de lluvia.
    const final = lines[2]!.get('[data-test="weather-mark"]');
    expect(final.get('.wx-mark-temp').text()).toBe('18°');
    expect(final.get('.wx-mark-rain').text()).toBe('60 %');
    expect(final.get('.sr-only').text()).toBe('Clima previsto: chaparrones débiles, 18°, 60 % de probabilidad de lluvia');
  });

  it('tarjeta "Clima en el circuito" con los días del evento', async () => {
    useFetch();
    const wrapper = await mountEvent('/evento/ev-tc-sannicolas');
    const card = wrapper.get('[data-test="weather-card"]');
    expect(card.get('.card-title').text()).toBe('Clima en el circuito');
    expect(card.findAll('.wx-day').map((d) => d.get('.wx-day-name').text())).toEqual(['vie 13', 'Hoy', 'Mañana']);
    expect(card.get('[data-test="weather-source"]').attributes('href')).toBe('https://open-meteo.com/');
    // Va después de los horarios y antes de las fuentes.
    const html = wrapper.html();
    expect(html.indexOf('day-card')).toBeLessThan(html.indexOf('weather-card'));
    expect(html.indexOf('weather-card')).toBeLessThan(html.indexOf('source-box'));
  });

  it('coordenadas aproximadas: "clima de la zona"', async () => {
    useFetch();
    const wrapper = await mountEvent('/evento/ev-f1-qatar');
    expect(wrapper.get('[data-test="weather-approx"]').text()).toContain('Clima de la zona');
    // Las dos sesiones (27 y 29/11) entran en los 16 días.
    expect(wrapper.findAll('[data-test="weather-mark"]')).toHaveLength(2);
  });

  it('sin coordenadas del circuito no se muestra ni se pide nada', async () => {
    const stub = useFetch();
    const wrapper = await mountEvent('/evento/ev-motogp-valencia');
    expect(wrapper.findAll('.session-line')).toHaveLength(2);
    expect(wrapper.find('[data-test="weather-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="weather-mark"]').exists()).toBe(false);
    expect(stub.weatherCalls()).toHaveLength(0);
  });

  it('sin el archivo de circuitos (todavía no publicado) la página funciona igual', async () => {
    useCircuitInfoStore().$patch({ file: null, status: 'idle' });
    const stub = useFetch();
    const wrapper = await mountEvent('/evento/ev-tc-sannicolas');
    expect(stub.urls.some((u) => u.endsWith('/data/circuits.json'))).toBe(true);
    expect(useCircuitInfoStore().status).toBe('missing');
    expect(stub.weatherCalls()).toHaveLength(0);
    expect(wrapper.findAll('.day-card')).toHaveLength(3);
    expect(wrapper.find('[data-test="weather-card"]').exists()).toBe(false);
  });

  it('con "Mostrar clima" apagado no hay marcas, tarjeta ni pedidos', async () => {
    useSettingsStore().setShowWeather(false);
    useCircuitInfoStore().$patch({ file: null, status: 'idle' });
    const stub = useFetch();
    const wrapper = await mountEvent('/evento/ev-tc-sannicolas');
    expect(stub.urls).toEqual([]);
    expect(wrapper.find('[data-test="weather-card"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="weather-mark"]').exists()).toBe(false);
  });
});

describe('hoja de una sesión', () => {
  const mountSheet = async (sessionId: string) => {
    const wrapper = mount(SessionSheet, {
      props: { item: gridItem(sessionId), timeZone: AR, now: NOW, inline: true },
      global: { plugins: [pinia, makeRouter()] },
    });
    await flushPromises();
    return wrapper;
  };
  const stat = (wrapper: Awaited<ReturnType<typeof mountSheet>>, label: string) =>
    wrapper
      .findAll('.wx-stats > div')
      .find((d) => d.get('dt').text() === label)
      ?.get('dd')
      .text()
      .replace(/\s+/g, ' ');

  it('sesión futura: "Clima previsto" con aire, sensación, lluvia, viento, humedad y pista estimada', async () => {
    const stub = useFetch();
    const wrapper = await mountSheet('a1b2c3d4e5f60003'); // Final del TC, domingo 15 de 16:00 a 17:15 UTC
    expect(stub.weatherCalls()).toHaveLength(1);
    const block = wrapper.get('[data-test="session-weather"]');
    expect(block.get('.section-title').text()).toBe('Clima previsto');
    expect(block.text()).toContain('Chaparrones débiles');
    expect(block.findAll('.wx-stats dt').map((d) => d.text())).toEqual(['Aire', 'Sensación', 'Lluvia', 'Viento', 'Humedad', 'Pista (estimada)']);
    expect(stat(wrapper, 'Aire')).toBe('18°');
    expect(stat(wrapper, 'Sensación')).toBe('17°');
    // 0,5 mm por hora durante 1 h 15 min.
    expect(stat(wrapper, 'Lluvia')).toBe('60 % · 0,6 mm');
    expect(stat(wrapper, 'Viento')).toBe('12 km/h ráfagas 25');
    expect(stat(wrapper, 'Humedad')).toBe('70 %');
    expect(stat(wrapper, 'Pista (estimada)')).toMatch(/^\d+°$/);
    expect(block.text()).toContain('Pista (estimada): cálculo propio');
    expect(block.text()).toContain('No es una medición');
    expect(block.get('[data-test="weather-source"]').text()).toBe('Clima: Open-Meteo.com');
    expect(block.text()).toContain('actualizado recién');
    // Va entre el horario y la transmisión.
    const html = wrapper.html();
    expect(html.indexOf('data-test="conversion"')).toBeLessThan(html.indexOf('session-weather'));
    expect(html.indexOf('session-weather')).toBeLessThan(html.indexOf('Transmisión'));
  });

  it('sesión ya corrida en los últimos 2 días: "Clima durante la sesión (según modelo)", sin probabilidades', async () => {
    useFetch();
    const wrapper = await mountSheet('a1b2c3d4e5f60001'); // Entrenamiento 1, viernes 13 a las 17:00 UTC
    const block = wrapper.get('[data-test="session-weather"]');
    expect(block.get('.section-title').text()).toBe('Clima durante la sesión (según modelo)');
    expect(stat(wrapper, 'Lluvia')).toBe('Sin lluvia');
    expect(stat(wrapper, 'Aire')).toBe('19°');
    // La fuente y la aclaración de la pista van igual.
    expect(block.text()).toContain('No es una medición');
    expect(block.find('[data-test="weather-source"]').exists()).toBe(true);
  });

  it('una carrera larga muestra el rango de temperaturas', async () => {
    useFetch();
    const item = gridItem('a1b2c3d4e5f60003');
    item.session = { ...item.session, startUtc: '2026-11-15T10:00:00Z', endUtc: '2026-11-15T16:00:00Z' };
    const wrapper = mount(SessionSheet, { props: { item, timeZone: AR, now: NOW, inline: true }, global: { plugins: [pinia, makeRouter()] } });
    await flushPromises();
    expect(stat(wrapper, 'Aire')).toBe('15° a 18°');
  });

  it('coordenadas de la ciudad: lo aclara', async () => {
    useFetch();
    const wrapper = await mountSheet('d1b2c3d4e5f60001'); // F1 Qatar, práctica 1
    expect(wrapper.get('[data-test="session-weather"] [data-test="weather-approx"]').text()).toContain('Clima de la zona');
  });

  it('fuera del alcance, sin coordenadas, sin conexión o con el clima apagado: la hoja queda como siempre', async () => {
    const stub = useFetch();
    // MotoGP en Valencia: el circuito no tiene coordenadas.
    const noCoords = await mountSheet('b1b2c3d4e5f60002');
    expect(noCoords.find('[data-test="session-weather"]').exists()).toBe(false);
    expect(noCoords.find('[data-test="source-link"]').exists()).toBe(true);
    expect(stub.weatherCalls()).toHaveLength(0);

    // Sesión a 3 meses: no entra en el pronóstico.
    const item = gridItem('a1b2c3d4e5f60003');
    item.session = { ...item.session, startUtc: '2027-02-14T16:00:00Z', endUtc: '2027-02-14T17:00:00Z' };
    const far = mount(SessionSheet, { props: { item, timeZone: AR, now: NOW, inline: true }, global: { plugins: [pinia, makeRouter()] } });
    await flushPromises();
    expect(far.find('[data-test="session-weather"]').exists()).toBe(false);
    expect(stub.weatherCalls()).toHaveLength(0);

    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 503 })));
    const offline = await mountSheet('a1b2c3d4e5f60003');
    expect(offline.find('[data-test="session-weather"]').exists()).toBe(false);
    expect(offline.text()).toContain('Fuente del horario');

    useSettingsStore().setShowWeather(false);
    const off = useFetch();
    const hidden = await mountSheet('a1b2c3d4e5f60003');
    expect(hidden.find('[data-test="session-weather"]').exists()).toBe(false);
    expect(off.urls).toEqual([]);
  });
});

describe('la Agenda no pide clima', () => {
  it('ni al listar las sesiones ni al cambiar de día; solo al abrir una sesión', async () => {
    useCircuitInfoStore().$patch({ file: null, status: 'idle' });
    const stub = useFetch();
    const router = makeRouter();
    await router.push('/');
    const wrapper = mount(AgendaView, { global: { plugins: [pinia, router] }, attachTo: document.body });
    await flushPromises();
    expect(wrapper.findAll('.session-line').length).toBeGreaterThan(0);
    await wrapper.get('.weekend-tab').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="weather-mark"]').exists()).toBe(false);
    // La Agenda pide sus propios datos (tablas), pero ni clima ni fichas de circuitos.
    expect(stub.weatherCalls()).toEqual([]);
    expect(stub.urls.some((u) => u.endsWith('/data/circuits.json'))).toBe(false);

    // Al abrir la hoja de una sesión se cargan las fichas de circuitos (acá, todavía no publicadas).
    await wrapper.get('.session-line-btn').trigger('click');
    await flushPromises();
    expect(stub.urls.some((u) => u.endsWith('/data/circuits.json'))).toBe(true);
    expect(stub.weatherCalls()).toHaveLength(0);
    wrapper.unmount();
  });

  it('con las fichas disponibles, abrir una sesión pide el clima de ese circuito (una vez)', async () => {
    const stub = useFetch();
    const router = makeRouter();
    await router.push('/');
    const wrapper = mount(AgendaView, { global: { plugins: [pinia, router] }, attachTo: document.body });
    await flushPromises();
    expect(stub.weatherCalls()).toHaveLength(0);
    // Primera tarjeta: TC en San Nicolás (en vivo).
    await wrapper.get('.session-line-btn').trigger('click');
    await flushPromises();
    expect(stub.weatherCalls()).toHaveLength(1);
    expect(stub.weatherCalls()[0]).toContain('latitude=-33.37&longitude=-60.25');
    expect(document.body.querySelector('[data-test="session-weather"]')?.textContent).toContain('Clima previsto');
    wrapper.unmount();
  });
});
