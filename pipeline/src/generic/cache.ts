/**
 * Caché de extracciones con IA: data/_cache/extract/{serie}/{tipo}-{hash}.json.
 * La clave combina la serie, el tipo de extracción, la versión del prompt y el hash del documento:
 * Gemini solo se vuelve a llamar cuando el documento oficial cambió.
 */
import path from 'node:path';
import { readJson, writeJson } from '../core/store.ts';
import { sha256 } from '../extract/document.ts';

export interface CachedExtraction<T> {
  key: string;
  url: string;
  model: string;
  createdAt: string;
  data: T;
}

export interface ExtractionCache {
  get<T>(seriesId: string, kind: string, docHash: string, extra?: string): Promise<CachedExtraction<T> | null>;
  set<T>(seriesId: string, kind: string, docHash: string, entry: Omit<CachedExtraction<T>, 'key'>, extra?: string): Promise<void>;
}

export function createExtractionCache(cacheDir: string, promptVersion: string): ExtractionCache {
  const file = (seriesId: string, kind: string, docHash: string, extra = '') => {
    const key = sha256(`${seriesId}|${kind}|${promptVersion}|${extra}|${docHash}`).slice(0, 24);
    return { key, path: path.join(cacheDir, 'extract', seriesId, `${kind}-${key}.json`) };
  };
  return {
    async get(seriesId, kind, docHash, extra) {
      const f = file(seriesId, kind, docHash, extra);
      try {
        return await readJson(f.path);
      } catch {
        return null;
      }
    },
    async set(seriesId, kind, docHash, entry, extra) {
      const f = file(seriesId, kind, docHash, extra);
      await writeJson(f.path, { key: f.key, ...entry });
    },
  };
}
