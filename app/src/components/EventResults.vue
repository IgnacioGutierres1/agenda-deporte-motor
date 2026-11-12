<template>
  <div class="event-results">
    <p v-if="!hasAnyResult" class="card empty dim">
      Todavía no hay resultados de este evento. Aparecen unas horas después de cada sesión.
    </p>
    <template v-else>
      <p v-if="!state || state.status === 'loading'" class="dim">Cargando resultados…</p>
      <p v-else-if="state.status === 'missing'" class="card empty dim">Sin datos todavía.</p>
      <div v-else-if="state.status === 'error'" class="notice notice-error">
        No se pudieron cargar los resultados ({{ state.error }}).
        <button type="button" class="btn btn-small" @click="load(true)">Reintentar</button>
      </div>
      <template v-else-if="state.data">
        <div v-tab-strip class="session-chips" role="tablist" aria-label="Sesión">
          <button
            v-for="sr in sessions"
            :key="sr.sessionId"
            type="button"
            role="tab"
            class="pill"
            :class="{ active: sr.sessionId === current?.sessionId }"
            :aria-selected="sr.sessionId === current?.sessionId"
            @click="selected = sr.sessionId"
          >
            {{ sessionName(sr.sessionId) }}
          </button>
        </div>
        <div v-if="current" :id="`res-${current.sessionId}`" class="card flush">
          <h3 class="card-title">{{ sessionName(current.sessionId) }}</h3>
          <table class="data results">
            <thead>
              <tr>
                <th class="num">#</th>
                <th class="name-col">Piloto</th>
                <th v-if="hasCol(current.rows, 'laps')" class="num">V</th>
                <th class="num">Tiempo</th>
                <th v-if="hasCol(current.rows, 'points')" class="num">Pts</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, i) in current.rows"
                :key="i"
                :class="{ podium: row.pos !== null && row.pos !== undefined && row.pos <= 3, linked: isSingle(row.driver) }"
                @click="openRow($event, row.driver)"
              >
                <td class="num pos">{{ row.pos ?? row.status ?? '—' }}</td>
                <td class="name-td">
                  <RouterLink v-if="isSingle(row.driver)" :to="`/piloto/${idOf(row.driver)}`" class="name-cell row-link">
                    <span v-if="row.number" class="car-number">{{ row.number }}</span>
                    <span class="grow">
                      <span class="row-name">{{ row.driver }}</span>
                      <span v-if="row.team || row.vehicle" class="small dim team">{{ row.team ?? row.vehicle }}</span>
                    </span>
                  </RouterLink>
                  <div v-else class="name-cell row-link">
                    <span v-if="row.number" class="car-number">{{ row.number }}</span>
                    <span class="grow">
                      {{ row.driver }}
                      <span v-if="row.team || row.vehicle" class="small dim team">{{ row.team ?? row.vehicle }}</span>
                    </span>
                  </div>
                </td>
                <td v-if="hasCol(current.rows, 'laps')" class="num">{{ row.laps ?? '' }}</td>
                <td class="num small">{{ row.time ?? row.gap ?? (row.pos === null ? row.status ?? '' : '') }}</td>
                <td v-if="hasCol(current.rows, 'points')" class="num">{{ row.points ?? '' }}</td>
              </tr>
            </tbody>
          </table>
          <div class="card-foot"><SourceLink :source="current.source" /></div>
        </div>
      </template>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapActions, mapState } from 'pinia';
import { driverId, isSingleDriverName, type EventResultsFile, type MotorEvent, type SessionResult } from '@dm/shared';
import SourceLink from './SourceLink.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { useResultsStore, type Loaded } from '../stores/results.ts';
import { tabStrip } from '../lib/tabStrip.ts';

/** Resultados de las sesiones de un evento, una tabla por vez (chips por sesión). */
export default defineComponent({
  name: 'EventResults',
  components: { SourceLink },
  directives: { tabStrip },
  props: {
    event: { type: Object as PropType<MotorEvent>, required: true },
    /** Sesión a mostrar primero (si tiene resultado). */
    focusSession: { type: String, default: '' },
  },
  data() {
    return { selected: '' };
  },
  computed: {
    ...mapState(useScheduleStore, ['schedule']),
    ...mapState(useResultsStore, { resultsMap: 'results' }),
    eventSessions() {
      return (this.schedule?.sessions ?? []).filter((s) => s.eventId === this.event.id);
    },
    hasAnyResult(): boolean {
      return this.eventSessions.some((s) => s.hasResults);
    },
    state(): Loaded<EventResultsFile> | undefined {
      return this.resultsMap[`${this.event.seriesId}/${this.event.id}`];
    },
    sessions(): SessionResult[] {
      const start = new Map(this.eventSessions.map((s) => [s.id, s.startUtc]));
      return [...(this.state?.data?.sessions ?? [])].sort((a, b) =>
        (start.get(a.sessionId) ?? '').localeCompare(start.get(b.sessionId) ?? ''),
      );
    },
    /** Por defecto, la última sesión con resultado (normalmente la carrera). */
    current(): SessionResult | undefined {
      const pick = this.selected || this.focusSession;
      return this.sessions.find((s) => s.sessionId === pick) ?? this.sessions[this.sessions.length - 1];
    },
  },
  watch: {
    'event.id': {
      immediate: true,
      handler() {
        this.selected = '';
        void this.load();
      },
    },
  },
  methods: {
    /** Toque en cualquier parte de la fila (posición, tiempo): lleva al piloto, como el link. */
    openRow(e: MouseEvent, driver: string) {
      if (!this.isSingle(driver) || (e.target as Element | null)?.closest?.('a')) return;
      void this.$router.push(`/piloto/${this.idOf(driver)}`);
    },
    ...mapActions(useResultsStore, ['loadResults']),
    load(force = false) {
      if (!this.hasAnyResult) return;
      return this.loadResults(this.event.seriesId, this.event.id, force);
    },
    isSingle: isSingleDriverName,
    idOf: driverId,
    sessionName(sessionId: string): string {
      return this.eventSessions.find((s) => s.id === sessionId)?.name ?? 'Sesión';
    },
    hasCol(rows: object[], key: string): boolean {
      return rows.some((r) => (r as Record<string, unknown>)[key] !== undefined && (r as Record<string, unknown>)[key] !== null);
    },
  },
});
</script>

<style>
table.data.results tr.podium td.pos {
  color: var(--accent);
  font-weight: 800;
}
</style>
