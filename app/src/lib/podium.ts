import {
  driverDisplayName,
  isSingleDriverName,
  splitDriverNames,
  type ResultRow,
  type Session,
  type SessionResult,
  type SessionType,
} from '@dm/shared';

/**
 * Resultados de un vistazo: podio de la sesión principal de un evento ("1. Norris · 2. Verstappen ·
 * 3. Hadjar"), sesión que se muestra primero en la pestaña Resultados y vuelta rápida.
 */

/**
 * Sesiones de carrera, de la más importante a la menos: la "principal" de un evento es la última del primer tipo presente.
 * En un rally cuentan también los bloques de tramos o etapas ("etapa"): mientras no esté el resultado final, la
 * clasificación más reciente es la del último bloque (y no la del shakedown).
 */
const RACE_PRIORITY: SessionType[] = ['carrera', 'sprint', 'serie', 'etapa'];

export function isRaceType(type: SessionType | undefined): boolean {
  return !!type && RACE_PRIORITY.includes(type);
}

type SessionLike = Pick<Session, 'id' | 'type' | 'startUtc'>;

function byStart(sessions: SessionLike[]) {
  const start = new Map(sessions.map((s) => [s.id, s.startUtc]));
  return (a: { sessionId: string }, b: { sessionId: string }) =>
    (start.get(a.sessionId) ?? '').localeCompare(start.get(b.sessionId) ?? '');
}

/**
 * Orden de los chips de sesión: primero las carreras (carrera, sprint, carreras clasificatorias), después el
 * resto; dentro de cada grupo, por hora de inicio.
 */
export function orderResultSessions<T extends { sessionId: string }>(results: T[], sessions: SessionLike[]): T[] {
  const type = new Map(sessions.map((s) => [s.id, s.type]));
  const sorted = [...results].sort(byStart(sessions));
  return [...sorted.filter((r) => isRaceType(type.get(r.sessionId))), ...sorted.filter((r) => !isRaceType(type.get(r.sessionId)))];
}

/**
 * Sesión principal con resultado: la última "carrera" (la Feature en F2/F3, la carrera del domingo en
 * MotoGP); si no hay, la última sprint o carrera clasificatoria; si tampoco, la última sesión con resultado.
 */
export function mainResultSession<T extends { sessionId: string; rows: ResultRow[] }>(
  results: T[],
  sessions: SessionLike[],
): T | undefined {
  const type = new Map(sessions.map((s) => [s.id, s.type]));
  const withRows = [...results].filter((r) => r.rows.length > 0).sort(byStart(sessions));
  for (const t of RACE_PRIORITY) {
    const races = withRows.filter((r) => type.get(r.sessionId) === t);
    if (races.length) return races[races.length - 1];
  }
  return withRows[withRows.length - 1];
}

/**
 * Los tres primeros clasificados (P1–P3) en orden. Las filas sin posición (DNF, NC, DSQ…) no cuentan, aunque
 * aparezcan antes en la tabla; si falta alguna posición, el podio queda más corto.
 */
export function podium(rows: ResultRow[]): ResultRow[] {
  const out: ResultRow[] = [];
  for (const pos of [1, 2, 3]) {
    const row = rows.find((r) => r.pos === pos);
    if (row) out.push(row);
  }
  return out;
}

const SUFFIX = /^(jr\.?|sr\.?|ii|iii|iv)$/i;
const PARTICLES = new Set(['de', 'del', 'la', 'da', 'das', 'do', 'dos', 'di', 'van', 'von', 'der', 'den', 'le', 'mc']);

/** Apellido de un piloto: "Kimi Antonelli" -> "Antonelli", "Laurens van Hoepen" -> "van Hoepen", "Ricky Stenhouse Jr" -> "Stenhouse Jr". */
function surnameOf(name: string): string {
  const words = driverDisplayName(name).split(/\s+/).filter(Boolean);
  if (words.length <= 1) return words[0] ?? name.trim();
  const end = words.length - 1;
  // "Stenhouse Jr": el sufijo va con el apellido.
  let start = SUFFIX.test(words[end]!) && end > 1 ? end - 1 : end;
  while (start > 1 && PARTICLES.has(words[start - 1]!.toLowerCase())) start--;
  return words.slice(start, end + 1).join(' ');
}

/**
 * Nombre corto para el podio en una línea: el apellido; en una tripulación de resistencia ("A / B / C"),
 * los apellidos unidos por "/".
 */
export function shortDriverName(raw: string): string {
  if (isSingleDriverName(raw)) return surnameOf(raw);
  const names = splitDriverNames(raw);
  return names.length ? names.map(surnameOf).join('/') : raw.trim();
}

/** "1. Antonelli · 2. Russell · 3. Verstappen" (vacío si no hay podio). */
export function podiumLine(rows: ResultRow[]): string {
  return podium(rows)
    .map((r) => `${r.pos}. ${shortDriverName(r.driver)}`)
    .join(' · ');
}

/** "1:21.493" -> 81.493 segundos (NaN si no es un tiempo). */
export function lapSeconds(text: string | undefined): number {
  const m = text?.trim().match(/^(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return NaN;
  return Number(m[1] ?? 0) * 60 + Number(m[2]);
}

/** Vuelta más rápida de la sesión según la columna "mejor vuelta" (si la fuente la publica). */
export function fastestLap(rows: ResultRow[]): { row: ResultRow; time: string } | null {
  let best: { row: ResultRow; time: string; s: number } | null = null;
  for (const row of rows) {
    const s = lapSeconds(row.bestLap);
    if (!Number.isNaN(s) && s > 0 && (!best || s < best.s)) best = { row, time: row.bestLap!.trim(), s };
  }
  return best ? { row: best.row, time: best.time } : null;
}

/** Ganador de la sesión principal de un evento (si hay resultados). */
export function eventWinner(results: SessionResult[], sessions: SessionLike[]): ResultRow | null {
  const main = mainResultSession(results, sessions);
  return main ? (podium(main.rows)[0] ?? null) : null;
}
