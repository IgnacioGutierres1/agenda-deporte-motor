import { cp, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Plugin } from 'vite';

const TYPES: Record<string, string> = {
  '.json': 'application/json; charset=utf-8',
  '.ics': 'text/calendar; charset=utf-8',
};

/**
 * Sirve el directorio data/ del repo bajo /data/ en desarrollo y lo copia a dist/data en el build
 * (sin data/_cache, que es interna del pipeline).
 */
export function serveData(dataDir: string): Plugin {
  let outDir = 'dist';
  return {
    name: 'dm-serve-data',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const base = server.config.base.replace(/\/$/, '');
        const url = decodeURIComponent((req.url ?? '').split('?')[0] ?? '');
        const prefix = `${base}/data/`;
        if (!url.startsWith(prefix)) return next();
        const rel = url.slice(prefix.length);
        const file = path.resolve(dataDir, rel);
        if (!file.startsWith(dataDir + path.sep) || rel.startsWith('_cache')) {
          res.statusCode = 403;
          return res.end();
        }
        try {
          if (!(await stat(file)).isFile()) return next();
          res.setHeader('Content-Type', TYPES[path.extname(file)] ?? 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-store');
          res.end(await readFile(file));
        } catch {
          res.statusCode = 404;
          res.end();
        }
      });
    },
    async closeBundle() {
      try {
        await stat(dataDir);
      } catch {
        return;
      }
      await cp(dataDir, path.join(outDir, 'data'), {
        recursive: true,
        filter: (src) => !src.includes(`${path.sep}_cache`),
      });
    },
  };
}
