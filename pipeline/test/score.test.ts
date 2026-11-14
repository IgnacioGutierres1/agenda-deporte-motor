import { describe, expect, it } from 'vitest';
import {
  eventResultsFileSchema,
  eventSchema,
  eventStagesFileSchema,
  sessionSchema,
  stableHash,
  type MotorEvent,
  type Series,
  type Session,
} from '@dm/shared';
import { adapters } from '../src/adapters/index.ts';
import type { PdfItem } from '../src/adapters/fia-documents.ts';
import {
  checkpointStages,
  createScoreAdapter,
  findScoreCalendar,
  findScoreDoc,
  homepageMapUrl,
  parseWpSearch,
  pickRaces,
  SCORE_QUERIES,
  SCORE_SITE,
  scorePageUrl,
  scoreSearchUrl,
  scoreTimeZone,
  scoreVenue,
  wpDocumentUrl,
} from '../src/adapters/score.ts';
import {
  leadingTime,
  parseScoreCalendar,
  parseScoreCheckpoints,
  parseScoreSchedule,
  scheduleKind,
  scoreRaceKey,
} from '../src/adapters/score-docs.ts';
import {
  parseLiveTimeEventPage,
  parseLiveTimeEvents,
  parseLiveTimeResult,
  SCORE_RESULTS_EVENTS_URL,
} from '../src/adapters/score-results.ts';
import { createContext } from '../src/core/context.ts';
import { createLogger } from '../src/core/log.ts';
import { validateSessions } from '../src/validate.ts';
import { fakeHttp, fixture } from './fake-http.ts';

// Fixtures: documentos reales de SCORE International leídos el 14/11/2026 (durante la Baja 1000 2026).
// - PDF de score-raceinfo.com: el texto posicionado que unpdf extrae del PDF real (*.items.json), solo las páginas
//   que se leen (los días de la carrera y la tabla de puestos de control).
// - Páginas de la API de WordPress (page-*.json) sin el carrusel ni el menú de la carrera.
// - LiveTime (results.score-international.com): sin scripts ni el detalle de vueltas, y con algunas filas por tabla.
const items = (name: string): PdfItem[] => JSON.parse(fixture(`score/${name}.items.json`)) as PdfItem[];
const pdfItems = async (bytes: Uint8Array) => JSON.parse(new TextDecoder().decode(bytes)) as PdfItem[];
const page = (id: number) => fixture(`score/page-${id}.json`);
const docUrl = (id: number) => wpDocumentUrl((JSON.parse(page(id)) as { content: { rendered: string } }).content.rendered)!;

const series: Series = {
  id: 'score-baja',
  name: 'SCORE Baja 1000 (Campeonato del Desierto)',
  shortName: 'SCORE Baja',
  group: 'rally',
  officialUrls: ['https://score-raceinfo.com/'],
  strategy: 'adapter',
  adapter: 'score',
  origin: 'default',
  enabled: true,
};

/** Página de la API -> PDF que embebe -> fixture con su texto. */
const PAGES: Record<number, string | null> = {
  27582: 'calendario-2026',
  28683: 'calendario-2027',
  28155: 'cronograma-2026-san-felipe-250',
  28290: 'race-info-2026-san-felipe-250',
  28257: null, // mapa (se enlaza, no se descarga)
  28409: 'cronograma-2026-baja-500',
  28522: 'race-info-2026-baja-500',
  28494: null,
  28677: 'cronograma-2026-baja-400',
  28812: 'race-info-2026-baja-400',
  28778: null,
  28939: 'cronograma-2026-baja-1000',
  29029: 'race-info-2026-baja-1000',
  28964: null,
};

function routes(): Record<string, string> {
  const r: Record<string, string> = {
    [scoreSearchUrl(SCORE_QUERIES.calendar)]: fixture('score/search-race-schedule.json'),
    [scoreSearchUrl(SCORE_QUERIES.schedule)]: fixture('score/search-schedule-of-events.json'),
    [scoreSearchUrl(SCORE_QUERIES.raceInfo)]: fixture('score/search-race-info.json'),
    [scoreSearchUrl(SCORE_QUERIES.courseMap)]: fixture('score/search-course-map.json'),
    [`${SCORE_SITE}/`]: fixture('score/portada.html'),
    [SCORE_RESULTS_EVENTS_URL]: fixture('score/livetime-eventos.html'),
    'https://results.score-international.com/results/?p=view_event&id=517132': fixture('score/livetime-evento-2026-baja-400.html'),
    'https://results.score-international.com/results/?p=view_event&id=524279': fixture('score/livetime-evento-2026-baja-1000.html'),
    'https://results.score-international.com/results/?p=view_race_result&id=7047215&show_combined=1': fixture('score/livetime-2026-baja-400-autos.html'),
    'https://results.score-international.com/results/?p=view_race_result&id=7047208&show_combined=1': fixture('score/livetime-2026-baja-400-motos.html'),
    'https://results.score-international.com/results/?p=view_race_result&id=7202680': fixture('score/livetime-2026-baja-1000-clasif-tt.html'),
    'https://results.score-international.com/results/?p=view_race_result&id=7202679&show_combined=1': fixture('score/livetime-2026-baja-1000-clasif-grupo1.html'),
  };
  for (const [id, pdf] of Object.entries(PAGES)) {
    r[scorePageUrl(Number(id))] = page(Number(id));
    if (pdf) r[docUrl(Number(id))] = fixture(`score/${pdf}.items.json`);
  }
  return r;
}

function setup(now = '2026-11-14T08:00:00Z') {
  const http = fakeHttp(routes());
  const ctx = createContext({ now: new Date(now), http, log: createLogger('test', true), previous: null });
  return { http, ctx, adapter: createScoreAdapter({ pdfItems }) };
}

describe('SCORE: nombres, sedes y horas', () => {
  it('reconoce cada carrera con cualquiera de sus nombres', () => {
    expect(scoreRaceKey('39th SCORE San Felipe 250')).toBe('san-felipe-250');
    expect(scoreRaceKey('Race Info – 2025 SF250')).toBe('san-felipe-250');
    expect(scoreRaceKey('2026 SCORE SanFelipe 250')).toBe('san-felipe-250');
    expect(scoreRaceKey('Schedule of Events – 2026 Baja 1000')).toBe('baja-1000');
    expect(scoreRaceKey('40th SCORE Baja 250')).toBe('baja-250');
    expect(scoreRaceKey('Course Map – Adaptive')).toBeNull();
  });

  it('sede y zona horaria: Baja California Sur no cambia la hora; Baja California, como California', () => {
    expect(scoreVenue('San Jose Del Cabo, Baja California Sur')).toBe('San José del Cabo');
    expect(scoreVenue('Ensenada, Baja California, Mexico')).toBe('Ensenada');
    expect(scoreVenue('Peninsula Run – Ensenada B.C. to End TBA')).toBe('Ensenada > a confirmar');
    expect(scoreTimeZone('San Jose Del Cabo, Baja California Sur')).toBe('America/Mazatlan');
    expect(scoreTimeZone('Mexicali, Baja California')).toBe('America/Tijuana');
    expect(scoreTimeZone('Peninsula Run – Ensenada B.C. to End TBA')).toBe('America/Tijuana');
  });

  it('lee la hora del principio de cada renglón del cronograma', () => {
    expect(leadingTime('8am-5pm Contingency / Tech – Boulevard Centenario')).toEqual({ start: '08:00', end: '17:00', rest: 'Contingency / Tech – Boulevard Centenario' });
    expect(leadingTime('1:00 am MOTO/QUAD START – All MOTO / QUAD Classes')).toMatchObject({ start: '01:00' });
    expect(leadingTime('8am - Done Baja 1000 Qualifying – Location')).toEqual({ start: '08:00', rest: 'Baja 1000 Qualifying – Location' });
    expect(leadingTime('12:00 Noon Awards Celebration – See below')).toMatchObject({ start: '12:00', rest: 'Awards Celebration – See below' });
    expect(leadingTime('12:15am (Friday Morning) MOTO/QUAD STAGING BEGINS')).toMatchObject({ start: '00:15' });
    expect(leadingTime('10:00-11am Race team period to submit result inquiries')).toMatchObject({ start: '10:00', end: '11:00' });
    expect(leadingTime('9:30-1:00p Media Center Open')).toMatchObject({ start: '09:30', end: '13:00' });
    expect(leadingTime('TIME GAP – Approx. 8-hour gap')).toBeNull();
    expect(leadingTime('1 Peña Colorado 216.63')).toBeNull();
  });

  it('solo van a la agenda la clasificación, la técnica, las largadas y la premiación', () => {
    expect(scheduleKind('Baja 1000 Qualifying – Location Will Be Provided at Race Registration on Monday')).toBe('clasificacion');
    expect(scheduleKind('Qualifying Registration TT/TT 2WD/TT Leg//TT Spec/Class One')).toBeNull();
    expect(scheduleKind('Media Registration for Access to Qualifying Site – Rancho Frondoso')).toBeNull();
    expect(scheduleKind('Racer Registration - Mandatory for Qualifying Teams Only')).toBeNull();
    expect(scheduleKind('Contingency Row - On the Malecon')).toBe('tecnica');
    expect(scheduleKind('Chassis Inspections – By appointment')).toBeNull();
    expect(scheduleKind('Moto-Quad Timed (Chrono) Start at Start/Finish area in front of RdEC')).toBe('largada-motos');
    expect(scheduleKind('Timed (Chrono) 4WV Start at Start/Finish ramp area in front of RdEC')).toBe('largada-autos');
    expect(scheduleKind('RACE START - All 4-Wheel Classes - Class start order as listed in Race Info')).toBe('largada-autos');
    expect(scheduleKind('ALL 4-WHEEL CLASSES STAGING BEGINS – All 4-Wheel Classes - Start/Finish Area')).toBeNull();
    expect(scheduleKind('Awards Celebration – Riviera de Ensenada Center')).toBe('premiacion');
  });
});

describe('SCORE: calendario de la temporada', () => {
  it('2026: San Felipe 250, Baja 500, Baja 400 y Baja 1000 con fechas, sede y distancia', () => {
    const races = parseScoreCalendar(items('calendario-2026'), 2026);
    expect(races.map((r) => [r.name, r.edition, r.dateStart, r.dateEnd])).toEqual([
      ['San Felipe 250', 39, '2026-03-25', '2026-03-29'],
      ['Baja 500', 58, '2026-06-03', '2026-06-07'],
      ['Baja 400', 7, '2026-09-09', '2026-09-13'],
      ['Baja 1000', 59, '2026-11-09', '2026-11-15'],
    ]);
    const b1000 = races[3]!;
    expect(b1000.place).toBe('San Jose Del Cabo, Baja California Sur');
    expect(b1000).toMatchObject({ distanceMi: 1000, distanceKm: 1609 });
    expect(b1000.days).toContainEqual({ date: '2026-11-13', text: 'Start of 59th Baja 1000' });
  });

  it('2027: la Baja 250 en Mexicali y la Baja 1000 de punta a punta de la península', () => {
    const races = parseScoreCalendar(items('calendario-2027'), 2027);
    expect(races.map((r) => [r.key, r.dateStart, r.dateEnd])).toEqual([
      ['baja-250', '2027-03-17', '2027-03-21'],
      ['baja-500', '2027-06-02', '2027-06-06'],
      ['baja-400', '2027-09-08', '2027-09-12'],
      ['baja-1000', '2027-11-14', '2027-11-20'],
    ]);
    expect(races[0]!.place).toBe('Mexicali, Baja California');
    expect(races[3]!.place).toBe('Peninsula Run – Ensenada B.C. to End TBA');
  });

  it('busca el calendario y los documentos de cada carrera por el título de la página', () => {
    const calendars = parseWpSearch(JSON.parse(fixture('score/search-race-schedule.json')));
    expect(findScoreCalendar(calendars, 2027)?.id).toBe(28683);
    expect(findScoreCalendar(calendars, 2026)?.id).toBe(27582);
    expect(findScoreCalendar(calendars, 2028)).toBeUndefined();
    const schedules = parseWpSearch(JSON.parse(fixture('score/search-schedule-of-events.json')));
    // La versión en español no se usa.
    expect(findScoreDoc(schedules, /^schedule of events\b/i, 2026, 'san-felipe-250')?.id).toBe(28155);
    expect(findScoreDoc(schedules, /^schedule of events\b/i, 2026, 'baja-1000')?.title).toBe('Schedule of Events – 2026 Baja 1000');
    const infos = parseWpSearch(JSON.parse(fixture('score/search-race-info.json')));
    expect(findScoreDoc(infos, /\brace info(?:rmation)?\b/i, 2026, 'baja-500')?.id).toBe(28522);
    expect(findScoreDoc(infos, /\brace info(?:rmation)?\b/i, 2025, 'san-felipe-250')?.title).toBe('Race Info – 2025 SF250');
  });
});

describe('SCORE: cronograma de cada carrera', () => {
  it('Baja 1000 2026: clasificación, dos días de técnica, largadas de motos y autos, 40 horas y premiación', () => {
    const s = parseScoreSchedule(items('cronograma-2026-baja-1000'), { dateStart: '2026-11-09', dateEnd: '2026-11-15' });
    expect(s.items.map((i) => [i.kind, i.date, i.start, i.end ?? null])).toEqual([
      ['clasificacion', '2026-11-10', '08:00', null],
      ['tecnica', '2026-11-11', '08:00', '17:00'],
      ['tecnica', '2026-11-12', '08:00', '17:00'],
      ['largada-motos', '2026-11-13', '01:00', null],
      ['largada-autos', '2026-11-13', '09:00', null],
      ['premiacion', '2026-11-15', '12:00', null],
    ]);
    expect(s).toMatchObject({ distanceMi: 964.96, distanceKm: 1552.95, timeLimitHours: 40 });
  });

  it('Baja 400, Baja 500 y San Felipe 250: la distancia de las clases Pro y su tiempo límite', () => {
    const b400 = parseScoreSchedule(items('cronograma-2026-baja-400'), { dateStart: '2026-09-09', dateEnd: '2026-09-13' });
    expect(b400.items.map((i) => [i.kind, i.date, i.start])).toEqual([
      ['clasificacion', '2026-09-10', '08:00'],
      ['tecnica', '2026-09-11', '08:00'],
      ['largada-motos', '2026-09-12', '05:00'],
      ['largada-autos', '2026-09-12', '10:00'],
      ['premiacion', '2026-09-13', '12:30'],
    ]);
    expect(b400).toMatchObject({ distanceMi: 416, distanceKm: 669.49, timeLimitHours: 16 });
    // Baja 500: la largada de las motos no lo dice ("Timed (Chrono) Start"), pero es la primera del día.
    const b500 = parseScoreSchedule(items('cronograma-2026-baja-500'), { dateStart: '2026-06-03', dateEnd: '2026-06-07' });
    expect(b500.items.filter((i) => i.kind.startsWith('largada')).map((i) => [i.kind, i.start])).toEqual([
      ['largada-motos', '03:00'],
      ['largada-autos', '08:00'],
    ]);
    expect(b500.timeLimitHours).toBe(18);
    const sf = parseScoreSchedule(items('cronograma-2026-san-felipe-250'), { dateStart: '2026-03-25', dateEnd: '2026-03-29' });
    expect(sf.items.map((i) => [i.kind, i.date, i.start])).toEqual([
      ['clasificacion', '2026-03-26', '07:00'],
      ['tecnica', '2026-03-27', '08:00'],
      ['largada-motos', '2026-03-28', '06:00'],
      ['largada-autos', '2026-03-28', '10:00'],
      ['premiacion', '2026-03-29', '11:00'],
    ]);
    expect(sf).toMatchObject({ distanceMi: 283, distanceKm: 455.45, timeLimitHours: 14 });
  });
});

describe('SCORE: puestos de control', () => {
  it('Baja 1000 2026: nombres en dos renglones y la sigla de la llegada partida (T/M)', () => {
    const rows = parseScoreCheckpoints(items('race-info-2026-baja-1000'));
    expect(rows.map((r) => [r.code, r.place, r.mi, r.km])).toEqual([
      ['ST', 'San José del Cabo', 0, 0],
      ['1', 'Centenario - La Paz', 220.69, 355.17],
      ['2', 'Cd. Insurgentes', 412.49, 663.84],
      ['3', 'Francisco Villa', 611.16, 983.56],
      ['4', 'Santa Fe', 788.59, 1269.11],
      ['TM', 'San José del Cabo', 978.6, 1564.36],
    ]);
    expect(rows[1]!.times).toEqual([
      { time: '12:32', day: 'Fri' },
      { time: '11:32', day: 'Fri' },
      { time: '20:28', day: 'Fri' },
    ]);
  });

  it('cinco sectores entre la largada, los cuatro puestos y la llegada', () => {
    const rows = parseScoreCheckpoints(items('race-info-2026-baja-1000'));
    const stages = checkpointStages(rows, '2026-11-13', { startUtc: '2026-11-13T16:00:00Z', localStartText: '09:00' }, 40);
    expect(stages.map((s) => [s.code, s.name, s.kind, s.date, s.distanceKm])).toEqual([
      ['Sector 1', 'San José del Cabo > Centenario - La Paz', 'especial', '2026-11-13', 355.17],
      ['Sector 2', 'Centenario - La Paz > Cd. Insurgentes', 'especial', '2026-11-13', 308.67],
      ['Sector 3', 'Cd. Insurgentes > Francisco Villa', 'especial', '2026-11-13', 319.72],
      ['Sector 4', 'Francisco Villa > Santa Fe', 'especial', '2026-11-13', 285.55],
      ['Sector 5', 'Santa Fe > San José del Cabo', 'especial', '2026-11-13', 295.25],
    ]);
    expect(stages[0]).toMatchObject({ startUtc: '2026-11-13T16:00:00Z', localStartText: '09:00' });
    expect(stages[0]!.note).toBe(
      'Hasta el puesto de control 1 (Centenario - La Paz), en la milla 220,69 de carrera. Paso estimado del primero: 12:32 (vie); cierre: 20:28 (vie) (hora local). Tiempo límite de la carrera: 40 horas.',
    );
    expect(stages[4]!.note).toContain('Hasta la llegada, en la milla 978,60 de carrera. Paso estimado del primero: 00:33 (sáb); cierre: 03:23 (dom)');
  });

  it('Baja 400 y Baja 500: la llegada cronometrada es antes de la meta y el último tramo es un enlace', () => {
    const b400 = checkpointStages(parseScoreCheckpoints(items('race-info-2026-baja-400')), '2026-09-12');
    expect(b400.map((s) => [s.name, s.kind, s.distanceKm ?? s.liaisonKm])).toEqual([
      ['Riviera Ensenada > Peña Colorado', 'especial', 348.63],
      ['Peña Colorado > Rancho Nelson', 'especial', 332.38],
      ['Rancho Nelson > Riviera Ensenada', 'enlace', 25.23],
    ]);
    expect(b400[1]!.note).toContain('Hasta el control de cronometraje de Rancho Nelson, en la milla 423,16');
    // El control de cronometraje del arranque (0,43 millas) no corta un sector; "453:00" es una errata del PDF.
    const b500 = checkpointStages(parseScoreCheckpoints(items('race-info-2026-baja-500')), '2026-06-06');
    expect(b500.map((s) => [s.name, s.distanceKm ?? s.liaisonKm])).toEqual([
      ['Riviera Ensenada > Ej. Jamau Access', 419.47],
      ['Ej. Jamau Access > R. Nelson', 309.56],
      ['R. Nelson > Riviera Ensenada', 25.27],
    ]);
    expect(b500[1]!.note).toContain('en la milla 453,00 de carrera');
    const sf = checkpointStages(parseScoreCheckpoints(items('race-info-2026-san-felipe-250')), '2026-03-28');
    expect(sf.map((s) => s.name)).toEqual(['Malecon > Morelia Jct', 'Morelia Jct > Cronometraje', 'Cronometraje > Malecon']);
    expect(sf[2]!.note).toContain('la llegada cronometrada es en el control de cronometraje.');
  });
});

describe('SCORE: mapa y documentos de las páginas', () => {
  it('toma el PDF del visor embebido de la página', () => {
    expect(docUrl(28939)).toBe('https://score-raceinfo.com/wp-content/uploads/2026/10/2026-Baja-1000-Schedule-10.26.26-Rev.pdf');
    expect(docUrl(28964)).toBe('https://score-raceinfo.com/wp-content/uploads/2026/10/2026-B1000-map-final-compressed.pdf');
  });

  it('la imagen del mapa de la carrera en curso sale de la portada (solo si es la de esa carrera)', () => {
    const html = fixture('score/portada.html');
    expect(homepageMapUrl(html, 2026, 'baja-1000')).toBe('https://score-international.com/race-teams/images/race-maps/2026-B1000-map-small.jpg');
    expect(homepageMapUrl(html, 2026, 'baja-400')).toBeNull();
    expect(homepageMapUrl(html, 2027, 'baja-1000')).toBeNull();
  });
});

describe('SCORE: resultados de LiveTime', () => {
  it('lista de eventos y carreras de cada evento', () => {
    const events = parseLiveTimeEvents(fixture('score/livetime-eventos.html'));
    expect(events.slice(0, 4).map((e) => [e.id, e.key, e.year])).toEqual([
      ['524279', 'baja-1000', 2026],
      ['517132', 'baja-400', 2026],
      ['506395', 'baja-500', 2026],
      ['499546', 'san-felipe-250', 2026],
    ]);
    const races = parseLiveTimeEventPage(fixture('score/livetime-evento-2026-baja-400.html'));
    expect(races.map((r) => [r.section, r.name, r.url.replace(/^.*\?/, '')])).toEqual([
      ['practica', 'Group 1 practice', 'p=view_race_result&id=7043319&show_combined=1'],
      ['practica', 'Group 2 practice', 'p=view_race_result&id=7043316'],
      ['clasificacion', 'Group 1 Qualifying', 'p=view_race_result&id=7043506&show_combined=1'],
      ['clasificacion', 'SCORE Trophy Truck Qualifying', 'p=view_race_result&id=7043507'],
      ['carrera', 'Baja 400 Moto', 'p=view_race_result&id=7047208&show_combined=1'],
      ['carrera', 'BAJA 400 4-wheel', 'p=view_race_result&id=7047215&show_combined=1'],
    ]);
    expect(pickRaces({ type: 'clasificacion', name: 'Clasificación' }, races).map((r) => r.name)).toEqual(['SCORE Trophy Truck Qualifying', 'Group 1 Qualifying']);
    expect(pickRaces({ type: 'carrera', name: 'Carrera de motos y cuatriciclos' }, races).map((r) => r.name)).toEqual(['Baja 400 Moto']);
    expect(pickRaces({ type: 'carrera', name: 'Carrera de autos, camionetas y UTV' }, races).map((r) => r.name)).toEqual(['BAJA 400 4-wheel']);
  });

  it('clasificación general con clase, puesto en la clase, abandonos y descalificados', () => {
    const { rows } = parseLiveTimeResult(fixture('score/livetime-2026-baja-400-autos.html'));
    expect(rows[0]).toEqual({ pos: 1, number: '83', driver: 'Luke McMillin', time: '8:40:50.386', class: 'SCORE Trophy Truck', classPos: 1 });
    expect(rows[1]).toEqual({ pos: 2, number: '7', driver: 'Bryce Menzies', time: '8:43:22.272', gap: '+2:31.886', class: 'SCORE Trophy Truck', classPos: 2 });
    expect(rows[4]).toMatchObject({ pos: 5, number: '1L', driver: 'Gustavo Vildosola', class: 'SCORE Trophy Truck Legends', classPos: 1 });
    expect(rows.find((r) => r.number === '21')).toEqual({ pos: null, status: 'DNF', number: '21', driver: 'Andy McMillin', class: 'SCORE Trophy Truck' });
    expect(rows.at(-1)).toEqual({ pos: null, status: 'DSQ', number: '1821', driver: 'Cayden Maccachren', time: '9:39:38.173', class: 'Pro UTV Open' });
    const motos = parseLiveTimeResult(fixture('score/livetime-2026-baja-400-motos.html')).rows;
    expect(motos[0]).toMatchObject({ pos: 1, number: '1X', driver: 'Tyler Lynn', class: 'Pro Moto Unlimited', classPos: 1 });
    // "DQ" y "DNF" a la vez: vale la descalificación.
    expect(motos.at(-1)).toMatchObject({ pos: null, status: 'DSQ', number: '17A', class: 'Pro Quad' });
  });

  it('una clase sola (Trophy Truck): la clase la da la carrera', () => {
    const { rows } = parseLiveTimeResult(fixture('score/livetime-2026-baja-1000-clasif-tt.html'), 'SCORE Trophy Truck');
    expect(rows.map((r) => [r.pos, r.number, r.driver, r.time])).toEqual([
      [1, '94', 'Christopher Polvoorde', '2:34.868'],
      [2, '1', 'Alan Ampudia', '2:36.478'],
      [3, '24', 'Adam Householder', '2:40.073'],
      [4, '70', 'Kevin Thompson', '2:40.605'],
      [5, '83', 'Luke McMillin', '2:41.701'],
      [6, '7', 'Bryce Menzies', '2:42.092'],
      [7, '62', 'Dodge Poelman', '2:49.695'],
      [8, '32', 'Ryan Arciero', '2:50.067'],
    ]);
    expect(rows.every((r) => r.class === 'SCORE Trophy Truck')).toBe(true);
  });
});

describe('SCORE: lector completo', () => {
  it('está registrado como lector directo', () => {
    expect(adapters.score).toBeDefined();
  });

  it('calendario 2026 y 2027, cronogramas en hora local y el itinerario de la Baja 1000', async () => {
    const { ctx, adapter, http } = setup();
    const chunk = await adapter.schedule(series, ctx);
    expect(chunk.events.map((e) => [e.name, e.dateStart, e.circuit, e.tz, e.sessionsStatus, e.stageCount ?? 0])).toEqual([
      ['San Felipe 250', '2026-03-25', 'San Felipe', 'America/Tijuana', 'published', 2],
      ['Baja 500', '2026-06-03', 'Ensenada', 'America/Tijuana', 'published', 2],
      ['Baja 400', '2026-09-09', 'Ensenada', 'America/Tijuana', 'published', 2],
      ['Baja 1000', '2026-11-09', 'San José del Cabo', 'America/Mazatlan', 'published', 5],
      ['Baja 250', '2027-03-17', 'Mexicali', 'America/Tijuana', 'pending', 0],
      ['Baja 500', '2027-06-02', 'Ensenada', 'America/Tijuana', 'pending', 0],
      ['Baja 400', '2027-09-08', 'Ensenada', 'America/Tijuana', 'pending', 0],
      ['Baja 1000', '2027-11-14', 'Ensenada > a confirmar', 'America/Tijuana', 'pending', 0],
    ]);
    for (const e of chunk.events) {
      eventSchema.parse(e);
      expect(e).toMatchObject({ country: 'México', surface: 'arena' });
    }
    // El id lleva la temporada del evento: la Baja 1000 2027 no pisa la de 2026.
    const b1000 = chunk.events.find((e) => e.id === stableHash('score-baja', 2026, 'baja-1000'))!;
    expect(chunk.events.filter((e) => e.id === stableHash('score-baja', 2027, 'baja-1000'))).toHaveLength(1);

    const sessions = chunk.sessions.filter((s) => s.eventId === b1000.id);
    // Sin hora de fin publicada (clasificación y premiación), el fin se estima (config/durations.json; en la prueba,
    // la duración por defecto).
    expect(sessions.map((s) => [s.type, s.name, s.startUtc, s.endUtc, s.localStartText, s.endEstimated])).toEqual([
      ['clasificacion', 'Clasificación', '2026-11-10T15:00:00Z', '2026-11-10T16:00:00Z', '08:00', true],
      ['otro', 'Contingencia e inspección técnica', '2026-11-11T15:00:00Z', '2026-11-12T00:00:00Z', '08:00', false],
      ['otro', 'Contingencia e inspección técnica', '2026-11-12T15:00:00Z', '2026-11-13T00:00:00Z', '08:00', false],
      // Fin: el tiempo límite oficial (40 horas desde la largada).
      ['carrera', 'Carrera de motos y cuatriciclos', '2026-11-13T08:00:00Z', '2026-11-15T00:00:00Z', '01:00', false],
      ['carrera', 'Carrera de autos, camionetas y UTV', '2026-11-13T16:00:00Z', '2026-11-15T08:00:00Z', '09:00', false],
      ['otro', 'Premiación', '2026-11-15T19:00:00Z', '2026-11-15T20:00:00Z', '12:00', true],
    ]);
    expect(new Set(sessions.map((s) => s.id)).size).toBe(sessions.length);
    for (const s of chunk.sessions) sessionSchema.parse(s);
    // Ninguna sesión queda afuera por la validación general (la Baja 1000 dura hasta 40 horas).
    expect(validateSessions(chunk.sessions, chunk.events).issues).toEqual([]);
    expect(sessions[0]!.source).toMatchObject({ url: 'https://score-raceinfo.com/schedule-of-events-2026-baja-1000/', kind: 'pdf', method: 'directo' });

    // San Felipe 250 en marzo: Baja California ya está en horario de verano (UTC-7).
    const sf = chunk.sessions.filter((s) => s.eventId === stableHash('score-baja', 2026, 'san-felipe-250'));
    expect(sf.find((s) => s.type === 'clasificacion')!.startUtc).toBe('2026-03-26T14:00:00Z');

    const file = chunk.stages!.find((f) => f.eventId === b1000.id)!;
    eventStagesFileSchema.parse(file);
    expect(file).toMatchObject({
      seriesId: 'score-baja',
      surface: 'arena',
      competitiveKm: 1564.36,
      routeMapUrl: 'https://score-international.com/race-teams/images/race-maps/2026-B1000-map-small.jpg',
      routeMapCredit: '© SCORE International',
    });
    expect(file.source.url).toBe('https://score-raceinfo.com/race-info-2026-baja-1000/');
    expect(file.stages[0]!.sessionId).toBe(sessions[4]!.id);
    // Las carreras ya corridas enlazan el PDF del mapa (la portada solo muestra el de la carrera en curso).
    const b400File = chunk.stages!.find((f) => f.eventId === stableHash('score-baja', 2026, 'baja-400'))!;
    expect(b400File).toMatchObject({ competitiveKm: 681.01, totalKm: 706.24, routeMapUrl: docUrl(28778) });
    expect(chunk.stages).toHaveLength(4);
    // Sin documentos de 2027 todavía: no se piden cronogramas que no existen.
    expect(http.calls.filter((u) => /\/pages\/\d+/.test(u))).toHaveLength(2 + 4 * 2 + 3);
  });

  it('resultados de la Baja 400 (motos y autos) y la clasificación de la Baja 1000 por tandas', async () => {
    const { ctx, adapter } = setup();
    const chunk = await adapter.schedule(series, ctx);
    const events: MotorEvent[] = chunk.events;
    const pending: Session[] = chunk.sessions
      .filter((s) => Date.parse(s.endUtc) < ctx.now.getTime())
      .filter((s) => [stableHash('score-baja', 2026, 'baja-400'), stableHash('score-baja', 2026, 'baja-1000')].includes(s.eventId))
      .filter((s) => s.type !== 'clasificacion' || s.eventId !== stableHash('score-baja', 2026, 'baja-400'))
      .sort((a, b) => b.startUtc.localeCompare(a.startUtc));
    const out = await adapter.results!(series, ctx, { events, pendingSessions: pending, sessions: chunk.sessions, standingsStale: false });
    for (const f of out.results) eventResultsFileSchema.parse(f);
    const byName = (eventKey: string, name: string) => {
      const event = stableHash('score-baja', 2026, eventKey);
      const session = chunk.sessions.find((s) => s.eventId === event && s.name === name)!;
      return out.results.find((f) => f.eventId === event)?.sessions.find((r) => r.sessionId === session.id);
    };
    const cars = byName('baja-400', 'Carrera de autos, camionetas y UTV')!;
    expect(cars.rows[0]).toMatchObject({ pos: 1, driver: 'Luke McMillin', class: 'SCORE Trophy Truck', classPos: 1 });
    expect(cars.source).toMatchObject({ url: 'https://results.score-international.com/results/?p=view_race_result&id=7047215&show_combined=1', method: 'directo' });
    expect(byName('baja-400', 'Carrera de motos y cuatriciclos')!.rows[0]).toMatchObject({ pos: 1, driver: 'Tyler Lynn', class: 'Pro Moto Unlimited' });

    // Clasificación: la tanda de Trophy Truck da el puesto; la otra tanda, solo el puesto en su clase.
    const quali = byName('baja-1000', 'Clasificación')!;
    expect(quali.rows.slice(0, 2)).toEqual([
      { pos: 1, number: '94', driver: 'Christopher Polvoorde', time: '2:34.868', class: 'SCORE Trophy Truck', classPos: 1 },
      { pos: 2, number: '1', driver: 'Alan Ampudia', time: '2:36.478', gap: '+1.610', class: 'SCORE Trophy Truck', classPos: 2 },
    ]);
    expect(quali.rows[8]).toEqual({ pos: null, number: '1L', driver: 'Gustavo Vildosola Sr.', time: '2:36.540', class: 'SCORE Trophy Truck Legends', classPos: 1 });
    expect(quali.rows.at(-1)).toMatchObject({ pos: null, status: 'DNS', number: '86L', class: 'SCORE Trophy Truck Legends' });
    // Las carreras de la Baja 1000 todavía no terminaron: no se piden.
    expect(byName('baja-1000', 'Carrera de autos, camionetas y UTV')).toBeUndefined();
  });

  it('sin el calendario de la temporada en curso, falla (run.ts conserva lo publicado)', async () => {
    const http = fakeHttp({ ...routes(), [scoreSearchUrl(SCORE_QUERIES.calendar)]: '[]' });
    const ctx = createContext({ now: new Date('2026-11-14T08:00:00Z'), http, log: createLogger('test', true), previous: null });
    await expect(createScoreAdapter({ pdfItems }).schedule(series, ctx)).rejects.toThrow(/calendario 2026/);
  });
});
