/**
 * Clima de un circuito: cliente de Open-Meteo con caché y la lógica pura que usan las pantallas
 * (resumen de una sesión, pronóstico por día, códigos WMO y temperatura de pista estimada).
 *
 * La app consulta a Open-Meteo directo desde el navegador y solo manda las coordenadas del circuito
 * (redondeadas a 2 decimales, ~1 km): nunca la ubicación ni ningún otro dato del usuario.
 * Nada de este módulo tira errores hacia la interfaz: sin conexión simplemente no hay clima.
 */
import { DateTime } from 'luxon';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** Atribución obligatoria de la fuente (se muestra con link en cada bloque de clima). */
export const WEATHER_SOURCE = { label: 'Clima: Open-Meteo.com', url: 'https://open-meteo.com/' } as const;

/** Aclaración que acompaña siempre a la temperatura de pista: es un cálculo, no un dato medido. */
export const TRACK_NOTE =
  'Pista (estimada): cálculo propio con la temperatura del aire, el sol y el viento del pronóstico. No es una medición.';

/** Días de pronóstico que se piden (hoy incluido) y días hacia atrás (clima "según modelo" de lo ya corrido). */
export const FORECAST_DAYS = 16;
export const PAST_DAYS = 2;
/** Un pronóstico se vuelve a pedir pasada una hora. */
export const WEATHER_TTL_MS = 60 * 60_000;
/** Si el pedido falla (sin conexión), se usa la copia guardada mientras no tenga más de 12 horas. */
export const WEATHER_STALE_MS = 12 * HOUR;
export const WEATHER_TIMEOUT_MS = 8_000;
/** Circuitos guardados en localStorage como máximo (cada pronóstico pesa ~25 KB). */
const MAX_STORED = 10;
const STORAGE_PREFIX = 'dm:weather:';
const STORAGE_VERSION = 1;

type Num = number | null;

/** Campo propio -> variable horaria de Open-Meteo. */
const HOURLY = {
  temp: 'temperature_2m',
  apparent: 'apparent_temperature',
  precipProb: 'precipitation_probability',
  precip: 'precipitation',
  code: 'weather_code',
  wind: 'wind_speed_10m',
  gusts: 'wind_gusts_10m',
  humidity: 'relative_humidity_2m',
  cloud: 'cloud_cover',
  radiation: 'shortwave_radiation',
  isDay: 'is_day',
} as const;

type Field = keyof typeof HOURLY;
const FIELDS = Object.keys(HOURLY) as Field[];
/** El bloque "current" no trae probabilidad de lluvia. */
const CURRENT_FIELDS = FIELDS.filter((f) => f !== 'precipProb');

export type HourlySeries = Record<Field, Num[]>;

export interface CurrentConditions extends Record<Exclude<Field, 'precipProb'>, Num> {
  /** Instante de la observación del modelo (ms desde epoch). */
  time: number;
}

/** Pronóstico horario de un punto, en UTC. */
export interface Forecast {
  v: number;
  /** Coordenadas pedidas (redondeadas). */
  lat: number;
  lon: number;
  /** Cuándo se descargó (ms desde epoch). */
  fetchedAt: number;
  /** Primera hora de la serie (ms desde epoch); las demás van de a una hora. */
  start: number;
  hours: number;
  hourly: HourlySeries;
  current: CurrentConditions | null;
}

// ---------------------------------------------------------------------------
// Coordenadas, clave de caché y URL
// ---------------------------------------------------------------------------

export function validCoords(lat: unknown, lon: unknown): boolean {
  return (
    typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180
  );
}

/** Redondeo a 2 decimales (el "+ 0" evita el "-0.00"). */
function round2(x: number): string {
  return (Math.round(x * 100) / 100 + 0).toFixed(2);
}

/** Clave de caché de un punto: "43.25,5.79". */
export function weatherKey(lat: number, lon: number): string {
  return `${round2(lat)},${round2(lon)}`;
}

export function forecastUrl(lat: number, lon: number): string {
  const params = [
    `latitude=${round2(lat)}`,
    `longitude=${round2(lon)}`,
    `hourly=${FIELDS.map((f) => HOURLY[f]).join(',')}`,
    `current=${CURRENT_FIELDS.map((f) => HOURLY[f]).join(',')}`,
    'timezone=UTC',
    `forecast_days=${FORECAST_DAYS}`,
    `past_days=${PAST_DAYS}`,
  ];
  return `https://api.open-meteo.com/v1/forecast?${params.join('&')}`;
}

/** Coordenadas para el clima a partir de la ficha del circuito (null si no las tiene). */
export function circuitCoords(
  info: { lat?: number; lon?: number; coordsApprox?: boolean } | null | undefined,
): { lat: number; lon: number; approx: boolean } | null {
  if (!info || !validCoords(info.lat, info.lon)) return null;
  return { lat: info.lat!, lon: info.lon!, approx: info.coordsApprox === true };
}

// ---------------------------------------------------------------------------
// Lectura de la respuesta
// ---------------------------------------------------------------------------

function num(v: unknown): Num {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** "2026-11-12T23:30" (Open-Meteo con timezone=UTC) -> ms desde epoch. */
function parseUtc(s: unknown): number {
  if (typeof s !== 'string') return NaN;
  return Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`);
}

/** Valida y compacta la respuesta de Open-Meteo. null si no tiene la forma esperada. */
export function parseForecast(json: unknown, lat: number, lon: number, fetchedAt: number): Forecast | null {
  if (!json || typeof json !== 'object') return null;
  const raw = json as { hourly?: Record<string, unknown>; current?: Record<string, unknown> };
  const times = raw.hourly?.time;
  if (!Array.isArray(times) || times.length < 2) return null;
  const start = parseUtc(times[0]);
  if (!Number.isFinite(start)) return null;
  // La serie tiene que ser horaria y sin huecos: todo lo demás se calcula por índice.
  for (let i = 1; i < times.length; i++) if (parseUtc(times[i]) !== start + i * HOUR) return null;

  const hourly = {} as HourlySeries;
  for (const f of FIELDS) {
    const arr = raw.hourly![HOURLY[f]];
    hourly[f] = Array.isArray(arr) && arr.length === times.length ? arr.map(num) : times.map(() => null);
  }
  if (!hourly.temp.some((t) => t !== null)) return null;

  let current: CurrentConditions | null = null;
  const time = parseUtc(raw.current?.time);
  if (raw.current && Number.isFinite(time)) {
    const c = { time } as CurrentConditions;
    for (const f of CURRENT_FIELDS) (c as unknown as Record<string, Num>)[f] = num(raw.current[HOURLY[f]]);
    current = c;
  }
  return {
    v: STORAGE_VERSION,
    lat: Number(round2(lat)),
    lon: Number(round2(lon)),
    fetchedAt,
    start,
    hours: times.length,
    hourly,
    current,
  };
}

// ---------------------------------------------------------------------------
// Cliente con caché (memoria + localStorage)
// ---------------------------------------------------------------------------

const memory = new Map<string, Forecast>();
const inflight = new Map<string, Promise<Forecast | null>>();

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function storedKeys(store: Storage): string[] {
  const keys: string[] = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k?.startsWith(STORAGE_PREFIX)) keys.push(k);
  }
  return keys;
}

function looksLikeForecast(f: unknown): f is Forecast {
  const x = f as Forecast | null;
  return (
    !!x &&
    x.v === STORAGE_VERSION &&
    Number.isFinite(x.fetchedAt) &&
    Number.isFinite(x.start) &&
    Number.isInteger(x.hours) &&
    !!x.hourly &&
    FIELDS.every((k) => Array.isArray(x.hourly[k]) && x.hourly[k].length === x.hours)
  );
}

function readStored(key: string): Forecast | null {
  try {
    const raw = storage()?.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return looksLikeForecast(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Guarda el pronóstico y, de paso, borra los vencidos y los más viejos si ya hay demasiados circuitos. */
function writeStored(key: string, forecast: Forecast): void {
  const store = storage();
  if (!store) return;
  try {
    const others: Array<{ k: string; at: number }> = [];
    for (const k of storedKeys(store)) {
      if (k === STORAGE_PREFIX + key) continue;
      let at = 0;
      try {
        at = Number((JSON.parse(store.getItem(k) ?? 'null') as Forecast | null)?.fetchedAt) || 0;
      } catch {
        at = 0;
      }
      if (forecast.fetchedAt - at > WEATHER_STALE_MS) store.removeItem(k);
      else others.push({ k, at });
    }
    others.sort((a, b) => b.at - a.at);
    for (const old of others.slice(MAX_STORED - 1)) store.removeItem(old.k);
    store.setItem(STORAGE_PREFIX + key, JSON.stringify(forecast));
  } catch {
    /* almacenamiento lleno o bloqueado: queda solo la copia en memoria */
  }
}

function age(forecast: Forecast, now: number): number {
  // Un reloj atrasado no debe dejar una copia "fresca" para siempre.
  return Math.abs(now - forecast.fetchedAt);
}

export interface ForecastOptions {
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

async function download(key: string, lat: number, lon: number, opts: ForecastOptions): Promise<Forecast | null> {
  const controller = typeof AbortController === 'undefined' ? null : new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const f = opts.fetchFn ?? fetch;
    // Sin credenciales ni "Referer": a Open-Meteo solo le llegan las coordenadas del circuito.
    const request = f(forecastUrl(lat, lon), { signal: controller?.signal, credentials: 'omit', referrerPolicy: 'no-referrer' }).then(
      async (res) => (res.ok ? parseForecast(await res.json(), lat, lon, Date.now()) : null),
    );
    // El límite vale aunque el pedido ignore la señal de cancelación.
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        controller?.abort();
        resolve(null);
      }, opts.timeoutMs ?? WEATHER_TIMEOUT_MS);
    });
    request.catch(() => undefined);
    const forecast = await Promise.race([request, timeout]);
    if (forecast) {
      memory.set(key, forecast);
      writeStored(key, forecast);
    }
    return forecast;
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Pronóstico de un punto. Usa la copia en memoria o en localStorage si tiene menos de una hora; si no, lo pide
 * (los pedidos simultáneos del mismo punto comparten una sola descarga). Nunca rechaza: sin conexión devuelve la
 * última copia de hasta 12 horas o null.
 */
export function getForecast(lat: number, lon: number, opts: ForecastOptions = {}): Promise<Forecast | null> {
  try {
    if (!validCoords(lat, lon)) return Promise.resolve(null);
    const key = weatherKey(lat, lon);
    const now = Date.now();
    let cached = memory.get(key) ?? null;
    if (!cached) {
      cached = readStored(key);
      if (cached) memory.set(key, cached);
    }
    if (cached && age(cached, now) < WEATHER_TTL_MS) return Promise.resolve(cached);

    const running = inflight.get(key);
    if (running) return running;
    const fallback = cached;
    const pending = download(key, lat, lon, opts)
      .then((fresh) => fresh ?? (fallback && age(fallback, Date.now()) < WEATHER_STALE_MS ? fallback : null))
      .catch(() => null)
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return pending;
  } catch {
    return Promise.resolve(null);
  }
}

/** Borra los pronósticos guardados (al desactivar "Mostrar clima" y en los tests). */
export function clearWeatherCache(): void {
  memory.clear();
  inflight.clear();
  try {
    const store = storage();
    if (store) for (const k of storedKeys(store)) store.removeItem(k);
  } catch {
    /* sin almacenamiento */
  }
}

// ---------------------------------------------------------------------------
// Alcance del pronóstico
// ---------------------------------------------------------------------------

function toMs(iso: string | number): number {
  return typeof iso === 'number' ? iso : Date.parse(iso);
}

/** Última hora con datos (ms desde epoch). */
export function forecastEnd(f: Forecast): number {
  return f.start + (f.hours - 1) * HOUR;
}

/**
 * Tramo que cubre un pronóstico pedido "ahora": desde 2 días (UTC) atrás hasta el final del día 16.
 * Sirve para decidir, sin pedir nada, si vale la pena consultar el clima de una sesión o un evento.
 */
export function forecastReach(now: string | number): { from: number; to: number } {
  const today = Math.floor(toMs(now) / DAY) * DAY;
  return { from: today - PAST_DAYS * DAY, to: today + FORECAST_DAYS * DAY - HOUR };
}

export function withinReach(startUtc: string | number, endUtc: string | number, now: string | number): boolean {
  const { from, to } = forecastReach(now);
  const a = toMs(startUtc);
  const b = toMs(endUtc);
  return Number.isFinite(a) && Number.isFinite(b) && a >= from && b <= to;
}

// ---------------------------------------------------------------------------
// Códigos WMO
// ---------------------------------------------------------------------------

export type WeatherIconName =
  | 'despejado'
  | 'despejado-noche'
  | 'algo-nublado'
  | 'algo-nublado-noche'
  | 'nublado'
  | 'niebla'
  | 'llovizna'
  | 'lluvia'
  | 'lluvia-fuerte'
  | 'chaparrones'
  | 'nieve'
  | 'aguanieve'
  | 'tormenta';

/** Código WMO (los que usa Open-Meteo) -> texto e ícono de día. */
const WMO: Record<number, [text: string, icon: WeatherIconName]> = {
  0: ['Despejado', 'despejado'],
  1: ['Mayormente despejado', 'despejado'],
  2: ['Parcialmente nublado', 'algo-nublado'],
  3: ['Nublado', 'nublado'],
  45: ['Niebla', 'niebla'],
  48: ['Niebla con escarcha', 'niebla'],
  51: ['Llovizna débil', 'llovizna'],
  53: ['Llovizna', 'llovizna'],
  55: ['Llovizna intensa', 'llovizna'],
  56: ['Llovizna helada', 'aguanieve'],
  57: ['Llovizna helada intensa', 'aguanieve'],
  61: ['Lluvia débil', 'lluvia'],
  63: ['Lluvia', 'lluvia'],
  65: ['Lluvia fuerte', 'lluvia-fuerte'],
  66: ['Lluvia helada', 'aguanieve'],
  67: ['Lluvia helada fuerte', 'aguanieve'],
  71: ['Nevada débil', 'nieve'],
  73: ['Nevada', 'nieve'],
  75: ['Nevada fuerte', 'nieve'],
  77: ['Granos de nieve', 'nieve'],
  80: ['Chaparrones débiles', 'chaparrones'],
  81: ['Chaparrones', 'chaparrones'],
  82: ['Chaparrones fuertes', 'lluvia-fuerte'],
  85: ['Chaparrones de nieve', 'nieve'],
  86: ['Chaparrones de nieve fuertes', 'nieve'],
  95: ['Tormenta', 'tormenta'],
  96: ['Tormenta con granizo', 'tormenta'],
  99: ['Tormenta con granizo fuerte', 'tormenta'],
};

const NIGHT_ICON: Partial<Record<WeatherIconName, WeatherIconName>> = {
  despejado: 'despejado-noche',
  'algo-nublado': 'algo-nublado-noche',
};

/** Texto en español e ícono de un código WMO. De noche cambian el sol y el sol con nubes. */
export function describeWeather(code: number | null | undefined, isDay = true): { text: string; icon: WeatherIconName } {
  const known = code == null ? undefined : WMO[code];
  if (!known) return { text: 'Sin dato del cielo', icon: 'nublado' };
  const [text, icon] = known;
  return { text, icon: isDay ? icon : (NIGHT_ICON[icon] ?? icon) };
}

/** Llovizna, lluvia, nieve, chaparrones o tormenta. */
export function isWetCode(code: number): boolean {
  return code >= 51;
}

/**
 * Estado del cielo predominante de un tramo. Gana el código que más tiempo ocupa, pero si llueve (o nieva)
 * al menos el 30 % del tramo se informa la precipitación más frecuente: un ícono de "nublado" con media
 * carrera bajo agua sería engañoso. En un empate gana el código más severo (el mayor).
 */
export function predominantCode(samples: Array<{ code: number | null; weight: number }>): number | null {
  const byCode = new Map<number, number>();
  let total = 0;
  let wet = 0;
  for (const s of samples) {
    if (s.code === null || !(s.weight > 0)) continue;
    byCode.set(s.code, (byCode.get(s.code) ?? 0) + s.weight);
    total += s.weight;
    if (isWetCode(s.code)) wet += s.weight;
  }
  if (!total) return null;
  const wantWet = wet / total >= 0.3;
  let best: number | null = null;
  let bestWeight = -1;
  for (const [code, weight] of byCode) {
    if (isWetCode(code) !== wantWet) continue;
    if (weight > bestWeight + 1e-9 || (Math.abs(weight - bestWeight) <= 1e-9 && code > (best ?? -1))) {
      best = code;
      bestWeight = weight;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Temperatura de pista estimada
// ---------------------------------------------------------------------------

/**
 * Temperatura de pista ESTIMADA (no es una medición): balance de energía simplificado del asfalto.
 *
 *   T_pista = T_aire + ΔT          ΔT = α · G_ef / (h₀ + h_v · v)
 *
 * - α = 0,9: fracción de la radiación solar que absorbe el asfalto.
 * - G_ef: radiación solar de onda corta "efectiva", en W/m² (ver effectiveRadiation). El asfalto tiene inercia,
 *   así que no cuenta solo el sol de este momento:
 *     G_ef = 0,6 · G_reciente + 0,4 · G_24h
 *   G_reciente promedia las últimas 6 horas pesando 1/2 la última, 1/4 la anterior, 1/8…; G_24h es el promedio
 *   de las últimas 24 horas (el calor acumulado: por eso de noche la pista queda unos grados sobre el aire).
 * - h₀ = 24 W/m²·K: lo que la pista pierde aunque no haya viento (infrarrojo, convección natural y calor que
 *   baja al suelo). h_v = 1 W/m²·K por cada m/s de viento a 10 m; v es el viento en m/s.
 * - ΔT se acota a 0–35 °C y el resultado a −30…75 °C.
 *
 * Órdenes de magnitud (los fija weather.test.ts): día de verano despejado con 25–30 °C de aire → 46–51 °C;
 * nublado → 4–5 °C sobre el aire; de noche → el aire más 1 a 5 °C según cuánto sol hubo en el día.
 *
 * Contraste: se corrió el modelo con el reanálisis de Open-Meteo para las coordenadas de cada circuito contra la
 * temperatura de pista que midió la F1 (datos de OpenF1) en 155 sesiones en seco de 2024 y 2025 (prácticas,
 * clasificaciones y carreras, de día y de noche). Las constantes se ajustaron con 2024 y se validaron con 2025:
 * error medio absoluto 2,4 °C en los dos años, y 9 de cada 10 sesiones a menos de 5 °C de lo medido (suponer
 * "pista = aire" erra 13 °C en promedio). El modelo no ve la pista mojada, la sombra ni el color del asfalto.
 */
export const TRACK_MODEL = {
  absorption: 0.9,
  baseLoss: 24,
  windLoss: 1,
  maxRise: 35,
  min: -30,
  max: 75,
  /** Radiación reciente: peso de cada hora anterior respecto de la siguiente, y cuántas horas se miran. */
  memory: 0.5,
  memoryHours: 6,
  /** Parte de la radiación efectiva que viene del promedio del último día (calor acumulado). */
  storedShare: 0.4,
  storedHours: 24,
} as const;

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Temperatura de pista estimada (°C) con el aire (°C), la radiación efectiva (W/m²) y el viento a 10 m (km/h). */
export function estimateTrackTemp(input: { airC: number; radiation: number; windKmh: number }): number {
  const wind = Math.max(0, input.windKmh) / 3.6;
  const gain = TRACK_MODEL.absorption * Math.max(0, input.radiation);
  const rise = clamp(gain / (TRACK_MODEL.baseLoss + TRACK_MODEL.windLoss * wind), 0, TRACK_MODEL.maxRise);
  return clamp(input.airC + rise, TRACK_MODEL.min, TRACK_MODEL.max);
}

/**
 * Radiación efectiva en la hora `i` de una serie horaria: 60 % de la reciente (últimas 6 horas con pesos
 * 1/2, 1/4, 1/8…) y 40 % del promedio de las últimas 24 horas.
 * Open-Meteo informa en cada hora la radiación media de la hora anterior, así que la fila `i` ya es "lo que
 * recibió la pista en la última hora". Si la serie no tiene 24 horas hacia atrás (el primer día del pronóstico),
 * el promedio diario se toma de sus primeras 24 horas: de un día al siguiente casi no cambia.
 */
export function effectiveRadiation(radiation: Num[], i: number): number | null {
  if (radiation[i] == null) return null;
  let sum = 0;
  let total = 0;
  let weight = 1;
  for (let k = 0; k < TRACK_MODEL.memoryHours; k++) {
    const g = radiation[i - k];
    if (g == null) break;
    sum += weight * g;
    total += weight;
    weight *= TRACK_MODEL.memory;
  }
  const recent = sum / total;

  const to = Math.min(Math.max(i, TRACK_MODEL.storedHours - 1), radiation.length - 1);
  let daySum = 0;
  let dayCount = 0;
  for (let j = Math.max(0, to - TRACK_MODEL.storedHours + 1); j <= to; j++) {
    const g = radiation[j];
    if (g != null) {
      daySum += g;
      dayCount++;
    }
  }
  const stored = dayCount ? daySum / dayCount : recent;
  return (1 - TRACK_MODEL.storedShare) * recent + TRACK_MODEL.storedShare * stored;
}

const trackCache = new WeakMap<Forecast, Num[]>();

/** Temperatura de pista estimada de cada hora del pronóstico. */
export function trackSeries(f: Forecast): Num[] {
  let series = trackCache.get(f);
  if (!series) {
    series = f.hourly.temp.map((airC, i) => {
      const radiation = effectiveRadiation(f.hourly.radiation, i);
      const windKmh = f.hourly.wind[i] ?? null;
      return airC === null || radiation === null || windKmh === null ? null : estimateTrackTemp({ airC, radiation, windKmh });
    });
    trackCache.set(f, series);
  }
  return series;
}

// ---------------------------------------------------------------------------
// Resumen de un tramo (una sesión)
// ---------------------------------------------------------------------------

export interface WeatherSummary {
  /** Temperatura del aire: media del tramo y extremos, °C. */
  tempC: number;
  tempMinC: number;
  tempMaxC: number;
  /** Sensación térmica media, °C. */
  apparentC: number | null;
  /** Probabilidad de precipitación más alta del tramo, %. */
  precipProb: number | null;
  /** Precipitación acumulada en el tramo, mm. */
  precipMm: number | null;
  /** Viento medio a 10 m, km/h. */
  windKmh: number | null;
  /** Ráfaga máxima, km/h. */
  gustsKmh: number | null;
  /** Humedad relativa media, %. */
  humidity: number | null;
  /** Estado del cielo predominante (código WMO). */
  code: number | null;
  isDay: boolean;
  /** Temperatura de pista estimada: media y extremos, °C. */
  trackC: number | null;
  trackMinC: number | null;
  trackMaxC: number | null;
}

/** Valor de una variable instantánea en `t`, interpolando entre las dos horas vecinas. */
function valueAt(series: Num[], f: Forecast, t: number): number | null {
  const x = (t - f.start) / HOUR;
  const i = Math.floor(x);
  const a = series[i];
  if (a == null) return null;
  const frac = x - i;
  if (frac === 0) return a;
  const b = series[i + 1];
  return b == null ? null : a + (b - a) * frac;
}

/** Media (ponderada por tiempo), mínimo y máximo de una variable instantánea entre `a` y `b`. */
function spanStats(series: Num[], f: Forecast, a: number, b: number): { mean: number; min: number; max: number } | null {
  const points = [a];
  for (let t = f.start + (Math.floor((a - f.start) / HOUR) + 1) * HOUR; t < b; t += HOUR) points.push(t);
  if (b > a) points.push(b);
  const values: number[] = [];
  for (const t of points) {
    const v = valueAt(series, f, t);
    if (v === null) return null;
    values.push(v);
  }
  let area = 0;
  for (let k = 1; k < points.length; k++) area += ((values[k - 1]! + values[k]!) / 2) * (points[k]! - points[k - 1]!);
  return { mean: b > a ? area / (b - a) : values[0]!, min: Math.min(...values), max: Math.max(...values) };
}

/**
 * Filas de las variables "de la hora anterior" (lluvia, probabilidad, ráfagas): la fila de las 15:00 cubre
 * de 14:00 a 15:00. Devuelve cada fila que toca el tramo con la fracción de su hora que cae adentro.
 */
function precedingRows(f: Forecast, a: number, b: number): Array<{ i: number; weight: number }> {
  if (b <= a) return [{ i: Math.ceil((a - f.start) / HOUR), weight: 1 }];
  const rows: Array<{ i: number; weight: number }> = [];
  const last = Math.ceil((b - f.start) / HOUR);
  for (let i = Math.floor((a - f.start) / HOUR) + 1; i <= last; i++) {
    const t = f.start + i * HOUR;
    rows.push({ i, weight: (Math.min(b, t) - Math.max(a, t - HOUR)) / HOUR });
  }
  return rows;
}

/** Filas "centradas" para lo que no se interpola (estado del cielo, día/noche): la de las 15:00 vale de 14:30 a 15:30. */
function centeredRows(f: Forecast, a: number, b: number): Array<{ i: number; weight: number }> {
  const index = (t: number) => clamp(Math.floor((t - f.start + HOUR / 2) / HOUR), 0, f.hours - 1);
  if (b <= a) return [{ i: index(a), weight: 1 }];
  const rows: Array<{ i: number; weight: number }> = [];
  for (let i = index(a); i <= index(b); i++) {
    const t = f.start + i * HOUR;
    const weight = (Math.min(b, t + HOUR / 2) - Math.max(a, t - HOUR / 2)) / HOUR;
    if (weight > 0) rows.push({ i, weight });
  }
  return rows;
}

function maxOf(series: Num[], rows: Array<{ i: number }>): number | null {
  let max: number | null = null;
  for (const { i } of rows) {
    const v = series[i];
    if (v != null && (max === null || v > max)) max = v;
  }
  return max;
}

/**
 * Clima de un tramo [start, end] (ms desde epoch). null si el tramo no entra entero en el pronóstico o
 * falta la temperatura.
 */
export function summarizeWindow(f: Forecast, start: number, end: number): WeatherSummary | null {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  if (start < f.start || end > forecastEnd(f)) return null;
  const temp = spanStats(f.hourly.temp, f, start, end);
  if (!temp) return null;

  const preceding = precedingRows(f, start, end);
  const centered = centeredRows(f, start, end);
  const track = spanStats(trackSeries(f), f, start, end);

  let precipMm: number | null = 0;
  for (const { i, weight } of preceding) {
    const mm = f.hourly.precip[i];
    if (mm == null) {
      precipMm = null;
      break;
    }
    // En un instante (start = end) no hay acumulado: se informa lo que cae en esa hora.
    precipMm += mm * weight;
  }

  let dayWeight = 0;
  let totalWeight = 0;
  for (const { i, weight } of centered) {
    const d = f.hourly.isDay[i];
    if (d == null) continue;
    totalWeight += weight;
    if (d >= 0.5) dayWeight += weight;
  }

  return {
    tempC: temp.mean,
    tempMinC: temp.min,
    tempMaxC: temp.max,
    apparentC: spanStats(f.hourly.apparent, f, start, end)?.mean ?? null,
    precipProb: maxOf(f.hourly.precipProb, preceding),
    precipMm,
    windKmh: spanStats(f.hourly.wind, f, start, end)?.mean ?? null,
    gustsKmh: maxOf(f.hourly.gusts, preceding),
    humidity: spanStats(f.hourly.humidity, f, start, end)?.mean ?? null,
    code: predominantCode(centered.map(({ i, weight }) => ({ code: f.hourly.code[i] ?? null, weight }))),
    isDay: totalWeight === 0 || dayWeight / totalWeight >= 0.5,
    trackC: track?.mean ?? null,
    trackMinC: track?.min ?? null,
    trackMaxC: track?.max ?? null,
  };
}

/** Clima de una sesión a partir de sus horarios ISO en UTC. */
export function sessionWeather(f: Forecast | null | undefined, startUtc: string, endUtc: string): WeatherSummary | null {
  return f ? summarizeWindow(f, Date.parse(startUtc), Date.parse(endUtc)) : null;
}

/** El bloque "current" se usa mientras tenga menos de 45 minutos; después se interpola la serie horaria. */
const CURRENT_MAX_AGE_MS = 45 * 60_000;

/** Clima "ahora" en el circuito: el bloque actual de Open-Meteo si es reciente; si no, la serie horaria. */
export function currentWeather(f: Forecast | null | undefined, now: string | number): WeatherSummary | null {
  if (!f) return null;
  const t = toMs(now);
  const base = summarizeWindow(f, t, t);
  const c = f.current;
  if (!c || c.temp === null || Math.abs(t - c.time) > CURRENT_MAX_AGE_MS) return base;

  const radiation = base ? valueAtEffectiveRadiation(f, t) : null;
  const windKmh = c.wind ?? base?.windKmh ?? null;
  const trackC = radiation !== null && windKmh !== null ? estimateTrackTemp({ airC: c.temp, radiation, windKmh }) : (base?.trackC ?? null);
  return {
    tempC: c.temp,
    tempMinC: c.temp,
    tempMaxC: c.temp,
    apparentC: c.apparent ?? base?.apparentC ?? null,
    precipProb: base?.precipProb ?? null,
    precipMm: c.precip ?? base?.precipMm ?? null,
    windKmh,
    gustsKmh: c.gusts ?? base?.gustsKmh ?? null,
    humidity: c.humidity ?? base?.humidity ?? null,
    code: c.code ?? base?.code ?? null,
    isDay: c.isDay === null ? (base?.isDay ?? true) : c.isDay >= 0.5,
    trackC,
    trackMinC: trackC,
    trackMaxC: trackC,
  };
}

function valueAtEffectiveRadiation(f: Forecast, t: number): number | null {
  const x = (t - f.start) / HOUR;
  const i = Math.floor(x);
  const a = effectiveRadiation(f.hourly.radiation, i);
  if (a === null) return null;
  const frac = x - i;
  if (frac === 0) return a;
  const b = effectiveRadiation(f.hourly.radiation, i + 1);
  return b === null ? null : a + (b - a) * frac;
}

// ---------------------------------------------------------------------------
// Pronóstico por día (en la zona horaria del circuito)
// ---------------------------------------------------------------------------

export interface DayForecast {
  /** Fecha local del circuito, YYYY-MM-DD. */
  date: string;
  /** Horas con dato de ese día (un día entero tiene 24; menos = el borde del pronóstico). */
  hours: number;
  maxC: number;
  minC: number;
  /** Probabilidad de precipitación más alta del día, %. */
  precipProb: number | null;
  /** Precipitación acumulada, mm. */
  precipMm: number | null;
  /** Ráfaga máxima, km/h. */
  gustsKmh: number | null;
  /** Estado del cielo predominante de las horas de luz (código WMO). */
  code: number | null;
  /** Máxima de la temperatura de pista estimada, °C. */
  trackMaxC: number | null;
}

function localIsoDate(ms: number, zone: string): string {
  const d = DateTime.fromMillis(ms, { zone });
  return (d.isValid ? d : DateTime.fromMillis(ms, { zone: 'utc' })).toISODate()!;
}

/** Máxima, mínima y lluvia de cada día del pronóstico, con los días cortados según la zona del circuito. */
export function dailyForecast(f: Forecast, zone: string): DayForecast[] {
  interface Acc extends DayForecast {
    daySamples: Array<{ code: number | null; weight: number }>;
    allSamples: Array<{ code: number | null; weight: number }>;
  }
  const days = new Map<string, Acc>();
  const dayOf = (date: string): Acc => {
    let d = days.get(date);
    if (!d) {
      d = { date, hours: 0, maxC: -Infinity, minC: Infinity, precipProb: null, precipMm: null, gustsKmh: null, code: null, trackMaxC: null, daySamples: [], allSamples: [] };
      days.set(date, d);
    }
    return d;
  };
  const track = trackSeries(f);
  const higher = (a: number | null, b: Num | undefined): number | null => (b == null ? a : a === null ? b : Math.max(a, b));

  for (let i = 0; i < f.hours; i++) {
    const t = f.start + i * HOUR;
    const temp = f.hourly.temp[i];
    if (temp != null) {
      const d = dayOf(localIsoDate(t, zone));
      d.hours++;
      d.maxC = Math.max(d.maxC, temp);
      d.minC = Math.min(d.minC, temp);
      d.trackMaxC = higher(d.trackMaxC, track[i]);
      const sample = { code: f.hourly.code[i] ?? null, weight: 1 };
      d.allSamples.push(sample);
      if ((f.hourly.isDay[i] ?? 0) >= 0.5) d.daySamples.push(sample);
    }
    // Lluvia, probabilidad y ráfagas son de la hora anterior: la fila de las 00:00 pertenece al día que termina.
    const p = days.get(localIsoDate(t - HOUR / 2, zone));
    if (p) {
      p.precipProb = higher(p.precipProb, f.hourly.precipProb[i]);
      p.gustsKmh = higher(p.gustsKmh, f.hourly.gusts[i]);
      const mm = f.hourly.precip[i];
      if (mm != null) p.precipMm = (p.precipMm ?? 0) + mm;
    }
  }

  return [...days.values()]
    .filter((d) => d.hours > 0)
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(({ daySamples, allSamples, ...d }) => ({ ...d, code: predominantCode(daySamples.length ? daySamples : allSamples) }));
}

// ---------------------------------------------------------------------------
// Textos
// ---------------------------------------------------------------------------

/** Un dato del clima para mostrar en una celda (WeatherStats.vue). */
export interface WeatherStat {
  label: string;
  value: string;
  /** Aclaración chica al lado del valor ("ráfagas 45"). */
  extra?: string;
  /** Valor de data-test (para las pruebas). */
  test?: string;
}

/** "18°" (sin decimales: el pronóstico no da para más). */
export function formatTemp(celsius: number | null | undefined): string {
  if (celsius == null || !Number.isFinite(celsius)) return '—';
  return `${Math.round(celsius) + 0}°`;
}

/** Probabilidad de lluvia redondeada, o null si no llega al mínimo que se muestra (20 %). */
export function rainChance(summary: { precipProb: number | null } | null | undefined, min = 20): number | null {
  const p = summary?.precipProb;
  if (p == null) return null;
  const rounded = Math.round(p);
  return rounded >= min ? rounded : null;
}

/** "1,2 mm"; cantidades ínfimas como "menos de 0,1 mm". */
export function formatMm(mm: number | null | undefined): string {
  if (mm == null || !Number.isFinite(mm)) return '';
  if (mm > 0 && mm < 0.05) return 'menos de 0,1 mm';
  return `${(Math.round(mm * 10) / 10).toLocaleString('es-AR', { maximumFractionDigits: 1 })} mm`;
}
