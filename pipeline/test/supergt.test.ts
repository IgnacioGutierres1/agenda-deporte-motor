import { describe, expect, it } from 'vitest';
import { supergt, supergtJapaneseUrl } from '../src/generic/supergt.ts';
import type { RecipeContext } from '../src/generic/types.ts';
import { fakeHttp, fixture, genericSeries } from './fakes.ts';

const EN = 'https://supergt.net/en';
const series = genericSeries('super-gt', 'SUPER GT', [`${EN}/calendar`, `${EN}/driver_ranking`], { rosterUrls: [`${EN}/teams_and_drivers`] });

function ctx(routes: Record<string, string>, season = 2026): RecipeContext {
  return { season, series, http: fakeHttp(routes), now: new Date('2026-11-11T12:00:00Z') };
}

const doc = (url: string, raw: string) => ({ url, kind: 'html' as const, raw, text: '', title: '', hash: '' });
const calendarDoc = () => doc(`${EN}/calendar?series=2026`, fixture('supergt-calendar-2026.html'));

/** Rankings de 2026; para otra temporada el sitio devuelve la misma página (la temporada actual). */
const rankings = (season: number) => ({
  [`${EN}/driver_ranking?series=${season}&gt_class=gt500`]: fixture('supergt-driver-ranking-gt500.html'),
  [`${EN}/driver_ranking?series=${season}&gt_class=gt300`]: fixture('supergt-driver-ranking-gt300.html'),
  [`${EN}/team_ranking?series=${season}&gt_class=gt500`]: fixture('supergt-team-ranking-gt500.html'),
  [`${EN}/team_ranking?series=${season}&gt_class=gt300`]: fixture('supergt-team-ranking-gt300.html'),
});

describe('SUPER GT (supergt.net)', () => {
  it('reconoce el sitio y arma la URL del calendario de la temporada', () => {
    expect(supergt.match(`${EN}/calendar`)).toBe(true);
    expect(supergt.match('https://www.supergt.net/en/driver_ranking')).toBe(true);
    expect(supergt.match('https://superformula.net/sf3/')).toBe(false);
    expect(supergt.calendarUrl!(`${EN}/calendar`, 2027)).toBe(`${EN}/calendar?series=2027`);
  });

  it('calendario 2026: fechas de la fracción mes/días, rondas y circuitos (la Rd.3 de Sepang se corrió a Motegi)', async () => {
    const entries = await supergt.calendar!(calendarDoc(), ctx({}));
    expect(entries.map((e) => [e.round, e.name, e.circuit, e.dateStart, e.dateEnd, e.country, e.tz])).toEqual([
      [1, 'Round1 OKAYAMA GT 300km RACE', 'OKAYAMA International Circuit', '2026-04-11', '2026-04-12', 'Japan', 'Asia/Tokyo'],
      [2, 'Round2 FUJI', 'FUJI SPEEDWAY', '2026-05-03', '2026-05-04', 'Japan', 'Asia/Tokyo'],
      [4, 'Round4 FUJI', 'FUJI SPEEDWAY', '2026-08-01', '2026-08-02', 'Japan', 'Asia/Tokyo'],
      [5, 'Round5 SUZUKA GT 300km RACE', 'SUZUKA CIRCUIT', '2026-08-22', '2026-08-23', 'Japan', 'Asia/Tokyo'],
      [6, 'Round6 SUGO GT 300km RACE', 'Sportsland SUGO', '2026-09-19', '2026-09-20', 'Japan', 'Asia/Tokyo'],
      [7, 'Round7 AUTOPOLIS', 'AUTOPOLIS', '2026-10-17', '2026-10-18', 'Japan', 'Asia/Tokyo'],
      [3, 'Round3 MOTEGI GT 250km RACE', 'MOBILITY RESORT MOTEGI', '2026-11-06', '2026-11-07', 'Japan', 'Asia/Tokyo'],
      [8, 'Round8 MOTEGI GT 250km RACE GRAND FINAL', 'MOBILITY RESORT MOTEGI', '2026-11-06', '2026-11-08', 'Japan', 'Asia/Tokyo'],
    ]);
    expect(entries[0]!.url).toBe(`${EN}/races/round1-okayama-2`);
  });

  it('calendario de otra temporada: el título no coincide y no devuelve eventos', async () => {
    expect(await supergt.calendar!(calendarDoc(), ctx({}, 2027))).toEqual([]);
  });

  it('cronograma: página japonesa de la carrera, solo sesiones de SUPER GT, en UTC', async () => {
    const entries = await supergt.calendar!(calendarDoc(), ctx({}));
    const round8 = entries.find((e) => e.round === 8)!;
    expect(supergtJapaneseUrl(round8.url!)).toBe('https://supergt.net/races/round8-motegi-2');
    const c = ctx({ 'https://supergt.net/races/round8-motegi-2': fixture('supergt-race-round8-ja.html') });
    const found = await supergt.sessions!(round8, c);
    // Se omiten FIA-F4, pit walk y la "Grand Finale" (ceremonia).
    expect(found!.sessions).toEqual([
      { name: 'Exclusive Practice', startUtc: '2026-11-06T00:30:00Z', endUtc: '2026-11-06T02:00:00Z', localStartText: '09:30' },
      { name: 'Qualifying', startUtc: '2026-11-08T00:45:00Z', endUtc: '2026-11-08T01:30:00Z', localStartText: '09:45' },
      { name: 'Warm Up', startUtc: '2026-11-08T03:30:00Z', endUtc: '2026-11-08T03:50:00Z', localStartText: '12:30' },
      { name: 'Race', startUtc: '2026-11-08T05:00:00Z', endUtc: '2026-11-08T06:45:00Z', localStartText: '14:00' },
    ]);
    expect(found!.source).toMatchObject({ url: 'https://supergt.net/races/round8-motegi-2', kind: 'html', method: 'directo' });
  });

  it('cronograma: sin página (404) devuelve null', async () => {
    const entries = await supergt.calendar!(calendarDoc(), ctx({}));
    expect(await supergt.sessions!(entries[0]!, ctx({}))).toBeNull();
  });

  it('rankings: pilotos (dupla por auto) y equipos de GT500 y GT300', async () => {
    const found = await supergt.standings!(`${EN}/driver_ranking`, ctx(rankings(2026)));
    expect(found!.tables.map((t) => [t.title, t.rows.length])).toEqual([
      ['Pilotos GT500', 16],
      ['Pilotos GT300', 42],
      ['Equipos GT500', 14],
      ['Equipos GT300', 29],
    ]);
    const [p500, p300, e500] = found!.tables;
    expect(p500!.rows.slice(0, 2)).toEqual([
      { pos: 1, name: 'Naoki Yamamoto / Tadasuke Makino', team: 'STANLEY TEAM KUNIMITSU', number: '100', points: 85 },
      { pos: 2, name: 'Koudai Tsukakoshi / Yuto Nomura', team: 'Astemo REAL RACING', number: '17', points: 65 },
    ]);
    // Si la dupla cambió durante el año, el sitio separa a los pilotos del mismo auto en filas distintas.
    expect(p500!.rows.filter((r) => r.number === '23').map((r) => r.name)).toEqual(['Mitsunori Takaboshi', 'Katsumasa Chiyo', 'Daiki Sasaki']);
    expect(p300!.rows[1]).toEqual({ pos: 2, name: 'Sven Müller', team: 'seven x seven Racing', number: '666', points: 82 });
    expect(e500!.rows.slice(0, 3)).toEqual([
      { pos: 1, name: 'STANLEY TEAM KUNIMITSU', number: '100', points: 108 },
      { pos: 2, name: 'TGR TEAM au TOM’S', number: '36', points: 84 },
      { pos: 3, name: 'Astemo REAL RACING', number: '17', points: 84 },
    ]);
    expect(found!.source).toMatchObject({ url: `${EN}/driver_ranking?series=2026&gt_class=gt500`, kind: 'html', method: 'directo' });
  });

  it('rankings de una temporada sin datos: el sitio muestra la actual y se devuelve null', async () => {
    expect(await supergt.standings!(`${EN}/driver_ranking`, ctx(rankings(2027), 2027))).toBeNull();
  });

  it('inscriptos: un piloto por fila con equipo, número, modelo y clase (incluye el tercer piloto)', async () => {
    const c = ctx({
      [`${EN}/teams_and_drivers?series=2026&gt_class=gt500`]: fixture('supergt-teams-gt500.html'),
      [`${EN}/teams_and_drivers?series=2026&gt_class=gt300`]: fixture('supergt-teams-gt300.html'),
    });
    const found = await supergt.roster!(`${EN}/teams_and_drivers`, c);
    expect(found!.rows.slice(0, 2)).toEqual([
      { driver: 'Kakunoshin Ohta', team: 'Team HRC ARTA MUGEN', number: '8', vehicle: 'Honda HRC PRELUDE-GT', class: 'GT500' },
      { driver: 'Hiroki Otsu', team: 'Team HRC ARTA MUGEN', number: '8', vehicle: 'Honda HRC PRELUDE-GT', class: 'GT500' },
    ]);
    expect(found!.rows.filter((r) => r.number === '23').map((r) => r.driver)).toEqual(['Katsumasa Chiyo', 'Mitsunori Takaboshi', 'Daiki Sasaki']);
    expect(found!.rows.find((r) => r.number === '666')).toMatchObject({ driver: 'Sven Müller', class: 'GT300', vehicle: 'PORSCHE 911 GT3R EVO' });
    expect(new Set(found!.rows.map((r) => r.class))).toEqual(new Set(['GT500', 'GT300']));
    expect(found!.rows.every((r) => r.driver && r.team && r.number && r.vehicle)).toBe(true);
    expect(found!.source).toMatchObject({ url: `${EN}/teams_and_drivers?series=2026&gt_class=gt500`, kind: 'html', method: 'directo' });
  });

  it('inscriptos de una temporada sin lista: null', async () => {
    const empty = fixture('supergt-teams-gt500.html').replace(/2026 Series Entry/g, '2027 Series Entry').replace(/<table class="common drivers_teams">[\s\S]*$/, '');
    const c = ctx({ [`${EN}/teams_and_drivers?series=2027&gt_class=gt500`]: empty, [`${EN}/teams_and_drivers?series=2027&gt_class=gt300`]: empty }, 2027);
    expect(await supergt.roster!(`${EN}/teams_and_drivers`, c)).toBeNull();
  });
});
