/**
 * Lee solo las noticias y escribe data/news.json, con un resumen por fuente y por categoría.
 * Uso: npm run news -- [--dry-run] [--sample=15]
 */
import { createHttp } from '../core/http.ts';
import { createLogger } from '../core/log.ts';
import { runNews } from './index.ts';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const sample = Number(args.find((a) => a.startsWith('--sample='))?.slice(9) ?? 15);

const log = createLogger('noticias');
const result = await runNews({ http: createHttp({ retries: 1 }), log, dryRun });
if (!result) process.exit(1);

console.log('\nFuentes:');
for (const s of result.stats) {
  const state = s.ok ? `${String(s.fetched).padStart(3)} leídas, ${String(s.kept).padStart(3)} en el archivo` : `ERROR ${s.error}`;
  console.log(`  ${s.name.padEnd(28)} ${state}`);
}

const items = result.file?.items ?? [];
console.log(`\nÚltimas ${Math.min(sample, items.length)} de ${items.length}:`);
for (const i of items.slice(0, sample)) {
  console.log(`  ${i.publishedAt}  ${i.source.padEnd(22)} [${i.seriesIds.join(',')}] ${i.title}`);
}

const bySeries = new Map<string, number>();
for (const i of items) for (const id of i.seriesIds) bySeries.set(id, (bySeries.get(id) ?? 0) + 1);
console.log(`\nPor categoría (${items.filter((i) => !i.seriesIds.length).length} sin categoría):`);
for (const [id, n] of [...bySeries].sort((a, b) => b[1] - a[1])) console.log(`  ${id.padEnd(18)} ${n}`);

if (items.length) {
  const oldest = items[items.length - 1]!.publishedAt;
  const days = (Date.parse(items[0]!.publishedAt) - Date.parse(oldest)) / 86_400_000;
  const grouped = items.filter((i) => i.alsoIn?.length);
  console.log(
    `\nVentana: ${days.toFixed(1)} días (desde ${oldest}); ${grouped.length} notas agrupadas con ` +
      `${grouped.reduce((n, i) => n + i.alsoIn!.length, 0)} versiones de otros medios; ${items.filter((i) => !i.image).length} sin foto`,
  );
}
if (!result.file) process.exit(1);
