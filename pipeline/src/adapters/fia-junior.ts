/**
 * Lector de FIA Fórmula 2 y Fórmula 3 desde sus sitios oficiales (fiaformula2.com / fiaformula3.com).
 *
 * REGLA F2: los horarios se leen SIEMPRE del cronograma propio de F2/F3 de cada ronda
 * (Practice, Qualifying, Sprint Race, Feature Race), nunca se infieren de los de F1.
 * Mientras el sitio muestra "TBC" la ronda queda con sessionsStatus "pending" y sin sesiones.
 *
 * - Calendario: https://www.fiaformula2.com/en/racing/{season} (tarjetas "ROUND n" con link a cada ronda).
 * - Cronograma: https://www.fiaformula2.com/en/racing/{season}/{slug}; payload RSC `race.meetingSessions[]`.
 * - Resultados: la misma página embebe los resultados de la última sesión con resultados
 *   (`meetingSessions[].results`), así que cada corrida del fin de semana captura la sesión recién terminada.
 * - Campeonato: https://www.fiaformula2.com/en/standings/{season}/drivers y …/teams (payload RSC `standings[]`).
 */
import type { EventResultsFile, Series, StandingsRow, StandingsTable } from '@dm/shared';
import type { Adapter, AdapterContext, ResultsChunk, ScheduleChunk } from '../core/types.ts';
import {
  buildMeeting,
  calendarSlugs,
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

const SITES: Record<string, { base: string; label: string }> = {
  f2: { base: 'https://www.fiaformula2.com', label: 'FIA Formula 2' },
  f3: { base: 'https://www.fiaformula3.com', label: 'FIA Formula 3' },
};
const MAX_RESULT_FETCHES = 40;

export function juniorSite(series: Series): { base: string; label: string } {
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

export function parseJuniorRoundPage(
  html: string,
  slug: string,
  round: number | undefined,
  url: string,
  series: Series,
  ctx: AdapterContext,
): MeetingBuild & { meeting: FomMeeting } {
  const { label } = juniorSite(series);
  const meeting = extractMeeting(html);
  if (!meeting || !Array.isArray(meeting.meetingSessions)) {
    throw new Error(`No se encontró el cronograma en ${url}`);
  }
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
  return { ...built, meeting };
}

async function loadRound(series: Series, ctx: AdapterContext, slug: string, round?: number) {
  const url = `${juniorSite(series).base}/en/racing/${ctx.season}/${slug}`;
  const html = (await ctx.http.text(url)).body;
  return parseJuniorRoundPage(html, slug, round, url, series, ctx);
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

export const fiaJuniorAdapter: Adapter = {
  name: 'fia-junior',

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
    }
    chunk.events.sort((a, b) => a.dateStart.localeCompare(b.dateStart));
    return chunk;
  },

  async results(series, ctx, req): Promise<ResultsChunk> {
    const { base, label } = juniorSite(series);
    const nowIso = isoNow(ctx.now);
    const eventsById = new Map(req.events.map((e) => [e.id, e]));
    // Una página por evento con sesiones pendientes (de la más reciente a la más vieja).
    const eventIds = [...new Set(req.pendingSessions.map((s) => s.eventId))].slice(0, MAX_RESULT_FETCHES - 2);
    const files: EventResultsFile[] = [];

    for (const eventId of eventIds) {
      const event = eventsById.get(eventId);
      if (!event) continue;
      const slug = event.source.url.split('/').filter(Boolean).at(-1)!;
      let round: Awaited<ReturnType<typeof loadRound>>;
      try {
        round = await loadRound(series, ctx, slug, event.round);
      } catch (err) {
        ctx.log.warn(`No se pudo releer ${event.source.url}: ${(err as Error).message}`);
        continue;
      }
      const file: EventResultsFile = { seriesId: series.id, eventId, updatedAt: nowIso, sessions: [] };
      for (const session of round.sessions) {
        const fom = round.bySessionId.get(session.id);
        const rows = fom?.results ? fomResultRows(fom.results) : [];
        if (rows.length === 0) continue;
        file.sessions.push({
          sessionId: session.id,
          rows,
          source: htmlSource(event.source.url, `${label} — ${event.name}: ${session.name} (resultados)`, ctx),
        });
      }
      if (file.sessions.length > 0) files.push(file);
    }

    const chunk: ResultsChunk = { results: files };
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
