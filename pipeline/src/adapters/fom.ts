/**
 * Ayudantes comunes para los sitios oficiales de la plataforma de Formula One Management
 * (formula1.com, fiaformula2.com y fiaformula3.com). Los tres son apps Next.js que envían los
 * datos de la ronda dentro del payload RSC (`self.__next_f.push([1,"…"])`): el objeto `race`
 * trae `meetingSessions[]` con hora local, offset GMT, zona IANA y estado de cada sesión.
 */
import { parse, type HTMLElement } from 'node-html-parser';
import {
  localToUtc,
  toUtcIso,
  type MotorEvent,
  type ResultRow,
  type Series,
  type Session,
  type SessionType,
  type Source,
} from '@dm/shared';
import { classifySession } from '../core/builders.ts';
import { HttpError } from '../core/http.ts';
import type { AdapterContext } from '../core/types.ts';

export interface FomResultRow {
  completionStatusCode?: string | null;
  racePoints?: number | null;
  positionValue?: string | null;
  positionNumber?: string | null;
  displayPosition?: string | null;
  lapsCompleted?: string | null;
  racingNumber?: string | null;
  driverFirstName?: string | null;
  driverLastName?: string | null;
  driverShortName?: string | null;
  teamName?: string | null;
  displayTeamName?: string | null;
  displayTime?: string | null;
  raceTime?: string | null;
}

export interface FomSession {
  /** Código de sesión: "p1", "q", "ss", "s", "r" (F1) o "Practice 0", "Race 2"… (F2/F3). */
  session: string;
  shortName?: string;
  description?: string;
  /** Hora local del circuito, "YYYY-MM-DDTHH:mm:ss" sin offset. */
  startTime?: string;
  endTime?: string;
  /** Offset del circuito ese día, "+03:00". */
  gmtOffset?: string;
  sessionType?: string;
  sessionNumber?: number;
  /** "TBC" mientras el organizador no publicó el horario. */
  sessionStatus?: string;
  state?: string;
  meetingSessionKey?: number;
  timezone?: string;
  /** F2/F3: "f2/race?meeting=1301&session=2". */
  value?: string;
  isAvailable?: boolean;
  /** F2/F3: resultados embebidos (solo la última sesión con resultados). */
  results?: FomResultRow[];
}

export interface FomMeeting {
  meetingSessions: FomSession[];
  season?: string;
  meetingNumber?: string;
  meetingName: string;
  meetingOfficialName?: string;
  meetingCode?: string;
  meetingStartDate?: string;
  meetingEndDate?: string;
  meetingLocation?: string;
  isTestEvent?: boolean;
  circuitShortName?: string;
  circuitOfficialName?: string;
  circuitLocation?: string;
  meetingKey?: string;
  meetingCountryName?: string;
  meetingTimezone?: string;
  url?: string;
  trackStats?: { circuitCountry?: string };
}

/** ISO UTC sin milisegundos, como exige Source.fetchedAt. */
export function isoNow(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function htmlSource(url: string, title: string, ctx: AdapterContext): Source {
  return { url, title, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) };
}

/** Concatena los fragmentos del payload RSC de Next.js embebidos en el HTML. */
export function decodeRscPayload(html: string): string {
  const re = /self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g;
  let out = '';
  for (const m of html.matchAll(re)) {
    try {
      out += JSON.parse(`"${m[1]}"`) as string;
    } catch {
      // fragmento no decodificable: se ignora
    }
  }
  return out;
}

/** Lee el valor JSON (objeto o arreglo) que empieza en `start`, respetando strings y escapes. */
export function readJsonValue<T = unknown>(text: string, start: number): T {
  const open = text[start];
  if (open !== '{' && open !== '[') throw new Error(`Se esperaba JSON en la posición ${start}`);
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1)) as T;
    }
  }
  throw new Error('JSON sin cerrar en el payload');
}

/**
 * Busca `anchor` en el texto y devuelve el JSON que empieza en anchor + offset.
 * Devuelve null si el ancla no aparece.
 */
export function extractJson<T>(text: string, anchor: string, offset: number): T | null {
  const idx = text.indexOf(anchor);
  if (idx < 0) return null;
  return readJsonValue<T>(text, idx + offset);
}

/** Objeto `race` (meeting) de una página de ronda. */
export function extractMeeting(html: string): FomMeeting | null {
  const rsc = decodeRscPayload(html);
  const anchor = '"race":{"meetingSessions"';
  return extractJson<FomMeeting>(rsc, anchor, '"race":'.length);
}

/** Pares (slug, ronda) en el orden en que aparecen en la página de calendario. */
export function calendarSlugs(html: string, season: number): Array<{ slug: string; round?: number }> {
  const re = new RegExp(`ROUND\\s+(\\d+)|href="/en/racing/${season}/([a-z0-9-]+)"`, 'gi');
  const seen = new Map<string, { slug: string; round?: number }>();
  let pendingRound: number | undefined;
  for (const m of html.matchAll(re)) {
    if (m[1]) {
      pendingRound = Number(m[1]);
      continue;
    }
    const slug = m[2]!.toLowerCase();
    const entry = seen.get(slug);
    if (!entry) seen.set(slug, { slug, ...(pendingRound !== undefined ? { round: pendingRound } : {}) });
    else if (entry.round === undefined && pendingRound !== undefined) entry.round = pendingRound;
    pendingRound = undefined;
  }
  return [...seen.values()];
}

export interface SessionTimes {
  startUtc: string;
  endUtc?: string;
  localStartText: string;
  localDate: string;
}

const UNPUBLISHED = /tbc|tba|tbd|cancel|postpon|abandon/i;

/**
 * Horario de una sesión. Usa el offset GMT publicado; si falta, convierte la hora local con la
 * zona IANA del circuito (respeta horario de verano). Devuelve null si la sesión no tiene
 * horario publicado ("TBC") o fue cancelada.
 */
export function sessionTimes(s: FomSession, tz: string): SessionTimes | null {
  if (s.sessionStatus && UNPUBLISHED.test(s.sessionStatus)) return null;
  const start = s.startTime?.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  if (!start) return null;
  const toUtc = (local: string): string | undefined => {
    const m = local.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?/);
    if (!m) return undefined;
    if (s.gmtOffset && /^[+-]\d{2}:\d{2}$/.test(s.gmtOffset)) {
      return toUtcIso(`${m[1]}T${m[2]}:${m[3] ?? '00'}${s.gmtOffset}`);
    }
    return localToUtc(m[1]!, m[2]!, s.timezone || tz);
  };
  const startUtc = toUtc(s.startTime!)!;
  let endUtc = s.endTime ? toUtc(s.endTime) : undefined;
  if (endUtc && endUtc <= startUtc) endUtc = undefined;
  return { startUtc, ...(endUtc ? { endUtc } : {}), localStartText: start[2]!, localDate: start[1]! };
}

export interface MeetingBuild {
  event: MotorEvent;
  sessions: Session[];
  /** id de nuestra sesión -> sesión de la fuente (para pedir resultados). */
  bySessionId: Map<string, FomSession>;
}

export interface MeetingBuildOptions {
  series: Series;
  ctx: AdapterContext;
  meeting: FomMeeting;
  key: string;
  round?: number;
  source: Source;
  name?: string;
  sessionName(s: FomSession): string;
  sessionType?(s: FomSession): SessionType;
  /** Filtro adicional (p. ej. que la sesión sea de la categoría pedida). */
  accept?(s: FomSession): boolean;
  /** Tipo de evento si la fuente lo informa (ensayos); si falta, se deduce del nombre. */
  kind?: MotorEvent['kind'];
}

/** Convierte un meeting de la fuente en evento + sesiones con ids estables. */
export function buildMeeting(o: MeetingBuildOptions): MeetingBuild {
  const { meeting: m, ctx } = o;
  const tz = m.meetingTimezone || m.meetingSessions.find((s) => s.timezone)?.timezone;
  if (!tz) throw new Error(`La ronda ${o.key} no informa la zona horaria del circuito`);

  const timed = m.meetingSessions
    .filter((s) => !o.accept || o.accept(s))
    .map((s) => ({ s, t: sessionTimes(s, tz) }))
    .filter((x): x is { s: FomSession; t: SessionTimes } => x.t !== null);

  const dates = [
    m.meetingStartDate?.slice(0, 10),
    m.meetingEndDate?.slice(0, 10),
    ...timed.map((x) => x.t.localDate),
  ].filter((d): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (dates.length === 0) throw new Error(`La ronda ${o.key} no informa fechas`);
  dates.sort();

  const event = ctx.build.event({
    series: o.series,
    season: ctx.season,
    key: o.key,
    name: o.name ?? m.meetingName,
    ...(o.round !== undefined ? { round: o.round } : {}),
    circuit: m.circuitOfficialName || m.circuitShortName || m.meetingLocation || o.key,
    country: m.trackStats?.circuitCountry || m.meetingCountryName || '',
    tz,
    dateStart: dates[0]!,
    dateEnd: dates.at(-1)!,
    sessionsStatus: timed.length > 0 ? 'published' : 'pending',
    ...(o.kind ? { kind: o.kind } : {}),
    source: o.source,
  });

  const names = timed.map((x) => o.sessionName(x.s));
  const sessions: Session[] = [];
  const bySessionId = new Map<string, FomSession>();
  timed.forEach(({ s, t }, i) => {
    const name = names[i]!;
    const duplicated = names.indexOf(name) !== names.lastIndexOf(name);
    const session = ctx.build.session({
      event,
      type: o.sessionType ? o.sessionType(s) : classifyFom(s),
      name,
      startUtc: t.startUtc,
      ...(t.endUtc ? { endUtc: t.endUtc } : {}),
      localStartText: t.localStartText,
      source: o.source,
      ...(duplicated ? { key: s.session } : {}),
    });
    sessions.push(session);
    bySessionId.set(session.id, s);
  });
  return { event, sessions, bySessionId };
}

/** Tipo de sesión a partir de la descripción y el nombre corto de la fuente. */
export function classifyFom(s: FomSession): SessionType {
  const text = [s.description, s.shortName].filter(Boolean).join(' ');
  const t = classifySession(text);
  if (t !== 'otro') return t;
  if (/^practice/i.test(s.sessionType ?? '')) return 'practica';
  if (/^qualifying/i.test(s.sessionType ?? '')) return 'clasificacion';
  if (/^race/i.test(s.sessionType ?? '')) return 'carrera';
  return 'otro';
}

/** Ejecuta fn sobre items con concurrencia limitada, preservando el orden. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Lee una página; devuelve null en 404 (página de resultados todavía inexistente). */
export async function fetchOptional(ctx: AdapterContext, url: string): Promise<string | null> {
  try {
    return (await ctx.http.text(url)).body;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Tablas HTML (resultados y campeonatos de formula1.com)

export interface HtmlTable {
  headers: string[];
  rows: string[][];
}

/** Texto visible de una celda, sin la sigla de 3 letras que formula1.com muestra solo en móvil. */
function cellText(td: HTMLElement): string {
  for (const el of td.querySelectorAll('span')) {
    if (el.classList.contains('md:hidden')) el.remove();
  }
  return td.text.replace(/\s+/g, ' ').trim();
}

export function parseHtmlTables(html: string): HtmlTable[] {
  const root = parse(html);
  return root.querySelectorAll('table').map((table) => {
    const headers = table.querySelectorAll('thead th').map((th) => th.text.replace(/\s+/g, ' ').trim());
    const rows = table
      .querySelectorAll('tbody tr')
      .map((tr) => tr.querySelectorAll('td').map(cellText))
      .filter((r) => r.length > 0);
    return { headers, rows };
  });
}

/** Busca la columna cuyo encabezado coincide con alguna expresión. */
export function columnIndex(headers: string[], ...patterns: RegExp[]): number {
  return headers.findIndex((h) => patterns.some((p) => p.test(h)));
}

const STATUS_RE = /^(DNF|DNS|DSQ|DQ|NC|EX|EXC|DNQ|DNPQ|RET|Retired)$/i;

/** Mapea una fila de una tabla de resultados de formula1.com por nombre de columna. */
export function htmlResultRows(table: HtmlTable): ResultRow[] {
  const h = table.headers;
  const iPos = columnIndex(h, /^pos/i);
  const iNo = columnIndex(h, /^no\.?$/i);
  const iDriver = columnIndex(h, /^driver/i);
  const iTeam = columnIndex(h, /^team|^car/i);
  const iLaps = columnIndex(h, /^laps/i);
  const iTime = columnIndex(h, /^time/i);
  const iPts = columnIndex(h, /^pts|^points/i);
  const qCols = h
    .map((x, i) => ({ x, i }))
    .filter(({ x }) => /^S?Q\d$/i.test(x))
    .map(({ i }) => i);
  if (iDriver < 0) return [];

  const rows: ResultRow[] = [];
  for (const r of table.rows) {
    const driver = r[iDriver] ?? '';
    if (!driver) continue;
    const posText = iPos >= 0 ? (r[iPos] ?? '') : '';
    const pos = /^\d+$/.test(posText) && Number(posText) > 0 ? Number(posText) : null;
    const row: ResultRow = { pos, driver };
    if (pos === null && posText) row.status = posText;
    if (iNo >= 0 && r[iNo]) row.number = r[iNo];
    if (iTeam >= 0 && r[iTeam]) row.team = r[iTeam];
    if (iLaps >= 0 && /^\d+$/.test(r[iLaps] ?? '')) row.laps = Number(r[iLaps]);
    let timeText = iTime >= 0 ? (r[iTime] ?? '') : '';
    if (!timeText && qCols.length > 0) {
      // Clasificación: mejor tiempo de la última ronda disputada (Q3 > Q2 > Q1).
      timeText = [...qCols].reverse().map((i) => r[i] ?? '').find((t) => /\d/.test(t)) ?? '';
    }
    if (timeText) {
      if (timeText.startsWith('+')) row.gap = timeText;
      // formula1.com pone "NC" en la posición tanto del que abandonó como del que no largó; cuál de los dos está en
      // la columna del tiempo ("DNF", "DNS"). Ese dato más preciso reemplaza al "NC" (no a un "DQ").
      else if (STATUS_RE.test(timeText)) row.status = row.status && row.status !== 'NC' ? row.status : timeText.toUpperCase();
      else row.time = timeText;
    }
    if (iPts >= 0 && r[iPts] && !Number.isNaN(Number(r[iPts]))) row.points = Number(r[iPts]);
    rows.push(row);
  }
  return rows;
}

/** Mapea filas de resultados embebidas en el payload de F2/F3. */
export function fomResultRows(results: FomResultRow[]): ResultRow[] {
  const rows: ResultRow[] = [];
  for (const x of results) {
    const driver = [x.driverFirstName, x.driverLastName].filter(Boolean).join(' ').trim() || x.driverShortName || '';
    if (!driver) continue;
    const posText = x.positionValue ?? '';
    const pos = /^\d+$/.test(posText) && Number(posText) > 0 ? Number(posText) : null;
    const row: ResultRow = { pos, driver };
    const code = x.completionStatusCode && x.completionStatusCode !== 'OK' ? x.completionStatusCode : undefined;
    if (pos === null) row.status = code ?? x.displayPosition ?? 'NC';
    else if (code) row.status = code;
    if (x.racingNumber) row.number = x.racingNumber;
    const team = x.displayTeamName || x.teamName;
    if (team) row.team = team;
    if (x.lapsCompleted && /^\d+$/.test(x.lapsCompleted)) row.laps = Number(x.lapsCompleted);
    const t = x.displayTime ?? '';
    if (t.startsWith('+')) row.gap = t;
    else if (t && STATUS_RE.test(t)) row.status = row.status ?? t.toUpperCase();
    else if (t) row.time = t;
    if (typeof x.racePoints === 'number') row.points = x.racePoints;
    rows.push(row);
  }
  return rows;
}
