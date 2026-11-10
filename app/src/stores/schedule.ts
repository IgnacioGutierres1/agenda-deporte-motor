import { defineStore } from 'pinia';
import { DateTime } from 'luxon';
import {
  PERIOD_LABELS,
  resolvePeriod,
  type Period,
  type PeriodPreset,
  type ScheduleFile,
  type Series,
  type StatusFile,
} from '@dm/shared';
import { DataNotFoundError, fetchData } from '../lib/data.ts';
import {
  buildAuditRows,
  groupByDay,
  pendingEventsInPeriod,
  sessionsInPeriod,
  type AuditRow,
  type GridDay,
  type GridItem,
  type PendingItem,
} from '../lib/grid.ts';
import { useSettingsStore } from './settings.ts';

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const PERIOD_PRESETS: PeriodPreset[] = [
  'este-finde',
  'proximos-2-findes',
  'proximos-4-findes',
  'proximo-mes',
  'personalizado',
];

/** Datos publicados por el pipeline + período elegido + derivados para la grilla, exportación y auditoría. */
export const useScheduleStore = defineStore('schedule', {
  state: () => ({
    schedule: null as ScheduleFile | null,
    status: null as StatusFile | null,
    loading: false,
    /** Mensaje de error de la última carga (si no hay datos para mostrar). */
    error: null as string | null,
    /** true si todavía no hay datos publicados (404). */
    missing: false,
    /** Momento de la última descarga exitosa en este dispositivo. */
    fetchedAt: null as string | null,
    /** "Ahora" (ISO UTC); se actualiza con un temporizador para estados en vivo. */
    now: nowIso(),

    preset: 'este-finde' as PeriodPreset,
    includeThursday: false,
    /** Fechas del período personalizado (YYYY-MM-DD, inclusivas). */
    customFrom: '',
    customTo: '',
    /** Sesiones que el usuario sacó de la exportación. */
    excludedIds: [] as string[],
  }),

  getters: {
    generatedAt: (state): string | null => state.schedule?.generatedAt ?? null,

    seriesById: (state): Map<string, Series> => new Map((state.schedule?.series ?? []).map((s) => [s.id, s])),

    periodLabel(state): string {
      return PERIOD_LABELS[state.preset];
    },

    /** Error del período personalizado (fechas incompletas o invertidas). */
    periodError(state): string | null {
      if (state.preset !== 'personalizado') return null;
      if (!state.customFrom || !state.customTo) return 'Elegí las fechas desde y hasta.';
      try {
        resolvePeriod('personalizado', state.now, this.periodOptions);
        return null;
      } catch (e) {
        return (e as Error).message;
      }
    },

    periodOptions(state) {
      const settings = useSettingsStore();
      return {
        zone: settings.timeZone,
        includeThursday: state.includeThursday,
        from: state.customFrom,
        to: state.customTo,
      };
    },

    period(state): Period {
      try {
        return resolvePeriod(state.preset, state.now, this.periodOptions);
      } catch {
        return resolvePeriod('este-finde', state.now, this.periodOptions);
      }
    },

    /** Visible en la grilla: habilitada en el repo y no ocultada en este dispositivo. */
    visibleSeriesPredicate(): (s: Series) => boolean {
      const hidden = new Set(useSettingsStore().hiddenSeries);
      return (s: Series) => s.enabled && !hidden.has(s.id);
    },

    items(state): GridItem[] {
      return sessionsInPeriod(state.schedule, this.period, this.visibleSeriesPredicate, state.now);
    },

    days(): GridDay[] {
      return groupByDay(this.items, useSettingsStore().timeZone);
    },

    pendingEvents(state): PendingItem[] {
      return pendingEventsInPeriod(state.schedule, this.period, this.visibleSeriesPredicate);
    },

    /** Sesiones del período que se exportan (sin las excluidas). */
    exportItems(state): GridItem[] {
      const excluded = new Set(state.excludedIds);
      return this.items.filter((i) => !excluded.has(i.session.id));
    },

    auditRows(state): AuditRow[] {
      return buildAuditRows(state.schedule, state.status, this.period);
    },

    hasData: (state): boolean => state.schedule !== null,
  },

  actions: {
    async load(opts: { force?: boolean } = {}) {
      this.loading = true;
      try {
        const [schedule, status] = await Promise.all([
          fetchData<ScheduleFile>('schedule.json', opts),
          fetchData<StatusFile>('status.json', opts).catch(() => null),
        ]);
        this.schedule = schedule;
        this.status = status;
        this.error = null;
        this.missing = false;
        this.fetchedAt = nowIso();
        this.pruneExcluded();
      } catch (e) {
        if (e instanceof DataNotFoundError) {
          this.missing = true;
          this.error = null;
        } else {
          this.error = (e as Error).message;
        }
      } finally {
        this.loading = false;
        this.now = nowIso();
      }
    },

    tick() {
      this.now = nowIso();
    },

    setPreset(preset: PeriodPreset) {
      if (preset === 'personalizado' && (!this.customFrom || !this.customTo)) {
        const zone = useSettingsStore().timeZone;
        const today = DateTime.fromISO(this.now, { zone: 'utc' }).setZone(zone);
        this.customFrom = today.toISODate()!;
        this.customTo = today.plus({ days: 7 }).toISODate()!;
      }
      this.preset = preset;
    },

    setExcluded(sessionId: string, excluded: boolean) {
      const set = new Set(this.excludedIds);
      if (excluded) set.add(sessionId);
      else set.delete(sessionId);
      this.excludedIds = [...set];
    },

    setAllExcluded(excluded: boolean) {
      this.excludedIds = excluded ? this.items.map((i) => i.session.id) : [];
    },

    /** Olvida exclusiones de sesiones que ya no existen. */
    pruneExcluded() {
      const ids = new Set((this.schedule?.sessions ?? []).map((s) => s.id));
      this.excludedIds = this.excludedIds.filter((id) => ids.has(id));
    },
  },
});
