/**
 * Ubicación de documentos oficiales: calendario por JSON-LD, sesiones por JSON-LD (subEvent),
 * cronograma (PDF/página del evento/nota de prensa) y resultados/campeonato.
 */
import { toUtcIso } from '@dm/shared';
import type { FetchedDocument } from '../extract/document.ts';
import { extractLinks, parseJsonLd, type Link } from '../extract/html.ts';
import { normalizeForMatch } from '../validate.ts';
import { countryName, dateInZone, guessTimeZone } from './places.ts';
import type { CalendarEntry, ExtractedSession } from './types.ts';

const isEventType = (o: Record<string, unknown>) => {
  const t = o['@type'];
  const types = Array.isArray(t) ? t.map(String) : [String(t ?? '')];
  return types.some((x) => /Event$/.test(x));
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function locationOf(o: Record<string, unknown>): { name: string; country: string; city: string } {
  const loc = (Array.isArray(o.location) ? o.location[0] : o.location) as Record<string, unknown> | string | undefined;
  if (!loc) return { name: '', country: '', city: '' };
  if (typeof loc === 'string') return { name: loc, country: '', city: '' };
  const addr = loc.address as Record<string, unknown> | string | undefined;
  if (typeof addr === 'string') {
    const parts = addr.split(',').map((p) => p.trim());
    return { name: str(loc.name), city: parts[0] ?? '', country: parts.at(-1) ?? '' };
  }
  const country = addr?.addressCountry;
  return {
    name: str(loc.name),
    city: str(addr?.addressLocality),
    country: typeof country === 'string' ? country : str((country as Record<string, unknown> | undefined)?.name),
  };
}

/** Eventos de la temporada publicados como JSON-LD (Event/SportsEvent) en la página del calendario. */
export function jsonLdCalendar(doc: FetchedDocument, season: number): CalendarEntry[] {
  if (doc.kind !== 'html') return [];
  const out: CalendarEntry[] = [];
  for (const o of parseJsonLd(doc.raw)) {
    if (!isEventType(o)) continue;
    const start = str(o.startDate);
    if (!start.startsWith(String(season))) continue;
    const loc = locationOf(o);
    const tz = guessTimeZone(loc.country, `${loc.city} ${loc.name}`) ?? 'UTC';
    const hasTime = start.length > 10;
    const end = str(o.endDate) || start;
    out.push({
      name: str(o.name),
      circuit: loc.name || loc.city || str(o.name),
      country: countryName(loc.country),
      tz,
      dateStart: hasTime ? dateInZone(start, tz) : start.slice(0, 10),
      dateEnd: end.length > 10 ? dateInZone(end, tz) : end.slice(0, 10),
      ...(str(o.url) ? { url: str(o.url) } : {}),
    });
  }
  return out.filter((e) => e.name && /^\d{4}-\d{2}-\d{2}$/.test(e.dateStart));
}

/** Sesiones publicadas como subEvent de un SportsEvent en la página del evento (WEC, ELMS…). */
export function jsonLdSessions(doc: FetchedDocument): { sessions: ExtractedSession[]; event?: { start: string; end: string } } {
  if (doc.kind !== 'html') return { sessions: [] };
  for (const o of parseJsonLd(doc.raw)) {
    if (!isEventType(o) || !Array.isArray(o.subEvent)) continue;
    const parentName = str(o.name);
    const sessions: ExtractedSession[] = [];
    for (const sub of o.subEvent as Record<string, unknown>[]) {
      const start = str(sub.startDate);
      if (start.length <= 10) continue; // sin hora
      let name = str(sub.name);
      // "Free Practice 1 - 6 Hours of Monza" -> "Free Practice 1" (el sufijo repite el nombre del evento).
      const cut = name.lastIndexOf(' - ');
      if (cut > 0 && normalizeForMatch(parentName).includes(normalizeForMatch(name.slice(cut + 3)))) name = name.slice(0, cut);
      try {
        sessions.push({
          name: name.trim(),
          startUtc: toUtcIso(start),
          ...(str(sub.endDate).length > 10 ? { endUtc: toUtcIso(str(sub.endDate)) } : {}),
          localStartText: start.slice(11, 16),
        });
      } catch {
        /* fecha ilegible */
      }
    }
    const start = str(o.startDate);
    const end = str(o.endDate);
    return { sessions, ...(start && end ? { event: { start, end } } : {}) };
  }
  return { sessions: [] };
}

export const TIMETABLE_RE = /time\s*-?table|schedule|cronograma|horarios|programa(ción)?|zeitplan|timing|weekend\s*sched|horaires|orario/i;
export const RESULTS_RE = /result|resultado|clasificaci|classification|classifica|ergebnis|tiempos|standings|final classification/i;
export const STANDINGS_RE = /standing|campeonato|posiciones|championship|ranking|punkte|point|tabla/i;

const isPdf = (url: string) => /\.pdf(\?|#|$)/i.test(url);

/** Links al cronograma dentro de la página del evento, primero los PDF. */
export function timetableLinks(doc: FetchedDocument): Link[] {
  if (doc.kind !== 'html') return [];
  const links = extractLinks(doc.raw, doc.url).filter(
    (l) => TIMETABLE_RE.test(l.text) || TIMETABLE_RE.test(decodeURIComponent(l.url.split('/').pop() ?? '')),
  );
  // Se descartan links de navegación general (p. ej. "Schedule" del menú, que vuelve al calendario).
  const filtered = links.filter((l) => isPdf(l.url) || !/\/(schedule|calendar|calendario)\/?(\?.*)?$/i.test(l.url));
  return filtered.sort((a, b) => Number(isPdf(b.url)) - Number(isPdf(a.url)));
}

/** La página tiene pinta de cronograma: varias horas y alguna palabra de sesión. */
export function looksLikeTimetable(text: string): boolean {
  const times = text.match(/(^|[^0-9])\d{1,2}[:.h]\d{2}(?![0-9])/g) ?? [];
  return times.length >= 4 && /practi|qualif|race|carrera|entrenamiento|clasificaci|final|training|rennen|session/i.test(text);
}

/** Palabras significativas de un evento para reconocerlo en títulos de notas ("Río Cuarto", "Rafaela"). */
export function eventTokens(entry: Pick<CalendarEntry, 'name' | 'circuit'>): string[] {
  const stop = new Set(['fecha', 'autodromo', 'circuito', 'circuit', 'ciudad', 'gran', 'premio', 'grand', 'prix', 'round', 'race', 'hours', 'parque', 'international', 'raceway', 'speedway', 'motorsport', 'park']);
  return [...new Set(normalizeForMatch(`${entry.name} ${entry.circuit}`).split(/[^a-z0-9]+/))].filter(
    (t) => t.length > 3 && !stop.has(t) && !/^\d+$/.test(t),
  );
}

/** Busca en un índice de noticias una nota de cronograma que mencione el evento. */
export function newsTimetableLink(index: FetchedDocument, entry: CalendarEntry): Link | undefined {
  if (index.kind !== 'html') return undefined;
  const tokens = eventTokens(entry);
  return extractLinks(index.raw, index.url).find((l) => {
    const text = normalizeForMatch(`${l.text} ${decodeURIComponent(l.url)}`);
    return /cronograma|horarios|timetable|schedule|zeitplan/.test(text) && tokens.some((t) => text.includes(t));
  });
}

/** Links a resultados en la página del evento (primero PDF de carrera). */
export function resultsLinks(doc: FetchedDocument): Link[] {
  if (doc.kind !== 'html') return [];
  return extractLinks(doc.raw, doc.url)
    .filter((l) => RESULTS_RE.test(l.text) || RESULTS_RE.test(l.url))
    .filter((l) => !STANDINGS_RE.test(l.text))
    .sort((a, b) => score(b) - score(a));
  function score(l: Link): number {
    return Number(isPdf(l.url)) + Number(/race|carrera|final|rennen/i.test(`${l.text} ${l.url}`));
  }
}
