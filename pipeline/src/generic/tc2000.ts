/**
 * Cronograma de TC2000: cada fecha tiene su página https://tc2000.com.ar/carreras.php?accion=cronograma&id=N
 * (el botón CRONOGRAMA de la página de la fecha). Mientras no está publicado dice "No hay datos sobre
 * cronograma por el momento"; publicado, el bloque trae una sola imagen (750 px de ancho, la grilla de todo el
 * fin de semana: TC2000, Top Race, Fórmula Nacional…). No hay versión en texto (la nota de prensa
 * "Cronograma confirmado para …" remite a la misma página), así que la receta solo ubica la imagen y la
 * transcribe la IA. tc2000.com.ar responde 403 a GitHub Actions: ahí la serie queda con el último dato bueno (no se saltea el bloqueo).
 */
import { stripComments } from './kit.ts';
import { absoluteUrl, attr } from '../extract/html.ts';
import type { CalendarEntry, RecipeContext, TimetableImages } from './types.ts';

/** Imágenes del bloque CRONOGRAMA de la página de cronograma de una fecha (vacío si no está publicado). */
export function tc2000TimetableImageUrls(html: string, baseUrl: string): string[] {
  const clean = stripComments(html);
  const head = clean.match(/<h4\b[^>]*>\s*CRONOGRAMA\s*<\/h4>/i);
  if (!head || head.index === undefined) return [];
  const rest = clean.slice(head.index + head[0].length);
  // El bloque termina donde empieza la columna lateral con el calendario.
  const end = rest.search(/<div\b[^>]*class="[^"]*\bnoticias_listado\b/i);
  const block = end >= 0 ? rest.slice(0, end) : rest.slice(0, 5000);
  const out: string[] = [];
  for (const m of block.matchAll(/<img\b([^>]*)>/gi)) {
    // Algunas fechas quedaron con un src local del editor (file:///C:/…): absoluteUrl los descarta.
    const url = absoluteUrl(attr(m[1] ?? '', 'src') ?? '', baseUrl);
    if (url && /\.(jpe?g|png|webp)$/i.test(new URL(url).pathname) && !out.includes(url)) out.push(url);
  }
  return out;
}

export async function tc2000TimetableImages(entry: CalendarEntry, ctx: RecipeContext): Promise<TimetableImages | null> {
  const id = entry.meta?.id ?? entry.url?.match(/[?&]id=(\d+)/)?.[1];
  if (!id) return null;
  const origin = entry.url ? new URL(entry.url).origin : 'https://tc2000.com.ar';
  const url = `${origin}/carreras.php?accion=cronograma&id=${id}`;
  const html = (await ctx.http.text(url)).body;
  const images = tc2000TimetableImageUrls(html, url).slice(0, 3);
  if (images.length === 0) return null;
  return { url, title: `Cronograma TC2000 — ${entry.name}`, images };
}
