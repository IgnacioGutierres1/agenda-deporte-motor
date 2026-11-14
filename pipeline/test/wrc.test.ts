import { describe, expect, it } from 'vitest';
import { eventStagesFileSchema, type Series, type Session } from '@dm/shared';
import { adapters } from '../src/adapters/index.ts';
import { cleanRallyName, createWrcAdapter, surfaceOf, wrcAdapter, wrcSeasonArticle } from '../src/adapters/wrc.ts';
import {
  crewRows,
  fiaWrcCalendarUrl,
  fiaWrcStandingsUrl,
  parseFiaCalendar,
  parseFiaClassifications,
  parseFiaEntryList,
  parseFiaStandings,
  rallyGap,
} from '../src/adapters/wrc-fia.ts';
import { parseRallyArticle, parseSeasonCalendar, wikiPagesUrl, wikiPlain } from '../src/adapters/wrc-wikipedia.ts';
import {
  parseWrcCalendarPage,
  parseWrcItinerary,
  WRC_CALENDAR_CONFIG_URL,
  WRC_CALENDAR_URL,
  seasonFromConfig,
  wrcContentUrl,
  wrcSeasonFeedUrl,
  wrcTabsUrl,
} from '../src/adapters/wrc-site.ts';
import { normalizeSession } from '../src/core/builders.ts';
import { createContext } from '../src/core/context.ts';
import { createHttp, HttpError } from '../src/core/http.ts';
import { createLogger } from '../src/core/log.ts';
import { scheduleWithNextSeason } from '../src/core/season.ts';
import type { ResultsRequest } from '../src/core/types.ts';
import { sameStages } from '../src/run.ts';
import { validateSessions } from '../src/validate.ts';
import { fakeHttp, fixture } from './fake-http.ts';

const series: Series = {
  id: 'wrc',
  name: 'Campeonato Mundial de Rally (WRC)',
  shortName: 'WRC',
  group: 'rally',
  officialUrls: ['https://www.wrc.com/en/calendar'],
  strategy: 'adapter',
  adapter: 'wrc',
  origin: 'default',
  enabled: true,
};

const FIA = 'https://www.fia.com/events/world-rally-championship/season-2026';
const ITALIA_CLASSIFICATIONS = `${FIA}/rally-ditalia/classifications`;
const ITALIA_ENTRY_LIST = `${FIA}/rally-ditalia/entry-list`;
const WRC_SEASON_2027 = 'rrn:content:event-seasons:a2afb291-1ee4-4950-bef3-71b3c67597b7:en-INT';
const MONTE_ITINERARY_ID = 'rrn:content:event-details:3a0c19f2-ed64-4113-9d32-40920b3e9326:en-INT';

/** Wikitexto del primer artículo de una respuesta real (recortada) de la API de Wikipedia. */
function wikitext(file: string, title?: string): string {
  const pages = (JSON.parse(fixture(file)) as { query: { pages: Array<{ title: string; revisions: Array<{ slots: { main: { content: string } } }> }> } }).query.pages;
  return (title ? pages.find((p) => p.title === title)! : pages[0]!).revisions[0]!.slots.main.content;
}

const season2026 = wikitext('wrc/wiki-season-2026.json');
const season2027 = wikitext('wrc/wiki-season-2027.json');
const articles = (text: string, season: number) => parseSeasonCalendar(text, season).map((r) => r.article);

function routes(overrides: Record<string, string | (() => string)> = {}): Record<string, string | (() => string)> {
  return {
    [fiaWrcCalendarUrl(2026)]: fixture('wrc/fia-calendar-2026.html'),
    [wikiPagesUrl([wrcSeasonArticle(2026)])]: fixture('wrc/wiki-season-2026.json'),
    [wikiPagesUrl(articles(season2026, 2026))]: fixture('wrc/wiki-rallies-2026.json'),
    // 2027: la FIA todavía no abrió la página (404) y Wikipedia no tiene artículos por rally.
    [wikiPagesUrl([wrcSeasonArticle(2027)])]: fixture('wrc/wiki-season-2027.json'),
    [wikiPagesUrl(articles(season2027, 2027))]: fixture('wrc/wiki-rallies-2027.json'),
    [ITALIA_CLASSIFICATIONS]: fixture('wrc/fia-classifications-italia-2026.html'),
    [ITALIA_ENTRY_LIST]: fixture('wrc/fia-entry-list-italia-2026.html'),
    [fiaWrcStandingsUrl(2026)]: fixture('wrc/fia-standings-2026.html'),
    // wrc.com: calendario 2027 (página + feed completo) e itinerario de Montecarlo; Suecia todavía sin itinerario.
    [WRC_CALENDAR_CONFIG_URL]: fixture('wrc/wrc-calendar-config.json'),
    [WRC_CALENDAR_URL]: fixture('wrc/wrc-calendar.html'),
    [wrcSeasonFeedUrl(WRC_SEASON_2027)]: fixture('wrc/wrc-season-feed-2027.json'),
    [wrcTabsUrl('wrc-rallye-monte-carlo-2027')]: fixture('wrc/wrc-tabs-monte-carlo-2027.json'),
    [wrcContentUrl(MONTE_ITINERARY_ID)]: fixture('wrc/wrc-itinerary-monte-carlo-2027.json'),
    [wrcTabsUrl('wrc-rally-sweden-2027')]: fixture('wrc/wrc-tabs-sweden-2027.json'),
    ...overrides,
  };
}

function ctxWith(http: ReturnType<typeof fakeHttp>, now = '2026-11-12T15:00:00.000Z') {
  return createContext({
    now: new Date(now),
    http,
    log: createLogger('test', true),
    durations: { wrc: { practica: 180, etapa: 60, carrera: 75 } },
    broadcast: { wrc: ['Rally.TV'] },
  });
}

describe('WRC: calendario de la FIA', () => {
  const rallies = parseFiaCalendar(fixture('wrc/fia-calendar-2026.html'), 2026);

  it('lee los 14 rallies con fechas, país y link a sus clasificaciones', () => {
    expect(rallies).toHaveLength(14);
    expect(rallies[0]).toMatchObject({
      name: '94e Rallye Monte-Carlo',
      dateStart: '2026-01-22',
      dateEnd: '2026-01-25',
      iso2: 'MC',
      cancelled: false,
      slug: '94e-rallye-monte-carlo',
      classificationsUrl: `${FIA}/94e-rallye-monte-carlo/classifications`,
    });
    expect(rallies.map((r) => r.iso2).join(' ')).toBe('MC SE KE HR ES PT JP GR EE FI PY CL IT SA');
    expect(rallies.find((r) => r.iso2 === 'ES')).toMatchObject({ dateStart: '2026-04-22', dateEnd: '2026-04-26' });
  });

  it('marca el Rally de Arabia Saudita como cancelado (sin página propia)', () => {
    const saudi = rallies.at(-1)!;
    expect(saudi).toMatchObject({ name: 'Rally Saudi Arabia', dateStart: '2026-11-12', dateEnd: '2026-11-15', cancelled: true });
    expect(saudi.slug).toBeUndefined();
    expect(rallies.filter((r) => r.cancelled)).toHaveLength(1);
  });

  it('limpia la sigla y el año que la FIA agrega a algunos nombres', () => {
    expect(cleanRallyName('WRC Croatia Rally 2026', 2026)).toBe('Croatia Rally');
    expect(cleanRallyName('EKO Acropolis Rally 2026', 2026)).toBe('EKO Acropolis Rally');
    expect(cleanRallyName('94e Rallye Monte-Carlo', 2026)).toBe('94e Rallye Monte-Carlo');
  });
});

describe('WRC: Wikipedia', () => {
  it('lee la tabla del calendario: sede, superficie y artículo de cada rally', () => {
    const rows = parseSeasonCalendar(season2026, 2026);
    expect(rows).toHaveLength(13); // el rally retirado figura en otra tabla
    expect(rows[0]).toMatchObject({
      round: 1,
      dateStart: '2026-01-22',
      dateEnd: '2026-01-25',
      name: 'Rallye Automobile Monte Carlo',
      flag: 'MON',
      city: 'Gap',
      hqCountry: 'France',
      surface: 'Mixed',
      article: '2026 Monte Carlo Rally',
    });
    expect(rows[0]!.surfaceNote).toMatch(/tarmac and snow/);
    expect(rows.map((r) => r.surface).join(' ')).toBe('Mixed Snow Gravel Tarmac Tarmac Gravel Tarmac Gravel Gravel Gravel Gravel Gravel Gravel');
    expect(rows.map((r) => r.city)).toEqual([
      'Gap', 'Umeå', 'Nairobi', 'Rijeka', 'Las Palmas', 'Matosinhos', 'Toyota', 'Loutraki', 'Tartu', 'Jyväskylä', 'Encarnación', 'Talcahuano', 'Alghero',
    ]);
    expect(rows.at(-1)).toMatchObject({ round: 13, dateStart: '2026-10-01', dateEnd: '2026-10-04', article: '2026 Rally Italia Sardegna' });
  });

  it('lee el calendario de la temporada siguiente (el artículo de cada rally sale de la tabla de resultados, aunque esté comentada)', () => {
    const rows = parseSeasonCalendar(season2027, 2027);
    expect(rows).toHaveLength(15);
    expect(rows[0]).toMatchObject({ round: 1, dateStart: '2027-01-21', dateEnd: '2027-01-24', city: 'Gap', article: '2027 Monte Carlo Rally' });
    expect(rows[7]).toMatchObject({ name: "Rally d'Italia", city: 'Rome', surface: 'Tarmac', article: "2027 Rally d'Italia" });
    expect(rows[10]).toMatchObject({ flag: 'USA', city: 'Knoxville', hqCountry: 'United States', dateStart: '2027-08-26' });
    expect(rows[14]).toMatchObject({ flag: 'SAU', city: 'Jeddah', dateStart: '2027-11-25', dateEnd: '2027-11-28' });
  });

  it('traduce la superficie (Montecarlo es asfalto con nieve, no "mixto")', () => {
    expect(surfaceOf('Gravel')).toEqual({ surface: 'tierra' });
    expect(surfaceOf('Tarmac')).toEqual({ surface: 'asfalto' });
    expect(surfaceOf('Snow')).toEqual({ surface: 'nieve' });
    expect(surfaceOf('Mixed', 'The Monte Carlo Rally was run on a tarmac and snow surface.')).toEqual({ surface: 'asfalto', note: 'Asfalto y nieve' });
    expect(surfaceOf('Mixed', 'Run on tarmac and gravel.')).toEqual({ surface: 'mixto' });
    expect(surfaceOf('Mixed')).toEqual({ surface: 'mixto' });
    expect(surfaceOf('')).toEqual({});
  });

  it('lee el itinerario de un rally: tramos, horas locales, kilómetros, Shakedown, superespecial y Power Stage', () => {
    const it2026 = parseRallyArticle(wikitext('wrc/wiki-rallies-2026.json', '2026 Rally Italia Sardegna'), '2026-10-01');
    expect(it2026.utcOffsetMinutes).toBe(120);
    expect(it2026.surface).toBe('Gravel');
    expect(it2026.overallKm).toBe(1626.79);
    expect(it2026.stages).toHaveLength(18);
    expect(it2026.stages[0]).toEqual({ code: 'Shakedown', name: 'Monte Baranta', kind: 'shakedown', date: '2026-10-01', time: '09:01', km: 3.27 });
    expect(it2026.stages[1]).toMatchObject({ code: 'SS1', number: 1, name: 'Ittiri Arena Show', kind: 'superespecial', date: '2026-10-01' });
    expect(it2026.stages[2]).toEqual({ code: 'SS2', number: 2, name: 'Tula – Erula 1', kind: 'especial', date: '2026-10-02', time: '08:01', km: 18.77 });
    expect(it2026.stages.at(-1)).toEqual({ code: 'SS17', number: 17, name: 'Sassari – Argentiera 2', kind: 'power', date: '2026-10-04', time: '14:15', km: 7.1 });
    // Sin asistencias, reagrupamientos ni ceremonias.
    expect(it2026.stages.every((s) => s.code === 'Shakedown' || /^SS\d+$/.test(s.code))).toBe(true);
  });

  it('el Shakedown puede caer el día anterior al inicio del rally (Montecarlo)', () => {
    const monte = parseRallyArticle(wikitext('wrc/wiki-rallies-2026.json', '2026 Monte Carlo Rally'), '2026-01-22');
    expect(monte.stages[0]).toEqual({ code: 'Shakedown', name: 'Gap', kind: 'shakedown', date: '2026-01-21', time: '14:01', km: 4.25 });
    expect(monte.surface).toBe('Tarmac and snow');
    expect(monte.stages.filter((s) => s.kind !== 'shakedown')).toHaveLength(17);
    expect(monte.stages.find((s) => s.code === 'SS13')).toMatchObject({ name: 'Monaco Circuit', kind: 'superespecial', km: 2.69 });
  });

  it('lee un itinerario publicado antes del rally (Arabia Saudita 2026, luego retirado del calendario)', () => {
    const saudi = parseRallyArticle(wikitext('wrc/wiki-rally-saudi-2026.json'), '2026-11-12');
    expect(saudi.utcOffsetMinutes).toBe(180);
    expect(saudi.stages.map((s) => s.code).join(' ')).toBe('Shakedown SS1 SS2 SS3 SS4 SS5 SS6 SS7 SS8 SS9 SS10 SS11 SS12 SS13 SS14 SS15 SS16');
    expect(saudi.stages[0]).toMatchObject({ name: 'Thabhan', date: '2026-11-11', time: '11:01' });
    expect(saudi.stages.at(-1)).toMatchObject({ name: 'Thabhan 2', kind: 'power', date: '2026-11-14', time: '14:15', km: 16.42 });
  });

  it('wikiPlain conserva los corchetes escritos con <nowiki> y quita referencias y plantillas', () => {
    expect(wikiPlain('Gap <nowiki>[</nowiki>[[Shakedown (testing)|Shakedown]]<nowiki>]</nowiki>')).toBe('Gap [Shakedown]');
    expect(wikiPlain('BioBio 2 [<nowiki/>[[Power Stage]]]')).toBe('BioBio 2 [Power Stage]');
    expect(wikiPlain("''Service A'', [[Gap, Hautes-Alpes|Gap]]")).toBe('Service A, Gap');
    expect(wikiPlain('339.15&nbsp;km<ref name="x">{{cite web|url=https://example.org|title=T}}</ref>')).toBe('339.15 km');
  });
});

describe('lector WRC: calendario, superficie e itinerario', () => {
  it('está registrado', () => {
    expect(adapters.wrc).toBe(wrcAdapter);
  });

  it('publica los 13 rallies corridos, con sede y superficie, y no el cancelado', async () => {
    const http = fakeHttp(routes());
    const { events } = await wrcAdapter.schedule(series, ctxWith(http));
    expect(events).toHaveLength(13);
    expect(events.map((e) => e.round)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(events.some((e) => /saudi/i.test(e.name))).toBe(false);
    expect(events.map((e) => [e.name, e.circuit, e.country, e.surface])).toEqual([
      ['94e Rallye Monte-Carlo', 'Gap (Francia)', 'Mónaco', 'asfalto'],
      ['Rally Sweden', 'Umeå', 'Suecia', 'nieve'],
      ['Safari Rally Kenya', 'Nairobi', 'Kenia', 'tierra'],
      ['Croatia Rally', 'Rijeka', 'Croacia', 'asfalto'],
      ['50 Rally Islas Canarias - Rally de España', 'Las Palmas', 'España', 'asfalto'],
      ['Vodafone Rally Portugal', 'Matosinhos', 'Portugal', 'tierra'],
      ['Rally Japan', 'Toyota', 'Japón', 'asfalto'],
      ['EKO Acropolis Rally', 'Loutraki', 'Grecia', 'tierra'],
      ['Rally Estonia', 'Tartu', 'Estonia', 'tierra'],
      ['Secto Rally Finland', 'Jyväskylä', 'Finlandia', 'tierra'],
      ['Rally del Paraguay', 'Encarnación', 'Paraguay', 'tierra'],
      ['Rally Chile BioBio', 'Talcahuano', 'Chile', 'tierra'],
      ["Rally d'Italia", 'Alghero', 'Italia', 'tierra'],
    ]);
    // Las fechas son las de la FIA (Wikipedia da 23 al 26 de abril para Canarias).
    expect(events[4]).toMatchObject({ dateStart: '2026-04-22', dateEnd: '2026-04-26', tz: 'Atlantic/Canary' });
    expect(events[0]!.source).toMatchObject({
      url: fiaWrcCalendarUrl(2026),
      title: 'FIA: calendario del WRC 2026 (sede y superficie: Wikipedia, «2026 World Rally Championship»)',
      method: 'directo',
    });
    // wrc.com se consulta, pero su calendario es el de 2027: el de 2026 sale de la FIA.
    expect(http.calls).toContain(WRC_CALENDAR_CONFIG_URL);
  });

  it('arma los bloques del rally: Shakedown, una etapa por día y la Power Stage aparte', async () => {
    const chunk = await wrcAdapter.schedule(series, ctxWith(fakeHttp(routes())));
    const italia = chunk.events.at(-1)!;
    expect(italia).toMatchObject({ sessionsStatus: 'published', stageCount: 17, tz: 'Europe/Rome' });
    const sessions = chunk.sessions.filter((s) => s.eventId === italia.id);
    expect(sessions.map((s) => [s.type, s.name, s.startUtc, s.endUtc, s.localStartText, s.endEstimated])).toEqual([
      // Hora local CEST (UTC+2). Fin: Shakedown +180 min; etapas, 60 min después de largar su último tramo; Power Stage +75.
      ['practica', 'Shakedown', '2026-10-01T07:01:00Z', '2026-10-01T10:01:00Z', '09:01', true],
      ['etapa', 'Etapa del jueves: SS1', '2026-10-01T14:05:00Z', '2026-10-01T15:05:00Z', '16:05', true],
      ['etapa', 'Etapa del viernes: SS2 a SS7', '2026-10-02T06:01:00Z', '2026-10-02T15:38:00Z', '08:01', true],
      ['etapa', 'Etapa del sábado: SS8 a SS13', '2026-10-03T06:01:00Z', '2026-10-03T15:37:00Z', '08:01', true],
      ['etapa', 'Etapa del domingo: SS14 a SS16', '2026-10-04T06:31:00Z', '2026-10-04T10:38:00Z', '08:31', true],
      ['carrera', 'Power Stage (SS17)', '2026-10-04T12:15:00Z', '2026-10-04T13:30:00Z', '14:15', true],
    ]);
    for (const s of sessions) {
      expect(s.source).toMatchObject({
        url: 'https://en.wikipedia.org/wiki/2026_Rally_Italia_Sardegna',
        title: 'Wikipedia: 2026 Rally Italia Sardegna (itinerario)',
      });
      expect(s.broadcast).toEqual(['Rally.TV']);
      // Los nombres ya están en español: la normalización de la corrida no los cambia.
      expect(normalizeSession(s)).toEqual(s);
    }
    expect(validateSessions(chunk.sessions, chunk.events).issues).toEqual([]);
  });

  it('publica el itinerario de cada rally con sus tramos apuntando al bloque de la agenda', async () => {
    const chunk = await wrcAdapter.schedule(series, ctxWith(fakeHttp(routes())));
    const italia = chunk.events.at(-1)!;
    const file = chunk.stages!.find((f) => f.eventId === italia.id)!;
    expect(() => chunk.stages!.forEach((f) => eventStagesFileSchema.parse(f))).not.toThrow();
    expect(file).toMatchObject({ seriesId: 'wrc', surface: 'tierra', competitiveKm: 306.92, totalKm: 1626.79 });
    expect(file.source).toMatchObject({ url: 'https://en.wikipedia.org/wiki/2026_Rally_Italia_Sardegna', title: 'Wikipedia: 2026 Rally Italia Sardegna' });
    expect(file.stages).toHaveLength(18);

    const byName = new Map(chunk.sessions.filter((s) => s.eventId === italia.id).map((s) => [s.name, s.id]));
    const stage = (code: string) => file.stages.find((s) => s.code === code)!;
    expect(stage('Shakedown')).toEqual({
      code: 'Shakedown',
      name: 'Monte Baranta',
      kind: 'shakedown',
      date: '2026-10-01',
      startUtc: '2026-10-01T07:01:00Z',
      localStartText: '09:01',
      distanceKm: 3.27,
      sessionId: byName.get('Shakedown'),
    });
    expect(stage('SS1')).toMatchObject({ kind: 'superespecial', sessionId: byName.get('Etapa del jueves: SS1') });
    expect(stage('SS7')).toMatchObject({ kind: 'especial', startUtc: '2026-10-02T14:38:00Z', sessionId: byName.get('Etapa del viernes: SS2 a SS7') });
    expect(stage('SS16').sessionId).toBe(byName.get('Etapa del domingo: SS14 a SS16'));
    expect(stage('SS17')).toMatchObject({ kind: 'power', startUtc: '2026-10-04T12:15:00Z', distanceKm: 7.1, sessionId: byName.get('Power Stage (SS17)') });
    // Todos los tramos pertenecen a una sesión del mismo evento.
    expect(file.stages.every((s) => [...byName.values()].includes(s.sessionId!))).toBe(true);

    // Montecarlo: asfalto con nieve, sede en Francia y Shakedown el miércoles.
    const monte = chunk.events[0]!;
    const monteFile = chunk.stages!.find((f) => f.eventId === monte.id)!;
    expect(monteFile).toMatchObject({ surface: 'asfalto', surfaceNote: 'Asfalto y nieve', competitiveKm: 339.15 });
    expect(chunk.sessions.filter((s) => s.eventId === monte.id).map((s) => s.name)).toEqual([
      'Shakedown',
      'Etapa del jueves: SS1 a SS3',
      'Etapa del viernes: SS4 a SS9',
      'Etapa del sábado: SS10 a SS13',
      'Etapa del domingo: SS14 a SS16',
      'Power Stage (SS17)',
    ]);
    expect(chunk.sessions.find((s) => s.eventId === monte.id && s.name === 'Shakedown')!.startUtc).toBe('2026-01-21T13:01:00Z');
  });

  it('convierte las horas con el huso de la sede (Canarias) o con el que declara el itinerario (Paraguay)', async () => {
    const chunk = await wrcAdapter.schedule(series, ctxWith(fakeHttp(routes())));
    const first = (country: string) => {
      const event = chunk.events.find((e) => e.country === country)!;
      return chunk.stages!.find((f) => f.eventId === event.id)!.stages.find((s) => s.code === 'SS1')!;
    };
    // Las Palmas, 23 de abril: WEST (UTC+1), una hora menos que la península.
    expect(first('España')).toMatchObject({ localStartText: '17:35', startUtc: '2026-04-23T16:35:00Z' });
    // Encarnación, 28 de agosto: UTC-3 según el itinerario (Paraguay dejó el cambio de hora en 2024).
    expect(first('Paraguay')).toMatchObject({ localStartText: '09:03', startUtc: '2026-08-28T12:03:00Z' });
  });

  it('los rallies sin artículo o sin itinerario quedan con horarios a confirmar', async () => {
    const chunk = await wrcAdapter.schedule(series, ctxWith(fakeHttp(routes())));
    const sweden = chunk.events[1]!;
    expect(sweden).toMatchObject({ sessionsStatus: 'pending', surface: 'nieve' });
    expect(sweden.stageCount).toBeUndefined();
    expect(chunk.sessions.some((s) => s.eventId === sweden.id)).toBe(false);
    expect(chunk.stages!.map((f) => f.eventId).sort()).toEqual([chunk.events[0]!.id, chunk.events[4]!.id, chunk.events[10]!.id, chunk.events[12]!.id].sort());
  });

  it('los ids son estables: no cambian entre corridas ni cuando cambia el rango de tramos de un bloque', async () => {
    const a = await wrcAdapter.schedule(series, ctxWith(fakeHttp(routes())));
    const b = await wrcAdapter.schedule(series, ctxWith(fakeHttp(routes()), '2026-11-13T03:00:00.000Z'));
    expect(b.events.map((e) => e.id)).toEqual(a.events.map((e) => e.id));
    expect(b.sessions.map((s) => s.id)).toEqual(a.sessions.map((s) => s.id));

    // Se cae el último tramo del viernes (SS7): el bloque pasa a "SS2 a SS6" con el mismo id.
    const rallies = JSON.parse(fixture('wrc/wiki-rallies-2026.json')) as { query: { pages: Array<{ title: string; revisions: Array<{ slots: { main: { content: string } } }> }> } };
    const slot = rallies.query.pages.find((p) => p.title === '2026 Rally Italia Sardegna')!.revisions[0]!.slots.main;
    // (la fila del día abarca una fila menos)
    const without = slot.content
      .replace(/\|-\n\| align="center" \| SS7\n[\s\S]*?(?=\|-\n)/, '')
      .replace('! rowspan="9" | 2 October', '! rowspan="8" | 2 October');
    expect(without).not.toBe(slot.content);
    slot.content = without;
    const c = await wrcAdapter.schedule(series, ctxWith(fakeHttp(routes({ [wikiPagesUrl(articles(season2026, 2026))]: JSON.stringify(rallies) }))));
    const friday = (sessions: Session[], eventId: string) => sessions.find((s) => s.eventId === eventId && s.name.startsWith('Etapa del viernes'))!;
    const italia = a.events.at(-1)!;
    expect(friday(c.sessions, italia.id).name).toBe('Etapa del viernes: SS2 a SS6');
    expect(friday(c.sessions, italia.id).id).toBe(friday(a.sessions, italia.id).id);
    expect(c.events.at(-1)!.stageCount).toBe(16);
  });

  it('terminada la temporada suma la siguiente con el calendario y los itinerarios de wrc.com mientras la FIA no la publica', async () => {
    const http = fakeHttp(routes());
    const chunk = await scheduleWithNextSeason(wrcAdapter, series, ctxWith(http));
    expect(http.calls).toContain(fiaWrcCalendarUrl(2027)); // primero se prueba la FIA (404)
    expect(chunk.events).toHaveLength(28);
    const next = chunk.events.filter((e) => e.dateStart.startsWith('2027'));
    expect(next).toHaveLength(15);
    expect(next.map((e) => e.round)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(next[0]).toMatchObject({
      name: 'Rallye Monte-Carlo',
      circuit: 'Gap (Francia)',
      country: 'Mónaco',
      dateStart: '2027-01-21',
      dateEnd: '2027-01-24',
      surface: 'asfalto',
      sessionsStatus: 'published',
      stageCount: 18,
    });
    expect(next[0]!.source).toMatchObject({
      url: WRC_CALENDAR_URL,
      title: 'WRC.com: calendario 2027 (sede y superficie: Wikipedia, «2027 World Rally Championship»)',
      kind: 'html',
    });
    expect(next.map((e) => [e.name, e.country, e.circuit, e.surface, e.tz]).slice(10, 12)).toEqual([
      ['Hankook Rally US', 'Estados Unidos', 'Knoxville', 'tierra', 'America/New_York'],
      ['Rally Scotland', 'Reino Unido', 'Aberdeen', 'tierra', 'Europe/London'],
    ]);
    expect(next.at(-1)).toMatchObject({ name: 'Rally Saudi Arabia', country: 'Arabia Saudita', dateStart: '2027-11-25', dateEnd: '2027-11-28' });

    // Montecarlo 2027: itinerario oficial de wrc.com (Wikipedia todavía no tiene el artículo).
    const monte = next[0]!;
    const sessions = chunk.sessions.filter((s) => s.eventId === monte.id);
    expect(sessions.map((s) => [s.type, s.name, s.startUtc, s.endUtc, s.localStartText])).toEqual([
      ['practica', 'Shakedown', '2027-01-20T13:01:00Z', '2027-01-20T16:01:00Z', '14:01'],
      ['etapa', 'Etapa del jueves: SS1 a SS3', '2027-01-21T14:35:00Z', '2027-01-21T20:05:00Z', '15:35'],
      ['etapa', 'Etapa del viernes: SS4 a SS9', '2027-01-22T08:25:00Z', '2027-01-22T16:45:00Z', '09:25'],
      ['etapa', 'Etapa del sábado: SS10 a SS15', '2027-01-23T07:05:00Z', '2027-01-23T18:25:00Z', '08:05'],
      ['etapa', 'Etapa del domingo: SS16 a SS17', '2027-01-24T07:00:00Z', '2027-01-24T09:40:00Z', '08:00'],
      ['carrera', 'Power Stage (SS18)', '2027-01-24T12:15:00Z', '2027-01-24T13:30:00Z', '13:15'],
    ]);
    const itineraryUrl = 'https://www.wrc.com/en/events/wrc-rallye-monte-carlo-2027/itinerary-wrc-rallye-monte-carlo-2027';
    for (const s of sessions) expect(s.source).toMatchObject({ url: itineraryUrl, title: 'WRC.com: WRC Rallye Monte-Carlo 2027 (itinerario)' });
    expect(validateSessions(sessions, chunk.events).issues).toEqual([]);

    const file = chunk.stages!.find((f) => f.eventId === monte.id)!;
    expect(() => eventStagesFileSchema.parse(file)).not.toThrow();
    expect(file).toMatchObject({ surface: 'asfalto', surfaceNote: 'Asfalto y nieve', competitiveKm: 353.57 });
    expect(file.totalKm).toBeUndefined();
    expect(file.source).toMatchObject({ url: itineraryUrl, title: 'WRC.com: WRC Rallye Monte-Carlo 2027' });
    expect(file.stages[0]).toMatchObject({ code: 'Shakedown', name: 'Gap', kind: 'shakedown', date: '2027-01-20', distanceKm: 4.25 });
    expect(file.stages.at(-1)).toMatchObject({ code: 'SS18', name: 'La Bollène-Vésubie / Moulinet', kind: 'power', distanceKm: 23.45 });
    // Los demás rallies de 2027 todavía no tienen itinerario: a confirmar.
    expect(next.slice(1).every((e) => e.sessionsStatus === 'pending' && e.stageCount === undefined)).toBe(true);
    expect(chunk.stages).toHaveLength(5);
  });

  it('si wrc.com rechaza al cliente (403), sigue con Wikipedia sin error', async () => {
    const forbidden = (url: string) => () => {
      throw new HttpError(url, 403, `HTTP 403 en ${url}`);
    };
    const http = fakeHttp(
      routes({ [WRC_CALENDAR_CONFIG_URL]: forbidden(WRC_CALENDAR_CONFIG_URL), [WRC_CALENDAR_URL]: forbidden(WRC_CALENDAR_URL) }),
    );
    const chunk = await scheduleWithNextSeason(wrcAdapter, series, ctxWith(http));
    const next = chunk.events.filter((e) => e.dateStart.startsWith('2027'));
    expect(next).toHaveLength(15);
    expect(next[0]).toMatchObject({ name: 'Rallye Automobile Monte Carlo', sessionsStatus: 'pending' });
    expect(next[0]!.source).toMatchObject({ url: 'https://en.wikipedia.org/wiki/2027_World_Rally_Championship', title: 'Wikipedia: 2027 World Rally Championship' });
    // Mismos ids que con el calendario de wrc.com (la clave es el país anfitrión).
    const withSite = await scheduleWithNextSeason(wrcAdapter, series, ctxWith(fakeHttp(routes())));
    expect(next.map((e) => e.id)).toEqual(withSite.events.filter((e) => e.dateStart.startsWith('2027')).map((e) => e.id));
  });

  it('si Wikipedia corta (429), la temporada sigue con el calendario oficial y lo de la corrida anterior', async () => {
    const before = await wrcAdapter.schedule(series, ctxWith(fakeHttp(routes())));
    const previous = { version: 1 as const, generatedAt: '2026-11-12T15:00:00Z', series: [series], events: before.events, sessions: before.sessions };
    const tooMany = (url: string) => () => {
      throw new HttpError(url, 429, `HTTP 429 en ${url}`);
    };
    const season = wikiPagesUrl([wrcSeasonArticle(2026)]);
    const rallies = wikiPagesUrl(articles(season2026, 2026));
    const ctx = { ...ctxWith(fakeHttp(routes({ [season]: tooMany(season), [rallies]: tooMany(rallies) }))), previous };
    const after = await wrcAdapter.schedule(series, ctx);
    expect(after.events.map((e) => e.id)).toEqual(before.events.map((e) => e.id));
    // Sede, superficie, itinerario y sesiones: los de la corrida anterior.
    expect(after.events.map((e) => [e.circuit, e.tz, e.surface, e.stageCount])).toEqual(before.events.map((e) => [e.circuit, e.tz, e.surface, e.stageCount]));
    expect(after.sessions.map((s) => s.id).sort()).toEqual(before.sessions.map((s) => s.id).sort());
    expect(after.events[0]!.source.title).toBe('FIA: calendario del WRC 2026 (sede y superficie: Wikipedia, lectura anterior)');
    // Sin itinerario nuevo, no se reescribe ningún archivo de etapas.
    expect(after.stages ?? []).toEqual([]);
  });

  it('un rally que deja de tener itinerario conserva los horarios de la corrida anterior', async () => {
    const before = await scheduleWithNextSeason(wrcAdapter, series, ctxWith(fakeHttp(routes())));
    const monte = before.events.find((e) => e.dateStart === '2027-01-21')!;
    const previous = { version: 1 as const, generatedAt: '2026-11-12T15:00:00Z', series: [series], events: before.events, sessions: before.sessions };
    const tabs = wrcTabsUrl('wrc-rallye-monte-carlo-2027');
    const ctx = { ...ctxWith(fakeHttp({ ...routes(), [tabs]: '{"data":{"type":"multi-page","tabs":[]}}' })), previous };
    const after = await scheduleWithNextSeason(wrcAdapter, series, ctx);
    const kept = after.events.find((e) => e.id === monte.id)!;
    expect(kept).toMatchObject({ sessionsStatus: 'published', stageCount: 18 });
    expect(after.sessions.filter((s) => s.eventId === monte.id)).toEqual(before.sessions.filter((s) => s.eventId === monte.id));
    // Sin itinerario nuevo no se reescribe su archivo de etapas.
    expect(after.stages!.some((f) => f.eventId === monte.id)).toBe(false);
  });

  it('el id de un rally no cambia cuando el calendario pasa de Wikipedia a la FIA', async () => {
    // 2027 leído hoy (Wikipedia) y 2026 (FIA) usan la misma clave por país: Montecarlo 2026 con ambos orígenes.
    const fromFia = await wrcAdapter.schedule(series, ctxWith(fakeHttp(routes())));
    const { [fiaWrcCalendarUrl(2026)]: _fia, ...onlyWiki } = routes();
    const fromWiki = await wrcAdapter.schedule(series, ctxWith(fakeHttp(onlyWiki)));
    expect(fromWiki.events).toHaveLength(13);
    expect(fromWiki.events.map((e) => e.id)).toEqual(fromFia.events.map((e) => e.id));
    expect(fromWiki.events[0]!.name).toBe('Rallye Automobile Monte Carlo');
    expect(fromWiki.sessions.map((s) => s.id)).toEqual(fromFia.sessions.map((s) => s.id));
  });

  it('si no hay calendario en ninguna fuente, lanza (se conserva lo anterior)', async () => {
    await expect(wrcAdapter.schedule(series, ctxWith(fakeHttp({})))).rejects.toThrow();
    const http = fakeHttp({
      [wikiPagesUrl([wrcSeasonArticle(2026)])]: JSON.stringify({ batchcomplete: true, query: { pages: [{ title: wrcSeasonArticle(2026), missing: true }] } }),
    });
    await expect(wrcAdapter.schedule(series, ctxWith(http))).rejects.toThrow(/Sin calendario 2026/);
  });
});

describe('lector WRC: resultados y campeonato (FIA)', () => {
  it('lee la clasificación general después de cada tramo', () => {
    const stages = parseFiaClassifications(fixture('wrc/fia-classifications-italia-2026.html'));
    expect(stages.map((s) => [s.number, s.name, s.km, s.unofficial])).toEqual([
      [1, 'ITTIRI ARENA SHOW', 2.21, true],
      [7, "MONTI DI ALA' - SA CONCHEDDA - LERNO 2", 23.23, true],
      [17, 'SASSARI - ARGENTIERA 2 / Wolf Pw Stage', 7.1, true],
    ]);
    expect(stages[2]!.overall[0]).toEqual({
      pos: 1,
      number: '99',
      driver: 'O. SOLBERG',
      codriver: 'E. EDMONDSON',
      vehicle: 'Toyota GR Yaris Rally1',
      time: '3:24:57.0',
      diff: '00:00:00.000',
    });
    // La penalización va en otra línea de la celda: el tiempo queda limpio.
    expect(stages[2]!.overall.find((r) => r.number === '62')).toMatchObject({ pos: 42, time: '5:08:25.5', diff: '01:50:48.500' });
  });

  it('arma las filas con el nombre completo de la lista de inscriptos', () => {
    const stages = parseFiaClassifications(fixture('wrc/fia-classifications-italia-2026.html'));
    const entries = parseFiaEntryList(fixture('wrc/fia-entry-list-italia-2026.html'));
    expect(entries.get('1')).toEqual({ driver: 'Sébastien Ogier', codriver: 'Vincent Landais', entrant: 'Toyota Gazoo Racing WRT', car: 'Toyota GR Yaris Rally1' });
    const rows = crewRows(stages[2]!.overall, entries);
    expect(rows.slice(0, 3)).toEqual([
      { pos: 1, number: '99', driver: 'Oliver Solberg / Elliott Edmondson', team: 'Toyota Gazoo Racing WRT', vehicle: 'Toyota GR Yaris Rally1', time: '3:24:57.0' },
      { pos: 2, number: '1', driver: 'Sébastien Ogier / Vincent Landais', team: 'Toyota Gazoo Racing WRT', vehicle: 'Toyota GR Yaris Rally1', gap: '+57.6s' },
      { pos: 3, number: '5', driver: 'Sami Pajari / Marko Salminen', team: 'Toyota Gazoo Racing WRT2', vehicle: 'Toyota GR Yaris Rally1', gap: '+1:37.4' },
    ]);
    // Sin lista de inscriptos quedan los nombres del cronometraje.
    expect(crewRows(stages[2]!.overall.slice(0, 1), new Map())[0]).toMatchObject({ driver: 'O. Solberg / E. Edmondson', vehicle: 'Toyota GR Yaris Rally1' });
  });

  it('formatea las diferencias', () => {
    expect(rallyGap('00:00:00.000')).toBeUndefined();
    expect(rallyGap('00:00:57.600')).toBe('+57.6s');
    expect(rallyGap('00:01:37.400')).toBe('+1:37.4');
    expect(rallyGap('01:26:35.300')).toBe('+1:26:35.3');
  });

  it('lee el campeonato de pilotos, copilotos y constructores (no las categorías de soporte)', () => {
    const tables = parseFiaStandings(fixture('wrc/fia-standings-2026.html'));
    expect(tables.map((t) => [t.title, t.rows.length])).toEqual([
      ['Pilotos', 5],
      ['Copilotos', 5],
      ['Constructores', 4],
    ]);
    expect(tables[0]!.rows[0]).toEqual({ pos: 1, name: 'Elfyn Evans', points: 243, wins: 2, country: 'GB' });
    expect(tables[0]!.rows[1]).toMatchObject({ pos: 2, name: 'Oliver Solberg', points: 238, wins: 3 });
    expect(tables[1]!.rows[0]).toMatchObject({ pos: 1, name: 'Scott Martin', points: 243 });
    expect(tables[2]!.rows).toEqual([
      { pos: 1, name: 'Toyota Gazoo Racing WRT', points: 662 },
      { pos: 2, name: 'Hyundai Shell Mobis World Rally Team', points: 440 },
      { pos: 3, name: 'Toyota Gazoo Racing WRT2', points: 251 },
      { pos: 4, name: 'M-Sport Ford World Rally Team', points: 168 },
    ]);
  });

  async function resultsFor(http: ReturnType<typeof fakeHttp>, now = '2026-11-12T15:00:00.000Z', only = (_s: Session) => true) {
    const ctx = ctxWith(http, now);
    const chunk = await wrcAdapter.schedule(series, ctx);
    const pending = chunk.sessions.filter(only).sort((x, y) => y.startUtc.localeCompare(x.startUtc));
    const req: ResultsRequest = { events: chunk.events, pendingSessions: pending, sessions: chunk.sessions, standingsStale: true };
    return { chunk, out: await wrcAdapter.results!(series, ctx, req) };
  }

  it('publica la clasificación final como resultado de la Power Stage y la general del día en cada etapa', async () => {
    const http = fakeHttp(routes());
    const { chunk, out } = await resultsFor(http);
    const italia = chunk.events.at(-1)!;
    const file = out.results.find((f) => f.eventId === italia.id)!;
    const name = (sessionId: string) => chunk.sessions.find((s) => s.id === sessionId)!.name;
    expect(file.sessions.map((s) => [name(s.sessionId), s.rows.length, s.source.title])).toEqual([
      ['Power Stage (SS17)', 20, "FIA: Rally d'Italia — clasificación final del rally (general tras SS17) (tiempos no oficiales)"],
      ['Etapa del viernes: SS2 a SS7', 4, "FIA: Rally d'Italia — clasificación general tras SS7 (tiempos no oficiales)"],
      ['Etapa del jueves: SS1', 4, "FIA: Rally d'Italia — clasificación general tras SS1 (tiempos no oficiales)"],
    ]);
    const final = file.sessions[0]!;
    expect(final.source).toMatchObject({ url: ITALIA_CLASSIFICATIONS, kind: 'html', method: 'directo' });
    expect(final.rows[0]).toEqual({
      pos: 1,
      number: '99',
      driver: 'Oliver Solberg / Elliott Edmondson',
      team: 'Toyota Gazoo Racing WRT',
      vehicle: 'Toyota GR Yaris Rally1',
      time: '3:24:57.0',
    });
    // El Shakedown no tiene clasificación; los rallies sin página en este fixture responden 404 y no rompen.
    expect(out.results).toHaveLength(1);
    expect(out.standings).toMatchObject({ seriesId: 'wrc', season: 2026 });
    expect(out.standings!.tables.map((t) => t.title)).toEqual(['Pilotos', 'Copilotos', 'Constructores']);
    expect(out.standings!.source).toMatchObject({ url: fiaWrcStandingsUrl(2026), title: 'FIA: campeonato del WRC 2026' });
  });

  it('lee pocas páginas de clasificaciones por corrida y deja el resto para la próxima sin gastar intentos', async () => {
    // Sin tope alcanzado: una página por rally con sesiones pendientes (Italia, Paraguay, Canarias y Montecarlo).
    const all = fakeHttp(routes());
    const full = await resultsFor(all);
    expect(all.calls.filter((u) => u.endsWith('/classifications'))).toHaveLength(4);
    expect(full.out.deferred ?? []).toEqual([]);

    // Con tope 1 se lee solo el rally más reciente; los bloques de los demás quedan diferidos.
    const http = fakeHttp(routes());
    const ctx = ctxWith(http);
    const capped = createWrcAdapter({ maxResultEvents: 1 });
    const chunk = await capped.schedule(series, ctx);
    const pending = [...chunk.sessions].sort((x, y) => y.startUtc.localeCompare(x.startUtc));
    const out = await capped.results!(series, ctx, { events: chunk.events, pendingSessions: pending, sessions: chunk.sessions, standingsStale: false });
    expect(http.calls.filter((u) => u.endsWith('/classifications'))).toEqual([ITALIA_CLASSIFICATIONS]);
    const italia = chunk.events.at(-1)!;
    const others = chunk.sessions.filter((s) => s.eventId !== italia.id && s.type !== 'practica').map((s) => s.id);
    expect(others.length).toBeGreaterThan(10);
    expect([...(out.deferred ?? [])].sort()).toEqual([...others].sort());
    expect(out.results.map((f) => f.eventId)).toEqual([italia.id]);
    expect(out.standings).toBeUndefined(); // no se pidió
  });

  it('no lee la clasificación de un bloque recién terminado (todavía pasan autos)', async () => {
    const http = fakeHttp(routes());
    // Domingo 4/10 a las 14:00 UTC: la Power Stage terminó (estimado) 13:30; el viernes y el sábado ya asentaron.
    const { chunk, out } = await resultsFor(http, '2026-10-04T14:00:00.000Z', (s) => s.startUtc.startsWith('2026-10') && Date.parse(s.endUtc) < Date.parse('2026-10-04T14:00:00Z'));
    const italia = chunk.events.at(-1)!;
    const of = (start: string) => chunk.sessions.find((s) => s.eventId === italia.id && s.name.startsWith(start))!;
    expect(out.deferred).toContain(of('Power Stage').id);
    // El bloque del domingo ya asentó, pero la tabla de su último tramo (SS16) no está en la página: también espera.
    expect(out.deferred).toContain(of('Etapa del domingo').id);
    expect(out.deferred).not.toContain(of('Etapa del viernes').id);
    const file = out.results.find((f) => f.eventId === italia.id)!;
    expect(file.sessions.map((s) => s.sessionId)).toEqual([of('Etapa del viernes').id, of('Etapa del jueves').id]);
  });

  it('si el último tramo no tiene clasificación pasado medio día (cancelado), vale la del último tramo corrido', async () => {
    const html = fixture('wrc/fia-classifications-italia-2026.html');
    const withoutPowerStage = html.slice(0, html.lastIndexOf('<table class="stage-table'));
    const { chunk, out } = await resultsFor(fakeHttp(routes({ [ITALIA_CLASSIFICATIONS]: withoutPowerStage })));
    const italia = chunk.events.at(-1)!;
    const power = chunk.sessions.find((s) => s.eventId === italia.id && s.type === 'carrera')!;
    const final = out.results.find((f) => f.eventId === italia.id)!.sessions.find((s) => s.sessionId === power.id)!;
    expect(final.source.title).toBe("FIA: Rally d'Italia — clasificación final del rally (general tras SS7) (tiempos no oficiales)");
    expect(final.rows[0]).toMatchObject({ pos: 1, driver: 'Thierry Neuville / Martijn Wydaeghe', time: '1:25:04.9' });
  });

  it('si la FIA pide esperar (429), las sesiones quedan diferidas y no se pide el campeonato', async () => {
    const http = fakeHttp(
      routes({
        [ITALIA_CLASSIFICATIONS]: () => {
          throw new HttpError(ITALIA_CLASSIFICATIONS, 429, `HTTP 429 en ${ITALIA_CLASSIFICATIONS}`);
        },
      }),
    );
    const { chunk, out } = await resultsFor(http);
    const italia = chunk.events.at(-1)!;
    const wanted = chunk.sessions.filter((s) => s.eventId === italia.id && s.type !== 'practica').map((s) => s.id);
    expect(out.results).toEqual([]);
    for (const id of wanted) expect(out.deferred).toContain(id);
    expect(out.standings).toBeUndefined();
    expect(http.calls).not.toContain(fiaWrcStandingsUrl(2026));
  });
});

describe('wrc.com', () => {
  it('lee el calendario embebido en la página y el id de la temporada', () => {
    const page = parseWrcCalendarPage(fixture('wrc/wrc-calendar.html'));
    expect(page.seasonRrn).toBe(WRC_SEASON_2027);
    expect(page.events).toHaveLength(3);
    expect(page.events[0]).toEqual({
      slug: 'wrc-rallye-monte-carlo-2027',
      title: 'WRC Rallye Monte-Carlo 2027',
      round: 1,
      dateStart: '2027-01-21',
      dateEnd: '2027-01-24',
      iso2: 'MC',
      status: 'confirmed',
      url: 'https://www.wrc.com/en/events/wrc-rallye-monte-carlo-2027',
    });
    expect(parseWrcCalendarPage('<html></html>')).toEqual({ events: [] });
  });

  it('saca el id de la temporada de la configuración de la página (el HTML no siempre trae los datos)', async () => {
    expect(seasonFromConfig(JSON.parse(fixture('wrc/wrc-calendar-config.json')))).toBe(WRC_SEASON_2027);
    // Sin configuración, con los datos embebidos en el HTML.
    const { [WRC_CALENDAR_CONFIG_URL]: _c, ...rest } = routes();
    const http = fakeHttp(rest);
    const chunk = await scheduleWithNextSeason(wrcAdapter, series, ctxWith(http));
    expect(http.calls).toContain(WRC_CALENDAR_URL);
    expect(chunk.events.filter((e) => e.source.url === WRC_CALENDAR_URL)).toHaveLength(15);
    // Con configuración no hace falta la página.
    const direct = fakeHttp(routes());
    await scheduleWithNextSeason(wrcAdapter, series, ctxWith(direct));
    expect(direct.calls).not.toContain(WRC_CALENDAR_URL);
  });

  it('lee el itinerario oficial: un renglón por tramo con hora local, nombre, km y Power Stage', () => {
    const stages = parseWrcItinerary(JSON.parse(fixture('wrc/wrc-itinerary-monte-carlo-2027.json')));
    expect(stages.map((s) => s.code).join(' ')).toBe(
      'Shakedown SS1 SS2 SS3 SS4 SS5 SS6 SS7 SS8 SS9 SS10 SS11 SS12 SS13 SS14 SS15 SS16 SS17 SS18',
    );
    expect(stages[0]).toEqual({ code: 'Shakedown', name: 'Gap', kind: 'shakedown', date: '2027-01-20', time: '14:01', km: 4.25 });
    // "SS 1 Col de Bleine…" y "SS 3 - Esclangon…": con o sin guion; la salida oficial no es un tramo.
    expect(stages[1]).toEqual({ code: 'SS1', number: 1, name: 'Col de Bleine / Aiglun', kind: 'especial', date: '2027-01-21', time: '15:35', km: 25.47 });
    expect(stages[3]).toMatchObject({ code: 'SS3', name: 'Esclangon / Seyne-les-Alpes', time: '20:05' });
    expect(stages.at(-1)).toEqual({ code: 'SS18', number: 18, name: 'La Bollène-Vésubie / Moulinet', kind: 'power', date: '2027-01-24', time: '13:15', km: 23.45 });
  });
});

describe('itinerarios sin cambios', () => {
  it('no cuentan las fechas de lectura', () => {
    const file = {
      seriesId: 'wrc',
      eventId: 'x',
      updatedAt: '2026-11-12T00:00:00Z',
      stages: [{ code: 'SS1', name: 'A', kind: 'especial' as const, date: '2026-10-01' }],
      source: { url: 'https://example.org', title: 'T', kind: 'api' as const, method: 'directo' as const, fetchedAt: '2026-11-12T00:00:00Z' },
    };
    const later = { ...file, updatedAt: '2026-11-13T00:00:00Z', source: { ...file.source, fetchedAt: '2026-11-13T00:00:00Z' } };
    expect(sameStages(file, later)).toBe(true);
    expect(sameStages(null, later)).toBe(false);
    expect(sameStages(file, { ...later, stages: [{ ...file.stages[0]!, name: 'B' }] })).toBe(false);
  });
});

describe('cliente HTTP: 403', () => {
  it('un 403 no se reintenta por ningún otro camino, con noProxy o sin él', async () => {
    const asked: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      asked.push(String(url));
      return new Response('Access Denied', { status: 403 });
    }) as typeof fetch;
    const http = createHttp({ fetchImpl, retries: 0 });
    await expect(http.text('https://www.wrc.com/en/calendar', { noProxy: true })).rejects.toMatchObject({ status: 403 });
    expect(asked).toEqual(['https://www.wrc.com/en/calendar']);
    await expect(http.text('https://www.example.org/x')).rejects.toMatchObject({ status: 403 });
    expect(asked).toEqual(['https://www.wrc.com/en/calendar', 'https://www.example.org/x']);
  });
});
