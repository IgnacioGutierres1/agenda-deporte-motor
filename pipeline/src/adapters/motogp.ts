import type { Adapter } from '../core/types.ts';

// TODO(feat/adapters-moto-nascar): implementar con api.motogp.pulselive.com
export const motogpAdapter: Adapter = {
  name: 'motogp',
  async schedule() {
    throw new Error('Lector de MotoGP no implementado todavía');
  },
};
