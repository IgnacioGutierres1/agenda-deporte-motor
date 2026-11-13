import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import type { EventStagesFile } from '@dm/shared';
import { DataLoadError, DataNotFoundError, fetchData } from '../lib/data.ts';
import type { Loaded } from './results.ts';

/** Clave de un itinerario en el store: "{seriesId}/{eventId}" (igual que la ruta del archivo). */
export function stagesKey(seriesId: string, eventId: string): string {
  return `${seriesId}/${eventId}`;
}

/**
 * Itinerarios de rally y rally raid (data/stages/{seriesId}/{eventId}.json): tramos del WRC, etapas del Dakar.
 * Se descargan recién cuando una pantalla los necesita (pestaña Tramos/Etapas, Agenda del día, En vivo) y quedan
 * en memoria por evento. Si el archivo todavía no existe queda como 'missing' y la app sigue como antes.
 */
export const useStagesStore = defineStore('stages', {
  state: () => ({
    files: {} as Record<string, Loaded<EventStagesFile>>,
  }),
  actions: {
    async load(seriesId: string, eventId: string, force = false) {
      const key = stagesKey(seriesId, eventId);
      const current = this.files[key];
      // Ya pedido (cargando, cargado o inexistente): no se repite. Un error de red sí se reintenta.
      if (!force && current && current.status !== 'error') return;
      if (!current?.data) this.files[key] = { status: 'loading' };
      const fresh = await fetchStages(key, force);
      // Si falla una actualización, se conserva el itinerario que ya había.
      if (fresh.status === 'ok' || !this.files[key]?.data) this.files[key] = fresh;
    },
    /** Vuelve a pedir (sin caché) los itinerarios ya abiertos (botón Actualizar). */
    async reloadLoaded() {
      await Promise.all(
        Object.keys(this.files).map((key) => {
          const [seriesId, eventId] = key.split('/') as [string, string];
          return this.load(seriesId, eventId, true);
        }),
      );
    },
  },
});

async function fetchStages(key: string, force: boolean): Promise<Loaded<EventStagesFile>> {
  const path = `stages/${key}.json`;
  try {
    const data = await fetchData<EventStagesFile>(path, { force });
    // Lo mínimo para que la pantalla no falle con un archivo a medio escribir o de otro formato.
    if (!data || !Array.isArray(data.stages)) throw new DataLoadError(path, `El archivo ${path} no tiene el formato esperado.`);
    return { status: 'ok', data: markRaw(data) };
  } catch (e) {
    if (e instanceof DataNotFoundError) return { status: 'missing' };
    return { status: 'error', error: (e as Error).message };
  }
}
