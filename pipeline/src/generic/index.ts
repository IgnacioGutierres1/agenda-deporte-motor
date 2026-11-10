import type { Adapter } from '../core/types.ts';

// TODO(feat/generic-ai): flujo genérico (calendario oficial -> documento del cronograma -> Gemini -> validación)
export const genericAdapter: Adapter = {
  name: 'generic',
  async schedule(series) {
    throw new Error(`Flujo genérico no implementado todavía (${series.id})`);
  },
};
