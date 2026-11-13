/**
 * Correcciones manuales de las fichas de circuitos: config/circuits.json.
 *   { "<id del circuito>": { "wikidata": "Q…" | null, "lat": …, "lon": …, "name": "…", "city": "…" } }
 * - wikidata: el elemento correcto de Wikidata; null = "no buscar" (no es un circuito o no tiene ficha).
 * - lat / lon: coordenadas exactas cuando Wikidata no las tiene.
 * - name: nombre a mostrar. city: localidad (también es la que se busca para las coordenadas aproximadas;
 *   admite la provincia después de una coma: "San Jorge, Santa Fe").
 */
import path from 'node:path';
import { z } from 'zod';
import { CONFIG_DIR } from '../core/paths.ts';
import { readJson } from '../core/store.ts';

const overrideSchema = z
  .object({
    wikidata: z
      .string()
      .regex(/^Q\d+$/)
      .nullable()
      .optional(),
    lat: z.number().min(-90).max(90).optional(),
    lon: z.number().min(-180).max(180).optional(),
    name: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
  })
  .strict()
  .refine((o) => (o.lat === undefined) === (o.lon === undefined), 'lat y lon van juntas');

export type CircuitOverride = z.infer<typeof overrideSchema>;
export type CircuitOverrides = Record<string, CircuitOverride>;

const overridesSchema = z.record(z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/), overrideSchema);

/** Lee config/circuits.json (sin el archivo no hay correcciones). Si está mal escrito, lanza. */
export async function loadCircuitOverrides(configDir = CONFIG_DIR): Promise<CircuitOverrides> {
  const raw = await readJson<Record<string, unknown>>(path.join(configDir, 'circuits.json'));
  if (!raw) return {};
  const { $comment: _ignored, ...rest } = raw;
  return overridesSchema.parse(rest);
}
