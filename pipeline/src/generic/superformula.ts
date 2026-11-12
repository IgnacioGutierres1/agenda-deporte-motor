/**
 * SUPER FORMULA (superformula.net/sf3): lector determinista del sitio oficial (WordPress, solo en japonés;
 * el botón "EN" es Google Translate). La API REST no expone carreras ni posiciones, así que se leen las
 * páginas HTML (UTF-8): calendario, página de cada fecha (cronograma), posiciones y equipos.
 * Los nombres de circuitos, pilotos y equipos ya vienen en alfabeto latino junto al japonés.
 */
import { localToUtc, type RosterRow, type StandingsRow, type StandingsTable } from '@dm/shared';
import { absoluteUrl, attr, blocksByClass, textOf } from '../extract/html.ts';
import { isoDate } from './places.ts';
import { checkStandingsTable, column, host, isoNow, pageOrNull, parseHtmlTable, parseNumber, standingsSource, stripComments } from './kit.ts';
import type { CalendarEntry, ExtractedSession, SiteRecipe } from './types.ts';

const BASE = 'https://superformula.net/sf3';
const TZ = 'Asia/Tokyo';

/** Temporada del título de la página ("2026 SUPER FORMULA"). */
const seasonOf = (html: string) => Number(html.match(/<span class="roboto">\s*(\d{4})\s+SUPER FORMULA/i)?.[1] ?? 0);

/** "岩佐 歩夢<br>Ayumu Iwasa │ IWA" / " Luke Browning ｜ BRO" -> nombre latino (sin la abreviatura de 3 letras). */
function latinName(text: string): string {
  return textOf(text)
    .split(/[│｜|]/)[0]!
    .trim();
}

/**
 * Nombre en inglés de una sesión del cronograma ("Rd.11 予選Q1 GrA" -> "Rd.11 Qualifying Q1 Group A").
 * Los fines de semana con dos carreras repiten clasificación y carrera: el prefijo "Rd.N" las distingue.
 * null si no es una sesión de pista (pit walk, fiestas, ensayos de largada).
 */
export function superformulaSessionName(raw: string): string | null {
  const text = textOf(raw);
  const rd = text.match(/Rd\.?\s*(\d+)/i)?.[1];
  const group = text.match(/Gr\.?\s*([AB])\b|([AB])組/i);
  const groupText = group ? ` Group ${(group[1] ?? group[2])!.toUpperCase()}` : '';
  let name: string;
  if (/決勝/.test(text)) name = 'Race';
  else if (/予選/.test(text)) {
    const q = text.match(/Q\s*(\d)/i)?.[1];
    name = `Qualifying${q ? ` Q${q}` : ''}${groupText}`;
  } else if (/ウォームアップ|warm\s*-?up/i.test(text)) name = 'Warm Up';
  else if (/\bFP\d*\b|フリー走行/i.test(text)) {
    const n = text.match(/FP\s*(\d)/i)?.[1];
    name = `Free Practice${n ? ` ${n}` : ''}${groupText}`;
  } else return null;
  return rd ? `Rd.${rd} ${name}` : name;
}

/** Nombres únicos (el id de la sesión sale del nombre): las repeticiones llevan " (2)", " (3)"… */
function uniqueNames(sessions: ExtractedSession[]): ExtractedSession[] {
  const seen = new Map<string, number>();
  return sessions.map((s) => {
    const n = (seen.get(s.name) ?? 0) + 1;
    seen.set(s.name, n);
    return n === 1 ? s : { ...s, name: `${s.name} (${n})` };
  });
}

/** Tabla de posiciones (.table_results): la posición se dibuja por CSS, así que es el orden de las filas. */
function standingsTable(html: string, title: string, kind: 'driver' | 'team', teams: Map<string, string>): StandingsTable | null {
  const table = html.match(/<table class="table_results">[\s\S]*?<\/table>/i)?.[0];
  if (!table) throw new Error(`SUPER FORMULA: la página de posiciones no tiene la tabla (${title})`);
  const { headers, rows } = parseHtmlTable(table);
  const cName = column(headers, kind === 'driver' ? /^driver/i : /^team/i);
  const cNum = column(headers, /^car\s*no/i);
  const cTotal = column(headers, /^total/i);
  if (cName < 0 || cTotal < 0 || (kind === 'driver' && cNum < 0)) {
    throw new Error(`SUPER FORMULA: la tabla "${title}" no tiene las columnas esperadas (${headers.join(', ')})`);
  }
  const parsed: StandingsRow[] = rows.map((cells, i) => {
    const cell = cells[cName] ?? '';
    // Pilotos: "太田 格之進<br>Kakunoshin Ohta │ OTA" -> se usa la parte latina.
    const name = kind === 'driver' ? latinName(cell.split(/<br\s*\/?>/i).pop() ?? cell) || textOf(cell) : textOf(cell);
    const number = cNum >= 0 ? textOf(cells[cNum] ?? '') : '';
    const team = number ? teams.get(number) : undefined;
    return {
      pos: i + 1,
      name,
      ...(team ? { team } : {}),
      ...(number ? { number } : {}),
      points: parseNumber(textOf(cells[cTotal] ?? '')) ?? NaN,
    };
  });
  return parsed.length ? checkStandingsTable({ title, rows: parsed }) : null;
}

/** Equipos de la temporada (/team_taxonomy/AAAA/): bloque por equipo con un <h5> por auto ("1 岩佐 歩夢 Ayumu Iwasa │ IWA"). */
function teamEntries(html: string): { team: string; number: string; driver: string }[] {
  const out: { team: string; number: string; driver: string }[] = [];
  for (const block of blocksByClass(stripComments(html), 'teams01_block01', 20_000)) {
    const team = textOf(block.match(/<h4\b[^>]*>[\s\S]*?<span class="roboto">([\s\S]*?)<\/span>/i)?.[1] ?? '');
    for (const h5 of block.matchAll(/<h5\b[^>]*>([\s\S]*?)<\/h5>/gi)) {
      const m = (h5[1] ?? '').match(/<span class="roboto">\s*(\d+)\s*<\/span>([^<]*)(?:<span class="roboto">([\s\S]*?)<\/span>)?/i);
      if (!m) continue;
      const driver = latinName(m[3] ?? '') || textOf(m[2] ?? '');
      if (driver) out.push({ team, number: m[1]!, driver });
    }
  }
  return out;
}

export const superformula: SiteRecipe = {
  name: 'superformula',
  match: (url) => host(url) === 'superformula.net',
  // Calendario de cada temporada: /sf3/race_taxonomy/AAAA/ (404 si todavía no existe).
  calendarUrl: (_url, season) => `${BASE}/race_taxonomy/${season}/`,
  /**
   * Tarjetas del calendario: "Rd.9-10" + "10月09日(金) ~ 11日(日)" + circuito en inglés. Los ensayos
   * oficiales ("Test.1") no son fechas del campeonato y se omiten. Una tarjeta puede reunir varias
   * fechas ("Rd.11-12": dos carreras el mismo fin de semana) y es un solo evento; las sesiones llevan
   * el número de fecha en el nombre.
   */
  calendar(doc, ctx) {
    const html = stripComments(doc.raw);
    if (seasonOf(html) !== ctx.season) return [];
    const list = html.match(/<ul class="race01_list01[^"]*">([\s\S]*?)<\/ul>/i)?.[1] ?? '';
    const out: CalendarEntry[] = [];
    const usedRounds = new Set<number>();
    for (const li of list.matchAll(/<li>([\s\S]*?)<\/li>/gi)) {
      const card = li[1] ?? '';
      const label = textOf(card.match(/class="box_txt01">([\s\S]*?)<\/p>/i)?.[1] ?? ''); // "Rd.11-12"
      if (!/^Rd\./i.test(label)) continue;
      const dates = textOf(card.match(/class="inner01_txt01">([\s\S]*?)<\/p>/i)?.[1] ?? '');
      const d = dates.match(/(\d{1,2})月\s*(\d{1,2})日[^~〜～]*(?:[~〜～]\s*(?:(\d{1,2})月\s*)?(\d{1,2})日)?/);
      if (!d) continue;
      const month = Number(d[1]);
      const startDay = Number(d[2]);
      const endDay = Number(d[4] ?? d[2]);
      // "6月30日 ~ 01日": sin mes explícito y día menor, termina el mes siguiente.
      const endMonth = d[3] ? Number(d[3]) : endDay < startDay ? (month % 12) + 1 : month;
      const dateStart = isoDate(ctx.season, month, startDay);
      const dateEnd = isoDate(endMonth < month ? ctx.season + 1 : ctx.season, endMonth, endDay);
      if (!dateStart || !dateEnd) continue;
      const circuit = textOf(card.match(/<span class="en">([\s\S]*?)<\/span>/i)?.[1] ?? '');
      // "Rd.3-6-7": la fecha 3 suspendida se corrió a este fin de semana; el número propio del evento es el primero
      // que no usó un evento anterior (si no, dos eventos quedarían como ronda 3).
      const rounds = [...label.matchAll(/\d+/g)].map((m) => Number(m[0]));
      const round = rounds.find((r) => !usedRounds.has(r)) ?? rounds[0];
      rounds.forEach((r) => usedRounds.add(r));
      const href = attr(card.match(/<a\b([^>]*)>/i)?.[1] ?? '', 'href');
      out.push({
        name: `${label} ${circuit}`.trim(),
        circuit,
        country: 'Japan',
        tz: TZ,
        dateStart,
        dateEnd,
        ...(round ? { round } : {}),
        url: (href && absoluteUrl(href, doc.url)) || undefined,
      });
    }
    return out;
  },
  /**
   * Cronograma de la página de la fecha: una tabla .table_time_schedule por día (caption "11.21(Sat)") con
   * filas "09:50-10:00 | Rd.11 予選Q1 GrA". La carrera solo trae la hora de largada ("14:25-[31周/最大75分]").
   */
  async sessions(entry, ctx) {
    if (!entry.url) return null;
    const html = await pageOrNull(ctx, entry.url);
    if (!html) return null;
    const year = Number(entry.dateStart.slice(0, 4));
    const startMonth = Number(entry.dateStart.slice(5, 7));
    const sessions: ExtractedSession[] = [];
    for (const block of stripComments(html).split(/<div class="[^"]*\btable_time_schedule\b[^"]*">/i).slice(1)) {
      const table = block.match(/<table\b[\s\S]*?<\/table>/i)?.[0] ?? '';
      const cap = textOf(table.match(/<caption>([\s\S]*?)<\/caption>/i)?.[1] ?? '').match(/(\d{1,2})\.(\d{1,2})/);
      if (!cap) continue;
      const month = Number(cap[1]);
      const date = isoDate(month < startMonth ? year + 1 : year, month, Number(cap[2]));
      if (!date) continue;
      for (const tr of table.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
        const time = textOf(tr[1]!.match(/<th\b[^>]*>([\s\S]*?)<\/th>/i)?.[1] ?? '');
        const label = tr[1]!.match(/<td\b[^>]*>([\s\S]*?)<\/td>/i)?.[1] ?? '';
        const t = time.match(/^(\d{1,2}:\d{2})\s*(?:[-–~〜～]\s*(\d{1,2}:\d{2})?)?/);
        const name = superformulaSessionName(label);
        if (!t || !name) continue;
        const from = t[1]!.padStart(5, '0');
        sessions.push({
          name,
          startUtc: localToUtc(date, from, entry.tz),
          ...(t[2] ? { endUtc: localToUtc(date, t[2], entry.tz) } : {}),
          localStartText: from,
        });
      }
    }
    if (sessions.length === 0) return null;
    return {
      sessions: uniqueNames(sessions),
      source: { url: entry.url, title: `レーススケジュール SUPER FORMULA — ${entry.name}`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) },
    };
  },
  /**
   * Posiciones de pilotos (/driver_taxonomy/AAAA/?standings) y de equipos (/team_taxonomy/AAAA/?standings).
   * La tabla de pilotos no trae el equipo: sale de la página de equipos, por número de auto.
   */
  async standings(_url, ctx) {
    const driversUrl = `${BASE}/driver_taxonomy/${ctx.season}/?standings`;
    const teamsUrl = `${BASE}/team_taxonomy/${ctx.season}/?standings`;
    const driversHtml = await pageOrNull(ctx, driversUrl);
    if (!driversHtml || seasonOf(driversHtml) !== ctx.season) return null;
    const teamsHtml = await pageOrNull(ctx, teamsUrl);
    const listHtml = await pageOrNull(ctx, `${BASE}/team_taxonomy/${ctx.season}/`);
    const teamByNumber = new Map(listHtml ? teamEntries(listHtml).map((e) => [e.number, e.team]) : []);
    const tables: StandingsTable[] = [];
    const drivers = standingsTable(stripComments(driversHtml), 'Pilotos', 'driver', teamByNumber);
    if (drivers) tables.push(drivers);
    if (teamsHtml && seasonOf(teamsHtml) === ctx.season) {
      const teams = standingsTable(stripComments(teamsHtml), 'Equipos', 'team', new Map());
      if (teams) tables.push(teams);
    }
    if (tables.length === 0) return null;
    return { tables, source: standingsSource(driversUrl, `Standings SUPER FORMULA ${ctx.season}`, ctx) };
  },
  /** Inscriptos: página de equipos de la temporada (equipo, número y piloto de cada auto). */
  async roster(_url, ctx) {
    const pageUrl = `${BASE}/team_taxonomy/${ctx.season}/`;
    const html = await pageOrNull(ctx, pageUrl);
    if (!html || seasonOf(html) !== ctx.season) return null;
    const rows: RosterRow[] = teamEntries(html).map((e) => ({ driver: e.driver, ...(e.team ? { team: e.team } : {}), number: e.number }));
    if (rows.length === 0) return null;
    return {
      rows,
      source: { url: pageUrl, title: `Teams SUPER FORMULA ${ctx.season}`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) },
    };
  },
};
