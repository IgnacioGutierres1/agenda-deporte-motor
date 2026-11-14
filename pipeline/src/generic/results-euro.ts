/**
 * Utilidades comunes de los lectores de resultados de DTM, NLS, 24H Series, GT Open, Porsche Supercup y F1 Academy
 * (tanda 5): unir cada resultado con la sesión pedida, armar las filas del PDF por renglón y dar formato a
 * diferencias y puestos por clase.
 */
import { localToUtc, type ResultRow, type Session, type SessionConditions, type Source } from '@dm/shared';
import { classifySession } from '../core/builders.ts';
import { HttpError } from '../core/http.ts';
import type { PdfItem } from '../adapters/fia-documents.ts';
import { isoNow } from './kit.ts';
import type { RecipeContext } from './types.ts';

/** Texto comparable de un nombre de sesión: sin tildes, mayúsculas ni signos ("Free Practice 1" -> "free practice 1"). */
export function sessionKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Sesión de la fuente de resultados (nombre como lo publica y, si se conoce, su hora de inicio). */
export interface SourceSession {
  name: string;
  startUtc?: string;
}

/** Margen para unir por hora una sesión de la fuente con una del cronograma (los horarios se corren un poco). */
const START_TOLERANCE_MS = 50 * 60_000;

/**
 * Sesión pedida que corresponde a una de la fuente: primero por nombre (el original de la fuente o el guardado),
 * después por tipo y hora de inicio y, si no hay hora, por tipo cuando hay una sola de ese tipo en los dos lados.
 * `all` son todas las sesiones de la fuente para el evento (para no asignar dos veces por tipo).
 */
export function pickSession(sessions: Session[], wanted: SourceSession, all: SourceSession[]): Session | undefined {
  const key = sessionKey(wanted.name);
  const byName = sessions.find((s) => sessionKey(s.originalName ?? s.name) === key || sessionKey(s.name) === key);
  if (byName) return byName;
  const type = classifySession(wanted.name);
  const sameType = sessions.filter((s) => s.type === type);
  if (wanted.startUtc) {
    const t = Date.parse(wanted.startUtc);
    const near = sameType.filter((s) => Math.abs(Date.parse(s.startUtc) - t) <= START_TOLERANCE_MS);
    if (near.length === 1) return near[0];
  }
  const sourceSameType = all.filter((s) => classifySession(s.name) === type);
  if (sameType.length === 1 && sourceSameType.length === 1) return sameType[0];
  // Mismo número de sesiones de ese tipo en los dos lados (p. ej. "Race 6"/"Race 7" contra "Carrera 1"/"Carrera 2"):
  // se unen por orden, si la fuente da la hora de todas.
  if (sameType.length > 1 && sameType.length === sourceSameType.length && sourceSameType.every((s) => s.startUtc)) {
    const rank = [...sourceSameType].sort((a, b) => a.startUtc!.localeCompare(b.startUtc!))
      .findIndex((s) => s.name === wanted.name && s.startUtc === wanted.startUtc);
    return rank >= 0 ? [...sameType].sort((a, b) => a.startUtc.localeCompare(b.startUtc))[rank] : undefined;
  }
  return undefined;
}

/** "+1 vuelta" / "+3 vueltas" (como el resto de los lectores). */
export const lapsGap = (n: number): string => `+${n} ${n === 1 ? 'vuelta' : 'vueltas'}`;

/** Diferencia en tiempo: "4.857" -> "+4.857s", "1:03.669" -> "+1:03.669". undefined si no es un tiempo. */
export function timeGap(raw: string): string | undefined {
  const t = raw.trim().replace(/^\+/, '').replace(/s$/i, '');
  if (!/^\d+(?::\d{2})*\.\d+$/.test(t) && !/^\d+:\d{2}(?::\d{2})?$/.test(t)) return undefined;
  return `+${t}${t.includes(':') ? '' : 's'}`;
}

/**
 * Puesto en la clase cuando la fuente no lo da: orden de la general dentro de cada clase (solo autos clasificados;
 * los que no tienen puesto quedan sin puesto en la clase).
 */
export function fillClassPositions(rows: ResultRow[]): ResultRow[] {
  const counter = new Map<string, number>();
  return rows.map((r) => {
    if (!r.class || r.classPos !== undefined || r.pos === null) return r;
    const n = (counter.get(r.class) ?? 0) + 1;
    counter.set(r.class, n);
    return { ...r, classPos: n };
  });
}

const NAME_PARTICLES = new Set(['van', 'von', 'der', 'den', 'de', 'di', 'da', 'du', 'del', 'della', 'la', 'le', 'ten', 'ter']);

/**
 * Apellidos en mayúsculas de las planillas de cronometraje a formato nombre: "Kelvin VAN DER LINDE" -> "Kelvin van
 * der Linde", "Robert DE HAAN" -> "Robert de Haan", "Wei SHI" -> "Wei Shi". Las palabras con minúsculas no se tocan.
 */
export function driverCase(name: string): string {
  return name
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map((w, i) => {
      if (!/\p{Lu}{2}/u.test(w) || w !== w.toUpperCase()) return w;
      const lower = w.toLowerCase();
      if (i > 0 && NAME_PARTICLES.has(lower)) return lower;
      return lower.replace(/(^|[-'’])(\p{L})/gu, (_, p: string, c: string) => p + c.toUpperCase());
    })
    .join(' ');
}

/** Fuente directa (sin IA) de un resultado. */
export function directSource(url: string, title: string, kind: Source['kind'], ctx: RecipeContext): Source {
  return { url, title, kind, method: 'directo', fetchedAt: isoNow(ctx.now) };
}

/** true si el error es de los que piden esperar (429 o 5xx): la sesión queda para la próxima corrida sin contar intento. */
export function isTransient(err: unknown): boolean {
  return err instanceof HttpError && (err.status === 429 || err.status >= 500);
}

/** Renglones de un PDF: ítems de la misma página con la misma altura (± tol), de izquierda a derecha. */
export function pdfLines(items: PdfItem[], tol = 2): PdfItem[][] {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const out: PdfItem[][] = [];
  for (const it of sorted) {
    const last = out.at(-1);
    if (last && last[0]!.page === it.page && Math.abs(last[0]!.y - it.y) <= tol) last.push(it);
    else out.push([it]);
  }
  return out.map((l) => l.sort((a, b) => a.x - b.x));
}

/** Hora UTC estimada para una sesión cuya fuente solo da el día: hora local fija según el tipo de sesión. */
export function estimatedStart(date: string, name: string, tz: string, hours: Partial<Record<string, string>> = {}): string {
  const type = classifySession(name);
  const local = hours[type] ?? DEFAULT_HOURS[type] ?? '12:00';
  return localToUtc(date, local, tz);
}

const DEFAULT_HOURS: Partial<Record<string, string>> = {
  practica: '10:00',
  clasificacion: '10:00',
  warmup: '09:00',
  carrera: '14:00',
  sprint: '14:00',
};

/**
 * Condiciones medidas que publican los PDF de cronometraje ("Track Temp: 25.5 °C", "Air Temp: 18.6 °C",
 * "Humidity: 64 %", "Track Status: WET"). undefined si el texto no trae ninguna.
 */
export function pdfConditions(text: string): SessionConditions | undefined {
  const num = (re: RegExp) => {
    const m = text.match(re);
    return m ? Number(m[1]!.replace(',', '.')) : undefined;
  };
  const trackC = num(/track\s*temp\w*\s*:?\s*(-?\d+(?:[.,]\d+)?)\s*°?\s*c/i);
  const airC = num(/air\s*temp\w*\s*:?\s*(-?\d+(?:[.,]\d+)?)\s*°?\s*c/i);
  const humidity = num(/humidity\s*:?\s*(\d+(?:[.,]\d+)?)\s*%/i);
  const status = text.match(/track\s*status\s*:?\s*([a-z]+)/i)?.[1]?.toLowerCase();
  const track = status === 'wet' ? 'Mojada' : status === 'dry' ? 'Seca' : status === 'damp' ? 'Húmeda' : undefined;
  const out: SessionConditions = {
    ...(airC !== undefined ? { airC } : {}),
    ...(trackC !== undefined ? { trackC } : {}),
    ...(humidity !== undefined ? { humidity } : {}),
    ...(track ? { track } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}
