/**
 * Lector directo del Rally Dakar (dakar.com, sitio oficial de A.S.O., versión en español).
 *
 * Recorrido: GET https://www.dakar.com/es/recorrido-general
 *            - Tabla <section class="generalRace">: una fila por jornada (P = prólogo, 1…12, T = traslado,
 *              R = descanso) con la fecha ("Sábado, 9 de enero de 2027"), las localidades ("LOULE > LOULE"),
 *              "km totales | km de especial" y el link a la página de la jornada.
 *            - Imagen ampliable del artículo: mapa general del recorrido.
 *            - Países resaltados (<strong>) en el texto de presentación.
 * Jornada:   GET https://www.dakar.com/es/etapa-{n}/coche (y /prologo-0, /traslado-0, /descanso-0)
 *            - <div class="introStage">: "Enlace > 200 km - Especial > 100 km".
 *            - Primer bloque .push--lead: recorrido bien escrito ("Loulé/Faro > Loulé/Faro") y descripción.
 *            Cada jornada tiene una página por categoría (/moto, /coche…). Se publican las distancias de autos; si
 *            no coinciden con la tabla general (que enlaza las páginas de motos) se lee también la de motos y la
 *            diferencia queda en `note`.
 *
 * Lo que el sitio todavía no publica (noviembre de 2026, edición 2027) y el lector toma solo si aparece:
 *   - Mapa de cada etapa: imagen ampliable de un bloque de artículo cuyo nombre parece un mapa (igual que el mapa
 *     general). Formato sin confirmar: las páginas de etapa de ediciones anteriores ya no están en el sitio.
 *   - Terreno: pares "Arena 45 %" escritos como texto en la ficha de la etapa, solo si suman 100 %.
 *   - Horarios de largada: no hay; el evento queda sin sesiones (nunca se inventan horas).
 *
 * Edición y temporada: el sitio muestra una sola edición, la próxima o la que se está corriendo. El evento lleva
 * como temporada el año de la edición (el de la llegada), no ctx.season: en noviembre de 2026 ya se publica
 * "Dakar 2027" con el id que va a conservar en enero. La edición ya corrida en el año de la corrida se conserva de
 * la corrida anterior cuando el sitio pasa a mostrar la siguiente.
 *
 * Sin publicar todavía:
 *   - Clasificación general (/es/clasificaciones): la lectura está en dakar-ranking.ts, pero es por tiempos (las
 *     tablas de campeonato son por puntos) y no tiene dónde publicarse; ver ese archivo.
 *   - Inscriptos (/es/corredores): hasta que salga la lista de la edición muestra la de la anterior, y sin equipo
 *     ni vehículo.
 */
import { parse, type HTMLElement } from 'node-html-parser';
import type { EventStagesFile, RallyStage, Series, StageKind, StageTerrain } from '@dm/shared';
import type { Adapter, AdapterContext, ScheduleChunk } from '../core/types.ts';
import { absoluteUrl } from '../extract/html.ts';
import { countryEs, guessTimeZone, isoDate, monthNumber, normalizeKey } from '../generic/places.ts';
import { directSource, fetchedAt } from './util.ts';

export const DAKAR_SITE = 'https://www.dakar.com';
export const DAKAR_ROUTE_URL = `${DAKAR_SITE}/es/recorrido-general`;
/** Último segmento de la URL de una jornada: la categoría. */
const CAR_SLUG = 'coche';
/** Tope de la descripción de una jornada (las del sitio rondan los 700 caracteres). */
const MAX_NOTE = 1200;

// ---------- Utilidades de lectura ----------

const clean = (text: string | undefined): string => (text ?? '').replace(/\s+/g, ' ').trim();

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** "1035", "1.035", "1 035", "29,5" -> kilómetros. */
function toKm(raw: string): number | undefined {
  let t = raw.replace(/\s+/g, '');
  if (!t) return undefined;
  if (/^\d{1,3}(?:\.\d{3})+$/.test(t)) t = t.replace(/\./g, '');
  const n = Number(t.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Fecha "Sábado, 9 de enero de 2027" o "09/01/2027" -> "2027-01-09". */
export function parseDakarDate(text: string): string | null {
  let m = text.match(/(\d{1,2})\s+de\s+(\p{L}+)\s+de\s+(\d{4})/u);
  if (m) {
    const month = monthNumber(m[2]!);
    return month ? isoDate(Number(m[3]), month, Number(m[1])) : null;
  }
  m = text.match(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/);
  return m ? isoDate(Number(m[3]), Number(m[2]), Number(m[1])) : null;
}

/** "BOUÂRFA" -> "Bouârfa", "AL HENAKIYAH" -> "Al Henakiyah" (los nombres con minúsculas se dejan como están). */
function placeCase(text: string): string {
  if (text !== text.toUpperCase()) return text;
  return text.toLowerCase().replace(/(^|[\s/\-(])(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());
}

/** "A", "A y B", "A, B y C". */
const listEs = (items: string[]): string =>
  items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} y ${items.at(-1)}`;

const fmtKm = (n: number): string => `${String(n).replace('.', ',')} km`;

/** Tipo de jornada según el rótulo ("Prólogo", "Etapa 3", "Traslado", "Descanso") o, si no, la URL. */
function stageKind(label: string, url: string | undefined): StageKind | null {
  const slug = url ? (new URL(url).pathname.split('/').filter(Boolean)[1] ?? '') : '';
  for (const t of [normalizeKey(label), normalizeKey(slug)]) {
    if (/\bprolog/.test(t)) return 'prologo';
    if (/\b(?:descanso|rest|repos)\b/.test(t)) return 'descanso';
    if (/\b(?:traslado|transfer|transfert|enlace|liaison)\b/.test(t)) return 'enlace';
    if (/\b(?:etapa|stage|etape)\b/.test(t)) return 'especial';
  }
  return null;
}

/** Nombre del archivo en una URL de imagen de A.S.O. (o la ruta entera si el formato es otro). */
const imageName = (url: string): string => url.match(/\/img-[^/]+\/([^/]+)\//)?.[1] ?? new URL(url).pathname;

const MAP_HINT = /carte|map|parcours|recorrido|route|itinera|trace|etape|etapa|stage/i;

/**
 * Mapa publicado como imagen ampliable de un bloque de artículo del CMS (así está el mapa general). Para no tomar
 * una foto por un mapa, el nombre de la imagen tiene que parecerlo ("dak27-officiel-parcours-…").
 */
function mapImage(main: HTMLElement, pageUrl: string): string | undefined {
  for (const fig of main.querySelectorAll('section.article figure, .push--lead figure')) {
    const href = fig.querySelector('a.js-jzoom')?.getAttribute('href');
    const lazy = fig.querySelector('img')?.getAttribute('data-src')?.split('|').at(-1);
    const src = href || lazy;
    const url = src ? absoluteUrl(src, pageUrl) : null;
    if (url && MAP_HINT.test(imageName(url))) return url;
  }
  return undefined;
}

/** Palabras con que se nombra cada terreno (español, inglés o francés) y su rótulo en español. */
const TERRAINS: Array<[string, string]> = [
  ['dunas?|dunes?', 'Dunas'],
  ['arenas?|sand|sable', 'Arena'],
  ['tierra|dirt|soil|terre', 'Tierra'],
  ['piedras?|rocas?|stones?|rocks?|pierres?|cailloux', 'Piedras'],
  ['asfalto|asphalte?|tarmac|goudron', 'Asfalto'],
  ['grava|gravel|graviers?', 'Grava'],
  ['pistas?|tracks?|pistes?', 'Pistas'],
];
const TERRAIN_WORD = TERRAINS.map(([words]) => words).join('|');
const PERCENT = '(\\d{1,3}(?:[.,]\\d)?)\\s*%';

const terrainLabel = (word: string): string =>
  TERRAINS.find(([words]) => new RegExp(`^(?:${words})$`).test(normalizeKey(word)))?.[1] ?? word;

/**
 * Desglose de terreno escrito como texto ("Arena 45 % · Dunas 10 % · Tierra 30 % · Piedras 15 %", o con el
 * porcentaje adelante). Solo vale si los porcentajes suman 100: cualquier otra cosa se descarta.
 */
export function terrainFromText(text: string): StageTerrain[] | undefined {
  const labelFirst = new RegExp(`(?<![\\p{L}])(${TERRAIN_WORD})(?![\\p{L}])\\s*[:>|·–-]?\\s*${PERCENT}`, 'giu');
  const percentFirst = new RegExp(`${PERCENT}\\s*(?:de\\s+|of\\s+)?(${TERRAIN_WORD})(?![\\p{L}])`, 'giu');
  const candidates = [
    [...text.matchAll(labelFirst)].map((m) => ({ label: terrainLabel(m[1]!), percent: Number(m[2]!.replace(',', '.')) })),
    [...text.matchAll(percentFirst)].map((m) => ({ label: terrainLabel(m[2]!), percent: Number(m[1]!.replace(',', '.')) })),
  ];
  for (const items of candidates) {
    const sum = items.reduce((acc, t) => acc + t.percent, 0);
    const labels = new Set(items.map((t) => t.label));
    if (items.length >= 2 && labels.size === items.length && Math.abs(sum - 100) <= 1) return items;
  }
  return undefined;
}

// ---------- Recorrido general ----------

export interface DakarRouteRow {
  /** Rótulo de la jornada: "Prólogo", "Etapa 1", "Traslado", "Descanso". */
  label: string;
  kind: StageKind;
  date: string;
  /** Localidades tal como figuran en la tabla (en mayúsculas): ["LOULE", "LOULE"], ["AGADIR"]. */
  places: string[];
  totalKm?: number;
  specialKm?: number;
  /** Página de la jornada que enlaza la tabla (la de la categoría por defecto del sitio: motos). */
  url?: string;
}

export interface DakarRoute {
  /** Año de la edición (el de la llegada). */
  edition: number;
  rows: DakarRouteRow[];
  /** Filas de la tabla que no se reconocieron como jornada. */
  unknown: string[];
  mapUrl?: string;
  /** Países resaltados en la presentación, en español y por orden de aparición. */
  countries: string[];
  /** El más nombrado: de ahí sale la zona horaria del evento. */
  mainCountry?: string;
}

export function parseDakarRoute(html: string, pageUrl: string = DAKAR_ROUTE_URL): DakarRoute {
  const root = parse(html);
  const main = root.querySelector('main') ?? root;
  const rows: DakarRouteRow[] = [];
  const unknown: string[] = [];
  const table = main.querySelector('.generalRace table') ?? main.querySelector('table');

  for (const tr of table?.querySelectorAll('tr') ?? []) {
    const cells = tr.querySelectorAll('td');
    if (cells.length < 3) continue;
    const date = parseDakarDate(clean(cells[1]!.text));
    if (!date) continue; // fila de subtítulos ("Total | Especial")
    const link = tr.querySelector('a[href]');
    const label = clean(link?.text) || clean(cells[0]!.text);
    const url = link ? (absoluteUrl(link.getAttribute('href') ?? '', pageUrl) ?? undefined) : undefined;
    // "129 km | 29 km": el total del día y la especial (el total siempre es el mayor).
    const kms = clean(cells[3]?.text)
      .split('|')
      .map((part) => toKm(part.replace(/km/i, '')))
      .filter((n): n is number => n !== undefined);
    const totalKm = kms.length > 0 ? Math.max(...kms) : undefined;
    const specialKm = kms.length > 1 ? Math.min(...kms) : undefined;
    const kind = stageKind(label, url) ?? (specialKm ? 'especial' : null);
    if (!kind) {
      unknown.push(label || date);
      continue;
    }
    rows.push({
      label,
      kind,
      date,
      places: clean(cells[2]!.text).split('>').map((p) => p.trim()).filter(Boolean),
      ...(totalKm !== undefined ? { totalKm } : {}),
      ...(specialKm !== undefined ? { specialKm } : {}),
      ...(url ? { url } : {}),
    });
  }

  // Países: solo los resaltados en la presentación que el pipeline conoce (la prosa suelta nombra otros de paso).
  const mentions = new Map<string, number>();
  for (const el of main.querySelectorAll('section.article strong, section.article b')) {
    const name = clean(el.text);
    if (name.length < 4 || guessTimeZone(name) === null) continue;
    const es = countryEs(name);
    mentions.set(es, (mentions.get(es) ?? 0) + 1);
  }
  const countries = [...mentions.keys()];
  const mainCountry = countries.reduce<string | undefined>(
    (best, c) => (best === undefined || mentions.get(c)! > mentions.get(best)! ? c : best),
    undefined,
  );

  const lastDate = rows.reduce((max, r) => (r.date > max ? r.date : max), '');
  const metaYear = Number(root.querySelector('meta[name="year"]')?.getAttribute('content'));
  const edition = lastDate ? Number(lastDate.slice(0, 4)) : metaYear;
  const mapUrl = mapImage(main, pageUrl);
  return {
    edition,
    rows,
    unknown,
    ...(mapUrl ? { mapUrl } : {}),
    countries,
    ...(mainCountry ? { mainCountry } : {}),
  };
}

// ---------- Página de una jornada ----------

export interface DakarStagePage {
  date?: string;
  /** Recorrido con mayúsculas y acentos, del título de la descripción ("Loulé/Faro > Bouarfa"). */
  title?: string;
  liaisonKm?: number;
  specialKm?: number;
  description?: string;
  mapUrl?: string;
  terrain?: StageTerrain[];
}

export function parseDakarStagePage(html: string, pageUrl: string): DakarStagePage {
  const root = parse(html);
  const main = root.querySelector('main') ?? root;
  const page: DakarStagePage = {};

  const date = parseDakarDate(clean(main.querySelector('.pageHeader__subheading')?.text));
  if (date) page.date = date;

  // "Enlace > 200 km - Especial > 100 km" (si hay dos enlaces, se suman).
  const intro = clean(main.querySelector('.introStage')?.text);
  for (const m of intro.matchAll(/([\p{L}][\p{L} ]*?)\s*>\s*([\d.,\s]+?)\s*km/giu)) {
    const km = toKm(m[2]!);
    if (km === undefined) continue;
    const label = normalizeKey(m[1]!);
    if (/enlace|liaison/.test(label)) page.liaisonKm = (page.liaisonKm ?? 0) + km;
    else if (/especial|special/.test(label)) page.specialKm = (page.specialKm ?? 0) + km;
  }

  const lead = main.querySelector('.push--lead .push__text');
  if (lead) {
    const heading = lead.querySelector('h1, h2, h3, h4');
    const title = clean(heading?.text);
    // El título solo sirve como recorrido si tiene esa forma: durante la carrera puede ser el de una nota.
    if (title.includes('>')) page.title = title.split('>').map((p) => p.trim()).join(' > ');
    heading?.remove();
    const description = clean(lead.text);
    if (description) page.description = description;
  }

  const mapUrl = mapImage(main, pageUrl);
  if (mapUrl) page.mapUrl = mapUrl;
  const terrain = terrainFromText(
    main
      .querySelectorAll('section.stage, section.article')
      .map((s) => clean(s.text))
      .join(' · '),
  );
  if (terrain) page.terrain = terrain;
  return page;
}

// ---------- Itinerario ----------

/**
 * Página de la jornada para otra categoría: cambia el último segmento ("/es/etapa-1/moto" -> "/es/etapa-1/coche").
 * Si la URL no tiene la forma idioma/jornada/categoría, se deja como está.
 */
function categoryUrl(url: string, slug: string): string {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length !== 3) return url;
  u.pathname = `/${parts[0]}/${parts[1]}/${slug}`;
  return u.toString();
}

async function readPage(ctx: AdapterContext, url: string): Promise<DakarStagePage> {
  return parseDakarStagePage((await ctx.http.text(url)).body, url);
}

/** Texto de la jornada, recortado en el final de una oración si es demasiado largo. */
function shorten(text: string): string {
  if (text.length <= MAX_NOTE) return text;
  const cut = text.slice(0, MAX_NOTE);
  const end = cut.lastIndexOf('. ');
  return end > MAX_NOTE / 2 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

async function readStage(row: DakarRouteRow, ctx: AdapterContext): Promise<RallyStage> {
  let page: DakarStagePage = {};
  let bikes: DakarStagePage | null = null;
  if (row.url) {
    const carUrl = categoryUrl(row.url, CAR_SLUG);
    try {
      page = await readPage(ctx, carUrl);
    } catch (err) {
      ctx.log.warn(`${row.label}: no se pudo leer ${carUrl} (${errorText(err)}); quedan los datos de la tabla general`);
    }
    // La tabla general enlaza las páginas de motos: si sus km no son los de autos, se mira qué dice la de motos.
    const carTotal = (page.specialKm ?? 0) + (page.liaisonKm ?? 0);
    const mismatch =
      page.specialKm !== undefined &&
      row.totalKm !== undefined &&
      (page.specialKm !== (row.specialKm ?? page.specialKm) || carTotal !== row.totalKm);
    if (mismatch && row.url !== carUrl) {
      try {
        bikes = await readPage(ctx, row.url);
      } catch (err) {
        ctx.log.warn(`${row.label}: no se pudo comparar con la página de motos (${errorText(err)})`);
      }
    }
  }

  // Distancias de la página de autos; si no las trae, las de la tabla (enlace = total - especial).
  const fromPage = page.specialKm !== undefined || page.liaisonKm !== undefined;
  const specialKm = fromPage ? page.specialKm : row.specialKm;
  const liaisonKm = fromPage
    ? page.liaisonKm
    : row.totalKm !== undefined && row.specialKm !== undefined
      ? row.totalKm - row.specialKm
      : undefined;
  const totalKm = fromPage ? (specialKm ?? 0) + (liaisonKm ?? 0) : row.totalKm;

  const notes: string[] = [];
  if (page.description) notes.push(shorten(page.description));
  if (bikes && (bikes.specialKm !== page.specialKm || bikes.liaisonKm !== page.liaisonKm)) {
    const parts = [
      ...(bikes.specialKm !== undefined ? [`${fmtKm(bikes.specialKm)} de especial`] : []),
      ...(bikes.liaisonKm !== undefined ? [`${fmtKm(bikes.liaisonKm)} de enlace`] : []),
    ];
    if (parts.length) notes.push(`Las distancias son las de autos; motos: ${listEs(parts)}.`);
  }

  // La fecha es la de la tabla general (una sola lista para toda la edición); la de la página solo se compara.
  if (page.date && page.date !== row.date) {
    ctx.log.warn(`${row.label}: la página de la jornada dice ${page.date} y la tabla general ${row.date}; se usa la tabla`);
  }
  return {
    code: row.label,
    name: page.title ?? row.places.map(placeCase).join(' > '),
    kind: row.kind,
    date: row.date,
    ...(specialKm !== undefined ? { distanceKm: specialKm } : {}),
    ...(liaisonKm !== undefined ? { liaisonKm } : {}),
    ...(totalKm !== undefined ? { totalKm } : {}),
    ...(page.terrain ? { terrain: page.terrain } : {}),
    ...(page.mapUrl ? { mapUrl: page.mapUrl } : {}),
    ...(notes.length ? { note: notes.join(' ') } : {}),
  };
}

async function buildSchedule(series: Series, ctx: AdapterContext): Promise<ScheduleChunk> {
  // Cuando la edición publicada ya terminó, scheduleWithNextSeason vuelve a llamar con la temporada siguiente. El
  // sitio muestra una sola edición (ya leída en la primera llamada): no hay otra que buscar hasta que la publique.
  if (ctx.nextSeason) return { events: [], sessions: [] };

  const { body } = await ctx.http.text(DAKAR_ROUTE_URL);
  const route = parseDakarRoute(body, DAKAR_ROUTE_URL);
  if (route.rows.length === 0 || !Number.isInteger(route.edition)) {
    throw new Error(`No se encontró la tabla del recorrido en ${DAKAR_ROUTE_URL}`);
  }
  for (const label of route.unknown) ctx.log.warn(`Fila del recorrido sin reconocer: "${label}"`);

  // De a una página por vez: son quince pedidos livianos al mismo sitio.
  const stages: RallyStage[] = [];
  for (const row of route.rows) stages.push(await readStage(row, ctx));
  stages.sort((a, b) => a.date.localeCompare(b.date));

  const first = stages[0]!;
  const last = stages.at(-1)!;
  const start = first.name.split('>')[0]!.trim();
  const finish = last.name.split('>').at(-1)!.trim();
  const source = directSource(ctx, DAKAR_ROUTE_URL, `Dakar.com – Recorrido ${route.edition}`, 'html');
  const event = ctx.build.event({
    series,
    // La temporada del evento es la edición (ver el encabezado): el id no cambia al pasar de año.
    season: route.edition,
    key: 'dakar',
    name: `Dakar ${route.edition}`,
    circuit: start === finish ? start : `${start} > ${finish}`,
    country: listEs(route.countries),
    tz: (route.mainCountry && guessTimeZone(route.mainCountry)) || 'UTC',
    dateStart: first.date,
    dateEnd: last.date,
    // Sin horarios de largada publicados no hay sesiones: la app muestra las etapas por día.
    sessionsStatus: 'pending',
    surface: 'arena',
    // Jornadas cronometradas: el prólogo y las etapas (no el traslado ni el descanso).
    stageCount: stages.filter((s) => s.kind !== 'enlace' && s.kind !== 'descanso').length,
    source,
  });

  const withKm = stages.filter((s) => s.kind !== 'descanso');
  const competitiveKm = stages.reduce((sum, s) => sum + (s.distanceKm ?? 0), 0);
  const file: EventStagesFile = {
    seriesId: series.id,
    eventId: event.id,
    updatedAt: fetchedAt(ctx),
    surface: 'arena',
    ...(competitiveKm > 0 ? { competitiveKm } : {}),
    // El total solo si todas las jornadas con recorrido lo publican (el traslado puede no traer kilómetros).
    ...(withKm.every((s) => s.totalKm !== undefined)
      ? { totalKm: withKm.reduce((sum, s) => sum + s.totalKm!, 0) }
      : {}),
    ...(route.mapUrl ? { routeMapUrl: route.mapUrl, routeMapCredit: '© A.S.O.' } : {}),
    stages,
    source,
  };

  // El sitio muestra una sola edición: la que ya se corrió este año se conserva de la corrida anterior.
  const kept = (ctx.previous?.events ?? []).filter(
    (e) =>
      e.seriesId === series.id &&
      e.id !== event.id &&
      e.dateEnd.startsWith(String(ctx.season)) &&
      e.dateEnd < event.dateStart,
  );
  const keptIds = new Set(kept.map((e) => e.id));
  return {
    events: [...kept, event],
    sessions: (ctx.previous?.sessions ?? []).filter((s) => keptIds.has(s.eventId)),
    stages: [file],
  };
}

export const dakarAdapter: Adapter = {
  name: 'dakar',
  schedule: buildSchedule,
};
