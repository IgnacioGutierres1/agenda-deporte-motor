import { defineStore } from 'pinia';
import type { EventResultsFile, StandingsFile } from '@dm/shared';
import { DataNotFoundError, fetchData } from '../lib/data.ts';

export type LoadStatus = 'loading' | 'ok' | 'missing' | 'error';

export interface Loaded<T> {
  status: LoadStatus;
  data?: T;
  error?: string;
}

/** Campeonatos y resultados: se descargan solo cuando se abren y quedan en memoria. */
export const useResultsStore = defineStore('results', {
  state: () => ({
    standings: {} as Record<string, Loaded<StandingsFile>>,
    results: {} as Record<string, Loaded<EventResultsFile>>,
  }),
  actions: {
    async loadStandings(seriesId: string, force = false) {
      const current = this.standings[seriesId];
      if (!force && current && current.status !== 'error') return;
      this.standings[seriesId] = { status: 'loading' };
      this.standings[seriesId] = await load<StandingsFile>(`standings/${seriesId}.json`, force);
    },
    async loadResults(seriesId: string, eventId: string, force = false) {
      const key = `${seriesId}/${eventId}`;
      const current = this.results[key];
      if (!force && current && current.status !== 'error') return;
      this.results[key] = { status: 'loading' };
      this.results[key] = await load<EventResultsFile>(`results/${seriesId}/${eventId}.json`, force);
    },
    clear() {
      this.standings = {};
      this.results = {};
    },
  },
});

async function load<T>(path: string, force: boolean): Promise<Loaded<T>> {
  try {
    return { status: 'ok', data: await fetchData<T>(path, { force }) };
  } catch (e) {
    if (e instanceof DataNotFoundError) return { status: 'missing' };
    return { status: 'error', error: (e as Error).message };
  }
}
