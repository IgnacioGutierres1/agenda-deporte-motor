/**
 * SUPER GT (supergt.net): lector determinista del sitio oficial (WordPress con plantillas propias).
 * La API REST de WordPress no expone los campos de las carreras ni de los rankings, así que se leen
 * las páginas HTML en inglés (calendario, rankings, inscriptos), que son UTF-8 y tienen una estructura
 * estable. El cronograma de cada fecha solo se publica completo en la versión japonesa de la página
 * de la carrera (la inglesa deja la grilla vacía): de ahí se toman las sesiones de SUPER GT.
 */
import { localToUtc, type RosterRow, type StandingsRow, type StandingsTable } from '@dm/shared';
import { absoluteUrl, attr, textOf } from '../extract/html.ts';
import { countryName, isoDate } from './places.ts';
import { checkStandingsTable, column, host, isoNow, pageOrNull, parseHtmlTable, parseNumber, standingsSource, stripComments, tzFor } from './kit.ts';
import type { CalendarEntry, ExtractedSession, SiteRecipe } from './types.ts';

const BASE = 'https://supergt.net/en';
const CLASSES = ['gt500', 'gt300'] as const;

/** Temporada que muestra el selector "20xx Series" de la página (si se pide un año sin datos, el sitio muestra el actual). */
function activeSeries(html: string): number | null {
  const m = html.match(/class="[^"]*dropdown__item--active[^"]*"\s+data-value="(\d{4}) Series"/);
  return m ? Number(m[1]) : null;
}

const cellsOf = (tr: string) => [...tr.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1] ?? '');

/** Nombres de los pilotos de una celda (cada uno va en un <div class="driver_icon"> con su foto). */
const driverNames = (fragment: string) =>
  [...fragment.matchAll(/<div class="driver_icon">([\s\S]*?)<\/div>/gi)].map((m) => textOf(m[1] ?? '')).filter(Boolean);

/** País del circuito: casi todo el campeonato corre en Japón; las fechas en el exterior se reconocen por el circuito. */
function countryOf(circuit: string): string {
  if (/sepang|malaysia/i.test(circuit)) return 'Malaysia';
  if (/buriram|chang international|thailand/i.test(circuit)) return 'Thailand';
  return 'Japan';
}

/**
 * Sesiones de SUPER GT del cronograma japonés -> nombre en inglés (el clasificador de sesiones entiende inglés).
 * Lo que no está acá (サーキットサファリ, グランドフィナーレ, pit walk, shows) no es una sesión de pista.
 */
function sessionName(raw: string): string | null {
  const q = raw.match(/[（(]\s*(Q\d)\s*[）)]/i)?.[1]?.toUpperCase();
  if (/ウォームアップ/.test(raw)) return 'Warm Up';
  if (/予選/.test(raw)) return q ? `Qualifying ${q}` : 'Qualifying';
  if (/決勝/.test(raw)) return 'Race';
  if (/公式練習/.test(raw)) return 'Official Practice';
  if (/専有走行/.test(raw)) return 'Exclusive Practice';
  if (/練習|フリー走行/.test(raw)) return 'Practice';
  return null;
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

/** Página de la carrera en japonés (/en/races/x -> /races/x), la única con el cronograma cargado. */
export function supergtJapaneseUrl(url: string): string {
  const u = new URL(url);
  u.pathname = u.pathname.replace(/^\/en(?=\/)/, '');
  return u.toString();
}

/** Tabla de un ranking (pilotos o equipos) de una clase. */
function rankingTable(html: string, kind: 'driver' | 'team', title: string, teams: Map<string, string>): StandingsTable | null {
  const table = stripComments(html).match(new RegExp(`<table class="common ${kind}_ranking">[\\s\\S]*?</table>`, 'i'))?.[0];
  if (!table) throw new Error(`SUPER GT: la página no tiene la tabla ${kind}_ranking`);
  const { headers, rows } = parseHtmlTable(table);
  const [cPos, cNum, cName, cTotal] = [/^ranking/i, /^no/i, kind === 'driver' ? /^driver/i : /^team/i, /^total/i].map((re) => column(headers, re));
  if (cPos! < 0 || cNum! < 0 || cName! < 0 || cTotal! < 0) {
    throw new Error(`SUPER GT: la tabla ${kind}_ranking no tiene las columnas esperadas (${headers.join(', ')})`);
  }
  const parsed: StandingsRow[] = rows.map((cells) => {
    const number = textOf(cells[cNum!] ?? '');
    const nameCell = cells[cName!] ?? '';
    // Pilotos: una fila por auto con la dupla "A / B" (comparten los puntos); si la dupla cambió, el sitio separa las filas.
    const name =
      kind === 'driver'
        ? driverNames(nameCell).join(' / ')
        : textOf(nameCell.match(/<dt>\s*Team\s*<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/i)?.[1] ?? '');
    const team = kind === 'driver' ? teams.get(number) : undefined;
    return {
      pos: parseNumber(textOf(cells[cPos!] ?? '')) ?? 0,
      name,
      ...(team ? { team } : {}),
      ...(number ? { number } : {}),
      points: parseNumber(textOf(cells[cTotal!] ?? '')) ?? NaN,
    };
  });
  return parsed.length ? checkStandingsTable({ title, rows: parsed }) : null;
}

export const supergt: SiteRecipe = {
  name: 'supergt',
  match: (url) => host(url) === 'supergt.net',
  // El calendario de cada temporada está en /en/calendar?series=AAAA (sin parámetro muestra la actual).
  calendarUrl: (_url, season) => `${BASE}/calendar?series=${season}`,
  /**
   * Tabla "Schedule | Round | Circuit | Race": la fecha viene como fracción (mes arriba, días "11-12" abajo)
   * y sin año, que sale del título "2026 Calendar". Para un año sin calendario el sitio muestra el título
   * pedido con la tabla vacía.
   */
  calendar(doc, ctx) {
    const html = stripComments(doc.raw);
    const year = Number(html.match(/<h2>\s*(\d{4})\s*(?:Calendar|カレンダー)/i)?.[1] ?? 0);
    if (year !== ctx.season) return [];
    const table = html.match(/<table class="common">[\s\S]*?<\/table>/i)?.[0] ?? '';
    const out: CalendarEntry[] = [];
    for (const tr of table.matchAll(/<tr>([\s\S]*?)<\/tr>/gi)) {
      const cells = cellsOf(tr[1] ?? '');
      if (cells.length < 4) continue;
      const month = Number(textOf(cells[0]!.match(/class="numerator_s">([\s\S]*?)<\/span>/)?.[1] ?? ''));
      const days = textOf(cells[0]!.match(/class="denominator_s">([\s\S]*?)<\/span>/)?.[1] ?? '').match(/(\d{1,2})(?:\s*-\s*(\d{1,2}))?/);
      const link = cells[1]!.match(/<a\b([^>]*)>([\s\S]*?)<\/a>/i);
      if (!month || !days || !link) continue;
      const startDay = Number(days[1]);
      const endDay = Number(days[2] ?? days[1]);
      // "10/31-01": si el último día es menor, el evento termina el mes siguiente.
      const endMonth = endDay < startDay ? (month % 12) + 1 : month;
      const endYear = endDay < startDay && month === 12 ? year + 1 : year;
      const dateStart = isoDate(year, month, startDay);
      const dateEnd = isoDate(endYear, endMonth, endDay);
      if (!dateStart || !dateEnd) continue;
      const short = textOf(link[2] ?? ''); // "Round1 OKAYAMA"
      const circuit = textOf(cells[2]!) || short.replace(/^Round\s*\d+\s*/i, '');
      // "2026 AUTOBACS SUPER GT Round1 OKAYAMA GT 300km RACE" -> "Round1 OKAYAMA GT 300km RACE"; algunas fechas solo dicen "Round2".
      let name = textOf(cells[3]!).replace(/^\d{4}\s+(?:AUTOBACS\s+)?SUPER GT\s+/i, '');
      if (!name || /^Round\s*\d+$/i.test(name)) name = short;
      const country = countryOf(`${circuit} ${name}`);
      const href = attr(link[1] ?? '', 'href');
      out.push({
        name,
        circuit,
        country: countryName(country),
        tz: tzFor(country, circuit, 'Asia/Tokyo'),
        dateStart,
        dateEnd,
        round: Number(short.match(/Round\s*(\d+)/i)?.[1]) || undefined,
        url: (href && absoluteUrl(href, doc.url)) || undefined,
      });
    }
    return out;
  },
  /**
   * Cronograma de la página japonesa de la carrera: una pestaña por día (data-target="2026-11-06") y, en el
   * mismo orden, un bloque .table_box con las sesiones (.race_box, data-from/data-to en hora local).
   * Solo las de SUPER GT ("SUPER GT : 公式予選"); las de FIA-F4 y los eventos para el público se omiten.
   */
  async sessions(entry, ctx) {
    if (!entry.url) return null;
    const url = supergtJapaneseUrl(entry.url);
    const html = await pageOrNull(ctx, url);
    if (!html) return null;
    const clean = stripComments(html);
    const dates = [...clean.matchAll(/class="table_date_tab"[^>]*>\s*<a\b[^>]*data-target="(\d{4}-\d{2}-\d{2})"/gi)].map((m) => m[1]!);
    const boxes = clean.split(/<div class="table_box\b[^"]*">/i).slice(1);
    const sessions: ExtractedSession[] = [];
    boxes.forEach((box, i) => {
      const date = dates[i];
      if (!date) return;
      // Cada sesión aparece dos veces (versión de escritorio .pc520 y de celular .sp520): se toma la de escritorio.
      for (const m of box.matchAll(/<div class="race_box schedule_box pc520"([^>]*)>\s*<h6>([\s\S]*?)<\/h6>/gi)) {
        const title = textOf(m[2] ?? '');
        const raw = title.match(/SUPER\s*GT\s*[:：]\s*(.+)$/i)?.[1];
        const name = raw ? sessionName(raw) : null;
        const from = attr(m[1] ?? '', 'data-from') ?? '';
        const to = attr(m[1] ?? '', 'data-to') ?? '';
        if (!name || !/^\d{1,2}:\d{2}$/.test(from)) continue;
        sessions.push({
          name,
          startUtc: localToUtc(date, from, entry.tz),
          ...(/^\d{1,2}:\d{2}$/.test(to) && to !== from ? { endUtc: localToUtc(date, to, entry.tz) } : {}),
          localStartText: from.padStart(5, '0'),
        });
      }
    });
    if (sessions.length === 0) return null;
    return {
      sessions: uniqueNames(sessions),
      source: { url, title: `Race & Event Schedule SUPER GT — ${entry.name}`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) },
    };
  },
  /**
   * Rankings de pilotos y de equipos de GT500 y GT300 (/en/driver_ranking y /en/team_ranking con
   * ?series=AAAA&gt_class=…). Si la temporada pedida todavía no tiene datos el sitio muestra la actual:
   * el selector de temporada lo delata y se devuelve null.
   */
  async standings(url, ctx) {
    const tables: StandingsTable[] = [];
    let firstUrl = '';
    for (const cls of CLASSES) {
      const label = cls.toUpperCase();
      const driversUrl = `${BASE}/driver_ranking?series=${ctx.season}&gt_class=${cls}`;
      const teamsUrl = `${BASE}/team_ranking?series=${ctx.season}&gt_class=${cls}`;
      const driversHtml = await pageOrNull(ctx, driversUrl);
      const teamsHtml = await pageOrNull(ctx, teamsUrl);
      if (!driversHtml || !teamsHtml) return null;
      if (activeSeries(driversHtml) !== ctx.season || activeSeries(teamsHtml) !== ctx.season) return null;
      firstUrl ||= driversUrl;
      const teamTable = rankingTable(teamsHtml, 'team', `Equipos ${label}`, new Map());
      const teamByNumber = new Map((teamTable?.rows ?? []).map((r) => [r.number ?? '', r.name]));
      const driverTable = rankingTable(driversHtml, 'driver', `Pilotos ${label}`, teamByNumber);
      if (driverTable) tables.push(driverTable);
      if (teamTable) tables.push(teamTable);
    }
    if (tables.length === 0) return null;
    // Orden: pilotos de cada clase primero, después equipos.
    tables.sort((a, b) => Number(b.title.startsWith('Pilotos')) - Number(a.title.startsWith('Pilotos')));
    return { tables, source: standingsSource(firstUrl || url, `Driver Ranking SUPER GT ${ctx.season}`, ctx) };
  },
  /**
   * Inscriptos de la temporada (/en/teams_and_drivers?series=AAAA&gt_class=gt500|gt300): una fila por auto
   * con sus pilotos (incluido el tercer piloto), el equipo, el auto y el modelo entre paréntesis.
   */
  async roster(_url, ctx) {
    const rows: RosterRow[] = [];
    let firstUrl = '';
    for (const cls of CLASSES) {
      const pageUrl = `${BASE}/teams_and_drivers?series=${ctx.season}&gt_class=${cls}`;
      const html = await pageOrNull(ctx, pageUrl);
      if (!html) return null;
      const clean = stripComments(html);
      const year = Number(clean.match(/(\d{4})\s+Series Entry/i)?.[1] ?? 0);
      if (year !== ctx.season) return null;
      firstUrl ||= pageUrl;
      const start = clean.search(/<table class="common drivers_teams">/i);
      if (start < 0) continue; // temporada anunciada sin inscriptos todavía
      const end = clean.indexOf('</section>', start);
      const region = clean.slice(start, end > start ? end : undefined);
      // La celda de pilotos tiene tablas anidadas: se trocea por el número de cada auto.
      const parts = region.split(/<span class="bib (gt\d+)">\s*(\d+)\s*<\/span>/i);
      for (let i = 1; i + 2 < parts.length; i += 3) {
        const cssClass = parts[i]!.toUpperCase();
        const number = parts[i + 1]!;
        const chunk = parts[i + 2]!;
        const team = textOf(chunk.match(/<dt>\s*team\s*<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/i)?.[1] ?? '');
        const model = textOf(chunk.match(/<dt>\s*machine\s*<\/dt>\s*<dd\b[^>]*>[\s\S]*?<\/dd>\s*<dd\b[^>]*>\s*\(([\s\S]*?)\)\s*<\/dd>/i)?.[1] ?? '');
        for (const driver of new Set(driverNames(chunk))) {
          rows.push({ driver, ...(team ? { team } : {}), number, ...(model ? { vehicle: model } : {}), class: cssClass });
        }
      }
    }
    if (rows.length === 0) return null;
    return {
      rows,
      source: { url: firstUrl, title: `Teams & Drivers SUPER GT ${ctx.season}`, kind: 'html', method: 'directo', fetchedAt: isoNow(ctx.now) },
    };
  },
};
