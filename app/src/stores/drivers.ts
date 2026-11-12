import { defineStore } from 'pinia';
import type { Driver, DriversFile } from '@dm/shared';
import { DataNotFoundError, fetchData } from '../lib/data.ts';
import { searchDrivers } from '../lib/search.ts';
import { driverSeriesIds } from '../lib/teams.ts';
import { useSettingsStore } from './settings.ts';

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
      // Al actualizar se siguen mostrando los datos anteriores hasta que lleguen los nuevos.
      if (!this.file) this.status = 'loading';
      try {
        this.file = await fetchData<DriversFile>('drivers.json', { force });
        this.status = 'ok';
        this.error = null;
        // Mantiene al día las categorías de los pilotos seguidos (las usa la Agenda).
        useSettingsStore().syncFollowedDrivers((id) => {
          const d = this.byId.get(id);
          return d ? { id: d.id, name: d.name, seriesIds: driverSeriesIds(d) } : undefined;
        });
      } catch (e) {
        if (this.file) {
          // Falló una actualización: se conserva la copia que ya había.
          this.status = 'ok';
        } else if (e instanceof DataNotFoundError) {
          this.status = 'missing';
        } else {
          this.status = 'error';
          this.error = (e as Error).message;
        }
      }
    },
    /** Búsqueda por nombre (sin acentos) o número; primero los que están mejor ubicados. */
    search(query: string, limit = 30): Driver[] {
      return searchDrivers(this.file?.drivers ?? [], query, limit);
    },
  },
});
