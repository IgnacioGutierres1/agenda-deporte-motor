/**
 * Lista de campeones de una categoría a partir de las tablas de Wikipedia (config/series-history.json).
 * Cada fuente indica la página, la sección y las columnas; el lector admite:
 *  - tablas "largas" (una fila por temporada o por temporada y clase, con una columna de clase opcional);
 *  - tablas "anchas" (una columna por clase o copa: IMSA, GT World Challenge, Asian Le Mans), con la tabla de
 *    equipos de la misma forma unida por temporada y clase;
 *  - filas de encabezado en medio de la tabla (los nombres de las clases cambian con los años).
 * Lo que no es un campeón ("Not held", "Cancelled", "TBD", "See …") se descarta.
 */
import { splitDriverNames, type SeriesChampion } from '@dm/shared';
import { cleanText, type WikiCell, type WikiTable } from './wikitable.ts';

/** Columna: índice, o texto del encabezado (expresión regular sin distinguir mayúsculas). */
export type Col = number | string;

export interface TablePick {
  /** Texto (expresión regular) que debe aparecer en algún título de sección o en el epígrafe de la tabla. */
  section?: string;
  /** Cuál de las tablas que cumplen (por defecto, la primera que tenga la columna de temporada). */
  table?: number;
}

export interface ChampionsSource extends TablePick {
  /** Idioma de la Wikipedia ("en", "es", "de"). */
  lang: string;
  page: string;
  season?: Col;
  /** Piloto o tripulación; varias columnas se unen con " / " (piloto y copiloto). */
  driver?: Col | Col[];
  team?: Col;
  /** Auto o moto; varias columnas se unen con espacio (chasis y motor). */
  vehicle?: Col | Col[];
  /** Separador entre las columnas de "vehicle" (por defecto, un espacio; en F1, "-": "Red Bull-Honda RBPT"). */
  vehicleJoin?: string;
  /** Columna con la clase o categoría (tabla larga): va a la nota. */
  class?: Col;
  /** Cómo se escribe la clase en la nota: "Clase GT300" (por defecto) o el texto tal cual ("USAC", "CART"). */
  classAs?: 'class' | 'raw';
  /**
   * Tabla ancha: columnas que son clases o copas (el encabezado va a la nota). `true` = todas menos la temporada.
   */
  classes?: Col[] | true;
  /** Columnas de la tabla ancha que no son clases (expresión regular: "^Car" para las columnas del auto). */
  classesExclude?: string;
  /** Tabla ancha de equipos de la misma página, unida por temporada y clase. */
  teams?: TablePick;
  /** Nota fija para todas las filas ("Clase Hypercar", "Motos"). */
  note?: string;
  /** Solo las filas donde la columna coincide con la expresión regular. */
  where?: { col: Col; match: string };
  from?: number;
  to?: number;
  /** El equipo está entre paréntesis después del dueño ("Rick Hendrick (Hendrick Motorsports)"). */
  teamParen?: boolean;
  /** La columna "vehicle" es la marca (Ford, Chevrolet): habilita el récord de marcas. */
  vehicleIsMake?: boolean;
  /** La marca es la primera palabra de "vehicle" ("Ford Falcon" -> "Ford"). */
  makeWord?: boolean;
  /** Estas filas no son las del campeonato principal (clases secundarias, otros vehículos). */
  secondary?: boolean;
  /** Para qué récords cuenta: todos (por defecto), solo el de equipos (campeonato de constructores) o ninguno. */
  records?: 'all' | 'teams' | 'none';
}

/** Campeón con datos internos para los récords (no se publican). */
export interface ChampionRow extends SeriesChampion {
  primary: boolean;
  /** Marca, cuando la fuente la publica en una columna propia. */
  make?: string;
  /** Artículos enlazados en las celdas de piloto y equipo (para vincular con la app). */
  driverLinks?: string[];
  teamLinks?: string[];
}

const SEASON_HEADER = /season|year|temporada|año|saison|jahr|edici[oó]n|edition|^a[nñ]o$/i;

/** Celdas que no son un campeón. */
const NOT_A_CHAMPION =
  /^(?:see\b|ver\b|siehe\b|not (?:held|contested|awarded|organi[sz]ed|run)|no (?:championship|eligible|race|se (?:disput|corri|realiz))|non disputat|nicht ausgetragen|cancel+ed|cancelad|suspendid|abandon|tb[ad]\b|n\/a\b|none\b|ningun|vacante|desiert|no disputad|sin campe[oó]n|—|–|-|\?)/i;

/** Primer año de la celda ("2019–20" -> 2019) y el texto de la temporada si abarca dos años. */
export function parseSeason(text: string): { season: number; span?: string } | null {
  const m = /\b(1[89]\d\d|20\d\d)(?:\s*[–\-/]\s*(\d{2,4}))?\b/.exec(text);
  if (!m) return null;
  const season = Number(m[1]);
  if (!m[2]) return { season };
  const second = m[2].length === 2 ? Number(`${m[1]!.slice(0, 2)}${m[2]}`) : Number(m[2]);
  return second === season + 1 ? { season, span: `${season}-${String(second).slice(2)}` } : { season };
}

function colIndex(header: string[], col: Col | undefined, avoid: number[] = []): number {
  if (col === undefined) return -1;
  if (typeof col === 'number') return col < header.length ? col : -1;
  const re = new RegExp(col, 'i');
  return header.findIndex((h, i) => re.test(h) && !avoid.includes(i));
}

/** Tablas de la página que cumplen la sección pedida, en orden. */
export function pickTable(tables: WikiTable[], pick: TablePick, seasonCol?: Col): WikiTable | undefined {
  const re = pick.section ? new RegExp(pick.section, 'i') : null;
  const matching = tables.filter(
    (t) =>
      (!re || t.headings.some((h) => re.test(h)) || (t.caption !== undefined && re.test(t.caption))) &&
      (seasonCol !== undefined ? colIndex(t.header, seasonCol) >= 0 : t.header.some((h) => SEASON_HEADER.test(h))),
  );
  return matching[pick.table ?? 0];
}

/** Piloto o tripulación de una celda: un renglón por integrante, o los nombres separados por "/", "&", "and". */
export function crewOf(cell: WikiCell | undefined): string {
  if (!cell) return '';
  const names = (cell.lines.length > 1 ? cell.lines : [cell.text])
    .flatMap((l) => (l.length > 3 ? splitDriverNames(l) : [l]))
    .map(cleanPerson)
    .filter((n) => n && !NOT_A_CHAMPION.test(n));
  return [...new Set(names)].join(' / ');
}

/** Nombre de un piloto o equipo: además, sin la aclaración final ("Laurens Vanthoor (Audi)", "(Rd. 1–3)"), salvo "(h)". */
function cleanPerson(raw: string): string {
  return cleanName(raw.replace(/\s*\((?!h\))[^()]*\)\s*$/i, ''));
}

/** Saca del nombre lo que no es parte de él: país o marca entre paréntesis ("Barney Oldfield (USA)"), "Sir". */
function cleanName(raw: string): string {
  return cleanText(raw)
    .replace(/\s*\(\s*[A-Z]{2,3}\s*\)/g, '')
    .replace(/\s*\((?:R|Rookie|N|G|Am|Pro|PA)\)/g, '')
    .replace(/^Sir\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Equipo de una celda: sin el número de auto delante ("5 Action Express Racing") ni el país entre paréntesis. */
export function teamOf(cell: WikiCell | undefined, paren = false): string {
  if (!cell) return '';
  let t = cell.lines.length > 1 && !paren ? cell.lines.join(' / ') : cell.text;
  if (paren) {
    const m = /\(([^()]+)\)\s*$/.exec(t);
    if (m) t = m[1]!;
  }
  t = cleanPerson(t)
    .replace(/^(?:No\.\s*|#)?\d{1,3}\s+(?=\D)/, '')
    .trim();
  return NOT_A_CHAMPION.test(t) ? '' : t;
}

function vehicleOf(row: WikiCell[], idx: number[], sep = ' '): string {
  const parts: string[] = [];
  for (const i of idx) {
    const t = cleanName((row[i]?.text ?? '').replace(/^\(\s*(.*?)\s*\)$/, '$1'));
    if (t && !NOT_A_CHAMPION.test(t) && !parts.some((p) => p.toLowerCase() === t.toLowerCase())) parts.push(t);
  }
  return parts.join(sep);
}

/** Nota para una clase o copa de una tabla ancha ("Overall" -> "General", "GTD" -> "Clase GTD"). */
export function classNote(header: string): string {
  // "Am Drivers (2016) Bronze Drivers (2018–2019) Independent Cup (2023–)": vale el nombre más reciente.
  const named = header.split(/\(\s*\d{4}[^)]*\)/).map((p) => p.trim()).filter(Boolean);
  const h = cleanText((named[named.length - 1] ?? header).replace(/^(?:category|categoría|class|clase)\s+/i, ''));
  if (!h) return '';
  if (/^(?:overall|outright|general|absolut[oa]?|gesamt|drivers?)$/i.test(h)) return 'General';
  if (/cup|copa|trophy|trofeo|champion|campe|general|series|serie|overall/i.test(h)) return h.replace(/\boverall\b/i, 'general');
  return `Clase ${h}`;
}

function join(...parts: Array<string | undefined>): string | undefined {
  const t = parts.filter(Boolean).join(' · ');
  return t || undefined;
}

/**
 * Campeones de una tabla según la fuente. `teamsTable` es la tabla ancha de equipos (si la fuente la pide).
 */
export function readChampions(table: WikiTable, src: ChampionsSource, teamsTable?: WikiTable): ChampionRow[] {
  let header = [...table.header];
  const seasonIdx = () => {
    const i = colIndex(header, src.season ?? SEASON_HEADER.source);
    return i >= 0 ? i : 0;
  };
  const out: ChampionRow[] = [];
  const whereRe = src.where ? new RegExp(src.where.match, 'i') : null;
  // Equipos de la tabla ancha: "temporada|nota" -> equipo.
  const teamsBy = teamsTable ? wideTeams(teamsTable, src) : new Map<string, { name: string; links: string[] }>();

  for (const row of table.rows) {
    const sIdx = seasonIdx();
    const seasonCell = row[sIdx];
    const parsed = seasonCell ? parseSeason(seasonCell.text) : null;
    // Fila de encabezado intermedia: redefine los nombres de las columnas para las filas que siguen (salvo que
    // sea una sola celda a lo ancho: el nombre de una época, "Formula Nippon"). Puede traer la temporada.
    if (isHeaderRow(row)) {
      header = row.map((c, i) => c.text || header[i] || '');
      continue;
    }
    if (!parsed) continue;
    const { season, span } = parsed;
    if ((src.from !== undefined && season < src.from) || (src.to !== undefined && season > src.to)) continue;
    if (whereRe && src.where && !whereRe.test(row[colIndex(header, src.where.col)]?.text ?? '')) continue;
    const spanNote = span ? `Temporada ${span}` : undefined;

    if (src.classes) {
      const exclude = src.classesExclude ? new RegExp(src.classesExclude, 'i') : null;
      const cols = (
        src.classes === true
          ? header.map((_, i) => i).filter((i) => i !== sIdx)
          : src.classes.map((c) => colIndex(header, c)).filter((i) => i >= 0)
      ).filter((i) => !exclude || !exclude.test(header[i] ?? ''));
      let first = true;
      const seen = new Set<WikiCell>();
      for (const i of cols) {
        const cell = row[i];
        if (!cell || seen.has(cell) || cell === seasonCell) continue;
        seen.add(cell);
        const driver = crewOf(cell);
        if (!driver) continue;
        const note = classNote(header[i] ?? '');
        const team = teamsBy.get(`${season}|${note}`);
        out.push({
          season,
          driver,
          ...(team ? { team: team.name } : {}),
          note: join(src.note, note, spanNote),
          primary: first && !src.secondary,
          driverLinks: cell.links,
          ...(team ? { teamLinks: team.links } : {}),
        });
        first = false;
      }
      continue;
    }

    const driverCols = (Array.isArray(src.driver) ? src.driver : [src.driver ?? 'driver|rider|champion|piloto|campe|fahrer|winner|ganador'])
      .map((c) => colIndex(header, c, [sIdx]))
      .filter((i) => i >= 0);
    const teamIdx = src.team !== undefined ? colIndex(header, src.team, [sIdx]) : -1;
    const vehicleIdx = (src.vehicle === undefined ? [] : Array.isArray(src.vehicle) ? src.vehicle : [src.vehicle])
      .map((c) => colIndex(header, c, [sIdx]))
      .filter((i) => i >= 0);
    const classIdx = src.class !== undefined ? colIndex(header, src.class, [sIdx]) : -1;

    const crews = driverCols.map((i) => crewOf(row[i])).filter(Boolean);
    const driver = [...new Set(crews)].join(' / ');
    const team = teamIdx >= 0 ? teamOf(row[teamIdx], src.teamParen) : '';
    const vehicle = vehicleOf(row, vehicleIdx, src.vehicleJoin);
    if (!driver && !team) continue;
    // Varias filas para el mismo campeón (NASCAR de los 60: un renglón por dueño de auto): vale la primera.
    if (driver && out.some((c) => c.season === season && c.driver === driver)) continue;
    const classText = classIdx >= 0 ? cleanText(row[classIdx]?.text ?? '') : '';
    const classLabel = classText ? (src.classAs === 'raw' ? classText : classNote(classText)) : undefined;
    out.push({
      season,
      ...(driver ? { driver } : {}),
      ...(team ? { team } : {}),
      ...(vehicle ? { vehicle } : {}),
      ...(src.vehicleIsMake && vehicle ? { make: src.makeWord ? vehicle.split(' ')[0]! : vehicle } : {}),
      note: join(src.note, classLabel, spanNote),
      primary: !src.secondary && (classIdx < 0 || !out.some((c) => c.season === season)),
      driverLinks: driverCols.flatMap((i) => row[i]?.links ?? []),
      ...(teamIdx >= 0 ? { teamLinks: row[teamIdx]?.links ?? [] } : {}),
    });
  }
  // Una celda con rowspan repite la misma fila: se deja una sola.
  const seen = new Set<string>();
  return mergeCrews(out)
    .filter((c) => {
      const key = `${c.season}|${c.driver ?? ''}|${c.team ?? ''}|${c.note ?? ''}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((c) => {
      if (c.note === undefined) delete c.note;
      return c;
    });
}

function wideTeams(table: WikiTable, src: ChampionsSource): Map<string, { name: string; links: string[] }> {
  const out = new Map<string, { name: string; links: string[] }>();
  let header = [...table.header];
  for (const row of table.rows) {
    const sIdx = Math.max(0, colIndex(header, SEASON_HEADER.source));
    const parsed = row[sIdx] ? parseSeason(row[sIdx]!.text) : null;
    if (isHeaderRow(row)) {
      header = row.map((c, i) => c.text || header[i] || '');
      continue;
    }
    if (!parsed) continue;
    header.forEach((h, i) => {
      if (i === sIdx) return;
      const name = teamOf(row[i], src.teamParen);
      if (name) out.set(`${parsed.season}|${classNote(h)}`, { name, links: row[i]?.links ?? [] });
    });
  }
  return out;
}

/** Fila de encabezado en medio de la tabla: solo <th> y más de una celda distinta (no un título a lo ancho). */
function isHeaderRow(row: WikiCell[]): boolean {
  if (!row.every((c) => c.header || !c.text)) return false;
  // Sin la celda de la temporada: al menos dos rótulos distintos, y ninguno "Not held" (temporada sin campeón).
  const labels = new Set(row.filter((c) => c.text && !parseSeason(c.text)));
  return labels.size > 1 && ![...labels].some((c) => NOT_A_CHAMPION.test(c.text));
}

/**
 * Tablas con un renglón por integrante (WEC, ELMS: el equipo ocupa varias filas): los renglones seguidos de la
 * misma temporada, nota, equipo y auto forman una tripulación.
 */
function mergeCrews(rows: ChampionRow[]): ChampionRow[] {
  const out: ChampionRow[] = [];
  for (const r of rows) {
    const prev = out[out.length - 1];
    if (
      prev &&
      r.team &&
      prev.driver &&
      r.driver &&
      prev.season === r.season &&
      prev.team === r.team &&
      prev.note === r.note &&
      prev.vehicle === r.vehicle &&
      !prev.driver.split(' / ').includes(r.driver)
    ) {
      prev.driver = `${prev.driver} / ${r.driver}`;
      prev.driverLinks = [...(prev.driverLinks ?? []), ...(r.driverLinks ?? [])];
      continue;
    }
    out.push({ ...r });
  }
  return out;
}
