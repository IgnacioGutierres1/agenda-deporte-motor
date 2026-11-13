/**
 * Acceso a las APIs abiertas de las fichas de circuitos (Wikidata, Wikipedia, Commons y Open-Meteo), siempre con
 * el cliente HTTP del pipeline y de a una request por vez.
 *
 * Los sitios de Wikimedia limitan a los clientes sin datos de contacto en el User-Agent a unas 10 requests por
 * minuto por IP (https://www.mediawiki.org/wiki/Wikimedia_APIs/Rate_limits). Por eso:
 *  - hay una pausa mínima entre requests a Wikimedia (por defecto 6,5 s; CIRCUITS_PAUSE_MS la cambia);
 *  - ante un 429 se espera lo que pide `Retry-After` y se reintenta (pocas veces);
 *  - un 403 no se reintenta ni se esquiva: se informa y se corta.
 * Se usa solo `http.json`, que no pasa por el proxy de respaldo del cliente.
 */
import { createHttp, HttpError, type Http } from '../core/http.ts';
import type { Logger } from '../core/log.ts';

/** El sitio pidió frenar (429 repetido) o rechazó la lectura automática (403): hay que cortar la fase. */
export class SourceLimitError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = 'SourceLimitError';
  }
}

export interface Api {
  /** GET de un JSON. Las URL repetidas en la misma corrida no se vuelven a pedir. */
  get<T>(url: string): Promise<T>;
  /** Requests reales hechas hasta ahora. */
  readonly requests: number;
}

/** Caché opcional de respuestas (la usa el script manual para no repetir consultas al depurar). */
export interface ResponseCache {
  get(url: string): Promise<unknown | undefined>;
  set(url: string, body: unknown): Promise<void>;
}

export interface ApiOptions {
  /** Cliente a usar (tests). Por defecto, uno propio sin reintentos automáticos. */
  http?: Http;
  log?: Logger;
  /** Pausa mínima entre requests a Wikimedia, en ms. */
  pauseMs?: number;
  /** Pausa mínima entre requests al resto de los sitios (Open-Meteo), en ms. */
  otherPauseMs?: number;
  /** Reintentos ante un 429 (cada uno espera `Retry-After`). */
  limitRetries?: number;
  sleep?: (ms: number) => Promise<void>;
  cache?: ResponseCache;
}

export const DEFAULT_PAUSE_MS = 6500;
const DEFAULT_RETRY_AFTER_S = 30;
const MAX_RETRY_AFTER_S = 180;

/** Pausa configurada por entorno (CIRCUITS_PAUSE_MS), o la conservadora por defecto. */
export function pauseFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.CIRCUITS_PAUSE_MS);
  return env.CIRCUITS_PAUSE_MS && Number.isFinite(n) && n >= 0 ? n : DEFAULT_PAUSE_MS;
}

function isWikimedia(url: string): boolean {
  return /^https:\/\/[^/]*\.(wikidata|wikipedia|wikimedia)\.org\//.test(url);
}

export function createApi(opts: ApiOptions = {}): Api {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pauseMs = opts.pauseMs ?? pauseFromEnv();
  const otherPauseMs = opts.otherPauseMs ?? Math.min(pauseMs, 400);
  const limitRetries = opts.limitRetries ?? 3;

  // `Retry-After` de la última respuesta 429/503 (el cliente del pipeline no expone las cabeceras de un error).
  let retryAfterS: number | null = null;
  const http =
    opts.http ??
    createHttp({
      retries: 0,
      fetchImpl: async (input, init) => {
        const res = await fetch(input, init);
        if (res.status === 429 || res.status === 503) {
          const s = Number(res.headers.get('retry-after'));
          retryAfterS = Number.isFinite(s) && s > 0 ? s : null;
        }
        return res;
      },
    });

  const cache = new Map<string, Promise<unknown>>();
  const lastAt = { wikimedia: 0, other: 0 };
  let requests = 0;
  let queue: Promise<unknown> = Promise.resolve();

  async function request<T>(url: string): Promise<T> {
    const stored = await opts.cache?.get(url);
    if (stored !== undefined) return stored as T;
    const body = await fetchJson<T>(url);
    await opts.cache?.set(url, body);
    return body;
  }

  async function fetchJson<T>(url: string): Promise<T> {
    const group = isWikimedia(url) ? 'wikimedia' : 'other';
    const pause = group === 'wikimedia' ? pauseMs : otherPauseMs;
    for (let attempt = 0; ; attempt++) {
      const wait = lastAt[group] + pause - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt[group] = Date.now();
      requests++;
      retryAfterS = null;
      try {
        return (await http.json<T>(url)).body;
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 0;
        const host = new URL(url).host;
        if (status === 403) {
          throw new SourceLimitError(`${host} rechazó la lectura automática (HTTP 403)`, 403);
        }
        if (status === 429) {
          if (attempt >= limitRetries) {
            throw new SourceLimitError(`${host} sigue pidiendo menos consultas (HTTP 429)`, 429);
          }
          const s = Math.min(retryAfterS ?? DEFAULT_RETRY_AFTER_S, MAX_RETRY_AFTER_S) + 2;
          opts.log?.warn(`${host} pide menos consultas (HTTP 429): se espera ${s} s`);
          await sleep(s * 1000);
          continue;
        }
        // 404 y demás errores del cliente: son la respuesta. Fallas de red o 5xx: un reintento.
        if ((status >= 400 && status < 500) || attempt >= 1) throw err;
        await sleep(Math.max(pause, 3000));
      }
    }
  }

  return {
    get<T>(url: string): Promise<T> {
      let p = cache.get(url) as Promise<T> | undefined;
      if (!p) {
        // En serie: cada request espera a que termine la anterior (aunque haya fallado).
        p = queue.then(
          () => request<T>(url),
          () => request<T>(url),
        );
        queue = p;
        p.catch(() => cache.delete(url));
        cache.set(url, p);
      }
      return p;
    },
    get requests() {
      return requests;
    },
  };
}
