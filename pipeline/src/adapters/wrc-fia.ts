/**
 * Páginas del WRC en el sitio de la FIA (https://www.fia.com/events/world-rally-championship/season-{año}/…):
 *
 * - Calendario:      …/events-calendar            (fechas, nombre oficial, país y rallies cancelados)
 * - Clasificaciones: …/{rally}/classifications     (una tabla por tramo: tiempos del tramo y general acumulada)
 * - Inscriptos:      …/{rally}/entry-list          (número, piloto y copiloto con nombre completo, equipo y auto)
 * - Campeonato:      …/standings                   (pilotos, copilotos, constructores y categorías de soporte)
 *
 * Son tablas HTML que la FIA arma con los datos del cronometraje oficial: se leen sin IA.
 */
import { parse, type HTMLElement } from 'node-html-parser';
import { driverDisplayName, titleCaseCaps, type ResultRow, type StandingsRow, type StandingsTable } from '@dm/shared';
import { isoDate, monthNumber } from '../generic/places.ts';
import { FIA_SITE } from './fia-documents.ts';

export const FIA_WRC = `${FIA_SITE}/events/world-rally-championship`;

export function fiaWrcCalendarUrl(season: number): string {
  return `${FIA_WRC}/season-${season}/events-calendar`;
}

export function fiaWrcStandingsUrl(season: number): string {
  return `${FIA_WRC}/season-${season}/standings`;
}

const text = (el: HTMLElement | null | undefined) => (el?.text ?? '').replace(/\s+/g, ' ').trim();

/**
 * La FIA escribe los equipos en mayúsculas ("HYUNDAI SHELL MOBIS WORLD RALLY TEAM"): se pasan a "Título" y solo
 * quedan en mayúsculas las siglas cortas o con números ("WRT", "HF", "WRT2", "2C").
 */
export function teamName(raw: string): string {
  return titleCaseCaps(raw).replace(/(?<![\p{L}\p{N}])\p{Lu}{4,}(?![\p{L}\p{N}])/gu, (w) => w.charAt(0) + w.slice(1).toLocaleLowerCase('es'));
}
/** Líneas de una celda separadas por <br> ("99<br />M", "O. SOLBERG<br />E. EDMONDSON<br />Toyota GR Yaris Rally1"). */
const cellLines = (el: HTMLElement | null | undefined) =>
  (el?.innerHTML ?? '')
    .split(/<br\s*\/?>/i)
    .map((part) => text(parse(part)));

// ─── Calendario ───────────────────────────────────────────────────────────────────────────────

export interface FiaRally {
  /** Nombre oficial ("94e Rallye Monte-Carlo", "WRC Croatia Rally 2026"). */
  name: string;
  dateStart: string;
  dateEnd: string;
  /** ISO 3166 alfa-2 de la bandera ("MC", "SE"). */
  iso2: string;
  cancelled: boolean;
  /** Identificador del rally en las URL de la FIA ("rally-ditalia"); falta en los cancelados. */
  slug?: string;
  classificationsUrl?: string;
  entryListUrl?: string;
}

/** Rallies del calendario de la temporada, en el orden de la página (incluye los cancelados, marcados). */
export function parseFiaCalendar(html: string, season: number): FiaRally[] {
  const out: FiaRally[] = [];
  for (const item of parse(html).querySelectorAll('.sport-events .event-item')) {
    const day = (sel: string) => Number(text(item.querySelector(`${sel} .day`)));
    const month = (sel: string) => monthNumber(text(item.querySelector(`${sel} .month`)));
    const m1 = month('.from-date');
    const m2 = month('.to-date') ?? m1;
    const name = text(item.querySelector('.event-name'));
    const start = m1 ? isoDate(season, m1, day('.from-date')) : null;
    // Sin fecha de fin es un evento de un día; un fin "anterior" al inicio cruza el año.
    const end = m2 && day('.to-date') ? isoDate(m1 && m2 < m1 ? season + 1 : season, m2, day('.to-date')) : start;
    if (!name || !start || !end) continue;
    const slug = item
      .querySelector('.event a')
      ?.getAttribute('href')
      ?.match(/\/season-\d{4}\/([^/?#"]+)/)?.[1];
    const cancelled = /\bcancel/i.test(item.getAttribute('class') ?? '') || /cancel/i.test(text(item.querySelector('.event-status')));
    out.push({
      name,
      dateStart: start,
      dateEnd: end,
      iso2: (item.querySelector('.country img')?.getAttribute('alt') ?? '').trim().toUpperCase(),
      cancelled,
      ...(slug
        ? {
            slug,
            classificationsUrl: `${FIA_WRC}/season-${season}/${slug}/classifications`,
            entryListUrl: `${FIA_WRC}/season-${season}/${slug}/entry-list`,
          }
        : {}),
    });
  }
  return out;
}

// ─── Clasificaciones de un rally ──────────────────────────────────────────────────────────────

export interface FiaCrewRow {
  pos: number;
  number: string;
  /** Como lo publica el cronometraje: inicial y apellido ("O. SOLBERG"). */
  driver: string;
  codriver: string;
  vehicle: string;
  /** Tiempo total acumulado ("3:24:57.0"). */
  time: string;
  /** Diferencia con el primero ("00:00:57.600"). */
  diff: string;
}

export interface FiaStageClassification {
  /** Número del tramo (SS17 -> 17). */
  number: number;
  /** Nombre del tramo según el cronometraje ("SASSARI - ARGENTIERA 2 / Wolf Pw Stage"). */
  name: string;
  km?: number;
  /** true si la FIA la rotula "UNOFFICIAL" (tiempos del cronometraje, antes de la clasificación oficial). */
  unofficial: boolean;
  /** Clasificación general después del tramo. */
  overall: FiaCrewRow[];
}

/** Una entrada por tramo disputado, con la clasificación general acumulada después de ese tramo. */
export function parseFiaClassifications(html: string): FiaStageClassification[] {
  const out: FiaStageClassification[] = [];
  for (const table of parse(html).querySelectorAll('table.stage-table')) {
    const [title = '', stage = ''] = cellLines(table.querySelector('th.table-head'));
    const number = Number(title.match(/AFTER\s+SS\s*(\d+)/i)?.[1] ?? stage.match(/^SS\s*(\d+)/i)?.[1]);
    if (!Number.isInteger(number) || number <= 0) continue;
    const km = Number.parseFloat(stage.match(/(\d+(?:\.\d+)?)\s*KMS?\s*$/i)?.[1] ?? '');
    const overall: FiaCrewRow[] = [];
    for (const tr of table.querySelectorAll('tr')) {
      if (/header-color/.test(tr.getAttribute('class') ?? '')) continue;
      const tds = tr.querySelectorAll('td');
      // 11 columnas: 5 de la clasificación del tramo, un separador y 5 de la general.
      if (tds.length < 11) continue;
      const pos = Number(text(tds[6]));
      const [driver = '', codriver = '', vehicle = ''] = cellLines(tds[8]);
      if (!Number.isInteger(pos) || pos <= 0 || !driver) continue;
      overall.push({
        pos,
        number: cellLines(tds[7])[0] ?? '',
        driver,
        codriver,
        vehicle,
        time: cellLines(tds[9])[0] ?? '',
        diff: cellLines(tds[10])[0] ?? '',
      });
    }
    out.push({
      number,
      name: stage
        .replace(/^SS\s*\d+\s*-\s*/i, '')
        .replace(/\s*-\s*\d+(?:\.\d+)?\s*KMS?\s*$/i, '')
        .trim(),
      ...(Number.isFinite(km) ? { km } : {}),
      unofficial: /unofficial/i.test(title),
      overall,
    });
  }
  return out.sort((a, b) => a.number - b.number);
}

/** "00:00:57.600" -> "+57.6s"; "00:01:37.400" -> "+1:37.4"; "01:26:35.300" -> "+1:26:35.3"; sin diferencia, undefined. */
export function rallyGap(diff: string): string | undefined {
  const m = diff.match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!m) return undefined;
  const [h, min, sec] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const tenths = (m[4] ?? '0').charAt(0);
  if (h === 0 && min === 0 && sec === 0 && tenths === '0') return undefined;
  const ss = String(sec).padStart(2, '0');
  if (h > 0) return `+${h}:${String(min).padStart(2, '0')}:${ss}.${tenths}`;
  if (min > 0) return `+${min}:${ss}.${tenths}`;
  return `+${sec}.${tenths}s`;
}

// ─── Lista de inscriptos ──────────────────────────────────────────────────────────────────────

export interface FiaEntry {
  /** Nombre completo, ya legible ("Sébastien Ogier"). */
  driver: string;
  codriver: string;
  /** Equipo inscripto ("Toyota Gazoo Racing WRT"). */
  entrant: string;
  car: string;
}

/** Inscriptos por número de auto. */
export function parseFiaEntryList(html: string): Map<string, FiaEntry> {
  const out = new Map<string, FiaEntry>();
  for (const tr of parse(html).querySelectorAll('tr.competitor')) {
    const tds = tr.querySelectorAll('td');
    if (tds.length < 5) continue;
    const number = text(tds[0]);
    const [driver = '', codriver = ''] = cellLines(tds[2]);
    if (!/^\d+$/.test(number) || !driver) continue;
    out.set(number, {
      driver: driverDisplayName(driver),
      codriver: codriver ? driverDisplayName(codriver) : '',
      entrant: teamName(text(tds[1])),
      car: cellLines(tds[4]).filter(Boolean).join(' '),
    });
  }
  return out;
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** "O. SOLBERG" y "Oliver Solberg": mismo apellido. */
function sameSurname(abbreviated: string, full: string): boolean {
  const surname = fold(abbreviated.replace(/^(?:\p{L}\.\s*)+/u, ''));
  return !!surname && fold(full).includes(surname);
}

/**
 * Filas de resultado de una clasificación general: tripulación "Piloto / Copiloto" con el nombre completo de la
 * lista de inscriptos (si el auto figura y el apellido coincide), equipo y auto; el primero lleva su tiempo total y
 * el resto la diferencia.
 */
export function crewRows(rows: FiaCrewRow[], entries: Map<string, FiaEntry>): ResultRow[] {
  return rows.map((r) => {
    const entry = entries.get(r.number);
    const known = entry && sameSurname(r.driver, entry.driver) ? entry : undefined;
    const driver = known?.driver ?? driverDisplayName(r.driver);
    // El copiloto puede cambiar después de publicada la lista: vale el del cronometraje si no coincide.
    const codriver = !r.codriver
      ? (known?.codriver ?? '')
      : known && sameSurname(r.codriver, known.codriver)
        ? known.codriver
        : driverDisplayName(r.codriver);
    const team = known && fold(known.entrant) !== fold(known.driver) ? known.entrant : undefined;
    const gap = r.pos > 1 ? rallyGap(r.diff) : undefined;
    return {
      pos: r.pos,
      ...(r.number ? { number: r.number } : {}),
      driver: codriver ? `${driver} / ${codriver}` : driver,
      ...(team ? { team } : {}),
      ...(known?.car || r.vehicle ? { vehicle: known?.car || r.vehicle } : {}),
      ...(gap ? { gap } : r.time ? { time: r.time } : {}),
    };
  });
}

// ─── Campeonato ───────────────────────────────────────────────────────────────────────────────

const TITLES: Array<[RegExp, string]> = [
  [/World Rally Championship for Drivers/i, 'Pilotos'],
  [/World Rally Championship for Co-?Drivers/i, 'Copilotos'],
  [/World Rally Championship for Manufacturers/i, 'Constructores'],
];

/**
 * Tablas del campeonato absoluto (pilotos, copilotos y constructores). La página trae también equipos y las
 * categorías de soporte (WRC2, WRC3, Junior, Masters), que no se publican.
 */
export function parseFiaStandings(html: string): StandingsTable[] {
  const tables: StandingsTable[] = [];
  for (const table of parse(html).querySelectorAll('table')) {
    const head = text(table.querySelector('th.table-head'));
    const title = TITLES.find(([re]) => re.test(head))?.[1];
    if (!title || tables.some((t) => t.title === title)) continue;
    const crew = title !== 'Constructores';
    const rows: StandingsRow[] = [];
    for (const tr of table.querySelectorAll('tr.competitor')) {
      const pos = Number(text(tr.querySelector('td.position')));
      const name = text(tr.querySelector('td.driver .name'));
      const points = Number.parseFloat(text(tr.querySelector('td.points')));
      if (!Number.isInteger(pos) || pos <= 0 || !name || !Number.isFinite(points)) continue;
      const country = tr.querySelector('td.driver .country img')?.getAttribute('alt')?.trim();
      // Victorias: rallies en los que la posición final (renglón de abajo de cada celda) fue 1.
      const wins = tr.querySelectorAll('td.pts .blue').filter((d) => text(d) === '1').length;
      rows.push({
        pos,
        name: crew ? driverDisplayName(name) : teamName(name),
        points,
        ...(crew ? { wins } : {}),
        ...(crew && country ? { country } : {}),
      });
    }
    if (rows.length > 0) tables.push({ title, rows });
  }
  return tables;
}
