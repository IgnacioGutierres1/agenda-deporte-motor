/**
 * Lectura de los JSON que publica el pipeline en /data/.
 * Las URL siempre se arman desde import.meta.env.BASE_URL para funcionar bajo una sub-ruta (GitHub Pages).
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

/** "schedule.json" -> "/agenda-deporte-motor/data/schedule.json" */
export function dataUrl(relPath: string, base: string = import.meta.env.BASE_URL): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  return `${b}data/${relPath.replace(/^\/+/, '')}`;
}

export interface FetchDataOptions {
  /** Saltea la caché HTTP (botón Actualizar). */
  force?: boolean;
  fetchFn?: typeof fetch;
}

export async function fetchData<T>(relPath: string, opts: FetchDataOptions = {}): Promise<T> {
  const f = opts.fetchFn ?? fetch;
  const url = dataUrl(relPath);
  let res: Response;
  try {
    res = await f(url, {
      cache: opts.force ? 'reload' : 'no-cache',
      headers: { Accept: 'application/json' },
    });
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

/** URL absoluta (con host) de un archivo de data/. `base` solo se pasa en pruebas (por defecto, la de la app). */
export function absoluteDataUrl(relPath: string, origin: string = window.location.origin, base?: string): string {
  return new URL(dataUrl(relPath, base), origin).toString();
}

/** webcal://host/base/data/feeds/deporte-motor.ics */
export function webcalUrl(relPath = 'feeds/deporte-motor.ics', origin: string = window.location.origin, base?: string): string {
  return absoluteDataUrl(relPath, origin, base).replace(/^https?:\/\//, 'webcal://');
}

/** Calendario de suscripción de una categoría (lo publica el pipeline): "feeds/f1.ics". */
export function seriesFeedPath(seriesId: string): string {
  return `feeds/${encodeURIComponent(seriesId)}.ics`;
}

/**
 * ¿Está publicado este archivo de data/? Sirve para no ofrecer una suscripción que daría 404: el calendario de
 * una categoría recién agregada aparece recién con la corrida siguiente del pipeline.
 * Devuelve null si no se pudo saber (sin conexión, error del servidor).
 */
export async function dataFileExists(relPath: string, fetchFn: typeof fetch = fetch): Promise<boolean | null> {
  try {
    const res = await fetchFn(dataUrl(relPath), { method: 'HEAD', cache: 'no-store' });
    if (res.status === 404) return false;
    if (!res.ok) return null;
    // Un servidor estático puede devolver index.html (200) para rutas que no existen.
    return !(res.headers.get('content-type') ?? '').includes('text/html');
  } catch {
    return null;
  }
}
