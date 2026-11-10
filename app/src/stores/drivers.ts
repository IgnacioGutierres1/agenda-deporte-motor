import { defineStore } from 'pinia';
import type { Driver, DriversFile } from '@dm/shared';
import { DataNotFoundError, fetchData } from '../lib/data.ts';
import { useSettingsStore } from './settings.ts';

const normalize = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();

/** Índice de pilotos (data/drivers.json): se descarga solo al abrir una pantalla de pilotos. */
export const useDriversStore = defineStore('drivers', {
  state: () => ({
    file: null as DriversFile | null,
    status: 'idle' as 'idle' | 'loading' | 'ok' | 'missing' | 'error',
    error: null as string | null,
  }),
  getters: {
    byId(state): Map<string, Driver> {
      return new Map((state.file?.drivers ?? []).map((d) => [d.id, d]));
    },
  },
  actions: {
    async load(force = false) {
      if (!force && (this.status === 'ok' || this.status === 'loading')) return;
      this.status = 'loading';
      try {
        this.file = await fetchData<DriversFile>('drivers.json', { force });
        this.status = 'ok';
        this.error = null;
        // Mantiene al día las categorías de los pilotos seguidos (las usa la Agenda).
        useSettingsStore().syncFollowedDrivers((id) => {
          const d = this.byId.get(id);
          return d ? { id: d.id, name: d.name, seriesIds: [...new Set(d.entries.map((e) => e.seriesId))] } : undefined;
        });
      } catch (e) {
        if (e instanceof DataNotFoundError) {
          this.status = 'missing';
        } else {
          this.status = 'error';
          this.error = (e as Error).message;
        }
      }
    },
    /** Búsqueda por nombre (sin acentos) o número; primero los que están mejor ubicados. */
    search(query: string, limit = 30): Driver[] {
      const q = normalize(query.trim());
      if (q.length < 2) return [];
      const words = q.split(/\s+/);
      const best = (d: Driver) => Math.min(...d.entries.map((e) => e.pos));
      return (this.file?.drivers ?? [])
        .filter((d) => {
          const hay = normalize(d.name);
          return words.every((w) => hay.includes(w)) || d.entries.some((e) => e.number === q);
        })
        .sort((a, b) => best(a) - best(b) || a.name.localeCompare(b.name, 'es'))
        .slice(0, limit);
    },
  },
});
