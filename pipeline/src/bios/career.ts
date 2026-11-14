/**
 * Trayectoria de un piloto a partir de la tabla de su artículo de Wikipedia:
 *  - en inglés: "Career summary" / "Racing record" (Season, Series, Team, Races, Wins, Poles, Podiums, Points,
 *    Position) y, en motociclismo, "Grand Prix motorcycle racing" → "By season" (Season, Class, …, Pts, Plcd);
 *  - en español: "Resumen de carrera" (Temporada, Categoría, Equipo, Carreras, Victorias, …, Puntos, Pos.).
 * Las columnas se reconocen por el encabezado, así que no importa el orden ni las que falten. Los nombres de las
 * categorías que sigue la app se traducen a su seriesId (tabla SERIES_ALIASES).
 */
import type { BioTitle, CareerSeason } from '@dm/shared';
import { parseTables, type WikiCell, type WikiTable } from './wikitext.ts';

/** Texto sin acentos, en minúsculas y con espacios simples (para comparar nombres de categorías). */
export function plain(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’`´]/g, "'")
    .replace(/[^a-z0-9'&+.\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface SeriesAlias {
  id: string;
  re: RegExp;
  /** Primera temporada en la que el nombre corresponde a la categoría que sigue la app. */
  from?: number;
  to?: number;
}

/**
 * Nombres con los que Wikipedia (en inglés o en español) llama a las categorías que sigue la app. Se comparan
 * contra el texto de la celda y contra el destino del enlace, sin el año ("2021 Formula One World Championship").
 * Solo la misma categoría (o su nombre anterior, si es el mismo campeonato): no las de soporte ni las homónimas de
 * otra época.
 */
export const SERIES_ALIASES: SeriesAlias[] = [
  { id: 'f1', re: /^(fia )?(formula one|formula 1|f1)( world championship| season)?$|^campeonato mundial de formula 1$|^temporada de formula 1$/ },
  { id: 'f2', re: /^(fia )?formula 2( championship)?$|^campeonato de fia formula 2$/, from: 2017 },
  { id: 'f3', re: /^(fia )?formula 3( championship)?$|^campeonato de fia formula 3$/, from: 2019 },
  { id: 'f1-academy', re: /^f1 academy$/ },
  { id: 'porsche-supercup', re: /^porsche (mobil 1 )?supercup$/ },
  { id: 'motogp', re: /^motogp( world championship| class)?$|^campeonato mundial de motogp$/ },
  { id: 'moto2', re: /^moto2( world championship| class)?$|^campeonato mundial de moto2$/ },
  { id: 'moto3', re: /^moto3( world championship| class)?$|^campeonato mundial de moto3$/ },
  { id: 'indycar', re: /^((ntt |verizon |izod )?indycar( series)?|indy racing league( indycar series)?|irl indycar series)$/ },
  { id: 'indy-nxt', re: /^(indy nxt|indy lights)( series| by firestone)?$/ },
  { id: 'nascar-cup', re: /^(nascar )?((winston|nextel|sprint|monster energy) )?cup series$|^nascar cup$|^nascar winston cup$/ },
  {
    id: 'nascar-xfinity',
    re: /^(nascar )?(xfinity|nationwide|busch|busch grand national|o'reilly auto parts) series$/,
  },
  {
    id: 'nascar-truck',
    re: /^(nascar )?((craftsman|camping world|gander (rv & )?outdoors|gander rv and outdoors) )?truck series$|^nascar (craftsman|camping world) truck series$/,
  },
  { id: 'wec', re: /^(fia )?world endurance championship$|^campeonato mundial de resistencia( de la fia)?$/, from: 2012 },
  { id: 'elms', re: /^(european )?le mans series$/ },
  { id: 'alms', re: /^asian le mans series$/ },
  {
    id: 'imsa',
    re: /^((imsa )?weathertech sportscar championship|(imsa |tudor )?united sportscar championship|imsa sportscar championship|weathertech united sportscar championship)$/,
  },
  {
    id: 'gtwc-europe',
    re: /^(fanatec )?gt world challenge europe( (powered by aws|endurance cup|sprint cup))*$|^blancpain (gt series|endurance series|sprint series|gt world challenge europe)( (endurance|sprint) cup)?$/,
  },
  { id: 'gtwc-america', re: /^(fanatec )?gt world challenge america( powered by aws)?$/ },
  { id: 'gtwc-asia', re: /^(fanatec )?gt world challenge asia( powered by aws)?$|^blancpain gt series asia$/ },
  { id: 'gtwc-australia', re: /^(fanatec )?gt world challenge australia( powered by aws)?$/ },
  { id: 'gt-open', re: /^international gt open$/ },
  { id: 'igtc', re: /^intercontinental gt challenge$/ },
  { id: '24h-series', re: /^24h (gt |tce )?series$|^creventic 24h series$/ },
  { id: 'nls', re: /^(nurburgring langstrecken[- ]serie|nls|vln( endurance championship nurburgring| langstreckenmeisterschaft nurburgring)?)$/ },
  { id: 'dtm', re: /^(deutsche tourenwagen masters|dtm)$/, from: 2000 },
  { id: 'super-gt', re: /^(super gt|super gt series|autobacs super gt|all japan gt championship|jgtc)( gt500| gt300)?$/ },
  { id: 'super-formula', re: /^(japanese )?(super formula|formula nippon)( championship)?$/ },
  { id: 'super-taikyu', re: /^(eneos )?super taikyu( series)?$/ },
  {
    id: 'supercars',
    re: /^((repco |virgin australia |international |v8 )?supercars?( championship| series)?|(international )?v8 supercars? championship( series)?|australian touring car championship)$/,
    from: 1997,
  },
  { id: 'wrc', re: /^(fia )?world rally championship$|^campeonato mundial de rally(es)?$|^wrc$/ },
  { id: 'dakar', re: /^(the )?(dakar rally|rally dakar|dakar)$/ },
  { id: 'macau-gp', re: /^macau grand prix$|^gran premio de macao$/ },
  { id: 'tc', re: /^turismo carretera$/ },
  { id: 'tc-pista', re: /^tc pista$/ },
  { id: 'tc-mouras', re: /^tc mouras$/ },
  { id: 'tc-pickup', re: /^tc pick ?up$/ },
  // El TC2000 de la app es el Súper TC2000 renombrado; el "TC 2000" de 2012 a 2023 era la categoría de ascenso.
  { id: 'tc2000', re: /^(super |super-)?tc ?2000( championship| series)?$|^turismo competicion 2000$/, to: 2011 },
  { id: 'tc2000', re: /^(super |super-)tc ?2000( championship| series)?$/ },
  { id: 'tc2000', re: /^(tc ?2000( championship| series)?|turismo carretera 2000)$/, from: 2024 },
  { id: 'tn', re: /^(turismo nacional( clase [23]| c[23])?|clase [23] del turismo nacional)$/ },
  { id: 'turismo-pista', re: /^(turismo pista( clase [123])?|clase [123] del turismo pista)$/ },
];

function seriesKey(text: string): string {
  return plain(
    text
      .replace(/^anexo:\s*/i, '')
      .replace(/^temporada (19|20)\d{2}(?:[–-](?:19|20)?\d{2})? de(l| la)?\s+/i, '')
      .replace(/^(19|20)\d{2}(?:[–-](?:19|20)?\d{2})?\s+/, ''),
  )
    .replace(/^(the|la|el)\s+/, '')
    .replace(/\s+(season|temporada)$/, '');
}

const wordSet = (text: string): string[] => text.split(/[^a-z0-9]+/).filter(Boolean);

/**
 * seriesId de la app para una categoría de la trayectoria, si es una de las que sigue. Se prueba el texto de la
 * celda, el texto sin la clase ("Super GT - GT500" → "Super GT") y el destino del enlace, este último solo si
 * contiene todas las palabras del texto: "Junior World Rally Championship" suele enlazar a la temporada del WRC.
 */
export function seriesIdFor(name: string, link: string | undefined, season: number): string | undefined {
  const display = seriesKey(name);
  const keys = [display];
  const prefix = /^(.+?)\s+[-–—:]\s+/.exec(name);
  if (prefix) keys.push(seriesKey(prefix[1]!));
  if (link) {
    const target = seriesKey(link);
    const targetWords = new Set(wordSet(target));
    if (wordSet(display).every((w) => targetWords.has(w))) keys.push(target);
  }
  for (const a of SERIES_ALIASES) {
    if (a.from !== undefined && season < a.from) continue;
    if (a.to !== undefined && season > a.to) continue;
    if (keys.some((k) => a.re.test(k))) return a.id;
  }
  return undefined;
}

/** Carreras sueltas (24 Horas, Grandes Premios, 500 Millas): ganarlas no es un título de campeón. */
const SINGLE_EVENT =
  /\b\d+\s*(hours|horas|heures|stunden|ore|hour)\b|\b\d+\s*h\b(?!\s*(gt |tce )?series)|\b(hours of|horas de|grand prix|gran premio|grande premio|grand prize|race of champions|carrera de campeones|bathurst|petit le mans|invitational|all[- ]star|shootout|clash|trophy race|cup race|duel|qualifying race|indianapolis|daytona 500|world finals?|final race)\b|\b\d+\s*(miles|millas|km)\b|\bmasters\b(?!.*(series|championship|serie))/i;

/** true si la fila es un campeonato (no una carrera suelta): solo ahí el primer puesto es un título. */
function isChampionship(series: string, seriesId: string | undefined): boolean {
  if (seriesId) return seriesId !== 'macau-gp';
  return !SINGLE_EVENT.test(series);
}

const KIND: Array<[keyof Columns, RegExp]> = [
  ['season', /^(season|year|temporada|ano)$/],
  ['series', /^(series|championship|class|category|categoria|campeonato|serie|clase|competition|competicion)$/],
  ['team', /^(team|teams|entrant|equipo|escuderia|team name)$/],
  ['races', /^(races|race|starts|carreras|gp|gps|grands prix|races entered|rounds|events)$/],
  ['wins', /^(wins|win|victorias|victories|vict\.?)$/],
  ['poles', /^(poles?|pole positions?|pps?)$/],
  ['podiums', /^(podiums?|podios?)$/],
  ['points', /^(points|pts\.?|puntos|pts)$/],
  ['pos', /^(position|pos\.?|plcd|place|rank|final placing|posicion|pos|final pos\.?|standing)$/],
];

interface Columns {
  season?: number;
  series?: number;
  team?: number;
  races?: number;
  wins?: number;
  poles?: number;
  podiums?: number;
  points?: number;
  pos?: number;
}

function columnsOf(header: WikiCell[]): Columns {
  const cols: Columns = {};
  header.forEach((cell, i) => {
    const t = plain(cell.text).replace(/[.:]+$/, '');
    for (const [kind, re] of KIND) {
      if (cols[kind] === undefined && re.test(t)) {
        cols[kind] = i;
        break;
      }
    }
  });
  return cols;
}

const STAT_KINDS: Array<keyof Columns> = ['team', 'races', 'wins', 'poles', 'podiums', 'points', 'pos'];

/** Una tabla de trayectoria: encabezado con temporada y categoría (y en lo posible estadísticas). */
interface CareerTable {
  table: WikiTable;
  header: number;
  cols: Columns;
  stats: number;
}

/** Secciones que no son la trayectoria en autos o motos: karting, premios, récords, filmografía. */
const SKIP_SECTIONS =
  /karting|\bkart\b|award|premio|reconocimiento|honou?r|distinci|nominat|\brecords\b|récords|filmograf|discograf|televis|video ?game|videojuego|media\b|bibliograf/i;

function careerTable(table: WikiTable): CareerTable | null {
  if (table.headings.some((h) => SKIP_SECTIONS.test(h))) return null;
  const header = table.rows.findIndex((r) => r.length >= 2 && r.every((c) => c.header));
  if (header < 0 || header > 2) return null;
  const cols = columnsOf(table.rows[header]!);
  if (cols.season === undefined || cols.series === undefined) return null;
  const stats = STAT_KINDS.filter((k) => cols[k] !== undefined).length;
  return { table, header, cols, stats };
}

const EMPTY = /^(n\/?a|s\/d|—|–|-|\?|tbd|tba|—|nc|n\.c\.|dnq|dns|dnf|wd|ex|dsq|ret|inv)$/i;

function cleanName(text: string): string {
  return text
    .replace(/^(debut en|debut in)\s+/i, '')
    .replace(/[†‡*§#^¹²³]+/g, '')
    .replace(/\s*\((?:part[- ]time|guest|invitado|wildcard|wild card)\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTeam(text: string): string | undefined {
  const t = cleanName(text);
  return t && !EMPTY.test(t) && !/^(none|ninguno|privado|private|privateer)$/i.test(t) ? t : undefined;
}

function int(text: string | undefined): number | undefined {
  const m = text ? /^\s*(\d{1,4})(?!\d|[.,]\d)/.exec(text.replace(/[†‡*]/g, '')) : null;
  return m ? Number(m[1]) : undefined;
}

function points(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const t = text.replace(/[†‡*\s]/g, '');
  if (/^\d{1,3}(,\d{3})+$/.test(t)) return Number(t.replace(/,/g, ''));
  const m = /^(\d+)(?:[.,](\d+))?/.exec(t);
  if (!m) return undefined;
  const n = Number(m[2] ? `${m[1]}.${m[2]}` : m[1]);
  return Number.isFinite(n) ? n : undefined;
}

/** "1st", "3.º", "12th‡", "1º" → número; "NC", "—", "N/A" → nada. */
function position(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const t = text.replace(/[†‡*]/g, '').trim();
  const m = /^(\d{1,3})\s*(?:st|nd|rd|th|º|°|\.º|\.°|\.ª|ª|\.|$)/i.exec(t);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 ? n : undefined;
}

function seasonOf(text: string): number | undefined {
  const m = /\b(19[0-9]{2}|20[0-9]{2})\b/.exec(text);
  return m ? Number(m[1]) : undefined;
}

/** Filas de una tabla de trayectoria ya reconocida. */
function rowsOf(t: CareerTable): CareerSeason[] {
  const out: CareerSeason[] = [];
  const { cols } = t;
  const at = (row: WikiCell[], k: keyof Columns): WikiCell | undefined => (cols[k] === undefined ? undefined : row[cols[k]!]);
  for (const row of t.table.rows.slice(t.header + 1)) {
    if (row.every((c) => c.header)) continue;
    const seasonCell = at(row, 'season');
    const seriesCell = at(row, 'series');
    const season = seasonCell ? seasonOf(seasonCell.text) : undefined;
    // Tablas sin columna de posición: "Campeón de Clase 3 del Turismo Nacional", "Subcampeón de TC Pista".
    const rawSeries = seriesCell ? cleanName(seriesCell.text) : '';
    const crowned = /^(sub)?campe[oó]n (?:de(?:l| la)?|en)\s+/i.exec(rawSeries);
    const series = crowned ? cleanName(rawSeries.slice(crowned[0].length)) : rawSeries;
    if (!season || !series || EMPTY.test(series) || /^(total|totales|career total)/i.test(series)) continue;
    const row_: CareerSeason = { season, series, source: 'wikipedia' };
    const seriesId = seriesIdFor(series, seriesCell?.link, season);
    if (seriesId) row_.seriesId = seriesId;
    const team = cleanTeam(at(row, 'team')?.text ?? '');
    if (team) row_.team = team;
    const pos = position(at(row, 'pos')?.text) ?? (crowned ? (crowned[1] ? 2 : 1) : undefined);
    if (pos !== undefined) row_.pos = pos;
    const pts = points(at(row, 'points')?.text);
    if (pts !== undefined) row_.points = pts;
    for (const k of ['races', 'wins', 'podiums', 'poles'] as const) {
      const v = int(at(row, k)?.text);
      if (v !== undefined) row_[k] = v;
    }
    if (pos === 1 && isChampionship(series, seriesId)) row_.champion = true;
    out.push(row_);
  }
  return out;
}

/**
 * Trayectoria del artículo: la tabla de temporadas con más filas (entre las que traen estadísticas, si hay alguna),
 * de la temporada más reciente a la más vieja.
 */
export function careerFromWikitext(wikitext: string): CareerSeason[] {
  const tables = parseTables(wikitext)
    .map(careerTable)
    .filter((t): t is CareerTable => !!t)
    .map((t) => ({ t, rows: rowsOf(t) }))
    .filter((x) => x.rows.length > 0);
  if (!tables.length) return [];
  const withStats = tables.filter((x) => x.t.stats >= 2);
  const pool = withStats.length ? withStats : tables;
  const best = pool.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
  return sortCareer(best.rows);
}

/** De la temporada más reciente a la más vieja; dentro de una temporada se respeta el orden original. */
export function sortCareer(rows: CareerSeason[]): CareerSeason[] {
  return rows
    .map((r, i) => ({ r, i }))
    .sort((a, b) => b.r.season - a.r.season || a.i - b.i)
    .map(({ r }) => r);
}

/** Títulos: temporadas en las que terminó primero en un campeonato de pilotos (no carreras sueltas). */
export function titlesOf(career: CareerSeason[]): BioTitle[] {
  const seen = new Set<string>();
  const out: BioTitle[] = [];
  for (const r of career) {
    if (!r.champion) continue;
    const key = `${r.season}|${plain(r.series)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r.seriesId ? { season: r.season, series: r.series, seriesId: r.seriesId } : { season: r.season, series: r.series });
  }
  return out;
}

/**
 * Nombres con los que un artículo puede mencionar cada categoría (para confirmar que el artículo es del piloto de la
 * app: un homónimo no corrió en sus categorías).
 */
export const SERIES_MENTIONS: Record<string, string[]> = {
  f1: ['formula one', 'formula 1'],
  f2: ['formula 2', 'fia formula 2'],
  f3: ['formula 3', 'fia formula 3'],
  'f1-academy': ['f1 academy'],
  'porsche-supercup': ['porsche supercup'],
  motogp: ['motogp'],
  moto2: ['moto2'],
  moto3: ['moto3'],
  indycar: ['indycar'],
  'indy-nxt': ['indy nxt', 'indy lights'],
  'nascar-cup': ['cup series'],
  'nascar-xfinity': ['xfinity series', 'nationwide series', "o'reilly auto parts series", 'busch series'],
  'nascar-truck': ['truck series'],
  wec: ['world endurance championship', 'mundial de resistencia'],
  elms: ['european le mans series'],
  alms: ['asian le mans series'],
  imsa: ['imsa', 'weathertech sportscar', 'united sportscar'],
  'gtwc-europe': ['gt world challenge europe', 'blancpain'],
  'gtwc-america': ['gt world challenge america', 'pirelli world challenge'],
  'gtwc-asia': ['gt world challenge asia', 'blancpain gt series asia'],
  'gtwc-australia': ['gt world challenge australia', 'australian gt championship'],
  'gt-open': ['international gt open', 'gt open'],
  igtc: ['intercontinental gt challenge'],
  '24h-series': ['24h series', '24h gt series', 'creventic'],
  nls: ['nurburgring langstrecken', 'nls', 'vln'],
  dtm: ['dtm', 'deutsche tourenwagen masters'],
  'super-gt': ['super gt'],
  'super-formula': ['super formula', 'formula nippon'],
  'super-taikyu': ['super taikyu'],
  supercars: ['supercars', 'v8 supercar'],
  wrc: ['world rally championship', 'mundial de rally', 'wrc'],
  dakar: ['dakar'],
  'macau-gp': ['macau grand prix', 'gran premio de macao'],
  tc: ['turismo carretera'],
  'tc-pista': ['tc pista'],
  'tc-mouras': ['tc mouras'],
  'tc-pickup': ['tc pick up', 'tc pickup'],
  tc2000: ['tc2000', 'tc 2000'],
  tn: ['turismo nacional'],
  'turismo-pista': ['turismo pista'],
};

/** Palabras sueltas: sin acentos, en minúsculas y sin signos (para buscar menciones en un texto). */
export function words(text: string): string {
  return ` ${plain(text).replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

/** true si el texto (wikitexto o resumen, ya pasado por words) menciona alguna de las categorías. */
export function mentionsSeries(wordsText: string, seriesIds: string[]): boolean {
  return seriesIds.some((id) => (SERIES_MENTIONS[id] ?? []).some((m) => wordsText.includes(words(m))));
}
