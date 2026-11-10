import path from 'node:path';
import { z } from 'zod';
import { CONFIG_DIR } from '../core/paths.ts';
import { readJson } from '../core/store.ts';

export const newsFeedSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  /** URL del feed RSS/Atom. */
  url: z.string().url(),
  kind: z.enum(['oficial', 'medio']),
  lang: z.enum(['es', 'en']),
  /** Categorías de las que trata el feed (si es de una sola). Se suman a las de las palabras clave. */
  seriesIds: z.array(z.string()).optional(),
  homepage: z.string().url().optional(),
  /** Encabezados HTTP extra (p. ej. un sitio que manda gzip roto: "Accept-Encoding": "identity"). */
  headers: z.record(z.string()).optional(),
  /** Desactivar sin borrar. */
  enabled: z.boolean().optional(),
});

export const newsConfigSchema = z.object({
  /** Se conservan las notas de los últimos N días. */
  maxAgeDays: z.number().positive().default(10),
  /** Tope total de notas en data/news.json. */
  maxItems: z.number().int().positive().default(250),
  /** Tope por fuente, para que un medio muy prolífico no tape al resto. */
  maxPerFeed: z.number().int().positive().default(40),
  /** Largo máximo de la bajada. */
  summaryMaxChars: z.number().int().positive().default(240),
  feeds: z.array(newsFeedSchema),
});

export type NewsFeed = z.infer<typeof newsFeedSchema>;
export type NewsConfig = z.infer<typeof newsConfigSchema>;

export async function loadNewsConfig(configDir = CONFIG_DIR): Promise<NewsConfig | null> {
  const raw = await readJson<unknown>(path.join(configDir, 'news.json'));
  return raw === null ? null : newsConfigSchema.parse(raw);
}
