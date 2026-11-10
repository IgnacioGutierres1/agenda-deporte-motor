/**
 * Speedhive (MyLaps) — API pública de resultados ("eventresults"):
 *   organizations/{org}/events  ->  events/{id}?sessions=true  ->  sessions/{id}/classification
 *
 * Importante: NO es tiempo real. Los cronometradores (Orbits) suben cada sesión al terminar, así que
 * el tablero sale siempre con status 'finished' ("última sesión publicada"). El vivo de Speedhive
 * (lt-api.speedhive.com + notificaciones push) exige clave de API: no se usa (sólo enlace).
 *
 * Los horarios de sesión vienen en hora local del circuito sin zona; para las categorías argentinas
 * se interpretan en America/Argentina/Buenos_Aires.
 */
import { DateTime } from 'luxon';
import type { LiveBoard, LiveRow } from './live.ts';
import { formatClock, formatGapTime, formatLapsBehind, isoNow, isRecord, num, str, stripUndefined } from './live-format.ts';
import { LIVE_SOURCES, speedhiveSessionPageUrl, type SpeedhiveSelector } from './live-sources.ts';
import { driverDisplayName } from './drivers.ts';
import { AR_TZ } from './time.ts';

export interface SpeedhiveEventRef {
  id: number;
  name: string;
  startDate: string;
}

export interface SpeedhiveSessionRef {
  id: number;
  name: string;
  groupName: string;
  type: string;
  /** ISO UTC. */
  startUtc: string;
}

function localToUtcIso(local: string, zone: string): string | undefined {
  const dt = DateTime.fromISO(local, { zone });
  if (!dt.isValid || dt.year < 2000) return undefined;
  return dt.toUTC().toISO({ suppressMilliseconds: true }) ?? undefined;
}

/**
 * Eventos candidatos de la respuesta de organizations/{org}/events: nombre que coincide y fecha de
 * inicio entre 4 días antes y 1 día después de `now` (los eventos van de viernes a domingo).
 * Más reciente primero. Puede haber duplicados (el cronometrador a veces crea dos eventos iguales).
 */
export function pickSpeedhiveEvents(json: unknown, selector: Pick<SpeedhiveSelector, 'eventPattern'>, now: Date, zone = AR_TZ): SpeedhiveEventRef[] {
  if (!Array.isArray(json)) return [];
  const today = DateTime.fromJSDate(now, { zone }).startOf('day');
  if (!today.isValid) return [];
  const from = today.minus({ days: 4 });
  const to = today.plus({ days: 1 });
  const out: SpeedhiveEventRef[] = [];
  for (const e of json) {
    if (!isRecord(e)) continue;
    const id = num(e.id);
    const name = str(e.name);
    const startDate = str(e.startDate)?.slice(0, 10);
    if (id === undefined || !name || !startDate || !selector.eventPattern.test(name)) continue;
    const d = DateTime.fromISO(startDate, { zone });
    if (!d.isValid || d < from || d > to) continue;
    out.push({ id, name, startDate });
  }
  return out.sort((a, b) => b.startDate.localeCompare(a.startDate) || b.id - a.id);
}

/**
 * Sesiones ya empezadas (startTime <= now) de los grupos que coinciden con el selector, más reciente
 * primero. Ignora las sesiones "generales" con fecha 1970. Probar la clasificación en ese orden:
 * si la primera todavía no tiene filas (no la subieron), pasar a la siguiente.
 */
export function pickSpeedhiveSessions(json: unknown, selector: Pick<SpeedhiveSelector, 'groupPattern'>, now: Date, zone = AR_TZ): SpeedhiveSessionRef[] {
  if (!isRecord(json)) return [];
  const container = isRecord(json.sessions) ? json.sessions : json;
  const groups: unknown[] = Array.isArray(container.groups) ? container.groups : [];
  const nowMs = now.getTime();
  const out: SpeedhiveSessionRef[] = [];
  const visit = (g: unknown) => {
    if (!isRecord(g)) return;
    const groupName = str(g.name) ?? '';
    if (selector.groupPattern.test(groupName) && Array.isArray(g.sessions)) {
      for (const s of g.sessions) {
        if (!isRecord(s)) continue;
        const id = num(s.id);
        const local = str(s.startTime);
        const startUtc = local ? localToUtcIso(local, zone) : undefined;
        if (id === undefined || !startUtc || Date.parse(startUtc) > nowMs) continue;
        out.push({ id, name: str(s.name) ?? '', groupName, type: str(s.type) ?? '', startUtc });
      }
    }
    if (Array.isArray(g.subGroups)) g.subGroups.forEach(visit);
  };
  groups.forEach(visit);
  return out.sort((a, b) => b.startUtc.localeCompare(a.startUtc) || b.id - a.id);
}

const ROW_STATUS: Record<string, string> = {
  DNF: 'Abandono',
  DNS: 'No largó',
  DQ: 'Descalificado',
  DSQ: 'Descalificado',
  DISQUALIFIED: 'Descalificado',
  DIDNOTFINISH: 'Abandono',
  DIDNOTSTART: 'No largó',
};

function diff(v: unknown): string | undefined {
  if (!isRecord(v)) return undefined;
  const laps = num(v.lapsBehind) ?? 0;
  if (laps > 0) return formatLapsBehind(laps);
  return formatGapTime(str(v.timeDifference));
}

export interface SpeedhiveContext {
  /** Sesión elegida (de pickSpeedhiveSessions) para nombre y enlace. */
  session?: Pick<SpeedhiveSessionRef, 'id' | 'name' | 'groupName'>;
  /** Nombre del evento ("TC2000 - FECHA #10"). */
  eventName?: string;
  seriesId?: string;
}

/**
 * Convierte sessions/{id}/classification en un LiveBoard con status 'finished'.
 * null si la entrada no es un objeto. Si todavía no hay filas devuelve el tablero vacío con
 * status 'unknown'. Nunca lanza.
 */
export function parseSpeedhiveClassification(json: unknown, now: Date, ctx: SpeedhiveContext = {}): LiveBoard | null {
  if (!isRecord(json)) return null;
  const isRace = /race/i.test(str(json.type) ?? '');
  const raw = Array.isArray(json.rows) ? json.rows.filter(isRecord) : [];
  const sorted = [...raw].sort((a, b) => (num(a.position) ?? 9999) - (num(b.position) ?? 9999));
  const rows: LiveRow[] = sorted.map((r, i) => {
    const st = (str(r.status) ?? 'Normal').replace(/\s+/g, '').toUpperCase();
    const status = st === 'NORMAL' ? (isRace && r.isQualified === false ? 'No clasificado' : undefined) : (ROW_STATUS[st] ?? str(r.status));
    const row: LiveRow = {
      pos: num(r.position) ?? i + 1,
      number: str(r.startNumber),
      driver: str(r.name) ? driverDisplayName(str(r.name)!) : '—',
      laps: num(r.numberOfLaps),
      gap: i > 0 ? diff(r.difference) : undefined,
      // En prácticas/clasificación `gap` es contra el de adelante; en carreras no viene.
      interval: i > 0 ? diff(r.gap) : undefined,
      bestLap: formatClock(str(r.bestTime)),
      status,
    };
    return stripUndefined(row);
  });

  const session = ctx.session;
  const sourceUrl =
    session?.id !== undefined ? speedhiveSessionPageUrl(session.id) : (ctx.seriesId && LIVE_SOURCES[ctx.seriesId]?.officialUrl) || 'https://speedhive.mylaps.com/';
  const sessionName = [session?.groupName, session?.name].filter(Boolean).join(' · ');
  const board: LiveBoard = {
    provider: 'speedhive',
    seriesId: ctx.seriesId,
    eventName: ctx.eventName ?? '',
    sessionName,
    status: rows.length ? 'finished' : 'unknown',
    rows,
    updatedAt: isoNow(now),
    sourceUrl,
  };
  return stripUndefined(board);
}
