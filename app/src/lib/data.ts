/**
 * Lectura de los JSON que publica el pipeline.
 *
 * Dos direcciones posibles para el mismo archivo:
 *  - la propia de los datos (`VITE_DATA_BASE`, p. ej. "https://data.gridagenda.com/"): estable, no depende de dónde
 *    esté publicada la app. Es la que se usa cuando está configurada;
 *  - la copia que viaja con la app en `data/` (relativa a la página): se usa en desarrollo y como respaldo si la
 *    primera no responde.
 */

export class DataNotFoundError extends Error {
  constructor(public readonly path: string) {
    super(`No hay datos en ${path}`);
    this.name = 'DataNotFoundError';
  }
}

export class DataLoadError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'DataLoadError';
  }
}

const withSlash = (s: string): string => (s.endsWith('/') ? s : `${s}/`);
const clean = (relPath: string): string => relPath.replace(/^\/+/, '');

/** Dirección propia de los datos, con barra final ("" = usar la copia que viaja con la app). */
export function normalizeDataBase(value: string | undefined | null): string {
  const v = (value ?? '').trim();
  return v ? withSlash(v) : '';
}

export const DATA_BASE = normalizeDataBase(import.meta.env.VITE_DATA_BASE);

/** Copia que viaja con la app: "schedule.json" -> "./data/schedule.json" (o "/sub/data/schedule.json"). */
export function localDataUrl(relPath: string, base: string = import.meta.env.BASE_URL): string {
  return `${withSlash(base)}data/${clean(relPath)}`;
}

/**
 * Dirección de un archivo de datos: "schedule.json" -> "https://data.gridagenda.com/schedule.json", o la copia
 * local si no hay dirección propia. `base` y `dataBase` solo se pasan en pruebas.
 */
export function dataUrl(relPath: string, base?: string, dataBase: string = DATA_BASE): string {
  return dataBase ? `${withSlash(dataBase)}${clean(relPath)}` : localDataUrl(relPath, base);
}

/** Direcciones a probar, en orden: la propia y, de respaldo, la copia local. */
export function dataUrls(relPath: string, base?: string, dataBase: string = DATA_BASE): string[] {
  const local = localDataUrl(relPath, base);
  return dataBase ? [dataUrl(relPath, base, dataBase), local] : [local];
}

/** Respuestas que justifican probar el respaldo: el servidor de datos falló o cortó por cupo (no un 404). */
function shouldFallBack(res: Response): boolean {
  return res.status === 429 || res.status >= 500;
}

/**
 * Pide un archivo de datos probando cada dirección en orden. Devuelve la primera respuesta "buena" (incluido un
 * 404: el archivo no existe y listo); si todas fallan, la última respuesta o el último error de red.
 */
export async function fetchFromData(relPath: string, init: RequestInit, f: typeof fetch = fetch, urls: string[] = dataUrls(relPath)): Promise<Response> {
  let last: Response | undefined;
  let lastError: unknown;
  for (const url of urls) {
    try {
      const res = await f(url, init);
      if (!shouldFallBack(res)) return res;
      last = res;
    } catch (err) {
      lastError = err;
    }
  }
  if (last) return last;
  throw lastError ?? new Error('Sin conexión');
}

export interface FetchDataOptions {
  /** Saltea la caché HTTP (botón Actualizar). */
  force?: boolean;
  fetchFn?: typeof fetch;
}

export async function fetchData<T>(relPath: string, opts: FetchDataOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetchFromData(
      relPath,
      {
        cache: opts.force ? 'reload' : 'no-cache',
        headers: { Accept: 'application/json' },
      },
      opts.fetchFn ?? fetch,
    );
  } catch {
    throw new DataLoadError(relPath, 'Sin conexión y sin una copia guardada de los datos.');
  }
  if (res.status === 404) throw new DataNotFoundError(relPath);
  if (!res.ok) throw new DataLoadError(relPath, `Error ${res.status} al leer ${relPath}.`);
  const type = res.headers.get('content-type') ?? '';
  // Un servidor estático puede devolver index.html (200) para rutas que no existen.
  if (type.includes('text/html')) throw new DataNotFoundError(relPath);
  try {
    return (await res.json()) as T;
  } catch {
    throw new DataLoadError(relPath, `El archivo ${relPath} no es un JSON válido.`);
  }
}

/**
 * URL absoluta (con host) de un archivo de datos, para compartir o suscribirse. Con dirección propia es esa; si no,
 * se resuelve contra la página actual (la app puede vivir en una sub-ruta). `page`, `base` y `dataBase` solo se
 * pasan en pruebas.
 */
export function absoluteDataUrl(relPath: string, page: string = window.location.href, base?: string, dataBase: string = DATA_BASE): string {
  return new URL(dataUrl(relPath, base, dataBase), page).toString();
}

/** webcal://data.gridagenda.com/feeds/deporte-motor.ics */
export function webcalUrl(relPath = 'feeds/deporte-motor.ics', page: string = window.location.href, base?: string, dataBase: string = DATA_BASE): string {
  return absoluteDataUrl(relPath, page, base, dataBase).replace(/^https?:\/\//, 'webcal://');
}

/** Calendario de suscripción de una categoría (lo publica el pipeline): "feeds/f1.ics". */
export function seriesFeedPath(seriesId: string): string {
  return `feeds/${encodeURIComponent(seriesId)}.ics`;
}

/**
 * ¿Está publicado este archivo de datos? Sirve para no ofrecer una suscripción que daría 404: el calendario de
 * una categoría recién agregada aparece recién con la corrida siguiente del pipeline.
 * Devuelve null si no se pudo saber (sin conexión, error del servidor).
 */
export async function dataFileExists(relPath: string, fetchFn: typeof fetch = fetch): Promise<boolean | null> {
  try {
    const res = await fetchFromData(relPath, { method: 'HEAD', cache: 'no-store' }, fetchFn);
    if (res.status === 404) return false;
    if (!res.ok) return null;
    // Un servidor estático puede devolver index.html (200) para rutas que no existen.
    return !(res.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return null;
  }
}
