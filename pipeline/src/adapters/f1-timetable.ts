/**
 * Cronograma oficial del fin de semana de F1 (formula1.com), con todas las categorías que corren en el evento.
 *
 * La página de cada ronda (https://www.formula1.com/en/racing/{season}/{slug}) enlaza en "Full Schedule" una nota
 * (`fullRaceSchedule.url` en el payload RSC) con una tabla por día: categoría ("FIA Formula 2", "F1 ACADEMY",
 * "FORMULA 1"…), sesión ("Practice Session", "Sprint Race (23 Laps or 45 Mins +1 Lap)"…) y hora local
 * ("14:00 - 14:45"). La usan F2/F3 mientras su propio sitio muestra el cronograma "TBC" y F1 Academy, cuyo
 * calendario deja las sesiones como "Unconfirmed" hasta último momento.
 *
 * Solo se toman las filas de la categoría pedida: nunca se infieren horarios a partir de las sesiones de F1.
 */
import { parse } from 'node-html-parser';
import { localToUtc, type SessionType, type Source } from '@dm/shared';
import { classifySession } from '../core/builders.ts';
import type { Http } from '../core/http.ts';
import { decodeRscPayload, extractMeeting, isoNow } from './fom.ts';

export const F1_SITE = 'https://www.formula1.com';

export interface TimetableRow {
  /** Categoría tal como figura en la tabla ("FIA Formula 2", "F1 ACADEMY"…). */
  series: string;
  /** Nombre publicado, sin el detalle de vueltas ("Sprint Race", "Practice Session"). */
  name: string;
  /** Texto completo de la celda ("Sprint Race (23 Laps or 45 Mins +1 Lap)"). */
  fullName: string;
  type: SessionType;
  localDate: string;
  localStartText: string;
  startUtc: string;
  endUtc?: string;
  /** Fin en hora local "YYYY-MM-DDTHH:mm", si se publica. */
  localEnd?: string;
}

export interface WeekendTimetable {
  url: string;
  title: string;
  tz: string;
  rows: TimetableRow[];
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const monthOf = (text: string): number => MONTHS.indexOf(text.slice(0, 3).toLowerCase()) + 1;
const pad = (n: number) => String(n).padStart(2, '0');
const DAY_RE = /^(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(\d{1,2})\s+([a-z]+)/i;
const RANGE_RE = /\b(\d{1,2})(?:\s+([a-z]{3}))?\s*-\s*(\d{1,2})\s+([a-z]{3})\b/i;
const HOURS_RE = /^(\d{1,2}[:.]\d{2})(?:\s*-\s*(\d{1,2}[:.]\d{2}))?$/;
/** Filas del cronograma que no son sesiones en pista. */
const NOT_ON_TRACK = /press|conference|parade|anthem|presentation|pit ?lane|autograph|walk|ceremony|podium/i;

/** Fecha local "YYYY-MM-DD" del día/mes publicado, en el año que lo acerca a la fecha de referencia. */
function dateNear(day: number, month: number, ref: string): string {
  const year = Number(ref.slice(0, 4));
  const candidates = [year - 1, year, year + 1].map((y) => `${y}-${pad(month)}-${pad(day)}`);
  const refMs = Date.parse(ref);
  return candidates.reduce((a, b) => (Math.abs(Date.parse(a) - refMs) <= Math.abs(Date.parse(b) - refMs) ? a : b));
}

const shiftDay = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/**
 * Rondas del calendario de formula1.com con sus fechas ("27 - 29 NOV", "30 Oct - 01 Nov") leídas de las tarjetas.
 */
export function f1CalendarRanges(html: string, season: number): Array<{ slug: string; dateStart: string; dateEnd: string }> {
  const re = new RegExp(`href="/en/racing/${season}/([a-z0-9-]+)"([\\s\\S]*?)</a>`, 'g');
  const out = new Map<string, { slug: string; dateStart: string; dateEnd: string }>();
  for (const m of html.matchAll(re)) {
    const slug = m[1]!;
    if (out.has(slug)) continue;
    const text = m[2]!.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const r = text.match(RANGE_RE);
    if (!r) continue;
    const endMonth = monthOf(r[4]!);
    const startMonth = r[2] ? monthOf(r[2]) : endMonth;
    if (startMonth < 1 || endMonth < 1) continue;
    const startYear = startMonth > endMonth ? season - 1 : season;
    out.set(slug, {
      slug,
      dateStart: `${startYear}-${pad(startMonth)}-${pad(Number(r[1]))}`,
      dateEnd: `${season}-${pad(endMonth)}-${pad(Number(r[3]))}`,
    });
  }
  return [...out.values()];
}

/** Ronda de F1 que comparte fin de semana con el evento (la de mayor superposición de fechas). */
export function matchF1Round(
  ranges: Array<{ slug: string; dateStart: string; dateEnd: string }>,
  dateStart: string,
  dateEnd: string,
): string | null {
  let best: { slug: string; overlap: number } | null = null;
  for (const r of ranges) {
    const from = Math.max(Date.parse(r.dateStart), Date.parse(dateStart));
    const to = Math.min(Date.parse(r.dateEnd), Date.parse(dateEnd));
    const overlap = (to - from) / 86_400_000 + 1;
    if (overlap >= 1 && (!best || overlap > best.overlap)) best = { slug: r.slug, overlap };
  }
  return best?.slug ?? null;
}

/** URL de la nota "Full Schedule" enlazada desde la página de la ronda. */
export function fullScheduleUrl(html: string): string | null {
  const rsc = decodeRscPayload(html);
  const m = rsc.match(/"fullRaceSchedule":\{[^{}]*?"url":"([^"]+)"/);
  const url = m?.[1] ?? html.match(/data-f1rd-a7s-click="view_schedule_click"[^>]*href="([^"]+)"/)?.[1];
  if (!url) return null;
  return url.startsWith('http') ? url : `${F1_SITE}${url}`;
}

/**
 * Filas de sesiones de las tablas por día de la nota del cronograma. `tz` es la zona del circuito y `refDate`
 * una fecha del fin de semana (para elegir el año de "FRIDAY 27 NOVEMBER").
 */
export function parseTimetableArticle(html: string, tz: string, refDate: string): TimetableRow[] {
  const rows: TimetableRow[] = [];
  for (const table of parse(html).querySelectorAll('table')) {
    let date: string | null = null;
    for (const tr of table.querySelectorAll('tr')) {
      const cells = tr.querySelectorAll('th,td').map((c) => c.text.replace(/\s+/g, ' ').trim());
      const day = cells[0]?.match(DAY_RE);
      if (day) {
        const month = monthOf(day[2]!);
        if (month > 0) date = dateNear(Number(day[1]), month, refDate);
        continue;
      }
      if (!date || cells.length < 3) continue;
      const [series, fullName, hours] = [cells[0]!, cells[1]!, cells.at(-1)!];
      const h = hours.match(HOURS_RE);
      if (!h || !series || !fullName || NOT_ON_TRACK.test(fullName)) continue;
      const name = fullName.replace(/\s*\(.*\)\s*$/, '').trim();
      const type = classifySession(name);
      if (type === 'otro') continue;
      const startUtc = localToUtc(date, h[1]!, tz);
      const hhmm = (t: string) => t.replace('.', ':').padStart(5, '0');
      let endUtc: string | undefined;
      let localEnd: string | undefined;
      if (h[2]) {
        let endDate = date;
        endUtc = localToUtc(endDate, hhmm(h[2]), tz);
        if (endUtc <= startUtc) {
          endDate = shiftDay(date, 1); // pasa la medianoche
          endUtc = localToUtc(endDate, hhmm(h[2]), tz);
        }
        localEnd = `${endDate}T${hhmm(h[2])}`;
      }
      rows.push({
        series,
        name,
        fullName,
        type,
        localDate: date,
        localStartText: hhmm(h[1]!),
        startUtc,
        ...(endUtc ? { endUtc, localEnd } : {}),
      });
    }
  }
  return rows;
}

/**
 * Cronograma oficial del fin de semana de F1 que coincide con las fechas del evento, o null si formula1.com
 * no tiene una ronda esas fechas o todavía no publicó la nota con el cronograma.
 */
export async function f1WeekendTimetable(
  http: Http,
  season: number,
  dateStart: string,
  dateEnd: string,
): Promise<WeekendTimetable | null> {
  const calendar = (await http.text(`${F1_SITE}/en/racing/${season}`)).body;
  const slug = matchF1Round(f1CalendarRanges(calendar, season), dateStart, dateEnd);
  if (!slug) return null;
  const roundHtml = (await http.text(`${F1_SITE}/en/racing/${season}/${slug}`)).body;
  const meeting = extractMeeting(roundHtml);
  const tz = meeting?.meetingTimezone || meeting?.meetingSessions?.find((s) => s.timezone)?.timezone;
  const url = fullScheduleUrl(roundHtml);
  if (!tz || !url) return null;
  const article = (await http.text(url)).body;
  const rows = parseTimetableArticle(article, tz, meeting?.meetingStartDate?.slice(0, 10) || dateStart);
  if (rows.length === 0) return null;
  const title = meeting?.meetingOfficialName || meeting?.meetingName || slug;
  return { url, title, tz, rows };
}

/** Filas de una categoría ("FIA Formula 2" -> /formula 2/). */
export function rowsFor(timetable: WeekendTimetable, series: RegExp): TimetableRow[] {
  return timetable.rows.filter((r) => series.test(r.series));
}

/**
 * Empareja las sesiones previstas por la categoría (en orden) con las filas del cronograma del mismo tipo
 * (en orden). Devuelve null si alguna sesión no tiene fila o sobran filas: entonces el cronograma no se usa.
 */
export function pairByType<T>(planned: T[], typeOf: (p: T) => SessionType, rows: TimetableRow[]): Map<T, TimetableRow> | null {
  const used = new Set<TimetableRow>();
  const pairs = new Map<T, TimetableRow>();
  for (const p of planned) {
    const row = rows.find((r) => !used.has(r) && r.type === typeOf(p));
    if (!row) return null;
    used.add(row);
    pairs.set(p, row);
  }
  return used.size === rows.length ? pairs : null;
}

export function timetableSource(t: WeekendTimetable, label: string, now: Date): Source {
  return {
    url: t.url,
    title: `${label} — ${t.title} (cronograma oficial del fin de semana, formula1.com)`,
    kind: 'html',
    method: 'directo',
    fetchedAt: isoNow(now),
  };
}
