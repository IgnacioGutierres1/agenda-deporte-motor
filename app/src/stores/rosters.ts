import { defineStore } from 'pinia';
import type { RosterFile } from '@dm/shared';
import { DataNotFoundError, fetchData } from '../lib/data.ts';
import type { Loaded } from './results.ts';

/** Listas de inscriptos (data/rosters/{id}.json): se descargan al abrir el plantel de una categoría. */
export const useRostersStore = defineStore('rosters', {
  state: () => ({
    rosters: {} as Record<string, Loaded<RosterFile>>,
  }),
  actions: {
    async loadRoster(seriesId: string, force = false) {
      const current = this.rosters[seriesId];
      if (!force && current && current.status !== 'error') return;
      if (!current?.data) this.rosters[seriesId] = { status: 'loading' };
      const fresh = await load(seriesId, force);
      // Si falla la red al actualizar, se conserva lo que había.
      if (fresh.status === 'ok' || !this.rosters[seriesId]?.data) this.rosters[seriesId] = fresh;
    },
    /** Vuelve a pedir (sin caché) las listas ya abiertas (botón Actualizar). */
    async reloadLoaded() {
      await Promise.all(Object.keys(this.rosters).map((id) => this.loadRoster(id, true)));
    },
  },
});

async function load(seriesId: string, force: boolean): Promise<Loaded<RosterFile>> {
  try {
    return { status: 'ok', data: await fetchData<RosterFile>(`rosters/${seriesId}.json`, { force }) };
  } catch (e) {
    if (e instanceof DataNotFoundError) return { status: 'missing' };
    return { status: 'error', error: (e as Error).message };
  }
}
