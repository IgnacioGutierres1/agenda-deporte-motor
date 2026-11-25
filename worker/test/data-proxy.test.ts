import { describe, expect, it } from 'vitest';
import { cacheControlFor, dataPath, etagMatches, handleData, isDataHost } from '../src/data-proxy.ts';

const env = { DATA_BASE: 'https://origen.example/data/', DATA_HOSTS: 'data.gridagenda.com, DATA.otro.example' };

/** Origen de mentira: anota lo pedido y responde lo indicado. */
function origin(status = 200, body = '{"ok":true}', headers: Record<string, string> = { ETag: '"abc"', 'Content-Type': 'text/html' }) {
  const calls: string[] = [];
  const fetchFn = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(status === 304 ? null : body, { status, headers });
  }) as typeof fetch;
  return { calls, fetchFn };
}

const get = (path: string, init: RequestInit = {}) => {
  const request = new Request(`https://data.gridagenda.com${path}`, init);
  return { request, url: new URL(request.url) };
};

describe('datos en el dominio propio', () => {
  it('isDataHost: solo los hosts configurados (sin distinguir mayúsculas)', () => {
    expect(isDataHost('data.gridagenda.com', env)).toBe(true);
    expect(isDataHost('data.otro.example', env)).toBe(true);
    expect(isDataHost('api.gridagenda.com', env)).toBe(false);
    expect(isDataHost('data.gridagenda.com', {})).toBe(false);
  });

  it('dataPath: acepta los archivos publicados y rechaza lo que no es de data/', () => {
    expect(dataPath('/schedule.json')).toBe('schedule.json');
    expect(dataPath('/results/f1/2026-11-22-las-vegas.json')).toBe('results/f1/2026-11-22-las-vegas.json');
    expect(dataPath('/feeds/tc-pista.ics')).toBe('feeds/tc-pista.ics');
    expect(dataPath('/drivers/0a.json')).toBe('drivers/0a.json');
    for (const bad of ['/', '/index.html', '/../secreto.json', '/a/../b.json', '/%2e%2e/b.json', '/_cache/x.json', '/a/_b/c.json', '/x.json/', '/a//b.json', '/%E0%A4%A.json', '/sw.js']) {
      expect(dataPath(bad), bad).toBeNull();
    }
  });

  it('pide el archivo al origen y lo devuelve con CORS abierto, tipo por extensión y caché corta', async () => {
    const o = origin();
    const { request, url } = get('/results/f1/x.json');
    const res = await handleData(request, env, url, o.fetchFn);
    expect(o.calls).toEqual(['https://origen.example/data/results/f1/x.json']);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Content-Type')).toBe('application/json; charset=utf-8');
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60, stale-while-revalidate=600');
    expect(res.headers.get('ETag')).toBe('"abc"');
  });

  it('calendarios .ics con su tipo; trazados con caché de un día', async () => {
    const ics = get('/feeds/f1.ics');
    const res = await handleData(ics.request, env, ics.url, origin(200, 'BEGIN:VCALENDAR').fetchFn);
    expect(res.headers.get('Content-Type')).toBe('text/calendar; charset=utf-8');
    expect(cacheControlFor('tracks/monza.json')).toBe('public, max-age=86400');
  });

  it('304 si el dispositivo ya tiene esa versión (ETag fuerte o débil); HEAD sin cuerpo', async () => {
    expect(etagMatches('W/"abc"', '"abc"')).toBe(true);
    expect(etagMatches('"x", "abc"', 'W/"abc"')).toBe(true);
    expect(etagMatches('"x"', '"abc"')).toBe(false);
    expect(etagMatches(null, '"abc"')).toBe(false);
    const cond = get('/schedule.json', { headers: { 'If-None-Match': 'W/"abc"' } });
    const res = await handleData(cond.request, env, cond.url, origin().fetchFn);
    expect(res.status).toBe(304);
    expect(res.headers.get('ETag')).toBe('"abc"');
    const head = get('/schedule.json', { method: 'HEAD' });
    const h = await handleData(head.request, env, head.url, origin().fetchFn);
    expect(h.status).toBe(200);
    expect(await h.text()).toBe('');
  });

  it('404 del origen o ruta inválida → 404 sin consultar de más; error del origen → 502 sin caché', async () => {
    const missing = get('/feeds/nueva.ics');
    expect((await handleData(missing.request, env, missing.url, origin(404, '<html>').fetchFn)).status).toBe(404);
    const o = origin();
    const bad = get('/index.html');
    expect((await handleData(bad.request, env, bad.url, o.fetchFn)).status).toBe(404);
    expect(o.calls).toEqual([]);
    const down = get('/schedule.json');
    const res = await handleData(down.request, env, down.url, origin(503, 'x').fetchFn);
    expect(res.status).toBe(502);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    const net = await handleData(down.request, env, down.url, (async () => {
      throw new Error('sin red');
    }) as typeof fetch);
    expect(net.status).toBe(502);
  });

  it('solo lectura: OPTIONS responde el preflight y POST se rechaza', async () => {
    const pre = get('/schedule.json', { method: 'OPTIONS' });
    const p = await handleData(pre.request, env, pre.url, origin().fetchFn);
    expect(p.status).toBe(204);
    expect(p.headers.get('Access-Control-Allow-Methods')).toContain('GET');
    const post = get('/schedule.json', { method: 'POST', body: '{}' });
    expect((await handleData(post.request, env, post.url, origin().fetchFn)).status).toBe(405);
  });
});
