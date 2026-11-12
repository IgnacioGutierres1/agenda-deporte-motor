/**
 * Circuitos: cada categoría escribe el nombre del circuito a su manera ("Circuit Paul Ricard",
 * "Paul Ricard", "Michelin 12H PAUL RICARD"). Se arma una clave normalizada y, para los casos
 * comunes que no se resuelven solos, una tabla chica de alias. Es conservador a propósito:
 * juntar dos circuitos distintos es peor que dejar dos páginas del mismo.
 * Lógica pura, sin Vue ni Pinia.
 */
import { slugify, type MotorEvent } from '@dm/shared';

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
  /\b\d+\s*(h|hr|hrs|hour|hours|heures|horas)\b(\s+(of|de|du|des)\b)?/g,
  /\b\d+\s*km\b/g,
  /\s+(race|prologue|sprint|winter\s+test)$/,
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
function baseKey(raw: string): string {
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
  const key = baseKey(raw);
  return ALIASES[key] ?? key;
}

export function circuitId(raw: string): string {
  return slugify(circuitKey(raw));
}

export interface Circuit {
  id: string;
  key: string;
  /** Nombre para mostrar (la variante más usada y más "limpia"). */
  name: string;
  /** Todas las variantes con que lo publican las categorías. */
  names: string[];
  country: string;
  seriesIds: string[];
  /** Eventos ordenados por fecha. */
  events: MotorEvent[];
}

/** Variantes que son nombre de carrera más que de circuito: se usan solo si no hay otra. */
const EVENTY = /\d+\s*h\b|hours|heures|\d+\s*km|michelin|crowdstrike|supercup|festival|prologue|\brace$|\(/i;

function mostCommon(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'es')).map(([v]) => v);
}

/** Agrupa los eventos por circuito. */
export function buildCircuits(events: MotorEvent[]): Circuit[] {
  const byKey = new Map<string, MotorEvent[]>();
  for (const e of events) {
    const key = circuitKey(e.circuit);
    if (!key) continue;
    const list = byKey.get(key);
    if (list) list.push(e);
    else byKey.set(key, [e]);
  }
  const out: Circuit[] = [];
  for (const [key, list] of byKey) {
    const counts = new Map<string, number>();
    for (const e of list) counts.set(e.circuit.trim(), (counts.get(e.circuit.trim()) ?? 0) + 1);
    // La variante más usada; a igualdad, la que ya es el nombre canónico ("Interlagos").
    const names = [...counts.keys()].sort(
      (a, b) =>
        counts.get(b)! - counts.get(a)! ||
        Number(baseKey(b) === key) - Number(baseKey(a) === key) ||
        a.localeCompare(b, 'es'),
    );
    const name = names.find((n) => !EVENTY.test(n)) ?? names[0]!;
    out.push({
      id: slugify(key),
      key,
      name,
      names,
      country: mostCommon(list.map((e) => e.country.trim()).filter(Boolean))[0] ?? '',
      seriesIds: [...new Set(list.map((e) => e.seriesId))],
      events: [...list].sort((a, b) => a.dateStart.localeCompare(b.dateStart) || a.seriesId.localeCompare(b.seriesId)),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'es'));
}
