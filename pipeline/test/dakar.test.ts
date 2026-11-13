import { describe, expect, it } from 'vitest';
import { eventSchema, eventStagesFileSchema, stableHash, type ScheduleFile, type Series } from '@dm/shared';
import { adapters } from '../src/adapters/index.ts';
import {
  DAKAR_ROUTE_URL,
  DAKAR_SITE,
  dakarAdapter,
  parseDakarDate,
  parseDakarRoute,
  parseDakarStagePage,
  terrainFromText,
} from '../src/adapters/dakar.ts';
import { parseDakarRanking } from '../src/adapters/dakar-ranking.ts';
import { createContext } from '../src/core/context.ts';
import { createLogger } from '../src/core/log.ts';
import { scheduleWithNextSeason } from '../src/core/season.ts';
import { fakeHttp, fixture } from './fake-http.ts';

// Fixtures: páginas reales de dakar.com (edición 2027) leídas el 12/11/2026, recortadas al <main>.
const SLUGS = ['prologo-0', 'etapa-1', 'traslado-0', ...[2, 3, 4, 5, 6].map((n) => `etapa-${n}`), 'descanso-0', ...[7, 8, 9, 10, 11, 12].map((n) => `etapa-${n}`)];
const carUrl = (slug: string) => `${DAKAR_SITE}/es/${slug}/coche`;
const bikeUrl = (slug: string) => `${DAKAR_SITE}/es/${slug}/moto`;
const page = (slug: string) => fixture(`dakar/${slug}-coche.html`);
const ROUTE = fixture('dakar/recorrido-general.html');
const MAP = 'https://img.aso.fr/core_app/img-motorSports-dak-jpg/dak27-officiel-parcours-maroc-moto-club-400x300-29oct/207307/0:0,4724:3543-1200-0-70/7ef8b';

const series: Series = {
  id: 'dakar',
  name: 'Rally Dakar',
  shortName: 'Dakar',
  group: 'rally',
  officialUrls: [DAKAR_ROUTE_URL],
  strategy: 'adapter',
  adapter: 'dakar',
  origin: 'default',
  enabled: true,
};

function routes(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const all: Record<string, string | undefined> = {
    [DAKAR_ROUTE_URL]: ROUTE,
    ...Object.fromEntries(SLUGS.map((slug) => [carUrl(slug), page(slug)])),
    ...overrides,
  };
  return Object.fromEntries(Object.entries(all).filter((e): e is [string, string] => e[1] !== undefined));
}

function setup(now: string, overrides: Record<string, string | undefined> = {}, previous: ScheduleFile | null = null) {
  const http = fakeHttp(routes(overrides));
  const ctx = createContext({ now: new Date(now), http, log: createLogger('test', true), previous });
  return { http, ctx };
}

const ID_2027 = stableHash('dakar', 2027, 'dakar');

describe('Dakar: recorrido general', () => {
  const route = parseDakarRoute(ROUTE);

  it('lee la edición y las quince jornadas en orden', () => {
    expect(route.edition).toBe(2027);
    expect(route.unknown).toEqual([]);
    expect(route.rows.map((r) => r.label)).toEqual([
      'Prólogo', 'Etapa 1', 'Traslado', 'Etapa 2', 'Etapa 3', 'Etapa 4', 'Etapa 5', 'Etapa 6', 'Descanso',
      'Etapa 7', 'Etapa 8', 'Etapa 9', 'Etapa 10', 'Etapa 11', 'Etapa 12',
    ]);
    expect(route.rows.map((r) => r.kind)).toEqual([
      'prologo', 'especial', 'enlace', 'especial', 'especial', 'especial', 'especial', 'especial', 'descanso',
      'especial', 'especial', 'especial', 'especial', 'especial', 'especial',
    ]);
    expect(route.rows[0]).toEqual({
      label: 'Prólogo',
      kind: 'prologo',
      date: '2027-01-09',
      places: ['LOULE', 'LOULE'],
      totalKm: 129,
      specialKm: 29,
      url: bikeUrl('prologo-0'),
    });
    expect(route.rows[13]).toMatchObject({ label: 'Etapa 11', date: '2027-01-22', places: ['SMARA', 'MARRAKECH'], totalKm: 1035, specialKm: 455 });
  });

  it('deja sin kilómetros el traslado y el descanso', () => {
    expect(route.rows[2]).toEqual({ label: 'Traslado', kind: 'enlace', date: '2027-01-11', places: ['LOULE', 'BOUÂRFA'], url: bikeUrl('traslado-0') });
    expect(route.rows[8]).toEqual({ label: 'Descanso', kind: 'descanso', date: '2027-01-17', places: ['AGADIR'], url: bikeUrl('descanso-0') });
  });

  it('toma el mapa general y los países resaltados en la presentación', () => {
    expect(route.mapUrl).toBe(MAP);
    expect(route.countries).toEqual(['Portugal', 'Marruecos']);
    expect(route.mainCountry).toBe('Marruecos');
  });

  it('entiende las dos formas de fecha del sitio', () => {
    expect(parseDakarDate('Sábado, 9 de enero de 2027')).toBe('2027-01-09');
    expect(parseDakarDate('23/01/2027 - Etapa 12')).toBe('2027-01-23');
    expect(parseDakarDate('Total | Especial')).toBeNull();
  });
});

describe('Dakar: página de una jornada', () => {
  it('lee fecha, recorrido, kilómetros y descripción de una etapa', () => {
    const p = parseDakarStagePage(page('etapa-4'), carUrl('etapa-4'));
    expect(p.date).toBe('2027-01-14');
    expect(p.title).toBe('Bouarfa > Zagora');
    expect(p.liaisonKm).toBe(260);
    expect(p.specialKm).toBe(490);
    expect(p.description).toMatch(/^La especial más larga de la primera semana roza los 500 km\./);
    expect(p.description).toContain('no deben provocar sudores fríos a los "rookies"');
    expect(p.description).not.toMatch(/&\w+;|<|\s{2}/);
    // El sitio todavía no publica mapa por etapa ni desglose de terreno: no se inventan.
    expect(p.mapUrl).toBeUndefined();
    expect(p.terrain).toBeUndefined();
  });

  it('el traslado no tiene kilómetros y el descanso tampoco descripción', () => {
    const transfer = parseDakarStagePage(page('traslado-0'), carUrl('traslado-0'));
    expect(transfer).toMatchObject({ date: '2027-01-11', title: 'Loulé/Faro > Bouarfa' });
    expect(transfer.specialKm).toBeUndefined();
    expect(transfer.liaisonKm).toBeUndefined();
    expect(transfer.description).toMatch(/^La tercera jornada marca una primera pausa/);
    expect(parseDakarStagePage(page('descanso-0'), carUrl('descanso-0'))).toEqual({ date: '2027-01-17' });
  });

  // Formatos supuestos (el sitio no los publica todavía): solo se comprueba que el lector no tome cualquier cosa.
  it('toma el terreno solo si está escrito como porcentajes que suman 100', () => {
    expect(terrainFromText('Arena 45 % · Dunas 10 % · Tierra 30 % · Piedras 15 %')).toEqual([
      { label: 'Arena', percent: 45 },
      { label: 'Dunas', percent: 10 },
      { label: 'Tierra', percent: 30 },
      { label: 'Piedras', percent: 15 },
    ]);
    expect(terrainFromText('62% sand, 27% dirt, 8% stones, 3% dunes')).toEqual([
      { label: 'Arena', percent: 62 },
      { label: 'Tierra', percent: 27 },
      { label: 'Piedras', percent: 8 },
      { label: 'Dunas', percent: 3 },
    ]);
    expect(terrainFromText('Arena 45 % · Dunas 10 %')).toBeUndefined();
    expect(terrainFromText('Enlace > 200 km - Especial > 100 km Moto > Coche >')).toBeUndefined();
    expect(terrainFromText('Unos cincuenta kilómetros de dunas y mucha arena.')).toBeUndefined();
  });

  it('toma como mapa de la etapa una imagen ampliable con nombre de mapa, no una foto', () => {
    const figure = (name: string) =>
      `<section class="container article"><div class="row article__content"><figure class="figure is-center is-clear js-zoomable">` +
      `<a href="https://img.aso.fr/core_app/img-motorSports-dak-jpg/${name}/1/0:0,10:10-1200-0-70/abc" class="js-jzoom"><img data-src="x|y" alt="" /></a></figure></div></section>`;
    const withFigure = (name: string) => page('etapa-4').replace('<section class="pushs', `${figure(name)}<section class="pushs`);
    expect(parseDakarStagePage(withFigure('dak27-carte-etape-4'), carUrl('etapa-4')).mapUrl).toBe(
      'https://img.aso.fr/core_app/img-motorSports-dak-jpg/dak27-carte-etape-4/1/0:0,10:10-1200-0-70/abc',
    );
    expect(parseDakarStagePage(withFigure('20270114dak0207'), carUrl('etapa-4')).mapUrl).toBeUndefined();
  });
});

describe('Dakar: evento e itinerario', () => {
  it('publica un evento por edición, sin sesiones, con el itinerario completo', async () => {
    const { http, ctx } = setup('2026-11-12T12:00:00Z');
    const chunk = await dakarAdapter.schedule(series, ctx);

    expect(chunk.sessions).toEqual([]);
    expect(chunk.events).toHaveLength(1);
    const event = eventSchema.parse(chunk.events[0]);
    expect(event).toMatchObject({
      id: ID_2027,
      seriesId: 'dakar',
      name: 'Dakar 2027',
      circuit: 'Loulé/Faro > Marrakech',
      country: 'Portugal y Marruecos',
      tz: 'Africa/Casablanca',
      dateStart: '2027-01-09',
      dateEnd: '2027-01-23',
      sessionsStatus: 'pending',
      surface: 'arena',
      stageCount: 13,
    });
    expect(event.kind).toBeUndefined();
    expect(event.source).toMatchObject({ url: DAKAR_ROUTE_URL, kind: 'html', method: 'directo' });

    expect(chunk.stages).toHaveLength(1);
    const file = eventStagesFileSchema.parse(chunk.stages![0]);
    expect(file).toMatchObject({ seriesId: 'dakar', eventId: ID_2027, surface: 'arena', competitiveKm: 4341, routeMapUrl: MAP });
    // El traslado no trae kilómetros: no se publica un total incompleto.
    expect(file.totalKm).toBeUndefined();
    expect(file.stages.map((s) => [s.code, s.kind, s.date, s.name, s.liaisonKm, s.distanceKm, s.totalKm])).toEqual([
      ['Prólogo', 'prologo', '2027-01-09', 'Loulé/Faro > Loulé/Faro', 100, 29, 129],
      ['Etapa 1', 'especial', '2027-01-10', 'Loulé/Faro > Loulé/Faro', 200, 100, 300],
      ['Traslado', 'enlace', '2027-01-11', 'Loulé/Faro > Bouarfa', undefined, undefined, undefined],
      ['Etapa 2', 'especial', '2027-01-12', 'Bouarfa > Bouarfa', 100, 390, 490],
      ['Etapa 3', 'especial', '2027-01-13', 'Bouarfa > Bouarfa', 80, 410, 490],
      ['Etapa 4', 'especial', '2027-01-14', 'Bouarfa > Zagora', 260, 490, 750],
      ['Etapa 5', 'especial', '2027-01-15', 'Zagora > Zagora', 175, 365, 540],
      ['Etapa 6', 'especial', '2027-01-16', 'Zagora > Agadir', 395, 365, 760],
      ['Descanso', 'descanso', '2027-01-17', 'Agadir', undefined, undefined, undefined],
      ['Etapa 7', 'especial', '2027-01-18', 'Agadir > Smara', 290, 500, 790],
      ['Etapa 8', 'especial', '2027-01-19', 'Smara > Bivouac refuge', 170, 355, 525],
      ['Etapa 9', 'especial', '2027-01-20', 'Bivouac refuge > Smara', 235, 390, 625],
      ['Etapa 10', 'especial', '2027-01-21', 'Smara > Smara', 90, 470, 560],
      ['Etapa 11', 'especial', '2027-01-22', 'Smara > Marrakech', 580, 455, 1035],
      ['Etapa 12', 'especial', '2027-01-23', 'Marrakech > Marrakech', 218, 22, 240],
    ]);
    expect(file.stages[0]!.note).toMatch(/^El prólogo es un ejercicio corto/);
    expect(file.stages[8]!.note).toBeUndefined();
    // Nada de lo que el sitio todavía no publica.
    for (const s of file.stages) {
      expect(s.mapUrl).toBeUndefined();
      expect(s.terrain).toBeUndefined();
      expect(s.startUtc).toBeUndefined();
      expect(s.note?.length ?? 0).toBeLessThanOrEqual(1200);
    }
    // Una página por jornada (la de autos); las de motos solo se piden si la tabla general no coincide.
    expect(http.calls).toEqual([DAKAR_ROUTE_URL, ...SLUGS.map(carUrl)]);
  });

  it('guarda las distancias de autos y avisa en la nota cuando las de motos son otras', async () => {
    const cars = page('etapa-3').replace('410 km', '420 km');
    expect(cars).not.toBe(page('etapa-3'));
    const { http, ctx } = setup('2026-11-12T12:00:00Z', { [carUrl('etapa-3')]: cars, [bikeUrl('etapa-3')]: page('etapa-3') });
    const stage = (await dakarAdapter.schedule(series, ctx)).stages![0]!.stages[4]!;
    expect(stage).toMatchObject({ code: 'Etapa 3', distanceKm: 420, liaisonKm: 80, totalKm: 500 });
    expect(stage.note).toMatch(/exigente\. Las distancias son las de autos; motos: 410 km de especial y 80 km de enlace\.$/);
    expect(http.calls.filter((u) => u.endsWith('/moto'))).toEqual([bikeUrl('etapa-3')]);
  });

  it('si la página de una jornada no se puede leer, quedan los datos de la tabla general', async () => {
    const { ctx } = setup('2026-11-12T12:00:00Z', { [carUrl('etapa-5')]: undefined });
    const file = (await dakarAdapter.schedule(series, ctx)).stages![0]!;
    expect(file.stages).toHaveLength(15);
    expect(file.stages[6]).toEqual({ code: 'Etapa 5', name: 'Zagora > Zagora', kind: 'especial', date: '2027-01-15', distanceKm: 365, liaisonKm: 175, totalKm: 540 });
    expect(file.competitiveKm).toBe(4341);
  });

  it('falla si la página del recorrido no trae la tabla', async () => {
    const { ctx } = setup('2026-11-12T12:00:00Z', { [DAKAR_ROUTE_URL]: '<html><body><main><h1>RECORRIDO 2028</h1></main></body></html>' });
    await expect(dakarAdapter.schedule(series, ctx)).rejects.toThrow(/tabla del recorrido/);
  });
});

describe('Dakar: edición y temporada', () => {
  it('el id del evento es el de la edición, antes y después del cambio de año', async () => {
    for (const now of ['2026-11-12T12:00:00Z', '2027-01-02T12:00:00Z', '2027-01-15T12:00:00Z']) {
      const { http, ctx } = setup(now);
      const chunk = await scheduleWithNextSeason(dakarAdapter, series, ctx);
      expect(chunk.events.map((e) => e.id), now).toEqual([ID_2027]);
      // La edición no terminó: no se busca la temporada siguiente.
      expect(http.calls.filter((u) => u === DAKAR_ROUTE_URL), now).toHaveLength(1);
    }
  });

  it('con la edición terminada no duplica ni pierde el evento mientras el sitio no publique la siguiente', async () => {
    const { ctx } = setup('2027-02-10T12:00:00Z');
    const chunk = await scheduleWithNextSeason(dakarAdapter, series, ctx);
    expect(chunk.events.map((e) => [e.id, e.name])).toEqual([[ID_2027, 'Dakar 2027']]);
    expect(chunk.stages).toHaveLength(1);
  });

  it('cuando el sitio pasa a la edición siguiente, conserva hasta fin de año la que ya se corrió', async () => {
    const first = setup('2027-02-10T12:00:00Z');
    const before = await scheduleWithNextSeason(dakarAdapter, series, first.ctx);
    const previous: ScheduleFile = { version: 1, generatedAt: '2027-02-10T12:00:00Z', series: [series], events: before.events, sessions: [] };
    // El recorrido 2028 se simula con el de 2027 corrido un año (el sitio todavía no lo publica).
    const next = Object.fromEntries(Object.entries(routes()).map(([url, html]) => [url, html.replaceAll('2027', '2028')]));

    const { ctx } = setup('2027-06-01T12:00:00Z', next, previous);
    const chunk = await scheduleWithNextSeason(dakarAdapter, series, ctx);
    expect(chunk.events.map((e) => e.name)).toEqual(['Dakar 2027', 'Dakar 2028']);
    expect(chunk.events[1]!.id).toBe(stableHash('dakar', 2028, 'dakar'));
    expect(chunk.stages!.map((f) => f.eventId)).toEqual([chunk.events[1]!.id]);

    // Al año siguiente la edición vieja ya no es de la temporada.
    const later = setup('2028-01-03T12:00:00Z', next, { ...previous, events: chunk.events });
    expect((await scheduleWithNextSeason(dakarAdapter, series, later.ctx)).events.map((e) => e.name)).toEqual(['Dakar 2028']);
  });

  it('está registrado con la clave que usa config/series.default.json', () => {
    expect(adapters.dakar).toBe(dakarAdapter);
  });
});

// Clasificación general de la edición 2026 (primeras 12 filas de cada página, leídas el 12/11/2026).
describe('Dakar: clasificación general (lectura todavía sin publicar)', () => {
  it('lee la edición y la etapa del título, no del año del sitio', () => {
    const cars = parseDakarRanking(fixture('dakar/clasificacion-coche.html'))!;
    expect(cars).toMatchObject({ edition: 2026, afterStage: 13, category: 'A' });
    expect(cars.rows).toHaveLength(12);
    expect(cars.rows[0]).toEqual({
      pos: 1,
      number: '299',
      crew: [
        { name: 'NASSER AL-ATTIYAH', country: 'qat' },
        { name: 'FABIAN LURQUIN', country: 'bel' },
      ],
      team: 'The Dacia Sandriders',
      time: "48h 56' 53''",
      penalty: "00h 02' 40''",
    });
    expect(cars.rows[1]).toMatchObject({ pos: 2, number: '227', time: "49h 06' 35''", gap: "+ 00h 09' 42''" });
  });

  it('lee las motos con un solo piloto por fila', () => {
    const bikes = parseDakarRanking(fixture('dakar/clasificacion-moto.html'))!;
    expect(bikes).toMatchObject({ edition: 2026, afterStage: 13, category: 'M' });
    expect(bikes.rows.map((r) => r.pos)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(bikes.rows[0]).toEqual({
      pos: 1,
      number: '77',
      crew: [{ name: 'LUCIANO BENAVIDES', country: 'arg' }],
      team: 'RED BULL KTM FACTORY RACING',
      time: "49h 00' 41''",
    });
    expect(bikes.rows[1]).toMatchObject({ crew: [{ name: 'RICKY BRABEC', country: 'usa' }], gap: "+ 00h 00' 02''" });
  });

  it('devuelve null si la página no trae una clasificación general', () => {
    expect(parseDakarRanking('<main><p>Clasificación próximamente</p></main>')).toBeNull();
    expect(parseDakarRanking(fixture('dakar/clasificacion-moto.html').replace('data-current-type="cg"', 'data-current-type="ce"'))).toBeNull();
    expect(parseDakarRanking(ROUTE)).toBeNull();
  });
});
