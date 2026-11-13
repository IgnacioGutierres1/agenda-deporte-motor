/**
 * Generador de .ics según las reglas del gem (RFC 5545):
 * - Cada línea termina en CRLF. Las líneas largas se pliegan (CRLF + espacio) a 75 octetos.
 * - Horas siempre en UTC con sufijo "Z". Sin VTIMEZONE ni parámetros TZID.
 * - UID: {hash}@agendadeportemotor.local
 * - SUMMARY: "Categoría (Circuito) - Sesión"
 *
 * Eventos sin cronograma todavía (solo se conocen las fechas): un evento de día completo con
 * DTSTART;VALUE=DATE / DTEND;VALUE=DATE (fin exclusivo, RFC 5545 §3.6.1), con el mismo formato de SUMMARY y
 * "(horarios a confirmar)". Son los únicos valores sin hora en UTC: una fecha no tiene zona horaria.
 *
 * Descripción: "Transmisión: X, Y" y "Fuente: URL" (formato del gem) y, al final, "Dónde verlo:" con un renglón
 * "Canal: URL" por cada canal que tiene sitio o canal oficial verificado (shared/src/broadcast.ts).
 */
import { broadcastLinkLines } from './broadcast.ts';

export const ICS_FILENAME = 'carreras_finde.ics';
const CRLF = '\r\n';

export interface IcsEventInput {
  /** Id estable de la sesión (se usa como parte del UID). */
  id: string;
  startUtc: string;
  endUtc: string;
  seriesName: string;
  circuit: string;
  sessionName: string;
  country: string;
  broadcast: string[];
  /** true si la transmisión es la habitual de la categoría (config) y no la que publica la fuente. */
  broadcastIsDefault?: boolean;
  sourceUrl?: string;
  /** true si el horario se leyó de una imagen oficial (se aclara en la descripción). */
  fromImage?: boolean;
}

/** Evento sin horarios publicados: se exporta como evento de día completo. */
export interface IcsAllDayEventInput {
  allDay: true;
  /**
   * Id estable del evento (UID). Cuando aparecen los horarios, el feed deja de emitirlo y los clientes
   * suscriptos lo borran al refrescar.
   */
  id: string;
  /** Fechas locales del circuito, YYYY-MM-DD, ambas inclusive. */
  dateStart: string;
  dateEnd: string;
  seriesName: string;
  circuit: string;
  /** Nombre del evento (ocupa el lugar de la sesión en el SUMMARY). */
  eventName: string;
  country: string;
  broadcast: string[];
  broadcastIsDefault?: boolean;
  sourceUrl?: string;
}

export interface IcsOptions {
  /** Momento de generación (DTSTAMP). Por defecto, ahora. */
  now?: Date;
  calendarName?: string;
}

/** ISO UTC -> "YYYYMMDDTHHMMSSZ" */
export function toIcsUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`Fecha inválida para .ics: ${iso}`);
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

/** "2026-11-13" -> "20261113" (valor DATE). */
export function toIcsDate(isoDate: string): string {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  // "2026-02-30" pasa la expresión pero no es una fecha: Date la corre al 2 de marzo.
  const d = new Date(`${isoDate}T00:00:00Z`);
  if (!m || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== isoDate) {
    throw new Error(`Fecha inválida para .ics: ${isoDate}`);
  }
  return `${m[1]}${m[2]}${m[3]}`;
}

/** Día siguiente a una fecha YYYY-MM-DD (fin exclusivo de un evento de día completo). */
export function nextIsoDate(isoDate: string): string {
  toIcsDate(isoDate);
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Escapa texto según RFC 5545 §3.3.11. */
export function escapeIcsText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Pliega una línea a 75 octetos UTF-8 sin cortar caracteres multibyte. */
export function foldLine(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  const parts: string[] = [];
  let current = '';
  let currentBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const bytes = encoder.encode(ch).length;
    if (currentBytes + bytes > limit) {
      parts.push(current);
      current = '';
      currentBytes = 0;
      limit = 74; // las líneas de continuación empiezan con un espacio
    }
    current += ch;
    currentBytes += bytes;
  }
  parts.push(current);
  return parts.join(`${CRLF} `);
}

export function icsSummary(e: Pick<IcsEventInput, 'seriesName' | 'circuit' | 'sessionName'>): string {
  return `${e.seriesName} (${e.circuit}) - ${e.sessionName}`;
}

/** "Transmisión: X, Y", "Transmisión habitual: X" (la de config, no confirmada por la fuente) o "A confirmar". */
export function icsBroadcastLine(broadcast: string[], isDefault = false): string {
  if (broadcast.length === 0) return 'Transmisión: A confirmar';
  return `${isDefault ? 'Transmisión habitual' : 'Transmisión'}: ${broadcast.join(', ')}`;
}

/**
 * Suma a la descripción los enlaces de los canales con sitio o canal oficial verificado. Van al final, después
 * de "Fuente:", para no tocar los dos primeros renglones (los que fija el gem).
 */
function withBroadcastLinks(description: string, broadcast: string[]): string {
  const lines = broadcastLinkLines(broadcast);
  return lines.length ? `${description}\nDónde verlo:\n${lines.join('\n')}` : description;
}

const isAllDay = (e: IcsEventInput | IcsAllDayEventInput): e is IcsAllDayEventInput => 'allDay' in e && e.allDay === true;

/** Orden: por inicio; un evento de día completo va antes que las sesiones de ese mismo día. */
const sortKey = (e: IcsEventInput | IcsAllDayEventInput) => (isAllDay(e) ? e.dateStart : e.startUtc);

export function buildIcs(events: Array<IcsEventInput | IcsAllDayEventInput>, opts: IcsOptions = {}): string {
  const stamp = toIcsUtc((opts.now ?? new Date()).toISOString());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Agenda Deporte Motor//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(opts.calendarName ?? 'Deporte Motor')}`,
  ];
  const sorted = [...events].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
  for (const e of sorted) {
    if (isAllDay(e)) {
      let description = `Horarios a confirmar: la fuente oficial todavía no publicó el cronograma.\n${icsBroadcastLine(e.broadcast, e.broadcastIsDefault)}`;
      if (e.sourceUrl) description += `\nFuente: ${e.sourceUrl}`;
      description = withBroadcastLinks(description, e.broadcast);
      lines.push(
        'BEGIN:VEVENT',
        `UID:${e.id}@agendadeportemotor.local`,
        `DTSTAMP:${stamp}`,
        `DTSTART;VALUE=DATE:${toIcsDate(e.dateStart)}`,
        `DTEND;VALUE=DATE:${toIcsDate(nextIsoDate(e.dateEnd < e.dateStart ? e.dateStart : e.dateEnd))}`,
        `SUMMARY:${escapeIcsText(icsSummary({ seriesName: e.seriesName, circuit: e.circuit, sessionName: `${e.eventName} (horarios a confirmar)` }))}`,
        `DESCRIPTION:${escapeIcsText(description)}`,
        `LOCATION:${escapeIcsText(`${e.circuit}, ${e.country}`)}`,
        'STATUS:CONFIRMED',
        // Un fin de semana entero no debe figurar como ocupado.
        'TRANSP:TRANSPARENT',
        'END:VEVENT',
      );
      continue;
    }
    let description = icsBroadcastLine(e.broadcast, e.broadcastIsDefault);
    if (e.sourceUrl) description += `\nFuente: ${e.sourceUrl}${e.fromImage ? ' (leído de imagen)' : ''}`;
    description = withBroadcastLinks(description, e.broadcast);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.id}@agendadeportemotor.local`,
      `DTSTAMP:${stamp}`,
      `DTSTART:${toIcsUtc(e.startUtc)}`,
      `DTEND:${toIcsUtc(e.endUtc)}`,
      `SUMMARY:${escapeIcsText(icsSummary(e))}`,
      `DESCRIPTION:${escapeIcsText(description)}`,
      `LOCATION:${escapeIcsText(`${e.circuit}, ${e.country}`)}`,
      'STATUS:CONFIRMED',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join(CRLF) + CRLF;
}
