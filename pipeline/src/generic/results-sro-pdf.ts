/**
 * Resultados en PDF de los sitios de SRO que no publican la tabla HTML por sesión (GT World Challenge Australia y
 * el Bathurst 12 Hour del IGTC): clasificaciones de NATSOFT ("Timing System By NATSOFT"), con columnas
 * Pos | Car | Competitor/Team | Driver | Vehicle | Cap | CL | Laps | Race.Time | Fastest…Lap (carrera) o
 * … | CL | Laps | Fastest…Lap | Gap (práctica y clasificación). Los textos de dos columnas vecinas a veces vienen
 * juntos en el PDF ("Tigani B.Leitch/S.Pires", "PRO 262 12:01:39.8977"): se separan por palabra según su posición.
 * Otros formatos de PDF (los del IGTC fuera de Bathurst) no se leen: devuelven [].
 */
import type { ResultRow } from '@dm/shared';
import { pdfTextItems, type PdfItem } from '../adapters/fia-documents.ts';
import { formatSeconds, lapsLabel, trimLapTime } from '../adapters/util.ts';

/** "1:02:03.456" | "2:04.1" | "45.678" -> segundos. */
export function timeSeconds(text: string): number | null {
  const m = text.trim().match(/^(?:(\d+):)?(?:(\d+):)?(\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const parts = [m[1], m[2], m[3]].filter((x): x is string => x !== undefined).map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

/** Puesto en la clase, ordenando la general (solo filas clasificadas). */
export function addClassPositions(rows: ResultRow[]): ResultRow[] {
  const count = new Map<string, number>();
  return rows.map((r) => {
    if (!r.class || r.pos === null) return r;
    const n = (count.get(r.class) ?? 0) + 1;
    count.set(r.class, n);
    return { ...r, classPos: n };
  });
}

interface Word {
  x: number;
  s: string;
}

/** Palabras de un texto del PDF con su posición estimada (proporcional a los caracteres dentro del ancho). */
function words(it: PdfItem): Word[] {
  const out: Word[] = [];
  const len = Math.max(1, it.s.length);
  for (const m of it.s.matchAll(/\S+/g)) out.push({ x: it.x + (it.w * (m.index ?? 0)) / len, s: m[0] });
  return out;
}

/** Renglones del PDF (por página y altura), de arriba hacia abajo. */
function pdfLines(items: PdfItem[]): PdfItem[][] {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const out: PdfItem[][] = [];
  for (const it of sorted) {
    const last = out[out.length - 1];
    if (last && last[0]!.page === it.page && Math.abs(last[0]!.y - it.y) < 2.5) last.push(it);
    else out.push([it]);
  }
  return out.map((l) => l.sort((a, b) => a.x - b.x));
}

/** Clases de NATSOFT en SRO: "PA"/"PAM" Pro-Am, "PRO", "SIL", "GOL", "BRO", "AM", "T" Trophy, "I" Invitational. */
const NATSOFT_CLASS: Record<string, string> = {
  PRO: 'Pro',
  PA: 'Pro-Am',
  PAM: 'Pro-Am',
  SIL: 'Silver',
  SA: 'Silver-Am',
  GOL: 'Gold',
  GOLD: 'Gold',
  BRO: 'Bronze',
  AM: 'Am',
  T: 'Trophy',
  I: 'Invitational',
};

const POS = /^(\d+|NC|DNF|DNS|DSQ|DQ|EXC|RET)$/i;
const TIME = /^\d+(?::\d{2}){0,2}\.\d+\*?$/;

/** "B.Feeney/B.Schumacher" -> "B. Feeney / B. Schumacher"; "Alex Peroni (AUS)" -> "Alex Peroni". */
export function natsoftDrivers(raw: string): string {
  return raw
    .replace(/\(\s*[A-Z]{3}\s*\)/g, ' ')
    .split('/')
    .map((d) => d.replace(/\s+/g, ' ').trim().replace(/^([A-Z])\.(?=\S)/, '$1. '))
    .filter(Boolean)
    .join(' / ');
}

/**
 * Filas de una clasificación de NATSOFT a partir de los textos del PDF. Lanza un error si el PDF no tiene la fila de
 * títulos esperada; [] si no tiene filas.
 */
export function natsoftRows(items: PdfItem[]): ResultRow[] {
  const lines = pdfLines(items);
  const headerLine = lines.find((l) => /^pos$/i.test(l[0]?.s ?? '') && l.some((i) => /^driver/i.test(i.s)));
  if (!headerLine) throw new Error('NATSOFT: el PDF no tiene la fila de títulos (Pos | Car | … | Driver)');
  const at = (re: RegExp) => headerLine.find((i) => re.test(i.s))?.x ?? NaN;
  const xTeam = at(/^competitor/i);
  const xDriver = at(/^driver/i);
  const xVehicle = at(/^vehicle/i);
  const xCap = at(/^cap/i);
  const xCl = at(/^cl\b/i);
  if (![xTeam, xDriver, xVehicle, xCl].every(Number.isFinite)) throw new Error('NATSOFT: columnas inesperadas');
  const raceLayout = headerLine.some((i) => /race\.?\s*time/i.test(i.s));
  const xEndVehicle = Number.isFinite(xCap) ? xCap : xCl;

  interface Raw {
    pos: string;
    car: string;
    team: string[];
    driver: string[];
    vehicle: string[];
    right: string[];
  }
  const raws: Raw[] = [];
  let current: Raw | null = null;
  // Solo se leen los renglones que siguen a la fila de títulos (se repite en cada página) hasta el primero que no es
  // una fila: así no se confunden el encabezado ("2026 GT Festival…") ni las notas del pie ("10 Safety Car…").
  let inTable = false;
  for (const line of lines) {
    const ws = line.flatMap(words);
    const first = ws[0];
    if (!first) continue;
    if (/^pos$/i.test(first.s)) {
      inTable = true;
      current = null;
      continue;
    }
    const isRow = inTable && first.x < 12 && POS.test(first.s) && ws.length >= 4;
    // Renglón de continuación: pilotos que no entran en un renglón (tripulaciones de resistencia), nunca el pie.
    const isContinuation =
      inTable && !!current && first.x >= xDriver - 3 && first.x < xCl - 3 && !line.some((i) => /natsoft|timing|printed|issue#/i.test(i.s));
    if (!isRow && !isContinuation) {
      inTable = false;
      current = null;
      continue;
    }
    if (isRow) {
      current = { pos: first.s, car: '', team: [], driver: [], vehicle: [], right: [] };
      raws.push(current);
    }
    for (const w of isRow ? ws.slice(1) : ws) {
      if (w.x < xTeam - 2) current!.car ||= w.s;
      else if (w.x < xDriver - 2) current!.team.push(w.s);
      else if (w.x < xVehicle - 2) current!.driver.push(w.s);
      else if (w.x < xEndVehicle - 2) current!.vehicle.push(w.s);
      else if (w.x >= xCl - 2) current!.right.push(w.s);
    }
  }

  const rows: ResultRow[] = [];
  let leader: { laps: number; total: number | null } | null = null;
  for (const r of raws) {
    const right = [...r.right];
    const cls = right[0] && /^[A-Z][A-Z0-9-]*$/i.test(right[0]) && !TIME.test(right[0]) && !/^\d+$/.test(right[0]) ? right.shift()! : '';
    const laps = /^\d+$/.test(right[0] ?? '') ? Number(right.shift()) : undefined;
    const times = right.filter((t) => TIME.test(t)).map((t) => t.replace(/\*$/, ''));
    const pos = /^\d+$/.test(r.pos) ? Number(r.pos) : null;
    const driver = natsoftDrivers(r.driver.join(' '));
    if (!driver) continue;
    const row: ResultRow = { pos, driver };
    if (pos === null) row.status = r.pos.toUpperCase() === 'DQ' ? 'DSQ' : r.pos.toUpperCase() === 'RET' ? 'DNF' : r.pos.toUpperCase();
    if (r.car) row.number = r.car;
    const team = r.team.join(' ').replace(/\s*\/\s*/g, ' / ').trim();
    if (team) row.team = team;
    const vehicle = r.vehicle.join(' ').trim();
    if (vehicle) row.vehicle = vehicle;
    if (cls) row.class = NATSOFT_CLASS[cls.toUpperCase()] ?? cls.toUpperCase();
    if (laps !== undefined && laps > 0) row.laps = laps;
    if (raceLayout) {
      const totalText = times[0];
      const total = totalText ? timeSeconds(totalText) : null;
      if (times.length > 1) row.bestLap = trimLapTime(times[times.length - 1]);
      if (pos === 1) {
        leader = { laps: laps ?? 0, total };
        if (totalText) row.time = totalText.replace(/^0(?=\d:)/, '');
      } else if (pos !== null && leader && laps !== undefined) {
        if (laps < leader.laps) row.gap = lapsLabel(leader.laps - laps);
        else if (total !== null && leader.total !== null && total >= leader.total) row.gap = `+${formatSeconds(total - leader.total)}`;
      }
    } else {
      if (times[0]) row.bestLap = trimLapTime(times[0]);
      // "0:00.0186" -> "+0.0186"; "0:01.0976" -> "+1.0976"; "1:02.3000" queda igual.
      const gap = times[1]?.replace(/^0:(?=\d\d\.)/, '').replace(/^0(?=\d\.)/, '');
      if (gap && pos !== null && pos > 1) row.gap = `+${gap}`;
    }
    rows.push(row);
  }
  return addClassPositions(rows);
}

/** Filas de un PDF de resultados de SRO. [] si el formato no se reconoce (no es NATSOFT). */
export async function sroPdfRows(bytes: Uint8Array): Promise<ResultRow[]> {
  const items = await pdfTextItems(bytes);
  if (!items.some((i) => /natsoft/i.test(i.s))) return [];
  return natsoftRows(items);
}
