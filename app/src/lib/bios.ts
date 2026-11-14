/**
 * Historial de pilotos, equipos y categorías (data/bios/**): textos y agrupamientos que muestran las fichas.
 */
import type { BioSummary, BioTitle, CareerSeason, CreditedImage } from '@dm/shared';

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

/** "1997-11-05" -> "5 de noviembre de 1997" ('' si la fecha no es válida). */
export function longDate(iso: string | undefined): string {
  const m = iso?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '';
  const month = MONTHS[Number(m[2]) - 1];
  return month ? `${Number(m[3])} de ${month} de ${m[1]}` : '';
}

/** Edad cumplida a la fecha `today` (YYYY-MM-DD), o null si no se sabe. */
export function ageOn(birthDate: string | undefined, today: string): number | null {
  const b = birthDate?.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const t = today.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!b || !t) return null;
  let age = Number(t[1]) - Number(b[1]);
  if (t[2]! < b[2]! || (t[2] === b[2] && t[3]! < b[3]!)) age--;
  return age >= 0 && age < 120 ? age : null;
}

/** Párrafos de un resumen (separados por renglones en blanco o saltos simples). */
export function paragraphs(text: string): string[] {
  return text
    .split(/\n\s*\n|\n/)
    .map((p) => p.trim())
    .filter(Boolean);
}

/** true si el texto sale de Wikipedia (lleva la atribución CC BY-SA). */
export function isWikipedia(summary: Pick<BioSummary, 'url'>): boolean {
  return /(^|\.)wikipedia\.org$/i.test(hostOf(summary.url));
}

/** "Leer más en Wikipedia (en inglés)" / "Leer más en formula1.com". */
export function readMoreLabel(summary: BioSummary): string {
  const where = isWikipedia(summary) ? 'Wikipedia' : hostOf(summary.url) || 'la fuente';
  return `Leer más en ${where}${summary.lang === 'en' ? ' (en inglés)' : ''}`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** "Foto: Jen Ross · CC BY 2.0": atribución corta de una imagen (el enlace va a `page`). */
export function imageCredit(img: CreditedImage, what = 'Foto'): string {
  const parts = [img.credit.trim(), img.license.trim()].filter(Boolean);
  return parts.length ? `${what}: ${parts.join(' · ')}` : what;
}

/** Títulos agrupados por categoría: "Fórmula 1" × 4 (2021, 2022, 2023, 2024), la de más títulos primero. */
export interface TitleGroup {
  series: string;
  seriesId?: string;
  seasons: number[];
}

export function groupTitles(titles: BioTitle[] | undefined): TitleGroup[] {
  const map = new Map<string, TitleGroup>();
  for (const t of titles ?? []) {
    const key = t.seriesId ?? t.series.toLowerCase();
    const g = map.get(key) ?? { series: t.series, ...(t.seriesId ? { seriesId: t.seriesId } : {}), seasons: [] };
    if (!g.seasons.includes(t.season)) g.seasons.push(t.season);
    map.set(key, g);
  }
  const out = [...map.values()];
  for (const g of out) g.seasons.sort((a, b) => a - b);
  return out.sort((a, b) => b.seasons.length - a.seasons.length || (b.seasons.at(-1) ?? 0) - (a.seasons.at(-1) ?? 0));
}

/** Renglón de la trayectoria: la temporada se muestra solo en el primero de cada año. */
export interface CareerRow extends CareerSeason {
  firstOfSeason: boolean;
}

/** Trayectoria de la temporada más reciente a la más vieja (la fuente ya la ordena, pero no se confía). */
export function careerRows(career: CareerSeason[] | undefined): CareerRow[] {
  const sorted = [...(career ?? [])].sort((a, b) => b.season - a.season);
  return sorted.map((c, i) => ({ ...c, firstOfSeason: i === 0 || sorted[i - 1]!.season !== c.season }));
}

/** "3 V · 7 Pod. · 255 pts": lo que haya de la temporada (vacío si no hay números). */
export function careerNumbers(c: CareerSeason): string {
  const parts: string[] = [];
  if (c.races !== undefined) parts.push(`${c.races} ${c.races === 1 ? 'carrera' : 'carreras'}`);
  if (c.points !== undefined) parts.push(`${c.points.toLocaleString('es-AR')} pts`);
  return parts.join(' · ');
}

/** "2010–2024", "desde 2014" o "2019" (una sola temporada). */
export function yearsText(from: number, to: number | undefined, current: number): string {
  if (to === undefined || to >= current) return from >= current ? String(from) : `desde ${from}`;
  return from === to ? String(from) : `${from}–${to}`;
}

/** Temporadas con trayectoria (para el título de la sección): "2014–2026". */
export function careerSpan(career: CareerSeason[] | undefined): string {
  const seasons = (career ?? []).map((c) => c.season);
  if (!seasons.length) return '';
  const min = Math.min(...seasons);
  const max = Math.max(...seasons);
  return min === max ? String(min) : `${min}–${max}`;
}
