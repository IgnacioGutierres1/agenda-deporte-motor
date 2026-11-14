/**
 * Lector directo de SCORE International: el campeonato del desierto de Baja California (San Felipe 250 / Baja 250,
 * Baja 500, Baja 400 y Baja 1000). Todo sale de sitios oficiales de SCORE, sin IA:
 *
 * score-raceinfo.com (WordPress de "Race Info" de SCORE; se lee por su API REST pública, /wp-json/wp/v2):
 *   - Búsqueda de páginas por título: "{año} Race Schedule" (calendario de la temporada), "Schedule of Events –
 *     {año} {carrera}" (cronograma), "Race Info – {año} {carrera}" (información de la carrera) y "Course Map –
 *     {año} {carrera}" (mapa del recorrido). Cada página embebe un PDF (visor "pdfemb": ?url=…pdf).
 *   - Calendario (PDF): carreras de la temporada en curso y de la siguiente, con sede, fechas y distancia aproximada.
 *   - Cronograma (PDF): clasificación (Trophy Truck y las otras clases que clasifican), contingencia e inspección
 *     técnica de cada día, largada de motos y cuatriciclos, largada de los autos ("4-wheel"), tiempo límite y
 *     premiación, en hora local.
 *   - Información de la carrera (PDF): tabla de puestos de control de los autos con la milla de carrera (race mile),
 *     los kilómetros y las horas aproximadas de paso y de cierre. Es el itinerario de data/stages/score-baja: un
 *     sector por tramo entre puestos.
 *   - Mapa del recorrido: la página "Course Map" publica un PDF (se enlaza). Para la carrera en curso, la portada
 *     de score-international.com publica además la imagen del mapa, que la app puede mostrar.
 * results.score-international.com (LiveTime Scoring, el cronometraje oficial): resultados por clase de la
 *   clasificación y de cada carrera (score-results.ts).
 *
 * Zonas horarias: las carreras de Baja California (Ensenada, San Felipe, Mexicali) usan America/Tijuana (con horario
 * de verano, como California); las de Baja California Sur (San José del Cabo, La Paz), America/Mazatlan (UTC-7 todo
 * el año).
 *
 * Fin de cada carrera: el tiempo límite oficial (p. ej. 40 horas en la Baja 1000) desde la largada: es el cierre de
 * la carrera. Sin hora de fin publicada (clasificación, premiación) se estima con config/durations.json.
 *
 * Superficie: carreras de desierto, "arena" como el Dakar (el sitio no publica un desglose por terreno).
 */
import { DateTime } from 'luxon';
import { parse } from 'node-html-parser';
import {
  addMinutes,
  localToUtc,
  type EventResultsFile,
  type EventStagesFile,
  type MotorEvent,
  type RallyStage,
  type ResultRow,
  type Series,
  type Session,
  type SessionResult,
  type SessionType,
  type Source,
} from '@dm/shared';
import { HttpError } from '../core/http.ts';
import type { Adapter, AdapterContext, ResultsChunk, ScheduleChunk } from '../core/types.ts';
import { pdfTextItems, type PdfItem } from './fia-documents.ts';
import {
  checkpointClock,
  parseScoreCalendar,
  parseScoreCheckpoints,
  parseScoreSchedule,
  scoreRaceKey,
  weekdayFrom,
  type ScoreCalendarRace,
  type ScoreCheckpoint,
  type ScoreEventSchedule,
  type ScoreScheduleItem,
} from './score-docs.ts';
import {
  parseLiveTimeEventPage,
  parseLiveTimeEvents,
  parseLiveTimeResult,
  SCORE_RESULTS_EVENTS_URL,
  type LiveTimeRace,
} from './score-results.ts';
import { directSource, fetchedAt } from './util.ts';

export const SCORE_SITE = 'https://score-international.com';
export const SCORE_INFO_SITE = 'https://score-raceinfo.com';
const WP_API = `${SCORE_INFO_SITE}/wp-json/wp/v2`;

/** Búsqueda de páginas de score-raceinfo.com por título (la API devuelve hasta 100, las más relevantes primero). */
export const scoreSearchUrl = (query: string): string =>
  `${WP_API}/search?search=${encodeURIComponent(query)}&subtype=page&per_page=100&_fields=id,title,url`;
export const scorePageUrl = (id: number): string => `${WP_API}/pages/${id}?_fields=id,link,modified,content`;

/** Consultas de búsqueda de cada tipo de documento. */
export const SCORE_QUERIES = {
  calendar: 'Race Schedule',
  schedule: 'Schedule of Events',
  raceInfo: 'Race Info',
  courseMap: 'Course Map',
} as const;

/** Tope de páginas de resultados por corrida (cada una pesa ~1 MB: trae las vueltas y los sectores de todos). */
const MAX_RESULT_FETCHES = 8;
const MI_DECIMALS = new Intl.NumberFormat('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ─── Páginas de score-raceinfo.com ───────────────────────────────────────────────────────────

export interface WpHit {
  id: number;
  /** Título ya decodificado ("Schedule of Events – 2026 Baja 1000"). */
  title: string;
  url: string;
}

const decode = (s: string): string => parse(`<p>${s}</p>`).text.replace(/\s+/g, ' ').trim();

export function parseWpSearch(json: unknown): WpHit[] {
  if (!Array.isArray(json)) return [];
  return json.flatMap((h: { id?: unknown; title?: unknown; url?: unknown }) =>
    typeof h.id === 'number' && typeof h.title === 'string' && typeof h.url === 'string' ? [{ id: h.id, title: decode(h.title), url: h.url }] : [],
  );
}

/**
 * Página de un tipo de documento para una carrera: el título lleva el año y nombra la carrera ("Race Information –
 * 2026 San Felipe 250", "Race Info – 2025 SF250"). La versión en español del cronograma no se usa.
 */
export function findScoreDoc(hits: WpHit[], kind: RegExp, year: number, key: string): WpHit | undefined {
  return hits.find(
    (h) => kind.test(h.title) && !/spanish|español/i.test(h.title) && new RegExp(`\\b${year}\\b`).test(h.title) && scoreRaceKey(h.title.replace(/\b20\d{2}\b/g, ' ')) === key,
  );
}

const DOC_KIND = {
  schedule: /^schedule of events\b/i,
  raceInfo: /\brace info(?:rmation)?\b/i,
  courseMap: /^course map\b/i,
};

/** Calendario de una temporada: "2027 Race Schedule", "2023 SCORE Race Schedule". */
export function findScoreCalendar(hits: WpHit[], year: number): WpHit | undefined {
  return hits.find((h) => new RegExp(`^${year}\\s+(?:SCORE\\s+)?Race Schedule$`, 'i').test(h.title));
}

/** Documento embebido en una página: el PDF del visor (…?url=https%3A…pdf), un link a un PDF o una imagen subida. */
export function wpDocumentUrl(contentHtml: string): string | null {
  const embedded = contentHtml.match(/[?&]url=(https?%3A%2F%2F[^&"']+?\.pdf)/i);
  if (embedded) return decodeURIComponent(embedded[1]!);
  const link = contentHtml.match(/href=["'](https?:\/\/[^"']+\/wp-content\/uploads\/[^"']+\.pdf)["']/i);
  if (link) return link[1]!;
  // Imagen de la página (no las miniaturas "-200x182" del carrusel de carreras).
  for (const m of contentHtml.matchAll(/<img[^>]+src=["'](https?:\/\/[^"']+\/wp-content\/uploads\/[^"']+\.(?:jpe?g|png))["']/gi)) {
    if (!/-\d{2,4}x\d{2,4}\.\w+$/.test(m[1]!)) return m[1]!;
  }
  return null;
}

interface WpPage {
  link: string;
  modified?: string;
  docUrl: string | null;
}

async function wpPage(ctx: AdapterContext, id: number): Promise<WpPage> {
  const { body } = await ctx.http.json<{ link?: string; modified?: string; content?: { rendered?: string } }>(scorePageUrl(id));
  return { link: body.link ?? `${SCORE_INFO_SITE}/?page_id=${id}`, ...(body.modified ? { modified: body.modified } : {}), docUrl: wpDocumentUrl(body.content?.rendered ?? '') };
}

// ─── Sede y zona horaria ─────────────────────────────────────────────────────────────────────

const PLACE_FIXES: Record<string, string> = {
  'san jose del cabo': 'San José del Cabo',
  'la paz': 'La Paz',
};

const cityOf = (text: string): string => {
  const city = text
    .split(',')[0]!
    .replace(/\s+B\.?\s*C\.?\s*S?\.?$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  return PLACE_FIXES[city.toLowerCase()] ?? city;
};

/**
 * Sede para mostrar: "San Jose Del Cabo, Baja California Sur" -> "San José del Cabo"; "Peninsula Run – Ensenada B.C.
 * to End TBA" (de punta a punta de la península) -> "Ensenada > a confirmar".
 */
export function scoreVenue(place: string): string {
  const p = place.replace(/^peninsula run\s*[–-]\s*/i, '');
  const run = p.match(/^(.+?)\s+to\s+(.+)$/i);
  if (run) return `${cityOf(run[1]!)} > ${/\b(?:tba|tbd)\b/i.test(run[2]!) ? 'a confirmar' : cityOf(run[2]!)}`;
  return cityOf(p) || 'A confirmar';
}

/** Baja California Sur no cambia la hora (UTC-7); Baja California sigue el horario de verano de California. */
export function scoreTimeZone(place: string): string {
  return /baja california sur|\bb\.?\s?c\.?\s?s\b|cabo|la paz|loreto/i.test(place) ? 'America/Mazatlan' : 'America/Tijuana';
}

// ─── Sesiones ────────────────────────────────────────────────────────────────────────────────

const SESSION_NAMES: Record<ScoreScheduleItem['kind'], { type: SessionType; name: string }> = {
  clasificacion: { type: 'clasificacion', name: 'Clasificación' },
  tecnica: { type: 'otro', name: 'Contingencia e inspección técnica' },
  'largada-motos': { type: 'carrera', name: 'Carrera de motos y cuatriciclos' },
  'largada-autos': { type: 'carrera', name: 'Carrera de autos, camionetas y UTV' },
  largada: { type: 'carrera', name: 'Carrera' },
  premiacion: { type: 'otro', name: 'Premiación' },
};

const isMotoSession = (s: Pick<Session, 'name'>): boolean => /motos/i.test(s.name);

function buildSessions(
  ctx: AdapterContext,
  event: MotorEvent,
  schedule: ScoreEventSchedule,
  source: Source,
): Session[] {
  const sessions: Session[] = [];
  for (const item of schedule.items) {
    const { type, name } = SESSION_NAMES[item.kind];
    const startUtc = localToUtc(item.date, item.start, event.tz);
    let endUtc: string | undefined;
    if (type === 'carrera' && schedule.timeLimitHours) endUtc = addMinutes(startUtc, schedule.timeLimitHours * 60);
    else if (item.end) {
      endUtc = localToUtc(item.date, item.end, event.tz);
      if (endUtc <= startUtc) endUtc = undefined;
    }
    sessions.push(
      ctx.build.session({
        event,
        type,
        name,
        startUtc,
        ...(endUtc ? { endUtc } : {}),
        localStartText: item.start,
        source,
        // Contingencia e inspección técnica puede durar dos días (mismo nombre): la fecha distingue el id.
        ...(item.kind === 'tecnica' ? { key: item.date } : {}),
      }),
    );
  }
  return sessions.sort((a, b) => a.startUtc.localeCompare(b.startUtc));
}

// ─── Itinerario (puestos de control) ─────────────────────────────────────────────────────────

const DAY_ES: Record<string, string> = { mo: 'lun', tu: 'mar', we: 'mié', th: 'jue', fr: 'vie', sa: 'sáb', su: 'dom' };
const round2 = (n: number): number => Math.round(n * 100) / 100;
const fmtMi = (n: number): string => MI_DECIMALS.format(n);

const pointName = (cp: ScoreCheckpoint): string => cp.place.replace(/^timing\b\s*[–-]?\s*/i, '').trim() || 'Cronometraje';
const isTiming = (cp: ScoreCheckpoint): boolean => /^timing\b/i.test(cp.place);
/** "el control de cronometraje de Rancho Nelson" (o sin lugar, si el PDF solo dice "Timing"). */
const timingText = (cp: ScoreCheckpoint): string => {
  const name = pointName(cp);
  return name === 'Cronometraje' ? 'el control de cronometraje' : `el control de cronometraje de ${name}`;
};
const timeText = (t: { time: string; day: string }): string => {
  const clock = checkpointClock(t.time) ?? t.time;
  const day = DAY_ES[t.day.slice(0, 2).toLowerCase()];
  return day ? `${clock} (${day})` : clock;
};

/**
 * Sectores entre puestos de control: largada > puesto 1 > … > llegada. Los controles de cronometraje del arranque
 * (a menos de 2 millas de la largada) no cortan un sector. Si el último control antes de la llegada es de
 * cronometraje, la llegada cronometrada es ahí y el último tramo es un enlace (sin cronometrar).
 */
export function checkpointStages(
  rows: ScoreCheckpoint[],
  raceDate: string,
  start?: { startUtc: string; localStartText: string },
  timeLimitHours?: number,
): RallyStage[] {
  if (rows.length < 2) return [];
  const points = rows.filter((r, i) => i === 0 || i === rows.length - 1 || r.mi >= 2);
  const stages: RallyStage[] = [];
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]!;
    const to = points[i]!;
    const last = i === points.length - 1;
    const liaison = last && i > 1 && isTiming(from);
    const km = round2(to.km - from.km);
    const target = last ? 'la llegada' : isTiming(to) ? timingText(to) : `el puesto de control ${to.code} (${pointName(to)})`;
    const notes = [`Hasta ${target}, en la milla ${fmtMi(to.mi)} de carrera.`];
    if (to.times.length) {
      const first = to.times[0]!;
      const close = to.times.length > 1 ? to.times[to.times.length - 1]! : null;
      notes.push(`Paso estimado del primero: ${timeText(first)}${close ? `; cierre: ${timeText(close)}` : ''} (hora local).`);
    }
    if (liaison) notes.push(`Sin cronometrar: la llegada cronometrada es en ${timingText(from)}.`);
    if (i === 1 && timeLimitHours) notes.push(`Tiempo límite de la carrera: ${timeLimitHours} horas.`);
    const day = from.times[0]?.day;
    stages.push({
      code: `Sector ${i}`,
      name: `${pointName(from)} > ${pointName(to)}`,
      kind: liaison ? 'enlace' : 'especial',
      date: day ? weekdayFrom(raceDate, day) : raceDate,
      ...(i === 1 && start ? { startUtc: start.startUtc, localStartText: start.localStartText } : {}),
      ...(km > 0 ? (liaison ? { liaisonKm: km } : { distanceKm: km }) : {}),
      note: notes.join(' '),
    });
  }
  return stages;
}

// ─── Mapa de la portada ──────────────────────────────────────────────────────────────────────

/** Imagen del mapa de la carrera en la portada de score-international.com (solo la de la carrera en curso). */
export function homepageMapUrl(html: string, year: number, key: string): string | null {
  const root = parse(html);
  for (const img of root.querySelectorAll('img[src*="race-maps"]')) {
    const alt = img.getAttribute('alt') ?? '';
    if (!new RegExp(`\\b${year}\\b`).test(alt) || scoreRaceKey(alt.replace(/\b20\d{2}\b/g, ' ')) !== key) continue;
    // La imagen de la portada (~0,5 MB); el link de alrededor lleva a la de alta resolución (~4 MB, pesada para el celular).
    const href = img.getAttribute('src') ?? '';
    try {
      return new URL(href, `${SCORE_SITE}/index.php`).toString();
    } catch {
      return null;
    }
  }
  return null;
}

// ─── Lector ──────────────────────────────────────────────────────────────────────────────────

export interface ScoreDeps {
  /** Texto posicionado de un PDF (inyectable en las pruebas). */
  pdfItems?: (bytes: Uint8Array) => Promise<PdfItem[]>;
}

interface DocIndex {
  calendar: WpHit[];
  schedule: WpHit[];
  raceInfo: WpHit[];
  courseMap: WpHit[];
}

export function createScoreAdapter(deps: ScoreDeps = {}): Adapter {
  const pdfItems = deps.pdfItems ?? pdfTextItems;

  async function search(ctx: AdapterContext, query: string): Promise<WpHit[]> {
    return parseWpSearch((await ctx.http.json<unknown>(scoreSearchUrl(query))).body);
  }

  async function pdfOf(ctx: AdapterContext, url: string): Promise<PdfItem[]> {
    return pdfItems((await ctx.http.bytes(url)).body);
  }

  /** PDF embebido en una página de score-raceinfo.com, con la dirección de la página. */
  async function pageDoc(ctx: AdapterContext, hit: WpHit): Promise<{ page: WpPage; items: PdfItem[] } | null> {
    const page = await wpPage(ctx, hit.id);
    if (!page.docUrl || !/\.pdf$/i.test(page.docUrl)) return null;
    return { page, items: await pdfOf(ctx, page.docUrl) };
  }

  async function loadRace(
    series: Series,
    ctx: AdapterContext,
    race: ScoreCalendarRace,
    season: number,
    calendarSource: Source,
    docs: DocIndex,
    homepage: () => Promise<string | null>,
  ): Promise<{ event: MotorEvent; sessions: Session[]; stages?: EventStagesFile }> {
    const tz = scoreTimeZone(race.place);
    const label = `${season} ${race.name}`;
    const baseEvent = (sessionsStatus: MotorEvent['sessionsStatus'], stageCount?: number, source: Source = calendarSource) =>
      ctx.build.event({
        series,
        season,
        key: race.key,
        name: race.name,
        circuit: scoreVenue(race.place),
        country: 'México',
        tz,
        dateStart: race.dateStart,
        dateEnd: race.dateEnd,
        sessionsStatus,
        surface: 'arena',
        ...(stageCount ? { stageCount } : {}),
        source,
      });

    // Cronograma con horarios.
    let schedule: ScoreEventSchedule | null = null;
    let scheduleSource: Source | null = null;
    const scheduleHit = findScoreDoc(docs.schedule, DOC_KIND.schedule, season, race.key);
    if (scheduleHit) {
      try {
        const doc = await pageDoc(ctx, scheduleHit);
        if (doc) {
          schedule = parseScoreSchedule(doc.items, race);
          scheduleSource = directSource(ctx, doc.page.link, `SCORE International – Cronograma ${label}`, 'pdf');
          if (!schedule.items.length) ctx.log.warn(`${label}: el cronograma no trae horarios reconocibles (${doc.page.docUrl})`);
        }
      } catch (err) {
        ctx.log.warn(`${label}: no se pudo leer el cronograma (${errorText(err)})`);
      }
    }

    // Puestos de control y mapa.
    let checkpoints: ScoreCheckpoint[] = [];
    let infoSource: Source | null = null;
    const infoHit = findScoreDoc(docs.raceInfo, DOC_KIND.raceInfo, season, race.key);
    if (infoHit) {
      try {
        const doc = await pageDoc(ctx, infoHit);
        if (doc) {
          checkpoints = parseScoreCheckpoints(doc.items);
          infoSource = directSource(ctx, doc.page.link, `SCORE International – Race Info ${label}`, 'pdf');
          if (checkpoints.length < 2) ctx.log.warn(`${label}: la información de la carrera no trae la tabla de puestos de control`);
        }
      } catch (err) {
        ctx.log.warn(`${label}: no se pudo leer la información de la carrera (${errorText(err)})`);
      }
    }
    let mapUrl: string | null = null;
    const today = ctx.now.toISOString().slice(0, 10);
    const current = race.dateEnd >= DateTime.fromISO(today).minus({ days: 7 }).toISODate()! && race.dateStart <= DateTime.fromISO(today).plus({ days: 60 }).toISODate()!;
    if (current) {
      const html = await homepage();
      if (html) mapUrl = homepageMapUrl(html, season, race.key);
    }
    const mapHit = mapUrl ? undefined : findScoreDoc(docs.courseMap, DOC_KIND.courseMap, season, race.key);
    if (mapHit) {
      try {
        mapUrl = (await wpPage(ctx, mapHit.id)).docUrl;
      } catch (err) {
        ctx.log.warn(`${label}: no se pudo leer la página del mapa (${errorText(err)})`);
      }
    }

    const previous = ctx.previous?.events.find((e) => e.seriesId === series.id && e.id === baseEvent('pending').id);
    if (!schedule || !scheduleSource || !schedule.items.length) {
      // Sin cronograma nuevo: lo que se haya leído en una corrida anterior (si el documento dejó de responder).
      const keptSessions = previous ? (ctx.previous?.sessions ?? []).filter((s) => s.eventId === previous.id) : [];
      const event = baseEvent(keptSessions.length ? 'published' : 'pending', previous?.stageCount);
      return { event, sessions: keptSessions };
    }

    const draft = baseEvent('published', undefined, scheduleSource);
    const sessions = buildSessions(ctx, draft, schedule, scheduleSource);
    const cars = sessions.find((s) => s.type === 'carrera' && !isMotoSession(s)) ?? sessions.find((s) => s.type === 'carrera');
    const raceDate = schedule.items.find((i) => i.kind === 'largada-autos' || i.kind === 'largada')?.date ?? schedule.items.find((i) => i.kind.startsWith('largada'))?.date;
    const start = cars?.localStartText ? { startUtc: cars.startUtc, localStartText: cars.localStartText } : undefined;

    let stages: RallyStage[] = [];
    let stagesSource = scheduleSource;
    if (raceDate && checkpoints.length >= 2 && infoSource) {
      stages = checkpointStages(checkpoints, raceDate, start, schedule.timeLimitHours);
      stagesSource = infoSource;
    } else if (raceDate && schedule.distanceKm) {
      // Sin tabla de puestos: el recorrido entero, con la distancia del cronograma.
      stages = [
        {
          code: 'Recorrido',
          name: scoreVenue(race.place),
          kind: 'especial',
          date: raceDate,
          ...(start ?? {}),
          distanceKm: schedule.distanceKm,
          note: `${fmtMi(schedule.distanceMi ?? 0)} millas (${schedule.distanceKm} km) de recorrido${schedule.timeLimitHours ? `; tiempo límite: ${schedule.timeLimitHours} horas` : ''}.`,
        },
      ];
    }
    const especiales = stages.filter((s) => s.kind === 'especial');
    const event = baseEvent('published', especiales.length || undefined, scheduleSource);
    const competitiveKm = round2(especiales.reduce((n, s) => n + (s.distanceKm ?? 0), 0));
    const totalKm = round2(stages.reduce((n, s) => n + (s.distanceKm ?? 0) + (s.liaisonKm ?? 0), 0));
    const file: EventStagesFile | undefined = stages.length
      ? {
          seriesId: series.id,
          eventId: event.id,
          updatedAt: fetchedAt(ctx),
          surface: 'arena',
          ...(competitiveKm > 0 ? { competitiveKm } : {}),
          ...(totalKm > competitiveKm ? { totalKm } : {}),
          ...(mapUrl ? { routeMapUrl: mapUrl, routeMapCredit: '© SCORE International' } : {}),
          stages: stages.map((s) => (cars && s.startUtc ? { ...s, sessionId: cars.id } : s)),
          source: stagesSource,
        }
      : undefined;
    return { event, sessions, ...(file ? { stages: file } : {}) };
  }

  return {
    name: 'score',

    async schedule(series, ctx): Promise<ScheduleChunk> {
      // La temporada siguiente ya va junto con la en curso (el calendario se publica a mitad de año).
      if (ctx.nextSeason) return { events: [], sessions: [] };
      const [calendar, schedule, raceInfo, courseMap] = await Promise.all([
        search(ctx, SCORE_QUERIES.calendar),
        search(ctx, SCORE_QUERIES.schedule).catch((err: unknown) => (ctx.log.warn(`Búsqueda de cronogramas: ${errorText(err)}`), [])),
        search(ctx, SCORE_QUERIES.raceInfo).catch((err: unknown) => (ctx.log.warn(`Búsqueda de Race Info: ${errorText(err)}`), [])),
        search(ctx, SCORE_QUERIES.courseMap).catch((err: unknown) => (ctx.log.warn(`Búsqueda de mapas: ${errorText(err)}`), [])),
      ]);
      const docs: DocIndex = { calendar, schedule, raceInfo, courseMap };

      let homepageHtml: Promise<string | null> | null = null;
      const homepage = () =>
        (homepageHtml ??= ctx.http.text(`${SCORE_SITE}/`).then(
          (r) => r.body,
          (err: unknown) => (ctx.log.warn(`Portada de score-international.com: ${errorText(err)}`), null),
        ));

      const chunk: ScheduleChunk = { events: [], sessions: [], stages: [] };
      for (const season of [ctx.season, ctx.season + 1]) {
        const hit = findScoreCalendar(docs.calendar, season);
        if (!hit) {
          if (season === ctx.season) throw new Error(`score-raceinfo.com no publica el calendario ${season} ("${season} Race Schedule")`);
          ctx.log.info(`Calendario ${season}: todavía no publicado`);
          continue;
        }
        const doc = await pageDoc(ctx, hit);
        if (!doc) throw new Error(`La página del calendario ${season} no trae el PDF (${hit.url})`);
        const races = parseScoreCalendar(doc.items, season);
        if (!races.length) throw new Error(`No se encontraron carreras en el calendario ${season} (${doc.page.docUrl})`);
        const source = directSource(ctx, doc.page.link, `SCORE International – Calendario ${season}`, 'pdf');
        for (const race of races) {
          const out = await loadRace(series, ctx, race, season, source, docs, homepage);
          chunk.events.push(out.event);
          chunk.sessions.push(...out.sessions);
          if (out.stages) chunk.stages!.push(out.stages);
          ctx.log.info(
            `${out.event.name} ${season}: ${out.sessions.length ? `${out.sessions.length} sesiones` : 'horarios a confirmar'}` +
              (out.stages ? `, ${out.stages.stages.length} sectores` : ''),
          );
        }
      }
      chunk.events.sort((a, b) => a.dateStart.localeCompare(b.dateStart));
      if (!chunk.stages!.length) delete chunk.stages;
      return chunk;
    },

    async results(series, ctx, req): Promise<ResultsChunk> {
      const wanted = req.pendingSessions.filter((s) => s.type === 'carrera' || s.type === 'clasificacion');
      if (!wanted.length) return { results: [] };
      let budget = MAX_RESULT_FETCHES;
      const events = new Map(req.events.map((e) => [e.id, e]));
      const ltEvents = parseLiveTimeEvents((await ctx.http.text(SCORE_RESULTS_EVENTS_URL)).body);
      const racesByEvent = new Map<string, Array<LiveTimeRace & { eventUrl: string }>>();
      const files = new Map<string, EventResultsFile>();
      const deferred: string[] = [];
      const nowIso = fetchedAt(ctx);

      for (const session of wanted) {
        const event = events.get(session.eventId);
        if (!event) continue;
        // Cupo de descargas agotado: se busca en la próxima corrida sin contar como intento fallido.
        if (budget <= 0) {
          deferred.push(session.id);
          continue;
        }
        const key = scoreRaceKey(event.name);
        const year = Number(event.dateStart.slice(0, 4));
        if (!racesByEvent.has(event.id)) {
          const races: Array<LiveTimeRace & { eventUrl: string }> = [];
          for (const lt of ltEvents.filter((e) => e.key === key && e.year === year)) {
            budget--;
            try {
              races.push(...parseLiveTimeEventPage((await ctx.http.text(lt.url)).body).map((r) => ({ ...r, eventUrl: lt.url })));
            } catch (err) {
              ctx.log.warn(`${event.name}: no se pudo leer ${lt.url} (${errorText(err)})`);
            }
          }
          racesByEvent.set(event.id, races);
        }
        const races = racesByEvent.get(event.id)!;
        const picked = pickRaces(session, races);
        if (!picked.length) continue;
        if (budget < picked.length) {
          deferred.push(session.id);
          continue;
        }
        const rows: ResultRow[] = [];
        let url = '';
        for (const race of picked) {
          budget--;
          try {
            const html = (await ctx.http.text(race.url)).body;
            const single = race.url.includes('show_combined') ? undefined : race.name.replace(/\s*(?:qualif\w*|site lap|practice)\s*$/i, '').trim();
            const result = parseLiveTimeResult(html, single);
            // Varias tandas de clasificación (Trophy Truck aparte): la primera da el puesto; el resto, solo el de su clase.
            // (sin la diferencia, que es contra el primero de su tanda).
            rows.push(...(rows.length ? result.rows.map(({ gap: _gap, ...r }) => ({ ...r, pos: null })) : result.rows));
            url ||= race.url;
          } catch (err) {
            if (err instanceof HttpError && (err.status === 429 || err.status >= 500)) deferred.push(session.id);
            ctx.log.warn(`${event.name} – ${session.name}: no se pudo leer ${race.url} (${errorText(err)})`);
          }
        }
        if (!rows.some((r) => r.pos !== null)) continue;
        const result: SessionResult = {
          sessionId: session.id,
          rows,
          source: directSource(ctx, url, `SCORE International (LiveTime) – ${event.name} ${year}: ${session.name}`, 'html'),
        };
        const file = files.get(event.id) ?? { seriesId: series.id, eventId: event.id, updatedAt: nowIso, sessions: [] };
        file.sessions.push(result);
        files.set(event.id, file);
      }
      return { results: [...files.values()], ...(deferred.length ? { deferred } : {}) };
    },
  };
}

/**
 * Qué carreras de LiveTime corresponden a una sesión: la clasificación (primero la tanda de Trophy Truck, que define
 * la grilla de la clase reina, y después las demás), la carrera de motos y cuatriciclos o la de autos ("4-wheel").
 */
export function pickRaces<T extends LiveTimeRace>(session: Pick<Session, 'type' | 'name'>, races: T[]): T[] {
  if (session.type === 'clasificacion') {
    const quali = races.filter((r) => r.section === 'clasificacion');
    const tt = (r: T) => /trophy\s*truck/i.test(r.name) && !/legend|spec|2wd/i.test(r.name);
    return [...quali.filter(tt), ...quali.filter((r) => !tt(r))];
  }
  const race = races.filter((r) => r.section === 'carrera');
  const moto = (r: T) => /\bmoto|\bquad/i.test(r.name);
  if (isMotoSession(session)) return race.filter(moto).slice(0, 1);
  const cars = race.filter((r) => !moto(r));
  return (cars.length ? cars : race).slice(0, 1);
}

export const scoreAdapter: Adapter = createScoreAdapter();
