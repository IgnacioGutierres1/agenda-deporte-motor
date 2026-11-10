/** Uso: npm run discovery  — actualiza data/discovered.json */
import path from 'node:path';
import { discoveredFileSchema } from '@dm/shared';
import { loadConfig } from '../core/config.ts';
import { createContext } from '../core/context.ts';
import { createLogger } from '../core/log.ts';
import { DATA_DIR } from '../core/paths.ts';
import { readJson, writeJson } from '../core/store.ts';
import { runDiscovery } from './index.ts';

async function main(): Promise<void> {
  const log = createLogger('descubrimiento');
  const config = await loadConfig();
  const file = path.join(DATA_DIR, 'discovered.json');
  const previous = await readJson(file, discoveredFileSchema);
  const ctx = createContext({ durations: config.durations, broadcast: config.broadcast, log });
  const result = await runDiscovery({ known: config.series, previous }, ctx);
  await writeJson(file, discoveredFileSchema.parse(result));
  log.info(`${result.items.length} competencias descubiertas`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
