/**
 * Resultados de los campeonatos del ACO (FIA WEC, European Le Mans Series y Asian Le Mans Series), sin IA.
 *
 * - Sesiones: la página de cada carrera (/en/race/{slug}) muestra el cronograma con un bloque por sesión: nombre
 *   ("Qualifications 1 - Hypercar & LMP2"), hora en UTC (data-timestamp) y hora local (data-local), y, cuando ya
 *   hay clasificación, el link a la página de resultados del sitio con el id de la sesión
 *   (/en/page/results?raceId=5073&sessionId=8316; en el WEC, /en/page/resultats-1?…).
 * - Clasificación: el JSON del cronometraje del ACO (data.asianlemansseries.com/results/{sessionId}), el que usa
 *   la app de tiempos de la Asian LMS para las sesiones terminadas. Los ids de sesión son comunes a los tres
 *   campeonatos (el mismo servidor responde los del WEC y la ELMS) y el JSON trae lo que las páginas de resultados
 *   de los sitios no muestran: clase, tripulación completa, auto, vueltas, diferencia y mejor vuelta.
 *   No publica el estado (abandono, no clasificado) ni el tiempo total de carrera.
 * - Los PDF/CSV oficiales de Al Kamel (fiawec.alkamelsystems.com, alms.alkamelsystems.com) quedaron detrás de un
 *   desafío de Cloudflare Turnstile: no se usan.
 */
import { driverDisplayName, toLocalWallIso, type ResultRow, type Session, type Source } from '@dm/shared';
import { HttpError } from '../core/http.ts';
import { absoluteUrl, decodeEntities, textOf } from '../extract/html.ts';
import { normalizeForMatch } from '../validate.ts';
import { isoNow, obj, pageOrNull, str, stripComments } from './kit.ts';
import { className } from './rosters.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, ResultsFound, SessionResultFound, SessionsFound } from './types.ts';

/** Clasificación de una sesión en el cronometraje del ACO (id de sesión de los sitios). */
export const ACO_TIMING_RESULTS = 'https://data.asianlemansseries.com/results/';

/** Sesión del cronograma de la página de una carrera. */
export interface AcoRaceSession {
  name: string;
  /** Hora de inicio en UTC (data-timestamp). */
  startUtc?: string;
  /** Hora local del circuito tal como la muestra la página ("10:10"). */
  localStartText?: string;
  /** Id de la sesión en el sitio (link de resultados o de repetición). */
  sessionId?: string;
  /** Página de resultados del sitio para esta sesión, si ya está publicada. */
  resultsUrl?: string;
}

const NAME_RE = /<div class="fw-bold lh-sm[^"]*">([\s\S]*?)<\/div>/g;

/** "01:30 PM" -> "13:30"; null si no tiene ese formato. */
function clock24(text: string): string | null {
  const m = text.trim().match(/^(\d{1,2}):(\d{2})(?:\s*([AP])M)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3]) h = (h % 12) + (/p/i.test(m[3]) ? 12 : 0);
  return h > 23 ? null : `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** Sesiones del cronograma de la página de una carrera, en el orden de la página. */
export function acoRaceSessions(html: string, pageUrl: string): AcoRaceSession[] {
  const page = stripComments(html);
  const marks = [...page.matchAll(NAME_RE)];
  return marks.map((m, i) => {
    const end = marks[i + 1]?.index ?? Math.min(page.length, m.index! + 20_000);
    const block = page.slice(m.index! + m[0].length, end);
    const out: AcoRaceSession = { name: textOf(m[1] ?? '') };
    const ts = Number(block.match(/data-timestamp="(\d{9,})"/)?.[1]);
    if (Number.isFinite(ts) && ts > 0) out.startUtc = new Date(ts * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
    const local = clock24(block.match(/data-local="([^"]+)"/)?.[1] ?? '');
    if (local) out.localStartText = local;
    const results = block.match(/href="([^"]*\/en\/page\/[^"?]*\?raceId=\d+&(?:amp;)?sessionId=(\d+))"/);
    if (results) {
      out.resultsUrl = absoluteUrl(decodeEntities(results[1]!), pageUrl) ?? undefined;
      out.sessionId = results[2]!;
    } else {
      const replay = block.match(/\/replay\/(\d+)"/)?.[1];
      if (replay) out.sessionId = replay;
    }
    return out;
  }).filter((s) => s.name);
}

/**
 * Sesiones de la carrera en el selector de la página de resultados del sitio (<select data-model="sessionId">):
 * lista también las que todavía no tienen link en la página de la carrera. Nombre en mayúsculas -> id.
 */
export function acoResultsPageSessions(html: string): { name: string; sessionId: string }[] {
  const select = html.match(/<select\b[^>]*data-model="sessionId"[^>]*>([\s\S]*?)<\/select>/)?.[1] ?? '';
  return [...select.matchAll(/<option\b[^>]*value="(\d+)"[^>]*>([\s\S]*?)<\/option>/g)]
    .map((m) => ({ name: textOf(m[2] ?? ''), sessionId: m[1]! }))
    .filter((s) => s.name);
}

const SHORT_PARTICLES = new Set(['DE', 'DA', 'DO', 'DI', 'DU', 'LA', 'LE', 'EL']);

/**
 * El cronometraje escribe el apellido en mayúsculas ("YE", "VAN DER LINDE"). driverDisplayName deja como sigla las
 * palabras de dos letras: en el apellido no lo son ("Yifei YE" -> "Yifei Ye"), salvo las partículas ("di Resta").
 */
function surnameCase(surname: string): string {
  return surname.replace(/(^|[s-])([A-ZÀ-Þ]{2})(?=$|[s-])/g, (m, sep: string, w: string) =>
    SHORT_PARTICLES.has(w) ? m : sep + w.charAt(0) + w.slice(1).toLocaleLowerCase('en'),
  );
}

/** "5.607" -> "+5.607", "1 Lap" -> "+1 Lap"; vacío o "-" (el primero) -> undefined. */
function gapText(raw: string): string | undefined {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t || t === '-') return undefined;
  return /^[+-]/.test(t) ? t : `+${t}`;
}

/**
 * Filas de la clasificación del JSON del cronometraje, en el orden de la general, con el puesto dentro de cada
 * clase (el JSON solo trae la general). [] si la sesión todavía no tiene datos ({"message":"No data"}); lanza un
 * error si la respuesta no tiene el formato esperado.
 */
export function acoResultRows(body: unknown): ResultRow[] {
  const o = obj(body);
  if (!Array.isArray(o.classification)) {
    if (str(o.message)) return [];
    throw new Error('ACO: respuesta inesperada del cronometraje (falta "classification")');
  }
  const lines = o.classification.map(obj).sort((a, b) => Number(a.position) - Number(b.position));
  const inClass = new Map<string, number>();
  const rows: ResultRow[] = [];
  for (const r of lines) {
    const drivers = (Array.isArray(r.drivers) ? r.drivers : [])
      .map(obj)
      .map((d) => driverDisplayName(`${str(d.firstname).trim()} ${surnameCase(str(d.surname).trim())}`.trim()))
      .filter(Boolean);
    const number = str(r.number).trim();
    if (!number && drivers.length === 0) continue;
    const pos = Number(r.position);
    const cls = className(str(r.class));
    const row: ResultRow = { pos: Number.isInteger(pos) && pos > 0 ? pos : null, driver: drivers.join(' / ') };
    if (number) row.number = number;
    const team = str(r.team).trim();
    if (team) row.team = team;
    const vehicle = str(r.vehicle).trim();
    if (vehicle) row.vehicle = vehicle;
    if (typeof r.laps === 'number') row.laps = r.laps;
    const gap = gapText(str(r.gap_first));
    if (gap) row.gap = gap;
    const best = str(r.fastest_lap_time).trim();
    if (best) row.bestLap = best;
    if (cls) {
      row.class = cls;
      const n = (inClass.get(cls) ?? 0) + 1;
      inClass.set(cls, n);
      row.classPos = n;
    }
    rows.push(row);
  }
  return rows;
}

const names = (s: Session) => [s.originalName, s.name].filter((x): x is string => !!x).map(normalizeForMatch);

/** Sesión del cronograma de la carrera que corresponde a una sesión pedida: por nombre y, si no, por hora. */
function findRaceSession(s: Session, list: AcoRaceSession[]): AcoRaceSession | undefined {
  const wanted = names(s);
  return list.find((r) => wanted.includes(normalizeForMatch(r.name))) ?? list.find((r) => r.startUtc && r.startUtc === s.startUtc);
}

/** Pedido que conviene reintentar más tarde (el servidor pidió esperar o no respondió) y no cuenta como intento. */
const transient = (err: unknown) => !(err instanceof HttpError) || err.status === 429 || err.status >= 500;

/**
 * Resultados de las sesiones pedidas de una carrera. null si la página de la carrera no existe o todavía no
 * enlaza ningún resultado.
 */
export async function acoResults(entry: CalendarEntry, sessions: Session[], ctx: RecipeContext): Promise<ResultsFound | null> {
  if (!entry.url) return null;
  const html = await pageOrNull(ctx, entry.url);
  if (!html) return null;
  const race = acoRaceSessions(html, entry.url);
  const published = race.find((r) => r.resultsUrl);
  if (!published) return null;
  // Sesiones sin link en la página de la carrera: el selector de la página de resultados del sitio tiene su id.
  let selector: { name: string; sessionId: string }[] | null = null;
  const idFromSelector = async (name: string): Promise<string | undefined> => {
    if (!selector) {
      const url = published.resultsUrl!.replace(/&(?:amp;)?sessionId=\d+/, '');
      selector = acoResultsPageSessions((await pageOrNull(ctx, url).catch(() => null)) ?? '');
    }
    return selector.find((o) => normalizeForMatch(o.name) === normalizeForMatch(name))?.sessionId;
  };

  const fetchedAt = isoNow(ctx.now);
  const found: SessionResultFound[] = [];
  const deferred: string[] = [];
  for (const s of sessions) {
    const r = findRaceSession(s, race);
    const id = r?.sessionId ?? (await idFromSelector(r?.name ?? s.originalName ?? s.name));
    if (!id) continue;
    let body: unknown;
    try {
      body = (await ctx.http.json<unknown>(`${ACO_TIMING_RESULTS}${id}`, { noProxy: true })).body;
    } catch (err) {
      if (transient(err)) deferred.push(s.id);
      else if (!(err instanceof HttpError && err.status === 404)) throw err;
      continue;
    }
    const rows = acoResultRows(body);
    if (rows.length === 0) continue;
    const label = r?.name ?? s.originalName ?? s.name;
    const source: Source = {
      url: r?.resultsUrl ?? published.resultsUrl!.replace(/sessionId=\d+/, `sessionId=${id}`),
      title: `${ctx.series.shortName} — ${entry.name}: ${label} (resultados)`,
      kind: 'api',
      method: 'directo',
      fetchedAt,
    };
    found.push({ sessionId: s.id, rows, source });
  }
  const title = textOf(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  return {
    sessions: found,
    source: { url: entry.url, title: title || `Resultados ${ctx.series.shortName} — ${entry.name}`, kind: 'html', method: 'directo', fetchedAt },
    ...(deferred.length ? { deferred } : {}),
  };
}

/**
 * Sesiones de una carrera ya corrida desde el cronograma de su página (hora UTC exacta y hora local publicada):
 * mismos nombres que usa acoResults. null si la página no existe o no trae el cronograma.
 */
export async function acoPastSessions(entry: CalendarEntry, ctx: RecipeContext): Promise<SessionsFound | null> {
  if (!entry.url) return null;
  const html = await pageOrNull(ctx, entry.url);
  if (!html) return null;
  const sessions: ExtractedSession[] = [];
  for (const r of acoRaceSessions(html, entry.url)) {
    if (!r.startUtc) continue;
    // Control: la hora local publicada tiene que coincidir con la UTC en la zona del circuito; si no, se omite.
    const local = r.localStartText && toLocalWallIso(r.startUtc, entry.tz).slice(11, 16) === r.localStartText ? r.localStartText : undefined;
    sessions.push({ name: r.name, startUtc: r.startUtc, ...(local ? { localStartText: local } : {}) });
  }
  if (sessions.length === 0) return null;
  const title = textOf(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  return {
    sessions,
    source: { url: entry.url, title: title || `Programa — ${entry.name}`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) },
  };
}
