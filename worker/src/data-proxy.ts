/**
 * Datos del pipeline en el dominio propio (data.gridagenda.com).
 *
 * GitHub Pages admite un solo dominio propio por sitio (lo usa la app), así que este Worker sirve los mismos
 * archivos de data/ bajo una dirección estable: `data.<dominio>/schedule.json` = `<Pages>/data/schedule.json`.
 * El día que los datos se muden (R2, otro hosting) cambia solo el origen: las apps instaladas no se enteran.
 *
 * Solo lectura (GET/HEAD), solo .json y .ics, CORS abierto (son datos públicos) y caché corta en el borde.
 */

export interface DataEnv {
  /** Origen de los datos, sin barra final (p. ej. "https://gridagenda.com/data"). */
  DATA_BASE: string;
  /** Hosts que sirven datos, separados por coma (p. ej. "data.gridagenda.com"). */
  DATA_HOSTS?: string;
}

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Accept, Cache-Control, If-None-Match, If-Modified-Since',
  'Access-Control-Expose-Headers': 'ETag, Last-Modified',
  'Access-Control-Max-Age': '86400',
};

const TYPES: Record<string, string> = {
  json: 'application/json; charset=utf-8',
  ics: 'text/calendar; charset=utf-8',
};

/** Segundos de caché en el borde de Cloudflare: como mucho un minuto de demora respecto de lo publicado. */
const EDGE_TTL = 60;

/** ¿Este host sirve datos (y no la API)? */
export function isDataHost(hostname: string, env: Pick<DataEnv, 'DATA_HOSTS'>): boolean {
  return (env.DATA_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean)
    .includes(hostname.toLowerCase());
}

/**
 * "/results/f1/x.json" -> "results/f1/x.json"; null si no es un archivo publicable
 * (otra extensión, `..`, carpeta interna `_cache`, caracteres raros).
 */
export function dataPath(pathname: string): string | null {
  let rel: string;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (!/^[\w.@+-]+(?:\/[\w.@+-]+)*\.(?:json|ics)$/.test(rel)) return null;
  const parts = rel.split('/');
  if (parts.some((p) => p === '..' || p === '.' || p.startsWith('_'))) return null;
  return parts.map(encodeURIComponent).join('/');
}

/** Caché para navegadores y clientes de calendario: los trazados casi no cambian; el resto, cada corrida. */
export function cacheControlFor(rel: string): string {
  return rel.startsWith('tracks/') ? 'public, max-age=86400' : 'public, max-age=60, stale-while-revalidate=600';
}

/** Comparación débil de ETag (Cloudflare puede convertir "abc" en W/"abc" al comprimir). */
export function etagMatches(ifNoneMatch: string | null, etag: string | null): boolean {
  if (!ifNoneMatch || !etag) return false;
  const norm = (s: string) => s.trim().replace(/^W\//, '');
  const wanted = norm(etag);
  return ifNoneMatch.split(',').some((t) => t.trim() === '*' || norm(t) === wanted);
}

function text(body: string, status: number, extra: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS, ...extra } });
}

export async function handleData(request: Request, env: DataEnv, url: URL, fetchFn: typeof fetch = fetch): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (request.method !== 'GET' && request.method !== 'HEAD') return text('Solo lectura.', 405, { Allow: 'GET, HEAD, OPTIONS' });
  if (url.pathname === '/') return text('Grid Agenda — datos públicos (JSON y calendarios .ics).', 200);

  const rel = dataPath(url.pathname);
  if (!rel) return text('No encontrado.', 404, { 'Cache-Control': 'public, max-age=60' });

  let upstream: Response;
  try {
    upstream = await fetchFn(`${env.DATA_BASE.replace(/\/+$/, '')}/${rel}`, {
      headers: { Accept: '*/*', 'User-Agent': 'GridAgenda-data/1.0' },
      // Muchos dispositivos pidiendo lo mismo = un pedido al origen por minuto.
      cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': EDGE_TTL, '404': 30, '500-599': 0 } },
    } as RequestInit);
  } catch {
    return text('No se pudo leer el origen de los datos.', 502, { 'Cache-Control': 'no-store' });
  }

  if (upstream.status === 404) return text('No encontrado.', 404, { 'Cache-Control': 'public, max-age=30' });
  if (!upstream.ok) return text(`El origen de los datos respondió ${upstream.status}.`, 502, { 'Cache-Control': 'no-store' });

  const ext = rel.slice(rel.lastIndexOf('.') + 1);
  const headers = new Headers(CORS);
  // El tipo sale de la extensión: si el origen devolviera una página HTML con 200, la app no la toma por datos.
  headers.set('Content-Type', TYPES[ext] ?? 'application/octet-stream');
  headers.set('Cache-Control', cacheControlFor(rel));
  headers.set('X-Content-Type-Options', 'nosniff');
  const etag = upstream.headers.get('ETag');
  const modified = upstream.headers.get('Last-Modified');
  if (etag) headers.set('ETag', etag);
  if (modified) headers.set('Last-Modified', modified);

  const notModified = etagMatches(request.headers.get('If-None-Match'), etag);
  if (notModified || request.method === 'HEAD') {
    // No se usa el cuerpo: se suelta para no dejar la conexión con el origen abierta.
    void upstream.body?.cancel();
    return new Response(null, { status: notModified ? 304 : 200, headers });
  }
  return new Response(upstream.body, { status: 200, headers });
}
