import type { DiscoveredFile, Series } from '@dm/shared';
import type { AdapterContext } from '../core/types.ts';

export interface DiscoveryInput {
  /** Series ya configuradas (default + usuario + descubiertas previas), para no repetirlas. */
  known: Series[];
  previous: DiscoveredFile | null;
}

// TODO(feat/generic-ai): Fuente 1 (calendarios multi-categoría) + Fuente 2 (Gemini con búsqueda, opcional)
export async function runDiscovery(input: DiscoveryInput, ctx: AdapterContext): Promise<DiscoveredFile> {
  ctx.log.warn('Descubrimiento no implementado todavía');
  return input.previous ?? { version: 1, generatedAt: ctx.now.toISOString().replace(/\.\d{3}Z$/, 'Z'), items: [] };
}
