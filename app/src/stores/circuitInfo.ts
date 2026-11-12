import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import { circuitId, type CircuitInfo, type CircuitsFile } from '@dm/shared';
import { DataNotFoundError, fetchData } from '../lib/data.ts';

/**
 * Fichas de los circuitos (data/circuits.json): coordenadas, datos del trazado, foto y plano. Se descargan al
 * abrir una pantalla que las usa (página del circuito, clima de un evento). Si el archivo todavía no existe
 * (status 'missing') la app sigue funcionando sin fichas.
 */
export const useCircuitInfoStore = defineStore('circuitInfo', {
  state: () => ({
    file: null as CircuitsFile | null,
    status: 'idle' as 'idle' | 'loading' | 'ok' | 'missing' | 'error',
    error: null as string | null,
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
      if (!this.file) this.status = 'loading';
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
  },
});
