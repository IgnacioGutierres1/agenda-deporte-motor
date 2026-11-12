/**
 * Inscriptos de Fórmula 1 desde formula1.com (sin IA). La F1 es una serie con adaptador propio
 * (adapters/f1.ts); esta receta solo aporta la lista de pilotos para la fase de inscriptos.
 *
 * - https://www.formula1.com/en/drivers: una tarjeta por piloto titular con nombre, equipo (con el mismo nombre
 *   que la tabla de constructores: "Red Bull Racing", "Haas F1 Team"), bandera ("Flag of Argentina") y link a
 *   su ficha. El número no figura como texto (es una imagen).
 * - https://www.formula1.com/en/drivers/{slug}: debajo del nombre, la ficha muestra país · equipo · número
 *   ("Argentina · Alpine · 43"); de ahí sale el número de cada piloto.
 *
 * La página solo publica a los titulares vigentes: no distingue reservas ni reemplazos, así que no se marcan.
 */
import type { RosterRow } from '@dm/shared';
import { absoluteUrl, attr, decodeEntities, textOf } from '../extract/html.ts';
import { host, isoNow, stripComments } from './kit.ts';
import { countryName } from './places.ts';
import type { RecipeContext, RosterFound, SiteRecipe } from './types.ts';

export const F1_DRIVERS_URL = 'https://www.formula1.com/en/drivers';

/** Fichas que se leen a la vez (son ~22 páginas, una vez cada tres días). */
const CONCURRENCY = 4;

/** Tarjeta de la página de pilotos. */
export interface F1DriverCard {
  driver: string;
  url: string;
  team?: string;
  country?: string;
  /** Temporada de las fotos (".../common/f1/2026/alpine/..."). */
  season?: number;
}

/** "Flag of Great Britain" -> "Great Britain" (places.ts lo normaliza al nombre en inglés). */
function flagCountry(fragment: string): string | undefined {
  const raw = fragment.match(/<title>\s*Flag of ([^<]+?)\s*<\/title>/i)?.[1];
  return raw ? countryName(decodeEntities(raw)) : undefined;
}

/** Texto de los <p> cuya clase incluye el fragmento dado (las clases llevan un sufijo que cambia en cada build). */
function paragraphsByClass(fragment: string, cls: string): string[] {
  const re = new RegExp(`<p\\b[^>]*class="[^"]*${cls}[^"]*"[^>]*>([\\s\\S]*?)<\\/p>`, 'gi');
  return [...fragment.matchAll(re)].map((m) => textOf(m[1] ?? '')).filter(Boolean);
}

/**
 * Tarjetas de /en/drivers. Solo se toman los <a href="/en/drivers/{slug}"> del HTML (el payload RSC repite la
 * página como JSON escapado, sin esa forma) y que traen nombre: un link suelto de un menú no es una tarjeta.
 */
export function f1DriverCards(html: string, pageUrl = F1_DRIVERS_URL): F1DriverCard[] {
  const page = stripComments(html);
  const out: F1DriverCard[] = [];
  const seen = new Set<string>();
  for (const m of page.matchAll(/<a\b[^>]*\bhref="(\/en\/drivers\/[a-z0-9-]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const url = absoluteUrl(m[1]!, pageUrl);
    const card = m[2] ?? '';
    if (!url || seen.has(url)) continue;
    const first = paragraphsByClass(card, 'display-l-regular')[0] ?? '';
    const last = paragraphsByClass(card, 'display-l-bold')[0] ?? '';
    const alt = decodeEntities(attr(card.match(/<img\b[^>]*\balt="[^"]+"[^>]*>/i)?.[0] ?? '', 'alt') ?? '').trim();
    const driver = (first && last ? `${first} ${last}` : alt).replace(/\s+/g, ' ').trim();
    if (!/\S\s+\S/.test(driver)) continue;
    seen.add(url);
    const team = paragraphsByClass(card, 'body-xs-semibold')[0];
    const country = flagCountry(card);
    const season = Number(card.match(/\/common\/f1\/(\d{4})\//)?.[1]);
    out.push({
      driver,
      url,
      ...(team ? { team } : {}),
      ...(country ? { country } : {}),
      ...(Number.isFinite(season) && season > 0 ? { season } : {}),
    });
  }
  return out;
}

/**
 * Ficha de un piloto: después del <h1> con el nombre viene la línea "bandera País · Equipo · Número".
 * Se lee hasta el primer botón o subtítulo, para no tomar números de las estadísticas.
 */
export function f1DriverPage(html: string): { number?: string; country?: string; team?: string } {
  const page = stripComments(html);
  const h1 = page.search(/<\/h1>/i);
  if (h1 < 0) throw new Error('F1: la ficha del piloto no tiene encabezado');
  const rest = page.slice(h1, h1 + 6000);
  const stop = rest.search(/<a\b|<h2\b|<dl\b|<section\b/i);
  const header = stop > 0 ? rest.slice(0, stop) : rest;
  const texts = [...header.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => textOf(m[1] ?? '')).filter(Boolean);
  const number = texts.find((t) => /^\d{1,3}$/.test(t));
  const country = flagCountry(header);
  const team = texts.find((t) => t !== number && (!country || countryName(t) !== country));
  return { ...(number ? { number } : {}), ...(country ? { country } : {}), ...(team ? { team } : {}) };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Inscriptos de F1: la página de pilotos más la ficha de cada uno (número y país). */
export async function f1Roster(url: string, ctx: RecipeContext): Promise<RosterFound | null> {
  const html = (await ctx.http.text(url)).body;
  const cards = f1DriverCards(html, url);
  if (cards.length === 0) throw new Error('F1: la página de pilotos no tiene tarjetas de pilotos');
  const seasons = cards.map((c) => c.season).filter((s): s is number => s !== undefined);
  const season = seasons.length ? Math.max(...seasons) : undefined;
  // Una grilla de más de un año de diferencia ya no describe la actual (ni la anticipada de la próxima).
  if (season !== undefined && (season < ctx.season - 1 || season > ctx.season + 1)) return null;
  const rows = await mapLimit(cards, CONCURRENCY, async (card): Promise<RosterRow> => {
    let page: ReturnType<typeof f1DriverPage> = {};
    try {
      page = f1DriverPage((await ctx.http.text(card.url)).body);
    } catch {
      // Sin ficha: el piloto queda en la lista sin número.
    }
    const country = card.country ?? page.country;
    const team = card.team ?? page.team;
    return {
      driver: card.driver,
      ...(team ? { team } : {}),
      ...(page.number ? { number: page.number } : {}),
      ...(country ? { country } : {}),
    };
  });
  // Sin ningún número la lista no suma nada a la tabla de campeonato: mejor conservar la anterior.
  if (!rows.some((r) => r.number)) throw new Error('F1: no se pudo leer el número de ningún piloto');
  return {
    rows,
    ...(season !== undefined ? { season } : {}),
    source: { url, title: `Formula 1 — Pilotos${season ? ` ${season}` : ''}`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) },
  };
}

/**
 * Receta de formula1.com solo para la lista de pilotos (rosterUrls de la F1). No entra en RECIPES: el
 * calendario, los resultados y el campeonato de la F1 los lee el adaptador, y una receta registrada ahí con
 * el mismo sitio cambiaría cómo se resuelve la serie. La fase de inscriptos la consulta antes que RECIPES.
 */
export const formula1Roster: SiteRecipe = {
  name: 'formula1',
  match: (url) => host(url) === 'formula1.com' && /^\/en\/drivers\/?$/.test(new URL(url).pathname),
  roster: (url, ctx) => f1Roster(url, ctx),
};
