/**
 * Lector del feed en vivo de NASCAR: https://cf.nascar.com/live/feeds/live-feed.json
 * (un solo feed para Cup / O'Reilly / Truck: lo que esté en pista; `series_id` dice cuál).
 *
 * Códigos verificados con los feeds archivados de 2026 (live_feed.json y lap-times.json):
 * - flag_state: 1 verde, 2 amarilla, 3 roja, 4 cuadros, 8 previa (vuelta 0), 9 sin sesión / terminada.
 *   (5 = bandera blanca, por convención; se muestra como verde).
 * - vehicles[].status: 1 en carrera, 3 fuera de carrera.
 * - vehicles[].delta: >0 segundos detrás del líder; <0 vueltas abajo (-2 = 2 vueltas).
 * - series_id: 1 Cup, 2 O'Reilly (ex Xfinity), 3 Truck. run_type: 1 práctica, 2 clasificación, 3 carrera.
 */
import type { LiveBoard, LiveFlag, LiveRow, LiveStatus } from './live.ts';
import { formatClock, formatGapTime, formatLapsBehind, isoNow, isRecord, num, str, stripUndefined } from './live-format.ts';
import { LIVE_SOURCES } from './live-sources.ts';

const SERIES_BY_NASCAR_ID: Record<number, string> = { 1: 'nascar-cup', 2: 'nascar-xfinity', 3: 'nascar-truck' };

const FLAGS: Record<number, LiveFlag> = { 1: 'green', 2: 'yellow', 3: 'red', 4: 'checkered', 5: 'green', 8: 'none', 9: 'none' };

const MAKES: Record<string, string> = { Chv: 'Chevrolet', Frd: 'Ford', Tyt: 'Toyota', Dge: 'Dodge', Ram: 'Ram' };

const RUN_TYPES: Record<number, string> = { 1: 'Práctica', 2: 'Clasificación', 3: 'Carrera' };

/** "* JJ Yeley(i)", "Ryan Blaney (C)", "Connor Zilisch #" -> nombre limpio. */
export function cleanNascarDriverName(raw: string): string {
  return raw
    .replace(/^\s*\*\s*/, '')
    .replace(/\s*\((?:i|c|r)\)/gi, '')
    .replace(/\s*#\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function boardStatus(flag: number | undefined, lap: number, anyLaps: boolean, hasCars: boolean): LiveStatus {
  if (!hasCars) return 'not-started';
  switch (flag) {
    case 1:
    case 2:
    case 3:
    case 5:
      return 'live';
    case 4:
      return 'finished';
    case 8:
      return 'not-started';
    case 9:
      return lap > 0 || anyLaps ? 'finished' : 'not-started';
    default:
      return 'unknown';
  }
}

/**
 * Convierte live-feed.json en un LiveBoard.
 * Devuelve null si la entrada no es un objeto o si no hay ninguna sesión cargada
 * (race_id <= 0 y sin autos: el feed "vacío" entre fines de semana).
 * Nunca lanza.
 */
export function parseNascarLive(json: unknown, now: Date): LiveBoard | null {
  if (!isRecord(json)) return null;
  const vehicles = Array.isArray(json.vehicles) ? json.vehicles.filter(isRecord) : [];
  const raceId = num(json.race_id) ?? -1;
  if (raceId <= 0 && vehicles.length === 0) return null;

  const nascarSeries = num(json.series_id);
  const seriesId = nascarSeries !== undefined ? SERIES_BY_NASCAR_ID[nascarSeries] : undefined;
  const flagState = num(json.flag_state);
  const lap = num(json.lap_number) ?? 0;
  const totalLaps = num(json.laps_in_race);
  const anyLaps = vehicles.some((v) => (num(v.laps_completed) ?? 0) > 0);
  const status = boardStatus(flagState, lap, anyLaps, vehicles.length > 0);
  const runType = num(json.run_type);

  const sorted = [...vehicles].sort(
    (a, b) => (num(a.running_position) ?? Number.MAX_SAFE_INTEGER) - (num(b.running_position) ?? Number.MAX_SAFE_INTEGER),
  );

  let prevDelta: number | undefined;
  const rows: LiveRow[] = sorted.map((v, i) => {
    const driver = isRecord(v.driver) ? str(v.driver.full_name) : undefined;
    const delta = num(v.delta);
    const carStatus = num(v.status);
    let gap: string | undefined;
    let interval: string | undefined;
    if (i > 0 && delta !== undefined) {
      if (delta < 0) gap = formatLapsBehind(Math.round(-delta));
      else gap = formatGapTime(delta);
      if (delta > 0 && prevDelta !== undefined && prevDelta >= 0 && delta > prevDelta) {
        interval = formatGapTime(Math.round((delta - prevDelta) * 1000) / 1000);
      }
    }
    prevDelta = delta;
    const make = str(v.vehicle_manufacturer);
    const row: LiveRow = {
      pos: num(v.running_position) ?? i + 1,
      number: str(v.vehicle_number),
      driver: driver ? cleanNascarDriverName(driver) : '—',
      vehicle: make ? (MAKES[make] ?? make) : undefined,
      laps: num(v.laps_completed),
      gap,
      interval,
      lastLap: formatClock(num(v.last_lap_time)),
      bestLap: formatClock(num(v.best_lap_time)),
    };
    if (carStatus === 3) row.status = 'Fuera';
    if (status === 'live' && carStatus === 1 && v.is_on_track === false) row.inPit = true;
    return stripUndefined(row);
  });

  const board: LiveBoard = {
    provider: 'nascar',
    seriesId,
    eventName: str(json.track_name) ?? 'NASCAR',
    sessionName: str(json.run_name) ?? (runType !== undefined ? RUN_TYPES[runType] : undefined) ?? '',
    status,
    flag: flagState !== undefined ? FLAGS[flagState] : undefined,
    lap: lap > 0 ? lap : undefined,
    totalLaps: totalLaps && totalLaps > 0 ? totalLaps : undefined,
    rows,
    updatedAt: isoNow(now),
    sourceUrl: (seriesId && LIVE_SOURCES[seriesId]?.officialUrl) || 'https://www.nascar.com/leaderboard',
  };
  return stripUndefined(board);
}

