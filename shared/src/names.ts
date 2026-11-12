/**
 * Nombres prolijos para mostrar: eventos, circuitos, lugares, equipos y sesiones.
 *
 * Los sitios oficiales publican muchos nombres en mayúsculas y sin acentos ("Fecha 14 — RIO CUARTO",
 * "Michelin 24H DUBAI", "Rd.11-12 SUZUKA CIRCUIT") y las sesiones en el idioma de cada sitio ("Practice 1",
 * "Qualifying", "Feature Race"). Estas funciones son conservadoras a propósito: solo tocan palabras escritas
 * todas en mayúsculas, dejan las siglas como están y traducen únicamente nombres de sesión conocidos; ante la
 * duda, el texto queda como lo publicó la fuente. Son idempotentes (aplicarlas dos veces no cambia nada).
 * Lógica pura, sin dependencias.
 */

// ─── Mayúsculas ───────────────────────────────────────────────────────────────────────────────

/** Siglas y marcas que se escriben en mayúsculas aunque tengan cuatro letras o más. */
const KEEP_UPPER = new Set([
  'ACAS', 'ACTC', 'ADAC', 'ALMS', 'AMG', 'APAT', 'APTP', 'ARGT', 'ARTA', 'CART', 'DEKRA', 'ELMS', 'ENEOS', 'FIAT',
  'GTWC', 'IGTC', 'IMPUL', 'IMSA', 'INDY', 'JLOC', 'KCMG', 'KDDI', 'KTMS', 'NASCAR', 'NISMO', 'NOPRO', 'SARD',
  'SUGO', 'TKRI', 'WTCR', 'XPEL',
]);

/** Palabras cortas (hasta tres letras) que no son siglas: se pasan a minúsculas o a "Título". */
const SHORT_WORDS = new Set([
  'DE', 'DEL', 'LA', 'LAS', 'LOS', 'EL', 'SAN', 'RIO', 'RÍO', 'ABU', 'RED', 'SPA', 'OF', 'THE', 'AT', 'AND', 'DU', 'DI',
  'DA', 'LE', 'AL', 'MAR', 'SUR', 'BAY', 'NEW', 'OLD', 'BIG', 'BY', 'VON', 'VAN', 'DES',
]);

/** Partículas que van en minúscula en medio de un nombre ("Concepción del Uruguay", "Circuit of the Americas"). */
const PARTICLES = new Set(['de', 'del', 'of', 'the', 'at', 'and', 'di', 'du', 'da', 'des', 'von', 'van', 'by', 'y', 'e']);

/** Grupos de consonantes con que empiezan palabras comunes (inglés/español): "TR", "STR"… */
const ONSETS = new Set([
  'bl', 'br', 'ch', 'cl', 'cr', 'dh', 'dr', 'fl', 'fr', 'gl', 'gr', 'kh', 'kl', 'kn', 'kr', 'ph', 'pl', 'pr', 'qu',
  'sc', 'sch', 'scr', 'sh', 'shr', 'sk', 'sl', 'sm', 'sn', 'sp', 'spl', 'spr', 'st', 'str', 'sw', 'th', 'thr',
  'tr', 'tw', 'wh', 'wr', 'zh',
]);

/** Grupos de consonantes con que terminan palabras comunes ("BEND", "FIRST", "HERTZ"…). */
const CODAS = new Set([
  'ch', 'ck', 'ct', 'ft', 'gh', 'ght', 'ld', 'lf', 'lk', 'll', 'lm', 'lp', 'lt', 'mb', 'mp', 'nch', 'nd', 'ng',
  'nk', 'ns', 'nt', 'nx', 'ps', 'pt', 'rd', 'rk', 'rl', 'rm', 'rn', 'rp', 'rs', 'rst', 'rt', 'rth', 'rtz', 'sh', 'sk',
  'sp', 'ss', 'st', 'th', 'ts', 'tz', 'xt', 'zz', 'nds', 'nts', 'cks', 'rds', 'rks', 'rts', 'sts', 'tt', 'ff', 'nn',
  'mm', 'pp', 'rr', 'dd', 'gg', 'bb', 'cc', 'lls', 'tts', 'ffs', 'ngs', 'nks', 'lts', 'lds', 'mps', 'cts', 'pts',
]);

/**
 * ¿La palabra en mayúsculas parece una sigla y no una palabra? "KCMG", "KTMS", "ARGT", "TKRI" sí;
 * "TEAM", "CORSE", "SPORT", "FUJI", "PLATA" no. Hasta tres letras siempre es sigla (salvo SHORT_WORDS);
 * de seis o más, nunca (salvo KEEP_UPPER). Entre medio decide la forma: sin vocales, o con un grupo de
 * consonantes imposible al principio o al final de una palabra.
 */
export function isLikelyAcronym(word: string): boolean {
  const w = word.toUpperCase();
  if (KEEP_UPPER.has(w)) return true;
  if (/\d/.test(w)) return true;
  if (!/^[A-Z]+$/.test(w)) return false; // con acentos o eñe: es una palabra
  if (w.length <= 3) return !SHORT_WORDS.has(w);
  if (w.length > 5) return false;
  const lower = w.toLowerCase();
  const vowels = /[aeiouy]/g;
  if (!vowels.test(lower)) return true;
  const onset = lower.match(/^[^aeiouy]*/)![0];
  const coda = lower.match(/[^aeiouy]*$/)![0];
  if (onset.length >= 2 && !ONSETS.has(onset)) return true;
  if (coda.length >= 2 && !CODAS.has(coda)) return true;
  return false;
}

const isAllCapsWord = (w: string) => /\p{Lu}/u.test(w) && !/\p{Ll}/u.test(w) && /\p{L}{2}/u.test(w);

/** "PLATA" -> "Plata", "SPA" (parte de "SPA-FRANCORCHAMPS") -> "Spa", "O'REILLY" -> "O'Reilly". */
function titleWord(w: string): string {
  return w.toLocaleLowerCase('es').replace(/^\p{L}|(?<=['’])\p{L}(?=\p{L})/gu, (c) => c.toLocaleUpperCase('es'));
}

/**
 * Pasa a "Título" las palabras escritas todas en mayúsculas, salvo siglas: "Fecha 14 — RIO CUARTO" ->
 * "Fecha 14 — Rio Cuarto", "Michelin 24H DUBAI" -> "Michelin 24H Dubai", "CONCEPCIÓN DEL URUGUAY" ->
 * "Concepción del Uruguay". Las palabras con minúsculas quedan como están.
 */
export function titleCaseCaps(text: string): string {
  let prevWasWord = false;
  return text.replace(/([\p{L}\p{N}]+(?:['’][\p{L}]+)*)|([^\p{L}\p{N}]+)/gu, (token: string, word?: string) => {
    if (!word) {
      // Una partícula va en minúscula solo si sigue a otra palabra separada por espacios ("Termas DE Río").
      prevWasWord = prevWasWord && /^ +$/.test(token);
      return token;
    }
    const after = prevWasWord;
    prevWasWord = true;
    if (!isAllCapsWord(word) || isLikelyAcronym(word)) return word;
    const lower = word.toLocaleLowerCase('es');
    if (after && PARTICLES.has(lower)) return lower;
    return titleWord(word);
  });
}

// ─── Acentos de lugares argentinos ─────────────────────────────────────────────────────────────

/** Lugares de la Argentina que los sitios publican sin acentos (o con errores frecuentes). */
const AR_PLACES: string[] = [
  'Río Cuarto', 'Río Hondo', 'Termas de Río Hondo', 'Río Negro', 'Río Gallegos', 'Río Tercero', 'Entre Ríos',
  'San Nicolás', 'Concepción del Uruguay', 'Paraná', 'Córdoba', 'Neuquén', 'San Martín', 'Olavarría', 'Albardón',
  'Oberá', 'Tucumán', 'Junín', 'Zárate', 'Bahía Blanca', 'Santiago del Estero', 'Oscar Cabalén', 'Cabalén',
  'Rosendo Hernández', 'Marcos Juárez', 'Villa María', 'Nogoyá', 'Gualeguaychú', 'Roberto José Mouras', 'Gálvez',
  'San Martín de los Andes', 'Río Grande', 'Jesús María',
];
/** Errores de tipeo vistos en los sitios oficiales -> forma correcta. */
const AR_TYPOS: Record<string, string> = { 'santiago del estereo': 'Santiago del Estero' };

const VOWEL_CLASS: Record<string, string> = { a: '[aáàä]', e: '[eéèë]', i: '[iíìï]', o: '[oóòö]', u: '[uúùü]', n: '[nñ]' };

const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function placePattern(key: string): RegExp {
  const body = [...plain(key)]
    .map((c) => VOWEL_CLASS[c] ?? (c === ' ' ? '\\s+' : c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('');
  return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu');
}

const AR_RULES: Array<[RegExp, string]> = [
  ...Object.entries(AR_TYPOS).map(([k, v]) => [placePattern(k), v] as [RegExp, string]),
  // Los más largos primero ("Termas de Río Hondo" antes que "Río Hondo").
  ...[...new Set(AR_PLACES)].sort((a, b) => b.length - a.length).map((p) => [placePattern(p), p] as [RegExp, string]),
];

/**
 * Restituye los acentos de lugares argentinos conocidos: "Rio Cuarto" -> "Río Cuarto", "Ciudad San Nicolas"
 * -> "Ciudad San Nicolás", "Entre Rios" -> "Entre Ríos". Solo si el texto no está en mayúsculas (aplicar
 * después de titleCaseCaps). Viedma, Mendoza, Rafaela, etc. no llevan acento y no figuran.
 */
export function restoreArPlaceAccents(text: string): string {
  let out = text;
  for (const [re, proper] of AR_RULES) {
    out = out.replace(re, (m) => (m === m.toUpperCase() && m !== m.toLowerCase() ? proper.toUpperCase() : proper));
  }
  return out;
}

// ─── Eventos, circuitos y lugares ─────────────────────────────────────────────────────────────

export interface PlaceNameOptions {
  /** Categoría argentina o evento en la Argentina: restituye acentos de lugares conocidos. */
  argentina?: boolean;
  /**
   * false: no tocar las mayúsculas (NASCAR, IndyCar, IMSA: "DAYTONA 500", "CRAFTSMAN", "XPEL" son la grafía
   * oficial de marcas y carreras, no texto "gritado").
   */
  titleCase?: boolean;
}

/** "A CONFIRMAR", "Por confirmar", "TBA"… (sede todavía no definida). */
const TO_CONFIRM = /^(?:a|por)\s+confirmar$|^(?:tba|tbc|tbd|to be (?:announced|confirmed))$/i;

/** true si el nombre de la sede es "a confirmar" (en cualquiera de sus formas). */
export function isVenueToConfirm(text: string): boolean {
  return TO_CONFIRM.test(text.replace(/\s+/g, ' ').trim());
}

/** Limpieza común: espacios repetidos, espacio antes de coma, "300km" -> "300 km". */
function tidy(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/(\d)\s?km\b/gi, '$1 km')
    .trim();
}

function caseAndAccents(text: string, opts: PlaceNameOptions): string {
  let out = opts.titleCase === false ? text : titleCaseCaps(text);
  if (opts.argentina) out = restoreArPlaceAccents(out);
  return out;
}

/** "A CONFIRMAR" -> "A confirmar" (la app ya reconoce esa forma como "sin sede"); el resto, prolijo. */
export function normalizeCircuitName(circuit: string, opts: PlaceNameOptions = {}): string {
  const t = tidy(circuit);
  if (isVenueToConfirm(t)) return 'A confirmar';
  return caseAndAccents(t, opts);
}

const listNumbers = (nums: string[]) => (nums.length <= 1 ? (nums[0] ?? '') : `${nums.slice(0, -1).join(', ')} y ${nums.at(-1)}`);

/**
 * Nombre de evento prolijo:
 * - "Round1 OKAYAMA GT 300km RACE" -> "Okayama GT 300 km" (la ronda ya figura aparte: no se repite);
 * - "Rd.3 AUTOPOLIS" -> "Autopolis"; "Rd.11-12 SUZUKA CIRCUIT" -> "Fechas 11 y 12 — Suzuka Circuit";
 * - "Fecha 14 — RIO CUARTO" -> "Fecha 14 — Río Cuarto"; "Fecha 12 A Confirmar" -> "Fecha 12 (sede a confirmar)".
 * `round` es la ronda del evento: el prefijo de una sola ronda se quita solo si coincide con ella.
 */
export function normalizeEventName(name: string, opts: PlaceNameOptions & { round?: number } = {}): string {
  let t = tidy(name);
  // "Round1 OKAYAMA…", "Rd.3 AUTOPOLIS", "Rd.11-12 SUZUKA CIRCUIT", "Rd.3-6-7 FUJI SPEEDWAY".
  const prefix = t.match(/^(?:round|rd\.?)\s*(\d+(?:\s*[-–]\s*\d+)*)\s+(?=\S)/i);
  if (prefix) {
    const nums = prefix[1]!.split(/\s*[-–]\s*/);
    const rest = t.slice(prefix[0].length);
    if (nums.length > 1) t = `Fechas ${listNumbers(nums)} — ${rest}`;
    else if (opts.round !== undefined && Number(nums[0]) === opts.round) t = rest;
  }
  // "… 300 km RACE" / "… 250 km RACE GRAND FINAL": "Race" después de la distancia no agrega nada.
  t = t.replace(/(\d km)\s+race\b/i, '$1');
  // Sede sin confirmar dentro del nombre ("Fecha 12 A Confirmar", "Fecha 7 — A CONFIRMAR").
  t = t.replace(/(?:\s+[-–—]\s+|\s+)(?:a|por)\s+confirmar$/i, ' (sede a confirmar)');
  return caseAndAccents(t, opts);
}

// ─── Sesiones ──────────────────────────────────────────────────────────────────────────────────

/** Cabeza de un segmento de nombre de sesión (en inglés o mal escrito) -> nombre en español. */
const SESSION_HEADS: Array<[RegExp, string | ((m: RegExpMatchArray) => string)]> = [
  [/^free\s+practi[cs]e/i, 'Práctica libre'],
  [/^fp\s*(\d+)/i, (m) => `Práctica libre ${m[1]}`],
  [/^night\s+practi[cs]e/i, 'Práctica nocturna'],
  [/^pr[aá]ctica\s+libre/i, 'Práctica libre'],
  [/^practi[cs]e/i, 'Práctica'],
  [/^sprint\s+(?:qualifying|qualification|shootout)/i, 'Clasificación sprint'],
  [/^(?:qualifying|qualification)\s+race/i, 'Carrera clasificatoria'],
  [/^pre[-\s]?qualifying/i, 'Preclasificación'],
  [/^(?:qualifying|qualifications?|quali)(?:\s+session)?/i, 'Clasificación'],
  [/^sprint\s+race/i, 'Sprint'],
  [/^(?:feature|main)\s+race/i, 'Carrera principal'],
  [/^reverse\s+grid\s+race/i, 'Carrera de grilla invertida'],
  [/^race/i, 'Carrera'],
  [/^warm[\s-]?up/i, 'Warm Up'],
  [/^day/i, 'Día'],
  [/^test(?:ing)?(?:\s+session)?/i, 'Ensayo'],
  [/^heat(?:\s+race)?/i, 'Serie'],
  [/^group/i, 'Grupo'],
  [/^session/i, 'Sesión'],
];

/** Lo que puede seguir a la cabeza: números, códigos ("Q1", "GT3", "A") y palabras conocidas. */
function translateTail(tail: string): string | null {
  const words = tail.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    const next = words[i + 1];
    if (/^\d+$/.test(w) || /^[A-Z0-9][A-Z0-9&+.-]*$/.test(w) || w === '&') {
      // "A Driver" -> "Piloto A"
      if (next && /^drivers?$/i.test(next)) {
        out.push(`Piloto ${w}`);
        i++;
        continue;
      }
      out.push(w);
    } else if (/^group$/i.test(w)) out.push('Grupo');
    else if (/^part$/i.test(w)) out.push('Parte');
    else if (/^session$/i.test(w)) continue;
    else return null; // palabra desconocida: el segmento queda como está
  }
  return out.join(' ');
}

function translateSegment(seg: string): string {
  const t = seg.trim();
  if (!t) return seg;
  // "Rd.11 Qualifying Q1 Group A" -> "Fecha 11 · Clasificación Q1 Grupo A"
  const rd = t.match(/^rd\.?\s*(\d+)\s+(.+)$/i);
  if (rd) {
    const rest = translateSegment(rd[2]!);
    return rest === rd[2] ? seg : `Fecha ${rd[1]} · ${rest}`;
  }
  for (const [re, to] of SESSION_HEADS) {
    const m = t.match(re);
    if (!m) continue;
    const after = t.slice(m[0].length);
    if (after && !/^[\s]/.test(after)) continue; // "Racecourse", "Dayton"…: no es la palabra
    const tail = translateTail(after);
    if (tail === null) return seg;
    const head = typeof to === 'string' ? to : to(m);
    return tail ? `${head} ${tail}` : head;
  }
  // Segmentos sueltos: "A Driver", "Group B".
  const tail = translateTail(t);
  return tail !== null && tail !== t ? tail : seg;
}

/**
 * Nombre de sesión en español: "Practice 1" -> "Práctica 1", "Free Practice 2" -> "Práctica libre 2",
 * "Qualifying" -> "Clasificación", "Sprint Qualifying" -> "Clasificación sprint", "Feature Race" ->
 * "Carrera principal", "Qualifications 1 - GT3" -> "Clasificación 1 - GT3", "Top 10 Shootout (Race 36)" ->
 * "Top 10 Shootout (Carrera 36)". Se traduce por segmentos (" - ", "·", "/", paréntesis); un segmento que no
 * se reconoce entero ("FIA GT World Cup", "Hypercar & LMP2", "Top 10 Shootout") queda como está.
 */
export function spanishSessionName(name: string): string {
  const t = name.replace(/\s+/g, ' ').trim();
  return t
    .split(/(\s+[-–—]\s+|\s*·\s*|\s*\/\s*|\s*\(\s*|\s*\)\s*|:\s+)/)
    .map((part, i) => (i % 2 === 1 ? part : translateSegment(part)))
    .join('');
}

// ─── Nombres de pila en español ───────────────────────────────────────────────────────────────

/**
 * Nombres de pila que los sitios argentinos publican en mayúsculas sin acento ("CORTINA, JOAQUIN").
 * Clave: sin acentos, en mayúsculas.
 */
const SPANISH_GIVEN = [
  'Joaquín', 'Agustín', 'Nicolás', 'Tobías', 'Matías', 'Martín', 'Julián', 'Sebastián', 'Damián', 'Germán',
  'Andrés', 'Hernán', 'Iván', 'Adrián', 'Fabián', 'Rubén', 'Simón', 'Tomás', 'Ramón', 'Benjamín', 'Valentín',
  'Lucía', 'Sofía', 'Inés', 'Máximo', 'Jesús', 'Óscar', 'Néstor', 'Víctor', 'Héctor', 'César', 'Raúl', 'Ángel',
  'Darío', 'Elías', 'Gastón', 'León', 'José', 'María', 'Cristián', 'Fermín', 'Bastián', 'Efraín', 'Moisés',
  'Isaías', 'Mía', 'Ramiro', 'Rocío', 'Belén', 'Josué', 'Nahuél',
].filter((n) => /[À-ÿ]/.test(n) && n !== 'Nahuél');

export const GIVEN_NAME_ACCENTS: ReadonlyMap<string, string> = new Map(
  SPANISH_GIVEN.map((n) => [plain(n).toUpperCase(), n] as [string, string]),
);

/** Nombres que también son apellidos frecuentes: solo se acentúan si se sabe que son el nombre de pila. */
const AMBIGUOUS_GIVEN = new Set(['MARTIN', 'LEON', 'ANGEL', 'TOMAS', 'JOSE', 'RAMON', 'SIMON', 'CESAR']);

/** Acento de un nombre de pila escrito en mayúsculas ("JOAQUIN" -> "JOAQUÍN"), o la palabra tal cual. */
export function accentGivenName(word: string, sure: boolean): string {
  if (!/^[A-Z]+$/.test(word)) return word;
  if (!sure && AMBIGUOUS_GIVEN.has(word)) return word;
  const proper = GIVEN_NAME_ACCENTS.get(word);
  return proper ? proper.toUpperCase() : word;
}

/**
 * Nombres con un "?" o "�" en lugar de una letra acentuada (el sitio perdió la codificación: "AGUST?N",
 * "NICOL?S", "TOB?AS"): se reparan con los nombres de pila conocidos. Lo que no se puede reparar queda igual
 * (ver hasBrokenChars).
 */
export function repairBrokenChars(raw: string): string {
  if (!/[?�]/.test(raw)) return raw;
  return raw.replace(/[\p{L}?�]+/gu, (word) => {
    if (!/[?�]/.test(word) || !/\p{L}/u.test(word)) return word;
    const re = new RegExp(`^${word.replace(/[?�]/g, '[^A-Z]').toUpperCase()}$`, 'u');
    const hits = [...GIVEN_NAME_ACCENTS.values()].filter((n) => re.test(n.toUpperCase()) && n.length === word.length);
    if (hits.length !== 1) return word;
    const fixed = hits[0]!;
    return word === word.toUpperCase() ? fixed.toUpperCase() : fixed;
  });
}

/** true si el texto tiene caracteres rotos ("?" entre letras o el carácter de reemplazo). */
export function hasBrokenChars(text: string): boolean {
  return /�|\p{L}\?+\p{L}/u.test(text);
}
