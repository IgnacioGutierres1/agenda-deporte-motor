/**
 * Plan B para sitios oficiales que bloquean a los servidores de GitHub Actions (HTTP 403 de Cloudflare,
 * p. ej. tc2000.com.ar): se pide la misma página a través del proxy del traductor de Google
 * (https://<host>.translate.goog/...). La descarga la hace Google, el HTML llega sin traducir
 * (la traducción la hace un script en el navegador) y acá se deshace la reescritura de links,
 * así que el resto del pipeline ve la página oficial tal cual y la fuente sigue siendo la URL oficial.
 */

const PROXY_PARAMS = '_x_tr_sl=auto&_x_tr_tl=es&_x_tr_hl=es';

/** "www.tc2000.com.ar" -> "www-tc2000-com-ar" (los guiones existentes se duplican). */
function encodeHost(host: string): string {
  return host.replace(/-/g, '--').replace(/\./g, '-');
}

function decodeHost(encoded: string): string {
  return encoded.replace(/--/g, '\u0000').replace(/-/g, '.').replace(/\u0000/g, '-');
}

/** URL de la misma página a través del proxy de Google (null si la URL no es http/https). */
export function googleProxyUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  const sep = u.search ? '&' : '?';
  return `https://${encodeHost(u.hostname)}.translate.goog${u.pathname}${u.search}${sep}${PROXY_PARAMS}${u.hash}`;
}

/** Deshace la reescritura del proxy: hosts *.translate.goog y parámetros _x_tr_* vuelven a ser los oficiales. */
export function unproxyHtml(html: string): string {
  return html
    .replace(/https:\/\/translate\.google\.com\/website\?[^"'\s<>]*?(?:&amp;|&)u=([^"'\s<>&]+)/gi, (m, u: string) => {
      try {
        return decodeURIComponent(u);
      } catch {
        return m;
      }
    })
    .replace(/https?:\/\/([a-z0-9-]+)\.translate\.goog/gi, (_m, h: string) => `https://${decodeHost(h.toLowerCase())}`)
    .replace(/([?&]|&amp;)_x_tr_[a-z]+=[^&"'#\s<>]*/gi, (_m, sep: string) => (sep === '?' ? '?' : ''))
    .replace(/\?(&amp;|&)/g, '?')
    .replace(/\?(["'#\s<>])/g, '$1');
}
