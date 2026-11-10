import { defineStore } from 'pinia';
import type { NewsFile, NewsItem } from '@dm/shared';
import { DataNotFoundError, fetchData } from '../lib/data.ts';

/** Noticias (data/news.json): se descargan al abrir Noticias o una pestaña que las muestre. */
export const useNewsStore = defineStore('news', {
  state: () => ({
    file: null as NewsFile | null,
    status: 'idle' as 'idle' | 'loading' | 'ok' | 'missing' | 'error',
    error: null as string | null,
  }),
  getters: {
    items: (state): NewsItem[] => state.file?.items ?? [],
  },
  actions: {
    async load(force = false) {
      if (!force && (this.status === 'ok' || this.status === 'loading')) return;
      this.status = 'loading';
      try {
        this.file = await fetchData<NewsFile>('news.json', { force });
        this.status = 'ok';
        this.error = null;
      } catch (e) {
        if (e instanceof DataNotFoundError) {
          this.status = 'missing';
        } else {
          this.status = 'error';
          this.error = (e as Error).message;
        }
      }
    },
  },
});

/** Notas de cualquiera de estas categorías. */
export function newsForSeries(items: NewsItem[], seriesIds: string[]): NewsItem[] {
  const set = new Set(seriesIds);
  return items.filter((n) => n.seriesIds.some((id) => set.has(id)));
}

/** Notas que mencionan a un piloto (por su apellido) dentro de sus categorías. */
export function newsForDriver(items: NewsItem[], name: string, seriesIds: string[]): NewsItem[] {
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const words = norm(name)
    .split(/\s+/)
    .filter((w) => w.length >= 4);
  const last = words[words.length - 1];
  if (!last) return [];
  const escaped = last.replace(/[^a-z0-9]/g, (c) => `\\${c}`);
  const re = new RegExp(`(^|[^a-z])${escaped}([^a-z]|$)`);
  return newsForSeries(items, seriesIds).filter((n) => re.test(norm(`${n.title} ${n.summary ?? ''}`)));
}
