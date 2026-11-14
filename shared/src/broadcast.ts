/**
 * Enlaces de transmisión ("dónde verlo"): nombre del canal o la plataforma → sitio, app o canal oficial.
 *
 * Los nombres llegan en `Session.broadcast`: los habituales de config/broadcast.ar.json o los que informa la
 * fuente. La tabla vive en shared porque la usan la app (hoja de sesión) y el generador de .ics (la descarga
 * de la app y los calendarios de suscripción del pipeline). Lógica pura, sin dependencias.
 *
 * Reglas de la tabla:
 * - Cada URL se abrió y se confirmó que es el sitio o el canal oficial (ver la nota de cada entrada); la mayoría
 *   está además enlazada desde el sitio oficial de la categoría. Fecha: BROADCAST_LINKS_VERIFIED_AT.
 * - Lo que no se pudo confirmar NO se adivina: un "YouTube X" sin canal confirmado lleva a una búsqueda de
 *   YouTube y el resto queda como texto. Sin enlace al 12/11/2026:
 *     · "Fox Sports": foxsports.com.ar ya no resuelve (sin DNS).
 *     · "NASCAR TrackPass": nascar.com rechaza la lectura automática (403).
 *     · "IMSA TV": imsa.tv redirige a imsa.com, que rechaza la lectura automática (403).
 * - Al cambiar un derecho o una plataforma: abrir la URL nueva, confirmarla y actualizar la fecha.
 * - El primer nombre de cada entrada es el actual (el de config/broadcast.ar.json); los demás son alias, entre
 *   ellos los nombres viejos que siguen en datos ya publicados ("FIA WEC TV", "TV Pública").
 */

/** Fecha (AAAA-MM-DD) en que se abrió y confirmó cada URL de la tabla. */
export const BROADCAST_LINKS_VERIFIED_AT = '2026-11-12';

export interface BroadcastLink {
  url: string;
  /**
   * 'official': sitio, app o canal oficial verificado.
   * 'search': búsqueda en YouTube (un "YouTube X" cuyo canal no está confirmado).
   */
  kind: 'official' | 'search';
}

interface BroadcastEntry {
  /** Nombres con los que puede venir el canal (el primero es el habitual). */
  names: string[];
  url: string;
}

const ENTRIES: BroadcastEntry[] = [
  // ── Plataformas y canales de TV ──
  // Portada de Disney+ Argentina ("Disney+ Argentina | Películas, series y deportes sin límites… deportes de ESPN").
  { names: ['Disney+', 'Disney Plus'], url: 'https://www.disneyplus.com/es-ar' },
  // Enlazado desde formula1.com como "F1 TV"; la página se presenta como "F1 TV".
  { names: ['F1 TV Pro', 'F1 TV', 'F1TV', 'F1 TV Premium', 'F1 TV Access'], url: 'https://f1tv.formula1.com/' },
  // "ESPN Argentina" (og:site_name ESPN.com.ar).
  { names: ['ESPN'], url: 'https://www.espn.com.ar/' },
  // "Home | Watch WRC & ERC Live Online | Rally.TV" (og:site_name Rally.TV): plataforma oficial del WRC.
  { names: ['Rally.TV', 'Rally TV', 'RallyTV'], url: 'https://www.rally.tv/en' },
  // Enlazado desde motogp.com como "VideoPass".
  { names: ['MotoGP VideoPass', 'VideoPass'], url: 'https://www.motogp.com/es/videopass' },
  // Enlazado desde indycar.com/how-to-follow/international como "INDYCAR LIVE".
  { names: ['IndyCar Live'], url: 'https://www.indycarlive.com/' },
  // La plataforma hoy se llama FIAWEC+: fiawec.tv redirige ahí y fiawec.com la enlaza como "FIAWEC+".
  { names: ['FIAWEC+', 'FIA WEC TV', 'FIA WEC+', 'WEC TV', 'FIAWEC TV'], url: 'https://plus.fiawec.com/en' },
  // App oficial de Super Formula: superformula.net enlaza a su página de SFgo; esta es la versión en inglés.
  { names: ['SFgo', 'SF go'], url: 'https://superformula.net/sfgo/en/' },
  // tvpublica.com.ar redirige a canal7.com.ar ("Sitio oficial de Canal 7"): es el mismo canal, con otro nombre.
  { names: ['Canal 7', 'TV Pública', 'Televisión Pública', 'TVP'], url: 'https://www.canal7.com.ar/' },
  // Enlazado desde actc.org.ar como "MotorPlay".
  { names: ['Motorplay', 'Motor Play', 'Motorplay TV'], url: 'https://www.motorplay.tv/ar' },
  // "Carreras de autos - Automovilismo deportivo Argentino | Carburando".
  { names: ['Carburando'], url: 'https://www.carburando.com/' },
  // "Campeones.com.ar" (og:site_name Campeones).
  { names: ['Campeones'], url: 'https://campeones.com.ar/' },
  // Transmisión propia de SCORE International en su sitio: "All 2026 SCORE races will be streaming LIVE on
  // score-international.com" (calendario oficial 2026 y 2027). Verificado el 14/11/2026.
  { names: ['SCORE Live', 'SCORE Live Stream', 'SCORE International Live'], url: 'https://score-international.com/' },

  // ── Canales oficiales de YouTube (nombre del canal en la página; * = además enlazado desde el sitio oficial) ──
  // "F1 Academy" (verificado por YouTube) * f1academy.com
  { names: ['YouTube F1 Academy'], url: 'https://www.youtube.com/@f1academy' },
  // "INDY NXT by Firestone" ("official YouTube channel for INDY NXT by Firestone") * indynxt.com
  { names: ['YouTube Indy NXT'], url: 'https://www.youtube.com/@INDYNXT' },
  // "GTWorld" (verificado por YouTube) * gt-world-challenge-europe.com e intercontinentalgtchallenge.com
  { names: ['YouTube GT World', 'YouTube GTWorld', 'GT World', 'GTWorld'], url: 'https://www.youtube.com/@GTWorld' },
  // "DTM" (verificado por YouTube) * dtm.com ("official DTM YouTube channel")
  { names: ['YouTube DTM'], url: 'https://www.youtube.com/@DTM' },
  // "Nürburgring Langstrecken-Serie" ("official YouTube channel of the ADAC RAVENOL NLS") * nuerburgring-langstrecken-serie.de
  { names: ['YouTube NLS', 'YouTube Nürburgring Langstrecken-Serie', 'YouTube VLN'], url: 'https://www.youtube.com/@VLNOFFICIAL' },
  // "IMSA Official" (verificado por YouTube, 2 M de suscriptores). Sin cruce con imsa.com, que rechaza la lectura automática.
  { names: ['YouTube IMSA'], url: 'https://www.youtube.com/@imsaofficial' },
  // "FIA World Endurance Championship" (verificado por YouTube) * fiawec.com
  { names: ['YouTube WEC', 'YouTube FIA WEC'], url: 'https://www.youtube.com/@FIAWEC' },
  // "European Le Mans Series" (verificado por YouTube) * europeanlemansseries.com
  { names: ['YouTube ELMS', 'YouTube European Le Mans Series'], url: 'https://www.youtube.com/@EuropeanLeMansSeriesOfficial' },
  // "Asian Le Mans Series" * asianlemansseries.com
  { names: ['YouTube Asian Le Mans Series', 'YouTube ALMS'], url: 'https://www.youtube.com/@AsianLeMansSeries' },
  // "SUPER GT Official Channel" * supergt.net
  { names: ['YouTube SUPER GT'], url: 'https://www.youtube.com/@SUPERGTOfficialChannel' },
  // "SUPER FORMULA Official" * superformula.net
  { names: ['YouTube Super Formula'], url: 'https://www.youtube.com/@superformula_official' },
  // "Super Taikyu / Stai TV" (verificado por YouTube) * supertaikyu.com
  { names: ['YouTube Super Taikyu', 'YouTube S-Tai TV', 'YouTube Stai TV'], url: 'https://www.youtube.com/channel/UC8sfQKfk_4_JePSHSupvT4w' },
  // "Creventic Motorsports TV" (el organizador de las 24H Series) * 24hseries.com
  { names: ['YouTube 24H Series', 'YouTube Creventic'], url: 'https://www.youtube.com/@creventicmotorsportstv' },
  // "International GT Open series" * gtopen.gtsport.es
  { names: ['YouTube GT Open'], url: 'https://www.youtube.com/@GTOPENseries' },
  // "TC2000" ("Canal de YouTube Oficial del TC2000") * tc2000.com.ar
  { names: ['YouTube TC2000'], url: 'https://www.youtube.com/@TC2000ok' },
  // "ACTC Argentina" (verificado por YouTube) * actc.org.ar
  { names: ['YouTube ACTC', 'YouTube Turismo Carretera'], url: 'https://www.youtube.com/@actcargentina' },
  // "Turismo Pista" ("Canal de YouTube oficial del Turismo Pista") * aptpweb.com.ar
  { names: ['YouTube Turismo Pista', 'YouTube APTP'], url: 'https://www.youtube.com/@turismopistaok' },
  // "FORMULA 1" (verificado por YouTube) * formula1.com
  { names: ['YouTube F1', 'YouTube Fórmula 1', 'YouTube Formula 1'], url: 'https://www.youtube.com/@Formula1' },
  // "MotoGP" (verificado por YouTube) * motogp.com
  { names: ['YouTube MotoGP'], url: 'https://www.youtube.com/@motogp' },
  // "NTT INDYCAR SERIES" (verificado por YouTube) * indycar.com
  { names: ['YouTube IndyCar'], url: 'https://www.youtube.com/@indycar' },
  // "Supercars" (verificado por YouTube) * supercars.com
  { names: ['YouTube Supercars'], url: 'https://www.youtube.com/@supercars' },
  // "SCORE International Off-Road Racing" * score-international.com (portada y sitio de resultados). Verificado el 14/11/2026.
  { names: ['YouTube SCORE International', 'YouTube SCORE'], url: 'https://www.youtube.com/@scoreinternational' },
];

/**
 * Clave de búsqueda tolerante: sin mayúsculas, acentos, espacios ni signos ("TV Publica" = "TV Pública",
 * "F1TV" = "F1 TV", "Disney Plus" = "Disney+"). Las aclaraciones entre paréntesis no cuentan.
 */
export function broadcastKey(name: string): string {
  return name
    .replace(/\([^)]*\)/g, ' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\+/g, 'plus')
    .replace(/[^a-z0-9]+/g, '');
}

const INDEX: Map<string, string> = new Map(ENTRIES.flatMap((e) => e.names.map((n): [string, string] => [broadcastKey(n), e.url])));

/** "ESPN 2", "ESPN 3 HD", "Fox Sports Premium" → la clave de la señal principal ("espn", "foxsports"). */
function baseKey(key: string): string {
  let prev = '';
  let k = key;
  while (k !== prev) {
    prev = k;
    k = k.replace(/(\d+|hd|premium)$/, '');
  }
  return k;
}

/** Palabras que no ayudan a encontrar el canal en una búsqueda ("YouTube (canal oficial)"). */
const GENERIC_WORDS = /\b(canal|channel|oficial|official|en vivo|live|gratis|free)\b/gi;

export function youtubeSearchUrl(query: string): string {
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
}

/**
 * Enlace de un canal o plataforma, o null si no hay uno confirmado (se muestra como texto).
 *
 * @param seriesName nombre de la categoría: se usa para la búsqueda cuando el canal viene solo como "YouTube".
 */
export function broadcastLink(name: string, seriesName?: string): BroadcastLink | null {
  const key = broadcastKey(name);
  if (!key) return null;
  const url = INDEX.get(key) ?? INDEX.get(baseKey(key));
  if (url) return { url, kind: 'official' };

  const youtube = name.match(/^\s*you\s?tube\b(.*)$/i);
  if (youtube) {
    const rest = (youtube[1] ?? '')
      .replace(GENERIC_WORDS, ' ')
      .replace(/[()[\]"“”:·–—-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const query = rest || (seriesName ?? '').trim();
    return query ? { url: youtubeSearchUrl(query), kind: 'search' } : null;
  }
  return null;
}

/**
 * Renglones "Canal: URL" para la descripción de un evento de calendario: solo sitios y canales oficiales
 * verificados (las búsquedas no van), sin repetir un mismo enlace ("ESPN" y "ESPN 2").
 */
export function broadcastLinkLines(broadcast: string[]): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const name of broadcast) {
    const link = broadcastLink(name);
    if (!link || link.kind !== 'official' || seen.has(link.url)) continue;
    seen.add(link.url);
    lines.push(`${name}: ${link.url}`);
  }
  return lines;
}
