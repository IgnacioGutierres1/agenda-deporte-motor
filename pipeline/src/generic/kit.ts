/**
 * Utilidades comunes de las recetas (lectores deterministas). Están separadas de recipes.ts para que las
 * recetas que viven en su propio archivo (supergt.ts, …) las usen sin importar recipes.ts, que a su vez
 * importa esas recetas para registrarlas (así no hay importaciones circulares).
 */
import type { Source, StandingsTable } from '@dm/shared';
import { HttpError } from '../core/http.ts';
import { textOf } from '../extract/html.ts';
import { guessTimeZone } from './places.ts';
import type { CalendarEntry, RecipeContext } from './types.ts';

export const host = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

export const stripComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, ' ');

export function tzFor(country: string, place: string, fallback = 'UTC'): string {
  return guessTimeZone(country, place) ?? fallback;
}

export function dedupe(entries: CalendarEntry[]): CalendarEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = e.url ? e.url.toLowerCase() : `${e.name}|${e.dateStart}|${e.championship ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function roundOf(text: string): number | undefined {
  const m = text.match(/(?:round|fecha|ronda|nls)\s*(\d{1,2})/i);
  return m ? Number(m[1]) : undefined;
}

/** Busca recursivamente en un JSON el primer array de objetos que cumpla el predicado. */
export function findArray(value: unknown, pred: (item: Record<string, unknown>) => boolean, depth = 0): Record<string, unknown>[] | null {
  if (depth > 25 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    const objs = value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
    if (objs.length > 0 && objs.length === value.length && objs.some(pred)) return objs;
    for (const v of value) {
      const r = findArray(v, pred, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    const r = findArray(v, pred, depth + 1);
    if (r) return r;
  }
  return null;
}

/** Busca recursivamente en un JSON el primer objeto que cumpla el predicado. */
export function findObject(value: unknown, pred: (item: Record<string, unknown>) => boolean, depth = 0): Record<string, unknown> | null {
  if (depth > 25 || !value || typeof value !== 'object') return null;
  if (!Array.isArray(value) && pred(value as Record<string, unknown>)) return value as Record<string, unknown>;
  for (const v of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) {
    const r = findObject(v, pred, depth + 1);
    if (r) return r;
  }
  return null;
}

export const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
export const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

// ─── Campeonatos: utilidades comunes ──────────────────────────────────────────────────────────

/** Número tal como lo publican los sitios ("258.5", "258,5", "1°", "x4"). null si no hay número. */
export function parseNumber(text: string): number | null {
  const m = text.replace(/\s+/g, '').match(/-?\d+(?:[.,]\d+)?/);
  return m ? Number(m[0].replace(',', '.')) : null;
}

/** Tabla HTML: textos de los encabezados y celdas (HTML crudo) de cada fila del cuerpo. */
export function parseHtmlTable(tableHtml: string): { headers: string[]; rows: string[][] } {
  const headers = [...tableHtml.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => textOf(m[1] ?? ''));
  const rows: string[][] = [];
  for (const tr of tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...(tr[1] ?? '').matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1] ?? '');
    if (cells.length > 0) rows.push(cells);
  }
  return { headers, rows };
}

/** Índice de la primera columna cuyo encabezado cumple el patrón (-1 si no hay). */
export const column = (headers: string[], re: RegExp) => headers.findIndex((h) => re.test(h.trim()));

/** Primera tabla de la página (sin comentarios HTML). */
export const firstTable = (html: string) => stripComments(html).match(/<table\b[\s\S]*?<\/table>/i)?.[0] ?? '';

/**
 * Controla una tabla leída: no vacía, puntos numéricos y posiciones 1, 2, 3… (se admiten empates).
 * Lanza un error si el formato no es el esperado (el flujo genérico prueba entonces con Gemini).
 */
export function checkStandingsTable(table: StandingsTable): StandingsTable {
  if (table.rows.length === 0) throw new Error(`Tabla "${table.title}" vacía`);
  table.rows.forEach((r, i) => {
    const prev = table.rows[i - 1];
    const ok = i === 0 ? r.pos === 1 : r.pos === i + 1 || r.pos === prev!.pos;
    if (!ok || !r.name || !Number.isFinite(r.points)) throw new Error(`Fila inesperada en "${table.title}": ${JSON.stringify(r)}`);
  });
  return table;
}

export function isoNow(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function standingsSource(url: string, title: string, ctx: RecipeContext): Source {
  return { url, title, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) };
}

/** HTML de una página; null si no existe (404), p. ej. la tabla de una temporada que todavía no empezó. */
export async function pageOrNull(ctx: RecipeContext, url: string): Promise<string | null> {
  try {
    return (await ctx.http.text(url)).body;
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) return null;
    throw err;
  }
}
