/**
 * Patrón de caché del service worker para archivos de datos: los de data/ junto a la app y, si hay dirección
 * propia (`ownBase`, con barra final, p. ej. "https://data.gridagenda.com/"), los de esa dirección.
 * Para un origen distinto al de la app, Workbox exige que el patrón calce desde el inicio de la URL.
 * `rest` es la parte de la ruta dentro de los datos, como expresión regular.
 */
export function dataPattern(rest: string, ownBase = ''): RegExp {
  const escaped = ownBase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const prefix = ownBase ? `(?:/data/|^${escaped})` : '/data/';
  return new RegExp(`${prefix}${rest}(?:\\?.*)?$`);
}

/** "https://data.gridagenda.com" -> "https://data.gridagenda.com/"; vacío queda vacío. */
export function withTrailingSlash(value: string | undefined): string {
  const v = (value ?? '').trim();
  return v && !v.endsWith('/') ? `${v}/` : v;
}
