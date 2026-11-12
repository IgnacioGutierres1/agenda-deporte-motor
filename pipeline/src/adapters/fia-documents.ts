/**
 * Clasificaciones oficiales de F2/F3 publicadas por la FIA (https://www.fia.com/documents).
 *
 * La página de cada ronda de fiaformula2.com / fiaformula3.com solo embebe los resultados de la ÚLTIMA sesión con
 * resultados (casi siempre la carrera principal): práctica, clasificación y sprint de rondas pasadas no están en
 * ninguna página del sitio. La FIA, en cambio, publica en el tablero de documentos de cada evento un PDF por
 * sesión ("Doc 81 - F2 Race 1 (Sprint) - final classification"), con una fila por auto: posición, número, piloto,
 * equipo, vueltas, tiempo, diferencia y puntos.
 *
 * - Temporada:  /documents/championships/{campeonato}  (opciones `/season/season-{año}-{id}/event/{Evento}`)
 * - Evento:     /documents/championships/{campeonato}/season/season-{año}-{id}/event/{Evento}  (lista de PDFs)
 * - PDF:        se lee el texto con unpdf, con la posición x/y de cada texto para separar las columnas.
 */
import { parse } from 'node-html-parser';
import type { ResultRow } from '@dm/shared';
import type { Http } from '../core/http.ts';
import type { FomMeeting, FomSession } from './fom.ts';
import { lapsLabel } from './util.ts';

export const FIA_SITE = 'https://www.fia.com';

/** Campeonatos en el tablero de documentos de la FIA (ids estables desde hace años). */
export const FIA_CHAMPIONSHIPS: Record<string, string> = {
  f2: 'formula-2-championship-44',
  f3: 'fia-formula-3-championship-1012',
};

export interface FiaDocument {
  title: string;
  url: string;
}

export interface FiaEventOption {
  label: string;
  url: string;
}

// ─── Tablero de documentos ────────────────────────────────────────────────────────────────────

/** Eventos de la temporada pedida en el selector de la página del campeonato. */
export function fiaEventOptions(html: string, season: number): FiaEventOption[] {
  const re = new RegExp(`<option[^>]*value="([^"]*/season/season-${season}-\\d+/event/[^"]+)"[^>]*>([^<]+)`, 'g');
  const out = new Map<string, FiaEventOption>();
  for (const m of html.matchAll(re)) {
    const url = `${FIA_SITE}${m[1]!.replace(/&amp;/g, '&')}`;
    if (!out.has(url)) out.set(url, { label: decodeEntities(m[2]!).trim(), url });
  }
  return [...out.values()];
}

/** Página de la temporada (con sus eventos) si la del campeonato muestra otra temporada. */
export function fiaSeasonUrl(html: string, championship: string, season: number): string | null {
  const m = html.match(new RegExp(`/season/(season-${season}-\\d+)`));
  return m ? `${FIA_SITE}/documents/championships/${championship}/season/${m[1]}` : null;
}

/** Documentos (título y PDF) de la página de un evento, del más nuevo al más viejo. */
export function parseFiaDocumentList(html: string): FiaDocument[] {
  const docs: FiaDocument[] = [];
  for (const li of parse(html).querySelectorAll('li.document-row')) {
    const href = li.querySelector('a')?.getAttribute('href');
    const title = (li.querySelector('.title')?.text ?? '').replace(/\s+/g, ' ').trim();
    if (!href || !/\.pdf$/i.test(href) || !title) continue;
    docs.push({ title: decodeEntities(title), url: href.startsWith('http') ? href : `${FIA_SITE}${href}` });
  }
  return docs;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)));
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * Evento del tablero que corresponde a la ronda ("Montréal" <- montreal, "Barcelona-Catalunya" <- barcelona,
 * "Miami" <- miami-gardens, "Monaco" <- país de monte-carlo).
 */
export function matchFiaEvent(options: FiaEventOption[], meeting: Partial<FomMeeting>, slug: string): FiaEventOption | null {
  const names = [slug, meeting.meetingLocation, meeting.circuitShortName].filter((x): x is string => !!x).map(fold);
  const opts = options.map((o) => ({ o, key: fold(o.label) }));
  for (const n of names) {
    const hit = opts.find(({ key }) => key === n) ?? opts.find(({ key }) => key.startsWith(n) || n.startsWith(key));
    if (hit) return hit.o;
  }
  const country = meeting.meetingCountryName ? fold(meeting.meetingCountryName) : '';
  return (country && opts.find(({ key }) => key === country)?.o) || null;
}

// ─── Qué documento es de qué sesión ───────────────────────────────────────────────────────────

/** Clave de la sesión: "P" (práctica), "Q", "Q1"/"Q2" (o grupos A/B), "R1", "R2"… */
export function fomSessionKey(s: FomSession): string | null {
  const type = (s.sessionType || s.session || '').toLowerCase();
  const n = s.sessionNumber ?? Number(s.session.match(/(\d+)$/)?.[1] ?? 0);
  if (type.startsWith('practice')) return 'P';
  if (type.startsWith('qualifying')) {
    const text = [s.shortName, s.description, s.session].filter(Boolean).join(' ');
    const group = text.match(/\bgroup\s*([ab])\b/i)?.[1] ?? text.match(/\b([ab])$/i)?.[1];
    if (group) return `Q${group.toUpperCase() === 'A' ? 1 : 2}`;
    return n > 0 ? `Q${n}` : 'Q';
  }
  if (type.startsWith('race')) return n > 0 ? `R${n}` : null;
  return null;
}

export interface DocKey {
  key: string;
  /** 3 = final o enmendada, 2 = clasificación sin calificativo, 1 = provisoria. */
  rank: number;
}

/** Clave de sesión y "firmeza" de un documento de clasificación; null si el documento es otra cosa. */
export function classificationKey(title: string, seriesId: string): DocKey | null {
  const t = title.toLowerCase();
  if (!/classif/.test(t) || /infringement|decision|summons|grid|lap time|offence|note/.test(t)) return null;
  const tag = t.match(/\bf([23])\b/)?.[1];
  if (tag && `f${tag}` !== seriesId) return null;
  let key: string | null = null;
  const race = t.match(/\brace\s*(\d)\b/);
  const quali = t.match(/\bqualifying\b(?:\s*-?\s*(?:group\s*)?([ab12])\b)?/);
  if (race) key = `R${race[1]}`;
  else if (quali) key = quali[1] ? `Q${/[a1]/.test(quali[1]) ? 1 : 2}` : 'Q';
  else if (/\bpractice\b/.test(t)) key = 'P';
  if (!key) return null;
  const rank = /final|amended/.test(t) ? 3 : /provisional/.test(t) ? 1 : 2;
  return { key, rank };
}

/** El documento más firme de cada sesión (a igual firmeza, el más nuevo: la lista viene de nuevo a viejo). */
export function classificationsBySession(docs: FiaDocument[], seriesId: string): Map<string, FiaDocument & DocKey> {
  const best = new Map<string, FiaDocument & DocKey>();
  for (const d of docs) {
    const k = classificationKey(d.title, seriesId);
    if (!k) continue;
    const prev = best.get(k.key);
    if (!prev || k.rank > prev.rank) best.set(k.key, { ...d, ...k });
  }
  return best;
}

// ─── PDF de clasificación ─────────────────────────────────────────────────────────────────────

/** Texto del PDF con su posición (x/y en puntos, y crece hacia arriba) y ancho. */
export interface PdfItem {
  page: number;
  x: number;
  y: number;
  w: number;
  s: string;
}

export async function pdfTextItems(bytes: Uint8Array): Promise<PdfItem[]> {
  const { getDocumentProxy } = await import('unpdf');
  // unpdf/pdf.js toma posesión del buffer: se le pasa una copia.
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const items: PdfItem[] = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const content = await (await pdf.getPage(p)).getTextContent();
    for (const it of content.items) {
      if (!('str' in it) || !it.str.trim()) continue;
      items.push({
        page: p,
        x: Math.round(it.transform[4] * 10) / 10,
        y: Math.round(it.transform[5] * 10) / 10,
        w: Math.round(it.width * 10) / 10,
        s: it.str.trim(),
      });
    }
  }
  return items;
}

/** Fila tal como figura en el PDF (antes de unificar el nombre con el sitio de la categoría). */
export interface PdfClassificationRow extends ResultRow {
  /** Nombre como lo escribe la FIA ("Laurens VAN HOEPEN", "T. INTHRAPHUVASAK"). */
  pdfDriver: string;
}

const STATUS = /^(DNF|DNS|DSQ|DQ|NC|EXC|EX|DNQ|RET)$/i;
const STOP = /^(overall fastest lap|fastest lap|\*\s*penalt|timekeeper|notes?\b|the stewards)/i;
const SECTION_STATUS: [RegExp, string][] = [
  [/disqualif|excluded/i, 'DSQ'],
  [/did not start|not started/i, 'DNS'],
  [/not classified/i, 'NC'],
];

function lines(items: PdfItem[]): PdfItem[][] {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const out: PdfItem[][] = [];
  for (const it of sorted) {
    const last = out.at(-1);
    if (last && last[0]!.page === it.page && Math.abs(last[0]!.y - it.y) <= 2) last.push(it);
    else out.push([it]);
  }
  return out.map((l) => l.sort((a, b) => a.x - b.x));
}

const center = (i: PdfItem) => i.x + i.w / 2;
const isInt = (s: string) => /^\d+$/.test(s);
const hasLetters = (s: string) => /[a-z]/i.test(s);

/**
 * Filas de un PDF de clasificación de F2/F3 (carrera, clasificación o práctica). Las columnas numéricas se
 * asignan por cercanía al centro de su encabezado (LAPS, TIME, GAP, PTS…), así no importa si el PDF trae o no
 * columnas como "%" o "TIME OF DAY". Devuelve [] si no encuentra la tabla.
 */
export function parseClassificationItems(items: PdfItem[]): PdfClassificationRow[] {
  const rows: PdfClassificationRow[] = [];
  let header: { cols: Array<{ label: string; c: number }>; race: boolean } | null = null;
  let section: string | null = null;
  let stopped = false;
  let page = 0;

  for (const line of lines(items.filter((it) => !/^\*+$/.test(it.s)))) {
    const text = line.map((i) => i.s).join(' ');
    if (line[0]!.page !== page) {
      page = line[0]!.page;
      header = null;
      section = null;
      stopped = false;
    }
    if (/\bDRIVER\b/.test(text) && /\bTIME\b/.test(text) && /\bLAPS\b/.test(text)) {
      const cols = line
        .filter((i) => !/DRIVER|TEAM/.test(i.s))
        .map((i) => ({ label: i.s.toUpperCase(), c: center(i) }));
      header = { cols, race: cols.some((c) => c.label === 'PTS' || c.label === 'FASTEST') };
      continue;
    }
    if (!header || stopped) continue;
    if (STOP.test(text)) {
      stopped = true;
      continue;
    }
    if (line.length === 1 && hasLetters(text) && !/\d/.test(text)) {
      section = text;
      continue;
    }

    const lead: string[] = [];
    let i = 0;
    while (i < line.length && isInt(line[i]!.s) && lead.length < 2) lead.push(line[i++]!.s);
    const alpha = line.slice(i).filter((x) => hasLetters(x.s) && !STATUS.test(x.s));
    const driverItem = alpha[0];
    if (!driverItem || lead.length === 0 || driverItem !== line[i]) continue;
    const teamItem = alpha[1] && alpha[1] === line[i + 1] ? alpha[1] : undefined;
    const values = line.slice(i + (teamItem ? 2 : 1));

    const cell: Record<string, string> = {};
    for (const v of values) {
      const col = header.cols.reduce((a, b) => (Math.abs(b.c - center(v)) < Math.abs(a.c - center(v)) ? b : a));
      if (!(col.label in cell)) cell[col.label] = v.s;
    }

    const sectionStatus = section ? SECTION_STATUS.find(([re]) => re.test(section!))?.[1] : undefined;
    const classified = lead.length === 2 && !sectionStatus;
    const number = lead.length === 2 ? lead[1]! : lead[0]!;
    const pdfDriver = driverItem.s.replace(/\s*\*+\s*$/, '').trim();
    const row: PdfClassificationRow = { pos: classified ? Number(lead[0]) : null, driver: pdfDriver, pdfDriver, number };
    if (teamItem) row.team = teamItem.s;
    const laps = cell.LAPS;
    if (laps && isInt(laps)) row.laps = Number(laps);

    const gap = cell.GAP ?? '';
    const time = cell.TIME ?? '';
    if (STATUS.test(gap)) row.status = gap.toUpperCase();
    else if (!classified) row.status = sectionStatus ?? 'NC';
    if (header.race) {
      const lapsDown = gap.match(/^(\d+)\s*LAPS?$/i);
      if (lapsDown) row.gap = lapsLabel(Number(lapsDown[1]));
      else if (/^\d+(?::\d{2})?\.\d+$/.test(gap)) row.gap = `+${gap}${gap.includes(':') ? '' : 's'}`;
      else if (!row.status && time) row.time = time;
      const pts = cell.PTS;
      if (pts && /^\d+(?:\.\d+)?$/.test(pts)) row.points = Number(pts);
    } else if (time && /\d/.test(time)) {
      row.time = time;
    }
    rows.push(row);
  }
  return rows;
}

// ─── Nombres: los del sitio de la categoría ───────────────────────────────────────────────────

export interface RosterEntry {
  driver: string;
  team?: string;
}

/** "Laurens VAN HOEPEN" -> "Laurens Van Hoepen" (solo si el piloto no figura en el sitio de la categoría). */
export function titleCaseDriver(name: string): string {
  return name
    .split(/\s+/)
    .map((w) => (/[A-Z]{2}/.test(w) && w === w.toUpperCase() ? w.toLowerCase().replace(/(^|[-'’])(\p{L})/gu, (_, p: string, c: string) => p + c.toUpperCase()) : w))
    .join(' ');
}

/** Apellido(s) en mayúsculas del nombre de la FIA ("VAN HOEPEN"). */
function surname(pdfDriver: string): string {
  return pdfDriver
    .split(/\s+/)
    .filter((w) => /[A-Z]{2}/.test(w) && w === w.toUpperCase() && !w.endsWith('.'))
    .join(' ');
}

/**
 * Usa el nombre y el equipo del sitio de la categoría (con tildes, igual que en las demás sesiones) cuando el
 * número del auto coincide y el apellido también; si no (p. ej. un reemplazo en una ronda vieja), el de la FIA.
 */
export function withRosterNames(rows: PdfClassificationRow[], roster: Map<string, RosterEntry>): ResultRow[] {
  return rows.map(({ pdfDriver, ...row }) => {
    const entry = row.number ? roster.get(row.number) : undefined;
    const last = fold(surname(pdfDriver));
    if (entry && last && fold(entry.driver).includes(last)) {
      return { ...row, driver: entry.driver, ...(entry.team ? { team: entry.team } : {}) };
    }
    return { ...row, driver: titleCaseDriver(pdfDriver) };
  });
}

// ─── Lectura completa ─────────────────────────────────────────────────────────────────────────

/** Lista de eventos de la temporada en el tablero de la FIA (una o dos páginas). */
export async function fiaSeasonEvents(http: Http, seriesId: string, season: number): Promise<FiaEventOption[]> {
  const championship = FIA_CHAMPIONSHIPS[seriesId];
  if (!championship) return [];
  const rootUrl = `${FIA_SITE}/documents/championships/${championship}`;
  const root = (await http.text(rootUrl)).body;
  const events = fiaEventOptions(root, season);
  if (events.length > 0) return events;
  const seasonUrl = fiaSeasonUrl(root, championship, season);
  if (!seasonUrl) return [];
  return fiaEventOptions((await http.text(seasonUrl)).body, season);
}
