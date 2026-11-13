/**
 * Puebla data/circuits.json de una vez, sin tope por corrida, a partir de data/schedule.json.
 * Uso: npm run circuits -- [--force] [--rematch] [--only=monza,rosario] [--limit=N] [--dry-run] [--table]
 *                          [--cache=carpeta]
 *   --force     vuelve a consultar todos los circuitos (no solo los nuevos o vencidos)
 *   --rematch   vuelve a buscar el elemento de Wikidata aunque ya estuviera identificado
 *   --table     solo imprime la tabla de lo guardado (id, Wikidata, nombre, ciudad, coordenadas), sin consultar
 *   --cache     guarda las respuestas en esa carpeta y las reutiliza (para depurar sin repetir consultas)
 *
 * Wikimedia permite unas 10 consultas por minuto a un cliente sin datos de contacto: poblar todo lleva un rato.
 * Al final imprime la tabla id -> Wikidata -> etiqueta -> país para revisar a mano; los errores se corrigen en
 * config/circuits.json.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { circuitsFileSchema, scheduleFileSchema, type CircuitInfo } from '@dm/shared';
import { createLogger } from '../core/log.ts';
import { DATA_DIR } from '../core/paths.ts';
import { readJson } from '../core/store.ts';
import type { ResponseCache } from './api.ts';
import { coverage, groupCircuits, runCircuits, type CircuitReport } from './index.ts';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const log = createLogger('circuitos');
const schedule = await readJson(path.join(DATA_DIR, 'schedule.json'), scheduleFileSchema);
if (!schedule) {
  log.error('Falta data/schedule.json: corré antes el pipeline');
  process.exit(1);
}
const groups = groupCircuits(schedule.events);
const groupById = new Map(groups.map((g) => [g.id, g]));

function coords(c: CircuitInfo | undefined): string {
  if (c?.lat === undefined || c.lon === undefined) return 'sin coordenadas';
  return `${c.lat.toFixed(4)},${c.lon.toFixed(4)}${c.coordsApprox ? ' (aprox.)' : ''}`;
}

function extras(c: CircuitInfo | undefined): string {
  if (!c) return '';
  return [c.map && 'plano', c.photo && 'foto', c.lapRecord && 'récord', c.summary && `texto ${c.summaryLang}`].filter(Boolean).join(', ');
}

function printStored(circuits: CircuitInfo[]): void {
  console.log('\nid | Wikidata | nombre | ciudad | país del calendario | coordenadas | datos');
  for (const c of circuits) {
    const g = groupById.get(c.id);
    console.log(
      [c.id, c.wikidata ?? '-', c.name, c.city ?? '-', g ? g.country || '-' : '(fuera del calendario)', coords(c), extras(c)].join(' | '),
    );
  }
}

function printCoverage(circuits: CircuitInfo[]): void {
  const s = coverage(circuits.filter((c) => groupById.has(c.id)));
  console.log(
    `\nCobertura (${groups.length} circuitos del calendario, ${s.total} con ficha): ${s.identified} identificados en Wikidata; ` +
      `coordenadas exactas ${s.exact}, aproximadas ${s.approx}, sin coordenadas ${groups.length - s.exact - s.approx}; ` +
      `con plano ${s.withMap}, con foto ${s.withPhoto}, con récord ${s.withRecord}, con extracto ${s.withSummary}.`,
  );
}

if (flag('table')) {
  const stored = await readJson(path.join(DATA_DIR, 'circuits.json'), circuitsFileSchema);
  printStored(stored?.circuits ?? []);
  printCoverage(stored?.circuits ?? []);
  process.exit(0);
}

/** Respuestas guardadas en una carpeta (un archivo por URL). */
function fileCache(dir: string): ResponseCache {
  const fileOf = (url: string) => path.join(dir, `${createHash('sha1').update(url).digest('hex')}.json`);
  return {
    async get(url) {
      try {
        return (JSON.parse(await readFile(fileOf(url), 'utf8')) as { body: unknown }).body;
      } catch {
        return undefined;
      }
    },
    async set(url, body) {
      await mkdir(dir, { recursive: true });
      await writeFile(fileOf(url), JSON.stringify({ url, body }), 'utf8');
    },
  };
}

const cacheDir = value('cache');
const result = await runCircuits({
  events: schedule.events,
  series: schedule.series,
  log,
  limit: Number(value('limit') ?? 0),
  force: flag('force'),
  rematch: flag('rematch'),
  only: value('only')?.split(',').filter(Boolean),
  dryRun: flag('dry-run'),
  cache: cacheDir ? fileCache(path.resolve(cacheDir)) : undefined,
});
if (!result) process.exit(1);

const byId = new Map(result.file.circuits.map((c) => [c.id, c]));
const row = (r: CircuitReport) =>
  [
    r.id,
    r.wikidata ?? '-',
    r.label ?? '-',
    r.entityCountry ?? '-',
    `${r.name} (${r.country || 'sin país'})`,
    r.how,
    coords(byId.get(r.id)),
    extras(byId.get(r.id)),
    r.ambiguous ? `candidatos: ${r.ambiguous.join('; ')}` : '',
    r.discarded ? `descartados: ${r.discarded.join('; ')}` : '',
    r.note ?? '',
  ]
    .join(' | ')
    .replace(/( \| )+$/, '');

if (result.reports.length) {
  console.log('\nid | Wikidata | etiqueta | país del elemento | nombre en el calendario (país) | cómo | coordenadas | datos');
  for (const r of [...result.reports].sort((a, b) => a.id.localeCompare(b.id))) console.log(row(r));
}
printCoverage(result.file.circuits);
if (result.pending) console.log(`Quedaron ${result.pending} circuitos sin consultar${result.error ? `: ${result.error}` : ''}.`);
if (result.error) process.exit(1);
