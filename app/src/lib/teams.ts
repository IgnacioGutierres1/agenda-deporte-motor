/**
 * Equipos: helpers puros sobre data/teams.json y, mientras ese archivo no exista, un índice
 * armado con los equipos que figuran en data/drivers.json (tablas e inscripciones de cada piloto).
 */
import { teamId, type Driver, type NewsItem, type Team, type TeamEntry } from '@dm/shared';

/** Categorías en las que figura un piloto (campeonatos e inscripciones). */
export function driverSeriesIds(d: Driver): string[] {
  return [...new Set([...d.entries.map((e) => e.seriesId), ...(d.lineups ?? []).map((l) => l.seriesId)])];
}

/** Categorías de un equipo: las de sus tablas e inscripciones y las de sus pilotos. */
export function teamSeriesIds(t: Team): string[] {
  return [...new Set([...t.entries.map((e) => e.seriesId), ...t.drivers.map((d) => d.seriesId)])];
}

/** Línea principal de un equipo: la primera con posición (la tabla general de su categoría principal), o la primera. */
export function teamMainEntry(t: Team): TeamEntry | undefined {
  return t.entries.find((e) => e.pos !== undefined) ?? t.entries[0];
}

/** Números de auto de un equipo en una categoría (de todas sus líneas y, si no hay, de sus pilotos). */
export function teamNumbers(t: Team, seriesId: string): string[] {
  const out = new Set(t.entries.filter((e) => e.seriesId === seriesId).flatMap((e) => e.numbers ?? []));
  if (!out.size) for (const d of t.drivers) if (d.seriesId === seriesId && d.number) out.add(d.number);
  return [...out];
}

/** Piloto del plantel de un equipo en una categoría, con todos sus números (sin repetir). */
export interface TeamRosterDriver {
  id: string;
  name: string;
  numbers: string[];
}

export interface TeamRosterGroup {
  seriesId: string;
  drivers: TeamRosterDriver[];
}

const numValue = (n: string | undefined) => Number.parseInt(n ?? '', 10) || 9999;

/**
 * Plantel de un equipo agrupado por categoría (en el orden de `seriesIds`): cada piloto una sola vez por categoría,
 * con sus números juntos ("#32 #46"), ordenados por su número más bajo y después por nombre.
 */
export function teamRoster(t: Team, seriesIds: string[] = teamSeriesIds(t)): TeamRosterGroup[] {
  return seriesIds
    .map((seriesId) => {
      const byId = new Map<string, TeamRosterDriver>();
      for (const d of t.drivers) {
        if (d.seriesId !== seriesId) continue;
        const row = byId.get(d.id) ?? { id: d.id, name: d.name, numbers: [] };
        if (d.number && !row.numbers.includes(d.number)) row.numbers.push(d.number);
        byId.set(d.id, row);
      }
      const drivers = [...byId.values()];
      for (const d of drivers) d.numbers.sort((a, b) => numValue(a) - numValue(b) || a.localeCompare(b));
      drivers.sort((a, b) => numValue(a.numbers[0]) - numValue(b.numbers[0]) || a.name.localeCompare(b.name, 'es'));
      return { seriesId, drivers };
    })
    .filter((g) => g.drivers.length > 0);
}

/** Nombre de tabla que no agrega nada al lado de un equipo ("Equipos", "Teams"). */
export const isGenericTeamTable = (table: string | undefined): boolean => !table || /^(equipos?|teams?)$/i.test(table.trim());

const push = (list: string[] | undefined, value: string | undefined): string[] | undefined => {
  if (!value) return list;
  const out = list ?? [];
  if (!out.includes(value)) out.push(value);
  return out;
};

/** Equipos a partir de los pilotos (sin posiciones de la tabla de equipos). */
export function deriveTeams(drivers: Driver[]): Team[] {
  const teams = new Map<string, Team & { names: Map<string, number> }>();
  const get = (raw: string) => {
    const id = teamId(raw);
    if (!id) return undefined;
    let t = teams.get(id);
    if (!t) {
      t = { id, name: raw.trim(), entries: [], drivers: [], names: new Map() };
      teams.set(id, t);
    }
    t.names.set(raw.trim(), (t.names.get(raw.trim()) ?? 0) + 1);
    return t;
  };
  const entryOf = (t: Team, seriesId: string): TeamEntry => {
    let e = t.entries.find((x) => x.seriesId === seriesId);
    if (!e) {
      e = { seriesId };
      t.entries.push(e);
    }
    return e;
  };
  const addDriver = (t: Team, d: Driver, seriesId: string, number: string | undefined) => {
    if (t.drivers.some((x) => x.id === d.id && x.seriesId === seriesId)) return;
    t.drivers.push({ id: d.id, name: d.name, seriesId, ...(number ? { number } : {}) });
  };
  for (const d of drivers) {
    for (const e of d.entries) {
      if (!e.team) continue;
      const t = get(e.team);
      if (!t) continue;
      const te = entryOf(t, e.seriesId);
      te.numbers = push(te.numbers, e.number);
      addDriver(t, d, e.seriesId, e.number);
    }
    for (const l of d.lineups ?? []) {
      if (!l.team) continue;
      const t = get(l.team);
      if (!t) continue;
      const te = entryOf(t, l.seriesId);
      te.numbers = push(te.numbers, l.number);
      te.vehicles = push(te.vehicles, l.vehicle);
      te.classes = push(te.classes, l.class);
      addDriver(t, d, l.seriesId, l.number);
    }
  }
  return [...teams.values()].map(({ names, ...t }) => ({
    ...t,
    // El nombre más usado entre las variantes.
    name: [...names.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0]![0],
  }));
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Palabras que aparecen en muchísimos nombres de equipo y no lo identifican. */
const GENERIC = new Set([
  'team',
  'teams',
  'racing',
  'racer',
  'motorsport',
  'motorsports',
  'sport',
  'sports',
  'competicion',
  'competicao',
  'competition',
  'competizione',
  'scuderia',
  'escuderia',
  'equipe',
  'squadra',
  'gp',
  'f1',
  'by',
  'the',
  'de',
  'del',
  'srl',
  'sa',
  'ltd',
  'inc',
  'llc',
  'gmbh',
  'ag',
]);

function teamWords(name: string): { words: string[]; core: string[] } {
  const words = norm(name)
    .replace(/#\s*\d+/g, ' ')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return { words, core: words.filter((w) => !GENERIC.has(w)) };
}

/**
 * Frases que, si aparecen en un título, se refieren al equipo ("Team WRT" -> "wrt").
 * `rivals`: los otros equipos de sus categorías. La primera palabra distintiva sola
 * ("Scuderia Ferrari HP" -> "ferrari") solo se usa si ningún rival empieza igual.
 */
export function teamNeedles(name: string, rivals: string[] = []): string[] {
  const { words, core } = teamWords(name);
  const out = new Set<string>();
  const full = words.join(' ');
  if (full.length >= 4) out.add(full);
  if (core.length && core.join(' ').length >= 3) out.add(core.join(' '));
  const first = core[0];
  if (core.length > 1 && first && first.length >= 5 && !rivals.some((r) => teamWords(r).core[0] === first)) out.add(first);
  return [...out];
}

/** Notas de las categorías del equipo cuyo título lo menciona. */
export function newsForTeam(items: NewsItem[], team: Team, allTeams: Team[] = []): NewsItem[] {
  const series = new Set(team.entries.map((e) => e.seriesId));
  const rivals = allTeams.filter((t) => t.id !== team.id && t.entries.some((e) => series.has(e.seriesId))).map((t) => t.name);
  const res = teamNeedles(team.name, rivals).map((n) => new RegExp(`(^|[^a-z0-9])${n.replace(/ /g, '[^a-z0-9]+')}([^a-z0-9]|$)`));
  if (!res.length) return [];
  return items.filter((n) => {
    // Solo notas de sus categorías: un nombre puede repetirse en otras disciplinas.
    if (!n.seriesIds.some((id) => series.has(id))) return false;
    const title = norm(n.title);
    return res.some((re) => re.test(title));
  });
}
