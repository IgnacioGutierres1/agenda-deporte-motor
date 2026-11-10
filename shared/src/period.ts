import { DateTime } from 'luxon';
import { AR_TZ } from './time.ts';

export type PeriodPreset =
  | 'este-finde'
  | 'proximos-2-findes'
  | 'proximos-4-findes'
  | 'proximo-mes'
  | 'personalizado';

export const PERIOD_LABELS: Record<PeriodPreset, string> = {
  'este-finde': 'Este finde',
  'proximos-2-findes': 'Próximos 2 findes',
  'proximos-4-findes': 'Próximos 4 findes',
  'proximo-mes': 'Próximo mes',
  personalizado: 'Personalizado',
};

export interface Period {
  /** Inicio inclusivo, ISO UTC. */
  startUtc: string;
  /** Fin exclusivo, ISO UTC. */
  endUtc: string;
}

export interface PeriodOptions {
  zone?: string;
  /** Incluir el jueves en el fin de semana (algunas categorías entrenan el jueves). */
  includeThursday?: boolean;
  /** Para "personalizado": fechas locales YYYY-MM-DD (ambas inclusivas). */
  from?: string;
  to?: string;
}

/**
 * Calcula el rango de un período relativo a `now`.
 * Fin de semana = viernes 00:00 a lunes 00:00 (o jueves si includeThursday).
 * Si `now` cae dentro de un fin de semana, "este finde" es el fin de semana en curso.
 */
export function resolvePeriod(
  preset: PeriodPreset,
  now: Date | string = new Date(),
  opts: PeriodOptions = {},
): Period {
  const zone = opts.zone ?? AR_TZ;
  const current =
    typeof now === 'string'
      ? DateTime.fromISO(now, { zone: 'utc' }).setZone(zone)
      : DateTime.fromJSDate(now).setZone(zone);
  const firstDay = opts.includeThursday ? 4 : 5; // luxon: 1 = lunes … 7 = domingo

  const weekendStart = (): DateTime => {
    const today = current.startOf('day');
    const wd = today.weekday;
    if (wd >= firstDay) return today.minus({ days: wd - firstDay });
    return today.plus({ days: firstDay - wd });
  };
  const toPeriod = (a: DateTime, b: DateTime): Period => ({
    startUtc: a.toUTC().toISO({ suppressMilliseconds: true })!,
    endUtc: b.toUTC().toISO({ suppressMilliseconds: true })!,
  });
  const weekends = (n: number): Period => {
    const start = weekendStart();
    const firstMonday = start.plus({ days: 8 - start.weekday }).startOf('day');
    return toPeriod(start, firstMonday.plus({ weeks: n - 1 }));
  };

  switch (preset) {
    case 'este-finde':
      return weekends(1);
    case 'proximos-2-findes':
      return weekends(2);
    case 'proximos-4-findes':
      return weekends(4);
    case 'proximo-mes': {
      const start = current.startOf('day');
      return toPeriod(start, start.plus({ months: 1 }));
    }
    case 'personalizado': {
      if (!opts.from || !opts.to) throw new Error('El período personalizado requiere "from" y "to".');
      const a = DateTime.fromISO(opts.from, { zone }).startOf('day');
      const b = DateTime.fromISO(opts.to, { zone }).startOf('day').plus({ days: 1 });
      if (!a.isValid || !b.isValid) throw new Error('Fechas inválidas en el período personalizado.');
      if (b <= a) throw new Error('La fecha "hasta" debe ser igual o posterior a "desde".');
      return toPeriod(a, b);
    }
  }
}

/** true si el intervalo [startUtc, endUtc) se superpone con el período. */
export function overlaps(period: Period, startUtc: string, endUtc: string): boolean {
  return startUtc < period.endUtc && endUtc > period.startUtc;
}

/** true si un evento (fechas locales YYYY-MM-DD, inclusivas) cae dentro del período. */
export function eventInPeriod(period: Period, dateStart: string, dateEnd: string, zone: string): boolean {
  const a = DateTime.fromISO(dateStart, { zone }).startOf('day').toUTC().toISO()!;
  const b = DateTime.fromISO(dateEnd, { zone }).startOf('day').plus({ days: 1 }).toUTC().toISO()!;
  return overlaps(period, a, b);
}
