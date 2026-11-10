import type { Adapter } from '../core/types.ts';

// TODO(feat/adapters-fia): implementar con las páginas oficiales de formula1.com
export const f1Adapter: Adapter = {
  name: 'f1',
  async schedule() {
    throw new Error('Lector de F1 no implementado todavía');
  },
};
