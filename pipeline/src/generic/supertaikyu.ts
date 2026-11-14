/**
 * ENEOS Super Taikyu Series (supertaikyu.com). El sitio oficial es HTML estático y solo en japonés (no hay
 * páginas en inglés), en UTF-8:
 * - /race/index.html: tarjetas de cada fecha ("ROUND.7", "2026/11/14-15", "FUJI"); los "TEST.n" no son carreras.
 * - /race/round_NN.html: cronograma ("RACE SCHEDULE": día, "09:05 - 09:45", texto en japonés) y lista de inscriptos
 *   por clase. Las páginas se reutilizan año a año, así que siempre se controla que las fechas sean de la temporada.
 * - /race/standing.html: campeonato por clase (cada auto suma para su equipo; no hay tabla de pilotos).
 */
import { localToUtc } from '@dm/shared';
import type { RosterRow, StandingsRow } from '@dm/shared';
import { absoluteUrl, textByClass, textOf } from '../extract/html.ts';
import { isoDate, shiftDate } from './places.ts';
import { checkStandingsTable, column, host, isoNow, pageOrNull, parseHtmlTable, parseNumber, standingsSource, stripComments } from './kit.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, SessionsFound, SiteRecipe } from './types.ts';

const TZ = 'Asia/Tokyo';
const RACES_URL = 'https://supertaikyu.com/race/index.html';

/** Circuitos tal como figuran en las tarjetas ("FUJI") -> nombre oficial y nombre corto para el evento. */
const CIRCUITS: Record<string, { circuit: string; short: string }> = {
  MOTEGI: { circuit: 'Mobility Resort Motegi', short: 'Motegi' },
  SUZUKA: { circuit: 'Suzuka Circuit', short: 'Suzuka' },
  FUJI: { circuit: 'Fuji Speedway', short: 'Fuji' },
  SUGO: { circuit: 'Sportsland SUGO', short: 'SUGO' },
  AUTOPOLIS: { circuit: 'Autopolis', short: 'Autopolis' },
  OKAYAMA: { circuit: 'Okayama International Circuit', short: 'Okayama' },
  TSUKUBA: { circuit: 'Tsukuba Circuit', short: 'Tsukuba' },
};

/** "2026/3/21-22", "2026/5/30-6/1", "2026/5/14" -> fechas locales. */
function cardDates(text: string): { start: string; end: string } | null {
  const m = text.normalize('NFKC').match(/(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s*-\s*(?:(\d{1,2})\/)?(\d{1,2}))?/);
  if (!m) return null;
  const y = Number(m[1]);
  const start = isoDate(y, Number(m[2]), Number(m[3]));
  const end = m[5] ? isoDate(y, Number(m[4] ?? m[2]), Number(m[5])) : start;
  return start && end && end >= start ? { start, end } : null;
}

export function supertaikyuCalendar(html: string, baseUrl: string, season: number): CalendarEntry[] {
  const out: CalendarEntry[] = [];
  for (const card of stripComments(html).split(/class="Race_BX_Inn"/).slice(1)) {
    const roundText = textByClass(card, 'Race_BX_Rd');
    const round = roundText.match(/^ROUND\.?\s*(\d+)/i)?.[1];
    const dates = cardDates(textByClass(card, 'Race_BX_Date'));
    if (!round || !dates || !dates.start.startsWith(String(season))) continue; // TEST.n = ensayos oficiales
    const code = textByClass(card, 'Race_BX_Circuit').toUpperCase();
    const known = CIRCUITS[code];
    const short = known?.short ?? code.charAt(0) + code.slice(1).toLowerCase();
    // El nombre oficial está en japonés ("第3戦 富士 24時間レース"): se arma uno en inglés con la duración.
    const hours = textByClass(card, 'Race_BX_Name').normalize('NFKC').match(/(\d+)\s*時間/)?.[1];
    const href = card.match(/href="([^"]*round_\d+\.html)"/)?.[1];
    out.push({
      name: hours ? `${short} ${hours} Hours` : `Super Taikyu ${short}`,
      circuit: known?.circuit ?? short,
      country: 'Japan',
      tz: TZ,
      dateStart: dates.start,
      dateEnd: dates.end,
      round: Number(round),
      ...(href ? { url: absoluteUrl(href, baseUrl) ?? undefined } : {}),
    });
  }
  return out;
}

/** Actividades del cronograma que no son sesiones en pista de la S耐 (S耐チャレンジ es una categoría soporte). */
const NOT_SESSION = /PIT\s*WALK|スタート進行|セレモニー|パレード|アクロバット|チャレンジ|サイン会|トークショー|グリッドウォーク|kids/i;

/** Nombre en inglés de una sesión del cronograma (texto japonés); null si no es una sesión de la serie. */
export function supertaikyuSessionName(text: string): string | null {
  const t = text.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!t || NOT_SESSION.test(t)) return null;
  const gr = t.match(/Gr\s*[.\-]?\s*(\d)/i)?.[1];
  const group = gr ? ` Gr.${gr}` : '';
  if (/ウォームアップ|warm\s*-?\s*up/i.test(t)) return `Warm Up${group}`;
  if (/フリー走行|free\s*practice/i.test(t)) return `Free Practice${group}`;
  if (/予選|qualif/i.test(t)) {
    // "(Aドライバー)", "(C・Dドライバー)", "(CDドライバー)": cada piloto del auto clasifica en su tanda.
    const letters = t.match(/\(\s*([A-F](?:\s*[・･,/]?\s*[A-F])*)\s*ドライバー\s*\)/)?.[1]?.match(/[A-F]/g);
    return `Qualifying${group}${letters ? ` - ${letters.join('/')} Driver` : ''}`;
  }
  if (/決勝|耐久レース|時間レース|\d+\s*H\b|hours?\s*race|race/i.test(t)) {
    const n = t.match(/Race\s*(\d)/i)?.[1];
    return `Race${n ? ` ${n}` : ''}${group}`;
  }
  return null;
}

/** Sesiones del cronograma de una fecha; solo días de la temporada pedida (las páginas se reciclan cada año). */
export function supertaikyuSessions(html: string, season: number): ExtractedSession[] {
  const out: ExtractedSession[] = [];
  const seen = new Map<string, number>();
  let date: string | null = null;
  let time = '';
  const re = /class="RaceSchedule_(Date|Time|TXT)"[^>]*>([\s\S]*?)<\/div>/g;
  for (const m of stripComments(html).matchAll(re)) {
    const text = textOf(m[2] ?? '').normalize('NFKC');
    if (m[1] === 'Date') {
      // "2026.11.14" o "2026.6.6-7" (24 horas): el primer día es el de la largada.
      const d = text.match(/(\d{4})\.(\d{1,2})\.(\d{1,2})/);
      date = d && Number(d[1]) === season ? isoDate(Number(d[1]), Number(d[2]), Number(d[3])) : null;
    } else if (m[1] === 'Time') {
      time = text;
    } else if (date) {
      const name = supertaikyuSessionName(text);
      const t = time.match(/^(\d{1,2}:\d{2})\s*-\s*(翌)?\s*(\d{1,2}:\d{2})?/);
      if (!name || !t) continue;
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      const start = t[1]!.padStart(5, '0');
      // "15:00 - 翌15:00": termina al día siguiente (24 horas de Fuji).
      const end = t[3] ? localToUtc(t[2] ? shiftDate(date, 1) : date, t[3], TZ) : undefined;
      out.push({
        name: n > 1 ? `${name} (${n})` : name,
        startUtc: localToUtc(date, start, TZ),
        ...(end ? { endUtc: end } : {}),
        localStartText: start,
      });
    }
  }
  return out;
}

/** Tablas por clase: cada "Standing_Class" (título) seguido de su tabla (campeonato e inscriptos usan lo mismo). */
function classTables(html: string): { cls: string; table: string }[] {
  const out: { cls: string; table: string }[] = [];
  for (const part of stripComments(html).split(/(?=<div class="Standing_Class")/).slice(1)) {
    const cls = textOf(part.match(/<div class="Standing_Class"[^>]*>([\s\S]*?)<(?:span|\/div)/)?.[1] ?? '');
    const table = part.match(/<table\b[\s\S]*?<\/table>/i)?.[0];
    if (cls && table) out.push({ cls, table });
  }
  return out;
}

/** Inscriptos de una página de fecha: una fila por piloto (columnas A, B, C… de cada auto). */
export function supertaikyuEntryList(html: string): RosterRow[] {
  const rows: RosterRow[] = [];
  for (const { cls, table } of classTables(html)) {
    // La primera fila de encabezados usa <th>: parseHtmlTable la deja fuera de rows.
    const { headers, rows: cells } = parseHtmlTable(table);
    const iNo = column(headers, /^no\.?$/i);
    const iTeam = column(headers, /^team$/i);
    const iCar = column(headers, /^(machine|car)$/i);
    const drivers = headers.map((h, i) => (/^[A-F]$/.test(h.trim()) ? i : -1)).filter((i) => i >= 0);
    if (iNo < 0 || iTeam < 0 || drivers.length === 0) throw new Error(`Lista de inscriptos de Super Taikyu con columnas inesperadas: ${headers.join(' | ')}`);
    for (const r of cells) {
      const cell = (i: number) => (i >= 0 ? textOf(r[i] ?? '') : '');
      for (const i of drivers) {
        const driver = cell(i);
        if (!driver) continue;
        rows.push({
          driver,
          ...(cell(iTeam) ? { team: cell(iTeam) } : {}),
          ...(cell(iNo) ? { number: cell(iNo) } : {}),
          ...(cell(iCar) ? { vehicle: cell(iCar) } : {}),
          class: textOf(r[0] ?? '') || cls,
        });
      }
    }
  }
  return rows;
}

/** Fechas de la página de una fecha ("2026/11/14-15"): sirve para descartar páginas de otra temporada. */
const roundPageSeason = (html: string) => Number(textByClass(html, 'Race_Detail_Upp_Date').match(/(\d{4})\//)?.[1]) || null;

async function rosterFromRoundPage(url: string, ctx: RecipeContext): Promise<RosterRow[] | null> {
  const html = await pageOrNull(ctx, url);
  if (!html || roundPageSeason(html) !== ctx.season) return null;
  const rows = supertaikyuEntryList(html);
  return rows.length ? rows : null;
}

export const supertaikyu: SiteRecipe = {
  name: 'supertaikyu',
  match: (url) => host(url) === 'supertaikyu.com',
  calendarUrl: () => RACES_URL,
  calendar: (doc, ctx) => supertaikyuCalendar(doc.raw, doc.url, ctx.season),
  async sessions(entry, ctx): Promise<SessionsFound | null> {
    if (!entry.url) return null;
    const html = await pageOrNull(ctx, entry.url);
    if (!html) return null;
    const sessions = supertaikyuSessions(html, ctx.season);
    if (sessions.length === 0) return null;
    return {
      sessions,
      source: { url: entry.url, title: `Race schedule — ${entry.name}`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) },
    };
  },
  /**
   * Fechas ya corridas: la página de la fecha conserva el cronograma hasta que se recicla para la temporada
   * siguiente (supertaikyuSessions descarta los días de otro año). Los resultados oficiales son PDF escaneados (sin
   * texto o con un OCR ilegible), así que no hay results(): quedan para la IA.
   */
  pastSessions: (entry, ctx) => supertaikyu.sessions!(entry, ctx),
  async standings(url, ctx) {
    const html = await pageOrNull(ctx, url);
    if (!html) return null;
    // Encabezado "2026 STANDING"; las temporadas anteriores quedan en standing_AAAA.html.
    const year = Number(stripComments(html).match(/>\s*(\d{4})\s*STANDING\s*</i)?.[1]);
    if (!year) throw new Error('Super Taikyu: no se encontró el año del campeonato');
    if (year !== ctx.season) return null;
    const blocks = classTables(html);
    if (blocks.length === 0) throw new Error('Super Taikyu: la página no tiene tablas por clase');
    const tables = [];
    for (const { cls, table } of blocks) {
      const { headers, rows: cells } = parseHtmlTable(table);
      const iPos = column(headers, /^rank$/i);
      const iNo = column(headers, /^no\.?$/i);
      const iTeam = column(headers, /^team$/i);
      const iTotal = column(headers, /^total$/i);
      if (iPos < 0 || iTeam < 0 || iTotal < 0) throw new Error(`Super Taikyu: columnas inesperadas en ${cls}: ${headers.join(' | ')}`);
      const rows: StandingsRow[] = [];
      for (const r of cells) {
        // Los autos sin puntos figuran al final sin posición: no forman parte de la tabla.
        const pos = parseNumber(textOf(r[iPos] ?? ''));
        const points = parseNumber(textOf(r[iTotal] ?? ''));
        if (pos === null || points === null) continue;
        const number = iNo >= 0 ? textOf(r[iNo] ?? '') : '';
        rows.push({ pos, name: textOf(r[iTeam] ?? ''), ...(number ? { number } : {}), points });
      }
      // Clase sin autos con puntos (p. ej. antes de la primera fecha): no hay tabla que mostrar.
      // El campeonato de Super Taikyu es por auto/equipo (columna TEAM, sin pilotos): se titula "Equipos" para que
      // el índice de pilotos no tome a los equipos como pilotos (isDriverTable) y la app los liste como equipos.
      if (rows.length) tables.push(checkStandingsTable({ title: `Equipos Clase ${cls}`, rows }));
    }
    if (tables.length === 0) return null;
    return { tables, source: standingsSource(url, `Super Taikyu ${ctx.season} — Standing`, ctx) };
  },
  async roster(url, ctx) {
    // Una página de fecha se lee directo; la de carreras manda a la fecha más reciente con inscriptos publicados.
    if (/round_\d+\.html/.test(url)) {
      const rows = await rosterFromRoundPage(url, ctx);
      return rows ? { rows, source: { url, title: `Entry list Super Taikyu ${ctx.season}`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) } } : null;
    }
    const html = await pageOrNull(ctx, url);
    if (!html) return null;
    const rounds = supertaikyuCalendar(html, url, ctx.season)
      .filter((e) => e.url)
      .sort((a, b) => b.dateStart.localeCompare(a.dateStart));
    for (const r of rounds) {
      const rows = await rosterFromRoundPage(r.url!, ctx);
      if (rows) {
        return { rows, source: { url: r.url!, title: `Entry list — ${r.name}`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) } };
      }
    }
    return null;
  },
};
