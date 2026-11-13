import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { EventResultsFile, EventStagesFile, MotorEvent, ScheduleFile, Session, StatusFile } from '@dm/shared';
import AgendaView from '../src/views/AgendaView.vue';
import CategoriesView from '../src/views/CategoriesView.vue';
import CategoryView from '../src/views/CategoryView.vue';
import EventView from '../src/views/EventView.vue';
import LiveView from '../src/views/LiveView.vue';
import EventCard from '../src/components/EventCard.vue';
import StagesPanel from '../src/components/StagesPanel.vue';
import SurfaceBadge from '../src/components/SurfaceBadge.vue';
import { routes } from '../src/router.ts';
import { useNewsStore } from '../src/stores/news.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { useSettingsStore } from '../src/stores/settings.ts';
import { toExpectedEvent } from '../src/gcal/mapping.ts';
import { eventFormatText, highlights, isRallyEvent, roundInfo, timingLabel, whoToWatch } from '../src/lib/context.ts';
import { starterPack } from '../src/lib/onboarding.ts';
import { isRaceType, mainResultSession, orderResultSessions } from '../src/lib/podium.ts';
import { groupSeries } from '../src/lib/grid.ts';
import { mainRaceOf, upcomingWhen } from '../src/lib/upcoming.ts';
import { fixture } from './helpers.ts';

const AR = 'America/Argentina/Buenos_Aires';
const schedule = () => fixture<ScheduleFile>('rally/schedule.json');
const wrcFile = () => fixture<EventStagesFile>('rally/stages/wrc/ev-wrc-japon.json');
const dakarFile = () => fixture<EventStagesFile>('rally/stages/dakar/ev-dakar-2027.json');

/** Viernes 09:45 en Japón (jueves 21:45 en Argentina): el SS4 largó hace 9 minutos. */
const WRC_NOW = '2026-11-13T00:45:00Z';
/** Viernes 8 de enero al mediodía en Argentina: día de la Etapa 6 del Dakar. */
const DAKAR_NOW = '2027-01-08T15:00:00Z';

let pinia: Pinia;

/** Sirve los archivos de data/ pedidos por la app; lo que no está, 404. */
function stubData(files: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = {
    'stages/wrc/ev-wrc-japon.json': wrcFile(),
    'stages/dakar/ev-dakar-2027.json': dakarFile(),
    ...files,
  };
  const fetchMock = vi.fn(async (url: string) => {
    const path = String(url).replace(/^.*\/data\//, '');
    const body = all[path];
    return body === undefined || body === null
      ? new Response('', { status: 404 })
      : new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function setup(now: string) {
  pinia = createPinia();
  setActivePinia(pinia);
  useScheduleStore().$patch({ schedule: schedule(), status: fixture<StatusFile>('rally/status.json'), now });
  useSettingsStore().$patch({ timeZone: AR });
  useNewsStore().$patch({ status: 'ok', file: { version: 1, generatedAt: now, items: [] } });
  document.body.innerHTML = '';
}

async function mountAt<T>(component: T, path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(path);
  const wrapper = mount(component as never, { global: { plugins: [pinia, router] } });
  await flushPromises();
  return wrapper;
}

const eventOf = (id: string): MotorEvent => schedule().events.find((e) => e.id === id)!;

afterEach(() => vi.unstubAllGlobals());

describe('pestaña Tramos (WRC, con horas de largada)', () => {
  beforeEach(() => {
    setup(WRC_NOW);
    stubData();
  });

  async function mountPanel() {
    const wrapper = mount(StagesPanel, { props: { event: eventOf('ev-wrc-japon') }, global: { plugins: [pinia, createRouter({ history: createMemoryHistory(), routes })] } });
    await flushPromises();
    return wrapper;
  }
  const row = (wrapper: Awaited<ReturnType<typeof mountPanel>>, code: string) =>
    wrapper.findAll('.stage-row').find((r) => r.find('.stage-code').text() === code)!;

  it('resume superficie, kilómetros y cantidad de tramos, con el mapa del recorrido enlazado', async () => {
    const wrapper = await mountPanel();
    const summary = wrapper.get('.stages-summary');
    expect(summary.get('.surface-badge').text()).toContain('Asfalto');
    expect(summary.text()).toContain('Asfalto angosto de montaña');
    expect(summary.findAll('.stat-tile').map((t) => [t.get('.stat-label').text(), t.get('.stat-value').text()])).toEqual([
      ['Cronometrados', '319,9 km'],
      ['Con enlaces', '967,1 km'],
      ['Tramos', '20'],
      ['Días', '4'],
    ]);
    expect(summary.text()).toContain('1 tramo cancelado');
    const map = summary.get('a.stage-map-link');
    expect(map.attributes('href')).toBe('https://example.org/rally/wrc-japon-recorrido.png');
    expect(map.attributes('target')).toBe('_blank');
    expect(map.get('img').attributes('src')).toBe('https://example.org/rally/wrc-japon-recorrido.png');
    expect(summary.text()).toContain('Mapa: Rally Japan');
    expect(wrapper.get('.source-box').text()).toContain('WRC – Itinerario Rally de Japón');
  });

  it('agrupa por día y marca el tramo en curso, los que ya largaron y el próximo', async () => {
    const wrapper = await mountPanel();
    expect(wrapper.findAll('.stage-day .card-title').map((h) => h.text())).toEqual([
      'Jueves 12 de noviembre',
      'Viernes 13 de noviembre',
      'Sábado 14 de noviembre',
      'Domingo 15 de noviembre',
    ]);
    expect(wrapper.findAll('.stage-day-meta').map((m) => m.text())[1]).toBe('6 tramos · 111,1 km');
    expect(wrapper.findAll('.stage-row')).toHaveLength(22);

    const live = wrapper.findAll('.stage-row.live');
    expect(live).toHaveLength(1);
    expect(live[0]!.text()).toContain('SS4');
    expect(live[0]!.get('.badge-live').text()).toBe('En curso');
    expect(live[0]!.attributes('aria-current')).toBe('true');

    const next = wrapper.findAll('.stage-row.next');
    expect(next).toHaveLength(1);
    expect(next[0]!.text()).toContain('SS5');
    // El SS5 larga a las 04:19Z: faltan 3 h 34 min.
    expect(next[0]!.get('.countdown-badge').text()).toBe('en 3 h 34 min');

    expect(wrapper.findAll('.stage-row.past').map((r) => r.get('.stage-code').text())).toEqual(['Shakedown', 'SS1', 'SS2', 'SS3']);
    expect(row(wrapper, 'SS3').get('.stage-time').text()).toContain('Largó');
    expect(row(wrapper, 'SS9').find('.stage-time-note').exists()).toBe(false);

    // Acceso directo al tramo en curso desde el resumen.
    expect(wrapper.get('.stage-now').text()).toContain('En curso: SS4 · Shitara Town R 1');
  });

  it('muestra la hora del usuario y, en chico, la del rally', async () => {
    const wrapper = await mountPanel();
    const ss2 = row(wrapper, 'SS2');
    // 07:33 del viernes en Japón: jueves 19:33 en Argentina.
    expect(ss2.get('.stage-time strong').text()).toBe('19:33');
    expect(ss2.get('.stage-time-day').text()).toBe('jue');
    expect(ss2.get('.stage-sub').text()).toBe('07:33 hora local');
    expect(ss2.get('.stage-km').text()).toBe('23,67 km');
    expect(wrapper.get('.zone-note').text()).toContain('hora Argentina');

    // Con el usuario en la zona del rally no hay segunda hora.
    useSettingsStore().$patch({ timeZone: 'Asia/Tokyo' });
    await flushPromises();
    expect(row(wrapper, 'SS2').get('.stage-time strong').text()).toBe('07:33');
    expect(row(wrapper, 'SS2').find('.stage-sub').exists()).toBe(false);
    expect(row(wrapper, 'SS2').find('.stage-time-day').exists()).toBe(false);
  });

  it('distintivos: Power Stage, superespecial, cancelado y superficie distinta a la del rally', async () => {
    const wrapper = await mountPanel();
    expect(row(wrapper, 'SS21').get('.stage-badges').text()).toContain('Power Stage');
    expect(row(wrapper, 'SS1').get('.stage-badges').text()).toContain('Superespecial');
    const ss7 = row(wrapper, 'SS7');
    expect(ss7.classes()).toContain('cancelled');
    expect(ss7.get('.badge-error').text()).toBe('Cancelado');
    expect(row(wrapper, 'SS12').get('.surface-badge').text()).toContain('Mixto');
    // Un tramo común, del mismo piso que el rally y todavía lejos: sin distintivos.
    expect(row(wrapper, 'SS10').find('.stage-badges').exists()).toBe(false);
    // El shakedown ya lo dice su código.
    expect(row(wrapper, 'Shakedown').find('.badge-info').exists()).toBe(false);
  });

  it('la descripción y el mapa del tramo van plegados', async () => {
    const wrapper = await mountPanel();
    const more = row(wrapper, 'SS2').get('details.stage-more');
    expect(more.attributes('open')).toBeUndefined();
    expect(more.get('summary').text()).toBe('Descripción y mapa');
    expect(more.text()).toContain('El tramo más largo del rally');
    expect(more.get('a.stage-map-link').attributes('href')).toBe('https://example.org/rally/wrc-japon-ss2.png');
    expect(row(wrapper, 'SS21').get('summary').text()).toBe('Descripción');
    expect(row(wrapper, 'SS3').find('details').exists()).toBe(false);
  });

  it('si el mapa no carga, queda el link al sitio oficial', async () => {
    const wrapper = await mountPanel();
    const map = wrapper.get('.stages-summary a.stage-map-link');
    await map.get('img').trigger('error');
    expect(map.find('img').exists()).toBe(false);
    expect(map.text()).toContain('Ver el mapa en el sitio oficial');
    expect(map.attributes('href')).toBe('https://example.org/rally/wrc-japon-recorrido.png');
  });

  it('avanza con el reloj: al largar el SS5 pasa a estar en curso', async () => {
    const wrapper = await mountPanel();
    useScheduleStore().$patch({ now: '2026-11-13T04:20:00Z' });
    await flushPromises();
    expect(wrapper.get('.stage-row.live').text()).toContain('SS5');
    expect(wrapper.get('.stage-row.next').text()).toContain('SS6');
    expect(row(wrapper, 'SS4').classes()).toContain('past');
  });
});

describe('pestaña Etapas (Dakar, sin horas de largada)', () => {
  beforeEach(() => {
    setup(DAKAR_NOW);
    stubData();
  });

  async function mountPanel() {
    const wrapper = mount(StagesPanel, { props: { event: eventOf('ev-dakar-2027') }, global: { plugins: [pinia, createRouter({ history: createMemoryHistory(), routes })] } });
    await flushPromises();
    return wrapper;
  }
  const row = (wrapper: Awaited<ReturnType<typeof mountPanel>>, code: string) =>
    wrapper.findAll('.stage-row').find((r) => r.find('.stage-code').text() === code)!;

  it('resumen del recorrido y una sola lista por fecha', async () => {
    const wrapper = await mountPanel();
    expect(wrapper.get('.stages-panel').classes()).toEqual(expect.arrayContaining(['by-date', 'surface-arena']));
    expect(wrapper.get('.stages-summary .surface-badge').text()).toContain('Arena y desierto');
    expect(wrapper.findAll('.stat-tile').map((t) => [t.get('.stat-label').text(), t.get('.stat-value').text()])).toEqual([
      ['Cronometrados', '4.429 km'],
      ['Etapas', '13'],
      ['Días', '15'],
    ]);
    expect(wrapper.findAll('.stage-day')).toHaveLength(1);
    expect(wrapper.find('.stage-day-head').exists()).toBe(false);
    expect(wrapper.findAll('.stage-row')).toHaveLength(15);
    expect(wrapper.find('.stage-time').exists()).toBe(false);
    expect(wrapper.get('.zone-note').text()).toContain('no publica la hora de largada');
  });

  it('resalta la etapa de hoy y deja las demás por fecha', async () => {
    const wrapper = await mountPanel();
    const today = wrapper.findAll('.stage-row.today');
    expect(today).toHaveLength(1);
    expect(today[0]!.text()).toContain('Etapa 6');
    expect(today[0]!.text()).toContain('Hail > Riad');
    expect(today[0]!.get('.badge-today').text()).toBe('Hoy');
    expect(today[0]!.get('.stage-date').text()).toBe('vie8');
    expect(today[0]!.get('.stage-km').text()).toBe('331 kmespecial');
    expect(today[0]!.get('.stage-sub').text()).toBe('Enlace 589 km · Total 920 km');
    expect(wrapper.findAll('.stage-row.past')).toHaveLength(6);
    expect(wrapper.get('.stage-row.next').text()).toContain('Etapa 7');
    expect(wrapper.get('.stage-row.next .badge-ok').text()).toBe('Próxima');
    expect(wrapper.find('.stage-row.live').exists()).toBe(false);
    expect(wrapper.get('.stage-now').text()).toContain('Hoy: Etapa 6 · Hail > Riad');
  });

  it('barras de terreno con porcentajes, solo donde la fuente las publica', async () => {
    const wrapper = await mountPanel();
    const bars = row(wrapper, 'Etapa 6').findAll('.terrain-row');
    expect(bars.map((b) => [b.get('.terrain-label').text(), b.get('.terrain-value').text(), b.get('.terrain-fill').attributes('style')])).toEqual([
      ['Arena', '64 %', 'width: 64%;'],
      ['Dunas', '21 %', 'width: 21%;'],
      ['Tierra', '15 %', 'width: 15%;'],
    ]);
    // Kilómetros en lugar de porcentajes: se calculan.
    expect(row(wrapper, 'Etapa 2').findAll('.terrain-value').map((v) => v.text())).toEqual(['42 %', '38 %', '20 %']);
    expect(row(wrapper, 'Etapa 2').get('.terrain-row').attributes('title')).toBe('Piedras: 42 % (168 km)');
    expect(row(wrapper, 'Etapa 5').find('.terrain-bars').exists()).toBe(false);
    expect(row(wrapper, 'Etapa 9').find('.terrain-bars').exists()).toBe(false);
  });

  it('prólogo, descanso, traslado y superficie distinta', async () => {
    const wrapper = await mountPanel();
    expect(row(wrapper, 'Prólogo').find('.badge-info').exists()).toBe(false);
    const rest = row(wrapper, 'Día de descanso');
    expect(rest.get('.stage-name').text()).toBe('Riad');
    expect(rest.find('.stage-km').exists()).toBe(false);
    const liaison = row(wrapper, 'Traslado');
    expect(liaison.get('.badge-info').text()).toBe('Enlace');
    // Como en dakar.com, el traslado no publica kilómetros.
    expect(liaison.find('.stage-km').exists()).toBe(false);
    expect(row(wrapper, 'Etapa 10').get('.surface-badge').text()).toContain('Tierra');
    expect(row(wrapper, 'Etapa 6').find('.surface-badge').exists()).toBe(false);
    expect(row(wrapper, 'Etapa 6').get('summary').text()).toBe('Descripción y mapa');
    expect(row(wrapper, 'Etapa 1').get('summary').text()).toBe('Mapa de la etapa');
  });
});

describe('pestaña del evento', () => {
  it('WRC: suma "Tramos" después de Horarios y muestra la superficie en la cabecera', async () => {
    setup(WRC_NOW);
    const fetchMock = stubData();
    const wrapper = await mountAt(EventView, '/evento/ev-wrc-japon');
    expect(wrapper.findAll('.underline-tab').map((t) => t.text())).toEqual(['Horarios', 'Tramos', 'Contexto', 'Resultados', 'Tabla']);
    expect(wrapper.get('.underline-tab.active').text()).toBe('Horarios');
    expect(wrapper.get('.hero .surface-badge').text()).toContain('Asfalto');
    expect(wrapper.get('.hero-status').text()).toContain('En vivo: Etapa del viernes: SS2 a SS8');
    // El itinerario no se descarga hasta abrir la pestaña.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/stages/'))).toBe(false);

    await wrapper.findAll('.underline-tab')[1]!.trigger('click');
    await flushPromises();
    expect(wrapper.get('.underline-tab.active').text()).toBe('Tramos');
    expect(wrapper.find('.stages-panel').exists()).toBe(true);
    expect(wrapper.get('.stage-row.live').text()).toContain('SS4');
    expect(fetchMock.mock.calls.filter((c) => String(c[0]).includes('/stages/wrc/ev-wrc-japon.json'))).toHaveLength(1);
  });

  it('Dakar: sin horarios, "Etapas" va primero y es la pestaña por defecto', async () => {
    setup(DAKAR_NOW);
    stubData();
    const wrapper = await mountAt(EventView, '/evento/ev-dakar-2027');
    expect(wrapper.findAll('.underline-tab').map((t) => t.text())).toEqual(['Etapas', 'Horarios', 'Contexto', 'Resultados', 'Tabla']);
    expect(wrapper.get('.underline-tab.active').text()).toBe('Etapas');
    expect(wrapper.get('.hero .surface-badge').text()).toContain('Arena');
    // No es "Horarios a confirmar": el recorrido está publicado.
    expect(wrapper.get('.hero-status').text()).toBe('En disputa · día 7 de 15');
    expect(wrapper.get('.stage-row.today').text()).toContain('Etapa 6');

    await wrapper.findAll('.underline-tab')[1]!.trigger('click');
    await flushPromises();
    expect(wrapper.get('.underline-tab.active').text()).toBe('Horarios');
    expect(wrapper.text()).toContain('Sin horarios de largada');
    expect(wrapper.text()).not.toContain('todavía no publicó el cronograma');
    expect(wrapper.text()).toContain('Ver etapas');
  });

  it('antes de empezar dice cuándo larga', async () => {
    setup('2026-12-20T15:00:00Z');
    stubData();
    const wrapper = await mountAt(EventView, '/evento/ev-dakar-2027');
    expect(wrapper.get('.hero-status').text()).toBe('Empieza el sáb 2 de ene');
    expect(wrapper.get('.stage-row.next').text()).toContain('Prólogo');
  });

  it('un evento sin itinerario sigue como antes, aunque se pida ?tab=etapas', async () => {
    setup(WRC_NOW);
    const fetchMock = stubData();
    const wrapper = await mountAt(EventView, '/evento/ev-wrc-arabia?tab=etapas');
    expect(wrapper.findAll('.underline-tab').map((t) => t.text())).toEqual(['Horarios', 'Contexto', 'Resultados', 'Tabla']);
    expect(wrapper.get('.underline-tab.active').text()).toBe('Horarios');
    expect(wrapper.get('.hero-status').text()).toBe('Horarios a confirmar');
    expect(wrapper.text()).toContain('todavía no publicó el cronograma');
    // La superficie se muestra igual: viene en el calendario.
    expect(wrapper.get('.hero .surface-badge').text()).toContain('Tierra');
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/stages/'))).toBe(false);
  });

  it('si el archivo del itinerario falta, la pestaña lo explica sin romper el resto', async () => {
    setup(DAKAR_NOW);
    stubData({ 'stages/dakar/ev-dakar-2027.json': null });
    const wrapper = await mountAt(EventView, '/evento/ev-dakar-2027');
    expect(wrapper.get('.stages-panel').text()).toContain('todavía no está publicado');
    expect(wrapper.find('.stage-row').exists()).toBe(false);
    expect(wrapper.get('.hero-title').text()).toBe('Dakar 2027');
  });

  it('Contexto de un rally: sin "carreras" ni "fin de semana" ni cronograma pendiente', async () => {
    setup(WRC_NOW);
    stubData();
    const wrc = await mountAt(EventView, '/evento/ev-wrc-japon?tab=contexto');
    expect(wrc.text()).toContain('Fecha 13 de 14');
    expect(wrc.text()).toContain('Rally por tramos cronometrados sobre asfalto · 4 días');
    expect(wrc.text()).not.toMatch(/\d carreras?\b/);
    expect(wrc.text()).not.toContain('1 práctica');

    setup(DAKAR_NOW);
    stubData();
    const dakar = await mountAt(EventView, '/evento/ev-dakar-2027?tab=contexto');
    expect(dakar.text()).toContain('Rally raid por etapas sobre arena y desierto · 15 días');
    expect(dakar.text()).not.toContain('todavía no publicó el cronograma');
    // Una sola prueba por año: "Fecha 1 de 1" y "Última fecha de la temporada" no dicen nada.
    expect(dakar.text()).not.toContain('Fecha 1 de 1');
    expect(dakar.text()).not.toContain('Última fecha');
  });
});

describe('Agenda: rally sin horas de largada', () => {
  it('muestra la etapa del día como renglón de día completo, no como "horarios a confirmar"', async () => {
    setup(DAKAR_NOW);
    stubData();
    const wrapper = await mountAt(AgendaView, '/');
    const card = wrapper.findAll('.event-card').find((c) => c.text().includes('Dakar'))!;
    expect(card.get('.event-card-series').text()).toBe('Dakar');
    expect(card.get('.event-card-event').text()).toContain('Dakar 2027');
    expect(card.get('.surface-badge').text()).toContain('Arena');
    const line = card.get('.stage-day-line');
    expect(line.get('.session-time').text()).toBe('Todo el día');
    expect(line.get('.session-name').text()).toBe('Etapa 6 · Hail > Riad');
    expect(line.text()).toContain('331 km de especial · 920 km en total');
    expect(line.classes()).toContain('next');
    // Lleva a la pestaña Etapas del evento.
    expect(line.get('a').attributes('href')).toBe('/evento/ev-dakar-2027?tab=etapas');
    // El TC del mismo finde, sin cronograma ni recorrido, sigue en "horarios a confirmar"; el Dakar no.
    const pending = wrapper.get('.pending-card');
    expect(pending.text()).toContain('La Plata');
    expect(pending.text()).not.toContain('Dakar');
    // Hay actividad ese día: no corresponde "Hoy no hay sesiones".
    expect(wrapper.find('.empty-day').exists()).toBe(false);
  });

  it('en "Finde" va una etapa por día, con el descanso', async () => {
    setup(DAKAR_NOW);
    stubData();
    const wrapper = await mountAt(AgendaView, '/');
    await wrapper.get('.weekend-tab').trigger('click');
    await flushPromises();
    const card = wrapper.findAll('.event-card').find((c) => c.text().includes('Dakar'))!;
    expect(card.findAll('.session-day-head').map((h) => h.text())).toEqual(['Viernes 8', 'Sábado 9', 'Domingo 10']);
    expect(card.findAll('.stage-day-line .session-name').map((n) => n.text())).toEqual([
      'Etapa 6 · Hail > Riad',
      'Día de descanso · Riad',
      'Etapa 7 · Riad > Wadi Ad-Dawasir',
    ]);
  });

  it('si se sigue la categoría, la etapa del día va en "Siguiendo"; y cuenta al plegar', async () => {
    setup(DAKAR_NOW);
    stubData();
    useSettingsStore().$patch({ followedSeries: ['dakar'] });
    const wrapper = await mountAt(AgendaView, '/');
    const following = wrapper.get('.following-block');
    expect(following.findAll('.event-card-series').map((c) => c.text())).toEqual(['Dakar']);
    expect(following.text()).not.toContain('no corren tus categorías');
    await following.get('.collapse-btn').trigger('click');
    expect(following.find('.stage-day-line').exists()).toBe(false);
    expect(following.get('.collapse-btn').text()).toBe('1');
  });

  it('el día anterior a la largada (para la zona del evento ya es el día 1) no aparece por adelantado', async () => {
    // 1 de enero 22:00 en Argentina: en Arabia ya es 2 de enero, pero el prólogo figura con fecha 2.
    setup('2027-01-02T01:00:00Z');
    stubData();
    const wrapper = await mountAt(AgendaView, '/');
    expect(wrapper.find('.stage-day-line').exists()).toBe(false);
    expect(wrapper.findAll('.event-card, .pending-card').some((c) => c.text().includes('Dakar'))).toBe(false);
  });

  it('si el itinerario no se puede leer, el evento sigue en "horarios a confirmar" como hasta ahora', async () => {
    setup(DAKAR_NOW);
    stubData({ 'stages/dakar/ev-dakar-2027.json': null });
    const wrapper = await mountAt(AgendaView, '/');
    expect(wrapper.find('.stage-day-line').exists()).toBe(false);
    expect(wrapper.get('.pending-card').text()).toContain('Dakar');
  });

  it('WRC con horarios: las sesiones de tipo etapa van como cualquier sesión, con la superficie en la tarjeta', async () => {
    setup(WRC_NOW);
    const fetchMock = stubData();
    const wrapper = await mountAt(AgendaView, '/');
    const card = wrapper.findAll('.event-card').find((c) => c.text().includes('WRC'))!;
    expect(card.get('.surface-badge').text()).toContain('Asfalto');
    expect(card.findAll('.session-name').map((n) => n.text())).toEqual(['Etapa del jueves: SS1', 'Etapa del viernes: SS2 a SS8']);
    expect(card.get('.session-line.live').text()).toContain('Etapa del viernes');
    expect(card.find('.stage-day-line').exists()).toBe(false);
    // Con horarios publicados la Agenda no necesita el itinerario.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).includes('/stages/'))).toBe(false);
  });
});

describe('superficie y grupo rally en los listados', () => {
  it('el distintivo lleva ícono, nombre y la superficie completa como título', () => {
    const wrapper = mount(SurfaceBadge, { props: { surface: 'mixto' } });
    expect(wrapper.classes()).toEqual(expect.arrayContaining(['surface-badge', 's-mixto']));
    expect(wrapper.text()).toBe('Superficie: Mixto');
    expect(wrapper.attributes('title')).toBe('Superficie: Mixto (asfalto y tierra)');
    expect(wrapper.find('svg path').exists()).toBe(true);
    expect(mount(SurfaceBadge, { props: { surface: 'arena', long: true } }).text()).toBe('Superficie: Arena y desierto');
  });

  it('las tarjetas de eventos sin superficie no cambian', () => {
    setup(WRC_NOW);
    const s = schedule();
    const wrapper = mount(EventCard, {
      props: { series: s.series.find((x) => x.id === 'tc')!, event: s.events.find((e) => e.id === 'ev-tc-sannicolas')!, items: [] },
      global: { plugins: [pinia, createRouter({ history: createMemoryHistory(), routes })] },
    });
    expect(wrapper.find('.surface-badge').exists()).toBe(false);
    expect(wrapper.find('.stage-day-line').exists()).toBe(false);
  });

  it('calendario de la categoría: superficie de cada fecha y "A confirmar" solo si no hay recorrido', async () => {
    setup(WRC_NOW);
    stubData();
    const wrapper = await mountAt(CategoryView, '/categoria/wrc?tab=calendario');
    expect(wrapper.get('.hero-sub').text()).toContain('Rally y rally raid');
    const rows = wrapper.findAll('.list-card .list-row');
    expect(rows.map((r) => r.get('.surface-badge').text().replace('Superficie: ', ''))).toEqual(['Asfalto', 'Nieve', 'Tierra', 'Mixto', 'Asfalto', 'Tierra']);
    expect(rows[4]!.text()).not.toContain('A confirmar');
    expect(rows[5]!.text()).toContain('A confirmar');

    const dakar = await mountAt(CategoryView, '/categoria/dakar?tab=calendario');
    const next = dakar.findAll('.list-card .list-row')[1]!;
    expect(next.text()).toContain('Dakar 2027');
    expect(next.get('.surface-badge').text()).toContain('Arena');
    expect(next.text()).not.toContain('A confirmar');
  });

  it('resumen de la categoría: el próximo Dakar no figura con "Horarios a confirmar"', async () => {
    setup(WRC_NOW);
    stubData();
    const wrapper = await mountAt(CategoryView, '/categoria/dakar');
    expect(wrapper.text()).toContain('Dakar 2027');
    expect(wrapper.text()).toContain('Empieza el sáb 2 de ene');
    expect(wrapper.text()).not.toContain('Horarios a confirmar');
  });

  it('Categorías agrupa "Rally y rally raid" entre Asia y las nacionales', async () => {
    setup(WRC_NOW);
    stubData();
    const wrapper = await mountAt(CategoriesView, '/categorias');
    expect(wrapper.findAll('.group-head strong').map((g) => g.text())).toEqual(['Fórmula 1 y soporte FIA', 'Rally y rally raid', 'Nacionales argentinas']);
    const groups = groupSeries(schedule().series.map((series) => ({ series })));
    expect(groups.find((g) => g.group === 'rally')!.items.map((i) => i.series.id)).toEqual(['wrc', 'dakar']);
  });

  it('"Empezá por acá" ofrece el WRC y el Dakar cuando están publicados', () => {
    const items = starterPack({ series: schedule().series, standings: {}, racingThisWeekend: ['wrc'] });
    const byId = new Map(items.map((i) => [i.id, i]));
    expect(byId.get('wrc')).toMatchObject({ kind: 'series', title: 'Campeonato Mundial de Rally (WRC)' });
    expect(byId.get('wrc')!.reason).toContain('corre este finde');
    expect(byId.get('dakar')).toMatchObject({ kind: 'series', title: 'Rally Dakar' });
    // Sin esas categorías en los datos, el paquete queda como estaba.
    const without = starterPack({ series: schedule().series.filter((s) => s.group !== 'rally'), standings: {} });
    expect(without.some((i) => i.id === 'wrc' || i.id === 'dakar')).toBe(false);
  });
});

describe('En vivo', () => {
  it('un bloque de tramos en curso muestra qué tramo se está corriendo y lleva al recorrido', async () => {
    setup(WRC_NOW);
    stubData();
    const wrapper = await mountAt(LiveView, '/en-vivo');
    const card = wrapper.get('.live-card');
    expect(card.text()).toContain('Etapa del viernes: SS2 a SS8');
    const link = card.get('a.stage-live-link');
    expect(link.attributes('href')).toBe('/evento/ev-wrc-japon?tab=etapas');
    expect(link.text()).toContain('En curso: SS4 · Shitara Town R 1');
    expect(link.text()).toContain('22,44 km');
    // Entre tramos (asistencia del mediodía) no inventa uno en curso.
    useScheduleStore().$patch({ now: '2026-11-13T02:30:00Z' });
    await flushPromises();
    expect(wrapper.get('a.stage-live-link').text()).toContain('Ver el recorrido');
  });
});

describe('tipo de sesión "etapa" en el resto de la app', () => {
  const sessions = (): Session[] => schedule().sessions.filter((s) => s.eventId === 'ev-wrc-japon');
  const src = { url: 'https://www.wrc.com/results', title: 'WRC', kind: 'html' as const, method: 'directo' as const, fetchedAt: '2026-11-15T08:00:00Z' };

  it('Contexto: formato y textos de un rally', () => {
    const wrc = eventOf('ev-wrc-japon');
    expect(isRallyEvent(wrc, sessions())).toBe(true);
    expect(isRallyEvent(eventOf('ev-tc-sannicolas'), [], 'argentina')).toBe(false);
    expect(isRallyEvent(eventOf('ev-tc-sannicolas'), [], 'rally')).toBe(true);
    expect(eventFormatText(wrc, sessions())).toBe('Rally por tramos cronometrados sobre asfalto · 4 días');
    expect(eventFormatText(eventOf('ev-dakar-2027'), [])).toBe('Rally raid por etapas sobre arena y desierto · 15 días');
    // Rally todavía sin recorrido ni horarios: solo la superficie.
    expect(eventFormatText(eventOf('ev-wrc-arabia'), [])).toBe('Rally sobre tierra');
    // Un evento de circuito sigue contando sus sesiones.
    const tc = schedule().sessions.filter((s) => s.eventId === 'ev-tc-sannicolas');
    expect(eventFormatText(eventOf('ev-tc-sannicolas'), tc)).toBe('1 práctica · 1 clasificación · 1 carrera');
    expect(eventFormatText(eventOf('ev-tc-laplata'), [])).toBe('');
    expect(timingLabel('before')).toBe('Tabla antes de la carrera');
    expect(timingLabel('before', true)).toBe('Tabla antes del rally');
    expect(timingLabel('unknown', true)).not.toContain('fin de semana');
  });

  it('Contexto: una categoría de una sola prueba por año no numera la fecha', () => {
    const events = schedule().events;
    expect(roundInfo(events, eventOf('ev-dakar-2027'))).toBeNull();
    expect(roundInfo(events, eventOf('ev-wrc-japon'))).toMatchObject({ n: 13, byCalendar: false });
  });

  it('Contexto: el primero de un bloque de tramos no es "el más rápido", y quien ganó, ganó el rally', () => {
    const file: EventResultsFile = {
      seriesId: 'wrc',
      eventId: 'ev-wrc-japon',
      updatedAt: '2026-11-15T08:00:00Z',
      sessions: [
        { sessionId: '7a11000000000001', rows: [{ pos: 1, driver: 'Kalle Rovanperä' }], source: src },
        { sessionId: '7a11000000000003', rows: [{ pos: 1, driver: 'Elfyn Evans' }], source: src },
        { sessionId: '7a11000000000006', rows: [{ pos: 1, driver: 'Sébastien Ogier' }], source: src },
      ],
    };
    const hl = highlights(file, sessions());
    expect(hl.map((h) => [h.sessionName, h.label])).toEqual([
      ['Shakedown', 'Más rápido'],
      ['Etapa del viernes: SS2 a SS8', 'Primero'],
      ['Power Stage (SS21)', 'Ganador'],
    ]);
    const winners = hl.filter((h) => h.label === 'Ganador');
    const base = { followed: { driverIds: [] }, tables: [], winnersHere: winners };
    expect(whoToWatch({ ...base, rally: true })[0]).toMatchObject({ name: 'Sébastien Ogier', reason: 'Ganó este rally' });
    expect(whoToWatch(base)[0]!.reason).toBe('Ganó esta carrera');
  });

  it('próximas carreras: en un rally importa cuándo larga cada día, no "la carrera"', () => {
    expect(mainRaceOf(sessions())).toBeUndefined();
    expect(upcomingWhen(sessions(), '2026-11-11T12:00:00Z', AR)).toEqual({ text: 'Shakedown · mié 11/11 21:01', live: false });
    expect(upcomingWhen(sessions(), WRC_NOW, AR)).toEqual({ text: 'En vivo: Etapa del viernes: SS2 a SS8', live: true });
    // La Power Stage sola (sin bloques de etapa) no convierte un evento en rally.
    expect(mainRaceOf(sessions().filter((s) => s.type === 'carrera'))?.name).toBe('Power Stage (SS21)');
  });

  it('resultados: las etapas van con las carreras y, sin resultado final, la principal es la última etapa', () => {
    expect(isRaceType('etapa')).toBe(true);
    const list = sessions();
    const results = [
      { sessionId: '7a11000000000001', rows: [{ pos: 1, driver: 'A' }] },
      { sessionId: '7a11000000000004', rows: [{ pos: 1, driver: 'C' }] },
      { sessionId: '7a11000000000003', rows: [{ pos: 1, driver: 'B' }] },
    ];
    expect(orderResultSessions(results, list).map((r) => r.sessionId)).toEqual(['7a11000000000003', '7a11000000000004', '7a11000000000001']);
    expect(mainResultSession(results, list)?.sessionId).toBe('7a11000000000004');
    const withFinal = [...results, { sessionId: '7a11000000000006', rows: [{ pos: 1, driver: 'D' }] }];
    expect(mainResultSession(withFinal, list)?.sessionId).toBe('7a11000000000006');
  });

  it('Google Calendar: una sesión de etapa se exporta como cualquier otra', () => {
    const s = schedule();
    const session = s.sessions.find((x) => x.id === '7a11000000000003')!;
    const expected = toExpectedEvent({ session, event: eventOf('ev-wrc-japon'), series: s.series.find((x) => x.id === 'wrc')! });
    expect(expected.label).toBe('Campeonato Mundial de Rally (WRC) · Etapa del viernes: SS2 a SS8');
    expect(expected.body.summary).toBe('Campeonato Mundial de Rally (WRC) (Toyota) - Etapa del viernes: SS2 a SS8');
    // 22:33Z del jueves es 19:33 en Argentina (hora de pared, sin corrimiento).
    expect(expected.body.start).toEqual({ dateTime: '2026-11-12T19:33:00', timeZone: AR });
    expect(expected.body.location).toBe('Toyota, Japón');
  });
});
