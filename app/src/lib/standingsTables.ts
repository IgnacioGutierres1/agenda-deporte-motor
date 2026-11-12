/**
 * Categorías con muchas tablas de campeonato (24H Series: 24; GTWC Europe, Super GT, Super Taikyu,
 * Turismo Pista): en lugar de apilarlas todas, la pestaña Tabla muestra una por vez y pastillas para
 * elegirla, en hasta tres filas: tipo (Pilotos / Equipos), campeonato ("Europa", "Middle East Trophy")
 * y clase ("GT3", "ST-X", "Clase 1"). Cada fila aparece solo si tiene más de una opción, y las
 * opciones de una fila dependen de lo elegido en las anteriores. Lógica pura, sin Vue.
 */
import { isDriverTable } from '@dm/shared';

export interface TableFacet {
  /** "Pilotos", "Equipos", "Marcas"… ('' si el título no lo dice). */
  kind: string;
  /** Campeonato entre paréntesis ("Europa"). */
  group: string;
  /** Clase o copa ("GT3", "ST-X", "Endurance Cup", "Clase 1"). */
  cls: string;
}

const KIND_RE = /^(pilotos?|equipos?|constructores|marcas|propietarios|fabricantes|drivers|teams|manufacturers)\b\s*/i;

export function tableFacet(title: string): TableFacet {
  let rest = title.trim();
  let kind = '';
  const k = rest.match(KIND_RE);
  if (k) {
    kind = k[1]![0]!.toUpperCase() + k[1]!.slice(1).toLowerCase();
    rest = rest.slice(k[0].length);
  }
  let group = '';
  const g = rest.match(/\(([^)]+)\)\s*$/);
  if (g) {
    group = g[1]!.trim();
    rest = rest.slice(0, g.index).trim();
  }
  // "Clase ST-X" -> "ST-X"; "Clase 1" queda igual (un número solo no se entiende).
  const cls = /^clase\s+\S*\D/i.test(rest) ? rest.replace(/^clase\s+/i, '') : rest;
  return { kind, group, cls: cls.trim() };
}

/** A partir de cuántas tablas se elige una por vez aunque no haya clases. */
export const MANY_TABLES = 4;

/**
 * Se muestran pastillas si hay más de MANY_TABLES tablas, o 3 o más con clases o campeonatos
 * distintos (Turismo Pista, GTWC America). Pilotos / Equipos / Marcas solos se siguen apilando.
 */
export function useTableChips(titles: string[]): boolean {
  if (titles.length > MANY_TABLES) return true;
  if (titles.length < 3) return false;
  const facets = titles.map(tableFacet);
  return new Set(facets.map((f) => f.group)).size > 1 || new Set(facets.map((f) => f.cls)).size > 1;
}

/** Tabla que se muestra primero: la del link (?tabla=…) o la primera de pilotos. */
export function initialTableIndex(titles: string[], wanted?: string | null): number {
  if (wanted) {
    const i = titles.indexOf(wanted);
    if (i >= 0) return i;
  }
  const first = titles.findIndex((t) => isDriverTable(t));
  return first >= 0 ? first : 0;
}

export type FacetKey = keyof TableFacet;

export interface ChipOption {
  label: string;
  /** Tabla que se abre al tocarla. */
  index: number;
  active: boolean;
}

export interface ChipRow {
  key: FacetKey;
  label: string;
  options: ChipOption[];
}

const ROW_LABELS: Record<FacetKey, string> = { kind: 'Tipo', group: 'Campeonato', cls: 'Clase' };
const KEYS: FacetKey[] = ['kind', 'group', 'cls'];

/** Filas de pastillas para la tabla elegida. */
export function tableChipRows(titles: string[], selected: number): ChipRow[] {
  const facets = titles.map(tableFacet);
  const current = facets[selected] ?? facets[0];
  if (!current) return [];
  const rows: ChipRow[] = [];
  KEYS.forEach((key, level) => {
    // Opciones compatibles con lo elegido en las filas anteriores.
    const parents = KEYS.slice(0, level);
    const pool = facets.map((f, i) => ({ f, i })).filter(({ f }) => parents.every((p) => f[p] === current[p]));
    let values = [...new Set(pool.map(({ f }) => f[key]))];
    if (values.length < 2) return;
    // Pilotos antes que equipos y marcas.
    if (key === 'kind') values = [...values.filter((v) => isDriverTable(v || 'Pilotos')), ...values.filter((v) => !isDriverTable(v || 'Pilotos'))];
    const options = values.map((value) => {
      const candidates = pool.filter(({ f }) => f[key] === value);
      // Al cambiar una fila se conserva lo posible de las siguientes (de GT3 Europa a GT3 Middle East).
      const score = (f: TableFacet) => KEYS.slice(level + 1).reduce((n, k, j) => n + (f[k] === current[k] ? 2 ** (KEYS.length - j) : 0), 0);
      const best = candidates.reduce((a, b) => (score(b.f) > score(a.f) ? b : a));
      return { label: value || 'General', index: best.i, active: value === current[key] };
    });
    rows.push({ key, label: ROW_LABELS[key], options });
  });
  return rows;
}
