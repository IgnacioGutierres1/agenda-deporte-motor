/**
 * Cronogramas de las categorías argentinas publicados como texto (tabla HTML o PDF con texto), sin IA.
 * Cada día lo encabeza una línea con el día ("Sábado 31-10", "SABADO 10/10", "JUEVES 15 DE OCTUBRE DE 2026")
 * y cada renglón empieza con la hora ("08.40 a 09.10 2 B 1° entrenamiento",
 * "13:09 TURISMO PISTA CLASE 1 1° SERIE – 5 VUELTAS"). Qué categoría y clase es cada renglón lo resuelve
 * el lector de cada sitio (apat.ts, aptp.ts); acá están las partes comunes.
 */
import { localToUtc } from '@dm/shared';
import { DateTime } from 'luxon';
import { pdfToText } from '../extract/document.ts';
import { textOf } from '../extract/html.ts';
import { shiftDate } from './places.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext } from './types.ts';

/** Días posibles del cronograma: desde dos días antes del primero del evento (verificaciones) hasta el último. */
export interface DayWindow {
  from: string;
  to: string;
}

export const eventWindow = (entry: Pick<CalendarEntry, 'dateStart' | 'dateEnd'>): DayWindow => ({
  from: shiftDate(entry.dateStart, -2),
  to: entry.dateEnd,
});

const WEEKDAYS: Record<string, number> = { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6, domingo: 7 };
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const HEADER = /^(lunes|martes|miercoles|jueves|viernes|sabado|domingo)\b\.?\s*(?:(\d{1,2})\s*(?:[-/.]\s*(\d{1,2})|de\s+([a-z]+)))?/;

/**
 * Fecha de un encabezado de día dentro de la ventana del evento. undefined si la línea no es un encabezado;
 * null si lo es pero no se puede ubicar. Manda el día de la semana: los organizadores copian el cronograma de
 * la fecha anterior y a veces queda mal el número ("Domingo 11-10" en el cronograma del 1° de noviembre).
 */
export function headerDate(line: string, window: DayWindow): string | null | undefined {
  const m = fold(line).match(HEADER);
  if (!m) return undefined;
  const weekday = WEEKDAYS[m[1]!]!;
  const day = m[2] ? Number(m[2]) : null;
  const month = m[3] ? Number(m[3]) : m[4] ? MONTHS.indexOf(m[4]) + 1 || null : null;
  const dates: DateTime[] = [];
  for (let d = DateTime.fromISO(window.from); d.toISODate()! <= window.to; d = d.plus({ days: 1 })) dates.push(d);
  const exact = day && month ? dates.find((d) => d.day === day && d.month === month && d.weekday === weekday) : undefined;
  if (exact) return exact.toISODate()!;
  const sameWeekday = dates.filter((d) => d.weekday === weekday);
  return sameWeekday.length === 1 ? sameWeekday[0]!.toISODate()! : null;
}

/** Renglón con hora de un cronograma, con su fecha ya resuelta. */
export interface TimetableRow {
  date: string;
  /** HH:MM */
  start: string;
  end?: string;
  /** Hora de inicio tal como figura ("08.40"). */
  startText: string;
  /** Lo que sigue a la hora (categoría, clase, grupo, actividad). */
  text: string;
}

const TIME = String.raw`(\d{1,2})[.:,](\d{2})`;
const ROW = new RegExp(String.raw`^${TIME}(?:\s*(?:hs\.?)?\s*(?:a|al|-|–)\s*${TIME})?\s*(?:hs\.?)?\s+(.+)$`, 'i');

const clock = (h: string, m: string): string | null =>
  Number(h) < 24 && Number(m) < 60 ? `${h.padStart(2, '0')}:${m}` : null;

/**
 * Renglones con hora de un cronograma en texto (una línea por renglón; las celdas de una tabla pueden venir
 * separadas por " | ", como las deja htmlToText). Los renglones de días que no caen en la ventana del evento
 * se descartan: así un cronograma de otra fecha no se toma por el de este evento.
 */
export function timetableRows(text: string, window: DayWindow): TimetableRow[] {
  const rows: TimetableRow[] = [];
  let date: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s*\|\s*/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const day = headerDate(line, window);
    if (day !== undefined) {
      date = day;
      continue;
    }
    if (!date) continue;
    const m = line.match(ROW);
    if (!m) continue;
    const start = clock(m[1]!, m[2]!);
    if (!start) continue;
    const end = m[3] ? clock(m[3], m[4]!) : null;
    // La línea empieza con la hora: "08.40", "13:09"… tal como figura.
    const startText = line.slice(0, m[1]!.length + 1 + m[2]!.length);
    rows.push({ date, start, ...(end && end > start ? { end } : {}), startText, text: m[5]!.trim() });
  }
  return rows;
}

/** Actividades en pista (lo demás de un cronograma son verificaciones, reuniones, transmisiones…). */
export const AR_SESSION = /entrenamiento|clasificaci|\bserie|final|carrera|tanda|prueba libre|pr[aá]ctica|warm|shakedown/i;
export const AR_NOT_SESSION =
  /salida a pista|apertura de boxes|cierre de boxes|pregrilla|podio|reuni[oó]n|sorteo|entrega|verificaci|acredita|combustible|parciales|transmisi|promoci|desarme|ingreso|sensores|sellado|conferencia|institucional|activaci|momento|neum[aá]tico|briefing|charla/i;

/**
 * Nombre de la actividad tal como figura, sin "Vuelta previa y" adelante ni la cantidad de vueltas atrás
 * ("Vuelta Previa y Final– 16 vueltas o 35 minutos" -> "Final"), sin mayúsculas sostenidas y con el grupo aparte.
 */
export function activityName(text: string): { name: string; group?: string } {
  let t = text.replace(/^vuelta\s+previa\s+y\s+/i, '');
  const g = t.match(/\s*[-–—]?\s*grupo\s*[-–—]?\s*([a-z])\b/i);
  const group = g?.[1]?.toUpperCase();
  if (g) t = t.replace(g[0], ' ');
  t = t
    .replace(/\s*[-–—]?\s*\d+\s*(?:vueltas?|vtas?)\b.*$/i, '')
    .replace(/[\s\-–—]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const upper = (t.match(/[A-ZÁÉÍÓÚÑ]/g) ?? []).length;
  const lower = (t.match(/[a-záéíóúñ]/g) ?? []).length;
  if (upper > lower) {
    t = t.toLowerCase().replace(/\b(i{1,3}|iv)\b/g, (r) => r.toUpperCase());
  }
  t = t.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  return { name: t, ...(group ? { group } : {}) };
}

export const isTrackSession = (activity: string) => AR_SESSION.test(activity) && !AR_NOT_SESSION.test(activity.replace(/^vuelta\s+previa\s+y\s+/i, ''));

/** Sesión de una clase ("1° entrenamiento (Clase 2, grupo A)"), con horas en UTC. */
export function classSession(row: TimetableRow, cls: string, activity: string, tz: string): ExtractedSession {
  const { name, group } = activityName(activity);
  const label = /\d\D+\d/.test(cls) ? `Clases ${cls.replace(/\D+/g, ' y ')}` : `Clase ${cls}`;
  return {
    name: `${name} (${label}${group ? `, grupo ${group}` : ''})`,
    startUtc: localToUtc(row.date, row.start, tz),
    ...(row.end ? { endUtc: localToUtc(row.date, row.end, tz) } : {}),
    localStartText: row.startText,
  };
}

/**
 * Texto de un cronograma en HTML, una línea por fila de tabla o párrafo y las celdas separadas por " | ".
 * (htmlToText respeta los saltos de línea del código fuente, que en estas tablas parten cada fila en celdas.)
 */
export function htmlTimetableText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/<\/(td|th)>/gi, ' | ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|table)>/gi, '\n')
    .split('\n')
    .map(textOf)
    .filter(Boolean)
    .join('\n');
}

export const byStart =(a: ExtractedSession, b: ExtractedSession) => a.startUtc.localeCompare(b.startUtc);

/** Texto de un PDF oficial; null si no se pudo descargar o no tiene texto. */
export async function pdfText(ctx: RecipeContext, url: string): Promise<string | null> {
  try {
    const res = await ctx.http.bytes(url);
    const text = await pdfToText(res.body);
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/** "undécima fecha", "11° fecha", "fecha 11" -> 11 (null si no hay número de fecha). */
export function fechaNumber(text: string): number | null {
  const t = fold(text).replace(/\s+/g, ' ');
  const numeric = t.match(/(\d{1,2})\s*(?:°|º|ª|a|ra|da|ta|va|na|ma)?\.?\s+fecha\b/) ?? t.match(/\bfecha\s*(?:n[°º.]?\s*)?(\d{1,2})\b/);
  if (numeric) return Number(numeric[1]);
  const ordinal = t.match(/\b([a-z]+(?:\s+[a-z]+)?)\s+fecha\b/);
  if (!ordinal) return null;
  const words = ordinal[1]!.split(' ');
  return ORDINALS[words.join('')] ?? ORDINALS[words.at(-1)!] ?? null;
}

const ORDINALS: Record<string, number> = {
  primera: 1, segunda: 2, tercera: 3, cuarta: 4, quinta: 5, sexta: 6, septima: 7, setima: 7, octava: 8, novena: 9,
  decima: 10, undecima: 11, decimoprimera: 11, duodecima: 12, decimosegunda: 12, decimotercera: 13, decimocuarta: 14,
  decimoquinta: 15, decimosexta: 16,
};
