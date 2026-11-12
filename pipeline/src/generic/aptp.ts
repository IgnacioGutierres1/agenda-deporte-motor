/**
 * Cronograma de Turismo Pista (APTP). El sitio (WordPress) no tiene página por fecha: el "Cronograma oficial de
 * actividades" se sube a la biblioteca de medios la semana de la carrera (p. ej.
 * wp-content/uploads/2026/10/cronograma_fecha_9_TP_-1.pdf, PDF con texto) y se borra después de la fecha.
 * Se ubica con la API REST oficial del sitio (/wp-json/wp/v2/media?search=crono), por fecha de subida y número
 * de fecha en el nombre del archivo. Si en vez de un PDF suben una imagen, se la pasa a la IA (timetableImages).
 */
import { classSession, byStart, eventWindow, isTrackSession, pdfText, timetableRows, type DayWindow } from './cronograma-ar.ts';
import { isoNow, obj, str } from './kit.ts';
import { shiftDate } from './places.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, SessionsFound, TimetableImages } from './types.ts';

/** "TURISMO PISTA CLASE 1 ENTRENAMIENTO I - GRUPO A" (los renglones de TC 2000 y los generales se descartan). */
const APTP_ROW = /^TURISMO\s+PISTA\s+CLASES?\s+(\d)\s+(.+)$/i;

export function aptpTimetableSessions(text: string, window: DayWindow, tz: string): ExtractedSession[] {
  const out: ExtractedSession[] = [];
  for (const row of timetableRows(text, window)) {
    const m = row.text.match(APTP_ROW);
    if (!m || !isTrackSession(m[2]!)) continue;
    out.push(classSession(row, m[1]!, m[2]!, tz));
  }
  return out.sort(byStart);
}

interface Media {
  url: string;
  date: string;
  mime: string;
}

/**
 * Archivos de cronograma subidos para el evento, del más nuevo al más viejo: subidos desde tres semanas antes
 * hasta el último día, y si el nombre trae número de fecha ("cronograma_fecha_9"), el de este evento.
 */
export async function aptpTimetableMedia(entry: CalendarEntry, ctx: RecipeContext): Promise<Media[]> {
  const origin = new URL(ctx.series.officialUrls[0] ?? 'https://aptpweb.com.ar/').origin;
  const after = `${shiftDate(entry.dateStart, -21)}T00:00:00`;
  const url = `${origin}/wp-json/wp/v2/media?search=crono&after=${after}&per_page=20&orderby=date&order=desc&_fields=date,source_url,mime_type`;
  const body = (await ctx.http.json<unknown>(url)).body;
  if (!Array.isArray(body)) throw new Error('APTP: la API de medios no devolvió una lista');
  return body
    .map(obj)
    .map((m) => ({ url: str(m.source_url), date: str(m.date), mime: str(m.mime_type) }))
    .filter((m) => {
      const file = decodeURIComponent(m.url.split('/').pop() ?? '');
      if (!/^https?:\/\//.test(m.url) || !/crono/i.test(file) || m.date.slice(0, 10) > entry.dateEnd) return false;
      const fecha = file.match(/fecha[\s_-]*(\d{1,2})(?!\d)/i)?.[1];
      return !fecha || entry.round === undefined || Number(fecha) === entry.round;
    })
    .sort((a, b) => b.date.localeCompare(a.date));
}

export async function aptpSessions(entry: CalendarEntry, ctx: RecipeContext): Promise<SessionsFound | null> {
  const window = eventWindow(entry);
  for (const m of (await aptpTimetableMedia(entry, ctx)).filter((x) => /pdf/i.test(x.mime) || /\.pdf$/i.test(x.url))) {
    const text = await pdfText(ctx, m.url);
    const sessions = text ? aptpTimetableSessions(text, window, entry.tz) : [];
    if (sessions.length > 0) {
      return {
        sessions,
        source: { url: m.url, title: `Cronograma Turismo Pista — ${entry.name}`, kind: 'pdf', method: 'directo', fetchedAt: isoNow(ctx.now) },
      };
    }
  }
  return null;
}

export async function aptpTimetableImages(entry: CalendarEntry, ctx: RecipeContext): Promise<TimetableImages | null> {
  const images = (await aptpTimetableMedia(entry, ctx)).filter((x) => /^image\//i.test(x.mime));
  if (images.length === 0) return null;
  // Las imágenes de la última subida (un cronograma de varias páginas), en el orden en que se subieron.
  const day = images[0]!.date.slice(0, 10);
  const urls = images.filter((x) => x.date.slice(0, 10) === day).map((x) => x.url).slice(0, 3).reverse();
  return { url: urls[0]!, title: `Cronograma Turismo Pista — ${entry.name}`, images: urls };
}
