/**
 * Resultados de ACTC (TC, TC Pista, TC Pick Up, TC Mouras) sin IA.
 *
 * La página oficial https://actc.org.ar/{categoría}/resultados trae en el payload RSC (Next.js) la lista completa de
 * documentos de la temporada (initialData.results.events[].days[].items[] = { id, title, date, pdfUrl, excelUrl,
 * kind }). Los documentos son del cronometraje oficial (tiempos.actc.org.ar, "sistema CURVA - Cronometraje Oficial
 * ACTC"): un PDF con texto por tanda ("1ER ENTRENAMIENTO TC", "CLASIFICACION", "2DA SERIE TC", "FINAL TC").
 * Los parciales, grillas y vuelta por vuelta no son resultados de sesión y se descartan; lo que solo está en Excel
 * (.xls, sin lector en el pipeline) también.
 *
 * Fila del PDF: "2 117 ROSSI MATIAS TOYOTA 25 43:56.497 2.287" (puesto, número, APELLIDO NOMBRE, marca, vueltas,
 * tiempo total o mejor vuelta, diferencia; "6 Vueltas" si está a vueltas; "-- -- --" si no largó). El nombre se
 * reemplaza por el del campeonato oficial (mismo número y mismas palabras): "Matías ROSSI".
 */
import type { Session } from '@dm/shared';
import { extractEmbeddedJson, textOf } from '../extract/html.ts';
import { pdfText } from './cronograma-ar.ts';
import { column, findObject, obj, parseHtmlTable, str } from './kit.ts';
import { shiftDate } from './places.ts';
import {
  arRows,
  arSessionKey,
  arSessionName,
  checkArRows,
  isRaceKind,
  lapTime,
  matchArSessions,
  pastSessionsFromDocs,
  resultsSource,
  withKnownNames,
  type ArSessionKey,
  type KnownDriver,
  type PastDoc,
  type RawRow,
} from './results-ar.ts';
import type { CalendarEntry, RecipeContext, ResultsFound, SessionResultFound, SessionsFound } from './types.ts';

const ORIGIN = 'https://actc.org.ar';
/** Cronometraje oficial de ACTC (los documentos de la lista están ahí). */
const TIEMPOS = 'https://tiempos.actc.org.ar';

/** Documento de la lista oficial de resultados. */
export interface ActcResultItem {
  id: number;
  title: string;
  /** Día local YYYY-MM-DD. */
  date: string;
  pdfUrl: string | null;
  excelUrl: string | null;
  kind: string;
}

/** Documentos de la temporada de la página /{categoría}/resultados (payload RSC). Lanza un error si no están. */
export function actcResultItems(html: string): { year: number; items: ActcResultItem[] } {
  let results: Record<string, unknown> | null = null;
  for (const value of extractEmbeddedJson(html)) {
    results = findObject(value, (o) => Array.isArray(o.events) && 'year' in o && 'category' in o);
    if (results) break;
  }
  if (!results) throw new Error('ACTC: la página de resultados no trae la lista de documentos');
  const items: ActcResultItem[] = [];
  for (const ev of (results.events as unknown[]).map(obj)) {
    for (const day of (Array.isArray(ev.days) ? ev.days : []).map(obj)) {
      for (const it of (Array.isArray(day.items) ? day.items : []).map(obj)) {
        const pdfUrl = str(it.pdfUrl);
        const excelUrl = str(it.excelUrl);
        items.push({
          id: Number(it.id),
          title: str(it.title).replace(/\s+/g, ' ').trim(),
          date: (str(it.date) || str(day.date)).slice(0, 10),
          pdfUrl: pdfUrl || null,
          excelUrl: excelUrl || null,
          kind: str(it.kind),
        });
      }
    }
  }
  return { year: Number(results.year), items };
}

/** Documento con resultado de una sesión, ya con su clave. */
interface ActcDoc {
  key: ArSessionKey;
  item: ActcResultItem;
}

/**
 * Documentos de resultados de una fecha: los publicados entre el día anterior al primero y cuatro días después del
 * último (la final a veces se sube el lunes o el martes), sin parciales, grillas ni combinados ("SERIES TC"). Si una
 * tanda tiene dos documentos (rectificado, subido dos veces), queda el último publicado, con preferencia por el PDF
 * (lo que está solo en Excel se lee de la vista "Ver" del cronometraje).
 */
export function actcEventDocs(items: ActcResultItem[], entry: Pick<CalendarEntry, 'dateStart' | 'dateEnd'>): ActcDoc[] {
  const from = shiftDate(entry.dateStart, -1);
  const to = shiftDate(entry.dateEnd, 4);
  const byKey = new Map<string, ActcDoc>();
  for (const item of items) {
    if (item.date < from || item.date > to || (!item.pdfUrl && !item.excelUrl)) continue;
    if (/gril+a|parcial|\bseries\b/i.test(`${item.kind} ${item.title}`)) continue;
    const key = arSessionKey(item.title);
    if (!key) continue;
    const id = `${key.kind}|${key.n ?? ''}`;
    const prev = byKey.get(id);
    const better = !prev || (!!item.pdfUrl === !!prev.item.pdfUrl ? item.id > prev.item.id : !!item.pdfUrl);
    if (better) byKey.set(id, { key, item });
  }
  return [...byKey.values()].sort((a, b) => a.item.date.localeCompare(b.item.date) || a.item.id - b.item.id);
}

/** Nombre de la sesión de un documento ("1° Entrenamiento", "Clasificación", "Serie única", "Final"). */
function docName(doc: ActcDoc, docs: ActcDoc[]): string {
  const series = docs.filter((d) => d.key.kind === 'serie');
  const single = doc.key.kind === 'serie' ? series.length === 1 && /unica/i.test(doc.item.title) : doc.key.kind === 'clasificacion';
  return arSessionName(doc.key, { single });
}

/** Hora local (HH:MM) de publicación según el nombre del archivo ("20261025_165254_FINAL_TC.pdf"), si es del mismo día. */
function publishedAt(item: ActcResultItem): string | undefined {
  const m = (item.pdfUrl ?? item.excelUrl)?.match(/\/(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})\d{2}_/);
  // Un documento rectificado se sube bastante después de la tanda: su hora no sirve para estimar la de la sesión.
  if (!m || `${m[1]}-${m[2]}-${m[3]}` !== item.date || /rectific/i.test(item.title)) return undefined;
  return `${m[4]}:${m[5]}`;
}

const MARCAS =
  /\s((?:MERCEDES[\s-]BENZ|MUSTANG|CAMARO|CHALLENGER|TORINO|TOYOTA(?:\s+HILUX)?|BMW|CHEVROLET|FORD|DODGE|FOTON|RAM|NISSAN(?:\s+FRONTIER)?|VW|VOLKSWAGEN(?:\s+AMAROK)?|AMAROK|FIAT|RENAULT|PEUGEOT|CITROEN|HONDA|ISUZU|MITSUBISHI|JEEP|IKA|CHEVROLET\s+S10|S10|HILUX|RANGER|FRONTIER))$/i;
// Tiempos "1:35.589", "43:54.210", "2.287" y, en los PDF de LapSync, "24;07.699".
const T = String.raw`\d{1,2}(?:[:.;]\d{2}){0,2}[.,]\d{1,3}`;
const LAPS = String.raw`\d+|--`;
const GAP = String.raw`${T}|--|\d+\s+(?:Vueltas?|VTAS?)`;
type Col = 'laps' | 'time' | 'gap';

/**
 * Fila de resultado con las columnas finales en el orden del encabezado: casi siempre "Vtas | Total T° (o Mejor
 * tiempo) | Dif.", pero algunos PDF traen "Mejor tiempo | Dif. | Vtas".
 */
function rowRegex(order: Col[]): RegExp {
  const part = { laps: LAPS, time: `${T}|--`, gap: GAP };
  const [a, b, c] = order.map((o) => part[o]);
  // La diferencia del primero puede faltar (PDF de LapSync) si es la última columna.
  const last = order[2] === 'gap' ? String.raw`(?:\s+(${c}))?` : String.raw`\s+(${c})`;
  return new RegExp(String.raw`^(\d+|--|EX|NC|DES\w*)\s+(\d+)\s+(.+?)\s+(${a})\s+(${b})${last}$`, 'i');
}

/** Orden de las columnas finales según la línea de encabezado ("Pos. N° Nombre Marca Vtas Total T° Dif."). */
function headerOrder(line: string): Col[] | null {
  if (!/^pos\.?\s+n/i.test(line)) return null;
  const found = (['laps', 'time', 'gap'] as Col[])
    .map((c) => ({ c, at: line.search(c === 'laps' ? /\bvtas\b|\bvueltas\b/i : c === 'time' ? /\btotal\b|\bmejor\b|\btiempo\b/i : /\bdif/i) }))
    .filter((x) => x.at >= 0)
    .sort((x, y) => x.at - y.at)
    .map((x) => x.c);
  return found.length === 3 ? found : null;
}

/**
 * Clasificación por tercios o cuartos (TC Pick Up): "POS N° NOMBRE MARCA CL3 CL2 CL1" y en cada fila solo el tiempo
 * de la tanda en que la corrió el piloto ("1 1 CANAPINO AGUSTIN CHEVROLET 1:27.640").
 */
const ROW_TANDAS = new RegExp(String.raw`^(\d+)\s+(\d+)\s+(.+?[A-Z])((?:\s+(?:${T}|--))+)$`, 'i');

interface CurvaLine {
  pos: string;
  number: string;
  /** Nombre y marca juntos ("DI PALMA LUIS JOSE TOYOTA"). */
  rest: string;
  laps: string;
  time: string;
  gap: string;
  /** El encabezado tiene columna Marca. */
  make: boolean;
}

/**
 * Filas de un PDF de ACTC, en cualquiera de los formatos de 2026: el del sistema CURVA (una línea por piloto, con
 * las columnas en el orden del encabezado y a veces sin marca) o el de Orbits (por columnas). Ordenadas por puesto
 * (un recargo puede quedar impreso al final). Sin nombres del campeonato todavía.
 */
export function actcPdfRows(text: string): RawRow[] {
  const orbits = orbitsPdfRows(text);
  const rows = orbits ?? curvaPdfRows(text);
  return rows.sort((a, b) => (a.pos ?? Infinity) - (b.pos ?? Infinity));
}

function curvaPdfRows(text: string): RawRow[] {
  const parsed: CurvaLine[] = [];
  let order: Col[] = ['laps', 'time', 'gap'];
  let make = true;
  let rowRe = rowRegex(order);
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+/g, ' ').trim();
    const header = headerOrder(line);
    if (header) {
      order = header;
      make = /\bmarca\b/i.test(line);
      rowRe = rowRegex(order);
      continue;
    }
    const hit = line.match(rowRe);
    if (hit) {
      const v = { [order[0]!]: hit[4]!, [order[1]!]: hit[5]!, [order[2]!]: hit[6] ?? '--' } as Record<Col, string>;
      parsed.push({ pos: hit[1]!, number: hit[2]!, rest: hit[3]!, laps: v.laps, time: v.time, gap: v.gap, make });
      continue;
    }
    const t = line.match(ROW_TANDAS);
    if (!t) continue;
    const times = t[4]!.trim().split(' ').map((x) => lapTime(x)).filter((x): x is string => !!x);
    const best = times.sort((a, b) => a.padStart(10, '0').localeCompare(b.padStart(10, '0')))[0];
    parsed.push({ pos: t[1]!, number: t[2]!, rest: t[3]!, laps: '--', time: best ?? '--', gap: '--', make: true });
  }
  // Marcas que no están en la lista: la última palabra, si se repite en otras filas del mismo documento.
  const lastWords = new Map<string, number>();
  for (const p of parsed) {
    const w = p.rest.split(' ').at(-1)!;
    lastWords.set(w, (lastWords.get(w) ?? 0) + 1);
  }
  return parsed.map((p) => {
    let driver = p.rest;
    let vehicle: string | undefined;
    if (p.make) {
      const brand = ` ${p.rest}`.match(MARCAS);
      const words = p.rest.split(' ');
      if (brand) {
        driver = ` ${p.rest}`.slice(0, brand.index).trim();
        vehicle = brand[1]!.replace(/\s+/g, ' ').toUpperCase();
      } else if (words.length > 2 || words.at(-1) === '--') {
        const last = words.at(-1)!;
        driver = words.slice(0, -1).join(' ');
        if (/[a-z]/i.test(last) && (lastWords.get(last) ?? 0) >= 2) vehicle = last;
      }
    }
    const status = /^\d+$/.test(p.pos) ? undefined : /^ex|^des/i.test(p.pos) ? 'DSQ' : p.pos === 'NC' ? 'NC' : undefined;
    return {
      pos: /^\d+$/.test(p.pos) ? Number(p.pos) : null,
      ...(status ? { status } : {}),
      number: p.number,
      driver: driver || p.rest,
      ...(vehicle ? { vehicle } : {}),
      ...(/^\d+$/.test(p.laps) ? { laps: Number(p.laps) } : {}),
      ...(lapTime(p.time) ? { time: lapTime(p.time)! } : {}),
      ...(p.gap !== '--' ? { gap: p.gap } : {}),
    };
  });
}


// ─── PDF de Orbits (MyLaps), primeras fechas de 2026 ──────────────────────────────────────────

type OrbitsCol = 'pos' | 'number' | 'name' | 'make' | 'laps' | 'total' | 'best' | 'diff' | 'ignored';

/** Encabezados de columna de los PDF de Orbits, en inglés o en español. */
const ORBITS_HEADERS: Array<[RegExp, OrbitsCol]> = [
  [/^pos\.?$/i, 'pos'],
  [/^(?:no\.|n°|nº)$/i, 'number'],
  [/^(?:name|nombre)$/i, 'name'],
  [/^(?:make|marca)$/i, 'make'],
  [/^(?:laps|vueltas|vtas\.?)$/i, 'laps'],
  [/^(?:total tm|tiempo total|tpo\. total)$/i, 'total'],
  [/^(?:best tm|mejor tm|mejor tiempo)$/i, 'best'],
  [/^(?:diff|dif\.(?: al)? 1[°º])$/i, 'diff'],
  [/^(?:gap|dif\. ant\.?|best speed|mejor vel\.|prom vel\.|en vta\.?)$/i, 'ignored'],
];
const ORBITS_END = /^(?:clasificado por|announcements|printed:|página \d|pagina \d|jefe de cronometraje)/i;
/** Línea con varios encabezados juntos ("Best Tm Diff Gap Best Speed"): sus valores no se pueden asignar. */
const ORBITS_MULTI = /^(?:(?:best|total|mejor)\s+tm|diff|gap|best speed|mejor vel\.|dif\.[^\n]*)(?:\s+(?:best|total|mejor|tm|diff|gap|speed|vel\.|dif\.|al|1°|ant\.?))+$/i;

/** "M E R C E D E S B E N Z" -> "MERCEDES BENZ" (el PDF separa las letras de algunas celdas). */
function joinSpacedLetters(s: string): string {
  const words = s.split(' ');
  return words.length > 3 && words.every((w) => w.length <= 2) ? s.replace(/\s+/g, '').replace(/^MERCEDESBENZ$/i, 'MERCEDES BENZ') : s;
}

/**
 * Filas de un PDF de Orbits: el texto sale por columnas (todos los puestos, después todos los números, todos los
 * nombres…), una página tras otra. Los tiempos y diferencias se listan desde arriba (el que no marcó tiempo va al
 * final) y la diferencia empieza en el segundo. null si el texto no tiene ese formato.
 */
export function orbitsPdfRows(text: string): RawRow[] | null {
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!lines.some((l) => /^(?:orbits|www\.mylaps\.com)$/i.test(l))) return null;
  const rows: RawRow[] = [];
  let cols: Partial<Record<OrbitsCol, string[]>> = {};
  let current: OrbitsCol | null = null;
  const flush = () => {
    const pos = cols.pos ?? [];
    const time = cols.total ?? cols.best ?? [];
    pos.forEach((p, i) => {
      const laps = Number(cols.laps?.[i]);
      const t = lapTime(time[i] ?? '');
      const diff = i > 0 ? cols.diff?.[i - 1] : undefined;
      rows.push({
        pos: /^\d+$/.test(p) ? Number(p) : null,
        ...(/^\d+$/.test(p) ? {} : { status: /^(?:ex|dsq|desc)/i.test(p) ? 'DSQ' : /^(?:dns|dnf|nc)$/i.test(p) ? p.toUpperCase() : 'NC' }),
        number: cols.number?.[i] ?? '',
        driver: cols.name?.[i] ?? '',
        ...(cols.make?.[i] ? { vehicle: joinSpacedLetters(cols.make[i]!).toUpperCase() } : {}),
        ...(Number.isFinite(laps) && cols.laps?.[i] ? { laps } : {}),
        ...(t ? { time: t } : {}),
        ...(diff ? { gap: diff.replace(/^(\d+)\s+laps?$/i, '$1 Vueltas') } : {}),
      });
    });
    cols = {};
  };
  for (const line of lines) {
    const header = ORBITS_HEADERS.find(([re]) => re.test(line))?.[1];
    if (header === 'pos' && cols.pos) flush(); // página nueva
    if (header) {
      current = header;
      cols[header] = [];
      continue;
    }
    if (ORBITS_END.test(line) || ORBITS_MULTI.test(line)) {
      current = ORBITS_MULTI.test(line) ? 'ignored' : null;
      continue;
    }
    if (current && current !== 'ignored') cols[current]!.push(current === 'name' ? line : line);
  }
  flush();
  return rows.filter((r) => r.driver && r.number);
}

/**
 * Resultado en HTML: el exportado por Orbits (algunas fechas, p. ej. Rafaela: Pos. | N° | Nombre | Make | En Vuelta |
 * Mejor Tm | Dif. resp. 1° | …; "En Vuelta" es la vuelta del mejor tiempo, no la cantidad de vueltas) o la vista
 * "Ver" del cronometraje (https://tiempos.actc.org.ar/resultados/N/ver: P | N° | Piloto | Marca | Tiempo total | Dif. |
 * Vtas), que se usa para los resultados publicados solo en Excel.
 */
export function actcHtmlRows(html: string): RawRow[] {
  const table = html
    .replace(/<(td|th)\b([^>]*)\/>/gi, '<$1$2></$1>')
    .match(/<table\b[\s\S]*?<\/table>/gi)
    ?.find((t) => /nombre|name|piloto/i.test(t));
  if (!table) return [];
  const { headers, rows } = parseHtmlTable(table);
  const col = (re: RegExp) => column(headers, re);
  const [cPos, cNum, cName, cMake, cLaps, cTime, cGap] = [
    /^(?:pos\.?|p)$/i, /^(?:n[°º]|no\.?)$/i, /^(?:nombre|name|piloto)/i, /^(?:make|marca)/i, /^(?:vtas|vueltas|laps)$/i,
    /total|mejor|best|^tiempo/i, /^dif/i,
  ].map(col);
  if (cPos! < 0 || cName! < 0) return [];
  return rows.map((cells) => {
    const cell = (i: number) => (i >= 0 ? textOf(cells[i] ?? '') : '');
    const p = cell(cPos!);
    const laps = Number(cell(cLaps!));
    const time = lapTime(cell(cTime!));
    return {
      pos: /^\d+$/.test(p) ? Number(p) : null,
      ...(/^\d+$/.test(p) || !p ? {} : { status: /^(?:ex|dsq|desc)/i.test(p) ? 'DSQ' : /^(?:dns|dnf|nc)$/i.test(p) ? p.toUpperCase() : 'NC' }),
      number: cell(cNum!),
      driver: cell(cName!),
      ...(cell(cMake!) ? { vehicle: cell(cMake!).toUpperCase() } : {}),
      ...(cLaps! >= 0 && Number.isFinite(laps) && cell(cLaps!) ? { laps } : {}),
      ...(time ? { time } : {}),
      ...(cell(cGap!) ? { gap: cell(cGap!) } : {}),
    };
  });
}

/** Pilotos del campeonato oficial de la categoría (número y nombre), para los nombres de los resultados. */
async function actcKnownDrivers(code: string, ctx: RecipeContext): Promise<KnownDriver[]> {
  try {
    const html = (await ctx.http.text(`${ORIGIN}/${code}/campeonato`)).body;
    for (const value of extractEmbeddedJson(html)) {
      const champ = findObject(value, (o) => Array.isArray(o.drivers) && 'year' in o);
      if (!champ) continue;
      return (champ.drivers as unknown[]).map(obj).map((d) => ({
        number: str(d.carNumber).trim(),
        name: (str(d.fullName) || `${str(d.givenName)} ${str(d.surname)}`).replace(/\s+/g, ' ').trim(),
      }));
    }
  } catch {
    // Sin campeonato, los nombres quedan como en el PDF.
  }
  return [];
}

const listUrl = (code: string) => `${ORIGIN}/${code}/resultados`;

async function eventDocs(entry: CalendarEntry, code: string, ctx: RecipeContext): Promise<ActcDoc[]> {
  const { year, items } = actcResultItems((await ctx.http.text(listUrl(code))).body);
  if (year !== ctx.season) return [];
  return actcEventDocs(items, entry);
}

/**
 * Sesiones de una fecha desde la lista de documentos de resultados: las de una fecha ya corrida, o las ya
 * terminadas de la fecha en curso cuando ACTC no publicó el cronograma (así sus resultados tienen dónde ir).
 */
export async function actcPastSessions(entry: CalendarEntry, code: string, ctx: RecipeContext): Promise<SessionsFound | null> {
  const docs = await eventDocs(entry, code, ctx);
  if (docs.length === 0) return null;
  const past: PastDoc[] = docs.map((d) => {
    const published = publishedAt(d.item);
    return { key: d.key, name: docName(d, docs), date: d.item.date, ...(published ? { published } : {}) };
  });
  return {
    sessions: pastSessionsFromDocs(past, entry),
    source: resultsSource(listUrl(code), `Resultados ${code.toUpperCase()} — ${entry.name}`, 'html', ctx),
  };
}

/** Resultados de las sesiones pedidas de una fecha (un PDF por sesión encontrada). */
export async function actcResults(entry: CalendarEntry, sessions: Session[], code: string, ctx: RecipeContext): Promise<ResultsFound | null> {
  const docs = await eventDocs(entry, code, ctx);
  if (docs.length === 0) return null;
  const named = docs.map((d) => {
    const name = docName(d, docs);
    return { ...d, name, key: arSessionKey(name) ?? d.key };
  });
  const pairs = matchArSessions(named, sessions);
  const known = pairs.length > 0 ? await actcKnownDrivers(code, ctx) : [];
  const out: SessionResultFound[] = [];
  const errors: Error[] = [];
  for (const [session, doc] of pairs) {
    // Casi siempre PDF; algunas fechas (Rafaela) se publicaron como HTML exportado por Orbits, y lo que está solo en
    // Excel se lee de la vista "Ver" del cronometraje oficial.
    const url = doc.item.pdfUrl ?? `${TIEMPOS}/resultados/${doc.item.id}/ver`;
    const html = !doc.item.pdfUrl || /\.html?$/i.test(url);
    try {
      const text = html ? (await ctx.http.text(url)).body : await pdfText(ctx, url);
      if (!text) continue;
      const raw = html ? actcHtmlRows(text) : actcPdfRows(text);
      const rows = checkArRows(withKnownNames(arRows(raw, isRaceKind(doc.key.kind)), known), `ACTC ${doc.item.title}`);
      out.push({
        sessionId: session.id,
        rows,
        source: resultsSource(url, `${doc.item.title} — ${entry.name}`, html ? 'html' : 'pdf', ctx),
      });
    } catch (err) {
      // Un PDF con otro formato no tira abajo los demás de la fecha (queda pendiente y se vuelve a intentar).
      errors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  // Si no se pudo leer ninguno, el formato cambió: que el flujo genérico lo informe.
  if (out.length === 0 && errors.length > 0) throw errors[0];
  return { sessions: out, source: resultsSource(listUrl(code), `Resultados ${code.toUpperCase()} — ${entry.name}`, 'html', ctx) };
}
