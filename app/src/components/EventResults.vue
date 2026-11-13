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
        <!-- Podio de un vistazo (solo en carreras): P2 · P1 · P3, con equipo y tiempo o diferencia -->
        <section v-if="current && showPodium" class="card podium-card" aria-label="Podio">
          <h3 class="podium-title">Podio · {{ sessionName(current.sessionId) }}</h3>
          <ol class="podium-steps">
            <li v-for="row in podiumSteps" :key="row.pos ?? row.driver" class="podium-step" :class="`p${row.pos}`">
              <span class="podium-pos">{{ row.pos }}</span>
              <RouterLink v-if="isSingle(row.driver)" :to="`/piloto/${idOf(row.driver)}`" class="podium-name">
                {{ displayName(row.driver) }}
              </RouterLink>
              <span v-else class="podium-name">{{ displayName(row.driver) }}</span>
              <span v-if="row.team || row.vehicle" class="podium-team small dim">{{ row.team ?? row.vehicle }}</span>
              <span v-if="row.time || row.gap" class="podium-time small">{{ row.time ?? row.gap }}</span>
            </li>
          </ol>
          <p v-if="fastest" class="podium-fastest small">
            <AppIcon name="clock" :size="14" />
            <span>Vuelta rápida: <strong>{{ displayName(fastest.row.driver) }}</strong> · {{ fastest.time }}</span>
          </p>
        </section>
        <div v-if="current" :id="`res-${current.sessionId}`" class="card flush">
          <h3 class="card-title">{{ sessionName(current.sessionId) }}</h3>
          <!-- Condiciones que midió la organización durante la sesión (no es el pronóstico) -->
          <p v-if="conditionsLine && current.conditions" class="session-conditions small">
            <svg
              class="session-conditions-icon"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z" />
              <path d="M12 9v7" />
            </svg>
            <span class="session-conditions-text">
              <!-- Cada dato no se parte y el "·" queda al final del renglón, nunca al principio del siguiente -->
              <span class="session-conditions-values">
                <template v-for="(part, i) in conditionsItems" :key="i">
                  <span class="session-conditions-part">{{ part }}<template v-if="i < conditionsItems.length - 1"> ·</template></span>{{ ' ' }}
                </template>
              </span>
              <span class="session-conditions-label dim">
                {{ conditionsLabel }}
                <template v-if="current.conditions.source">
                  ·
                  <a
                    :href="current.conditions.source.url"
                    :title="current.conditions.source.title"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="tap-inline"
                  >
                    {{ conditionsSourceName }}
                  </a>
                </template>
              </span>
            </span>
          </p>
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
import {
  driverDisplayName,
  driverId,
  isSingleDriverName,
  type EventResultsFile,
  type MotorEvent,
  type ResultRow,
  type SessionResult,
} from '@dm/shared';
import AppIcon from './AppIcon.vue';
import SourceLink from './SourceLink.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { useResultsStore, type Loaded } from '../stores/results.ts';
import { tabStrip } from '../lib/tabStrip.ts';
import { conditionsLabel, conditionsParts, conditionsSourceName, conditionsText } from '../lib/conditions.ts';
import { fastestLap, isRaceType, mainResultSession, orderResultSessions, podium } from '../lib/podium.ts';

/** Resultados de las sesiones de un evento, una tabla por vez (chips por sesión). */
export default defineComponent({
  name: 'EventResults',
  components: { AppIcon, SourceLink },
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
    /** Carreras primero (carrera, sprint, clasificatorias); después el resto, por hora. */
    sessions(): SessionResult[] {
      return orderResultSessions(this.state?.data?.sessions ?? [], this.eventSessions);
    },
    /** Por defecto, la carrera principal (no la primera práctica); o la sesión pedida en la ruta. */
    current(): SessionResult | undefined {
      const pick = this.selected || this.focusSession;
      return (
        this.sessions.find((s) => s.sessionId === pick) ??
        mainResultSession(this.sessions, this.eventSessions) ??
        this.sessions[0]
      );
    },
    currentIsRace(): boolean {
      const id = this.current?.sessionId;
      return isRaceType(this.eventSessions.find((s) => s.id === id)?.type);
    },
    showPodium(): boolean {
      return this.currentIsRace && podium(this.current?.rows ?? []).length > 0;
    },
    /** Orden visual del podio: 2.º, 1.º, 3.º (el ganador en el centro y más alto). */
    podiumSteps(): ResultRow[] {
      const [p1, p2, p3] = podium(this.current?.rows ?? []);
      return [p2, p1, p3].filter((r): r is ResultRow => !!r);
    },
    fastest(): { row: ResultRow; time: string } | null {
      return this.currentIsRace ? fastestLap(this.current?.rows ?? []) : null;
    },
    /** "Aire 24° · Pista 38° · Humedad 45 % · Pista seca": solo con lo que la fuente midió; vacío si no hay nada. */
    conditionsLine(): string {
      return conditionsText(this.current?.conditions);
    },
    conditionsItems(): string[] {
      return conditionsParts(this.current?.conditions);
    },
    conditionsLabel(): string {
      return this.current?.conditions ? conditionsLabel(this.current.conditions) : '';
    },
    conditionsSourceName(): string {
      return this.current?.conditions ? conditionsSourceName(this.current.conditions) : '';
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
    displayName: driverDisplayName,
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

/* Línea de condiciones medidas, bajo el título de la sesión */
.session-conditions {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  margin: 0;
  padding: 0 0.85rem 0.6rem;
  line-height: 1.35;
}

.session-conditions-icon {
  flex: none;
  margin-top: 0.12em;
  color: var(--text-dim);
}

.session-conditions-text {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.session-conditions-values {
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.session-conditions-part {
  white-space: nowrap;
}

.podium-card {
  padding: 0.75rem 0.6rem 0.65rem;
}

.podium-title {
  margin: 0 0.25rem 0.6rem;
  font-size: 0.95rem;
  font-weight: 800;
}

.podium-steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: end;
  gap: 0.4rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.podium-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.15rem;
  min-width: 0;
  padding: 0.55rem 0.35rem 0.6rem;
  border-radius: 12px;
  background: var(--bg-elev-2);
  text-align: center;
}

.podium-step.p1 {
  padding-top: 0.95rem;
  background: color-mix(in srgb, var(--accent) 16%, var(--bg-elev-2));
}

.podium-pos {
  font-size: 1.15rem;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
}

.podium-step.p1 .podium-pos {
  font-size: 1.45rem;
  color: var(--accent);
}

a.podium-name,
.podium-name {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 2.4em;
  max-width: 100%;
  color: var(--text);
  font-weight: 700;
  font-size: 0.9rem;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.podium-team {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.podium-time {
  font-variant-numeric: tabular-nums;
}

.podium-fastest {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin: 0.6rem 0.25rem 0;
  color: var(--text-dim);
}

.podium-fastest strong {
  color: var(--text);
}
</style>
