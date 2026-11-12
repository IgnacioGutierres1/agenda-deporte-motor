/**
 * Etiquetado de notas por categoría con palabras clave (precisión antes que alcance).
 *
 * Las reglas se evalúan en orden y cada coincidencia se "consume" (se borra del texto), así un
 * nombre específico no dispara además uno genérico: "TC Pista" no cuenta como "TC",
 * "Súper TC2000" no cuenta como "TC", "F1 Academy" no cuenta como "F1",
 * "European Le Mans Series" no cuenta como "Le Mans" (WEC). Las reglas con `seriesId: null`
 * solo consumen nombres que se parecen a una categoría seguida pero no lo son
 * (MotoGP Rookies Cup, Le Mans Classic…).
 */

export interface TagRule {
  seriesId: string | null;
  patterns: RegExp[];
  /** Solo para notas en estos idiomas (siglas ambiguas en otros, como "TC"). */
  langs?: string[];
}

const I = 'gi'; // sin distinguir mayúsculas
const C = 'g'; // siglas: solo en mayúsculas

const re = (src: string, flags = I) => new RegExp(src, flags);

export const TAG_RULES: TagRule[] = [
  // --- Argentina: de lo más específico a lo más genérico ---------------------
  { seriesId: 'tc-mouras', patterns: [re(String.raw`\bTC\s*(?:Pista\s*)?Mouras\b`)] },
  { seriesId: 'tc-pickup', patterns: [re(String.raw`\bTC\s*Pick[\s-]?Ups?\b`), re(String.raw`\bTCPU\b`, C)] },
  { seriesId: 'tc-pista', patterns: [re(String.raw`\bTC\s*Pista\b`)] },
  { seriesId: 'tc2000', patterns: [re(String.raw`\b(?:S[uú]per\s*)?TC\s*2000\b`), re(String.raw`\bTC2K\b`, C)] },
  { seriesId: 'turismo-pista', patterns: [re(String.raw`\bTurismo\s+Pista\b`)] },
  {
    seriesId: 'tn',
    patterns: [
      re(String.raw`\bTurismo\s+Nacional\b`),
      re(String.raw`\bTN\s+Clase\s*[23]\b`),
      re(String.raw`\bClase\s*[23]\s+(?:del\s+)?TN\b`),
    ],
  },
  { seriesId: 'tc', patterns: [re(String.raw`\bTurismo\s+Carretera\b`)] },
  // "TC" a secas, en mayúsculas y solo en notas en castellano (en inglés puede ser "traction control").
  { seriesId: 'tc', patterns: [re(String.raw`(?<![\w-])TC(?![\w-])`, C)], langs: ['es'] },

  // --- Asia y Oceanía (antes de las genéricas: "Super Formula" no es F1) ----------
  { seriesId: null, patterns: [re(String.raw`\bSuper\s*Formula\s+Lights\b`)] },
  { seriesId: 'super-formula', patterns: [re(String.raw`\bSuper\s*Formula\b`)] },
  { seriesId: 'super-taikyu', patterns: [re(String.raw`\bSuper\s*Taikyu\b`)] },
  { seriesId: 'macau-gp', patterns: [re(String.raw`\bMaca[ou]\s+(?:Grand\s+Prix|GP)\b`), re(String.raw`\bGran\s+Premio\s+de\s+Macao\b`)] },
  { seriesId: 'supercars', patterns: [re(String.raw`\bSupercars\b`), re(String.raw`\bBathurst\s*1000\b`)] },
  { seriesId: 'super-gt',patterns: [re(String.raw`\bSUPER\s*GT\b`, C), re(String.raw`\bSuper\s+GT\b`)] },

  // --- Monoplazas FIA ----------------------------------------------------------
  { seriesId: 'f1-academy', patterns: [re(String.raw`\bF1\s*Academy\b`)] },
  { seriesId: 'f2', patterns: [re(String.raw`\bF[oó]rmula\s*(?:2|Dos|Two)\b`), re(String.raw`\bF2\b`, C)] },
  { seriesId: 'f3', patterns: [re(String.raw`\bF[oó]rmula\s*(?:3|Tres|Three)\b`), re(String.raw`\bF3\b`, C)] },
  { seriesId: 'f1', patterns: [re(String.raw`\bF[oó]rmula\s*(?:1|Uno|One)\b`), re(String.raw`\bF1\b`, C)] },
  { seriesId: 'porsche-supercup', patterns: [re(String.raw`\bPorsche\s+(?:Mobil\s*1\s+)?Supercup\b`)] },

  // --- Motos -------------------------------------------------------------------
  { seriesId: null, patterns: [re(String.raw`\bMotoGP\s+Rookies\s+Cup\b`)] },
  { seriesId: 'moto2', patterns: [re(String.raw`\bMoto\s?2\b`)] },
  { seriesId: 'moto3', patterns: [re(String.raw`\bMoto\s?3\b`)] },
  { seriesId: 'motogp', patterns: [re(String.raw`\bMoto\s?GP\b`)] },

  // --- Estados Unidos ------------------------------------------------------------
  { seriesId: 'indy-nxt', patterns: [re(String.raw`\bIndy\s*NXT\b`)] },
  {
    seriesId: 'indycar',
    patterns: [
      re(String.raw`\bIndyCar\b`),
      re(String.raw`\bIndy(?:anapolis)?\s*500\b`),
      re(String.raw`\b500\s+Millas\s+de\s+Indian[aá]polis\b`),
    ],
  },
  { seriesId: 'nascar-truck', patterns: [re(String.raw`\b(?:NASCAR\s+)?(?:Craftsman\s+)?Truck\s+Series\b`)] },
  {
    seriesId: 'nascar-xfinity',
    patterns: [re(String.raw`\b(?:NASCAR\s+)?Xfinity(?:\s+Series)?\b`), re(String.raw`\bO['’]Reilly\s+(?:Auto\s+Parts\s+)?Series\b`)],
  },
  {
    seriesId: 'nascar-cup',
    patterns: [re(String.raw`\b(?:NASCAR\s+)?Cup\s+Series\b`), re(String.raw`\bNASCAR\s+Cup\b`), re(String.raw`\bDaytona\s*500\b`)],
  },

  // --- GT y resistencia ------------------------------------------------------------
  { seriesId: 'elms', patterns: [re(String.raw`\bEuropean\s+Le\s+Mans\s+Series\b`), re(String.raw`\bELMS\b`, C)] },
  { seriesId: 'alms', patterns: [re(String.raw`\bAsian\s+Le\s+Mans\s+Series\b`), re(String.raw`\bAs?LMS\b`, C)] },
  { seriesId: null, patterns: [re(String.raw`\bLe\s+Mans\s+(?:Cup|Classic|Virtual|Ultimate)\b`)] },
  {
    seriesId: 'imsa',
    patterns: [
      re(String.raw`\bIMSA\b`, C),
      re(String.raw`\bWeatherTech\b`),
      re(String.raw`\bRolex\s*24\b`),
      re(String.raw`\bPetit\s+Le\s+Mans\b`),
      re(String.raw`\b(?:12\s*(?:Hours|Horas)\s+(?:of|de)\s+Sebring|Sebring\s+12\s*(?:Hours|Horas))\b`),
    ],
  },
  {
    seriesId: 'wec',
    patterns: [
      re(String.raw`\bWEC\b`, C),
      re(String.raw`\bWorld\s+Endurance\s+Championship\b`),
      re(String.raw`\b(?:Campeonato\s+)?Mundial\s+de\s+Resistencia\b`),
      re(String.raw`\b24\s*(?:Hours|Horas|h)\s+(?:of|de)\s+Le\s+Mans\b`),
      re(String.raw`\bLe\s+Mans\s+24\s*(?:Hours|Horas|h)?\b`),
    ],
  },
  {
    seriesId: 'gtwc-europe',
    patterns: [
      re(String.raw`\bGT\s*World\s*Challenge\s+Europe\b`),
      re(String.raw`\bGTWC\s*Europe\b`),
      re(String.raw`\b24\s*(?:Hours|Horas|h)\s+(?:of|de)\s+Spa\b`),
      re(String.raw`\bSpa\s+24\s*(?:Hours|Horas|h)\b`),
    ],
  },
  { seriesId: 'gtwc-asia', patterns: [re(String.raw`\b(?:GT\s*World\s*Challenge|GTWC)\s+Asia\b`)] },
  { seriesId: 'gtwc-america', patterns: [re(String.raw`\b(?:GT\s*World\s*Challenge|GTWC)\s+America\b`)] },
  { seriesId: 'gtwc-australia', patterns: [re(String.raw`\b(?:GT\s*World\s*Challenge|GTWC)\s+Australia\b`)] },
  { seriesId: 'igtc', patterns: [re(String.raw`\bIntercontinental\s+GT\s+Challenge\b`), re(String.raw`\bIGTC\b`, C)] },
  { seriesId: 'dtm', patterns: [re(String.raw`\bDTM\b`, C)] },
  {
    seriesId: 'nls',
    patterns: [re(String.raw`\bNLS\b`, C), re(String.raw`\bN[uü]rburgring\s+Langstrecken[\s-]Serie\b`)],
  },
  { seriesId: '24h-series', patterns: [re(String.raw`\b24H\s+Series\b`), re(String.raw`\bCreventic\b`)] },
  { seriesId: 'gt-open', patterns: [re(String.raw`\b(?:International\s+)?GT\s+Open\b`)] },
];

const NASCAR_IDS = ['nascar-cup', 'nascar-xfinity', 'nascar-truck'];

export interface TagInput {
  title: string;
  summary?: string;
  categories?: string[];
  lang?: string;
}

/** Categorías mencionadas en el título, las categorías del feed o la bajada. */
export function tagSeries(input: TagInput, rules: TagRule[] = TAG_RULES): string[] {
  // Separadores fuertes para que una sigla no se una con la palabra del campo siguiente.
  let text = [input.title, ...(input.categories ?? []), input.summary ?? ''].join(' \n ');
  const found = new Set<string>();
  for (const rule of rules) {
    if (rule.langs && !(input.lang && rule.langs.includes(input.lang))) continue;
    for (const p of rule.patterns) {
      p.lastIndex = 0;
      if (!p.test(text)) continue;
      p.lastIndex = 0;
      if (rule.seriesId) found.add(rule.seriesId);
      text = text.replace(p, ' ');
    }
  }
  // "NASCAR" a secas habla casi siempre de la categoría principal.
  if (!NASCAR_IDS.some((id) => found.has(id)) && /\bNASCAR\b/i.test(text)) found.add('nascar-cup');
  return [...found];
}

/**
 * Secciones de la URL que identifican la categoría sin ambigüedad
 * (motorsport.com "/f1/news/…", the-race.com "/formula-1/…", sportscar365.com "/imsa/…").
 */
const URL_SEGMENTS: Record<string, string> = {
  f1: 'f1',
  'formula-1': 'f1',
  formula1: 'f1',
  'formula-uno': 'f1',
  f2: 'f2',
  'formula-2': 'f2',
  f3: 'f3',
  'formula-3': 'f3',
  'f1-academy': 'f1-academy',
  motogp: 'motogp',
  moto2: 'moto2',
  moto3: 'moto3',
  indycar: 'indycar',
  'indy-nxt': 'indy-nxt',
  'nascar-cup': 'nascar-cup',
  'nascar-xfinity': 'nascar-xfinity',
  'nascar-truck': 'nascar-truck',
  wec: 'wec',
  alms: 'alms',
  imsa: 'imsa',
  elms: 'elms',
  dtm: 'dtm',
  tc: 'tc',
  'turismo-carretera': 'tc',
  'tc-pista': 'tc-pista',
  'tc-pick-up': 'tc-pickup',
  'tc-pickup': 'tc-pickup',
  'tc-mouras': 'tc-mouras',
  tc2000: 'tc2000',
  'turismo-nacional': 'tn',
  'turismo-pista': 'turismo-pista',
};

/** Palabras sueltas del "slug" de la nota que tampoco son ambiguas (Olé: ".../fia-formula1-qatar_0_…"). */
const SLUG_WORDS: Record<string, string> = {
  formula1: 'f1',
  motogp: 'motogp',
  moto2: 'moto2',
  moto3: 'moto3',
  indycar: 'indycar',
  tc2000: 'tc2000',
};

export function tagUrl(url: string): string[] {
  let segments: string[];
  try {
    segments = new URL(url).pathname.toLowerCase().split('/').filter(Boolean);
  } catch {
    return [];
  }
  const found = new Set<string>();
  for (const seg of segments) {
    const s = URL_SEGMENTS[seg];
    if (s) found.add(s);
    for (const w of seg.split(/[-_.]+/)) {
      const id = SLUG_WORDS[w];
      if (id) found.add(id);
    }
  }
  return [...found];
}
