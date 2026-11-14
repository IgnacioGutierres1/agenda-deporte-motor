/**
 * Resultados del Gran Premio de Macao: la API de la app oficial (/api/game/result_list?year=AAAA) lista por categoría
 * ("Macau GT Cup - FIA GT World Cup") los PDF oficiales de cada sesión ("Free Practice 1", "Qualifing 1",
 * "Qualifiying Race", "Race Classification", "Race 1 Classification"). Los PDF son los de cronometraje (ITS) firmados
 * por los comisarios: casi todos tienen texto; algunos se publican escaneados y no se pueden leer sin IA.
 *
 * El PDF se lee con las posiciones de cada texto (unpdf): cada fila de la tabla es una línea y cada valor va en la
 * columna de encabezado más cercana ("LAPS", "BEST LAP", "TOTAL TIME", "GAP 1st"…).
 */
import type { ResultRow, Session, SessionConditions } from '@dm/shared';
import { isoNow, obj, str } from './kit.ts';
import { macauCategory } from './macau.ts';
import { gapText, lapTime, sourceName } from './results-asia-kit.ts';
import type { CalendarEntry, RecipeContext, ResultsFound, SessionResultFound } from './types.ts';

const BASE = 'https://www.macau.grandprix.gov.mo';
export const macauResultListUrl = (season: number) => `${BASE}/api/game/result_list?_locale=en&year=${season}`;

/** Texto de un PDF con su posición en la página. */
export interface PdfItem {
  page: number;
  x: number;
  y: number;
  w: number;
  str: string;
}

/** Textos del PDF con su posición (import diferido de unpdf, como en extract/document.ts). */
export async function pdfItems(bytes: Uint8Array): Promise<PdfItem[]> {
  const { getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const out: PdfItem[] = [];
  try {
    for (let p = 1; p <= pdf.numPages; p++) {
      const content = await (await pdf.getPage(p)).getTextContent();
      for (const it of content.items) {
        if (!('str' in it) || !it.str.trim()) continue;
        out.push({ page: p, x: it.transform[4] as number, y: it.transform[5] as number, w: it.width, str: it.str.trim() });
      }
    }
  } finally {
    await pdf.loadingTask.destroy();
  }
  return out;
}

/** "VANTHOOR Laurens" / "Nestor GIROLAMI" -> "Laurens Vanthoor" / "Nestor Girolami" (apellido en mayúsculas). */
export function macauDriverName(raw: string): string {
  const words = raw.replace(/\s+/g, ' ').trim().split(' ');
  const isUpper = (w: string) => /\p{L}{2,}/u.test(w) && w === w.toUpperCase();
  const surname = words.filter(isUpper);
  const given = words.filter((w) => !isUpper(w));
  if (surname.length === 0 || given.length === 0) return raw.trim();
  const title = (w: string) => w.toLowerCase().replace(/(^|[\s'’-])(\p{L})/gu, (_m, a: string, b: string) => a + b.toUpperCase());
  return [...given, ...surname.map(title)].join(' ');
}

type Kind = 'practice' | 'qualifying' | 'race';

interface Column {
  key: string;
  x: number;
  center: number;
}

/** Columnas de la tabla según los encabezados de la línea que empieza con "#". */
function headerColumns(items: PdfItem[]): { columns: Column[]; driverX: number; y: number; page: number } | null {
  const hash = items.find((i) => i.str === '#');
  if (!hash) return null;
  const line = items.filter((i) => i.page === hash.page && Math.abs(i.y - hash.y) <= 3);
  const driver = line.find((i) => /^(driver|rider)$/i.test(i.str));
  if (!driver) return null;
  const columns = line
    .filter((i) => i !== hash)
    .map((i) => ({ key: i.str.toUpperCase().replace(/\s+/g, ' '), x: i.x, center: i.x + i.w / 2 }));
  return { columns, driverX: driver.x, y: hash.y, page: hash.page };
}

/** Condiciones del pie: "WEATHER : 1020 HPA - DRY - 24 °C - HUMIDITY 71 %". */
function weatherOf(items: PdfItem[]): SessionConditions | undefined {
  const text = items.find((i) => /^WEATHER\s*:/i.test(i.str))?.str;
  if (!text) return undefined;
  const airC = Number(text.match(/(-?\d+(?:[.,]\d+)?)\s*°\s*C/i)?.[1]?.replace(',', '.'));
  const humidity = Number(text.match(/HUMIDITY\s*(\d+(?:[.,]\d+)?)\s*%/i)?.[1]?.replace(',', '.'));
  const track = /\bWET\b/i.test(text) ? 'Mojada' : /\bDAMP\b/i.test(text) ? 'Húmeda' : /\bDRY\b/i.test(text) ? 'Seca' : undefined;
  const out: SessionConditions = {
    ...(Number.isFinite(airC) ? { airC } : {}),
    ...(Number.isFinite(humidity) ? { humidity } : {}),
    ...(track ? { track } : {}),
  };
  return Object.keys(out).length ? out : undefined;
}

/** "02:16.412" -> "2:16.412"; "-" -> undefined. */
const timeOf = (t: string | undefined) => {
  const v = lapTime((t ?? '').replace(/^0(\d:)/, '$1'));
  return v?.replace(/^0+(\d)/, '$1');
};

/** "03.960" -> "+3.960"; "1:11.427"; "6 Lp." -> "+6 vueltas". */
const gapOf = (t: string | undefined) => {
  const v = (t ?? '').trim();
  if (!v || v === '-') return undefined;
  const g = gapText(v.replace(/\s*Lp\.?$/i, ' Laps'));
  return g?.replace(/^\+0+(\d)/, '+$1');
};

/**
 * Filas de un PDF de clasificación de ITS (práctica, clasificación o carrera). [] si el PDF no tiene la tabla
 * (escaneado, o la clasificación combinada, que tiene otro formato).
 */
export function macauPdfRows(items: PdfItem[]): { rows: ResultRow[]; conditions?: SessionConditions; race: boolean } {
  const head = headerColumns(items);
  if (!head) return { rows: [], race: false };
  const race = head.columns.some((c) => c.key === 'TOTAL TIME');
  const notClassified = items.filter((i) => /^not classified$/i.test(i.str));
  const below = (it: { page: number; y: number }) => notClassified.some((n) => it.page > n.page || (it.page === n.page && it.y < n.y - 2));
  // Filas: líneas debajo del encabezado (o en páginas siguientes) que empiezan con puesto y número a la izquierda del piloto.
  const body = items
    .filter((i) => i.page > head.page || i.y < head.y - 3)
    .sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines: PdfItem[][] = [];
  for (const it of body) {
    const last = lines.at(-1);
    if (last && last[0]!.page === it.page && Math.abs(last[0]!.y - it.y) <= 3) last.push(it);
    else lines.push([it]);
  }
  const rows: ResultRow[] = [];
  for (const line of lines) {
    const left = line.filter((i) => i.x < head.driverX - 5).sort((a, b) => a.x - b.x);
    if (left.length < 2 || !/^\d+$/.test(left[0]!.str) || !/^\d+$/.test(left[1]!.str)) continue;
    const cells = new Map<string, string>();
    for (const it of line) {
      if (left.includes(it)) continue;
      // Los textos alineados a la izquierda (piloto, equipo, auto) empiezan donde empieza el encabezado; los números
      // (alineados a la derecha o al centro) van en la columna cuyo centro está más cerca.
      const center = it.x + it.w / 2;
      const aligned = head.columns.find((c) => Math.abs(c.x - it.x) <= 3);
      const nearest = head.columns.reduce((best, c) => (Math.abs(c.center - center) < Math.abs(best.center - center) ? c : best));
      const key = (aligned ?? nearest).key;
      cells.set(key, [cells.get(key), it.str].filter(Boolean).join(' '));
    }
    const driver = macauDriverName(cells.get('DRIVER') ?? cells.get('RIDER') ?? '');
    if (!driver) continue;
    const nc = below(line[0]!);
    const pos = nc ? null : Number(left[0]!.str);
    const laps = Number(cells.get('LAPS'));
    const team = cells.get('TEAM');
    const vehicle = cells.get('CAR') ?? cells.get('BIKE');
    const row: ResultRow = {
      pos,
      ...(nc ? { status: laps > 0 ? 'NC' : 'DNS' } : {}),
      number: left[1]!.str,
      driver,
      ...(team ? { team } : {}),
      ...(vehicle ? { vehicle } : {}),
      ...(Number.isFinite(laps) && cells.has('LAPS') ? { laps } : {}),
    };
    const best = timeOf(cells.get('BEST LAP'));
    if (race) {
      const total = timeOf(cells.get('TOTAL TIME'));
      const gap = gapOf(cells.get('GAP 1ST'));
      if (pos === 1 && total) row.time = total;
      else if (pos !== null && gap) row.gap = gap;
      if (best) row.bestLap = best;
    } else {
      if (best) row.time = best;
      const gap = gapOf(cells.get('GAP 1ST'));
      if (gap && pos !== 1) row.gap = gap;
    }
    rows.push(row);
  }
  const conditions = weatherOf(items);
  return { rows, race, ...(conditions ? { conditions } : {}) };
}

/** Clave comparable de una sesión: tipo y número ("Qualifying 2" -> q2, "Qualification Race" -> qr, "Race" -> r1). */
export function macauSessionKey(name: string): string | null {
  const n = name.toLowerCase();
  const num = Number(n.match(/(\d+)/)?.[1]) || 1;
  if (/combined/.test(n)) return null;
  if (/warm/.test(n)) return 'wu';
  if (/qualif\w*\s+race/.test(n)) return 'qr';
  if (/qualif/.test(n)) return `q${num}`;
  if (/practice/.test(n)) return `fp${num}`;
  if (/race|classification/.test(n)) return `r${num}`;
  return null;
}

interface ResultDoc {
  category: string;
  key: string;
  title: string;
  pdf: string;
}

/** PDF publicados de la temporada, por categoría y sesión. */
export function macauResultDocs(json: unknown): ResultDoc[] {
  const out: ResultDoc[] = [];
  for (const g of (Array.isArray(obj(json).data) ? (obj(json).data as unknown[]) : []).map(obj)) {
    const category = macauCategory(str(g.title));
    if (!category) continue;
    for (const r of (Array.isArray(g.results) ? g.results : []).map(obj)) {
      const key = macauSessionKey(str(r.title));
      const pdf = str(r.pdf);
      if (key && /^https?:\/\//.test(pdf)) out.push({ category, key, title: str(r.title), pdf });
    }
  }
  return out;
}

export async function macauResults(_entry: CalendarEntry, sessions: Session[], ctx: RecipeContext): Promise<ResultsFound | null> {
  const listUrl = macauResultListUrl(ctx.season);
  const docs = macauResultDocs((await ctx.http.json<unknown>(listUrl)).body);
  if (docs.length === 0) return null;
  const found: SessionResultFound[] = [];
  for (const s of sessions) {
    // "FIA GT World Cup - Qualifying 1": categoría y sesión.
    const name = sourceName(s);
    const at = name.lastIndexOf(' - ');
    if (at < 0) continue;
    const category = macauCategory(name.slice(0, at));
    const key = macauSessionKey(name.slice(at + 3));
    const doc = docs.find((d) => d.category === category && d.key === key);
    if (!doc) continue;
    const { rows, conditions } = macauPdfRows(await pdfItems((await ctx.http.bytes(doc.pdf)).body));
    if (rows.length === 0) continue;
    found.push({
      sessionId: s.id,
      rows,
      ...(conditions ? { conditions } : {}),
      source: { url: doc.pdf, title: `${doc.category} — ${doc.title}`, kind: 'pdf', method: 'directo', fetchedAt: isoNow(ctx.now) },
    });
  }
  return {
    sessions: found,
    source: { url: `${BASE}/en/info/result`, title: `Results — Macau Grand Prix ${ctx.season}`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) },
  };
}
