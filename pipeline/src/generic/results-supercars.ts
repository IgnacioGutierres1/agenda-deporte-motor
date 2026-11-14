/**
 * Resultados de Supercars: cada sesión tiene su página /results/AAAA/<slug>/<código> (el código de Natsoft que trae
 * el cronograma: "P7", "Q5", "R7"). La página (Next.js) incluye en el payload RSC el resultado oficial de Natsoft
 * (resultData.V8Supercars…Event[0].Competitor) y los puntos de la fecha (meetingPointData): de ahí se lee sin IA.
 */
import type { ResultRow, Session } from '@dm/shared';
import { extractEmbeddedJson } from '../extract/html.ts';
import { isoNow, obj, pageOrNull, str } from './kit.ts';
import { formatSeconds, sourceName } from './results-asia-kit.ts';
import { supercarsScheduleItems } from './supercars.ts';
import type { CalendarEntry, RecipeContext, ResultsFound, SessionResultFound } from './types.ts';

const BASE = 'https://www.supercars.com';

export const supercarsResultUrl = (season: number, slug: string, code: string) => `${BASE}/results/${season}/${slug}/${code}`;

const arr = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj) : []);

/** Primer objeto (a cualquier profundidad) que cumpla el predicado. */
function find(value: unknown, pred: (o: Record<string, unknown>) => boolean, depth = 0): Record<string, unknown> | null {
  if (depth > 60 || !value || typeof value !== 'object') return null;
  if (!Array.isArray(value) && pred(value as Record<string, unknown>)) return value as Record<string, unknown>;
  for (const v of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
    const r = find(v, pred, depth + 1);
    if (r) return r;
  }
  return null;
}

/** "Series[0].Season[0].Meeting[0].Event[0]" de un informe de Natsoft. */
const natsoftEvent = (report: unknown) =>
  obj(arr(arr(arr(arr(obj(obj(report).V8Supercars).Series)[0]?.Season)[0]?.Meeting)[0]?.Event)[0]);

/** Diferencia en segundos -> "+5.362" / "+1:11.427". */
const gapSeconds = (s: number) => `+${s < 60 ? s.toFixed(3) : formatSeconds(s)}`;

const seconds = (v: unknown) => {
  const n = Number(str(v));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/**
 * Filas de una sesión a partir del HTML de su página de resultados. null si la página no trae el informe de esa
 * sesión (todavía no publicado o de otra categoría).
 */
export function supercarsResultRows(html: string, code: string): ResultRow[] | null {
  let data: Record<string, unknown> | null = null;
  for (const v of extractEmbeddedJson(html)) {
    data = find(v, (o) => !!o.resultData && typeof o.resultData === 'object' && 'meetingRoundCode' in o);
    if (data) break;
  }
  if (!data) return null;
  // Solo el campeonato principal (el mismo sitio publica Super2, Super3, Carrera Cup…).
  if (!/supercars championship/i.test(str(data.description))) return null;
  const event = natsoftEvent(obj(data.resultData).resultData ?? data.resultData);
  if (str(event.Code) !== code) return null;
  const type = str(event.Type).toUpperCase(); // R = carrera, Q = clasificación, P = práctica
  const competitors = arr(event.Competitor);
  if (competitors.length === 0) return null;
  // Puntos de la fecha por auto y sesión.
  const points = new Map<string, number>();
  for (const c of arr(natsoftMeeting(data.meetingPointData).Competitor)) {
    const p = arr(c.Event).find((e) => str(e.Code) === code);
    const n = Number(str(p?.Points));
    if (p && Number.isFinite(n)) points.set(str(c.Number) || str(c.id), n);
  }
  const sorted = [...competitors].sort((a, b) => Number(str(a.LineNumber)) - Number(str(b.LineNumber)));
  const leader = sorted.find((c) => /^\d+$/.test(str(c.Position)));
  const leaderLaps = Number(str(leader?.Laps));
  const leaderTime = seconds(leader?.RaceTime);
  return sorted.map((c) => {
    const posText = str(c.Position).trim();
    const pos = /^\d+$/.test(posText) ? Number(posText) : null;
    const number = str(c.Number) || str(c.id);
    const driver = arr(c.Driver)
      .map((d) => str(d.Name).replace(/_/g, ' ').trim())
      .filter(Boolean)
      .join(' / ');
    const laps = Number(str(c.Laps));
    const best = seconds(c.FastestTime);
    const team = str(c.Entrant).trim() || str(c.TeamName).trim();
    const vehicle = str(c.Vehicle).trim();
    const row: ResultRow = {
      pos,
      ...(pos === null ? { status: posText.toUpperCase() || 'NC' } : {}),
      number,
      driver: driver || `#${number}`,
      ...(team ? { team } : {}),
      ...(vehicle ? { vehicle } : {}),
      ...(Number.isFinite(laps) ? { laps } : {}),
    };
    if (type === 'R') {
      const time = seconds(c.RaceTime);
      if (pos !== null && c === leader && time) row.time = formatSeconds(time);
      else if (pos !== null && time && leaderTime && laps === leaderLaps) row.gap = gapSeconds(time - leaderTime);
      else if (pos !== null && Number.isFinite(laps) && leaderLaps > laps) row.gap = `+${leaderLaps - laps} ${leaderLaps - laps === 1 ? 'vuelta' : 'vueltas'}`;
      if (best) row.bestLap = formatSeconds(best);
      const pts = points.get(number);
      if (pts !== undefined) row.points = pts;
    } else {
      if (best) row.time = formatSeconds(best);
      const gap = seconds(c.Gap);
      if (gap && pos !== 1) row.gap = gapSeconds(gap);
    }
    return row;
  });
}

const natsoftMeeting = (report: unknown) => obj(arr(arr(arr(obj(obj(report).V8Supercars).Series)[0]?.Season)[0]?.Meeting)[0]);

export async function supercarsResults(entry: CalendarEntry, sessions: Session[], ctx: RecipeContext): Promise<ResultsFound | null> {
  const slug = entry.meta?.slug;
  if (!slug) return null;
  const scheduleUrl = `${BASE}/events/${slug}/schedule`;
  const html = await pageOrNull(ctx, scheduleUrl);
  if (!html) return null;
  const items = supercarsScheduleItems(html, entry.tz);
  const found: SessionResultFound[] = [];
  for (const s of sessions) {
    const item = items.find((i) => i.name === sourceName(s)) ?? items.find((i) => i.startUtc === s.startUtc);
    if (!item?.code) continue;
    const url = supercarsResultUrl(ctx.season, slug, item.code);
    const page = await pageOrNull(ctx, url);
    if (!page) continue;
    const rows = supercarsResultRows(page, item.code);
    if (!rows?.length) continue;
    found.push({
      sessionId: s.id,
      rows,
      source: { url, title: `Results — ${entry.name} — ${item.name}`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) },
    });
  }
  return {
    sessions: found,
    source: { url: `${BASE}/results/${slug}`, title: `Results — ${entry.name}`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) },
  };
}
