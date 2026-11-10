import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, type Http, type HttpResponse } from '../src/core/http.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

/**
 * Http falso para pruebas: cada URL se resuelve a un archivo de test/fixtures.
 * Las URL no mapeadas responden 404. `calls` registra las URL pedidas.
 */
export function fixtureHttp(routes: Record<string, string>): Http & { calls: string[] } {
  const calls: string[] = [];
  function load(url: string): HttpResponse<string> {
    calls.push(url);
    const file = routes[url];
    if (!file) throw new HttpError(url, 404, `HTTP 404 en ${url}`);
    return { url, status: 200, contentType: '', body: readFileSync(path.join(FIXTURES, file), 'utf8') };
  }
  return {
    calls,
    async text(url) {
      return load(url);
    },
    async json<T>(url: string) {
      const r = load(url);
      return { ...r, body: JSON.parse(r.body) as T };
    },
    async bytes(url) {
      const r = load(url);
      return { ...r, body: new TextEncoder().encode(r.body) };
    },
  };
}
