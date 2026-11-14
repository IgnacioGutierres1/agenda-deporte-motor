/**
 * Fichas de equipos (data/bios/teams.json): elemento de Wikidata, resumen de Wikipedia, logo de Commons,
 * fundación, sede, país, director, sitio web y categorías en las que corrió.
 *
 * Identificación del elemento de Wikidata (solo si es seguro):
 *  1. config/team-bios.json fija el elemento a mano (equipos que corren con el nombre del patrocinador).
 *  2. Si no, se buscan candidatos entre los elementos cuyo tipo (P31) es equipo de automovilismo, de
 *     motociclismo, de Fórmula 1, de rally o constructor (una consulta SPARQL trae todos, con sus nombres), más
 *     las organizaciones cuyo deporte (P641) es el automovilismo o el motociclismo.
 *  3. Nombre: igual (sin acentos ni signos), igual sin las palabras genéricas ("Team", "Racing", "Motorsport"),
 *     o el nombre del elemento contenido en el del equipo ("Oracle Red Bull Racing" ⊃ "Red Bull Racing").
 *  4. El deporte tiene que coincidir (un equipo de MotoGP no es uno de autos) y, salvo que el nombre sea igual y
 *     haya un solo candidato, tiene que coincidir la categoría (P118 liga o P1344 participó en) o el país (P17)
 *     con el de las categorías nacionales en las que corre.
 */
import { teamKey, type BioTitle, type TeamBio } from '@dm/shared';
import type { Api } from '../circuits/api.ts';
import { fetchImages, fileKey } from '../circuits/commons.ts';
import { coreTokens } from './series.ts';
import {
  asRecord,
  currentValues,
  earliestYear,
  fetchExtracts,
  firstString,
  itemIds,
  labelsOf,
  pickSummary,
  qidOf,
  sparql,
  statements,
  yearOf,
  type WdItem,
} from './wd.ts';

export type SportKind = 'car' | 'moto' | 'any';

/** Tipos (P31) que valen como equipo, con su deporte. */
export const TEAM_TYPES: Record<string, SportKind> = {
  Q20074337: 'car', // equipo de automovilismo
  Q10497835: 'car', // equipo de Fórmula 1
  Q109136128: 'car', // constructor de Fórmula 1 (equipo)
  Q21748148: 'car', // constructor de Fórmula 1
  Q109131203: 'car', // constructor de chasis de Fórmula 1
  Q15648574: 'car', // constructor de autos de carrera
  Q20146776: 'car', // equipo de rally
  Q124398405: 'any', // equipo de rally raid
  Q20784907: 'moto', // equipo de motociclismo
};

/** Organizaciones (P31) que valen si su deporte (P641) es el automovilismo o el motociclismo. */
const ORG_TYPES = ['Q43229', 'Q4830453', 'Q783794', 'Q12973014', 'Q847017', 'Q6881511', 'Q2384416', 'Q1589009', 'Q891723'];

const CAR_SPORTS = ['Q5386', 'Q371804', 'Q1805420', 'Q22940089', 'Q4245261', 'Q7856', 'Q1758324', 'Q1199515', 'Q1968', 'Q5367', 'Q569205'];
const MOTO_SPORTS = ['Q965550', 'Q15732689', 'Q1902630', 'Q328716', 'Q17163326', 'Q15056386'];

const MOTO_SERIES = new Set(['motogp', 'moto2', 'moto3']);
const ANY_SERIES = new Set(['dakar', 'score-baja']);

/** País de las categorías nacionales (para confirmar un equipo por su país). */
export const SERIES_COUNTRY: Record<string, string> = {
  tc: 'Q414',
  'tc-pista': 'Q414',
  'tc-pickup': 'Q414',
  'tc-mouras': 'Q414',
  tn: 'Q414',
  tc2000: 'Q414',
  'turismo-pista': 'Q414',
  'nascar-cup': 'Q30',
  'nascar-xfinity': 'Q30',
  'nascar-truck': 'Q30',
  indycar: 'Q30',
  'indy-nxt': 'Q30',
  imsa: 'Q30',
  'gtwc-america': 'Q30',
  'super-gt': 'Q17',
  'super-formula': 'Q17',
  'super-taikyu': 'Q17',
  supercars: 'Q408',
  'gtwc-australia': 'Q408',
  dtm: 'Q183',
  nls: 'Q183',
};

/** Orden en que se completan los equipos: primero los de las categorías principales. */
export const PRIORITY_SERIES = ['f1', 'motogp', 'wec', 'imsa', 'nascar-cup', 'supercars', 'tc', 'tc2000', 'tn', 'tc-pista', 'tc-pickup', 'tc-mouras', 'turismo-pista', 'indycar', 'wrc', 'dakar', 'moto2', 'moto3', 'f2', 'f3', 'dtm', 'super-gt', 'super-formula', 'nascar-xfinity', 'nascar-truck', 'elms'];

export interface TeamInput {
  id: string;
  name: string;
  series: string[];
}

export function teamKind(series: string[]): SportKind {
  if (series.some((s) => ANY_SERIES.has(s))) return 'any';
  if (series.length && series.every((s) => MOTO_SERIES.has(s))) return 'moto';
  return series.some((s) => MOTO_SERIES.has(s)) ? 'any' : 'car';
}

function compatible(a: SportKind, b: SportKind): boolean {
  return a === 'any' || b === 'any' || a === b;
}

// ── Candidatos ──

export interface Candidate {
  id: string;
  names: Set<string>;
  kind: SportKind;
  sitelinks: number;
  /** Solo es equipo o constructor de Fórmula 1 (escuderías históricas: "Modena", "Bride", "Honda F1"). */
  f1Only?: boolean;
}

/** Tipos que identifican un equipo o constructor de Fórmula 1. */
const F1_TYPES = new Set(['Q10497835', 'Q109136128', 'Q21748148', 'Q109131203']);

const LANGS = '"en","es","mul","de","fr","it","pt","nl"';

/** Todos los elementos que pueden ser un equipo, con sus nombres (dos consultas SPARQL). */
export async function fetchCandidates(api: Api): Promise<Candidate[]> {
  const byId = new Map<string, Candidate>();
  const add = (id: string | undefined, name: string | undefined, kind: SportKind, sl: string | undefined, f1 = false) => {
    if (!id || !name) return;
    const c = byId.get(id) ?? { id, names: new Set<string>(), kind, sitelinks: Number(sl) || 0, f1Only: f1 };
    if (c.kind !== kind) c.kind = c.kind === 'any' || kind === 'any' ? 'any' : c.kind;
    if (!f1) c.f1Only = false;
    c.names.add(name);
    byId.set(id, c);
  };
  const teams = await sparql(
    api,
    `SELECT ?item ?type ?name ?sl WHERE {
      VALUES ?type { ${Object.keys(TEAM_TYPES).map((q) => `wd:${q}`).join(' ')} }
      ?item wdt:P31 ?type ; wikibase:sitelinks ?sl .
      { ?item rdfs:label ?name } UNION { ?item skos:altLabel ?name }
      FILTER(LANG(?name) IN (${LANGS}))
    }`,
  );
  for (const r of teams) add(qidOf(r.item), r.name, TEAM_TYPES[qidOf(r.type) ?? ''] ?? 'any', r.sl, F1_TYPES.has(qidOf(r.type) ?? ''));
  const orgs = await sparql(
    api,
    `SELECT ?item ?sport ?name ?sl WHERE {
      VALUES ?sport { ${[...CAR_SPORTS, ...MOTO_SPORTS].map((q) => `wd:${q}`).join(' ')} }
      VALUES ?type { ${ORG_TYPES.map((q) => `wd:${q}`).join(' ')} }
      ?item wdt:P641 ?sport ; wdt:P31 ?type ; wikibase:sitelinks ?sl .
      { ?item rdfs:label ?name } UNION { ?item skos:altLabel ?name }
      FILTER(LANG(?name) IN (${LANGS}))
    }`,
  );
  for (const r of orgs) add(qidOf(r.item), r.name, MOTO_SPORTS.includes(qidOf(r.sport) ?? '') ? 'moto' : 'car', r.sl);
  return [...byId.values()];
}

export interface CandidateIndex {
  full: Map<string, Candidate[]>;
  core: Map<string, Candidate[]>;
  /** Primera palabra distintiva -> candidatos con sus palabras distintivas. */
  byToken: Map<string, Array<{ c: Candidate; core: string[] }>>;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (!list) map.set(key, [value]);
  else if (!list.includes(value)) list.push(value);
}

/** Nombres que no identifican a nadie por sí solos. */
const WEAK = new Set(['corse', 'sport', 'sports', 'competition', 'competicion', 'engineering', 'factory', 'works', 'grand', 'prix', 'auto', 'autosport', 'motor', 'performance', 'speed', 'scuderia', 'escuderia', 'equipe', 'squadra', 'rally', 'gp', 'motogp', 'moto', 'mx', 'usa', 'italia', 'japan', 'argentina', 'mobil', 'castrol', 'ypf', 'shell', 'red', 'bull', 'monster', 'energy']);

function distinctive(core: string[]): boolean {
  if (core.length >= 2) return core.some((t) => !WEAK.has(t));
  const t = core[0];
  return !!t && t.length >= 4 && !WEAK.has(t) && !/^\d+$/.test(t);
}

export function indexCandidates(cands: Candidate[]): CandidateIndex {
  const index: CandidateIndex = { full: new Map(), core: new Map(), byToken: new Map() };
  for (const c of cands) {
    for (const name of c.names) {
      const key = teamKey(name);
      if (!key) continue;
      push(index.full, key, c);
      const core = coreTokens(name);
      if (!core.length) continue;
      push(index.core, core.join(' '), c);
      if (distinctive(core)) {
        const list = index.byToken.get(core[0]!) ?? [];
        if (!list.some((x) => x.c === c && x.core.join(' ') === core.join(' '))) list.push({ c, core });
        index.byToken.set(core[0]!, list);
      }
    }
  }
  return index;
}

export type MatchHow = 'exacto' | 'nombre' | 'contenido';

/** true si las palabras de `small` están seguidas dentro de `big`. */
function contiguous(small: string[], big: string[]): boolean {
  for (let i = 0; i + small.length <= big.length; i++) {
    if (small.every((t, k) => big[i + k] === t)) return true;
  }
  return false;
}

/** Candidatos para el nombre de un equipo, con el nivel de coincidencia más fuerte que haya. */
export function findCandidates(index: CandidateIndex, name: string): { how: MatchHow; list: Candidate[] } | null {
  const full = index.full.get(teamKey(name));
  if (full?.length) return { how: 'exacto', list: full };
  const core = coreTokens(name);
  if (!core.length || !distinctive(core)) return null;
  const byCore = index.core.get(core.join(' '));
  if (byCore?.length) return { how: 'nombre', list: byCore };
  // El nombre del candidato, entero, dentro del nombre del equipo (con patrocinadores delante o detrás).
  const found: Array<{ c: Candidate; len: number }> = [];
  for (const t of new Set(core)) {
    for (const { c, core: other } of index.byToken.get(t) ?? []) {
      if (other.length < core.length && contiguous(other, core)) found.push({ c, len: other.length });
    }
  }
  if (!found.length) return null;
  const best = Math.max(...found.map((f) => f.len));
  return { how: 'contenido', list: [...new Set(found.filter((f) => f.len === best).map((f) => f.c))] };
}

/** ¿Coincide la categoría (liga, participación) o el país del elemento con las del equipo? */
export function confirmation(item: WdItem, team: TeamInput, seriesQids: Map<string, string>): { category: boolean; country: boolean } {
  const leagues = new Set([...itemIds(item.claims, 'P118', false), ...itemIds(item.claims, 'P1344', false), ...itemIds(item.claims, 'P641', false)]);
  const category = team.series.some((s) => {
    const q = seriesQids.get(s);
    return !!q && leagues.has(q);
  });
  const countries = new Set([...itemIds(item.claims, 'P17', false), ...itemIds(item.claims, 'P495', false)]);
  const country = team.series.some((s) => {
    const q = SERIES_COUNTRY[s];
    return !!q && countries.has(q);
  });
  return { category, country };
}

export interface Choice {
  qid: string;
  how: MatchHow;
  /** Por qué se aceptó ("categoría", "país", "único"). */
  why: string;
}

/**
 * Elige el elemento de un equipo entre los candidatos (ya con sus datos). null si no hay uno seguro.
 */
export function chooseItem(
  team: TeamInput,
  match: { how: MatchHow; list: Candidate[] },
  items: Map<string, WdItem>,
  seriesQids: Map<string, string>,
): Choice | null {
  const kind = teamKind(team.series);
  const inF1 = team.series.includes('f1');
  const usable = match.list.filter((c) => compatible(kind, c.kind) && items.has(c.id) && (!c.f1Only || inF1));
  if (!usable.length) return null;
  const scored = usable.map((c) => ({ c, ...confirmation(items.get(c.id)!, team, seriesQids) }));
  const confirmed = scored.filter((s) => s.category || s.country).sort((a, b) => Number(b.category) - Number(a.category) || b.c.sitelinks - a.c.sitelinks);
  if (confirmed.length) {
    const best = confirmed[0]!;
    // Dos candidatos confirmados por lo mismo: solo si uno es claramente más conocido.
    const rival = confirmed[1];
    if (rival && rival.category === best.category && rival.c.sitelinks * 2 > best.c.sitelinks) return null;
    return { qid: best.c.id, how: match.how, why: best.category ? 'categoría' : 'país' };
  }
  // Sin confirmación, solo un nombre igual (o igual sin "Team"/"Racing" pero de dos palabras o más) y un solo candidato.
  if (usable.length === 1 && (match.how === 'exacto' || (match.how === 'nombre' && coreTokens(team.name).length >= 2))) {
    return { qid: usable[0]!.id, how: match.how, why: 'único' };
  }
  return null;
}

// ── Ficha ──

export interface TeamBioContext {
  nowIso: string;
  /** Id de serie por elemento de Wikidata de la categoría (para la línea de tiempo). */
  seriesByQid: Map<string, { id: string; name: string }>;
}

function placeText(id: string | undefined, labels: Map<string, { label: string; country?: string }>): string | undefined {
  if (!id) return undefined;
  const l = labels.get(id);
  if (!l) return undefined;
  return l.country ? `${l.label}, ${l.country}` : l.label;
}

/** Categorías en las que corrió (P118 con fecha de inicio), de la más vieja a la más reciente. */
function historyOf(item: WdItem, labels: Map<string, { label: string }>, ctx: TeamBioContext): TeamBio['history'] {
  const out: NonNullable<TeamBio['history']> = [];
  for (const s of statements(item.claims, 'P118')) {
    const q = asRecord(s.value)?.id;
    const from = yearOf(s.start);
    if (typeof q !== 'string' || !from) continue;
    const known = ctx.seriesByQid.get(q);
    const series = known?.name ?? labels.get(q)?.label;
    if (!series) continue;
    const to = yearOf(s.end);
    out.push({ series, ...(known ? { seriesId: known.id } : {}), from, ...(to ? { to } : {}) });
  }
  return out.length ? out.sort((a, b) => a.from - b.from) : undefined;
}

/** Fichas de los equipos ya identificados (los datos de los elementos tienen que estar en `items`). */
export async function buildTeamBios(
  api: Api,
  picks: Array<{ id: string; qid: string }>,
  items: Map<string, WdItem>,
  ctx: TeamBioContext,
): Promise<TeamBio[]> {
  const usable = picks.filter((p) => items.has(p.qid));
  const itemOf = (p: { qid: string }) => items.get(p.qid)!;
  // Etiquetas de sedes, países, directores y categorías, en una consulta.
  const refs = usable.flatMap((p) => {
    const c = itemOf(p).claims;
    return [
      ...itemIds(c, 'P159').slice(0, 1),
      ...itemIds(c, 'P17').slice(0, 1),
      ...itemIds(c, 'P495').slice(0, 1),
      ...itemIds(c, 'P1037').slice(0, 1),
      ...itemIds(c, 'P286').slice(0, 1),
      ...statements(c, 'P118')
        .filter((s) => s.start)
        .map((s) => asRecord(s.value)?.id)
        .filter((q): q is string => typeof q === 'string' && !ctx.seriesByQid.has(q)),
    ];
  });
  const labels = refs.length ? await labelsOf(api, refs) : new Map<string, { label: string; country?: string }>();
  const logoFiles = new Map(usable.map((p) => [p.id, firstString(itemOf(p).claims, 'P154')]));
  const logos = await fetchImages(api, [...logoFiles.values()].filter((f): f is string => !!f), 320);
  const es = await fetchExtracts(api, 'es', usable.map((p) => itemOf(p).eswiki ?? '').filter(Boolean));
  const en = await fetchExtracts(
    api,
    'en',
    usable
      .filter((p) => !itemOf(p).eswiki || !es.has(itemOf(p).eswiki!))
      .map((p) => itemOf(p).enwiki ?? '')
      .filter(Boolean),
  );

  return usable.map((p) => {
    const item = itemOf(p);
    const c = item.claims;
    const bio: TeamBio = { id: p.id, wikidata: item.id, updatedAt: ctx.nowIso };
    const summary = pickSummary(item, es, en);
    if (summary) bio.summary = summary;
    const file = logoFiles.get(p.id);
    const logo = file ? logos.get(fileKey(file)) : undefined;
    if (logo) bio.logo = logo;
    const founded = earliestYear(c, 'P571');
    if (founded && founded > 1880) bio.founded = founded;
    const base = placeText(itemIds(c, 'P159')[0], labels);
    if (base) bio.base = base;
    const country = labels.get(itemIds(c, 'P17')[0] ?? itemIds(c, 'P495')[0] ?? '')?.label;
    if (country) bio.country = country;
    const principal = labels.get(itemIds(c, 'P1037')[0] ?? itemIds(c, 'P286')[0] ?? '')?.label;
    if (principal) bio.principal = principal;
    const history = historyOf(item, labels, ctx);
    if (history) bio.history = history;
    const website = currentValues(c, 'P856').find((v): v is string => typeof v === 'string' && /^https?:\/\/\S+$/.test(v));
    if (website) bio.website = website;
    return bio;
  });
}

/** Títulos de un equipo según las listas de campeones (por teamId). */
export function titlesFor(
  teamId: string,
  series: Array<{ seriesId: string; champions: Array<{ season: number; teamId?: string; note?: string }> }>,
  names: Map<string, string>,
): BioTitle[] {
  const out: BioTitle[] = [];
  for (const s of series) {
    const name = names.get(s.seriesId) ?? s.seriesId;
    for (const c of s.champions) {
      if (c.teamId !== teamId) continue;
      const label = c.note ? `${name} · ${c.note}` : name;
      if (out.some((t) => t.season === c.season && t.series === label)) continue;
      out.push({ season: c.season, series: label, seriesId: s.seriesId });
    }
  }
  return out.sort((a, b) => b.season - a.season || a.series.localeCompare(b.series));
}
