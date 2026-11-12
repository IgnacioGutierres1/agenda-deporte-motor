/**
 * Posibles pilotos duplicados en el índice: el mismo piloto publicado con variantes del nombre que no se unen
 * solas ("Cam Waters" / "Cameron Waters", "Alexey" / "Aleksei Nesov", "Jamie Alan Day" / "Jamie Day").
 * No une nada: arma la lista para revisar a mano y, si corresponde, sumar el alias a config/driver-aliases.json.
 * Ver `npm run drivers:candidates`.
 */
import { knownHomonyms, teamKey, type Driver } from '@dm/shared';

export interface DuplicateCandidate {
  a: Pick<Driver, 'id' | 'name'>;
  b: Pick<Driver, 'id' | 'name'>;
  /** Por qué los nombres se parecen ("diminutivo", "nombre a 1 letra", "palabras incluidas"…). */
  nameMatch: string;
  /** Qué tienen en común (equipo, número en la misma categoría, país, categoría). */
  evidence: string[];
  score: number;
}

/** Diminutivos y variantes frecuentes del mismo nombre de pila (sin acentos, en minúsculas). */
const NICKNAMES: string[][] = [
  ['alex', 'alexander', 'alexandar', 'alexandre', 'alessandro', 'aleksandr', 'alejandro'],
  ['aleksei', 'alexey', 'alexei', 'aleksey'],
  ['cam', 'cameron'],
  ['chris', 'christopher', 'kristopher', 'christoph'],
  ['dani', 'daniel', 'dan', 'danny', 'daniele'],
  ['tom', 'thomas', 'tommy', 'tomas', 'tommaso'],
  ['mike', 'mikey', 'michael', 'mick', 'mikkel', 'michele'],
  ['jonny', 'jonathan', 'jon', 'jonathon', 'johnny'],
  ['jef', 'jeff', 'jeffrey', 'geoffrey'],
  ['nick', 'nicholas', 'nicolas', 'nico', 'nicky', 'niklas', 'nicklas', 'nicola', 'nikolas'],
  ['matt', 'matthew', 'matthias', 'mathias', 'matias', 'mateo', 'matteo'],
  ['ben', 'benjamin', 'benji'],
  ['sam', 'samuel', 'sammy'],
  ['will', 'william', 'bill', 'billy', 'liam'],
  ['rob', 'robert', 'bob', 'bobby', 'robbie', 'roberto'],
  ['andy', 'andrew', 'andreas', 'andrea', 'andres'],
  ['jim', 'james', 'jamie', 'jimmy'],
  ['joe', 'joseph', 'joey', 'jose'],
  ['josh', 'joshua'],
  ['pat', 'patrick', 'paddy'],
  ['tony', 'anthony', 'antonio', 'toni'],
  ['zak', 'zach', 'zachary', 'zack'],
  ['max', 'maximilian', 'maxime', 'maximiliano', 'maximo'],
  ['fred', 'frederik', 'frederic', 'frederick', 'freddie'],
  ['ed', 'edward', 'eddie', 'edoardo'],
  ['steve', 'steven', 'stephen', 'stefan', 'steffen'],
  ['dave', 'david'],
  ['charlie', 'charles'],
  ['harry', 'henry', 'hank'],
  ['jake', 'jacob', 'jakob'],
  ['ricky', 'richard', 'rick', 'rich', 'riccardo', 'ricardo'],
  ['ollie', 'oliver', 'olly'],
  ['phil', 'philip', 'phillip', 'philipp'],
  ['tim', 'timothy', 'timo'],
  ['greg', 'gregory'],
  ['santi', 'santiago'],
  ['fede', 'federico'],
  ['nacho', 'ignacio'],
  ['gabi', 'gabriel', 'gabriele'],
];
const NICK = new Map<string, number>();
NICKNAMES.forEach((group, i) => group.forEach((n) => NICK.set(n, i)));

const plain = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Palabras del nombre mostrado, sin acentos ni signos ("Gustavo Tadei (h)" -> ["gustavo", "tadei", "h"]). */
const words = (name: string) => plain(name).split(/[^a-z0-9]+/).filter(Boolean);

/** Distancia de edición (Levenshtein). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

/** Cómo se parecen dos nombres de pila, o null si no se parecen lo suficiente. */
function givenMatch(a: string, b: string): string | null {
  if (a === b) return 'mismo nombre';
  if (NICK.has(a) && NICK.get(a) === NICK.get(b)) return 'diminutivo o variante';
  const d = editDistance(a, b);
  // Nombres cortos: una letra de diferencia ya puede ser otro nombre ("Jan"/"Jon"); se exige largo.
  if (d === 1 && Math.min(a.length, b.length) >= 3) return 'nombre a 1 letra';
  if (d === 2 && Math.min(a.length, b.length) >= 5) return 'nombre a 2 letras';
  if (Math.min(a.length, b.length) >= 3 && (a.startsWith(b) || b.startsWith(a))) return 'nombre abreviado';
  return null;
}

function nameMatch(a: string[], b: string[]): string | null {
  if (a.length === 0 || b.length === 0) return null;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  // "Jamie Day" dentro de "Jamie Alan Day", "Mathieu Detry" dentro de "Mathieu Vincent R Detry".
  if (short.length >= 2 && short.length < long.length && short.every((w) => long.includes(w))) return 'palabras incluidas';
  const sa = a.at(-1)!;
  const sb = b.at(-1)!;
  if (a.length < 2 || b.length < 2) return null;
  if (sa === sb) {
    const g = givenMatch(a[0]!, b[0]!);
    return g && g !== 'mismo nombre' ? g : null;
  }
  // Mismo nombre de pila y apellido a una letra ("Nicklas"/"Niclkas" ya cae arriba; "Riccardo Pera"/"Ricardo Pera" también).
  if (a[0] === b[0] && Math.min(sa.length, sb.length) >= 5 && editDistance(sa, sb) === 1) return 'apellido a 1 letra';
  return null;
}

interface Facts {
  series: Set<string>;
  teams: Set<string>;
  numbers: Set<string>;
  country?: string;
}

function facts(d: Driver): Facts {
  const lines = [...d.entries, ...(d.lineups ?? [])];
  return {
    series: new Set(lines.map((l) => l.seriesId)),
    teams: new Set(lines.map((l) => (l.team ? teamKey(l.team) : '')).filter(Boolean)),
    numbers: new Set(lines.filter((l) => l.number).map((l) => `${l.seriesId}#${l.number!.replace(/^0+(?=\d)/, '')}`)),
    ...(d.country ? { country: plain(d.country) } : {}),
  };
}

const intersects = <T>(a: Set<T>, b: Set<T>) => [...a].some((x) => b.has(x));

/** Pares ya resueltos como homónimos en config/driver-aliases.json (no se vuelven a proponer). */
export function ignoredPairs(): Set<string> {
  return new Set(knownHomonyms().map((pair) => [...pair].sort().join('|')));
}

/**
 * Pares de pilotos que probablemente son la misma persona: nombres parecidos (mismo apellido y nombre de pila
 * a una o dos letras, diminutivo o abreviado; o las palabras de uno incluidas en el otro) y algo en común
 * (equipo, número en la misma categoría o país). `ignore` son pares ya resueltos (p. ej. homónimos
 * conocidos), como "id-a|id-b" en cualquier orden.
 */
export function duplicateCandidates(drivers: Driver[], ignore: Set<string> = new Set()): DuplicateCandidate[] {
  const info = drivers.map((d) => ({ d, w: words(d.name), f: facts(d) }));
  // Se comparan solo pares que comparten alguna palabra (apellido, nombre o una del nombre compuesto).
  const byWord = new Map<string, number[]>();
  info.forEach((x, i) => {
    for (const w of new Set([x.w.at(-1)!, x.w[0]!])) {
      if (!w) continue;
      const list = byWord.get(w);
      if (list) list.push(i);
      else byWord.set(w, [i]);
    }
  });
  const seen = new Set<string>();
  const out: DuplicateCandidate[] = [];
  for (const list of byWord.values()) {
    if (list.length < 2 || list.length > 400) continue;
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const x = info[list[i]!]!;
        const y = info[list[j]!]!;
        const key = [x.d.id, y.d.id].sort().join('|');
        if (seen.has(key) || ignore.has(key)) continue;
        seen.add(key);
        const match = nameMatch(x.w, y.w);
        if (!match) continue;
        const evidence: string[] = [];
        let score = 0;
        if (intersects(x.f.teams, y.f.teams)) {
          evidence.push('equipo');
          score += 3;
        }
        if (intersects(x.f.numbers, y.f.numbers)) {
          evidence.push('número');
          score += 3;
        }
        if (x.f.country && x.f.country === y.f.country) {
          evidence.push('país');
          score += 1;
        }
        if (intersects(x.f.series, y.f.series)) {
          evidence.push('categoría');
          score += 1;
        }
        const strongName = match === 'diminutivo o variante' || match === 'palabras incluidas' || match === 'nombre abreviado';
        // Solo la categoría en común alcanza si el nombre es claramente una variante ("Dani"/"Daniel Juncadella");
        // con una letra de diferencia hace falta algo más (equipo, número o país).
        if (evidence.length === 0 || (evidence.length === 1 && evidence[0] === 'categoría' && !strongName)) continue;
        if (strongName) score += 1;
        out.push({ a: { id: x.d.id, name: x.d.name }, b: { id: y.d.id, name: y.d.name }, nameMatch: match, evidence, score });
      }
    }
  }
  return out.sort((p, q) => q.score - p.score || p.a.name.localeCompare(q.a.name, 'es'));
}
