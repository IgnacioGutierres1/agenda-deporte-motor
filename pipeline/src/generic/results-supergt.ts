/**
 * Resultados de SUPER GT (supergt.net/en/result): una página por sesión y por clase
 * (?series=AAAA&gt_class=gt500|gt300&race_num=N&round=RoundM). El menú de la página lista las sesiones con
 * resultado de la fecha ("4-11(Sat)Practice", "4-11(Sat)Qualifying（Q1）", "4-12(Sun)Race"); el número de cada
 * una (race_num) cambia según la fecha (con o sin Q1/Q2), así que se lee del menú.
 *
 * El sitio publica cada clase por separado y no da la general: se arma con las dos clases (carrera: vueltas y luego
 * GT500 antes que GT300; práctica: mejor vuelta; clasificación: cada clase en su orden oficial). La clasificación
 * de GT300 en dos grupos ("A-1", "B-1") se publica con el grupo como clase ("GT300 (Grupo A)").
 */
import type { ResultRow, Session, SessionConditions } from '@dm/shared';
import { textOf } from '../extract/html.ts';
import { column, isoNow, pageOrNull, parseHtmlTable, stripComments } from './kit.ts';
import { dateInZone } from './places.ts';
import { conditionsOf, gapText, lapTime, sourceName } from './results-asia-kit.ts';
import type { CalendarEntry, RecipeContext, ResultsFound, SessionResultFound } from './types.ts';

const BASE = 'https://supergt.net/en';
const CLASSES = ['gt500', 'gt300'] as const;

type Kind = 'practice' | 'qualifying' | 'race';

/** Sesión con resultado según el menú de la página. */
export interface SupergtResultSession {
  raceNum: number;
  kind: Kind;
  /** "Q1", "Q2" o undefined. */
  part?: string;
  /** "M-D" del menú, si lo trae. */
  monthDay?: string;
  label: string;
}

export const supergtResultUrl = (season: number, round: number, cls: string, raceNum?: number) =>
  `${BASE}/result?series=${season}&gt_class=${cls}${raceNum ? `&race_num=${raceNum}` : ''}&round=Round${round}`;

/** Temporada del selector "20xx Series" de la página. */
const activeSeries = (html: string) => Number(html.match(/class="[^"]*dropdown__item--active[^"]*"\s+data-value="(\d{4}) Series"/)?.[1] ?? 0);

function kindOf(label: string): { kind: Kind; part?: string } | null {
  const part = label.normalize('NFKC').match(/\(\s*(Q\d)\s*\)/i)?.[1]?.toUpperCase();
  if (/qualif/i.test(label)) return { kind: 'qualifying', ...(part ? { part } : {}) };
  if (/race/i.test(label)) return { kind: 'race' };
  if (/practice|warm/i.test(label)) return /warm/i.test(label) ? null : { kind: 'practice' };
  return null;
}

/** Sesiones con resultado de la fecha (menú "local_menu_pc"), solo si el menú es de esa fecha. */
export function supergtResultMenu(html: string, round: number): SupergtResultSession[] {
  const menu = stripComments(html).match(/<ul class="local_menu_pc">([\s\S]*?)<\/ul>/i)?.[1] ?? '';
  const out: SupergtResultSession[] = [];
  for (const m of menu.matchAll(/<a href="[^"]*race_num=(\d+)&(?:amp;)?round=Round(\d+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (Number(m[2]) !== round) continue;
    const label = textOf(m[3] ?? '');
    const kind = kindOf(label);
    if (!kind) continue;
    const md = label.match(/^(\d{1,2})-(\d{1,2})/);
    out.push({ raceNum: Number(m[1]), ...kind, ...(md ? { monthDay: `${Number(md[1])}-${Number(md[2])}` } : {}), label });
  }
  return out;
}

/** Tipo y parte (Q1/Q2) de una sesión del cronograma ("Official Practice", "Qualifying Q1", "Race"). */
function sessionKind(s: Session): { kind: Kind; part?: string } | null {
  const name = sourceName(s);
  if (/warm/i.test(name)) return null;
  const part = name.match(/\bQ(\d)\b/i)?.[1];
  if (/qualif/i.test(name) || s.type === 'clasificacion') return { kind: 'qualifying', ...(part ? { part: `Q${part}` } : {}) };
  if (/race/i.test(name) || s.type === 'carrera') return { kind: 'race' };
  if (/practice/i.test(name) || s.type === 'practica') return { kind: 'practice' };
  return null;
}

/**
 * Une las sesiones pedidas con las del menú: mismo tipo y parte (Q1/Q2) y, si hay más de una candidata, el mismo día.
 * Cada resultado se asigna a una sola sesión (la primera del día: "Official Practice" antes que "Exclusive Practice").
 */
export function matchSupergtSessions(sessions: Session[], menu: SupergtResultSession[], tz: string): Map<string, SupergtResultSession> {
  const out = new Map<string, SupergtResultSession>();
  const used = new Set<number>();
  const sorted = [...sessions].sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  for (const s of sorted) {
    const k = sessionKind(s);
    if (!k) continue;
    const date = dateInZone(s.startUtc, tz);
    const md = `${Number(date.slice(5, 7))}-${Number(date.slice(8, 10))}`;
    let cands = menu.filter((r) => !used.has(r.raceNum) && r.kind === k.kind && (r.part ?? '') === (k.part ?? ''));
    // "Qualifying" a secas en el cronograma con Q1/Q2 en los resultados (o al revés): no se adivina.
    if (cands.length > 1) cands = cands.filter((r) => !r.monthDay || r.monthDay === md);
    else if (cands.length === 1 && cands[0]!.monthDay && cands[0]!.monthDay !== md) cands = [];
    const hit = cands[0];
    if (!hit) continue;
    used.add(hit.raceNum);
    out.set(s.id, hit);
  }
  return out;
}

interface ClassPage {
  rows: (ResultRow & { sortTime?: number })[];
  conditions?: SessionConditions;
}

const seconds = (t: string | undefined) => {
  if (!t) return undefined;
  const parts = t.split(':').map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
};

/** Filas de la tabla "common races" de una clase. */
export function supergtClassRows(html: string, cls: string, kind: Kind): ClassPage {
  const clean = stripComments(html);
  const table = clean.match(/<table class="common races">[\s\S]*?<\/table>/i)?.[0];
  if (!table) return { rows: [] };
  const { headers, rows } = parseHtmlTable(table);
  const iPos = column(headers, /^po/i);
  const iNo = column(headers, /^no/i);
  const iMachine = column(headers, /^machine/i);
  const iDriver = column(headers, /^driver/i);
  const iLaps = column(headers, /^laps?$/i);
  const iBest = column(headers, /^best\s*(time|lap)/i);
  const iDiff = column(headers, /^diff/i);
  if (iPos < 0 || iNo < 0 || iDriver < 0 || iBest < 0) {
    throw new Error(`SUPER GT: la tabla de resultados no tiene las columnas esperadas (${headers.join(', ')})`);
  }
  const label = cls.toUpperCase();
  const out: ClassPage['rows'] = [];
  for (const cells of rows) {
    const cell = (i: number) => (i >= 0 ? textOf(cells[i] ?? '') : '');
    const drivers = [...(cells[iDriver] ?? '').matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => textOf(m[1] ?? '')).filter(Boolean);
    const driver = (drivers.length ? drivers : [cell(iDriver)]).join(' / ');
    if (!driver) continue;
    const machineCell = iMachine >= 0 ? (cells[iMachine] ?? '') : '';
    const team = textOf(machineCell.match(/<dt>\s*Team\s*<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/i)?.[1] ?? '');
    const machine = textOf(machineCell.match(/<dt>\s*Machine\s*<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/i)?.[1] ?? '');
    // En práctica y clasificación, debajo del nombre del auto va el modelo entre paréntesis ("(Aston Martin Vantage GT3 EVO)").
    const model = textOf(machineCell.match(/<dt>\s*Machine\s*<\/dt>\s*<dd\b[^>]*>[\s\S]*?<\/dd>\s*<dd\b[^>]*>\s*\(([\s\S]*?)\)\s*<\/dd>/i)?.[1] ?? '');
    const vehicle = model || machine;
    const posText = cell(iPos);
    const group = posText.match(/^([A-Z])\s*-\s*(\d+)$/);
    const pos = group ? Number(group[2]) : /^\d+$/.test(posText) ? Number(posText) : null;
    const best = lapTime(cell(iBest));
    // Laps: "82" en carrera; "4/5" (vuelta de la mejor / total) en práctica y clasificación.
    const lapsText = cell(iLaps);
    const lapsNum = lapsText.match(/(\d+)\s*$/)?.[1];
    const laps = lapsNum !== undefined ? Number(lapsNum) : undefined;
    const gap = gapText(cell(iDiff));
    const row: ClassPage['rows'][number] = {
      pos,
      number: cell(iNo),
      driver,
      ...(team ? { team } : {}),
      ...(vehicle ? { vehicle } : {}),
      ...(laps !== undefined ? { laps } : {}),
      class: group ? `${label} (Grupo ${group[1]})` : label,
      ...(pos !== null ? { classPos: pos } : {}),
    };
    if (kind === 'race') {
      if (best) row.bestLap = best;
      if (gap && pos !== null) row.gap = gap;
    } else {
      if (best) row.time = best;
      if (gap) row.gap = gap;
      row.sortTime = seconds(best);
    }
    if (pos === null) {
      row.status = kind === 'race' ? (laps ? 'DNF' : 'DNS') : best ? 'NC' : 'DNS';
    }
    out.push(row);
  }
  const help = textOf(clean.match(/<div class="help">\s*<p class="mr20">([\s\S]*?)<\/p>/i)?.[1] ?? '');
  const cond = help.match(/Weather\s*:\s*(.*?)\s*\/\s*Track\s*:\s*(.*)$/i);
  const conditions = cond ? conditionsOf(cond[1]!, cond[2]!) : undefined;
  return { rows: out, ...(conditions ? { conditions } : {}) };
}

/**
 * General de la sesión con las filas de las dos clases (en el orden GT500, GT300):
 * carrera = clasificados por vueltas (a igual cantidad, la clase más rápida primero) y después los no clasificados;
 * práctica = por mejor vuelta; clasificación = el orden oficial de cada clase (GT500 y después GT300). Al final, los
 * que no tienen puesto.
 */
export function supergtOverall(byClass: ClassPage['rows'][], kind: Kind): ResultRow[] {
  const all = byClass.flatMap((rows, ci) => rows.map((r, i) => ({ r, ci, i })));
  const classified = all.filter((x) => x.r.pos !== null);
  const rest = all.filter((x) => x.r.pos === null);
  if (kind === 'race') {
    classified.sort((a, b) => (b.r.laps ?? 0) - (a.r.laps ?? 0) || a.ci - b.ci || a.i - b.i);
    rest.sort((a, b) => (b.r.laps ?? 0) - (a.r.laps ?? 0) || a.ci - b.ci || a.i - b.i);
  } else if (kind === 'practice') {
    const t = (x: (typeof all)[number]) => x.r.sortTime ?? Infinity;
    classified.sort((a, b) => t(a) - t(b) || a.ci - b.ci || a.i - b.i);
  }
  // Clasificación: cada clase (y cada grupo de GT300) clasifica por separado y el puesto puede salir de la suma de
  // tiempos de Q1 y Q2: se respeta el orden oficial de cada clase, GT500 primero.
  return [...classified, ...rest].map(({ r }, i) => {
    const { sortTime: _sortTime, ...row } = r;
    return { ...row, pos: row.pos === null ? null : i + 1 };
  });
}

export async function supergtResults(entry: CalendarEntry, sessions: Session[], ctx: RecipeContext): Promise<ResultsFound | null> {
  if (!entry.round) return null;
  const indexUrl = supergtResultUrl(ctx.season, entry.round, 'gt500');
  const index = await pageOrNull(ctx, indexUrl);
  if (!index || activeSeries(index) !== ctx.season) return null;
  const menu = supergtResultMenu(index, entry.round);
  if (menu.length === 0) return null;
  const matched = matchSupergtSessions(sessions, menu, entry.tz);
  const found: SessionResultFound[] = [];
  for (const [sessionId, rs] of matched) {
    const pages: ClassPage[] = [];
    for (const cls of CLASSES) {
      const url = supergtResultUrl(ctx.season, entry.round, cls, rs.raceNum);
      const html = await pageOrNull(ctx, url);
      if (!html || activeSeries(html) !== ctx.season) continue;
      // La página marca como "selected" la sesión que muestra: si no es la pedida, no se usa.
      const selected = stripComments(html).match(/<ul class="local_menu_pc">[\s\S]*?race_num=(\d+)[^"]*" class="selected"/i)?.[1];
      if (selected && Number(selected) !== rs.raceNum) continue;
      pages.push(supergtClassRows(html, cls, rs.kind));
    }
    const rows = supergtOverall(
      pages.map((p) => p.rows),
      rs.kind,
    );
    if (rows.length === 0) continue;
    const conditions = pages.find((p) => p.conditions)?.conditions;
    found.push({
      sessionId,
      rows,
      ...(conditions ? { conditions } : {}),
      source: {
        url: supergtResultUrl(ctx.season, entry.round, 'gt500', rs.raceNum),
        title: `SUPER GT ${ctx.season} Round${entry.round} — ${rs.label.replace(/^\d{1,2}-\d{1,2}\([A-Za-z]+\)/, '')}`,
        kind: 'html',
        method: 'directo',
        fetchedAt: isoNow(ctx.now),
      },
    });
  }
  return {
    sessions: found,
    source: { url: indexUrl, title: `SUPER GT ${ctx.season} Round${entry.round} — Results`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) },
  };
}
