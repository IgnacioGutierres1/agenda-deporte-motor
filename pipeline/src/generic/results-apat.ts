/**
 * Resultados de Turismo Nacional (APAT) sin IA. Cada clase tiene su página de resultados por fecha:
 * https://apat.org.ar/resultados/c2/2026-11-01 (y …/c3/…), con una tabla por sesión bajo su título ("FINAL C2",
 * "PRIMERA SERIE C2", "1º CLASIFICACIÓN C2", "1º ENTRENAMIENTO C2"): Puesto | Nro | Piloto | Marca | Vtas | Tiempo |
 * Diferencia. Debajo de cada tabla está el PDF oficial con su fecha y hora de publicación ("01/11/2026 18:37").
 * Las tablas "GENERAL CLASIFICACIÓN/ENTRENAMIENTO" son combinados y se descartan. Una fecha sin resultados
 * todavía muestra la última corrida: se controla que la página sea de la fecha pedida ("Fecha: 01/11/2026").
 *
 * Los nombres ("VITAR TOMAS") se reemplazan por los del campeonato oficial de la clase (mismo número): "Vitar, Tomas".
 */
import type { Session } from '@dm/shared';
import { textOf } from '../extract/html.ts';
import { apatTimetableBlock, apatTimetableSessions } from './apat.ts';
import { eventWindow, htmlTimetableText } from './cronograma-ar.ts';
import { column, pageOrNull, parseHtmlTable, stripComments } from './kit.ts';
import {
  arRows,
  arSessionKey,
  arSessionName,
  checkArRows,
  isRaceKind,
  lapTime,
  matchArSessions,
  pastSessionsFromDocs,
  resultsSource,
  withKnownNames,
  type ArSessionKey,
  type KnownDriver,
  type PastDoc,
  type RawRow,
} from './results-ar.ts';
import type { CalendarEntry, RecipeContext, ResultsFound, SessionResultFound, SessionsFound } from './types.ts';

const CLASSES = ['c2', 'c3'];

/** Sesión de la página de resultados de una clase. */
export interface ApatSession {
  title: string;
  key: ArSessionKey;
  name: string;
  rows: RawRow[];
  /** Día y hora local de publicación del PDF oficial de la sesión. */
  publishedDate?: string;
  published?: string;
}

/** Día de la fecha de la página ("Fecha: 01/11/2026" en "Información de la Carrera"), YYYY-MM-DD. */
export function apatResultsDate(html: string): string | null {
  const m = textOf(html.match(/Informaci[oó]n de la Carrera[\s\S]*?<\/ul>/i)?.[0] ?? '').match(/Fecha:?\s*(\d{2})\/(\d{2})\/(\d{4})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

/** Sesiones con tabla de la página de resultados de una clase. */
export function apatResultSessions(html: string, cls: string): ApatSession[] {
  const clean = stripComments(html);
  const out: (ApatSession & { general: boolean })[] = [];
  const tables = [...clean.matchAll(/<table\b[^>]*class="[^"]*table-hover[^"]*"[^>]*>[\s\S]*?<\/table>/gi)];
  tables.forEach((t, i) => {
    const before = clean.slice(0, t.index);
    const heads = [...before.matchAll(/<h[23]\b[^>]*>([\s\S]*?)<\/h[23]>/gi)];
    const title = textOf(heads.at(-1)?.[1] ?? '');
    // "GENERAL CLASIFICACIÓN C3": combinado de las tandas, salvo que sea la única (entonces es la clasificación).
    const general = /^general\b/i.test(title);
    const parsedKey = arSessionKey(general ? title.replace(/^general\s+/i, '') : title);
    if (!parsedKey) return;
    const key = { ...parsedKey, cls: parsedKey.cls ?? cls.slice(1) };
    const { headers, rows } = parseHtmlTable(t[0]);
    const [cPos, cNum, cName, cMake, cLaps, cTime, cGap] = [
      /^(?:puesto|pos)/i, /^(?:nro|n°|nº)/i, /^(?:piloto|nombre)/i, /^marca/i, /^vtas/i, /^(?:tiempo|mejor)/i, /^dif/i,
    ].map((re) => column(headers, re));
    if (cPos! < 0 || cName! < 0) {
      if (general) return; // los combinados tienen otras columnas; no hacen falta
      throw new Error(`APAT: la tabla "${title}" no tiene las columnas esperadas (${headers.join(', ')})`);
    }
    const parsed: RawRow[] = rows.map((cells) => {
      const cell = (c: number) => (c >= 0 ? textOf(cells[c] ?? '').replace(/\s+/g, ' ').trim() : '');
      const nameCell = cells[cName!] ?? '';
      const driver = textOf(nameCell.match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/i)?.[1] ?? nameCell);
      const p = cell(cPos!);
      const gap = cell(cGap!);
      const excluded = /\bEX\b|excluid|descalif/i.test(gap) || /^ex/i.test(p);
      const time = lapTime(cell(cTime!));
      return {
        pos: /^\d+$/.test(p) && !excluded ? Number(p) : null,
        ...(excluded ? { status: 'DSQ' } : /^(?:ab|nc|dnf|dns)$/i.test(p) ? { status: p.toUpperCase() === 'AB' ? 'DNF' : p.toUpperCase() } : {}),
        ...(cell(cNum!) ? { number: cell(cNum!) } : {}),
        driver,
        // En las series la columna Marca dice "*TN - CLASE 2": no es la marca.
        ...(cell(cMake!) && !/^\*|clase\s*\d/i.test(cell(cMake!)) ? { vehicle: cell(cMake!) } : {}),
        ...(/^\d+$/.test(cell(cLaps!)) ? { laps: Number(cell(cLaps!)) } : {}),
        ...(time ? { time } : {}),
        ...(gap && !excluded ? { gap } : {}),
      };
    }).filter((r) => r.driver);
    if (parsed.length === 0) return;
    // PDF oficial de esta tabla: el bloque "Archivos para descargar" que sigue, antes de la próxima tabla.
    const after = clean.slice(t.index! + t[0].length, tables[i + 1]?.index ?? clean.length);
    const when = textOf(after.match(/Archivos para descargar[\s\S]*?<\/table>/i)?.[0] ?? '').match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})/);
    out.push({
      general,
      title,
      key,
      name: arSessionName(key),
      // El orden de la página es el de la general; los excluidos van al final.
      rows: [...parsed.filter((r) => r.pos !== null).sort((a, b) => a.pos! - b.pos!), ...parsed.filter((r) => r.pos === null)],
      ...(when ? { publishedDate: `${when[3]}-${when[2]}-${when[1]}`, published: `${when[4]}:${when[5]}` } : {}),
    });
  });
  return out
    .filter((s) => !s.general || !out.some((o) => !o.general && o.key.kind === s.key.kind))
    .map(({ general: _g, ...s }) => s);
}

const resultsUrl = (entry: CalendarEntry, cls: string) => {
  const origin = entry.url ? new URL(entry.url).origin : 'https://apat.org.ar';
  return `${origin}/resultados/${cls}/${entry.dateEnd}`;
};

async function readClasses(entry: CalendarEntry, ctx: RecipeContext): Promise<{ cls: string; url: string; sessions: ApatSession[] }[]> {
  const out: { cls: string; url: string; sessions: ApatSession[] }[] = [];
  for (const cls of CLASSES) {
    const url = resultsUrl(entry, cls);
    const html = await pageOrNull(ctx, url);
    // Sin resultados de esta fecha, la página muestra otra (o redirige): no se toma.
    if (!html || apatResultsDate(html) !== entry.dateEnd) continue;
    out.push({ cls, url, sessions: apatResultSessions(html, cls) });
  }
  return out;
}

/** Pilotos del campeonato de cada clase (Nro y nombre), para los nombres de los resultados. */
async function knownDrivers(entry: CalendarEntry, cls: string, ctx: RecipeContext): Promise<KnownDriver[]> {
  const origin = entry.url ? new URL(entry.url).origin : 'https://apat.org.ar';
  const html = await pageOrNull(ctx, `${origin}/campeonato/ranking/${cls}`).catch(() => null);
  if (!html) return [];
  const table = stripComments(html).match(/<table\b[\s\S]*?<\/table>/i)?.[0] ?? '';
  const { headers, rows } = parseHtmlTable(table);
  const cNum = column(headers, /^(nro|n°|num)/i);
  const cName = column(headers, /^piloto/i);
  if (cNum < 0 || cName < 0) return [];
  return rows.map((cells) => ({
    number: textOf(cells[cNum] ?? ''),
    name: textOf((cells[cName] ?? '').match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/i)?.[1] ?? cells[cName] ?? ''),
  }));
}

/**
 * Sesiones de una fecha ya corrida: las del cronograma de la página de la fecha si sigue publicado (con su hora);
 * si no, las de las tablas de resultados, con la hora estimada por la publicación de cada PDF.
 */
export async function apatPastSessions(entry: CalendarEntry, ctx: RecipeContext): Promise<SessionsFound | null> {
  if (entry.url) {
    const html = await pageOrNull(ctx, entry.url);
    const block = html ? apatTimetableBlock(html) : '';
    const sessions = block ? apatTimetableSessions(htmlTimetableText(block), eventWindow(entry), entry.tz) : [];
    if (sessions.length > 0) return { sessions, source: resultsSource(entry.url, `Cronograma TN — ${entry.name}`, 'html', ctx) };
  }
  const classes = await readClasses(entry, ctx);
  const docs: PastDoc[] = classes.flatMap((c) =>
    c.sessions.map((s) => ({
      key: s.key,
      name: s.name,
      ...(s.publishedDate ? { date: s.publishedDate } : {}),
      ...(s.published ? { published: s.published } : {}),
    })),
  );
  if (docs.length === 0) return null;
  return { sessions: pastSessionsFromDocs(docs, entry), source: resultsSource(classes[0]!.url, `Resultados TN — ${entry.name}`, 'html', ctx) };
}

export async function apatResults(entry: CalendarEntry, sessions: Session[], ctx: RecipeContext): Promise<ResultsFound | null> {
  const classes = await readClasses(entry, ctx);
  if (classes.length === 0) return null;
  const out: SessionResultFound[] = [];
  const errors: Error[] = [];
  for (const c of classes) {
    const pairs = matchArSessions(c.sessions, sessions);
    const known = pairs.length > 0 ? await knownDrivers(entry, c.cls, ctx) : [];
    for (const [session, s] of pairs) {
      try {
        out.push({
          sessionId: session.id,
          rows: checkArRows(withKnownNames(arRows(s.rows, isRaceKind(s.key.kind)), known), `TN ${s.title}`),
          source: resultsSource(c.url, `${s.title} — ${entry.name}`, 'html', ctx),
        });
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
  // Una tabla rara no tira abajo las demás; si no se pudo leer ninguna, cambió el formato.
  if (out.length === 0 && errors.length > 0) throw errors[0];
  return { sessions: out, source: resultsSource(classes[0]!.url, `Resultados TN — ${entry.name}`, 'html', ctx) };
}
