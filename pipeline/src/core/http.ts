/**
 * Cliente HTTP del pipeline: timeout, reintentos con espera y memoización por URL
 * dentro de una misma corrida (varias series pueden compartir la misma fuente).
 * Si una página responde 403 (sitios que bloquean a los servidores de GitHub), se reintenta
 * a través del proxy de Google (ver proxy.ts) y se devuelve con su URL oficial.
 */
import { googleProxyUrl, unproxyHtml } from './proxy.ts';

export interface HttpResponse<T> {
  url: string;
  status: number;
  contentType: string;
  body: T;
}

export interface Http {
  text(url: string, init?: RequestInit): Promise<HttpResponse<string>>;
  json<T = unknown>(url: string, init?: RequestInit): Promise<HttpResponse<T>>;
  bytes(url: string, init?: RequestInit): Promise<HttpResponse<Uint8Array>>;
}

export interface HttpOptions {
  timeoutMs?: number;
  retries?: number;
  fetchImpl?: typeof fetch;
}

/** Identificación genérica del cliente (sin datos personales). */
export const USER_AGENT =
  'Mozilla/5.0 (compatible; AgendaDeporteMotor/0.1; calendario personal de horarios oficiales)';

export class HttpError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export function createHttp(opts: HttpOptions = {}): Http {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const retries = opts.retries ?? 2;
  const doFetch = opts.fetchImpl ?? fetch;
  const memo = new Map<string, Promise<HttpResponse<unknown>>>();

  async function request(url: string, init: RequestInit | undefined): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await doFetch(url, {
          ...init,
          headers: {
            'User-Agent': USER_AGENT,
            'Accept-Language': 'es-AR,es;q=0.9,en;q=0.8',
            ...(init?.headers ?? {}),
          },
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) return res;
        // 4xx (salvo 429) no se reintenta.
        if (res.status < 500 && res.status !== 429) {
          throw new HttpError(url, res.status, `HTTP ${res.status} en ${url}`);
        }
        lastError = new HttpError(url, res.status, `HTTP ${res.status} en ${url}`);
      } catch (err) {
        if (err instanceof HttpError && err.status < 500 && err.status !== 429) throw err;
        lastError = err;
      }
      if (attempt < retries) await sleep(1000 * 2 ** attempt);
    }
    throw lastError instanceof Error ? lastError : new Error(`Fallo al leer ${url}`);
  }

  function memoized<T>(
    kind: string,
    url: string,
    init: RequestInit | undefined,
    read: (res: Response) => Promise<T>,
  ): Promise<HttpResponse<T>> {
    const key = `${kind} ${init?.method ?? 'GET'} ${url} ${init?.body ? String(init.body) : ''}`;
    let p = memo.get(key) as Promise<HttpResponse<T>> | undefined;
    if (!p) {
      p = request(url, init).then(async (res) => ({
        url: res.url || url,
        status: res.status,
        contentType: res.headers.get('content-type') ?? '',
        body: await read(res),
      }));
      // Si falla, no dejar el error memoizado.
      p.catch(() => memo.delete(key));
      memo.set(key, p as Promise<HttpResponse<unknown>>);
    }
    return p;
  }

  async function textWithFallback(url: string, init: RequestInit | undefined): Promise<HttpResponse<string>> {
    try {
      return await memoized('text', url, init, (r) => r.text());
    } catch (err) {
      const isGet = !init?.method || init.method.toUpperCase() === 'GET';
      const proxied = err instanceof HttpError && err.status === 403 && isGet && !init?.body ? googleProxyUrl(url) : null;
      if (!proxied) throw err;
      try {
        const res = await memoized('text', proxied, init, (r) => r.text());
        return { ...res, url, body: unproxyHtml(res.body) };
      } catch {
        throw err; // se informa el 403 original, que es el que explica el problema
      }
    }
  }

  return {
    text: textWithFallback,
    json: <T>(url: string, init?: RequestInit) =>
      memoized('json', url, init, async (r) => (await r.json()) as T),
    bytes: (url, init) => memoized('bytes', url, init, async (r) => new Uint8Array(await r.arrayBuffer())),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
