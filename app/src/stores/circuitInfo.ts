import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import { circuitId, type CircuitInfo, type CircuitsFile, type CircuitTrackFile } from '@dm/shared';
import { DataNotFoundError, fetchData } from '../lib/data.ts';
import type { Loaded } from './results.ts';

/**
 * Fichas de los circuitos (data/circuits.json): coordenadas, datos del trazado, foto y plano. Se descargan al
 * abrir una pantalla que las usa (página del circuito, clima de un evento). Si el archivo todavía no existe
 * (status 'missing') la app sigue funcionando sin fichas.
 *
 * Los trazados dibujables (data/tracks/{id}.json) se piden de a uno, recién cuando se van a mostrar.
 */
export const useCircuitInfoStore = defineStore('circuitInfo', {
  state: () => ({
    file: null as CircuitsFile | null,
    status: 'idle' as 'idle' | 'loading' | 'ok' | 'missing' | 'error',
    error: null as string | null,
    /** Trazados ya pedidos, por id de circuito. */
    tracks: {} as Record<string, Loaded<CircuitTrackFile>>,
  }),
  getters: {
    byId(state): Map<string, CircuitInfo> {
      return new Map((state.file?.circuits ?? []).map((c) => [c.id, c]));
    },
    /** Todavía no se sabe si hay fichas (para mostrar un esqueleto). */
    pending: (state): boolean => state.status === 'idle' || state.status === 'loading',
  },
  actions: {
    async load(force = false) {
      if (!force && (this.status === 'ok' || this.status === 'loading' || this.status === 'missing')) return;
      // Al reintentar un archivo que no existía no se vuelve a "cargando": las pantallas no parpadean.
      if (!this.file && this.status !== 'missing') this.status = 'loading';
      try {
        this.file = markRaw(await fetchData<CircuitsFile>('circuits.json', { force }));
        this.status = 'ok';
        this.error = null;
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
      }
    },
    /** Ficha del circuito a partir del nombre con que lo publica un evento ("Circuit Paul Ricard"). */
    infoFor(circuitName: string): CircuitInfo | undefined {
      const id = circuitId(circuitName);
      return id ? this.byId.get(id) : undefined;
    },
    /**
     * Trazado dibujable de un circuito (data/tracks/{id}.json). Se pide una sola vez; quien lo usa decide
     * cuándo (al abrir la página o cuando la miniatura entra en pantalla) y solo si la ficha dice hasTrack.
     */
    async loadTrack(id: string, force = false) {
      const current = this.tracks[id];
      if (!force && current && current.status !== 'error') return;
      if (!current?.data) this.tracks[id] = { status: 'loading' };
      const fresh = await loadTrackFile(id, force);
      // Si falla la red al actualizar, se conserva el trazado que ya había.
      if (fresh.status === 'ok' || !this.tracks[id]?.data) this.tracks[id] = fresh;
    },
    /** Vuelve a pedir (sin caché) las fichas y los trazados ya abiertos (botón Actualizar). */
    async reloadLoaded() {
      await Promise.all([
        this.status !== 'idle' ? this.load(true) : Promise.resolve(),
        ...Object.keys(this.tracks).map((id) => this.loadTrack(id, true)),
      ]);
    },
  },
});

async function loadTrackFile(id: string, force: boolean): Promise<Loaded<CircuitTrackFile>> {
  try {
    // Sin proxies reactivos: los paths son textos largos que nunca se modifican.
    return { status: 'ok', data: markRaw(await fetchData<CircuitTrackFile>(`tracks/${id}.json`, { force })) };
  } catch (e) {
    if (e instanceof DataNotFoundError) return { status: 'missing' };
    return { status: 'error', error: (e as Error).message };
  }
}
