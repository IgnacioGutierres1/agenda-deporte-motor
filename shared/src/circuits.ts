/**
 * Clave de un circuito: cada categoría escribe el nombre a su manera ("Circuit Paul Ricard", "Paul Ricard",
 * "Michelin 12H PAUL RICARD"). Se arma una clave normalizada y, para los casos comunes que no se resuelven
 * solos, una tabla chica de alias. Es conservador a propósito: juntar dos circuitos distintos es peor que
 * dejar dos páginas del mismo. La usan la app (páginas de circuito) y el pipeline (data/circuits.json).
 */
import { slugify } from './hash.ts';

/** Palabras genéricas que no identifican a un circuito. */
const STOPWORDS = new Set([
  'circuit',
  'circuits',
  'circuito',
  'circuitos',
  'autodromo',
  'autodrom',
  'international',
  'internacional',
  'internazionale',
  'nazionale',
  'grand',
  'prix',
  'gp',
  'street',
  'streets',
  'ciudad',
  'parque',
  'of',
  'the',
  'de',
  'del',
  'do',
  'di',
  'des',
  'du',
]);

/**
 * Prefijos de patrocinador o de nombre de carrera que algunas categorías publican como circuito
 * ("Michelin 12H …", "CrowdStrike 24 Hours of …", "GT Festival …").
 */
const PREFIXES = [
  /^michelin\s+/,
  /^crowdstrike\s+/,
  /^adac\s+ravenol\s+/,
  /^meguiar\s*s\s+/,
  /^porsche\s+mobil\s+1\s+supercup\s+/,
  /^gt\s+festival\s+/,
  /^grand\s+prix\s+of\s+/,
];

/** Duraciones y sufijos de carrera: "24h", "6 hours of", "1000km", "… race", "… prologue". */
const NOISE = [
  // Año de la edición al final ("Michelin 12H Mugello 2027"): sin esto cada temporada sería otro circuito.
  /\s+(?:19|20)\d{2}$/,
  /\b\d+\s*(h|hr|hrs|hour|hours|heures|horas)\b(\s+(of|de|du|des)\b)?/g,
  /\b\d+\s*km\b/g,
  /\s+(race|prologue|sprint|winter\s+test)$/,
  /\s+(?:19|20)\d{2}$/,
];

/**
 * Alias de claves ya normalizadas -> clave canónica. Solo casos seguros (mismo autódromo).
 * No se juntan trazados distintos del mismo lugar (Le Mans Bugatti y La Sarthe, Balcarce y Rosario).
 */
const ALIASES: Record<string, string> = {
  'le castellet': 'paul ricard',
  'jose carlos pace': 'interlagos',
  spa: 'spa francorchamps',
  'barcelona catalunya': 'barcelona',
  catalunya: 'barcelona',
  montmelo: 'barcelona',
  spielberg: 'red bull ring',
  'red bull ring spielberg': 'red bull ring',
  budapest: 'hungaroring',
  hockenheimring: 'hockenheim',
  algarve: 'portimao',
  'misano world marco simoncelli': 'misano',
  'petronas sepang': 'sepang',
  'abu dhabi': 'yas marina',
  'ims road course': 'indianapolis motor speedway',
  indianapolis: 'indianapolis motor speedway',
  'nurburgring sprint': 'nurburgring',
  'barcelona winter test': 'barcelona',
  'juan manuel fangio rosario': 'rosario',
  'roberto jose mouras': 'roberto mouras',
  'la pampa': 'toay',
  'provincia la pampa': 'toay',
  'jerez angel nieto': 'jerez',
  ameriques: 'americas',
  'nurburgring nordschleife': 'nurburgring',
};

/** Nombres que no son un circuito (fecha sin sede confirmada, galas, pruebas). */
const NOT_A_CIRCUIT = /^(a confirmar|por confirmar|tba|tbc|tbd|to be (announced|confirmed))$|\bgala\b|\btest days\b/;

function words(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join(' ');
}

/** Clave normalizada sin aplicar los alias. */
export function circuitBaseKey(raw: string): string {
  let t = words(raw);
  if (!t || NOT_A_CIRCUIT.test(t)) return '';
  for (let changed = true; changed; ) {
    changed = false;
    for (const re of PREFIXES) {
      const next = t.replace(re, '');
      if (next !== t && next) {
        t = next;
        changed = true;
      }
    }
  }
  for (const re of NOISE) t = t.replace(re, ' ').replace(/\s+/g, ' ').trim();
  const kept = t.split(' ').filter((w) => w && !STOPWORDS.has(w));
  // Si solo quedaban palabras genéricas, se usa el nombre completo.
  return kept.length ? kept.join(' ') : t;
}

/**
 * Clave normalizada del circuito ("Circuit Paul Ricard" y "Michelin 12H PAUL RICARD" -> "paul ricard").
 * Devuelve '' si el nombre no corresponde a un circuito ("A confirmar").
 */
export function circuitKey(raw: string): string {
  const key = circuitBaseKey(raw);
  return ALIASES[key] ?? key;
}

export function circuitId(raw: string): string {
  return slugify(circuitKey(raw));
}
