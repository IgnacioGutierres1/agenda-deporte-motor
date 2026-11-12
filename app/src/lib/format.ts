import { DateTime } from 'luxon';
import { AR_TZ, type TimetableCoverage } from '@dm/shared';

/** "Horarios publicados: 1 de 3 próximas fechas" (cobertura de cronogramas del estado de la serie). */
export function timetablesText(t: TimetableCoverage): string {
  return `Horarios publicados: ${t.found} de ${t.due} ${t.due === 1 ? 'próxima fecha' : 'próximas fechas'}`;
}

/** "hace 3 horas", "hace 5 minutos", "recién". */
export function timeAgo(isoUtc: string | null | undefined, now: string | Date = new Date()): string {
  if (!isoUtc) return 'nunca';
  const then = DateTime.fromISO(isoUtc, { zone: 'utc' });
  const ref = typeof now === 'string' ? DateTime.fromISO(now, { zone: 'utc' }) : DateTime.fromJSDate(now);
  if (!then.isValid) return '—';
  const minutes = Math.round(ref.diff(then, 'minutes').minutes);
  const rtf = new Intl.RelativeTimeFormat('es-AR', { numeric: 'auto' });
  // Fechas "en el futuro" solo pueden venir de un reloj desfasado: se muestran como recientes.
  if (minutes < 1) return 'recién';
  if (minutes < 60) return rtf.format(-minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours < 48) return rtf.format(-hours, 'hour');
  return rtf.format(-Math.round(hours / 24), 'day');
}

/** "sáb 28/11 08:00" en la zona indicada. */
export function formatDateTime(isoUtc: string, zone: string = AR_TZ): string {
  return DateTime.fromISO(isoUtc, { zone: 'utc' }).setZone(zone).setLocale('es-AR').toFormat('ccc d/L HH:mm');
}

/** "28/11" o "27–29/11" a partir de fechas locales YYYY-MM-DD. */
export function formatDateRange(dateStart: string, dateEnd: string): string {
  const a = DateTime.fromISO(dateStart);
  const b = DateTime.fromISO(dateEnd);
  if (dateStart === dateEnd) return a.toFormat('d/L');
  if (a.month === b.month) return `${a.toFormat('d')}–${b.toFormat('d/L')}`;
  return `${a.toFormat('d/L')}–${b.toFormat('d/L')}`;
}

/** Etiqueta corta de una zona: "ARG" para Buenos Aires; si no, la ciudad de la zona IANA. */
export function zoneLabel(zone: string): string {
  if (zone === AR_TZ) return 'ARG';
  if (zone === 'UTC' || zone === 'Etc/UTC') return 'UTC';
  const last = zone.split('/').pop() ?? zone;
  return last.replace(/_/g, ' ');
}

/** Nombre de la zona para el encabezado de la Agenda: "Hora Argentina", "Hora de Chile", "Hora de Tokyo"… */
export function zoneDisplayName(zone: string): string {
  if (zone === AR_TZ || zone.startsWith('America/Argentina/')) return 'Hora Argentina';
  if (zone === 'UTC' || zone === 'Etc/UTC') return 'Hora UTC';
  const option = ZONE_OPTIONS.find((o) => o.value === zone);
  return `Hora de ${option ? option.label : zoneLabel(zone)}`;
}

/** Zonas ofrecidas en Ajustes (además de la del dispositivo). */
export const ZONE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: AR_TZ, label: 'Argentina (Buenos Aires)' },
  { value: 'America/Montevideo', label: 'Uruguay' },
  { value: 'America/Santiago', label: 'Chile' },
  { value: 'America/Sao_Paulo', label: 'Brasil (São Paulo)' },
  { value: 'America/Mexico_City', label: 'México' },
  { value: 'America/New_York', label: 'EE.UU. (Este)' },
  { value: 'Europe/Madrid', label: 'España' },
  { value: 'UTC', label: 'UTC' },
];

export function deviceZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || AR_TZ;
  } catch {
    return AR_TZ;
  }
}
