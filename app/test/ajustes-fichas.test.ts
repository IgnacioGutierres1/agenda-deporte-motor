import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { Session, Team, TeamsFile } from '@dm/shared';
import ExportView from '../src/views/ExportView.vue';
import FollowingView from '../src/views/FollowingView.vue';
import SettingsView from '../src/views/SettingsView.vue';
import TeamView from '../src/views/TeamView.vue';
import { routes } from '../src/router.ts';
import { persistStore } from '../src/lib/storage.ts';
import { teamRoster } from '../src/lib/teams.ts';
import { mainRaceOf, shortSessionName, upcomingWhen } from '../src/lib/upcoming.ts';
import { commonSeason, standingsSeason } from '../src/lib/season.ts';
import { PERSISTED_SETTINGS, migrateSettings, useSettingsStore } from '../src/stores/settings.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { useTeamsStore } from '../src/stores/teams.ts';
import { NOW, scheduleFixture, statusFixture } from './helpers.ts';

const AR = 'America/Argentina/Buenos_Aires';
let pinia: Pinia;
const makeRouter = () => createRouter({ history: createMemoryHistory(), routes });

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
  window.localStorage.clear();
});

afterEach(() => vi.unstubAllGlobals());

describe('tema', () => {
  it('por defecto sigue al sistema; elegir uno a mano queda marcado', () => {
    const s = useSettingsStore();
    expect(s.theme).toBe('system');
    expect(s.themeChosen).toBe(false);
    s.setTheme('dark');
    expect(s.theme).toBe('dark');
    expect(s.themeChosen).toBe(true);
  });

  it('migración: quien ya usaba la app sigue con el tema que tenía (Oscuro incluido)', () => {
    expect(migrateSettings({ theme: 'dark', timeZone: AR })).toEqual({ theme: 'dark', themeChosen: true, timeZone: AR });
    // Claro y Según el sistema no eran el predeterminado: los eligió el usuario.
    expect(migrateSettings({ theme: 'light' })).toEqual({ theme: 'light', themeChosen: true });
    expect(migrateSettings({ theme: 'system' })).toEqual({ theme: 'system', themeChosen: false });
    // Ya migrado y elegido a mano: se respeta.
    expect(migrateSettings({ theme: 'dark', themeChosen: true })).toEqual({ theme: 'dark', themeChosen: true });
    // Sin tema guardado: nada que migrar.
    expect(migrateSettings({ timeZone: AR })).toEqual({ timeZone: AR });
  });

  it('persistStore aplica la migración al restaurar y guarda la marca', () => {
    window.localStorage.setItem('dm:settings', JSON.stringify({ theme: 'light', followedSeries: ['tc'] }));
    const s = useSettingsStore();
    persistStore(s, PERSISTED_SETTINGS, migrateSettings);
    expect(s.theme).toBe('light');
    expect(s.followedSeries).toEqual(['tc']);

    const pinia2 = createPinia();
    setActivePinia(pinia2);
    window.localStorage.setItem('dm:settings', JSON.stringify({ theme: 'dark', followedSeries: ['tc'] }));
    const legacy = useSettingsStore();
    persistStore(legacy, PERSISTED_SETTINGS, migrateSettings);
    expect(legacy.theme).toBe('dark');
    legacy.setTheme('system');
    // Se guarda en el próximo cambio (subscribe sincrónico de Pinia en modo "detached").
    return flushPromises().then(() => {
      expect(JSON.parse(window.localStorage.getItem('dm:settings')!)).toMatchObject({ theme: 'system', themeChosen: true });
    });
  });
});

describe('Ajustes', () => {
  const mountSettings = async () => {
    const router = makeRouter();
    await router.push('/ajustes');
    const wrapper = mount(SettingsView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return wrapper;
  };

  it('categorías visibles: grupos cerrados con Todas/Ninguna (las desactivadas no se tocan)', async () => {
    const wrapper = await mountSettings();
    expect(wrapper.text()).toContain('Categorías visibles en la agenda');
    expect(wrapper.text()).toContain('★ Seguir');
    // Cerrados: no hay casillas hasta abrir un grupo.
    expect(wrapper.findAll('input[type="checkbox"]')).toHaveLength(0);

    const settings = useSettingsStore();
    await wrapper.get('button[aria-label="Ocultar todas: Nacionales argentinas"]').trigger('click');
    expect([...settings.hiddenSeries].sort()).toEqual(['tc', 'tc-pista', 'turismo-nacional']); // top-race está desactivada
    const head = wrapper.findAll('.settings-group-toggle').find((b) => b.text().includes('Nacionales argentinas'))!;
    expect(head.text()).toContain('0 de 3 visibles');

    await head.trigger('click');
    expect(head.attributes('aria-expanded')).toBe('true');
    const boxes = wrapper.findAll('input[type="checkbox"]');
    expect(boxes).toHaveLength(4);
    const enabledBoxes = boxes.map((b) => b.element as HTMLInputElement).filter((b) => !b.disabled);
    expect(enabledBoxes).toHaveLength(3);
    expect(enabledBoxes.every((b) => !b.checked)).toBe(true);

    await wrapper.get('button[aria-label="Mostrar todas: Nacionales argentinas"]').trigger('click');
    expect(settings.hiddenSeries).toEqual([]);
  });

  it('lo técnico va en "Avanzado (dueño de la app)", cerrado; el texto de Forzar coincide con el botón', async () => {
    const wrapper = await mountSettings();
    expect(wrapper.find('input[type="password"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('Client ID de Google');
    const toggle = wrapper.get('.advanced-toggle');
    expect(toggle.text()).toContain('Avanzado (dueño de la app)');
    await toggle.trigger('click');
    expect(wrapper.find('input[type="password"]').exists()).toBe(true);
    expect(wrapper.text()).toContain('Client ID de Google');
    expect(wrapper.text()).toContain('"Forzar actualización"');

    useSettingsStore().$patch({ githubToken: 'github_pat_x', githubRepo: 'yo/repo' });
    await flushPromises();
    const force = wrapper.findAll('button').find((b) => b.text() === 'Forzar actualización');
    expect(force).toBeTruthy();
  });

  it('tema: "Según el sistema" primero y activo por defecto', async () => {
    const wrapper = await mountSettings();
    const radios = wrapper.findAll('[role="radio"]');
    expect(radios.map((r) => r.text())).toEqual(['Según el sistema', 'Oscuro', 'Claro']);
    expect(radios[0]!.attributes('aria-checked')).toBe('true');
    await radios[2]!.trigger('click');
    expect(useSettingsStore()).toMatchObject({ theme: 'light', themeChosen: true });
  });
});

describe('Exportar sin Client ID de Google', () => {
  it('oculta "Cargar en Google Calendar" y ofrece la suscripción', async () => {
    const router = makeRouter();
    await router.push('/exportar');
    const wrapper = mount(ExportView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.text()).not.toContain('Cargar en Google Calendar');
    expect(wrapper.text()).toContain('no está configurada');
    expect(wrapper.get('.subscribe-card a.btn-primary').attributes('href')).toMatch(/^webcal:\/\/.*deporte-motor\.ics$/);

    useSettingsStore().$patch({ googleClientId: '123-abc.apps.googleusercontent.com' });
    await flushPromises();
    expect(wrapper.text()).toContain('Cargar en Google Calendar');
  });
});

describe('Siguiendo: ?tab= en la misma ruta', () => {
  it('cambia de pestaña cuando solo cambia la query', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 404 })));
    const router = makeRouter();
    await router.push('/siguiendo');
    const wrapper = mount(FollowingView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    const active = () => wrapper.get('[role="tab"][aria-selected="true"]').text();
    expect(active()).toBe('Categorías');
    await router.push('/siguiendo?tab=equipos');
    await flushPromises();
    expect(active()).toBe('Equipos');
    await router.push('/siguiendo?tab=pilotos');
    await flushPromises();
    expect(active()).toBe('Pilotos');
    await router.push('/siguiendo');
    await flushPromises();
    expect(active()).toBe('Categorías');
  });
});

const wrt: Team = {
  id: 'team-wrt',
  name: 'Team WRT',
  entries: [
    { seriesId: 'f2', table: 'Equipos', pos: 1, points: 152.5, numbers: ['31', '46'] },
    { seriesId: 'motogp', numbers: ['32'] },
  ],
  drivers: [
    { id: 'rossi-valentino', name: 'Valentino Rossi', seriesId: 'f2', number: '46' },
    { id: 'charles-weerts', name: 'Charles Weerts', seriesId: 'f2', number: '31' },
    // El mismo piloto en dos autos de la misma categoría (lista de inscriptos por carrera): una sola fila.
    { id: 'rossi-valentino', name: 'Valentino Rossi', seriesId: 'f2', number: '31' },
    { id: 'charles-weerts', name: 'Charles Weerts', seriesId: 'f2', number: '31' },
    { id: 'rossi-valentino', name: 'Valentino Rossi', seriesId: 'motogp', number: '32' },
  ],
};

describe('ficha de equipo', () => {
  it('plantel por categoría, sin pilotos repetidos y con sus números', () => {
    expect(teamRoster(wrt)).toEqual([
      {
        seriesId: 'f2',
        drivers: [
          { id: 'charles-weerts', name: 'Charles Weerts', numbers: ['31'] },
          { id: 'rossi-valentino', name: 'Valentino Rossi', numbers: ['31', '46'] },
        ],
      },
      { seriesId: 'motogp', drivers: [{ id: 'rossi-valentino', name: 'Valentino Rossi', numbers: ['32'] }] },
    ]);
  });

  it('"Próximas carreras" antes del plantel; solo la primera categoría abierta', async () => {
    const file: TeamsFile = { version: 1, generatedAt: NOW, teams: [wrt] };
    useTeamsStore().$patch({ file, status: 'ok' });
    const router = makeRouter();
    await router.push('/equipo/team-wrt');
    const wrapper = mount(TeamView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(wrapper.findAll('.card-title').map((h) => h.text())).toEqual(['Categorías', 'Próximas carreras', 'Pilotos']);

    const heads = wrapper.findAll('.roster-head');
    expect(heads.map((h) => h.attributes('aria-expanded'))).toEqual(['true', 'false']);
    expect(heads[0]!.text()).toContain('2 pilotos');
    expect(wrapper.findAll('.roster-list li')).toHaveLength(2);
    expect(wrapper.get('.roster-list').text()).toContain('#31#46');

    await heads[1]!.trigger('click');
    expect(wrapper.findAll('.roster-list')).toHaveLength(2);
    await heads[0]!.trigger('click');
    expect(wrapper.findAll('.roster-list')).toHaveLength(1);
  });
});

describe('próximas carreras: la hora de la carrera', () => {
  const sessionsOf = (seriesId: string) => scheduleFixture().sessions.filter((s) => s.seriesId === seriesId);
  const s = (over: Partial<Session>): Session =>
    ({ id: over.name ?? 'x', eventId: 'e', seriesId: 'x', type: 'practica', name: 'x', startUtc: '', endUtc: '', endEstimated: false, broadcast: [], broadcastIsDefault: false, source: { kind: 'html', url: '' }, ...over }) as Session;

  it('carrera primero y después la próxima sesión ("Carrera dom 29/11 13:00 · P1 vie 10:30")', () => {
    expect(upcomingWhen(sessionsOf('f1'), NOW, AR)).toEqual({ text: 'Carrera dom 29/11 13:00 · P1 vie 10:30', live: false });
  });

  it('si la próxima sesión es la carrera, solo la carrera', () => {
    expect(upcomingWhen(sessionsOf('motogp'), NOW, AR)).toEqual({ text: 'Carrera dom 15/11 10:00', live: false });
  });

  it('en vivo: la sesión que corre y la hora de la carrera', () => {
    expect(upcomingWhen(sessionsOf('tc'), NOW, AR)).toEqual({ text: 'En vivo: Clasificación · Carrera dom 15/11 13:00', live: true });
  });

  it('carrera principal: la última "carrera"; si no hay, la última sprint', () => {
    const list = [
      s({ name: 'Sprint', type: 'sprint', startUtc: '2026-11-21T10:00:00Z' }),
      s({ name: 'Carrera 2', type: 'carrera', startUtc: '2026-11-22T15:00:00Z' }),
      s({ name: 'Carrera 1', type: 'carrera', startUtc: '2026-11-22T12:00:00Z' }),
    ];
    expect(mainRaceOf(list)?.name).toBe('Carrera 2');
    expect(mainRaceOf(list.slice(0, 1))?.name).toBe('Sprint');
    expect(mainRaceOf([s({ type: 'practica' })])).toBeUndefined();
  });

  it('sin carrera (test): la próxima sesión como antes', () => {
    const list = [s({ name: 'Day 1', startUtc: '2026-11-20T10:00:00Z', endUtc: '2026-11-20T18:00:00Z' })];
    expect(upcomingWhen(list, NOW, AR)).toEqual({ text: 'Day 1 · vie 20/11 07:00', live: false });
    expect(upcomingWhen(list, '2026-12-01T00:00:00Z', AR)).toBeNull();
  });

  it('nombres cortos', () => {
    expect(shortSessionName({ type: 'practica', name: 'Práctica Libre 1' })).toBe('P1');
    expect(shortSessionName({ type: 'practica', name: 'Free Practice 2' })).toBe('P2');
    expect(shortSessionName({ type: 'practica', name: 'Day 2' })).toBe('Day 2');
    expect(shortSessionName({ type: 'clasificacion', name: 'Clasificación Q2' })).toBe('Q2');
    expect(shortSessionName({ type: 'clasificacion', name: 'Clasificación' })).toBe('Clasificación');
  });
});

describe('ficha de piloto: año del campeonato', () => {
  it('el de la última fecha disputada de la categoría, o el del archivo de la tabla si ya está cargado', () => {
    const schedule = scheduleFixture();
    // F1 ya corrió en 2026 (fixture): 2026, aunque los datos se generen en 2027.
    const past = { ...schedule, events: [...schedule.events, { ...schedule.events[0]!, id: 'f1-old', dateStart: '2026-03-01', dateEnd: '2026-03-03' }] };
    expect(standingsSeason(past, 'f1', '2027-01-10T12:00:00Z')).toBe(2026);
    // Sin ninguna fecha disputada no se sabe (IMSA en enero, con solo el calendario nuevo).
    expect(standingsSeason(schedule, 'nascar-cup', NOW)).toBeNull();
    expect(standingsSeason(schedule, 'nascar-cup', NOW, 2026)).toBe(2026);
  });

  it('el título lleva año solo si todas las tablas son de la misma temporada', () => {
    expect(commonSeason([2026, 2026])).toBe(2026);
    expect(commonSeason([2026, 2027])).toBeNull();
    expect(commonSeason([2026, null])).toBeNull();
    expect(commonSeason([])).toBeNull();
  });
});
