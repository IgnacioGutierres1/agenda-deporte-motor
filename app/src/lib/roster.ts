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

/** Nombres que publican las listas oficiales y que no coinciden con el nombre en inglés de Intl. */
const COUNTRY_ALIASES: Record<string, string> = {
  'great britain': 'GB',
  england: 'GB',
  scotland: 'GB',
  wales: 'GB',
  'united states of america': 'US',
  usa: 'US',
  holland: 'NL',
  'hong kong sar china': 'HK',
  'south korea': 'KR',
  korea: 'KR',
  russia: 'RU',
  'czech republic': 'CZ',
  turkey: 'TR',
  'macao sar china': 'MO',
  macau: 'MO',
};

let englishToCode: Map<string, string> | null = null;

/** Código ISO de dos letras a partir del código o del nombre en inglés ("Germany" -> "DE"); '' si no se reconoce. */
export function countryCode(country: string | undefined): string {
  const c = (country ?? '').trim();
  if (/^[A-Za-z]{2}$/.test(c)) return c.toUpperCase();
  const key = c.toLowerCase();
  if (!key) return '';
  if (COUNTRY_ALIASES[key]) return COUNTRY_ALIASES[key]!;
  if (!englishToCode) {
    englishToCode = new Map();
    try {
      const en = new Intl.DisplayNames(['en'], { type: 'region' });
      for (let a = 65; a <= 90; a++) {
        for (let b = 65; b <= 90; b++) {
          const code = String.fromCharCode(a, b);
          const name = en.of(code);
          // El primero gana: "FR" antes que códigos viejos con el mismo nombre ("FX").
          if (name && name !== code && !englishToCode.has(name.toLowerCase())) englishToCode.set(name.toLowerCase(), code);
        }
      }
    } catch {
      // Sin Intl.DisplayNames: se muestra el país tal como vino.
    }
  }
  return englishToCode.get(key) ?? '';
}

/** Bandera del país ("AR" o "Argentina" -> 🇦🇷); '' si no se reconoce. */
export function countryFlag(country: string | undefined): string {
  const c = countryCode(country);
  if (!c) return '';
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

/** Nombre del país en castellano ("IT" o "Italy" -> "Italia"); si no se reconoce, tal cual. */
export function countryName(country: string | undefined): string {
  const raw = (country ?? '').trim();
  const c = countryCode(raw);
  if (!c) return raw;
  try {
    return new Intl.DisplayNames(['es'], { type: 'region' }).of(c) ?? raw;
  } catch {
    return raw;
  }
}
