import type { Adapter } from '../core/types.ts';
import { motogpAdapter } from './motogp.ts';
import { nascarAdapter } from './nascar.ts';
import { f1Adapter } from './f1.ts';
import { fiaJuniorAdapter } from './fia-junior.ts';
import { wrcAdapter } from './wrc.ts';

/** Lectores directos (Nivel A). La clave coincide con Series.adapter en config/series.default.json. */
export const adapters: Record<string, Adapter> = {
  motogp: motogpAdapter,
  nascar: nascarAdapter,
  f1: f1Adapter,
  'fia-junior': fiaJuniorAdapter,
  wrc: wrcAdapter,
};
