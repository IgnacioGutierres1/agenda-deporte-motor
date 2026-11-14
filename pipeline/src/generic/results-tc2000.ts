/**
 * Resultados de TC2000 sin IA: la página "Tiempos" de cada fecha (https://tc2000.com.ar/carreras.php?accion=tiempos&id=N,
 * el botón TIEMPOS de la fecha) trae un acordeón con una tabla por sesión, encabezada por el nombre y el horario
 * oficial: "1° Entrenamiento&nbsp;Sábado 31 de octubre de 2026, 10:35 a 11:20hs" | Posición | Piloto | Marca |
 * Vueltas | Tiempo | Diferencia. Antes de la fecha dice "No hay datos de tiempos por el momento".
 * Las tablas "General Prácticas…" (combinado de los entrenamientos) no son una sesión y se descartan.
 *
 * tc2000.com.ar responde 403 a los servidores de GitHub Actions: esta lectura NO pasa por el proxy de core/http.ts
 * (noProxy), así que en CI solo funciona si el sitio deja pasar el pedido directo.
 */
import type { Session } from '@dm/shared';
import { textOf } from '../extract/html.ts';
import { parseHtmlTable, stripComments } from './kit.ts';
import {
  arRows,
  arSessionKey,
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
import type { CalendarEntry, RecipeContext, ResultsFound, SessionsFound } from './types.ts';

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** Una sesión de la página de tiempos. */
export interface Tc2000Session {
  name: string;
  key: ArSessionKey;
  /** Día local YYYY-MM-DD y horas HH:MM, si el encabezado los trae. */
  date?: string;
  start?: string;
  end?: string;
  rows: RawRow[];
}

const hhmm = (h: string, m: string) => `${h.padStart(2, '0')}:${m}`;

/** Día y horario del encabezado ("Sábado 14 de marzo de 2026, de 10:20hs a 11:10hs", "10.05 hs. a 10.15 hs."). */
export function tc2000When(text: string): { date?: string; start?: string; end?: string } {
  const t = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const d = t.match(/(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})/);
  const month = d ? MONTHS.indexOf(d[2]!) + 1 : 0;
  const date = d && month ? `${d[3]}-${String(month).padStart(2, '0')}-${d[1]!.padStart(2, '0')}` : undefined;
  const after = d ? t.slice(t.indexOf(d[0]) + d[0].length) : t;
  const range = after.match(/(\d{1,2})[:.](\d{2})\s*(?:hs\.?)?\s*a\s*(\d{1,2})[:.](\d{2})/);
  const single = after.match(/(\d{1,2})[:.](\d{2})/);
  return {
    ...(date ? { date } : {}),
    ...(range ? { start: hhmm(range[1]!, range[2]!), end: hhmm(range[3]!, range[4]!) } : single ? { start: hhmm(single[1]!, single[2]!) } : {}),
  };
}

/** Sesiones con su tabla de la página de tiempos de una fecha (vacío si todavía no hay tiempos). */
export function tc2000Sessions(html: string): Tc2000Session[] {
  const clean = stripComments(html);
  const start = clean.indexOf('id="accordion"');
  if (start < 0) return [];
  const body = clean.slice(start);
  const out: Tc2000Session[] = [];
  const heads = [...body.matchAll(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi)];
  heads.forEach((h, i) => {
    const raw = h[1]!.replace(/<i\b[^>]*>[\s\S]*?<\/i>/gi, '');
    const [nameHtml, ...whenHtml] = raw.split(/&nbsp;| /);
    const name = textOf(nameHtml ?? '').replace(/\s+/g, ' ').trim();
    const key = arSessionKey(name);
    if (!name || !key) return;
    const section = body.slice(h.index! + h[0].length, heads[i + 1]?.index ?? body.length);
    const table = section.match(/<table\b[^>]*tabla_tiempos[\s\S]*?<\/table>/i)?.[0];
    if (!table) return;
    const { rows } = parseHtmlTable(table);
    const parsed: RawRow[] = rows
      .map((cells) => cells.map((c) => textOf(c).replace(/ /g, ' ').replace(/\s+/g, ' ').trim()))
      .filter((c) => c.length >= 6 && /^\d+$/.test(c[0]!))
      .map((c) => {
        const time = lapTime(c[4]!);
        const pos = Number(c[0]);
        // Puesto 0: no largó (sin vueltas) o no clasificó.
        const status = pos === 0 ? (Number(c[3]) > 0 ? 'NC' : 'DNS') : undefined;
        return {
          pos: pos === 0 ? null : pos,
          ...(status ? { status } : {}),
          driver: c[1]!,
          ...(c[2] ? { vehicle: c[2] } : {}),
          ...(/^\d+$/.test(c[3]!) ? { laps: Number(c[3]) } : {}),
          ...(time ? { time } : {}),
          ...(c[5] ? { gap: c[5] } : {}),
        };
      });
    if (parsed.length === 0) return;
    out.push({ name, key, ...tc2000When(textOf(whenHtml.join(' '))), rows: parsed });
  });
  return out;
}

const tiemposUrl = (entry: CalendarEntry) => {
  const id = entry.meta?.id ?? entry.url?.match(/[?&]id=(\d+)/)?.[1];
  const origin = entry.url ? new URL(entry.url).origin : 'https://tc2000.com.ar';
  return id ? `${origin}/carreras.php?accion=tiempos&id=${id}` : null;
};

async function readSessions(entry: CalendarEntry, ctx: RecipeContext): Promise<{ url: string; sessions: Tc2000Session[] } | null> {
  const url = tiemposUrl(entry);
  if (!url) return null;
  // Sin el proxy de Google: si el sitio rechaza el pedido, no se lo saltea (ver comentario del archivo).
  const html = (await ctx.http.text(url, { noProxy: true })).body;
  const sessions = tc2000Sessions(html);
  return sessions.length > 0 ? { url, sessions } : null;
}

/** Sesiones de una fecha ya corrida, con el horario oficial de cada encabezado. */
export async function tc2000PastSessions(entry: CalendarEntry, ctx: RecipeContext): Promise<SessionsFound | null> {
  const read = await readSessions(entry, ctx);
  if (!read) return null;
  const docs: PastDoc[] = read.sessions.map((s) => ({
    key: s.key,
    name: s.name,
    ...(s.date ? { date: s.date } : {}),
    ...(s.start ? { start: s.start } : {}),
    ...(s.end ? { end: s.end } : {}),
  }));
  return { sessions: pastSessionsFromDocs(docs, entry), source: resultsSource(read.url, `Tiempos TC2000 — ${entry.name}`, 'html', ctx) };
}

export async function tc2000Results(entry: CalendarEntry, sessions: Session[], ctx: RecipeContext): Promise<ResultsFound | null> {
  const read = await readSessions(entry, ctx);
  if (!read) return null;
  const pairs = matchArSessions(read.sessions, sessions);
  return {
    sessions: pairs.map(([session, s]) => ({
      sessionId: session.id,
      rows: checkArRows(arRows(s.rows, isRaceKind(s.key.kind)), `TC2000 ${s.name}`),
    })),
    source: resultsSource(read.url, `Tiempos TC2000 — ${entry.name}`, 'html', ctx),
  };
}
