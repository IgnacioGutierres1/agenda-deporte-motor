/**
 * Carga directa en Google Calendar con el calendario de destino a elección: lista de calendarios de la cuenta,
 * elección guardada en el dispositivo y borrado de sobrantes limitado a lo que creó la app.
 */
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { ScheduleFile } from '@dm/shared';
import ExportView from '../src/views/ExportView.vue';
import SettingsView from '../src/views/SettingsView.vue';
import { routes } from '../src/router.ts';
import { CalendarApi, sortCalendars, type CalendarChoice } from '../src/gcal/api.ts';
import { auditCalendar, isAppEvent, type CalendarEvent } from '../src/gcal/audit.ts';
import { APP_MARK_KEY, toExpectedEvent, type ExpectedEvent } from '../src/gcal/mapping.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { PERSISTED_SETTINGS, useSettingsStore } from '../src/stores/settings.ts';
import { NOW, scheduleFixture, statusFixture } from './helpers.ts';

vi.mock('../src/gcal/gis.ts', () => ({
  getAccessToken: vi.fn(async () => 'token-de-prueba'),
  preloadGis: vi.fn(),
  forgetAccessToken: vi.fn(),
}));

const API = 'https://www.googleapis.com/calendar/v3';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function expectedFromFixture(): ExpectedEvent[] {
  const s: ScheduleFile = scheduleFixture();
  const series = new Map(s.series.map((x) => [x.id, x]));
  const events = new Map(s.events.map((x) => [x.id, x]));
  return s.sessions
    .filter((x) => x.eventId === 'ev-tc-sannicolas')
    .map((session) => toExpectedEvent({ session, event: events.get(session.eventId), series: series.get(session.seriesId)! }));
}

describe('calendarios de la cuenta', () => {
  it('lista solo los que admiten escritura, con el nombre que ve el usuario, en todas las páginas', async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        json({
          items: [
            { id: 'yo@gmail.com', summary: 'yo@gmail.com', summaryOverride: 'Personal', primary: true, accessRole: 'owner', backgroundColor: '#123456' },
            { id: 'borrado@group', summary: 'Viejo', deleted: true },
          ],
          nextPageToken: 'p2',
        }),
      )
      .mockResolvedValueOnce(json({ items: [{ id: 'dm@group', summary: 'Deporte Motor', accessRole: 'owner' }] }));
    const list = await new CalendarApi('tok', fetchFn).listWritableCalendars();
    expect(list).toEqual([
      { id: 'yo@gmail.com', name: 'Personal', primary: true, suggested: false, color: '#123456' },
      { id: 'dm@group', name: 'Deporte Motor', primary: false, suggested: true },
    ]);
    const first = new URL(String(fetchFn.mock.calls[0]![0]));
    expect(first.pathname).toBe('/calendar/v3/users/me/calendarList');
    expect(first.searchParams.get('minAccessRole')).toBe('writer');
    expect(new URL(String(fetchFn.mock.calls[1]![0])).searchParams.get('pageToken')).toBe('p2');
  });

  it('ordena: el sugerido, el principal y el resto por nombre', () => {
    const c = (name: string, extra: Partial<CalendarChoice> = {}): CalendarChoice => ({ id: name, name, primary: false, suggested: false, ...extra });
    const sorted = sortCalendars([c('Trabajo'), c('Personal', { primary: true }), c('Ánimo'), c('Deporte Motor', { suggested: true })]);
    expect(sorted.map((x) => x.name)).toEqual(['Deporte Motor', 'Personal', 'Ánimo', 'Trabajo']);
  });

  it('canWrite: sí con permiso de edición; no si se borró, perdió el permiso o ya no existe', async () => {
    const api = (body: unknown, status = 200) => new CalendarApi('tok', vi.fn<typeof fetch>().mockResolvedValue(json(body, status)));
    await expect(api({ id: 'a', accessRole: 'writer' }).canWrite('a')).resolves.toBe(true);
    await expect(api({ id: 'a', accessRole: 'owner' }).canWrite('a')).resolves.toBe(true);
    await expect(api({ id: 'a', accessRole: 'reader' }).canWrite('a')).resolves.toBe(false);
    await expect(api({ id: 'a', accessRole: 'owner', deleted: true }).canWrite('a')).resolves.toBe(false);
    await expect(api({ error: { message: 'Not Found' } }, 404).canWrite('a')).resolves.toBe(false);
    await expect(api({}, 500).canWrite('a')).rejects.toThrow();
  });
});

describe('eventos de la app en un calendario compartido con eventos propios', () => {
  it('cada evento que crea la app lleva su marca privada', () => {
    const [exp] = expectedFromFixture();
    expect(exp!.body.extendedProperties.private[APP_MARK_KEY]).toBe('1');
  });

  it('solo se ofrecen para borrar los sobrantes con la marca de la app, no los que apenas se le parecen', () => {
    const expected = expectedFromFixture();
    const mark = { extendedProperties: { private: { [APP_MARK_KEY]: '1' } } };
    const actual: CalendarEvent[] = [
      // Sobrante real: lo creó la app y ya no está en la agenda.
      { id: 'dm0000000000000099', summary: 'TC (X) - Vieja', start: { dateTime: '2026-11-14T10:00:00-03:00' }, ...mark },
      // Evento del usuario cuyo id de Google empieza con "dm" por casualidad.
      { id: 'dmk3v91pq0s7a2b4c6d8e0f1g3', summary: 'Turno con el dentista', start: { dateTime: '2026-11-14T11:00:00-03:00' } },
      // Marca sin el prefijo de la app (otro programa pudo copiar la propiedad): tampoco.
      { id: 'zz0000000000000001', summary: 'Otro', ...mark },
    ];
    expect(isAppEvent(actual[0]!)).toBe(true);
    expect(isAppEvent(actual[1]!)).toBe(false);
    expect(isAppEvent(actual[2]!)).toBe(false);
    expect(auditCalendar(expected, actual).extras.map((e) => e.summary)).toEqual(['TC (X) - Vieja']);
  });
});

describe('Exportar: elegir el calendario de destino', () => {
  let pinia: Pinia;
  let wrapper: VueWrapper | undefined;
  const calls: Array<{ method: string; url: string }> = [];
  /** Lo que tiene la cuenta de Google de mentira; cada prueba lo ajusta. */
  let account: { calendars: Array<Record<string, unknown>>; missing: string[] };

  const fakeGoogle = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (!url.startsWith(API)) return new Response('', { status: 200, headers: { 'Content-Type': 'text/calendar' } });
    const path = decodeURIComponent(new URL(url).pathname.slice('/calendar/v3'.length));
    if (path === '/users/me/calendarList') return json({ items: account.calendars });
    const entry = /^\/users\/me\/calendarList\/(.+)$/.exec(path);
    if (entry) {
      const cal = account.calendars.find((c) => c.id === entry[1]);
      return cal && !account.missing.includes(entry[1]!) ? json(cal) : json({ error: { message: 'Not Found' } }, 404);
    }
    if (/^\/calendars\/[^/]+\/events$/.test(path)) return method === 'POST' ? json({ id: 'x' }) : json({ items: [] });
    return json({ error: { message: `sin respuesta para ${path}` } }, 500);
  });

  const mountExport = async () => {
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/exportar');
    wrapper = mount(ExportView, { global: { plugins: [pinia, router], stubs: { teleport: true } }, attachTo: document.body });
    await flushPromises();
    return wrapper;
  };
  const button = (w: VueWrapper, text: string) => w.findAll('button').find((b) => b.text().includes(text))!;
  const pickerRows = (w: VueWrapper) => w.findAll('[data-test="gcal-picker"] button');
  const inserts = () => calls.filter((c) => c.method === 'POST' && c.url.includes('/events'));

  beforeEach(() => {
    pinia = createPinia();
    setActivePinia(pinia);
    useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
    useSettingsStore().$patch({ googleClientId: '123-abc.apps.googleusercontent.com' });
    calls.length = 0;
    account = {
      calendars: [
        { id: 'yo@gmail.com', summary: 'yo@gmail.com', summaryOverride: 'Personal', primary: true, accessRole: 'owner' },
        { id: 'carreras@group.calendar.google.com', summary: 'Carreras', accessRole: 'owner' },
        { id: 'dm@group.calendar.google.com', summary: 'Deporte Motor', accessRole: 'owner' },
      ],
      missing: [],
    };
    document.body.innerHTML = '';
    vi.stubGlobal('fetch', fakeGoogle);
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.unstubAllGlobals();
  });

  it('la primera vez muestra los calendarios de la cuenta; al elegir uno, lo guarda y carga ahí', async () => {
    const w = await mountExport();
    expect(w.get('[data-test="gcal-target"]').text()).toContain('La primera vez elegís');
    await button(w, 'Cargar en Google Calendar').trigger('click');
    await flushPromises();
    // Lista con el sugerido primero y el principal después; todavía no se cargó nada.
    expect(pickerRows(w).map((r) => r.text().replace(/\s+/g, ' '))).toEqual(['Deporte Motor sugerido', 'Personal principal', 'Carreras']);
    expect(inserts()).toHaveLength(0);

    await pickerRows(w)[2]!.trigger('click');
    await flushPromises();
    expect(useSettingsStore().gcalCalendar).toEqual({ id: 'carreras@group.calendar.google.com', name: 'Carreras' });
    expect(inserts().length).toBeGreaterThan(0);
    expect(inserts().every((c) => c.url.startsWith(`${API}/calendars/${encodeURIComponent('carreras@group.calendar.google.com')}/events`))).toBe(true);
    expect(w.get('[data-test="gcal-target"]').text()).toContain('Se carga en tu calendario Carreras');
    expect(w.text()).toContain('Calendario elegido: "Carreras".');
    expect(w.find('[data-test="gcal-picker"]').exists()).toBe(false);
  });

  it('la elección se guarda en el dispositivo y la vez siguiente carga sin volver a preguntar', async () => {
    expect(PERSISTED_SETTINGS).toContain('gcalCalendar');
    useSettingsStore().setGcalCalendar({ id: 'dm@group.calendar.google.com', name: 'Deporte Motor' });
    const w = await mountExport();
    await button(w, 'Cargar en Google Calendar').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="gcal-picker"]').exists()).toBe(false);
    expect(calls.some((c) => c.url === `${API}/users/me/calendarList`)).toBe(false);
    expect(inserts().length).toBeGreaterThan(0);
    // La comprobación de que el calendario sigue ahí se hace una sola vez por sesión.
    const checks = () => calls.filter((c) => c.url.includes('/users/me/calendarList/')).length;
    expect(checks()).toBe(1);
    await button(w, 'Solo auditar').trigger('click');
    await flushPromises();
    expect(checks()).toBe(1);
  });

  it('cerrar la lista sin elegir no carga nada', async () => {
    const w = await mountExport();
    await button(w, 'Cargar en Google Calendar').trigger('click');
    await flushPromises();
    await w.get('[aria-label="Cerrar"]').trigger('click');
    await flushPromises();
    expect(useSettingsStore().gcalCalendar).toBeNull();
    expect(inserts()).toHaveLength(0);
    expect(w.text()).toContain('No se eligió ningún calendario');
  });

  it('si el calendario elegido ya no está en la cuenta, avisa y pide elegir otro antes de cargar', async () => {
    useSettingsStore().setGcalCalendar({ id: 'borrado@group.calendar.google.com', name: 'Viejo' });
    const w = await mountExport();
    await button(w, 'Cargar en Google Calendar').trigger('click');
    await flushPromises();
    expect(pickerRows(w)).toHaveLength(3);
    expect(inserts()).toHaveLength(0);
    await pickerRows(w)[0]!.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('El calendario "Viejo" ya no está en tu cuenta');
    expect(useSettingsStore().gcalCalendar?.name).toBe('Deporte Motor');
    expect(inserts().every((c) => c.url.includes(encodeURIComponent('dm@group.calendar.google.com')))).toBe(true);
  });

  it('"Cambiar" vuelve a mostrar la lista: elegir otro lo reemplaza; cerrar deja el que estaba', async () => {
    useSettingsStore().setGcalCalendar({ id: 'dm@group.calendar.google.com', name: 'Deporte Motor' });
    const w = await mountExport();
    await w.get('[data-test="gcal-change"]').trigger('click');
    await flushPromises();
    // El actual aparece marcado en la lista.
    expect(pickerRows(w)[0]!.find('svg').exists()).toBe(true);
    await w.get('[aria-label="Cerrar"]').trigger('click');
    await flushPromises();
    expect(useSettingsStore().gcalCalendar?.name).toBe('Deporte Motor');
    expect(w.text()).not.toContain('No se eligió');

    await w.get('[data-test="gcal-change"]').trigger('click');
    await flushPromises();
    await pickerRows(w)[1]!.trigger('click');
    await flushPromises();
    expect(useSettingsStore().gcalCalendar).toEqual({ id: 'yo@gmail.com', name: 'Personal' });
    // Cambiar de calendario no carga nada por sí solo.
    expect(inserts()).toHaveLength(0);
  });

  it('Ajustes muestra el calendario elegido y permite olvidarlo', async () => {
    useSettingsStore().setGcalCalendar({ id: 'yo@gmail.com', name: 'Personal' });
    const router = createRouter({ history: createMemoryHistory(), routes });
    await router.push('/ajustes');
    wrapper = mount(SettingsView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    // La sección de Google está dentro de "Avanzado", que arranca cerrada.
    await wrapper.get('.advanced-toggle').trigger('click');
    const chosen = wrapper.get('[data-test="gcal-chosen"]');
    expect(chosen.text()).toContain('Personal');
    await chosen.get('button').trigger('click');
    expect(useSettingsStore().gcalCalendar).toBeNull();
    expect(wrapper.find('[data-test="gcal-chosen"]').exists()).toBe(false);
  });
});
