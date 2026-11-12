/**
 * Etiquetado por contexto, para notas que las palabras clave no ubican en ninguna categoría:
 * - nombre completo de un piloto o equipo que corre en una sola categoría ("Liam Lawson" → F1);
 * - circuito de una fecha cercana, si en esos días ahí corre una sola categoría
 *   ("Paul Ricard" la semana de las 4 Horas de Le Castellet → ALMS).
 * Solo nombres inequívocos: un nombre que aparece en dos categorías (o en dos personas/equipos de
 * categorías distintas) no etiqueta nada.
 */
import { normalizeTitle } from './text.ts';

/** Lo mínimo que se lee de data/drivers.json, data/teams.json y data/schedule.json. */
export interface ContextSources {
  drivers?: Array<{
    name: string;
    entries?: Array<{ seriesId: string }>;
    lineups?: Array<{ seriesId: string }>;
    recent?: Array<{ seriesId: string }>;
  }>;
  teams?: Array<{ name: string; entries?: Array<{ seriesId: string }> }>;
  events?: Array<{ seriesId: string; name: string; circuit?: string; dateStart: string; dateEnd: string }>;
}

interface Venue {
  seriesId: string;
  /** Desde cuándo y hasta cuándo una nota puede referirse a esa fecha (ISO). */
  from: string;
  to: string;
}

export interface ContextTagger {
  /** Categorías por nombres de pilotos/equipos y circuitos del título (o las etiquetas del feed). */
  tag(text: string, publishedAt: string): string[];
}

/** Palabras que no identifican a un equipo por sí solas (marcas, "Racing", "Team"…). */
const GENERIC_TEAM_WORDS = new Set(
  (
    'racing team motorsport motorsports competition competicion corse sport sports by the de del la el los and y ' +
    'f1 gt gt3 gt4 junior works factory official academy powered pro engineering autosport auto autos car cars ' +
    'ford bmw audi porsche ferrari mercedes amg benz toyota gazoo gr honda acura chevrolet lexus mclaren aston martin ' +
    'lamborghini alpine cadillac nissan hyundai peugeot renault mazda ktm ducati yamaha aprilia kawasaki suzuki ' +
    'dodge ram fiat volkswagen vw citroen chevy torino corvette mustang camaro red bull hrc'
  ).split(' '),
);

/** Palabras genéricas de los nombres de circuitos. */
const GENERIC_VENUE_WORDS = new Set(
  (
    'circuit circuito circuits international internacional autodromo autodromos speedway raceway motorsport motorsports ' +
    'park parque ciudad city street strip resort mobility race track pista of de del la el the and y grand prix ' +
    'gp hours horas fecha final round rd'
  ).split(' '),
);

/** Ventana de días alrededor de una fecha en la que una nota puede referirse a ella. */
const VENUE_DAYS_BEFORE = 10;
const VENUE_DAYS_AFTER = 3;

export function createContextTagger(src: ContextSources): ContextTagger {
  // Nombre normalizado → categorías (si son varias, es ambiguo y no se usa).
  const names = new Map<string, Set<string>>();
  const addName = (name: string, series: Set<string>) => {
    const key = normalizeTitle(name);
    if (!key) return;
    const set = names.get(key) ?? new Set<string>();
    for (const s of series) set.add(s);
    names.set(key, set);
  };

  for (const d of src.drivers ?? []) {
    const words = normalizeTitle(d.name).split(' ').filter(Boolean);
    // Nombre y apellido como mínimo, sin iniciales sueltas ni seudónimos.
    if (words.length < 2 || words.some((w) => w.length < 2) || words.join(' ').length < 8) continue;
    const series = new Set([...(d.entries ?? []), ...(d.lineups ?? []), ...(d.recent ?? [])].map((e) => e.seriesId));
    if (series.size) addName(d.name, series);
  }
  for (const t of src.teams ?? []) {
    const words = normalizeTitle(t.name).split(' ').filter(Boolean);
    if (words.length < 2 || words.every((w) => GENERIC_TEAM_WORDS.has(w) || /^\d+$/.test(w))) continue;
    const series = new Set((t.entries ?? []).map((e) => e.seriesId));
    if (series.size) addName(t.name, series);
  }
  const unambiguous = new Map<string, string>();
  for (const [key, set] of names) if (set.size === 1) unambiguous.set(key, [...set][0]!);

  const venues = new Map<string, Venue[]>();
  for (const e of src.events ?? []) {
    for (const key of venueKeys(e)) {
      const list = venues.get(key) ?? [];
      list.push({ seriesId: e.seriesId, from: shiftDate(e.dateStart, -VENUE_DAYS_BEFORE), to: shiftDate(e.dateEnd, VENUE_DAYS_AFTER + 1) });
      venues.set(key, list);
    }
  }

  return {
    tag(text, publishedAt) {
      const words = normalizeTitle(text).split(' ').filter(Boolean);
      const found = new Set<string>();
      const venueSeries = new Set<string>();
      for (const gram of ngrams(words, 4)) {
        const s = unambiguous.get(gram);
        if (s) found.add(s);
        for (const v of venues.get(gram) ?? []) if (publishedAt >= v.from && publishedAt < v.to) venueSeries.add(v.seriesId);
      }
      // Un circuito donde esos días corren dos categorías (F1 y F1 Academy, TC y TC Pista) no decide nada.
      if (venueSeries.size === 1) found.add([...venueSeries][0]!);
      return [...found];
    },
  };
}

/** Claves de un circuito: el nombre sin palabras genéricas, y la ciudad de "Fecha 14 — RIO CUARTO" o "4 Hours of Le Castellet". */
export function venueKeys(e: { name: string; circuit?: string }): string[] {
  const out = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    const words = normalizeTitle(raw)
      .split(' ')
      .filter((w) => w && !GENERIC_VENUE_WORDS.has(w) && !/^\d+[a-z]?$/.test(w));
    const key = words.join(' ');
    if (key.length >= 4 && words.length <= 3) out.add(key);
  };
  if (e.circuit && normalizeTitle(e.circuit) !== normalizeTitle(e.name)) add(e.circuit);
  add(e.name.match(/[—–-]\s*([^—–-]+)$/)?.[1]);
  add(e.name.match(/\b(?:Hours|Horas)\s+(?:of|de)\s+(.+)$/i)?.[1]);
  return [...out];
}

function* ngrams(words: string[], max: number): Generator<string> {
  for (let i = 0; i < words.length; i++) {
    for (let n = 1; n <= max && i + n <= words.length; n++) yield words.slice(i, i + n).join(' ');
  }
}

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate.slice(0, 10)}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}
