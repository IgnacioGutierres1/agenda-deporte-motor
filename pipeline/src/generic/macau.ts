/**
 * Gran Premio de Macao (macau.grandprix.gov.mo): un solo evento por año con varias categorías (FIA FR World Cup,
 * FIA GT World Cup, FIA F4 World Cup, Guia Race/TCR, Motorcycle GP, Greater Bay Area GT Cup…).
 *
 * El sitio es una SPA de Vue: el HTML no trae datos, pero la propia página pide el programa oficial a
 * /api/game/event_day?_locale=en&year=AAAA (días del evento con cada actividad y su horario local). De ahí salen
 * las fechas del evento y todas las sesiones en pista, nombradas con la categoría ("FIA FR World Cup - Qualifying 1").
 * Si el programa de la temporada todavía no está publicado, las fechas salen de /api/setting (la cuenta regresiva
 * de la app oficial: "19-22/11/2026").
 * Las listas de inscriptos son PDF por categoría (/api/game/entry_list), así que no hay roster determinista.
 */
import { localToUtc } from '@dm/shared';
import { dateInZone, isoDate } from './places.ts';
import { host, isoNow, obj, str } from './kit.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, SessionsFound, SiteRecipe } from './types.ts';

const BASE = 'https://www.macau.grandprix.gov.mo';
const TZ = 'Asia/Macau';
const SCHEDULE_PAGE = `${BASE}/en/info/schedule`;

export const macauProgrammeUrl = (season: number) => `${BASE}/api/game/event_day?_locale=en&year=${season}`;
const SETTING_URL = `${BASE}/api/setting?_locale=en`;

interface ProgrammeDay {
  date: string;
  items: { time: string; title: string }[];
}

/** Días del programa oficial de la temporada (vacío si la API todavía no lo publica o es de otro año). */
function programmeDays(raw: string, season: number): ProgrammeDay[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return [];
  }
  const days = obj(data).data;
  if (!Array.isArray(days)) return [];
  const out: ProgrammeDay[] = [];
  for (const d of days.map(obj)) {
    // date_timestamp es la medianoche de Macao del día; "19/11" (sin año) queda de respaldo.
    const ts = Number(d.date_timestamp);
    let date = Number.isFinite(ts) && ts > 0 ? dateInZone(new Date(ts * 1000).toISOString(), TZ) : null;
    if (!date) {
      const m = str(d.date).match(/^(\d{1,2})\/(\d{1,2})$/);
      date = m ? isoDate(season, Number(m[2]), Number(m[1])) : null;
    }
    if (!date || !date.startsWith(String(season))) continue;
    const items = (Array.isArray(d.events) ? d.events : []).map(obj).map((e) => ({ time: str(e.time), title: str(e.title) }));
    out.push({ date, items });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Categorías del programa con un nombre corto y estable: los títulos oficiales cambian de un año a otro
 * ("58th Edition", "Kumho FIA TCR World Tour Event of Macau") y a veces dentro del mismo programa (guiones distintos).
 */
const CATEGORIES: [RegExp, string][] = [
  [/\bFR World Cup|Formula Regional/i, 'FIA FR World Cup'],
  [/\bF4 World Cup|Formula 4/i, 'FIA F4 World Cup'],
  [/\bGT World Cup|Macau GT Cup/i, 'FIA GT World Cup'],
  [/Guia Race|\bTCR\b|\bWTCR\b/i, 'Guia Race TCR'],
  [/Motorcycle/i, 'Motorcycle Grand Prix'],
  [/Greater Bay Area/i, 'Greater Bay Area GT Cup'],
  [/Roadsport/i, 'Roadsport Challenge'],
];

/** Parte final del título que nombra la sesión ("Free Practice 1", "Qualification Race (8 laps)", "warm up"). */
const SESSION_PART = /^(?:free practice|practice|qualif\w*|warm[\s-]*up|(?:main|qualification|qualifying|feature|sprint)\s+race|race|heat|final)\b/i;
/** Actividades en pista que no son sesiones de competencia. */
const NOT_SESSION = /cancel|inspection|circuit (?:closed|open)|parade|ceremony|lion dance|special event|demo|track walk|pit walk|autograph|safety car/i;

/** Sesión en pista a partir de un título oficial; null si no es una sesión (inspección, ceremonias, etc.). */
export function macauSessionName(title: string): string | null {
  const clean = title.replace(/\*+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!clean || NOT_SESSION.test(clean)) return null;
  // Separadores con espacio de algún lado (" - ", "- ", " -", "–"): un guion pegado a dos palabras no separa.
  const parts = clean
    .split(/\s+[-–—]\s*|\s*[-–—]\s+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const last = parts.at(-1) ?? '';
  const hasSession = parts.length > 1 && SESSION_PART.test(last);
  const categoryText = (hasSession ? parts.slice(0, -1) : parts).join(' - ');
  const category = CATEGORIES.find(([re]) => re.test(categoryText))?.[1];
  // La carrera principal de algunas categorías figura solo con la cantidad de vueltas ("FIA GT World Cup (16 laps)").
  const laps = /\(\s*\d+\s*laps?\s*\)/i.test(clean);
  if (!category || (!hasSession && !laps)) return null;
  const session = hasSession
    ? last
        .replace(/\(\s*\d+\s*laps?\s*\)/gi, '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^warm[\s-]*up$/i, 'Warm Up')
    : 'Race';
  return `${category} - ${session.charAt(0).toUpperCase()}${session.slice(1)}`;
}

/** Sesiones en pista del programa, con horas locales de Macao. Repetidos (mismo nombre) se numeran para no pisarse. */
function programmeSessions(days: ProgrammeDay[]): ExtractedSession[] {
  const out: ExtractedSession[] = [];
  const seen = new Map<string, number>();
  for (const day of days) {
    for (const item of day.items) {
      const name = macauSessionName(item.title);
      const t = item.time.match(/^(\d{1,2}:\d{2})(?:\s*[~–-]\s*(\d{1,2}:\d{2}))?$/);
      if (!name || !t) continue;
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      const start = t[1]!.padStart(5, '0');
      out.push({
        name: n > 1 ? `${name} (${n})` : name,
        startUtc: localToUtc(day.date, start, TZ),
        ...(t[2] ? { endUtc: localToUtc(day.date, t[2], TZ) } : {}),
        localStartText: start,
      });
    }
  }
  return out;
}

/** Fechas y nombre de la edición según la configuración de la app oficial ("19-22/11/2026", "73rd Macau Grand Prix"). */
async function announcedEdition(ctx: RecipeContext): Promise<{ start: string; end: string; title: string } | null> {
  try {
    const res = await ctx.http.json<unknown>(SETTING_URL);
    const app = obj(obj(obj(obj(res.body).data).app_settings).app);
    const title = str(obj(app.title).en);
    const m = str(obj(app.date).en).match(/^(\d{1,2})(?:\s*-\s*(\d{1,2}))?\/(\d{1,2})\/(\d{4})$/);
    if (!m || Number(m[4]) !== ctx.season) return null;
    const start = isoDate(ctx.season, Number(m[3]), Number(m[1]));
    const end = isoDate(ctx.season, Number(m[3]), Number(m[2] ?? m[1]));
    return start && end ? { start, end, title } : null;
  } catch {
    // Es solo un dato de respaldo: si la API de configuración falla, el evento queda sin fecha anunciada.
    return null;
  }
}

function entry(start: string, end: string, title: string, sessions: ExtractedSession[]): CalendarEntry {
  return {
    name: title || 'Macau Grand Prix',
    circuit: 'Guia Circuit',
    country: 'Macau',
    tz: TZ,
    dateStart: start,
    dateEnd: end,
    url: SCHEDULE_PAGE,
    ...(sessions.length ? { sessions } : {}),
  };
}

export const macau: SiteRecipe = {
  name: 'macau',
  match: (url) => host(url) === 'macau.grandprix.gov.mo',
  calendarUrl: (_url, season) => macauProgrammeUrl(season),
  async calendar(doc, ctx) {
    const days = programmeDays(doc.raw, ctx.season);
    const edition = await announcedEdition(ctx);
    if (days.length > 0) {
      // Los días del programa incluyen el jueves de entrenamientos: son las fechas reales del evento.
      return [entry(days[0]!.date, days.at(-1)!.date, edition?.title ?? '', programmeSessions(days))];
    }
    return edition ? [entry(edition.start, edition.end, edition.title, [])] : [];
  },
  async sessions(_entry, ctx): Promise<SessionsFound | null> {
    const url = macauProgrammeUrl(ctx.season);
    const res = await ctx.http.text(url);
    const sessions = programmeSessions(programmeDays(res.body, ctx.season));
    if (sessions.length === 0) return null;
    return {
      sessions,
      source: { url: SCHEDULE_PAGE, title: `Schedule — Macau Grand Prix ${ctx.season}`, kind: 'api', method: 'directo', fetchedAt: isoNow(ctx.now) },
    };
  },
};
