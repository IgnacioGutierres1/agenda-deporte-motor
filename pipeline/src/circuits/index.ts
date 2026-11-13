/**
 * Fichas de circuitos: data/circuits.json con un CircuitInfo por circuito del calendario (coordenadas, datos del
 * trazado, extracto, foto y plano), armadas con fuentes abiertas: Wikidata, Wikipedia, Wikimedia Commons y, para
 * las coordenadas aproximadas de una ciudad, el geocoding de Open-Meteo.
 *
 * - El id de cada ficha es circuitId(event.circuit), el mismo con que la app agrupa los eventos.
 * - Solo se consultan los circuitos nuevos, los que tienen `checkedAt` de más de 30 días y los que cambiaron en
 *   config/circuits.json (correcciones manuales), con un tope por corrida. Los ya identificados se releen por su
 *   id de Wikidata, sin volver a buscar.
 * - Se trabaja por lotes: cada lote terminado se guarda; si una fuente falla o pide frenar, se corta ahí y el
 *   resto queda para la próxima corrida. Nunca lanza: los circuitos no pueden hacer fallar el pipeline.
 * - Al refrescar se conservan `hasTrack` (lo escribe la fase de trazados) y los campos que la nueva consulta no
 *   trae.
 */
import path from 'node:path';
import { circuitsFileSchema, type CircuitInfo, type CircuitsFile, type MotorEvent, type Series } from '@dm/shared';
import type { Http } from '../core/http.ts';
import type { Logger } from '../core/log.ts';
import { DATA_DIR } from '../core/paths.ts';
import { readJson, writeJson } from '../core/store.ts';
import { createApi, type Api, type ResponseCache } from './api.ts';
import { groupCircuits, type CircuitGroup } from './group.ts';
import { loadCircuitOverrides, type CircuitOverride } from './overrides.ts';
import { ordered, resolveCircuits, type CircuitReport, type ResolveInput } from './resolve.ts';

export { groupCircuits, type CircuitGroup } from './group.ts';
export type { CircuitReport } from './resolve.ts';

export interface RunCircuitsOptions {
  /** Eventos del calendario recién armado. */
  events: Array<Pick<MotorEvent, 'circuit' | 'country' | 'seriesId'>>;
  /** Categorías (para saber cuáles son de rally: su "circuito" es una ciudad base). */
  series?: Array<Pick<Series, 'id' | 'group'>>;
  log: Logger;
  /** Cliente HTTP (tests). Por defecto se crea uno propio, sin reintentos automáticos. */
  http?: Http;
  now?: Date;
  dataDir?: string;
  configDir?: string;
  dryRun?: boolean;
  /** Tope de circuitos a consultar en la corrida (0 = sin tope). */
  limit?: number;
  /** Días de validez de una ficha antes de volver a consultarla. */
  maxAgeDays?: number;
  /** Circuitos por lote (cada lote terminado se guarda). */
  batchSize?: number;
  /** Pausa entre requests a Wikimedia, en ms (por defecto CIRCUITS_PAUSE_MS o 6500). */
  pauseMs?: number;
  /** Volver a consultar todos, aunque no hayan vencido. */
  force?: boolean;
  /** Volver a buscar el elemento de Wikidata aunque ya estuviera identificado. */
  rematch?: boolean;
  /** Solo estos ids (los consulta aunque no hayan vencido). */
  only?: string[];
  sleep?: (ms: number) => Promise<void>;
  /** Caché de respuestas (script manual). */
  cache?: ResponseCache;
}

export interface RunCircuitsResult {
  /** Archivo resultante (el anterior si no hubo cambios). */
  file: CircuitsFile;
  /** Circuitos consultados en esta corrida. */
  reports: CircuitReport[];
  /** Circuitos que quedaron para otra corrida (por el tope o por un corte). */
  pending: number;
  requests: number;
  /** Motivo del corte, si lo hubo. */
  error?: string;
}

const DEFAULT_LIMIT = 25;
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_BATCH = 20;
/** Una ficha de un circuito que ya no está en el calendario se conserva este tiempo (puede volver). */
const ORPHAN_DAYS = 180;

/**
 * Actualiza data/circuits.json. Nunca lanza: ante cualquier problema lo registra y conserva el archivo anterior
 * (o lo avanzado hasta el corte).
 */
export async function runCircuits(opts: RunCircuitsOptions): Promise<RunCircuitsResult | null> {
  const { log } = opts;
  try {
    return await update(opts);
  } catch (err) {
    log.error(`Circuitos: ${err instanceof Error ? err.message : String(err)}; se conserva data/circuits.json`);
    return null;
  }
}

async function update(opts: RunCircuitsOptions): Promise<RunCircuitsResult> {
  const { log } = opts;
  const now = opts.now ?? new Date();
  const nowIso = toIso(now);
  const file = path.join(opts.dataDir ?? DATA_DIR, 'circuits.json');
  const maxAgeMs = (opts.maxAgeDays ?? DEFAULT_MAX_AGE_DAYS) * 86_400_000;

  const groups = groupCircuits(opts.events);
  const overrides = await loadCircuitOverrides(opts.configDir);
  const previous = await readPrevious(file, log);
  const prevById = new Map((previous?.circuits ?? []).map((c) => [c.id, c]));
  const rally = new Set((opts.series ?? []).filter((s) => s.group === 'rally').map((s) => s.id));

  const isDue = (g: CircuitGroup): boolean => {
    if (opts.only) return opts.only.includes(g.id);
    const prev = prevById.get(g.id);
    if (!prev || opts.force) return true;
    return now.getTime() - Date.parse(prev.checkedAt) > maxAgeMs || overrideChanged(prev, overrides[g.id]);
  };
  // Primero los que no tienen ficha; después, los de consulta más vieja.
  const due = groups
    .filter(isDue)
    .sort((a, b) => (prevById.get(a.id)?.checkedAt ?? '').localeCompare(prevById.get(b.id)?.checkedAt ?? '') || a.id.localeCompare(b.id));
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const selected = limit > 0 ? due.slice(0, limit) : due;

  const current = new Map(prevById);
  const reports: CircuitReport[] = [];
  let error: string | undefined;
  let api: Api | undefined;
  let done = 0;

  if (selected.length) {
    api = createApi({ http: opts.http, log, pauseMs: opts.pauseMs, sleep: opts.sleep, cache: opts.cache });
    const size = Math.max(1, opts.batchSize ?? DEFAULT_BATCH);
    for (let i = 0; i < selected.length; i += size) {
      const batch = selected.slice(i, i + size);
      const inputs: ResolveInput[] = batch.map((group) => ({
        group,
        override: overrides[group.id],
        knownWikidata: opts.rematch ? undefined : prevById.get(group.id)?.wikidata,
        cityOnly: group.seriesIds.length > 0 && group.seriesIds.every((s) => rally.has(s)),
      }));
      try {
        const resolved = await resolveCircuits(api, inputs, { nowIso, log });
        for (const r of resolved) {
          current.set(r.info.id, mergeInfo(prevById.get(r.info.id), r.info, overrides[r.info.id]));
          reports.push(r.report);
        }
        done += batch.length;
        if (!opts.dryRun) await save(file, current, groups, now, nowIso);
      } catch (err) {
        // Un lote que falla se descarta entero (queda lo anterior) y no se sigue insistiendo en esta corrida.
        error = err instanceof Error ? err.message : String(err);
        log.error(`Se corta la consulta de circuitos: ${error}`);
        break;
      }
    }
  }

  let result = buildFile(current, groups, now, nowIso);
  if (!done && previous) {
    // Sin consultas el archivo no se toca, salvo para limpiar fichas de circuitos que salieron del calendario.
    if (result.circuits.length === previous.circuits.length) result = previous;
    else if (!opts.dryRun) await save(file, current, groups, now, nowIso);
  }
  const pending = due.length - done;
  const inCalendar = new Set(groups.map((g) => g.id));
  const stats = coverage(result.circuits.filter((c) => inCalendar.has(c.id)));
  log.info(
    `${groups.length} circuitos en el calendario: ${stats.exact} con coordenadas exactas, ${stats.approx} aproximadas, ` +
      `${groups.length - stats.exact - stats.approx} sin coordenadas; ${done} consultados en esta corrida` +
      (api ? ` (${api.requests} requests)` : '') +
      (pending ? `, ${pending} pendientes` : ''),
  );
  return { file: result, reports, pending, requests: api?.requests ?? 0, error };
}

async function readPrevious(file: string, log: Logger): Promise<CircuitsFile | null> {
  try {
    return await readJson(file, circuitsFileSchema);
  } catch (err) {
    log.warn(`data/circuits.json anterior ilegible, se ignora: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** true si la corrección manual pide algo distinto de lo que quedó guardado (hay que volver a consultar). */
export function overrideChanged(prev: CircuitInfo, override: CircuitOverride | undefined): boolean {
  if (!override) return false;
  if (override.wikidata !== undefined && (override.wikidata ?? undefined) !== prev.wikidata) return true;
  if (override.name !== undefined && override.name !== prev.name) return true;
  if (override.city !== undefined && override.city.split(',')[0]!.trim() !== prev.city) return true;
  return override.lat !== undefined && (override.lat !== prev.lat || override.lon !== prev.lon || prev.coordsApprox === true);
}

/**
 * Une la ficha anterior con la recién consultada: se conserva `hasTrack` y, si es el mismo circuito de Wikidata
 * (o ninguna de las dos lo identificó), los campos que la nueva consulta no trae. Si la nueva consulta no
 * encontró el elemento que antes sí, queda la ficha anterior (salvo que se haya pedido "no buscar").
 */
export function mergeInfo(prev: CircuitInfo | undefined, next: CircuitInfo, override?: CircuitOverride): CircuitInfo {
  if (!prev) return ordered(next);
  const keep = prev.hasTrack !== undefined ? { hasTrack: prev.hasTrack } : {};
  if (prev.wikidata && !next.wikidata && override?.wikidata !== null) {
    return ordered({ ...prev, checkedAt: next.checkedAt });
  }
  if (prev.wikidata !== next.wikidata) return ordered({ ...next, ...keep });
  const merged: CircuitInfo = { ...prev, ...next, ...keep };
  // Las coordenadas van en bloque: si ahora son exactas, deja de valer el "aproximadas" de antes.
  if (next.lat !== undefined && !next.coordsApprox) delete merged.coordsApprox;
  // Una foto conservada de antes que resulta ser el plano actual no se repite.
  if (merged.photo && merged.map && merged.photo.page === merged.map.page) delete merged.photo;
  return ordered(merged);
}

function buildFile(current: Map<string, CircuitInfo>, groups: CircuitGroup[], now: Date, nowIso: string): CircuitsFile {
  const inCalendar = new Set(groups.map((g) => g.id));
  const circuits = [...current.values()]
    .filter((c) => inCalendar.has(c.id) || now.getTime() - Date.parse(c.checkedAt) <= ORPHAN_DAYS * 86_400_000)
    .sort((a, b) => a.id.localeCompare(b.id));
  return { version: 1, generatedAt: nowIso, circuits };
}

async function save(file: string, current: Map<string, CircuitInfo>, groups: CircuitGroup[], now: Date, nowIso: string): Promise<void> {
  // `hasTrack` lo escribe otra fase: se toma el valor que haya en disco en este momento.
  const onDisk = await readJson(file, circuitsFileSchema).catch(() => null);
  for (const c of onDisk?.circuits ?? []) {
    const mine = current.get(c.id);
    if (mine && c.hasTrack !== undefined && mine.hasTrack !== c.hasTrack) current.set(c.id, ordered({ ...mine, hasTrack: c.hasTrack }));
  }
  const out = buildFile(current, groups, now, nowIso);
  circuitsFileSchema.parse(out);
  await writeJson(file, out);
}

export interface Coverage {
  total: number;
  exact: number;
  approx: number;
  none: number;
  identified: number;
  withMap: number;
  withPhoto: number;
  withRecord: number;
  withSummary: number;
}

export function coverage(circuits: CircuitInfo[]): Coverage {
  const count = (fn: (c: CircuitInfo) => boolean) => circuits.filter(fn).length;
  const exact = count((c) => c.lat !== undefined && !c.coordsApprox);
  const approx = count((c) => c.lat !== undefined && !!c.coordsApprox);
  return {
    total: circuits.length,
    exact,
    approx,
    none: circuits.length - exact - approx,
    identified: count((c) => !!c.wikidata),
    withMap: count((c) => !!c.map),
    withPhoto: count((c) => !!c.photo),
    withRecord: count((c) => !!c.lapRecord),
    withSummary: count((c) => !!c.summary),
  };
}

function toIso(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
