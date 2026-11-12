/**
 * "Actualizar": vuelve a pedir todos los datos que la app tiene abiertos (sin caché) y busca una
 * versión nueva de la app. Lo usan el menú y Ajustes.
 */
import { useDriversStore } from '../stores/drivers.ts';
import { useNewsStore } from '../stores/news.ts';
import { useResultsStore } from '../stores/results.ts';
import { useRostersStore } from '../stores/rosters.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { useTeamsStore } from '../stores/teams.ts';
import { checkForAppUpdate, type UpdateCheck } from './appUpdate.ts';

export interface RefreshResult {
  app: UpdateCheck;
  /** Mensaje de error si no se pudo actualizar la agenda. */
  error: string | null;
}

export async function refreshEverything(): Promise<RefreshResult> {
  const schedule = useScheduleStore();
  const news = useNewsStore();
  const drivers = useDriversStore();
  const results = useResultsStore();
  const rosters = useRostersStore();
  const teams = useTeamsStore();
  const [app] = await Promise.all([
    checkForAppUpdate(true),
    schedule.load({ force: true }),
    results.reloadLoaded(),
    rosters.reloadLoaded(),
    // Solo lo que ya se abrió (si nunca se abrió, se descarga al entrar).
    news.status !== 'idle' ? news.load(true) : Promise.resolve(),
    drivers.status !== 'idle' ? drivers.load(true) : Promise.resolve(),
    // Fichas de pilotos ya abiertas (data/drivers/*.json).
    drivers.reloadDetails(),
    teams.status !== 'idle' ? teams.load(true) : Promise.resolve(),
  ]);
  return { app, error: schedule.error };
}
