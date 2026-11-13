/**
 * Wikipedia en inglés como fuente complementaria del WRC (texto bajo CC BY-SA 4.0).
 *
 * La FIA publica el calendario, las clasificaciones y el campeonato, pero no la ciudad base, la superficie ni el
 * itinerario con horarios de cada rally; y el sitio del promotor (wrc.com) no se lee de forma automática. Eso sale
 * de acá, siempre rotulado como "Wikipedia: <artículo>" en la fuente de cada dato:
 *
 * - Artículo de la temporada ("2026 World Rally Championship"): tabla "Calendar" (ronda, fechas, rally, sede,
 *   superficie) y, en la tabla de resultados, el artículo de cada rally (columna "Report").
 * - Artículo de cada rally ("2026 Rally Italia Sardegna"): sección "Itinerary" (fecha, tramo, hora local, nombre
 *   y kilómetros) con su huso ("All dates and times are CEST (UTC+2)") y la ficha (superficie, km totales).
 *
 * Se lee el wikitexto con la API abierta (action=query&prop=revisions), varios artículos por pedido.
 */
import type { Http } from '../core/http.ts';
import { isoDate, monthNumber } from '../generic/places.ts';

export const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const WIKI_ARTICLE = 'https://en.wikipedia.org/wiki/';
/** La API admite hasta 50 títulos por pedido. */
const TITLES_PER_REQUEST = 40;

export interface WikiPage {
  /** Título del artículo (ya resueltas las redirecciones). */
  title: string;
  /** Wikitexto. */
  text: string;
  /** URL del artículo para mostrar como fuente. */
  url: string;
}

export function wikiArticleUrl(title: string): string {
  return `${WIKI_ARTICLE}${encodeURI(title.trim().replace(/ /g, '_'))}`;
}

/** Pedido a la API por el wikitexto de varios artículos (exportado para las pruebas). */
export function wikiPagesUrl(titles: string[]): string {
  const params = new URLSearchParams({
    action: 'query',
    prop: 'revisions',
    rvprop: 'content',
    rvslots: 'main',
    redirects: '1',
    format: 'json',
    formatversion: '2',
    titles: titles.join('|'),
  });
  return `${WIKI_API}?${params.toString()}`;
}

interface ApiResponse {
  query?: {
    normalized?: Array<{ from: string; to: string }>;
    redirects?: Array<{ from: string; to: string }>;
    pages?: Array<{ title: string; missing?: boolean; revisions?: Array<{ slots?: { main?: { content?: string } } }> }>;
  };
}

/** Wikitexto de los artículos pedidos (clave: el título pedido). Los que no existen no figuran en el resultado. */
export async function fetchWikiPages(http: Http, titles: string[]): Promise<Map<string, WikiPage>> {
  const out = new Map<string, WikiPage>();
  const unique = [...new Set(titles.map((t) => t.trim()).filter(Boolean))];
  for (let i = 0; i < unique.length; i += TITLES_PER_REQUEST) {
    const batch = unique.slice(i, i + TITLES_PER_REQUEST);
    const { body } = await http.json<ApiResponse>(wikiPagesUrl(batch));
    const alias = new Map<string, string>();
    for (const a of [...(body.query?.normalized ?? []), ...(body.query?.redirects ?? [])]) alias.set(a.from, a.to);
    const pages = new Map((body.query?.pages ?? []).map((p) => [p.title, p]));
    for (const asked of batch) {
      let title = asked;
      for (let hop = 0; hop < 4 && alias.has(title); hop++) title = alias.get(title)!;
      const text = pages.get(title)?.revisions?.[0]?.slots?.main?.content;
      if (text) out.set(asked, { title, text, url: wikiArticleUrl(title) });
    }
  }
  return out;
}

// ─── Wikitexto ────────────────────────────────────────────────────────────────────────────────

/** Parte `text` por `sep` sin cortar dentro de enlaces [[…]] ni de plantillas {{…}}. */
function splitTopLevel(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const two = text.slice(i, i + 2);
    if (two === '[[' || two === '{{') {
      depth++;
      i++;
    } else if (two === ']]' || two === '}}') {
      depth = Math.max(0, depth - 1);
      i++;
    } else if (depth === 0 && text.startsWith(sep, i)) {
      out.push(text.slice(last, i));
      last = i + sep.length;
      i += sep.length - 1;
    }
  }
  out.push(text.slice(last));
  return out;
}

/** Reemplaza cada plantilla {{nombre|arg|…}} de primer nivel (pueden anidarse) por lo que devuelva `fn`. */
function replaceTemplates(text: string, fn: (name: string, args: string[]) => string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{{', i);
    if (open < 0) return out + text.slice(i);
    out += text.slice(i, open);
    let depth = 0;
    let j = open;
    while (j < text.length) {
      if (text.startsWith('{{', j)) {
        depth++;
        j += 2;
      } else if (text.startsWith('}}', j)) {
        depth--;
        j += 2;
        if (depth === 0) break;
      } else j++;
    }
    if (depth !== 0) return out + text.slice(open); // plantilla sin cerrar: se deja como está
    const parts = splitTopLevel(text.slice(open + 2, j - 2), '|');
    out += fn(parts[0]!.trim().toLowerCase(), parts.slice(1));
    i = j;
  }
  return out;
}

/** Argumentos de la primera plantilla `name` de `text` (p. ej. la nota {{efn|…}} de una celda). */
function templateArgs(text: string, name: string): string[] | null {
  let found: string[] | null = null;
  replaceTemplates(text, (n, args) => {
    if (n === name && !found) found = args;
    return '';
  });
  return found;
}

/**
 * Texto plano de un fragmento de wikitexto: sin referencias, plantillas, imágenes ni formato; los enlaces quedan
 * con su texto visible ("[[Gap, Hautes-Alpes|Gap]]" -> "Gap") y los corchetes escritos con <nowiki> se conservan.
 */
export function wikiPlain(text: string): string {
  let t = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref\b[^>]*\/>/gi, '')
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '')
    // <nowiki/> separa un corchete suelto de un enlace: se marca para que "[" + "[[…]]" no se lea como "[[[".
    .replace(/<nowiki\s*\/>/gi, '​')
    .replace(/<nowiki>([\s\S]*?)<\/nowiki>/gi, (_m, s: string) => s.replace(/\[/g, '［').replace(/\]/g, '］'));
  t = replaceTemplates(t, (name, args) => {
    if (name === 'convert') return `${args[0] ?? ''} ${args[1] ?? ''}`;
    if (name === 'nowrap' || name === 'nobr') return args.join('|');
    return '';
  });
  return t
    .replace(/\[\[(?:File|Image):[^\]]*\]\]/gi, '')
    .replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2')
    .replace(/\[\[([^\]]*)\]\]/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/'{2,}/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&amp;/g, '&')
    .replace(/［/g, '[')
    .replace(/］/g, ']')
    .replace(/​/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface WikiCell {
  header: boolean;
  /** Atributos de la celda (rowspan="5", align="center"…). */
  attrs: string;
  /** Wikitexto de la celda. */
  raw: string;
}

/** `align="center" | After 14:01` -> atributos + contenido (la barra de un enlace o plantilla no cuenta). */
function splitAttrs(cell: string): { attrs: string; raw: string } {
  const parts = splitTopLevel(cell, '|');
  const first = parts[0] ?? '';
  if (parts.length > 1 && /^[\s\w\-="':;#%.,]*$/.test(first) && (first.includes('=') || /^\s*nowrap\s*$/i.test(first))) {
    return { attrs: first.trim(), raw: parts.slice(1).join('|').trim() };
  }
  return { attrs: '', raw: cell.trim() };
}

/** Tablas {| … |} del wikitexto: filas (separadas por "|-") de celdas ("|" datos, "!" encabezados). */
export function wikiTables(text: string): WikiCell[][][] {
  const tables: WikiCell[][][] = [];
  let rows: WikiCell[][] | null = null;
  let row: WikiCell[] = [];
  const flush = () => {
    if (rows && row.length) rows.push(row);
    row = [];
  };
  for (const line of text.split('\n')) {
    const l = line.trimStart();
    if (l.startsWith('{|')) {
      rows = [];
      row = [];
    } else if (!rows) {
      continue;
    } else if (l.startsWith('|}')) {
      flush();
      tables.push(rows);
      rows = null;
    } else if (l.startsWith('|-')) {
      flush();
    } else if (l.startsWith('|+')) {
      continue;
    } else if (l.startsWith('!') || l.startsWith('|')) {
      const header = l.startsWith('!');
      for (const part of splitTopLevel(l.slice(1), header ? '!!' : '||')) row.push({ header, ...splitAttrs(part) });
    } else if (row.length) {
      row[row.length - 1]!.raw += `\n${line}`; // la celda sigue en la línea siguiente
    }
  }
  return tables;
}

const EMPTY_CELL: WikiCell = { header: false, attrs: '', raw: '' };
const span = (cell: WikiCell, kind: 'rowspan' | 'colspan') =>
  Math.max(1, Number(cell.attrs.match(new RegExp(`${kind}\\s*=\\s*["']?(\\d+)`, 'i'))?.[1] ?? 1));

/** Aplica rowspan/colspan: cada fila queda con una celda por columna (la fecha del día se repite en sus filas). */
export function expandSpans(rows: WikiCell[][]): WikiCell[][] {
  const pending: Array<{ left: number; cell: WikiCell } | undefined> = [];
  return rows.map((cells) => {
    const out: WikiCell[] = [];
    let k = 0;
    for (let col = 0; k < cells.length || pending.some((p, c) => c >= col && p && p.left > 0); col++) {
      const p = pending[col];
      if (p && p.left > 0) {
        out.push(p.cell);
        p.left--;
        continue;
      }
      const cell = cells[k++];
      if (!cell) {
        out.push(EMPTY_CELL);
        continue;
      }
      const rs = span(cell, 'rowspan');
      const cs = span(cell, 'colspan');
      for (let c = 0; c < cs; c++) {
        out.push(cell);
        if (rs > 1) pending[col + c] = { left: rs - 1, cell };
      }
      col += cs - 1;
    }
    return out;
  });
}

/** "22 January" -> día y mes (las tablas no llevan año). */
function dayMonth(text: string): { day: number; month: number } | null {
  const m = text.match(/(\d{1,2})\s+([A-Za-zÀ-ÿ]+)/);
  const month = m ? monthNumber(m[2]!) : null;
  return m && month ? { day: Number(m[1]), month } : null;
}

/** "21 January" -> fecha ISO con el año más cercano a `near` (el shakedown de un rally de enero puede caer en diciembre). */
function dateNear(text: string, near: string): string | null {
  const dm = dayMonth(text);
  if (!dm) return null;
  const year = Number(near.slice(0, 4));
  const target = Date.parse(`${near.slice(0, 10)}T00:00:00Z`);
  let best: string | null = null;
  for (const y of [year, year - 1, year + 1]) {
    const iso = isoDate(y, dm.month, dm.day);
    if (iso && (!best || Math.abs(Date.parse(iso) - target) < Math.abs(Date.parse(best) - target))) best = iso;
  }
  return best;
}

// ─── Artículo de la temporada: calendario ─────────────────────────────────────────────────────

export interface WikiCalendarRow {
  round: number;
  dateStart: string;
  dateEnd: string;
  /** Nombre del rally como figura en la tabla ("Rallye Automobile Monte Carlo"). */
  name: string;
  /** Código de la bandera ({{flagicon|MON}}): identifica el país anfitrión. */
  flag: string;
  /** Ciudad base ("Gap", "Las Palmas"). */
  city: string;
  /** Sede completa en texto ("Gap, Provence-Alpes-Côte d'Azur, France"). */
  hq: string;
  /** País de la sede si la tabla lo nombra ("France"). */
  hqCountry: string;
  /** "Gravel", "Tarmac", "Snow", "Mixed". */
  surface: string;
  /** Nota al pie de la superficie ("…run on a tarmac and snow surface"). */
  surfaceNote: string;
  /** Artículo del rally ("2026 Monte Carlo Rally"); puede no existir todavía. */
  article: string;
}

/** Filas de la tabla "Calendar" del artículo de la temporada. [] si no hay tabla (temporada sin calendario). */
export function parseSeasonCalendar(text: string, season: number): WikiCalendarRow[] {
  const at = text.search(/^==\s*Calendar\s*==\s*$/m);
  const scope = at >= 0 ? text.slice(at) : text;

  // Artículo de cada rally: columna "Report" de la tabla de resultados (a veces todavía comentada).
  const reports = new Map<number, string>();
  for (const m of text.matchAll(/\n!\s*(\d+)\s*\n(?:(?!\n\|-)[\s\S])*?\[\[([^\]|]+)\|\s*Report\s*\]\]/g)) {
    reports.set(Number(m[1]), m[2]!.trim());
  }

  for (const table of wikiTables(scope)) {
    const grid = expandSpans(table);
    const head = (grid[0] ?? []).map((c) => wikiPlain(c.raw).toLowerCase());
    const col = (re: RegExp, not?: RegExp) => head.findIndex((h) => re.test(h) && !not?.test(h));
    const iRound = col(/^round/);
    const iStart = col(/start/);
    const iEnd = col(/finish|end/);
    const iHq = col(/headquarter|base/);
    const iRally = col(/rally|event/, /headquarter|base/);
    const iSurface = col(/surface/);
    if (iRound < 0 || iStart < 0 || iRally < 0) continue;

    const out: WikiCalendarRow[] = [];
    for (const cells of grid.slice(1)) {
      const round = wikiPlain(cells[iRound]?.raw ?? '');
      if (!/^\d+$/.test(round)) continue;
      // Las fechas de la tabla no llevan año: son las de la temporada.
      const start = dayMonth(wikiPlain(cells[iStart]?.raw ?? ''));
      const end = (iEnd >= 0 ? dayMonth(wikiPlain(cells[iEnd]?.raw ?? '')) : null) ?? start;
      const startIso = start ? isoDate(season, start.month, start.day) : null;
      const endIso = end ? isoDate(season, end.month, end.day) : null;
      const rallyRaw = cells[iRally]?.raw ?? '';
      const link = rallyRaw.match(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/);
      const name = wikiPlain(rallyRaw);
      if (!startIso || !endIso || !name) continue;
      const hq = iHq >= 0 ? wikiPlain(cells[iHq]?.raw ?? '') : '';
      const hqParts = hq.split(',').map((p) => p.trim()).filter(Boolean);
      const surfaceRaw = iSurface >= 0 ? (cells[iSurface]?.raw ?? '') : '';
      out.push({
        round: Number(round),
        dateStart: startIso,
        dateEnd: endIso < startIso ? startIso : endIso,
        name,
        flag: (rallyRaw.match(/\{\{\s*flag(?:icon|u|country)?\s*\|\s*([^}|]+)/i)?.[1] ?? '').trim(),
        city: hqParts[0] ?? '',
        hq,
        hqCountry: hqParts.length > 1 ? hqParts.at(-1)! : '',
        surface: wikiPlain(surfaceRaw),
        surfaceNote: wikiPlain(templateArgs(surfaceRaw, 'efn')?.join('|') ?? ''),
        article: reports.get(Number(round)) ?? (link ? `${season} ${link[1]!.trim()}` : ''),
      });
    }
    if (out.length > 0) return out;
  }
  return [];
}

// ─── Artículo de un rally: itinerario ─────────────────────────────────────────────────────────

export type ItineraryKind = 'shakedown' | 'especial' | 'superespecial' | 'power';

export interface ItineraryStage {
  /** "SS1" o "Shakedown". */
  code: string;
  /** Número del tramo (falta en el shakedown). */
  number?: number;
  name: string;
  kind: ItineraryKind;
  /** Fecha local YYYY-MM-DD. */
  date: string;
  /** Hora local de largada del primer auto, "HH:mm". */
  time?: string;
  km?: number;
}

export interface WikiItinerary {
  stages: ItineraryStage[];
  /** Huso que declara el artículo ("UTC+2" -> 120), en minutos. */
  utcOffsetMinutes?: number;
  /** Superficie de la ficha ("Tarmac and snow"). */
  surface: string;
  /** Kilómetros totales con enlaces, de la ficha. */
  overallKm?: number;
}

/** Tramos de hasta esta distancia se consideran superespeciales (los artículos solo lo dicen a veces: "SSS"). */
const SUPER_SPECIAL_MAX_KM = 4;

/** Itinerario y datos de la ficha del artículo de un rally. `near`: fecha de inicio del evento (para el año). */
export function parseRallyArticle(text: string, near: string): WikiItinerary {
  const field = (name: string) => text.match(new RegExp(`^\\|\\s*${name}\\s*=[ \\t]*(.*)$`, 'm'))?.[1] ?? '';
  const overall = Number.parseFloat(wikiPlain(field('overallkm')).replace(/,/g, ''));
  const out: WikiItinerary = {
    stages: [],
    surface: wikiPlain(field('surface')),
    ...(Number.isFinite(overall) && overall > 0 ? { overallKm: overall } : {}),
  };

  const heading = text.match(/^=+\s*Itinerary\s*=+\s*$/im);
  if (!heading || heading.index === undefined) return out;
  const rest = text.slice(heading.index + heading[0].length);
  const next = rest.search(/^==/m);
  const section = next >= 0 ? rest.slice(0, next) : rest;

  const tableAt = section.indexOf('{|');
  const offset = section.slice(0, tableAt >= 0 ? tableAt : undefined).match(/UTC\s*([+\-−–])\s*(\d{1,2})(?::(\d{2}))?/);
  if (offset) {
    const minutes = Number(offset[2]) * 60 + Number(offset[3] ?? 0);
    out.utcOffsetMinutes = offset[1] === '+' ? minutes : -minutes;
  }

  for (const table of wikiTables(section)) {
    const grid = expandSpans(table);
    const head = (grid[0] ?? []).map((c) => wikiPlain(c.raw).toLowerCase());
    const col = (re: RegExp, fallback: number) => {
      const i = head.findIndex((h) => re.test(h));
      return i >= 0 ? i : fallback;
    };
    const iDate = col(/date|day/, 0);
    const iNo = col(/^no\b|^no\.|number|^stage$/, 1);
    const iTime = col(/time/, 2);
    const iName = col(/name/, 3);
    const iKm = col(/dist|length/, 4);

    for (const cells of grid.slice(1)) {
      const date = dateNear(wikiPlain(cells[iDate]?.raw ?? ''), near);
      const label = wikiPlain(cells[iName]?.raw ?? '');
      const ss = wikiPlain(cells[iNo]?.raw ?? '').match(/^SS\s*(\d+)$/i);
      const shakedown = !ss && /shakedown/i.test(label);
      if (!date || (!ss && !shakedown)) continue; // asistencias, reagrupamientos, ceremonias…
      const time = wikiPlain(cells[iTime]?.raw ?? '').match(/(\d{1,2})[:.](\d{2})/);
      const km = Number.parseFloat(wikiPlain(cells[iKm]?.raw ?? '').match(/(\d+(?:[.,]\d+)?)\s*km/i)?.[1]?.replace(',', '.') ?? '');
      const name = label.replace(/\s*\[+\s*(?:shakedown|power\s*stage)\s*\]+\s*/gi, ' ').trim();
      const power = !!ss && /power\s*stage/i.test(label);
      const kind: ItineraryKind = shakedown
        ? 'shakedown'
        : power
          ? 'power'
          : /\bSSS\b|super[\s-]*special/i.test(name) || (Number.isFinite(km) && km <= SUPER_SPECIAL_MAX_KM)
            ? 'superespecial'
            : 'especial';
      out.stages.push({
        code: ss ? `SS${Number(ss[1])}` : 'Shakedown',
        ...(ss ? { number: Number(ss[1]) } : {}),
        name,
        kind,
        date,
        ...(time && Number(time[1]) < 24 && Number(time[2]) < 60 ? { time: `${time[1]!.padStart(2, '0')}:${time[2]}` } : {}),
        ...(Number.isFinite(km) ? { km } : {}),
      });
    }
    if (out.stages.length > 0) break;
  }
  return out;
}
