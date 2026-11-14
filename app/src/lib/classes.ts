import { driverId, isSingleDriverName, splitDriverNames, type ResultRow } from '@dm/shared';

/**
 * Resultados de categorías con clases (WEC, ELMS, Asian LMS, IMSA, GT World Challenge, 24H Series, Super GT…): cada
 * fila trae `class` y, si la fuente lo publica, `classPos`; `pos` es siempre el puesto en la general.
 */

/** Clases de una sesión en el orden en que aparecen en la general (la primera suele ser la principal). */
export function resultClasses(rows: ResultRow[]): string[] {
  const out: string[] = [];
  for (const r of rows) {
    const c = r.class?.trim();
    if (c && !out.includes(c)) out.push(c);
  }
  return out;
}

/** true si la sesión tiene más de una clase (con una sola, el selector no aporta nada). */
export function hasClasses(rows: ResultRow[]): boolean {
  return resultClasses(rows).length > 1;
}

/** Fila con el puesto dentro de su clase ya resuelto (el publicado o, si falta, el calculado). */
export interface ClassRow extends ResultRow {
  classPos?: number;
}

/**
 * Filas de una clase, en el orden de la general, con `classPos`: el que publica la fuente o, si falta, el que sale de
 * ordenar por la general a los clasificados de la clase (los que no tienen puesto —DNF, NC— quedan sin puesto).
 */
export function classRows(rows: ResultRow[], cls: string): ClassRow[] {
  const inClass = rows.filter((r) => r.class?.trim() === cls);
  const ranked = inClass
    .filter((r) => r.pos !== null && r.pos !== undefined)
    .sort((a, b) => (a.pos as number) - (b.pos as number));
  const computed = new Map(ranked.map((r, i) => [r, i + 1]));
  return inClass.map((r) => {
    const pos = r.classPos ?? computed.get(r);
    return pos !== undefined ? { ...r, classPos: pos } : { ...r };
  });
}

/** Puesto en la clase de una fila de la general (el publicado o el calculado), o undefined. */
export function classPosOf(rows: ResultRow[], row: ResultRow): number | undefined {
  if (row.classPos !== undefined) return row.classPos;
  const cls = row.class?.trim();
  if (!cls || row.pos === null || row.pos === undefined) return undefined;
  const ranked = rows
    .filter((r) => r.class?.trim() === cls && r.pos !== null && r.pos !== undefined)
    .sort((a, b) => (a.pos as number) - (b.pos as number));
  const i = ranked.indexOf(row);
  return i < 0 ? undefined : i + 1;
}

/** Los tres primeros de una clase (P1–P3 de la clase), en orden. */
export function classPodium(rows: ResultRow[], cls: string): ClassRow[] {
  const list = classRows(rows, cls);
  const out: ClassRow[] = [];
  for (const pos of [1, 2, 3]) {
    const row = list.find((r) => r.classPos === pos);
    if (row) out.push(row);
  }
  return out;
}

/** Ganador de cada clase, en el orden de las clases. */
export function classWinners(rows: ResultRow[]): Array<{ class: string; row: ClassRow }> {
  const out: Array<{ class: string; row: ClassRow }> = [];
  for (const cls of resultClasses(rows)) {
    const row = classRows(rows, cls).find((r) => r.classPos === 1);
    if (row) out.push({ class: cls, row });
  }
  return out;
}

/** Integrante de una tripulación (o el piloto único) con su id en la app. */
export interface CrewMember {
  name: string;
  id: string;
}

/**
 * Pilotos de una fila: uno solo, o cada integrante de una tripulación ("A / B / C"). Si el nombre no se puede
 * separar en pilotos identificables, devuelve el texto entero sin id.
 */
export function crewMembers(raw: string, seriesId?: string): CrewMember[] {
  if (isSingleDriverName(raw)) return [{ name: raw.trim(), id: driverId(raw, seriesId) }];
  const names = splitDriverNames(raw);
  if (!names.length) return [{ name: raw.trim(), id: '' }];
  return names.map((name) => ({ name, id: driverId(name, seriesId) }));
}

/** Paleta de las clases, por orden de aparición: se repite si hay más de seis. */
const CLASS_TONES = 6;

/** Tono (0–5) de una clase según su orden en la sesión, para el chip. */
export function classTone(classes: string[], cls: string | undefined): number {
  const i = cls ? classes.indexOf(cls.trim()) : -1;
  return i < 0 ? 0 : i % CLASS_TONES;
}

/**
 * Clase de un piloto en una sesión: la de la fila en la que figura (solo o en una tripulación), con su puesto en la
 * clase. Sirve para la ficha del piloto ("P2 en LMP2").
 */
export function driverClassResult(
  rows: ResultRow[],
  id: string,
  seriesId?: string,
): { class: string; classPos?: number; pos: number | null } | null {
  if (!hasClasses(rows)) return null;
  const row = rows.find((r) => crewMembers(r.driver, seriesId).some((m) => m.id === id));
  const cls = row?.class?.trim();
  if (!row || !cls) return null;
  const classPos = classPosOf(rows, row);
  return { class: cls, pos: row.pos ?? null, ...(classPos !== undefined ? { classPos } : {}) };
}
