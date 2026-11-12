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
import { classifySession } from '../core/builders.ts';
import type { Adapter, AdapterContext, ResultsChunk, ResultsRequest, ScheduleChunk } from '../core/types.ts';
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
/** Imágenes que se leen como máximo de una página de calendario y de una página/nota de cronograma. */
const MAX_CALENDAR_IMAGES = 16;
const MAX_TIMETABLE_IMAGES = 3;

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
  const recipe = findRecipe(series.officialUrls[0] ?? '');
  if (!recipe?.season) return ctx;
  try {
    const season = await recipe.season(recipeCtx(series, ctx));
    if (season === ctx.season) return ctx;
    ctx.log.info(`Temporada ${season}-${String(season + 1).slice(2)} (la que indica el sitio oficial)`);
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
  let read: FetchedDocument = doc;
  const trace = newTrace();
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
      entries = await aiCalendar(ai, series, doc, ctx.season, aiOpts);
      // Calendario publicado como imágenes (una por fecha, p. ej. Turismo Pista): se leen las imágenes.
      // (No si Gemini sí encontró eventos en el texto pero sin días concretos: las imágenes no los van a tener.)
      if (entries.length === 0 && dropped === 0 && doc.kind === 'html') {
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

/** Claves estables de evento: número de fecha/ronda si existe, si no el nombre; desambigua repetidos. */
export function eventKeys(entries: CalendarEntry[]): string[] {
  const keys = entries.map((e) => (e.round !== undefined ? `r${e.round}` : slugify(e.name)));
  return keys.map((k, i) => (keys.indexOf(k) !== i || keys.lastIndexOf(k) !== i ? `${k}|${entries[i]!.dateEnd}` : k));
}

export function createGenericAdapter(deps: GenericDeps = {}): Adapter {
  return {
    name: 'generic',

    prefersDirectStandings(series) {
      const url = series.officialUrls.slice(1).find((u) => STANDINGS_RE.test(u));
      return !!(url && findRecipe(url)?.standings);
    },

    async schedule(series, baseCtx): Promise<ScheduleChunk> {
      const ctx = await withSeriesSeason(series, baseCtx);
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
      let needsKey = 0;
      let unavailable = MISSING_KEY_MESSAGE;

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
        const inHorizon = entry.dateEnd >= from && entry.dateStart <= to;
        if (inHorizon) {
          try {
            found = await findSessions(series, entry, cal, ctx, deps);
          } catch (err) {
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
        }
      }
      if (needsKey > 0) {
        ctx.log.warn(`${unavailable}: ${needsKey} cronograma(s) dentro del horizonte quedan "a confirmar"`);
      }
      return { events, sessions };
    },

    async results(series, ctx, req): Promise<ResultsChunk> {
      return genericResults(series, await withSeriesSeason(series, ctx), req, deps);
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
  if (result.sessions.length === 0) return null;
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

/** Une un nombre de sesión transcripto con la sesión del cronograma. */
export function matchSession(name: string, candidates: Session[]): Session | undefined {
  const n = normalizeForMatch(name);
  const exact = candidates.find((c) => normalizeForMatch(c.name) === n);
  if (exact) return exact;
  const contains = candidates.filter((c) => {
    const cn = normalizeForMatch(c.name);
    return cn.includes(n) || n.includes(cn);
  });
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
      for (const eventId of eventOrder) {
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
        const data = await aiResults(ai, series, event.name, all.map((s) => s.name), doc, trace);
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
