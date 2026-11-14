/**
 * Documentos oficiales de SCORE International (score-raceinfo.com) que se publican como PDF: lectura del texto
 * posicionado (pdfTextItems de unpdf, con x/y de cada texto) agrupado en renglones.
 *
 * - Calendario de la temporada ("2027 Race Schedule"): un bloque por carrera con el título ("59th SCORE Baja 1000"),
 *   la sede ("San Jose Del Cabo, Baja California Sur"), "Event Dates: November 9-15, 2026", la distancia aproximada
 *   ("250mi / 402km") y los días clave ("Nov. 13 - Start of 59th Baja 1000").
 * - Cronograma de la carrera ("Schedule of Events – 2026 Baja 1000"): un título por día ("FRIDAY, November 13") y
 *   renglones con hora local a la izquierda ("8am-5pm Contingency / Tech – Boulevard Centenario", "1:00 am MOTO/QUAD
 *   START", "9:00am ALL 4-WHEEL CLASSES START"), más la distancia y el tiempo límite del día de carrera.
 * - Información de la carrera ("Race Info – 2026 Baja 1000"): la tabla de puestos de control de los autos
 *   ("Checkpoints – All 4WV Classes"): número o sigla (ST largada, 1…n puestos, TM cronometraje, FN/FIN llegada),
 *   lugar, millas y kilómetros acumulados y entre puestos, y horas aproximadas (paso del primero, cierre).
 *
 * Los PDF cambian de diseño entre carreras (columnas, siglas, nombres en dos renglones), así que la lectura se apoya
 * en patrones de texto y en la columna de cada dato, no en posiciones fijas.
 */
import { DateTime } from 'luxon';
import type { PdfItem } from './fia-documents.ts';
import { isoDate, monthNumber } from '../generic/places.ts';

// ─── Renglones ───────────────────────────────────────────────────────────────────────────────

export interface PdfLine {
  page: number;
  y: number;
  /** Textos del renglón de izquierda a derecha. */
  items: PdfItem[];
  /** Textos unidos con un espacio. */
  text: string;
}

const squash = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Agrupa el texto en renglones (misma página y casi la misma altura), de arriba hacia abajo. */
export function pdfLines(items: PdfItem[], tolerance = 2): PdfLine[] {
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const lines: PdfLine[] = [];
  let cur: PdfItem[] = [];
  const flush = () => {
    if (!cur.length) return;
    const row = [...cur].sort((a, b) => a.x - b.x);
    // Las palabras partidas en dos textos pegados ("B" + "aja", "Riviera d" + "e") se unen sin espacio.
    let text = '';
    row.forEach((it, i) => {
      const prev = row[i - 1];
      text += prev && it.x - (prev.x + prev.w) < 0.5 && /\w$/.test(prev.s) && /^\w/.test(it.s) ? it.s : ` ${it.s}`;
    });
    lines.push({ page: row[0]!.page, y: cur[0]!.y, items: row, text: squash(text) });
    cur = [];
  };
  for (const it of sorted) {
    if (cur.length && (it.page !== cur[0]!.page || Math.abs(it.y - cur[0]!.y) > tolerance)) flush();
    cur.push(it);
  }
  flush();
  return lines;
}

// ─── Nombres de las carreras ─────────────────────────────────────────────────────────────────

/**
 * Clave estable de una carrera a partir de cualquier texto que la nombre: "San Felipe 250", "SF 250", "SF250" y
 * "SanFelipe 250" -> "san-felipe-250"; "Baja 1000", "B1000" -> "baja-1000". null si no nombra ninguna.
 */
export function scoreRaceKey(text: string): string | null {
  const t = text.toLowerCase().replace(/sanfelipe/g, 'san felipe');
  if (/san\s+felipe\s*250|\bsf\s*-?\s*250\b/.test(t)) return 'san-felipe-250';
  const m = t.match(/\bbaja\s*-?\s*(\d{3,4})\b/) ?? t.match(/\bb\s?(\d{3,4})\b/);
  return m ? `baja-${m[1]}` : null;
}

/** Nombre corto a partir de la clave: "baja-1000" -> "Baja 1000", "san-felipe-250" -> "San Felipe 250". */
export function scoreRaceName(key: string): string {
  return key
    .split('-')
    .map((w) => (/^\d/.test(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

// ─── Fechas y horas ──────────────────────────────────────────────────────────────────────────

/** "March 25", "Sept. 9", "Nov 13" (+ año) -> "2026-03-25". */
function monthDay(month: string, day: string | number, year: number): string | null {
  const m = monthNumber(month);
  return m ? isoDate(year, m, Number(day)) : null;
}

const MERIDIEM = '(?:a\\.?m\\.?|p\\.?m\\.?|a|p)';
const CLOCK = `(?:12\\s*:?\\s*00\\s*noon|noon|12\\s*mid(?:night)?|\\d{1,2}(?:\\s*:\\s*\\d{2})?\\s*${MERIDIEM}?)`;
/** Hora (o rango) al principio del renglón: "8am-5pm", "1 pm - 5pm", "12:00 Noon", "8am - Done", "10:00-11am". */
const LEADING_TIME = new RegExp(`^(${CLOCK})(?:\\s*[-–]\\s*(${CLOCK}|done|end))?(?![\\w:])\\s*(.*)$`, 'i');

/** Hora de 24 h ("08:00") a partir de "8am", "1:00 am", "12:00 Noon", "9:30" + meridiano por defecto. */
export function parseClock(raw: string, defaultMeridiem?: 'a' | 'p'): string | null {
  const t = raw.toLowerCase().replace(/\s+/g, '');
  if (/noon/.test(t)) return '12:00';
  if (/mid/.test(t)) return null; // "12mid": medianoche al final del día, solo como fin
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?(a|p)?(?:\.?m\.?)?$/);
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const mer = m[3] ?? defaultMeridiem;
  if (h > 23 || min > 59) return null;
  if (mer === 'a' && h === 12) h = 0;
  else if (mer === 'p' && h < 12) h += 12;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

const meridiemOf = (raw: string): 'a' | 'p' | undefined => raw.toLowerCase().match(/\d\s*(a|p)/)?.[1] as 'a' | 'p' | undefined;

/** Hora y texto de un renglón del cronograma, o null si el renglón no empieza con una hora. */
export function leadingTime(text: string): { start: string; end?: string; rest: string } | null {
  const m = text.match(LEADING_TIME);
  if (!m) return null;
  const [, a, b, rest] = m;
  // Sin meridiano en la primera hora ("10:00-11am", "9:30-1:00p"): el de la segunda, salvo que quede después.
  const endMer = b ? meridiemOf(b) : undefined;
  let start = parseClock(a!, meridiemOf(a!) ?? endMer);
  const end = b && !/done|end/i.test(b) ? parseClock(b, endMer) : null;
  if (start && end && !meridiemOf(a!) && start > end) start = parseClock(a!, 'a');
  if (!start) return null;
  // Sin meridiano en ningún lado y sin minutos ("1 Peña…"): no es una hora.
  if (!meridiemOf(a!) && !endMer && !/:|noon/i.test(a!)) return null;
  return { start, ...(end ? { end } : {}), rest: squash(rest ?? '') };
}

// ─── Calendario de la temporada ──────────────────────────────────────────────────────────────

export interface ScoreCalendarRace {
  /** Número de edición ("59th" -> 59). */
  edition?: number;
  /** "Baja 1000", "San Felipe 250". */
  name: string;
  key: string;
  /** Sede tal como figura: "San Jose Del Cabo, Baja California Sur", "Peninsula Run – Ensenada B.C. to End TBA". */
  place: string;
  dateStart: string;
  dateEnd: string;
  distanceMi?: number;
  distanceKm?: number;
  /** Días clave del calendario, en orden: "Qualifying Day & On-site Registration", "Start of 59th Baja 1000"… */
  days: Array<{ date: string; text: string }>;
}

const num = (s: string): number => Number(s.replace(/,/g, ''));

/** "5 9 th SCORE Baja 500" (cada dígito por separado en el PDF) -> "59th SCORE Baja 500". */
const joinDigits = (s: string): string => s.replace(/(\d)\s+(?=\d)/g, '$1').replace(/(\d)\s+(st|nd|rd|th)\b/gi, '$1$2');

const RACE_TITLE = /^(\d{1,3})(?:st|nd|rd|th)\s+SCORE\s+(.+?)\s*$/i;
const EVENT_DATES = /event\s+dates:\s*([a-z]+)\.?\s+(\d{1,2})\s*[-–]\s*(?:([a-z]+)\.?\s+)?(\d{1,2}),?\s*(\d{4})?/i;
const DISTANCE = /([\d,]+(?:\.\d+)?)\s*mi(?:les)?\.?\s*(?:\/|=|\()\s*([\d,]+(?:\.\d+)?)\s*km/i;
const KEY_DAY = /^([a-z]{3,9})\.?\s*(\d{1,2})(?:\s*-\s*\d{1,2})?\s*[-–]\s*(.+)$/i;

/** Calendario de la temporada `year` (las fechas del PDF no siempre llevan el año). */
export function parseScoreCalendar(items: PdfItem[], year: number): ScoreCalendarRace[] {
  const races: ScoreCalendarRace[] = [];
  let cur: ScoreCalendarRace | null = null;
  let placeNext = false;
  for (const line of pdfLines(items)) {
    const text = joinDigits(line.text);
    const title = text.match(RACE_TITLE);
    if (title) {
      const name = title[2]!.replace(/\s+/g, ' ');
      const key = scoreRaceKey(name);
      cur = key ? { edition: Number(title[1]), name: scoreRaceName(key), key, place: '', dateStart: '', dateEnd: '', days: [] } : null;
      if (cur) races.push(cur);
      placeNext = !!cur;
      continue;
    }
    if (!cur) continue;
    if (placeNext) {
      cur.place = line.text.replace(/\s+,/g, ',');
      placeNext = false;
      continue;
    }
    const dates = line.text.match(EVENT_DATES);
    if (dates) {
      const y = dates[5] ? Number(dates[5]) : year;
      const start = monthDay(dates[1]!, dates[2]!, y);
      const end = monthDay(dates[3] ?? dates[1]!, dates[4]!, y);
      if (start && end) {
        cur.dateStart = start;
        cur.dateEnd = end;
      }
      continue;
    }
    const dist = line.text.match(DISTANCE);
    if (dist && cur.distanceMi === undefined) {
      cur.distanceMi = num(dist[1]!);
      cur.distanceKm = num(dist[2]!);
    }
    const day = line.text.match(KEY_DAY);
    if (day && cur.dateStart) {
      const y = Number(cur.dateStart.slice(0, 4));
      let date = monthDay(day[1]!, day[2]!, y);
      // Un día clave en diciembre de una carrera de enero (o al revés) es del año anterior.
      if (date && date > cur.dateEnd && Number(date.slice(5, 7)) > Number(cur.dateEnd.slice(5, 7))) date = monthDay(day[1]!, day[2]!, y - 1);
      if (date) cur.days.push({ date, text: squash(day[3]!) });
    }
  }
  return races.filter((r) => r.dateStart && r.dateEnd);
}

// ─── Cronograma de una carrera ───────────────────────────────────────────────────────────────

export type ScoreScheduleKind = 'clasificacion' | 'tecnica' | 'largada-motos' | 'largada-autos' | 'largada' | 'premiacion';

export interface ScoreScheduleItem {
  kind: ScoreScheduleKind;
  /** Fecha local YYYY-MM-DD. */
  date: string;
  /** Hora local "HH:mm". */
  start: string;
  end?: string;
  /** Renglón tal como figura (sin la hora). */
  text: string;
}

export interface ScoreEventSchedule {
  items: ScoreScheduleItem[];
  /** Distancia de la carrera (la de las clases Pro si se publican varias). */
  distanceMi?: number;
  distanceKm?: number;
  /** Tiempo límite de la carrera, en horas. */
  timeLimitHours?: number;
  /** "Trophy Truck, TT 2WD, TT Legends, TT Spec, Class 1 and Pro Ultimate UTV". */
  qualifyingClasses?: string;
}

const WEEKDAY_TITLE =
  /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?:\s*-\s*[a-z]+)?\s*,\s*([a-z]+)\.?\s+(\d{1,2})\b/i;

/** Qué es un renglón del cronograma (solo lo que va a la agenda), o null. */
export function scheduleKind(text: string): ScoreScheduleKind | null {
  if (/\bawards?\b/i.test(text) && /celebration|presentation|ceremony|banquet|^awards?\b/i.test(text)) return 'premiacion';
  // "Baja 1000 Qualifying – Location Will Be Provided at Race Registration" sí; "Qualifying Registration…",
  // "Media Registration for Access to Qualifying Site" no.
  if (/\bqualifying\b/i.test(text) && !/qualifying\s+(?:regis|site|info|grid|order|classes|teams)|media|zoom/i.test(text)) return 'clasificacion';
  if ((/^contingency\b/i.test(text) || /contingency\s*\/\s*tech/i.test(text)) && !/chassis/i.test(text)) return 'tecnica';
  const start = text.replace(/start\s*\/\s*finish/gi, ' ').replace(/start\s+(?:ramp|line)/gi, ' ');
  if (/\bstart\b/i.test(start) && !/staging|pre-?run|posting|registration|gap/i.test(start)) {
    if (/\b4\s*-?\s*(?:wheel|wv)\b|four\s*-?\s*wheel/i.test(start)) return 'largada-autos';
    if (/\bmoto|\bquad/i.test(start)) return 'largada-motos';
    return /all\s+classes/i.test(start) ? 'largada' : 'largada-motos';
  }
  return null;
}

/**
 * Cronograma oficial de una carrera. Solo se toman los días de la semana del evento (`dateStart` a `dateEnd`): el
 * PDF empieza con plazos de inscripción y la apertura del reconocimiento, que no van a la agenda.
 */
export function parseScoreSchedule(items: PdfItem[], race: { dateStart: string; dateEnd: string }): ScoreEventSchedule {
  const year = Number(race.dateStart.slice(0, 4));
  const out: ScoreEventSchedule = { items: [] };
  const lines = pdfLines(items);
  let date: string | null = null;
  const seen = new Set<string>();
  for (const line of lines) {
    const title = line.text.match(WEEKDAY_TITLE);
    if (title) {
      const d = monthDay(title[2]!, title[3]!, year);
      date = d && d >= race.dateStart && d <= race.dateEnd ? d : null;
      continue;
    }
    if (!date) continue;
    const t = leadingTime(line.text);
    if (!t) continue;
    const kind = scheduleKind(t.rest);
    if (!kind) continue;
    // Una sola técnica por día (el cronograma la repite: "Contingency / Tech" y "Tech Inspection / Transponder…").
    const once = kind === 'tecnica' || kind === 'premiacion' || kind === 'clasificacion' ? `${kind}|${date}` : `${kind}|${date}|${t.start}`;
    if (seen.has(once)) continue;
    seen.add(once);
    out.items.push({ kind, date, start: t.start, ...(t.end ? { end: t.end } : {}), text: t.rest });
  }

  const all = squash(lines.map((l) => l.text).join(' '));
  const dist = all.match(DISTANCE);
  if (dist) {
    out.distanceMi = num(dist[1]!);
    out.distanceKm = num(dist[2]!);
  }
  const limit = all.match(/time\s+limit[^0-9]{0,30}(\d{1,2})\s*(?:hrs?|hours)\b/i);
  if (limit) out.timeLimitHours = Number(limit[1]);
  const classes = all.match(/qualifying\s+classes\s+(?:will\s+be|are)\s+(.+?)\.(?:\s|$)/i);
  if (classes) out.qualifyingClasses = classes[1]!.trim();
  return out;
}

// ─── Puestos de control (Race Info) ──────────────────────────────────────────────────────────

export interface ScoreCheckpoint {
  /** Sigla tal como figura: "ST", "1", "TM", "FN", "FIN". */
  code: string;
  /** "San José del Cabo", "Centenario - La Paz", "Timing – Rancho Nelson". */
  place: string;
  /** Millas acumuladas (race mile) y kilómetros acumulados. */
  mi: number;
  km: number;
  /** Horas aproximadas del renglón, en orden ("12:32", día "Fri"): paso del primero / apertura … cierre. */
  times: Array<{ time: string; day: string }>;
}

const NUMBER_CELL = /^\d{1,3}(?:,\d{3})*[.:]\d{2}$/;
const TIME_CELL = /(\d{1,2}:\d{2})\s*([ap])?\s*(mon|tue|wed|thu|fri|sat?|sun?|mo|tu|we|th|fr)\b/gi;
const ONE_TIME_CELL = new RegExp(TIME_CELL.source, 'i');
const HEADER_WORD =/\b(place|location|gps|miles?|km|classes|open|close|estimated|to cp|cp-cp)\b|^\(?(mi|km)\)?$|^(n|o|no\.?)$/i;
const CODE_CELL = /^(st|s|t|m|tm|fn|fin|\d{1,2})$/i;
const cellNumber = (s: string): number => Number(s.replace(/,/g, '').replace(':', '.'));

/** Tabla de puestos de control de los autos (4WV); vacía si el documento no la trae. */
export function parseScoreCheckpoints(items: PdfItem[]): ScoreCheckpoint[] {
  const lines = pdfLines(items);
  const start = lines.findIndex((l) => /^checkpoints\s*[–-]/i.test(l.text) && /\b4\s*-?\s*wv\b|4\s*-?\s*wheel/i.test(l.text));
  if (start < 0) return [];
  const rows: ScoreCheckpoint[] = [];
  // Textos de lugar o sigla que quedaron en renglones sin números ("Centenario - La" sobre "1 Paz").
  let pendingPlace: string[] = [];
  let pendingCode = '';
  for (const line of lines.slice(start + 1)) {
    if (/^checkpoints?\b/i.test(line.text) || /\d+h\s*\d+m/.test(line.text)) break;
    const firstNum = line.items.findIndex((i) => NUMBER_CELL.test(i.s));
    const nums = line.items.filter((i) => NUMBER_CELL.test(i.s));
    const left = (firstNum < 0 ? line.items : line.items.slice(0, firstNum)).filter((i) => !ONE_TIME_CELL.test(i.s));
    if (nums.length < 4) {
      // Renglón sin datos: encabezado, hora suelta o la mitad de un nombre en dos renglones.
      if (rows.length > 0 && firstNum >= 0) break; // fila de totales sin horas
      if (line.text.length > 80) break; // ya es un párrafo de texto
      const words = left.map((i) => i.s);
      if (!words.length || words.some((w) => HEADER_WORD.test(w))) continue;
      // Sigla partida en dos renglones ("S" / "T" junto a "San José del" / "Cabo").
      if (CODE_CELL.test(words[0]!) && (words.length > 1 || /^[a-z]$/i.test(words[0]!))) pendingCode += words.shift()!;
      if (words.length) pendingPlace.push(words.join(' '));
      continue;
    }
    const words = left.map((i) => i.s);
    let code = pendingCode;
    if (words.length && CODE_CELL.test(words[0]!)) code += words.shift()!;
    const place = squash([...pendingPlace, words.join(' ')].join(' '));
    pendingPlace = [];
    pendingCode = '';
    const [mi, , km] = nums.map((n) => cellNumber(n.s));
    const right = line.items.filter((i) => i.x > nums[nums.length - 1]!.x).map((i) => i.s).join(' ');
    const times = [...right.matchAll(TIME_CELL)].map((m) => ({ time: m[1]! + (m[2] ?? ''), day: m[3]! }));
    rows.push({ code: code.toUpperCase(), place, mi: mi!, km: km!, times });
  }
  return rows;
}

/** Hora de un renglón de la tabla ("12:32", "1:51p", "10:00a") en 24 h. */
export function checkpointClock(time: string): string | null {
  const m = time.match(/^(\d{1,2}):(\d{2})([ap])?$/i);
  if (!m) return null;
  return parseClock(`${m[1]}:${m[2]}${m[3] ?? ''}`);
}

const WEEKDAYS: Record<string, number> = { mo: 1, tu: 2, we: 3, th: 4, fr: 5, sa: 6, su: 7 };

/** Fecha de un día abreviado ("Fri", "Sa") contando desde la fecha de la carrera (hasta tres días después). */
export function weekdayFrom(raceDate: string, day: string): string {
  const target = WEEKDAYS[day.slice(0, 2).toLowerCase()];
  const base = DateTime.fromISO(raceDate);
  for (let i = 0; i < 4 && target; i++) {
    const d = base.plus({ days: i });
    if (d.weekday === target) return d.toISODate()!;
  }
  return raceDate;
}
