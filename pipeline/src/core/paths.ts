import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(here, '..', '..', '..');
export const CONFIG_DIR = process.env.DM_CONFIG_DIR ?? path.join(ROOT_DIR, 'config');
export const DATA_DIR = process.env.DM_DATA_DIR ?? path.join(ROOT_DIR, 'data');
export const CACHE_DIR = path.join(DATA_DIR, '_cache');
