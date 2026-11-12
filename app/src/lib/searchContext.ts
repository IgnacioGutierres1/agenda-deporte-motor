/**
 * Contexto de relevancia para las búsquedas (lo que sigue el usuario y las categorías argentinas),
 * armado con los stores. Lo usan los stores de pilotos y equipos y la pantalla Buscar.
 */
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import type { SearchContext } from './search.ts';

export function searchContext(): SearchContext {
  const settings = useSettingsStore();
  const schedule = useScheduleStore().schedule;
  return {
    followedSeries: settings.followedSeriesIds,
    followedDrivers: settings.followedDrivers.map((d) => d.id),
    followedTeams: settings.followedTeams.map((t) => t.id),
    argentineSeries: (schedule?.series ?? []).filter((s) => s.group === 'argentina').map((s) => s.id),
  };
}
