/**
 * Lectores deterministas (sin IA) para calendarios oficiales con estructura conocida.
 * Cada receta solo interpreta el HTML/JSON que publica el sitio oficial; lo que no resuelve
 * (cronogramas en PDF, páginas sin estructura) queda para el flujo genérico con Gemini.
 */
import { localToUtc, toUtcIso, type Source, type StandingsRow, type StandingsTable } from '@dm/shared';
import type { FetchedDocument } from '../extract/document.ts';
import {
  absoluteUrl,
  attr,
  blocksByClass,
  extractEmbeddedJson,
  parseJsonLd,
  textByClass,
  textOf,
} from '../extract/html.ts';
import { jsonLdSessions } from './locate.ts';
import { f1AcademyUtc, f1AcademyWeekendSessions, PLANNED_SESSIONS } from './f1academy.ts';
import {
  countryName,
  dateInZone,
  isoDate,
  monthNumber,
  parseDateRangeText,
  shiftDate,
} from './places.ts';
import {
  checkStandingsTable,
  column,
  dedupe,
  findArray,
  findObject,
  firstTable,
  host,
  isoNow,
  obj,
  pageOrNull,
  parseHtmlTable,
  parseNumber,
  roundOf,
  standingsSource,
  str,
  stripComments,
  tzFor,
} from './kit.ts';
import { acoStandings } from './aco-standings.ts';
import { acoRoster, countryFromCode, dtmRoster, sroRoster } from './rosters.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, SiteRecipe, StandingsFound } from './types.ts';
import { apatSessions } from './apat.ts';
import { aptpSessions, aptpTimetableImages } from './aptp.ts';
import { creventic } from './creventic.ts';
import { imsa } from './imsa.ts';
import { macau } from './macau.ts';
import { supercars } from './supercars.ts';
import { superformula } from './superformula.ts';
import { supergt } from './supergt.ts';
import { supertaikyu } from './supertaikyu.ts';
import { tc2000TimetableImages } from './tc2000.ts';

export { checkStandingsTable, findArray, findObject, parseHtmlTable, parseNumber } from './kit.ts';

// ─── SRO Motorsports Group (GT World Challenge, IGTC, calendario general de SRO) ───────────────

const sro: SiteRecipe = {
  name: 'sro',
  match: (url) => /(gt-world-challenge-[a-z]+\.com|intercontinentalgtchallenge\.com|sro-motorsports\.com)$/.test(host(url)),
  calendar(doc, ctx) {
    const html = stripComments(doc.raw);
    const out: CalendarEntry[] = [];
    for (const b of blocksByClass(html, 'calendar__list-item')) {
      const part = (cls: string) => {
        const block = b.match(new RegExp(`class="${cls}"[\\s\\S]*?</div>`))?.[0] ?? '';
        return {
          d: textByClass(block, 'calendar__date-number'),
          m: textByClass(block, 'calendar__date-month'),
          y: textByClass(block, 'calendar__date-year'),
        };
      };
      const s = part('calendar__date-start');
      const e = part('calendar__date-end');
      const name = textByClass(b, 'calendar__race-header');
      if (!s.d || !name) continue;
      const start = isoDate(Number(s.y) || ctx.season, monthNumber(s.m) ?? 0, Number(s.d));
      const end = e.d ? isoDate(Number(e.y) || Number(s.y) || ctx.season, monthNumber(e.m) ?? 0, Number(e.d)) : start;
      if (!start || !end) continue;
      const country = textByClass(b, 'calendar__race-subheading-text');
      const texts = [...b.matchAll(/class="calendar__race-text"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => textOf(m[1] ?? '')).filter(Boolean);
      const roundText = texts.find((t) => /round/i.test(t)) ?? '';
      const championship = texts.find((t) => !/round/i.test(t));
      const href = [...b.matchAll(/href="([^"]*\/event\/\d+[^"]*)"/g)][0]?.[1];
      const url = href ? (absoluteUrl(href, doc.url) ?? undefined) : undefined;
      out.push({
        name,
        circuit: name,
        country: countryName(country),
        tz: tzFor(country, name),
        dateStart: start,
        dateEnd: end < start ? start : end,
        round: roundOf(roundText),
        url,
        ...(championship ? { championship, ...(url ? { championshipUrl: `${new URL(url).origin}/calendar` } : {}) } : {}),
      });
    }
    // Eventos pasados (sin año en el texto): nunca son de una temporada futura (lectura de la temporada siguiente).
    const pastBlocks = ctx.season > ctx.now.getUTCFullYear() ? [] : blocksByClass(html, 'past-events__list-item');
    for (const b of pastBlocks) {
      const spans = [...b.matchAll(/class="past-events__piped-list-span"[^>]*>([\s\S]*?)<\/span>\s*<\/li>/g)].map((m) => m[1] ?? '');
      if (spans.length < 2) continue;
      const dates = parseDateRangeText(textOf(spans[0]!), ctx.season);
      const venue = textOf(spans[1]!.match(/<strong>([\s\S]*?)<\/strong>/)?.[1] ?? '');
      const country = textOf(spans[1]!.replace(/<strong>[\s\S]*?<\/strong>/, ''));
      const href = b.match(/href="([^"]*\/event\/\d+[^"]*)"/)?.[1];
      if (!dates || !venue) continue;
      out.push({
        name: venue,
        circuit: venue,
        country: countryName(country),
        tz: tzFor(country, venue),
        dateStart: dates.start,
        dateEnd: dates.end,
        round: roundOf(textOf(spans[2] ?? '')),
        url: href ? (absoluteUrl(href, doc.url) ?? undefined) : undefined,
      });
    }
    return dedupe(out).sort((a, b) => a.dateStart.localeCompare(b.dateStart));
  },
  standings: (url, ctx) => sroStandings(url, ctx),
  roster: (url, ctx) => sroRoster(url, ctx),
};

interface SelectOption {
  value: string;
  label: string;
  selected: boolean;
}

/** Opciones del <select name="…"> más completo de la página (algunas páginas lo repiten para celulares). */
export function selectOptions(html: string, name: string): SelectOption[] {
  let best: SelectOption[] = [];
  for (const m of html.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    if (attr(m[1] ?? '', 'name') !== name) continue;
    const opts = [...(m[2] ?? '').matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((o) => ({
      value: attr(o[1] ?? '', 'value') ?? '',
      label: textOf(o[2] ?? ''),
      selected: /\bselected\b/i.test(o[1] ?? ''),
    }));
    if (opts.length > best.length) best = opts;
  }
  return best;
}

/** Subcopas de SRO (por categoría de piloto o premios aparte): sus pilotos ya están en la tabla general. */
const SRO_SUBCUP = /\b(gold|silver|bronze|pro-?am|silver-?am|am|pro|trophy|academy|independent|china cup|rookie)\b/i;
const SRO_PREFIX = /^.*?powered by aws\s*|^(gt world challenge (europe|asia|america|australia)|intercontinental gt challenge)\s*/i;

/**
 * Título de una tabla de SRO a partir de la opción del selector:
 * "GT World Challenge Europe powered by AWS Endurance Cup Overall Driver" -> "Pilotos Endurance Cup",
 * "GT World Challenge America powered by AWS Pro-Am Teams" -> "Equipos Pro-Am", "GT3 Manufacturers" -> "Marcas".
 */
export function sroTableTitle(label: string, value: string): string {
  const kind = /manufacturer/i.test(label)
    ? 'Marcas'
    : /_teams$/i.test(value) || (!/_drivers$/i.test(value) && /\bteams?\b/i.test(label))
      ? 'Equipos'
      : 'Pilotos';
  const qualifier = label
    .replace(SRO_PREFIX, '')
    .replace(/\b(gt3|overall|championship|drivers?|teams?|manufacturers?)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return qualifier ? `${kind} ${qualifier}` : kind;
}

/**
 * Tablas que se leen: las generales de cada campeonato (en Europa: general, Endurance Cup y Sprint Cup) y no
 * las subcopas Gold/Silver/Bronze/Pro-Am, que repiten pilotos. Si el sitio no publica una tabla general de
 * pilotos (América y Australia solo tienen tablas por clase), se leen todas las clases: no se superponen.
 */
export function sroChosenTypes(types: SelectOption[]): SelectOption[] {
  const usable = types.filter((o) => o.value && o.value !== '0' && !/pit stop/i.test(o.label));
  const main = usable.filter((o) => !SRO_SUBCUP.test(o.label.replace(SRO_PREFIX, '')));
  return main.some((o) => sroTableTitle(o.label, o.value).startsWith('Pilotos')) ? main : usable;
}

/** Filas de una tabla HTML con cada celda repetida según su colspan (para alinear encabezados y datos). */
function expandedRows(tableHtml: string): string[][] {
  return [...tableHtml.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((tr) =>
    [...(tr[1] ?? '').matchAll(/<t([hd])\b([^>]*)>([\s\S]*?)<\/t\1>/gi)].flatMap((c) =>
      Array<string>(Math.max(1, Number(attr(c[2] ?? '', 'colspan')) || 1)).fill(c[3] ?? ''),
    ),
  );
}

/**
 * Tabla del campeonato de SRO. La fila de títulos ("Pos | Driver | Total", a veces dentro del <tbody>) es la
 * que tiene la columna Total; las filas siguientes con posición numérica son los pilotos o equipos.
 * La columna "Manufacturer" de las tablas de pilotos del IGTC es la marca, no el equipo: no se guarda.
 * null si la tabla todavía no tiene filas.
 */
export function sroStandingsTable(html: string, title: string): StandingsTable | null {
  const table = firstTable(html);
  if (!table) throw new Error(`SRO: "${title}" sin tabla`);
  const rows = expandedRows(table).map((r) => r.map((c) => textOf(c)));
  const headerAt = rows.findIndex((r) => r.some((c) => /^total$/i.test(c)));
  if (headerAt < 0) throw new Error(`SRO: "${title}" sin columna Total`);
  const headers = rows[headerAt]!;
  const cPos = column(headers, /^pos/i);
  const cName = column(headers, /^(driver|team|manufacturer|brand|name)s?$/i);
  const cTotal = column(headers, /^total$/i);
  if (cPos < 0 || cName < 0) throw new Error(`SRO: "${title}" sin las columnas esperadas (${headers.join(', ')})`);
  const out: StandingsRow[] = [];
  for (const r of rows.slice(headerAt + 1)) {
    const pos = r[cPos] ?? '';
    if (!/^\d+$/.test(pos)) continue;
    out.push({ pos: Number(pos), name: r[cName] ?? '', points: parseNumber(r[cTotal] ?? '') ?? NaN });
  }
  return out.length ? checkStandingsTable({ title, rows: out }, true) : null;
}

/**
 * Campeonato de los sitios de SRO (https://www.gt-world-challenge-europe.com/standings y equivalentes): la
 * página tiene un selector de temporada (filter_season_id, con ids propios: 26 = 2026 en Europa, 10 en Asia)
 * y otro del tipo de tabla (filter_standing_type = "42_0_drivers"…, o filter_igtcstandingtype_id en el IGTC).
 * Si la temporada pedida no está en el selector, o el sitio responde con otra (lo hace cuando la tabla todavía
 * no existe), la temporada no está publicada.
 */
async function sroStandings(url: string, ctx: RecipeContext): Promise<StandingsFound | null> {
  const base = `${new URL(url).origin}/standings`;
  const first = stripComments((await ctx.http.text(base)).body);
  const season = selectOptions(first, 'filter_season_id').find((o) => o.label === String(ctx.season));
  if (!season) return null;
  const typeName = first.match(/<select\b[^>]*name="(filter_[a-z]*standing[a-z_]*)"/i)?.[1];
  if (!typeName) throw new Error('SRO: la página de posiciones no tiene el selector de tablas');
  const types = sroChosenTypes(selectOptions(first, typeName));
  if (types.length === 0) throw new Error('SRO: el selector de tablas está vacío');
  const tables: StandingsTable[] = [];
  for (const type of types) {
    const pageUrl = `${base}?filter_season_id=${encodeURIComponent(season.value)}&${typeName}=${encodeURIComponent(type.value)}`;
    const html = stripComments((await ctx.http.text(pageUrl)).body);
    const shown = selectOptions(html, 'filter_season_id').find((o) => o.selected);
    if (shown && shown.value !== season.value) return null;
    const table = sroStandingsTable(html, sroTableTitle(type.label, type.value));
    if (table) tables.push(table);
  }
  if (tables.length === 0) return null;
  const title = textOf(first.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') || 'Standings';
  return { tables, source: standingsSource(base, `${title} ${ctx.season}`, ctx) };
}

// ─── IndyCar / Indy NXT ───────────────────────────────────────────────────────────────────────

const indycar: SiteRecipe = {
  name: 'indycar',
  match: (url) => /^(indycar\.com|indynxt\.com)$/.test(host(url)),
  calendarUrl: (url, season) => {
    const u = new URL(url);
    if (!u.searchParams.has('year')) u.searchParams.set('year', String(season));
    return u.toString();
  },
  calendar(doc, ctx) {
    const out: CalendarEntry[] = [];
    for (const b of blocksByClass(stripComments(doc.raw), 'event-card')) {
      const href = b.match(/<a\b[^>]*href="([^"]+)"[^>]*class="event-card-link"/)?.[1] ?? b.match(/class="event-card-link"[^>]*href="([^"]+)"/)?.[1];
      if (!href || !new RegExp(`/schedule/${ctx.season}/`, 'i').test(href)) continue;
      const day = parseDateRangeText(textByClass(b, 'event-card-header-date'), ctx.season);
      if (!day) continue;
      const title = textByClass(b, 'event-card-title');
      const track = textByClass(b, 'event-card-track-name') || title;
      const location = textByClass(b, 'event-card-track-location');
      const url = absoluteUrl(href, doc.url) ?? undefined;
      // Fechas dobles (Indy NXT): una tarjeta por carrera; se agrupan en un solo evento.
      const prev = out.find((e) => e.circuit === track && Math.abs(Date.parse(e.dateEnd) - Date.parse(day.start)) <= 2 * 86_400_000);
      if (prev) {
        if (day.start > prev.dateEnd) prev.dateEnd = day.start;
        continue;
      }
      out.push({
        name: title || track,
        circuit: track,
        country: 'United States',
        tz: tzFor(/canada|ontario|toronto/i.test(location) ? 'Canada' : 'United States', `${location} ${track}`),
        dateStart: shiftDate(day.start, -2),
        dateEnd: day.start,
        url,
        // Desde 2027 la clave es el slug de la URL (/Schedule/2027/St-Petersburg): las fechas futuras figuran primero
        // con el nombre del circuito y después con el nombre comercial, y el id no tiene que cambiar por eso. (2026
        // sigue con el nombre para no cambiar los ids ya publicados, con sus resultados.)
        ...(ctx.season >= 2027 ? { key: href.split('/').filter(Boolean).pop()!.toLowerCase() } : {}),
      });
    }
    return dedupe(out);
  },
};

// ─── FIA WEC / ELMS / Asian Le Mans Series (misma plataforma del ACO) ─────────────────────────

/** Carrera listada en la página /season/{año} del ACO, con lo que esa página dice de ella. */
export interface AcoRace {
  url: string;
  name?: string;
  flag?: string;
  venue?: string;
  /** Día de la carrera (YYYY-MM-DD), si la página lo muestra (tira de fechas o tarjeta); a veces solo figura el mes. */
  raceDay?: string;
}

const ACO_TEST = /prologue|test/i;

/**
 * La Asian Le Mans Series corre en invierno: la temporada "2026 - 2027" (página /season/2026) va de noviembre a
 * febrero. El slug de cada carrera lleva el año en que se corre (…-le-castellet-by-alms-2026, …-jerez-by-alms-2027)
 * o a veces el de inicio de la temporada (…-dubai-2024 se corrió en febrero de 2025): el slug no dice a qué
 * temporada pertenece una carrera, manda la grilla de la página de la temporada.
 */
const isAcoWinter = (url: string) => host(url) === 'asianlemansseries.com';

/**
 * Temporada vigente según el propio sitio: todas las páginas de la ALMS muestran en el encabezado el botón activo
 * "Season 2026 - 2027" (cambia cuando el sitio pasa a la temporada siguiente). null si no figura.
 */
export function acoCurrentSeason(html: string): number | null {
  const m =
    html.match(/class="season-selector[^"]*\bactive\b[^"]*"[^>]*>\s*Season\s+(\d{4})\s*-\s*\d{4}/i) ??
    html.match(/>\s*Season\s+(\d{4})\s*-\s*\d{4}\s*</i);
  return m ? Number(m[1]) : null;
}

/** "4 Hours of Le Castellet by ALMS" -> "4 Hours of Le Castellet" (la firma repite el nombre de la serie). */
const acoEventName = (name: string) => name.replace(/\s+by\s+(ALMS|ELMS|WEC)$/i, '').trim();

/**
 * Carreras de la temporada en la página /season/{año} de fiawec.com / europeanlemansseries.com. Según el momento
 * del año la página muestra una tira con el día de cada carrera, tarjetas con "5 July" (ELMS) o solo una lista
 * por mes (div.race-item: bandera, nombre y mes, sin día; así está WEC al terminar la temporada).
 *
 * Temporada de invierno (ALMS): la tira del encabezado muestra siempre la temporada vigente (también en las páginas
 * de temporadas anteriores), así que solo cuentan las tarjetas de la grilla "Rounds", con cualquier año en el slug;
 * el día de la tarjeta ("17 January") es del año siguiente si cae en el primer semestre.
 */
export function acoSeasonRaces(doc: FetchedDocument, season: number, opts: { winter?: boolean } = {}): AcoRace[] {
  const winter = !!opts.winter;
  const html = stripComments(doc.raw);
  const byUrl = new Map<string, AcoRace>();
  const add = (href: string, info: Omit<AcoRace, 'url'>) => {
    const url = absoluteUrl(href.trim(), doc.url);
    if (!url) return;
    const race = byUrl.get(url) ?? { url };
    for (const [k, v] of Object.entries(info) as [keyof Omit<AcoRace, 'url'>, string | undefined][]) {
      if (v && !race[k]) race[k] = v;
    }
    byUrl.set(url, race);
  };
  const year = winter ? '\\d{4}' : String(season);
  const raceHref = new RegExp(`href="(/en/race/[^"]*-${year})\\s*"`);

  // Lista por mes: cada div.race-item trae su propia bandera y nombre.
  for (const b of winter ? [] : blocksByClass(html, 'race-item', 2500)) {
    const href = b.match(raceHref)?.[1];
    if (!href) continue;
    add(href, { name: textByClass(b, 'name') || undefined, flag: b.match(/flag:([A-Z]{2})/)?.[1] });
  }

  // Tira de fechas (<strong>11</strong><small>Apr</small>) y tarjetas ("5 July" debajo del link).
  const re = new RegExp(`<a\\b[^>]*href="(/en/race/[^"]*-${year})\\s*"[^>]*>([\\s\\S]*?)</a>`, 'g');
  for (const m of html.matchAll(re)) {
    const inner = m[2] ?? '';
    const after = html.slice(m.index! + m[0].length, m.index! + m[0].length + 1500);
    const strip = inner.match(/<strong[^>]*>\s*(\d{1,2})\s*<\/strong>\s*<small[^>]*>\s*([A-Za-z]+)\s*<\/small>/);
    const card = /^\s*<div class="thumb/.test(inner)
      ? after.match(/class="text-primary text-uppercase[^"]*"[^>]*>\s*(\d{1,2}\s+[A-Za-z]+)\s*</)
      : null;
    if (winter && !card) continue;
    const dayText = strip ? `${strip[1]} ${strip[2]}` : card?.[1];
    let raceDay = dayText ? parseDateRangeText(dayText, season)?.start : undefined;
    if (winter && raceDay && Number(raceDay.slice(5, 7)) < 7) raceDay = `${season + 1}${raceDay.slice(4)}`;
    const alt = attr(inner.match(/<img\b[^>]*>/)?.[0] ?? '', 'alt');
    add(m[1]!, {
      name: alt ? textOf(alt) : undefined,
      flag: (strip || card ? inner + after.slice(0, 600) : inner).match(/flag:([A-Z]{2})/)?.[1],
      venue: card ? textOf(after.match(/class="fs-7 fw-bold[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '') || undefined : undefined,
      raceDay,
    });
  }
  return [...byUrl.values()];
}

/**
 * Fechas exactas de una carrera desde el JSON-LD (SportsEvent) de su página: startDate/endDate. El sitio escribe
 * la hora local del circuito (con el offset de París), así que la fecha local es la parte YYYY-MM-DD tal cual.
 */
export function acoRaceDates(html: string): { start: string; end: string; name: string; place: string; city: string; country: string } | null {
  for (const o of parseJsonLd(html)) {
    if (!/Event$/.test(str(o['@type'])) || !/^\d{4}-\d{2}-\d{2}/.test(str(o.startDate))) continue;
    const start = str(o.startDate).slice(0, 10);
    const endRaw = str(o.endDate).slice(0, 10);
    const end = /^\d{4}-\d{2}-\d{2}$/.test(endRaw) && endRaw >= start ? endRaw : start;
    const loc = obj(o.location);
    const address = str(loc.address).split(',').map((p) => p.trim());
    return {
      start,
      end,
      // "WEC 6 Hours of Monza 2026" -> "6 Hours of Monza"; "ALMS 4 Hours of Jerez by ALMS 2026" -> "4 Hours of Jerez"
      name: acoEventName(str(o.name).replace(/^(WEC|ELMS|AsLMS|ALMS)\s+/i, '').replace(/\s+\d{4}$/, '')),
      place: str(loc.name),
      city: address.length > 1 ? address[0]! : '',
      country: address.at(-1) ?? '',
    };
  }
  return null;
}

const aco: SiteRecipe = {
  name: 'aco',
  match: (url) => /^(fiawec\.com|europeanlemansseries\.com|asianlemansseries\.com)$/.test(host(url)),
  calendarUrl: (url, season) => {
    const u = new URL(url);
    return /\/season\/\d{4}/.test(u.pathname) ? url.replace(/\/season\/\d{4}/, `/season/${season}`) : `${u.origin}/en/season/${season}`;
  },
  /**
   * ALMS: la temporada vigente es la que indica el sitio ("Season 2026 - 2027" = 2026), no el año en curso. Así, en
   * enero de 2027 se sigue leyendo /season/2026 (Jerez y Portimão) y los eventos conservan su id. Si el encabezado no
   * aparece: de julio en adelante, la que empieza este año; antes, la que empezó el anterior.
   */
  async season(ctx) {
    const year = ctx.now.getUTCFullYear();
    const url = ctx.series.officialUrls[0] ?? '';
    if (!isAcoWinter(url)) return ctx.season;
    const page = await pageOrNull(ctx, url).catch(() => null);
    return (page ? acoCurrentSeason(page) : null) ?? (ctx.now.getUTCMonth() >= 6 ? year : year - 1);
  },
  /**
   * La página de la temporada lista las carreras; las fechas exactas salen del JSON-LD de la página de cada
   * carrera. Si esa página no se puede leer se usa el día de carrera de la temporada (viernes a domingo); si la
   * temporada solo muestra el mes, la carrera se omite (nunca se publica un mes entero como fechas del evento).
   */
  async calendar(doc, ctx) {
    const out: CalendarEntry[] = [];
    const winter = isAcoWinter(doc.url);
    // Temporada de invierno: de julio del año de inicio a junio del siguiente.
    const inSeason = (date: string) =>
      winter ? date >= `${ctx.season}-07-01` && date < `${ctx.season + 1}-07-01` : date.startsWith(String(ctx.season));
    for (const race of acoSeasonRaces(doc, ctx.season, { winter })) {
      const page = await pageOrNull(ctx, race.url).catch(() => null);
      const ld = page ? acoRaceDates(page) : null;
      const name = acoEventName(race.name || ld?.name || humanize(race.url.split('/').pop()!.replace(/-\d{4}$/, '')));
      const circuit = race.venue || ld?.place || name;
      const country = race.flag || ld?.country || '';
      const tz = tzFor(country, `${circuit} ${ld?.city ?? ''} ${name}`);
      let dates: { start: string; end: string } | null = null;
      if (ld) dates = { start: ld.start, end: ld.end };
      else if (race.raceDay) dates = { start: shiftDate(race.raceDay, ACO_TEST.test(name) ? -1 : -2), end: race.raceDay };
      if (!dates || !inSeason(dates.start)) continue;
      out.push({ name, circuit, country: countryName(country), tz, dateStart: dates.start, dateEnd: dates.end, url: race.url });
    }
    out.sort((a, b) => a.dateStart.localeCompare(b.dateStart));
    // Ronda = orden en el calendario, sin contar prólogo ni ensayos oficiales (el sitio no publica el número).
    let round = 0;
    for (const e of out) if (!ACO_TEST.test(e.name)) e.round = ++round;
    return out;
  },
  /**
   * Cronograma: subEvent del JSON-LD de la página de la carrera. Las horas son locales del circuito aunque el
   * offset diga París, y las que todavía no se publicaron figuran como 00:00 (se omiten). Si la página trae el
   * evento en JSON-LD pero ninguna hora publicada, devuelve una lista vacía (no se busca el cronograma por otro
   * lado, donde esas horas de relleno se leerían como reales); null solo si la página no trae JSON-LD.
   */
  async sessions(entry, ctx) {
    if (!entry.url) return null;
    const html = await pageOrNull(ctx, entry.url);
    if (!html || !acoRaceDates(html)) return null;
    const page: FetchedDocument = { url: entry.url, kind: 'html', raw: html, text: '', title: '', hash: '' };
    const { sessions } = jsonLdSessions(page, { wallClockZone: entry.tz });
    const title = textOf(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
    return {
      sessions,
      source: { url: entry.url, title: title || `Programa — ${entry.name}`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) },
    };
  },
  /** Campeonato: página de clasificaciones de cada sitio (ver aco-standings.ts). */
  standings: (url, ctx) => acoStandings(url, ctx),
  /** Inscriptos: grilla de autos del WEC (/en/page/grid) o página de pilotos de ELMS y Asian LMS (/en/page/drivers). */
  roster: (url, ctx) => acoRoster(url, ctx),
};

// ─── Nürburgring Langstrecken-Serie ───────────────────────────────────────────────────────────

const nls: SiteRecipe = {
  name: 'nls',
  match: (url) => host(url) === 'nuerburgring-langstrecken-serie.de',
  calendar(doc, ctx) {
    const out: CalendarEntry[] = [];
    for (const row of stripComments(doc.raw).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)(?=<td\b|$)/g)].map((c) => c[1] ?? '');
      if (cells.length < 2) continue;
      const dates = parseDateRangeText(textOf(cells[0]!), ctx.season);
      const name = textOf(cells[1]!);
      if (!dates || !name || !dates.start.startsWith(String(ctx.season))) continue;
      const href = [...cells[1]!.matchAll(/href="([^"]+)"/g)].map((h) => h[1]!).find((h) => /nuerburgring-langstrecken-serie\.de|^\//.test(h));
      out.push({
        name,
        circuit: 'Nürburgring Nordschleife',
        country: 'Germany',
        tz: 'Europe/Berlin',
        dateStart: dates.start,
        dateEnd: dates.end,
        round: roundOf(name),
        url: href ? (absoluteUrl(href, doc.url) ?? undefined) : undefined,
      });
    }
    return dedupe(out);
  },
};

// ─── APAT (Turismo Nacional) ──────────────────────────────────────────────────────────────────

const apat: SiteRecipe = {
  name: 'apat',
  match: (url) => host(url) === 'apat.org.ar',
  calendarUrl: (url) => {
    const u = new URL(url);
    return u.pathname === '/' ? `${u.origin}/carreras` : url;
  },
  calendar(doc, ctx) {
    const out: CalendarEntry[] = [];
    for (const b of blocksByClass(stripComments(doc.raw), 'card-tn')) {
      const link = b.match(/<a\b[^>]*href="([^"]*\/carreras\/info\/(\d{4}-\d{2}-\d{2}))"[^>]*>([\s\S]*?)<\/a>/);
      if (!link || !link[2]!.startsWith(String(ctx.season))) continue;
      const race = link[2]!;
      const circuit = textOf(link[3] ?? '');
      const location = textOf(b.slice(link.index! + link[0].length).match(/<small[^>]*>([\s\S]*?)<\/small>/)?.[1] ?? '');
      out.push({
        name: location ? `${circuit} (${location})` : circuit,
        circuit,
        country: 'Argentina',
        tz: 'America/Argentina/Buenos_Aires',
        dateStart: shiftDate(race, -2),
        dateEnd: race,
        url: absoluteUrl(link[1]!, doc.url) ?? undefined,
      });
    }
    // El sitio no numera las fechas: el número (para reconocer la nota "Cronograma de actividades: undécima
    // fecha") es el orden en el calendario.
    return dedupe(out)
      .sort((a, b) => a.dateStart.localeCompare(b.dateStart))
      .map((e, i) => ({ ...e, meta: { fecha: String(i + 1) } }));
  },
  /** Cronograma: página de la fecha o nota de prensa con el PDF (apat.ts). Si no está en ninguna, no se publicó todavía. */
  sessions: apatSessions,
  timetableFallback: 'none',
  /**
   * Campeonato de cada clase (https://apat.org.ar/campeonato/ranking/c2, …/c3): tabla HTML con
   * Pos | Nro | Piloto | Equipo | Marca | Puntos. Las clases se toman de los links de la propia página.
   * (/campeonato/posiciones/cN es otro "ranking", con otro orden: no sirve como tabla del campeonato.)
   */
  async standings(url, ctx) {
    const origin = new URL(url).origin;
    const own = url.match(/\/campeonato\/(?:ranking|posiciones)\/(c\d+)/i)?.[1]?.toLowerCase() ?? 'c2';
    const rankingUrl = (cls: string) => `${origin}/campeonato/ranking/${cls}`;
    const first = (await ctx.http.text(rankingUrl(own))).body;
    const linked = [...first.matchAll(/\/campeonato\/ranking\/(c\d+)/gi)].map((m) => m[1]!.toLowerCase());
    const classes = [...new Set([own, ...linked])].sort();
    const tables: StandingsTable[] = [];
    for (const cls of classes) {
      const html = cls === own ? first : (await ctx.http.text(rankingUrl(cls))).body;
      const { headers, rows } = parseHtmlTable(firstTable(html));
      const [cPos, cNum, cName, cTeam, cPts] = [/^pos/i, /^(nro|n°|num)/i, /^piloto/i, /^equipo/i, /^puntos/i].map((re) =>
        column(headers, re),
      );
      if (cPos! < 0 || cName! < 0 || cPts! < 0) {
        throw new Error(`APAT ${cls}: la tabla no tiene las columnas esperadas (${headers.join(', ')})`);
      }
      const parsed: StandingsRow[] = rows.map((cells) => {
        const nameCell = cells[cName!] ?? '';
        // La celda del piloto repite el equipo en un bloque solo visible en celulares.
        const name = textOf(nameCell.match(/<strong\b[^>]*>([\s\S]*?)<\/strong>/i)?.[1] ?? nameCell);
        const team = cTeam! >= 0 ? textOf(cells[cTeam!] ?? '') : '';
        const number = cNum! >= 0 ? textOf(cells[cNum!] ?? '') : '';
        return {
          pos: parseNumber(textOf(cells[cPos!] ?? '')) ?? 0,
          name,
          ...(number ? { number } : {}),
          ...(team ? { team } : {}),
          points: parseNumber(textOf(cells[cPts!] ?? '')) ?? NaN,
        };
      });
      tables.push(checkStandingsTable({ title: `Clase ${cls.slice(1)}`, rows: parsed }));
    }
    return { tables, source: standingsSource(rankingUrl(own), `Campeonato Turismo Nacional ${ctx.season}`, ctx) };
  },
};

// ─── TC2000 ───────────────────────────────────────────────────────────────────────────────────

const tc2000: SiteRecipe = {
  name: 'tc2000',
  match: (url) => host(url) === 'tc2000.com.ar',
  calendarUrl: (url) => {
    const u = new URL(url);
    return u.pathname === '/' ? `${u.origin}/carreras.php?evento=calendario` : url;
  },
  calendar(doc, ctx) {
    // Las fechas no traen año ("12 - 14"): la página no dice de qué temporada es, así que no se usa para la
    // temporada siguiente (se leería el calendario terminado con el año cambiado).
    if (ctx.season > ctx.now.getUTCFullYear()) return [];
    const out: CalendarEntry[] = [];
    for (const b of blocksByClass(stripComments(doc.raw), 'box-fechas', 1500)) {
      const round = Number(textByClass(b, 'item-fechas'));
      const dm = textByClass(b, 'gris').match(/(\d{1,2})\s*-\s*(\d{1,2})/);
      const circuit = textOf(b.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? '');
      const href = b.match(/href="([^"]*accion=historial[^"]*)"/)?.[1];
      if (!dm || !circuit) continue;
      const race = isoDate(ctx.season, Number(dm[2]), Number(dm[1]));
      if (!race) continue;
      const id = href?.match(/id=(\d+)/)?.[1];
      out.push({
        name: `Fecha ${round || ''} ${circuit}`.replace(/\s+/g, ' ').trim(),
        circuit,
        country: 'Argentina',
        tz: 'America/Argentina/Buenos_Aires',
        dateStart: shiftDate(race, -2),
        dateEnd: race,
        ...(round ? { round } : {}),
        url: href ? (absoluteUrl(href, doc.url) ?? undefined) : undefined,
        ...(id ? { meta: { id } } : {}),
      });
    }
    return dedupe(out);
  },
  /** Cronograma: imagen de la página de cronograma de cada fecha, transcripta por la IA (tc2000.ts). */
  timetableImages: tc2000TimetableImages,
  timetableFallback: 'none',
  /**
   * Posiciones (https://tc2000.com.ar/estadisticas.php?accion=posiciones): pestañas PILOTOS / EQUIPOS / MARCAS;
   * cada fila es un <ul class="puntajes"> con posición, nombre y total.
   */
  async standings(url, ctx) {
    const target = /accion=posiciones/.test(url) ? url : 'https://tc2000.com.ar/estadisticas.php?accion=posiciones';
    const html = stripComments((await ctx.http.text(target)).body);
    const year = Number(html.match(/POSICIONES\s*(\d{4})/i)?.[1] ?? 0);
    if (year && year !== ctx.season) return null;
    const tabs = [...html.matchAll(/<a\b[^>]*href="[^"#]*#(tabs-\d+)"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ id: m[1]!, title: textOf(m[2] ?? '') }));
    const tables: StandingsTable[] = [];
    for (const tab of tabs) {
      const start = html.indexOf(`id="${tab.id}"`);
      if (start < 0) continue;
      const rest = html.slice(start + tab.id.length + 5);
      const next = rest.search(/id="tabs-\d+"/);
      const section = next >= 0 ? rest.slice(0, next) : rest;
      const rows: StandingsRow[] = [];
      for (const ul of section.matchAll(/<ul\b[^>]*class="puntajes"[^>]*>([\s\S]*?)<\/ul>/gi)) {
        const item = (cls: string) => textOf(ul[1]!.match(new RegExp(`<li\\b[^>]*class="[^"]*\\b${cls}\\b[^"]*"[^>]*>([\\s\\S]*?)</li>`, 'i'))?.[1] ?? '');
        rows.push({ pos: parseNumber(item('posicion')) ?? 0, name: item('piloto'), points: parseNumber(item('total')) ?? NaN });
      }
      if (rows.length === 0) continue;
      const title = tab.title.charAt(0).toUpperCase() + tab.title.slice(1).toLowerCase();
      tables.push(checkStandingsTable({ title, rows }));
    }
    if (tables.length === 0) throw new Error('TC2000: la página de posiciones no tiene tablas');
    return { tables, source: standingsSource(target, `Posiciones TC2000 ${ctx.season}`, ctx) };
  },
};

// ─── ACTC (TC, TC Pista, TC Pick Up, TC Mouras) ───────────────────────────────────────────────

/** Código de categoría de ACTC a partir de la URL del calendario (https://actc.org.ar/tcp/calendario -> tcp). */
export function actcCategory(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter(Boolean)[0]?.toLowerCase() ?? 'tc';
  } catch {
    return 'tc';
  }
}

const ACTC_SESSION = /entrenamiento|clasificaci|serie|final|carrera|tanda|prueba libre/i;
const ACTC_NOT_SESSION = /salida a pista|previa|c[aá]mara|nota tv|pregrilla|giro|reuni[oó]n|sorteo|entrega|verificaci|podio|conferencia/i;

const actc: SiteRecipe = {
  name: 'actc',
  match: (url) => host(url) === 'actc.org.ar',
  calendarUrl: (url) => {
    const u = new URL(url);
    return u.pathname === '/' ? `${u.origin}/tc/calendario` : url;
  },
  calendar(doc, ctx) {
    const code = actcCategory(doc.url);
    const out: CalendarEntry[] = [];
    for (const value of extractEmbeddedJson(doc.raw)) {
      const events = findArray(value, (o) => 'raceDate' in o && 'title' in o);
      if (!events) continue;
      for (const ev of events) {
        if (str(ev.category).toLowerCase() !== code) continue;
        const raceIso = str(ev.raceDate);
        if (!raceIso || Number(ev.year ?? raceIso.slice(0, 4)) !== ctx.season || ev.active === false) continue;
        const tz = 'America/Argentina/Buenos_Aires';
        const race = dateInZone(raceIso, tz);
        const endIso = str(ev.raceDateEnd);
        const circuit = obj(ev.circuit);
        const title = str(ev.title).trim();
        out.push({
          name: title,
          circuit: str(circuit.name) || title,
          country: 'Argentina',
          tz,
          dateStart: shiftDate(race, -2),
          dateEnd: endIso ? dateInZone(endIso, tz) : race,
          round: roundOf(title),
          url: doc.url,
          meta: { code, raceDate: race, location: str(circuit.location) },
        });
      }
      if (out.length) break;
    }
    // Dos eventos con el mismo título y fecha son el mismo (el sitio a veces repite fechas).
    return out.filter((e, i) => out.findIndex((x) => x.name === e.name && x.dateEnd === e.dateEnd) === i);
  },
  /**
   * Campeonato (https://actc.org.ar/{categoría}/campeonato): la página de Next.js trae la tabla completa en el
   * payload RSC (initialData.championship = { name, year, drivers: [{ position, points, fullName, carNumber }] }).
   */
  async standings(url, ctx) {
    const code = actcCategory(url);
    const target = `https://actc.org.ar/${code}/campeonato`;
    const html = (await ctx.http.text(target)).body;
    let champ: Record<string, unknown> | null = null;
    for (const value of extractEmbeddedJson(html)) {
      champ = findObject(value, (o) => Array.isArray(o.drivers) && 'year' in o);
      if (champ) break;
    }
    if (!champ) throw new Error(`ACTC ${code}: la página no trae los datos del campeonato`);
    if (Number(champ.year) !== ctx.season) return null;
    // En el payload RSC los campos sin valor llegan como "$undefined".
    const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^\s*-?\d/.test(v) ? Number(v) : NaN);
    const rows: StandingsRow[] = (champ.drivers as unknown[])
      .map(obj)
      .map((d) => {
        const wins = num(d.championshipEventWins);
        const number = str(d.carNumber).trim();
        const team = str(d.team).trim();
        return {
          pos: num(d.position),
          name: (str(d.fullName) || `${str(d.givenName)} ${str(d.surname)}`).replace(/\s+/g, ' ').trim(),
          ...(number ? { number } : {}),
          ...(team && team !== '$undefined' ? { team } : {}),
          points: num(d.points),
          ...(Number.isInteger(wins) ? { wins } : {}),
        };
      })
      .sort((a, b) => a.pos - b.pos);
    const table = checkStandingsTable({ title: 'Pilotos', rows });
    return { tables: [table], source: standingsSource(target, `Campeonato ${str(champ.name) || code.toUpperCase()} ${ctx.season}`, ctx) };
  },
  async sessions(entry, ctx) {
    const code = entry.meta?.code ?? actcCategory(ctx.series.officialUrls[0] ?? '');
    const raceDate = entry.meta?.raceDate ?? entry.dateEnd;
    const listUrl = 'https://actc.org.ar/api/schedules';
    const list = (await ctx.http.json<{ data?: Record<string, unknown>[] }>(listUrl)).body.data ?? [];
    const tz = entry.tz;
    const schedule = list.find((s) => {
      const cats = Array.isArray(s.categories) ? (s.categories as unknown[]).map((c) => str(c).toLowerCase()) : [str(s.category)];
      if (s.published === false || !cats.includes(code)) return false;
      const evDate = str(obj(s.calendarEvent).raceDate);
      if (evDate) return dateInZone(evDate, tz) === raceDate;
      // Cronograma sin evento del calendario asociado (calendarEventId null): se reconoce por sus días.
      const days = Array.isArray(s.days) ? (s.days as unknown[]).map((d) => str(obj(d).date).slice(0, 10)) : [];
      return days.includes(raceDate);
    });
    if (!schedule) return null;
    let days = schedule.days as Record<string, unknown>[] | undefined;
    if (!Array.isArray(days)) {
      const detail = await ctx.http.json<{ data?: Record<string, unknown> }>(`${listUrl}/${str(schedule.id)}`);
      days = (detail.body.data?.days as Record<string, unknown>[] | undefined) ?? [];
    }
    const labels = new Set([code, ctx.series.shortName.toLowerCase().replace(/\s+/g, '')]);
    const sessions: ExtractedSession[] = [];
    for (const day of days) {
      const date = str(day.date).slice(0, 10);
      for (const item of (day.items as Record<string, unknown>[] | undefined) ?? []) {
        const title = str(item.title).trim();
        const logos = ((item.logos as Record<string, unknown>[] | undefined) ?? []).map((l) => str(l.label).toLowerCase().replace(/\s+/g, ''));
        if (!logos.some((l) => labels.has(l))) continue;
        if (item.trackType === 'administrative' || !ACTC_SESSION.test(title) || ACTC_NOT_SESSION.test(title)) continue;
        const startMin = Number(item.startMin);
        if (!Number.isFinite(startMin)) continue;
        const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
        const subtitle = str(item.subtitle).trim();
        const detail = subtitle.match(/grupo\s+\w+|\d\*?\s*(?:tercio|cuarto)|\w+\s+(?:tercio|cuarto)/i)?.[0];
        const name = detail ? `${title} (${detail.replace('*', '°')})` : title;
        const endMin = Number(item.endMin);
        sessions.push({
          name,
          startUtc: localToUtc(date, hhmm(startMin), tz),
          ...(Number.isFinite(endMin) && endMin > startMin && item.endMin !== null ? { endUtc: localToUtc(date, hhmm(endMin), tz) } : {}),
          localStartText: hhmm(startMin),
        });
      }
    }
    if (sessions.length === 0) return null;
    const ev = obj(schedule.calendarEvent);
    const source: Source = {
      url: `https://actc.org.ar/cronogramas/${str(schedule.id)}`,
      title: `Cronograma ACTC — ${str(ev.title) || entry.name}`,
      kind: 'api',
      method: 'directo',
      fetchedAt: isoNow(ctx.now),
    };
    return { sessions, source };
  },
};

// ─── APTP (Turismo Pista) ─────────────────────────────────────────────────────────────────────

/**
 * Turismo Pista publica una página de campeonato por clase y temporada
 * (https://aptpweb.com.ar/campeonato-clase-1-2026/): tabla P | N | PILOTO | AUTO | PTS | VICTORIAS.
 * El calendario sale de imágenes (flujo genérico); el cronograma, del PDF que suben a la biblioteca de medios
 * (aptp.ts). Si no aparece, se sigue buscando una nota de cronograma en las noticias (flujo genérico).
 */
const aptp: SiteRecipe = {
  name: 'aptp',
  match: (url) => host(url) === 'aptpweb.com.ar',
  sessions: aptpSessions,
  timetableImages: aptpTimetableImages,
  timetableFallback: 'generic',
  async standings(url, ctx) {
    const origin = new URL(url).origin;
    const own = url.match(/campeonato-clase-(\d+)/i)?.[1] ?? '1';
    const pageUrl = (n: string) => `${origin}/campeonato-clase-${n}-${ctx.season}/`;
    const first = await pageOrNull(ctx, pageUrl(own));
    if (first === null) return null; // la temporada todavía no tiene tabla publicada
    const linked = [...first.matchAll(new RegExp(`campeonato-clase-(\\d+)-${ctx.season}\\b`, 'gi'))].map((m) => m[1]!);
    const classes = [...new Set([own, ...linked])].sort((a, b) => Number(a) - Number(b));
    const tables: StandingsTable[] = [];
    for (const n of classes) {
      const html = n === own ? first : await pageOrNull(ctx, pageUrl(n));
      if (html === null) continue;
      const { headers, rows } = parseHtmlTable(firstTable(html));
      const [cPos, cNum, cName, cPts, cWins] = [/^p$/i, /^n$/i, /^piloto/i, /^(pts|puntos)/i, /^victorias/i].map((re) =>
        column(headers, re),
      );
      if (cPos! < 0 || cName! < 0 || cPts! < 0) {
        throw new Error(`APTP clase ${n}: la tabla no tiene las columnas esperadas (${headers.join(', ')})`);
      }
      const parsed: StandingsRow[] = rows.map((cells) => {
        const number = cNum! >= 0 ? textOf(cells[cNum!] ?? '') : '';
        return {
          pos: parseNumber(textOf(cells[cPos!] ?? '')) ?? 0,
          name: textOf(cells[cName!] ?? ''),
          ...(number ? { number } : {}),
          points: parseNumber(textOf(cells[cPts!] ?? '')) ?? NaN,
          // La columna muestra una copa con "x4"; vacía = sin victorias.
          ...(cWins! >= 0 ? { wins: parseNumber(textOf(cells[cWins!] ?? '')) ?? 0 } : {}),
        };
      });
      tables.push(checkStandingsTable({ title: `Clase ${n}`, rows: parsed }));
    }
    return { tables, source: standingsSource(pageUrl(own), `Campeonato Turismo Pista ${ctx.season}`, ctx) };
  },
};

// ─── DTM (API oficial de dtm.com) ─────────────────────────────────────────────────────────────

const dtm: SiteRecipe = {
  name: 'dtm',
  match: (url) => /^(dtm\.com|api\.dtm\.com)$/.test(host(url)),
  calendarUrl: (url) => (host(url) === 'api.dtm.com' ? url : 'https://api.dtm.com/data?query=events'),
  calendar(doc, ctx) {
    let data: unknown;
    try {
      data = JSON.parse(doc.raw);
    } catch {
      return [];
    }
    const events = (obj(data).events as Record<string, unknown>[] | undefined) ?? [];
    const out: CalendarEntry[] = [];
    for (const ev of events) {
      const cat = str(ev.eventCategory);
      const start = str(ev.startTime);
      if (!/^DTM\b/i.test(cat) || !start.startsWith(String(ctx.season)) || ev.hideOnOverview === true) continue;
      const country = obj(ev.country);
      const track = obj(ev.racetrack);
      const tz = tzFor(str(country.countryCode) || str(country.name), str(track.name));
      out.push({
        name: str(ev.name),
        circuit: str(track.name) || str(ev.name),
        country: countryName(str(country.name) || str(country.countryCode)),
        tz,
        dateStart: dateInZone(start, tz),
        dateEnd: dateInZone(str(ev.endTime) || start, tz),
        round: Number(ev.eventNumber) || undefined,
        url: `https://www.dtm.com/en/events/${str(ev.slug)}`,
        meta: { slug: str(ev.slug) },
      });
    }
    return out;
  },
  async sessions(entry, ctx) {
    const slug = entry.meta?.slug;
    if (!slug) return null;
    const res = await ctx.http.json<{ events?: Record<string, unknown>[] }>(
      `https://api.dtm.com/data?query=eventDetails&slug=${encodeURIComponent(slug)}`,
    );
    const ev = res.body.events?.[0];
    const items = (ev?.timetable as Record<string, unknown>[] | undefined) ?? [];
    const sessions: ExtractedSession[] = items
      .filter((i) => str(i.headline).trim().toUpperCase() === 'DTM')
      .filter((i) => !/autogramm|autograph|pit ?walk|pit ?lane|parade|interview|press|safari|taxi|grid ?walk/i.test(str(i.label)))
      .map((i) => ({
        name: str(i.label),
        startUtc: toUtcIso(str(i.start)),
        ...(str(i.end) ? { endUtc: toUtcIso(str(i.end)) } : {}),
      }));
    if (sessions.length === 0) return null;
    return {
      sessions,
      source: {
        url: entry.url ?? 'https://www.dtm.com/en/calendar',
        title: `Timetable DTM — ${entry.name}`,
        kind: 'api',
        method: 'directo',
        fetchedAt: isoNow(ctx.now),
      },
    };
  },
  /**
   * Campeonato: la misma consulta que usa www.dtm.com/en/standings (wigeStandings, por rango de fechas de la
   * temporada), con pilotos, equipos y marcas. null si la temporada todavía no tiene tabla.
   */
  async standings(_url, ctx) {
    const res = await ctx.http.json<unknown>(
      `https://api.dtm.com/data?query=wigeStandings&raceSeries=DTM&startDate=${ctx.season}-01-01&endDate=${ctx.season}-12-31`,
    );
    const tables = dtmStandingsTables(res.body, ctx.season);
    if (!tables) return null;
    return { tables, source: { ...standingsSource('https://www.dtm.com/en/standings', `Standings DTM ${ctx.season}`, ctx), kind: 'api' } };
  },
  /** Inscriptos de la temporada: https://api.dtm.com/data?query=drivers (número, equipo y auto por temporada). */
  roster: (url, ctx) => dtmRoster(url, ctx),
};

/** "PREINING Thomas" -> "Thomas PREINING": la API escribe primero el apellido (en mayúsculas). */
export function dtmDriverName(raw: string): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  const m = t.match(/^((?:[\p{Lu}'’.-]{2,}\s+)*[\p{Lu}'’.-]{2,})\s+(\S.*)$/u);
  return m && /\p{Ll}/u.test(m[2]!) ? `${m[2]} ${m[1]}` : t;
}

/**
 * Tablas del DTM a partir de la respuesta de wigeStandings: { wigeStandingses: [{ raceSeries, startDate, jsonText }] },
 * con jsonText = { drivers, teams, manufacturers } (position, name, totalpoints; los pilotos con nationality).
 * null si la temporada no tiene tabla todavía.
 */
export function dtmStandingsTables(data: unknown, season: number): StandingsTable[] | null {
  const list = ((obj(data).wigeStandingses as unknown[] | undefined) ?? []).map(obj);
  const entry = list.find((e) => /^dtm$/i.test(str(e.raceSeries)) && str(e.startDate).startsWith(String(season)));
  if (!entry) return null;
  let doc: Record<string, unknown>;
  try {
    doc = obj(JSON.parse(str(entry.jsonText)));
  } catch {
    throw new Error('DTM: el campeonato de la API no es un JSON válido');
  }
  const table = (key: string, title: string, driver: boolean): StandingsTable | null => {
    const rows = ((doc[key] as unknown[] | undefined) ?? [])
      .map(obj)
      .map((r): StandingsRow => {
        const country = driver ? str(r.nationality) : '';
        return {
          pos: Number(r.position),
          name: driver ? dtmDriverName(str(r.name)) : str(r.name).trim(),
          points: parseNumber(str(r.totalpoints)) ?? NaN,
          ...(country ? { country: countryFromCode(country) } : {}),
        };
      })
      .sort((a, b) => a.pos - b.pos);
    return rows.length ? checkStandingsTable({ title, rows }) : null;
  };
  const tables = [table('drivers', 'Pilotos', true), table('teams', 'Equipos', false), table('manufacturers', 'Marcas', false)].filter(
    (t): t is StandingsTable => t !== null,
  );
  return tables.length ? tables : null;
}

// ─── F1 Academy (datos de Next.js de f1academy.com) ───────────────────────────────────────────

const f1academy: SiteRecipe = {
  name: 'f1academy',
  match: (url) => host(url) === 'f1academy.com',
  calendar(doc, ctx) {
    const out: CalendarEntry[] = [];
    for (const value of extractEmbeddedJson(doc.raw)) {
      const races = findArray(value, (o) => 'RaceStartDate' in o && 'Sessions' in o);
      if (!races) continue;
      for (const r of races) {
        const start = str(r.RaceStartDate);
        if (!start.startsWith(String(ctx.season))) continue;
        const circuit = str(r.CircuitName);
        const country = str(r.CountryName);
        const raw = (r.Sessions as Record<string, unknown>[] | undefined) ?? [];
        const tz = tzFor(country, `${circuit} ${str(r.CircuitShortName)}`);
        const sessions: ExtractedSession[] = raw
          .filter((s) => s.Unconfirmed !== true && str(s.SessionStartTime))
          .map((s) => {
            const startIso = str(s.SessionStartTime);
            return {
              name: str(s.SessionName),
              startUtc: f1AcademyUtc(startIso, tz),
              ...(str(s.SessionEndTime) ? { endUtc: f1AcademyUtc(str(s.SessionEndTime), tz) } : {}),
              localStartText: startIso.slice(11, 16),
            };
          });
        out.push({
          name: str(r.CircuitShortName) || circuit,
          circuit,
          country: countryName(country),
          tz,
          dateStart: start,
          dateEnd: str(r.RaceEndDate) || start,
          round: Number(r.RoundNumber) || undefined,
          url: `https://www.f1academy.com/Racing-Series/Results?raceid=${str(r.RaceId)}`,
          ...(sessions.length ? { sessions } : {}),
          // Sin horarios confirmados: los nombres previstos sirven para leer el cronograma de formula1.com.
          ...(!sessions.length && raw.length ? { meta: { [PLANNED_SESSIONS]: raw.map((s) => str(s.SessionName)).filter(Boolean).join('|') } } : {}),
        });
      }
      break;
    }
    return out;
  },
  // Mientras f1academy.com marca las sesiones "Unconfirmed": cronograma oficial del fin de semana (formula1.com).
  sessions: (entry, ctx) => f1AcademyWeekendSessions(entry, ctx),
};

// ─── International GT Open (gtopen.gtsport.es) ────────────────────────────────────────────────

const gtopen: SiteRecipe = {
  name: 'gtopen',
  match: (url) => /^(gtopen\.gtsport\.es|gtopen\.net)$/.test(host(url)),
  calendarUrl: () => 'https://gtopen.gtsport.es/calendario',
  calendar(doc, ctx) {
    const out: CalendarEntry[] = [];
    for (const value of extractEmbeddedJson(doc.raw)) {
      const eventos = findArray(value, (o) => 'nombre' in o && 'fecha' in o && 'circuito' in o);
      if (!eventos) continue;
      for (const ev of eventos) {
        const fecha = str(ev.fecha);
        if (!fecha.startsWith(String(ctx.season))) continue;
        const circuito = obj(ev.circuito);
        const country = str(circuito.pais);
        const tz = tzFor(country, str(circuito.nombre));
        const race = dateInZone(fecha, tz);
        const docs = ((ev.docs as Record<string, unknown>[] | undefined) ?? []).filter((d) => /^schedule/i.test(str(d.nombre)));
        const schedule = docs.find((d) => /fin/i.test(str(d.nombre))) ?? docs.at(-1);
        const scheduleUrl = str(obj(obj(schedule).doc).url);
        out.push({
          name: str(ev.nombre).replace(/\s*-\s*GTO\s*-\s*\d{4}$/i, '') || str(circuito.nombre),
          circuit: str(circuito.nombre),
          country: countryName(country),
          tz,
          dateStart: shiftDate(race, -2),
          dateEnd: race,
          url: doc.url,
          ...(scheduleUrl ? { timetableUrl: scheduleUrl } : {}),
        });
      }
      if (out.length) break;
    }
    return out;
  },
};

// ─── FIA: calendario deportivo internacional (descubrimiento) ────────────────────────────────

const fia: SiteRecipe = {
  name: 'fia',
  match: (url) => host(url) === 'fia.com',
  calendar(doc, ctx) {
    const out: CalendarEntry[] = [];
    let year = ctx.now.getUTCFullYear();
    let lastMonth = 0;
    const html = stripComments(doc.raw);
    const blocks = blocksByClass(html, 'calendar-layout', 5000);
    let cursor = 0;
    for (const b of blocks) {
      // El link al evento (cuando existe) envuelve el bloque: se busca también justo antes.
      const at = html.indexOf(b.slice(0, 200), cursor);
      cursor = at > 0 ? at + 1 : cursor;
      const before = at > 0 ? html.slice(Math.max(0, at - 400), at) : '';
      if (/^<[^>]*calendar-layout cancelled/.test(b) || /class="pane-event-status"[\s\S]{0,120}cancel/i.test(b)) continue;
      const title = textOf(b.match(/region-right[\s\S]*?<p>([\s\S]*?)<\/p>/)?.[1] ?? '');
      const sd = b.match(/<span class="start day">(\d{1,2})<\/span>\s*<span class="start month">([A-Za-z]+)<\/span>/);
      const ed = b.match(/<span class="end day">(\d{1,2})<\/span>\s*<span class="end month">([A-Za-z]+)<\/span>/);
      const linkRe = /href="([^"]*\/championship\/events\/([^/"]+)\/season-(\d{4})\/[^"]*)"/;
      const openAnchor = before.slice(before.lastIndexOf('<a ')); // ancla que envuelve el bloque (sin cerrar)
      const href = b.match(linkRe) ?? (openAnchor.includes('</a>') ? null : openAnchor.match(linkRe));
      if (!title || !sd) continue;
      const m1 = monthNumber(sd[2]!) ?? 0;
      if (href?.[3]) year = Number(href[3]);
      else if (lastMonth && m1 < lastMonth) year++;
      lastMonth = m1;
      const start = isoDate(year, m1, Number(sd[1]));
      const m2 = ed ? (monthNumber(ed[2]!) ?? m1) : m1;
      const end = ed ? isoDate(m2 < m1 ? year + 1 : year, m2, Number(ed[1])) : start;
      if (!start || !end) continue;
      const code = textByClass(b, 'country-label-wrapper');
      const slug = href?.[2] ?? '';
      const logo = b.match(/competition_logo\/public\/([^?"]+)/)?.[1] ?? '';
      const championship = slug ? humanize(slug) : fiaChampionshipFromLogo(logo);
      const url = href ? (absoluteUrl(href[1]!, doc.url) ?? undefined) : undefined;
      out.push({
        name: title,
        circuit: title,
        country: countryName(code),
        tz: tzFor(code, title),
        dateStart: start,
        dateEnd: end,
        url,
        championship: championship ?? title,
        // Una categoría descubierta acá se sigue leyendo de este mismo calendario, filtrada por campeonato.
        championshipUrl: doc.url,
      });
    }
    return dedupe(out);
  },
};

// ─── CDA del ACA: calendario deportivo nacional (descubrimiento) ──────────────────────────────

const cdaaca: SiteRecipe = {
  name: 'cdaaca',
  match: (url) => host(url) === 'cdaaca.org.ar',
  calendar(doc) {
    const out: CalendarEntry[] = [];
    const re = /<a\b[^>]*href="(\/eventos\/[^"]+)"[^>]*class="hidden md:grid[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    for (const m of doc.raw.matchAll(re)) {
      const spans = [...m[2]!.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/g)].map((s) => textOf(s[1] ?? '')).filter(Boolean);
      if (spans.length < 3) continue;
      const date = parseDateRangeText(spans[0]!, new Date().getUTCFullYear());
      if (!date) continue;
      const [, category, circuit, number] = spans;
      const url = absoluteUrl(m[1]!, doc.url) ?? undefined;
      out.push({
        name: `${category}${number ? ` — Fecha ${number}` : ''}`,
        circuit: circuit ?? '',
        country: 'Argentina',
        tz: 'America/Argentina/Buenos_Aires',
        dateStart: date.start,
        dateEnd: date.end,
        url,
        championship: category!,
        championshipUrl: doc.url,
      });
    }
    return dedupe(out);
  },
};

/** El calendario de la FIA solo identifica el campeonato por su logo: nombre a partir del archivo. */
export function fiaChampionshipFromLogo(file: string): string | undefined {
  const f = file.toLowerCase();
  const region = (r: string) =>
    ({ master: 'Europe', european: 'Europe', world: 'World', middleeast: 'Middle East', asiapacific: 'Asia-Pacific', codasur: 'CODASUR', nacam: 'NACAM', africa: 'Africa' })[r] ??
    r.charAt(0).toUpperCase() + r.slice(1);
  if (/f1_championship|formula_?1|formula_one/.test(f)) return 'FIA Formula One World Championship';
  if (/(^|_)f2_|formula_?2/.test(f)) return 'FIA Formula 2 Championship';
  if (/(^|_)f3_|formula_?3/.test(f)) return 'FIA Formula 3 Championship';
  if (/f1_?academy/.test(f)) return 'F1 Academy';
  if (/formula_?e|(^|_)fe_/.test(f)) return 'FIA Formula E World Championship';
  if (/wec/.test(f)) return 'World Endurance Championship';
  if (/w2rc/.test(f)) return 'FIA World Rally-Raid Championship';
  if (/wrc/.test(f)) return 'FIA World Rally Championship';
  if (/tcrwt|tcr_world/.test(f)) return 'FIA TCR World Tour';
  if (/gt_world_cup/.test(f)) return 'FIA GT World Cup';
  const ert = f.match(/ert_([a-z]+)/);
  if (ert) return `FIA Rally Regional ${region(ert[1]!)}`;
  const baja = f.match(/bajacup_([a-z]+)/);
  if (baja) return baja[1] === 'world' ? 'FIA World Baja Cup' : `FIA Baja Cup ${region(baja[1]!)}`;
  return undefined;
}

function humanize(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w === 'fia' ? 'FIA' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

export const RECIPES: SiteRecipe[] = [sro, indycar, aco, nls, creventic, apat, tc2000, actc, aptp, dtm, f1academy, gtopen, fia, cdaaca, imsa];
// Asia y Oceanía: recetas en su propio archivo (importan sus utilidades de kit.ts, no de este).
RECIPES.push(supergt, superformula, supertaikyu, macau, supercars);

export function findRecipe(url: string): SiteRecipe | undefined {
  return RECIPES.find((r) => r.match(url));
}

