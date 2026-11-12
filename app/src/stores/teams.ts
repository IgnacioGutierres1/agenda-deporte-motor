import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import type { Team, TeamsFile } from '@dm/shared';
import { DataNotFoundError, fetchData } from '../lib/data.ts';
import { deriveTeams, teamSeriesIds } from '../lib/teams.ts';
import { searchTeams } from '../lib/search.ts';
import { useDriversStore } from './drivers.ts';
import { useSettingsStore } from './settings.ts';

/**
 * Equipos (data/teams.json): se descargan al abrir una pantalla que los usa. Si ese archivo no está
 * (status 'missing') o no se pudo leer, se arman con los equipos del índice de pilotos, que recién
 * entonces se pide.
 */
export const useTeamsStore = defineStore('teams', {
  state: () => ({
    file: null as TeamsFile | null,
    status: 'idle' as 'idle' | 'loading' | 'ok' | 'missing' | 'error',
    error: null as string | null,
  }),
  getters: {
    /** true si los equipos salen del índice de pilotos (sin teams.json). */
    derived: (state): boolean => !state.file,
    teams(state): Team[] {
      if (state.file) return state.file.teams;
      return deriveTeams(useDriversStore().file?.drivers ?? []);
    },
    byId(): Map<string, Team> {
      return new Map(this.teams.map((t) => [t.id, t]));
    },
    /** Todavía no se sabe qué equipos hay (para mostrar "Cargando…"). */
    pending(state): boolean {
      if (state.status === 'idle' || state.status === 'loading') return !state.file;
      return !state.file && ['idle', 'loading'].includes(useDriversStore().status);
    },
  },
  actions: {
    /** Pide teams.json; el índice de pilotos solo hace falta como respaldo (sin teams.json). */
    async load(force = false) {
      if (!force && (this.status === 'ok' || this.status === 'loading')) return;
      if (!force && this.status === 'missing') return this.loadFallback();
      if (!this.file) this.status = 'loading';
      try {
        this.file = markRaw(await fetchData<TeamsFile>('teams.json', { force }));
        this.status = 'ok';
        this.error = null;
        this.syncFollowed();
      } catch (e) {
        if (this.file) {
          // Falló una actualización: se conserva la copia que ya había.
          this.status = 'ok';
          return;
        }
        if (e instanceof DataNotFoundError) {
          this.status = 'missing';
        } else {
          this.status = 'error';
          this.error = (e as Error).message;
        }
        await this.loadFallback();
      }
    },
    /** Sin teams.json: los equipos salen de los pilotos, cuando lleguen. */
    async loadFallback() {
      const drivers = useDriversStore();
      await drivers.load();
      if (drivers.file) this.syncFollowed();
    },
    /** Mantiene al día nombre y categorías de los equipos seguidos (los usan la Agenda y los avisos). */
    syncFollowed() {
      const byId = this.byId;
      useSettingsStore().syncFollowedTeams((id) => {
        const t = byId.get(id);
        return t ? { id: t.id, name: t.name, seriesIds: teamSeriesIds(t) } : undefined;
      });
    },
    search(query: string, limit = 10): Team[] {
      return searchTeams(this.teams, query, limit);
    },
  },
});
