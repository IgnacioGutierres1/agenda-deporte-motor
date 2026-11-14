import { describe, expect, it } from 'vitest';
import type { Session, SessionType } from '@dm/shared';
import type { PdfItem } from '../src/adapters/fia-documents.ts';
import { classifySession } from '../src/core/builders.ts';
import { findRecipe } from '../src/generic/recipes.ts';
import {
  creventicFastestDrivers,
  creventicResultSessions,
  creventicStart,
  fixSpacing,
  parseCreventicItems,
} from '../src/generic/results-creventic.ts';
import { dtmPastSessions, dtmResults } from '../src/generic/results-dtm.ts';
import { driverCase, lapsGap, pickSession, timeGap } from '../src/generic/results-euro.ts';
import { f1AcademyPastSessions, f1AcademyResults } from '../src/generic/results-f1academy.ts';
import { gtOpenSessionName, parseGtOpenItems } from '../src/generic/results-gtopen.ts';
import { nlsArchive, nlsClass, nlsDriverName, nlsRacesFor, parseNlsItems } from '../src/generic/results-nls.ts';
import { porscheCalendarTable, porscheDateRange, porscheResultRounds, porscheRows } from '../src/generic/results-porsche.ts';
import { pdfConditions, pdfLines } from '../src/generic/results-euro.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext } from '../src/generic/types.ts';
import { fakeHttp, fixture, genericSeries } from './fakes.ts';

const NOW = '2026-11-14T12:00:00Z';
const items = (name: string) => JSON.parse(fixture(name)) as PdfItem[];

const ctx = (routes: Record<string, string>, id = 'dtm'): RecipeContext => ({
  season: 2026,
  series: genericSeries(id, id, ['https://example.com']),
  http: fakeHttp(routes),
  now: new Date(NOW),
});

/** Sesiones guardadas como las arma el schedule a partir de las sesiones reconstruidas (nombre original = fuente). */
function stored(found: ExtractedSession[], eventId = 'ev'): Session[] {
  return found.map((s, i) => ({
    id: `s${i}`,
    eventId,
    seriesId: 'x',
    type: classifySession(s.name) as SessionType,
    name: `traducido ${i}`,
    originalName: s.name,
    startUtc: s.startUtc,
    endUtc: s.endUtc ?? s.startUtc,
    endEstimated: !s.endUtc,
    broadcast: [],
    broadcastIsDefault: true,
    source: { url: 'https://example.com', title: 't', kind: 'html', method: 'directo', fetchedAt: NOW },
    hasResults: false,
  }));
}

describe('resultados: utilidades comunes', () => {
  it('pasa a formato nombre los apellidos en mayúsculas', () => {
    expect(driverCase('Kelvin VAN DER LINDE')).toBe('Kelvin van der Linde');
    expect(driverCase('Wei SHI')).toBe('Wei Shi');
    expect(driverCase('Ben DÖRR')).toBe('Ben Dörr');
    expect(driverCase("Liam O'CONNOR")).toBe("Liam O'Connor");
  });

  it('formatea diferencias y une sesiones por nombre, por hora o por orden', () => {
    expect(timeGap('4.857')).toBe('+4.857s');
    expect(timeGap('1:03.669')).toBe('+1:03.669');
    expect(timeGap('DNF')).toBeUndefined();
    expect(lapsGap(1)).toBe('+1 vuelta');
    expect(lapsGap(3)).toBe('+3 vueltas');
    const sessions = stored([
      { name: 'Carrera 1', startUtc: '2026-08-22T09:20:00Z' },
      { name: 'Carrera 2', startUtc: '2026-08-23T09:35:00Z' },
      { name: 'Free practice 1', startUtc: '2026-08-21T09:00:00Z' },
    ]);
    const all = [
      { name: 'Free Practice 1', startUtc: '2026-08-21T12:00:00Z' },
      { name: 'Race 6', startUtc: '2026-08-22T09:00:00Z' },
      { name: 'Race 7', startUtc: '2026-08-23T09:00:00Z' },
    ];
    expect(pickSession(sessions, all[0]!, all)?.id).toBe('s2');
    expect(pickSession(sessions, all[1]!, all)?.id).toBe('s0');
    expect(pickSession(sessions, all[2]!, all)?.id).toBe('s1');
  });
});

describe('DTM: resultados de la API oficial', () => {
  const URL = 'https://api.dtm.com/data?query=wigeResults&raceSeries=DTM&startDate=2026-01-01&endDate=2026-12-31';
  const routes = { [URL]: fixture('dtm-results-2026.json'), 'https://api.dtm.com/data?query=drivers': fixture('dtm-drivers.json') };
  const rbr: CalendarEntry = { name: 'Red Bull Ring by VKB-Bank', circuit: 'Red Bull Ring', country: 'Austria', tz: 'Europe/Vienna', dateStart: '2026-04-24', dateEnd: '2026-04-26' };

  it('reconstruye las sesiones de la fecha y lee práctica, clasificación y carrera con abandonos y descalificados', async () => {
    const c = ctx(routes);
    const past = await dtmPastSessions(rbr, c);
    expect(past?.sessions.map((s) => s.name)).toEqual(['Free Practice 1', 'Qualifying 1', 'Race 1']);
    expect(past?.sessions[2]!.startUtc).toBe('2026-04-25T11:30:00Z');
    const sessions = stored(past!.sessions);
    const found = await dtmResults(rbr, sessions, c);
    expect(found?.sessions.map((s) => s.sessionId)).toEqual(['s0', 's1', 's2']);
    const quali = found!.sessions[1]!.rows;
    expect(quali[0]).toMatchObject({ pos: 1, number: '80', driver: 'Maro Engel', team: 'Mercedes-AMG Team RAVENOL', time: '1:27.403' });
    const race = found!.sessions[2]!.rows;
    expect(race[0]).toMatchObject({ pos: 1, number: '91', driver: 'Thomas Preining', time: '1:00:11.576', bestLap: '1:28.899', points: 26 });
    expect(race[1]).toMatchObject({ pos: 2, number: '22', gap: '+0.774s' });
    expect(race.find((r) => r.number === '25')).toMatchObject({ pos: null, status: 'DNF' });
    expect(race.find((r) => r.number === '3')).toMatchObject({ pos: null, status: 'DSQ', driver: 'Kelvin van der Linde' });
  });

  it('respeta la clasificación por grupos del Norisring', async () => {
    const nori: CalendarEntry = { ...rbr, name: 'Norisring', dateStart: '2026-07-03', dateEnd: '2026-07-05' };
    const c = ctx(routes);
    const past = await dtmPastSessions(nori, c);
    expect(past?.sessions.map((s) => s.name)).toEqual(['Qualifying 1 Group A']);
    const found = await dtmResults(nori, stored([{ name: 'Qualifying 1 Group B', startUtc: '2026-07-04T08:00:00Z' }, ...past!.sessions]), c);
    expect(found?.sessions.map((s) => s.sessionId)).toEqual(['s1']);
  });
});

describe('F1 Academy: página de resultados del evento', () => {
  const url = 'https://www.f1academy.com/Racing-Series/Results?raceid=22';
  const shanghai: CalendarEntry = { name: 'Shanghai', circuit: 'Shanghai International Circuit', country: 'China', tz: 'Asia/Shanghai', dateStart: '2026-03-13', dateEnd: '2026-03-15', url };

  it('lee las cuatro sesiones con nombres, horas y abandonos', async () => {
    const c = ctx({ [url]: fixture('f1academy-results-shanghai.html') }, 'f1-academy');
    const past = await f1AcademyPastSessions(shanghai, c);
    expect(past?.sessions.map((s) => `${s.name} ${s.startUtc}`)).toEqual([
      'Free Practice 2026-03-13T01:10:00Z',
      'Qualifying 2026-03-13T06:10:00Z',
      'Reverse Grid Race 2026-03-14T05:45:00Z',
      'Feature Race 2026-03-15T02:40:00Z',
    ]);
    const found = await f1AcademyResults(shanghai, stored(past!.sessions), c);
    expect(found?.sessions).toHaveLength(4);
    expect(found!.sessions[1]!.rows[0]).toMatchObject({ pos: 1, number: '21', driver: 'Alisha Palmowski', team: 'Campos Racing', time: '2:04.182' });
    const feature = found!.sessions[3]!.rows;
    expect(feature[0]).toMatchObject({ pos: 1, driver: 'Emma Felbermayr', time: '29:19.520', bestLap: '2:05.530' });
    expect(feature.find((r) => r.number === '32')).toMatchObject({ pos: null, status: 'DNF', driver: 'Esmee Kosterman' });
  });
});

describe('GT Open: PDF de cronometraje', () => {
  it('nombra las sesiones de los documentos del calendario', () => {
    expect(gtOpenSessionName('Race 1 (fin)')).toBe('Race 1');
    expect(gtOpenSessionName('Qualifying 2 (amended)')).toBe('Qualifying 2');
    expect(gtOpenSessionName('Qualifying Driver 1')).toBe('Qualifying 1');
    expect(gtOpenSessionName('Free Pratice 1')).toBe('Free Practice 1');
    expect(gtOpenSessionName('Bronze Test (FP3)')).toBe('Bronze Test');
    expect(gtOpenSessionName('Race')).toBe('Race');
    expect(gtOpenSessionName('Private Test 1')).toBeNull();
    expect(gtOpenSessionName('Standings after R1')).toBeNull();
    expect(gtOpenSessionName('Combined Qualifying 1 & 2')).toBeNull();
  });

  it('lee la carrera con categorías, lapeados, no clasificados y condiciones', () => {
    const its = items('gtopen-barcelona-race1.items.json');
    const rows = parseGtOpenItems(its);
    expect(rows[0]).toMatchObject({ pos: 1, number: '71', driver: 'Christian Mansell / Maximilian Götz', class: 'Pro', classPos: 1, laps: 37, time: '1:13:25.387', bestLap: '1:41.810' });
    expect(rows[1]).toMatchObject({ pos: 2, number: '911', gap: '+13.496s', vehicle: 'Porsche 911 GT3 R EVO (992)' });
    expect(rows.find((r) => r.number === '77')).toMatchObject({ pos: 27, class: 'Am', classPos: 8, gap: '+1 vuelta' });
    expect(rows.find((r) => r.number === '26')).toMatchObject({ pos: null, status: 'NC', class: 'Pro-Am' });
    expect(pdfConditions(pdfLines(its).map((l) => l.map((i) => i.s).join(' ')).join('\n'))).toEqual({ airC: 18.6, trackC: 25.5, humidity: 64, track: 'Mojada' });
  });

  it('lee la clasificación', () => {
    const rows = parseGtOpenItems(items('gtopen-barcelona-qualifying1.items.json'));
    expect(rows[0]).toMatchObject({ pos: 1, number: '71', time: '1:38.956', class: 'Pro', classPos: 1 });
    expect(rows[2]).toMatchObject({ pos: 3, number: '54', class: 'Pro-Am', classPos: 1, team: 'CBRX by SPS' });
  });
});

describe('NLS: archivo de resultados y PDF de WIGE', () => {
  const page = 'https://www.nuerburgring-langstrecken-serie.de/language/de/ergebnisarchiv/?jahr=2026';
  const archive = nlsArchive(fixture('nls-ergebnisarchiv-2026.html'), page);

  it('une cada fecha del calendario con sus carreras del archivo (aunque las fechas no coincidan)', () => {
    expect(archive.find((r) => r.date === '2026-04-11')?.files.r).toBe('https://www.nuerburgring-langstrecken-serie.de/wp-content/uploads/ergebnisse/2026-04-11r.pdf');
    const nls8 = nlsRacesFor({ name: 'NLS8: 65. ADAC Reinoldus-Langstreckenrennen (4h)', dateStart: '2026-09-12', dateEnd: '2026-09-12' }, archive);
    expect(nls8.map((r) => r.name)).toEqual(['65. ADAC Reinoldus-Langstreckenrennen']);
    const nls9 = nlsRacesFor({ name: 'NLS9: 66. ADAC ACAS Cup (4h)', dateStart: '2026-09-13', dateEnd: '2026-09-13' }, archive);
    expect(nls9.map((r) => r.name)).toEqual(['66. ADAC ACAS Cup']);
    const quali = nlsRacesFor({ name: 'ADAC 24h Qualifiers (2x4h)', dateStart: '2026-04-18', dateEnd: '2026-04-19' }, archive);
    expect(quali.map((r) => r.date)).toEqual(['2026-04-18', '2026-04-19']);
  });

  it('da vuelta los nombres y normaliza las clases', () => {
    expect(nlsDriverName('Wittmann Marco')).toBe('Marco Wittmann');
    expect(nlsDriverName('Van Roon Jan Jaap')).toBe('Jan Jaap Van Roon');
    expect(nlsDriverName("'Jesse Krohn'")).toBe('Jesse Krohn');
    expect(nlsClass('SP9 PRO-AM')).toBe('SP9 Pro-Am');
    expect(nlsClass('CUP2', 'PRO')).toBe('Cup2 Pro');
    expect(nlsClass('SP 9', 'PRO/AM')).toBe('SP9 Pro-Am');
  });

  it('lee la carrera (alemán) con tripulaciones, clases y la sección DNF', () => {
    const rows = parseNlsItems(items('nls-nls3-race.items.json'));
    expect(rows[0]).toMatchObject({ pos: 1, number: '77', driver: 'Marco Wittmann / Philipp Eng / Robin Frijns', team: 'Schubert Motorsport', class: 'SP9 Pro', classPos: 1, laps: 28, time: '4:08:08.316', bestLap: '8:01.584' });
    expect(rows[1]).toMatchObject({ pos: 2, number: '911', gap: '+21.759s' });
    expect(rows.find((r) => r.number === '100')).toBeUndefined();
    const dnf = rows.find((r) => r.number === '921');
    expect(dnf).toMatchObject({ pos: null, status: 'DNF', class: 'Cup2 Pro', vehicle: 'Porsche 911 GT3 Cup' });
  });

  it('lee la carrera de los 24h Qualifiers (inglés)', () => {
    const rows = parseNlsItems(items('nls-qualifiers-race2.items.json'));
    expect(rows[0]).toMatchObject({ pos: 1, number: '16', driver: 'Christopher Haase / Alexander Sims / Ben Green', team: 'Scherer Sport PHX', vehicle: 'Audi R8 LMS GT3 evo II', class: 'SP9 Pro', time: '4:04:49.751' });
    expect(rows[1]).toMatchObject({ pos: 2, number: '84', gap: '+28.024s', team: 'Red Bull Team ABT' });
  });
});

describe('24H Series: resultados de la página de la carrera', () => {
  const mugello: CalendarEntry = { name: 'Michelin 12H Mugello', circuit: 'Mugello', country: 'Italy', tz: 'Europe/Rome', dateStart: '2026-03-20', dateEnd: '2026-03-22' };

  it('lista las sesiones del campeonato principal con su día y hora', () => {
    const list = creventicResultSessions(fixture('creventic-results-mugello-2026.html'));
    expect(list.map((s) => `${s.when} ${s.name}`)).toEqual([
      'Fri-11:45 Free Practice',
      'Fri-16:15 Qualifying 1 - Classes TCE, GT4, GTX & 992',
      'Fri-16:37 Qualifying 2 - Classes TCE, GT4, GTX & 992',
      'Fri-16:59 Qualifying 3 - Classes TCE, GT4, GTX & 992',
      'Fri-17:25 Qualifying 1 - Classes GT3',
      'Fri-17:45 Qualifying 2 - Classes GT3',
      'Fri-18:05 Qualifying 3 - Classes GT3',
      'Sat-12:10 Race Part 1',
      'Sun-12:00 Race Part 2',
    ]);
    expect(list[0]!.url).toMatch(/^https:\/\/resultscdn\.getraceresults\.com\/2026\/.*Free%20Practice\.pdf$/);
    expect(creventicStart('Sat-12:10', mugello)).toBe('2026-03-21T11:10:00Z');
  });

  it('corrige los espacios de más del PDF', () => {
    expect(fixSpacing('Kikires hko-Gros s e')).toBe('Kikireshko-Grosse');
    expect(fixSpacing('T im H einemann')).toBe('Tim Heinemann');
    expect(fixSpacing('1:41.2 07')).toBe('1:41.207');
    expect(fixSpacing('Kumar-de Breuc ker')).toBe('Kumar-de Breucker');
    expect(fixSpacing('Mercedes-A MG GT 3 E VO')).toBe('Mercedes-AMG GT3 EVO');
  });

  it('lee la carrera con vueltas, subclases y no clasificados, y los pilotos del PDF de vueltas rápidas', () => {
    const rows = parseCreventicItems(items('creventic-barcelona-race.items.json'));
    expect(rows[0]).toMatchObject({ pos: 1, number: '88', class: 'GT3', laps: 741, time: '24:00:42.759', bestLap: '1:41.207', surnames: ['Heinemann', 'Kikireshko', 'Grosse', 'Renauer'] });
    expect(rows[1]).toMatchObject({ pos: 2, number: '21', class: 'GT3 Am', laps: 740, gap: '+1 vuelta' });
    expect(rows.find((r) => r.number === '69')).toMatchObject({ pos: null, status: 'NC' });
    const fastest = creventicFastestDrivers(items('creventic-barcelona-fastest.items.json'));
    expect(fastest.get('88')).toEqual(['Tim Heinemann']);
    expect(fastest.get('28')).toEqual(['Maxime Martin']);
    expect(fastest.get('286')).toEqual(['Patrick Liddy']);
    const q = parseCreventicItems(items('creventic-barcelona-q1-gt3.items.json'));
    expect(q[0]).toMatchObject({ pos: 1, number: '18', class: 'GT3 Pro-Am', time: '1:41.246', vehicle: 'Audi R8 LMS GT3 EVO II' });
  });
});

describe('Porsche Mobil 1 Supercup', () => {
  it('es una receta propia y arma el calendario desde la tabla o desde la página de resultados', () => {
    expect(findRecipe('https://racing.porsche.com/series/mobil-1-supercup')?.name).toBe('porsche');
    expect(porscheDateRange('30.07 – 01.08.2027')).toEqual({ start: '2027-07-30', end: '2027-08-01' });
    expect(porscheDateRange('03. – 06.06.2027')).toEqual({ start: '2027-06-03', end: '2027-06-06' });
    const cal = porscheCalendarTable(fixture('porsche-series-calendar.html'), 2027);
    expect(cal).toHaveLength(8);
    expect(cal[0]).toMatchObject({ name: 'Monaco Grand Prix', circuit: 'Circuit de Monaco', round: 1, key: 'monaco', tz: 'Europe/Monaco' });
    expect(porscheCalendarTable(fixture('porsche-series-calendar.html'), 2026)).toEqual([]);
    const rounds = porscheResultRounds(fixture('porsche-results-season-2026.html'));
    expect(rounds.map((r) => `${r.round} ${r.title} ${r.rows.length}`)).toEqual([
      '8 Monza 3',
      '6 Zandvoort 4',
      '5 Budapest 3',
      '4 Spa-Francorchamps 3',
      '3 Spielberg 3',
      '2 Barcelona 3',
      '1 Monaco 3',
    ]);
    expect(rounds[4]!.rows[2]).toMatchObject({ date: '2026-06-28', session: 'Race 3' });
  });

  it('lee la carrera y la clasificación doble del formato de la Fórmula 1', () => {
    const race = porscheRows(items('porsche-spielberg-race.items.json'));
    expect(race[0]).toMatchObject({ pos: 1, number: '1', driver: 'Robert de Haan', laps: 18, time: '27:46.436' });
    expect(race[4]).toMatchObject({ pos: 5, driver: 'Andrea Bristot', gap: '+8.626s' });
    expect(race.find((r) => r.number === '29')).toMatchObject({ pos: null, status: 'DNF' });
    expect(race.find((r) => r.number === '6')).toMatchObject({ pos: null, status: 'DSQ' });
    const quali = porscheRows(items('porsche-zandvoort-qualifying.items.json'));
    expect(quali[0]).toMatchObject({ pos: 1, number: '12', driver: 'Flynt Schuring', time: '1:35.585', laps: 12 });
    expect(quali.find((r) => r.driver === 'Jacques Villeneuve')).toMatchObject({ pos: 30, number: '911', time: '1:38.486', laps: 13 });
  });
});
