/**
 * Descubrimiento automático de competencias que no están entre las categorías configuradas.
 *
 * - Fuente 1: calendarios oficiales multi-categoría de config/discovery.json (FIA, SRO, CDA del ACA…),
 *   leídos con el flujo genérico (lectura directa; Gemini solo si el sitio no tiene lector propio).
 * - Fuente 2 (opcional: searchEnabled o DISCOVERY_SEARCH=1): Gemini con búsqueda de Google, limitado a
 *   dominios oficiales; cada hallazgo se acepta solo si su sitio es de un dominio permitido o si se
 *   puede descargar y el nombre figura en la página.
 */
import path from 'node:path';
import { slugify, type DiscoveredFile, type DiscoveredItem, type Series, type Source } from '@dm/shared';
import { CONFIG_DIR } from '../core/paths.ts';
import { readJson } from '../core/store.ts';
import type { AdapterContext } from '../core/types.ts';
import { fetchDocument } from '../extract/document.ts';
import { getGemini, parseLooseJson, type Gemini } from '../extract/gemini.ts';
import { readCalendar } from '../generic/index.ts';
import { championshipKey, shiftDate } from '../generic/places.ts';

export { championshipKey };
import { normalizeForMatch } from '../validate.ts';

export interface DiscoveryInput {
  /** Series ya configuradas (default + usuario + descubiertas previas), para no repetirlas. */
  known: Series[];
  previous: DiscoveredFile | null;
}

export interface DiscoveryCalendar {
  name?: string;
  url: string;
  /** Campeonato fijo (calendarios de una sola categoría). */
  championship?: string;
}

export interface DiscoveryConfig {
  calendars: DiscoveryCalendar[];
  allowedDomains: string[];
  searchEnabled: boolean;
  windowDays?: number;
  searchWindowDays?: number;
  maxSearchCalls?: number;
  aliases?: Record<string, string[]>;
  ignore?: string[];
}

export interface DiscoveryDeps {
  config?: DiscoveryConfig;
  gemini?: () => Gemini;
  env?: Record<string, string | undefined>;
}

const EMPTY_CONFIG: DiscoveryConfig = { calendars: [], allowedDomains: [], searchEnabled: false };

export async function loadDiscoveryConfig(configDir = CONFIG_DIR): Promise<DiscoveryConfig> {
  return (await readJson<DiscoveryConfig>(path.join(configDir, 'discovery.json'))) ?? EMPTY_CONFIG;
}

/** Devuelve el id de la serie configurada que corresponde a ese campeonato, o null. */
export function createKnownMatcher(known: Series[], aliases: Record<string, string[]> = {}): (championship: string) => string | null {
  const keys: Array<{ id: string; key: string }> = [];
  for (const s of known) {
    for (const n of [s.name, s.shortName, s.id.replace(/-/g, ' '), ...(aliases[s.id] ?? [])]) {
      const key = championshipKey(n);
      if (key) keys.push({ id: s.id, key });
    }
  }
  return (championship) => {
    const key = championshipKey(championship);
    if (!key) return null;
    const slug = slugify(championship);
    // Coincidencia exacta de la clave (no por inclusión: "TC Pista Mouras" no es "TC Pista").
    // Las variantes de nombre ("… Sprint Cup", "Formula One") se declaran en aliases.
    return keys.find((k) => k.key === key || k.id === slug)?.id ?? null;
  };
}

function hostAllowed(url: string, domains: string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return domains.some((d) => host === d || host.endsWith(`.${d}`));
  } catch {
    return false;
  }
}

const isoNow = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

export async function runDiscovery(input: DiscoveryInput, ctx: AdapterContext, deps: DiscoveryDeps = {}): Promise<DiscoveredFile> {
  const config = deps.config ?? (await loadDiscoveryConfig());
  const env = deps.env ?? process.env;
  const today = isoNow(ctx.now).slice(0, 10);
  const configured = input.known.filter((s) => s.origin !== 'discovered');
  const knownMatch = createKnownMatcher(configured, config.aliases);
  const ignore = (config.ignore ?? []).map((i) => normalizeForMatch(i));
  const ignored = (text: string) => ignore.some((i) => normalizeForMatch(text).includes(i));

  const found = new Map<string, DiscoveredItem>();
  const add = (item: Omit<DiscoveredItem, 'firstSeen'>) => {
    const prev = found.get(item.seriesId);
    if (!prev || (item.nextEventDate && (!prev.nextEventDate || item.nextEventDate < prev.nextEventDate))) {
      found.set(item.seriesId, { ...item, firstSeen: today });
    }
  };

  // Fuente 1: calendarios oficiales multi-categoría.
  const until = shiftDate(today, config.windowDays ?? 60);
  for (const cal of config.calendars) {
    const pseudo: Series = {
      id: `discovery-${slugify(cal.name ?? cal.url)}`.slice(0, 60),
      name: cal.name ?? cal.url,
      shortName: cal.name ?? 'Calendario',
      group: 'otros',
      officialUrls: [cal.url],
      strategy: 'generic',
      origin: 'discovered',
      enabled: true,
    };
    try {
      const read = await readCalendar(pseudo, cal.url, ctx, { gemini: deps.gemini }, { multiSeries: !cal.championship });
      let count = 0;
      for (const e of read.entries) {
        if (e.dateEnd < today || e.dateStart > until) continue;
        const championship = cal.championship ?? e.championship;
        if (!championship || ignored(championship) || ignored(e.name)) continue;
        if (knownMatch(championship)) continue;
        const seriesId = slugify(championship);
        if (!seriesId) continue;
        add({
          seriesId,
          name: championship,
          officialUrl: e.championshipUrl ?? e.url ?? read.doc.url,
          nextEventDate: e.dateStart,
          source: read.source,
        });
        count++;
      }
      ctx.log.info(`${cal.name ?? cal.url}: ${read.entries.length} competencias, ${count} sin categoría configurada`);
    } catch (err) {
      ctx.log.warn(`${cal.name ?? cal.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Fuente 2: Gemini con búsqueda de Google (opcional).
  if (config.searchEnabled || env.DISCOVERY_SEARCH === '1') {
    await searchSource(config, ctx, deps, today, configured, knownMatch, ignored, add);
  }

  // Fusión con la corrida anterior: conserva firstSeen, descarta lo que ya es categoría configurada
  // y mantiene un tiempo lo que esta vez no apareció (los calendarios son ventanas móviles).
  const keepSince = shiftDate(today, -30);
  const previous = new Map((input.previous?.items ?? []).map((i) => [i.seriesId, i]));
  const items: DiscoveredItem[] = [];
  for (const item of found.values()) {
    const prev = previous.get(item.seriesId);
    items.push(prev ? { ...item, firstSeen: prev.firstSeen } : item);
    previous.delete(item.seriesId);
  }
  for (const prev of previous.values()) {
    if (knownMatch(prev.name) || configured.some((s) => s.id === prev.seriesId)) continue;
    if ((prev.nextEventDate ?? prev.firstSeen) >= keepSince) items.push(prev);
  }
  items.sort((a, b) => (a.nextEventDate ?? '9999').localeCompare(b.nextEventDate ?? '9999') || a.seriesId.localeCompare(b.seriesId));
  return { version: 1, generatedAt: isoNow(ctx.now), items };
}

interface SearchHit {
  championship?: string;
  eventName?: string;
  dateStart?: string;
  officialUrl?: string;
}

async function searchSource(
  config: DiscoveryConfig,
  ctx: AdapterContext,
  deps: DiscoveryDeps,
  today: string,
  configured: Series[],
  knownMatch: (c: string) => string | null,
  ignored: (t: string) => boolean,
  add: (item: Omit<DiscoveredItem, 'firstSeen'>) => void,
): Promise<void> {
  const gemini = (deps.gemini ?? getGemini)();
  if (!gemini.available) {
    ctx.log.warn(`Búsqueda con Gemini desactivada: ${gemini.unavailableReason}`);
    return;
  }
  const until = shiftDate(today, config.searchWindowDays ?? 30);
  const knownList = configured.map((s) => s.name).join('; ');
  const scopes = [
    'internacionales (campeonatos mundiales, continentales y nacionales importantes de autos y motos)',
    'de Argentina (categorías nacionales y zonales con fiscalización de la CDA del ACA, ACTC, APAT u otras)',
  ].slice(0, config.maxSearchCalls ?? 2);
  for (const scope of scopes) {
    const prompt =
      `Buscá competencias de automovilismo o motociclismo ${scope} que tengan una fecha entre ${today} y ${until}. ` +
      `Excluí estas categorías ya conocidas: ${knownList}. ` +
      `Usá solo información de sitios oficiales (dominios: ${config.allowedDomains.join(', ')}). ` +
      'Respondé SOLO con un array JSON, sin texto adicional: ' +
      '[{"championship": "nombre del campeonato", "eventName": "nombre de la fecha", "dateStart": "YYYY-MM-DD", "officialUrl": "URL del sitio oficial del campeonato"}]';
    let hits: SearchHit[] = [];
    try {
      const res = await gemini.searchGrounded(prompt);
      hits = parseLooseJson<SearchHit[]>(res.text) ?? [];
    } catch (err) {
      ctx.log.warn(`Búsqueda con Gemini: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const h of Array.isArray(hits) ? hits : []) {
      const championship = (h.championship ?? '').trim();
      const url = (h.officialUrl ?? '').trim();
      if (!championship || !/^https?:\/\//.test(url) || ignored(championship) || knownMatch(championship)) continue;
      if (h.dateStart && (!/^\d{4}-\d{2}-\d{2}$/.test(h.dateStart) || h.dateStart < today || h.dateStart > until)) continue;
      let title = '';
      if (!hostAllowed(url, config.allowedDomains)) {
        // Dominio no listado: se acepta solo si el sitio responde y nombra al campeonato.
        try {
          const doc = await fetchDocument(ctx.http, url);
          const key = championshipKey(championship).split(' ').filter((t) => t.length > 2);
          const text = normalizeForMatch(doc.text);
          if (key.length === 0 || !key.every((t) => text.includes(t))) continue;
          title = doc.title;
        } catch {
          continue;
        }
      }
      const source: Source = {
        url,
        title: title || `${championship} (hallado con búsqueda de Google)`,
        kind: 'html',
        method: 'ia',
        fetchedAt: isoNow(ctx.now),
      };
      add({ seriesId: slugify(championship), name: championship, officialUrl: url, ...(h.dateStart ? { nextEventDate: h.dateStart } : {}), source });
    }
  }
}
