import type { Adapter } from '../core/types.ts';

// TODO(feat/adapters-fia): implementar con fiaformula2.com / fiaformula3.com
export const fiaJuniorAdapter: Adapter = {
  name: 'fia-junior',
  async schedule() {
    throw new Error('Lector de F2/F3 no implementado todavía');
  },
};
