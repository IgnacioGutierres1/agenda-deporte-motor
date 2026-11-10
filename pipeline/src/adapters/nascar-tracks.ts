/**
 * Zona horaria y país de los circuitos de NASCAR. El feed oficial solo trae el nombre del
 * circuito; las horas vienen en UTC, así que la zona se usa para fechas locales y la hora
 * local mostrada. Si un circuito no figura, se asume America/New_York (la mayoría está en el Este).
 */
export interface TrackInfo {
  tz: string;
  /** ISO 3166 alfa-2. */
  country: string;
}

const ET = 'America/New_York';
const CT = 'America/Chicago';
const MT = 'America/Denver';
const PT = 'America/Los_Angeles';

/** Se evalúan en orden: el primer patrón que coincide con track_name gana. */
const TRACKS: Array<[RegExp, TrackInfo]> = [
  // Centro
  [/texas motor|circuit of the americas|\bcota\b/i, { tz: CT, country: 'US' }],
  [/talladega/i, { tz: CT, country: 'US' }],
  [/kansas/i, { tz: CT, country: 'US' }],
  [/nashville/i, { tz: CT, country: 'US' }],
  [/chicago/i, { tz: CT, country: 'US' }],
  [/iowa|knoxville/i, { tz: CT, country: 'US' }],
  [/world wide technology|gateway/i, { tz: CT, country: 'US' }],
  [/road america|milwaukee|elkhart/i, { tz: CT, country: 'US' }],
  [/memphis/i, { tz: CT, country: 'US' }],
  // Montaña / Pacífico
  [/phoenix/i, { tz: 'America/Phoenix', country: 'US' }],
  [/colorado|pikes peak/i, { tz: MT, country: 'US' }],
  [/las vegas/i, { tz: PT, country: 'US' }],
  [/sonoma|san diego|auto club|fontana|los angeles|coliseum|portland|kern|madera|irwindale|all american/i, { tz: PT, country: 'US' }],
  // Fuera de EE. UU.
  [/hermanos rodr[ií]guez|mexico city|ciudad de m[eé]xico/i, { tz: 'America/Mexico_City', country: 'MX' }],
  [/gilles[- ]villeneuve|montr[eé]al/i, { tz: 'America/Toronto', country: 'CA' }],
  [/mosport|canadian tire|toronto/i, { tz: 'America/Toronto', country: 'CA' }],
  // Indiana (Este, con su propia zona IANA)
  [/indianapolis|lucas oil/i, { tz: 'America/Indiana/Indianapolis', country: 'US' }],
];

export function trackInfo(trackName: string): TrackInfo {
  for (const [re, info] of TRACKS) if (re.test(trackName)) return info;
  return { tz: ET, country: 'US' };
}
