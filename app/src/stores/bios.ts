import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import {
  driverShard,
  type DriverBio,
  type DriverBiosShardFile,
  type SeriesHistory,
  type SeriesHistoryFile,
  type TeamBio,
  type TeamBiosFile,
} from '@dm/shared';
import { DataNotFoundError, fetchData } from '../lib/data.ts';

export type BioStatus = 'idle' | 'loading' | 'ok' | 'missing' | 'error';

/** Ruta (dentro de data/) del grupo de historiales de pilotos: el mismo grupo que la ficha (driverShard). */
export function driverBiosPath(id: string): string {
  return `bios/drivers/${driverShard(id)}.json`;
}
export const TEAM_BIOS_PATH = 'bios/teams.json';
export const SERIES_HISTORY_PATH = 'bios/series.json';

/** La validación (zod) se carga recién cuando llega el primer archivo: queda en un chunk aparte. */
const schemas = () => import('../lib/bioSchemas.ts');

/**
 * Historial (data/bios/**, ver profiles.ts): fichas de pilotos por grupo, equipos y categorías. Todo se pide recién
 * al abrir la pantalla que lo usa y es opcional: si el archivo no está publicado (404), es inválido o falla la red,
 * la pantalla sigue sin esas secciones. Los archivos se validan con los esquemas compartidos (las fichas mal
 * formadas se descartan una por una) y se guardan sin proxies reactivos (markRaw).
 */
export const useBiosStore = defineStore('bios', {
  state: () => ({
    /** Historiales de pilotos ya descargados, por id. */
    drivers: {} as Record<string, DriverBio>,
    /** Estado de cada grupo pedido (por shard: "3f"). */
    driverShards: {} as Record<string, BioStatus>,
    teamsFile: null as TeamBiosFile | null,
    teamsStatus: 'idle' as BioStatus,
    seriesFile: null as SeriesHistoryFile | null,
    seriesStatus: 'idle' as BioStatus,
  }),
  getters: {
    driverStatus(state): (id: string) => BioStatus {
      return (id: string) => state.driverShards[driverShard(id)] ?? 'idle';
    },
    teamsById(state): Map<string, TeamBio> {
      return new Map((state.teamsFile?.teams ?? []).map((t) => [t.id, t]));
    },
    seriesById(state): Map<string, SeriesHistory> {
      return new Map((state.seriesFile?.series ?? []).map((s) => [s.seriesId, s]));
    },
  },
  actions: {
    /** Historial de un piloto: baja su grupo (data/bios/drivers/{shard}.json) una sola vez. */
    async loadDriver(id: string, force = false) {
      const shard = driverShard(id);
      const current = this.driverShards[shard];
      if (!force && (current === 'ok' || current === 'loading' || current === 'missing')) return;
      if (current !== 'ok') this.driverShards[shard] = 'loading';
      const path = driverBiosPath(id);
      try {
        const raw = await fetchData<unknown>(path, { force });
        const file: DriverBiosShardFile = (await schemas()).parseDriverBios(raw, path);
        const next = { ...this.drivers };
        for (const b of file.bios) next[b.id] = markRaw(b);
        this.drivers = next;
        this.driverShards[shard] = 'ok';
      } catch (e) {
        // Falló una actualización: se conserva lo que había.
        if (current === 'ok' && !(e instanceof DataNotFoundError)) this.driverShards[shard] = 'ok';
        else this.driverShards[shard] = e instanceof DataNotFoundError ? 'missing' : 'error';
      }
    },

    /** Historial de todos los equipos (data/bios/teams.json). */
    async loadTeams(force = false) {
      if (!force && this.teamsStatus !== 'idle' && this.teamsStatus !== 'error') return;
      if (!this.teamsFile) this.teamsStatus = 'loading';
      try {
        const raw = await fetchData<unknown>(TEAM_BIOS_PATH, { force });
        this.teamsFile = markRaw((await schemas()).parseTeamBios(raw, TEAM_BIOS_PATH));
        this.teamsStatus = 'ok';
      } catch (e) {
        if (this.teamsFile && !(e instanceof DataNotFoundError)) this.teamsStatus = 'ok';
        else {
          if (e instanceof DataNotFoundError) this.teamsFile = null;
          this.teamsStatus = e instanceof DataNotFoundError ? 'missing' : 'error';
        }
      }
    },

    /** Historia de todas las categorías (data/bios/series.json). */
    async loadSeries(force = false) {
      if (!force && this.seriesStatus !== 'idle' && this.seriesStatus !== 'error') return;
      if (!this.seriesFile) this.seriesStatus = 'loading';
      try {
        const raw = await fetchData<unknown>(SERIES_HISTORY_PATH, { force });
        this.seriesFile = markRaw((await schemas()).parseSeriesHistory(raw, SERIES_HISTORY_PATH));
        this.seriesStatus = 'ok';
      } catch (e) {
        if (this.seriesFile && !(e instanceof DataNotFoundError)) this.seriesStatus = 'ok';
        else {
          if (e instanceof DataNotFoundError) this.seriesFile = null;
          this.seriesStatus = e instanceof DataNotFoundError ? 'missing' : 'error';
        }
      }
    },

    /** "Actualizar": vuelve a pedir (sin caché) lo que ya se abrió. */
    async reloadLoaded() {
      const ids = new Map<string, string>();
      for (const id of Object.keys(this.drivers)) ids.set(driverShard(id), id);
      await Promise.all([
        ...[...ids.values()].map((id) => this.loadDriver(id, true)),
        this.teamsStatus !== 'idle' ? this.loadTeams(true) : Promise.resolve(),
        this.seriesStatus !== 'idle' ? this.loadSeries(true) : Promise.resolve(),
      ]);
    },
  },
});
