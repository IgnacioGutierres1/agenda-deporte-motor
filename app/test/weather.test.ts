import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FORECAST_DAYS,
  PAST_DAYS,
  TRACK_MODEL,
  WEATHER_STALE_MS,
  WEATHER_TTL_MS,
  circuitCoords,
  clearWeatherCache,
  currentWeather,
  dailyForecast,
  describeWeather,
  effectiveRadiation,
  estimateTrackTemp,
  forecastEnd,
  forecastReach,
  forecastUrl,
  formatMm,
  formatTemp,
  getForecast,
  parseForecast,
  predominantCode,
  rainChance,
  sessionWeather,
  summarizeWindow,
  trackSeries,
  validCoords,
  weatherKey,
  withinReach,
  type Forecast,
  type HourlySeries,
} from '../src/lib/weather.ts';
import { H, START, openMeteoResponse } from './weather-helpers.ts';

type Gen = (i: number) => number | null;

/** Pronóstico sintético: cada variable sale de una función de la hora (0 si no se indica). */
function forecast(hours: number, gen: Partial<Record<keyof HourlySeries, Gen>> = {}): Forecast {
  const series = (f?: Gen) => Array.from({ length: hours }, (_, i) => (f ? f(i) : 0));
  const hourly = {} as HourlySeries;
  for (const k of ['temp', 'apparent', 'precipProb', 'precip', 'code', 'wind', 'gusts', 'humidity', 'cloud', 'radiation', 'isDay'] as const) {
    hourly[k] = series(gen[k]);
  }
  return { v: 1, lat: 0, lon: 0, fetchedAt: START, start: START, hours, hourly, current: null };
}

const at = (hours: number) => START + hours * H;

describe('coordenadas, clave y URL', () => {
  it('la clave redondea a 2 decimales (≈ 1 km) y no deja "-0.00"', () => {
    expect(weatherKey(43.2506, 5.7917)).toBe('43.25,5.79');
    expect(weatherKey(-34.6037, -58.3816)).toBe('-34.60,-58.38');
    expect(weatherKey(-0.001, 0.004)).toBe('0.00,0.00');
    // Dos puntos del mismo circuito comparten pronóstico.
    expect(weatherKey(43.2512, 5.7889)).toBe(weatherKey(43.2506, 5.7917));
  });

  it('la URL lleva solo las coordenadas redondeadas y las variables pedidas, en UTC', () => {
    const url = new URL(forecastUrl(43.2506, 5.7917));
    expect(url.origin + url.pathname).toBe('https://api.open-meteo.com/v1/forecast');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      latitude: '43.25',
      longitude: '5.79',
      hourly:
        'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m,cloud_cover,shortwave_radiation,is_day',
      current:
        'temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,relative_humidity_2m,cloud_cover,shortwave_radiation,is_day',
      timezone: 'UTC',
      forecast_days: String(FORECAST_DAYS),
      past_days: String(PAST_DAYS),
    });
  });

  it('valida coordenadas y las saca de la ficha del circuito', () => {
    expect(validCoords(43.25, 5.79)).toBe(true);
    expect(validCoords(0, 0)).toBe(true);
    expect(validCoords(91, 0)).toBe(false);
    expect(validCoords(10, 181)).toBe(false);
    expect(validCoords(NaN, 5)).toBe(false);
    expect(validCoords(undefined, 5)).toBe(false);

    expect(circuitCoords({ lat: 43.25, lon: 5.79 })).toEqual({ lat: 43.25, lon: 5.79, approx: false });
    // Coordenadas de la ciudad: sirven, pero se avisa "clima de la zona".
    expect(circuitCoords({ lat: -33.33, lon: -60.21, coordsApprox: true })).toEqual({ lat: -33.33, lon: -60.21, approx: true });
    expect(circuitCoords({ lat: 43.25 })).toBeNull();
    expect(circuitCoords({})).toBeNull();
    expect(circuitCoords(undefined)).toBeNull();
  });
});

describe('parseForecast', () => {
  it('lee la serie horaria en UTC y el bloque actual', () => {
    const f = parseForecast(openMeteoResponse({ hours: 48 }), 43.2506, 5.7917, 123)!;
    expect(f).toMatchObject({ v: 1, lat: 43.25, lon: 5.79, fetchedAt: 123, start: START, hours: 48 });
    expect(forecastEnd(f)).toBe(at(47));
    expect(f.hourly.temp).toHaveLength(48);
    expect(f.hourly.temp[0]).toBe(10);
    expect(f.hourly.radiation[12]).toBe(600);
    expect(f.current).toMatchObject({ time: at(10.5), temp: 13.1, apparent: 12.7, code: 3, wind: 8, gusts: 20.9, humidity: 96, isDay: 0 });
  });

  it('una variable que falta queda en null; sin temperatura o con huecos de hora no hay pronóstico', () => {
    const raw = openMeteoResponse({ hours: 24 });
    delete (raw.hourly as Record<string, unknown>).wind_gusts_10m;
    (raw.hourly.precipitation_probability as Array<number | null>)[3] = null;
    const f = parseForecast(raw, 1, 2, 0)!;
    expect(f.hourly.gusts.every((g) => g === null)).toBe(true);
    expect(f.hourly.precipProb[3]).toBeNull();
    expect(f.hourly.precipProb[4]).toBe(10);

    const gap = openMeteoResponse({ hours: 24 });
    gap.hourly.time[5] = '2026-11-10T07:00';
    expect(parseForecast(gap, 1, 2, 0)).toBeNull();

    const noTemp = openMeteoResponse({ hours: 24 });
    (noTemp.hourly as Record<string, unknown>).temperature_2m = undefined;
    expect(parseForecast(noTemp, 1, 2, 0)).toBeNull();

    for (const junk of [null, 'x', 42, {}, { hourly: {} }, { hourly: { time: ['ayer'] } }, { error: true, reason: 'x' }]) {
      expect(parseForecast(junk, 1, 2, 0)).toBeNull();
    }
  });
});

describe('códigos WMO', () => {
  it('texto en español e ícono', () => {
    expect(describeWeather(0)).toEqual({ text: 'Despejado', icon: 'despejado' });
    expect(describeWeather(2)).toEqual({ text: 'Parcialmente nublado', icon: 'algo-nublado' });
    expect(describeWeather(3)).toEqual({ text: 'Nublado', icon: 'nublado' });
    expect(describeWeather(45).icon).toBe('niebla');
    expect(describeWeather(53)).toEqual({ text: 'Llovizna', icon: 'llovizna' });
    expect(describeWeather(61)).toEqual({ text: 'Lluvia débil', icon: 'lluvia' });
    expect(describeWeather(65)).toEqual({ text: 'Lluvia fuerte', icon: 'lluvia-fuerte' });
    expect(describeWeather(67).icon).toBe('aguanieve');
    expect(describeWeather(73)).toEqual({ text: 'Nevada', icon: 'nieve' });
    expect(describeWeather(81)).toEqual({ text: 'Chaparrones', icon: 'chaparrones' });
    expect(describeWeather(95)).toEqual({ text: 'Tormenta', icon: 'tormenta' });
    expect(describeWeather(99).icon).toBe('tormenta');
  });

  it('de noche cambian el sol y el sol con nubes; lo demás queda igual', () => {
    expect(describeWeather(0, false).icon).toBe('despejado-noche');
    expect(describeWeather(1, false)).toEqual({ text: 'Mayormente despejado', icon: 'despejado-noche' });
    expect(describeWeather(2, false).icon).toBe('algo-nublado-noche');
    expect(describeWeather(3, false).icon).toBe('nublado');
    expect(describeWeather(63, false).icon).toBe('lluvia');
  });

  it('un código desconocido o ausente no rompe', () => {
    expect(describeWeather(null)).toEqual({ text: 'Sin dato del cielo', icon: 'nublado' });
    expect(describeWeather(undefined).icon).toBe('nublado');
    expect(describeWeather(12345).icon).toBe('nublado');
  });

  it('estado predominante: el que más dura, salvo que llueva 30 % del tramo o más', () => {
    const s = (code: number | null, weight = 1) => ({ code, weight });
    expect(predominantCode([s(0), s(0), s(3)])).toBe(0);
    // Empate: el más severo.
    expect(predominantCode([s(1), s(3)])).toBe(3);
    // 1 de 4 horas con lluvia: sigue "nublado" (la probabilidad se informa aparte).
    expect(predominantCode([s(3), s(3), s(2), s(61)])).toBe(3);
    // 2 de 5: ya es una sesión con lluvia; gana la precipitación más frecuente.
    expect(predominantCode([s(3), s(3), s(3), s(61), s(61)])).toBe(61);
    expect(predominantCode([s(3), s(61), s(95, 0.5), s(61, 0.2)])).toBe(61);
    // Los pesos cuentan (media hora de tormenta contra hora y media de lluvia débil).
    expect(predominantCode([s(95, 0.5), s(61, 1.5)])).toBe(61);
    expect(predominantCode([s(null), s(2, 0)])).toBeNull();
    expect(predominantCode([])).toBeNull();
  });
});

describe('resumen de una sesión', () => {
  const f = forecast(48, {
    temp: (i) => 10 + i,
    apparent: (i) => 8 + i,
    wind: (i) => 2 * i,
    humidity: () => 60,
    // Lluvia "de la hora anterior": los 2 mm de la fila 3 cayeron entre la hora 2 y la 3.
    precip: (i) => (i === 3 ? 2 : i === 4 ? 4 : 0),
    precipProb: (i) => (i === 3 ? 30 : i === 4 ? 80 : i === 5 ? 10 : 0),
    gusts: (i) => (i === 3 ? 25 : i === 4 ? 55 : 5),
    code: (i) => (i === 2 ? 3 : i === 3 || i === 4 ? 61 : 0),
    isDay: (i) => (i % 24 >= 6 && i % 24 <= 17 ? 1 : 0),
  });

  it('temperatura, sensación, viento y humedad: media ponderada por tiempo, con extremos', () => {
    const s = summarizeWindow(f, at(2), at(4))!;
    expect(s.tempC).toBeCloseTo(13, 6);
    expect(s.tempMinC).toBe(12);
    expect(s.tempMaxC).toBe(14);
    expect(s.apparentC).toBeCloseTo(11, 6);
    expect(s.windKmh).toBeCloseTo(6, 6);
    expect(s.humidity).toBe(60);
  });

  it('una sesión corta entre dos horas se interpola', () => {
    const s = summarizeWindow(f, at(2.5), at(3))!;
    expect(s.tempC).toBeCloseTo(12.75, 6);
    expect(s.tempMinC).toBeCloseTo(12.5, 6);
    expect(s.tempMaxC).toBe(13);
    expect(summarizeWindow(f, at(2.25), at(2.25))!.tempC).toBeCloseTo(12.25, 6);
  });

  it('lluvia: mm proporcionales a la parte de cada hora que cae en la sesión; probabilidad y ráfagas, las máximas', () => {
    // De 2:30 a 3:30 → media hora de la fila 3 (2 mm) y media de la fila 4 (4 mm).
    const s = summarizeWindow(f, at(2.5), at(3.5))!;
    expect(s.precipMm).toBeCloseTo(3, 6);
    expect(s.precipProb).toBe(80);
    expect(s.gustsKmh).toBe(55);
    // De 2:00 a 3:00 es exactamente la fila 3.
    const exact = summarizeWindow(f, at(2), at(3))!;
    expect(exact.precipMm).toBeCloseTo(2, 6);
    expect(exact.precipProb).toBe(30);
    expect(exact.gustsKmh).toBe(25);
    // Antes de la lluvia.
    expect(summarizeWindow(f, at(0), at(2))!.precipMm).toBe(0);
  });

  it('estado del cielo predominante y día/noche', () => {
    expect(summarizeWindow(f, at(2), at(4))!.code).toBe(61);
    // 8 horas con 2 de lluvia (25 %): predomina el cielo despejado.
    expect(summarizeWindow(f, at(0), at(8))!.code).toBe(0);
    expect(summarizeWindow(f, at(1), at(3))!.isDay).toBe(false);
    expect(summarizeWindow(f, at(10), at(12))!.isDay).toBe(true);
    expect(summarizeWindow(f, at(20), at(22))!.isDay).toBe(false);
  });

  it('fuera del pronóstico (o con horarios inválidos) no hay resumen', () => {
    expect(summarizeWindow(f, at(-1), at(2))).toBeNull();
    expect(summarizeWindow(f, at(46), at(48))).toBeNull();
    expect(summarizeWindow(f, at(46), at(47))).not.toBeNull();
    expect(summarizeWindow(f, at(5), at(4))).toBeNull();
    expect(summarizeWindow(f, NaN, at(4))).toBeNull();
  });

  it('una variable sin dato queda en null sin tapar al resto', () => {
    const partial = forecast(24, { temp: () => 20, humidity: (i) => (i === 3 ? null : 50), precipProb: () => null, precip: () => null });
    const s = summarizeWindow(partial, at(2), at(4))!;
    expect(s.tempC).toBe(20);
    expect(s.humidity).toBeNull();
    expect(s.precipProb).toBeNull();
    expect(s.precipMm).toBeNull();
    // Sin temperatura no hay nada que mostrar.
    expect(summarizeWindow(forecast(24, { temp: (i) => (i === 3 ? null : 20) }), at(2), at(4))).toBeNull();
  });

  it('sessionWeather recibe los horarios ISO de la sesión', () => {
    const s = sessionWeather(f, '2026-11-10T02:00:00Z', '2026-11-10T04:00:00Z')!;
    expect(s.tempC).toBeCloseTo(13, 6);
    expect(sessionWeather(null, '2026-11-10T02:00:00Z', '2026-11-10T04:00:00Z')).toBeNull();
    expect(sessionWeather(f, 'no es una fecha', '2026-11-10T04:00:00Z')).toBeNull();
  });
});

describe('pronóstico por día en la zona del circuito', () => {
  // START = 10/11 00:00 UTC = 9/11 21:00 en Buenos Aires (UTC−3). 72 horas: 3 del día 9, los días 10 y 11 enteros, 21 del 12.
  const localHour = (i: number) => (i + 21) % 24;
  const f = forecast(72, {
    temp: (i) => i,
    // La fila 27 es la medianoche local del 11: su lluvia cayó entre las 23 y las 24 del día 10.
    precip: (i) => (i === 27 ? 5 : i === 28 ? 1 : 0),
    precipProb: (i) => (i === 27 ? 90 : i === 28 ? 40 : 5),
    gusts: (i) => (i === 27 ? 70 : 20),
    isDay: (i) => (localHour(i) >= 6 && localHour(i) <= 19 ? 1 : 0),
    // Día 10: llueve de día y despeja de noche. Después, parcialmente nublado.
    code: (i) => (i >= 3 && i <= 26 ? (localHour(i) >= 6 && localHour(i) <= 19 ? 61 : 0) : 2),
  });

  it('corta los días según la zona horaria: máxima, mínima y horas con dato', () => {
    const days = dailyForecast(f, 'America/Argentina/Buenos_Aires');
    expect(days.map((d) => [d.date, d.hours])).toEqual([
      ['2026-11-09', 3],
      ['2026-11-10', 24],
      ['2026-11-11', 24],
      ['2026-11-12', 21],
    ]);
    expect(days[1]).toMatchObject({ minC: 3, maxC: 26 });
    expect(days[2]).toMatchObject({ minC: 27, maxC: 50 });
  });

  it('la lluvia y las ráfagas de la medianoche pertenecen al día que termina', () => {
    const days = dailyForecast(f, 'America/Argentina/Buenos_Aires');
    expect(days[1]).toMatchObject({ precipMm: 5, precipProb: 90, gustsKmh: 70 });
    expect(days[2]).toMatchObject({ precipMm: 1, precipProb: 40, gustsKmh: 20 });
  });

  it('el estado del día es el de las horas de luz', () => {
    const days = dailyForecast(f, 'America/Argentina/Buenos_Aires');
    expect(days[1]!.code).toBe(61);
    expect(days[2]!.code).toBe(2);
    // Sin horas de luz (noche polar) se usa todo el día.
    const dark = forecast(24, { code: () => 71, isDay: () => 0 });
    expect(dailyForecast(dark, 'UTC')[0]!.code).toBe(71);
  });

  it('en UTC los mismos datos caen en otros días; una zona inválida se trata como UTC', () => {
    const utc = dailyForecast(f, 'UTC');
    expect(utc.map((d) => [d.date, d.hours, d.minC, d.maxC])).toEqual([
      ['2026-11-10', 24, 0, 23],
      ['2026-11-11', 24, 24, 47],
      ['2026-11-12', 24, 48, 71],
    ]);
    expect(dailyForecast(f, 'Marte/Olympus')).toEqual(utc);
    // Zonas con media hora de diferencia (India, UTC+5:30).
    expect(dailyForecast(f, 'Asia/Kolkata').map((d) => [d.date, d.hours])).toEqual([
      ['2026-11-10', 19],
      ['2026-11-11', 24],
      ['2026-11-12', 24],
      ['2026-11-13', 5],
    ]);
  });

  it('incluye la máxima de pista estimada del día', () => {
    const sunny = forecast(48, { temp: () => 25, wind: () => 10, radiation: (i) => CLEAR_DAY[i % 24]! });
    const [, second] = dailyForecast(sunny, 'UTC');
    expect(second!.trackMaxC).toBeGreaterThan(44);
    expect(second!.trackMaxC).toBeLessThan(48);
  });
});

/**
 * Radiación de un día despejado de verano en latitudes medias (W/m², media de la hora anterior a cada hora
 * solar): pico de ~880 W/m² al mediodía y ~320 W/m² de promedio diario.
 */
const CLEAR_DAY = [0, 0, 0, 0, 0, 0, 40, 150, 300, 470, 620, 750, 840, 880, 870, 810, 700, 560, 400, 240, 90, 0, 0, 0];

describe('temperatura de pista estimada', () => {
  const sunny = (airC: number, windKmh: number, factor = 1) =>
    forecast(72, { temp: () => airC, wind: () => windKmh, radiation: (i) => CLEAR_DAY[i % 24]! * factor });
  const trackAt = (f: Forecast, hour: number) => trackSeries(f)[hour]!;

  it('la fórmula: aire + α·G / (h₀ + h_v·viento)', () => {
    expect(TRACK_MODEL).toMatchObject({ absorption: 0.9, baseLoss: 24, windLoss: 1, memory: 0.5, memoryHours: 6, storedShare: 0.4, storedHours: 24 });
    // 0,9 · 600 / (24 + 10 m/s) = 15,88 °C sobre el aire.
    expect(estimateTrackTemp({ airC: 20, radiation: 600, windKmh: 36 })).toBeCloseTo(20 + 540 / 34, 6);
    expect(estimateTrackTemp({ airC: 20, radiation: 600, windKmh: 0 })).toBeCloseTo(42.5, 6);
    expect(estimateTrackTemp({ airC: 12, radiation: 0, windKmh: 10 })).toBe(12);
  });

  it('caso conocido: día despejado de verano con 25–30 °C de aire → 45–55 °C de pista', () => {
    // 14:00 del segundo día, brisa de 10 km/h.
    const cool = trackAt(sunny(25, 10), 24 + 14);
    const hot = trackAt(sunny(30, 10), 24 + 14);
    expect(cool).toBeCloseTo(46.4, 1);
    expect(hot).toBeCloseTo(51.4, 1);
    for (const t of [cool, hot, trackAt(sunny(28, 5), 24 + 13), trackAt(sunny(28, 20), 24 + 15)]) {
      expect(t).toBeGreaterThanOrEqual(45);
      expect(t).toBeLessThanOrEqual(55);
    }
  });

  it('caso conocido: nublado → pocos grados sobre el aire', () => {
    // El mismo día con el 22 % de la radiación (cielo cubierto) y 18 °C.
    const rise = trackAt(sunny(18, 15, 0.22), 24 + 14) - 18;
    expect(rise).toBeGreaterThan(3);
    expect(rise).toBeLessThan(7);
    expect(rise).toBeCloseTo(4.5, 1);
  });

  it('de noche queda cerca del aire: solo el calor acumulado del día', () => {
    // 03:00 de la madrugada siguiente a un día despejado: unos grados (las carreras nocturnas de F1 miden +2 a +5).
    const night = trackAt(sunny(22, 5), 24 + 3) - 22;
    expect(night).toBeGreaterThan(2);
    expect(night).toBeLessThan(6);
    // Después de un día cubierto, casi nada; sin sol (noche polar), exactamente el aire.
    expect(trackAt(sunny(10, 5, 0.22), 24 + 3) - 10).toBeLessThan(1.5);
    expect(trackAt(sunny(-5, 5, 0), 24 + 3)).toBe(-5);
  });

  it('la pista se calienta más lento que el sol a la mañana y sigue tibia al atardecer', () => {
    const f = sunny(25, 10);
    const rise = (h: number) => trackAt(f, 24 + h) - 25;
    // La radiación de las 10 y de las 17 es parecida (620 y 560 W/m²), pero a la tarde la pista está más caliente.
    expect(rise(17)).toBeGreaterThan(rise(10));
    // El pico llega después del mediodía solar.
    const peak = [11, 12, 13, 14, 15, 16].reduce((a, b) => (rise(b) > rise(a) ? b : a));
    expect(peak).toBeGreaterThanOrEqual(13);
    // Una hora después de la puesta del sol todavía hay varios grados.
    expect(rise(21)).toBeGreaterThan(5);
  });

  it('el viento la enfría y los resultados quedan acotados', () => {
    expect(trackAt(sunny(28, 40), 24 + 14)).toBeLessThan(trackAt(sunny(28, 5), 24 + 14) - 4);
    // Como mucho 35 °C sobre el aire y entre −30 y 75 °C.
    expect(estimateTrackTemp({ airC: 30, radiation: 5000, windKmh: 0 })).toBe(65);
    expect(estimateTrackTemp({ airC: 48, radiation: 1100, windKmh: 0 })).toBe(75);
    expect(estimateTrackTemp({ airC: -45, radiation: 0, windKmh: 0 })).toBe(-30);
    // Datos imposibles (radiación o viento negativos) no enfrían la pista por debajo del aire.
    expect(estimateTrackTemp({ airC: 15, radiation: -50, windKmh: -10 })).toBe(15);
  });

  it('radiación efectiva: 60 % reciente (1/2, 1/4, 1/8…) + 40 % del promedio de 24 horas', () => {
    const steady = Array.from({ length: 48 }, () => 500);
    expect(effectiveRadiation(steady, 30)).toBeCloseTo(500, 6);
    // Un solo pulso de 800 W/m² en la última hora, con el resto en cero.
    const pulse = Array.from({ length: 48 }, (_, i) => (i === 30 ? 800 : 0));
    const recent = 800 / (1 + 0.5 + 0.25 + 0.125 + 0.0625 + 0.03125);
    expect(effectiveRadiation(pulse, 30)).toBeCloseTo(0.6 * recent + 0.4 * (800 / 24), 6);
    // Una hora después pesa la mitad.
    expect(effectiveRadiation(pulse, 31)).toBeCloseTo(0.6 * (recent / 2) + 0.4 * (800 / 24), 6);
    expect(effectiveRadiation([null, 100], 0)).toBeNull();
    expect(effectiveRadiation([100, null], 1)).toBeNull();
  });

  it('sin 24 horas de historia usa el promedio del primer día de la serie', () => {
    const series = Array.from({ length: 72 }, (_, i) => CLEAR_DAY[i % 24]!);
    // Mismo momento del día, con y sin historia completa: da lo mismo.
    expect(effectiveRadiation(series, 14)).toBeCloseTo(effectiveRadiation(series, 24 + 14)!, 6);
    expect(effectiveRadiation(series, 3)).toBeCloseTo(effectiveRadiation(series, 24 + 3)!, 0);
  });

  it('el resumen de una sesión trae la pista media y sus extremos', () => {
    const s = summarizeWindow(sunny(26, 10), at(24 + 12), at(24 + 14))!;
    expect(s.trackC).toBeGreaterThan(44);
    expect(s.trackC).toBeLessThan(49);
    expect(s.trackMinC!).toBeLessThanOrEqual(s.trackC!);
    expect(s.trackMaxC!).toBeGreaterThanOrEqual(s.trackC!);
    // Sin radiación (o sin viento) en el pronóstico no se estima nada.
    expect(summarizeWindow(forecast(24, { temp: () => 20, radiation: () => null }), at(2), at(4))!.trackC).toBeNull();
    expect(summarizeWindow(forecast(24, { temp: () => 20, wind: () => null }), at(2), at(4))!.trackC).toBeNull();
  });
});

describe('clima de ahora', () => {
  const f: Forecast = {
    ...forecast(48, { temp: (i) => 10 + i, wind: () => 10, humidity: () => 50, precipProb: (i) => (i === 11 ? 70 : 0), radiation: (i) => CLEAR_DAY[i % 24]! }),
    current: { time: at(10.5), temp: 15.3, apparent: 14.1, precip: 0.2, code: 61, wind: 22, gusts: 40, humidity: 88, cloud: 100, radiation: 300, isDay: 1 },
  };

  it('usa el bloque actual de Open-Meteo mientras es reciente', () => {
    const now = currentWeather(f, at(10.75))!;
    expect(now).toMatchObject({ tempC: 15.3, apparentC: 14.1, windKmh: 22, gustsKmh: 40, humidity: 88, code: 61, isDay: true, precipMm: 0.2 });
    // La probabilidad de lluvia no viene en el bloque actual: sale de la hora en curso.
    expect(now.precipProb).toBe(70);
    // Pista: aire y viento actuales con la radiación efectiva de la serie.
    expect(now.trackC).toBeGreaterThan(15.3 + 10);
    expect(now.trackC).toBeLessThan(15.3 + 25);
  });

  it('pasados 45 minutos interpola la serie horaria', () => {
    const later = currentWeather(f, at(12.5))!;
    expect(later.tempC).toBeCloseTo(22.5, 6);
    expect(later.windKmh).toBe(10);
    expect(later.humidity).toBe(50);
    expect(currentWeather(f, new Date(at(12.5)).toISOString())!.tempC).toBeCloseTo(22.5, 6);
  });

  it('sin pronóstico o fuera de su alcance no hay "ahora"', () => {
    expect(currentWeather(null, at(3))).toBeNull();
    expect(currentWeather({ ...f, current: null }, at(100))).toBeNull();
  });
});

describe('alcance del pronóstico', () => {
  it('desde 2 días (UTC) atrás hasta el final del día 16', () => {
    const reach = forecastReach('2026-11-12T23:30:00Z');
    expect(new Date(reach.from).toISOString()).toBe('2026-11-10T00:00:00.000Z');
    expect(new Date(reach.to).toISOString()).toBe('2026-11-27T23:00:00.000Z');
  });

  it('decide si una sesión entra, sin pedir nada', () => {
    const now = '2026-11-12T23:30:00Z';
    expect(withinReach('2026-11-14T13:00:00Z', '2026-11-14T14:00:00Z', now)).toBe(true);
    expect(withinReach('2026-11-10T09:00:00Z', '2026-11-10T10:00:00Z', now)).toBe(true);
    expect(withinReach('2026-11-09T23:00:00Z', '2026-11-10T01:00:00Z', now)).toBe(false);
    expect(withinReach('2026-11-27T22:00:00Z', '2026-11-27T23:00:00Z', now)).toBe(true);
    expect(withinReach('2026-11-27T22:00:00Z', '2026-11-28T00:30:00Z', now)).toBe(false);
    expect(withinReach('2027-02-14T18:00:00Z', '2027-02-14T22:00:00Z', now)).toBe(false);
    expect(withinReach('x', 'y', now)).toBe(false);
  });
});

describe('textos', () => {
  it('temperatura sin decimales', () => {
    expect(formatTemp(18.4)).toBe('18°');
    expect(formatTemp(18.5)).toBe('19°');
    expect(formatTemp(-0.3)).toBe('0°');
    expect(formatTemp(-3.6)).toBe('-4°');
    expect(formatTemp(null)).toBe('—');
    expect(formatTemp(undefined)).toBe('—');
  });

  it('la probabilidad de lluvia se muestra desde 20 %', () => {
    expect(rainChance({ precipProb: 19.4 })).toBeNull();
    expect(rainChance({ precipProb: 19.6 })).toBe(20);
    expect(rainChance({ precipProb: 85 })).toBe(85);
    expect(rainChance({ precipProb: null })).toBeNull();
    expect(rainChance(null)).toBeNull();
    expect(rainChance({ precipProb: 5 }, 0)).toBe(5);
  });

  it('milímetros con coma decimal', () => {
    expect(formatMm(1.24)).toBe('1,2 mm');
    expect(formatMm(12)).toBe('12 mm');
    expect(formatMm(0)).toBe('0 mm');
    expect(formatMm(0.02)).toBe('menos de 0,1 mm');
    expect(formatMm(null)).toBe('');
  });
});

describe('cliente con caché', () => {
  const ok = () => new Response(JSON.stringify(openMeteoResponse({ hours: 48 })), { status: 200, headers: { 'content-type': 'application/json' } });
  const okFetch = () => vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => ok());
  const storedKeys = () => Array.from({ length: window.localStorage.length }, (_, i) => window.localStorage.key(i)!);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
    window.localStorage.clear();
    clearWeatherCache();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('pide a Open-Meteo solo las coordenadas, sin credenciales ni referer', async () => {
    const fetchFn = okFetch();
    const f = await getForecast(43.2506, 5.7917, { fetchFn });
    expect(f).toMatchObject({ lat: 43.25, lon: 5.79, hours: 48, fetchedAt: Date.parse('2026-11-12T12:00:00Z') });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(String(url)).toBe(forecastUrl(43.2506, 5.7917));
    expect(init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer' });
    expect(init!.headers).toBeUndefined();
    expect(init!.body).toBeUndefined();
  });

  it('caché en memoria: dentro de la hora no vuelve a pedir; después sí', async () => {
    const fetchFn = okFetch();
    const first = await getForecast(43.25, 5.79, { fetchFn });
    vi.setSystemTime(Date.now() + WEATHER_TTL_MS - 1000);
    expect(await getForecast(43.25, 5.79, { fetchFn })).toBe(first);
    // Otro punto del mismo circuito (misma clave) también usa la copia.
    expect(await getForecast(43.2512, 5.7889, { fetchFn })).toBe(first);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 2000);
    const second = await getForecast(43.25, 5.79, { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(second).not.toBe(first);
    expect(second!.fetchedAt).toBe(Date.now());
  });

  it('caché en localStorage: otra sesión de la app la aprovecha', async () => {
    const fetchFn = okFetch();
    await getForecast(43.25, 5.79, { fetchFn });
    expect(window.localStorage.getItem('dm:weather:43.25,5.79')).toBeTruthy();

    // Módulo recién cargado = app recién abierta (memoria vacía, mismo localStorage).
    vi.resetModules();
    const fresh = await import('../src/lib/weather.ts');
    const again = await fresh.getForecast(43.25, 5.79, { fetchFn });
    expect(again).toMatchObject({ lat: 43.25, lon: 5.79, hours: 48 });
    expect(fetchFn).toHaveBeenCalledTimes(1);

    // Vencida la hora, se vuelve a pedir.
    vi.setSystemTime(Date.now() + WEATHER_TTL_MS + 1000);
    await fresh.getForecast(43.25, 5.79, { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('los pedidos simultáneos del mismo punto comparten una sola descarga', async () => {
    const releases: Array<(r: Response) => void> = [];
    const fetchFn = vi.fn(() => new Promise<Response>((resolve) => releases.push(resolve)));
    const a = getForecast(43.25, 5.79, { fetchFn });
    const b = getForecast(43.25, 5.79, { fetchFn });
    const other = getForecast(35.37, 138.93, { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    releases[0]!(ok());
    const [fa, fb] = await Promise.all([a, b]);
    expect(fa).toBe(fb);
    expect(fa).not.toBeNull();
    // El otro punto sigue esperando su propia descarga.
    await vi.advanceTimersByTimeAsync(20_000);
    expect(await other).toBeNull();
  });

  it('timeout: si Open-Meteo no responde, corta el pedido y sigue sin clima', async () => {
    let signal: AbortSignal | undefined;
    const fetchFn = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => undefined);
    });
    const pending = getForecast(43.25, 5.79, { fetchFn, timeoutMs: 5000 });
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await pending).toBeNull();
    expect(signal?.aborted).toBe(true);
    // El siguiente intento vuelve a pedir (no queda un pedido colgado).
    expect(await getForecast(43.25, 5.79, { fetchFn: okFetch() })).not.toBeNull();
  });

  it('nunca tira un error: sin conexión, respuesta rota o coordenadas inválidas → null', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(getForecast(43.25, 5.79, { fetchFn: offline })).resolves.toBeNull();
    await expect(getForecast(43.25, 5.79, { fetchFn: vi.fn(async () => new Response('x', { status: 500 })) })).resolves.toBeNull();
    await expect(getForecast(43.25, 5.79, { fetchFn: vi.fn(async () => new Response('<html>', { status: 200 })) })).resolves.toBeNull();
    await expect(getForecast(43.25, 5.79, { fetchFn: vi.fn(async () => new Response('{"error":true}', { status: 200 })) })).resolves.toBeNull();
    const sync = vi.fn(() => {
      throw new Error('fetch bloqueado');
    });
    await expect(getForecast(43.25, 5.79, { fetchFn: sync as unknown as typeof fetch })).resolves.toBeNull();

    const never = okFetch();
    await expect(getForecast(NaN, 5.79, { fetchFn: never })).resolves.toBeNull();
    await expect(getForecast(120, 5.79, { fetchFn: never })).resolves.toBeNull();
    await expect(getForecast(undefined as unknown as number, 5.79, { fetchFn: never })).resolves.toBeNull();
    expect(never).not.toHaveBeenCalled();
  });

  it('sin conexión usa la última copia de hasta 12 horas; más vieja, nada', async () => {
    const first = await getForecast(43.25, 5.79, { fetchFn: okFetch() });
    const offline = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    vi.setSystemTime(Date.now() + 3 * H);
    expect(await getForecast(43.25, 5.79, { fetchFn: offline })).toBe(first);
    expect(offline).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + WEATHER_STALE_MS);
    expect(await getForecast(43.25, 5.79, { fetchFn: offline })).toBeNull();
  });

  it('guarda como mucho 10 circuitos y borra los pronósticos vencidos', async () => {
    const fetchFn = okFetch();
    for (let i = 0; i < 12; i++) {
      await getForecast(10 + i, 20, { fetchFn });
      vi.setSystemTime(Date.now() + 60_000);
    }
    const keys = () => storedKeys().filter((k) => k.startsWith('dm:weather:'));
    expect(keys()).toHaveLength(10);
    // Quedan los más nuevos.
    expect(keys()).not.toContain('dm:weather:10.00,20.00');
    expect(keys()).not.toContain('dm:weather:11.00,20.00');
    expect(keys()).toContain('dm:weather:21.00,20.00');

    vi.setSystemTime(Date.now() + WEATHER_STALE_MS + 60_000);
    await getForecast(50, 20, { fetchFn });
    expect(keys()).toEqual(['dm:weather:50.00,20.00']);
  });

  it('con el almacenamiento bloqueado o con basura guardada sigue funcionando', async () => {
    window.localStorage.setItem('dm:weather:43.25,5.79', '{"v":1,"hourly":"roto"');
    window.localStorage.setItem('dm:weather:1.00,1.00', 'no es json');
    const fetchFn = okFetch();
    expect(await getForecast(43.25, 5.79, { fetchFn })).not.toBeNull();
    expect(fetchFn).toHaveBeenCalledTimes(1);

    clearWeatherCache();
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('QuotaExceededError');
    });
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('SecurityError');
    });
    const f = await getForecast(43.25, 5.79, { fetchFn });
    expect(f).not.toBeNull();
    // La copia en memoria alcanza para no volver a pedir.
    expect(await getForecast(43.25, 5.79, { fetchFn })).toBe(f);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    setItem.mockRestore();
    getItem.mockRestore();
  });

  it('clearWeatherCache borra memoria y localStorage (al apagar "Mostrar clima")', async () => {
    const fetchFn = okFetch();
    await getForecast(43.25, 5.79, { fetchFn });
    window.localStorage.setItem('dm:settings', '{}');
    clearWeatherCache();
    expect(storedKeys()).toEqual(['dm:settings']);
    await getForecast(43.25, 5.79, { fetchFn });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
