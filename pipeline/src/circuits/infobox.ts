/**
 * Lee la ficha (infobox) del artículo de un circuito a partir del wikitexto de la introducción:
 * "Infobox motorsport venue" en la Wikipedia en inglés y "Ficha de circuito de carreras" en la española.
 * De ahí salen las curvas, el récord de vuelta y, como respaldo de Wikidata, longitud, inauguración y capacidad.
 * Con varios trazados (layout2, record_time2…) se toma el primero, que es el principal.
 */
import type { CircuitLapRecord } from '@dm/shared';
import { decodeEntities } from '../extract/html.ts';

export interface InfoboxData {
  turns?: number;
  lengthM?: number;
  opened?: number;
  capacity?: number;
  lapRecord?: CircuitLapRecord;
  /** Localidad según la ficha ("Monza"). */
  city?: string;
  /** Archivos de imagen nombrados en la ficha, en orden (el plano suele ser el primero o "track_map"). */
  images: string[];
}

// ── Plantillas ──

interface Template {
  name: string;
  params: Map<string, string>;
}

/** Plantillas de primer nivel del texto, con sus parámetros con nombre. */
export function topLevelTemplates(wikitext: string): Template[] {
  const out: Template[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < wikitext.length - 1; i++) {
    const two = wikitext.slice(i, i + 2);
    if (two === '{{') {
      if (depth === 0) start = i + 2;
      depth++;
      i++;
    } else if (two === '}}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) out.push(parseTemplate(wikitext.slice(start, i)));
      i++;
    }
  }
  return out;
}

/** Parte por las barras que no están dentro de otra plantilla o de un enlace. */
function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let braces = 0;
  let brackets = 0;
  let last = 0;
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === '{{') {
      braces++;
      i++;
    } else if (two === '}}') {
      braces = Math.max(0, braces - 1);
      i++;
    } else if (two === '[[') {
      brackets++;
      i++;
    } else if (two === ']]') {
      brackets = Math.max(0, brackets - 1);
      i++;
    } else if (body[i] === '|' && braces === 0 && brackets === 0) {
      parts.push(body.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(body.slice(last));
  return parts;
}

function paramKey(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[_\s]+/g, ' ')
    .trim();
}

function parseTemplate(body: string): Template {
  const [head = '', ...rest] = splitTopLevel(stripComments(body));
  const params = new Map<string, string>();
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = paramKey(part.slice(0, eq));
    const value = part.slice(eq + 1).trim();
    if (key && value && !params.has(key)) params.set(key, value);
  }
  return { name: paramKey(head), params };
}

function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

// ── Texto plano de un valor ──

/** Plantillas que solo decoran (banderas) o agregan una conversión: se quitan enteras. */
const DROP_TEMPLATE = /^(flag|bandera|band\b|cvt|convert|edad|age|small ?refs?|efn|sfn|refn|cita|cite|citation|ref)/;
/** Plantillas que envuelven un texto: queda su primer parámetro sin nombre. */
const KEEP_FIRST = /^(nowrap|nobr|small|ill|lang|abbr|nobold|plainlist|unbulleted list|ubl)/;

function templateText(body: string): string {
  const [head = '', ...rest] = splitTopLevel(body);
  const name = paramKey(head);
  if (name === 'esd' || name === 'nbsp' || name === 'spaces') return ' ';
  const positional = rest.filter((p) => !/^\s*[\w -]+=/.test(p)).map((p) => p.trim());
  if (name === 'lang') return positional[1] ?? positional[0] ?? '';
  // {{bandera2|Río Cuarto (ciudad)}}: bandera y nombre del lugar.
  if (name === 'bandera2' || name === 'flag2') return (positional[0] ?? '').replace(/\s*\([^)]*\)\s*$/, '');
  if (DROP_TEMPLATE.test(name)) return '';
  if (KEEP_FIRST.test(name)) return positional[0] ?? '';
  return '';
}

/** Texto plano de un valor de la ficha: sin referencias, plantillas, enlaces, formato ni HTML. */
export function plainValue(raw: string): string {
  let t = stripComments(raw)
    .replace(/<ref\b[^>]*\/>/gi, '')
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ');
  // Plantillas, de adentro hacia afuera.
  for (let i = 0; i < 6 && t.includes('{{'); i++) {
    const next = t.replace(/\{\{([^{}]*)\}\}/g, (_m, body: string) => templateText(body));
    if (next === t) break;
    t = next;
  }
  t = t
    .replace(/\[\[(?:File|Image|Archivo|Imagen|Fichero):[^\]]*\]\]/gi, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1')
    .replace(/\[https?:\/\/\S+\]/g, '')
    .replace(/'{2,}/g, '')
    .replace(/<[^>]*>/g, ' ');
  return decodeEntities(t)
    .replace(/[ ​  ]/g, ' ')
    .replace(/[{}[\]]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;.)])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .trim();
}

// ── Campos ──

function firstYear(raw: string | undefined): number | undefined {
  // Del texto visible de los enlaces: el destino puede nombrar otra cosa ("[[Súper TC 2000 2013|2013]]").
  const text = raw ? stripRefs(raw).replace(/\[\[[^|\]]*\|([^\]]*)\]\]/g, '$1') : '';
  const m = /\b(1[89]\d\d|20\d\d)\b/.exec(text);
  return m ? Number(m[1]) : undefined;
}

function stripRefs(raw: string): string {
  return stripComments(raw)
    .replace(/<ref\b[^>]*\/>/gi, '')
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '');
}

/** "1:20.901", "1'18.523", "0:43.682", "1:44,701", "43.682" -> tiempo normalizado, o undefined. */
export function lapTime(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const text = plainValue(raw).replace(/[′’´]/g, "'");
  const m =
    /(?<![\d.,:])(\d{1,2})\s*[:'m]\s*(\d{2})\s*[.,"]\s*(\d{1,4})(?!\d)/.exec(text) ??
    /(?<![\d.,:])(\d{1,3})[.,](\d{2,4})(?=\s*(?:s|seg|sec|$))/.exec(text);
  if (!m) return undefined;
  return m[3] !== undefined ? `${Number(m[1])}:${m[2]}.${m[3]}` : `${m[1]}.${m[2]}`;
}

function shortText(raw: string | undefined, max: number): string | undefined {
  if (!raw) return undefined;
  const t = plainValue(raw)
    .replace(/^[\s,;:–—-]+|[\s,;:–—-]+$/g, '')
    .trim();
  return t && t.length <= max ? t : undefined;
}

/** "5.793", "5,793", "4.259 km" -> metros. */
function lengthMeters(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const m = /^\D{0,3}(\d{1,2})[.,](\d{1,4})\b/.exec(plainValue(raw));
  if (!m) return undefined;
  const km = Number(`${m[1]}.${m[2]}`);
  return km >= 0.2 && km <= 80 ? Math.round(km * 1000) : undefined;
}

/** "118,865", "70 000 espectadores", "101,500–167,785 (…)" -> primer número. */
function firstCount(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  for (const m of plainValue(raw).matchAll(/(\d{1,3}(?:[.,\s]\d{3})+|\d{3,7})/g)) {
    // Un año suelto ("76,812 (2021)" escrito al revés, "2021: 76,812") no es una capacidad.
    if (/^(18|19|20)\d\d$/.test(m[1]!)) continue;
    const n = Number(m[1]!.replace(/[.,\s]/g, ''));
    return n >= 100 && n <= 2_000_000 ? n : undefined;
  }
  return undefined;
}

function firstInt(raw: string | undefined, min: number, max: number): number | undefined {
  if (!raw) return undefined;
  const m = /\d{1,3}/.exec(plainValue(raw));
  const n = m ? Number(m[0]) : NaN;
  return n >= min && n <= max ? n : undefined;
}

const FILE_NAME = /([^|[\]{}=<>\n]+?\.(?:svg|png|jpe?g|gif|webp|tiff?))/gi;

/** Nombres de archivo de un valor: "[[File:Monza track map.svg|260px]]" o "Monza track map.svg". */
export function fileNames(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const m of stripComments(raw).matchAll(FILE_NAME)) {
    const name = m[1]!
      .replace(/^\s*(?:File|Image|Archivo|Imagen|Fichero)\s*:/i, '')
      .replace(/_/g, ' ')
      .trim();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

const INFOBOX_NAME = /^(infobox|ficha de|motorsport venue)/;
const KNOWN_PARAMS = ['turns', 'curvas', 'record time', 'length km', 'longitud km', 'track map', 'opened', 'inauguracion'];

/** Datos de la ficha del circuito; vacío si el artículo no tiene una. */
export function parseInfobox(wikitext: string): InfoboxData {
  const box = topLevelTemplates(wikitext).find(
    (t) => INFOBOX_NAME.test(t.name) && KNOWN_PARAMS.some((k) => t.params.has(k)),
  );
  const data: InfoboxData = { images: [] };
  if (!box) return data;
  const p = (...keys: string[]): string | undefined => {
    for (const k of keys) {
      const v = box.params.get(k);
      if (v) return v;
    }
    return undefined;
  };

  data.turns = firstInt(p('turns', 'curvas'), 2, 250);
  data.lengthM = lengthMeters(p('length km', 'longitud km', 'longitud'));
  data.opened = firstYear(p('opened', 'inauguracion', 'apertura'));
  data.capacity = firstCount(p('capacity', 'capacidad'));
  data.images = [...fileNames(p('track map')), ...fileNames(p('image', 'imagen'))];
  data.city = cityOf(p('location', 'ubicacion', 'localizacion', 'localidad'));

  const time = lapTime(p('record time'));
  if (time) {
    const record: CircuitLapRecord = { time };
    const driver = shortText(p('record driver'), 60);
    const vehicle = shortText(p('record car', 'record team'), 80);
    const year = firstYear(p('record year'));
    const series = shortText(p('record class'), 50);
    if (driver) record.driver = driver;
    if (vehicle) record.vehicle = vehicle;
    if (year) record.year = year;
    if (series) record.series = series;
    data.lapRecord = record;
  }
  for (const k of ['turns', 'lengthM', 'opened', 'capacity', 'city'] as const) if (data[k] === undefined) delete data[k];
  return data;
}

/**
 * Localidad de "Monza, Italy" o "1801 W. Speedway Blvd, Daytona Beach, Florida, United States": la primera
 * parte que no es una dirección.
 */
function cityOf(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Cada renglón (<br>) es una parte más: "1801 W. Speedway Blvd<br>[[Daytona Beach, Florida]]".
  for (const part of plainValue(raw.replace(/<br\s*\/?>/gi, ', ')).split(/\s*[,;]\s*/)) {
    const t = part.replace(/^(?:near|cerca de|in|en)\s+/i, '').trim();
    if (t.length >= 2 && t.length <= 40 && !/\d/.test(t)) return t;
  }
  return undefined;
}

// ── Sentido de giro ──

const CLOCKWISE = /\b(clockwise|sentido\s+(?:de\s+giro\s+)?horario|sentido\s+de\s+las\s+agujas\s+del\s+reloj)\b/gi;
const ANTICLOCKWISE =
  /\b(anti-?\s?clockwise|counter-?\s?clockwise|sentido\s+(?:de\s+giro\s+)?anti-?\s?horario|(?:sentido\s+)?contrario\s+(?:al\s+de\s+|a\s+)?las\s+agujas\s+del\s+reloj)\b/gi;

/**
 * Sentido de giro si el texto lo dice de una sola manera ("runs clockwise", "en sentido antihorario").
 * Si nombra los dos (o ninguno) no se arriesga.
 */
export function findDirection(text: string): 'Horario' | 'Antihorario' | undefined {
  const t = stripRefs(text);
  const anti = (t.match(ANTICLOCKWISE) ?? []).length;
  const clock = (t.replace(ANTICLOCKWISE, ' ').match(CLOCKWISE) ?? []).length;
  if (anti > 0 && clock === 0) return 'Antihorario';
  if (clock > 0 && anti === 0) return 'Horario';
  return undefined;
}
