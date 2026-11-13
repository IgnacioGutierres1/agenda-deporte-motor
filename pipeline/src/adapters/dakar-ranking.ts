/**
 * Clasificación general del Rally Dakar (dakar.com). Lectura probada con la edición 2026 y, por decisión de la
 * tanda 4, sin conectar: el lector del Dakar (dakar.ts) no la usa ni se publica en data/. Queda lista (con sus
 * tests) para cuando se defina dónde va una clasificación por tiempos; ver "Qué falta para publicarla".
 *
 * Motos:  GET https://www.dakar.com/es/clasificaciones                    (última etapa disputada)
 * Autos:  GET https://www.dakar.com/es/clasificaciones/etapa-{n}/coche   (misma URL con /moto para motos)
 *         - <h2>Clasificaciones 2026 al final de la etapa 13</h2>: edición y etapa. La edición sale de acá y no de
 *           <meta name="year">, que ya dice 2027 mientras la tabla sigue siendo la de 2026.
 *         - data-current-tab="M" | "A" (motos | autos) y data-current-type="cg" (general) en el contenedor.
 *         - <table class="rankingTable">: posición, dorsal, tripulación con país "(arg)", equipo, tiempo
 *           ("49h 00' 41''"), diferencia y penalización.
 *         Las demás categorías (Challenger, SSV, Stock, camiones, Rally 2…) se cargan por /es/ajax/ranking/…, que
 *         robots.txt excluye (las rutas "ajax" de todos los idiomas): no se leen.
 *
 * Qué falta para publicarla:
 *   - Dónde: StandingsRow es por puntos (points obligatorio) y esta tabla es por tiempos; ResultRow tiene time y
 *     gap, pero va atado a una sesión y el Dakar no tiene sesiones (el sitio no publica horarios de largada).
 *   - Cuándo: core/results.ts relee un campeonato solo después de una carrera terminada o una vez por semana; durante
 *     el Dakar la general cambia todos los días.
 */
import { textOf } from '../extract/html.ts';

export interface DakarRankingRow {
  pos: number;
  number: string;
  /** Piloto y, en autos, navegante, con el país tal como lo publica el sitio ("arg", "qat"). */
  crew: Array<{ name: string; country?: string }>;
  team?: string;
  /** Tiempo acumulado tal como figura en la fuente: "49h 00' 41''". */
  time: string;
  /** Diferencia con el primero: "+ 00h 00' 02''". */
  gap?: string;
  penalty?: string;
}

export interface DakarRanking {
  edition: number;
  /** Etapa hasta la que llega la clasificación (0 = prólogo). */
  afterStage: number;
  /** "M" motos, "A" autos. */
  category: string;
  rows: DakarRankingRow[];
}

const cell = (row: string, re: RegExp): string => textOf(row.match(re)?.[1] ?? '');

/** Clasificación general de la página, o null si todavía no hay ("Clasificación próximamente") o no es la general. */
export function parseDakarRanking(html: string): DakarRanking | null {
  const heading = textOf(html.match(/<h2 class="heading heading--2">([\s\S]*?)<\/h2>/)?.[1] ?? '');
  const title = heading.match(/(\d{4})\D+?etapa\s+(\d+)/i);
  const wrapper = html.match(/data-current-tab="([^"]+)"\s+data-current-type="([^"]+)"/);
  const table = html.match(/<table class="rankingTable js-extend-target"[\s\S]*?<\/table>/)?.[0];
  if (!title || !wrapper || wrapper[2] !== 'cg' || !table) return null;

  const rows: DakarRankingRow[] = [];
  for (const m of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
    const row = m[1]!;
    const pos = Number(cell(row, /<td class="position">([\s\S]*?)<\/td>/));
    const number = cell(row, /<td class="position">[\s\S]*?<\/td>\s*<td>([\s\S]*?)<\/td>/);
    const time = cell(row, /<td[^>]*class="time">([\s\S]*?)(?:<br|<\/td>)/);
    const crew = [...row.matchAll(/<div class="name[^"]*"[^>]*>([\s\S]*?)<\/div>/g)]
      .map((n) => {
        const name = cell(n[1]!, /<a\b[^>]*>([\s\S]*?)<\/a>/);
        const country = n[1]!.match(/class="flag[^"]*">\s*\(([a-z]{2,3})\)/i)?.[1]?.toLowerCase();
        return { name, ...(country ? { country } : {}) };
      })
      .filter((c) => c.name);
    if (!Number.isInteger(pos) || pos <= 0 || !number || !time || crew.length === 0) continue;
    const team = cell(row, /<td class="hidden--xs">([\s\S]*?)<\/td>/);
    const gap = cell(row, /<td[^>]*class="[^"]*time--relative">([\s\S]*?)<\/td>/);
    const penalty = cell(row, /<td[^>]*class="[^"]*time--penality">([\s\S]*?)<\/td>/);
    rows.push({ pos, number, crew, ...(team ? { team } : {}), time, ...(gap ? { gap } : {}), ...(penalty ? { penalty } : {}) });
  }
  if (rows.length === 0) return null;
  return { edition: Number(title[1]), afterStage: Number(title[2]), category: wrapper[1]!, rows };
}
