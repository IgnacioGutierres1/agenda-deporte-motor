/**
 * Temporadas: URL con el año de la temporada y lectura de la temporada siguiente.
 *
 * - En config/series.default.json una URL oficial puede llevar `{season}` (p. ej.
 *   https://www.fiawec.com/en/season/{season}); se reemplaza al leer la serie por la temporada que se está leyendo.
 *   Las URL sin `{season}` quedan tal cual (compatibilidad con la config de siempre y con las series del usuario).
 * - Cuando la temporada en curso de una serie ya terminó (ningún evento por delante), además se lee la siguiente
 *   (si el sitio oficial ya la publica) y se publican sus eventos junto a los de la temporada terminada. Los ids
 *   de los eventos llevan la temporada del evento (ver builders.ts), así que el 1 de enero, cuando esa temporada
 *   pasa a ser la "en curso", los eventos conservan su id (y sus sesiones, avisos y resultados).
 */
import type { MotorEvent, Series } from '@dm/shared';
import type { Adapter, AdapterContext, ScheduleChunk } from './types.ts';

/** Marcador de temporada en las URL de la config. */
export const SEASON_TOKEN = '{season}';

/** URL con `{season}` reemplazado por el año de la temporada. */
export function seasonUrl(url: string, season: number): string {
  return url.split(SEASON_TOKEN).join(String(season));
}

/** true si la URL lleva el marcador de temporada. */
export function hasSeasonToken(url: string): boolean {
  return url.includes(SEASON_TOKEN);
}

/** Serie con sus URL (oficiales y de inscriptos) resueltas para la temporada. Sin marcadores, devuelve la misma. */
export function seriesForSeason(series: Series, season: number): Series {
  const urls = [...series.officialUrls, ...(series.rosterUrls ?? [])];
  if (!urls.some(hasSeasonToken)) return series;
  return {
    ...series,
    officialUrls: series.officialUrls.map((u) => seasonUrl(u, season)),
    ...(series.rosterUrls ? { rosterUrls: series.rosterUrls.map((u) => seasonUrl(u, season)) } : {}),
  };
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** true si la temporada leída ya terminó: tiene eventos y ninguno termina hoy o después. */
export function seasonOver(events: Pick<MotorEvent, 'dateEnd'>[], today: string): boolean {
  return events.length > 0 && events.every((e) => e.dateEnd < today);
}

/**
 * Se queda con lo de la temporada siguiente que es de verdad nuevo y futuro:
 * - descarta eventos que ya estaban en la temporada en curso (mismo id), que ya pasaron o que empiezan antes de
 *   que termine la temporada en curso;
 * - si la mayoría de los eventos repiten día y mes de un evento de la temporada en curso, el sitio no tiene la
 *   temporada siguiente y el lector le puso el año pedido al calendario actual (fechas sin año): se descarta todo.
 *   (Una carrera de fin de semana no cae los mismos días dos años seguidos: el día de la semana se corre.)
 * Devuelve lo aceptado y, si se descartó todo por lo anterior, el motivo.
 */
export function acceptNextSeason(
  current: ScheduleChunk,
  next: ScheduleChunk,
  today: string,
): { chunk: ScheduleChunk; rejected?: string } {
  const ids = new Set(current.events.map((e) => e.id));
  const lastEnd = current.events.reduce((max, e) => (e.dateEnd > max ? e.dateEnd : max), '');
  const fresh = next.events.filter((e) => !ids.has(e.id) && e.dateEnd >= today && e.dateStart > lastEnd);
  const monthDays = new Set(current.events.map((e) => `${e.dateStart.slice(5)}|${e.dateEnd.slice(5)}`));
  const copies = fresh.filter((e) => monthDays.has(`${e.dateStart.slice(5)}|${e.dateEnd.slice(5)}`)).length;
  if (fresh.length > 0 && copies * 2 >= fresh.length) {
    return {
      chunk: { events: [], sessions: [] },
      rejected: `${copies} de ${fresh.length} fechas repiten día y mes de la temporada terminada (el sitio todavía muestra ese calendario)`,
    };
  }
  const keep = new Set(fresh.map((e) => e.id));
  return { chunk: { events: fresh, sessions: next.sessions.filter((s) => keep.has(s.eventId)) } };
}

/**
 * Lee el calendario de la serie y, si su temporada ya terminó, también el de la siguiente (ctx.season + 1, con
 * ctx.nextSeason = true). Si la siguiente todavía no está publicada (error, 404, calendario vacío) no pasa nada:
 * quedan solo los eventos de la temporada terminada. Los errores de la temporada en curso se propagan igual que
 * antes. Los lectores que ignoran ctx.season no se ven afectados: lo que devuelvan de más se descarta en
 * acceptNextSeason.
 */
export async function scheduleWithNextSeason(adapter: Adapter, series: Series, ctx: AdapterContext): Promise<ScheduleChunk> {
  const current = await adapter.schedule(series, ctx);
  const today = isoDay(ctx.now);
  if (!seasonOver(current.events, today)) return current;

  const season = ctx.season + 1;
  let next: ScheduleChunk;
  try {
    next = await adapter.schedule(series, { ...ctx, season, nextSeason: true });
  } catch (err) {
    ctx.log.info(`Temporada ${season}: todavía sin calendario oficial (${err instanceof Error ? err.message : String(err)})`);
    return current;
  }
  const { chunk, rejected } = acceptNextSeason(current, next, today);
  if (rejected) ctx.log.warn(`Temporada ${season} descartada: ${rejected}`);
  else if (chunk.events.length === 0) ctx.log.info(`Temporada ${season}: todavía sin fechas publicadas`);
  else {
    const first = chunk.events.reduce((a, b) => (b.dateStart < a.dateStart ? b : a));
    ctx.log.info(`Temporada ${season}: ${chunk.events.length} eventos (desde el ${first.dateStart}); la ${ctx.season} ya terminó`);
  }
  return { events: [...current.events, ...chunk.events], sessions: [...current.sessions, ...chunk.sessions] };
}
