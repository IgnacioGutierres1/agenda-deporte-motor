/**
 * Lector de FIA Fórmula 2 y Fórmula 3 desde sus sitios oficiales (fiaformula2.com / fiaformula3.com).
 *
 * REGLA F2: los horarios son SIEMPRE los publicados para F2/F3 (Practice, Qualifying, Sprint Race, Feature Race),
 * nunca se infieren de los de F1. Se leen del cronograma propio de cada ronda; mientras ese sitio muestra "TBC"
 * (suele pasar hasta pocos días antes), de las filas "FIA Formula 2"/"FIA Formula 3" del cronograma oficial del fin
 * de semana que publica formula1.com (ver f1-timetable.ts). Si ninguno lo publica, la ronda queda "pending".
 *
 * - Calendario: https://www.fiaformula2.com/en/racing/{season} (tarjetas "ROUND n" con link a cada ronda).
 * - Cronograma: https://www.fiaformula2.com/en/racing/{season}/{slug}; payload RSC `race.meetingSessions[]`.
 * - Resultados: la misma página embebe los resultados de la ÚLTIMA sesión con resultados (`meetingSessions[].results`);
 *   las demás sesiones (práctica, clasificación, sprint) se leen de los PDF de clasificación que publica la FIA en
 *   su tablero de documentos (ver fia-documents.ts).
 * - Campeonato: https://www.fiaformula2.com/en/standings/{season}/drivers y …/teams (payload RSC `standings[]`).
 */
import type { EventResultsFile, Series, SessionResult, StandingsRow, StandingsTable } from '@dm/shared';
import { HttpError } from '../core/http.ts';
import type { Adapter, AdapterContext, ResultsChunk, ScheduleChunk } from '../core/types.ts';
import {
  buildMeeting,
  calendarSlugs,
  classifyFom,
  decodeRscPayload,
  extractJson,
  extractMeeting,
  fomResultRows,
  htmlSource,
  isoNow,
  mapLimit,
  type FomMeeting,
  type FomSession,
  type MeetingBuild,
} from './fom.ts';
import { f1WeekendTimetable, pairByType, rowsFor, timetableSource, type WeekendTimetable } from './f1-timetable.ts';
import {
  classificationsBySession,
  fiaSeasonEvents,
  fomSessionKey,
  matchFiaEvent,
  parseClassificationItems,
  parseFiaDocumentList,
  pdfTextItems,
  withRosterNames,
  type FiaEventOption,
  type PdfItem,
  type RosterEntry,
} from './fia-documents.ts';

const SITES: Record<string, { base: string; label: string; f1Label: RegExp }> = {
  f2: { base: 'https://www.fiaformula2.com', label: 'FIA Formula 2', f1Label: /formula 2\b|^f2$/i },
  f3: { base: 'https://www.fiaformula3.com', label: 'FIA Formula 3', f1Label: /formula 3\b|^f3$/i },
};
const MAX_RESULT_FETCHES = 40;
/** PDFs de clasificación de la FIA por serie y corrida (alcanza para ponerse al día con una temporada entera). */
const MAX_PDF_FETCHES = 60;
/** Una clasificación provisoria solo se usa si pasaron estos días sin que se publique la final. */
const PROVISIONAL_AFTER_MS = 2 * 24 * 3600_000;
/** Fecha del último arreglo del lector de resultados (ver Adapter.resultsReaderSince). */
const RESULTS_READER_SINCE = '2026-11-12T12:00:00Z';
const UNCONFIRMED = /tbc|tba|tbd/i;

export function juniorSite(series: Series): { base: string; label: string; f1Label: RegExp } {
  const site = SITES[series.id];
  if (!site) throw new Error(`El lector fia-junior no conoce la serie "${series.id}" (solo f2 y f3)`);
  return site;
}

export function juniorCalendarUrl(series: Series, season: number): string {
  return `${juniorSite(series).base}/en/racing/${season}`;
}

/**
 * La sesión pertenece a la categoría pedida. Las sesiones de F2/F3 traen
 * value = "f2/practice?meeting=…"; si la página trajera otra categoría (p. ej. F1) se descarta.
 */
function isOwnSession(series: Series, s: FomSession): boolean {
  return !s.value || s.value.toLowerCase().startsWith(`${series.id}/`);
}

/** true si alguna sesión de la categoría todavía figura "TBC". */
function hasUnconfirmed(series: Series, meeting: FomMeeting | null): boolean {
  return !!meeting?.meetingSessions?.some((s) => isOwnSession(series, s) && UNCONFIRMED.test(s.sessionStatus ?? ''));
}

/**
 * Completa las sesiones "TBC" con las filas de la categoría en el cronograma del fin de semana. Las sesiones se
 * emparejan por tipo y en orden (Practice, Qualifying, Sprint Race, Feature Race); si no coinciden todas, no se
 * toca nada. Conserva nombres y códigos de la categoría, así los ids no cambian cuando el sitio confirme.
 */
function applyWeekendTimetable(
  series: Series,
  meeting: FomMeeting,
  timetable: WeekendTimetable,
): { meeting: FomMeeting; patched: Set<FomSession> } | null {
  const own = meeting.meetingSessions.filter((s) => isOwnSession(series, s));
  const pairs = pairByType(own, classifyFom, rowsFor(timetable, juniorSite(series).f1Label));
  if (!pairs) return null;
  const patched = new Set<FomSession>();
  const sessions = meeting.meetingSessions.map((s) => {
    const row = pairs.get(s);
    if (!row || !UNCONFIRMED.test(s.sessionStatus ?? '')) return s;
    // Hora local del circuito: sin el offset "TBC" de la fuente, se convierte con la zona (respeta horario de verano).
    const out: FomSession = { ...s, startTime: `${row.localDate}T${row.localStartText}:00`, timezone: timetable.tz, sessionStatus: 'Confirmed' };
    delete out.gmtOffset;
    delete out.endTime;
    if (row.localEnd) out.endTime = `${row.localEnd}:00`;
    patched.add(out);
    return out;
  });
  return { meeting: { ...meeting, meetingSessions: sessions }, patched };
}

export function parseJuniorRoundPage(
  html: string,
  slug: string,
  round: number | undefined,
  url: string,
  series: Series,
  ctx: AdapterContext,
  timetable?: WeekendTimetable | null,
): MeetingBuild & { meeting: FomMeeting; fromTimetable: boolean } {
  const { label } = juniorSite(series);
  let meeting = extractMeeting(html);
  if (!meeting || !Array.isArray(meeting.meetingSessions)) {
    throw new Error(`No se encontró el cronograma en ${url}`);
  }
  const applied = timetable ? applyWeekendTimetable(series, meeting, timetable) : null;
  if (applied) meeting = applied.meeting;
  const place = meeting.meetingLocation || meeting.circuitShortName || slug;
  const source = htmlSource(url, `${label} — Ronda ${round ?? '?'} ${place} ${ctx.season} (cronograma)`, ctx);
  const built = buildMeeting({
    series,
    ctx,
    meeting,
    key: slug,
    ...(round !== undefined ? { round } : {}),
    source,
    sessionName: (s) => s.shortName || s.description || s.session,
    accept: (s) => isOwnSession(series, s),
  });
  let fromTimetable = false;
  if (applied && timetable) {
    const ttSource = timetableSource(timetable, label, ctx.now);
    for (const session of built.sessions) {
      if (!applied.patched.has(built.bySessionId.get(session.id)!)) continue;
      session.source = ttSource;
      fromTimetable = true;
    }
  }
  return { ...built, meeting, fromTimetable };
}

async function loadRound(series: Series, ctx: AdapterContext, slug: string, round?: number) {
  const url = `${juniorSite(series).base}/en/racing/${ctx.season}/${slug}`;
  const html = (await ctx.http.text(url)).body;
  let timetable: WeekendTimetable | null = null;
  const meeting = extractMeeting(html);
  if (hasUnconfirmed(series, meeting) && meeting?.meetingStartDate && meeting.meetingEndDate) {
    try {
      timetable = await f1WeekendTimetable(
        ctx.http,
        ctx.season,
        meeting.meetingStartDate.slice(0, 10),
        meeting.meetingEndDate.slice(0, 10),
      );
    } catch (err) {
      ctx.log.warn(`${meeting.meetingName}: no se pudo leer el cronograma del fin de semana en formula1.com: ${(err as Error).message}`);
    }
  }
  return parseJuniorRoundPage(html, slug, round, url, series, ctx, timetable);
}

interface FomStanding {
  displayPosition?: string;
  position?: string;
  championshipPoints?: number;
  driverFirstName?: string;
  driverLastName?: string;
  driverShortName?: string;
  teamName?: string;
}

/** Tabla de campeonato desde el payload de la página de standings. */
export function parseJuniorStandings(html: string, title: string): StandingsTable {
  const rsc = decodeRscPayload(html);
  const list = extractJson<FomStanding[]>(rsc, '"standings":[{', '"standings":'.length);
  if (!list || list.length === 0) throw new Error(`No se encontró la tabla de campeonato (${title})`);
  const rows: StandingsRow[] = list
    .map((x, i) => {
      const pos = Number.parseInt(x.displayPosition ?? x.position ?? '', 10);
      const name =
        x.teamName ?? ([x.driverFirstName, x.driverLastName].filter(Boolean).join(' ').trim() || x.driverShortName || '');
      return { pos: Number.isFinite(pos) && pos > 0 ? pos : i + 1, name, points: x.championshipPoints ?? 0 };
    })
    .filter((r) => r.name);
  return { title, rows };
}

/** Número de auto -> piloto y equipo según el sitio de la categoría (resultados embebidos en la ronda). */
export function juniorRoster(meeting: FomMeeting): Map<string, RosterEntry> {
  const roster = new Map<string, RosterEntry>();
  for (const s of meeting.meetingSessions) {
    for (const r of s.results ?? []) {
      const driver = [r.driverFirstName, r.driverLastName].filter(Boolean).join(' ').trim();
      const team = r.displayTeamName || r.teamName;
      if (r.racingNumber && driver && !roster.has(r.racingNumber)) {
        roster.set(r.racingNumber, { driver, ...(team ? { team } : {}) });
      }
    }
  }
  return roster;
}

export interface FiaJuniorDeps {
  /** Texto posicionado de un PDF (inyectable en las pruebas). */
  pdfItems?: (bytes: Uint8Array) => Promise<PdfItem[]>;
}

export function createFiaJuniorAdapter(deps: FiaJuniorDeps = {}): Adapter {
  const pdfItems = deps.pdfItems ?? pdfTextItems;

  return {
    name: 'fia-junior',
    resultsReaderSince: RESULTS_READER_SINCE,

    async schedule(series, ctx): Promise<ScheduleChunk> {
      const calUrl = juniorCalendarUrl(series, ctx.season);
      const html = (await ctx.http.text(calUrl)).body;
      const entries = calendarSlugs(html, ctx.season);
      if (entries.length === 0) throw new Error(`No se encontraron rondas en ${calUrl}`);

      const rounds = await mapLimit(entries, 4, (e) => loadRound(series, ctx, e.slug, e.round));
      const chunk: ScheduleChunk = { events: [], sessions: [] };
      for (const r of rounds) {
        chunk.events.push(r.event);
        chunk.sessions.push(...r.sessions);
        if (r.event.sessionsStatus === 'pending') ctx.log.info(`${r.event.name}: horarios a confirmar (TBC)`);
        else if (r.fromTimetable) ctx.log.info(`${r.event.name}: horarios del cronograma oficial del fin de semana (formula1.com)`);
      }
      chunk.events.sort((a, b) => a.dateStart.localeCompare(b.dateStart));
      return chunk;
    },

    async results(series, ctx, req): Promise<ResultsChunk> {
      const { base, label } = juniorSite(series);
      const nowIso = isoNow(ctx.now);
      const eventsById = new Map(req.events.map((e) => [e.id, e]));
      const pendingIds = new Set(req.pendingSessions.map((s) => s.id));
      // Una página por evento con sesiones pendientes (de la más reciente a la más vieja).
      const eventIds = [...new Set(req.pendingSessions.map((s) => s.eventId))].slice(0, MAX_RESULT_FETCHES - 2);
      const files: EventResultsFile[] = [];
      let pdfBudget = MAX_PDF_FETCHES;
      // fia.com corta con 429 si se le piden muchos PDF seguidos: al primer aviso se deja de pedir en esta corrida y
      // esas sesiones quedan para la próxima sin gastar intentos (ver ResultsChunk.deferred).
      let throttled = false;
      const deferred: string[] = [];
      let fiaEvents: FiaEventOption[] | null = null;

      const loaded = await mapLimit(eventIds, 4, async (eventId) => {
        const event = eventsById.get(eventId);
        if (!event) return null;
        const slug = event.source.url.split('/').filter(Boolean).at(-1)!;
        try {
          return { event, slug, round: await loadRound(series, ctx, slug, event.round) };
        } catch (err) {
          ctx.log.warn(`No se pudo releer ${event.source.url}: ${(err as Error).message}`);
          return null;
        }
      });
      // Pilotos de todas las rondas leídas: un auto que no terminó la última carrera de su ronda (o un reemplazo)
      // suele figurar en otra; withRosterNames igual exige que coincida el apellido.
      const seasonRoster = new Map<string, RosterEntry>();
      for (const l of loaded) {
        for (const [n, entry] of l ? juniorRoster(l.round.meeting) : []) if (!seasonRoster.has(n)) seasonRoster.set(n, entry);
      }

      for (const l of loaded) {
        if (!l) continue;
        const { event, slug, round } = l;
        const eventId = event.id;
        const file: EventResultsFile = { seriesId: series.id, eventId, updatedAt: nowIso, sessions: [] };
        const missing: typeof round.sessions = [];
        for (const session of round.sessions) {
          const fom = round.bySessionId.get(session.id);
          const rows = fom?.results ? fomResultRows(fom.results) : [];
          if (rows.length > 0) {
            file.sessions.push({
              sessionId: session.id,
              rows,
              source: htmlSource(event.source.url, `${label} — ${event.name}: ${session.name} (resultados)`, ctx),
            });
          } else if (pendingIds.has(session.id)) {
            missing.push(session);
          }
        }

        // Las demás sesiones: clasificaciones en PDF del tablero de documentos de la FIA.
        if (missing.length > 0 && pdfBudget > 0) {
          try {
            fiaEvents ??= await fiaSeasonEvents(ctx.http, series.id, ctx.season);
            const option = matchFiaEvent(fiaEvents, round.meeting, slug);
            if (!option) {
              ctx.log.info(`${event.name}: la FIA no tiene tablero de documentos para el evento`);
            } else {
              const docs = classificationsBySession(parseFiaDocumentList((await ctx.http.text(option.url)).body), series.id);
              const roster = new Map([...seasonRoster, ...juniorRoster(round.meeting)]);
              const jobs = missing.flatMap((session) => {
                const key = fomSessionKey(round.bySessionId.get(session.id)!);
                const doc = key ? docs.get(key) : undefined;
                if (!doc) return [];
                const settled = ctx.now.getTime() - Date.parse(session.endUtc) > PROVISIONAL_AFTER_MS;
                if (doc.rank < 2 && !settled) return [];
                return [{ session, doc }];
              });
              const read = await mapLimit(jobs, 3, async ({ session, doc }): Promise<SessionResult | null> => {
                if (pdfBudget <= 0 || throttled) {
                  deferred.push(session.id);
                  return null;
                }
                pdfBudget--;
                try {
                  const bytes = (await ctx.http.bytes(doc.url)).body;
                  const rows = withRosterNames(parseClassificationItems(await pdfItems(bytes)), roster);
                  if (rows.length === 0) {
                    ctx.log.warn(`${event.name}: ${session.name}: el PDF de la FIA no tiene la tabla esperada (${doc.url})`);
                    return null;
                  }
                  return {
                    sessionId: session.id,
                    rows,
                    source: {
                      url: doc.url,
                      title: `FIA — ${label} ${event.name}: ${doc.title.replace(/^doc\s*\d+\s*-\s*/i, '')}`,
                      kind: 'pdf',
                      method: 'directo',
                      fetchedAt: nowIso,
                    },
                  };
                } catch (err) {
                  if (err instanceof HttpError && (err.status === 429 || err.status >= 500)) {
                    if (err.status === 429 && !throttled) ctx.log.warn(`La FIA pidió esperar (HTTP 429): los PDF que faltan quedan para la próxima corrida`);
                    throttled ||= err.status === 429;
                    deferred.push(session.id);
                    return null;
                  }
                  ctx.log.warn(`${event.name}: ${session.name}: no se pudo leer ${doc.url}: ${(err as Error).message}`);
                  return null;
                }
              });
              for (const r of read) if (r) file.sessions.push(r);
            }
          } catch (err) {
            ctx.log.warn(`${event.name}: no se pudo leer el tablero de documentos de la FIA: ${(err as Error).message}`);
          }
        }
        if (file.sessions.length > 0) files.push(file);
      }

      const chunk: ResultsChunk = { results: files, ...(deferred.length ? { deferred } : {}) };
      if (req.standingsStale) {
        const driversUrl = `${base}/en/standings/${ctx.season}/drivers`;
        const teamsUrl = `${base}/en/standings/${ctx.season}/teams`;
        const [drivers, teams] = await Promise.all([ctx.http.text(driversUrl), ctx.http.text(teamsUrl)]);
        chunk.standings = {
          seriesId: series.id,
          season: ctx.season,
          updatedAt: nowIso,
          tables: [parseJuniorStandings(drivers.body, 'Pilotos'), parseJuniorStandings(teams.body, 'Equipos')],
          source: htmlSource(driversUrl, `${label} — Campeonato ${ctx.season}`, ctx),
        };
      }
      return chunk;
    },
  };
}

export const fiaJuniorAdapter: Adapter = createFiaJuniorAdapter();
