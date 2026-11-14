/**
 * 24H Series (Creventic): resultados desde la página oficial de cada carrera (www.24hseries.com/races/<slug>, la
 * URL del evento en el calendario). Su bloque "raceResultsOverviewBlock" tiene un contenedor por campeonato del
 * fin de semana ("Michelin 24H SERIES", "24H SERIES ME-TROPHY", y soportes como Radical o los track days, que no se
 * leen) y un renglón por sesión con el día y la hora local ("Fri-16:10"), el nombre ("Qualifying 1 - Classes GT3",
 * "Race Part 2") y los PDF de resultados (overall / per class) que publica el cronometrador (TimeService,
 * resultscdn.getraceresults.com).
 *
 * El PDF "overall" trae Pos, Nbr, Cls y S.Cls (clase y subclase: GT3 + AM / P/A), equipo, auto y, debajo, los
 * apellidos de la tripulación unidos por guiones; en carrera, las vueltas ("-- 741 laps --") o la diferencia, la
 * vuelta rápida y el tiempo total; los no clasificados figuran con "DNC". El texto de estos PDF viene con espacios
 * de más dentro de las palabras ("Rac ing", "1:41.2 07"), que se corrigen. Los nombres completos de los pilotos
 * salen de la lista de inscriptos de la misma página (por número de auto); si el evento no la publica con pilotos
 * (Barcelona 2026), del PDF "fastest drivers" de la carrera, que nombra a cada piloto con su auto.
 */
import { localToUtc, type ResultRow, type RosterRow, type Session } from '@dm/shared';
import { pdfTextItems, type PdfItem } from '../adapters/fia-documents.ts';
import { textOf } from '../extract/html.ts';
import { creventicEntryList } from './creventic.ts';
import { shiftDate } from './places.ts';
import { stripComments } from './kit.ts';
import { directSource, fillClassPositions, isTransient, lapsGap, pdfLines, pickSession, timeGap, type SourceSession } from './results-euro.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, ResultsFound, SessionResultFound, SessionsFound } from './types.ts';

export interface CreventicSession {
  name: string;
  /** "Fri-16:10" */
  when: string;
  url: string;
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&#0?39;/g, "'").replace(/&quot;/g, '"');

/** "RACE PART 1 - MICHELIN 12H MUGELLO 2026" -> "Race Part 1"; el resto queda como lo publica el sitio. */
export function creventicSessionName(raw: string): string {
  const t = decode(textOf(raw)).replace(/\s+/g, ' ').trim();
  const part = t.match(/^race\s*part\s*(\d)/i);
  if (part) return `Race Part ${part[1]}`;
  return t;
}

/** Sesiones del campeonato principal en el bloque de resultados de la página de una carrera. */
export function creventicResultSessions(html: string): CreventicSession[] {
  const out: CreventicSession[] = [];
  for (const block of stripComments(html).split('class="raceResultsContainer"').slice(1)) {
    const series = textOf(block.match(/<span class="series">([\s\S]*?)<\/span>/)?.[1] ?? '');
    if (!/24h\s*series/i.test(series)) continue;
    for (const r of block.split(/<div class="result[\s"]/).slice(1)) {
      const cols = [...r.matchAll(/<div class="col[^"]*"[^>]*>([\s\S]*?)<\/div>/g)].map((m) => m[1]!);
      const when = textOf(cols[0] ?? '');
      const name = creventicSessionName(cols[1] ?? '');
      if (!/^[a-z]{3}-\d{1,2}:\d{2}$/i.test(when) || !name || /half\s*way|per\s*hour|after\s*\d+\s*hours?/i.test(name)) continue;
      const overall = [...r.matchAll(/<a\b[^>]*href="([^"]+\.pdf)"[^>]*>\s*overall\s*<\/a>/gi)][0]?.[1];
      if (!overall) continue;
      out.push({ name, when, url: decode(overall) });
    }
  }
  return out;
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** "Fri-16:10" -> hora UTC, con el día de la semana dentro de las fechas del evento (o hasta 3 días antes). */
export function creventicStart(when: string, entry: Pick<CalendarEntry, 'dateStart' | 'dateEnd' | 'tz'>): string | null {
  const m = when.match(/^([a-z]{3})-(\d{1,2}:\d{2})$/i);
  const wd = m ? WEEKDAYS.indexOf(m[1]!.toLowerCase()) : -1;
  if (wd < 0) return null;
  for (let d = entry.dateEnd; d >= shiftDate(entry.dateStart, -3); d = shiftDate(d, -1)) {
    if (new Date(`${d}T12:00:00Z`).getUTCDay() === wd) return localToUtc(d, m![2]!, entry.tz);
  }
  return null;
}

function sourceSessions(list: CreventicSession[], entry: CalendarEntry): Array<SourceSession & { url: string }> {
  return list.flatMap((s) => {
    const startUtc = creventicStart(s.when, entry);
    return startUtc ? [{ name: s.name, startUtc, url: s.url }] : [];
  });
}

export async function creventicPastSessions(entry: CalendarEntry, ctx: RecipeContext): Promise<SessionsFound | null> {
  if (!entry.url) return null;
  const found = sourceSessions(creventicResultSessions((await ctx.http.text(entry.url)).body), entry);
  if (found.length === 0) return null;
  const sessions: ExtractedSession[] = found.map((s) => ({ name: s.name, startUtc: s.startUtc! })).sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  return { sessions, source: directSource(entry.url, `Resultados 24H Series — ${entry.name}`, 'html', ctx) };
}

// ─── PDF ──────────────────────────────────────────────────────────────────────────────────────

const PARTICLES = new Set(['de', 'da', 'di', 'du', 'van', 'von', 'der', 'den', 'del', 'della']);

/**
 * Quita los espacios que el PDF mete dentro de palabras y números: "Rac ing" -> "Racing", "1:41.2 07" -> "1:41.207",
 * "Kikires hko" -> "Kikireshko", "T im H einemann" -> "Tim Heinemann". Un espacio antes de una minúscula se quita,
 * salvo que empiece una partícula de apellido ("Kumar-de Breucker", "van der Linde").
 */
export function fixSpacing(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (/^[\d\s:.,]+$/.test(t)) return t.replace(/\s+/g, '');
  return t
    .replace(/(\d) (?=[\d:.])|([:.]) (?=\d)/g, '$1$2')
    .replace(/ (?=([a-zà-ÿ][\p{L}]*))/gu, (sp, word: string) => (PARTICLES.has(word) ? sp : ''))
    // Siglas partidas: "Mercedes-A MG GT 3 E VO" -> "Mercedes-AMG GT3 EVO", "BMW M 4" -> "BMW M4".
    .replace(/(^|[\s-])([A-Z]) (?=[A-Z]{2,}\b)/g, '$1$2')
    .replace(/\b(GT|M) (?=\d)/g, '$1');
}

interface Cols {
  nbr: number;
  cls: number;
  scls: number;
  team: number;
  car: number;
  gap?: number;
  fastest?: number;
  laps?: number;
  race: boolean;
}

/** Columnas del encabezado (dos renglones: "Cls / S.Cls / … Race Time" y "Pos Nbr / PIC / PISC / Team name / Car / Drivers…"). */
function header(page: PdfItem[]): { cols: Cols; y: number } | null {
  const pos = page.find((i) => /^pos(\s+nbr)?$/i.test(i.s));
  if (!pos) return null;
  const near = page.filter((i) => i.y >= pos.y - 3 && i.y <= pos.y + 25);
  const x = (re: RegExp) => near.find((i) => re.test(i.s))?.x;
  const nbrItem = near.find((i) => /^nbr$/i.test(i.s));
  const nbr = nbrItem ? nbrItem.x : pos.x + (pos.w * 4) / 7;
  const cls = x(/^(cls|pic)$/i);
  const scls = x(/^(s\.cls|pisc)$/i);
  const team = x(/^team/i);
  const car = x(/^car/i);
  if (cls === undefined || scls === undefined || team === undefined || car === undefined) return null;
  const race = near.some((i) => /race\s*time/i.test(i.s));
  const fastest = x(/^fastest/i);
  const gap = x(/^gap$/i);
  const laps = x(/^laps$/i);
  return {
    y: pos.y,
    cols: { nbr, cls, scls, team, car, race, ...(fastest !== undefined ? { fastest } : {}), ...(gap !== undefined ? { gap } : {}), ...(laps !== undefined ? { laps } : {}) },
  };
}

const SUBCLASS: Record<string, string> = { AM: 'Am', 'P/A': 'Pro-Am', PA: 'Pro-Am', PRO: 'Pro', TCX: 'TCX' };

export interface CreventicPdfRow extends ResultRow {
  /** Apellidos de la tripulación según el PDF (para unir con los nombres completos). */
  surnames: string[];
}

/** Clasificación general de un PDF "overall" de Creventic. [] si no tiene la tabla. */
export function parseCreventicItems(raw: PdfItem[]): CreventicPdfRow[] {
  const items = raw.map((i) => ({ ...i, s: fixSpacing(i.s) }));
  const rows: CreventicPdfRow[] = [];
  let leaderLaps: number | undefined;
  let groupLaps: number | undefined;
  for (const p of [...new Set(items.map((i) => i.page))].sort((a, b) => a - b)) {
    const page = items.filter((i) => i.page === p);
    const head = header(page);
    if (!head) continue;
    const { cols } = head;
    const stop = page.find((i) => /^fastest time/i.test(i.s))?.y ?? -Infinity;
    const body = page.filter((i) => i.y < head.y - 3 && i.y > stop + 1);
    // El número del auto es el entero más a la derecha antes de la clase (a su izquierda puede estar el puesto).
    const anchors = body
      .filter((i) => /^\d+$/.test(i.s) && i.x >= cols.nbr - 12 && i.x < cols.cls - 8)
      .filter((i, _, all) => !all.some((o) => o !== i && Math.abs(o.y - i.y) <= 2.5 && o.x > i.x))
      .sort((a, b) => b.y - a.y);
    const tailStart = Math.min(cols.gap ?? Infinity, cols.fastest ?? Infinity, cols.car + 100);
    for (const [k, a] of anchors.entries()) {
      const nextY = anchors[k + 1]?.y ?? stop;
      const line = body.filter((i) => Math.abs(i.y - a.y) <= 2.5);
      const posItem = line.find((i) => i.x < cols.nbr - 6 && /^(\d+|DNC|DNS|DSQ|DQ|NC)$/i.test(i.s));
      const inCol = (i: PdfItem, from: number, to: number) => i.x >= from && i.x < to;
      const cls = line.find((i) => inCol(i, cols.cls - 6, cols.scls - 4) && /\p{L}|\d{3}/u.test(i.s) && !/^\d{1,2}$/.test(i.s))?.s;
      const scls = body.find((i) => Math.abs(i.y - a.y) <= 2.5 && inCol(i, cols.scls - 6, cols.team - 4) && /^[A-Z/]+$/.test(i.s))?.s;
      const team = line.find((i) => inCol(i, cols.team - 4, cols.car - 6))?.s;
      const carCol = (i: PdfItem) => inCol(i, cols.car - 8, tailStart - 15);
      const car = body.find((i) => carCol(i) && i.y >= a.y - 2.5 && i.y <= a.y + 4)?.s;
      const crew = body
        .filter((i) => carCol(i) && i.y < a.y - 2.5 && i.y > Math.max(nextY + 2.5, a.y - 14))
        .sort((x, y) => x.x - y.x)
        .map((i) => i.s)
        .join(' ');
      const posText = posItem?.s ?? '';
      const pos = /^\d+$/.test(posText) ? Number(posText) : null;
      const surnames = crew.split('-').map((s) => s.trim()).filter((s) => /\p{L}{2}/u.test(s));
      const row: CreventicPdfRow = { pos, number: a.s, driver: surnames.join(' / '), surnames };
      if (pos === null) row.status = /^(DNS|DSQ)$/i.test(posText) ? posText.toUpperCase() : posText.toUpperCase() === 'DQ' ? 'DSQ' : 'NC';
      if (team) row.team = team;
      if (car) row.vehicle = car;
      if (cls) row.class = scls && SUBCLASS[scls.toUpperCase()] && scls.toUpperCase() !== 'TCX' ? `${cls} ${SUBCLASS[scls.toUpperCase()]}` : cls;
      const tail = line.filter((i) => i.x >= tailStart - 20);
      if (cols.race) {
        const lapsItem = tail.find((i) => /--\s*\d+\s*laps?\s*--/i.test(i.s));
        if (lapsItem) groupLaps = Number(lapsItem.s.match(/(\d+)\s*laps?/i)![1]);
        if (groupLaps !== undefined) row.laps = groupLaps;
        if (pos === 1) leaderLaps = groupLaps;
        const total = [...tail].reverse().find((i) => /^\d+:\d{2}:\d{2}\.\d{3}$/.test(i.s));
        const gapItem = cols.gap !== undefined ? tail.find((i) => Math.abs(i.x - cols.gap!) <= 22 && timeGap(i.s)) : undefined;
        if (pos === 1 && total) row.time = total.s;
        else if (pos !== null && leaderLaps !== undefined && groupLaps !== undefined && groupLaps < leaderLaps) row.gap = lapsGap(leaderLaps - groupLaps);
        else if (pos !== null && gapItem) row.gap = timeGap(gapItem.s);
        const best = tail.find((i) => cols.fastest !== undefined && Math.abs(i.x - cols.fastest) <= 25 && /^\d{1,2}:\d{2}\.\d{3}$/.test(i.s));
        if (best) row.bestLap = best.s;
      } else {
        const best = tail.find((i) => cols.fastest !== undefined && Math.abs(i.x - cols.fastest) <= 25 && /^\d{1,2}:\d{2}\.\d{3}$/.test(i.s));
        if (best) row.time = best.s;
        const laps = tail.find((i) => cols.laps !== undefined && Math.abs(i.x - cols.laps) <= 15 && /^\d+$/.test(i.s));
        if (laps) row.laps = Number(laps.s);
      }
      rows.push(row);
    }
  }
  return rows;
}

/** Pilotos por número de auto del PDF "fastest drivers" ("T im H einemann (1 )" -> "Tim Heinemann"). */
export function creventicFastestDrivers(raw: PdfItem[]): Map<string, string[]> {
  const items = raw.map((i) => ({ ...i, s: fixSpacing(i.s) }));
  const out = new Map<string, string[]>();
  const headerItem = items.find((i) => /^driver$/i.test(i.s));
  const nbrItem = items.find((i) => /^nbr$/i.test(i.s));
  if (!headerItem || !nbrItem) return out;
  for (const line of pdfLines(items)) {
    const nbr = line.find((i) => /^\d+$/.test(i.s) && Math.abs(i.x - nbrItem.x) <= 10);
    const driver = line.find((i) => Math.abs(i.x - headerItem.x) <= 8 && /\p{L}{2}/u.test(i.s));
    if (!nbr || !driver) continue;
    const name = driver.s.replace(/\s*\(\s*\d+\s*\)\s*$/, '').trim();
    const list = out.get(nbr.s) ?? [];
    if (!list.includes(name)) list.push(name);
    out.set(nbr.s, list);
  }
  return out;
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

/** Nombres completos en el orden de la tripulación del PDF (por apellido); los que no se encuentran, como vienen. */
function crewNames(row: CreventicPdfRow, known: string[] | undefined): string | null {
  if (!known?.length) return null;
  if (row.surnames.length === 0) return known.join(' / ');
  const used = new Set<string>();
  const ordered = row.surnames.map((s) => {
    const hit = known.find((k) => !used.has(k) && fold(k).endsWith(fold(s)));
    if (hit) used.add(hit);
    return hit;
  });
  const rest = known.filter((k) => !used.has(k));
  const names = [...ordered.filter((n): n is string => !!n), ...rest];
  return names.join(' / ');
}

function rosterByNumber(rows: RosterRow[]): Map<string, { drivers: string[]; team?: string; vehicle?: string }> {
  const out = new Map<string, { drivers: string[]; team?: string; vehicle?: string }>();
  for (const r of rows) {
    if (!r.number) continue;
    const e = out.get(r.number) ?? { drivers: [], ...(r.team ? { team: r.team } : {}), ...(r.vehicle ? { vehicle: r.vehicle } : {}) };
    if (!e.drivers.includes(r.driver)) e.drivers.push(r.driver);
    out.set(r.number, e);
  }
  return out;
}

export async function creventicResults(entry: CalendarEntry, sessions: Session[], ctx: RecipeContext): Promise<ResultsFound | null> {
  if (!entry.url) return null;
  const html = (await ctx.http.text(entry.url)).body;
  const found = sourceSessions(creventicResultSessions(html), entry);
  if (found.length === 0) return null;
  const roster = rosterByNumber(creventicEntryList(html));
  let fastest: Map<string, string[]> | null = null;
  const out: SessionResultFound[] = [];
  const deferred: string[] = [];
  // Un PDF ilegible no tira abajo las demás sesiones del evento; si no se pudo leer ninguna, se avisa con un error.
  const failures: string[] = [];
  for (const s of found) {
    const target = pickSession(sessions, s, found);
    if (!target || out.some((o) => o.sessionId === target.id)) continue;
    try {
      const parsed = parseCreventicItems(await pdfTextItems((await ctx.http.bytes(s.url)).body));
      if (parsed.length === 0) throw new Error(`24H Series: el PDF de ${s.name} no tiene la tabla esperada (${s.url})`);
      // Sin pilotos en la lista de inscriptos: los del PDF de vueltas rápidas de la carrera (si ya se corrió).
      if (roster.size === 0 && fastest === null) {
        const race = found.find((x) => /^race\b/i.test(x.name));
        fastest = race ? await readFastest(race.url, ctx) : new Map();
      }
      const rows: ResultRow[] = parsed.map(({ surnames: _s, ...row }) => {
        const r = roster.get(row.number ?? '');
        const names = crewNames({ ...row, surnames: _s }, r?.drivers ?? fastest?.get(row.number ?? ''));
        return {
          ...row,
          ...(names ? { driver: names } : {}),
          ...(r?.team ? { team: r.team } : {}),
          ...(r?.vehicle ? { vehicle: r.vehicle } : {}),
        };
      });
      out.push({ sessionId: target.id, rows: fillClassPositions(rows), source: directSource(s.url, `24H Series — ${entry.name}: ${s.name}`, 'pdf', ctx) });
    } catch (err) {
      if (isTransient(err)) deferred.push(target.id);
      else failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (out.length === 0 && failures.length > 0) throw new Error(failures[0]);
  return { sessions: out, source: directSource(entry.url, `Resultados 24H Series — ${entry.name}`, 'html', ctx), ...(deferred.length ? { deferred } : {}) };
}

async function readFastest(raceUrl: string, ctx: RecipeContext): Promise<Map<string, string[]>> {
  const url = raceUrl.replace(/\.pdf$/i, '%20-%20fastest%20drivers.pdf');
  try {
    return creventicFastestDrivers(await pdfTextItems((await ctx.http.bytes(url)).body));
  } catch {
    return new Map();
  }
}
