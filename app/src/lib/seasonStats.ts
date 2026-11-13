/**
 * "La temporada en números": mosaicos que muestran las fichas de piloto y de equipo a partir de los números que
 * publica el pipeline (DriverSeasonStats, TeamSeasonStats). Solo va lo que aplica a cada categoría.
 */
import type { DriverSeasonStats, TeamSeasonStats } from '@dm/shared';

/** Números de un piloto o de un equipo en una categoría (los del equipo no traen top 5, top 10 ni promedio). */
export type SeasonNumbers = TeamSeasonStats & Partial<Pick<DriverSeasonStats, 'top5' | 'top10' | 'avgPos'>>;

export interface StatTile {
  key: string;
  label: string;
  value: string;
  /** Aclaración corta debajo del valor ("+ 3 sprints"). */
  sub?: string;
}

const decimal = (n: number) => n.toLocaleString('es-AR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * Mosaicos de una categoría, en orden de lectura. En una categoría con clases (`overall`) solo van carreras,
 * mejor puesto en la general y abandonos: victorias, podios y promedio de la general no dicen nada de la clase.
 * Poles, top 5, top 10, promedio y mejor puesto se omiten si el pipeline no los publicó (no hay dato, que no es
 * lo mismo que cero).
 */
export function statTiles(s: SeasonNumbers): StatTile[] {
  const tiles: StatTile[] = [{ key: 'races', label: 'Carreras', value: String(s.races) }];
  if (s.overall) {
    if (s.bestPos !== undefined) tiles.push({ key: 'best', label: 'Mejor puesto en la general', value: `P${s.bestPos}` });
    tiles.push({ key: 'dnfs', label: 'Abandonos', value: String(s.dnfs) });
    return tiles;
  }
  tiles.push({
    key: 'wins',
    label: 'Victorias',
    value: String(s.wins),
    ...(s.sprintWins ? { sub: `+ ${s.sprintWins} ${s.sprintWins === 1 ? 'sprint' : 'sprints'}` } : {}),
  });
  tiles.push({ key: 'podiums', label: 'Podios', value: String(s.podiums) });
  if (s.poles !== undefined) tiles.push({ key: 'poles', label: 'Poles', value: String(s.poles) });
  if (s.top5 !== undefined) tiles.push({ key: 'top5', label: 'Top 5', value: String(s.top5) });
  if (s.top10 !== undefined) tiles.push({ key: 'top10', label: 'Top 10', value: String(s.top10) });
  if (s.bestPos !== undefined) tiles.push({ key: 'best', label: 'Mejor puesto', value: `P${s.bestPos}` });
  if (s.avgPos !== undefined) tiles.push({ key: 'avg', label: 'Promedio', value: decimal(s.avgPos) });
  tiles.push({ key: 'dnfs', label: 'Abandonos', value: String(s.dnfs) });
  return tiles;
}

/** "20 carreras con resultado": sobre qué se calculó (puede no ser toda la temporada). */
export function coverageText(races: number): string {
  return `${races} ${races === 1 ? 'carrera' : 'carreras'} con resultado`;
}
