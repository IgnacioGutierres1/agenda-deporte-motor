/**
 * Nürburgring Langstrecken-Serie: resultados desde el archivo oficial de resultados
 * (https://www.nuerburgring-langstrecken-serie.de/language/de/ergebnisarchiv/?jahr=AAAA), que enlaza por cada
 * carrera ("11.04.2026<br>57. Adenauer ADAC Rundstrecken-Trophy") los PDF que publica WIGE Solutions, el
 * cronometrador: …/ergebnisse/2026-04-11t.pdf (Zeittraining = clasificación), …r.pdf (Rennen = carrera, general),
 * …tq.pdf (Top-Qualifying, en los 24h Qualifiers), además de inscriptos (s), vuelta a vuelta (tl, rl) y por clase (k),
 * que no se leen.
 *
 * Los PDF del training y la carrera tienen el mismo formato (en alemán): un renglón por auto con Pl., Nr., la clase
 * arriba ("SP9 PRO", "CUP2", y en las copas monomarca la subclase PRO/AM más abajo), auto, vueltas, tiempo total,
 * diferencia ("21.759", "9 Runden"), mejor vuelta; debajo "B:" equipo, "S:" sponsor y un renglón por piloto
 * "Apellido Nombre, Ciudad". Los que no terminaron van en secciones "DNF", "DNS", "DSQ". El Top-Qualifying viene en
 * inglés con otro encabezado (Pos., No., Cl., Entrant, Car, Laps, Best time) y "Apellido Nombre, Ciudad, País, …".
 *
 * El archivo no publica la hora de las sesiones: para las fechas ya corridas se estima con el horario habitual
 * (Zeittraining 8:30, carrera 12:00).
 */
import { localToUtc, type ResultRow, type Session } from '@dm/shared';
import { pdfTextItems, type PdfItem } from '../adapters/fia-documents.ts';
import { textOf } from '../extract/html.ts';
import { className } from './rosters.ts';
import { isoDate, shiftDate } from './places.ts';
import { stripComments } from './kit.ts';
import { directSource, fillClassPositions, isTransient, lapsGap, pickSession, sessionKey, timeGap, type SourceSession } from './results-euro.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, ResultsFound, SessionResultFound, SessionsFound } from './types.ts';

const SITE = 'https://www.nuerburgring-langstrecken-serie.de';
const archiveUrl = (season: number) => `${SITE}/language/de/ergebnisarchiv/?jahr=${season}`;

export interface NlsArchiveRace {
  date: string;
  name: string;
  /** Documentos por sufijo del archivo: t, tq, r… */
  files: Record<string, string>;
}

/** Carreras del archivo de resultados con sus PDF. */
export function nlsArchive(html: string, pageUrl: string): NlsArchiveRace[] {
  const out: NlsArchiveRace[] = [];
  for (const tr of stripComments(html).matchAll(/<tr\b[^>]*>\s*<td\b[^>]*>([\s\S]*?)<\/td>([\s\S]*?)<\/tr>/gi)) {
    const head = tr[1]!.split(/<br\s*\/?>/i);
    const d = textOf(head[0] ?? '').match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
    const date = d ? isoDate(Number(d[3]), Number(d[2]), Number(d[1])) : null;
    if (!date) continue;
    const files: Record<string, string> = {};
    for (const a of tr[2]!.matchAll(/href="([^"]*\/ergebnisse\/\d{4}-\d{2}-\d{2}([a-z]+)\.pdf)"/gi)) {
      files[a[2]!.toLowerCase()] = new URL(a[1]!, pageUrl).toString();
    }
    out.push({ date, name: textOf(head.slice(1).join(' ')), files });
  }
  return out;
}

const STOP_WORDS = new Set(['adac', 'nls', 'rennen', 'race', 'the', 'und', 'der', 'die', 'des']);
const tokens = (s: string) => new Set(sessionKey(s).split(' ').filter((t) => t.length >= 3 && !/^\d+h?$/.test(t) && !STOP_WORDS.has(t)));

/** Carreras del archivo que corresponden a una fecha del calendario (por nombre y fecha, con un día de margen). */
export function nlsRacesFor(entry: Pick<CalendarEntry, 'name' | 'dateStart' | 'dateEnd'>, archive: NlsArchiveRace[]): NlsArchiveRace[] {
  const from = shiftDate(entry.dateStart, -1);
  const to = shiftDate(entry.dateEnd, 1);
  const wanted = tokens(entry.name);
  const near = archive.filter((r) => r.date >= from && r.date <= to);
  const scored = near.map((r) => ({ r, score: [...tokens(r.name)].filter((t) => wanted.has(t)).length }));
  const best = Math.max(0, ...scored.map((s) => s.score));
  const chosen = best > 0 ? scored.filter((s) => s.score === best).map((s) => s.r) : near.filter((r) => r.date >= entry.dateStart && r.date <= entry.dateEnd);
  return chosen.sort((a, b) => a.date.localeCompare(b.date));
}

/** Sesiones que publica el archivo para una fecha: Zeittraining, Top-Qualifying y carrera (numeradas si son dos). */
function archiveSessions(races: NlsArchiveRace[], entry: CalendarEntry): Array<SourceSession & { url: string; endUtc?: string }> {
  const out: Array<SourceSession & { url: string; endUtc?: string }> = [];
  const many = races.length > 1;
  races.forEach((race, i) => {
    const n = race.name.match(/rennen\s*(\d)/i)?.[1] ?? String(i + 1);
    const suffix = many ? ` ${n}` : '';
    const hours = /\b6\s*h\b|6h/i.test(`${race.name} ${entry.name}`) ? 6 : 4;
    if (race.files.t) out.push({ name: `Qualifying${suffix}`, url: race.files.t, startUtc: localToUtc(race.date, '08:30', entry.tz) });
    if (race.files.tq) out.push({ name: `Top-Qualifying${suffix}`, url: race.files.tq, startUtc: localToUtc(race.date, '10:30', entry.tz) });
    if (race.files.r) {
      const startUtc = localToUtc(race.date, '12:00', entry.tz);
      out.push({ name: `Race${suffix}`, url: race.files.r, startUtc, endUtc: new Date(Date.parse(startUtc) + hours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z') });
    }
  });
  return out;
}

async function eventSessions(entry: CalendarEntry, ctx: RecipeContext) {
  const url = archiveUrl(ctx.season);
  const archive = nlsArchive((await ctx.http.text(url)).body, url);
  return archiveSessions(nlsRacesFor(entry, archive), entry);
}

export async function nlsPastSessions(entry: CalendarEntry, ctx: RecipeContext): Promise<SessionsFound | null> {
  const found = await eventSessions(entry, ctx);
  if (found.length === 0) return null;
  const sessions: ExtractedSession[] = found.map((s) => ({ name: s.name, startUtc: s.startUtc!, ...(s.endUtc ? { endUtc: s.endUtc } : {}) }));
  return { sessions, source: directSource(archiveUrl(ctx.season), `Ergebnisarchiv NLS — ${entry.name}`, 'html', ctx) };
}

// ─── PDF de WIGE ──────────────────────────────────────────────────────────────────────────────

const PARTICLES = /^(van|van´t|van't|von|vom|de|der|den|di|da|du|del|della|le|la|ten|ter|zu|dos|das|mac|st\.?)$/i;

/**
 * "Wittmann Marco" -> "Marco Wittmann", "Van Roon Jan Jaap" -> "Jan Jaap Van Roon", "'Jesse Krohn'" (seudónimo,
 * entre comillas) -> "Jesse Krohn". El archivo escribe primero el apellido; se toma como apellido la primera palabra
 * (con sus partículas: van, von, de…) y el resto como nombre.
 */
export function nlsDriverName(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  const quoted = t.match(/^['"‘’“”](.+?)['"‘’“”]$/);
  if (quoted) return quoted[1]!.trim();
  const words = t.split(' ');
  if (words.length < 2) return t;
  let i = 0;
  while (PARTICLES.test(words[i]!) && i < words.length - 2) i++;
  const surname = words.slice(0, i + 1).join(' ');
  const first = words.slice(i + 1).join(' ');
  return first ? `${first} ${surname}` : t;
}

/** "SP9 PRO" -> "SP9 Pro", "CUP2" + "PRO" -> "Cup2 Pro", "SP 9" -> "SP9". */
export function nlsClass(main: string, sub?: string): string {
  let c = main.replace(/\s+/g, ' ').trim().replace(/^SP\s+(\d)/i, 'SP$1').replace(/^CUP\s*(\d)/i, 'Cup$1');
  if (sub && !new RegExp(`\\b${sub.replace(/[/-]/g, '.')}\\b`, 'i').test(c)) c = `${c} ${sub}`;
  return className(c.replace(/\bPRO\/AM\b/i, 'PRO-AM'));
}

interface Cols {
  pos: number;
  nr: number;
  kl: number;
  veh: number;
  car?: number;
  rueck?: number;
  schnitt?: number;
  best?: number;
  race: boolean;
}

function header(page: PdfItem[]): Cols | null {
  const find = (re: RegExp) => page.find((i) => re.test(i.s));
  const pos = find(/^(pl|pos)\.?$/i);
  const nr = find(/^(nr|no)\.?$/i);
  const kl = find(/^(kl|cl)\.?$/i);
  const veh = find(/^fahrzeug|^entrant/i);
  if (!pos || !nr || !kl || !veh) return null;
  const car = find(/^car$/i);
  return {
    pos: pos.x,
    nr: nr.x,
    kl: kl.x,
    veh: veh.x,
    ...(car ? { car: car.x } : {}),
    ...(find(/^(rückstand|gap)$/i) ? { rueck: find(/^(rückstand|gap)$/i)!.x } : {}),
    ...(find(/^(schnitt|average)/i) ? { schnitt: find(/^(schnitt|average)/i)!.x } : {}),
    ...(find(/^(schnellste|best time|fastest lap)$/i) ? { best: find(/^(schnellste|best time|fastest lap)$/i)!.x } : {}),
    race: page.some((i) => /^(gesamtzeit|total time)$/i.test(i.s)),
  };
}

const INT = /^\d+$/;
const LAP_TIME = /^\d{1,2}:\d{2}\.\d{3}$/;
const TOTAL_TIME = /^\d+:\d{2}:\d{2}\.\d{3}$/;
const SECTION = /^(DNF|DNS|DSQ|NC)$/;

/** Clasificación de un PDF de WIGE (training, Top-Qualifying o carrera). [] si no tiene la tabla. */
export function parseNlsItems(items: PdfItem[]): ResultRow[] {
  const rows: ResultRow[] = [];
  const pages = [...new Set(items.map((i) => i.page))].sort((a, b) => a - b);
  let status: string | null = null;
  for (const p of pages) {
    const page = items.filter((i) => i.page === p);
    const cols = header(page);
    if (!cols) continue;
    const headerY = page.find((i) => /^(pl|pos)\.?$/i.test(i.s))!.y;
    const body = page.filter((i) => i.y < headerY - 4 && i.y > 60);
    const anchors = body
      .filter((i) => INT.test(i.s) && i.x >= cols.nr - 9 && i.x < cols.kl - 6)
      .sort((a, b) => b.y - a.y);
    const sections = body.filter((i) => SECTION.test(i.s) && i.x < cols.nr - 10).map((i) => ({ y: i.y, s: i.s }));
    anchors.forEach((a, k) => {
      const nextY = anchors[k + 1]?.y ?? -Infinity;
      // Estado de la sección a la que pertenece el auto (la última encabezada por encima, en esta página o antes).
      const sec = sections.filter((s) => s.y > a.y).sort((x, y) => x.y - y.y)[0];
      if (sec) status = sec.s;
      const line = body.filter((i) => Math.abs(i.y - a.y) <= 2.5);
      const posItem = line.find((i) => INT.test(i.s) && i.x < cols.nr - 6);
      const inKl = (i: PdfItem) => i.x >= cols.kl - 20 && i.x < cols.veh - 3 && !INT.test(i.s);
      const main = body.filter((i) => inKl(i) && i.y >= a.y - 1 && i.y <= a.y + 6).map((i) => i.s)[0];
      const sub = body.filter((i) => inKl(i) && i.y < a.y - 1 && i.y > nextY + 2.5 && /^(PRO|AM|PRO-AM|PRO\/AM)$/i.test(i.s)).map((i) => i.s)[0];
      const text = (i: PdfItem) => /\p{L}/u.test(i.s);
      const vehicle = (cols.car !== undefined
        ? body.find((i) => text(i) && Math.abs(i.y - a.y) <= 4 && i.x >= cols.car! - 90 && i.x < cols.car! + 20 && i.x > cols.veh + 150)
        : line.find((i) => text(i) && Math.abs(i.x - cols.veh) <= 6 && !/^[BES]:/.test(i.s)))?.s;
      const block = body.filter((i) => i.y < a.y + 3 && i.y > nextY + 2.5 && Math.abs(i.x - cols.veh) <= 6);
      const team = block.find((i) => /^[BE]:/.test(i.s))?.s.replace(/^[BE]:\s*/, '').replace(/,\s*[^,]*\d[^,]*$/, '').trim();
      const drivers = block
        .filter((i) => i.y < a.y - 1 && !/^[BES]:/.test(i.s) && i.s.includes(','))
        .sort((x, y) => y.y - x.y)
        .map((i) => nlsDriverName(i.s.split(',')[0]!.replace(/\*+/g, '')))
        .filter((d) => /\p{L}{2}/u.test(d));
      if (drivers.length === 0) return;
      const classified = !!posItem && !status;
      const row: ResultRow = { pos: classified ? Number(posItem!.s) : null, number: a.s, driver: drivers.join(' / ') };
      if (!classified) row.status = status ?? 'NC';
      if (team) row.team = team;
      if (vehicle) row.vehicle = vehicle.trim();
      if (main) row.class = nlsClass(main, sub);
      const nums = line.filter((i) => i.x > cols.veh + 150);
      const laps = nums.find((i) => INT.test(i.s) && (cols.rueck === undefined || i.x < cols.rueck - 30));
      if (laps) row.laps = Number(laps.s);
      if (cols.race) {
        const total = nums.find((i) => TOTAL_TIME.test(i.s));
        // La diferencia va en el renglón del auto (alemán) o en el siguiente, con signo (inglés: "+28.024", "+1 Lap").
        const inGap = (i: PdfItem) => cols.rueck !== undefined && i.x >= cols.rueck - 25 && i.x < (cols.schnitt ?? Infinity) - 3;
        const gapItem =
          nums.find(inGap) ?? body.find((i) => inGap(i) && i.y < a.y - 2 && i.y > Math.max(nextY + 2.5, a.y - 14) && /^\+/.test(i.s));
        const gapText = gapItem?.s.replace(/^\+\s*/, '') ?? '';
        const lapsDown = gapText.match(/^(\d+)\s*(?:Runden?|laps?)$/i);
        if (row.pos === 1 && total) row.time = total.s;
        else if (row.pos !== null && lapsDown) row.gap = lapsGap(Number(lapsDown[1]));
        else if (row.pos !== null && timeGap(gapText)) row.gap = timeGap(gapText.replace(/^0(?=\d\.)/, ''));
        const best = nums.find((i) => LAP_TIME.test(i.s) && (cols.best === undefined || i.x >= cols.best - 15));
        if (best) row.bestLap = best.s;
      } else {
        const best = nums.find((i) => LAP_TIME.test(i.s));
        if (best) row.time = best.s;
      }
      rows.push(row);
    });
  }
  return fillClassPositions(rows);
}

export async function nlsResults(entry: CalendarEntry, sessions: Session[], ctx: RecipeContext): Promise<ResultsFound | null> {
  const found = await eventSessions(entry, ctx);
  if (found.length === 0) return null;
  const out: SessionResultFound[] = [];
  const deferred: string[] = [];
  // Un PDF ilegible no tira abajo las demás sesiones del evento; si no se pudo leer ninguna, se avisa con un error.
  const failures: string[] = [];
  for (const s of found) {
    const target = pickSession(sessions, s, found);
    if (!target || out.some((o) => o.sessionId === target.id)) continue;
    try {
      const rows = parseNlsItems(await pdfTextItems((await ctx.http.bytes(s.url)).body));
      if (rows.length === 0) throw new Error(`NLS: el PDF de ${s.name} no tiene la tabla esperada (${s.url})`);
      out.push({ sessionId: target.id, rows, source: directSource(s.url, `NLS — ${entry.name}: ${s.name} (WIGE)`, 'pdf', ctx) });
    } catch (err) {
      if (isTransient(err)) deferred.push(target.id);
      else failures.push(err instanceof Error ? err.message : String(err));
    }
  }
  if (out.length === 0 && failures.length > 0) throw new Error(failures[0]);
  return { sessions: out, source: directSource(archiveUrl(ctx.season), `Ergebnisarchiv NLS — ${entry.name}`, 'html', ctx), ...(deferred.length ? { deferred } : {}) };
}
