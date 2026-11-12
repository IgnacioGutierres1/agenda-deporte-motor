import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import {
  driverShard,
  driverShardPath,
  type Driver,
  type DriverDetail,
  type DriverShardFile,
  type DriversFile,
  type DriversIndexFile,
} from '@dm/shared';
import { DataNotFoundError, fetchData } from '../lib/data.ts';
import { searchDrivers } from '../lib/search.ts';
import { driverSeriesIds } from '../lib/teams.ts';
import { useSettingsStore } from './settings.ts';

export type ShardStatus = 'loading' | 'ok' | 'missing' | 'error';

/**
 * Pilotos, en dos niveles:
 *  - Índice liviano (data/drivers-index.json, sin las últimas carreras): se descarga solo al abrir una
 *    pantalla que lista o busca pilotos. Es `file`, `byId` y `search()`.
 *  - Fichas completas (data/drivers/{shard}.json, unas pocas por archivo): se piden al abrir la ficha de
 *    un piloto con `loadDetail(id)` y quedan en `details`.
 * Si el pipeline todavía no publicó el índice, se usa data/drivers.json (todas las fichas completas).
 * Los archivos se guardan sin proxies reactivos (markRaw): se reemplazan enteros y nunca se modifican.
 */
export const useDriversStore = defineStore('drivers', {
  state: () => ({
    file: null as DriversIndexFile | null,
    status: 'idle' as 'idle' | 'loading' | 'ok' | 'missing' | 'error',
    error: null as string | null,
    /** Fichas completas ya descargadas, por id de piloto. */
    details: {} as Record<string, DriverDetail>,
    /** Estado de cada grupo de fichas pedido (por shard: "3f"). */
    shards: {} as Record<string, { status: ShardStatus; error?: string }>,
  }),
  getters: {
    byId(state): Map<string, Driver> {
      return new Map((state.file?.drivers ?? []).map((d) => [d.id, d]));
    },
    /** Estado de la ficha completa de un piloto ('idle' si todavía no se pidió). */
    detailStatus(state): (id: string) => ShardStatus | 'idle' {
      return (id: string) => state.shards[driverShard(id)]?.status ?? 'idle';
    },
  },
  actions: {
    async load(force = false) {
      if (!force && (this.status === 'ok' || this.status === 'loading')) return;
      // Al actualizar se siguen mostrando los datos anteriores hasta que lleguen los nuevos.
      if (!this.file) this.status = 'loading';
      try {
        this.file = markRaw(await fetchIndex(force, (all) => this.keepDetails(all)));
        this.status = 'ok';
        this.error = null;
        // Mantiene al día las categorías de los pilotos seguidos (las usa la Agenda).
        this.syncFollowed(this.byId);
        // Quien lista o busca pilotos suele abrir una ficha: se deja bajado el código de esa pantalla.
        void import('../views/DriverView.vue').catch(() => undefined);
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

    /**
     * Ficha completa de un piloto (con sus últimas carreras): baja el grupo de fichas que lo contiene.
     * Si no hay fichas publicadas o falla la red, cae al índice (que puede estar guardado sin conexión).
     */
    async loadDetail(id: string, force = false) {
      const shard = driverShard(id);
      const current = this.shards[shard];
      if (!force && (this.details[id] || current?.status === 'ok' || current?.status === 'loading')) return;
      if (!this.details[id]) this.shards[shard] = { status: 'loading' };
      try {
        const file = await fetchData<DriverShardFile>(driverShardPath(id), { force });
        this.keepDetails(file.drivers);
        this.shards[shard] = { status: 'ok' };
        this.syncFollowed(new Map(file.drivers.map((d) => [d.id, d])));
      } catch (e) {
        if (current?.status === 'ok' && !(e instanceof DataNotFoundError)) {
          // Falló una actualización: se conserva lo que había.
          this.shards[shard] = current;
          return;
        }
        this.shards[shard] = e instanceof DataNotFoundError ? { status: 'missing' } : { status: 'error', error: (e as Error).message };
        await this.load();
      }
    },

    /** "Actualizar": vuelve a pedir (sin caché) los grupos de fichas ya abiertos. */
    async reloadDetails() {
      const ids = new Map<string, string>();
      for (const id of Object.keys(this.details)) ids.set(driverShard(id), id);
      await Promise.all([...ids.values()].map((id) => this.loadDetail(id, true)));
    },

    keepDetails(drivers: DriverDetail[]) {
      const next = { ...this.details };
      for (const d of drivers) next[d.id] = markRaw(d);
      this.details = next;
    },

    syncFollowed(byId: Map<string, Driver>) {
      useSettingsStore().syncFollowedDrivers((id) => {
        const d = byId.get(id);
        return d ? { id: d.id, name: d.name, seriesIds: driverSeriesIds(d) } : undefined;
      });
    },

    /** Búsqueda por nombre (sin acentos) o número; primero los que están mejor ubicados. */
    search(query: string, limit = 30): Driver[] {
      return searchDrivers(this.file?.drivers ?? [], query, limit);
    },
  },
});

/**
 * Índice de pilotos. Sin drivers-index.json (datos de antes de la división) usa drivers.json, que trae
 * las fichas completas: esas se entregan a `onFull` para no tener que pedirlas otra vez.
 */
async function fetchIndex(force: boolean, onFull: (drivers: DriverDetail[]) => void): Promise<DriversIndexFile> {
  try {
    return await fetchData<DriversIndexFile>('drivers-index.json', { force });
  } catch (e) {
    if (!(e instanceof DataNotFoundError)) throw e;
    const full = await fetchData<DriversFile>('drivers.json', { force });
    onFull(full.drivers);
    return full;
  }
}
