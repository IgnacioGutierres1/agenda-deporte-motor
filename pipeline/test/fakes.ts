import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Series } from '@dm/shared';
import { createContext } from '../src/core/context.ts';
import { HttpError, type Http, type HttpResponse } from '../src/core/http.ts';
import { createLogger } from '../src/core/log.ts';
import type { AdapterContext } from '../src/core/types.ts';
import type { Gemini, GeminiJsonRequest, GeminiSearchResult } from '../src/extract/gemini.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return readFileSync(path.join(here, 'fixtures', 'generic', name), 'utf8');
}

type Route = string | { body: string | Uint8Array; contentType?: string };

/** Http falso: responde solo las URL registradas (el resto, 404). Registra cada pedido. */
export function fakeHttp(routes: Record<string, Route>): Http & { requested: string[] } {
  const table = new Map(Object.entries(routes).map(([u, r]) => [new URL(u).toString(), r]));
  const requested: string[] = [];
  const get = (url: string): { body: string | Uint8Array; contentType: string } => {
    const key = new URL(url).toString();
    requested.push(key);
    const r = table.get(key);
    if (r === undefined) throw new HttpError(key, 404, `HTTP 404 en ${key}`);
    if (typeof r === 'string') {
      const ct = /^\s*[[{]/.test(r) ? 'application/json' : 'text/html; charset=utf-8';
      return { body: r, contentType: ct };
    }
    return { body: r.body, contentType: r.contentType ?? 'application/octet-stream' };
  };
  const res = <T>(url: string, body: T, contentType: string): HttpResponse<T> => ({ url, status: 200, contentType, body });
  return {
    requested,
    async text(url) {
      const r = get(url);
      return res(url, typeof r.body === 'string' ? r.body : new TextDecoder().decode(r.body), r.contentType);
    },
    async json<T>(url: string) {
      const r = get(url);
      return res(url, JSON.parse(typeof r.body === 'string' ? r.body : new TextDecoder().decode(r.body)) as T, r.contentType);
    },
    async bytes(url) {
      const r = get(url);
      return res(url, typeof r.body === 'string' ? new TextEncoder().encode(r.body) : r.body, r.contentType);
    },
  };
}

export type Responder = (req: GeminiJsonRequest) => unknown;

/** Gemini falso: responde según la etiqueta del pedido (calendario, cronograma, resultados, campeonato). */
export function fakeGemini(
  responders: Record<string, Responder> = {},
  opts: { available?: boolean; search?: (prompt: string) => GeminiSearchResult } = {},
): Gemini & { requests: GeminiJsonRequest[]; searches: string[] } {
  const requests: GeminiJsonRequest[] = [];
  const searches: string[] = [];
  const available = opts.available ?? true;
  return {
    requests,
    searches,
    available,
    unavailableReason: available ? '' : 'Falta GEMINI_API_KEY',
    extractModel: 'fake-model',
    searchModel: 'fake-search',
    callsMade: () => requests.length + searches.length,
    async generateJson<T>(req: GeminiJsonRequest): Promise<T> {
      if (!available) throw new Error('no debería llamarse sin clave');
      requests.push(req);
      const kind = Object.keys(responders).find((k) => req.label?.startsWith(k));
      if (!kind) throw new Error(`Pedido inesperado a Gemini: ${req.label}`);
      return responders[kind]!(req) as T;
    },
    async searchGrounded(prompt: string) {
      searches.push(prompt);
      if (!opts.search) throw new Error('búsqueda inesperada');
      return opts.search(prompt);
    },
  };
}

export function testContext(http: Http, now: string, cacheDir = mkdtempSync(path.join(tmpdir(), 'dm-cache-'))): AdapterContext {
  return createContext({
    now: new Date(now),
    http,
    log: createLogger('', true),
    cacheDir,
    durations: { default: { practica: 60, clasificacion: 30, carrera: 60, serie: 15 } },
    broadcast: {},
  });
}

export function genericSeries(id: string, name: string, officialUrls: string[], extra: Partial<Series> = {}): Series {
  return {
    id,
    name,
    shortName: name,
    group: 'otros',
    officialUrls,
    strategy: 'generic',
    origin: 'default',
    enabled: true,
    ...extra,
  };
}
