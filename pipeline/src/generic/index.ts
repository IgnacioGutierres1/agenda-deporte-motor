/**
 * Flujo genérico (Nivel B): para cualquier serie con strategy "generic", usando solo sus officialUrls.
 *
 * 1. Calendario oficial (officialUrls[0]) -> eventos. Primero lectura determinista (receta del sitio,
 *    JSON-LD); si no alcanza, Gemini sobre el texto compacto de la página.
 * 2. Para los eventos dentro del horizonte, ubica el documento oficial del cronograma (API oficial,
 *    JSON-LD de la página del evento, PDF enlazado, la propia página o una nota de prensa) y lo descarga.
 * 3. Gemini transcribe las sesiones; las horas que no figuran literalmente en el documento se descartan.
 * 4. Caché por serie + hash del documento: Gemini solo se llama cuando el documento cambió.
 */
import path from 'node:path';
import {
  slugify,
  type EventResultsFile,
  type MotorEvent,
  type Series,
  type Session,
  type SessionResult,
  type Source,
  type StandingsFile,
} from '@dm/shared';
import { classifySession, isNonRaceEvent } from '../core/builders.ts';
import { seriesForSeason } from '../core/season.ts';
import { readJson, writeJson } from '../core/store.ts';
import type { Adapter, AdapterContext, MissingTimetable, ResultsChunk, ResultsRequest, ScheduleChunk } from '../core/types.ts';
import { fetchDocument, fetchImages, looksLikePdf, type FetchedDocument } from '../extract/document.ts';
import { getAi } from '../extract/ai-chain.ts';
import { GeminiUnavailableError, MISSING_KEY_MESSAGE, type Gemini } from '../extract/gemini.ts';
import { contentImages } from '../extract/html.ts';
import { normalizeForMatch } from '../validate.ts';
import {
  aiCalendar,
  aiResults,
  aiStandings,
  aiTimetable,
  imageDocument,
  newTrace,
  PROMPT_VERSION,
  traceModel,
  validateResultRows,
  type AiDeps,
  type AiTrace,
} from './ai.ts';
import { createExtractionCache } from './cache.ts';
import {
  imageCalendarEntries,
  jsonLdCalendar,
  jsonLdSessions,
  looksLikeTimetable,
  newsTimetableLink,
  resultsLinks,
  STANDINGS_RE,
  RESULTS_RE,
  timetableLinks,
} from './locate.ts';
import { championshipKey, shiftDate } from './places.ts';
import { findRecipe } from './recipes.ts';
import type { CalendarEntry, RecipeContext, SessionsFound, StandingsFound } from './types.ts';

export interface GenericDeps {
  /**
   * Cliente de IA (por defecto, la cadena compartida de la corrida: Gemini -> Groq, configurada por variables
   * de entorno). Se llama `gemini` por historia: cualquier cliente con esa interfaz sirve.
   */
  gemini?: () => Gemini;
}

/** Tope de documentos de resultados/campeonato por serie y corrida (cuida el cupo de Gemini). */
const MAX_RESULT_DOCS = 3;
/**
 * Eventos cuyos resultados se leen por receta (sin IA) por serie y corrida: alcanza para ponerse al día con una
 * temporada entera en pocas corridas sin cargar de golpe al sitio. Los que quedan afuera no cuentan como intento.
 */
const MAX_DIRECT_RESULT_EVENTS = 8;
/**
 * Último cambio de los lectores de resultados por receta (SiteRecipe.results). Las sesiones que se habían dado por
 * perdidas antes de esta fecha (porque solo había IA) se vuelven a intentar (ver Adapter.resultsReaderSince).
 */
/**
 * Fechas ya corridas sin sesiones guardadas cuyas sesiones se reconstruyen por corrida y serie desde los resultados
 * oficiales (SiteRecipe.pastSessions), de la más reciente a la más vieja.
 */
const MAX_PAST_SESSION_EVENTS = 6;
export const GENERIC_RESULTS_READER_SINCE = '2026-11-14T00:00:00Z';
/** Imágenes que se leen como máximo de una página de calendario y de una página/nota de cronograma. */
const MAX_CALENDAR_IMAGES = 16;
const MAX_TIMETABLE_IMAGES = 3;
/**
 * Temporada siguiente sin lectura directa: la IA lee su calendario solo si la página ya nombra ese año al menos
 * estas veces, y como mucho una vez por semana y serie (registro en data/_cache/next-season-ai.json).
 */
const NEXT_SEASON_MIN_MENTIONS = 3;
const NEXT_SEASON_AI_EVERY_MS = 7 * 24 * 3600_000;

export interface CalendarRead {
  entries: CalendarEntry[];
  doc: FetchedDocument;
  source: Source;
}

const isoNow = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

function aiDeps(ctx: AdapterContext, deps: GenericDeps): AiDeps {
  return { gemini: (deps.gemini ?? getAi)(), cache: createExtractionCache(ctx.cacheDir, PROMPT_VERSION) };
}

function recipeCtx(series: Series, ctx: AdapterContext): RecipeContext {
  return { season: ctx.season, series, http: ctx.http, now: ctx.now };
}

/**
 * Contexto con la temporada vigente de la serie: el año en curso, salvo que la receta del sitio diga otra
 * (campeonatos de invierno, ver SiteRecipe.season). Lo usan el calendario, los resultados y el campeonato, y
 * debería usarlo cualquier otra fase que lea la serie con ctx.season (p. ej. los inscriptos).
 */
export async function withSeriesSeason(series: Series, ctx: AdapterContext): Promise<AdapterContext> {
  const resolved = seriesForSeason(series, ctx.season);
  const recipe = findRecipe(resolved.officialUrls[0] ?? '');
  if (!recipe?.season) return ctx;
  try {
    const season = await recipe.season(recipeCtx(resolved, ctx));
    if (season === ctx.season) return ctx;
    ctx.log.info(`Temporada vigente: ${season} (la que indica el sitio oficial, no el año en curso)`);
    return { ...ctx, season };
  } catch (err) {
    ctx.log.warn(`No se pudo determinar la temporada vigente (${err instanceof Error ? err.message : String(err)}); se usa ${ctx.season}`);
    return ctx;
  }
}

/**
 * Lee el calendario oficial de una serie (o un calendario multi-categoría, para el descubrimiento).
 * Lanza un error claro si hace falta IA y no hay clave.
 */
export async function readCalendar(
  series: Series,
  url: string,
  ctx: AdapterContext,
  deps: GenericDeps = {},
  opts: { multiSeries?: boolean } = {},
): Promise<CalendarRead> {
  const recipe = findRecipe(url);
  const target = recipe?.calendarUrl?.(url, ctx.season) ?? url;
  const doc = await fetchDocument(ctx.http, target);
  let entries = (await recipe?.calendar?.(doc, recipeCtx(series, ctx))) ?? [];
  let method: Source['method'] = 'directo';
  // Calendario multi-categoría usado como sitio de una sola serie (p. ej. una categoría descubierta en el
  // calendario de la FIA o de la CDA): se queda con las fechas de ese campeonato.
  if (!opts.multiSeries && entries.some((e) => e.championship)) {
    const key = championshipKey(series.name);
    entries = entries.filter((e) => e.championship && championshipKey(e.championship) === key);
  }
  if (entries.length === 0) entries = jsonLdCalendar(doc, ctx.season);
  entries = dropNonRaceEvents(entries, ctx);
  let read: FetchedDocument = doc;
  const trace = newTrace();
  // Temporada siguiente sin lectura directa: IA solo si el sitio no tiene receta de calendario y la página ya
  // la muestra (con tope semanal); si no, el calendario queda vacío y no se gasta cupo.
  const nextSeasonAi = entries.length === 0 && ctx.nextSeason ? await nextSeasonAiGate(series, doc, ctx, !!recipe?.calendar) : null;
  if (entries.length === 0 && ctx.nextSeason && !nextSeasonAi) {
    return { entries, doc, source: { url: doc.url, title: doc.title || `Calendario ${series.shortName} ${ctx.season}`, kind: doc.kind, method: 'directo', fetchedAt: isoNow(ctx.now) } };
  }
  if (entries.length === 0) {
    method = 'ia';
    let dropped = 0;
    const aiOpts = {
      ...opts,
      trace,
      onDropped: (name: string, reason: string) => {
        dropped++;
        ctx.log.warn(`Calendario: "${name}" descartado, ${reason}`);
      },
    };
    try {
      const ai = aiDeps(ctx, deps);
      try {
        entries = await aiCalendar(ai, series, doc, ctx.season, aiOpts);
      } catch (err) {
        // Sin IA disponible no hubo pedido: no cuenta para el tope semanal de la temporada siguiente.
        if (!(err instanceof GeminiUnavailableError)) await nextSeasonAi?.record();
        throw err;
      }
      await nextSeasonAi?.record();
      // Calendario publicado como imágenes (una por fecha, p. ej. Turismo Pista): se leen las imágenes.
      // (No si Gemini sí encontró eventos en el texto pero sin días concretos: las imágenes no los van a tener;
      // tampoco para la temporada siguiente, que espera al 1 de enero antes que gastar cupo en imágenes.)
      if (entries.length === 0 && dropped === 0 && doc.kind === 'html' && !ctx.nextSeason) {
        const imgTrace = newTrace();
        const img = await imageDocument(ai, series.id, doc, await fetchImages(ctx.http, contentImages(doc.raw, doc.url).slice(0, MAX_CALENDAR_IMAGES)), imgTrace);
        if (img) {
          trace.models.push(...imgTrace.models);
          // Primero lectura determinista de la transcripción ("FECHA 10 / NOVIEMBRE 20, 21 y 22 / Rafaela");
          // si no tiene ese formato, Gemini arma la lista a partir del texto transcripto.
          entries =
            series.group === 'argentina' && !opts.multiSeries
              ? imageCalendarEntries(img, ctx.season, {
                  country: 'Argentina',
                  defaultTz: 'America/Argentina/Buenos_Aires',
                  seriesNames: [series.name, series.shortName],
                })
              : [];
          if (entries.length === 0) entries = await aiCalendar(ai, series, img, ctx.season, aiOpts);
          if (entries.length > 0) read = { ...img, url: doc.url };
        }
      }
      entries = dropNonRaceEvents(entries, ctx);
    } catch (err) {
      if (err instanceof GeminiUnavailableError) {
        throw new Error(`${err.message}: el calendario oficial (${target}) no se puede leer sin IA`);
      }
      throw err;
    }
  }
  const model = method === 'ia' ? traceModel(trace) : undefined;
  const source: Source = {
    url: read.url,
    title: doc.title || `Calendario ${series.shortName} ${ctx.season}`,
    kind: read.kind,
    method,
    fetchedAt: isoNow(ctx.now),
    ...(model ? { model } : {}),
  };
  return { entries, doc, source };
}

/** Saca del calendario las galas, premiaciones y presentaciones (no son eventos de pista). */
function dropNonRaceEvents(entries: CalendarEntry[], ctx: AdapterContext): CalendarEntry[] {
  return entries.filter((e) => {
    if (!isNonRaceEvent(e.name)) return true;
    ctx.log.info(`Calendario: "${e.name}" no es un evento de pista (gala, premiación o presentación); se omite`);
    return false;
  });
}

type NextSeasonAiLog = Record<string, string>;

/**
 * ¿Se puede gastar IA en el calendario de la temporada siguiente? Solo si:
 * - el sitio no tiene receta de calendario (si la tiene y no encontró fechas de ese año, es que no están);
 * - la página nombra ese año al menos NEXT_SEASON_MIN_MENTIONS veces (si no, todavía muestra la terminada);
 * - no se probó en la última semana (data/_cache/next-season-ai.json): aunque el documento cambie en cada
 *   corrida, como mucho un pedido por semana y serie.
 * Devuelve con qué registrar el intento (se llama al pedirle a la IA), o null si no corresponde.
 */
async function nextSeasonAiGate(
  series: Series,
  doc: FetchedDocument,
  ctx: AdapterContext,
  hasRecipe: boolean,
): Promise<{ record(): Promise<void> } | null> {
  if (hasRecipe) return null;
  const mentions = doc.text.match(new RegExp(`(?<!\\d)${ctx.season}(?!\\d)`, 'g'))?.length ?? 0;
  if (mentions < NEXT_SEASON_MIN_MENTIONS) return null;
  const file = path.join(ctx.cacheDir, 'next-season-ai.json');
  const key = `${series.id}|${ctx.season}`;
  const last = Date.parse((await readJson<NextSeasonAiLog>(file).catch(() => null))?.[key] ?? '');
  if (Number.isFinite(last) && ctx.now.getTime() - last < NEXT_SEASON_AI_EVERY_MS) return null;
  ctx.log.info(`Temporada ${ctx.season}: la página la nombra ${mentions} veces; se lee su calendario con IA`);
  return {
    async record() {
      const log = (await readJson<NextSeasonAiLog>(file).catch(() => null)) ?? {};
      log[key] = isoNow(ctx.now);
      await writeJson(file, log);
    },
  };
}

/** Claves estables de evento: número de fecha/ronda si existe, si no el nombre; desambigua repetidos. */
export function eventKeys(entries: CalendarEntry[]): string[] {
  const keys = entries.map((e) => e.key ?? (e.round !== undefined ? `r${e.round}` : slugify(e.name)));
  return keys.map((k, i) => (keys.indexOf(k) !== i || keys.lastIndexOf(k) !== i ? `${k}|${entries[i]!.dateEnd}` : k));
}

export function createGenericAdapter(deps: GenericDeps = {}): Adapter {
  return {
    name: 'generic',
    resultsReaderSince: GENERIC_RESULTS_READER_SINCE,

    prefersDirectStandings(series) {
      const url = series.officialUrls.slice(1).find((u) => STANDINGS_RE.test(u));
      return !!(url && findRecipe(url)?.standings);
    },

    async schedule(template, baseCtx): Promise<ScheduleChunk> {
      const ctx = await withSeriesSeason(template, baseCtx);
      // Temporada de invierno (ALMS): la vigente la dice el sitio; la "siguiente" del año calendario no aplica.
      if (baseCtx.nextSeason && ctx.season !== baseCtx.season) return { events: [], sessions: [] };
      const series = seriesForSeason(template, ctx.season);
      const url = series.officialUrls[0];
      if (!url) throw new Error('La serie no tiene URL oficial (officialUrls[0])');
      const cal = await readCalendar(series, url, ctx, deps);
      if (cal.entries.length === 0) {
        throw new Error(`No se encontraron eventos ${ctx.season} en el calendario oficial (${cal.doc.url})`);
      }
      ctx.log.info(`Calendario: ${cal.entries.length} eventos (${cal.source.method === 'ia' ? 'IA' : 'lectura directa'})`);

      const today = isoNow(ctx.now).slice(0, 10);
      const from = shiftDate(today, -1);
      const to = shiftDate(today, ctx.horizonDays);
      const keys = eventKeys(cal.entries);
      const prevSessions = ctx.previous?.sessions ?? [];
      const events: MotorEvent[] = [];
      const sessions: Session[] = [];
      const missing: MissingTimetable[] = [];
      let needsKey = 0;
      let unavailable = MISSING_KEY_MESSAGE;
      // Fechas ya terminadas sin sesiones guardadas (el cronograma solo se lee dentro del horizonte): la receta puede
      // reconstruirlas desde los resultados oficiales para que la fase de resultados tenga a qué asignarlos.
      const recipe = findRecipe(url);
      const pastBudget = { left: recipe?.pastSessions ? MAX_PAST_SESSION_EVENTS : 0 };
      const pastOrder = new Map(
        cal.entries
          .map((e, i) => ({ e, i }))
          .filter(({ e }) => e.dateEnd < from)
          .sort((a, b) => b.e.dateEnd.localeCompare(a.e.dateEnd))
          .map(({ i }, rank) => [i, rank]),
      );

      for (const [i, entry] of cal.entries.entries()) {
        const draft = ctx.build.event({
          series,
          season: ctx.season,
          key: keys[i]!,
          name: entry.name,
          ...(entry.round !== undefined ? { round: entry.round } : {}),
          circuit: entry.circuit,
          country: entry.country,
          tz: entry.tz,
          dateStart: entry.dateStart,
          dateEnd: entry.dateEnd,
          sessionsStatus: 'pending',
          source: cal.source,
        });
        let found: SessionsFound | null = null;
        // Un error al buscar o leer el cronograma (o la falta de IA) no es lo mismo que "todavía no publicado".
        let unreadable = false;
        const inHorizon = entry.dateEnd >= from && entry.dateStart <= to;
        const pastRank = pastOrder.get(i);
        if (
          pastRank !== undefined &&
          recipe?.pastSessions &&
          pastBudget.left > 0 &&
          !isNonRaceEvent(entry.name) &&
          !prevSessions.some((s) => s.eventId === draft.id)
        ) {
          pastBudget.left--;
          try {
            found = await recipe.pastSessions(entry, recipeCtx(series, ctx));
            if (found?.sessions.length) ctx.log.info(`${entry.name}: ${found.sessions.length} sesión(es) reconstruidas desde los resultados oficiales`);
          } catch (err) {
            ctx.log.warn(`${entry.name}: sesiones de la fecha ya corrida ilegibles (${err instanceof Error ? err.message : String(err)})`);
          }
        }
        if (inHorizon) {
          try {
            found = await findSessions(series, entry, cal, ctx, deps);
          } catch (err) {
            unreadable = true;
            if (err instanceof GeminiUnavailableError) {
              needsKey++;
              unavailable = err.message;
            }
            else ctx.log.warn(`${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (found && found.sessions.length > 0) {
          const event: MotorEvent = { ...draft, sessionsStatus: 'published' };
          events.push(event);
          const seen = new Map<string, number>();
          for (const s of found.sessions) {
            const n = (seen.get(s.name) ?? 0) + 1;
            seen.set(s.name, n);
            sessions.push(
              ctx.build.session({
                event,
                type: classifySession(s.name),
                name: s.name,
                startUtc: s.startUtc,
                ...(s.endUtc ? { endUtc: s.endUtc } : {}),
                ...(s.localStartText ? { localStartText: s.localStartText } : {}),
                source: found.source,
                ...(n > 1 ? { key: n } : {}),
              }),
            );
          }
        } else {
          // Fuera del horizonte (o sin cronograma nuevo): se conservan las sesiones ya leídas antes.
          const kept = prevSessions.filter((s) => s.eventId === draft.id);
          events.push(kept.length > 0 ? { ...draft, sessionsStatus: 'published' } : draft);
          sessions.push(...kept);
          if (inHorizon && kept.length === 0) missing.push({ eventId: draft.id, reason: unreadable ? 'ilegible' : 'no-publicado' });
        }
      }
      if (needsKey > 0) {
        ctx.log.warn(`${unavailable}: ${needsKey} cronograma(s) dentro del horizonte quedan "a confirmar"`);
      }
      return { events, sessions, ...(missing.length ? { missingTimetables: missing } : {}) };
    },

    async results(template, baseCtx, req): Promise<ResultsChunk> {
      const ctx = await withSeriesSeason(template, baseCtx);
      return genericResults(seriesForSeason(template, ctx.season), ctx, req, deps);
    },
  };
}

/** Busca las sesiones de un evento: lectura directa si se puede, si no Gemini sobre el documento oficial. */
async function findSessions(
  series: Series,
  entry: CalendarEntry,
  cal: CalendarRead,
  ctx: AdapterContext,
  deps: GenericDeps,
): Promise<SessionsFound | null> {
  if (entry.sessions?.length) return { sessions: entry.sessions, source: cal.source };

  const recipe = findRecipe(series.officialUrls[0] ?? '');
  if (recipe?.sessions) {
    const direct = await recipe.sessions(entry, recipeCtx(series, ctx));
    if (direct) return direct;
  }

  const trace = newTrace();
  let doc: Located | null = null;
  if (recipe?.timetableImages) {
    // Cronograma publicado como imagen en un lugar fijo del sitio: la receta ubica las imágenes y la IA las transcribe.
    const located = await recipe.timetableImages(entry, recipeCtx(series, ctx));
    const img = located ? await imageDocument(aiDeps(ctx, deps), series.id, located, await fetchImages(ctx.http, located.images), trace) : null;
    if (img) doc = { doc: img };
  }
  const fallback = recipe?.timetableFallback ?? (recipe?.sessions && (!entry.url || entry.url === cal.doc.url) ? 'none' : 'generic');
  if (!doc && fallback === 'generic') doc = await locateTimetable(series, entry, cal, ctx, deps, trace);
  if (!doc) {
    ctx.log.info(`${entry.name}: cronograma todavía no publicado`);
    return null;
  }
  if ('direct' in doc) return doc.direct;

  const result = await aiTimetable(aiDeps(ctx, deps), series, entry, doc.doc, trace);
  for (const d of result.dropped) ctx.log.warn(`${entry.name}: sesión descartada "${d.name}": ${d.reason}`);
  // Había un documento de cronograma pero no salió ninguna sesión válida: no es "todavía no publicado".
  if (result.sessions.length === 0) throw new Error(`el cronograma (${doc.doc.url}) no tiene sesiones legibles`);
  const model = traceModel(trace);
  return {
    sessions: result.sessions,
    source: {
      url: doc.doc.url,
      title:
        doc.doc.kind === 'image'
          ? `Cronograma ${series.shortName} — ${entry.name} (imagen oficial)`
          : doc.doc.title || `Cronograma ${series.shortName} — ${entry.name}`,
      kind: doc.doc.kind === 'api' ? 'html' : doc.doc.kind,
      method: 'ia',
      fetchedAt: isoNow(ctx.now),
      ...(model ? { model } : {}),
    },
  };
}

type Located = { doc: FetchedDocument } | { direct: SessionsFound };

async function tryFetch(ctx: AdapterContext, url: string): Promise<FetchedDocument | null> {
  try {
    return await fetchDocument(ctx.http, url);
  } catch (err) {
    ctx.log.warn(`No se pudo leer ${url}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/**
 * Cronograma publicado como imagen dentro de una página o nota de cronograma (TC2000, notas de prensa):
 * se transcriben sus imágenes de contenido. null si la página no tiene imágenes.
 */
async function timetableFromImages(
  series: Series,
  page: FetchedDocument,
  ctx: AdapterContext,
  deps: GenericDeps,
  trace?: AiTrace,
): Promise<FetchedDocument | null> {
  if (page.kind !== 'html') return null;
  const urls = contentImages(page.raw, page.url).slice(0, MAX_TIMETABLE_IMAGES);
  if (urls.length === 0) return null;
  return imageDocument(aiDeps(ctx, deps), series.id, page, await fetchImages(ctx.http, urls), trace);
}

async function locateTimetable(
  series: Series,
  entry: CalendarEntry,
  cal: CalendarRead,
  ctx: AdapterContext,
  deps: GenericDeps,
  trace?: AiTrace,
): Promise<Located | null> {
  if (entry.timetableUrl) {
    const doc = await tryFetch(ctx, entry.timetableUrl);
    if (doc) return { doc };
  }
  if (entry.url && entry.url !== cal.doc.url) {
    const page = await tryFetch(ctx, entry.url);
    if (page) {
      const ld = jsonLdSessions(page);
      if (ld.sessions.length > 0) {
        return {
          direct: {
            sessions: ld.sessions,
            source: { url: page.url, title: page.title || entry.name, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) },
          },
        };
      }
      for (const link of timetableLinks(page).slice(0, 2)) {
        const doc = await tryFetch(ctx, link.url);
        if (!doc) continue;
        if (doc.kind === 'pdf' || looksLikeTimetable(doc.text)) return { doc };
        const img = await timetableFromImages(series, doc, ctx, deps, trace);
        if (img) return { doc: img };
      }
      if (looksLikeTimetable(page.text)) return { doc: page };
    }
  }
  // Sitios que publican el cronograma como nota (ACTC, APAT…): índices de noticias en officialUrls[1..].
  for (const indexUrl of series.officialUrls.slice(1)) {
    if (RESULTS_RE.test(indexUrl) || STANDINGS_RE.test(indexUrl)) continue;
    const index = await tryFetch(ctx, indexUrl);
    if (!index) continue;
    const link = newsTimetableLink(index, entry);
    if (!link) continue;
    const doc = await tryFetch(ctx, link.url);
    if (!doc) continue;
    const pdf = doc.kind === 'html' ? timetableLinks(doc).find((l) => looksLikePdf(l.url)) : undefined;
    if (pdf) {
      const pdfDoc = await tryFetch(ctx, pdf.url);
      if (pdfDoc) return { doc: pdfDoc };
    }
    if (!looksLikeTimetable(doc.text)) {
      const img = await timetableFromImages(series, doc, ctx, deps, trace);
      if (img) return { doc: img };
    }
    return { doc };
  }
  return null;
}

// ─── Resultados y campeonato (Nivel B) ────────────────────────────────────────────────────────

/** Nombres con que se puede reconocer una sesión: el original de la fuente ("Practice 1") y el publicado ("Práctica 1"). */
const sessionNames = (c: Session) => [...new Set([c.originalName, c.name].filter((x): x is string => !!x).map(normalizeForMatch))];

/** Une un nombre de sesión transcripto con la sesión del cronograma. */
export function matchSession(name: string, candidates: Session[]): Session | undefined {
  const n = normalizeForMatch(name);
  const exact = candidates.find((c) => sessionNames(c).includes(n));
  if (exact) return exact;
  const contains = candidates.filter((c) => sessionNames(c).some((cn) => cn.includes(n) || n.includes(cn)));
  if (contains.length === 1) return contains[0];
  const type = classifySession(name);
  const sameType = candidates.filter((c) => c.type === type);
  return sameType.length === 1 ? sameType[0] : undefined;
}

async function genericResults(
  series: Series,
  ctx: AdapterContext,
  req: ResultsRequest,
  deps: GenericDeps,
): Promise<ResultsChunk> {
  const out: ResultsChunk = { results: [] };
  const ai = aiDeps(ctx, deps);
  let docs = 0;
  const nowIso = isoNow(ctx.now);
  const standingsUrl = series.officialUrls.slice(1).find((u) => STANDINGS_RE.test(u));

  // Campeonato por lectura directa (receta del sitio): primero y fuera del flujo con IA, así no depende
  // del cupo de Gemini ni de que los resultados se hayan podido leer.
  let standingsRead = false;
  if (req.standingsStale && standingsUrl) {
    const direct = await directStandings(series, standingsUrl, ctx);
    if (direct !== undefined) {
      standingsRead = true;
      if (direct) out.standings = { seriesId: series.id, season: ctx.season, updatedAt: nowIso, ...direct };
      else ctx.log.info(`Campeonato ${ctx.season} todavía no publicado (${standingsUrl})`);
    }
  }

  try {
    if (req.pendingSessions.length > 0) {
      const cal = await readCalendar(series, series.officialUrls[0]!, ctx, deps);
      const keys = eventKeys(cal.entries);
      const byEventId = new Map<string, CalendarEntry>();
      cal.entries.forEach((e, i) => {
        const ev = ctx.build.event({
          series, season: ctx.season, key: keys[i]!, name: e.name, circuit: e.circuit, country: e.country, tz: e.tz,
          dateStart: e.dateStart, dateEnd: e.dateEnd, sessionsStatus: 'pending', source: cal.source,
        });
        byEventId.set(ev.id, e);
      });
      const eventOrder = [...new Set(req.pendingSessions.map((s) => s.eventId))];
      // 1) Lectura directa con la receta del sitio (sin IA). Los eventos que resuelve no pasan a la IA.
      const direct = await directResults(series, ctx, req, eventOrder, byEventId, out);
      for (const eventId of eventOrder) {
        if (direct.has(eventId)) continue;
        if (docs >= MAX_RESULT_DOCS) break;
        const entry = byEventId.get(eventId);
        const event = req.events.find((e) => e.id === eventId);
        if (!entry || !event) continue;
        const doc = await locateResults(series, entry, ctx);
        if (!doc) continue;
        docs++;
        const pending = req.pendingSessions.filter((s) => s.eventId === eventId);
        const all = req.sessions.filter((s) => s.eventId === eventId);
        const trace = newTrace();
        // La IA lee el documento oficial: se le pasan los nombres de sesión tal como figuran en la fuente.
        const data = await aiResults(ai, series, event.name, all.map((s) => s.originalName ?? s.name), doc, trace);
        const model = traceModel(trace);
        const source: Source = {
          url: doc.url,
          title: doc.title || `Resultados ${series.shortName}`,
          kind: doc.kind === 'api' ? 'html' : doc.kind,
          method: 'ia',
          fetchedAt: nowIso,
          ...(model ? { model } : {}),
        };
        const sessionResults: SessionResult[] = [];
        for (const s of data.sessions ?? []) {
          const target = matchSession(s.sessionName, pending);
          if (!target) continue;
          const problem = validateResultRows(s.rows ?? [], doc.text);
          if (problem) {
            ctx.log.warn(`Resultado descartado (${s.sessionName}): ${problem}`);
            continue;
          }
          sessionResults.push({ sessionId: target.id, rows: s.rows, source });
        }
        if (sessionResults.length > 0) {
          const file: EventResultsFile = { seriesId: series.id, eventId, updatedAt: nowIso, sessions: sessionResults };
          out.results.push(file);
        }
      }
    }

    if (req.standingsStale && !standingsRead && docs < MAX_RESULT_DOCS) {
      const doc = standingsUrl ? await tryFetch(ctx, standingsUrl) : null;
      if (doc) {
        const trace = newTrace();
        const tables = await aiStandings(ai, series, ctx.season, doc, trace);
        const model = traceModel(trace);
        if (tables.length > 0) {
          const standings: StandingsFile = {
            seriesId: series.id,
            season: ctx.season,
            updatedAt: nowIso,
            tables,
            source: {
              url: doc.url,
              title: doc.title || `Campeonato ${series.shortName}`,
              kind: doc.kind === 'api' ? 'html' : doc.kind,
              method: 'ia',
              fetchedAt: nowIso,
              ...(model ? { model } : {}),
            },
          };
          out.standings = standings;
        }
      }
    }
  } catch (err) {
    if (err instanceof GeminiUnavailableError) {
      ctx.log.warn(`${err.message}: resultados y campeonato sin leer`);
      return out;
    }
    throw err;
  }
  return out;
}

/**
 * Resultados por receta (SiteRecipe.results), del evento más reciente al más viejo. Devuelve los ids de los eventos
 * que la receta resolvió (con o sin resultado publicado todavía): esos no se le pasan a la IA. Si la receta falla,
 * el evento queda para la IA.
 */
async function directResults(
  series: Series,
  ctx: AdapterContext,
  req: ResultsRequest,
  eventOrder: string[],
  byEventId: Map<string, CalendarEntry>,
  out: ResultsChunk,
): Promise<Set<string>> {
  const handled = new Set<string>();
  const recipe = findRecipe(series.officialUrls[0] ?? '');
  if (!recipe?.results) return handled;
  const nowIso = isoNow(ctx.now);
  let read = 0;
  for (const eventId of eventOrder) {
    const entry = byEventId.get(eventId);
    if (!entry) continue;
    const pending = req.pendingSessions.filter((s) => s.eventId === eventId);
    if (read >= MAX_DIRECT_RESULT_EVENTS) {
      // Tope de la corrida: quedan para la próxima sin contar como intento.
      (out.deferred ??= []).push(...pending.map((s) => s.id));
      handled.add(eventId);
      continue;
    }
    read++;
    try {
      const found = await recipe.results(entry, pending, recipeCtx(series, ctx));
      handled.add(eventId);
      if (!found) continue;
      if (found.deferred?.length) (out.deferred ??= []).push(...found.deferred);
      const ids = new Set(pending.map((s) => s.id));
      const sessions: SessionResult[] = found.sessions
        .filter((s) => ids.has(s.sessionId) && s.rows.length > 0)
        .map((s) => ({ sessionId: s.sessionId, rows: s.rows, ...(s.conditions ? { conditions: s.conditions } : {}), source: s.source ?? found.source }));
      if (sessions.length > 0) {
        out.results.push({ seriesId: series.id, eventId, updatedAt: nowIso, sessions });
        ctx.log.info(`Resultados ${entry.name}: ${sessions.length} sesión(es) (lectura directa)`);
      }
    } catch (err) {
      ctx.log.warn(`Resultados ${entry.name}: lectura directa fallida (${err instanceof Error ? err.message : String(err)}); se intenta con IA`);
    }
  }
  return handled;
}

/**
 * Campeonato con la receta del sitio. undefined si no hay receta o no pudo leer la página (se prueba con IA);
 * null si el sitio todavía no publica la tabla de la temporada.
 */
async function directStandings(series: Series, url: string, ctx: AdapterContext): Promise<StandingsFound | null | undefined> {
  const recipe = findRecipe(url);
  if (!recipe?.standings) return undefined;
  try {
    const found = await recipe.standings(url, recipeCtx(series, ctx));
    if (found) ctx.log.info(`Campeonato: ${found.tables.map((t) => `${t.title} (${t.rows.length})`).join(', ')} (lectura directa)`);
    return found;
  } catch (err) {
    ctx.log.warn(`Campeonato: lectura directa fallida (${err instanceof Error ? err.message : String(err)}); se intenta con IA`);
    return undefined;
  }
}

async function locateResults(series: Series, entry: CalendarEntry, ctx: AdapterContext): Promise<FetchedDocument | null> {
  if (entry.url) {
    const page = await tryFetch(ctx, entry.url);
    if (page) {
      const link = resultsLinks(page)[0];
      if (link) return tryFetch(ctx, link.url);
    }
  }
  const seriesLevel = series.officialUrls.slice(1).find((u) => RESULTS_RE.test(u) && !STANDINGS_RE.test(u));
  return seriesLevel ? tryFetch(ctx, seriesLevel) : null;
}

export const genericAdapter: Adapter = createGenericAdapter();
