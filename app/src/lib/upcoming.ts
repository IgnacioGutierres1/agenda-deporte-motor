/**
 * "Próximas carreras" de las fichas de piloto y de equipo: lo que importa es la hora de la CARRERA,
 * no la de la primera práctica. Helpers puros (sin Vue) para poder probarlos.
 */
import { DateTime } from 'luxon';
import type { Session } from '@dm/shared';

/**
 * Carrera principal de un evento: la última sesión de tipo "carrera" (en los findes con dos carreras, la final;
 * la "Feature Race" de F2/F3). Si el evento no tiene ninguna, la última "sprint". Si tampoco, undefined.
 * Un rally (sesiones de tipo "etapa") no tiene carrera principal: la Power Stage es su último tramo, y lo que
 * importa es cuándo larga cada día.
 */
export function mainRaceOf(sessions: Session[]): Session | undefined {
  if (sessions.some((s) => s.type === 'etapa')) return undefined;
  const byStart = [...sessions].sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  const last = (type: Session['type']) => byStart.filter((s) => s.type === type).at(-1);
  return last('carrera') ?? last('sprint');
}

/** Nombre corto de una sesión para el renglón: "Práctica Libre 1" / "Free Practice 1" → "P1", "Clasificación Q2" → "Q2". */
export function shortSessionName(s: Pick<Session, 'type' | 'name'>): string {
  const name = s.name.trim();
  if (s.type === 'practica') {
    const n = name.match(/(\d+)\s*$/);
    if (n && !/^day\b/i.test(name)) return `P${n[1]}`;
  }
  if (s.type === 'clasificacion') {
    const q = name.match(/\b(Q\d)\b/i);
    if (q) return q[1]!.toUpperCase();
  }
  return name;
}

export interface UpcomingWhen {
  text: string;
  live: boolean;
}

/**
 * Texto del renglón de un evento próximo:
 * - "Carrera dom 22/11 01:00 · P1 jue 21:30" (la carrera primero; después la próxima sesión, si es otra y es antes);
 * - "En vivo: Clasificación · Carrera dom 22/11 01:00" mientras corre otra sesión del finde;
 * - si el evento no tiene carrera (test, sin cronograma de carrera) o ya se corrió, la próxima sesión como antes.
 * Devuelve null si no queda ninguna sesión por terminar (el que llama muestra la fecha "a confirmar").
 */
export function upcomingWhen(sessions: Session[], now: string, zone: string): UpcomingWhen | null {
  const pending = sessions.filter((s) => s.endUtc > now).sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  const next = pending[0];
  if (!next) return null;
  const live = next.startUtc <= now;
  const at = (iso: string, fmt: string) => DateTime.fromISO(iso, { zone: 'utc' }).setZone(zone).setLocale('es-AR').toFormat(fmt);
  const race = mainRaceOf(sessions);
  const raceAhead = race && race.endUtc > now ? race : undefined;

  if (!raceAhead) {
    const text = live ? `En vivo: ${next.name}` : `${next.name} · ${at(next.startUtc, 'ccc d/LL HH:mm')}`;
    return { text, live };
  }
  if (live && next.id === raceAhead.id) return { text: 'En vivo: Carrera', live: true };
  const raceText = `Carrera ${at(raceAhead.startUtc, 'ccc d/LL HH:mm')}`;
  if (live) return { text: `En vivo: ${shortSessionName(next)} · ${raceText}`, live: true };
  if (next.id === raceAhead.id) return { text: raceText, live: false };
  // Si la próxima sesión es otro día de la semana que la carrera, alcanza con el día; si es muy lejos, con la fecha.
  const sameWeek = DateTime.fromISO(raceAhead.startUtc).diff(DateTime.fromISO(next.startUtc), 'days').days < 6;
  return { text: `${raceText} · ${shortSessionName(next)} ${at(next.startUtc, sameWeek ? 'ccc HH:mm' : 'ccc d/LL HH:mm')}`, live: false };
}
