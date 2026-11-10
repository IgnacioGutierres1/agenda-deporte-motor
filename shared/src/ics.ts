/**
 * Generador de .ics según las reglas del gem (RFC 5545):
 * - Cada línea termina en CRLF. Las líneas largas se pliegan (CRLF + espacio) a 75 octetos.
 * - Horas siempre en UTC con sufijo "Z". Sin VTIMEZONE ni parámetros TZID.
 * - UID: {hash}@agendadeportemotor.local
 * - SUMMARY: "Categoría (Circuito) - Sesión"
 */

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
  sourceUrl?: string;
  /** true si el horario se leyó de una imagen oficial (se aclara en la descripción). */
  fromImage?: boolean;
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

export function buildIcs(events: IcsEventInput[], opts: IcsOptions = {}): string {
  const stamp = toIcsUtc((opts.now ?? new Date()).toISOString());
  const lines: string[] = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Agenda Deporte Motor//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(opts.calendarName ?? 'Deporte Motor')}`,
  ];
  const sorted = [...events].sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  for (const e of sorted) {
    const broadcast = e.broadcast.length ? e.broadcast.join(', ') : 'A confirmar';
    let description = `Transmisión: ${broadcast}`;
    if (e.sourceUrl) description += `\nFuente: ${e.sourceUrl}${e.fromImage ? ' (leído de imagen)' : ''}`;
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
