/**
 * Repco Supercars Championship (supercars.com). El sitio es Next.js (App Router) y trae los datos de Contentful
 * en el payload RSC (self.__next_f.push), que extractEmbeddedJson ya sabe leer:
 * - /calendar: eventos de la temporada vigente y de la siguiente (título, slug, "Adelaide, SA", fechas con offset).
 * - /events/<slug>/schedule: todas las sesiones del fin de semana, de todas las categorías (series.name).
 * - /drivers: tarjetas de cada auto (piloto, co-piloto de los enduros, número, equipo, modelo).
 * - /standings/<año>/supercars y /teams: tablas HTML ya renderizadas en el servidor.
 *
 * Las horas se toman como hora local del circuito (la parte "HH:MM" del ISO) y se convierten con la zona del
 * estado: en Contentful el offset lo carga a mano el editor y a veces está mal (p. ej. Christchurch 2027 con +10:00).
 */
import { localToUtc, type RosterRow, type StandingsRow } from '@dm/shared';
import { attr, extractEmbeddedJson, textOf } from '../extract/html.ts';
import { checkStandingsTable, column, host, isoNow, obj, pageOrNull, parseHtmlTable, parseNumber, standingsSource, str } from './kit.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, SessionsFound, SiteRecipe } from './types.ts';

const BASE = 'https://www.supercars.com';

/** Estado o país de "Adelaide, SA" / "Taupō, NZ" / "Mallala, South Australia" -> zona IANA. */
const STATES: [RegExp, string][] = [
  [/\b(NSW|New South Wales|ACT)\b/i, 'Australia/Sydney'],
  [/\b(VIC|Victoria)\b/i, 'Australia/Melbourne'],
  [/\b(QLD|Queensland)\b/i, 'Australia/Brisbane'],
  [/\b(SA|South Australia)\b/i, 'Australia/Adelaide'],
  [/\b(WA|Western Australia)\b/i, 'Australia/Perth'],
  [/\b(NT|Northern Territory)\b/i, 'Australia/Darwin'],
  [/\b(TAS|Tasmania)\b/i, 'Australia/Hobart'],
  [/\b(NZ|New Zealand)\b/i, 'Pacific/Auckland'],
];

/** Circuito de cada evento (el calendario solo publica la ciudad). Se busca por el slug del evento. */
const CIRCUITS: [RegExp, string][] = [
  [/sydney/, 'Sydney Motorsport Park'],
  [/melbourne|albert-park|grand-prix/, 'Albert Park Circuit'],
  [/taupo/, 'Taupo International Motorsport Park'],
  [/christchurch|ruapuna/, 'Ruapuna Park'],
  [/tasmania|symmons/, 'Symmons Plains Raceway'],
  [/darwin/, 'Hidden Valley Raceway'],
  [/townsville/, 'Reid Park Street Circuit'],
  [/perth|wanneroo/, 'Wanneroo Raceway'],
  [/ipswich|queensland-raceway/, 'Queensland Raceway'],
  [/the-bend/, 'The Bend Motorsport Park'],
  [/bathurst/, 'Mount Panorama Circuit'],
  [/gold-coast|surfers/, 'Surfers Paradise Street Circuit'],
  [/sandown/, 'Sandown Raceway'],
  [/phillip-island/, 'Phillip Island Grand Prix Circuit'],
  [/adelaide/, 'Adelaide Parklands Circuit'],
  [/pukekohe|auckland/, 'Pukekohe Park Raceway'],
];

export function supercarsTimeZone(location: string): string {
  return STATES.find(([re]) => re.test(location))?.[1] ?? 'Australia/Sydney';
}

/** Todos los objetos del JSON (a cualquier profundidad) que cumplan el predicado. */
function collect(value: unknown, pred: (o: Record<string, unknown>) => boolean, out: Record<string, unknown>[] = [], depth = 0): Record<string, unknown>[] {
  if (depth > 40 || !value || typeof value !== 'object') return out;
  if (!Array.isArray(value) && pred(value as Record<string, unknown>)) {
    out.push(value as Record<string, unknown>);
    return out;
  }
  for (const v of Array.isArray(value) ? value : Object.values(value as Record<string, unknown>)) collect(v, pred, out, depth + 1);
  return out;
}

/** "2026-11-27T13:10:00.000+10:30" -> fecha y hora tal como se ven en el circuito. */
const wallClock = (iso: string) => {
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? { date: m[1]!, time: m[2]! } : null;
};

export function supercarsCalendar(html: string, season: number): CalendarEntry[] {
  const events = new Map<string, Record<string, unknown>>();
  for (const v of extractEmbeddedJson(html)) {
    for (const ev of collect(v, (o) => typeof o.slug === 'string' && typeof o.startDate === 'string' && typeof o.location === 'string')) {
      events.set(str(ev.slug), ev);
    }
  }
  const rows = [...events.values()]
    .map((ev) => ({ ev, start: wallClock(str(ev.startDate)), end: wallClock(str(ev.endDate)) }))
    .filter((r) => r.start && r.start.date.startsWith(String(season)))
    // Las fechas exclusivas de las categorías soporte (p. ej. "Mallala Super2 Round") no son del campeonato.
    .filter((r) => !/super\s*[23]\b|super[23]-/i.test(`${str(r.ev.title)} ${str(r.ev.slug)}`))
    .sort((a, b) => a.start!.date.localeCompare(b.start!.date));
  return rows.map(({ ev, start, end }, i) => {
    const slug = str(ev.slug);
    const location = str(ev.location);
    const tz = supercarsTimeZone(location);
    const city = location.split(',')[0]!.trim();
    return {
      name: str(ev.title).replace(/^\d{4}\s+/, '').trim(),
      circuit: CIRCUITS.find(([re]) => re.test(slug))?.[1] ?? city,
      country: tz === 'Pacific/Auckland' ? 'New Zealand' : 'Australia',
      tz,
      dateStart: start!.date,
      dateEnd: end && end.date >= start!.date ? end.date : start!.date,
      // El orden de la temporada es el número de fecha (el sitio no lo publica en el calendario).
      round: i + 1,
      url: `${BASE}/events/${slug}`,
      meta: { slug },
    };
  });
}

/** Nombre de la sesión sin el patrocinador ("Boost Mobile TTSO (Race 36)" -> "Top 10 Shootout (Race 36)"). */
export function supercarsSessionName(name: string): string {
  const n = name.replace(/\bTTSO\b/g, 'Top 10 Shootout').replace(/\s+/g, ' ').trim();
  const at = n.search(/co-?driver\b|practice|qualifying|top\s*10\s*shootout|shootout|warm[\s-]?up|\brace\b/i);
  return at > 0 ? n.slice(at) : n;
}

export function supercarsSessions(html: string, tz: string): ExtractedSession[] {
  const seen = new Set<string>();
  const out: ExtractedSession[] = [];
  const names = new Map<string, number>();
  const items: Record<string, unknown>[] = [];
  for (const v of extractEmbeddedJson(html)) {
    items.push(...collect(v, (o) => 'natsoftEventCode' in o && typeof o.startDate === 'string' && typeof o.name === 'string'));
  }
  for (const s of items) {
    // Solo el campeonato principal: el mismo cronograma trae Super2, Carrera Cup, GT, SuperUtes, etc.
    if (!/supercars championship/i.test(str(obj(s.series).name))) continue;
    if (/on track activity/i.test(str(s.type))) continue;
    const start = wallClock(str(s.startDate));
    if (!start) continue;
    // La misma sesión aparece en varias listas del payload (cronograma completo, resumen de carreras).
    const key = `${str(s.name)}|${str(s.startDate)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const base = supercarsSessionName(str(s.name));
    const n = (names.get(base) ?? 0) + 1;
    names.set(base, n);
    const end = wallClock(str(s.endDate));
    out.push({
      name: n > 1 ? `${base} (${n})` : base,
      startUtc: localToUtc(start.date, start.time, tz),
      ...(end && `${end.date}T${end.time}` > `${start.date}T${start.time}` ? { endUtc: localToUtc(end.date, end.time, tz) } : {}),
      localStartText: start.time,
    });
  }
  return out.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
}

/** Tabla de pilotos: "Pos | Driver | Wins | Poles | Pts | Gap"; la celda del piloto trae número, nombre y equipo. */
export function supercarsDriverStandings(html: string): StandingsRow[] {
  const table = html.match(/<table\b[\s\S]*?<\/table>/i)?.[0] ?? '';
  const { headers, rows } = parseHtmlTable(table);
  const iPos = column(headers, /^pos/i);
  const iDriver = column(headers, /^driver/i);
  const iWins = column(headers, /^wins/i);
  const iPts = column(headers, /^(pts|points)/i);
  if (iPos < 0 || iDriver < 0 || iPts < 0) throw new Error(`Supercars: columnas inesperadas en el campeonato de pilotos: ${headers.join(' | ')}`);
  const out = rows.map((r) => {
    const cell = r[iDriver] ?? '';
    const name = attr(cell.match(/<a\b[^>]*>/)?.[0] ?? '', 'aria-label') ?? textOf(cell);
    const number = textOf(cell.match(/<span\b[^>]*>([\s\S]*?)<\/span>/)?.[1] ?? '');
    const team = textOf(cell.match(/<div aria-label="[^"]*">[\s\S]*?<\/div><\/div><div\b[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '');
    const wins = iWins >= 0 ? parseNumber(textOf(r[iWins] ?? '')) : null;
    return {
      pos: parseNumber(textOf(r[iPos] ?? '')) ?? 0,
      name: textOf(name),
      ...(team ? { team } : {}),
      ...(number ? { number } : {}),
      points: parseNumber(textOf(r[iPts] ?? '')) ?? NaN,
      ...(wins !== null ? { wins } : {}),
    };
  });
  // Igual que en equipos: sin posición (0) es que todavía no corrió.
  return out.filter((r) => r.pos >= 1);
}

/** Tabla de equipos: la primera celda trae la posición y el nombre comercial del equipo (aria-label del link). */
export function supercarsTeamStandings(html: string): StandingsRow[] {
  const table = html.match(/<table\b[\s\S]*?<\/table>/i)?.[0] ?? '';
  const { headers, rows } = parseHtmlTable(table);
  const iPts = column(headers, /^(pts|points)/i);
  if (iPts < 0) throw new Error(`Supercars: columnas inesperadas en el campeonato de equipos: ${headers.join(' | ')}`);
  const out: StandingsRow[] = [];
  for (const r of rows) {
    const cell = r[0] ?? '';
    // Posición: el primer <div> que solo tiene un número (el nombre puede tener dígitos: "Team 18").
    // Los equipos que todavía no corrieron (wildcards) figuran al final con posición 0.
    const pos = Number(cell.match(/>\s*(\d+)\s*<\/div>/)?.[1] ?? 0);
    if (pos < 1) continue;
    out.push({
      pos,
      name: textOf(attr(cell.match(/<a\b[^>]*>/)?.[0] ?? '', 'aria-label') ?? ''),
      points: parseNumber(textOf(r[iPts] ?? '')) ?? NaN,
    });
  }
  return out;
}

/** Año de la página según su <title> ("… | Standings 2026 | Supercars", "2026 Repco Supercars Championship | Drivers"). */
const titleOf = (html: string) => textOf(html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] ?? '');

/** Texto de un campo del payload RSC ("$undefined" es como Next.js serializa undefined). */
const rscStr = (v: unknown) => {
  const s = str(v).trim();
  return s.startsWith('$undefined') ? '' : s;
};

/**
 * Una fila por piloto de cada tarjeta: titulares, co-pilotos de los enduros (Sandown, Bathurst), reemplazos y
 * wildcards. Un mismo piloto puede tener varias tarjetas (co-piloto y reemplazo del mismo auto): se deduplica.
 */
export function supercarsRoster(html: string): RosterRow[] {
  const rows: RosterRow[] = [];
  const seen = new Set<string>();
  const add = (driver: string, row: Omit<RosterRow, 'driver'>) => {
    const key = `${driver}|${row.number ?? ''}`.toLowerCase();
    if (!driver || seen.has(key)) return;
    seen.add(key);
    rows.push({ driver, ...row });
  };
  for (const v of extractEmbeddedJson(html)) {
    for (const c of collect(v, (o) => 'carNumber' in o && !!o.driver && typeof o.driver === 'object')) {
      const driver = obj(c.driver);
      const team = rscStr(driver.teamName) || rscStr(c.carName);
      const number = rscStr(c.carNumber);
      const vehicle = rscStr(c.carMakeModel);
      const row = { ...(team ? { team } : {}), ...(number ? { number } : {}), ...(vehicle ? { vehicle } : {}) };
      add(rscStr(driver.name), row);
      add(rscStr(obj(obj(c.coDriver).driver).name), row);
    }
  }
  return rows;
}

const standingsUrl = (season: number, teams = false) => `${BASE}/standings/${season}/supercars${teams ? '/teams' : ''}`;

export const supercars: SiteRecipe = {
  name: 'supercars',
  match: (url) => host(url) === 'supercars.com',
  calendarUrl: () => `${BASE}/calendar`,
  calendar: (doc, ctx) => supercarsCalendar(doc.raw, ctx.season),
  async sessions(entry, ctx): Promise<SessionsFound | null> {
    const slug = entry.meta?.slug;
    if (!slug) return null;
    const url = `${BASE}/events/${slug}/schedule`;
    const html = await pageOrNull(ctx, url);
    if (!html) return null;
    const sessions = supercarsSessions(html, entry.tz);
    if (sessions.length === 0) return null;
    return { sessions, source: { url, title: `Schedule — ${entry.name}`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) } };
  },
  async standings(_url, ctx) {
    // La URL configurada es /standings (redirige en el navegador a la temporada vigente): se pide la del año.
    const url = standingsUrl(ctx.season);
    const html = await pageOrNull(ctx, url);
    if (!html) return null;
    const year = Number(titleOf(html).match(/Standings\s+(\d{4})/i)?.[1]);
    if (year && year !== ctx.season) return null;
    const drivers = supercarsDriverStandings(html);
    // Temporada sin carreras todavía: la tabla existe pero sin filas.
    if (drivers.length === 0) return null;
    const tables = [checkStandingsTable({ title: 'Pilotos', rows: drivers })];
    const teamsHtml = await pageOrNull(ctx, standingsUrl(ctx.season, true));
    const teams = teamsHtml ? supercarsTeamStandings(teamsHtml) : [];
    try {
      if (teams.length) tables.push(checkStandingsTable({ title: 'Equipos', rows: teams }));
    } catch {
      // La tabla oficial de equipos a veces saltea posiciones (en 2026 pasa del 13 al 15): no se inventa la
      // numeración ni se descarta el campeonato de pilotos por eso; los equipos quedan afuera.
    }
    return { tables, source: standingsSource(url, `Supercars ${ctx.season} — Standings`, ctx) };
  },
  async roster(url, ctx: RecipeContext) {
    const html = await pageOrNull(ctx, url);
    if (!html) return null;
    // "2026 Repco Supercars Championship | Drivers": la grilla publicada es la de la temporada del título.
    const year = Number(titleOf(html).match(/^(\d{4})\b/)?.[1]);
    if (year && year !== ctx.season) return null;
    const rows = supercarsRoster(html);
    if (rows.length === 0) throw new Error('Supercars: la página de pilotos no tiene las tarjetas esperadas');
    return { rows, source: { url, title: titleOf(html) || `Supercars ${ctx.season} — Drivers`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) } };
  },
};
