import { DateTime } from 'luxon';

export const AR_TZ = 'America/Argentina/Buenos_Aires';

/**
 * Convierte una fecha + hora local de un circuito a ISO UTC.
 * Respeta el horario de verano vigente en el circuito ese día.
 * @param date "YYYY-MM-DD"
 * @param time "HH:mm" (también acepta "H:mm", "HH.mm" y "HHhmm")
 * @param zone zona IANA del circuito
 */
export function localToUtc(date: string, time: string, zone: string): string {
  const normalized = normalizeTime(time);
  const dt = DateTime.fromISO(`${date}T${normalized}`, { zone });
  if (!dt.isValid) {
    throw new Error(`Fecha/hora inválida: ${date} ${time} (${zone}): ${dt.invalidExplanation ?? ''}`);
  }
  return toIsoUtc(dt);
}

/** "9.30" | "9:30" | "09h30" | "0930" -> "09:30" */
export function normalizeTime(time: string): string {
  const m = time.trim().match(/^(\d{1,2})\s*[:.hH]?\s*(\d{2})$/);
  if (!m) throw new Error(`Hora inválida: "${time}"`);
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw new Error(`Hora fuera de rango: "${time}"`);
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

/** Normaliza cualquier ISO con offset a "YYYY-MM-DDTHH:mm:ssZ" en UTC. */
export function toUtcIso(iso: string): string {
  const dt = DateTime.fromISO(iso, { setZone: true });
  if (!dt.isValid) throw new Error(`ISO inválido: ${iso}`);
  return toIsoUtc(dt);
}

function toIsoUtc(dt: DateTime): string {
  return dt.toUTC().toISO({ suppressMilliseconds: true })!;
}

export function addMinutes(isoUtc: string, minutes: number): string {
  return toIsoUtc(DateTime.fromISO(isoUtc, { zone: 'utc' }).plus({ minutes }));
}

/** Hora "HH:mm" de un instante UTC en la zona indicada. */
export function formatTime(isoUtc: string, zone: string = AR_TZ): string {
  return DateTime.fromISO(isoUtc, { zone: 'utc' }).setZone(zone).toFormat('HH:mm');
}

/** Fecha local "YYYY-MM-DD" de un instante UTC en la zona indicada. */
export function localDate(isoUtc: string, zone: string = AR_TZ): string {
  return DateTime.fromISO(isoUtc, { zone: 'utc' }).setZone(zone).toISODate()!;
}

/** "sábado 28 de noviembre" */
export function formatDayLabel(isoDate: string, zone: string = AR_TZ): string {
  return DateTime.fromISO(isoDate, { zone }).setLocale('es-AR').toFormat("cccc d 'de' LLLL");
}

/**
 * Hora local de pared de un instante UTC, en formato ISO sin offset ("YYYY-MM-DDTHH:mm:ss").
 * Es lo que exige la regla del gem para la API de Google Calendar con timeZone de Buenos Aires.
 */
export function toLocalWallIso(isoUtc: string, zone: string = AR_TZ): string {
  return DateTime.fromISO(isoUtc, { zone: 'utc' })
    .setZone(zone)
    .toFormat("yyyy-LL-dd'T'HH:mm:ss");
}

/** Diferencia en minutos entre dos instantes ISO (b - a). */
export function diffMinutes(a: string, b: string): number {
  return Math.round(
    DateTime.fromISO(b, { setZone: true }).diff(DateTime.fromISO(a, { setZone: true }), 'minutes').minutes,
  );
}
