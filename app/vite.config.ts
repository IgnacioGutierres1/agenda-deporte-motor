import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { serveData } from './build/serve-data.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(here, '..', 'data');

// En GitHub Pages la app vive en /<repo>/. Se define con VITE_BASE en el workflow.
const base = process.env.VITE_BASE ?? '/';

export default defineConfig({
  base,
  plugins: [vue(), serveData(dataDir)],
  server: {
    fs: { allow: [path.resolve(here, '..')] },
  },
});
