/**
 * Cronograma de Turismo Nacional (APAT), sin IA. APAT lo publica en dos lugares:
 * - la página de la fecha (https://apat.org.ar/carreras/info/2026-10-11), bloque "Cronograma" con una tabla
 *   HORARIO | CATEGORIA | ACTIVIDAD (o Hora | Clase | Grupo | Actividad); en otras fechas queda
 *   "El cronograma de esta fecha aún no está disponible";
 * - una nota de prensa "Cronograma de actividades: undécima fecha" con el PDF adjunto
 *   (/documentos/descargar/N; PDF con texto: "08.40 a 09.10 2 B 1° entrenamiento").
 * Si ninguno está, el cronograma todavía no está publicado (null).
 */
import type { Source } from '@dm/shared';
import { extractLinks, htmlToText, textOf } from '../extract/html.ts';
import { normalizeForMatch } from '../validate.ts';
import {
  byStart,
  classSession,
  eventWindow,
  fechaNumber,
  htmlTimetableText,
  isTrackSession,
  pdfText,
  timetableRows,
  type DayWindow,
} from './cronograma-ar.ts';
import { isoNow, pageOrNull } from './kit.ts';
import { eventTokens } from './locate.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, SessionsFound } from './types.ts';

/** "2 B 1° entrenamiento", "TN CLASE 2 1er ENTRENAMIENTO", "2-3 Verificación…": clase, grupo (opcional) y actividad. */
const APAT_ROW = /^(?:TN\s+)?(?:CLASES?\s+)?(\d(?:\s*(?:-|y)\s*\d)?)\s+(?:([A-D])\s+)?(.+)$/i;

/** Sesiones de TN en un cronograma en texto (renglones sin clase son de otras categorías o administrativos). */
export function apatTimetableSessions(text: string, window: DayWindow, tz: string): ExtractedSession[] {
  const out: ExtractedSession[] = [];
  for (const row of timetableRows(text, window)) {
    const m = row.text.match(APAT_ROW);
    if (!m || !isTrackSession(m[3]!)) continue;
    const activity = m[2] ? `${m[3]} - grupo ${m[2]}` : m[3]!;
    out.push(classSession(row, m[1]!.replace(/\s+/g, ''), activity, tz));
  }
  return out.sort(byStart);
}

/** HTML del bloque "Cronograma" de la página de una fecha ('' si no está). */
export function apatTimetableBlock(html: string): string {
  const head = html.match(/<h3\b[^>]*>(?:\s|<[^>]*>)*Cronograma(?:\s|<[^>]*>)*<\/h3>/i);
  if (!head || head.index === undefined) return '';
  const rest = html.slice(head.index + head[0].length);
  const end = rest.search(/<h3\b/i);
  return end >= 0 ? rest.slice(0, end) : rest;
}

const source = (url: string, kind: Source['kind'], entry: CalendarEntry, ctx: RecipeContext): Source => ({
  url,
  title: `Cronograma TN — ${entry.name}`,
  kind,
  method: 'directo',
  fetchedAt: isoNow(ctx.now),
});

/** Notas de cronograma revisadas como máximo por evento (cada una es una descarga). */
const MAX_POSTS = 3;

export async function apatSessions(entry: CalendarEntry, ctx: RecipeContext): Promise<SessionsFound | null> {
  const window = eventWindow(entry);
  const base = entry.url ?? ctx.series.officialUrls[0] ?? 'https://apat.org.ar/carreras';

  // 1. Página de la fecha.
  if (entry.url) {
    const html = await pageOrNull(ctx, entry.url);
    const block = html ? apatTimetableBlock(html) : '';
    const sessions = block ? apatTimetableSessions(htmlTimetableText(block), window, entry.tz) : [];
    if (sessions.length > 0) return { sessions, source: source(entry.url, 'html', entry, ctx) };
  }

  // 2. Nota de prensa con el PDF del cronograma (se publica la semana de la carrera: está en el índice de noticias).
  const origin = new URL(base).origin;
  const round = Number(entry.meta?.fecha) || entry.round || null;
  const tokens = eventTokens({ name: entry.circuit, circuit: '' });
  const seen = new Set<string>();
  let checked = 0;
  for (const indexUrl of [`${origin}/noticias`, `${origin}/noticias?page=2`]) {
    const index = await pageOrNull(ctx, indexUrl);
    if (!index) continue;
    const posts = extractLinks(index, indexUrl).filter(
      (l) => /\/noticias\/detalle\//.test(l.url) && /cronograma/i.test(`${l.text} ${l.url}`) && !seen.has(l.url) && seen.add(l.url),
    );
    for (const post of posts) {
      if (checked++ >= MAX_POSTS) return null;
      const html = await pageOrNull(ctx, post.url);
      if (!html) continue;
      const title = textOf(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? post.text);
      const fecha = fechaNumber(title) ?? fechaNumber(post.url.replace(/-/g, ' '));
      const text = normalizeForMatch(htmlToText(html, post.url));
      // La nota tiene que ser de esta fecha: por número ("undécima fecha") o por el circuito.
      if (fecha !== null && round !== null ? fecha !== round : !tokens.some((t) => text.includes(t))) continue;
      const docs = extractLinks(html, post.url).filter((l) => /\/documentos\/descargar\/\d+|\.pdf(\?|$)/i.test(l.url));
      for (const d of docs) {
        const pdf = await pdfText(ctx, d.url);
        const sessions = pdf ? apatTimetableSessions(pdf, window, entry.tz) : [];
        if (sessions.length > 0) return { sessions, source: source(d.url, 'pdf', entry, ctx) };
      }
      const inline = apatTimetableSessions(htmlTimetableText(html), window, entry.tz);
      if (inline.length > 0) return { sessions: inline, source: source(post.url, 'html', entry, ctx) };
    }
  }
  return null;
}
