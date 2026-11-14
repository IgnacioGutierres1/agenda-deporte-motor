/**
 * Resultados de Turismo Pista (APTP) sin IA. El sitio (WordPress) publica una página por fecha y clase:
 * https://aptpweb.com.ar/resultados-fecha-9-c1-2026/ (c1, c2, c3), con pestañas E1, E2, EG, Clasif.1, Clasif.2,
 * Clasif.Gral, Serie 1…3 y Final; cada pestaña es una tabla (TablePress) Pos | Auto | Piloto | Marca | Vts. | Tiempo |
 * Dif. Los excluidos van al final con "EX" en el puesto. "EG" y "Clasif.Gral" son combinados y se descartan.
 * La página no dice la hora de cada tanda; la de la fecha ya corrida se estima (results-ar.ts).
 * Arriba de las pestañas está el fin de semana ("> 16, 17 y 18 de Octubre / Concepción"): se controla que sea el
 * de la fecha pedida, por si un número de fecha del calendario no coincide con el del sitio.
 */
import type { Session } from '@dm/shared';
import { textOf } from '../extract/html.ts';
import { fechaNumber } from './cronograma-ar.ts';
import { column, pageOrNull, parseHtmlTable } from './kit.ts';
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
  type ArSessionKey,
  type PastDoc,
  type RawRow,
} from './results-ar.ts';
import type { CalendarEntry, RecipeContext, ResultsFound, SessionResultFound, SessionsFound } from './types.ts';

const CLASSES = ['1', '2', '3'];

export interface AptpSession {
  tab: string;
  key: ArSessionKey;
  name: string;
  rows: RawRow[];
}

/** ¿El encabezado del fin de semana ("> 16, 17 y 18 de Octubre / …") incluye el último día de la fecha? */
export function aptpPageMatches(html: string, dateEnd: string): boolean {
  const head = textOf(html.match(/<h5\b[^>]*>\s*(?:&gt;|>)([\s\S]*?)<\/h5>/i)?.[1] ?? '');
  if (!head) return true; // sin encabezado no hay con qué controlar
  const days = (head.split('/')[0]!.match(/\d{1,2}/g) ?? []).map(Number);
  return days.includes(Number(dateEnd.slice(8, 10)));
}

/** Sesiones con tabla de la página de resultados de una fecha y clase. */
export function aptpResultSessions(html: string, cls: string): AptpSession[] {
  const tabs = [...(html.match(/<ul\b[^>]*class="tabs_navigation[^"]*"[^>]*>([\s\S]*?)<\/ul>/i)?.[1] ?? '').matchAll(/<a\b[^>]*href="#([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)];
  const out: AptpSession[] = [];
  for (const [, id, label] of tabs) {
    const tab = textOf(label ?? '');
    const parsedKey = arSessionKey(tab);
    if (!parsedKey) continue;
    const key = { ...parsedKey, cls };
    const start = html.indexOf(`id="${id}"`);
    if (start < 0) continue;
    const table = html.slice(start).match(/<table\b[\s\S]*?<\/table>/i)?.[0];
    if (!table) continue;
    const { headers, rows } = parseHtmlTable(table);
    const [cPos, cNum, cName, cMake, cLaps, cTime, cGap] = [/^pos/i, /^auto/i, /^piloto/i, /^marca/i, /^vts|^vueltas/i, /^tiempo/i, /^dif/i].map(
      (re) => column(headers, re),
    );
    if (cPos! < 0 || cName! < 0) throw new Error(`APTP: la tabla "${tab}" no tiene las columnas esperadas (${headers.join(', ')})`);
    const parsed: RawRow[] = rows
      .map((cells) => {
        const cell = (c: number) => (c >= 0 ? textOf(cells[c] ?? '').replace(/\s+/g, ' ').trim() : '');
        const p = cell(cPos!);
        const gap = cell(cGap!);
        const excluded = /^ex/i.test(p) || /^ex$/i.test(gap);
        const time = lapTime(cell(cTime!));
        return {
          pos: /^\d+$/.test(p) && !excluded ? Number(p) : null,
          ...(excluded ? { status: 'DSQ' } : /^\d+$/.test(p) || !p ? {} : { status: /^(?:dnf|ab)$/i.test(p) ? 'DNF' : /^dns|^np$/i.test(p) ? 'DNS' : 'NC' }),
          ...(cell(cNum!) ? { number: cell(cNum!) } : {}),
          driver: cell(cName!),
          ...(cell(cMake!) ? { vehicle: cell(cMake!) } : {}),
          ...(/^\d+$/.test(cell(cLaps!)) ? { laps: Number(cell(cLaps!)) } : {}),
          ...(time ? { time } : {}),
          // Diferencias con coma decimal ("1,782") y a vueltas ("11 Vueltas").
          ...(gap && !excluded ? { gap: gap.replace(/^(\d+),(\d{3})$/, '$1.$2') } : {}),
        };
      })
      .filter((r) => r.driver);
    if (parsed.length === 0) continue;
    // Ordenadas por puesto (un recargo puede quedar cargado más abajo); los excluidos, al final.
    const rowsSorted = [...parsed.filter((r) => r.pos !== null).sort((a, b) => a.pos! - b.pos!), ...parsed.filter((r) => r.pos === null)];
    out.push({ tab, key, name: arSessionName(key), rows: rowsSorted });
  }
  return out;
}

/** Número de fecha del evento (del calendario o de su nombre, "Fecha 9 Concepción del Uruguay"). */
const roundOf = (entry: CalendarEntry) => entry.round ?? fechaNumber(entry.name) ?? null;

const pageUrl = (round: number, cls: string, season: number) => `https://aptpweb.com.ar/resultados-fecha-${round}-c${cls}-${season}/`;

async function readClasses(entry: CalendarEntry, ctx: RecipeContext): Promise<{ cls: string; url: string; sessions: AptpSession[] }[]> {
  const round = roundOf(entry);
  if (!round) return [];
  const out: { cls: string; url: string; sessions: AptpSession[] }[] = [];
  for (const cls of CLASSES) {
    const url = pageUrl(round, cls, ctx.season);
    const html = await pageOrNull(ctx, url); // 404 hasta que se publica
    if (!html || !aptpPageMatches(html, entry.dateEnd)) continue;
    out.push({ cls, url, sessions: aptpResultSessions(html, cls) });
  }
  return out;
}

/** Sesiones de una fecha ya corrida desde las pestañas de resultados (hora estimada: el sitio no la publica). */
export async function aptpPastSessions(entry: CalendarEntry, ctx: RecipeContext): Promise<SessionsFound | null> {
  const classes = await readClasses(entry, ctx);
  const docs: PastDoc[] = classes.flatMap((c) => c.sessions.map((s) => ({ key: s.key, name: s.name })));
  if (docs.length === 0) return null;
  return { sessions: pastSessionsFromDocs(docs, entry), source: resultsSource(classes[0]!.url, `Resultados Turismo Pista — ${entry.name}`, 'html', ctx) };
}

export async function aptpResults(entry: CalendarEntry, sessions: Session[], ctx: RecipeContext): Promise<ResultsFound | null> {
  const classes = await readClasses(entry, ctx);
  if (classes.length === 0) return null;
  const out: SessionResultFound[] = [];
  const errors: Error[] = [];
  for (const c of classes) {
    for (const [session, s] of matchArSessions(c.sessions, sessions)) {
      try {
        out.push({
          sessionId: session.id,
          rows: checkArRows(arRows(s.rows, isRaceKind(s.key.kind)), `Turismo Pista clase ${c.cls} ${s.tab}`),
          source: resultsSource(c.url, `Resultados Turismo Pista clase ${c.cls} — ${s.tab}`, 'html', ctx),
        });
      } catch (err) {
        errors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }
  // Una tabla rara no tira abajo las demás; si no se pudo leer ninguna, cambió el formato.
  if (out.length === 0 && errors.length > 0) throw errors[0];
  return { sessions: out, source: resultsSource(classes[0]!.url, `Resultados Turismo Pista — ${entry.name}`, 'html', ctx) };
}
