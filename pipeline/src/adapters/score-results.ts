/**
 * Resultados de SCORE International: results.score-international.com, el sitio oficial de cronometraje de SCORE
 * (LiveTime Scoring). Tres páginas HTML, sin IA:
 *
 * - Eventos:    /events/  -> tabla "2026 SCORE Baja 1000 | Nov 10, 2026 to Nov 15, 2026" con el link
 *               /results/?p=view_event&id={id}.
 * - Evento:     /results/?p=view_event&id={id} -> bloques "Practice Round 1 Results", "Qualifying Results" y
 *               "Race Results"; en cada uno, una "carrera" por grupo ("SCORE Trophy Truck Qualifying",
 *               "Group 1 Qualifying", "Baja 1000 Moto", "Baja 1000 4-wheel") con el link a la clasificación
 *               general ("Overall Combined Results", si junta varias clases) o directo (una sola clase).
 * - Resultado:  /results/?p=view_race_result&id={id}[&show_combined=1] -> tabla POS | PIC (puesto en la clase) |
 *               CAR # | BRAND | DRIVER (con la clase debajo y DNF/DQ) | QUAL # o GRID # | LAPS/TIME ("1/8:40:50.386",
 *               tiempo corregido de cada uno, que larga en otro momento) | BEHIND | …
 *
 * El sitio numera también a los que abandonaron (con "DNF" y "0" vueltas): esos van sin puesto y con su estado.
 * Solo publica al piloto o al motociclista "de registro" (no los acompañantes ni los relevos).
 */
import { parse, type HTMLElement } from 'node-html-parser';
import { driverDisplayName, type ResultRow } from '@dm/shared';
import { scoreRaceKey } from './score-docs.ts';

export const SCORE_RESULTS_SITE = 'https://results.score-international.com';
export const SCORE_RESULTS_EVENTS_URL = `${SCORE_RESULTS_SITE}/events/`;

const clean = (s: string | undefined): string =>
  (s ?? '')
    // La marca registrada llega rota (U+FFFD) o como ® / ™: no aporta al nombre de la clase.
    .replace(/[�®™]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

export interface LiveTimeEvent {
  id: string;
  name: string;
  url: string;
  /** Clave de la carrera ("baja-1000") y año, si el nombre los trae. */
  key: string | null;
  year: number | null;
}

/** Lista de eventos del sitio de resultados. */
export function parseLiveTimeEvents(html: string): LiveTimeEvent[] {
  const root = parse(html);
  const out: LiveTimeEvent[] = [];
  for (const a of root.querySelectorAll('a[href*="p=view_event"]')) {
    const href = a.getAttribute('href') ?? '';
    const id = href.match(/[?&]id=(\d+)/)?.[1];
    const name = clean(a.text);
    if (!id || !name || out.some((e) => e.id === id)) continue;
    const year = name.match(/\b(20\d{2})\b/)?.[1];
    out.push({ id, name, url: new URL(href, SCORE_RESULTS_SITE).toString(), key: scoreRaceKey(name), year: year ? Number(year) : null });
  }
  return out;
}

export type LiveTimeSection = 'practica' | 'clasificacion' | 'carrera' | 'otro';

export interface LiveTimeRace {
  section: LiveTimeSection;
  /** "SCORE Trophy Truck Qualifying", "Group 1 Qualifying", "Baja 1000 Moto", "BAJA 400 4-wheel". */
  name: string;
  /** Clasificación general (la combinada si junta clases). */
  url: string;
}

function sectionOf(title: string): LiveTimeSection {
  if (/practice/i.test(title)) return 'practica';
  if (/qualif/i.test(title)) return 'clasificacion';
  if (/race|final/i.test(title)) return 'carrera';
  return 'otro';
}

/** Carreras de un evento con el link a su clasificación general. */
export function parseLiveTimeEventPage(html: string): LiveTimeRace[] {
  const root = parse(html);
  const card = root.querySelectorAll('.card').find((c) => /race results/i.test(c.querySelector('.card-header')?.text ?? ''));
  const races: LiveTimeRace[] = [];
  let section: LiveTimeSection = 'otro';
  let current: { section: LiveTimeSection; name: string; url?: string } | null = null;
  const close = () => {
    if (current?.url) races.push({ section: current.section, name: current.name, url: current.url });
    current = null;
  };
  for (const tr of card?.querySelectorAll('tr') ?? []) {
    const heading = tr.querySelector('h5');
    if (heading) {
      close();
      section = sectionOf(clean(heading.text));
      continue;
    }
    const link = tr.querySelector('a[href*="view_race_result"]');
    if (tr.querySelector('.fa-award')) {
      close();
      // Una sola clase: el nombre es el link. Varias: el link viene en el renglón siguiente.
      current = { section, name: clean((link ?? tr.querySelector('td'))?.text) };
      if (link) current.url = new URL(link.getAttribute('href') ?? '', SCORE_RESULTS_SITE).toString();
      continue;
    }
    if (current && !current.url && link && /overall|combined/i.test(link.text)) {
      current.url = new URL(link.getAttribute('href') ?? '', SCORE_RESULTS_SITE).toString();
    }
  }
  close();
  return races;
}

export interface LiveTimeResult {
  /** "BAJA 400 4-wheel Race Results" */
  title: string;
  rows: ResultRow[];
}

/** "1/8:40:50.386" -> "8:40:50.386"; "0" o vacío -> undefined. */
function raceTime(raw: string): string | undefined {
  const t = raw.replace(/^\d+\s*\/\s*/, '').trim();
  return /^\d{1,2}(?::\d{2}){0,2}\.\d+$/.test(t) && !/^0+(?:\.0+)?$/.test(t) ? t : undefined;
}

/** Estado escrito debajo del nombre ("DNF", "DQ", "DQ | DNF"): el más grave. */
function statusOf(parts: string[]): string | undefined {
  const marks = parts.map((p) => p.toUpperCase());
  if (marks.some((m) => /^(DQ|DSQ)$/.test(m))) return 'DSQ';
  if (marks.includes('DNS')) return 'DNS';
  if (marks.includes('DNF')) return 'DNF';
  return undefined;
}

/**
 * Clasificación de una carrera de LiveTime. `className`: la clase de todos cuando la página es de una sola clase
 * (no la escribe debajo de cada nombre).
 */
export function parseLiveTimeResult(html: string, className?: string): LiveTimeResult {
  const root = parse(html);
  const title = clean(root.querySelector('.card-header h2')?.text);
  const table = root.querySelector('.card-body table');
  const head = (table?.querySelectorAll('thead th') ?? []).map((th) => clean(th.text).toUpperCase());
  const col = (name: RegExp) => head.findIndex((h) => name.test(h));
  const iPos = col(/^POS$/);
  const iPic = col(/^PIC$/);
  const iCar = col(/^CAR/);
  const iDriver = col(/^DRIVER$/);
  const iTime = col(/^LAPS\/TIME$/);
  const iBehind = col(/^BEHIND$/);
  const rows: ResultRow[] = [];
  for (const tr of table?.querySelectorAll('tr') ?? []) {
    if (!tr.getAttribute('data-driver-id') && !/driver_details_link/.test(tr.getAttribute('class') ?? '')) continue;
    const cells = tr.querySelectorAll('td');
    const cell = (i: number): HTMLElement | undefined => (i >= 0 ? cells[i] : undefined);
    const driverCell = cell(iDriver);
    if (!driverCell) continue;
    // El nombre es el texto suelto; debajo, en <div class="small">, la clase y el estado (DNF, DQ).
    const marks = driverCell.querySelectorAll('div, span');
    const extras = marks.map((d) => clean(d.text)).filter(Boolean);
    for (const d of marks) d.remove();
    const name = clean(driverCell.text);
    if (!name) continue;
    const status = statusOf(extras);
    const cls = extras.find((e) => !/^(DNF|DNS|DQ|DSQ)$/i.test(e)) ?? className;
    const time = raceTime(clean(cell(iTime)?.text));
    const pos = Number(clean(cell(iPos)?.text));
    const pic = Number(clean(cell(iPic)?.text));
    const behind = clean(cell(iBehind)?.text);
    const number = clean(cell(iCar)?.text);
    // Sin tiempo y sin estado (clasificación sin vuelta válida): queda sin puesto.
    const ranked = !status && !!time && Number.isInteger(pos) && pos > 0;
    rows.push({
      pos: ranked ? pos : null,
      ...(status ? { status } : !time ? { status: 'NC' } : {}),
      ...(number ? { number } : {}),
      // "LUKE MCMILLIN" -> "Luke McMillin" (el sitio escribe todo en mayúsculas).
      driver: driverDisplayName(name)
        .replace(/\bMc([a-z])(?=[a-z]{2})/g, (_m, c: string) => `Mc${c.toUpperCase()}`)
        .replace(/\b(J|S)R$/, (_m, c: string) => `${c}r.`),
      ...(time ? { time } : {}),
      ...(ranked && behind && /^\d/.test(behind) ? { gap: `+${behind}` } : {}),
      ...(cls ? { class: clean(cls) } : {}),
      ...(ranked && Number.isInteger(pic) && pic > 0 ? { classPos: pic } : {}),
    });
  }
  return { title, rows };
}
