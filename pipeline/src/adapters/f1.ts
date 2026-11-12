/**
 * Lector de Fórmula 1 desde formula1.com.
 *
 * - Calendario: https://www.formula1.com/en/racing/{season} (links a cada ronda).
 * - Cronograma: página de cada ronda (https://www.formula1.com/en/racing/{season}/{slug});
 *   el payload RSC trae `race.meetingSessions[]` con hora local, offset GMT, fin y zona IANA.
 * - Resultados: https://www.formula1.com/en/results/{season}/races/{meetingKey}/{slug}/{sesión}
 *   (tabla HTML).
 * - Campeonato: https://www.formula1.com/en/results/{season}/drivers y …/team (tablas HTML).
 */
import type { EventResultsFile, Series, SessionResult, StandingsRow, StandingsTable } from '@dm/shared';
import type { Adapter, AdapterContext, ResultsChunk, ScheduleChunk } from '../core/types.ts';
import {
  buildMeeting,
  calendarSlugs,
  columnIndex,
  extractMeeting,
  fetchOptional,
  htmlResultRows,
  htmlSource,
  isoNow,
  mapLimit,
  parseHtmlTables,
  type FomMeeting,
  type FomSession,
  type MeetingBuild,
} from './fom.ts';

export const F1_BASE = 'https://www.formula1.com';
/** Tope de páginas por corrida para resultados y campeonato. */
const MAX_RESULT_FETCHES = 40;

export function f1CalendarUrl(season: number): string {
  return `${F1_BASE}/en/racing/${season}`;
}

function isTesting(m: FomMeeting, slug: string): boolean {
  return m.isTestEvent === true || /testing/i.test(slug) || /T\d+$/.test(m.meetingCode ?? '');
}

/** Arma evento y sesiones a partir del HTML de la página de una ronda. */
export function parseF1RoundPage(
  html: string,
  slug: string,
  url: string,
  series: Series,
  ctx: AdapterContext,
): MeetingBuild & { meeting: FomMeeting } {
  const meeting = extractMeeting(html);
  if (!meeting || !Array.isArray(meeting.meetingSessions)) {
    throw new Error(`No se encontró el cronograma en ${url}`);
  }
  const testing = isTesting(meeting, slug);
  const round = !testing && meeting.meetingNumber ? Number(meeting.meetingNumber) : undefined;
  const source = htmlSource(url, `Formula 1 — ${meeting.meetingOfficialName || meeting.meetingName} (cronograma)`, ctx);
  const built = buildMeeting({
    series,
    ctx,
    meeting,
    key: slug,
    ...(round !== undefined && Number.isFinite(round) ? { round } : {}),
    ...(testing ? { kind: 'test' as const } : {}),
    source,
    sessionName: (s) => s.description || s.shortName || s.session,
  });
  return { ...built, meeting };
}

async function loadRound(series: Series, ctx: AdapterContext, slug: string) {
  const url = `${F1_BASE}/en/racing/${ctx.season}/${slug}`;
  const html = (await ctx.http.text(url)).body;
  return { html, ...parseF1RoundPage(html, slug, url, series, ctx) };
}

/** Ruta de resultados de formula1.com para un código de sesión. */
export function f1ResultsPath(s: FomSession): string | null {
  const code = s.session.toLowerCase();
  const p = code.match(/^p(\d)$/);
  if (p) return `practice/${p[1]}`;
  if (code === 'q') return 'qualifying';
  if (code === 'ss' || code === 'sq') return 'sprint-qualifying';
  if (code === 's') return 'sprint-results';
  if (code === 'r') return 'race-result';
  return null;
}

/** Slug que usa la sección de resultados para la ronda (se toma de los links de la página). */
export function f1ResultsBase(html: string, season: number, meeting: FomMeeting, slug: string): string | null {
  if (!meeting.meetingKey) return null;
  const re = new RegExp(`/en/results/${season}/races/${meeting.meetingKey}/([a-z0-9-]+)/`);
  const resultsSlug = html.match(re)?.[1] ?? slug;
  return `${F1_BASE}/en/results/${season}/races/${meeting.meetingKey}/${resultsSlug}`;
}

/** Tablas de campeonato de pilotos o constructores. */
export function parseF1Standings(html: string, title: string): StandingsTable {
  const table = parseHtmlTables(html)[0];
  if (!table) throw new Error(`No se encontró la tabla de campeonato (${title})`);
  const h = table.headers;
  const iPos = columnIndex(h, /^pos/i);
  const iDriver = columnIndex(h, /^driver/i);
  const iTeam = columnIndex(h, /^team/i);
  const iPts = columnIndex(h, /^pts|^points/i);
  const iName = iDriver >= 0 ? iDriver : iTeam;
  if (iName < 0 || iPts < 0) throw new Error(`Tabla de campeonato con columnas inesperadas: ${h.join(', ')}`);
  const rows: StandingsRow[] = table.rows
    .map((r, i) => {
      const pos = Number.parseInt(r[iPos] ?? '', 10);
      const row: StandingsRow = {
        pos: Number.isFinite(pos) && pos > 0 ? pos : i + 1,
        name: r[iName] ?? '',
        points: Number(r[iPts] ?? 0) || 0,
      };
      if (iDriver >= 0 && iTeam >= 0 && r[iTeam]) row.team = r[iTeam];
      return row;
    })
    .filter((r) => r.name);
  if (rows.length === 0) throw new Error(`Tabla de campeonato vacía (${title})`);
  return { title, rows };
}

export const f1Adapter: Adapter = {
  name: 'f1',

  async schedule(series, ctx): Promise<ScheduleChunk> {
    const calUrl = f1CalendarUrl(ctx.season);
    const html = (await ctx.http.text(calUrl)).body;
    const slugs = calendarSlugs(html, ctx.season).map((x) => x.slug);
    if (slugs.length === 0) throw new Error(`No se encontraron rondas en ${calUrl}`);

    const rounds = await mapLimit(slugs, 4, (slug) => loadRound(series, ctx, slug));
    const chunk: ScheduleChunk = { events: [], sessions: [] };
    for (const r of rounds) {
      chunk.events.push(r.event);
      chunk.sessions.push(...r.sessions);
      if (r.event.sessionsStatus === 'pending') ctx.log.info(`${r.event.name}: horarios a confirmar`);
    }
    chunk.events.sort((a, b) => a.dateStart.localeCompare(b.dateStart));
    return chunk;
  },

  async results(series, ctx, req): Promise<ResultsChunk> {
    let budget = MAX_RESULT_FETCHES - (req.standingsStale ? 2 : 0);
    const nowIso = isoNow(ctx.now);
    const files = new Map<string, EventResultsFile>();
    const eventsById = new Map(req.events.map((e) => [e.id, e]));
    const rounds = new Map<string, Awaited<ReturnType<typeof loadRound>> | null>();

    for (const pending of req.pendingSessions) {
      if (budget <= 0) break;
      const event = eventsById.get(pending.eventId);
      if (!event) continue;
      const slug = event.source.url.split('/').filter(Boolean).at(-1)!;
      if (!rounds.has(event.id)) {
        budget--; // normalmente ya está en la caché de la corrida
        rounds.set(event.id, await loadRound(series, ctx, slug).catch((err: Error) => {
          ctx.log.warn(`No se pudo releer ${event.source.url}: ${err.message}`);
          return null;
        }));
      }
      const round = rounds.get(event.id);
      const fom = round?.bySessionId.get(pending.id);
      if (!round || !fom) continue;
      const path = f1ResultsPath(fom);
      const base = f1ResultsBase(round.html, ctx.season, round.meeting, slug);
      if (!path || !base || isTesting(round.meeting, slug)) continue;

      const url = `${base}/${path}`;
      budget--;
      const html = await fetchOptional(ctx, url);
      if (!html) continue;
      const table = parseHtmlTables(html)[0];
      const rows = table ? htmlResultRows(table) : [];
      if (rows.length === 0) continue;

      const result: SessionResult = {
        sessionId: pending.id,
        rows,
        source: htmlSource(url, `Formula 1 — ${event.name}: ${pending.name} (resultados)`, ctx),
      };
      const file = files.get(event.id) ?? { seriesId: series.id, eventId: event.id, updatedAt: nowIso, sessions: [] };
      file.sessions.push(result);
      files.set(event.id, file);
    }

    const chunk: ResultsChunk = { results: [...files.values()] };
    if (req.standingsStale) {
      const driversUrl = `${F1_BASE}/en/results/${ctx.season}/drivers`;
      const teamsUrl = `${F1_BASE}/en/results/${ctx.season}/team`;
      const [drivers, teams] = await Promise.all([ctx.http.text(driversUrl), ctx.http.text(teamsUrl)]);
      chunk.standings = {
        seriesId: series.id,
        season: ctx.season,
        updatedAt: nowIso,
        tables: [parseF1Standings(drivers.body, 'Pilotos'), parseF1Standings(teams.body, 'Constructores')],
        source: htmlSource(driversUrl, `Formula 1 — Campeonato ${ctx.season}`, ctx),
      };
    }
    return chunk;
  },
};
