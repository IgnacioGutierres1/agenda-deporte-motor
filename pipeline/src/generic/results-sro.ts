/**
 * Cronograma y resultados de los sitios de SRO Motorsports Group (GT World Challenge Europe/Asia/America/Australia,
 * Intercontinental GT Challenge), sin IA:
 * - Cronograma: tabla "Timetable" de la página del evento (/event/{id}/…), con la hora local de cada sesión.
 * - Resultados: la página del evento enlaza /results?filter_season_id=…&filter_meeting_id=…; ahí el selector
 *   filter_race_id lista las sesiones con resultado (Europa, Asia, América: tabla HTML por sesión, con
 *   &filter_race_id={id}) o, en Australia y el IGTC, una lista de PDF por sesión (ver results-sro-pdf.ts).
 */
import { localToUtc, type ResultRow, type Session, type Source } from '@dm/shared';
import { HttpError } from '../core/http.ts';
import { absoluteUrl, attr, blocksByClass, textByClass, textOf } from '../extract/html.ts';
import { lapsLabel, trimLapTime } from '../adapters/util.ts';
import { column, dedupe, isoNow, parseHtmlTable, roundOf, stripComments, tzFor } from './kit.ts';
import { countryName, isoDate, monthNumber, parseDateRangeText, shiftDate } from './places.ts';
import { addClassPositions, sroPdfRows, timeSeconds } from './results-sro-pdf.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, ResultsFound, SessionResultFound, SessionsFound } from './types.ts';

/** Actividades del cronograma que no son sesiones en pista (sin resultado). */
const NOT_ON_TRACK = /parade|pit\s*-?\s*walk|pit\s*lane\s*walk|autograph|grid\s*walk|gala|press\s*conference|briefing|signing|\bfan\b|ceremony|podium/i;
/** Opciones del selector de resultados que no son una sesión del cronograma (parciales cada hora, partes de la Superpole, grilla). */
const NOT_A_SESSION = /\bafter\s+\d|^superpole\s*\d|^grid$|^starting\s+grid/i;

/**
 * Clave para unir el nombre del cronograma con el de los resultados, también entre sitios (el IGTC y la fecha del
 * GT World Challenge que comparte el evento): "Pre Qualifying" = "Pre-Qualifying", "Pole Shootout (Top-10)" =
 * "Superpole", "Main Race" = "Race", "Official Paid Test Session 1" = "Paid Test Session 1",
 * "Combined Qualifying" = "Qualifying Combined".
 */
export const sroKey = (name: string): string =>
  textOf(name)
    .toLowerCase()
    .replace(/super\s*pole|pole\s*shoot-?out(\s*\(top[\s-]*\d+\))?/g, 'superpole')
    .replace(/^\s*(official|main)\s+/, '')
    .replace(/^\s*combined\s+qualifying/, 'qualifying combined')
    .replace(/[^a-z0-9]+/g, '');

/** "13:05" | "04:00 pm" | "12:30 am" -> "13:05", "16:00", "00:30". */
export function sroTime(text: string): string | null {
  const m = text.trim().match(/^(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const ampm = m[3]?.[0]?.toLowerCase();
  if (ampm === 'p' && h < 12) h += 12;
  if (ampm === 'a' && h === 12) h = 0;
  if (h > 23) return null;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** Horas de carrera que anuncia el nombre del evento o de la sesión ("24 Hours of Spa", "Bathurst 12 Hour", "Suzuka 1000km"). */
export function sroRaceHours(eventName: string, sessionName = ''): number | null {
  const t = `${eventName} ${sessionName}`;
  const h = t.match(/\b(24|12|10|9|8|6)\s*-?\s*h(?:ou)?rs?\b|\b(24|12|10|9|8|6)h\b/i);
  if (h) return Number(h[1] ?? h[2]);
  if (/\b1000\s*km\b/i.test(t)) return 6;
  return null;
}

/**
 * Sesiones de la tabla "Timetable" de la página de un evento de SRO. Cada tabla es un día ("Friday, 17 July") con
 * filas Session | Local Time | GMT. La hora UTC sale de la hora local y la zona del circuito: la columna GMT no es
 * confiable (en Australia repite la hora local y en Bathurst no aplica el horario de verano). Solo si la zona no
 * se conoce se usa la columna GMT. Se omiten actividades que no son en pista (Pit Walk, Parade, autógrafos…).
 * La carrera de un evento de resistencia larga ("24 Hours", "12 Hour", "1000km") lleva su hora de fin estimada.
 */
export function sroTimetable(html: string, entry: Pick<CalendarEntry, 'name' | 'dateStart' | 'tz' | 'url'>): ExtractedSession[] {
  const out: ExtractedSession[] = [];
  const year = Number(entry.dateStart.slice(0, 4));
  for (const t of stripComments(html).matchAll(/<table\b[^>]*class="timetable__table"[^>]*>([\s\S]*?)<\/table>/gi)) {
    const caption = textOf(t[1]!.match(/<caption\b[^>]*>([\s\S]*?)<\/caption>/i)?.[1] ?? '');
    const dm = caption.match(/(\d{1,2})\s+([A-Za-zÀ-ÿ]+)/);
    const month = dm ? monthNumber(dm[2]!) : null;
    if (!dm || !month) continue;
    let date = `${year}-${String(month).padStart(2, '0')}-${dm[1]!.padStart(2, '0')}`;
    // Evento que cruza el año (no pasa en SRO, pero no cuesta nada): el día queda cerca del inicio.
    if (date < shiftDate(entry.dateStart, -30)) date = `${year + 1}${date.slice(4)}`;
    const { rows } = parseHtmlTable(t[1]!);
    for (const cells of rows) {
      const name = textOf(cells[0] ?? '');
      const local = sroTime(textOf(cells[1] ?? ''));
      if (!name || !local || NOT_ON_TRACK.test(name)) continue;
      let startUtc: string;
      if (entry.tz && entry.tz !== 'UTC') {
        startUtc = localToUtc(date, local, entry.tz);
      } else {
        const gmt = sroTime(textOf(cells[2] ?? ''));
        if (!gmt) continue;
        startUtc = gmtStart(date, local, gmt);
      }
      const hours = /^(main\s+)?race$/i.test(name) ? sroRaceHours(eventHint(entry), name) : null;
      out.push({
        name,
        startUtc,
        ...(hours ? { endUtc: new Date(Date.parse(startUtc) + hours * 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z') } : {}),
        localStartText: local,
      });
    }
  }
  return out.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
}

/** Nombre y dirección del evento: la duración a veces solo figura en la URL (".../event/117/indianpolis-8-hour"). */
function eventHint(entry: Pick<CalendarEntry, 'name' | 'url'>): string {
  let slug = entry.url?.split('/').pop() ?? '';
  try {
    slug = decodeURIComponent(slug);
  } catch {
    // Dirección con un % suelto: se usa tal cual.
  }
  return `${entry.name} ${slug.replace(/[-_]+/g, ' ')}`;
}

/** Inicio UTC a partir de la hora local y la GMT del mismo renglón (la GMT puede ser del día anterior o siguiente). */
function gmtStart(date: string, local: string, gmt: string): string {
  const mins = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
  let offset = (((mins(local) - mins(gmt)) % 1440) + 1440) % 1440;
  if (offset > 14 * 60) offset -= 1440;
  const localMs = Date.parse(`${date}T${local}:00Z`);
  return new Date(localMs - offset * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// ─── Calendario ──────────────────────────────────────────────────────────────────────────────

/** Fechas de la página de calendario de SRO; solo las de la temporada pedida (la página puede mostrar otra). */
export function sroCalendar(raw: string, pageUrl: string, ctx: RecipeContext): CalendarEntry[] {
  const html = stripComments(raw);
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
    const url = href ? (absoluteUrl(href, pageUrl) ?? undefined) : undefined;
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
      url: href ? (absoluteUrl(href, pageUrl) ?? undefined) : undefined,
    });
  }
  return dedupe(out)
    .filter((e) => e.dateStart.startsWith(String(ctx.season)))
    .sort((a, b) => a.dateStart.localeCompare(b.dateStart));
}

/** Opciones de un <select name="…"> (valor, texto y si está elegida). */
function selectOptions(html: string, name: string): { value: string; label: string; selected: boolean }[] {
  for (const sel of stripComments(html).matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
    if (attr(sel[1] ?? '', 'name') !== name) continue;
    return [...(sel[2] ?? '').matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)].map((o) => ({
      value: attr(o[1] ?? '', 'value') ?? '',
      label: textOf(o[2] ?? ''),
      selected: /\bselected\b/i.test(o[1] ?? ''),
    }));
  }
  return [];
}

/**
 * Calendario de un sitio de SRO para la temporada pedida. Al terminar la temporada, /calendar pasa a mostrar la
 * siguiente (América mostraba 2027 en noviembre de 2026): si la página no tiene fechas de la temporada pedida, se lee
 * la versión del selector de temporadas (/calendar?filter_season_id=…).
 */
export async function sroCalendarPage(raw: string, pageUrl: string, ctx: RecipeContext): Promise<CalendarEntry[]> {
  const entries = sroCalendar(raw, pageUrl, ctx);
  if (entries.length > 0) return entries;
  const option = selectOptions(raw, 'filter_season_id').find((o) => o.label === String(ctx.season));
  if (!option || option.selected) return entries;
  const url = `${new URL(pageUrl).origin}/calendar?filter_season_id=${encodeURIComponent(option.value)}`;
  return sroCalendar((await ctx.http.text(url)).body, url, ctx);
}

// ─── Resultados ──────────────────────────────────────────────────────────────────────────────

/** Sesión con resultado publicado en la página de resultados de un evento. */
export interface SroResultLink {
  label: string;
  url: string;
  kind: 'html' | 'pdf';
  /** Id de la sesión en el selector (filter_race_id), para ordenar sesiones con el mismo nombre. */
  id?: number;
}

/**
 * Sesiones con resultado de la página de resultados de un evento: opciones del selector filter_race_id (tabla HTML
 * por sesión) y, en los sitios que publican PDF (Australia, IGTC), los enlaces de la lista "link-boxes".
 */
export function sroResultLinks(html: string, pageUrl: string): SroResultLink[] {
  const clean = stripComments(html);
  const out: SroResultLink[] = [];
  for (const o of selectOptions(clean, 'filter_race_id')) {
    if (!/^\d+$/.test(o.value) || !o.label) continue;
    const u = new URL(pageUrl);
    u.searchParams.set('filter_race_id', o.value);
    out.push({ label: o.label, url: u.toString(), kind: 'html', id: Number(o.value) });
  }
  for (const a of clean.matchAll(/<a\b[^>]*class="link-boxes__link"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = a[1]!.trim();
    const label = textOf(a[2]!.match(/<span\b[^>]*class="link-boxes__title"[^>]*>([\s\S]*?)(?:<\/a>|$)/i)?.[1] ?? a[2]!);
    if (!label || !/\.pdf(\?|#|$)/i.test(href)) continue;
    out.push({ label, url: new URL(encodeURI(decodeURI(href)), pageUrl).toString(), kind: 'pdf' });
  }
  return out;
}

/** Enlace de la página del evento a sus resultados (/results?filter_season_id=…&filter_meeting_id=…). */
export function sroResultsUrl(eventHtml: string, eventUrl: string): string | null {
  const href = stripComments(eventHtml).match(/href="([^"]*\/results\?[^"]*filter_meeting_id=\d+[^"]*)"/i)?.[1];
  return href ? new URL(href.replace(/&amp;/g, '&'), eventUrl).toString() : null;
}

/** "Pro Cup" -> "Pro", "PRO-AM" -> "Pro-Am", "SIL-AM" -> "Silver-Am", "AM" -> "Am". */
export function sroClass(raw: string): string {
  const t = raw.replace(/\bcup\b/gi, '').replace(/\s+/g, ' ').trim();
  if (!t) return '';
  return t
    .replace(/\bsil\b/gi, 'Silver')
    .split(/([\s-]+)/)
    .map((w) => (/^(gt\d|lmp\d|gtwc|gte|tcr)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()))
    .join('');
}

const STATUS: [RegExp, string][] = [
  [/^(nc|not classified)$/i, 'NC'],
  [/^(ns|dns|did not start)$/i, 'DNS'],
  [/^(dq|dsq|exc|ex|excluded)$/i, 'DSQ'],
  [/^(dnf|ret|ab|retired)$/i, 'DNF'],
];

function statusOf(text: string): string | null {
  for (const [re, s] of STATUS) if (re.test(text.trim())) return s;
  return null;
}

/** Diferencia publicada -> "+0.141", "+1:02.674", "+3 vueltas". Las negativas (autos no clasificados) se omiten. */
function gapText(raw: string): string | undefined {
  const t = raw.trim();
  if (!t || t.startsWith('-')) return undefined;
  const laps = t.match(/^\+?(\d+)\s*laps?$/i);
  if (laps) return Number(laps[1]) > 0 ? lapsLabel(Number(laps[1])) : undefined;
  return /^\+?[\d:.]+$/.test(t) ? `+${t.replace(/^\+/, '').replace(/^0+:/, '').replace(/^00?(?=\d\.)/, '')}` : undefined;
}

/**
 * Tabla de resultados de una sesión en el HTML de SRO. Las columnas cambian según el sitio:
 * - Europa: Pos | Car # | Class ("Pro Cup") | Drivers | Team | Car | Time (mejor vuelta) | Laps | Gap; la
 *   clasificación combinada de Spa trae Avg Time | Time 1…4.
 * - Asia: Pos | Car # | Class ("GT3") | Cat ("PRO-AM") | Team | Drivers | Car | Time (total en carrera) | Laps | Gap…
 * - América: Pos | Car # | Class | Drivers | Team | Car | Best Lap | Laps | Gap.
 * En carrera, a un auto con menos vueltas que el ganador se le pone "+N vueltas" (Europa publica la diferencia de
 * tiempo con el auto de adelante). Sin posición: NC, DNS (NS), DSQ.
 */
export function sroHtmlRows(html: string, isRace: boolean): ResultRow[] {
  const table = stripComments(html).match(/<table\b[^>]*class="table session"[^>]*>[\s\S]*?<\/table>/i)?.[0];
  if (!table) return [];
  const { headers, rows } = parseHtmlTable(table);
  const c = {
    pos: column(headers, /^pos/i),
    num: column(headers, /^(car\s*#|car\s*no\.?|no\.?|#)$/i),
    cls: column(headers, /^class$/i),
    cat: column(headers, /^cat(egory)?$/i),
    drv: column(headers, /^drivers?$/i),
    team: column(headers, /^team$/i),
    car: column(headers, /^car$/i),
    time: column(headers, /^time$/i),
    best: column(headers, /^best\s*lap$/i),
    avg: column(headers, /^avg\.?\s*time$/i),
    laps: column(headers, /^laps$/i),
    gap: column(headers, /^gap$/i),
  };
  if (c.pos < 0 || c.drv < 0) throw new Error(`SRO: tabla de resultados sin las columnas esperadas (${headers.join(', ')})`);
  const cell = (r: string[], i: number) => (i >= 0 ? textOf(r[i] ?? '') : '');
  const out: ResultRow[] = [];
  let leaderLaps: number | null = null;
  let leaderTotal: number | null = null;
  let leaderAvg: number | null = null;
  for (const r of rows) {
    const posText = cell(r, c.pos);
    const drivers = cell(r, c.drv)
      .split(',')
      .map((d) => d.trim())
      .filter(Boolean);
    if (drivers.length === 0) continue;
    const pos = /^\d+$/.test(posText) ? Number(posText) : null;
    const lapsText = cell(r, c.laps);
    const laps = /^\d+$/.test(lapsText) ? Number(lapsText) : undefined;
    const row: ResultRow = { pos, driver: drivers.join(' / ') };
    if (pos === null) row.status = statusOf(posText) ?? (laps === 0 ? 'DNS' : 'NC');
    const num = cell(r, c.num);
    if (num) row.number = num;
    const team = cell(r, c.team);
    if (team) row.team = team;
    const car = cell(r, c.car);
    if (car) row.vehicle = car;
    const cat = cell(r, c.cat);
    const cls = cell(r, c.cls);
    const klass = cat ? (/gt4/i.test(cls) ? `GT4 ${sroClass(cat)}` : sroClass(cat)) : sroClass(cls);
    if (klass) row.class = klass;
    if (laps !== undefined && laps > 0) row.laps = laps;
    const avg = cell(r, c.avg);
    const time = cell(r, c.time);
    const best = cell(r, c.best);
    if (avg) {
      // Clasificación combinada de Spa: manda el promedio de las vueltas de todos los pilotos.
      row.time = trimLapTime(avg);
      const sec = timeSeconds(avg);
      if (pos === 1) leaderAvg = sec;
      else if (pos !== null && sec !== null && leaderAvg !== null) row.gap = `+${(sec - leaderAvg).toFixed(3)}`;
    }
    if (best) row.bestLap = trimLapTime(best);
    const total = time ? timeSeconds(time) : null;
    if (time && total !== null && total >= 600) {
      // Tiempo total de carrera (Asia): el del ganador; los demás llevan la diferencia.
      if (pos === 1 || leaderTotal === null) {
        row.time = time.replace(/^0(?=\d:)/, '').replace(/^00:/, '');
        leaderTotal = total;
      }
    } else if (time) {
      row.bestLap = trimLapTime(time);
    }
    if (pos !== null) {
      const gap = gapText(cell(r, c.gap));
      if (pos === 1) leaderLaps = laps ?? null;
      const down = isRace && leaderLaps !== null && laps !== undefined && laps < leaderLaps ? leaderLaps - laps : 0;
      if (down > 0) row.gap = lapsLabel(down);
      else if (gap && pos > 1) row.gap = gap;
      else if (pos > 1 && total !== null && leaderTotal !== null && total >= 600 && !row.gap) row.time = time;
    }
    out.push(row);
  }
  return addClassPositions(out);
}

/** Título de la página de resultados ("Race 1 | Misano | 2026 Results"). */
function heading(html: string): string {
  const h = html.match(/<h2\b[^>]*class="results__heading[^"]*"[^>]*>([\s\S]*?)<\/h2>/i)?.[1] ?? '';
  return [...h.matchAll(/<span\b[^>]*class="heading__text"[^>]*>([\s\S]*?)<\/span>/gi)].map((m) => textOf(m[1] ?? '')).filter(Boolean).join(' · ');
}

/** Sesiones de resultados que no figuran en el cronograma, ubicadas junto a la sesión de la que salen. */
function extraSessions(timetable: ExtractedSession[], links: SroResultLink[]): ExtractedSession[] {
  const known = new Set(timetable.map((s) => sroKey(s.name)));
  const out: ExtractedSession[] = [];
  for (const l of links) {
    const key = sroKey(l.label);
    if (known.has(key) || NOT_A_SESSION.test(l.label) || NOT_ON_TRACK.test(l.label)) continue;
    // "Qualifying 1 Combined" va con las Qualifying 1 (grupos A y B); "Qualifying Combined", con la última clasificación.
    const base = key.replace(/combined$|^combined/, '');
    if (base === key) continue;
    const anchor = [...timetable].reverse().find((s) => sroKey(s.name).startsWith(base) && !/combined/.test(sroKey(s.name)));
    if (!anchor) continue;
    known.add(key);
    out.push({ name: l.label, startUtc: anchor.startUtc, ...(anchor.endUtc ? { endUtc: anchor.endUtc } : {}) });
  }
  return out;
}

async function page(ctx: RecipeContext, url: string): Promise<string> {
  return stripComments((await ctx.http.text(url)).body);
}

/**
 * Cronograma de un evento de SRO: la tabla "Timetable" de su página y, si ya hay resultados, las clasificaciones
 * combinadas que no figuran en ella ("Qualifying 1 Combined": la grilla de la Race 1 del Sprint Cup).
 * null si la página todavía no tiene cronograma.
 */
export async function sroSessions(entry: CalendarEntry, ctx: RecipeContext): Promise<SessionsFound | null> {
  if (!entry.url) return null;
  const html = await page(ctx, entry.url);
  const sessions = sroTimetable(html, entry);
  if (sessions.length === 0) return null;
  const resultsUrl = sroResultsUrl(html, entry.url);
  if (resultsUrl && entry.dateStart <= isoNow(ctx.now).slice(0, 10)) {
    try {
      sessions.push(...extraSessions(sessions, sroResultLinks(await page(ctx, resultsUrl), resultsUrl)));
    } catch {
      // Sin la página de resultados quedan solo las sesiones del cronograma.
    }
  }
  const title = textOf(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '') || entry.name;
  return {
    sessions: sessions.sort((a, b) => a.startUtc.localeCompare(b.startUtc)),
    source: { url: entry.url, title, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) },
  };
}

/** Sitios del GT World Challenge que comparten fechas con el IGTC (Spa con Europa, Indianápolis con América). */
const SISTER_SITES = [
  'https://www.gt-world-challenge-europe.com',
  'https://www.gt-world-challenge-america.com',
  'https://www.gt-world-challenge-asia.com',
  'https://www.gt-world-challenge-australia.com',
];

/**
 * Resultados en HTML de la misma fecha en otro sitio de SRO: el IGTC solo publica PDF (de cronometrajes distintos en
 * cada carrera), pero las 24 Horas de Spa y las 8 Horas de Indianápolis también son fechas del GT World Challenge
 * Europe y America, que publican la tabla por sesión. Se busca en el calendario de cada sitio un evento con las
 * mismas fechas. [] si no hay (Bathurst, Nürburgring y Suzuka solo son del IGTC).
 */
async function sisterResultLinks(entry: CalendarEntry, ctx: RecipeContext): Promise<SroResultLink[]> {
  const out: SroResultLink[] = [];
  for (const origin of SISTER_SITES) {
    try {
      const calUrl = `${origin}/calendar`;
      const cal = await sroCalendarPage((await ctx.http.text(calUrl)).body, calUrl, ctx);
      const twin = cal.find((e) => e.url && e.dateStart <= entry.dateEnd && e.dateEnd >= entry.dateStart && Math.abs(Date.parse(e.dateEnd) - Date.parse(entry.dateEnd)) <= 86_400_000);
      if (!twin?.url) continue;
      const resultsUrl = sroResultsUrl(await page(ctx, twin.url), twin.url);
      if (!resultsUrl) continue;
      out.push(...sroResultLinks(await page(ctx, resultsUrl), resultsUrl).filter((l) => l.kind === 'html'));
    } catch {
      // Sitio hermano caído o con otro formato: quedan los PDF propios del IGTC.
    }
  }
  return out;
}

/** Margen tras la largada antes de aceptar el resultado de una carrera (la página se completa al final). */
function raceWaitMs(entry: CalendarEntry, s: Session): number {
  const hours = sroRaceHours(eventHint(entry), s.originalName ?? s.name) ?? (/main\s+race/i.test(s.originalName ?? s.name) ? 6 : 2);
  return (hours + 1) * 3600_000;
}

/** Une cada sesión pedida con su resultado publicado (mismo nombre; si se repite, por orden). */
export function matchResultLinks(sessions: Session[], links: SroResultLink[]): Map<string, SroResultLink> {
  const byKey = new Map<string, SroResultLink[]>();
  for (const l of links) {
    const k = sroKey(l.label);
    const list = byKey.get(k) ?? [];
    list.push(l);
    byKey.set(k, list);
  }
  // Primero la tabla HTML (si el mismo resultado también está en PDF) y, entre homónimos, en el orden de carga.
  for (const list of byKey.values()) list.sort((a, b) => Number(a.kind === 'pdf') - Number(b.kind === 'pdf') || (a.id ?? 0) - (b.id ?? 0));
  const out = new Map<string, SroResultLink>();
  const used = new Map<string, number>();
  for (const s of [...sessions].sort((a, b) => a.startUtc.localeCompare(b.startUtc))) {
    const k = sroKey(s.originalName ?? s.name);
    const list = byKey.get(k);
    if (!list?.length) continue;
    const i = used.get(k) ?? 0;
    used.set(k, i + 1);
    const link = list[Math.min(i, list.length - 1)];
    if (link) out.set(s.id, link);
  }
  return out;
}

/**
 * Resultados de un evento de SRO. null si el evento todavía no tiene página de resultados con sesiones.
 * Las carreras se aceptan recién un rato después de su duración prevista (las 24 Horas, 24 h + 1 h): antes quedan
 * diferidas sin contar como intento.
 */
export async function sroResults(entry: CalendarEntry, sessions: Session[], ctx: RecipeContext): Promise<ResultsFound | null> {
  if (!entry.url) return null;
  const eventHtml = await page(ctx, entry.url);
  const resultsUrl = sroResultsUrl(eventHtml, entry.url);
  if (!resultsUrl) return null;
  const html = await page(ctx, resultsUrl);
  const links = sroResultLinks(html, resultsUrl);
  if (/(^|\.)intercontinentalgtchallenge\.com$/.test(new URL(resultsUrl).hostname)) links.push(...(await sisterResultLinks(entry, ctx)));
  if (links.length === 0) return null;
  const nowIso = isoNow(ctx.now);
  const title = heading(html) || `Resultados ${entry.name}`;
  const matched = matchResultLinks(sessions, links);
  const found: SessionResultFound[] = [];
  const deferred: string[] = [];
  for (const s of sessions) {
    const link = matched.get(s.id);
    if (!link) continue;
    const isRace = s.type === 'carrera' || s.type === 'sprint';
    if (isRace && ctx.now.getTime() < Date.parse(s.startUtc) + raceWaitMs(entry, s)) {
      deferred.push(s.id);
      continue;
    }
    let rows: ResultRow[];
    let docTitle = `${link.label} — ${title}`;
    try {
      if (link.kind === 'html') {
        const sessionHtml = await page(ctx, link.url);
        rows = sroHtmlRows(sessionHtml, isRace);
        docTitle = heading(sessionHtml) || docTitle;
      } else {
        rows = await sroPdfRows((await ctx.http.bytes(link.url)).body);
      }
    } catch (err) {
      // Una sesión ilegible no tumba las demás del evento; si el sitio pidió esperar, no cuenta como intento.
      if (err instanceof HttpError && (err.status === 429 || err.status >= 500)) deferred.push(s.id);
      continue;
    }
    if (rows.length === 0) continue;
    const source: Source = { url: link.url, title: docTitle, kind: link.kind, method: 'directo', fetchedAt: nowIso };
    found.push({ sessionId: s.id, rows, source });
  }
  return {
    sessions: found,
    source: { url: resultsUrl, title, kind: 'html', method: 'directo', fetchedAt: nowIso },
    ...(deferred.length ? { deferred } : {}),
  };
}
