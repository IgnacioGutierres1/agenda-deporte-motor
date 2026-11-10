import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, type Http, type HttpResponse } from '../src/core/http.ts';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function fixture(rel: string): string {
  return fs.readFileSync(path.join(FIXTURES, rel), 'utf8');
}

/** Http falso: cada URL se responde con un fixture (o un texto); el resto, 404. Registra las URLs pedidas. */
export function fakeHttp(routes: Record<string, string | (() => string)>): Http & { calls: string[] } {
  const calls: string[] = [];
  const text = async (url: string): Promise<HttpResponse<string>> => {
    calls.push(url);
    const r = routes[url];
    if (r === undefined) throw new HttpError(url, 404, `HTTP 404 en ${url}`);
    const body = typeof r === 'function' ? r() : r;
    return { url, status: 200, contentType: 'text/html', body };
  };
  return {
    calls,
    text,
    async json<T>(url: string) {
      const res = await text(url);
      return { ...res, body: JSON.parse(res.body) as T };
    },
    async bytes(url: string) {
      const res = await text(url);
      return { ...res, body: new TextEncoder().encode(res.body) };
    },
  };
}
