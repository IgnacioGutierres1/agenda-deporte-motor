import type { Adapter } from '../core/types.ts';

// TODO(feat/adapters-moto-nascar): implementar con cf.nascar.com/cacher
export const nascarAdapter: Adapter = {
  name: 'nascar',
  async schedule() {
    throw new Error('Lector de NASCAR no implementado todavía');
  },
};
