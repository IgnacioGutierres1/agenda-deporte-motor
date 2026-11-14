/**
 * Historia de cada categoría (data/bios/series.json): resumen, logo, año de fundación, organizador y la lista de
 * campeones por temporada, con récords calculados (más títulos, primer campeón, campeón vigente).
 *
 * Qué leer de cada categoría está en config/series-history.json (versionado): el elemento de Wikidata y las
 * tablas de Wikipedia con los campeones (página, sección y columnas; ver champions.ts). La primera fuente es la
 * principal: de ella salen los récords de pilotos y el enlace "fuente" de la ficha.
 */
import path from 'node:path';
import { z } from 'zod';
import { driverId, splitDriverNames, teamKey, type SeriesChampion, type SeriesHistory } from '@dm/shared';
import type { Api } from '../circuits/api.ts';
import { fetchImages } from '../circuits/commons.ts';
import { wikiUrl } from '../circuits/wikipedia.ts';
import { CONFIG_DIR } from '../core/paths.ts';
import { readJson } from '../core/store.ts';
import { pickTable, readChampions, type ChampionRow, type ChampionsSource } from './champions.ts';
import { earliestYear, fetchExtracts, firstString, getItems, itemIds, labelsOf, pickSummary, type WdItem } from './wd.ts';
import { parseWikiTables, type WikiTable } from './wikitable.ts';

// ── Configuración ──

const colSchema = z.union([z.number().int().nonnegative(), z.string().min(1)]);
const pickSchema = { section: z.string().optional(), table: z.number().int().nonnegative().optional() };

const sourceSchema = z.object({
  lang: z.string().regex(/^[a-z]{2,3}$/),
  page: z.string().min(1),
  ...pickSchema,
  season: colSchema.optional(),
  driver: z.union([colSchema, z.array(colSchema)]).optional(),
  team: colSchema.optional(),
  vehicle: z.union([colSchema, z.array(colSchema)]).optional(),
  vehicleJoin: z.string().optional(),
  class: colSchema.optional(),
  classAs: z.enum(['class', 'raw']).optional(),
  classes: z.union([z.literal(true), z.array(colSchema)]).optional(),
  teams: z.object(pickSchema).optional(),
  note: z.string().optional(),
  where: z.object({ col: colSchema, match: z.string() }).optional(),
  from: z.number().int().optional(),
  to: z.number().int().optional(),
  teamParen: z.boolean().optional(),
  vehicleIsMake: z.boolean().optional(),
  makeWord: z.boolean().optional(),
  classesExclude: z.string().optional(),
  secondary: z.boolean().optional(),
  records: z.enum(['all', 'teams', 'none']).optional(),
});

const specSchema = z.object({
  wikidata: z.string().regex(/^Q\d+$/).optional(),
  article: z.object({ es: z.string().optional(), en: z.string().optional() }).optional(),
  organizer: z.string().optional(),
  founded: z.number().int().optional(),
  /** "winners": la lista es de ganadores de una carrera (Macao, Dakar, Baja 1000), no de campeones. */
  kind: z.enum(['champions', 'winners']).optional(),
  champions: z.array(sourceSchema),
});

export type SeriesHistorySpec = z.infer<typeof specSchema>;
export type SeriesHistoryConfig = Record<string, SeriesHistorySpec>;

/** config/series-history.json (sin la clave $comment). */
export async function loadSeriesHistoryConfig(configDir = CONFIG_DIR): Promise<SeriesHistoryConfig> {
  const raw = await readJson<Record<string, unknown>>(path.join(configDir, 'series-history.json'));
  if (!raw) return {};
  const { $comment: _ignored, ...rest } = raw;
  return z.record(specSchema).parse(rest);
}

// ── Vínculos con la app ──

export interface AppIndex {
  /** Ids de data/drivers-index.json. */
  drivers: Set<string>;
  /** Equipos de data/teams.json: id, nombre y categorías. */
  teams: Array<{ id: string; name: string; series: string[] }>;
  /** Artículo de Wikipedia ("en:Red Bull Racing", "es:Escudería…") -> id del equipo, de las fichas ya hechas. */
  teamArticles: Map<string, string>;
}

const GENERIC = new Set(['team', 'racing', 'motorsport', 'motorsports', 'the', 'by', 'with', 'f1', 'formula', 'one', 'srl', 'ltd', 'gmbh', 'inc', 'llc', 'sa', 'ag', 'co', 'de', 'and']);

/** Palabras distintivas del nombre de un equipo (sin "Team", "Racing", "Motorsport"…). */
export function coreTokens(name: string): string[] {
  return teamKey(name)
    .split(' ')
    .filter((t) => t && !GENERIC.has(t));
}

/** true si las palabras de `small` aparecen en orden dentro de `big`. */
function inOrder(small: string[], big: string[]): boolean {
  let i = 0;
  for (const t of big) if (t === small[i]) i++;
  return small.length > 0 && i === small.length;
}

/**
 * Id del equipo de la app que corresponde al nombre de una tabla: por el artículo enlazado (si el equipo ya tiene
 * ficha), por el mismo id, o por las palabras distintivas entre los equipos de esa categoría (si hay uno solo).
 */
export function linkTeam(index: AppIndex, seriesId: string, name: string | undefined, links: string[] = [], lang = 'en'): string | undefined {
  for (const l of links) {
    const id = index.teamArticles.get(`${lang}:${l}`);
    if (id) return id;
  }
  if (!name) return undefined;
  const key = teamKey(name);
  const exact = index.teams.find((t) => teamKey(t.name) === key);
  if (exact) return exact.id;
  const core = coreTokens(name);
  if (!core.length || (core.length === 1 && core[0]!.length < 4)) return undefined;
  const hits = index.teams.filter((t) => {
    if (!t.series.includes(seriesId)) return false;
    const other = coreTokens(t.name);
    return other.length > 0 && (inOrder(core, other) || (other.length >= 2 && inOrder(other, core)));
  });
  return hits.length === 1 ? hits[0]!.id : undefined;
}

/** Id del piloto en la app, si es uno solo y figura en data/drivers-index.json. */
export function linkDriver(index: AppIndex, seriesId: string, driver: string | undefined): string | undefined {
  if (!driver || driver.includes(' / ')) return undefined;
  const id = driverId(driver, seriesId);
  return id && index.drivers.has(id) ? id : undefined;
}

// ── Récords ──

function top(counts: Map<string, { name: string; n: number }>): string | undefined {
  const list = [...counts.values()].sort((a, b) => b.n - a.n);
  const best = list[0];
  if (!best || best.n < 2) return undefined;
  const tied = list.filter((x) => x.n === best.n).map((x) => x.name);
  const names = tied.length > 3 ? `${tied.slice(0, 3).join(', ')} y otros` : tied.length > 1 ? `${tied.slice(0, -1).join(', ')} y ${tied[tied.length - 1]}` : tied[0];
  return `${names} (${best.n})`;
}

function count(map: Map<string, { name: string; n: number }>, name: string, key: string): void {
  const prev = map.get(key);
  if (prev) prev.n++;
  else map.set(key, { name, n: 1 });
}

/** Récords de la lista: más títulos (pilotos, equipos, marcas), primer campeón y campeón vigente. */
export function computeRecords(
  rows: Array<ChampionRow & { countDriver?: boolean; countTeam?: boolean }>,
  kind: 'champions' | 'winners' = 'champions',
): Array<{ label: string; value: string }> {
  const w = kind === 'winners';
  const drivers = new Map<string, { name: string; n: number }>();
  const teams = new Map<string, { name: string; n: number }>();
  const makes = new Map<string, { name: string; n: number }>();
  const main = rows.filter((r) => r.primary && r.driver).sort((a, b) => a.season - b.season);
  for (const r of rows) {
    if (r.countDriver !== false && r.primary && r.driver) {
      for (const name of r.driver.split(' / ')) {
        const parts = splitDriverNames(name);
        for (const p of parts.length ? parts : [name]) count(drivers, p, driverId(p) || p.toLowerCase());
      }
    }
    if (r.countTeam && r.team) count(teams, r.team, teamKey(r.team));
    if (r.primary && r.make) count(makes, r.make, r.make.toLowerCase());
  }
  const out: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: string | undefined) => value && out.push({ label, value });
  push(w ? 'Más victorias' : 'Más títulos', top(drivers));
  push(w ? 'Más victorias de equipos' : 'Más títulos de equipos', top(teams));
  push(w ? 'Más victorias de marcas' : 'Más títulos de marcas', top(makes));
  const first = main[0];
  const last = main[main.length - 1];
  if (first) push(w ? 'Primer ganador' : 'Primer campeón', `${first.driver} (${first.season})`);
  if (last && last !== first) push(w ? 'Último ganador' : 'Campeón vigente', `${last.driver} (${last.season})`);
  if (main.length) push(w ? 'Ganadores distintos' : 'Campeones distintos', String(new Set(main.map((r) => r.driver)).size));
  return out;
}

// ── Lectura ──

export interface SeriesBuildContext {
  nowIso: string;
  index: AppIndex;
}

interface ParsedPage {
  title: string;
  tables: WikiTable[];
}

/** HTML de una página de Wikipedia (action=parse) convertido en tablas. */
export async function fetchTables(api: Api, lang: string, page: string): Promise<ParsedPage | null> {
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(page)}` +
    '&prop=text&redirects=1&disableeditsection=1&disablelimitreport=1&format=json&formatversion=2';
  const res = await api.get<{ parse?: { title?: string; text?: string }; error?: { code?: string } }>(url);
  if (!res.parse?.text) return null;
  return { title: res.parse.title ?? page, tables: parseWikiTables(res.parse.text) };
}

/** Campeones de todas las fuentes de una categoría, de la temporada más reciente a la más vieja. */
export async function readSeriesChampions(
  api: Api,
  seriesId: string,
  spec: SeriesHistorySpec,
  index: AppIndex,
  warn: (msg: string) => void,
): Promise<{ rows: Array<ChampionRow & { countDriver: boolean; countTeam: boolean }>; source?: { url: string; title: string } }> {
  const rows: Array<ChampionRow & { countDriver: boolean; countTeam: boolean }> = [];
  let source: { url: string; title: string } | undefined;
  // Si hay un campeonato de equipos o constructores aparte, solo ese cuenta para el récord de equipos.
  const teamsApart = spec.champions.some((s) => s.records === 'teams');
  for (const [i, src] of spec.champions.entries()) {
    const page = await fetchTables(api, src.lang, src.page);
    if (!page) {
      warn(`${seriesId}: no existe la página ${src.lang}:${src.page}`);
      continue;
    }
    const table = pickTable(page.tables, src, src.season);
    if (!table) {
      warn(`${seriesId}: no se encontró la tabla de campeones en ${src.lang}:${page.title}${src.section ? ` (sección ${src.section})` : ''}`);
      continue;
    }
    const teamsTable = src.teams ? pickTable(page.tables, src.teams) : undefined;
    const found = readChampions(table, src as ChampionsSource, teamsTable);
    if (!found.length) warn(`${seriesId}: la tabla de ${src.lang}:${page.title} no dio campeones`);
    if (i === 0 && found.length) source = { url: wikiUrl(src.lang as 'es', page.title), title: page.title };
    const records = src.records ?? 'all';
    for (const r of found) {
      rows.push({
        ...r,
        primary: r.primary && records === 'all',
        countDriver: records === 'all',
        countTeam: teamsApart ? records === 'teams' : records === 'all' && r.primary,
        ...linkRow(index, seriesId, r, src.lang),
      });
    }
  }
  rows.sort((a, b) => b.season - a.season);
  return { rows, source };
}

function linkRow(index: AppIndex, seriesId: string, r: ChampionRow, lang: string): Partial<SeriesChampion> {
  const out: Partial<SeriesChampion> = {};
  const d = linkDriver(index, seriesId, r.driver);
  if (d) out.driverId = d;
  const t = linkTeam(index, seriesId, r.team, r.teamLinks, lang);
  if (t) out.teamId = t;
  return out;
}

/** Lo que se publica de un campeón (sin los datos internos). */
export function publicChampion(r: ChampionRow): SeriesChampion {
  const out: SeriesChampion = { season: r.season };
  if (r.driver) out.driver = r.driver;
  if (r.driverId) out.driverId = r.driverId;
  if (r.team) out.team = r.team;
  if (r.teamId) out.teamId = r.teamId;
  if (r.vehicle) out.vehicle = r.vehicle;
  if (r.note) out.note = r.note;
  return out;
}

/**
 * Historia de varias categorías. Los datos de Wikidata, los logos y los resúmenes se piden juntos; las páginas de
 * campeones, una por fuente. Un error de una fuente (SourceLimitError) corta todo: lo resuelve quien llama.
 */
export async function buildSeriesHistories(
  api: Api,
  specs: Array<[string, SeriesHistorySpec]>,
  ctx: SeriesBuildContext,
  warn: (msg: string) => void,
): Promise<SeriesHistory[]> {
  const items = await getItems(
    api,
    specs.map(([, s]) => s.wikidata ?? '').filter(Boolean),
  );
  const itemOf = (s: SeriesHistorySpec): WdItem | undefined => (s.wikidata ? items.get(s.wikidata) : undefined);

  // Organizador (si la configuración no lo fija), logos y resúmenes.
  const orgIds = specs.flatMap(([, s]) => (s.organizer ? [] : itemIds(itemOf(s)?.claims ?? {}, 'P664').slice(0, 2)));
  const orgLabels = orgIds.length ? await labelsOf(api, orgIds) : new Map();
  const logoFiles = new Map(specs.map(([id, s]) => [id, firstString(itemOf(s)?.claims ?? {}, 'P154')]));
  const logos = await fetchImages(api, [...logoFiles.values()].filter((f): f is string => !!f), 320);
  const titles = new Map(
    specs.map(([id, s]) => [id, { eswiki: s.article?.es ?? itemOf(s)?.eswiki, enwiki: s.article?.en ?? itemOf(s)?.enwiki }]),
  );
  const es = await fetchExtracts(api, 'es', [...titles.values()].map((t) => t.eswiki ?? '').filter(Boolean));
  const en = await fetchExtracts(
    api,
    'en',
    [...titles.entries()].filter(([, t]) => !t.eswiki || !es.has(t.eswiki)).map(([, t]) => t.enwiki ?? '').filter(Boolean),
  );

  const out: SeriesHistory[] = [];
  for (const [seriesId, spec] of specs) {
    const item = itemOf(spec);
    const { rows, source } = await readSeriesChampions(api, seriesId, spec, ctx.index, warn);
    const history: SeriesHistory = { seriesId, champions: rows.map(publicChampion), updatedAt: ctx.nowIso };
    if (spec.wikidata) history.wikidata = spec.wikidata;
    const summary = pickSummary(titles.get(seriesId) ?? {}, es, en);
    if (summary) history.summary = summary;
    const file = logoFiles.get(seriesId);
    const logo = file ? logos.get(fileKeyOf(file)) : undefined;
    if (logo) history.logo = logo;
    const firstSeason = rows.length ? Math.min(...rows.map((r) => r.season)) : undefined;
    // Fundación según Wikidata, salvo que la lista tenga un campeón anterior (TC Pick Up: 2019 en Wikidata, campeón 2018).
    const inception = earliestYear(item?.claims ?? {}, 'P571');
    const founded = spec.founded ?? (inception && firstSeason ? Math.min(inception, firstSeason) : (inception ?? firstSeason));
    if (founded) history.founded = founded;
    const organizer =
      spec.organizer ??
      itemIds(item?.claims ?? {}, 'P664')
        .slice(0, 2)
        .map((q) => orgLabels.get(q)?.label)
        .filter(Boolean)
        .join(' / ');
    if (organizer) history.organizer = organizer;
    const records = computeRecords(rows, spec.kind);
    if (records.length) history.records = records;
    if (source) history.championsSource = source;
    out.push(history);
  }
  return out;
}

function fileKeyOf(name: string): string {
  const t = name.replace(/_/g, ' ').trim();
  return t ? t[0]!.toUpperCase() + t.slice(1) : '';
}
