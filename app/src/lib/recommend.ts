/**
 * "Te puede interesar": recomendaciones locales, deterministas y explicables a partir de lo que
 * sigue el usuario (nada sale del dispositivo). Cada regla agrega a lo sumo unas pocas sugerencias
 * con su motivo ("Porque seguís WEC"):
 *  1. Equipo y compañeros de los pilotos seguidos, y pilotos de los equipos seguidos.
 *  2. Líderes del campeonato de las categorías seguidas.
 *  3. Categorías del mismo grupo que las seguidas (las principales y argentinas primero, después
 *     las que corren antes).
 *  4. Categorías que corren este finde (también las principales y argentinas primero: si corre el TC,
 *     va antes que Asian Le Mans o Super Taikyu).
 *  5. Circuitos de la próxima fecha de una categoría seguida donde también corre otra.
 * Lógica pura, sin Vue ni Pinia.
 */
import { eventInPeriod, isDriverTable, resolvePeriod, type Driver, type MotorEvent, type ScheduleFile, type Series, type Team } from '@dm/shared';
import { circuitId, circuitKey } from './circuits.ts';
import { formatDateRange } from './format.ts';
import { seriesSort } from './grid.ts';
import { todayIn } from './agenda.ts';
import { seriesRelevanceSort, seriesTier, type SearchContext } from './search.ts';

export type RecommendationKind = 'series' | 'driver' | 'team' | 'circuit';

export interface Recommendation {
  kind: RecommendationKind;
  /** Id de la categoría, piloto, equipo o circuito. */
  id: string;
  title: string;
  /** Motivo, en una línea ("Porque seguís WEC"). */
  reason: string;
  to: string;
  /** Categoría para el escudo o el color. */
  seriesId?: string;
}

export interface RecommendInput {
  schedule: ScheduleFile | null;
  now: string;
  zone: string;
  followedSeries: string[];
  followedDrivers: Array<{ id: string; name: string; seriesIds: string[] }>;
  followedTeams?: Array<{ id: string; name: string; seriesIds: string[] }>;
  hiddenSeries?: string[];
  /** Categorías que no hace falta sugerir (ya se ofrecen en otro lado, como "Empezá por acá"). */
  excludeSeries?: string[];
  /** Índice de pilotos, si ya se descargó. */
  drivers?: Driver[];
  /** Equipos (teams.json o derivados de los pilotos), si ya se descargaron. */
  teams?: Team[];
  limit?: number;
}

const CAPS = { team: 3, teamDrivers: 4, perTeam: 2, leader: 2, group: 3, weekend: 3, circuit: 2 };

export function recommend(input: RecommendInput): Recommendation[] {
  const { schedule, now, zone } = input;
  if (!schedule) return [];
  const seriesById = new Map(schedule.series.map((s) => [s.id, s]));
  const hidden = new Set([...(input.hiddenSeries ?? []), ...(input.excludeSeries ?? [])]);
  const followed = new Set(input.followedSeries.filter((id) => seriesById.get(id)?.enabled));
  const followedDrivers = new Set(input.followedDrivers.map((d) => d.id));
  const followedTeams = new Set((input.followedTeams ?? []).map((t) => t.id));
  const short = (id: string) => seriesById.get(id)?.shortName ?? id;
  const today = todayIn(now, zone);
  const candidate = (s: Series | undefined): s is Series => !!s && s.enabled && !hidden.has(s.id) && !followed.has(s.id);

  const out: Recommendation[] = [];
  const seen = new Set<string>();
  const add = (r: Recommendation): boolean => {
    const key = `${r.kind}:${r.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    out.push(r);
    return true;
  };

  // Próximo evento (en curso o futuro) de cada categoría, para ordenar.
  const nextStart = new Map<string, string>();
  for (const e of schedule.events) {
    if (e.dateEnd < today) continue;
    const cur = nextStart.get(e.seriesId);
    if (!cur || e.dateStart < cur) nextStart.set(e.seriesId, e.dateStart);
  }
  const bySoonest = (a: Series, b: Series) =>
    (nextStart.get(a.id) ?? '9999').localeCompare(nextStart.get(b.id) ?? '9999') || seriesSort(a, b);
  // Relevancia para un fan argentino: principales (F1, MotoGP, TC…), argentinas y el resto.
  const ctx: SearchContext = { argentineSeries: schedule.series.filter((s) => s.group === 'argentina').map((s) => s.id) };
  const byRelevance = seriesRelevanceSort(ctx);
  const tierOf = (s: Series) => (seriesTier(s.id, ctx) <= 2 ? 0 : 1);

  // 1. Equipo y compañeros de los pilotos seguidos.
  let n = 0;
  for (const fd of input.followedDrivers) {
    for (const team of input.teams ?? []) {
      const mine = team.drivers.filter((d) => d.id === fd.id);
      if (!mine.length || n >= CAPS.team) continue;
      const first = fd.name.split(' ').slice(-1)[0] ?? fd.name;
      if (!followedTeams.has(team.id) && add({ kind: 'team', id: team.id, title: team.name, reason: `Equipo de ${fd.name}`, to: `/equipo/${team.id}`, seriesId: mine[0]!.seriesId })) n++;
      for (const m of mine) {
        const mate = team.drivers.find((d) => d.seriesId === m.seriesId && d.id !== fd.id && !followedDrivers.has(d.id));
        if (!mate || n >= CAPS.team) continue;
        if (add({ kind: 'driver', id: mate.id, title: mate.name, reason: `Compañero de ${first} en ${short(m.seriesId)}`, to: `/piloto/${mate.id}`, seriesId: m.seriesId })) n++;
      }
    }
  }

  // 1b. Pilotos de los equipos seguidos: primero los mejor ubicados en su campeonato.
  n = 0;
  const bestPos = new Map((input.drivers ?? []).map((d) => [d.id, Math.min(...d.entries.map((e) => e.pos), 9999)]));
  const teamsById = new Map((input.teams ?? []).map((t) => [t.id, t]));
  for (const ft of input.followedTeams ?? []) {
    const team = teamsById.get(ft.id);
    if (!team) continue;
    const candidates = team.drivers
      .filter((d) => !followedDrivers.has(d.id))
      .sort((a, b) => (bestPos.get(a.id) ?? 9999) - (bestPos.get(b.id) ?? 9999));
    let k = 0;
    for (const d of candidates) {
      if (n >= CAPS.teamDrivers || k >= CAPS.perTeam) break;
      if (add({ kind: 'driver', id: d.id, title: d.name, reason: `Porque seguís ${team.name}`, to: `/piloto/${d.id}`, seriesId: d.seriesId })) {
        n++;
        k++;
      }
    }
  }

  // 2. Líderes de las categorías seguidas.
  n = 0;
  for (const seriesId of followed) {
    if (n >= CAPS.leader) break;
    const leader = (input.drivers ?? []).find(
      (d) => !followedDrivers.has(d.id) && d.entries.some((e) => e.seriesId === seriesId && e.pos === 1 && (!e.table || isDriverTable(e.table))),
    );
    if (leader && add({ kind: 'driver', id: leader.id, title: leader.name, reason: `Líder de ${short(seriesId)}`, to: `/piloto/${leader.id}`, seriesId })) n++;
  }

  // 3. Categorías del mismo grupo que las seguidas.
  n = 0;
  for (const id of followed) {
    const s = seriesById.get(id)!;
    if (s.group === 'otros') continue;
    const siblings = schedule.series
      .filter((x) => x.group === s.group && candidate(x))
      .sort((a, b) => tierOf(a) - tierOf(b) || bySoonest(a, b))
      .slice(0, 2);
    for (const x of siblings) {
      if (n >= CAPS.group) break;
      if (add({ kind: 'series', id: x.id, title: x.name, reason: `Porque seguís ${s.shortName}`, to: `/categoria/${x.id}`, seriesId: x.id })) n++;
    }
  }

  // 4. Categorías que corren este finde.
  n = 0;
  const weekend = resolvePeriod('este-finde', now, { zone });
  const racing = new Set(schedule.events.filter((e) => eventInPeriod(weekend, e.dateStart, e.dateEnd, e.tz)).map((e) => e.seriesId));
  for (const s of schedule.series.filter((x) => racing.has(x.id) && candidate(x)).sort(byRelevance)) {
    if (n >= CAPS.weekend) break;
    if (add({ kind: 'series', id: s.id, title: s.name, reason: 'Corre este finde', to: `/categoria/${s.id}`, seriesId: s.id })) n++;
  }

  // 5. Próxima fecha de una categoría seguida en un circuito donde también corre otra.
  n = 0;
  const upcoming = schedule.events.filter((e) => e.dateEnd >= today);
  for (const id of followed) {
    if (n >= CAPS.circuit) break;
    const next = upcoming.filter((e) => e.seriesId === id).sort((a, b) => a.dateStart.localeCompare(b.dateStart))[0];
    const key = next ? circuitKey(next.circuit) : '';
    if (!next || !key) continue;
    const others: MotorEvent[] = upcoming
      .filter((e) => !followed.has(e.seriesId) && candidate(seriesById.get(e.seriesId)) && circuitKey(e.circuit) === key)
      .sort((a, b) => a.dateStart.localeCompare(b.dateStart));
    const other = others[0];
    if (!other) continue;
    const names = [...new Set(others.map((e) => short(e.seriesId)))].slice(0, 2).join(', ');
    const title = `${next.circuit.trim()}: también ${names} (${formatDateRange(other.dateStart, other.dateEnd)})`;
    if (add({ kind: 'circuit', id: circuitId(next.circuit), title, reason: `Próxima fecha de ${short(id)}`, to: `/circuito/${circuitId(next.circuit)}`, seriesId: other.seriesId })) n++;
  }

  return out.slice(0, input.limit ?? 10);
}
