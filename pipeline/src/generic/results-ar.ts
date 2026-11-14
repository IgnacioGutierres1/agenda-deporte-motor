/**
 * Resultados de las categorías argentinas (ACTC, TC2000, TN, Turismo Pista), sin IA: partes comunes.
 *
 * Los sitios publican un documento por tanda ("1ER ENTRENAMIENTO TC", "1º CLASIFICACIÓN C2", "Clasif.1",
 * "Carrera Final") y el cronograma usa otros nombres para las mismas sesiones ("1er. Entrenamiento TC (Grupo A)",
 * "Clasificación - 1a tanda (Clase 2)", "Entrenamiento I (Clase 1, grupo A)"). Para unirlos, cada nombre se reduce a
 * una clave (tipo, número, clase y grupo) y se comparan las claves.
 *
 * Para las fechas ya corridas sin sesiones guardadas (SiteRecipe.pastSessions), las sesiones se arman desde la
 * lista de documentos de resultados: con la hora oficial si la fuente la da (TC2000), si no estimada con la hora
 * de publicación del documento (ACTC) o, a falta de eso, con un orden típico del fin de semana.
 */
import { localToUtc, type ResultRow, type Session, type Source } from '@dm/shared';
import { normalizeForMatch } from '../validate.ts';
import { isoNow } from './kit.ts';
import { shiftDate } from './places.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext } from './types.ts';

// ─── Claves de sesión ─────────────────────────────────────────────────────────────────────────

export type ArKind = 'practica' | 'clasificacion' | 'serie' | 'final' | 'sprint' | 'warmup' | 'shakedown';

export interface ArSessionKey {
  kind: ArKind;
  /** Número de la tanda (1° entrenamiento, 2a serie, clasificación 2…); null si no lo dice. */
  n: number | null;
  /** Clase ("2" en "Clase 2", "C2"); null si la categoría no tiene clases o el nombre no la dice. */
  cls: string | null;
  /** Grupo, tercio o cuarto de una tanda que se corre por partes ("A", "1° cuarto"); null si es la tanda entera. */
  group: string | null;
}

const ORDINAL_WORDS: Record<string, number> = {
  primer: 1, primera: 1, primero: 1, segunda: 2, segundo: 2, tercera: 3, tercer: 3, tercero: 3, cuarta: 4, cuarto: 4,
  quinta: 5, quinto: 5, sexta: 6, sexto: 6,
};
const ROMAN: Record<string, number> = { i: 1, ii: 2, iii: 3, iv: 4, v: 5 };

/**
 * Clave de un nombre de sesión o de documento de resultados. null si no es una sesión con resultado propio
 * (clasificación o entrenamiento "general", grilla, parciales, vuelta por vuelta).
 */
export function arSessionKey(raw: string): ArSessionKey | null {
  let t = normalizeForMatch(raw.replace(/[°º]/g, ' ° ')).replace(/\s+/g, ' ').trim();
  if (/\b(gral|general|gril+a|parciales|vuelta x vuelta|vuelta por vuelta|cuartos clasificatorios|grupos)\b/.test(t)) {
    return null;
  }
  // Clase: "(Clase 2)", "clases 2 y 3", "C2" (sin confundir con "TC2000").
  let cls: string | null = null;
  const c = t.match(/\bclases?\s+(\d)(?:\s*(?:y|-)\s*(\d))?\b/) ?? t.match(/(?:^|\s)c\s?(\d)\b/);
  if (c) {
    cls = c[2] ? `${c[1]}-${c[2]}` : c[1]!;
    t = t.replace(c[0], ' ');
  }
  // Grupo, tercio o cuarto (tandas por partes del mismo entrenamiento o clasificación).
  let group: string | null = null;
  const g =
    t.match(/\bgrupo\s*([a-z])\b/) ??
    t.match(/\b(\d)\s*°?\s*\*?\s*(tercio|cuarto)\b/) ??
    t.match(/\b(primer|segundo|tercer|cuarto)\s+(tercio|cuarto)\b/);
  if (g) {
    group = g[2] ? `${ORDINAL_WORDS[g[1]!] ?? g[1]}° ${g[2]}` : g[1]!.toUpperCase();
    t = t.replace(g[0], ' ');
  }
  let kind: ArKind | null = null;
  let n: number | null = null;
  if (/\bshake\s*down\b/.test(t)) kind = 'shakedown';
  else if (/\bwarm\s*-?\s*up\b/.test(t)) kind = 'warmup';
  else if (/\bclasif|\bqualy|^q\s?\d\b/.test(t)) kind = 'clasificacion';
  else if (/\bseries?\b/.test(t)) kind = 'serie';
  else if (/\bentren|\bpractica|\bprueba libre|^e\s?\d\b/.test(t)) kind = 'practica';
  else if (/\bsprint\b/.test(t)) kind = 'sprint';
  else if (/\bfinal\b|\bcarrera\b/.test(t)) kind = 'final';
  if (!kind) return null;
  if (kind === 'serie' && /\bunica\b/.test(t)) n = 1;
  // "tanda N" numera la clasificación de TN (1a tanda = 1º clasificación).
  const tanda = t.match(/\b(\d)\s*(?:°|a|ra|da|er|era|do|ta)?\s*tanda\b/) ?? t.match(/\btanda\s*(\d)\b/);
  const num =
    tanda ??
    t.match(/^q\s?(\d)\b/) ??
    t.match(/\b(\d)\s*(?:°|a|ra|da|er|era|ro|do|to|ta|nd)?\.?\s+(?:entren|clasif|serie|practica|prueba|carrera)/) ??
    t.match(/\b(?:entrenamientos?|clasificacion|serie|practica(?: oficial| libre)?|clasif\.?|e)\s*(\d)\b/);
  if (num) n = Number(num[1]);
  else {
    const word = t.match(/\b(primer|primera|primero|segunda|segundo|tercera|tercer|tercero|cuarta|quinta|sexta)\s+(?:entren|clasif|serie|practica)/);
    const roman = t.match(/\b(?:entrenamiento|clasificacion|serie|practica)\s+(i{1,3}|iv|v)\b/);
    if (word) n = ORDINAL_WORDS[word[1]!]!;
    else if (roman) n = ROMAN[roman[1]!]!;
  }
  return { kind, n, cls, group };
}

/** Nombre prolijo de una sesión a partir de su clave ("2° Entrenamiento (Clase 3)", "Serie única", "Final"). */
export function arSessionName(key: ArSessionKey, opts: { single?: boolean } = {}): string {
  const base = (() => {
    switch (key.kind) {
      case 'practica':
        return key.n ? `${key.n}° Entrenamiento` : 'Entrenamiento';
      case 'clasificacion':
        return key.n && !opts.single ? `${key.n}° Clasificación` : 'Clasificación';
      case 'serie':
        return opts.single ? 'Serie única' : key.n ? `${key.n}° Serie` : 'Serie';
      case 'final':
        return 'Final';
      case 'sprint':
        return 'Carrera sprint';
      case 'warmup':
        return 'Warm up';
      case 'shakedown':
        return 'Shakedown';
    }
  })();
  const cls = key.cls ? (key.cls.includes('-') ? `Clases ${key.cls.replace('-', ' y ')}` : `Clase ${key.cls}`) : '';
  return cls ? `${base} (${cls})` : base;
}

const sameClass = (a: ArSessionKey, b: ArSessionKey) => a.cls === b.cls || (a.cls?.split('-').includes(b.cls ?? '') ?? false);

/** ¿El documento con clave `doc` es el resultado de la sesión con clave `s`? (sin mirar el grupo) */
function keysMatch(doc: ArSessionKey, s: ArSessionKey, docsOfKind: number, sessionsOfKind: number): boolean {
  if (doc.kind !== s.kind || !sameClass(s, doc)) return false;
  if (doc.n !== null && s.n !== null) return doc.n === s.n;
  // Sin número de un lado: vale si del otro lado es la primera o la única de su tipo.
  if (doc.n === null && s.n === null) return docsOfKind === 1 || sessionsOfKind === 1;
  const n = doc.n ?? s.n;
  return n === 1 || (doc.n === null ? docsOfKind === 1 : sessionsOfKind === 1);
}

/**
 * Une documentos de resultados con las sesiones pedidas. Un documento de una tanda que el cronograma parte en grupos
 * (tercios, cuartos, grupo A/B) trae el resultado combinado: va a la última sesión de esos grupos (la que completa
 * la tanda). Cada sesión recibe a lo sumo un documento. Devuelve pares [sesión, documento].
 */
export function matchArSessions<T extends { key: ArSessionKey; name?: string }>(docs: T[], sessions: Session[]): Array<[Session, T]> {
  const keyed = sessions
    .map((s) => ({ s, key: arSessionKey(s.originalName ?? s.name) }))
    .filter((x): x is { s: Session; key: ArSessionKey } => x.key !== null);
  const used = new Set<string>();
  const out: Array<[Session, T]> = [];
  // Primero, los nombres iguales (las sesiones armadas desde los resultados llevan el nombre del documento).
  const pending: T[] = [];
  for (const doc of docs) {
    const same = doc.name ? sessions.find((s) => !used.has(s.id) && normalizeForMatch(s.originalName ?? s.name) === normalizeForMatch(doc.name!)) : undefined;
    if (same) {
      used.add(same.id);
      out.push([same, doc]);
    } else pending.push(doc);
  }
  for (const doc of pending) {
    const docsOfKind = docs.filter((d) => d.key.kind === doc.key.kind && sameClass(d.key, doc.key)).length;
    const candidates = keyed.filter((x) => {
      if (used.has(x.s.id)) return false;
      const sessionsOfKind = new Set(
        keyed.filter((y) => y.key.kind === x.key.kind && sameClass(y.key, x.key)).map((y) => `${y.key.n}`),
      ).size;
      return keysMatch(doc.key, x.key, docsOfKind, sessionsOfKind);
    });
    if (candidates.length === 0) continue;
    const whole = candidates.find((x) => x.key.group === null);
    const target = whole ?? candidates.sort((a, b) => b.s.startUtc.localeCompare(a.s.startUtc))[0]!;
    used.add(target.s.id);
    out.push([target.s, doc]);
  }
  return out;
}

// ─── Filas ────────────────────────────────────────────────────────────────────────────────────

const TIME_RE = /^\d{1,2}(?::\d{2}){0,2}[.,]\d{1,3}$/;

/** "1:35.589" (o "1.35.589", "95,589") tal como se muestra: con punto decimal. null si no es un tiempo. */
export function lapTime(raw: string): string | null {
  const t = raw.trim().replace(/^\+/, '').replace(/;/g, ':');
  if (/^(\d{1,2})\.(\d{2})\.(\d{3})$/.test(t)) return t.replace(/^(\d{1,2})\.(\d{2})\./, '$1:$2.');
  if (!TIME_RE.test(t)) return null;
  return t.replace(',', '.');
}

/** "1:35.589" -> 95.589 (null si no es un tiempo). */
export function seconds(time: string): number | null {
  const t = lapTime(time);
  if (!t) return null;
  return t.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
}

/** 2.287 -> "2.287"; 61.543 -> "1:01.543". */
export function formatGap(secs: number): string {
  const ms = Math.round(secs * 1000);
  const m = Math.floor(ms / 60000);
  const rest = ((ms % 60000) / 1000).toFixed(3);
  return m > 0 ? `${m}:${rest.padStart(6, '0')}` : rest;
}

/** Datos de una fila tal como los publica la fuente, antes de armar la diferencia. */
export interface RawRow {
  pos: number | null;
  status?: string;
  number?: string;
  driver: string;
  vehicle?: string;
  team?: string;
  laps?: number;
  /** Tiempo total (carreras) o mejor vuelta (entrenamientos y clasificaciones). */
  time?: string;
  /** Diferencia publicada ("2.287", "6 Vueltas", "+0.676"). */
  gap?: string;
  class?: string;
}

/**
 * Filas del resultado: en carreras y series, `time` es el total del ganador y los demás llevan la diferencia
 * ("+2.287", "+6 vueltas"); en entrenamientos y clasificaciones, la mejor vuelta va en `bestLap` y la diferencia
 * con el primero en `gap`. Quien no dio vueltas ni tiene tiempo queda sin puesto, con estado DNS.
 */
export function arRows(raw: RawRow[], race: boolean): ResultRow[] {
  const leader = raw.find((r) => r.pos === 1);
  const leaderLaps = leader?.laps;
  const leaderSecs = leader?.time ? seconds(leader.time) : null;
  return raw.map((r) => {
    const noTime = !r.time && !r.laps && !r.gap;
    const status = r.status ?? (noTime ? 'DNS' : undefined);
    const pos = status && status !== 'NC' ? null : r.pos;
    let gap: string | undefined;
    const g = r.gap?.trim() ?? '';
    const lapsDown = g.match(/^\+?(\d+)\s*(?:vueltas?|vtas?|laps?)\b/i);
    // Con el tiempo propio y el del primero (misma cantidad de vueltas en carrera), la diferencia se calcula: algunas
    // páginas la publican mal ("5:37.000" por 0.337 en TC2000).
    const secs = r.time ? seconds(r.time) : null;
    const computed =
      !lapsDown && secs !== null && leaderSecs !== null && secs > leaderSecs && (!race || (r.laps !== undefined && r.laps === leaderLaps))
        ? formatGap(secs - leaderSecs)
        : null;
    if (lapsDown) gap = `+${lapsDown[1]} ${lapsDown[1] === '1' ? 'vuelta' : 'vueltas'}`;
    else if (computed) gap = `+${computed}`;
    else if (lapTime(g) && !/^\+?0*[.,:]?0+(?:[.,]0+)?$/.test(g.replace(/[:]/g, ''))) gap = `+${lapTime(g)}`;
    if (!gap && race && pos !== 1 && leaderLaps && r.laps !== undefined && r.laps < leaderLaps) {
      const n = leaderLaps - r.laps;
      gap = `+${n} ${n === 1 ? 'vuelta' : 'vueltas'}`;
    }
    const row: ResultRow = {
      pos,
      ...(status ? { status } : {}),
      ...(r.number ? { number: r.number } : {}),
      driver: r.driver,
      ...(r.team ? { team: r.team } : {}),
      ...(r.vehicle ? { vehicle: r.vehicle } : {}),
      ...(r.laps !== undefined ? { laps: r.laps } : {}),
      ...(race ? (r.time && (pos === 1 || !gap) ? { time: r.time } : {}) : r.time ? { bestLap: r.time } : {}),
      ...(gap && pos !== 1 && pos !== null ? { gap } : {}),
      ...(r.class ? { class: r.class } : {}),
    };
    return row;
  });
}

/** Tipo de sesión de carrera (resultado por tiempo total y diferencia). */
export const isRaceKind = (kind: ArKind) => kind === 'serie' || kind === 'final' || kind === 'sprint';

/**
 * Controla un resultado leído: tiene filas, los puestos no bajan, arrancan cerca del 1 y todos tienen piloto. Se
 * admiten huecos: TC2000 y TN sacan de la tabla o mandan al final a los excluidos ("9, 11"), y una clasificación
 * rectificada de ACTC puede no tener 1° (el que lo era quedó 7° por una sanción). Lanza un error si no (cambió el
 * formato).
 */
export function checkArRows(rows: ResultRow[], label: string): ResultRow[] {
  const classified = rows.filter((r) => r.pos !== null);
  if (rows.length === 0) throw new Error(`${label}: el resultado no tiene filas`);
  classified.forEach((r, i) => {
    const ok = i === 0 ? r.pos! <= 3 : r.pos! >= classified[i - 1]!.pos!;
    if (!ok || !r.driver) throw new Error(`${label}: fila inesperada ${JSON.stringify(r)}`);
  });
  return rows;
}

// ─── Nombres de los pilotos ───────────────────────────────────────────────────────────────────

const plainTokens = (s: string) => normalizeForMatch(s).split(/[^a-z0-9]+/).filter((w) => w.length > 0);

/** Piloto de una lista oficial (campeonato o inscriptos), con su número. */
export interface KnownDriver {
  number?: string;
  name: string;
}

/**
 * Los resultados escriben el nombre como "APELLIDO NOMBRE" sin coma ("LAMBIRIS MAURICIO", "DE BENEDICTIS JUAN B"):
 * si el campeonato oficial tiene al piloto con el mismo número y las mismas palabras (o un prefijo, por los nombres
 * cortados), se usa el nombre del campeonato ("Mauricio LAMBIRIS"), que se lee bien y une al piloto con su ficha.
 */
export function withKnownNames(rows: ResultRow[], known: KnownDriver[]): ResultRow[] {
  if (known.length === 0) return rows;
  const byNumber = new Map<string, KnownDriver[]>();
  for (const k of known) if (k.number) byNumber.set(k.number, [...(byNumber.get(k.number) ?? []), k]);
  return rows.map((r) => {
    const words = plainTokens(r.driver);
    const candidates = (r.number ? byNumber.get(r.number) : undefined) ?? [];
    const joined = words.join('');
    const hit = candidates.find((k) => {
      const kw = plainTokens(k.name);
      if (words.length > 0 && words.every((w) => kw.some((x) => x === w || (w.length <= 2 && x.startsWith(w))))) return true;
      // Letras separadas por el PDF ("CASTE LLANO JONATAN", "CATALA N M AG N I"): mismas letras en otro orden de palabras.
      const letters = (s: string) => [...s].sort().join('');
      if (joined.length >= 6 && letters(joined) === letters(kw.join(''))) return true;
      // Letra rota ("MART¡NEZ, TOBIAS"): mismo número, misma cantidad de palabras y alguna igual (de 4 letras o más).
      return /[^\p{L}\s,.'-]/u.test(r.driver) && words.some((w) => w.length >= 4 && kw.includes(w));
    });
    return hit ? { ...r, driver: hit.name } : r;
  });
}

// ─── Sesiones de fechas ya corridas ───────────────────────────────────────────────────────────

/** Documento de resultados de una fecha ya corrida, con lo que se sepa de su hora. */
export interface PastDoc {
  key: ArSessionKey;
  /** Nombre de la sesión (el que results() reconoce). */
  name: string;
  /** Día local (YYYY-MM-DD) si la fuente lo dice. */
  date?: string;
  /** Hora local oficial de inicio y fin (HH:MM), si la fuente la publica. */
  start?: string;
  end?: string;
  /** Hora local (HH:MM) en que se publicó el documento: la sesión terminó un rato antes. */
  published?: string;
}

/** Duración típica (minutos) para estimar el inicio desde la hora de publicación o para encadenar sesiones. */
const TYPICAL_MIN: Record<ArKind, number> = { practica: 30, clasificacion: 25, serie: 15, final: 45, sprint: 30, warmup: 10, shakedown: 10 };
const KIND_ORDER: ArKind[] = ['shakedown', 'practica', 'clasificacion', 'warmup', 'serie', 'sprint', 'final'];

const hm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/**
 * Sesiones de una fecha ya corrida a partir de sus documentos de resultados. La hora es la oficial si el documento
 * la trae (con localStartText); si no, se estima: publicación del documento menos la duración típica y un margen,
 * o el orden típico del fin de semana (entrenamientos y clasificación el sábado, series y final el domingo).
 * Las estimadas van sin localStartText.
 */
export function pastSessionsFromDocs(docs: PastDoc[], entry: Pick<CalendarEntry, 'dateStart' | 'dateEnd' | 'tz'>): ExtractedSession[] {
  const sat = entry.dateStart < entry.dateEnd ? shiftDate(entry.dateEnd, -1) : entry.dateEnd;
  const clampDay = (d: string) => (d < entry.dateStart ? entry.dateStart : d > entry.dateEnd ? entry.dateEnd : d);
  const ordered = [...docs].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.key.kind) - KIND_ORDER.indexOf(b.key.kind) ||
      (a.key.n ?? 0) - (b.key.n ?? 0) ||
      (a.key.cls ?? '').localeCompare(b.key.cls ?? ''),
  );
  const out: ExtractedSession[] = [];
  const estimated: Array<{ d: PastDoc; day: string; start: number; dur: number; order: number }> = [];
  ordered.forEach((d, order) => {
    const weekendDay = ['practica', 'clasificacion', 'shakedown'].includes(d.key.kind) ? sat : entry.dateEnd;
    const day = d.date ? clampDay(d.date) : weekendDay;
    if (d.start) {
      out.push({
        name: d.name,
        startUtc: localToUtc(day, d.start, entry.tz),
        ...(d.end && d.end > d.start ? { endUtc: localToUtc(day, d.end, entry.tz) } : {}),
        localStartText: d.start,
      });
      return;
    }
    const dur = TYPICAL_MIN[d.key.kind];
    // La hora de publicación sirve si es razonable (un PDF subido a la noche no dice cuándo se corrió).
    const fromPublished = d.published ? minutes(d.published) - dur - 10 : -1;
    const usable = d.published && (!d.date || d.date === day) && fromPublished >= 8 * 60 && fromPublished <= 18 * 60 + 30;
    estimated.push({ d, day, start: usable ? fromPublished : -1, dur, order });
  });
  // Por día, en el orden del fin de semana: las que no tienen hora van después de la anterior, y ninguna se superpone
  // con la anterior (los PDF de las tres series se suben casi juntos).
  for (const day of new Set(estimated.map((e) => e.day))) {
    const list = estimated.filter((e) => e.day === day).sort((a, b) => a.order - b.order);
    let next = 9 * 60;
    for (const e of list) {
      const start = Math.min(Math.max(e.start, next), 22 * 60);
      next = start + e.dur + 10;
      out.push({ name: e.d.name, startUtc: localToUtc(day, hm(start), entry.tz) });
    }
  }
  return out.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
}

export function resultsSource(url: string, title: string, kind: Source['kind'], ctx: RecipeContext): Source {
  return { url, title, kind, method: 'directo', fetchedAt: isoNow(ctx.now) };
}
