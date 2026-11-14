/**
 * Porsche Mobil 1 Supercup (racing.porsche.com): calendario, sesiones ya corridas y resultados sin IA.
 *
 * - Calendario: la página de la serie trae una tabla "Supercup AAAA Race Calendar" (Round, Event, Date, Location,
 *   Track) en el JSON de Next.js (texto enriquecido de Contentful, nodos "table"). Cuando la temporada pedida ya no
 *   está en esa tabla (la página pasa a mostrar la siguiente), los eventos salen de la página de resultados de la
 *   temporada (https://racing.porsche.com/mobil-1-supercup/results-season-AAAA): un <h2> por fecha ("Round 1 -
 *   Monaco", "R3 - Spielberg", "Round 6+7 - Zandvoort") y una tabla Date / Session / Download Link.
 * - Resultados: cada link es un PDF de cronometraje con el formato de la Fórmula 1 ("Race Final Classification"),
 *   directo en res.cloudinary.com o como link compartido de Cloudinary (asset.cloudinary.com/<cuenta>/<id>), que se
 *   resuelve con la misma consulta pública que usa esa página (console.cloudinary.com/…/public_links/…?mode=json).
 *   El PDF se lee con el lector de clasificaciones de la FIA (adapters/fia-documents.ts).
 * - Las sesiones de las fechas ya corridas salen de esa misma tabla (día de cada sesión; la hora no se publica y se
 *   estima).
 */
import { slugify, type ResultRow, type Session } from '@dm/shared';
import { parseClassificationItems, pdfTextItems, type PdfItem } from '../adapters/fia-documents.ts';
import { extractEmbeddedJson, textOf } from '../extract/html.ts';
import { countryName, isoDate } from './places.ts';
import { host, obj, str, tzFor } from './kit.ts';
import { directSource, driverCase, estimatedStart, isTransient, pdfLines, pickSession, type SourceSession } from './results-euro.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, ResultsFound, SessionResultFound, SessionsFound, SiteRecipe } from './types.ts';

const resultsPage = (season: number) => `https://racing.porsche.com/mobil-1-supercup/results-season-${season}`;

/** Circuitos del Supercup: palabra clave del nombre de la fecha -> circuito y país. */
const VENUES: Array<{ re: RegExp; key: string; circuit: string; country: string }> = [
  { re: /monaco|monte\s*carlo/i, key: 'monaco', circuit: 'Circuit de Monaco', country: 'Monaco' },
  { re: /barcelona|catalunya/i, key: 'barcelona', circuit: 'Circuit de Barcelona-Catalunya', country: 'Spain' },
  { re: /madrid|madring/i, key: 'madrid', circuit: 'Madring', country: 'Spain' },
  { re: /spielberg|red\s*bull\s*ring|austria/i, key: 'spielberg', circuit: 'Red Bull Ring', country: 'Austria' },
  { re: /spa|francorchamps|belgi/i, key: 'spa', circuit: 'Circuit de Spa-Francorchamps', country: 'Belgium' },
  { re: /budapest|hungar/i, key: 'budapest', circuit: 'Hungaroring', country: 'Hungary' },
  { re: /zandvoort|dutch|netherlands/i, key: 'zandvoort', circuit: 'Circuit Zandvoort', country: 'Netherlands' },
  { re: /monza|italian/i, key: 'monza', circuit: 'Autodromo Nazionale di Monza', country: 'Italy' },
  { re: /imola|emilia/i, key: 'imola', circuit: 'Autodromo Enzo e Dino Ferrari', country: 'Italy' },
  { re: /portim|algarve|portugal/i, key: 'portimao', circuit: 'Autódromo Internacional do Algarve', country: 'Portugal' },
  { re: /istanbul|turk/i, key: 'istanbul', circuit: 'Istanbul Park', country: 'Turkey' },
  { re: /silverstone|british/i, key: 'silverstone', circuit: 'Silverstone Circuit', country: 'United Kingdom' },
  { re: /mexico/i, key: 'mexico', circuit: 'Autódromo Hermanos Rodríguez', country: 'Mexico' },
];

const venueOf = (text: string) => VENUES.find((v) => v.re.test(text));

// ─── Calendario ───────────────────────────────────────────────────────────────────────────────

/** Texto de un nodo de texto enriquecido de Contentful. */
function richText(node: unknown): string {
  const n = obj(node);
  if (n.nodeType === 'text') return str(n.value);
  return ((n.content as unknown[] | undefined) ?? []).map(richText).join(' ').replace(/\s+/g, ' ').trim();
}

/** Tablas de texto enriquecido (filas de celdas de texto) del JSON de Next.js. */
function richTables(value: unknown, out: string[][][] = [], depth = 0): string[][][] {
  if (!value || typeof value !== 'object' || depth > 40) return out;
  if (Array.isArray(value)) {
    for (const v of value) richTables(v, out, depth + 1);
    return out;
  }
  const o = value as Record<string, unknown>;
  if (o.nodeType === 'table') {
    out.push(((o.content as unknown[] | undefined) ?? []).map((row) => ((obj(row).content as unknown[] | undefined) ?? []).map(richText)));
    return out;
  }
  for (const v of Object.values(o)) richTables(v, out, depth + 1);
  return out;
}

/** "03. – 06.06.2027", "18. - 20.06.2027", "09.07 – 11.07.2027", "30.07 – 01.08.2027" -> fechas ISO. */
export function porscheDateRange(text: string): { start: string; end: string } | null {
  const m = text.match(/(\d{1,2})\.\s*(?:(\d{1,2})\.?)?\s*[–-]\s*(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (!m) return null;
  const year = Number(m[5]);
  const endMonth = Number(m[4]);
  const startMonth = m[2] ? Number(m[2]) : endMonth;
  const start = isoDate(startMonth > endMonth ? year - 1 : year, startMonth, Number(m[1]));
  const end = isoDate(year, endMonth, Number(m[3]));
  return start && end ? { start, end } : null;
}

/** Fechas de la tabla "Race Calendar" de la página de la serie para la temporada pedida. */
export function porscheCalendarTable(html: string, season: number): CalendarEntry[] {
  const out: CalendarEntry[] = [];
  for (const value of extractEmbeddedJson(html)) {
    for (const table of richTables(value)) {
      const head = (table[0] ?? []).map((h) => h.toLowerCase());
      const col = (re: RegExp) => head.findIndex((h) => re.test(h));
      const [iRound, iEvent, iDate, iLoc, iTrack] = [col(/round/), col(/event/), col(/date/), col(/location/), col(/track$|circuit/)];
      if (iEvent < 0 || iDate < 0) continue;
      for (const row of table.slice(1)) {
        const dates = porscheDateRange(row[iDate] ?? '');
        if (!dates || !dates.end.startsWith(String(season))) continue;
        const name = row[iEvent] ?? '';
        const location = iLoc >= 0 ? (row[iLoc] ?? '') : '';
        const track = iTrack >= 0 ? (row[iTrack] ?? '') : '';
        const venue = venueOf(`${location} ${track} ${name}`);
        const country = countryName(location.split(',').at(-1)?.trim() || venue?.country || '');
        out.push({
          name,
          circuit: track || venue?.circuit || name,
          country,
          tz: tzFor(country, `${location} ${track}`),
          dateStart: dates.start,
          dateEnd: dates.end,
          ...(iRound >= 0 && /^\d+$/.test(row[iRound] ?? '') ? { round: Number(row[iRound]) } : {}),
          key: venue?.key ?? slugify(name),
        });
      }
      if (out.length) return out;
    }
  }
  return out;
}

export interface PorscheRound {
  title: string;
  /** Primera ronda del campeonato que corresponde a la fecha ("Round 6+7" -> 6). */
  round?: number;
  rows: Array<{ date: string; session: string; url: string }>;
}

/** Fechas de la página de resultados de la temporada (un <h2> por fecha y su tabla de sesiones). */
export function porscheResultRounds(html: string): PorscheRound[] {
  const clean = html.replace(/<template\b[\s\S]*?<\/template>/gi, '').replace(/<script\b[\s\S]*?<\/script>/gi, '');
  const rounds: PorscheRound[] = [];
  const parts = clean.split(/<h2\b[^>]*>/i).slice(1);
  for (const part of parts) {
    const title = textOf(part.slice(0, part.indexOf('</h2>')));
    const m = title.match(/^(?:round|r)\s*(\d+)(?:\s*\+\s*\d+)?\s*[-–]\s*(.+)$/i);
    if (!m) continue;
    const rows: PorscheRound['rows'] = [];
    for (const tr of part.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...tr[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]!);
      if (cells.length < 3) continue;
      const d = textOf(cells[0]!).match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
      const date = d ? isoDate(Number(d[3]), Number(d[2]), Number(d[1])) : null;
      const url = cells[2]!.match(/href="([^"]+)"/)?.[1] ?? '';
      if (!date) continue;
      rows.push({ date, session: textOf(cells[1]!), url });
    }
    rounds.push({ title: m[2]!.trim(), round: Number(m[1]), rows });
  }
  return rounds;
}

function roundEntry(r: PorscheRound): CalendarEntry | null {
  const dates = r.rows.map((x) => x.date).sort();
  if (dates.length === 0) return null;
  const venue = venueOf(r.title);
  const country = countryName(venue?.country ?? '');
  return {
    name: r.title,
    circuit: venue?.circuit ?? r.title,
    country,
    tz: tzFor(country, `${r.title} ${venue?.circuit ?? ''}`),
    dateStart: dates[0]!,
    dateEnd: dates.at(-1)!,
    ...(r.round ? { round: r.round } : {}),
    key: venue?.key ?? slugify(r.title),
  };
}

async function porscheCalendar(html: string, ctx: RecipeContext): Promise<CalendarEntry[]> {
  const fromTable = porscheCalendarTable(html, ctx.season);
  if (fromTable.length) return fromTable;
  let page: string;
  try {
    page = (await ctx.http.text(resultsPage(ctx.season))).body;
  } catch {
    return [];
  }
  return porscheResultRounds(page)
    .map(roundEntry)
    .filter((e): e is CalendarEntry => e !== null)
    .sort((a, b) => a.dateStart.localeCompare(b.dateStart));
}

// ─── Sesiones y resultados ────────────────────────────────────────────────────────────────────

/** "Practice" / "Qualifying" / "Race 6": si la fecha tiene una sola carrera se llama "Race"; si tiene dos, "Race 1"/"Race 2". */
function sessionNames(rows: PorscheRound['rows']): string[] {
  const races = rows.filter((r) => /race/i.test(r.session)).length;
  let n = 0;
  return rows.map((r) => {
    if (/race/i.test(r.session)) return races > 1 ? `Race ${++n}` : 'Race';
    if (/qualif/i.test(r.session)) return 'Qualifying';
    if (/practi|training/i.test(r.session)) return 'Practice';
    return r.session;
  });
}

const HOURS = { practica: '11:00', clasificacion: '10:00', carrera: '11:00' };

async function roundFor(entry: CalendarEntry, ctx: RecipeContext): Promise<PorscheRound | null> {
  const rounds = porscheResultRounds((await ctx.http.text(resultsPage(ctx.season))).body);
  const venue = venueOf(`${entry.key ?? ''} ${entry.name} ${entry.circuit}`);
  const overlaps = (r: PorscheRound) => r.rows.some((x) => x.date >= entry.dateStart && x.date <= entry.dateEnd);
  return rounds.find((r) => venue && venueOf(r.title)?.key === venue.key && overlaps(r)) ?? rounds.find(overlaps) ?? null;
}

function sourceSessions(round: PorscheRound, entry: CalendarEntry): SourceSession[] {
  const names = sessionNames(round.rows);
  return round.rows.map((r, i) => ({ name: names[i]!, startUtc: estimatedStart(r.date, names[i]!, entry.tz, HOURS) }));
}

export async function porschePastSessions(entry: CalendarEntry, ctx: RecipeContext): Promise<SessionsFound | null> {
  const round = await roundFor(entry, ctx);
  if (!round || round.rows.length === 0) return null;
  const sessions: ExtractedSession[] = sourceSessions(round, entry).map((s) => ({ name: s.name, startUtc: s.startUtc! }));
  return { sessions, source: directSource(resultsPage(ctx.season), `Resultados Supercup — ${entry.name}`, 'html', ctx) };
}

/** URL del PDF: directa, o la que devuelve la consulta pública de un link compartido de Cloudinary. */
async function pdfUrl(link: string, ctx: RecipeContext): Promise<string | null> {
  if (/\.pdf(\?|$)/i.test(link)) return link;
  const share = link.match(/^https:\/\/asset\.cloudinary\.com\/([^/]+)\/([0-9a-f]{16,})/i);
  if (!share) return null;
  const res = await ctx.http.json<unknown>(`https://console.cloudinary.com/console/api/v1/public_links/${share[1]}/assets/${share[2]}?mode=json`);
  const asset = obj(obj(res.body).asset);
  const url = str(obj(asset.delivery_urls).original);
  return str(asset.format) === 'pdf' && url ? url : null;
}

/**
 * Filas del PDF de la F1 con los nombres en formato del sitio ("Robert DE HAAN (R)" -> "Robert de Haan"). En las
 * fechas dobles la clasificación da dos tiempos ("1ST TIME" y "2ND TIME", la grilla de cada carrera) y el lector de
 * la FIA no reconoce la columna: se toma el primer tiempo del renglón (el de la clasificación general) y las vueltas.
 */
export function porscheRows(items: PdfItem[]): ResultRow[] {
  const parsed = parseClassificationItems(items);
  const twoTimes = items.some((i) => /^1ST TIME$/i.test(i.s));
  const lines = twoTimes ? pdfLines(items) : [];
  return parsed.map(({ pdfDriver, ...row }) => {
    // Número de tres cifras pegado al nombre ("911 Jacques VILLENEUVE"): el entero suelto de adelante era el puesto.
    const glued = pdfDriver.match(/^(\d+)\s+(\D.*)$/);
    const name = glued ? glued[2]! : pdfDriver;
    const out: ResultRow = { ...row, driver: driverCase(name.replace(/\s*\([A-Z]{1,3}\)\s*/g, ' ').replace(/\s*\*+$/, '').trim()) };
    if (glued) {
      if (out.pos === null && out.status === 'NC' && row.number && /^\d+$/.test(row.number)) {
        out.pos = Number(row.number);
        delete out.status;
      }
      out.number = glued[1]!;
    }
    if (twoTimes && !out.time && !out.gap) {
      const line = lines.find((l) => l.some((i) => i.s === pdfDriver || i.s.startsWith(`${pdfDriver} `)));
      const time = line?.find((i) => /^\d{1,2}:\d{2}\.\d{3}$/.test(i.s));
      const laps = time ? line?.filter((i) => /^\d+$/.test(i.s) && i.x > time.x).at(-1) : undefined;
      if (time) out.time = time.s;
      if (laps) out.laps = Number(laps.s);
    }
    return out;
  });
}

export async function porscheResults(entry: CalendarEntry, sessions: Session[], ctx: RecipeContext): Promise<ResultsFound | null> {
  const round = await roundFor(entry, ctx);
  if (!round) return null;
  const all = sourceSessions(round, entry);
  const out: SessionResultFound[] = [];
  const deferred: string[] = [];
  // Un PDF ilegible no tira abajo las demás sesiones del evento; si no se pudo leer ninguna, se avisa con un error.
  const failures: string[] = [];
  for (const [i, row] of round.rows.entries()) {
    const target = pickSession(sessions, all[i]!, all);
    if (!target || out.some((o) => o.sessionId === target.id)) continue;
    try {
      const url = await pdfUrl(row.url, ctx);
      if (!url) continue;
      const rows = porscheRows(await pdfTextItems((await ctx.http.bytes(url)).body));
      if (rows.length === 0) throw new Error(`Supercup: el PDF de ${row.session} no tiene la tabla esperada (${url})`);
      out.push({ sessionId: target.id, rows, source: directSource(url, `Porsche Mobil 1 Supercup — ${round.title}: ${row.session}`, 'pdf', ctx) });
    } catch (err) {
      if (isTransient(err)) deferred.push(target.id);
      else failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (out.length === 0 && failures.length > 0) throw new Error(failures[0]);
  return { sessions: out, source: directSource(resultsPage(ctx.season), `Resultados Supercup — ${entry.name}`, 'html', ctx), ...(deferred.length ? { deferred } : {}) };
}

export const porsche: SiteRecipe = {
  name: 'porsche',
  match: (url) => host(url) === 'racing.porsche.com',
  calendar: (doc, ctx) => porscheCalendar(doc.raw, ctx),
  // El cronograma de cada fecha no está en el sitio: se sigue buscando con el flujo genérico.
  timetableFallback: 'generic',
  pastSessions: (entry, ctx) => porschePastSessions(entry, ctx),
  results: (entry, sessions, ctx) => porscheResults(entry, sessions, ctx),
};
