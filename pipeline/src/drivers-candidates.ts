/**
 * Lista los posibles pilotos duplicados del índice publicado (data/drivers-index.json): nombres parecidos con
 * equipo, número o país en común. Sirve para mantener config/driver-aliases.json; no cambia nada.
 *
 * Uso: npm run drivers:candidates [-- --all]   (--all: también los que solo comparten país)
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { driversIndexFileSchema } from '@dm/shared';
import { duplicateCandidates, ignoredPairs } from './core/driver-candidates.ts';
import { DATA_DIR } from './core/paths.ts';
import { readJson } from './core/store.ts';

async function main(argv: string[]): Promise<void> {
  const file = path.join(DATA_DIR, 'drivers-index.json');
  const index = await readJson(file, driversIndexFileSchema);
  if (!index) throw new Error(`No existe ${file}`);
  const all = argv.includes('--all');
  const list = duplicateCandidates(index.drivers, ignoredPairs()).filter((c) => all || c.evidence.some((e) => e !== 'país'));
  console.log(`${index.drivers.length} pilotos en ${file}; ${list.length} posibles duplicados${all ? '' : ' (sin los que solo comparten país; --all para verlos)'}:`);
  for (const c of list) {
    console.log(`  ${c.a.name} (${c.a.id})  ~  ${c.b.name} (${c.b.id})  · ${c.nameMatch} · en común: ${c.evidence.join(', ')}`);
  }
  if (list.length) console.log('\nSi son la misma persona, sumar "alias": "id-canónico" en config/driver-aliases.json (aliases).');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
