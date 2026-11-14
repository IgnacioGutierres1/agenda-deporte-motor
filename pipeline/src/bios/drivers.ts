/**
 * Historial de pilotos (data/bios/drivers/{shard}.json, mismo shard que data/drivers): ficha con resumen, fecha y
 * lugar de nacimiento, nacionalidad, foto, trayectoria, títulos y enlaces, a partir de Wikidata, Wikipedia y Commons
 * (y fotos oficiales de los sitios que el pipeline ya lee).
 *
 * Es incremental, porque Wikimedia limita a ~10 consultas por minuto a los clientes sin contacto en el User-Agent:
 *  - cada corrida procesa a lo sumo `limit` pilotos, primero los de las categorías principales y los nunca vistos;
 *  - una ficha se renueva cada REFRESH_DAYS días (trayectoria y foto cambian); un piloto sin ficha se vuelve a
 *    buscar cada RECHECK_DAYS días;
 *  - lo decidido queda en data/_cache/bios-drivers.json (ítem aceptado o motivo del descarte), así un descarte no
 *    se repite en cada corrida y un piloto ya identificado no se vuelve a buscar;
 *  - ante un límite de Wikimedia (429 repetido o 403) se corta y se guarda lo hecho.
 * En cada corrida, sin consultar nada, se completa la temporada en curso de todas las fichas con los datos de la app
 * (tablas de campeonato y estadísticas de data/drivers), si Wikipedia todavía no la tiene.
 *
 * Uso local (llenado inicial): npm run bios:drivers -- [--limit=200] [--only=franco-colapinto,matias-rossi] [--force] [--dry-run]
 */
import { readdir, readFile, rm } from 'node:fs/promises';
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  baseDriverId,
  driverBiosShardFileSchema,
  driverShard,
  driversIndexFileSchema,
  type CareerSeason,
  type CreditedImage,
  type DriverBio,
  type DriverBiosShardFile,
  type DriverDetail,
  type DriverShardFile,
  type Driver,
  type Series,
} from '@dm/shared';
import { createApi, SourceLimitError, type Api } from '../circuits/api.ts';
import { fetchImages } from '../circuits/commons.ts';
import { loadConfig } from '../core/config.ts';
import { createHttp, type Http } from '../core/http.ts';
import { createLogger, type Logger } from '../core/log.ts';
import { DATA_DIR } from '../core/paths.ts';
import { readJson, writeJson } from '../core/store.ts';
import { careerFromWikitext, mentionsSeries, sortCareer, titlesOf, words } from './career.ts';
import { fetchDetails, nationalityOf, pickImage } from './details.ts';
import { candidateInfo, chooseCandidate, sameName, searchNames, type Candidate, type CandidateEvidence } from './identify.ts';
import { fetchOfficialPhotos, OFFICIAL_PHOTO_SERIES, type PhotoMap } from './official-photos.ts';
import { fetchPages, summaryOf, type WikiPage } from './wiki.ts';

/** Pilotos por corrida del pipeline (~12 consultas a Wikimedia por cada 50). */
export const BIOS_PER_RUN = 40;
/** Cada cuánto se renueva una ficha. */
export const REFRESH_DAYS = 30;
/** Cada cuánto se vuelve a buscar un piloto sin ficha. */
export const RECHECK_DAYS = 60;
/** Pilotos por lote de consultas. */
const CHUNK = 50;
/** Ancho de las miniaturas de Commons. */
const PHOTO_WIDTH = 480;

/**
 * Orden de llenado: primero los campeonatos principales y los argentinos; después el resto de las categorías con
 * tabla, y al final los que solo figuran en listas de inscriptos.
 */
export const PRIORITY_SERIES = [
  'f1',
  'motogp',
  'tc',
  'tc2000',
  'indycar',
  'wec',
  'moto2',
  'moto3',
  'f2',
  'f3',
  'tn',
  'turismo-pista',
  'tc-pista',
  'tc-mouras',
  'tc-pickup',
  'nascar-cup',
  'imsa',
  'wrc',
  'supercars',
  'dtm',
  'super-formula',
  'super-gt',
  'f1-academy',
  'indy-nxt',
  'elms',
  'nascar-xfinity',
  'nascar-truck',
  'gtwc-europe',
  'igtc',
  'alms',
];

/** Países tal como los publican las listas oficiales (nombre en inglés o código) → ISO 3166-1 alfa-2. */
const COUNTRY_ISO: Record<string, string> = {
  andorra: 'AD', angola: 'AO', argentina: 'AR', armenia: 'AM', australia: 'AU', austria: 'AT', bangladesh: 'BD',
  belgium: 'BE', brazil: 'BR', bulgaria: 'BG', canada: 'CA', chile: 'CL', china: 'CN', colombia: 'CO',
  'costa rica': 'CR', cyprus: 'CY', 'czech republic': 'CZ', czechia: 'CZ', denmark: 'DK', 'el salvador': 'SV',
  estonia: 'EE', finland: 'FI', france: 'FR', germany: 'DE', 'great britain': 'GB', 'united kingdom': 'GB',
  'gb-eng': 'GB', england: 'GB', scotland: 'GB', wales: 'GB', greece: 'GR', grenada: 'GD', 'hong kong': 'HK',
  hungary: 'HU', india: 'IN', indonesia: 'ID', ireland: 'IE', israel: 'IL', italy: 'IT', japan: 'JP', jordan: 'JO',
  kazakhstan: 'KZ', kuwait: 'KW', kyrgyzstan: 'KG', latvia: 'LV', lebanon: 'LB', lithuania: 'LT', luxembourg: 'LU',
  malaysia: 'MY', mexico: 'MX', monaco: 'MC', montenegro: 'ME', netherlands: 'NL', 'new zealand': 'NZ', norway: 'NO',
  oman: 'OM', pakistan: 'PK', paraguay: 'PY', peru: 'PE', poland: 'PL', portugal: 'PT', qatar: 'QA', russia: 'RU',
  'san marino': 'SM', 'saudi arabia': 'SA', singapore: 'SG', slovakia: 'SK', slovenia: 'SI', 'south africa': 'ZA',
  spain: 'ES', 'sri lanka': 'LK', 'st. kitts & nevis': 'KN', sweden: 'SE', switzerland: 'CH', taiwan: 'TW',
  thailand: 'TH', turkey: 'TR', ukraine: 'UA', 'united arab emirates': 'AE', uae: 'AE', 'united states': 'US',
  usa: 'US', uruguay: 'UY', uzbekistan: 'UZ', vanuatu: 'VU', zimbabwe: 'ZW',
};

/** ISO alfa-2 del país publicado ("Great Britain", "GB", "GB-ENG"), si se reconoce. */
export function countryIso(country: string | undefined): string | undefined {
  if (!country) return undefined;
  const t = country.trim();
  if (/^[A-Z]{2}$/.test(t)) return t;
  return COUNTRY_ISO[t.toLowerCase()] ?? (/^[A-Z]{2}-[A-Z]{3}$/.test(t) ? t.slice(0, 2) : undefined);
}

/** Lo decidido para cada piloto. */
export interface BioCacheEntry {
  name: string;
  checkedAt: string;
  /** Ítem aceptado. */
  wikidata?: string;
  /** Motivo de la elección o del descarte. */
  reason: string;
}
export type BioCache = Record<string, BioCacheEntry>;

export interface RunDriverBiosOptions {
  log: Logger;
  dataDir?: string;
  configDir?: string;
  now?: Date;
  /** Pilotos a procesar en esta corrida. */
  limit?: number;
  /** Solo estos pilotos (ids). */
  only?: string[];
  /** Procesa aunque la ficha esté al día o el piloto se haya descartado hace poco, y vuelve a identificarlo. */
  force?: boolean;
  dryRun?: boolean;
  /** Cliente para Wikimedia (pausa entre consultas). */
  api?: Api;
  /** Cliente para los sitios oficiales (fotos). */
  http?: Http;
  /** Categorías (para el nombre de las filas de la temporada en curso). */
  series?: Series[];
}

export interface RunDriverBiosResult {
  /** Pilotos procesados (buscados o renovados). */
  processed: number;
  identified: number;
  rejected: number;
  /** Fichas escritas en esta corrida con foto / con trayectoria. */
  withPhoto: number;
  withCareer: number;
  /** Pilotos que quedaron para otra corrida. */
  pending: number;
  /** Grupos (archivos) escritos y borrados. */
  written: number;
  removed: number;
  /** Motivo del corte, si Wikimedia pidió frenar. */
  stopped?: string;
}

const days = (from: string | undefined, now: Date): number =>
  from ? (now.getTime() - Date.parse(from)) / 86_400_000 : Number.POSITIVE_INFINITY;

/** Nombre que no sirve para buscar: una sola palabra, iniciales ("A. Danielsson") o letras rotas. */
export function searchableName(name: string): boolean {
  const parts = name.replace(/^[-–\s]+/, '').trim().split(/\s+/);
  if (parts.length < 2) return false;
  if (parts.some((p) => /^\p{L}\.?$/u.test(p))) return false;
  return !/[?�]/.test(name);
}

function seriesOf(d: Driver): string[] {
  return [...new Set([...d.entries.map((e) => e.seriesId), ...(d.lineups ?? []).map((l) => l.seriesId)])];
}

function teamsOf(d: Driver): string[] {
  return [...new Set([...d.entries.map((e) => e.team), ...(d.lineups ?? []).map((l) => l.team)].filter((t): t is string => !!t))];
}

/** Rango de prioridad: más chico, antes. */
export function priority(d: Driver): number {
  const rank = (ids: string[]) => Math.min(...ids.map((s) => (PRIORITY_SERIES.includes(s) ? PRIORITY_SERIES.indexOf(s) : PRIORITY_SERIES.length)));
  if (d.entries.length) return rank(d.entries.map((e) => e.seriesId));
  return 100 + rank((d.lineups ?? []).map((l) => l.seriesId));
}

/** Pilotos a procesar, en orden: prioridad, nunca vistos y después los más viejos. */
export function selectDue(
  drivers: Driver[],
  bios: Map<string, DriverBio>,
  cache: BioCache,
  now: Date,
  opts: { only?: string[]; force?: boolean } = {},
): Driver[] {
  const due: Array<{ d: Driver; p: number; last: number }> = [];
  for (const d of drivers) {
    if (opts.only && !opts.only.includes(d.id)) continue;
    if (!searchableName(d.name)) continue;
    const bio = bios.get(d.id);
    const entry = cache[d.id];
    if (!opts.force) {
      if (bio && days(bio.updatedAt, now) < REFRESH_DAYS) continue;
      if (!bio && entry && entry.name === d.name && days(entry.checkedAt, now) < RECHECK_DAYS) continue;
    }
    const last = Date.parse(bio?.updatedAt ?? entry?.checkedAt ?? '') || 0;
    due.push({ d, p: priority(d), last });
  }
  return due.sort((a, b) => a.p - b.p || a.last - b.last || a.d.id.localeCompare(b.d.id)).map((x) => x.d);
}

/** Evidencia de los artículos de un candidato: categorías de su trayectoria y menciones de las del piloto. */
function evidenceOf(pages: WikiPage[], seriesIds: string[], teams: string[]): CandidateEvidence {
  const careerSeries = new Set<string>();
  for (const p of pages) for (const r of careerFromWikitext(p.wikitext)) if (r.seriesId) careerSeries.add(r.seriesId);
  const text = words(pages.map((p) => p.wikitext).join('\n'));
  const teamKeys = teams.map(words).filter((t) => t.replace(/\b(racing|motorsports?|team|competicion|competition|sport)\b/g, '').trim().length >= 6);
  const mentions = mentionsSeries(text, seriesIds) || teamKeys.some((t) => text.includes(t));
  return { careerSeries: [...careerSeries], mentions };
}

/** El nombre tal cual y con la primera o la última palabra pasada al otro extremo ("Lynn Alex" → "Alex Lynn"). */
export function nameVariants(name: string): string[] {
  const w = name.trim().split(/\s+/);
  if (w.length < 2) return [name];
  return [...new Set([name, [...w.slice(1), w[0]].join(' '), [w[w.length - 1], ...w.slice(0, -1)].join(' ')])];
}

/** Otro piloto al que ya se le asignó el ítem (en la caché o en este lote). */
function ownerOf(qid: string, id: string, cache: BioCache, accepted: Map<string, Candidate>): string | undefined {
  for (const [other, c] of accepted) if (other !== id && c.qid === qid) return other;
  for (const [other, e] of Object.entries(cache)) if (other !== id && e.wikidata === qid) return other;
  return undefined;
}

interface Built {
  bio?: DriverBio;
  entry: BioCacheEntry;
}

/** Procesa un lote: identifica (o usa el ítem ya aceptado), lee artículos, datos y fotos, y arma las fichas. */
async function processChunk(
  api: Api,
  drivers: Driver[],
  cache: BioCache,
  now: Date,
  nowIso: string,
  force = false,
): Promise<Map<string, Built>> {
  const out = new Map<string, Built>();
  const known = new Map<string, string>();
  for (const d of drivers) {
    const qid = cache[d.id]?.wikidata;
    if (qid && cache[d.id]!.name === d.name && !force) known.set(d.id, qid);
  }
  const toSearch = drivers.filter((d) => !known.has(d.id));
  const found = toSearch.length ? await searchNames(api, toSearch.map((d) => d.name)) : new Map<string, string[]>();
  // Los que no trajeron nada se buscan otra vez (la búsqueda dentro de WDQS a veces pierde nombres sin avisar) y
  // con el apellido en el otro extremo: varias listas publican "Lynn Alex" o "Mortensen Martin Vedel".
  const variants = new Map<string, string>();
  for (const name of toSearch.map((d) => d.name).filter((n) => !found.has(n))) {
    for (const v of nameVariants(name)) if (!variants.has(v)) variants.set(v, name);
  }
  if (variants.size) {
    for (const [variant, qids] of await searchNames(api, [...variants.keys()])) {
      const name = variants.get(variant)!;
      found.set(name, [...new Set([...(found.get(name) ?? []), ...qids])]);
    }
  }
  const allQids = [...known.values(), ...[...found.values()].flat()];
  const info = allQids.length ? await candidateInfo(api, allQids) : new Map<string, Candidate>();

  // Candidatos con el mismo nombre (los ya aceptados, tal cual).
  const candidates = new Map<string, Candidate[]>();
  for (const d of drivers) {
    const k = known.get(d.id);
    const list = k ? [info.get(k)].filter((c): c is Candidate => !!c) : (found.get(d.name) ?? []).map((q) => info.get(q)).filter((c): c is Candidate => !!c && sameName(c, d.name));
    candidates.set(d.id, list);
  }
  const all = [...candidates.values()].flat();
  const enPages = await fetchPages(api, 'en', all.map((c) => c.enwiki).filter((t): t is string => !!t));
  const esPages = await fetchPages(api, 'es', all.map((c) => c.eswiki).filter((t): t is string => !!t));
  const pagesOf = (c: Candidate): { en?: WikiPage; es?: WikiPage } => ({
    en: c.enwiki ? enPages.get(c.enwiki) : undefined,
    es: c.eswiki ? esPages.get(c.eswiki) : undefined,
  });

  const accepted = new Map<string, Candidate>();
  for (const d of drivers) {
    const list = candidates.get(d.id) ?? [];
    const k = known.get(d.id);
    if (k && list.length) {
      accepted.set(d.id, list[0]!);
      out.set(d.id, { entry: { name: d.name, checkedAt: nowIso, wikidata: k, reason: cache[d.id]!.reason } });
      continue;
    }
    const evidence = new Map<string, CandidateEvidence>();
    for (const c of list) {
      const p = pagesOf(c);
      evidence.set(c.qid, evidenceOf([p.en, p.es].filter((x): x is WikiPage => !!x), seriesOf(d), teamsOf(d)));
    }
    const choice = chooseCandidate({ name: d.name, iso: countryIso(d.country), seriesIds: seriesOf(d) }, list, evidence, now);
    // Un homónimo de la app ("Josh Berry" de NASCAR y el de la 24H Series) no se queda con la ficha del otro: con
    // evidencia débil, un ítem que ya tiene otro piloto se descarta.
    const owner = choice.qid && !choice.strong ? ownerOf(choice.qid, d.id, cache, accepted) : undefined;
    if (owner) {
      choice.reason = `el ítem ${choice.qid} ya es de ${owner}`;
      delete choice.qid;
    }
    const entry: BioCacheEntry = { name: d.name, checkedAt: nowIso, reason: choice.reason };
    if (choice.qid) {
      entry.wikidata = choice.qid;
      accepted.set(d.id, list.find((c) => c.qid === choice.qid)!);
    }
    out.set(d.id, { entry });
  }

  const details = accepted.size ? await fetchDetails(api, [...accepted.values()].map((c) => c.qid)) : new Map();
  const files = new Map<string, string>();
  for (const [id, c] of accepted) {
    const file = pickImage(details.get(c.qid)?.images ?? []);
    if (file) files.set(id, file);
  }
  const images = files.size ? await fetchImages(api, [...files.values()], PHOTO_WIDTH) : new Map<string, CreditedImage>();

  for (const d of drivers) {
    const c = accepted.get(d.id);
    if (!c) continue;
    const det = details.get(c.qid);
    const { en, es } = pagesOf(c);
    const bio: DriverBio = { id: d.id, wikidata: c.qid, updatedAt: nowIso };
    const summary = (es && summaryOf(es)) ?? (en && summaryOf(en));
    if (summary) bio.summary = summary;
    if (det?.birthDate) bio.birthDate = det.birthDate;
    if (det?.birthPlace) bio.birthPlace = det.birthPlace;
    const nationality = det ? nationalityOf(det, countryIso(d.country)) : undefined;
    if (nationality) bio.nationality = nationality;
    const file = files.get(d.id);
    const photo = file ? images.get(file) : undefined;
    if (photo) bio.photo = photo;
    // Trayectoria: la tabla más completa entre los dos artículos (en empate, la del artículo en inglés).
    const enCareer = en ? careerFromWikitext(en.wikitext) : [];
    const esCareer = es ? careerFromWikitext(es.wikitext) : [];
    const career = esCareer.length > enCareer.length ? esCareer : enCareer;
    if (career.length) {
      bio.career = career;
      const titles = titlesOf(career);
      if (titles.length) bio.titles = titles;
    }
    if (det?.links.length) bio.links = det.links;
    out.get(d.id)!.bio = bio;
  }
  return out;
}

// ── Temporada en curso con los datos de la app ──

interface AppSeason {
  seasons: Map<string, number>;
  names: Map<string, string>;
  details: Map<string, DriverDetail>;
}

async function loadAppSeason(dataDir: string, ids: string[], series: Series[], now: Date): Promise<AppSeason> {
  const seasons = new Map<string, number>();
  for (const s of series) {
    const standings = await readJson<{ season?: number }>(path.join(dataDir, 'standings', `${s.id}.json`)).catch(() => null);
    const roster = standings?.season ? null : await readJson<{ season?: number }>(path.join(dataDir, 'rosters', `${s.id}.json`)).catch(() => null);
    seasons.set(s.id, standings?.season ?? roster?.season ?? now.getUTCFullYear());
  }
  const details = new Map<string, DriverDetail>();
  for (const shard of new Set(ids.map(driverShard))) {
    const file = await readJson<DriverShardFile>(path.join(dataDir, 'drivers', `${shard}.json`)).catch(() => null);
    for (const d of file?.drivers ?? []) details.set(d.id, d);
  }
  return { seasons, names: new Map(series.map((s) => [s.id, s.name])), details };
}

/** Filas de la temporada en curso según la app (tablas de campeonato, estadísticas e inscripciones). */
export function appCareer(d: Driver, app: AppSeason): CareerSeason[] {
  const out: CareerSeason[] = [];
  const detail = app.details.get(d.id);
  const statsDone = new Set<string>();
  for (const e of d.entries) {
    const season = app.seasons.get(e.seriesId);
    const name = app.names.get(e.seriesId);
    if (!season || !name) continue;
    // "Pilotos LMGT3" → "European Le Mans Series (LMGT3)"; "Turismo Nacional (Clase 2 y 3)" + "Clase 3" →
    // "Turismo Nacional (Clase 3)".
    const table = e.table?.replace(/^pilotos\s*/i, '').trim();
    const series = table ? `${name.replace(/\s*\([^)]*\)\s*$/, '')} (${table})` : name;
    const row: CareerSeason = { season, series, seriesId: e.seriesId, source: 'app' };
    if (e.team) row.team = e.team;
    if (e.pos >= 1) row.pos = e.pos;
    row.points = e.points;
    if (!statsDone.has(e.seriesId)) {
      statsDone.add(e.seriesId);
      const st = detail?.stats?.find((s) => s.seriesId === e.seriesId);
      if (st) {
        row.races = st.races;
        row.wins = st.wins;
        if (!st.overall) {
          row.podiums = st.podiums;
          if (st.poles !== undefined) row.poles = st.poles;
        }
      } else if (e.wins !== undefined) {
        row.wins = e.wins;
      }
    }
    out.push(row);
  }
  for (const l of d.lineups ?? []) {
    if (d.entries.some((e) => e.seriesId === l.seriesId) || out.some((r) => r.seriesId === l.seriesId)) continue;
    const season = app.seasons.get(l.seriesId);
    const name = app.names.get(l.seriesId);
    if (!season || !name) continue;
    out.push(l.team ? { season, series: name, seriesId: l.seriesId, team: l.team, source: 'app' } : { season, series: name, seriesId: l.seriesId, source: 'app' });
  }
  return out;
}

/**
 * Trayectoria con la temporada en curso de la app donde Wikipedia todavía no la tiene. Una fila de Wikipedia de esa
 * temporada sin puesto ni puntos (temporada en curso todavía sin completar) se reemplaza por la de la app, con el
 * equipo de Wikipedia si la app no lo tiene.
 */
export function withAppSeason(bio: DriverBio, appRows: CareerSeason[]): DriverBio {
  let own = (bio.career ?? []).filter((r) => r.source !== 'app');
  const extra: CareerSeason[] = [];
  for (const r of appRows) {
    const same = own.filter((w) => w.season === r.season && w.seriesId === r.seriesId);
    if (!same.length) {
      extra.push(r);
    } else if (same.length === 1 && same[0]!.pos === undefined && same[0]!.points === undefined && (r.pos !== undefined || r.points !== undefined)) {
      own = own.filter((w) => w !== same[0]);
      extra.push(!r.team && same[0]!.team ? { ...r, team: same[0]!.team } : r);
    }
  }
  const career = sortCareer([...own, ...extra]);
  const next: DriverBio = { ...bio };
  if (career.length) next.career = career;
  else delete next.career;
  return next;
}

// ── Archivos ──

async function readBios(dir: string): Promise<Map<string, DriverBio>> {
  const out = new Map<string, DriverBio>();
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => /^[0-9a-f]{2}\.json$/.test(f));
  } catch {
    return out;
  }
  for (const f of files) {
    const file = await readJson(path.join(dir, f), driverBiosShardFileSchema);
    for (const b of file?.bios ?? []) out.set(b.id, b as DriverBio);
  }
  return out;
}

/** Escribe los grupos que cambiaron y borra los que quedaron vacíos. */
async function writeBios(dir: string, bios: Map<string, DriverBio>): Promise<{ written: number; removed: number }> {
  const groups = new Map<string, DriverBio[]>();
  for (const b of bios.values()) {
    const k = driverShard(b.id);
    groups.set(k, [...(groups.get(k) ?? []), b]);
  }
  let written = 0;
  let removed = 0;
  for (const [shard, list] of groups) {
    // Pasar por el esquema deja las claves en un orden fijo: el archivo no cambia si no cambian los datos.
    const file: DriverBiosShardFile = driverBiosShardFileSchema.parse({ version: 1, bios: list.sort((a, b) => a.id.localeCompare(b.id)) });
    const target = path.join(dir, `${shard}.json`);
    const text = `${JSON.stringify(file, null, 2)}\n`;
    const prev = await readFile(target, 'utf8').catch(() => null);
    if (prev === text) continue;
    await writeJson(target, file);
    written++;
  }
  let existing: string[] = [];
  try {
    existing = (await readdir(dir)).filter((f) => /^[0-9a-f]{2}\.json$/.test(f));
  } catch {
    existing = [];
  }
  for (const f of existing) {
    if (groups.has(f.slice(0, 2))) continue;
    await rm(path.join(dir, f));
    removed++;
  }
  return { written, removed };
}

export async function runDriverBios(opts: RunDriverBiosOptions): Promise<RunDriverBiosResult> {
  const { log } = opts;
  const dataDir = opts.dataDir ?? DATA_DIR;
  const now = opts.now ?? new Date();
  const nowIso = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  const limit = opts.limit ?? BIOS_PER_RUN;
  const result: RunDriverBiosResult = { processed: 0, identified: 0, rejected: 0, withPhoto: 0, withCareer: 0, pending: 0, written: 0, removed: 0 };

  const index = await readJson(path.join(dataDir, 'drivers-index.json'), driversIndexFileSchema);
  if (!index) {
    log.info('Todavía no existe data/drivers-index.json: no hay pilotos');
    return result;
  }
  const biosDir = path.join(dataDir, 'bios', 'drivers');
  const cacheFile = path.join(dataDir, '_cache', 'bios-drivers.json');
  const bios = await readBios(biosDir);
  const cache = (await readJson<BioCache>(cacheFile)) ?? {};
  const drivers = index.drivers as Driver[];
  const byId = new Map(drivers.map((d) => [d.id, d]));

  const due = selectDue(drivers, bios, cache, now, opts);
  const todo = due.slice(0, limit);
  result.pending = due.length - todo.length;
  const api = opts.api ?? createApi({ log });

  const processed: Driver[] = [];
  for (let i = 0; i < todo.length; i += CHUNK) {
    const chunk = todo.slice(i, i + CHUNK);
    try {
      const built = await processChunk(api, chunk, cache, now, nowIso, opts.force);
      for (const d of chunk) {
        const b = built.get(d.id);
        if (!b) continue;
        cache[d.id] = b.entry;
        processed.push(d);
        result.processed++;
        if (b.bio) {
          result.identified++;
          bios.set(d.id, b.bio);
        } else {
          result.rejected++;
          // Sin ítem: la ficha anterior (si la había, de una foto oficial) se rearma más abajo.
          if (!b.entry.wikidata) bios.delete(d.id);
        }
      }
      log.info(`Historial de pilotos: ${Math.min(i + CHUNK, todo.length)}/${todo.length} procesados (${api.requests} consultas)`);
    } catch (err) {
      if (err instanceof SourceLimitError) {
        result.stopped = err.message;
        result.pending += todo.length - i;
        log.warn(`Historial de pilotos: ${err.message}; se sigue en la próxima corrida`);
        break;
      }
      log.warn(`Historial de pilotos: lote con error (${err instanceof Error ? err.message : String(err)})`);
      result.pending += chunk.length;
    }
  }

  // Fotos oficiales para los procesados sin foto libre, en las categorías cuyo sitio oficial la publica.
  const needPhoto = processed.filter((d) => !bios.get(d.id)?.photo && seriesOf(d).some((s) => s in OFFICIAL_PHOTO_SERIES));
  if (needPhoto.length) {
    const sources = new Set(needPhoto.flatMap((d) => seriesOf(d).map((s) => OFFICIAL_PHOTO_SERIES[s]).filter((x): x is 'f1' | 'motogp' | 'nascar' => !!x)));
    const photos = await fetchOfficialPhotos(opts.http ?? createHttp(), sources, log);
    for (const d of needPhoto) {
      const photo = officialPhotoFor(d, photos);
      if (!photo) continue;
      const bio = bios.get(d.id) ?? { id: d.id, updatedAt: nowIso };
      bios.set(d.id, { ...bio, photo });
    }
  }
  for (const d of processed) {
    const b = bios.get(d.id);
    if (!b) continue;
    if (b.photo) result.withPhoto++;
    if (b.career?.some((r) => r.source !== 'app')) result.withCareer++;
  }

  // Solo los pilotos que siguen en la app; a todos, la temporada en curso con los datos propios.
  for (const id of [...bios.keys()]) if (!byId.has(id)) bios.delete(id);
  const series = opts.series ?? (await loadConfig(opts.configDir, dataDir)).series;
  const app = await loadAppSeason(dataDir, [...bios.keys()], series, now);
  for (const [id, bio] of bios) bios.set(id, withAppSeason(bio, appCareer(byId.get(id)!, app)));

  if (!opts.dryRun) {
    const files = await writeBios(biosDir, bios);
    result.written = files.written;
    result.removed = files.removed;
    if (result.processed > 0) await writeJson(cacheFile, sortKeys(cache));
  }
  log.info(
    `Historial de pilotos: ${result.processed} procesados, ${result.identified} con ficha, ${result.rejected} sin ficha, ` +
      `${result.withPhoto} con foto, ${result.withCareer} con trayectoria; ${result.pending} pendientes; ` +
      `${bios.size} fichas en total (${result.written} grupos escritos, ${result.removed} borrados)`,
  );
  return result;
}

function officialPhotoFor(d: Driver, photos: Map<'f1' | 'motogp' | 'nascar', PhotoMap>): CreditedImage | undefined {
  const keys = [d.id, baseDriverId(d.name)];
  for (const s of seriesOf(d)) {
    const source = OFFICIAL_PHOTO_SERIES[s];
    const map = source ? photos.get(source) : undefined;
    const photo = map && keys.map((k) => map.get(k)).find(Boolean);
    if (photo) return photo;
  }
  return undefined;
}

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  setDefaultAutoSelectFamilyAttemptTimeout(2000);
  const args = process.argv.slice(2);
  const value = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  runDriverBios({
    log: createLogger('historial'),
    limit: value('limit') ? Number(value('limit')) : 200,
    only: value('only')?.split(',').filter(Boolean),
    force: args.includes('--force'),
    dryRun: args.includes('--dry-run'),
  })
    .then((r) => process.exit(r.stopped && !r.processed ? 1 : 0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
