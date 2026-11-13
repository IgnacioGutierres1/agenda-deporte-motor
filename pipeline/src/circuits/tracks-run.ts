/**
 * Corrida de trazados: para cada circuito de data/circuits.json con coordenadas exactas y sin
 * data/tracks/{id}.json, consulta OpenStreetMap (Overpass), escribe el trazado y marca `hasTrack`.
 *
 * - Nunca reconsulta un circuito que ya tiene archivo (salvo --force).
 * - Los que no tienen trazado en OpenStreetMap quedan con `hasTrack: false` y anotados en
 *   data/_cache/tracks-attempts.json: no se vuelve a preguntar hasta que cambien sus coordenadas o pasen
 *   RECHECK_DAYS días (el mapa mejora con el tiempo).
 * - Política de Overpass: una consulta por vez, pausa entre consultas, espera y reintento ante 429/502/503/504,
 *   tope de consultas por corrida, y se corta la corrida si el servidor falla dos veces seguidas.
 *
 * Uso: npm run circuits:tracks -- [--limit=30] [--only=paul-ricard,monza] [--force] [--dry-run]
 */
import { access } from 'node:fs/promises';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { circuitTrackFileSchema, circuitsFileSchema, type CircuitInfo, type CircuitTrackFile } from '@dm/shared';
import { createHttp, type Http } from '../core/http.ts';
import { createLogger, type Logger } from '../core/log.ts';
import { DATA_DIR } from '../core/paths.ts';
import { readJson, writeJson } from '../core/store.ts';
import { fetchTrack, type FetchTrackOptions } from './track.ts';

/** Consultas a Overpass por corrida, si no se indica otro tope. */
export const DEFAULT_LIMIT = 30;
/** Pausa entre consultas. */
const PAUSE_MS = 2500;
/** Cada cuánto se vuelve a preguntar por un circuito que no tenía trazado. */
const RECHECK_DAYS = 120;

export interface RunTracksOptions {
  /** Conviene un cliente propio (ver createOverpassHttp): sin reintentos rápidos y con más timeout. */
  http?: Http;
  log: Logger;
  dataDir?: string;
  now?: Date;
  /** Tope de consultas a Overpass en esta corrida. */
  limit?: number;
  /** Vuelve a consultar aunque ya exista el archivo o esté anotado como "sin trazado". */
  force?: boolean;
  /** Solo estos circuitos (ids). */
  only?: string[];
  dryRun?: boolean;
  /** Para las pruebas: pausa entre consultas y espera de los reintentos. */
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  fetchOptions?: Pick<FetchTrackOptions, 'retries' | 'retryWaitMs'>;
}

export interface RunTracksResult {
  /** Consultas hechas a Overpass. */
  queried: number;
  written: string[];
  /** Consultados que no tienen trazado dibujable. */
  without: string[];
  failed: string[];
  /** Quedaron para la próxima corrida (por el tope o porque se cortó). */
  pending: number;
}

/** Intentos sin trazado: id → cuándo y con qué coordenadas se preguntó. */
type Attempts = Record<string, { checkedAt: string; lat: number; lon: number }>;

/**
 * Identificación del cliente ante Overpass. Su política de uso pide que la aplicación se identifique; con el
 * USER_AGENT común del pipeline (que empieza con "Mozilla/5.0") overpass-api.de responde 406 a toda consulta.
 * Sin datos personales.
 */
export const OVERPASS_USER_AGENT = 'AgendaDeporteMotor/0.1 (agenda personal de automovilismo)';

/**
 * Cliente para Overpass: se identifica con OVERPASS_USER_AGENT, no hace los reintentos rápidos del cliente
 * común (con el servidor ocupado hay que esperar, y de eso se ocupa fetchTrack) y tiene un timeout acorde a un servidor
 * compartido (una consulta tarda de 5 a 40 s según la carga).
 */
export function createOverpassHttp(userAgent = OVERPASS_USER_AGENT): Http {
  return createHttp({
    retries: 0,
    timeoutMs: 90_000,
    fetchImpl: (url, init) => fetch(url, { ...init, headers: { ...(init?.headers as Record<string, string>), 'User-Agent': userAgent } }),
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

export async function runTracks(opts: RunTracksOptions): Promise<RunTracksResult> {
  const { log } = opts;
  const dataDir = opts.dataDir ?? DATA_DIR;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const limit = opts.limit ?? DEFAULT_LIMIT;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const result: RunTracksResult = { queried: 0, written: [], without: [], failed: [], pending: 0 };

  const circuitsFile = path.join(dataDir, 'circuits.json');
  const attemptsFile = path.join(dataDir, '_cache', 'tracks-attempts.json');
  const trackFile = (id: string): string => path.join(dataDir, 'tracks', `${id}.json`);

  const circuits = await readJson(circuitsFile, circuitsFileSchema);
  if (!circuits) {
    log.info('Todavía no existe data/circuits.json: no hay circuitos para consultar');
    return result;
  }
  const attempts = (await readJson<Attempts>(attemptsFile)) ?? {};
  /** Cambios de hasTrack de esta corrida (se aplican al final sobre el archivo releído). */
  const flags = new Map<string, boolean>();

  const todo: (CircuitInfo & { lat: number; lon: number })[] = [];
  for (const c of circuits.circuits) {
    if (opts.only && !opts.only.includes(c.id)) continue;
    const hasFile = await exists(trackFile(c.id));
    if (hasFile && !opts.force) {
      if (c.hasTrack !== true) flags.set(c.id, true);
      continue;
    }
    // Sin coordenadas exactas no se pregunta: las de la ciudad traerían la pista equivocada.
    if (c.lat === undefined || c.lon === undefined || c.coordsApprox) continue;
    const prev = attempts[c.id];
    if (!opts.force && prev && prev.lat === c.lat && prev.lon === c.lon) {
      const days = (now.getTime() - Date.parse(prev.checkedAt)) / 86_400_000;
      if (days < RECHECK_DAYS) {
        if (c.hasTrack !== false) flags.set(c.id, false);
        continue;
      }
    }
    todo.push({ ...c, lat: c.lat, lon: c.lon });
  }

  const http = opts.http ?? createOverpassHttp();
  let failedInARow = 0;
  for (const [i, c] of todo.entries()) {
    if (result.queried >= limit || failedInARow >= 2) {
      result.pending = todo.length - i;
      break;
    }
    if (result.queried > 0) await sleep(opts.pauseMs ?? PAUSE_MS);
    result.queried++;
    try {
      const data = await fetchTrack(c.lat, c.lon, http, { lengthM: c.lengthM, sleep, ...opts.fetchOptions });
      failedInARow = 0;
      if (!data) {
        result.without.push(c.id);
        attempts[c.id] = { checkedAt: nowIso, lat: c.lat, lon: c.lon };
        flags.set(c.id, false);
        log.info(`${c.id}: sin trazado en OpenStreetMap`);
        continue;
      }
      const file: CircuitTrackFile = {
        id: c.id,
        updatedAt: nowIso,
        ...data,
        source: {
          url: `https://www.openstreetmap.org/#map=15/${c.lat.toFixed(5)}/${c.lon.toFixed(5)}`,
          title: 'OpenStreetMap',
          kind: 'api',
          method: 'directo',
          fetchedAt: nowIso,
        },
      };
      circuitTrackFileSchema.parse(file);
      if (!opts.dryRun) await writeJson(trackFile(c.id), file);
      delete attempts[c.id];
      flags.set(c.id, true);
      result.written.push(c.id);
      log.info(`${c.id}: trazado escrito (${file.paths.length + (file.secondary?.length ?? 0)} líneas)`);
    } catch (err) {
      failedInARow++;
      result.failed.push(c.id);
      log.warn(`${c.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failedInARow >= 2) log.warn('Overpass falló dos veces seguidas: se corta la corrida y se sigue en la próxima');

  if (!opts.dryRun) {
    // circuits.json lo genera otra etapa: se relee y solo se le toca hasTrack.
    const fresh = flags.size ? await readJson(circuitsFile, circuitsFileSchema) : null;
    if (fresh) {
      let changed = false;
      for (const c of fresh.circuits) {
        const flag = flags.get(c.id);
        if (flag === undefined || c.hasTrack === flag) continue;
        c.hasTrack = flag;
        changed = true;
      }
      if (changed) await writeJson(circuitsFile, fresh);
    }
    if (result.queried > 0) await writeJson(attemptsFile, attempts);
  }
  log.info(
    `Trazados: ${result.queried} consultas, ${result.written.length} escritos, ${result.without.length} sin trazado, ` +
      `${result.failed.length} con error, ${result.pending} pendientes`,
  );
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  // Con IPv6 sin salida, Node prueba cada dirección del servidor solo 250 ms: no alcanza para un servidor lejano.
  setDefaultAutoSelectFamilyAttemptTimeout(2000);
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  runTracks({
    log: createLogger('trazados'),
    limit: value('limit') ? Number(value('limit')) : undefined,
    only: value('only')?.split(',').filter(Boolean),
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run'),
  })
    .then((r) => process.exit(r.failed.length && !r.written.length && !r.without.length ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
