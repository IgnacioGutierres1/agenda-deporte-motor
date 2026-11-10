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

export type ThemeChoice = 'dark' | 'light' | 'system';

/** Piloto seguido: se guarda con sus categorías para armar la agenda sin descargar el índice de pilotos. */
export interface FollowedDriver {
  id: string;
  name: string;
  seriesIds: string[];
}

/** Preferencias de este dispositivo (se guardan en localStorage desde main.ts). */
export const useSettingsStore = defineStore('settings', {
  state: () => ({
    /** Zona en la que se muestran los horarios. */
    timeZone: AR_TZ as string,
    /** Series ocultas en este dispositivo (filtro de la grilla). */
    hiddenSeries: [] as string[],
    /** Categorías que sigue el usuario (aparecen primero en la agenda y en Siguiendo), en orden. */
    followedSeries: [] as string[],
    /** Pilotos que sigue el usuario, en orden. */
    followedDrivers: [] as FollowedDriver[],
    /** Avisos push activados en este dispositivo. */
    notifyEnabled: false,
    /** Minutos de anticipación de los avisos. */
    notifyLead: 30,
    /** Tema visual: oscuro por defecto, como FotMob. */
    theme: 'dark' as ThemeChoice,
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
    /** Categorías de las que se avisa: las seguidas y las de los pilotos seguidos. */
    notifySeriesIds(state): string[] {
      return [...new Set([...state.followedSeries, ...state.followedDrivers.flatMap((d) => d.seriesIds)])].sort();
    },
    canWriteRepo(state): boolean {
      return state.githubToken.trim() !== '' && parseRepo(this.effectiveRepo) !== null;
    },
  },
  actions: {
    isFollowed(seriesId: string): boolean {
      return this.followedSeries.includes(seriesId);
    },
    toggleFollow(seriesId: string) {
      this.followedSeries = this.isFollowed(seriesId)
        ? this.followedSeries.filter((id) => id !== seriesId)
        : [...this.followedSeries, seriesId];
    },
    isDriverFollowed(driverId: string): boolean {
      return this.followedDrivers.some((d) => d.id === driverId);
    },
    toggleFollowDriver(driver: FollowedDriver) {
      this.followedDrivers = this.isDriverFollowed(driver.id)
        ? this.followedDrivers.filter((d) => d.id !== driver.id)
        : [...this.followedDrivers, { id: driver.id, name: driver.name, seriesIds: [...driver.seriesIds] }];
    },
    /** Actualiza nombre y categorías de los pilotos seguidos con el índice publicado. */
    syncFollowedDrivers(lookup: (id: string) => FollowedDriver | undefined) {
      let changed = false;
      const next = this.followedDrivers.map((d) => {
        const fresh = lookup(d.id);
        if (!fresh) return d;
        if (fresh.name === d.name && fresh.seriesIds.join() === d.seriesIds.join()) return d;
        changed = true;
        return { id: d.id, name: fresh.name, seriesIds: [...fresh.seriesIds] };
      });
      if (changed) this.followedDrivers = next;
    },
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
