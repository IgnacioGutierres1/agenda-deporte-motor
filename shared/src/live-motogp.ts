/**
 * Lector del widget gratuito de MotoGP:
 * https://api.motogp.pulselive.com/motogp/v1/timing-gateway/livetiming-lite
 * Devuelve la sesión en curso o, si no hay, la última disputada (MotoGP, Moto2 o Moto3: `head.category`).
 *
 * Semántica tomada del propio widget de motogp.com (live-timings-lite.js):
 * - head.session_status_id/_name: "N" previa, "S" en curso, "I" interrumpida (bandera roja), "F" terminada.
 * - En carreras (session_shortname RAC/SPR) `head.remaining` son vueltas restantes y `rider.lap_time` es
 *   el tiempo total; en prácticas/clasificación `remaining` son segundos y `lap_time` es la mejor vuelta.
 * - rider.order < 0 = fuera de la clasificación (al final); status_name "RT" abandono, "NC" no clasificado.
 * - Tiempos con apóstrofo: "1'53.940".
 */
import type { LiveBoard, LiveFlag, LiveRow, LiveStatus } from './live.ts';
import { formatClock, formatGapTime, formatLapsBehind, formatRemaining, isoNow, isRecord, num, str, stripUndefined } from './live-format.ts';
import { LIVE_SOURCES } from './live-sources.ts';

const SERIES_BY_CATEGORY: Record<string, string> = { motogp: 'motogp', moto2: 'moto2', moto3: 'moto3' };

const STATUS: Record<string, LiveStatus> = { N: 'not-started', S: 'live', I: 'live', F: 'finished' };
const FLAG: Record<string, LiveFlag> = { I: 'red', F: 'checkered' };

const RIDER_STATUS: Record<string, string> = { RT: 'Abandono', NC: 'No clasificado', DQ: 'Descalificado', DSQ: 'Descalificado', NS: 'No largó' };

/** "DI GIANNANTONIO" -> "Di Giannantonio", "VIÑALES" -> "Viñales". */
function titleCase(s: string): string {
  return s.toLocaleLowerCase('es').replace(/(^|[\s'’-])(\p{L})/gu, (_m, sep: string, c: string) => sep + c.toLocaleUpperCase('es'));
}

function riderName(r: Record<string, unknown>): string {
  const first = str(r.rider_name);
  const last = str(r.rider_surname);
  const full = [first, last ? titleCase(last) : undefined].filter(Boolean).join(' ');
  return full || str(r.rider_shortname) || '—';
}

function orderOf(r: Record<string, unknown>): number {
  const o = num(r.order);
  return o === undefined || o < 0 ? Number.MAX_SAFE_INTEGER : o;
}

/**
 * Convierte la respuesta de livetiming-lite en un LiveBoard.
 * null si la entrada no es un objeto o no trae `head`. Nunca lanza.
 * Ojo: entre fines de semana devuelve la última sesión con status 'finished' (fecha en head.date).
 */
export function parseMotogpLive(json: unknown, now: Date): LiveBoard | null {
  if (!isRecord(json) || !isRecord(json.head)) return null;
  const head = json.head;
  const ridersRaw = isRecord(json.rider) ? Object.values(json.rider) : Array.isArray(json.rider) ? json.rider : [];
  const riders = ridersRaw.filter(isRecord).sort((a, b) => orderOf(a) - orderOf(b));

  const category = str(head.category);
  const seriesId = category ? SERIES_BY_CATEGORY[category.toLowerCase()] : undefined;
  const short = (str(head.session_shortname) ?? '').toUpperCase();
  const sessionName = str(head.session_name) ?? short;
  const isRace = /RAC|SPR/.test(short) || /race|sprint/i.test(sessionName);
  const code = (str(head.session_status_id) ?? str(head.session_status_name) ?? '').toUpperCase();
  const status: LiveStatus = STATUS[code] ?? 'unknown';
  const numLaps = num(head.num_laps);
  const remaining = num(head.remaining);

  let lap: number | undefined;
  let remainingText: string | undefined;
  if (isRace) {
    if (numLaps && numLaps > 0 && remaining !== undefined && remaining >= 0 && remaining <= numLaps) lap = numLaps - remaining;
  } else if (remaining !== undefined && status === 'live') {
    remainingText = formatRemaining(remaining);
  }

  const leaderLaps = riders.length ? num(riders[0]!.num_lap) : undefined;
  const rows: LiveRow[] = riders.map((r, i) => {
    const statusName = (str(r.status_name) ?? '').toUpperCase();
    const out = statusName in RIDER_STATUS;
    const pos = num(r.pos);
    const laps = num(r.num_lap);
    let gap: string | undefined;
    if (i > 0 && !out) {
      const behind = isRace && leaderLaps !== undefined && laps !== undefined ? leaderLaps - laps : 0;
      gap = behind > 0 ? formatLapsBehind(behind) : formatGapTime(str(r.gap_first));
    }
    const row: LiveRow = {
      pos: pos !== undefined && pos > 0 ? pos : i + 1,
      number: str(r.rider_number),
      driver: riderName(r),
      team: str(r.team_name),
      vehicle: str(r.bike_name),
      laps,
      gap,
      interval: i > 0 && !out ? formatGapTime(str(r.gap_prev)) : undefined,
      lastLap: formatClock(str(r.last_lap_time)),
      bestLap: isRace ? undefined : formatClock(str(r.lap_time)),
      status: out ? RIDER_STATUS[statusName] : undefined,
      inPit: !out && r.on_pit === true ? true : undefined,
    };
    return stripUndefined(row);
  });

  const board: LiveBoard = {
    provider: 'motogp',
    seriesId,
    eventName: str(head.event_tv_name) ?? str(head.circuit_name) ?? 'MotoGP',
    sessionName: category && sessionName ? `${category} · ${sessionName}` : sessionName,
    status,
    flag: FLAG[code],
    lap,
    totalLaps: isRace && numLaps && numLaps > 0 ? numLaps : undefined,
    remaining: remainingText,
    rows,
    updatedAt: isoNow(now),
    sourceUrl: (seriesId && LIVE_SOURCES[seriesId]?.officialUrl) || 'https://timingpass.motogp.com/en/',
  };
  return stripUndefined(board);
}

/** Fecha de la sesión según head.datst/datet (YYYYMMDD) -> "YYYY-MM-DD", para saber si es de hoy. */
export function motogpSessionDate(json: unknown): string | undefined {
  if (!isRecord(json) || !isRecord(json.head)) return undefined;
  const d = str(json.head.datst) ?? str(json.head.datet);
  const m = d?.match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}
