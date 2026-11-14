/**
 * International GT Open: resultados desde los PDF de cronometraje que el calendario oficial
 * (gtopen.gtsport.es/calendario) publica en cada evento (campo `documentos` del JSON embebido: "Free Practice 1",
 * "Qualifying 1", "Race 1 (fin)", "Qualifying Driver 2", "Race"…; también tandas privadas, campeonato y listas de
 * inscriptos, que no son sesiones del evento).
 *
 * Cada PDF trae primero la clasificación general (Cls, Nº, Entrant/Team, Driver 1/2/3 con su nacionalidad,
 * Vehicle, Cat = PRO/PROAM/AM, Cl = puesto en la categoría, Laps, Total Time o Best/Time, Gap, Interval…), después
 * los "Not classified" y, en otras páginas, la vuelta rápida y la misma tabla por categoría (que no se lee). Al pie,
 * las condiciones medidas (Track Temp, Air Temp, Humidity, Track Status).
 *
 * El JSON no da la hora de las sesiones: para las fechas ya corridas se estima con el día típico del formato
 * (viernes prácticas, sábado clasificación 1 y carrera 1, domingo el resto) y una hora local fija.
 */
import { localToUtc, type ResultRow, type Session } from '@dm/shared';
import { pdfTextItems, type PdfItem } from '../adapters/fia-documents.ts';
import { safeUrl } from '../extract/document.ts';
import { extractEmbeddedJson } from '../extract/html.ts';
import { dateInZone, shiftDate } from './places.ts';
import { findArray, obj, str } from './kit.ts';
import {
  directSource,
  estimatedStart,
  fillClassPositions,
  isTransient,
  lapsGap,
  pdfConditions,
  pdfLines,
  pickSession,
  timeGap,
  type SourceSession,
} from './results-euro.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, ResultsFound, SessionResultFound, SessionsFound } from './types.ts';

const CALENDAR_URL = 'https://gtopen.gtsport.es/calendario';

export interface GtOpenDoc {
  /** Nombre normalizado de la sesión ("Free Practice 1", "Bronze Test", "Qualifying 2", "Race 1", "Race"). */
  name: string;
  url: string;
  /** Hora de publicación del PDF (ISO). */
  createdAt: string;
}

/** Nombre de sesión de un documento del evento; null si no es una sesión (tanda privada, campeonato, inscriptos…). */
export function gtOpenSessionName(title: string): string | null {
  const t = title.toLowerCase().replace(/\s+/g, ' ').trim();
  if (/priva\w*\s*test|standing|entry|schedule|clas\w*\s*gen|combined|comb\b|regulation|bulletin/.test(t)) return null;
  if (/bronze/.test(t)) return 'Bronze Test';
  const fp = t.match(/free\s*pra\w*\s*(\d)/);
  if (fp) return `Free Practice ${fp[1]}`;
  const q = t.match(/qualifying\D*(\d)/);
  if (q) return `Qualifying ${q[1]}`;
  if (/^qualifying\b/.test(t)) return 'Qualifying';
  const r = t.match(/race\D*(\d)/);
  if (r) return `Race ${r[1]}`;
  if (/^race\b/.test(t)) return 'Race';
  return null;
}

/** Eventos del calendario con sus documentos de sesión (los de la temporada pedida). */
export function gtOpenEventDocs(html: string, season: number): Array<{ name: string; raceDate: string; endurance: boolean; docs: GtOpenDoc[] }> {
  for (const value of extractEmbeddedJson(html)) {
    const eventos = findArray(value, (o) => 'nombre' in o && 'fecha' in o && 'circuito' in o);
    if (!eventos) continue;
    return eventos
      .filter((ev) => str(ev.fecha).startsWith(String(season)))
      .map((ev) => {
        const docs: GtOpenDoc[] = [];
        for (const d of ((ev.documentos as unknown[] | undefined) ?? []).map(obj)) {
          const name = gtOpenSessionName(str(d.title));
          const url = str(d.url);
          if (!name || !url) continue;
          // El último publicado de una sesión reemplaza al anterior ("Qualifying 2 (amended)").
          const prev = docs.findIndex((x) => x.name === name);
          const doc = { name, url, createdAt: str(d.createdAt) };
          if (prev < 0) docs.push(doc);
          else if (doc.createdAt >= docs[prev]!.createdAt) docs[prev] = doc;
        }
        return {
          name: str(ev.nombre).replace(/\s*-\s*GTO\s*-\s*\d{4}$/i, ''),
          raceDate: str(ev.fecha),
          endurance: /endurance/i.test(str(ev.tipo)),
          docs,
        };
      });
  }
  return [];
}

/** Día y hora local típicos de cada sesión (formato sprint: 2 carreras; endurance: 1 carrera de 3 horas). */
function plannedStart(name: string, entry: CalendarEntry, endurance: boolean): string {
  const fri = entry.dateStart;
  const sat = entry.dateEnd > entry.dateStart ? shiftDate(entry.dateEnd, -1) : entry.dateEnd;
  const sun = entry.dateEnd;
  const plan: Record<string, [string, string]> = endurance
    ? { 'Free Practice 1': [fri, '11:00'], 'Free Practice 2': [fri, '15:30'], 'Bronze Test': [sat, '09:00'], 'Qualifying 1': [sat, '10:30'], 'Qualifying 2': [sat, '15:00'], Race: [sun, '13:00'] }
    : {
        'Free Practice 1': [fri, '11:00'],
        'Free Practice 2': [fri, '15:30'],
        'Bronze Test': [fri, '17:30'],
        'Qualifying 1': [sat, '10:00'],
        'Race 1': [sat, '16:00'],
        'Qualifying 2': [sun, '09:30'],
        'Race 2': [sun, '14:30'],
      };
  const p = plan[name];
  return p ? localToUtc(p[0], p[1], entry.tz) : estimatedStart(sun, name, entry.tz);
}

async function eventDocs(entry: CalendarEntry, ctx: RecipeContext) {
  const html = (await ctx.http.text(CALENDAR_URL)).body;
  const events = gtOpenEventDocs(html, ctx.season);
  const inRange = (e: { raceDate: string }) => {
    const d = dateInZone(e.raceDate, entry.tz);
    return d >= entry.dateStart && d <= entry.dateEnd;
  };
  return events.find((e) => e.name === entry.name && inRange(e)) ?? events.find(inRange) ?? null;
}

export async function gtOpenPastSessions(entry: CalendarEntry, ctx: RecipeContext): Promise<SessionsFound | null> {
  const ev = await eventDocs(entry, ctx);
  if (!ev || ev.docs.length === 0) return null;
  const sessions: ExtractedSession[] = ev.docs
    .map((d) => ({ name: d.name, startUtc: plannedStart(d.name, entry, ev.endurance) }))
    .sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  return { sessions, source: directSource(CALENDAR_URL, `Resultados GT Open — ${entry.name}`, 'html', ctx) };
}

// ─── PDF ──────────────────────────────────────────────────────────────────────────────────────

type Role = 'pos' | 'number' | 'team' | 'nat' | 'driver' | 'vehicle' | 'cat' | 'classPos' | 'laps' | 'total' | 'gap' | 'interval' | 'kmh' | 'bestNo' | 'time' | 'other';

interface Column {
  role: Role;
  left: number;
  right: number;
}

/** Columnas del encabezado. "Interval Km/h" viene en un solo ítem: se parte en dos según la cantidad de letras. */
function headerColumns(line: PdfItem[]): Column[] {
  const cols: Column[] = [];
  let afterCat = false;
  let sawBest = false;
  for (const it of line) {
    const parts = it.s.split(/\s+(?=Km\/h$)/i);
    let x = it.x;
    for (const p of parts) {
      const w = (it.w * p.length) / it.s.length;
      const label = p.toLowerCase();
      let role: Role = 'other';
      if (/^cls?$/.test(label)) role = afterCat ? 'classPos' : 'pos';
      else if (/^n[ºo°]/.test(label)) role = 'number';
      else if (/entrant|team/.test(label)) role = 'team';
      else if (/^nat/.test(label)) role = 'nat';
      else if (/^driver/.test(label)) role = 'driver';
      else if (/vehicle|car\b/.test(label)) role = 'vehicle';
      else if (/^cat/.test(label)) {
        role = 'cat';
        afterCat = true;
      } else if (/^laps?$/.test(label)) role = 'laps';
      else if (/total/.test(label)) role = 'total';
      else if (/^gap/.test(label)) role = 'gap';
      else if (/^interval/.test(label)) role = 'interval';
      else if (/km\/h/.test(label)) role = 'kmh';
      else if (/^best/.test(label)) {
        role = 'bestNo';
        sawBest = true;
      } else if (/^time/.test(label) && sawBest) role = 'time';
      cols.push({ role, left: x, right: x + w });
      x += w;
    }
  }
  return cols;
}

const TEXT_ROLES = new Set<Role>(['team', 'nat', 'driver', 'vehicle']);

/** Celdas de un renglón: texto por borde izquierdo, números (alineados a la derecha) por borde derecho. */
function cells(line: PdfItem[], cols: Column[]): Array<{ role: Role; col: number; s: string }> {
  const firstText = cols.findIndex((c) => TEXT_ROLES.has(c.role));
  const cat = cols.findIndex((c) => c.role === 'cat');
  const textStart = firstText >= 0 ? cols[firstText]!.left - 4 : Infinity;
  const textEnd = cat >= 0 ? cols[cat]!.left - 12 : Infinity;
  const out: Array<{ role: Role; col: number; s: string }> = [];
  for (const it of line) {
    let idx = -1;
    if (it.x >= textStart && it.x < textEnd) {
      for (let i = 0; i < cols.length; i++) if (TEXT_ROLES.has(cols[i]!.role) && cols[i]!.left <= it.x + 4) idx = i;
    } else {
      let best = Infinity;
      for (let i = 0; i < cols.length; i++) {
        if (TEXT_ROLES.has(cols[i]!.role)) continue;
        const d = Math.abs(cols[i]!.right - (it.x + it.w));
        if (d < best) {
          best = d;
          idx = i;
        }
      }
    }
    if (idx >= 0) out.push({ role: cols[idx]!.role, col: idx, s: it.s.trim() });
  }
  return out;
}

const CATEGORY: Record<string, string> = { PRO: 'Pro', PROAM: 'Pro-Am', 'PRO-AM': 'Pro-Am', AM: 'Am' };

/** Clasificación general de un PDF de GT Open (práctica, clasificación o carrera). [] si no tiene la tabla. */
export function parseGtOpenItems(items: PdfItem[]): ResultRow[] {
  const rows: ResultRow[] = [];
  let cols: Column[] | null = null;
  let race = false;
  let notClassified = false;
  for (const line of pdfLines(items)) {
    const text = line.map((i) => i.s).join(' ');
    if (/^fastest lap\b|by category|^\*\s*penalt/i.test(text)) break;
    if (/\bdriver\s*1\b/i.test(text) && /\blaps\b/i.test(text)) {
      cols = headerColumns(line);
      race = cols.some((c) => c.role === 'total');
      continue;
    }
    if (!cols) continue;
    if (/^not classified/i.test(text)) {
      notClassified = true;
      continue;
    }
    const cs = cells(line, cols);
    const get = (role: Role) => cs.filter((c) => c.role === role).map((c) => c.s);
    const number = (get('number')[0] ?? '').replace(/\s*\*+$/, '');
    const drivers = get('driver').filter((d) => /\p{L}{2}/u.test(d));
    if (!/^\d+$/.test(number) || drivers.length === 0) continue;
    const posText = get('pos')[0] ?? '';
    const pos = !notClassified && /^\d+$/.test(posText) ? Number(posText) : null;
    const row: ResultRow = { pos, number, driver: drivers.join(' / ') };
    if (pos === null) row.status = 'NC';
    const team = get('team').join(' ').trim();
    if (team) row.team = team;
    const vehicle = get('vehicle').join(' ').trim();
    if (vehicle) row.vehicle = vehicle;
    const cat = (get('cat')[0] ?? '').toUpperCase();
    if (cat) row.class = CATEGORY[cat] ?? cat;
    const classPos = get('classPos')[0];
    if (pos !== null && classPos && /^\d+$/.test(classPos)) row.classPos = Number(classPos);
    const laps = get('laps')[0];
    if (laps && /^\d+$/.test(laps)) row.laps = Number(laps);
    if (race) {
      const total = get('total')[0];
      // A veces la diferencia y el intervalo vienen pegados en un solo ítem ("1 Lap 2:13.178"), alineado con el intervalo.
      const merged = get('interval').find((s) => /^\d+\s*laps?\s+\S/i.test(s));
      const gapText = get('gap')[0] ?? merged ?? '';
      const lapsDown = gapText.match(/^(\d+)\s*laps?\b/i);
      if (pos === 1 && total) row.time = total;
      else if (pos !== null && lapsDown) row.gap = lapsGap(Number(lapsDown[1]));
      else if (pos !== null && timeGap(gapText.split(/\s+/)[0] ?? '')) row.gap = timeGap(gapText.split(/\s+/)[0]!);
      const best = get('time')[0];
      if (best && /\d:\d{2}\.\d/.test(best)) row.bestLap = best;
    } else {
      const best = get('time')[0];
      if (best && /\d/.test(best)) row.time = best;
    }
    rows.push(row);
  }
  return rows;
}

export async function gtOpenResults(entry: CalendarEntry, sessions: Session[], ctx: RecipeContext): Promise<ResultsFound | null> {
  const ev = await eventDocs(entry, ctx);
  if (!ev || ev.docs.length === 0) return null;
  const all: SourceSession[] = ev.docs.map((d) => ({ name: d.name, startUtc: plannedStart(d.name, entry, ev.endurance) }));
  const out: SessionResultFound[] = [];
  const deferred: string[] = [];
  const failures: string[] = [];
  for (const [i, doc] of ev.docs.entries()) {
    const target = pickSession(sessions, all[i]!, all);
    if (!target || out.some((o) => o.sessionId === target.id)) continue;
    let items: PdfItem[];
    try {
      items = await pdfTextItems((await ctx.http.bytes(safeUrl(doc.url))).body);
    } catch (err) {
      if (isTransient(err)) deferred.push(target.id);
      else failures.push(err instanceof Error ? err.message : String(err));
      continue;
    }
    const rows = fillClassPositions(parseGtOpenItems(items));
    // Algunas clasificaciones finales se publican escaneadas (sin texto): esa sesión queda sin resultado.
    if (rows.length === 0) {
      failures.push(`GT Open: el PDF de ${doc.name} no tiene la tabla esperada (${doc.url})`);
      continue;
    }
    const conditions = pdfConditions(pdfLines(items).map((l) => l.map((i) => i.s).join(' ')).join('\n'));
    out.push({
      sessionId: target.id,
      rows,
      ...(conditions ? { conditions } : {}),
      source: directSource(doc.url, `GT Open — ${entry.name}: ${doc.name}`, 'pdf', ctx),
    });
  }
  if (out.length === 0 && failures.length > 0) throw new Error(failures[0]);
  return { sessions: out, source: directSource(CALENDAR_URL, `Resultados GT Open — ${entry.name}`, 'html', ctx), ...(deferred.length ? { deferred } : {}) };
}
