/** Datos de prueba del clima: una respuesta de Open-Meteo armada a mano (misma forma que la real). */

export const H = 3_600_000;
/** Primera hora de la serie por defecto. */
export const START = Date.parse('2026-11-10T00:00:00Z');

type Value = number | null;
/** Valor de una variable según el índice de la hora y la hora del día (UTC). */
type Gen = (i: number, hourOfDay: number) => Value;

export interface OpenMeteoOptions {
  hours?: number;
  start?: number;
  /** Instante del bloque "current" (por defecto, 10:30 del primer día). */
  currentAt?: number;
  /** Reemplazos por variable de Open-Meteo ("temperature_2m", "precipitation"…). */
  hourly?: Record<string, Gen>;
  current?: Record<string, Value>;
}

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16);

/**
 * Respuesta de https://api.open-meteo.com/v1/forecast con timezone=UTC. Por defecto: 10 °C a medianoche que
 * suben medio grado por hora, parcialmente nublado, sin lluvia, viento de 12 km/h y sol de 7 a 17 UTC.
 */
export function openMeteoResponse(opts: OpenMeteoOptions = {}) {
  const hours = opts.hours ?? 432;
  const start = opts.start ?? START;
  const time = Array.from({ length: hours }, (_, i) => iso(start + i * H));
  const sun = (h: number) => h >= 7 && h <= 17;
  const defaults: Record<string, Gen> = {
    temperature_2m: (_i, h) => 10 + h / 2,
    apparent_temperature: (_i, h) => 9 + h / 2,
    precipitation_probability: () => 10,
    precipitation: () => 0,
    weather_code: () => 2,
    wind_speed_10m: () => 12,
    wind_gusts_10m: () => 25,
    relative_humidity_2m: () => 70,
    cloud_cover: () => 50,
    shortwave_radiation: (_i, h) => (sun(h) ? 600 : 0),
    is_day: (_i, h) => (sun(h) ? 1 : 0),
  };
  const hourly: Record<string, Value[]> & { time: string[] } = { time } as Record<string, Value[]> & { time: string[] };
  for (const [name, gen] of Object.entries({ ...defaults, ...opts.hourly })) {
    hourly[name] = time.map((_, i) => gen(i, new Date(start + i * H).getUTCHours()));
  }
  return {
    latitude: 43.25,
    longitude: 5.79,
    utc_offset_seconds: 0,
    timezone: 'GMT',
    current: {
      time: iso(opts.currentAt ?? start + 10.5 * H),
      interval: 900,
      temperature_2m: 13.1,
      apparent_temperature: 12.7,
      precipitation: 0,
      weather_code: 3,
      wind_speed_10m: 8,
      wind_gusts_10m: 20.9,
      relative_humidity_2m: 96,
      cloud_cover: 100,
      shortwave_radiation: 0,
      is_day: 0,
      ...opts.current,
    } as Record<string, Value | string>,
    hourly,
  };
}

/** `fetch` de mentira: Open-Meteo responde con `body`; cualquier otra dirección, 404. Devuelve también las URL pedidas. */
export function stubWeatherFetch(body: unknown = openMeteoResponse()) {
  const urls: string[] = [];
  const fetchFn = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    if (!url.startsWith('https://api.open-meteo.com/')) return new Response('no', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { fetchFn, urls, weatherCalls: () => urls.filter((u) => u.startsWith('https://api.open-meteo.com/')) };
}
