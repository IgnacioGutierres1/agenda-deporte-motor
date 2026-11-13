/**
 * Clima medido en pista durante las sesiones de Fórmula 1, leído de OpenF1 (https://openf1.org).
 *
 * Por qué OpenF1 y no una fuente de formula1.com:
 *  - formula1.com no publica las condiciones en sus páginas de resultados.
 *  - El archivo estático oficial del live timing (https://livetiming.formula1.com/static/{año}/…/WeatherData.jsonStream)
 *    responde 401 a un cliente sin cuenta, también para temporadas viejas (verificado el 12/11/2026): pide cuenta,
 *    así que no se usa ni se rodea.
 *  - OpenF1 es un proyecto abierto (CC BY-NC-SA 4.0, uso personal y no comercial) que guarda las muestras de la
 *    estación meteorológica del live timing de la F1, una por minuto. Los datos históricos son gratis y sin cuenta;
 *    los datos EN VIVO son pagos, y por eso acá solo se pide después de la sesión, cuando ya hay resultado. No es
 *    un sitio oficial de la F1: por eso las condiciones llevan su propia fuente (`conditions.source`).
 *
 * Pedidos (límite gratuito: 3 por segundo y 30 por minuto; se piden de a uno):
 *   GET {API}/sessions?year={año}             → session_key, meeting_key e inicio (UTC) de cada sesión del año
 *   GET {API}/weather?meeting_key={meeting}   → muestras de todas las sesiones de ese fin de semana (~120 KB)
 *
 * Resumen por sesión: mediana de aire, asfalto, humedad y viento de las muestras desde el inicio programado hasta
 * que el feed deja de emitir (unos minutos después de la bandera a cuadros). Se usa la mediana y no el promedio
 * porque el sensor de asfalto tiene lecturas sueltas disparatadas (0 °C, saltos de 10 °C en un minuto). La lluvia
 * es un indicador sí/no por muestra: se resume como "Sin lluvia" (ninguna muestra), "Lluvia por momentos" (10 % o
 * más) o "Lluvia" (la mitad o más). OpenF1 no informa el estado de la pista ni la nubosidad: no se inventan.
 */
import type { Session, SessionConditions } from '@dm/shared';
import { sourceUnavailable } from '../core/conditions.ts';
import type { AdapterContext, ConditionsChunk } from '../core/types.ts';
import { directSource } from './util.ts';

export const OPENF1_API = 'https://api.openf1.org/v1';
/** Diferencia máxima entre nuestro inicio de sesión y el de OpenF1 para considerarlas la misma sesión. */
const MATCH_TOLERANCE_MS = 20 * 60_000;
/** Con menos muestras (minutos) que estas no se resume: la sesión casi no tuvo medición. */
const MIN_SAMPLES = 5;
/**
 * Proporción de muestras con lluvia a partir de la cual se informa "Lluvia por momentos" y "Lluvia". Por debajo del
 * 10 % (unas gotas, o lluvia que empezó cuando la sesión ya había terminado y el feed seguía emitiendo) no se
 * afirma nada: ni lluvia ni "Sin lluvia".
 */
const RAIN_SOME = 0.1;
const RAIN_MOST = 0.5;

export interface OpenF1Session {
  session_key: number;
  meeting_key: number;
  session_name?: string;
  date_start: string;
  is_cancelled?: boolean;
}

export interface OpenF1Weather {
  date: string;
  session_key: number;
  air_temperature?: number | null;
  track_temperature?: number | null;
  humidity?: number | null;
  /** 0 = sin lluvia; mayor que 0 = el sensor detecta lluvia. */
  rainfall?: number | null;
  /** m/s. */
  wind_speed?: number | null;
}

export function openF1SessionsUrl(year: number): string {
  return `${OPENF1_API}/sessions?year=${year}`;
}

export function openF1WeatherUrl(meetingKey: number): string {
  return `${OPENF1_API}/weather?meeting_key=${meetingKey}`;
}

/** URL que se publica como fuente: las muestras de esa sesión, tal como las devuelve OpenF1. */
export function openF1SessionWeatherUrl(sessionKey: number): string {
  return `${OPENF1_API}/weather?session_key=${sessionKey}`;
}

/** Sesión de OpenF1 que empieza a la misma hora que la nuestra (la más cercana dentro de la tolerancia). */
export function matchOpenF1Session(list: OpenF1Session[], startUtc: string): OpenF1Session | null {
  const start = Date.parse(startUtc);
  let best: OpenF1Session | null = null;
  let bestDiff = MATCH_TOLERANCE_MS;
  for (const s of list) {
    if (s.is_cancelled) continue;
    const diff = Math.abs(Date.parse(s.date_start) - start);
    if (Number.isFinite(diff) && diff <= bestDiff) {
      best = s;
      bestDiff = diff;
    }
  }
  return best;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function numbers(samples: OpenF1Weather[], key: 'air_temperature' | 'track_temperature' | 'humidity' | 'wind_speed'): number[] {
  return samples.map((x) => x[key]).filter((n): n is number => typeof n === 'number' && Number.isFinite(n));
}

const round1 = (n: number): number => Math.round(n * 10) / 10;

/**
 * Resume las muestras de una sesión (ver el comentario del archivo). Devuelve undefined si casi no hay muestras
 * desde el inicio de la sesión.
 */
export function summarizeWeather(
  samples: OpenF1Weather[],
  sessionKey: number,
  startUtc: string,
): Omit<SessionConditions, 'source'> | undefined {
  const start = Date.parse(startUtc);
  const during = samples.filter((x) => x.session_key === sessionKey && Date.parse(x.date) >= start);
  if (during.length < MIN_SAMPLES) return undefined;

  const air = median(numbers(during, 'air_temperature'));
  const track = median(numbers(during, 'track_temperature'));
  const humidity = median(numbers(during, 'humidity'));
  const wind = median(numbers(during, 'wind_speed'));
  if (air === undefined && track === undefined && humidity === undefined) return undefined;

  const rainReadings = during.filter((x) => typeof x.rainfall === 'number');
  const rainy = rainReadings.filter((x) => x.rainfall! > 0).length;
  const share = rainReadings.length > 0 ? rainy / rainReadings.length : -1;
  const weather =
    share === 0 ? 'Sin lluvia' : share >= RAIN_MOST ? 'Lluvia' : share >= RAIN_SOME ? 'Lluvia por momentos' : undefined;

  return {
    ...(air !== undefined ? { airC: round1(air) } : {}),
    ...(track !== undefined ? { trackC: round1(track) } : {}),
    ...(humidity !== undefined ? { humidity: Math.round(humidity) } : {}),
    ...(weather ? { weather } : {}),
    ...(wind !== undefined ? { windKmh: Math.round(wind * 3.6) } : {}),
  };
}

/**
 * Condiciones medidas de las sesiones pedidas: 1 pedido por año (índice de sesiones) + 1 por fin de semana.
 * Si OpenF1 pide esperar, no responde o rechaza el pedido, se deja de pedir y lo que falta vuelve como `deferred`.
 * Lanza solo si falla el índice de sesiones (no se llegó a consultar nada).
 */
export async function openF1Conditions(
  ctx: AdapterContext,
  sessions: Array<Pick<Session, 'id' | 'startUtc'>>,
): Promise<ConditionsChunk> {
  const out: ConditionsChunk = { conditions: new Map(), deferred: [] };
  if (sessions.length === 0) return out;

  // Índice de sesiones de cada año pedido (normalmente uno solo).
  const index = new Map<number, OpenF1Session[]>();
  for (const year of new Set(sessions.map((s) => new Date(s.startUtc).getUTCFullYear()))) {
    const { body } = await ctx.http.json<OpenF1Session[]>(openF1SessionsUrl(year));
    index.set(year, Array.isArray(body) ? body : []);
  }

  const byMeeting = new Map<number, Array<{ id: string; match: OpenF1Session }>>();
  for (const s of sessions) {
    const match = matchOpenF1Session(index.get(new Date(s.startUtc).getUTCFullYear()) ?? [], s.startUtc);
    if (!match) continue; // OpenF1 no tiene esa sesión: cuenta como "sin dato"
    const list = byMeeting.get(match.meeting_key) ?? [];
    list.push({ id: s.id, match });
    byMeeting.set(match.meeting_key, list);
  }

  const meetings = [...byMeeting.entries()];
  for (let i = 0; i < meetings.length; i++) {
    const [meetingKey, wanted] = meetings[i]!;
    try {
      const { body } = await ctx.http.json<OpenF1Weather[]>(openF1WeatherUrl(meetingKey));
      const samples = Array.isArray(body) ? body : [];
      for (const { id, match } of wanted) {
        const summary = summarizeWeather(samples, match.session_key, match.date_start);
        if (!summary) continue;
        out.conditions.set(id, {
          ...summary,
          source: directSource(
            ctx,
            openF1SessionWeatherUrl(match.session_key),
            'OpenF1 — clima medido en pista (estación del live timing de F1; valor típico de la sesión)',
          ),
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (sourceUnavailable(err)) {
        ctx.log.warn(`OpenF1 no está disponible (${message}): las condiciones que faltan quedan para la próxima corrida`);
        out.deferred!.push(...meetings.slice(i).flatMap(([, list]) => list.map((x) => x.id)));
        break;
      }
      ctx.log.warn(`OpenF1, fin de semana ${meetingKey}: ${message}`);
    }
  }
  return out;
}
