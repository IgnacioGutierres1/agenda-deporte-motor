import { describe, expect, it } from 'vitest';
import { stableHash, type MotorEvent, type RosterFile, type Series, type Session, type Source, type StandingsFile } from '@dm/shared';
import { createBuilders, normalizeEvent, normalizeSession } from '../src/core/builders.ts';
import { duplicateCandidates, editDistance, ignoredPairs } from '../src/core/driver-candidates.ts';
import { buildDrivers, buildTeams, teamDisplayName } from '../src/core/drivers.ts';
import { matchSession } from '../src/generic/index.ts';
import { countryEs } from '../src/generic/places.ts';
import { createGenericAdapter } from '../src/generic/index.ts';
import { fakeGemini, fakeHttp, fixture, genericSeries, testContext } from './fakes.ts';

const source: Source = { url: 'https://example.org/', title: 'x', kind: 'html', method: 'directo', fetchedAt: '2026-11-10T00:00:00Z' };
const mkSeries = (id: string, group: Series['group']): Series => ({
  id,
  name: id,
  shortName: id,
  group,
  officialUrls: ['https://example.org/'],
  strategy: 'generic',
  origin: 'default',
  enabled: true,
});
const build = createBuilders({ default: { carrera: 60 } }, {});

describe('constructores: nombres prolijos sin cambiar ids', () => {
  const tc = mkSeries('tc', 'argentina');
  const raw = {
    series: tc,
    season: 2026,
    key: 'r14',
    name: 'Fecha 14 — RIO CUARTO',
    round: 14,
    circuit: 'Parque Ciudad de Rio Cuarto',
    country: 'AR',
    tz: 'America/Argentina/Cordoba',
    dateStart: '2026-11-13',
    dateEnd: '2026-11-15',
    sessionsStatus: 'published' as const,
    source,
  };

  it('evento: nombre, circuito y país en español; el id sale de la clave', () => {
    const e = build.event(raw);
    expect(e).toMatchObject({ name: 'Fecha 14 — Río Cuarto', circuit: 'Parque Ciudad de Río Cuarto', country: 'Argentina' });
    expect(e.id).toBe(stableHash('tc', 2026, 'r14'));
    expect(build.event({ ...raw, name: 'Fecha 14 — Río Cuarto' }).id).toBe(e.id);
    // Idempotente (lo que se conserva de corridas anteriores se vuelve a normalizar).
    expect(normalizeEvent(e, tc)).toEqual(e);
  });

  it('el tipo de evento se deduce del nombre original', () => {
    const wec = mkSeries('wec', 'gt-endurance');
    const e = build.event({ ...raw, series: wec, key: 'prologue', name: 'Official Prologue - IMOLA', round: undefined, country: 'Italy', tz: 'Europe/Rome' });
    expect(e).toMatchObject({ name: 'Official Prologue - Imola', kind: 'test', country: 'Italia' });
  });

  it('NASCAR / IndyCar / IMSA conservan las mayúsculas de marca', () => {
    const cup = mkSeries('nascar-cup', 'usa');
    const e = build.event({ ...raw, series: cup, key: 'r1', name: 'DAYTONA 500', round: 1, circuit: 'Daytona International Speedway', country: 'United States', tz: 'America/New_York' });
    expect(e).toMatchObject({ name: 'DAYTONA 500', country: 'Estados Unidos' });
  });

  it('sesión: nombre en español, original en originalName y el mismo id que con el nombre original', () => {
    const event = build.event(raw);
    const s = build.session({ event, type: 'practica', name: 'Free Practice 1', startUtc: '2026-11-13T12:00:00Z', source });
    expect(s).toMatchObject({ name: 'Práctica libre 1', originalName: 'Free Practice 1' });
    expect(s.id).toBe(stableHash(event.id, 'practica', 'Free Practice 1', undefined));
    expect(normalizeSession(s)).toEqual(s);
    // Ya en español: sin originalName.
    const es = build.session({ event, type: 'carrera', name: 'Carrera', startUtc: '2026-11-15T15:00:00Z', source });
    expect(es.originalName).toBeUndefined();
    // Datos viejos (sin originalName, con el nombre en inglés): se traducen y el original queda guardado.
    const old: Session = { ...s, name: 'Free Practice 1' };
    delete old.originalName;
    expect(normalizeSession(old)).toEqual(s);
  });

  it('resultados: la sesión se reconoce por el nombre original o por el traducido', () => {
    const event = build.event(raw);
    const fp = build.session({ event, type: 'practica', name: 'Free Practice 1', startUtc: '2026-11-13T12:00:00Z', source });
    const q = build.session({ event, type: 'clasificacion', name: 'Qualifying', startUtc: '2026-11-14T12:00:00Z', source });
    const race = build.session({ event, type: 'carrera', name: 'Race', startUtc: '2026-11-15T12:00:00Z', source });
    expect(matchSession('Race', [fp, q, race])?.id).toBe(race.id);
    expect(matchSession('Free Practice 1', [fp, q, race])?.id).toBe(fp.id);
    expect(matchSession('Clasificación', [fp, q, race])?.id).toBe(q.id);
  });
});

describe('países en español', () => {
  it('unifica inglés, español y códigos', () => {
    expect(countryEs('United States')).toBe('Estados Unidos');
    expect(countryEs('USA')).toBe('Estados Unidos');
    expect(countryEs('Estados Unidos')).toBe('Estados Unidos');
    expect(countryEs('Great Britain')).toBe('Reino Unido');
    expect(countryEs('United Kingdom')).toBe('Reino Unido');
    expect(countryEs('Spain')).toBe('España');
    expect(countryEs('Qatar')).toBe('Catar');
    expect(countryEs('Czechia')).toBe('Chequia');
    expect(countryEs('Narnia')).toBe('Narnia');
  });

  it('corrige con la zona del circuito: Markham (IndyCar) es Canadá; sin país, el de la zona', () => {
    expect(countryEs('United States', 'America/Toronto')).toBe('Canadá');
    expect(countryEs('United States', 'America/Chicago')).toBe('Estados Unidos');
    expect(countryEs('', 'Europe/Budapest')).toBe('Hungría');
    expect(countryEs('', 'UTC')).toBe('');
  });
});

describe('índice de pilotos: alias, homónimos y nombres rotos', () => {
  const series = [mkSeries('supercars', 'otros'), mkSeries('igtc', 'gt-endurance'), mkSeries('nascar-cup', 'usa'), mkSeries('24h-series', 'gt-endurance'), mkSeries('turismo-pista', 'argentina')];
  const standings = (seriesId: string, rows: StandingsFile['tables'][number]['rows']): StandingsFile => ({
    seriesId,
    season: 2026,
    updatedAt: '2026-11-10T00:00:00Z',
    tables: [{ title: 'Pilotos', rows }],
    source,
  });
  const roster = (seriesId: string, rows: RosterFile['rows']): RosterFile => ({ seriesId, season: 2026, updatedAt: '2026-11-10T00:00:00Z', rows, source });
  const input = {
    series,
    standings: [
      standings('supercars', [{ pos: 1, name: 'Cam Waters', team: 'Monster Castrol Racing', points: 100 }]),
      standings('nascar-cup', [{ pos: 1, name: 'Josh Berry', points: 50 }]),
      standings('turismo-pista', [
        { pos: 1, name: 'CORTINA, JOAQUIN', points: 258 },
        { pos: 2, name: 'MENENDEZ, AGUST?N', points: 10 },
        { pos: 3, name: 'P?REZ, JUAN', points: 5 },
      ]),
    ],
    rosters: [
      roster('igtc', [{ driver: 'Cameron Waters', team: 'SCOTT TAYLOR MOTORSPORT', number: '222', country: 'Australia' }]),
      roster('24h-series', [{ driver: 'Josh Berry', team: 'EBM', number: '952', country: 'Australia' }]),
    ],
    results: [],
    sessions: [],
    generatedAt: '2026-11-10T00:00:00Z',
  };

  it('une las variantes conocidas, separa los homónimos y repara o descarta nombres rotos', () => {
    const file = buildDrivers(input);
    const byId = new Map(file.drivers.map((d) => [d.id, d]));
    expect(byId.get('cameron-waters')).toMatchObject({
      name: 'Cameron Waters',
      entries: [{ seriesId: 'supercars', team: 'Monster Castrol Racing' }],
      lineups: [{ seriesId: 'igtc', team: 'Scott Taylor Motorsport', number: '222' }],
    });
    expect(byId.has('cam-waters')).toBe(false);
    expect(byId.get('berry-josh')).toMatchObject({ entries: [{ seriesId: 'nascar-cup' }] });
    expect(byId.get('berry-josh')!.lineups).toBeUndefined();
    expect(byId.get('berry-josh-24h')).toMatchObject({ name: 'Josh Berry', country: 'Australia', lineups: [{ seriesId: '24h-series' }] });
    expect(byId.get('cortina-joaquin')!.name).toBe('Joaquín Cortina');
    expect(byId.get('agustin-menendez')!.name).toBe('Agustín Menendez');
    expect([...byId.keys()].some((id) => id.includes('perez') || id.includes('p-rez'))).toBe(false);
  });

  it('los equipos enlazan al piloto con su id canónico', () => {
    const drivers = buildDrivers(input);
    const teams = buildTeams({ ...input, drivers });
    const taylor = teams.teams.find((t) => t.id === 'scott-taylor-motorsport')!;
    expect(taylor.name).toBe('Scott Taylor Motorsport');
    expect(taylor.drivers).toEqual([{ id: 'cameron-waters', name: 'Cameron Waters', seriesId: 'igtc', number: '222' }]);
  });

  it('un resultado con el nombre más prolijo mejora el que se muestra', () => {
    const file = buildDrivers({
      ...input,
      sessions: [{ id: 's1', eventId: 'e1', seriesId: 'turismo-pista', type: 'carrera', name: 'Carrera', startUtc: '2026-11-01T15:00:00Z', endUtc: '2026-11-01T16:00:00Z', endEstimated: false, broadcast: [], broadcastIsDefault: true, source, hasResults: true }],
      results: [{ seriesId: 'turismo-pista', eventId: 'e1', updatedAt: '2026-11-01T17:00:00Z', sessions: [{ sessionId: 's1', rows: [{ pos: 1, driver: 'Joaquín Cortina' }], source }] }],
    });
    expect(file.drivers.find((d) => d.id === 'cortina-joaquin')).toMatchObject({ name: 'Joaquín Cortina', recent: [{ sessionId: 's1', pos: 1 }] });
  });

  it('equipos: siglas cortas en mayúsculas', () => {
    expect(teamDisplayName('KCMG')).toBe('KCMG');
    expect(teamDisplayName('KTMS')).toBe('KTMS');
    expect(teamDisplayName('ARGT')).toBe('ARGT');
    expect(teamDisplayName('ZIGGO SPORT TEMPESTA BY ARGT')).toBe('Ziggo Sport Tempesta by ARGT');
    expect(teamDisplayName('HMR RACING')).toBe('HMR Racing');
    expect(teamDisplayName('TEAM ZEROONE')).toBe('Team Zeroone');
  });
});

describe('candidatos a duplicados', () => {
  const d = (id: string, name: string, extra: Partial<{ team: string; number: string; seriesId: string; country: string }> = {}) => ({
    id,
    name,
    ...(extra.country ? { country: extra.country } : {}),
    entries: [],
    lineups: [{ seriesId: extra.seriesId ?? 'gtwc-europe', ...(extra.team ? { team: extra.team } : {}), ...(extra.number ? { number: extra.number } : {}) }],
  });

  it('nombres parecidos con algo en común', () => {
    const list = duplicateCandidates([
      d('mikey-porter', 'Mikey Porter', { team: 'Optimum Motorsport', number: '5' }),
      d('michael-porter', 'Michael Porter', { team: 'OPTIMUM MOTORSPORT', seriesId: '24h-series', number: '74' }),
      d('day-jamie', 'Jamie Day', { country: 'Great Britain', seriesId: 'gtwc-europe' }),
      d('alan-day-jamie', 'Jamie Alan Day', { country: 'Great Britain', seriesId: '24h-series' }),
      d('niclkas-nielsen', 'Niclkas Nielsen', { team: 'AF Corse', number: '51' }),
      d('nicklas-nielsen', 'Nicklas Nielsen', { team: 'AF Corse', number: '51' }),
      // Mismo apellido, nombres distintos y nada en común: no.
      d('ben-porter', 'Ben Porter', { seriesId: 'gtwc-australia' }),
      // Parecidos pero sin nada en común: no.
      d('jan-smith', 'Jan Smith', { seriesId: 'nls' }),
      d('jon-smith', 'Jon Smith', { seriesId: 'dtm' }),
    ]);
    expect(list.map((c) => [c.a.id, c.b.id].sort().join(' ~ ')).sort()).toEqual([
      'alan-day-jamie ~ day-jamie',
      'michael-porter ~ mikey-porter',
      'nicklas-nielsen ~ niclkas-nielsen',
    ]);
    expect(list.find((c) => c.a.id.includes('nielsen'))).toMatchObject({ nameMatch: 'nombre a 2 letras', evidence: ['equipo', 'número', 'categoría'] });
  });

  it('no vuelve a proponer homónimos ya resueltos', () => {
    const pair = [d('berry-josh', 'Josh Berry', { country: 'Australia' }), d('berry-josh-24h', 'Josh Berry', { country: 'Australia' })];
    expect(ignoredPairs().has('berry-josh|berry-josh-24h')).toBe(true);
    expect(duplicateCandidates(pair, ignoredPairs())).toEqual([]);
  });

  it('distancia de edición', () => {
    expect(editDistance('nicklas', 'niclkas')).toBe(2);
    expect(editDistance('lu', 'lyu')).toBe(1);
    expect(editDistance('', 'abc')).toBe(3);
  });
});

describe('APTP (Turismo Pista): nombres con "?" en lugar de la vocal acentuada', () => {
  it('se reparan al leer la tabla del campeonato', async () => {
    const tp = genericSeries('turismo-pista', 'Turismo Pista', ['https://aptpweb.com.ar/calendario-2026/', 'https://aptpweb.com.ar/campeonato-clase-1-2026/']);
    const page = fixture('aptp-campeonato-clase-1-2026.html').replace('BAYALA, LUCAS', 'MENENDEZ, AGUST?N');
    const http = fakeHttp(Object.fromEntries(['1', '2', '3'].map((n) => [`https://aptpweb.com.ar/campeonato-clase-${n}-2026/`, n === '1' ? page : fixture(`aptp-campeonato-clase-${n}-2026.html`)])));
    const out = await createGenericAdapter({ gemini: () => fakeGemini({}, { available: false }) }).results!(tp, testContext(http, '2026-11-12T12:00:00Z'), {
      events: [] as MotorEvent[],
      pendingSessions: [],
      sessions: [],
      standingsStale: true,
    });
    expect(out.standings!.tables[0]!.rows[2]).toMatchObject({ pos: 3, name: 'MENENDEZ, AGUSTÍN' });
  });
});
