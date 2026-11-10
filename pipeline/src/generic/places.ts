/**
 * Zonas horarias y fechas para los lectores deterministas: país (nombre en inglés/español, ISO2 o ISO3)
 * -> zona IANA, con estados de EE. UU. y Australia para los países con varios husos.
 */
import { DateTime } from 'luxon';
import { normalizeForMatch } from '../validate.ts';

interface Country {
  name: string;
  tz: string;
  codes: string[];
  aliases?: string[];
}

const COUNTRIES: Country[] = [
  { name: 'Argentina', tz: 'America/Argentina/Buenos_Aires', codes: ['AR', 'ARG'] },
  { name: 'Australia', tz: 'Australia/Sydney', codes: ['AU', 'AUS'] },
  { name: 'Austria', tz: 'Europe/Vienna', codes: ['AT', 'AUT'] },
  { name: 'Azerbaijan', tz: 'Asia/Baku', codes: ['AZ', 'AZE'], aliases: ['azerbaiyan'] },
  { name: 'Bahrain', tz: 'Asia/Bahrain', codes: ['BH', 'BHR'], aliases: ['barein', 'bahrein'] },
  { name: 'Belgium', tz: 'Europe/Brussels', codes: ['BE', 'BEL'], aliases: ['belgica'] },
  { name: 'Brazil', tz: 'America/Sao_Paulo', codes: ['BR', 'BRA'], aliases: ['brasil'] },
  { name: 'Canada', tz: 'America/Toronto', codes: ['CA', 'CAN'] },
  { name: 'Chile', tz: 'America/Santiago', codes: ['CL', 'CHL'] },
  { name: 'China', tz: 'Asia/Shanghai', codes: ['CN', 'CHN'] },
  { name: 'Czech Republic', tz: 'Europe/Prague', codes: ['CZ', 'CZE'], aliases: ['czechia', 'republica checa'] },
  { name: 'Denmark', tz: 'Europe/Copenhagen', codes: ['DK', 'DNK'] },
  { name: 'Finland', tz: 'Europe/Helsinki', codes: ['FI', 'FIN'] },
  { name: 'France', tz: 'Europe/Paris', codes: ['FR', 'FRA'], aliases: ['francia'] },
  { name: 'Germany', tz: 'Europe/Berlin', codes: ['DE', 'DEU', 'GER'], aliases: ['alemania', 'deutschland'] },
  { name: 'Great Britain', tz: 'Europe/London', codes: ['GB', 'GBR', 'UK'], aliases: ['united kingdom', 'england', 'gran bretana', 'reino unido', 'inglaterra'] },
  { name: 'Hungary', tz: 'Europe/Budapest', codes: ['HU', 'HUN'], aliases: ['hungria'] },
  { name: 'India', tz: 'Asia/Kolkata', codes: ['IN', 'IND'] },
  { name: 'Indonesia', tz: 'Asia/Makassar', codes: ['ID', 'IDN'] },
  { name: 'Italy', tz: 'Europe/Rome', codes: ['IT', 'ITA'], aliases: ['italia'] },
  { name: 'Japan', tz: 'Asia/Tokyo', codes: ['JP', 'JPN'], aliases: ['japon'] },
  { name: 'Kazakhstan', tz: 'Asia/Almaty', codes: ['KZ', 'KAZ'] },
  { name: 'Korea', tz: 'Asia/Seoul', codes: ['KR', 'KOR'], aliases: ['south korea', 'corea'] },
  { name: 'Macau', tz: 'Asia/Macau', codes: ['MO', 'MAC'], aliases: ['macao'] },
  { name: 'Malaysia', tz: 'Asia/Kuala_Lumpur', codes: ['MY', 'MYS', 'MAS'], aliases: ['malasia'] },
  { name: 'Mexico', tz: 'America/Mexico_City', codes: ['MX', 'MEX'] },
  { name: 'Monaco', tz: 'Europe/Monaco', codes: ['MC', 'MCO', 'MON'] },
  { name: 'Morocco', tz: 'Africa/Casablanca', codes: ['MA', 'MAR'], aliases: ['marruecos'] },
  { name: 'Netherlands', tz: 'Europe/Amsterdam', codes: ['NL', 'NLD', 'NED'], aliases: ['holland', 'paises bajos', 'holanda'] },
  { name: 'New Zealand', tz: 'Pacific/Auckland', codes: ['NZ', 'NZL'], aliases: ['nueva zelanda'] },
  { name: 'Paraguay', tz: 'America/Asuncion', codes: ['PY', 'PRY'] },
  { name: 'Poland', tz: 'Europe/Warsaw', codes: ['PL', 'POL'] },
  { name: 'Portugal', tz: 'Europe/Lisbon', codes: ['PT', 'PRT', 'POR'] },
  { name: 'Qatar', tz: 'Asia/Qatar', codes: ['QA', 'QAT'] },
  { name: 'Saudi Arabia', tz: 'Asia/Riyadh', codes: ['SA', 'SAU', 'KSA'], aliases: ['arabia saudita', 'arabia saudi'] },
  { name: 'Singapore', tz: 'Asia/Singapore', codes: ['SG', 'SGP'], aliases: ['singapur'] },
  { name: 'Slovakia', tz: 'Europe/Bratislava', codes: ['SK', 'SVK'] },
  { name: 'South Africa', tz: 'Africa/Johannesburg', codes: ['ZA', 'ZAF', 'RSA'], aliases: ['sudafrica'] },
  { name: 'Spain', tz: 'Europe/Madrid', codes: ['ES', 'ESP'], aliases: ['espana'] },
  { name: 'Sweden', tz: 'Europe/Stockholm', codes: ['SE', 'SWE'] },
  { name: 'Switzerland', tz: 'Europe/Zurich', codes: ['CH', 'CHE', 'SUI'] },
  { name: 'Thailand', tz: 'Asia/Bangkok', codes: ['TH', 'THA'], aliases: ['tailandia'] },
  { name: 'Turkey', tz: 'Europe/Istanbul', codes: ['TR', 'TUR'], aliases: ['turkiye', 'turquia'] },
  { name: 'United Arab Emirates', tz: 'Asia/Dubai', codes: ['AE', 'ARE', 'UAE'], aliases: ['abu dhabi', 'dubai', 'emiratos arabes unidos'] },
  { name: 'United States', tz: 'America/New_York', codes: ['US', 'USA'], aliases: ['united states of america', 'estados unidos', 'eeuu', 'ee. uu.'] },
  { name: 'Uruguay', tz: 'America/Montevideo', codes: ['UY', 'URY', 'URU'] },
  { name: 'Vietnam', tz: 'Asia/Ho_Chi_Minh', codes: ['VN', 'VNM'] },
];

const US_STATES: Record<string, string> = {
  alabama: 'America/Chicago', alaska: 'America/Anchorage', arizona: 'America/Phoenix', arkansas: 'America/Chicago',
  california: 'America/Los_Angeles', colorado: 'America/Denver', connecticut: 'America/New_York', delaware: 'America/New_York',
  florida: 'America/New_York', georgia: 'America/New_York', hawaii: 'Pacific/Honolulu', idaho: 'America/Boise',
  illinois: 'America/Chicago', indiana: 'America/Indiana/Indianapolis', iowa: 'America/Chicago', kansas: 'America/Chicago',
  kentucky: 'America/New_York', louisiana: 'America/Chicago', maine: 'America/New_York', maryland: 'America/New_York',
  massachusetts: 'America/New_York', michigan: 'America/Detroit', minnesota: 'America/Chicago', mississippi: 'America/Chicago',
  missouri: 'America/Chicago', montana: 'America/Denver', nebraska: 'America/Chicago', nevada: 'America/Los_Angeles',
  'new hampshire': 'America/New_York', 'new jersey': 'America/New_York', 'new mexico': 'America/Denver', 'new york': 'America/New_York',
  'north carolina': 'America/New_York', 'north dakota': 'America/Chicago', ohio: 'America/New_York', oklahoma: 'America/Chicago',
  oregon: 'America/Los_Angeles', pennsylvania: 'America/New_York', 'rhode island': 'America/New_York', 'south carolina': 'America/New_York',
  'south dakota': 'America/Chicago', tennessee: 'America/Chicago', texas: 'America/Chicago', utah: 'America/Denver',
  vermont: 'America/New_York', virginia: 'America/New_York', washington: 'America/Los_Angeles', 'west virginia': 'America/New_York',
  wisconsin: 'America/Chicago', wyoming: 'America/Denver', ontario: 'America/Toronto', 'british columbia': 'America/Vancouver',
  alberta: 'America/Edmonton', quebec: 'America/Toronto',
};

const AU_STATES: Record<string, string> = {
  'south australia': 'Australia/Adelaide', adelaide: 'Australia/Adelaide', bend: 'Australia/Adelaide', tailem: 'Australia/Adelaide',
  victoria: 'Australia/Melbourne', 'phillip island': 'Australia/Melbourne', melbourne: 'Australia/Melbourne', sandown: 'Australia/Melbourne',
  queensland: 'Australia/Brisbane', 'queensland raceway': 'Australia/Brisbane', 'gold coast': 'Australia/Brisbane',
  'western australia': 'Australia/Perth', wanneroo: 'Australia/Perth', perth: 'Australia/Perth',
  tasmania: 'Australia/Hobart', symmons: 'Australia/Hobart', 'northern territory': 'Australia/Darwin', hidden: 'Australia/Darwin',
  bathurst: 'Australia/Sydney', sydney: 'Australia/Sydney', 'mount panorama': 'Australia/Sydney',
};

/** Circuitos/ciudades de EE. UU. y Canadá frecuentes cuando la fuente no informa el estado. */
const NA_PLACES: Record<string, string> = {
  'las vegas': 'America/Los_Angeles', 'long beach': 'America/Los_Angeles', 'laguna seca': 'America/Los_Angeles',
  monterey: 'America/Los_Angeles', sonoma: 'America/Los_Angeles', portland: 'America/Los_Angeles',
  austin: 'America/Chicago', 'circuit of the americas': 'America/Chicago', cota: 'America/Chicago',
  'road america': 'America/Chicago', elkhart: 'America/Chicago', barber: 'America/Chicago', nashville: 'America/Chicago',
  gateway: 'America/Chicago', milwaukee: 'America/Chicago', 'st. louis': 'America/Chicago',
  indianapolis: 'America/Indiana/Indianapolis', detroit: 'America/Detroit', miami: 'America/New_York',
  sebring: 'America/New_York', daytona: 'America/New_York', 'road atlanta': 'America/New_York', 'watkins glen': 'America/New_York',
  'mid-ohio': 'America/New_York', 'mid ohio': 'America/New_York', 'st. petersburg': 'America/New_York', 'lime rock': 'America/New_York',
  vir: 'America/New_York', toronto: 'America/Toronto', montreal: 'America/Toronto', 'mosport': 'America/Toronto',
  'canadian tire': 'America/Toronto', 'mexico city': 'America/Mexico_City',
};

export function normalizeKey(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findCountry(country: string): Country | undefined {
  const key = normalizeKey(country);
  if (!key) return undefined;
  const upper = country.trim().toUpperCase();
  return COUNTRIES.find(
    (c) => normalizeKey(c.name) === key || c.codes.includes(upper) || (c.aliases ?? []).includes(key),
  );
}

/** Nombre del país en inglés a partir de un nombre, ISO2 o ISO3 (o el texto original si no se conoce). */
export function countryName(country: string): string {
  return findCountry(country)?.name ?? country.trim();
}

/**
 * Zona IANA para un país (y, si hace falta, el lugar: "St. Petersburg, Florida", "Adelaide").
 * Devuelve null si no se puede determinar.
 */
export function guessTimeZone(country: string, place = ''): string | null {
  const c = findCountry(country);
  const p = normalizeKey(place);
  if (!c || c.name === 'United States' || c.name === 'Canada') {
    for (const [state, tz] of Object.entries(US_STATES)) if (new RegExp(`\\b${state}\\b`).test(p)) return tz;
    for (const [key, tz] of Object.entries(NA_PLACES)) if (p.includes(key)) return tz;
  }
  if (c?.name === 'Australia') {
    for (const [key, tz] of Object.entries(AU_STATES)) if (p.includes(key)) return tz;
  }
  return c?.tz ?? null;
}

const MONTHS: Record<string, number> = {};
const MONTH_NAMES: string[][] = [
  ['january', 'jan', 'enero', 'ene', 'januar', 'janvier', 'gennaio', 'janeiro', 'jän'],
  ['february', 'feb', 'febrero', 'februar', 'fevrier', 'febbraio', 'fevereiro', 'fev'],
  ['march', 'mar', 'marzo', 'märz', 'marz', 'mars', 'marco', 'maerz'],
  ['april', 'apr', 'abril', 'abr', 'avril', 'aprile'],
  ['may', 'mayo', 'mai', 'maggio', 'maio'],
  ['june', 'jun', 'junio', 'juni', 'juin', 'giugno', 'junho'],
  ['july', 'jul', 'julio', 'juli', 'juillet', 'luglio', 'julho'],
  ['august', 'aug', 'agosto', 'ago', 'aout', 'août'],
  ['september', 'sep', 'sept', 'septiembre', 'setiembre', 'set', 'septembre', 'settembre', 'setembro'],
  ['october', 'oct', 'octubre', 'oktober', 'okt', 'octobre', 'ottobre', 'outubro'],
  ['november', 'nov', 'noviembre', 'novembre', 'novembro'],
  ['december', 'dec', 'diciembre', 'dic', 'dezember', 'dez', 'decembre', 'dicembre', 'dezembro'],
];
MONTH_NAMES.forEach((names, i) => names.forEach((n) => (MONTHS[n] = i + 1)));

export function monthNumber(name: string): number | null {
  const key = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\.$/, '')
    .trim();
  return MONTHS[key] ?? MONTHS[key.slice(0, 3)] ?? null;
}

export function isoDate(year: number, month: number, day: number): string | null {
  const dt = DateTime.fromObject({ year, month, day });
  return dt.isValid ? dt.toISODate() : null;
}

export function shiftDate(date: string, days: number): string {
  return DateTime.fromISO(date).plus({ days }).toISODate()!;
}

/**
 * Interpreta rangos de fechas escritos a mano en calendarios oficiales:
 * "28 - 31 May 2026", "30 October 2026 - 1 November 2026", "18.-19.04.2026", "14.03.2026",
 * "15 y 16 de noviembre", "Mar 7", "08/02/2026". Sin año, usa `defaultYear`.
 */
export function parseDateRangeText(text: string, defaultYear: number): { start: string; end: string } | null {
  const t = text.replace(/\s+/g, ' ').trim();
  // Numéricos: 18.-19.04.2026 | 14.03.2026 | 08/02/2026 | 13/11/26
  const range = t.match(/(\d{1,2})\.?\s*[-–]\s*(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (range) {
    const y = fullYear(range[4]!);
    const s = isoDate(y, Number(range[3]), Number(range[1]));
    const e = isoDate(y, Number(range[3]), Number(range[2]));
    return s && e ? { start: s, end: e } : null;
  }
  const single = t.match(/(?<!\d)(\d{1,2})[./](\d{1,2})[./](\d{2,4})(?!\d)/);
  if (single) {
    const d = isoDate(fullYear(single[3]!), Number(single[2]), Number(single[1]));
    return d ? { start: d, end: d } : null;
  }
  // Textuales: días, meses por nombre y años en orden de aparición.
  const days: number[] = [];
  const months: number[] = [];
  const years: number[] = [];
  for (const tok of t.matchAll(/(\d{4})|(\d{1,2})(?:st|nd|rd|th|º)?|([A-Za-zÀ-ÿ]{3,}\.?)/g)) {
    if (tok[1]) years.push(Number(tok[1]));
    else if (tok[2]) days.push(Number(tok[2]));
    else if (tok[3]) {
      const m = monthNumber(tok[3]);
      if (m) months.push(m);
    }
  }
  if (days.length === 0 || months.length === 0) return null;
  const y1 = years[0] ?? defaultYear;
  const y2 = years.at(-1) ?? y1;
  const m1 = months[0]!;
  const m2 = months.at(-1)!;
  const s = isoDate(y1, m1, days[0]!);
  const e = isoDate(y2, m2, days.at(-1)!);
  if (!s || !e) return null;
  return e < s ? { start: s, end: s } : { start: s, end: e };
}

function fullYear(y: string): number {
  return y.length === 2 ? 2000 + Number(y) : Number(y);
}

/** Fecha local (YYYY-MM-DD) de un ISO con offset u hora UTC, en la zona indicada. */
export function dateInZone(iso: string, zone: string): string {
  return DateTime.fromISO(iso, { setZone: true }).setZone(zone).toISODate()!;
}

const NOISE = new Set([
  'fia', 'fanatec', 'powered', 'by', 'aws', 'championship', 'championships', 'campeonato', 'series', 'serie', 'world',
  'mundial', 'the', 'of', 'de', 'del', 'la', 'el', 'cup', 'copa', 'season', 'temporada', 'official', 'oficial', 'sportscar',
]);

/** Clave comparable de un nombre de campeonato ("GT World Challenge Australia Powered by AWS" -> "gt challenge australia"). */
export function championshipKey(name: string): string {
  return normalizeForMatch(name)
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((t) => t && !NOISE.has(t) && !/^(19|20)\d{2}$/.test(t))
    .join(' ');
}

