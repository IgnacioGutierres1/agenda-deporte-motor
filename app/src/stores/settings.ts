import { defineStore } from 'pinia';
import { AR_TZ } from '@dm/shared';

export interface RepoRef {
  owner: string;
  repo: string;
}

/** "owner/repo" -> { owner, repo } (o null si no tiene ese formato). */
export function parseRepo(value: string | undefined | null): RepoRef | null {
  const m = (value ?? '').trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** Preferencias de este dispositivo (se guardan en localStorage desde main.ts). */
export const useSettingsStore = defineStore('settings', {
  state: () => ({
    /** Zona en la que se muestran los horarios. */
    timeZone: AR_TZ as string,
    /** Series ocultas en este dispositivo (filtro de la grilla). */
    hiddenSeries: [] as string[],
    /** Client ID OAuth de Google; vacío = el de VITE_GOOGLE_CLIENT_ID. */
    googleClientId: '',
    /** "owner/repo"; vacío = VITE_GITHUB_REPO. */
    githubRepo: '',
    /** Token de GitHub de grano fino (solo para el dueño del repo). Solo vive en este dispositivo. */
    githubToken: '',
  }),
  getters: {
    effectiveClientId(state): string {
      return state.googleClientId.trim() || (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '');
    },
    effectiveRepo(state): string {
      return state.githubRepo.trim() || (import.meta.env.VITE_GITHUB_REPO ?? '');
    },
    repoRef(): RepoRef | null {
      return parseRepo(this.effectiveRepo);
    },
    canWriteRepo(state): boolean {
      return state.githubToken.trim() !== '' && parseRepo(this.effectiveRepo) !== null;
    },
  },
  actions: {
    isHidden(seriesId: string): boolean {
      return this.hiddenSeries.includes(seriesId);
    },
    setSeriesVisible(seriesId: string, visible: boolean) {
      const set = new Set(this.hiddenSeries);
      if (visible) set.delete(seriesId);
      else set.add(seriesId);
      this.hiddenSeries = [...set];
    },
    setManyVisible(seriesIds: string[], visible: boolean) {
      const set = new Set(this.hiddenSeries);
      for (const id of seriesIds) {
        if (visible) set.delete(id);
        else set.add(id);
      }
      this.hiddenSeries = [...set];
    },
    showAll() {
      this.hiddenSeries = [];
    },
  },
});
