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

/** Equipo seguido: igual que un piloto, con sus categorías (las de sus tablas, inscripciones y pilotos). */
export type FollowedTeam = FollowedDriver;

/**
 * Lista actualizada con el índice publicado (nombre y categorías), o null si no cambió nada.
 * Lo que no figura en el índice se conserva tal cual (puede volver la temporada siguiente).
 */
function syncRefs<T extends FollowedDriver>(list: T[], lookup: (id: string) => FollowedDriver | undefined): FollowedDriver[] | null {
  let changed = false;
  const next = list.map((d): FollowedDriver => {
    const fresh = lookup(d.id);
    if (!fresh) return d;
    if (fresh.name === d.name && fresh.seriesIds.join() === d.seriesIds.join()) return d;
    changed = true;
    return { id: d.id, name: fresh.name, seriesIds: [...fresh.seriesIds] };
  });
  return changed ? next : null;
}

/** Campos de useSettingsStore que se guardan en localStorage (main.ts). */
export const PERSISTED_SETTINGS = [
  'timeZone',
  'hiddenSeries',
  'followedSeries',
  'followedDrivers',
  'followedTeams',
  'notifyEnabled',
  'notifyLead',
  'theme',
  'themeChosen',
  'googleClientId',
  'githubRepo',
  'githubToken',
];

/**
 * Ajusta lo guardado por versiones anteriores antes de restaurarlo.
 * Tema: antes el predeterminado era "Oscuro" y se guardaba siempre (el snapshot incluye todos los campos), así que un
 * "dark" sin themeChosen no distingue "lo eligió" de "nunca tocó el tema". Quien ya usaba la app la conoce oscura:
 * se le conserva así (no cambia de golpe a claro si el sistema está en claro). "Según el sistema" es el predeterminado
 * solo para instalaciones nuevas. Lo guardado se marca como elegido para no volver a migrarlo.
 */
export function migrateSettings(saved: Record<string, unknown>): Record<string, unknown> {
  if ('themeChosen' in saved || !('theme' in saved)) return saved;
  return { ...saved, themeChosen: saved.theme !== 'system' };
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
    /** Equipos que sigue el usuario, en orden. */
    followedTeams: [] as FollowedTeam[],
    /** Avisos push activados en este dispositivo. */
    notifyEnabled: false,
    /** Minutos de anticipación de los avisos. */
    notifyLead: 30,
    /** Tema visual: por defecto el del sistema (prefers-color-scheme); oscuro o claro si el usuario lo eligió. */
    theme: 'system' as ThemeChoice,
    /** true cuando el usuario eligió el tema a mano (ver migrateSettings). */
    themeChosen: false,
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
    /**
     * Todas las categorías de interés: las seguidas y las de los pilotos y equipos seguidos (en ese orden).
     * Son las que van primero en la Agenda, En vivo y "Para ti".
     */
    followedSeriesIds(state): string[] {
      return [
        ...new Set([
          ...state.followedSeries,
          ...state.followedDrivers.flatMap((d) => d.seriesIds),
          ...state.followedTeams.flatMap((t) => t.seriesIds),
        ]),
      ];
    },
    /** Categorías de las que se avisa (se mandan así al Worker): las mismas, ordenadas. */
    notifySeriesIds(): string[] {
      return [...this.followedSeriesIds].sort();
    },
    canWriteRepo(state): boolean {
      return state.githubToken.trim() !== '' && parseRepo(this.effectiveRepo) !== null;
    },
  },
  actions: {
    /** Tema elegido a mano desde Ajustes (se respeta aunque cambie el predeterminado). */
    setTheme(theme: ThemeChoice) {
      this.theme = theme;
      this.themeChosen = true;
    },
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
      const next = syncRefs(this.followedDrivers, lookup);
      if (next) this.followedDrivers = next;
    },
    isTeamFollowed(teamId: string): boolean {
      return this.followedTeams.some((t) => t.id === teamId);
    },
    toggleFollowTeam(team: FollowedTeam) {
      this.followedTeams = this.isTeamFollowed(team.id)
        ? this.followedTeams.filter((t) => t.id !== team.id)
        : [...this.followedTeams, { id: team.id, name: team.name, seriesIds: [...team.seriesIds] }];
    },
    /** Actualiza nombre y categorías de los equipos seguidos con el índice de equipos. */
    syncFollowedTeams(lookup: (id: string) => FollowedTeam | undefined) {
      const next = syncRefs(this.followedTeams, lookup);
      if (next) this.followedTeams = next;
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
