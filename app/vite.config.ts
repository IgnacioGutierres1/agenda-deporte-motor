import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { VitePWA } from 'vite-plugin-pwa';
import { serveData } from './build/serve-data.ts';

const here = path.dirname(fileURLToPath(import.meta.url));

// En GitHub Pages la app vive en /<repo>/. Se define con VITE_BASE en el workflow.
const base = process.env.VITE_BASE ?? '/';

export default defineConfig(({ command, mode }) => {
  // `npm run dev:fixtures` sirve los datos de prueba de app/test/fixtures en /data/ (solo en desarrollo).
  // DM_DATA_DIR permite probar con otra copia de data/ (p. ej. con archivos que el pipeline todavía no publica).
  const useFixtures = command === 'serve' && mode === 'fixtures';
  const dataDir = process.env.DM_DATA_DIR
    ? path.resolve(process.env.DM_DATA_DIR)
    : useFixtures
      ? path.resolve(here, 'test', 'fixtures')
      : path.resolve(here, '..', 'data');

  return {
    base,
    plugins: [
      vue(),
      serveData(dataDir),
      VitePWA({
        registerType: 'autoUpdate',
        injectRegister: false,
        includeAssets: ['icons/icon.svg', 'icons/apple-touch-icon.png'],
        manifest: {
          name: 'Deporte Motor',
          short_name: 'Deporte Motor',
          description: 'Grilla de horarios de deporte motor con fuentes oficiales, resultados y campeonatos.',
          lang: 'es-AR',
          dir: 'ltr',
          start_url: '.',
          scope: '.',
          display: 'standalone',
          orientation: 'portrait',
          background_color: '#111111',
          theme_color: '#111111',
          categories: ['sports'],
          icons: [
            { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
            { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
            { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
            { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml' },
          ],
        },
        workbox: {
          globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
          globIgnores: ['data/**'],
          navigateFallback: 'index.html',
          navigateFallbackDenylist: [/\/data\//],
          // Manejo de avisos push (public/push-handler.js).
          importScripts: ['push-handler.js'],
          runtimeCaching: [
            {
              // Datos del pipeline: siempre intenta la red y, sin conexión, usa la última copia.
              urlPattern: ({ url }) => /\/data\/.+\.json$/.test(url.pathname),
              handler: 'NetworkFirst',
              options: {
                cacheName: 'dm-data',
                networkTimeoutSeconds: 10,
                expiration: { maxEntries: 300, maxAgeSeconds: 60 * 60 * 24 * 60 },
                cacheableResponse: { statuses: [200] },
              },
            },
          ],
        },
      }),
    ],
    server: {
      fs: { allow: [path.resolve(here, '..')] },
    },
    build: {
      rollupOptions: {
        // Los módulos de @dm/shared no tienen efectos secundarios: así los esquemas zod (y zod)
        // solo entran en el chunk de Ajustes, que es el único que los usa.
        treeshake: {
          moduleSideEffects: (id) => !/[\\/]shared[\\/]src[\\/]/.test(id),
        },
      },
    },
  };
});
