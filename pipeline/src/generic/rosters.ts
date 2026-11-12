/**
 * Listas oficiales de inscriptos (pilotos, equipos, números, autos y clases) leídas sin IA.
 * Cada lector devuelve null si la lista de la temporada todavía no está publicada y lanza un error si la
 * página no tiene el formato esperado (run.ts conserva entonces el archivo anterior).
 */
import { driverKey, type RosterRow, type Source } from '@dm/shared';
import { absoluteUrl, attr, decodeEntities, textByClass, textOf } from '../extract/html.ts';
import { countryName } from './places.ts';
import type { RecipeContext, RosterFound } from './types.ts';

const stripComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, ' ');

function isoNow(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function rosterSource(url: string, title: string, kind: Source['kind'], ctx: RecipeContext): Source {
  return { url, title, kind, method: 'directo', fetchedAt: isoNow(ctx.now) };
}

/**
 * Temporada publicada aceptable: la pedida, la siguiente (lista de inscriptos anticipada) o la anterior (las
 * listas se publican semanas antes de la primera carrera, y el Asian LMS numera la temporada por el año en
 * que empieza). Una lista más vieja ya no describe la grilla actual.
 */
function acceptable(season: number, ctx: RecipeContext): boolean {
  return season >= ctx.season - 1 && season <= ctx.season + 1;
}

/** Nombre de clase prolijo: "LMP2 PRO/AM" -> "LMP2 Pro/Am", "HYPERCAR" -> "Hypercar"; siglas como LMGT3 quedan igual. */
export function className(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b(PRO|AM|SILVER|GOLD|BRONZE|CUP|TROPHY|ACADEMY|HYPERCAR|INVITATIONAL)\b/gi, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

/** "PROTON COMPETITION #9" -> { team: "PROTON COMPETITION", number: "9" }. */
export function splitTeamNumber(raw: string): { team?: string; number?: string } {
  const t = raw.replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.*?)\s*#\s*([0-9A-Za-z]+)$/);
  const team = (m ? m[1]! : t).trim();
  return { ...(team ? { team } : {}), ...(m ? { number: m[2]! } : {}) };
}

/**
 * Un casillero de piloto vacío o sin confirmar ("/", "TBA") no es un piloto; tampoco un nombre de una sola
 * palabra (las listas provisorias de SRO a veces traen solo "Mikkel"), que no identifica a nadie.
 */
function isRealDriver(name: string): boolean {
  const t = name.trim();
  return /\p{L}{2}/u.test(t) && /\S\s+\S/.test(t) && !/^(tba|tbc|tbd|n\/a)\b/i.test(t);
}

/** Códigos de país (COI o ISO3) que usan las listas de SRO y la 24H Series y que places.ts no conoce. */
const COUNTRY_CODES: Record<string, string> = {
  AGO: 'Angola', AND: 'Andorra', AUT: 'Austria', BEL: 'Belgium', BUL: 'Bulgaria', CHI: 'Chile', CHN: 'China',
  COL: 'Colombia', CRO: 'Croatia', CYP: 'Cyprus', CZE: 'Czech Republic', DEN: 'Denmark', ECU: 'Ecuador',
  EST: 'Estonia', FIN: 'Finland', GRC: 'Greece', GRE: 'Greece', GUA: 'Guatemala', HKG: 'Hong Kong',
  HUN: 'Hungary', INA: 'Indonesia', IND: 'India', IRL: 'Ireland', ISL: 'Iceland', ISR: 'Israel',
  KOR: 'South Korea', KSA: 'Saudi Arabia', KUW: 'Kuwait', LAT: 'Latvia', LIE: 'Liechtenstein', LTU: 'Lithuania',
  LUX: 'Luxembourg', MAC: 'Macau', MAS: 'Malaysia', MLT: 'Malta', MON: 'Monaco', NOR: 'Norway',
  NZL: 'New Zealand', OMA: 'Oman', PER: 'Peru', PHI: 'Philippines', POL: 'Poland', POR: 'Portugal',
  ROU: 'Romania', RSA: 'South Africa', RUS: 'Russia', SGP: 'Singapore', SIN: 'Singapore', SLO: 'Slovenia',
  SMR: 'San Marino', SRB: 'Serbia', SUI: 'Switzerland', SVK: 'Slovakia', SWE: 'Sweden', THA: 'Thailand',
  TPE: 'Chinese Taipei', TUR: 'Turkey', UKR: 'Ukraine', URU: 'Uruguay', VEN: 'Venezuela', ZIM: 'Zimbabwe',
  ZWE: 'Zimbabwe',
  // ISO3 de las banderas de la 24H Series.
  ARM: 'Armenia', BGD: 'Bangladesh', CRI: 'Costa Rica', GRD: 'Grenada', JOR: 'Jordan', KGZ: 'Kyrgyzstan',
  KNA: 'St. Kitts & Nevis', KWT: 'Kuwait', LBN: 'Lebanon', LKA: 'Sri Lanka', LVA: 'Latvia', MNE: 'Montenegro',
  OMN: 'Oman', PAK: 'Pakistan', SLV: 'El Salvador', SVN: 'Slovenia', SYC: 'Seychelles', UZB: 'Uzbekistan',
  VUT: 'Vanuatu',
};

/** País en inglés a partir de un código de bandera ("ger", "den", "rsa"); el código si no se conoce. */
export function countryFromCode(code: string): string {
  const c = code.toUpperCase();
  const name = countryName(c);
  return name !== c ? name : (COUNTRY_CODES[c] ?? c);
}

const norm = (w: string) =>
  w
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * El sitio del WEC muestra a los pilotos como "Apellido Nombre" ("Félix da Costa António") pero la foto se
 * llama "2026-wec-35-antonio-felix-da-costa-right-….png": se ordenan las palabras como en el archivo. Si el
 * archivo no tiene exactamente las mismas palabras, el nombre queda como se publica (el índice de pilotos
 * une las variantes igual, porque la clave no depende del orden).
 */
export function orderNameBySlug(name: string, file: string): string {
  const words = name.replace(/\s+/g, ' ').trim().split(' ');
  const parts = words.map(norm);
  const flat = parts.flat();
  if (flat.length === 0) return name;
  const slug = norm(file.replace(/^.*\//, '').replace(/\.[a-z0-9]+$/i, ''));
  const target = [...flat].sort().join(' ');
  for (let i = 0; i + flat.length <= slug.length; i++) {
    const window = slug.slice(i, i + flat.length);
    if ([...window].sort().join(' ') !== target) continue;
    const used = new Set<number>();
    const placed: { word: string; at: number }[] = [];
    for (const [k, p] of parts.entries()) {
      const at = window.findIndex((_t, j) => !used.has(j) && p.every((x, n) => window[j + n] === x && !used.has(j + n)));
      if (at < 0) return name;
      p.forEach((_x, n) => used.add(at + n));
      placed.push({ word: words[k]!, at });
    }
    return placed
      .sort((a, b) => a.at - b.at)
      .map((x) => x.word)
      .join(' ');
  }
  return name;
}

// ─── ACO: WEC, ELMS y Asian LMS ───────────────────────────────────────────────────────────────

/** Auto de la grilla del WEC (/en/page/grid): tarjeta con clase, equipo, número y link a su ficha. */
export interface AcoGridCar {
  url: string;
  season: number;
  team?: string;
  number?: string;
  class?: string;
}

export function acoGridCars(html: string, pageUrl: string): AcoGridCar[] {
  const out: AcoGridCar[] = [];
  const seen = new Set<string>();
  const page = stripComments(html);
  const starts = [...page.matchAll(/<div\b[^>]*class="card-team\b[^"]*"[^>]*>/g)].map((m) => m.index!);
  starts.forEach((start, i) => {
    const block = page.slice(start, starts[i + 1] ?? start + 6000);
    const link = block.match(/<a\b[^>]*href="([^"]*\/car\/(\d{4})\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!link) return;
    const url = absoluteUrl(link[1]!, pageUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    const team = textOf(link[3]!);
    const number = (textOf(block.match(/>\s*(#\s*[0-9A-Za-z]+)\s*</)?.[1] ?? '').replace(/^#\s*/, '') || url.split('/').pop()) ?? '';
    const cls = textByClass(block, 'fs-11');
    out.push({ url, season: Number(link[2]), ...(team ? { team } : {}), ...(number ? { number } : {}), ...(cls ? { class: className(cls) } : {}) });
  });
  return out;
}

/** Pilotos y modelo de un auto en su ficha del WEC (/en/car/2026/35). */
export function acoCarPage(html: string): { drivers: string[]; vehicle?: string } {
  const page = stripComments(html);
  const drivers: string[] = [];
  for (const m of page.matchAll(/<a\b[^>]*class="card-driver"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const inner = m[1] ?? '';
    const raw = textOf(inner.match(/<div\b[^>]*class="py-4"[^>]*>([\s\S]*?)(?:<br|<\/div>)/i)?.[1] ?? '') || decodeEntities(attr(inner.match(/<img\b[^>]*>/i)?.[0] ?? '', 'alt') ?? '').trim();
    const file = attr(inner.match(/<img\b[^>]*>/i)?.[0] ?? '', 'src') ?? '';
    if (isRealDriver(raw)) drivers.push(orderNameBySlug(raw, file));
  }
  const model = page.match(/"@type"\s*:\s*"Vehicle"[\s\S]*?"model"\s*:\s*"([^"]+)"/)?.[1];
  return { drivers, ...(model ? { vehicle: decodeEntities(model).trim() } : {}) };
}

/**
 * Página de pilotos de ELMS / Asian LMS (/en/page/drivers): una tarjeta "card-driver" por piloto con
 * equipo y número ("PROTON COMPETITION #9"), nombre y bandera; la clase es el <h2> anterior (LMP2, LMGT3…).
 */
export function acoDriverCards(html: string): { rows: RosterRow[]; season?: number } {
  const page = stripComments(html);
  const headings = [...page.matchAll(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi)].map((m) => ({ at: m.index!, text: textOf(m[1] ?? '') }));
  const starts = [...page.matchAll(/<div\b[^>]*class="card-driver"[^>]*>/g)].map((m) => m.index!);
  const rows: RosterRow[] = [];
  const seasons: number[] = [];
  starts.forEach((start, i) => {
    const block = page.slice(start, starts[i + 1] ?? start + 6000);
    const driver = textByClass(block, 'driver-name');
    if (!isRealDriver(driver)) return;
    const year = block.match(/\/driver\/(\d{4})\//)?.[1];
    if (year) seasons.push(Number(year));
    const { team, number } = splitTeamNumber(textByClass(block, 'driver-team'));
    const heading = headings.filter((h) => h.at < start).at(-1)?.text;
    const country = textByClass(block, 'driver-country-name') || attr(block.match(/<img\b[^>]*class="driver-country-flag"[^>]*>/i)?.[0] ?? '', 'alt') || '';
    rows.push({
      driver,
      ...(team ? { team } : {}),
      ...(number ? { number } : {}),
      ...(heading ? { class: className(heading) } : {}),
      ...(country ? { country: countryName(country) } : {}),
    });
  });
  return { rows, ...(seasons.length ? { season: Math.max(...seasons) } : {}) };
}

/** Inscriptos del WEC (grilla + ficha de cada auto) o de ELMS / Asian LMS (página de pilotos). */
export async function acoRoster(url: string, ctx: RecipeContext): Promise<RosterFound | null> {
  const html = (await ctx.http.text(url)).body;
  const title = textOf(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') || 'Inscriptos';
  if (/\/page\/grid\b/.test(url)) {
    const cars = acoGridCars(html, url);
    if (cars.length === 0) throw new Error('ACO: la grilla no tiene autos');
    const season = Math.max(...cars.map((c) => c.season));
    if (!acceptable(season, ctx)) return null;
    const rows: RosterRow[] = [];
    let failed = 0;
    for (const car of cars.filter((c) => c.season === season)) {
      let page: { drivers: string[]; vehicle?: string };
      try {
        page = acoCarPage((await ctx.http.text(car.url)).body);
      } catch {
        failed++;
        continue;
      }
      for (const driver of page.drivers) {
        rows.push({
          driver,
          ...(car.team ? { team: car.team } : {}),
          ...(car.number ? { number: car.number } : {}),
          ...(page.vehicle ? { vehicle: page.vehicle } : {}),
          ...(car.class ? { class: car.class } : {}),
        });
      }
    }
    if (rows.length === 0) throw new Error(`ACO: ninguna ficha de auto con pilotos (${failed} sin leer)`);
    return { rows, season, source: rosterSource(url, title, 'html', ctx) };
  }
  const { rows, season } = acoDriverCards(html);
  if (rows.length === 0) throw new Error('ACO: la página de pilotos no tiene tarjetas de pilotos');
  if (season !== undefined && !acceptable(season, ctx)) return null;
  return { rows, ...(season !== undefined ? { season } : {}), source: rosterSource(url, title, 'html', ctx) };
}

// ─── SRO: listas de inscriptos por carrera ───────────────────────────────────────────────────

/**
 * Lista de inscriptos de una carrera de SRO (/entry-list/2026/crowdstrike-24-hours-of-spa): tabla con
 * "Car # | Team | Driver 1…4 | Car | Class" (el orden de las columnas cambia según el sitio). Cada piloto lleva
 * la bandera como código de 3 letras en la clase ("table__flag flag size--tiny ger").
 */
export function sroEntryListRows(html: string): RosterRow[] {
  const table = stripComments(html).match(/<table\b[\s\S]*?<\/table>/i)?.[0];
  if (!table) return [];
  const headers = [...table.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => textOf(m[1] ?? ''));
  const col = (re: RegExp) => headers.findIndex((h) => re.test(h));
  const cNum = col(/#|^no\.?$|number/i);
  const cTeam = col(/^team$/i);
  const cCar = col(/^(car|vehicle)$/i);
  const cClass = col(/^(class|cat|category)$/i);
  const cDrivers = headers.map((h, i) => (/^driver/i.test(h) ? i : -1)).filter((i) => i >= 0);
  if (cDrivers.length === 0) throw new Error(`SRO: la lista de inscriptos no tiene columnas de pilotos (${headers.join(', ')})`);
  const rows: RosterRow[] = [];
  const body = table.match(/<tbody\b[\s\S]*?<\/tbody>/i)?.[0] ?? table;
  for (const tr of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...(tr[1] ?? '').matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1] ?? '');
    if (cells.length < headers.length - 1) continue;
    const cell = (i: number) => (i >= 0 ? textOf(cells[i] ?? '') : '');
    const number = cell(cNum).replace(/^#\s*/, '');
    const team = cell(cTeam);
    const vehicle = cell(cCar);
    const cls = cell(cClass);
    for (const c of cDrivers) {
      const raw = cells[c] ?? '';
      const driver = textByClass(raw, 'table__text') || textOf(raw);
      if (!isRealDriver(driver)) continue;
      const code = raw.match(/class="[^"]*\btable__flag\b[^"]*\b([a-z]{3})"/i)?.[1];
      rows.push({
        driver,
        ...(team ? { team } : {}),
        ...(number ? { number } : {}),
        ...(vehicle ? { vehicle } : {}),
        ...(cls ? { class: className(cls) } : {}),
        ...(code ? { country: countryFromCode(code) } : {}),
      });
    }
  }
  return rows;
}

/**
 * Inscriptos de un campeonato de SRO a partir de su índice de listas (/entry-lists): se leen las listas de
 * todas las carreras de la temporada y se une cada piloto con su auto (un piloto que cambió de auto aparece
 * una vez por auto). Asia y Australia publican las listas solo en PDF: ahí no hay links y se devuelve null.
 */
export async function sroRoster(url: string, ctx: RecipeContext): Promise<RosterFound | null> {
  const index = /\/entry-lists\/?$/.test(new URL(url).pathname) ? url : `${new URL(url).origin}/entry-lists`;
  const html = stripComments((await ctx.http.text(index)).body);
  const links = [...html.matchAll(/href="([^"]*\/entry-list\/(\d{4})\/[^"]+)"/gi)].map((m) => ({ url: absoluteUrl(m[1]!, index)!, season: Number(m[2]) }));
  const valid = links.filter((l) => l.url && l.season <= ctx.season + 1);
  if (valid.length === 0) return null;
  const season = Math.max(...valid.map((l) => l.season));
  if (!acceptable(season, ctx)) return null;
  const pages = [...new Set(valid.filter((l) => l.season === season).map((l) => l.url))];
  const byCar = new Map<string, RosterRow>();
  let read = 0;
  for (const page of pages) {
    let rows: RosterRow[];
    try {
      rows = sroEntryListRows((await ctx.http.text(page)).body);
    } catch {
      continue;
    }
    read++;
    // La lista más reciente pisa los datos de la anterior (cambios de clase o de auto del mismo número).
    for (const r of rows) byCar.set(`${driverKey(r.driver)}|${r.number ?? ''}`, r);
  }
  if (read === 0) throw new Error(`SRO: no se pudo leer ninguna de las ${pages.length} listas de inscriptos`);
  const title = textOf(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') || 'Entry lists';
  return { rows: [...byCar.values()], season, source: rosterSource(index, `${title} ${season}`, 'html', ctx) };
}

// ─── DTM (API oficial) ────────────────────────────────────────────────────────────────────────

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/**
 * Pilotos del DTM (https://api.dtm.com/data?query=drivers): cada piloto trae sus temporadas con número,
 * equipo y auto. Se toma la temporada más reciente que no sea futura; los pilotos ocultos en la web
 * (webVisibility = false, p. ej. fichas de prueba) se omiten.
 */
export function dtmRosterRows(data: unknown, season: number): { rows: RosterRow[]; season: number } | null {
  const drivers = ((obj(data).drivers as unknown[] | undefined) ?? []).map(obj);
  const seasons = drivers.flatMap((d) => ((d.driverSeasons as unknown[] | undefined) ?? []).map((s) => Number(obj(s).season)));
  const latest = Math.max(...seasons.filter((s) => Number.isFinite(s) && s <= season + 1), -Infinity);
  if (!Number.isFinite(latest)) return null;
  const rows: RosterRow[] = [];
  for (const d of drivers) {
    if (d.webVisibility === false) continue;
    const s = ((d.driverSeasons as unknown[] | undefined) ?? []).map(obj).find((x) => Number(x.season) === latest && (!x.raceSeries || /^dtm$/i.test(str(x.raceSeries))));
    if (!s) continue;
    const driver = `${str(d.firstName)} ${str(d.lastName)}`.trim();
    if (!isRealDriver(driver)) continue;
    const number = str(s.driverNumber);
    const team = str(obj(s.team).name).trim();
    const vehicle = str(obj(s.car).name).trim();
    const country = str(obj(d.country).name) || str(obj(d.country).countryCode);
    rows.push({
      driver,
      ...(team ? { team } : {}),
      ...(number ? { number } : {}),
      ...(vehicle ? { vehicle } : {}),
      ...(country ? { country: countryName(country) } : {}),
    });
  }
  return { rows, season: latest };
}

export async function dtmRoster(url: string, ctx: RecipeContext): Promise<RosterFound | null> {
  const target = /api\.dtm\.com/.test(url) ? url : 'https://api.dtm.com/data?query=drivers';
  const res = await ctx.http.json<unknown>(target);
  const found = dtmRosterRows(res.body, ctx.season);
  if (!found || !acceptable(found.season, ctx)) return null;
  if (found.rows.length === 0) throw new Error('DTM: la API no devolvió pilotos');
  return { rows: found.rows, season: found.season, source: rosterSource('https://www.dtm.com/en/drivers', `Pilotos DTM ${found.season}`, 'api', ctx) };
}
