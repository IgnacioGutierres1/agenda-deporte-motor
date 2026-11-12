/**
 * Plantel de una categoría: la lista oficial de inscriptos (data/rosters/{id}.json) agrupada por
 * equipo y auto, o, si todavía no hay lista, lo que se puede sacar de las tablas del campeonato.
 * Lógica pura, sin Vue ni Pinia.
 */
import {
  driverDisplayName,
  driverId,
  isDriverTable,
  isSingleDriverName,
  teamId,
  teamKey,
  type RosterRow,
  type StandingsFile,
} from '@dm/shared';

export interface RosterDriver {
  name: string;
  /** Id de la ficha del piloto ('' si el nombre no es de un solo piloto). */
  id: string;
  country?: string;
}

/** Un auto: número, modelo, clase y su tripulación. */
export interface RosterCar {
  key: string;
  number?: string;
  vehicle?: string;
  class?: string;
  drivers: RosterDriver[];
}

export interface RosterTeam {
  key: string;
  /** Nombre del equipo (vacío si la lista no lo publica). */
  name: string;
  teamId: string;
  cars: RosterCar[];
}

/** Clases de la lista, en el orden en que aparecen. */
export function rosterClasses(rows: RosterRow[]): string[] {
  return [...new Set(rows.map((r) => r.class?.trim()).filter((c): c is string => !!c))];
}

/** Agrupa por equipo y, dentro de cada equipo, por número de auto (en el orden de la lista). */
export function groupRoster(rows: RosterRow[], onlyClass = ''): RosterTeam[] {
  const teams = new Map<string, RosterTeam>();
  for (const r of rows) {
    if (onlyClass && r.class?.trim() !== onlyClass) continue;
    const name = r.team?.trim() ?? '';
    const tk = name ? `t:${teamKey(name)}` : r.number ? `n:${r.number}` : `d:${r.driver}`;
    let team = teams.get(tk);
    if (!team) {
      team = { key: tk, name, teamId: name ? teamId(name) : '', cars: [] };
      teams.set(tk, team);
    }
    const ck = r.number ? `#${r.number.trim()}` : `${r.vehicle ?? ''}|${r.class ?? ''}|${team.cars.length}`;
    let car = r.number ? team.cars.find((c) => c.key === ck) : undefined;
    if (!car) {
      car = {
        key: ck,
        ...(r.number ? { number: r.number.trim() } : {}),
        ...(r.vehicle ? { vehicle: r.vehicle } : {}),
        ...(r.class ? { class: r.class.trim() } : {}),
        drivers: [],
      };
      team.cars.push(car);
    }
    car.vehicle ??= r.vehicle;
    const single = isSingleDriverName(r.driver);
    car.drivers.push({
      name: single ? driverDisplayName(r.driver) : r.driver,
      id: single ? driverId(r.driver) : '',
      ...(r.country ? { country: r.country } : {}),
    });
  }
  return [...teams.values()];
}

/**
 * Sin lista de inscriptos: pilotos (con equipo y número) de las tablas de pilotos del campeonato.
 * Si hay varias tablas de pilotos ("Clase 2", "Clase 3"), el título se usa como clase.
 */
export function rosterFromStandings(standings: StandingsFile): { rows: RosterRow[]; teams: string[] } {
  const driverTables = standings.tables.filter((t) => isDriverTable(t.title));
  const multi = driverTables.length > 1;
  const rows: RosterRow[] = [];
  for (const t of driverTables) {
    for (const r of t.rows) {
      rows.push({
        driver: r.name,
        ...(r.team ? { team: r.team } : {}),
        ...(r.number ? { number: r.number } : {}),
        ...(multi ? { class: t.title } : {}),
      });
    }
  }
  // Equipos de las tablas de equipos (no marcas ni propietarios), por si los pilotos no traen equipo.
  const teams = new Set<string>();
  for (const t of standings.tables) {
    if (isDriverTable(t.title) || !/equipo|team|escuder/i.test(t.title)) continue;
    for (const r of t.rows) teams.add(r.name.trim());
  }
  return { rows, teams: [...teams] };
}

/** Bandera para códigos ISO de dos letras ("AR" -> 🇦🇷); '' para el resto. */
export function countryFlag(country: string | undefined): string {
  const c = (country ?? '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(c)) return '';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

/** Nombre del país en castellano para códigos ISO de dos letras ("IT" -> "Italia"); el resto, tal cual. */
export function countryName(country: string | undefined): string {
  const c = (country ?? '').trim();
  if (!/^[A-Za-z]{2}$/.test(c)) return c;
  try {
    return new Intl.DisplayNames(['es'], { type: 'region' }).of(c.toUpperCase()) ?? c;
  } catch {
    return c;
  }
}
