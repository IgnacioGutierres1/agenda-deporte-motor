/**
 * Condiciones medidas en pista (SessionResult.conditions): lectura en MotoGP (API oficial) y F1 (OpenF1), y
 * completado de las sesiones que ya tenían resultado guardado (core/conditions.ts).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  eventResultsFileSchema,
  type EventResultsFile,
  type MotorEvent,
  type Series,
  type Session,
  type SessionConditions,
  type Source,
} from '@dm/shared';
import { f1Adapter } from '../src/adapters/f1.ts';
import { mapConditions, MOTOGP_API, motogpAdapter } from '../src/adapters/motogp.ts';
import {
  matchOpenF1Session,
  openF1Conditions,
  openF1SessionsUrl,
  openF1WeatherUrl,
  summarizeWeather,
  type OpenF1Session,
  type OpenF1Weather,
} from '../src/adapters/openf1.ts';
import {
  applyConditions,
  conditionsLogFile,
  fillConditionsForSeries,
  MAX_CONDITION_ATTEMPTS,
  MAX_CONDITIONS_PER_RUN,
  sessionsWithoutConditions,
  sourceUnavailable,
  type ConditionsLog,
} from '../src/core/conditions.ts';
import { createContext } from '../src/core/context.ts';
import { HttpError, type Http } from '../src/core/http.ts';
import { createLogger } from '../src/core/log.ts';
import { mergeEventResults, pendingResultSessions, runResultsForSeries, type AttemptsLog } from '../src/core/results.ts';
import type { Adapter, AdapterContext, ConditionsChunk } from '../src/core/types.ts';
import { fakeHttp, fixture } from './fake-http.ts';
import { fixtureHttp } from './fixtures-http.ts';

const NOW = '2026-11-10T12:00:00Z';

// ───────────────────────────── MotoGP ─────────────────────────────

const R = `${MOTOGP_API}/results`;
const SEASON = 'e88b4e43-2209-47aa-8e83-0e0b1cedde6e';
const QAT_RESULTS = '5a880aba-62c4-413c-bb2d-b721683dd064';
const MGP_CAT = 'e8c110ad-64aa-4e8e-8a86-f2f152f6a942';
const SESSIONS_URL = `${R}/sessions?eventUuid=${QAT_RESULTS}&categoryUuid=${MGP_CAT}`;

const motogpRoutes = {
  [`${MOTOGP_API}/events?seasonYear=2026`]: 'motogp/events.json',
  [`${R}/seasons`]: 'motogp/results-seasons.json',
  [`${R}/events?seasonUuid=${SEASON}&isFinished=true`]: 'motogp/results-events.json',
  [`${R}/categories?eventUuid=${QAT_RESULTS}`]: 'motogp/results-categories.json',
  [SESSIONS_URL]: 'motogp/results-sessions.json',
  [`${R}/session/67c2f209-bea0-47e9-9375-d7958fd4fe1d/classification?test=false`]: 'motogp/classification-rac.json',
  [`${R}/session/d1022c09-0af2-4e5d-b4ac-fba02562fb0c/classification?test=false`]: 'motogp/classification-fp1.json',
};

const motogp: Series = {
  id: 'motogp',
  name: 'MotoGP',
  shortName: 'MotoGP',
  group: 'moto',
  officialUrls: ['https://www.motogp.com/en/calendar'],
  strategy: 'adapter',
  adapter: 'motogp',
  origin: 'default',
  enabled: true,
};

function contextWith(http: Http, cacheDir?: string): AdapterContext {
  return createContext({
    now: new Date(NOW),
    http,
    log: createLogger('test', true),
    durations: { motogp: { carrera: 50, sprint: 30 }, f1: { practica: 60, clasificacion: 60, sprint: 60, carrera: 120 } },
    broadcast: {},
    ...(cacheDir ? { cacheDir } : {}),
  });
}

describe('MotoGP: condiciones medidas (API oficial)', () => {
  it('traduce pista y cielo al español y deja los números como números', () => {
    expect(mapConditions({ track: 'Dry', air: '34º', humidity: '51%', ground: '42º', weather: 'Clear' })).toEqual({
      airC: 34,
      trackC: 42,
      humidity: 51,
      track: 'Seca',
      weather: 'Despejado',
    });
    expect(mapConditions({ track: 'Wet', air: '19º', humidity: '88%', ground: '21º', weather: 'Light-Rain' })).toMatchObject({
      track: 'Mojada',
      weather: 'Lluvia leve',
    });
    const text = (track: string, weather: string) => {
      const c = mapConditions({ track, air: '20º', humidity: '50%', ground: '25º', weather });
      return [c?.track, c?.weather];
    };
    expect(text('Wet-Dry', 'Partly-Cloudy')).toEqual(['Húmeda', 'Parcialmente nublado']);
    expect(text('Wet', 'Raining')).toEqual(['Mojada', 'Lluvia']);
    expect(text('Wet', 'Heavy-Rain')).toEqual(['Mojada', 'Lluvia intensa']);
    expect(text('Dry', 'Cloudy')).toEqual(['Seca', 'Nublado']);
  });

  it('sin ninguna medición no publica nada, aunque la API traiga "Dry"/"Clear"', () => {
    // Así vienen algunas sesiones terminadas (p. ej. BRA 2026, carrera) y las canceladas (AUS 2026, carrera).
    expect(mapConditions({ track: 'Dry', air: 'º', humidity: '%', ground: 'º', weather: 'Clear' })).toBeUndefined();
    expect(mapConditions({ track: '', air: 'º', humidity: '%', ground: 'º', weather: '' })).toBeUndefined();
    expect(mapConditions(null)).toBeUndefined();
    expect(mapConditions(undefined)).toBeUndefined();
  });

  it('no afirma "pista seca" cuando la misma API dice que llovía', () => {
    // Moto3, Australia 2026, FP2: el PDF oficial dice "Practice condition: Wet" con estos mismos números.
    expect(mapConditions({ track: 'Dry', air: '15º', humidity: '91%', ground: '18º', weather: 'Raining' })).toEqual({
      airC: 15,
      trackC: 18,
      humidity: 91,
      weather: 'Lluvia',
    });
    // Mojada y despejado sí es coherente (pista que todavía no secó).
    expect(mapConditions({ track: 'Wet', air: '15º', humidity: '91%', ground: '18º', weather: 'Clear' })).toMatchObject({
      track: 'Mojada',
      weather: 'Despejado',
    });
  });

  it('omite un texto desconocido o un número increíble en vez de publicarlo', () => {
    expect(mapConditions({ track: 'Greasy', air: '24º', humidity: '140%', ground: '', weather: 'Foggy' })).toEqual({ airC: 24 });
  });

  it('los resultados nuevos ya traen las condiciones, sin pedidos de más', async () => {
    const http = fixtureHttp(motogpRoutes);
    const ctx = contextWith(http);
    const chunk = await motogpAdapter.schedule(motogp, ctx);
    const pending = pendingResultSessions(chunk.sessions, ctx.now, {});
    const res = await motogpAdapter.results!(motogp, ctx, {
      events: chunk.events,
      sessions: chunk.sessions,
      pendingSessions: pending,
      standingsStale: false,
    });
    const file = eventResultsFileSchema.parse(res.results[0]);
    const nameOf = (id: string) => chunk.sessions.find((s) => s.id === id)!.name;
    const byName = new Map(file.sessions.map((s) => [nameOf(s.sessionId), s]));
    // Los mismos valores que encabezan los PDF oficiales de Qatar 2026 (ver fixture results-sessions.json).
    expect(byName.get('Carrera')!.conditions).toEqual({ airC: 31, trackC: 33, humidity: 61, track: 'Seca', weather: 'Despejado' });
    expect(byName.get('Práctica libre 1')!.conditions).toEqual({ airC: 34, trackC: 42, humidity: 51, track: 'Seca', weather: 'Despejado' });
    // Salen del listado de sesiones que el lector ya pedía: no aparece ninguna URL nueva.
    const known = /\/(events\?seasonYear=\d+|results\/(seasons|events\?.*|categories\?.*|sessions\?.*|session\/[\w-]+\/classification\?test=false))$/;
    expect(http.calls.filter((u) => !known.test(u))).toEqual([]);
  });

  it('completa las sesiones ya guardadas con el listado de sesiones, sin volver a pedir clasificaciones', async () => {
    const http = fixtureHttp(motogpRoutes);
    const ctx = contextWith(http);
    const chunk = await motogpAdapter.schedule(motogp, ctx);
    const qatar = chunk.sessions.filter((s) => s.eventId === chunk.events[0]!.id);
    http.calls.length = 0;
    const out = await motogpAdapter.conditions!(motogp, ctx, { events: chunk.events, sessions: qatar });
    expect(out.conditions.size).toBe(8);
    expect(out.deferred).toEqual([]);
    const sprint = qatar.find((s) => s.type === 'sprint')!;
    expect(out.conditions.get(sprint.id)).toEqual({ airC: 30, trackC: 33, humidity: 61, track: 'Seca', weather: 'Despejado' });
    expect(http.calls.some((u) => u.includes('/classification'))).toBe(false);
    expect(new Set(http.calls.filter((u) => u.includes('/results/')))).toEqual(
      new Set([`${R}/seasons`, `${R}/events?seasonUuid=${SEASON}&isFinished=true`, `${R}/categories?eventUuid=${QAT_RESULTS}`, SESSIONS_URL]),
    );
  });

  it('si la API pide esperar, deja de pedir y difiere lo que falta (no gasta intentos)', async () => {
    const base = fixtureHttp(motogpRoutes);
    const http: Http = {
      ...base,
      async json<T>(url: string) {
        if (url === SESSIONS_URL) throw new HttpError(url, 429, `HTTP 429 en ${url}`);
        return base.json<T>(url);
      },
    };
    const ctx = contextWith(http);
    const chunk = await motogpAdapter.schedule(motogp, ctx);
    const qatar = chunk.sessions.filter((s) => s.eventId === chunk.events[0]!.id);
    base.calls.length = 0;
    const out = await motogpAdapter.conditions!(motogp, ctx, { events: chunk.events, sessions: qatar });
    expect(out.conditions.size).toBe(0);
    expect(new Set(out.deferred)).toEqual(new Set(qatar.map((s) => s.id)));
    // Un solo intento sobre el listado: no se insiste sesión por sesión.
    expect(base.calls.filter((u) => u.includes('/categories'))).toHaveLength(1);
  });
});

// ───────────────────────────── Fórmula 1 (OpenF1) ─────────────────────────────

const f1: Series = {
  id: 'f1',
  name: 'Fórmula 1',
  shortName: 'F1',
  group: 'f1-fia',
  officialUrls: ['https://www.formula1.com/en/racing/2026'],
  strategy: 'adapter',
  adapter: 'f1',
  origin: 'default',
  enabled: true,
};

const F1_BASE = 'https://www.formula1.com';
const F1_SLUGS = ['pre-season-testing-1', 'australia', 'brazil', 'qatar', 'united-arab-emirates'];
const OPENF1_SESSIONS = openF1SessionsUrl(2026);
const OPENF1_BRAZIL = openF1WeatherUrl(1299);

function f1Routes(extra: Record<string, string> = {}): Record<string, string> {
  const res = `${F1_BASE}/en/results/2026`;
  const r: Record<string, string> = {
    [`${F1_BASE}/en/racing/2026`]: fixture('f1/season-2026.html'),
    [`${res}/races/1299/brazil/race-result`]: fixture('f1/results-brazil-race.html'),
    [`${res}/races/1299/brazil/qualifying`]: fixture('f1/results-brazil-qualifying.html'),
  };
  for (const s of F1_SLUGS) r[`${F1_BASE}/en/racing/2026/${s}`] = fixture(`f1/round-${s}.html`);
  return { ...r, ...extra };
}

const openF1Routes = {
  [OPENF1_SESSIONS]: fixture('f1/openf1-sessions-2026.json'),
  [OPENF1_BRAZIL]: fixture('f1/openf1-weather-1299.json'),
};

const openF1Sessions = JSON.parse(fixture('f1/openf1-sessions-2026.json')) as OpenF1Session[];
const brazilWeather = JSON.parse(fixture('f1/openf1-weather-1299.json')) as OpenF1Weather[];

/** Muestras sintéticas, una por minuto desde `start`, para probar los umbrales de lluvia. */
function minuteSamples(start: string, rain: number[], extra: Partial<OpenF1Weather> = {}): OpenF1Weather[] {
  return rain.map((rainfall, i) => ({
    date: new Date(Date.parse(start) + i * 60_000).toISOString(),
    session_key: 1,
    air_temperature: 20,
    track_temperature: 30,
    humidity: 50,
    wind_speed: 2,
    rainfall,
    ...extra,
  }));
}

describe('F1: clima medido en pista (OpenF1)', () => {
  it('ubica la sesión de OpenF1 por su hora de inicio', () => {
    expect(matchOpenF1Session(openF1Sessions, '2026-11-08T17:00:00Z')).toMatchObject({ session_key: 11412, meeting_key: 1299 });
    expect(matchOpenF1Session(openF1Sessions, '2026-11-07T18:00:00Z')).toMatchObject({ session_key: 11408 });
    // Una sesión que OpenF1 no tiene (otra hora) o que figura cancelada no se empareja con la más parecida.
    expect(matchOpenF1Session(openF1Sessions, '2026-11-08T13:00:00Z')).toBeNull();
    const cancelled = openF1Sessions.map((s) => (s.session_key === 11412 ? { ...s, is_cancelled: true } : s));
    expect(matchOpenF1Session(cancelled, '2026-11-08T17:00:00Z')).toBeNull();
  });

  it('resume la sesión con la mediana desde el inicio, sin las muestras previas ni las lecturas disparatadas', () => {
    // Carrera de San Pablo 2026: lluvia solo en un par de muestras del final → no se afirma nada sobre la lluvia.
    expect(summarizeWeather(brazilWeather, 11412, '2026-11-08T17:00:00+00:00')).toEqual({
      airC: 16.2,
      trackC: 24.8,
      humidity: 86,
      windKmh: 10,
    });
    // Clasificación (demorada por lluvia: el feed siguió hasta las 20:26 UTC).
    expect(summarizeWeather(brazilWeather, 11408, '2026-11-07T18:00:00+00:00')).toMatchObject({
      trackC: 28.6,
      humidity: 92,
      windKmh: 5,
      weather: 'Lluvia',
    });
    // La mediana ignora las lecturas sueltas del sensor (en el fixture hay asfalto a 0 °C y a 43,6 °C).
    const track = brazilWeather.map((x) => x.track_temperature ?? NaN);
    expect(Math.min(...track)).toBe(0);
    expect(Math.max(...track)).toBeGreaterThan(40);
  });

  it('resume la lluvia: sin lluvia, por momentos, toda la sesión o sin afirmar nada', () => {
    const start = '2026-05-01T12:00:00Z';
    const weatherOf = (rain: number[]) => summarizeWeather(minuteSamples(start, rain), 1, start)?.weather;
    const dry = Array<number>(60).fill(0);
    expect(weatherOf(dry)).toBe('Sin lluvia');
    expect(weatherOf([...Array<number>(48).fill(0), ...Array<number>(12).fill(1)])).toBe('Lluvia por momentos');
    expect(weatherOf([...Array<number>(10).fill(0), ...Array<number>(50).fill(1)])).toBe('Lluvia');
    expect(weatherOf([...Array<number>(58).fill(0), 1, 1])).toBeUndefined();
    // Las muestras anteriores al inicio no cuentan, y con muy pocas no se resume.
    expect(summarizeWeather(minuteSamples('2026-05-01T11:00:00Z', dry), 1, start)).toBeUndefined();
    expect(summarizeWeather(minuteSamples(start, [0, 0, 0]), 1, start)).toBeUndefined();
    expect(summarizeWeather(minuteSamples(start, dry), 2, start)).toBeUndefined();
  });

  it('pide el índice del año y un solo archivo por fin de semana, y cita a OpenF1 como fuente', async () => {
    const http = fakeHttp(openF1Routes);
    const out = await openF1Conditions(contextWith(http), [
      { id: 'carrera', startUtc: '2026-11-08T17:00:00Z' },
      { id: 'clasificacion', startUtc: '2026-11-07T18:00:00Z' },
      { id: 'inexistente', startUtc: '2026-11-08T03:00:00Z' },
    ]);
    expect(http.calls).toEqual([OPENF1_SESSIONS, OPENF1_BRAZIL]);
    expect([...out.conditions.keys()].sort()).toEqual(['carrera', 'clasificacion']);
    expect(out.deferred).toEqual([]);
    expect(out.conditions.get('carrera')).toEqual({
      airC: 16.2,
      trackC: 24.8,
      humidity: 86,
      windKmh: 10,
      source: {
        url: 'https://api.openf1.org/v1/weather?session_key=11412',
        title: expect.stringContaining('OpenF1'),
        kind: 'api',
        method: 'directo',
        fetchedAt: NOW,
      },
    });
  });

  it('si OpenF1 rechaza o demora el pedido, difiere las sesiones en vez de darlas por perdidas', async () => {
    const base = fakeHttp(openF1Routes);
    const http: Http = {
      ...base,
      async json<T>(url: string) {
        if (url === OPENF1_BRAZIL) throw new HttpError(url, 401, `HTTP 401 en ${url}`);
        return base.json<T>(url);
      },
    };
    const out = await openF1Conditions(contextWith(http), [{ id: 'carrera', startUtc: '2026-11-08T17:00:00Z' }]);
    expect(out.conditions.size).toBe(0);
    expect(out.deferred).toEqual(['carrera']);
    expect(sourceUnavailable(new HttpError('x', 404, 'no'))).toBe(false);
    expect(sourceUnavailable(new HttpError('x', 503, 'no'))).toBe(true);
    expect(sourceUnavailable(new Error('timeout'))).toBe(true);
  });

  it('el lector de F1 agrega el clima a los resultados nuevos', async () => {
    const http = fakeHttp(f1Routes(openF1Routes));
    const ctx = contextWith(http);
    const { events, sessions } = await f1Adapter.schedule(f1, ctx);
    const brazil = events.find((e) => e.name === 'São Paulo Grand Prix')!;
    const pending = sessions.filter((s) => s.eventId === brazil.id && ['Race', 'Qualifying'].includes(s.originalName ?? ''));
    const out = await f1Adapter.results!(f1, ctx, { events, sessions, pendingSessions: pending, standingsStale: false });
    const file = eventResultsFileSchema.parse(out.results[0]);
    const race = file.sessions.find((s) => s.sessionId === pending.find((p) => p.originalName === 'Race')!.id)!;
    const quali = file.sessions.find((s) => s.sessionId === pending.find((p) => p.originalName === 'Qualifying')!.id)!;
    expect(race.rows[0]).toMatchObject({ pos: 1, driver: 'Lando Norris' });
    expect(race.source.url).toContain('formula1.com');
    expect(race.conditions).toMatchObject({ airC: 16.2, trackC: 24.8, humidity: 86 });
    expect(race.conditions!.source!.url).toBe('https://api.openf1.org/v1/weather?session_key=11412');
    expect(quali.conditions).toMatchObject({ weather: 'Lluvia', source: { url: 'https://api.openf1.org/v1/weather?session_key=11408' } });
  });

  it('si OpenF1 falla, el resultado se publica igual (sin condiciones)', async () => {
    const http = fakeHttp(f1Routes()); // OpenF1 responde 404 a todo
    const ctx = contextWith(http);
    const { events, sessions } = await f1Adapter.schedule(f1, ctx);
    const brazil = events.find((e) => e.name === 'São Paulo Grand Prix')!;
    const pending = sessions.filter((s) => s.eventId === brazil.id && s.originalName === 'Race');
    const out = await f1Adapter.results!(f1, ctx, { events, sessions, pendingSessions: pending, standingsStale: false });
    expect(out.results[0]!.sessions).toHaveLength(1);
    expect(out.results[0]!.sessions[0]!.rows.length).toBeGreaterThan(0);
    expect(out.results[0]!.sessions[0]!.conditions).toBeUndefined();
  });
});

// ───────────────────────────── Completado (core) ─────────────────────────────

const source: Source = { url: 'https://example.org/resultados', title: 'Resultados', kind: 'html', method: 'directo', fetchedAt: NOW };
const event: MotorEvent = {
  id: 'ev1',
  seriesId: 'motogp',
  name: 'Gran Premio',
  circuit: 'Circuito',
  country: 'Argentina',
  tz: 'America/Argentina/Buenos_Aires',
  dateStart: '2026-11-06',
  dateEnd: '2026-11-08',
  sessionsStatus: 'published',
  source,
};

function session(id: string, startUtc: string, extra: Partial<Session> = {}): Session {
  return {
    id,
    eventId: 'ev1',
    seriesId: 'motogp',
    type: 'practica',
    name: id,
    startUtc,
    endUtc: new Date(Date.parse(startUtc) + 3600_000).toISOString().replace('.000Z', 'Z'),
    endEstimated: false,
    broadcast: [],
    broadcastIsDefault: false,
    source,
    hasResults: true,
    ...extra,
  };
}

const rows = [{ pos: 1, driver: 'Piloto Uno', time: '1:30.000' }];
const measured: SessionConditions = { airC: 24, trackC: 38, humidity: 45, track: 'Seca', weather: 'Despejado' };

function resultsFile(sessions: EventResultsFile['sessions'], eventId = 'ev1'): EventResultsFile {
  return { seriesId: 'motogp', eventId, updatedAt: '2026-11-08T20:00:00Z', sessions };
}

/** Carpeta de datos temporal con los archivos de resultados dados. */
function dataDirWith(files: EventResultsFile[]): { dir: string; cacheDir: string; read: (eventId?: string) => EventResultsFile } {
  const dir = mkdtempSync(path.join(tmpdir(), 'dm-cond-'));
  const target = (eventId: string) => path.join(dir, 'results', 'motogp', `${eventId}.json`);
  mkdirSync(path.dirname(target('x')), { recursive: true });
  for (const f of files) writeFileSync(target(f.eventId), JSON.stringify(f));
  return {
    dir,
    cacheDir: path.join(dir, '_cache'),
    read: (eventId = 'ev1') => JSON.parse(readFileSync(target(eventId), 'utf8')) as EventResultsFile,
  };
}

function adapterWith(conditions: Adapter['conditions'], results?: Adapter['results']): Adapter {
  return { name: 'x', schedule: async () => ({ events: [], sessions: [] }), ...(results ? { results } : {}), conditions };
}

const readLog = (cacheDir: string): ConditionsLog =>
  existsSync(conditionsLogFile(cacheDir)) ? (JSON.parse(readFileSync(conditionsLogFile(cacheDir), 'utf8')) as ConditionsLog) : {};

describe('condiciones: qué sesiones se consultan', () => {
  const a = session('a', '2026-11-06T10:00:00Z');
  const b = session('b', '2026-11-07T10:00:00Z');
  const c = session('c', '2026-11-08T10:00:00Z');
  const file = resultsFile([
    { sessionId: 'a', rows, source },
    { sessionId: 'b', rows, conditions: measured, source },
    { sessionId: 'c', rows, source },
    { sessionId: 'vacia', rows: [], source },
  ]);

  it('las que tienen resultado y no tienen condiciones, de la más reciente a la más vieja', () => {
    expect(sessionsWithoutConditions([file], [a, b, c], {}).map((s) => s.id)).toEqual(['c', 'a']);
  });

  it('saltea las recién leídas, las que agotaron sus consultas y respeta el tope por corrida', () => {
    expect(sessionsWithoutConditions([file], [a, b, c], {}, new Set(['c'])).map((s) => s.id)).toEqual(['a']);
    const spent = { c: { count: MAX_CONDITION_ATTEMPTS, last: NOW }, a: { count: MAX_CONDITION_ATTEMPTS - 1, last: NOW } };
    expect(sessionsWithoutConditions([file], [a, b, c], spent).map((s) => s.id)).toEqual(['a']);
    expect(sessionsWithoutConditions([file], [a, b, c], {}, new Set(), 1).map((s) => s.id)).toEqual(['c']);

    const many = Array.from({ length: MAX_CONDITIONS_PER_RUN + 10 }, (_, i) =>
      session(`s${i}`, new Date(Date.parse('2026-03-01T10:00:00Z') + i * 86_400_000).toISOString().replace('.000Z', 'Z')),
    );
    const all = resultsFile(many.map((s) => ({ sessionId: s.id, rows, source })));
    const picked = sessionsWithoutConditions([all], many, {});
    expect(picked).toHaveLength(MAX_CONDITIONS_PER_RUN);
    expect(picked[0]!.id).toBe(`s${MAX_CONDITIONS_PER_RUN + 9}`);
  });

  it('unas condiciones vacías o con solo la fuente cuentan como "sin condiciones"', () => {
    const empty = resultsFile([{ sessionId: 'a', rows, conditions: { source }, source }]);
    expect(sessionsWithoutConditions([empty], [a], {}).map((s) => s.id)).toEqual(['a']);
  });
});

describe('condiciones: completado de resultados guardados', () => {
  const a = session('a', '2026-11-06T10:00:00Z');
  const b = session('b', '2026-11-07T10:00:00Z');
  const c = session('c', '2026-11-08T10:00:00Z');
  const stored = () =>
    resultsFile([
      { sessionId: 'a', rows, source },
      { sessionId: 'b', rows, conditions: measured, source },
      { sessionId: 'c', rows, source },
    ]);

  it('agrega solo las condiciones que faltan, sin tocar filas, fuente ni las que ya estaban', () => {
    const file = stored();
    const other: SessionConditions = { airC: 10 };
    const updated = applyConditions(file, new Map([['a', other], ['b', other], ['zzz', other]]), NOW)!;
    expect(updated.updatedAt).toBe(NOW);
    expect(updated.sessions).toEqual([
      { sessionId: 'a', rows, conditions: other, source },
      { sessionId: 'b', rows, conditions: measured, source },
      { sessionId: 'c', rows, source },
    ]);
    expect(file.sessions[0]!.conditions).toBeUndefined(); // no modifica el original
    expect(applyConditions(file, new Map([['b', other]]), NOW)).toBeNull();
    expect(applyConditions(file, new Map([['a', {}]]), NOW)).toBeNull();
  });

  it('escribe lo hallado, cuenta un intento por sesión sin dato y no cuenta las diferidas', async () => {
    const d = session('d', '2026-11-08T14:00:00Z');
    const data = dataDirWith([resultsFile([...stored().sessions, { sessionId: 'd', rows, source }])]);
    const asked: string[][] = [];
    const adapter = adapterWith(async (_s, _ctx, req): Promise<ConditionsChunk> => {
      asked.push(req.sessions.map((s) => s.id));
      return { conditions: new Map([['c', measured]]), deferred: ['d'] };
    });
    const ctx = contextWith(fakeHttp({}), data.cacheDir);
    const filled = await fillConditionsForSeries(motogp, adapter, ctx, [event], [a, b, c, d], data.dir, false);

    expect(filled).toBe(1);
    expect(asked).toEqual([['d', 'c', 'a']]);
    const file = eventResultsFileSchema.parse(data.read());
    expect(file.updatedAt).toBe(NOW);
    expect(file.sessions.find((s) => s.sessionId === 'c')).toEqual({ sessionId: 'c', rows, conditions: measured, source });
    expect(file.sessions.find((s) => s.sessionId === 'a')).toEqual({ sessionId: 'a', rows, source });
    expect(readLog(data.cacheDir)).toEqual({ a: { count: 1, last: NOW } });
  });

  it('deja de consultar una sesión tras MAX_CONDITION_ATTEMPTS corridas sin dato, y después no pide nada', async () => {
    const data = dataDirWith([resultsFile([{ sessionId: 'a', rows, source }])]);
    let calls = 0;
    const adapter = adapterWith(async () => {
      calls++;
      return { conditions: new Map() };
    });
    const ctx = contextWith(fakeHttp({}), data.cacheDir);
    for (let i = 0; i < MAX_CONDITION_ATTEMPTS + 2; i++) {
      await fillConditionsForSeries(motogp, adapter, ctx, [event], [a], data.dir, false);
    }
    expect(calls).toBe(MAX_CONDITION_ATTEMPTS);
    expect(readLog(data.cacheDir).a!.count).toBe(MAX_CONDITION_ATTEMPTS);
    expect(data.read().sessions).toEqual([{ sessionId: 'a', rows, source }]);
  });

  it('un lector que falla no rompe nada: el archivo queda igual y no se gasta ningún intento', async () => {
    const data = dataDirWith([stored()]);
    const before = readFileSync(path.join(data.dir, 'results', 'motogp', 'ev1.json'), 'utf8');
    const adapter = adapterWith(async () => {
      throw new Error('fuente caída');
    });
    const ctx = contextWith(fakeHttp({}), data.cacheDir);
    await expect(fillConditionsForSeries(motogp, adapter, ctx, [event], [a, b, c], data.dir, false)).resolves.toBe(0);
    expect(readFileSync(path.join(data.dir, 'results', 'motogp', 'ev1.json'), 'utf8')).toBe(before);
    expect(readLog(data.cacheDir)).toEqual({});
  });

  it('con --dry-run consulta pero no escribe ni el archivo ni el registro', async () => {
    const data = dataDirWith([stored()]);
    const adapter = adapterWith(async () => ({ conditions: new Map([['a', measured]]) }));
    const ctx = contextWith(fakeHttp({}), data.cacheDir);
    expect(await fillConditionsForSeries(motogp, adapter, ctx, [event], [a, b, c], data.dir, true)).toBe(1);
    expect(data.read().sessions[0]!.conditions).toBeUndefined();
    expect(existsSync(conditionsLogFile(data.cacheDir))).toBe(false);
  });

  it('sin lector de condiciones, o sin nada que completar, no hace nada', async () => {
    const data = dataDirWith([resultsFile([{ sessionId: 'b', rows, conditions: measured, source }])]);
    const ctx = contextWith(fakeHttp({}), data.cacheDir);
    let called = false;
    const adapter = adapterWith(async () => {
      called = true;
      return { conditions: new Map() };
    });
    expect(await fillConditionsForSeries(motogp, adapter, ctx, [event], [b], data.dir, false)).toBe(0);
    expect(called).toBe(false);
    const plain: Adapter = { name: 'x', schedule: async () => ({ events: [], sessions: [] }) };
    expect(await fillConditionsForSeries(motogp, plain, ctx, [event], [b], data.dir, false)).toBe(0);
  });
});

describe('condiciones y resultados', () => {
  it('una relectura del resultado sin condiciones conserva las guardadas', () => {
    const existing = resultsFile([{ sessionId: 'a', rows, conditions: measured, source }]);
    const reread = resultsFile([{ sessionId: 'a', rows: [{ pos: 1, driver: 'Piloto Dos' }], source }]);
    expect(mergeEventResults(existing, reread).sessions).toEqual([
      { sessionId: 'a', rows: [{ pos: 1, driver: 'Piloto Dos' }], conditions: measured, source },
    ]);
    const better: SessionConditions = { airC: 30 };
    const withNew = resultsFile([{ sessionId: 'a', rows, conditions: better, source }]);
    expect(mergeEventResults(existing, withNew).sessions[0]!.conditions).toEqual(better);
  });

  it('el completado corre después de los resultados, sin tocar sus intentos ni repetir las sesiones recién leídas', async () => {
    const old = session('old', '2026-11-06T10:00:00Z');
    const fresh = session('fresh', '2026-11-08T10:00:00Z', { hasResults: false });
    const missing = session('missing', '2026-11-09T10:00:00Z', { hasResults: false });
    const data = dataDirWith([resultsFile([{ sessionId: 'old', rows, source }])]);
    const asked: string[][] = [];
    const adapter = adapterWith(
      async (_s, _ctx, req) => {
        asked.push(req.sessions.map((s) => s.id));
        return { conditions: new Map([['old', measured]]) };
      },
      // El lector trae el resultado de `fresh` (sin condiciones todavía) y no encuentra el de `missing`.
      async () => ({ results: [resultsFile([{ sessionId: 'fresh', rows, source }])] }),
    );
    const attempts: AttemptsLog = {};
    const ctx = contextWith(fakeHttp({}), data.cacheDir);
    const out = await runResultsForSeries(motogp, adapter, ctx, [event], [old, fresh, missing], attempts, data.dir, false);

    expect([...out.withResults].sort()).toEqual(['fresh', 'old']);
    // Intentos de resultados: solo la sesión que sigue sin resultado. El completado no agrega ni quita nada.
    expect(Object.keys(attempts)).toEqual(['missing']);
    // Se consultó solo la vieja: la recién leída ya la intentó el lector en esta corrida.
    expect(asked).toEqual([['old']]);
    const file = eventResultsFileSchema.parse(data.read());
    expect(file.sessions.find((s) => s.sessionId === 'old')!.conditions).toEqual(measured);
    expect(file.sessions.find((s) => s.sessionId === 'fresh')).toEqual({ sessionId: 'fresh', rows, source });
    expect(readLog(data.cacheDir)).toEqual({});
  });

  it('si el completado falla, los resultados de la corrida quedan escritos', async () => {
    const fresh = session('fresh', '2026-11-08T10:00:00Z', { hasResults: false });
    const old = session('old', '2026-11-06T10:00:00Z');
    const data = dataDirWith([resultsFile([{ sessionId: 'old', rows, source }])]);
    const adapter = adapterWith(
      async () => {
        throw new HttpError('https://example.org', 500, 'HTTP 500');
      },
      async () => ({ results: [resultsFile([{ sessionId: 'fresh', rows, source }])] }),
    );
    const ctx = contextWith(fakeHttp({}), data.cacheDir);
    const out = await runResultsForSeries(motogp, adapter, ctx, [event], [old, fresh], {}, data.dir, false);
    expect(out.withResults.has('fresh')).toBe(true);
    expect(data.read().sessions.map((s) => s.sessionId)).toEqual(['old', 'fresh']);
  });
});
