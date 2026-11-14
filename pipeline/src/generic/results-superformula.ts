/**
 * Resultados de SUPER FORMULA: la propia página de la fecha (superformula.net/sf3/race/NNNNN/) publica, debajo del
 * cronograma, una tabla por sesión con su título ("FP1", "Rd.1予選", "Rd.1 RACE") y una nota con las condiciones
 * ("Weather :Cloudy/Rain", "Track :Dry/Wet"). La clasificación es una sola tabla con grupo y tiempo de cada parte
 * (Q1, Q2 y, en algunas fechas, Q3): de ahí salen las sesiones "Q1 Group A/B" (cada grupo por su tiempo de Q1), las
 * partes intermedias (por su tiempo) y la última parte, que muestra la clasificación oficial completa.
 */
import type { ResultRow, Session, SessionConditions } from '@dm/shared';
import { textOf } from '../extract/html.ts';
import { column, isoNow, pageOrNull, parseHtmlTable, parseNumber, stripComments } from './kit.ts';
import { conditionsOf, gapText, lapTime, sourceName } from './results-asia-kit.ts';
import type { CalendarEntry, RecipeContext, ResultsFound, SessionResultFound } from './types.ts';

/** Bloque de resultados de la página: título de la sección, tabla y nota al pie. */
export interface SfResultBlock {
  title: string;
  table: string;
  note: string;
}

export function superformulaResultBlocks(html: string): SfResultBlock[] {
  const parts = stripComments(html).split(/<h3 class="block\d+_ttl01[^"]*"><span>/i).slice(1);
  const out: SfResultBlock[] = [];
  for (const part of parts) {
    const title = textOf(part.slice(0, part.indexOf('</span>')));
    const table = part.match(/<div class="table_results">[\s\S]*?<\/table>/i)?.[0];
    if (!title || !table) continue;
    const note = part.match(/<p class="table01_txt01[^"]*">([\s\S]*?)<\/p>/i)?.[1] ?? '';
    out.push({ title, table, note });
  }
  return out;
}

type Kind = 'practice' | 'qualifying' | 'race';

/** Tipo de bloque y número de fecha: "FP1" -> práctica 1; "Rd.1予選" -> clasificación de la fecha 1. */
function blockKind(title: string): { kind: Kind; n?: number; rd?: number } | null {
  const t = title.normalize('NFKC');
  const rd = Number(t.match(/Rd\.?\s*(\d+)/i)?.[1]) || undefined;
  if (/予選|qualif/i.test(t)) return { kind: 'qualifying', ...(rd ? { rd } : {}) };
  if (/race|決勝/i.test(t)) return { kind: 'race', ...(rd ? { rd } : {}) };
  const fp = t.match(/^FP\s*(\d)?$|フリー走行\s*(\d)?/i);
  if (fp) {
    const n = Number(fp[1] ?? fp[2]) || undefined;
    return { kind: 'practice', ...(n ? { n } : {}) };
  }
  return null;
}

/** Sesión del cronograma: "Free Practice 1", "Rd.11 Qualifying Q1 Group A", "Rd.11 Qualifying Q2", "Rd.11 Race". */
function sessionKind(name: string): { kind: Kind; n?: number; rd?: number; q?: number; group?: string } | null {
  if (/warm/i.test(name)) return null;
  const rd = Number(name.match(/Rd\.?\s*(\d+)/i)?.[1]) || undefined;
  if (/qualif/i.test(name)) {
    const q = Number(name.match(/\bQ(\d)\b/i)?.[1]) || undefined;
    const group = name.match(/Group\s*([AB])\b/i)?.[1]?.toUpperCase();
    return { kind: 'qualifying', ...(rd ? { rd } : {}), ...(q ? { q } : {}), ...(group ? { group } : {}) };
  }
  if (/race/i.test(name)) return { kind: 'race', ...(rd ? { rd } : {}) };
  if (/practice/i.test(name)) {
    // "Free Practice 2", o "Free Practice (2)" cuando el cronograma no las numera (la segunda del fin de semana).
    const n = Number(name.match(/Practice\s*\(?(\d)/i)?.[1]) || undefined;
    const group = name.match(/Group\s*([AB])\b/i)?.[1]?.toUpperCase();
    return { kind: 'practice', ...(n ? { n } : {}), ...(group ? { group } : {}) };
  }
  return null;
}

/** Puesto publicado ("1", "8 *1"); null si no tiene ("*2", "", "*1,2"). */
const posOf = (text: string) => {
  const m = text.trim().match(/^(\d+)(?:\s|$|\*)/);
  return m ? Number(m[1]) : null;
};

/** Estado escrito en la columna de puesto, si lo hay. */
const statusOf = (text: string) => (/DSQ|失格/i.test(text) ? 'DSQ' : /DNS|不出走|出走せず/i.test(text) ? 'DNS' : /DNF|リタイア/i.test(text) ? 'DNF' : undefined);

/** Nombre del equipo a partir del auto ("PONOS NAKAJIMA RACING SF23" -> "PONOS NAKAJIMA RACING"). */
const teamOf = (car: string) => car.replace(/\s+SF\d{2}\w*$/i, '').trim();

function conditionsFromNote(note: string): SessionConditions | undefined {
  // "Weather：Cloudy", "Track　：Dry": dos puntos y espacios de ancho completo.
  const text = note.normalize('NFKC').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ');
  const weather = text.match(/Weather\s*:\s*([^\n]+)/i)?.[1]?.trim() ?? '';
  const track = text.match(/Track\s*:\s*([^\n]+)/i)?.[1]?.trim() ?? '';
  return conditionsOf(weather, track);
}

/**
 * Columna con la diferencia al primero: en práctica es "Gap" y en carrera "Delay" (la otra es al de adelante).
 * Se elige la que nunca baja de una fila a la siguiente.
 */
function leaderGapColumn(rows: string[][], preferred: number[]): number {
  const valid = preferred.filter((c) => c >= 0);
  const monotonic = (c: number) => {
    const values = rows.map((r) => textOf(r[c] ?? '')).filter((t) => /^\d+(?:\.\d+)?$/.test(t)).map(Number);
    return values.every((v, i) => i === 0 || v >= values[i - 1]!);
  };
  return valid.find(monotonic) ?? valid[0] ?? -1;
}

interface ParsedRow extends ResultRow {
  group?: string;
  /** Tiempo de cada parte de la clasificación (1 = Q1). */
  q?: Record<number, string>;
}

/** Filas de una tabla de resultados (práctica, clasificación o carrera). */
export function superformulaRows(table: string, kind: Kind): ParsedRow[] {
  const { headers, rows } = parseHtmlTable(table);
  // Algún encabezado viene con basura delante ("suPos.").
  const iPos = column(headers, /pos\.?$/i);
  const iNo = column(headers, /^no/i);
  const iDriver = column(headers, /^driver/i);
  const iCar = column(headers, /^car$/i);
  const iEngine = column(headers, /^engine/i);
  if (iPos < 0 || iNo < 0 || iDriver < 0) throw new Error(`SUPER FORMULA: columnas inesperadas (${headers.join(', ')})`);
  const cell = (r: string[], i: number) => (i >= 0 ? textOf(r[i] ?? '') : '');
  const base = (r: string[]): ParsedRow => {
    const car = cell(r, iCar);
    const engine = cell(r, iEngine);
    const posText = cell(r, iPos);
    const pos = posOf(posText);
    return {
      pos,
      number: cell(r, iNo),
      driver: cell(r, iDriver),
      ...(car ? { team: teamOf(car) } : {}),
      ...(engine ? { vehicle: engine } : {}),
      ...(pos === null && statusOf(posText) ? { status: statusOf(posText)! } : {}),
    };
  };
  const out: ParsedRow[] = [];
  if (kind === 'qualifying') {
    const iGroup = column(headers, /^group/i);
    const parts = headers.map((h, i) => ({ n: Number(h.trim().match(/^Q(\d)$/i)?.[1]), i })).filter((p) => p.n);
    for (const r of rows) {
      const row = base(r);
      if (!row.driver) continue;
      const q: Record<number, string> = {};
      for (const p of parts) {
        const t = lapTime(cell(r, p.i));
        if (t) q[p.n] = t;
      }
      const group = cell(r, iGroup).toUpperCase();
      out.push({ ...row, ...(group ? { group } : {}), q });
    }
    return out;
  }
  const iBest = column(headers, /^best/i);
  const iLap = column(headers, /^lap$/i);
  const iLaps = column(headers, /^laps$/i);
  const iTime = column(headers, /^time$/i);
  const iDelay = column(headers, /^delay/i);
  const iGapCol = column(headers, /^gap/i);
  const iGap = leaderGapColumn(rows, kind === 'race' ? [iDelay, iGapCol] : [iGapCol, iDelay]);
  for (const r of rows) {
    const row = base(r);
    if (!row.driver) continue;
    const best = lapTime(cell(r, iBest));
    if (kind === 'race') {
      const laps = parseNumber(cell(r, iLaps));
      const time = lapTime(cell(r, iTime));
      const gap = gapText(cell(r, iGap));
      if (laps !== null) row.laps = laps;
      if (row.pos === 1 && time) row.time = time;
      else if (row.pos !== null && gap) row.gap = gap;
      if (best) row.bestLap = best;
      if (row.pos === null && !row.status) row.status = laps ? 'DNF' : 'DNS';
    } else {
      // "Lap": "23 / 24" = vuelta de la mejor / vueltas dadas.
      const laps = cell(r, iLap).match(/(\d+)\s*$/)?.[1];
      const gap = gapText(cell(r, iGap));
      if (laps) row.laps = Number(laps);
      if (best) row.time = best;
      if (gap && row.pos !== 1) row.gap = gap;
      if (row.pos === null && !row.status) row.status = best ? 'NC' : 'DNS';
    }
    out.push(row);
  }
  return out;
}

const clean = ({ group: _g, q: _q, ...row }: ParsedRow): ResultRow => row;

/**
 * Una parte intermedia de la clasificación (Q1 de un grupo, o de todos si no hay grupos; Q2 cuando hay Q3):
 * ordenada por el tiempo de esa parte; los que no marcaron tiempo, al final. En Q1 entran todos los del grupo; en
 * las siguientes, solo los que la corrieron.
 */
function partRows(rows: ParsedRow[], part: number, group?: string): ResultRow[] {
  const sel = rows.filter((r) => (!group || r.group === group) && (part === 1 || r.q?.[part]));
  const time = (r: ParsedRow) => r.q?.[part];
  const timed = sel.filter(time).sort((a, b) => secondsOf(time(a)!) - secondsOf(time(b)!));
  const rest = sel.filter((r) => !time(r));
  const best = timed[0] ? time(timed[0]) : undefined;
  return [
    ...timed.map((r, i) => {
      const { gap: _gap, status: _status, ...row } = clean(r);
      const gap = i > 0 && best ? `+${(secondsOf(time(r)!) - secondsOf(best)).toFixed(3)}` : undefined;
      return { ...row, pos: i + 1, time: time(r)!, ...(gap ? { gap } : {}) };
    }),
    ...rest.map((r) => ({ ...clean(r), pos: null, status: r.status ?? 'NC' })),
  ];
}

const secondsOf = (t: string) => t.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);

/** Clasificación oficial completa (última parte o "Qualifying" a secas): con el tiempo de la última parte que corrió. */
function finalQualifying(rows: ParsedRow[]): ResultRow[] {
  return rows.map((r) => {
    const done = Object.keys(r.q ?? {}).map(Number).sort((a, b) => b - a)[0];
    const time = done ? r.q![done] : undefined;
    return { ...clean(r), ...(time ? { time } : {}), ...(r.pos === null ? { status: r.status ?? 'NC' } : {}) };
  });
}

export async function superformulaResults(entry: CalendarEntry, sessions: Session[], ctx: RecipeContext): Promise<ResultsFound | null> {
  if (!entry.url) return null;
  const html = await pageOrNull(ctx, entry.url);
  if (!html) return null;
  const blocks = superformulaResultBlocks(html)
    .map((b) => ({ ...b, k: blockKind(b.title) }))
    .filter((b) => b.k);
  if (blocks.length === 0) return null;
  const found: SessionResultFound[] = [];
  for (const s of sessions) {
    const k = sessionKind(sourceName(s));
    if (!k) continue;
    // Las prácticas por grupo ("Free Practice 2 Group A") no tienen tabla propia: la del FP2 es de todos.
    if (k.kind === 'practice' && k.group) continue;
    const cands = blocks.filter((b) => b.k!.kind === k.kind && (k.kind !== 'practice' || (b.k!.n ?? 1) === (k.n ?? 1)));
    // Fechas dobles: el bloque de la misma fecha ("Rd.11予選" para "Rd.11 Qualifying …"); sin número, el único que haya.
    const block = cands.find((b) => b.k!.rd !== undefined && b.k!.rd === k.rd) ?? (cands.length === 1 && (!k.rd || !cands[0]!.k!.rd) ? cands[0] : undefined);
    if (!block) continue;
    const parsed = superformulaRows(block.table, k.kind);
    let rows: ResultRow[];
    if (k.kind === 'qualifying') {
      const last = Math.max(0, ...parsed.flatMap((r) => Object.keys(r.q ?? {}).map(Number)));
      rows = k.q && k.q < last ? partRows(parsed, k.q, k.group) : finalQualifying(parsed);
    } else rows = parsed.map(clean);
    if (rows.length === 0) continue;
    const conditions = conditionsFromNote(block.note);
    found.push({ sessionId: s.id, rows, ...(conditions ? { conditions } : {}) });
  }
  return {
    sessions: found,
    source: { url: entry.url, title: `Results SUPER FORMULA — ${entry.name}`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) },
  };
}
