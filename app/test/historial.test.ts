import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia, type Pinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import {
  driverBiosShardFileSchema,
  driverShardPath,
  seriesHistoryFileSchema,
  type CareerSeason,
  type DriverDetail,
  type TeamsFile,
} from '@dm/shared';
import CategoryView from '../src/views/CategoryView.vue';
import DriverView from '../src/views/DriverView.vue';
import TeamView from '../src/views/TeamView.vue';
import { routes } from '../src/router.ts';
import { driverBiosPath, SERIES_HISTORY_PATH, TEAM_BIOS_PATH, useBiosStore } from '../src/stores/bios.ts';
import { useScheduleStore } from '../src/stores/schedule.ts';
import { ageOn, careerRows, careerSpan, groupTitles, imageCredit, longDate, readMoreLabel, yearsText } from '../src/lib/bios.ts';
import { NOW, fixture, scheduleFixture, statusFixture } from './helpers.ts';

/**
 * Historial (data/bios/**): store con carga perezosa y validación, y las secciones de las fichas de piloto, equipo y
 * categoría. Los fixtures de data/bios son de prueba (formato del contrato; la foto es la real de Commons).
 */

let pinia: Pinia;

const BIOS = {
  [driverBiosPath('agustin-canapino')]: fixture('bios/drivers/f6.json'),
  [TEAM_BIOS_PATH]: fixture('bios/teams.json'),
  [SERIES_HISTORY_PATH]: fixture('bios/series.json'),
};

const canapino: DriverDetail = {
  id: 'agustin-canapino',
  name: 'Agustín Canapino',
  entries: [{ seriesId: 'tc', pos: 3, points: 471, number: '8', team: 'Chevrolet' }],
  recent: [],
};

const teams: TeamsFile = {
  version: 1,
  generatedAt: NOW,
  teams: [{ id: 'team-wrt', name: 'Team WRT', entries: [{ seriesId: 'tc', numbers: ['31'] }], drivers: [] }],
};

type Files = Record<string, unknown>;
const json = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });

function stubFetch(files: Files) {
  const requested: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const rel = String(input).replace(/^.*\/data\//, '');
      requested.push(rel);
      return rel in files ? json(files[rel]) : new Response('no', { status: 404 });
    }),
  );
  return requested;
}

async function mountAt(component: object, path: string) {
  const router = createRouter({ history: createMemoryHistory(), routes });
  await router.push(path);
  const wrapper = mount(component, { global: { plugins: [pinia, router] } });
  await flushPromises();
  // La validación (zod) se importa de forma diferida.
  await new Promise((r) => setTimeout(r, 0));
  await flushPromises();
  return wrapper;
}

beforeEach(() => {
  pinia = createPinia();
  setActivePinia(pinia);
  useScheduleStore().$patch({ schedule: scheduleFixture(), status: statusFixture(), now: NOW });
});
afterEach(() => vi.unstubAllGlobals());

describe('store del historial', () => {
  it('los fixtures cumplen los esquemas compartidos', () => {
    expect(driverBiosShardFileSchema.safeParse(fixture('bios/drivers/f6.json')).success).toBe(true);
    expect(seriesHistoryFileSchema.safeParse(fixture('bios/series.json')).success).toBe(true);
  });

  it('el historial de un piloto se pide una sola vez, del mismo grupo que su ficha', async () => {
    const requested = stubFetch(BIOS);
    const bios = useBiosStore();
    expect(driverBiosPath('agustin-canapino')).toBe(`bios/${driverShardPath('agustin-canapino')}`);
    await bios.loadDriver('agustin-canapino');
    await bios.loadDriver('agustin-canapino');
    expect(requested).toEqual(['bios/drivers/f6.json']);
    expect(bios.driverStatus('agustin-canapino')).toBe('ok');
    expect(bios.drivers['agustin-canapino']?.birthPlace).toBe('Arrecifes, Buenos Aires, Argentina');
  });

  it('sin archivos publicados (404) queda "missing" y no se vuelve a pedir', async () => {
    const requested = stubFetch({});
    const bios = useBiosStore();
    await bios.loadDriver('agustin-canapino');
    await bios.loadTeams();
    await bios.loadSeries();
    await bios.loadDriver('agustin-canapino');
    await bios.loadTeams();
    expect(bios.driverStatus('agustin-canapino')).toBe('missing');
    expect(bios.teamsStatus).toBe('missing');
    expect(bios.seriesStatus).toBe('missing');
    expect(bios.teamsById.size).toBe(0);
    expect(requested).toHaveLength(3);
  });

  it('una ficha mal formada se descarta sola; un archivo de otro formato, entero', async () => {
    stubFetch({ ...BIOS, [SERIES_HISTORY_PATH]: { version: 2, series: [] } });
    const bios = useBiosStore();
    await bios.loadTeams();
    await bios.loadSeries();
    // teams.json trae un equipo roto ("roto", sin fecha válida): queda solo el bueno.
    expect([...bios.teamsById.keys()]).toEqual(['team-wrt']);
    expect(bios.seriesStatus).toBe('error');
    expect(bios.seriesById.size).toBe(0);
  });

  it('sin conexión queda "error" y se puede reintentar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const bios = useBiosStore();
    await bios.loadSeries();
    expect(bios.seriesStatus).toBe('error');
    stubFetch(BIOS);
    await bios.loadSeries();
    expect(bios.seriesStatus).toBe('ok');
    expect(bios.seriesById.get('tc')?.organizer).toBe('ACTC');
  });
});

describe('textos del historial', () => {
  it('fechas y edad', () => {
    expect(longDate('1990-02-16')).toBe('16 de febrero de 1990');
    expect(longDate('raro')).toBe('');
    expect(ageOn('1990-02-16', '2026-11-14')).toBe(36);
    expect(ageOn('1990-11-15', '2026-11-14')).toBe(35);
    expect(ageOn('1990-11-14', '2026-11-14')).toBe(36);
    expect(ageOn(undefined, '2026-11-14')).toBeNull();
  });

  it('"Leer más" aclara el idioma y el crédito de la imagen lleva autor y licencia', () => {
    expect(readMoreLabel({ text: 'x', lang: 'en', url: 'https://en.wikipedia.org/wiki/W_Racing_Team' })).toBe('Leer más en Wikipedia (en inglés)');
    expect(readMoreLabel({ text: 'x', lang: 'es', url: 'https://www.actc.org.ar/historia' })).toBe('Leer más en actc.org.ar');
    expect(imageCredit({ url: 'https://x/a.jpg', credit: 'Diego HC', license: 'CC BY-SA 4.0', page: 'https://x' })).toBe('Foto: Diego HC · CC BY-SA 4.0');
  });

  it('títulos agrupados y trayectoria ordenada', () => {
    const groups = groupTitles([
      { season: 2019, series: 'Súper TC2000' },
      { season: 2018, series: 'Turismo Carretera', seriesId: 'tc' },
      { season: 2010, series: 'Turismo Carretera', seriesId: 'tc' },
    ]);
    expect(groups).toEqual([
      { series: 'Turismo Carretera', seriesId: 'tc', seasons: [2010, 2018] },
      { series: 'Súper TC2000', seasons: [2019] },
    ]);
    const career: CareerSeason[] = [
      { season: 2018, series: 'TC', source: 'wikidata' },
      { season: 2019, series: 'TC', source: 'wikidata' },
      { season: 2019, series: 'STC2000', source: 'wikidata' },
    ];
    expect(careerRows(career).map((c) => [c.season, c.firstOfSeason])).toEqual([
      [2019, true],
      [2019, false],
      [2018, true],
    ]);
    expect(careerSpan(career)).toBe('2018–2019');
    expect(yearsText(2011, undefined, 2026)).toBe('desde 2011');
    expect(yearsText(2019, 2021, 2026)).toBe('2019–2021');
    expect(yearsText(2026, undefined, 2026)).toBe('2026');
  });
});

describe('ficha del piloto con historial', () => {
  it('foto en la cabecera, perfil con crédito, títulos, resumen con atribución y trayectoria', async () => {
    stubFetch({ ...BIOS, [driverShardPath('agustin-canapino')]: { version: 1, drivers: [canapino] } });
    const wrapper = await mountAt(DriverView, '/piloto/agustin-canapino');
    const photo = wrapper.get('.hero .driver-avatar-photo');
    expect(photo.attributes('src')).toContain('Agust%C3%ADn_Canapino_2017');

    const profile = wrapper.get('.driver-profile');
    expect(profile.text()).toContain('36 años');
    expect(profile.text()).toContain('16 de febrero de 1990');
    expect(profile.text()).toContain('Arrecifes, Buenos Aires, Argentina');
    const credit = profile.get('.bio-image-credit a');
    expect(credit.text()).toBe('Foto: Diego HC · CC BY-SA 4.0');
    expect(credit.attributes('href')).toBe('https://commons.wikimedia.org/wiki/File:Agust%C3%ADn_Canapino_2017_(cropped).jpg');
    expect(profile.get('.bio-title').text()).toContain('Turismo Carretera×4');
    expect(profile.get('.bio-title a').attributes('href')).toBe('/categoria/tc?tab=historia');
    expect(profile.get('.bio-source a').text()).toBe('Leer más en Wikipedia');
    expect(profile.get('.bio-license').text()).toContain('CC BY-SA 4.0');
    expect(profile.find('.bio-links a').attributes('href')).toBe('https://www.instagram.com/agustincanapino/');

    const career = wrapper.get('.career-table');
    const trs = career.findAll('tbody tr');
    expect(trs).toHaveLength(7);
    expect(trs[0]!.text()).toContain('IndyCar Series');
    expect(trs[0]!.text()).toContain('Juncos Hollinger Racing');
    // Campeonatos resaltados; la segunda fila de 2019 no repite el año.
    expect(trs[2]!.classes()).toContain('champion');
    expect(trs[3]!.find('.career-year').text()).toBe('');
    // Enlace a la categoría solo si la app la sigue (TC sí; IndyCar no está en la agenda de prueba).
    expect(trs[2]!.find('a').attributes('href')).toBe('/categoria/tc');
    expect(trs[0]!.find('a').exists()).toBe(false);
  });

  it('sin historial publicado, la ficha sigue igual (iniciales, sin perfil ni trayectoria)', async () => {
    const requested = stubFetch({ [driverShardPath('agustin-canapino')]: { version: 1, drivers: [canapino] } });
    const wrapper = await mountAt(DriverView, '/piloto/agustin-canapino');
    expect(wrapper.find('.hero-title').text()).toBe('Agustín Canapino');
    expect(wrapper.find('.driver-avatar-photo').exists()).toBe(false);
    expect(wrapper.find('.hero .driver-avatar').text()).toContain('AC');
    expect(wrapper.find('.driver-profile').exists()).toBe(false);
    expect(wrapper.find('.career-table').exists()).toBe(false);
    expect(requested).toContain('bios/drivers/f6.json');
  });
});

describe('ficha del equipo con historial', () => {
  it('logo, fundación, sede, director, sitio, resumen en inglés aclarado e historia por categoría', async () => {
    stubFetch({ ...BIOS, 'teams.json': teams });
    const wrapper = await mountAt(TeamView, '/equipo/team-wrt');
    expect(wrapper.get('.hero-logo img').attributes('src')).toBe('https://example.org/logos/wrt.svg');
    expect(wrapper.get('.hero').text()).toContain('Fundado en 2009 · Baudour, Bélgica');
    const profile = wrapper.get('.team-profile');
    expect(profile.text()).toContain('Vincent Vosse');
    // El país ya está en la sede: no se repite.
    expect(profile.text()).not.toContain('País');
    expect(profile.get('.bio-image-credit a').text()).toBe('Logo: Team WRT · © Team WRT');
    expect(profile.get('.bio-source a').text()).toBe('Leer más en Wikipedia (en inglés)');
    expect(profile.get('.bio-license').text()).toContain('Texto de Wikipedia en inglés');
    expect(profile.findAll('.team-history-item').map((li) => li.text())).toEqual([
      'desde 2021WEC',
      'desde 2011GT World Challenge Europe',
      '2019–2021DTM',
    ]);
    expect(profile.get('.bio-fact a').text()).toBe('w-racingteam.com');
  });
});

describe('Historia de la categoría', () => {
  it('pestaña con resumen, organizador, récords y campeones con enlaces', async () => {
    stubFetch(BIOS);
    const wrapper = await mountAt(CategoryView, '/categoria/tc?tab=historia');
    expect(wrapper.findAll('.underline-tab').map((t) => t.text())).toContain('Historia');
    expect(wrapper.get('.underline-tab.active').text()).toBe('Historia');
    expect(wrapper.text()).toContain('ACTC');
    expect(wrapper.text()).toContain('1937');
    expect(wrapper.text()).toContain('Juan Gálvez (9)');
    const rows = wrapper.findAll('.champions-table tbody tr');
    expect(rows.map((r) => r.find('.champions-year').text())).toEqual(['2025', '2024', '2023']);
    expect(rows[0]!.get('a').attributes('href')).toBe('/piloto/agustin-canapino');
    // Sin id en el archivo: sin enlace.
    expect(rows[2]!.find('.champions-driver a').exists()).toBe(false);
    expect(wrapper.get('.series-history').text()).toContain('Turismo Carretera – Wikipedia');
  });

  it('sin historia publicada no aparece la pestaña', async () => {
    stubFetch({});
    const wrapper = await mountAt(CategoryView, '/categoria/tc');
    expect(wrapper.findAll('.underline-tab').map((t) => t.text())).not.toContain('Historia');
  });
});
