/**
 * IndyCar e Indy NXT (indycar.com / indynxt.com): cronograma y resultados sin IA.
 *
 * - Cronograma: la página de cada fecha (/Schedule/{año}/{slug}) tiene la tabla "Schedule" con día, hora (ET) y
 *   sesión, y en las sesiones ya corridas un link a su página de resultados (/results/{serie}/{año}/{evento}/{sesión}).
 *   Las fechas dobles (Indy NXT, Milwaukee) tienen una página por carrera; el calendario las junta en un solo evento y
 *   guarda todas sus páginas en meta.pages.
 * - Resultados: la página de resultados se arma con la API JSON del mismo sitio: /api/results/SeasonDropDown?id={serie}
 *   (eventos y sesiones con su id) y /api/results/EventsSessionDetails?id={sesión} (tabla de la sesión). El slug de los
 *   links es el nombre de la API con los espacios cambiados por guiones, sin apóstrofos y en minúsculas (así lo arma
 *   el JavaScript del sitio).
 * - Clasificación en circuitos y callejeros: el cronograma tiene una sola sesión ("Qualifying") y la API la publica
 *   por partes (Round 1 Group 1/2, Round 2 = Fast 12, Firestone Fast 6 y la combinada). Se devuelve la combinada
 *   (`pos` = puesto final de la clasificación) y en `class`/`classPos` la parte en la que cada piloto quedó afuera,
 *   con su mejor vuelta de esa parte. En las fechas dobles, la sesión define las dos grillas: una tabla por carrera
 *   en `class` ("Carrera 1", "Carrera 2").
 */
import { localToUtc, type ResultRow, type Session, type Source } from '@dm/shared';
import { HttpError } from '../core/http.ts';
import { classifySession } from '../core/builders.ts';
import { decodeEntities, textOf } from '../extract/html.ts';
import { normalizeForMatch } from '../validate.ts';
import { lapsLabel } from '../adapters/util.ts';
import { host, isoNow, pageOrNull } from './kit.ts';
import { isoDate, monthNumber } from './places.ts';
import type { CalendarEntry, RecipeContext, ResultsFound, SessionResultFound, SessionsFound } from './types.ts';

/** Id de cada campeonato en la API de resultados (campo oculto hdnSeries de las páginas de resultados). */
const SERIES_IDS: Record<string, string> = {
  'indycar.com': 'b856a4f1-e85c-4fac-8c36-fd58d962227a',
  'indynxt.com': '09341e09-3216-4f89-a45f-db697d72ee13',
};

/** Rótulo de la serie con que empiezan las sesiones del cronograma ("NTT INDYCAR SERIES - Practice 1"). */
const SERIES_LABEL: Record<string, RegExp> = {
  'indycar.com': /^(ntt\s+)?indycar(\s+series)?$/i,
  'indynxt.com': /^indy\s*nxt(\s+by\s+firestone)?$/i,
};

/** Actividades del cronograma que no son sesiones de pista (o no tienen resultado). */
const NOT_A_SESSION = /pre-?race|pit\s*stop|parade|autograph|ceremon|introduc|track\s*walk|concert|draw|celebrat|fan\s*fest/i;

const ZONES: Record<string, string> = {
  ET: 'America/New_York',
  CT: 'America/Chicago',
  MT: 'America/Denver',
  PT: 'America/Los_Angeles',
};

/** Sesión leída del cronograma de una página de fecha. */
export interface IndycarScheduleItem {
  /** Nombre sin el rótulo de la serie ("Practice 1", "Qualifying", "Race 2"). */
  name: string;
  startUtc: string;
  /** Links de resultados de la sesión (/results/{serie}/{año}/{evento}/{sesión}), si ya se corrió. */
  links: string[];
}

/** Nombre de la sesión sin el rótulo de la serie; null si es de otra serie o no es una sesión de pista. */
function sessionName(description: string, site: string, labelled: boolean): string | null {
  const text = description.replace(/\s+/g, ' ').trim();
  const m = text.match(/^(.+?)\s+[-–]\s+(.+)$/);
  let name = text;
  if (m && /indy|nxt|series/i.test(m[1]!)) {
    if (!SERIES_LABEL[site]?.test(m[1]!.trim())) return null;
    name = m[2]!.trim();
  } else if (labelled) {
    // La página rotula sus sesiones: lo que no lleva rótulo es de otra categoría o del programa del evento.
    return null;
  }
  if (NOT_A_SESSION.test(name)) return null;
  // "Fast Friday" (Indy 500) es la práctica del viernes.
  if (/fast\s+friday/i.test(name) && !/practi/i.test(name)) name = `${name} Practice`;
  return classifySession(name) === 'otro' ? null : name;
}

/** Hora "6:00PM ET" del día "Friday, Apr 17" → ISO UTC. */
function slotUtc(day: string, time: string, year: number): string | null {
  const d = day.match(/([A-Za-z]{3,})\.?\s+(\d{1,2})/);
  const t = time.match(/(\d{1,2})(?::(\d{2}))?\s*([AP])\.?M\.?\s*(ET|CT|MT|PT)?/i);
  if (!d || !t) return null;
  const month = monthNumber(d[1]!);
  const date = month ? isoDate(year, month, Number(d[2])) : null;
  if (!date) return null;
  let h = Number(t[1]) % 12;
  if (t[3]!.toUpperCase() === 'P') h += 12;
  const hhmm = `${String(h).padStart(2, '0')}:${t[2] ?? '00'}`;
  return localToUtc(date, hhmm, ZONES[(t[4] ?? 'ET').toUpperCase()]!);
}

/**
 * Sesiones de la tabla "Schedule" de una página de fecha. Las sesiones repetidas el mismo día (la práctica de las
 * 12 y de las 16 del Indy 500, que son dos ventanas de la misma sesión) se juntan en la primera.
 */
export function indycarSchedule(html: string, pageUrl: string, year: number): IndycarScheduleItem[] {
  const site = host(pageUrl);
  const start = html.indexOf('class="schedule-table"');
  if (start < 0) return [];
  const end = html.indexOf('collapsible-header', start);
  const table = html.slice(start, end > 0 ? end : undefined);
  const raw: { day: string; time: string; description: string; links: string[] }[] = [];
  let day = '';
  for (const m of table.matchAll(/<h3>([\s\S]*?)<\/h3>|<div class="schedule-entry">([\s\S]*?)(?=<h3>|<div class="schedule-entry">|$)/g)) {
    if (m[1] !== undefined) {
      day = textOf(m[1]);
      continue;
    }
    const block = m[2]!;
    const time = textOf(block.match(/class="schedule-time">([\s\S]*?)<\/div>/)?.[1] ?? '');
    const description = decodeEntities(textOf(block.match(/class="schedule-description">([\s\S]*?)<\/div>/)?.[1] ?? ''));
    const links = [...block.matchAll(/href="((?:https?:\/\/[^/"]+)?\/results\/[^"]+)"/gi)].map((l) => new URL(decodeEntities(l[1]!), pageUrl).toString());
    if (day && time && description) raw.push({ day, time, description, links });
  }
  const labelled = raw.some((r) => /^.+?\s+[-–]\s+/.test(r.description) && /indy|nxt|series/i.test(r.description.split(/\s+[-–]\s+/)[0]!));
  const out: IndycarScheduleItem[] = [];
  for (const r of raw) {
    const name = sessionName(r.description, site, labelled);
    const startUtc = name ? slotUtc(r.day, r.time, year) : null;
    if (!name || !startUtc) continue;
    const same = out.find((o) => o.name === name && o.startUtc.slice(0, 10) === startUtc.slice(0, 10));
    if (same) {
      if (startUtc < same.startUtc) same.startUtc = startUtc;
      same.links.push(...r.links.filter((l) => !same.links.includes(l)));
    } else out.push({ name, startUtc, links: [...r.links] });
  }
  return out;
}

/** Páginas de la fecha (las fechas dobles tienen una por carrera). */
function entryPages(entry: CalendarEntry): string[] {
  const pages = entry.meta?.pages?.split(/\s+/).filter(Boolean) ?? [];
  return pages.length ? pages : entry.url ? [entry.url] : [];
}

/** Cronograma de todas las páginas de la fecha, sin repetir las sesiones que figuran en más de una. */
async function weekendSchedule(entry: CalendarEntry, ctx: RecipeContext): Promise<{ items: IndycarScheduleItem[]; url: string } | null> {
  const year = Number(entry.dateEnd.slice(0, 4)) || ctx.season;
  const items: IndycarScheduleItem[] = [];
  let first: string | null = null;
  for (const url of entryPages(entry)) {
    const html = await pageOrNull(ctx, url);
    if (!html) continue;
    first ??= url;
    for (const it of indycarSchedule(html, url, year)) {
      const same = items.find((o) => o.name === it.name && o.startUtc === it.startUtc);
      if (same) same.links.push(...it.links.filter((l) => !same.links.includes(l)));
      else items.push(it);
    }
  }
  if (!first || items.length === 0) return null;
  items.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  return { items, url: first };
}

/** Cronograma de una fecha (dentro del horizonte o ya corrida): la tabla "Schedule" de sus páginas. */
export async function indycarSessions(entry: CalendarEntry, ctx: RecipeContext): Promise<SessionsFound | null> {
  const found = await weekendSchedule(entry, ctx);
  if (!found) return null;
  return {
    sessions: found.items.map((it) => ({
      name: it.name,
      startUtc: it.startUtc,
      localStartText: localTime(it.startUtc, entry.tz),
    })),
    source: { url: found.url, title: `Schedule — ${entry.name}`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) },
  };
}

function localTime(iso: string, zone: string): string {
  const d = new Date(iso);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('hour')}:${get('minute')}`;
}

// ─── API de resultados ─────────────────────────────────────────────────────────────────────────

interface ApiSession {
  EventsSessionID: string;
  SessionName: string;
}
interface ApiEvent {
  EventID: number;
  EventName: string;
  Sessions: ApiSession[];
}
interface ApiYear {
  Year: string;
  Events: ApiEvent[];
}
export interface ApiRecord {
  CarNumber?: string | null;
  DriverName?: string | null;
  TeamName?: string | null;
  PositionFinish?: number | null;
  ElapsedTime?: string | null;
  LapsComplete?: number | null;
  LapsDown?: number | null;
  BestLapTime?: string | null;
  Difference?: string | null;
  Status?: string | null;
  PointsEarned?: number | null;
  IsDeleted?: boolean;
}
export interface ApiSessionDetails {
  EventName?: string;
  SessionName?: string;
  SessionDate?: string;
  /** R carrera, Q clasificación, P práctica (incluye warmup). */
  SessionType?: string;
  records?: ApiRecord[];
}

/** Slug que usa el sitio en los links de resultados (mismo armado que su JavaScript). */
export const indycarSlug = (name: string) => name.trim().replaceAll(' ', '-').replaceAll("'", '').toLowerCase();

/** "01:59:29.6163" → "1:59:29.6163"; "00:51.6195" → "51.6195"; "01:09.1363" → "1:09.1363". */
export function apiTime(t: string | null | undefined): string | undefined {
  let s = (t ?? '').trim();
  if (!/^\d/.test(s) || /^--/.test(s)) return undefined;
  while (/^00:\d/.test(s) && s.split(':').length > 1) s = s.slice(3);
  return s.replace(/^0(\d)/, '$1');
}

function seconds(t: string | undefined): number | null {
  if (!t) return null;
  const parts = t.split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function gapLabel(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec - m * 60).toFixed(4);
  return m > 0 ? `+${m}:${s.padStart(7, '0')}` : `+${s}`;
}

/** Filas de una sesión de la API. */
export function indycarRows(details: ApiSessionDetails): ResultRow[] {
  const race = details.SessionType === 'R';
  const records = (details.records ?? []).filter((r) => !r.IsDeleted && r.DriverName?.trim());
  const rows: ResultRow[] = [];
  const timed = records.map((r) => apiTime(r.ElapsedTime));
  const leader = seconds(timed.find(Boolean));
  records.forEach((r, i) => {
    const row: ResultRow = { pos: r.PositionFinish ?? null, driver: r.DriverName!.trim() };
    if (r.CarNumber?.trim()) row.number = r.CarNumber.trim();
    if (r.TeamName?.trim()) row.team = r.TeamName.trim();
    const best = apiTime(r.BestLapTime);
    const diff = apiTime(r.Difference);
    if (race) {
      if (r.LapsComplete != null) row.laps = r.LapsComplete;
      if (i === 0 || row.pos === 1) {
        const t = apiTime(r.ElapsedTime);
        if (t) row.time = t;
      } else if ((r.LapsDown ?? 0) > 0) row.gap = lapsLabel(r.LapsDown!);
      else if (diff) row.gap = `+${diff}`;
      if (best) row.bestLap = best;
      if (r.PointsEarned != null) row.points = r.PointsEarned;
      const status = (r.Status ?? '').trim();
      if (status && !/^running$/i.test(status)) row.status = status;
    } else if (best) {
      // Práctica, warmup y clasificación en circuitos: mejor vuelta.
      row.bestLap = best;
      if (diff && row.pos !== 1) row.gap = `+${diff}`;
      if (r.LapsComplete != null) row.laps = r.LapsComplete;
    } else if (timed[i]) {
      // Clasificación en óvalos: tiempo total de las vueltas lanzadas (1 en Milwaukee, 2 en los óvalos cortos, 4 en Indianápolis).
      row.time = timed[i];
      const t = seconds(timed[i]);
      if (leader != null && t != null && t > leader) row.gap = gapLabel(t - leader);
    } else row.status = 'Sin tiempo';
    rows.push(row);
  });
  return rows;
}

/** Parte de la clasificación según el nombre de la sesión en la API, con su orden (mayor = más avanzada). */
function qualPart(name: string): { label: string; rank: number } {
  const n = name.toLowerCase();
  if (/fast\s*6|fast\s*six/.test(n)) return { label: 'Firestone Fast 6', rank: 3 };
  if (/top[\s-]*12|fast\s*12/.test(n)) return { label: 'Fast 12', rank: 2 };
  if (/round\s*2/.test(n)) return { label: 'Ronda 2 (Fast 12)', rank: 2 };
  const group = n.match(/group\s*(\d)/)?.[1];
  if (group) return { label: /round\s*1/.test(n) ? `Ronda 1 · Grupo ${group}` : `Grupo ${group}`, rank: 1 };
  return { label: '', rank: 0 };
}

const sameDriver = (a: ResultRow, b: ResultRow) => a.driver === b.driver && (a.number ?? '') === (b.number ?? '');

/**
 * Clasificación de una grilla armada con sus partes: la combinada da el orden final; cada fila lleva en class/classPos
 * la parte en la que el piloto quedó (Fast 6, Ronda 2, su grupo) y la mejor vuelta y diferencia de esa parte.
 * Sin combinada, el orden sale de las partes (Fast 6, después Ronda 2, después los grupos por puesto).
 */
export function combineQualifying(parts: { name: string; rows: ResultRow[] }[]): ResultRow[] {
  const combined = parts.find((p) => /^combined/i.test(p.name.trim()));
  const segments = parts
    .filter((p) => p !== combined)
    .map((p) => ({ ...qualPart(p.name), rows: p.rows }))
    .filter((p) => p.rank > 0 && p.rows.length > 0);
  if (segments.length === 0) return combined?.rows ?? parts.find((p) => p.rows.length)?.rows ?? [];
  let base = combined?.rows;
  if (!base?.length) {
    const seen: ResultRow[] = [];
    for (const seg of [...segments].sort((a, b) => b.rank - a.rank || a.label.localeCompare(b.label))) {
      const fresh = seg.rows.filter((r) => !seen.some((s) => sameDriver(s, r)));
      seen.push(...fresh);
    }
    // Los eliminados en la primera ronda se intercalan por su puesto en el grupo.
    const top = seen.filter((r) => segments.some((s) => s.rank > 1 && s.rows.some((x) => sameDriver(x, r))));
    const rest = seen.filter((r) => !top.includes(r)).sort((a, b) => (a.pos ?? 99) - (b.pos ?? 99));
    base = [...top, ...rest].map((r, i) => ({ ...r, pos: i + 1 }));
  }
  return base.map((row) => {
    let best: { label: string; rank: number; row: ResultRow } | null = null;
    for (const seg of segments) {
      const r = seg.rows.find((x) => sameDriver(x, row));
      if (r && (!best || seg.rank > best.rank)) best = { label: seg.label, rank: seg.rank, row: r };
    }
    if (!best) return row;
    const out: ResultRow = { pos: row.pos, driver: row.driver };
    if (row.number) out.number = row.number;
    if (row.team) out.team = row.team;
    const seg = best.row;
    if (seg.bestLap) out.bestLap = seg.bestLap;
    if (seg.time) out.time = seg.time;
    if (seg.gap) out.gap = seg.gap;
    if (seg.laps != null) out.laps = seg.laps;
    if (seg.status ?? row.status) out.status = seg.status ?? row.status;
    out.class = best.label;
    if (seg.pos != null) out.classPos = seg.pos;
    return out;
  });
}

/** Grilla a la que pertenece una parte de la clasificación en una fecha doble ("Qualifying - Race 2 Group 1"). */
function gridOf(sessionName: string, eventName: string): string {
  return sessionName.match(/race\s*(\d)/i)?.[1] ?? eventName.match(/race\s*(\d)\s*$/i)?.[1] ?? '';
}

function isTransient(err: unknown): boolean {
  if (err instanceof HttpError) return err.status === 429 || err.status >= 500;
  // Sin respuesta (timeout, conexión cortada).
  return err instanceof Error && /timeout|abort|fetch failed|ECONN|socket/i.test(`${err.name} ${err.message}`);
}

const resultsUrl = (origin: string, seriesSlug: string, season: number, event: string, session: string) =>
  `${origin}/results/${seriesSlug}/${season}/${indycarSlug(event)}/${indycarSlug(session)}`;

/**
 * Resultados de una fecha: cada sesión pedida se une con su fila del cronograma (por nombre y hora) y de ahí, por el
 * link de resultados, con la sesión de la API. null si la fecha todavía no tiene ningún resultado publicado.
 */
export async function indycarResults(entry: CalendarEntry, sessions: Session[], ctx: RecipeContext): Promise<ResultsFound | null> {
  const site = host(entry.url ?? ctx.series.officialUrls[0] ?? '');
  const seriesId = SERIES_IDS[site];
  if (!seriesId) throw new Error(`Sitio sin id de serie conocido: ${site}`);
  const schedule = await weekendSchedule(entry, ctx);
  const links = schedule?.items.flatMap((it) => it.links) ?? [];
  if (!schedule || links.length === 0) return null;
  const origin = new URL(links[0]!).origin;
  const seriesSlug = new URL(links[0]!).pathname.split('/')[2] ?? '';
  const season = Number(entry.dateEnd.slice(0, 4)) || ctx.season;

  const years = (await ctx.http.json<ApiYear[]>(`${origin}/api/results/SeasonDropDown?id=${seriesId}`)).body;
  const events = years.find((y) => y.Year === String(season))?.Events ?? [];
  // Eventos de la API de esta fecha: los que enlazan sus páginas (uno por carrera en las fechas dobles).
  const linkParts = links.map((l) => new URL(l).pathname.split('/').map((p) => decodeURIComponent(p).toLowerCase()));
  const mine = events.filter((e) => linkParts.some((p) => p[4] === indycarSlug(e.EventName)));
  if (mine.length === 0) return null;

  const details = new Map<string, Promise<ApiSessionDetails>>();
  const fetchDetails = (id: string) => {
    let p = details.get(id);
    if (!p) {
      p = ctx.http.json<ApiSessionDetails>(`${origin}/api/results/EventsSessionDetails?id=${id}`).then((r) => r.body);
      details.set(id, p);
    }
    return p;
  };
  const byLink = (link: string): { event: ApiEvent; session: ApiSession } | null => {
    const p = new URL(link).pathname.split('/').map((x) => decodeURIComponent(x).toLowerCase());
    const event = mine.find((e) => indycarSlug(e.EventName) === p[4]);
    const session = event?.Sessions.find((s) => indycarSlug(s.SessionName) === p[5]);
    return event && session ? { event, session } : null;
  };

  const found: SessionResultFound[] = [];
  const deferred: string[] = [];
  const fetchedAt = isoNow(ctx.now);
  for (const s of sessions) {
    const name = normalizeForMatch(s.originalName ?? s.name);
    const items = schedule.items.filter((it) => normalizeForMatch(it.name) === name);
    const item = items.sort((a, b) => Math.abs(Date.parse(a.startUtc) - Date.parse(s.startUtc)) - Math.abs(Date.parse(b.startUtc) - Date.parse(s.startUtc)))[0];
    if (!item) continue;
    try {
      let rows: ResultRow[] = [];
      let source: Source | undefined;
      if (/^qualif\w*$/i.test(item.name.trim())) {
        // Clasificación completa: todas sus partes, en todas las carreras de la fecha.
        const parts = mine.flatMap((e) =>
          e.Sessions.filter((x) => /^(combined\s+)?qualif/i.test(x.SessionName.trim())).map((x) => ({ event: e, session: x })),
        );
        const grids = new Map<string, { name: string; rows: ResultRow[] }[]>();
        for (const p of parts) {
          const d = await fetchDetails(p.session.EventsSessionID);
          const key = gridOf(p.session.SessionName, p.event.EventName);
          grids.set(key, [...(grids.get(key) ?? []), { name: p.session.SessionName, rows: indycarRows(d) }]);
        }
        const keys = [...grids.keys()].sort();
        for (const key of keys) {
          const grid = combineQualifying(grids.get(key)!);
          if (keys.length === 1) rows.push(...grid);
          else
            for (const r of grid) {
              const { classPos: _c, ...rest } = r;
              rows.push({ ...rest, class: `Carrera ${key}`, ...(r.pos != null ? { classPos: r.pos } : {}) });
            }
        }
        const link = item.links[0] ?? (parts[0] ? resultsUrl(origin, seriesSlug, season, parts[0].event.EventName, parts[0].session.SessionName) : undefined);
        if (link) source = { url: link, title: `Resultados — ${mine[0]!.EventName} — Qualifying`, kind: 'api', method: 'directo', fetchedAt };
      } else {
        const target = item.links.map(byLink).find(Boolean) ?? fallbackSession(item.name, mine);
        if (!target) continue;
        const d = await fetchDetails(target.session.EventsSessionID);
        rows = indycarRows(d);
        source = {
          url: resultsUrl(origin, seriesSlug, season, target.event.EventName, target.session.SessionName),
          title: `Resultados — ${target.event.EventName} — ${target.session.SessionName}`,
          kind: 'api',
          method: 'directo',
          fetchedAt,
        };
      }
      if (rows.length > 0) found.push({ sessionId: s.id, rows, ...(source ? { source } : {}) });
    } catch (err) {
      if (isTransient(err)) deferred.push(s.id);
      else throw err;
    }
  }
  return {
    sessions: found,
    source: { url: schedule.url, title: `Resultados — ${entry.name}`, kind: 'html', method: 'directo', fetchedAt },
    ...(deferred.length ? { deferred } : {}),
  };
}

/** Sesión de la API para una sesión del cronograma sin link de resultados: mismo nombre en los eventos de la fecha. */
function fallbackSession(name: string, events: ApiEvent[]): { event: ApiEvent; session: ApiSession } | null {
  const n = normalizeForMatch(name);
  const race = n.match(/^race\s*(\d)$/)?.[1];
  const hits = events.flatMap((event) =>
    event.Sessions.filter((s) => {
      const sn = normalizeForMatch(s.SessionName);
      if (race) return sn === 'race' && gridOf('', event.EventName) === race;
      return sn === n;
    }).map((session) => ({ event, session })),
  );
  return hits.length === 1 ? hits[0]! : null;
}

export const _test = { slotUtc, sessionName };
