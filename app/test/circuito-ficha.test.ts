import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import type { CircuitInfo, CircuitsFile, CircuitTrackFile, MotorEvent } from '@dm/shared';
import CircuitFigure from '../src/components/CircuitFigure.vue';
import ContextPanel from '../src/components/ContextPanel.vue';
import TrackOutline from '../src/components/TrackOutline.vue';
import CircuitView from '../src/views/CircuitView.vue';
import CircuitsView from '../src/views/CircuitsView.vue';
import SearchView from '../src/views/SearchView.vue';
import { routes } from '../src/router.ts';
import { buildCircuits } from '../src/lib/circuits.ts';
import {
  circuitFacts,
  circuitShortFacts,
  circuitsByCountry,
  commonsThumb,
  dateRangeWithYear,
  hasCircuitHighlights,
  httpUrl,
  imageCredit,
  lapRecordDetail,
  lapRecordShort,
  lengthKm,
  mapLinks,
  thousands,
  trackDrawable,
  trackScale,
} from '../src/lib/circuitInfo.ts';
import { refreshEverything } from '../src/lib/refresh.ts';
import { useCircuitInfoStore } from '../src/stores/circuitInfo.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { NOW, fixture, scheduleFixture, statusFixture } from './helpers.ts';

const circuitsFile = (): CircuitsFile => fixture<CircuitsFile>('circuits.json');
const trackFile = (): CircuitTrackFile => fixture<CircuitTrackFile>('tracks/lusail.json');
const infoOf = (id: string): CircuitInfo => circuitsFile().circuits.find((c) => c.id === id)!;

let pinia: Pinia;
let requested: string[];

const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

/** Sirve los fixtures de circuitos; todo lo demás (tablas, noticias…) no existe. */
function stubData(opts: { circuits?: boolean; track?: boolean } = {}) {
  const { circuits = true, track = true } = opts;
  requested = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = String(input);
      requested.push(url);
      if (circuits && url.endsWith('data/circuits.json')) return json(circuitsFile());
      if (track && url.endsWith('data/tracks/lusail.json')) return json(trackFile());
      return new Response('no', { status: 404 });
    }),
  );
}

const trackRequests = () => requested.filter((u) => u.includes('/tracks/'));

function makeRouter() {
  return createRouter({ history: createMemoryHistory(), routes });
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
  requested = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('ficha de circuito: textos y cálculos', () => {
  it('longitud en km con tres decimales y separador de miles', () => {
    expect(lengthKm(5419)).toBe('5,419 km');
    expect(lengthKm(4000)).toBe('4,000 km');
    expect(lengthKm(20832)).toBe('20,832 km');
    expect(thousands(125000)).toBe('125.000');
    expect(thousands(9500)).toBe('9.500');
    expect(thousands(800)).toBe('800');
  });

  it('la ficha solo trae los datos que existen, en orden, con el récord al final', () => {
    const facts = circuitFacts(infoOf('lusail'));
    expect(facts.map((f) => f.key)).toEqual(['length', 'turns', 'direction', 'opened', 'capacity', 'elevation', 'city', 'record']);
    expect(facts.map((f) => f.value)).toEqual(['5,419 km', '16', 'Horario', '2004', '52.000 personas', '12 m s. n. m.', 'Lusail', '1:22.384']);
    expect(facts.at(-1)).toMatchObject({ detail: 'Lando Norris · McLaren MCL38 · 2024 · F1', wide: true });
    // Circuito con pocos datos: nada de renglones vacíos.
    expect(circuitFacts(infoOf('san-nicolas')).map((f) => f.label)).toEqual(['Longitud', 'Sentido', 'Inauguración', 'Ciudad']);
    expect(circuitFacts(infoOf('goiania')).map((f) => f.key)).toEqual(['city']);
    expect(circuitFacts({ id: 'x', name: 'X', checkedAt: NOW })).toEqual([]);
    // Datos inválidos no se muestran; la altitud 0 sí (nivel del mar).
    expect(circuitFacts({ id: 'x', name: 'X', checkedAt: NOW, lengthM: 0, turns: -1, elevationM: 0 }).map((f) => f.key)).toEqual(['elevation']);
  });

  it('récord de vuelta: detalle completo y versión corta', () => {
    const record = infoOf('lusail').lapRecord!;
    expect(lapRecordDetail(record)).toBe('Lando Norris · McLaren MCL38 · 2024 · F1');
    expect(lapRecordShort(record)).toBe('1:22.384 · Lando Norris (2024)');
    expect(lapRecordShort({ time: '1:30.000' })).toBe('1:30.000');
    expect(lapRecordShort({ time: '1:30.000', year: 2019 })).toBe('1:30.000 · 2019');
    expect(lapRecordDetail({ time: '1:30.000' })).toBe('');
    expect(circuitShortFacts(infoOf('lusail'))).toBe('5,419 km · 16 curvas');
    expect(circuitShortFacts(infoOf('goiania'))).toBe('');
    expect(hasCircuitHighlights(infoOf('ricardo-tormo'))).toBe(true);
    expect(hasCircuitHighlights(infoOf('goiania'))).toBe(false);
  });

  it('links a mapas con las coordenadas; con las de la ciudad, más alejado', () => {
    expect(mapLinks(infoOf('lusail'))).toEqual({
      directions: 'https://www.google.com/maps/dir/?api=1&destination=25.49000,51.45420',
      map: 'https://www.openstreetmap.org/?mlat=25.49000&mlon=51.45420#map=15/25.49000/51.45420',
    });
    expect(mapLinks(infoOf('goiania'))!.map).toContain('#map=12/-16.68690/-49.26480');
    expect(mapLinks({})).toBeNull();
    expect(mapLinks({ lat: 0, lon: 0 })).toBeNull();
    expect(mapLinks({ lat: 95, lon: 10 })).toBeNull();
  });

  it('atribución de imágenes y links solo web', () => {
    expect(imageCredit(infoOf('lusail').map!)).toBe('Will Pittenger, Gpmat · CC BY-SA 3.0');
    expect(imageCredit({ url: 'https://x', credit: '', license: 'Dominio público', page: '' })).toBe('Dominio público');
    expect(httpUrl('https://es.wikipedia.org/wiki/X')).toBe('https://es.wikipedia.org/wiki/X');
    expect(httpUrl('javascript:alert(1)')).toBe('');
    expect(httpUrl(undefined)).toBe('');
  });

  it('miniaturas de Commons: pide un ancho estándar más chico y no toca lo que no reconoce', () => {
    const thumb = infoOf('ricardo-tormo').map!.url;
    expect(commonsThumb(thumb, 120)).toBe(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/a/a2/Valencia_%28Ricardo_Tormo%29_track_map.svg/120px-Valencia_%28Ricardo_Tormo%29_track_map.svg.png',
    );
    expect(commonsThumb(infoOf('lusail').map!.url, 200)).toContain('/250px-Lusail_International_Circuit_2023.svg.png');
    // Nunca agranda, ni toca un archivo original u otro servidor.
    expect(commonsThumb(thumb, 2000)).toBe(thumb);
    expect(commonsThumb(thumb.replace('960px', '120px'), 250)).toBe(thumb.replace('960px', '120px'));
    const original = infoOf('ricardo-tormo').photo!.url;
    expect(commonsThumb(original, 120)).toBe(original);
    expect(commonsThumb('https://example.org/thumb/a/960px-x.png', 120)).toBe('https://example.org/thumb/a/960px-x.png');
  });

  it('escala del trazado: un largo redondo que no pase del 30 % del ancho', () => {
    const track = trackFile();
    const scale = trackScale(track)!;
    expect(scale).toMatchObject({ meters: 500, label: '500 m' });
    expect(scale.units).toBeCloseTo(500 / track.metersPerUnit!, 5);
    expect(scale.units / track.width).toBeLessThanOrEqual(0.3);
    expect(trackScale({ width: 1000, metersPerUnit: 8 })).toMatchObject({ meters: 2000, label: '2 km' });
    expect(trackScale({ width: 1000, metersPerUnit: 0.5 })).toMatchObject({ meters: 100, label: '100 m' });
    expect(trackScale({ width: 1000 })).toBeNull();
    expect(trackDrawable(track)).toBe(true);
    expect(trackDrawable({ ...track, paths: [] })).toBe(false);
    expect(trackDrawable({ ...track, width: 0 })).toBe(false);
    expect(trackDrawable(undefined)).toBe(false);
  });

  it('agrupa los circuitos por país (Argentina primero) con su próxima fecha', () => {
    const schedule = scheduleFixture();
    const enabled = new Set(schedule.series.filter((s) => s.enabled).map((s) => s.id));
    const circuits = buildCircuits(schedule.events.filter((e) => enabled.has(e.seriesId)));
    const byId = new Map(circuitsFile().circuits.map((c) => [c.id, c]));
    const groups = circuitsByCountry(circuits, byId, (e: MotorEvent) => e.dateEnd >= '2026-11-14');
    expect(groups.map((g) => g.label)).toEqual(['Argentina', 'Brasil', 'EE.UU.', 'España', 'Qatar']);
    const qatar = groups.at(-1)!.rows[0]!;
    expect(qatar.circuit.id).toBe('lusail');
    expect(qatar.info?.name).toBe('Circuito Internacional de Losail');
    expect(qatar.next?.id).toBe('ev-f1-qatar');
    // Sin ficha y sin fechas próximas: la fila existe igual.
    const later = circuitsByCountry(circuits, new Map(), () => false);
    expect(later.flatMap((g) => g.rows).every((r) => !r.info && !r.next)).toBe(true);
    expect(dateRangeWithYear('2026-11-27', '2026-11-29', '2026')).toBe('27–29/11');
    expect(dateRangeWithYear('2027-02-14', '2027-02-14', '2026')).toBe('14/2/2027');
  });
});

describe('store de fichas: trazados a pedido', () => {
  it('pide cada trazado una sola vez y recuerda los que no existen', async () => {
    stubData();
    const store = useCircuitInfoStore();
    await Promise.all([store.loadTrack('lusail'), store.loadTrack('lusail')]);
    await store.loadTrack('lusail');
    expect(trackRequests()).toHaveLength(1);
    expect(store.tracks.lusail?.status).toBe('ok');
    expect(store.tracks.lusail?.data?.paths).toHaveLength(1);
    await store.loadTrack('daytona');
    await store.loadTrack('daytona');
    expect(store.tracks.daytona?.status).toBe('missing');
    expect(trackRequests()).toHaveLength(2);
  });

  it('"Actualizar" vuelve a pedir fichas y trazados abiertos; si falla la red, quedan los que había', async () => {
    stubData();
    const store = useCircuitInfoStore();
    await store.load();
    await store.loadTrack('lusail');
    requested = [];
    await refreshEverything();
    expect(requested.some((u) => u.endsWith('data/circuits.json'))).toBe(true);
    expect(trackRequests()).toHaveLength(1);

    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    await store.reloadLoaded();
    expect(store.status).toBe('ok');
    expect(store.byId.get('lusail')?.hasTrack).toBe(true);
    expect(store.tracks.lusail?.status).toBe('ok');
  });

  it('sin circuits.json queda "missing" y un reintento no vuelve a "cargando"', async () => {
    stubData({ circuits: false });
    const store = useCircuitInfoStore();
    await store.load();
    expect(store.status).toBe('missing');
    expect(store.pending).toBe(false);
    const retry = store.load(true);
    expect(store.status).toBe('missing');
    await retry;
    expect(store.status).toBe('missing');
  });
});

describe('TrackOutline', () => {
  it('dibuja la pista gruesa, lo secundario fino, la escala y el crédito de OpenStreetMap', () => {
    const track = trackFile();
    const wrapper = mount(TrackOutline, { props: { track, name: 'Lusail' } });
    const svg = wrapper.get('svg');
    expect(svg.attributes('viewBox')).toBe(`0 0 ${track.width} ${track.height}`);
    expect(svg.attributes('aria-label')).toBe('Trazado de Lusail');
    expect(wrapper.findAll('path.track-main').map((p) => p.attributes('d'))).toEqual(track.paths);
    expect(wrapper.findAll('path.track-secondary').map((p) => p.attributes('d'))).toEqual(track.secondary);
    expect(wrapper.get('.track-scale').text()).toBe('Escala: 500 m');
    expect(wrapper.get('.track-scale').attributes('style')).toMatch(/width: 29\.\d+%/);
    const credit = wrapper.get('.track-credit');
    expect(credit.text()).toContain('© Colaboradores de OpenStreetMap');
    expect(credit.text()).toContain('ODbL');
    expect(credit.get('a').attributes('href')).toBe('https://www.openstreetmap.org/copyright');
  });

  it('en miniatura deja solo el dibujo; sin metersPerUnit no hay escala', () => {
    const noScale = trackFile();
    delete noScale.metersPerUnit;
    const mini = mount(TrackOutline, { props: { track: trackFile(), mini: true } });
    expect(mini.find('.track-scale').exists()).toBe(false);
    expect(mini.find('.track-credit').exists()).toBe(false);
    expect(mini.findAll('path')).toHaveLength(2);
    const full = mount(TrackOutline, { props: { track: noScale, color: '#e10600' } });
    expect(full.find('.track-scale').exists()).toBe(false);
    expect(full.get('.track-outline').attributes('style')).toContain('--track-color: #e10600');
  });
});

describe('CircuitFigure', () => {
  const mountFigure = async (info: CircuitInfo, props: { mini?: boolean; imgWidth?: number } = {}) => {
    const wrapper = mount(CircuitFigure, { props: { info, ...props }, slots: { default: '<i class="nada" />' }, global: { plugins: [pinia] } });
    await flushPromises();
    return wrapper;
  };
  const lastKind = (wrapper: { emitted(name: string): unknown[][] | undefined }) => wrapper.emitted('kind')!.at(-1)![0];

  it('con hasTrack pide el archivo y dibuja el trazado', async () => {
    stubData();
    const wrapper = await mountFigure(infoOf('lusail'));
    expect(trackRequests()).toHaveLength(1);
    expect(wrapper.find('.track-outline').exists()).toBe(true);
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.emitted('kind')!.map((e) => e[0])).toEqual(['loading', 'track']);
  });

  it('si el trazado no llega, muestra el plano de Commons sobre fondo claro con su atribución', async () => {
    stubData({ track: false });
    const wrapper = await mountFigure(infoOf('lusail'));
    expect(wrapper.find('.track-outline').exists()).toBe(false);
    const img = wrapper.get('.circuit-map-stage img');
    expect(img.attributes('src')).toBe(infoOf('lusail').map!.url);
    expect(img.attributes('loading')).toBe('lazy');
    expect(img.attributes('alt')).toBe('Plano de Circuito Internacional de Losail');
    const caption = wrapper.get('figcaption');
    expect(caption.text()).toContain('Will Pittenger, Gpmat · CC BY-SA 3.0');
    expect(caption.get('a').attributes('href')).toBe('https://commons.wikimedia.org/wiki/File:Lusail_International_Circuit_2023.svg');
    expect(lastKind(wrapper)).toBe('map');
  });

  it('sin hasTrack no pide nada; si la imagen del plano falla, queda vacío', async () => {
    stubData();
    const wrapper = await mountFigure(infoOf('ricardo-tormo'), { mini: true, imgWidth: 120 });
    expect(trackRequests()).toHaveLength(0);
    expect(wrapper.get('img').attributes('src')).toContain('/120px-Valencia_');
    expect(wrapper.find('figcaption').exists()).toBe(false);
    await wrapper.get('img').trigger('error');
    expect(wrapper.find('img').exists()).toBe(false);
    expect(wrapper.find('.nada').exists()).toBe(true);
    expect(lastKind(wrapper)).toBe('none');
  });

  it('sin trazado ni plano deja el contenido alternativo', async () => {
    stubData();
    const wrapper = await mountFigure(infoOf('goiania'));
    expect(wrapper.find('.nada').exists()).toBe(true);
    expect(wrapper.emitted('kind')!.map((e) => e[0])).toEqual(['none']);
    expect(requested).toHaveLength(0);
  });
});

describe('CircuitView', () => {
  /** Oculto con v-show (isVisible de test-utils exige que el componente esté en el documento). */
  const hidden = (el: { attributes(name: string): string | undefined }) => (el.attributes('style') ?? '').includes('display: none');

  async function mountCircuit(id: string) {
    const router = makeRouter();
    await router.push(`/circuito/${id}`);
    const wrapper = mount(CircuitView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return wrapper;
  }

  it('circuito con ficha completa: trazado, ficha técnica, foto, extracto y links', async () => {
    stubData();
    const wrapper = await mountCircuit('lusail');
    expect(wrapper.find('.hero-title').text()).toBe('Lusail');
    // Trazado propio con crédito.
    const figure = wrapper.get('.circuit-figure-card');
    expect(figure.get('h3').text()).toBe('Trazado');
    expect(figure.findAll('path.track-main')).toHaveLength(1);
    expect(figure.text()).toContain('© Colaboradores de OpenStreetMap');
    // Ficha técnica.
    const facts = wrapper.findAll('.fact').map((f) => `${f.get('dt').text()} ${f.get('dd').text().replace(/\s+/g, ' ')}`);
    expect(facts).toEqual([
      'Longitud 5,419 km',
      'Curvas 16',
      'Sentido Horario',
      'Inauguración 2004',
      'Capacidad 52.000 personas',
      'Altitud 12 m s. n. m.',
      'Ciudad Lusail',
      'Récord de vuelta 1:22.384 Lando Norris · McLaren MCL38 · 2024 · F1',
    ]);
    // Foto con atribución, perezosa.
    const photo = wrapper.get('.circuit-photo');
    expect(photo.get('img').attributes('loading')).toBe('lazy');
    expect(photo.get('.circuit-photo-frame').attributes('style')).toContain('--photo-ar: 1.7778');
    expect(photo.get('figcaption').text()).toContain('Dmitry Racer · CC BY-SA 4.0');
    expect(photo.get('figcaption a').attributes('href')).toBe('https://commons.wikimedia.org/wiki/File:WTCC_2016,_Qatar.jpg');
    // Extracto y links.
    const about = wrapper.get('.circuit-about');
    expect(about.get('h3').text()).toBe('Circuito Internacional de Losail');
    expect(about.get('.circuit-summary').text()).toContain('El Circuito Internacional de Losail es un autódromo');
    const links = Object.fromEntries(about.findAll('a').map((a) => [a.text(), a.attributes('href')]));
    expect(links['Leer más en Wikipedia']).toBe('https://es.wikipedia.org/wiki/Circuito_Internacional_de_Losail');
    expect(links['Sitio oficial']).toBe('https://www.lcsc.qa/');
    expect(links['Cómo llegar']).toBe('https://www.google.com/maps/dir/?api=1&destination=25.49000,51.45420');
    expect(links['Ver en OpenStreetMap']).toContain('mlat=25.49000&mlon=51.45420');
    expect(about.text()).not.toContain('Ubicación aproximada');
    // Los eventos siguen estando.
    expect(wrapper.text()).toContain('Próximos eventos');
    expect(wrapper.text()).toContain('Gran Premio de Qatar');
    expect(wrapper.find('.circuit-skeleton').exists()).toBe(false);
  });

  it('si la foto falla se oculta, sin romper el resto', async () => {
    stubData();
    const wrapper = await mountCircuit('san-nicolas');
    expect(wrapper.find('.circuit-photo').exists()).toBe(true);
    await wrapper.get('.circuit-photo img').trigger('error');
    expect(wrapper.find('.circuit-photo').exists()).toBe(false);
    // Sin trazado ni plano no hay tarjeta de dibujo; el extracto en inglés se avisa.
    expect(hidden(wrapper.get('.circuit-figure-card'))).toBe(true);
    expect(wrapper.get('.circuit-summary').attributes('lang')).toBe('en');
    expect(wrapper.text()).toContain('Texto de Wikipedia en inglés.');
    expect(wrapper.findAll('.fact dt').map((f) => f.text())).toEqual(['Longitud', 'Sentido', 'Inauguración', 'Ciudad']);
    expect(wrapper.text()).not.toContain('—');
  });

  it('circuito solo con plano de Commons: lo muestra con su atribución y no pide trazado', async () => {
    stubData();
    const wrapper = await mountCircuit('ricardo-tormo');
    const figure = wrapper.get('.circuit-figure-card');
    expect(hidden(figure)).toBe(false);
    expect(figure.get('h3').text()).toBe('Plano del circuito');
    expect(figure.get('.circuit-map-stage img').attributes('src')).toBe(infoOf('ricardo-tormo').map!.url);
    expect(figure.get('figcaption').text()).toContain('Will Pittenger · CC BY-SA 3.0');
    expect(trackRequests()).toHaveLength(0);
  });

  it('coordenadas aproximadas: aclara que es la ubicación de la ciudad', async () => {
    stubData();
    const wrapper = await mountCircuit('goiania');
    expect(wrapper.get('.circuit-where').text()).toContain('Ubicación aproximada: es la de Goiânia, no la del circuito.');
    expect(wrapper.findAll('.circuit-links a').map((a) => a.text())).toEqual(['Cómo llegar']);
    expect(wrapper.findAll('.fact')).toHaveLength(1);
    expect(wrapper.find('.circuit-photo').exists()).toBe(false);
  });

  it('circuito sin ficha: queda la página de siempre', async () => {
    stubData();
    const wrapper = await mountCircuit('daytona');
    expect(wrapper.find('.hero-title').text()).toBe('Daytona');
    expect(wrapper.find('.circuit-figure-card').exists()).toBe(false);
    expect(wrapper.find('.circuit-facts').exists()).toBe(false);
    expect(wrapper.find('.circuit-about').exists()).toBe(false);
    expect(wrapper.find('.circuit-skeleton').exists()).toBe(false);
    expect(wrapper.text()).toContain('Próximos eventos');
    expect(wrapper.text()).not.toContain('Wikidata');
  });

  it('sin circuits.json (o sin red) todo sigue funcionando', async () => {
    stubData({ circuits: false });
    const missing = await mountCircuit('lusail');
    expect(useCircuitInfoStore().status).toBe('missing');
    expect(missing.find('.circuit-facts').exists()).toBe(false);
    expect(missing.find('.circuit-skeleton').exists()).toBe(false);
    expect(missing.text()).toContain('Gran Premio de Qatar');
    expect(trackRequests()).toHaveLength(0);

    setActivePinia((pinia = createPinia()));
    useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const offline = await mountCircuit('lusail');
    expect(useCircuitInfoStore().status).toBe('error');
    expect(offline.find('.circuit-skeleton').exists()).toBe(false);
    expect(offline.text()).toContain('Gran Premio de Qatar');
  });

  it('mientras llega la ficha muestra un esqueleto y después lo reemplaza', async () => {
    let release: (r: Response) => void = () => undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string) => {
        if (String(input).endsWith('data/circuits.json')) return new Promise<Response>((resolve) => (release = resolve));
        if (String(input).endsWith('data/tracks/lusail.json')) return json(trackFile());
        return new Response('no', { status: 404 });
      }),
    );
    const wrapper = await mountCircuit('lusail');
    expect(wrapper.get('.circuit-skeleton').attributes('aria-busy')).toBe('true');
    expect(wrapper.find('.circuit-facts').exists()).toBe(false);
    // Los eventos ya están, sin esperar la ficha.
    expect(wrapper.text()).toContain('Gran Premio de Qatar');
    release(json(circuitsFile()));
    await flushPromises();
    expect(wrapper.find('.circuit-skeleton').exists()).toBe(false);
    expect(wrapper.find('.circuit-facts').exists()).toBe(true);
    expect(wrapper.find('path.track-main').exists()).toBe(true);
  });

  it('con la ficha ya descargada no hay esqueleto ni pedidos de más al cambiar de circuito', async () => {
    stubData();
    await useCircuitInfoStore().load();
    const router = makeRouter();
    await router.push('/circuito/ricardo-tormo');
    const wrapper = mount(CircuitView, { global: { plugins: [pinia, router] } });
    // Primer dibujo, sin esperar nada: ya está la ficha.
    expect(wrapper.find('.circuit-skeleton').exists()).toBe(false);
    expect(wrapper.find('.circuit-facts').exists()).toBe(true);
    await router.push('/circuito/lusail');
    await flushPromises();
    expect(wrapper.get('.circuit-figure-card h3').text()).toBe('Trazado');
    expect(requested.filter((u) => u.endsWith('circuits.json'))).toHaveLength(1);
  });
});

describe('Contexto del evento: bloque "El circuito"', () => {
  async function mountContext(eventId: string) {
    const schedule = useScheduleStore();
    const event = schedule.schedule!.events.find((e) => e.id === eventId)!;
    const series = schedule.seriesById.get(event.seriesId)!;
    const router = makeRouter();
    await router.push(`/evento/${eventId}?tab=contexto`);
    const wrapper = mount(ContextPanel, { props: { event, series }, global: { plugins: [pinia, router] } });
    await flushPromises();
    return wrapper;
  }

  it('con ficha: miniatura del trazado, longitud, curvas, récord y link a la página', async () => {
    stubData();
    const wrapper = await mountContext('ev-f1-qatar');
    const block = wrapper.get('.ctx-circuit');
    expect(block.get('h3').text()).toBe('El circuito');
    expect(block.get('a.ctx-circuit-row').attributes('href')).toBe('/circuito/lusail');
    expect(block.find('.track-outline.mini path.track-main').exists()).toBe(true);
    expect(block.text()).toContain('Circuito Internacional de Losail');
    expect(block.text()).toContain('5,419 km · 16 curvas');
    expect(block.text()).toContain('Récord: 1:22.384 · Lando Norris (2024)');
    expect(block.get('.ctx-circuit-credit').text()).toBe('Trazado: © Colaboradores de OpenStreetMap');
  });

  it('con plano de Commons usa la miniatura liviana y lo atribuye', async () => {
    stubData();
    const wrapper = await mountContext('ev-motogp-valencia');
    const block = wrapper.get('.ctx-circuit');
    expect(block.get('img').attributes('src')).toContain('/250px-Valencia_');
    expect(block.get('.ctx-circuit-credit').text()).toBe('Plano: Will Pittenger · CC BY-SA 3.0 · Wikimedia Commons');
    expect(trackRequests()).toHaveLength(0);
  });

  it('sin ficha (o con una ficha sin datos del trazado) el bloque no aparece', async () => {
    stubData();
    expect((await mountContext('ev-nascar-daytona')).find('.ctx-circuit').exists()).toBe(false);
    expect((await mountContext('ev-copatruck-goiania')).find('.ctx-circuit').exists()).toBe(false);
    stubData({ circuits: false });
    setActivePinia((pinia = createPinia()));
    useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
    const wrapper = await mountContext('ev-f1-qatar');
    expect(wrapper.find('.ctx-circuit').exists()).toBe(false);
    expect(wrapper.text()).toContain('Fuentes');
  });
});

describe('CircuitsView (/circuitos)', () => {
  async function mountList() {
    const router = makeRouter();
    await router.push('/circuitos');
    const wrapper = mount(CircuitsView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    return wrapper;
  }
  const rowsText = (wrapper: Awaited<ReturnType<typeof mountList>>) =>
    wrapper.findAll('.circuit-row').map((r) => [r.get('.grow').element.firstChild!.textContent!.trim(), ...r.findAll('.grow > .block').map((b) => b.text())].join(' | '));

  it('lista los circuitos por país con categorías, próxima fecha y miniatura', async () => {
    stubData();
    const wrapper = await mountList();
    expect(wrapper.get('.circuits-count').text()).toBe('5 circuitos en 5 países');
    expect(wrapper.findAll('.circuits-group .section-title').map((h) => h.text().replace(/\s+/g, ' '))).toEqual([
      'Argentina 1',
      'Brasil 1',
      'EE.UU. 1',
      'España 1',
      'Qatar 1',
    ]);
    expect(rowsText(wrapper)).toEqual([
      'San Nicolás | 2 categorías | Ahora: 13–15/11 · TC',
      'Goiânia | 1 categoría | Próxima: 15/11 · Copa Truck',
      'Daytona | 1 categoría | Próxima: 14/2/2027 · NASCAR Cup',
      'Ricardo Tormo | 1 categoría | Ahora: 13–15/11 · MotoGP',
      'Lusail | 2 categorías | Próxima: 27–29/11 · F1',
    ]);
    const rows = wrapper.findAll('.circuit-row');
    expect(rows.map((r) => r.attributes('href'))).toContain('/circuito/lusail');
    // Lusail: trazado; Ricardo Tormo: plano liviano; el resto, banderita.
    expect(rows[4]!.find('.track-outline.mini').exists()).toBe(true);
    expect(rows[3]!.get('img').attributes('src')).toContain('/120px-Valencia_');
    expect(rows[2]!.find('.circuit-thumb-none').exists()).toBe(true);
    expect(rows[0]!.find('.circuit-thumb-none').exists()).toBe(true);
    expect(trackRequests()).toHaveLength(1);
    expect(wrapper.get('.circuits-credits').text()).toContain('© Colaboradores de OpenStreetMap');
  });

  it('el buscador filtra por nombre o país', async () => {
    stubData();
    const wrapper = await mountList();
    await wrapper.get('input[type=search]').setValue('lus');
    expect(rowsText(wrapper)).toEqual(['Lusail | Qatar · 2 categorías | Próxima: 27–29/11 · F1']);
    await wrapper.get('input[type=search]').setValue('zzzz');
    expect(wrapper.text()).toContain('No hay circuitos que coincidan con «zzzz».');
    await wrapper.get('input[type=search]').setValue('');
    expect(wrapper.findAll('.circuit-row')).toHaveLength(5);
  });

  it('sin fichas publicadas la lista funciona igual, con banderitas', async () => {
    stubData({ circuits: false });
    const wrapper = await mountList();
    expect(wrapper.findAll('.circuit-row')).toHaveLength(5);
    expect(wrapper.findAll('.circuit-thumb-none')).toHaveLength(5);
    expect(wrapper.find('.circuits-credits').exists()).toBe(false);
    expect(trackRequests()).toHaveLength(0);
  });

  it('la ruta existe y Buscar la enlaza cuando hay circuitos entre los resultados', async () => {
    stubData();
    const router = makeRouter();
    await router.push('/buscar?q=lusail');
    expect(router.resolve('/circuitos').name).toBe('circuitos');
    const wrapper = mount(SearchView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    const link = wrapper.get('a.see-all');
    expect(link.text()).toBe('Ver todos los circuitos');
    expect(link.attributes('href')).toBe('/circuitos');
    wrapper.unmount();

    await router.push('/buscar?q=motogp');
    const other = mount(SearchView, { global: { plugins: [pinia, router] } });
    await flushPromises();
    expect(other.find('a.see-all').exists()).toBe(false);
  });
});
