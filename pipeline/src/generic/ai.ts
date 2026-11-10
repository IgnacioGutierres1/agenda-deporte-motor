/**
 * Extracciones con Gemini sobre documentos oficiales ya descargados (Gemini no busca en la web):
 * calendario, cronograma, resultados y campeonato. Cada salida pasa por controles anti-alucinación
 * contra el texto del documento antes de usarse.
 */
import { DateTime } from 'luxon';
import { localToUtc, type ResultRow, type Series, type StandingsTable } from '@dm/shared';
import type { FetchedDocument } from '../extract/document.ts';
import { hasUsableText } from '../extract/document.ts';
import { GeminiUnavailableError, type Gemini, type GeminiSchema } from '../extract/gemini.ts';
import { appearsInDocument, normalizeForMatch } from '../validate.ts';
import type { ExtractionCache } from './cache.ts';
import { guessTimeZone } from './places.ts';
import type { CalendarEntry, ExtractedSession } from './types.ts';

/** Cambiar cuando cambien los prompts o esquemas (invalida la caché). */
export const PROMPT_VERSION = 'v1';

export interface AiDeps {
  gemini: Gemini;
  cache: ExtractionCache;
}

const SYSTEM =
  'Sos un transcriptor de documentos oficiales de automovilismo. Copiás datos tal como figuran en el documento, ' +
  'sin inventar, completar ni deducir nada que no esté escrito. Si un dato no figura, lo omitís o devolvés null.';

/** Llama a Gemini solo si no hay una extracción en caché para este documento. */
async function cached<T>(
  deps: AiDeps,
  seriesId: string,
  kind: string,
  doc: FetchedDocument,
  extra: string,
  run: () => Promise<T>,
): Promise<T> {
  const hit = await deps.cache.get<T>(seriesId, kind, doc.hash, extra);
  if (hit) return hit.data;
  if (!deps.gemini.available) throw new GeminiUnavailableError(deps.gemini.unavailableReason);
  const data = await run();
  await deps.cache.set(seriesId, kind, doc.hash, { url: doc.url, model: deps.gemini.extractModel, createdAt: new Date().toISOString(), data }, extra);
  return data;
}

function docPayload(doc: FetchedDocument): { text?: string; pdf?: Uint8Array } {
  return doc.kind === 'pdf' && doc.pdf ? { pdf: doc.pdf } : { text: doc.text };
}

const S = (description?: string): GeminiSchema => ({ type: 'STRING', ...(description ? { description } : {}) });
const N = (description?: string): GeminiSchema => ({ type: 'INTEGER', nullable: true, ...(description ? { description } : {}) });

// ─── Calendario ───────────────────────────────────────────────────────────────────────────────

interface AiCalendar {
  events: Array<{
    name: string;
    circuit?: string;
    city?: string;
    country?: string;
    timeZone?: string;
    dateStart: string;
    dateEnd?: string;
    round?: number | null;
    url?: string;
    championship?: string;
  }>;
}

const calendarSchema: GeminiSchema = {
  type: 'OBJECT',
  properties: {
    events: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: S('Nombre del evento tal como figura'),
          circuit: S('Circuito o autódromo'),
          city: S(),
          country: S('País en inglés'),
          timeZone: S('Zona IANA del circuito, p. ej. Europe/Rome'),
          dateStart: S('Primer día del evento, YYYY-MM-DD'),
          dateEnd: S('Último día del evento, YYYY-MM-DD'),
          round: N('Número de fecha/ronda'),
          url: S('Link (URL absoluta) a la página del evento, si figura en el documento'),
          championship: S('Campeonato o categoría (solo calendarios con varias categorías)'),
        },
        required: ['name', 'dateStart'],
      },
    },
  },
  required: ['events'],
};

export async function aiCalendar(
  deps: AiDeps,
  series: Series,
  doc: FetchedDocument,
  season: number,
  opts: { multiSeries?: boolean } = {},
): Promise<CalendarEntry[]> {
  if (!hasUsableText(doc)) return [];
  const data = await cached<AiCalendar>(deps, series.id, opts.multiSeries ? 'calendar-multi' : 'calendar', doc, String(season), () =>
    deps.gemini.generateJson<AiCalendar>({
      system: SYSTEM,
      label: `calendario ${series.id}`,
      ...docPayload(doc),
      schema: calendarSchema,
      prompt: opts.multiSeries
        ? `Listá todas las competencias de automovilismo de ${season} y comienzos de ${season + 1} que figuran en este calendario oficial con varias categorías. ` +
          'Para cada una indicá el campeonato/categoría al que pertenece, fechas, circuito y país.'
        : `Listá los eventos (fechas/rondas) de la temporada ${season} de "${series.name}" que figuran en este calendario oficial. ` +
          'Incluí fechas de inicio y fin (días del fin de semana del evento). Si solo figura el día de la carrera, usá ese día en ambas fechas. ' +
          'No incluyas eventos de otras categorías.',
    }),
  );
  const out: CalendarEntry[] = [];
  for (const e of data.events ?? []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e.dateStart)) continue;
    const dateEnd = e.dateEnd && /^\d{4}-\d{2}-\d{2}$/.test(e.dateEnd) && e.dateEnd >= e.dateStart ? e.dateEnd : e.dateStart;
    // Anti-alucinación: el nombre o el circuito tienen que figurar en el documento.
    if (!appearsInDocument(e.name, doc.text) && !(e.circuit && appearsInDocument(e.circuit, doc.text))) continue;
    const tz = validZone(e.timeZone) ?? guessTimeZone(e.country ?? '', `${e.city ?? ''} ${e.circuit ?? ''}`) ?? 'UTC';
    out.push({
      name: e.name.trim(),
      circuit: (e.circuit ?? e.name).trim(),
      country: (e.country ?? '').trim(),
      tz,
      dateStart: e.dateStart,
      dateEnd,
      ...(e.round ? { round: e.round } : {}),
      ...(e.url && /^https?:\/\//.test(e.url) ? { url: e.url } : {}),
      ...(e.championship ? { championship: e.championship.trim() } : {}),
    });
  }
  return out;
}

function validZone(zone: string | undefined): string | null {
  if (!zone) return null;
  return DateTime.now().setZone(zone).isValid ? zone : null;
}

// ─── Cronograma ───────────────────────────────────────────────────────────────────────────────

interface AiTimetable {
  sessions: Array<{
    name: string;
    category?: string;
    date: string;
    localStartText: string;
    localEndText?: string | null;
    timeZoneAbbr?: string | null;
  }>;
}

const timetableSchema: GeminiSchema = {
  type: 'OBJECT',
  properties: {
    sessions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          name: S('Nombre de la sesión tal como figura (p. ej. "Free Practice 1", "1er. Entrenamiento", "Final")'),
          category: S('Categoría/clase a la que corresponde la sesión, tal como figura'),
          date: S('Fecha de la sesión, YYYY-MM-DD'),
          localStartText: S('Hora de inicio copiada EXACTAMENTE como figura en el documento (p. ej. "9:30", "14.05", "5:00 PM")'),
          localEndText: { type: 'STRING', nullable: true, description: 'Hora de fin exactamente como figura, o null' },
          timeZoneAbbr: { type: 'STRING', nullable: true, description: 'Huso que indica el documento para esa hora si NO es la hora local del circuito (p. ej. "ET", "GMT"); si no, null' },
        },
        required: ['name', 'date', 'localStartText'],
      },
    },
  },
  required: ['sessions'],
};

const ZONE_ABBR: Record<string, string> = {
  ET: 'America/New_York', EST: 'America/New_York', EDT: 'America/New_York',
  CT: 'America/Chicago', CST: 'America/Chicago', CDT: 'America/Chicago',
  MT: 'America/Denver', PT: 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
  GMT: 'UTC', UTC: 'UTC', Z: 'UTC', CET: 'Europe/Paris', CEST: 'Europe/Paris', BST: 'Europe/London',
  AEST: 'Australia/Sydney', AEDT: 'Australia/Sydney', ART: 'America/Argentina/Buenos_Aires',
};

/** "9:30" | "09.30" | "14h05" | "5:00 PM" | "5:00PM ET" -> "HH:mm" (24 h) o null. */
export function parseClock(text: string): string | null {
  const m = text.trim().match(/^(\d{1,2})\s*[:.hH]\s*(\d{2})\s*(a\.?\s?m\.?|p\.?\s?m\.?)?/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2]);
  const ampm = m[3]?.toLowerCase().replace(/[.\s]/g, '');
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** Fragmento horario que se busca literalmente en el documento ("5:00 PM ET" -> "5:00 PM"). */
function clockFragment(text: string): string {
  const m = text.trim().match(/^\d{1,2}\s*[:.hH]\s*\d{2}(\s*[ap]\.?\s?m\.?)?/i);
  return m ? m[0] : text.trim();
}

/**
 * Control anti-alucinación de una hora: la hora (con variantes 9:30/09:30/9.30) tiene que figurar
 * en el documento y, si trae AM/PM, también con ese sufijo.
 */
export function timeAppears(text: string, documentText: string): boolean {
  const m = text.trim().match(/^(\d{1,2}\s*[:.hH]\s*\d{2})\s*([ap])?\.?\s?m?\.?/i);
  if (!m) return false;
  if (!appearsInDocument(m[1]!, documentText)) return false;
  if (!m[2]) return true;
  const [h, min] = m[1]!.split(/\s*[:.hH]\s*/);
  const re = new RegExp(`(^|[^0-9])0?${Number(h)}\\s*[:.h]\\s*${min}\\s*${m[2]}\\.?\\s?m`, 'i');
  return re.test(documentText);
}

export interface TimetableResult {
  sessions: ExtractedSession[];
  dropped: Array<{ name: string; reason: string }>;
}

export async function aiTimetable(
  deps: AiDeps,
  series: Series,
  entry: CalendarEntry,
  doc: FetchedDocument,
): Promise<TimetableResult> {
  if (!hasUsableText(doc)) return { sessions: [], dropped: [{ name: '*', reason: 'El documento no tiene texto legible para validar' }] };
  const names = [...new Set([series.name, series.shortName])].map((n) => `"${n}"`).join(' / ');
  const data = await cached<AiTimetable>(deps, series.id, 'timetable', doc, `${entry.dateStart}|${entry.dateEnd}`, () =>
    deps.gemini.generateJson<AiTimetable>({
      system: SYSTEM,
      label: `cronograma ${series.id}`,
      ...docPayload(doc),
      schema: timetableSchema,
      prompt:
        `Transcribí el cronograma oficial del evento "${entry.name}" (${entry.circuit}), que se disputa entre ${entry.dateStart} y ${entry.dateEnd}. ` +
        `Incluí SOLO las sesiones en pista de la categoría ${names} (entrenamientos/prácticas, clasificación, series, sprint, carreras/finales, warm-up). ` +
        'Si el documento incluye otras categorías, omitilas. No incluyas actividades administrativas (verificaciones, reuniones, entrega de neumáticos, salida a pista, pregrilla, etc.). ' +
        'Si hay una columna de hora local del circuito y otra en GMT/UTC, usá la hora local. ' +
        'Copiá la hora de inicio exactamente como figura (sin agregar ni quitar ceros) y deducí la fecha de cada sesión por el día que la encabeza, usando el año del evento.',
    }),
  );

  const sessions: ExtractedSession[] = [];
  const dropped: TimetableResult['dropped'] = [];
  for (const s of data.sessions ?? []) {
    const name = (s.name ?? '').trim();
    const startText = clockFragment(s.localStartText ?? '');
    if (!name || !/^\d{4}-\d{2}-\d{2}$/.test(s.date ?? '')) {
      dropped.push({ name, reason: 'Sesión sin nombre o fecha válida' });
      continue;
    }
    if (!timeAppears(startText, doc.text)) {
      dropped.push({ name, reason: `La hora "${s.localStartText}" no figura en el documento` });
      continue;
    }
    const start24 = parseClock(startText);
    if (!start24) {
      dropped.push({ name, reason: `Hora ilegible "${s.localStartText}"` });
      continue;
    }
    const zone = (s.timeZoneAbbr && ZONE_ABBR[s.timeZoneAbbr.trim().toUpperCase()]) || entry.tz;
    let startUtc: string;
    try {
      startUtc = localToUtc(s.date, start24, zone);
    } catch (err) {
      dropped.push({ name, reason: err instanceof Error ? err.message : String(err) });
      continue;
    }
    let endUtc: string | undefined;
    const endText = s.localEndText ? clockFragment(s.localEndText) : '';
    const end24 = endText && timeAppears(endText, doc.text) ? parseClock(endText) : null;
    if (end24) {
      const e = localToUtc(s.date, end24, zone);
      if (e > startUtc) endUtc = e;
    }
    sessions.push({ name, startUtc, ...(endUtc ? { endUtc } : {}), localStartText: s.localStartText.trim() });
  }
  return { sessions, dropped };
}

// ─── Resultados ───────────────────────────────────────────────────────────────────────────────

export interface AiResults {
  sessions: Array<{ sessionName: string; rows: ResultRow[] }>;
}

const resultRowSchema: GeminiSchema = {
  type: 'OBJECT',
  properties: {
    pos: N('Posición final; null si no clasificó'),
    status: S('DNF, DNS, DSQ, NC… si no tiene posición'),
    number: S('Número del auto'),
    driver: S('Piloto(s) exactamente como figura(n)'),
    team: S(),
    vehicle: S(),
    laps: N(),
    time: S('Tiempo total o mejor tiempo, como figura'),
    gap: S('Diferencia con el primero, como figura'),
    bestLap: S(),
    points: { type: 'NUMBER', nullable: true },
  },
  required: ['driver'],
};

const resultsSchema: GeminiSchema = {
  type: 'OBJECT',
  properties: {
    sessions: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { sessionName: S('Nombre de la sesión tal como figura'), rows: { type: 'ARRAY', items: resultRowSchema } },
        required: ['sessionName', 'rows'],
      },
    },
  },
  required: ['sessions'],
};

export async function aiResults(
  deps: AiDeps,
  series: Series,
  eventName: string,
  sessionNames: string[],
  doc: FetchedDocument,
): Promise<AiResults> {
  if (!hasUsableText(doc)) return { sessions: [] };
  return cached<AiResults>(deps, series.id, 'results', doc, eventName, () =>
    deps.gemini.generateJson<AiResults>({
      system: SYSTEM,
      label: `resultados ${series.id}`,
      ...docPayload(doc),
      schema: resultsSchema,
      prompt:
        `Transcribí las clasificaciones oficiales de "${series.name}" en el evento "${eventName}". ` +
        `Sesiones esperadas: ${sessionNames.map((n) => `"${n}"`).join(', ')}. ` +
        'Una tabla por sesión, en el orden del documento, con todos los pilotos. Omití otras categorías. Copiá nombres y números exactamente como figuran.',
    }),
  );
}

/**
 * Controles de una tabla de resultados transcripta por IA:
 * cada piloto (y número) tiene que figurar en el documento y las posiciones tienen que ser 1, 2, 3…
 * (las filas sin posición —DNF, DSQ…— van al final).
 */
export function validateResultRows(rows: ResultRow[], documentText: string): string | null {
  if (rows.length === 0) return 'Tabla vacía';
  let expected = 1;
  let seenUnclassified = false;
  for (const r of rows) {
    if (!r.driver || !appearsInDocument(r.driver, documentText)) return `El piloto "${r.driver}" no figura en el documento`;
    if (r.number && !numberAppears(r.number, documentText)) return `El número "${r.number}" no figura en el documento`;
    if (r.pos === null || r.pos === undefined) {
      seenUnclassified = true;
      continue;
    }
    if (seenUnclassified || r.pos !== expected) return `Posiciones no consecutivas (se esperaba ${expected}, vino ${r.pos})`;
    expected++;
  }
  return expected > 1 ? null : 'Ninguna fila con posición';
}

function numberAppears(num: string, documentText: string): boolean {
  const n = normalizeForMatch(num).replace(/^#/, '');
  return new RegExp(`(^|[^0-9])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^0-9]|$)`).test(normalizeForMatch(documentText));
}

// ─── Campeonato ───────────────────────────────────────────────────────────────────────────────

interface AiStandings {
  tables: StandingsTable[];
}

const standingsSchema: GeminiSchema = {
  type: 'OBJECT',
  properties: {
    tables: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          title: S('Pilotos, Equipos, Marcas…'),
          rows: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                pos: { type: 'INTEGER' },
                name: S('Piloto/equipo exactamente como figura'),
                team: S(),
                number: S(),
                points: { type: 'NUMBER' },
                wins: N(),
              },
              required: ['pos', 'name', 'points'],
            },
          },
        },
        required: ['title', 'rows'],
      },
    },
  },
  required: ['tables'],
};

export async function aiStandings(deps: AiDeps, series: Series, season: number, doc: FetchedDocument): Promise<StandingsTable[]> {
  if (!hasUsableText(doc)) return [];
  const data = await cached<AiStandings>(deps, series.id, 'standings', doc, String(season), () =>
    deps.gemini.generateJson<AiStandings>({
      system: SYSTEM,
      label: `campeonato ${series.id}`,
      ...docPayload(doc),
      schema: standingsSchema,
      prompt:
        `Transcribí las tablas del campeonato ${season} de "${series.name}" (pilotos y, si figuran, equipos/marcas). ` +
        'Copiá nombres exactamente como figuran. Omití otras categorías.',
    }),
  );
  return (data.tables ?? []).filter((t) => validateStandingsRows(t, doc.text) === null);
}

export function validateStandingsRows(table: StandingsTable, documentText: string): string | null {
  if (table.rows.length === 0) return 'Tabla vacía';
  for (let i = 0; i < table.rows.length; i++) {
    const r = table.rows[i]!;
    if (!appearsInDocument(r.name, documentText)) return `"${r.name}" no figura en el documento`;
    const prev = table.rows[i - 1];
    const ok = i === 0 ? r.pos === 1 : r.pos === i + 1 || r.pos === prev!.pos; // empates
    if (!ok) return `Posiciones no consecutivas en ${table.title}`;
  }
  return null;
}
