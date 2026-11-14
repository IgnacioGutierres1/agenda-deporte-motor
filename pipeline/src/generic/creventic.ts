/**
 * 24H Series (Creventic, www.24hseries.com): lector determinista del calendario, del campeonato y de los
 * inscriptos. La temporada tiene dos campeonatos con tablas propias: el Middle East Trophy (enero, en el Golfo)
 * y la serie europea (marzo a septiembre); los dos llevan el año de la temporada en el nombre.
 *
 * Las tablas no están en www.24hseries.com/standings sino en un iframe del "dashboard" de Creventic
 * (dashboard.24hseries.com/vendors/24hseries/standings.php), que publica cada campeonato en
 * standings.php?championship=N con tablas de equipos y de pilotos por clase (GT3, GT3-P/A, 992…). Muchos
 * pilotos son amateurs que solo corren acá: sin estas tablas no figuran en el índice.
 */
import type { RosterRow, StandingsRow, StandingsTable } from '@dm/shared';
import { absoluteUrl, attr, blocksByClass, textOf } from '../extract/html.ts';
import { countryName, isoDate, monthNumber } from './places.ts';
import { checkStandingsTable, dedupe, host, isoNow, pageOrNull, parseNumber, standingsSource, stripComments, tzFor } from './kit.ts';
import { className, countryFromCode } from './rosters.ts';
import type { CalendarEntry, RecipeContext, SiteRecipe } from './types.ts';
import { creventicPastSessions, creventicResults } from './results-creventic.ts';

// ─── Calendario ───────────────────────────────────────────────────────────────────────────────

/** Eventos de la temporada en la página /races (cada carrera es un <a class="raceItem" data-year="AAAA">). */
export function creventicCalendar(html: string, pageUrl: string, season: number): CalendarEntry[] {
  const out: CalendarEntry[] = [];
  const ymd = (frag: string) => {
    const spans = [...frag.matchAll(/<span class="day[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]!.trim());
    return spans.length >= 3 ? isoDate(Number(spans[2]), monthNumber(spans[1]!) ?? 0, Number(spans[0])) : null;
  };
  for (const b of blocksByClass(stripComments(html), 'raceItem', 4000)) {
    if (attr(b.slice(0, 400), 'data-year') !== String(season)) continue;
    const href = attr(b.slice(0, 400), 'href');
    const start = ymd(b.match(/<span class="start">([\s\S]*?<\/span>)<\/span>/)?.[1] ?? '');
    const end = ymd(b.match(/<span class="end">([\s\S]*?<\/span>)<\/span>/)?.[1] ?? '') ?? start;
    const name = textOf((b.match(/class="mediumTitle">([\s\S]*?)<\/span>(?:<i|\s*<\/span>)/)?.[1] ?? '').replace(/<span class="year">[\s\S]*?(<\/span>|$)/, '')).replace(/\s*\|\s*\d{4}$/, '');
    if (!href || !start || !end || !name) continue;
    const flag = decodeURIComponent(b.match(/Countries(?:%20| )Flags\/(?:flags\/)?([^"_.]+)[_.]/)?.[1] ?? '');
    const circuit = textOf(b.match(/class="infoContent">\s*<span class="smallTitle">([\s\S]*?)<\/span>/)?.[1] ?? '') || name;
    out.push({
      name,
      circuit,
      country: countryName(flag),
      tz: tzFor(flag, `${circuit} ${name}`),
      dateStart: start,
      dateEnd: end < start ? start : end,
      url: absoluteUrl(href, pageUrl) ?? undefined,
    });
  }
  return dedupe(out);
}

// ─── Campeonato ───────────────────────────────────────────────────────────────────────────────

export interface CreventicChampionship {
  id: string;
  label: string;
}

/**
 * Temporada de un campeonato según su nombre: "Michelin 24H SERIES Europe 2026" -> 2026. El Middle East Trophy
 * de los primeros años cruzaba el año ("… 2023/2024"): cuenta para la temporada en la que terminó, como sus
 * carreras de enero en el calendario. null si el nombre no termina en un año.
 */
export function championshipSeason(label: string): number | null {
  const m = label.trim().match(/(\d{4})(?:\s*\/\s*(\d{4}))?$/);
  return m ? Number(m[2] ?? m[1]) : null;
}

/** Campeonatos del selector del dashboard (#csSelList), del más nuevo al más viejo como los publica el sitio. */
export function creventicChampionships(html: string): CreventicChampionship[] {
  const list = html.match(/<div id="csSelList">([\s\S]*?)<\/div>/)?.[1] ?? '';
  return [...list.matchAll(/<a\b[^>]*href="[^"]*[?&]championship=(\d+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({
    id: m[1]!,
    label: textOf(m[2] ?? ''),
  }));
}

/** Campeonato que muestra la página (el texto de #csSel antes de la lista desplegable). */
const shownChampionship = (html: string) => textOf(html.match(/<div id="csSel">([^<]*)/)?.[1] ?? '');

/**
 * Nombre corto del campeonato para el título de las tablas cuando la temporada tiene más de uno:
 * "Michelin 24H SERIES Europe 2026" -> "Europa", "Michelin 24H SERIES MIDDLE EAST TROPHY 2026" -> "Middle East Trophy".
 */
export function championshipShortName(label: string): string {
  if (/middle\s*east/i.test(label)) return 'Middle East Trophy';
  if (/europe/i.test(label)) return 'Europa';
  return label
    .replace(/\d{4}(\s*\/\s*\d{4})?\s*$/, '')
    .replace(/^.*?24H\s*SERIES\s*(powered by \S+\s*)?/i, '')
    .trim();
}

/** "Sainteloc Junior Team (18)" -> { name: "Sainteloc Junior Team", number: "18" }: las tablas de equipos van por auto. */
function teamAndNumber(raw: string): { name: string; number?: string } {
  const m = raw.match(/^(.*?)\s*\((\d+[A-Za-z]?)\)$/);
  return m ? { name: m[1]!.trim(), number: m[2]! } : { name: raw };
}

/**
 * Tablas de un campeonato del dashboard. La página tiene una sección por tipo (<div id="teamsperclass"
 * class="standings">, "driversperclass" y, algunos años, "ladiescupperclass") y dentro una tabla por clase
 * (<h2>GT3</h2> seguido de filas <div class="row">). Solo se leen equipos y pilotos por clase: la Ladies Cup
 * repite pilotos que ya están en su clase. Los autos sin puntos figuran al final con posición "*" y total "-",
 * o con total 0 y una posición que a veces saltea números ("…, 10, 11, *, *, 13" en el Middle East Trophy 2025):
 * no son parte de la tabla. Los empates se numeran "1, 1, 1, 2…" (de ahí la verificación laxa). Las clases
 * se superponen como en el sitio: GT3 incluye a los autos de GT3-P/A y GT3-AM (cada una con su propio puntaje),
 * y TCE y TCX comparten autos; son títulos distintos, así que se publican todas.
 * Orden: los pilotos de cada clase primero y después los equipos, como en SUPER GT.
 */
const SUBCUP_RE = /-(P\/?A|PRO\/?AM|AM)$/i;

export function creventicTables(html: string, suffix: string): StandingsTable[] {
  const drivers: StandingsTable[] = [];
  const teams: StandingsTable[] = [];
  const parts = stripComments(html).split(/<div id="([a-z]+)" class="standings">/);
  for (let i = 1; i + 1 < parts.length; i += 2) {
    const section = parts[i]!;
    const kind = section === 'driversperclass' ? 'Pilotos' : section === 'teamsperclass' ? 'Equipos' : null;
    if (!kind) continue;
    for (const chunk of parts[i + 1]!.split(/<h2>/).slice(1)) {
      const cls = textOf(chunk.slice(0, chunk.indexOf('</h2>')));
      // Subcopas (GT3-P/A, GT3-AM, 992-AM) repiten pilotos de su clase madre: como en SRO, solo se publican
      // las clases completas para no duplicar cada piloto en la ficha y en la pestaña Tabla.
      if (SUBCUP_RE.test(cls)) continue;
      const title = `${kind} ${cls}${suffix ? ` (${suffix})` : ''}`;
      const rows: StandingsRow[] = [];
      for (const row of chunk.split(/<div class="row">/).slice(1)) {
        const pos = textOf(row.match(/<div class="pos">([\s\S]*?)<\/div>/)?.[1] ?? '');
        const total = textOf(row.match(/<div class="race tot">([\s\S]*?)<\/div>/)?.[1] ?? '');
        if (!/^\d+$/.test(pos) || total === '-' || total === '0') continue;
        const name = textOf(row.match(/<div class="name">([\s\S]*?)<\/div>/)?.[1] ?? '');
        const points = parseNumber(total) ?? NaN;
        if (kind === 'Equipos') {
          const t = teamAndNumber(name);
          rows.push({ pos: Number(pos), name: t.name, ...(t.number ? { number: t.number } : {}), points });
        } else {
          // Bandera de la nacionalidad (…/countries/DEU.png): el índice la usa si ninguna lista de inscriptos la da.
          const code = row.match(/<div class="nat">[\s\S]*?\/countries\/([A-Z]{3})\.png/)?.[1];
          const country = code ? countryFromCode(code) : undefined;
          rows.push({ pos: Number(pos), name, points, ...(country ? { country } : {}) });
        }
      }
      // Clase sin autos con puntos (TC en 2026): no hay tabla que mostrar.
      if (rows.length) (kind === 'Pilotos' ? drivers : teams).push(checkStandingsTable({ title, rows }, true));
    }
  }
  return [...drivers, ...teams];
}

/**
 * Campeonato de la temporada: la página /standings del sitio solo embebe el dashboard en un iframe; se sigue
 * ese iframe (así un cambio de dirección del dashboard no rompe la lectura), se eligen los campeonatos cuyo
 * nombre termina en el año pedido y se lee cada uno. null si ninguno es de esa temporada (todavía no
 * publicada); lanza un error si la página no tiene el formato esperado.
 */
async function creventicStandings(url: string, ctx: RecipeContext) {
  const page = (await ctx.http.text(url)).body;
  const iframe = [...page.matchAll(/<iframe\b[^>]*>/gi)].map((m) => attr(m[0], 'src') ?? '').find((src) => /standings\.php/i.test(src));
  const dashboard = iframe ? absoluteUrl(iframe, url) : null;
  if (!dashboard) throw new Error('24H Series: la página de posiciones no embebe el dashboard de Creventic');
  const first = (await ctx.http.text(dashboard)).body;
  const all = creventicChampionships(first);
  if (all.length === 0) throw new Error('24H Series: el dashboard no tiene el selector de campeonatos');
  const chosen = all.filter((c) => championshipSeason(c.label) === ctx.season);
  if (chosen.length === 0) return null;
  const tables: StandingsTable[] = [];
  let firstUrl = '';
  for (const c of chosen) {
    const champUrl = new URL(`standings.php?championship=${c.id}`, dashboard).toString();
    const html = (await ctx.http.text(champUrl)).body;
    // Un id que ya no existe devuelve la página sin campeonato: no se mezcla con otro.
    if (shownChampionship(html) !== c.label) throw new Error(`24H Series: el dashboard no mostró "${c.label}"`);
    firstUrl ||= champUrl;
    tables.push(...creventicTables(html, chosen.length > 1 ? championshipShortName(c.label) : ''));
  }
  if (tables.length === 0) return null;
  return { tables, source: standingsSource(firstUrl, `24H Series Standings ${ctx.season}`, ctx) };
}

// ─── Inscriptos ───────────────────────────────────────────────────────────────────────────────

/** País de la bandera de un piloto ("/gfx/Countries Flags/flags/DEU_flag.png" -> "Germany"); undefined si no hay. */
function flagCountry(fragment: string): string | undefined {
  const code = decodeURIComponent(fragment.match(/Countries(?:%20| )Flags\/(?:flags\/)?([A-Z]{3})_flag\./)?.[1] ?? '');
  return code ? countryFromCode(code) : undefined;
}

/**
 * Lista de inscriptos de la página de un evento (bloque entryListBlock): un <div class="teamWrapper"
 * data-class="GT3-PRO/AM"> por auto, con número, equipo, auto y, en la columna "driverCol" de la versión de
 * escritorio, cada piloto con su bandera. Algunos eventos publican solo los autos ("teamHeader desktop
 * noDrivers"; Barcelona 2026 sigue así después de la carrera): esos no aportan pilotos, y los que solo corrieron
 * ahí quedan en el índice por la tabla del campeonato (con su nacionalidad).
 */
export function creventicEntryList(html: string): RosterRow[] {
  const clean = stripComments(html);
  const start = clean.indexOf('entryListBlock');
  if (start < 0) return [];
  const end = clean.indexOf('</section>', start);
  const block = clean.slice(start, end > start ? end : undefined);
  const rows: RosterRow[] = [];
  for (const car of block.split(/(?=<div class="teamWrapper\b)/).slice(1)) {
    const cut = car.indexOf('<div class="teamHeader mobile">');
    const desktop = cut > 0 ? car.slice(0, cut) : car;
    const drivers = desktop.split(/<div class="driver">/).slice(1);
    if (drivers.length === 0) continue;
    const cls = attr(car.slice(0, 300), 'data-class') ?? '';
    const number = textOf(desktop.match(/<span class="col tinyTitle start">([\s\S]*?)<\/span>/)?.[1] ?? '');
    const carCol = desktop.match(/<span class="col tinyTitle name car">\s*<span>([\s\S]*?)<\/span>\s*<span class="carBrand">([\s\S]*?)<\/span>/);
    const team = textOf(carCol?.[1] ?? '');
    const vehicle = textOf(carCol?.[2] ?? '');
    for (const d of drivers) {
      const driver = textOf(d.match(/<div class="driverTitle[^"]*">([\s\S]*?)<\/div>/)?.[1] ?? '');
      if (!/\p{L}{2}/u.test(driver)) continue;
      const country = flagCountry(d);
      rows.push({
        driver,
        ...(team ? { team } : {}),
        ...(number ? { number } : {}),
        ...(vehicle ? { vehicle } : {}),
        ...(cls ? { class: className(cls) } : {}),
        ...(country ? { country } : {}),
      });
    }
  }
  return rows;
}

/**
 * Inscriptos de la temporada: no hay una lista anual, cada evento publica la suya (y las tripulaciones cambian
 * de una carrera a otra). Se leen todos los eventos de la temporada del calendario (/races), del más reciente
 * al más viejo; el flujo común deja una fila por piloto, auto y equipo. null si ningún evento publicó pilotos.
 */
async function creventicRoster(url: string, ctx: RecipeContext) {
  const page = await pageOrNull(ctx, url);
  if (!page) return null;
  const events = creventicCalendar(page, url, ctx.season)
    .filter((e) => e.url)
    .sort((a, b) => b.dateStart.localeCompare(a.dateStart));
  const rows: RosterRow[] = [];
  let firstUrl = '';
  for (const e of events) {
    const html = await pageOrNull(ctx, e.url!);
    const found = html ? creventicEntryList(html) : [];
    if (found.length === 0) continue;
    firstUrl ||= e.url!;
    rows.push(...found);
  }
  if (rows.length === 0) return null;
  return { rows, source: { url: firstUrl, title: `Entry list 24H Series ${ctx.season}`, kind: 'html' as const, method: 'directo' as const, fetchedAt: isoNow(ctx.now) } };
}

// ─── Receta ───────────────────────────────────────────────────────────────────────────────────

export const creventic: SiteRecipe = {
  name: '24h-series',
  match: (url) => host(url) === '24hseries.com',
  calendarUrl: (url) => {
    const u = new URL(url);
    return u.pathname === '/' ? `${u.origin}/races` : url;
  },
  calendar: (doc, ctx) => creventicCalendar(doc.raw, doc.url, ctx.season),
  standings: (url, ctx) => creventicStandings(url, ctx),
  roster: (url, ctx) => creventicRoster(url, ctx),
  pastSessions: (entry, ctx) => creventicPastSessions(entry, ctx),
  results: (entry, sessions, ctx) => creventicResults(entry, sessions, ctx),
};
