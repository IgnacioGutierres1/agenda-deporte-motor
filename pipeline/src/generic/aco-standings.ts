/**
 * Campeonato del WEC, la ELMS y la Asian LMS (misma plataforma del ACO), leído sin IA.
 *
 * Cada sitio publica todas sus tablas en una sola página (fiawec.com/en/page/manufacturers-classification,
 * europeanlemansseries.com/en/page/classification-2, asianlemansseries.com/en/page/classification): un botón por
 * tabla ("FIA Hypercar World Endurance Drivers Championship", "LMP2 Teams Classification"…) que despliega su
 * <table> con "Pos. | N° | Drivers/Team | una columna por carrera | Total points". Los pilotos de un mismo auto
 * van en una sola fila (la tripulación) y los links a fichas llevan la temporada: /en/car/2026/22.
 */
import type { StandingsRow, StandingsTable } from '@dm/shared';
import { absoluteUrl, attr, textOf } from '../extract/html.ts';
import { checkStandingsTable, column, parseNumber, standingsSource, stripComments } from './kit.ts';
import { className } from './rosters.ts';
import type { RecipeContext, StandingsFound } from './types.ts';

/**
 * Título en castellano a partir del botón de la tabla:
 * "FIA Hypercar World Endurance Manufacturers’ Championship" -> "Marcas Hypercar",
 * "FIA Endurance Trophy for LMGT3 Drivers" -> "Pilotos LMGT3", "LMP2 Pro/Am Teams Classification" -> "Equipos LMP2 Pro/Am".
 */
export function acoTableTitle(label: string): string {
  const kind = /manufacturer/i.test(label) ? 'Marcas' : /\bteams?\b/i.test(label) ? 'Equipos' : 'Pilotos';
  const qualifier = className(
    label
      .replace(/manufacturers?[’']?s?/gi, ' ')
      .replace(/\b(fia|world|endurance|championship|trophy|cup|for|teams?|drivers?|classification)\b/gi, ' '),
  );
  return qualifier ? `${kind} ${qualifier}` : kind;
}

/** Temporada que muestra la página: la de los links a fichas de autos y pilotos (/en/car/2026/22). null si no hay. */
export function acoShownSeason(html: string): number | null {
  const count = new Map<number, number>();
  for (const m of html.matchAll(/\/en\/(?:car|driver)\/(\d{4})\//g)) count.set(Number(m[1]), (count.get(Number(m[1])) ?? 0) + 1);
  let best: number | null = null;
  for (const [year, n] of count) if (best === null || n > count.get(best)!) best = year;
  return best;
}

/** Opciones del selector de temporada del WEC: <option data-url="…?season_id=4175" selected>2026</option>. */
export function acoSeasonOptions(html: string, pageUrl: string): { season: number; url: string; selected: boolean }[] {
  const out: { season: number; url: string; selected: boolean }[] = [];
  for (const m of html.matchAll(/<option\b([^>]*)>\s*(\d{4})\s*</gi)) {
    const href = attr(m[1] ?? '', 'data-url');
    if (!href || !/season_id=/.test(href)) continue;
    const url = absoluteUrl(href, pageUrl);
    if (url) out.push({ season: Number(m[2]), url, selected: /\bselected\b/i.test(m[1] ?? '') });
  }
  return out;
}

const cells = (tr: string) => [...tr.matchAll(/<t([hd])\b[^>]*>([\s\S]*?)<\/t\1>/gi)].map((c) => c[2] ?? '');

/**
 * Una tabla: posición, número, nombre (la tripulación "A / B / C" si la celda trae varios pilotos) y total.
 * El sitio a veces publica filas sin nombre (la ALMS 2025-26 tiene autos sin pilotos cargados): se omiten, y
 * entonces solo se exige que las posiciones arranquen en 1 y no bajen. null si la tabla no tiene filas.
 */
export function acoTable(tableHtml: string, title: string): StandingsTable | null {
  const head = tableHtml.match(/<thead\b[\s\S]*?<\/thead>/i)?.[0] ?? '';
  const headers = cells(head).map((c) => textOf(c));
  const cPos = column(headers, /^pos/i);
  const cNum = column(headers, /^n[°º]|^no\.?$|^#$/i);
  const cTotal = column(headers, /^total/i);
  // Pilotos ("Drivers"; la tabla de pilotos de GT de la ALMS dice "Team"), equipo o marca ("Man.").
  const cName = [/^drivers?$/i, /^teams?$/i, /^man(\.|ufacturers?)?$/i].map((re) => column(headers, re)).find((i) => i >= 0) ?? -1;
  if (cPos < 0 || cName < 0 || cTotal < 0) throw new Error(`ACO: "${title}" sin las columnas esperadas (${headers.join(', ')})`);
  const body = tableHtml.match(/<tbody\b[\s\S]*?<\/tbody>/i)?.[0] ?? '';
  const rows: StandingsRow[] = [];
  let skipped = 0;
  for (const tr of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const c = cells(tr[1] ?? '');
    const pos = textOf(c[cPos] ?? '');
    if (!/^\d+$/.test(pos)) continue;
    const nameCell = c[cName] ?? '';
    const drivers = [...nameCell.matchAll(/<a\b[^>]*href="[^"]*\/driver\/[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)].map((m) => textOf(m[1] ?? '')).filter(Boolean);
    const name = drivers.length ? drivers.join(' / ') : textOf(nameCell);
    if (!name) {
      skipped++;
      continue;
    }
    const number = cNum >= 0 ? textOf(c[cNum] ?? '').replace(/^#\s*/, '') : '';
    rows.push({ pos: Number(pos), name, ...(number ? { number } : {}), points: parseNumber(textOf(c[cTotal] ?? '')) ?? NaN });
  }
  if (rows.length === 0) return null;
  const table = { title, rows };
  if (skipped === 0) return checkStandingsTable(table);
  rows.forEach((r, i) => {
    if ((i === 0 ? r.pos < 1 : r.pos < rows[i - 1]!.pos) || !Number.isFinite(r.points)) {
      throw new Error(`Fila inesperada en "${title}": ${JSON.stringify(r)}`);
    }
  });
  return table;
}

/**
 * Todas las tablas de la página, primero las de pilotos (como en el resto de las categorías). Las filas de
 * pilotos llevan el equipo de la tabla de equipos de su clase (mismo número de auto), si la hay.
 */
export function acoStandingsTables(html: string): StandingsTable[] {
  const page = stripComments(html);
  const tables: StandingsTable[] = [];
  for (const m of page.matchAll(/<button\b[^>]*data-bs-target="#([\w-]+)"[^>]*>([\s\S]*?)<\/button>/gi)) {
    const at = page.indexOf(`id="${m[1]}"`);
    if (at < 0) continue;
    const tableHtml = page.slice(at).match(/<table\b[\s\S]*?<\/table>/i)?.[0];
    if (!tableHtml) continue;
    const table = acoTable(tableHtml, acoTableTitle(textOf(m[2] ?? '')));
    if (table) tables.push(table);
  }
  for (const t of tables) {
    if (!t.title.startsWith('Pilotos')) continue;
    const teams = tables.find((x) => x.title === t.title.replace(/^Pilotos/, 'Equipos'));
    if (!teams) continue;
    const byNumber = new Map(teams.rows.filter((r) => r.number).map((r) => [r.number!, r.name]));
    for (const r of t.rows) {
      const team = r.number ? byNumber.get(r.number) : undefined;
      if (team) r.team = team;
    }
  }
  return tables.sort((a, b) => Number(b.title.startsWith('Pilotos')) - Number(a.title.startsWith('Pilotos')));
}

/**
 * Lector del campeonato. Si la página tiene selector de temporada (WEC) se pide la temporada indicada; si no
 * (ELMS, ALMS), la temporada es la de los links de las tablas: la ALMS sigue mostrando la 2025-26 hasta que se
 * corre la primera carrera de la 2026-27. null si la temporada pedida no está publicada.
 */
export async function acoStandings(url: string, ctx: RecipeContext): Promise<StandingsFound | null> {
  const u = new URL(url);
  const base = `${u.origin}${u.pathname}`;
  let pageUrl = base;
  let html = (await ctx.http.text(base)).body;
  const options = acoSeasonOptions(html, base);
  if (options.length > 0) {
    const wanted = options.find((o) => o.season === ctx.season);
    if (!wanted) return null;
    if (!wanted.selected) {
      pageUrl = wanted.url;
      html = (await ctx.http.text(pageUrl)).body;
    }
  }
  const shown = acoShownSeason(html);
  if (shown !== null && shown !== ctx.season) return null;
  if (!/data-bs-target="#results-/.test(html)) throw new Error('ACO: la página de campeonato no tiene tablas');
  const tables = acoStandingsTables(html);
  if (tables.length === 0 || shown === null) return null;
  const title = textOf(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '').replace(/^\d{4}\s+/, '') || 'Classification';
  return { tables, source: standingsSource(pageUrl, `${title} ${ctx.season}`, ctx) };
}
