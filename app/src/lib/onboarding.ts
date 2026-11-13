/**
 * "Empezá por acá": lo primero para seguir cuando todavía no se sigue nada, pensado para un fan
 * argentino. Categorías fijas (F1, TC, TC2000, MotoGP, TC Pista, TN, WRC y Dakar), Colapinto y Canapino, y los
 * líderes actuales del TC y del TC2000 sacados de las tablas publicadas (no de nombres fijos).
 * Lógica pura, sin Vue ni Pinia.
 */
import { driverId, isDriverTable, isSingleDriverName, type Driver, type Series, type StandingsFile } from '@dm/shared';
import { driverSeriesIds } from './teams.ts';
import { MAJOR_SERIES } from './search.ts';

/** Categorías del paquete, con su motivo. Algunas tienen otro id en datos viejos o de prueba. */
export const STARTER_SERIES: Array<{ ids: string[]; reason: string }> = [
  { ids: ['f1'], reason: 'La máxima, con un argentino en la grilla' },
  { ids: ['tc'], reason: 'La más popular del país' },
  { ids: ['tc2000'], reason: 'Las marcas oficiales, en todo el país' },
  { ids: ['motogp'], reason: 'El Mundial de motos' },
  { ids: ['tc-pista'], reason: 'La antesala del TC' },
  { ids: ['tn', 'turismo-nacional'], reason: 'Autos de calle preparados, de todo el país' },
  // Rally y rally raid (solo aparecen si la categoría está publicada).
  { ids: ['wrc'], reason: 'El Mundial de Rally: asfalto, tierra y nieve' },
  { ids: ['dakar', 'rally-dakar'], reason: 'El rally raid más duro, con argentinos protagonistas' },
];

/** Pilotos fijos del paquete (se resuelven por id, solo si figuran en el índice de pilotos). */
export const STARTER_DRIVERS: Array<{ name: string; seriesId: string; reason: string }> = [
  { name: 'Franco Colapinto', seriesId: 'f1', reason: 'Argentino en F1' },
  { name: 'Agustín Canapino', seriesId: 'tc', reason: 'Ídolo del automovilismo argentino' },
];

/** Categorías cuyo líder actual se sugiere. */
export const STARTER_LEADERS = ['tc', 'tc2000'];

/** Con esta cantidad de cosas seguidas el paquete ya no se muestra. */
export const STARTER_HIDE_AT = 3;

export interface StarterItem {
  kind: 'series' | 'driver';
  id: string;
  title: string;
  reason: string;
  /** Categoría para el escudo o el color. */
  seriesId: string;
  /** Categorías del piloto (para seguirlo sin descargar el índice). */
  seriesIds: string[];
}

export interface StarterInput {
  /** Categorías publicadas (solo se usan las habilitadas). */
  series: Series[];
  /** Tablas de campeonato ya descargadas, por categoría. */
  standings: Record<string, StandingsFile | undefined>;
  /** Índice de pilotos, si ya se descargó (para confirmar ids, nombres y categorías). */
  drivers?: Map<string, Driver> | null;
  /** Categorías que corren este finde (se avisa en el motivo). */
  racingThisWeekend?: Iterable<string>;
}

/** "Agustín CANAPINO" -> "Agustín Canapino" (las tablas suelen traer el apellido en mayúsculas). */
export function displayName(raw: string): string {
  return raw
    .trim()
    .split(/\s+/)
    .map((w) => (w.length > 1 && w === w.toUpperCase() && /[A-ZÀ-Ý]/.test(w) ? w[0] + w.slice(1).toLowerCase() : w))
    .join(' ');
}

/** Líder (P1) de la primera tabla de pilotos de un campeonato. */
export function standingsLeader(file: StandingsFile | undefined): { id: string; name: string } | null {
  const table = file?.tables.find((t) => isDriverTable(t.title) && t.rows.length);
  const row = table?.rows.find((r) => r.pos === 1);
  if (!row || !isSingleDriverName(row.name)) return null;
  const id = driverId(row.name);
  return id ? { id, name: displayName(row.name) } : null;
}

/** Cantidad de cosas seguidas (categorías, pilotos y equipos). */
export function followCount(s: { followedSeries: unknown[]; followedDrivers: unknown[]; followedTeams: unknown[] }): number {
  return s.followedSeries.length + s.followedDrivers.length + s.followedTeams.length;
}

export function starterPack(input: StarterInput): StarterItem[] {
  const byId = new Map(input.series.filter((s) => s.enabled).map((s) => [s.id, s]));
  const racing = new Set(input.racingThisWeekend ?? []);
  const short = (id: string) => byId.get(id)?.shortName ?? id;
  const out: StarterItem[] = [];

  for (const { ids, reason } of STARTER_SERIES) {
    const s = ids.map((id) => byId.get(id)).find(Boolean);
    if (!s) continue;
    out.push({
      kind: 'series',
      id: s.id,
      title: s.name,
      reason: racing.has(s.id) ? `${reason} · corre este finde` : reason,
      seriesId: s.id,
      seriesIds: [s.id],
    });
  }

  // Líderes actuales, para describir a los pilotos fijos que además van primeros.
  const leaders = STARTER_LEADERS.filter((id) => byId.has(id))
    .map((seriesId) => ({ seriesId, leader: standingsLeader(input.standings[seriesId]) }))
    .filter((l): l is { seriesId: string; leader: { id: string; name: string } } => !!l.leader);
  const leads = (id: string) => leaders.find((l) => l.leader.id === id);

  const seen = new Set<string>();
  const addDriver = (id: string, fallbackName: string, reason: string, seriesId: string) => {
    if (seen.has(id)) return;
    const d = input.drivers?.get(id);
    // Con el índice cargado, solo se sugieren pilotos que figuran.
    if (input.drivers && !d) return;
    seen.add(id);
    const seriesIds = d ? driverSeriesIds(d) : [seriesId];
    out.push({ kind: 'driver', id, title: d?.name ?? fallbackName, reason, seriesId, seriesIds });
  };

  for (const fixed of STARTER_DRIVERS) {
    const id = driverId(fixed.name);
    const lead = leads(id);
    const d = input.drivers?.get(id);
    // Categoría principal del piloto: la más importante en la que figura (si cambió, el motivo la nombra).
    const main = (d && [...driverSeriesIds(d)].sort((a, b) => rank(a) - rank(b))[0]) || fixed.seriesId;
    const reason = lead ? `Líder del ${short(lead.seriesId)}` : main === fixed.seriesId ? fixed.reason : `Argentino en ${short(main)}`;
    addDriver(id, fixed.name, reason, lead?.seriesId ?? main);
  }
  for (const { seriesId, leader } of leaders) addDriver(leader.id, leader.name, `Líder del ${short(seriesId)}`, seriesId);

  return out;
}

const rank = (id: string) => {
  const i = MAJOR_SERIES.indexOf(id);
  return i < 0 ? 99 : i;
};
