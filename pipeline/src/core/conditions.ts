/**
 * Completado de las condiciones medidas en pista (`SessionResult.conditions`) en resultados YA guardados.
 *
 * Las sesiones nuevas reciben sus condiciones junto con el resultado (el lector las devuelve en `results`). Esto es
 * para las demás: las que se guardaron antes de que el lector las supiera leer, o cuya fuente las publicó más tarde.
 * Reglas (para no molestar a las fuentes ni poner en riesgo lo publicado):
 *
 *  - Corre aparte de la búsqueda de resultados: no marca sesiones como pendientes, no vuelve a pedir resultados y no
 *    toca data/_cache/results-attempts.json. Lleva su propio registro en data/_cache/conditions-attempts.json.
 *  - Por corrida y serie se consultan como mucho MAX_CONDITIONS_PER_RUN sesiones, de la más reciente a la más vieja:
 *    una temporada entera se completa sola en unas pocas corridas y después no se pide nada más.
 *  - Una sesión consultada MAX_CONDITION_ATTEMPTS veces sin dato se da por "la fuente no publica sus condiciones".
 *    Las que el lector no llegó a consultar de verdad (`deferred`: 429, 5xx, sin respuesta) no gastan intento.
 *  - Solo AGREGA `conditions` a sesiones que no las tienen: nunca cambia filas, fuente ni otras sesiones, y cualquier
 *    error (de red, del lector o al escribir) se registra y deja el archivo de resultados como estaba.
 */
import path from 'node:path';
import {
  eventResultsFileSchema,
  type EventResultsFile,
  type MotorEvent,
  type Series,
  type Session,
  type SessionConditions,
} from '@dm/shared';
import { HttpError } from './http.ts';
import { readJson, writeJson } from './store.ts';
import type { Adapter, AdapterContext } from './types.ts';

/** Tope de sesiones por serie y corrida a las que se les buscan las condiciones. */
export const MAX_CONDITIONS_PER_RUN = 24;
/** Consultas sin dato tras las cuales una sesión deja de buscarse. */
export const MAX_CONDITION_ATTEMPTS = 3;

export type ConditionsLog = Record<string, { count: number; last: string }>;

export function conditionsLogFile(cacheDir: string): string {
  return path.join(cacheDir, 'conditions-attempts.json');
}

/** true si las condiciones traen al menos una medición (un objeto vacío o con solo la fuente no se publica). */
export function hasMeasurement(c: SessionConditions | undefined | null): c is SessionConditions {
  if (!c) return false;
  return (
    [c.airC, c.trackC, c.humidity, c.windKmh].some((n) => typeof n === 'number' && Number.isFinite(n)) ||
    !!c.track ||
    !!c.weather
  );
}

/**
 * true si el error indica que la fuente no se pudo consultar ahora (pidió esperar, falló, rechazó el pedido o no
 * respondió), a diferencia de "respondió y no tiene el dato" (404). Los lectores lo usan para dejar de pedir en la
 * corrida y devolver esas sesiones como `deferred`.
 */
export function sourceUnavailable(err: unknown): boolean {
  if (err instanceof HttpError) return [401, 403, 408, 429].includes(err.status) || err.status >= 500;
  return true;
}

/**
 * Sesiones con resultado guardado y sin condiciones que todavía vale la pena consultar, de la más reciente a la
 * más vieja y acotadas a `limit`. `skip` son las que el lector acaba de leer en esta misma corrida.
 */
export function sessionsWithoutConditions(
  files: Array<Pick<EventResultsFile, 'sessions'>>,
  sessions: Session[],
  log: ConditionsLog,
  skip: ReadonlySet<string> = new Set(),
  limit = MAX_CONDITIONS_PER_RUN,
): Session[] {
  const missing = new Set<string>();
  for (const f of files) {
    for (const s of f.sessions) if (s.rows.length > 0 && !hasMeasurement(s.conditions)) missing.add(s.sessionId);
  }
  return sessions
    .filter((s) => missing.has(s.id) && !skip.has(s.id) && (log[s.id]?.count ?? 0) < MAX_CONDITION_ATTEMPTS)
    .sort((a, b) => b.startUtc.localeCompare(a.startUtc))
    .slice(0, limit);
}

/**
 * Agrega las condiciones halladas a las sesiones del archivo que no las tienen. Devuelve el archivo nuevo, o null
 * si no hubo nada que agregar. No modifica `file`.
 */
export function applyConditions(
  file: EventResultsFile,
  found: ReadonlyMap<string, SessionConditions>,
  updatedAt: string,
): EventResultsFile | null {
  let changed = false;
  const sessions = file.sessions.map((s) => {
    const c = found.get(s.sessionId);
    if (!hasMeasurement(c) || hasMeasurement(s.conditions) || s.rows.length === 0) return s;
    changed = true;
    return { ...s, conditions: c };
  });
  return changed ? { ...file, updatedAt, sessions } : null;
}

// Las series corren en paralelo y comparten el registro: las actualizaciones se encolan para no pisarse.
let logQueue: Promise<unknown> = Promise.resolve();

async function readLog(file: string): Promise<ConditionsLog> {
  try {
    return (await readJson<ConditionsLog>(file)) ?? {};
  } catch {
    return {}; // registro ilegible: se empieza de nuevo (a lo sumo se repiten algunas consultas)
  }
}

function updateLog(file: string, change: (log: ConditionsLog) => void): Promise<void> {
  const next = logQueue.then(async () => {
    const log = await readLog(file);
    change(log);
    await writeJson(file, log);
  });
  logQueue = next.catch(() => undefined);
  return next;
}

/**
 * Busca las condiciones de las sesiones de la serie que tienen resultado y no las tienen, y las agrega a
 * data/results/{serie}/{evento}.json. Devuelve cuántas sesiones completó. Nunca lanza.
 */
export async function fillConditionsForSeries(
  series: Series,
  adapter: Adapter,
  ctx: AdapterContext,
  events: MotorEvent[],
  sessions: Session[],
  dataDir: string,
  dryRun: boolean,
  skip: ReadonlySet<string> = new Set(),
): Promise<number> {
  if (!adapter.conditions) return 0;
  try {
    const fileOf = (eventId: string) => path.join(dataDir, 'results', series.id, `${eventId}.json`);
    const logFile = conditionsLogFile(ctx.cacheDir);
    const log = await readLog(logFile);

    const eventIds = [...new Set(sessions.filter((s) => s.hasResults).map((s) => s.eventId))];
    const files: EventResultsFile[] = [];
    for (const id of eventIds) {
      const file = await readJson(fileOf(id), eventResultsFileSchema).catch(() => null);
      if (file) files.push(file);
    }
    const wanted = sessionsWithoutConditions(files, sessions, log, skip);
    if (wanted.length === 0) return 0;

    const chunk = await adapter.conditions(series, ctx, { events, sessions: wanted });
    const asked = new Set(wanted.map((s) => s.id));
    const found = new Map([...chunk.conditions].filter(([id, c]) => asked.has(id) && hasMeasurement(c)));
    const deferred = new Set((chunk.deferred ?? []).filter((id) => asked.has(id) && !found.has(id)));
    const nowIso = ctx.now.toISOString().replace(/\.\d{3}Z$/, 'Z');

    let filled = 0;
    for (const eventId of new Set(wanted.filter((s) => found.has(s.id)).map((s) => s.eventId))) {
      // Se relee justo antes de escribir: el archivo pudo cambiar durante la consulta.
      const current = await readJson(fileOf(eventId), eventResultsFileSchema);
      const updated = current && applyConditions(current, found, nowIso);
      if (!current || !updated) continue;
      filled += updated.sessions.filter((s, i) => s !== current.sessions[i]).length;
      if (!dryRun) await writeJson(fileOf(eventId), eventResultsFileSchema.parse(updated));
    }

    if (!dryRun) {
      await updateLog(logFile, (fresh) => {
        for (const s of wanted) {
          if (found.has(s.id)) delete fresh[s.id];
          else if (!deferred.has(s.id)) fresh[s.id] = { count: (fresh[s.id]?.count ?? 0) + 1, last: nowIso };
        }
      });
    }
    const without = wanted.length - found.size - deferred.size;
    ctx.log.info(
      `Condiciones de pista: ${filled} sesión(es) completadas` +
        (without > 0 ? `, ${without} sin dato en la fuente` : '') +
        (deferred.size > 0 ? `, ${deferred.size} para la próxima corrida` : ''),
    );
    return filled;
  } catch (err) {
    ctx.log.warn(`Condiciones de pista: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
