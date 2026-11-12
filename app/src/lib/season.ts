/**
 * Temporada de las tablas de campeonato que muestra la ficha de un piloto, sin descargar las tablas:
 * el año de generación de los datos no sirve (en enero la tabla de IMSA sigue siendo la del año anterior).
 */
import type { ScheduleFile } from '@dm/shared';
import { pastEventsOf } from './agenda.ts';

/**
 * Temporada de la tabla de una categoría: la del archivo de campeonato si ya está en memoria; si no, el año de la
 * última fecha ya disputada de la categoría (la tabla es la de esa temporada). Sin ninguna de las dos, null.
 */
export function standingsSeason(
  schedule: ScheduleFile | null,
  seriesId: string,
  now: string,
  loadedSeason?: number,
): number | null {
  if (loadedSeason) return loadedSeason;
  const last = pastEventsOf(schedule, seriesId, now)[0];
  return last ? Number(last.dateStart.slice(0, 4)) : null;
}

/** Año para el título "Campeonato 2026": solo si todas las tablas son de la misma temporada conocida. */
export function commonSeason(seasons: Array<number | null>): number | null {
  const set = new Set(seasons);
  if (set.size !== 1) return null;
  return [...set][0] ?? null;
}
