<template>
  <section class="card flush live-card">
    <header class="event-card-head">
      <RouterLink :to="`/evento/${item.session.eventId}`" class="event-card-title grow">
        <SeriesCrest :series="item.series" :size="26" />
        <span class="grow">
          <span class="event-card-series">{{ item.series.shortName || item.series.name }}</span>
          <span class="event-card-event"> · {{ item.session.name }}</span>
          <span class="block small dim">{{ item.event?.name }}</span>
        </span>
        <span class="badge badge-live">En vivo</span>
      </RouterLink>
    </header>
    <RouterLink :to="`/evento/${item.session.eventId}?tab=contexto`" class="context-link">
      <AppIcon name="flag" :size="16" />
      <span class="context-link-label">Ponerme en contexto</span>
      <span class="grow small dim context-link-hint">qué se juega, a quién mirar</span>
      <AppIcon name="chevron" :size="14" class="dim" />
    </RouterLink>
    <!-- Rally: el tramo que se está corriendo ahora, con acceso al recorrido -->
    <RouterLink v-if="hasItinerary" :to="`/evento/${item.session.eventId}?tab=etapas`" class="context-link stage-live-link">
      <AppIcon name="route" :size="16" />
      <span class="context-link-label">{{ stageNow ? `En curso: ${stageNowTitle}` : 'Ver el recorrido' }}</span>
      <span class="grow small dim context-link-hint">{{ stageNowKm }}</span>
      <AppIcon name="chevron" :size="14" class="dim" />
    </RouterLink>

    <template v-if="target.load">
      <p v-if="loading && !board" class="small dim live-empty">Conectando con el cronometraje oficial…</p>
      <p v-else-if="error && !board" class="small live-empty">
        <span class="warn-text">No se pudieron leer los tiempos ({{ error }}).</span>
      </p>
      <p v-else-if="!board" class="small dim live-empty">
        {{ target.kind === 'results' ? 'Todavía no hay sesiones publicadas por el cronometrador.' : 'La fuente oficial todavía no muestra esta sesión.' }}
      </p>
      <p v-if="board && target.kind === 'results'" class="small live-empty results-note">
        Última sesión publicada por el cronometraje oficial (no es en vivo: aparece al terminar cada sesión).
      </p>
      <LiveBoardTable v-if="board" :board="board" :now="now" />
    </template>
    <div v-if="!board || target.kind === 'results'" class="card-foot">
      <a v-if="target.officialUrl" :href="target.officialUrl" target="_blank" rel="noopener noreferrer" class="btn btn-small">
        Ver tiempos en vivo oficiales <AppIcon name="external" :size="14" />
      </a>
      <span v-else class="small dim">Esta categoría no publica tiempos en vivo abiertos.</span>
      <span v-if="target.officialNote" class="block small dim">{{ target.officialNote }}</span>
    </div>
  </section>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapActions, mapState } from 'pinia';
import type { LiveBoard, RallyStage } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import LiveBoardTable from './LiveBoardTable.vue';
import SeriesCrest from './SeriesCrest.vue';
import { stagesKey, useStagesStore } from '../stores/stages.ts';
import { liveTargetFor, type LiveTarget } from '../lib/live.ts';
import type { GridItem } from '../lib/grid.ts';
import { formatKm, hasStages, liveStage, stageTitle } from '../lib/stages.ts';

/** Una sesión en curso: tabla en vivo si la fuente lo permite, si no link al cronometraje oficial. */
export default defineComponent({
  name: 'LiveSessionCard',
  components: { AppIcon, LiveBoardTable, SeriesCrest },
  props: {
    item: { type: Object as PropType<GridItem>, required: true },
    now: { type: String, required: true },
  },
  data() {
    return {
      board: null as LiveBoard | null,
      error: '',
      loading: false,
      timer: 0,
      clock: new Date().toISOString(),
    };
  },
  computed: {
    ...mapState(useStagesStore, { stageFiles: 'files' }),
    target(): LiveTarget {
      return liveTargetFor(this.item.series.id);
    },
    /** Rally o rally raid con el recorrido publicado. */
    hasItinerary(): boolean {
      return hasStages(this.item.event);
    },
    /** Tramo en curso según las horas de largada del itinerario (si ya se descargó). */
    stageNow(): RallyStage | undefined {
      const ev = this.item.event;
      const stages = ev ? this.stageFiles[stagesKey(ev.seriesId, ev.id)]?.data?.stages : undefined;
      return stages ? liveStage(stages, this.now) : undefined;
    },
    stageNowTitle(): string {
      return this.stageNow ? stageTitle(this.stageNow) : '';
    },
    stageNowKm(): string {
      const km = this.stageNow?.distanceKm;
      return km !== undefined ? formatKm(km) : this.stageNow ? '' : 'tramos y horarios';
    },
  },
  mounted() {
    const ev = this.item.event;
    if (ev && this.hasItinerary) void this.loadStages(ev.seriesId, ev.id);
    if (this.target.load) {
      void this.poll();
      document.addEventListener('visibilitychange', this.onVisibility);
    }
  },
  beforeUnmount() {
    window.clearTimeout(this.timer);
    document.removeEventListener('visibilitychange', this.onVisibility);
  },
  methods: {
    ...mapActions(useStagesStore, { loadStages: 'load' }),
    async poll() {
      window.clearTimeout(this.timer);
      const { load, intervalMs } = this.target;
      if (!load) return;
      this.loading = true;
      try {
        const board = await load(new Date());
        // Si la fuente muestra otra categoría (p. ej. otra división de NASCAR), no se mezcla.
        this.board = board && (!board.seriesId || board.seriesId === this.item.series.id) ? board : null;
        this.error = '';
      } catch (e) {
        this.error = (e as Error).message;
      } finally {
        this.loading = false;
      }
      // Solo se consulta con la pantalla visible (cuida el cupo de las fuentes y la batería).
      if (document.visibilityState === 'visible') this.timer = window.setTimeout(() => void this.poll(), intervalMs);
    },
    onVisibility() {
      if (document.visibilityState === 'visible') void this.poll();
      else window.clearTimeout(this.timer);
    },
  },
});
</script>

<style>
.results-note {
  border-bottom: 1px solid var(--border);
  color: var(--warn);
}

a.context-link {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-height: 44px;
  padding: 0.35rem 0.85rem;
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  color: var(--accent);
  font-weight: 700;
  font-size: 0.9rem;
}

.context-link-label {
  white-space: nowrap;
}

.context-link-hint {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: right;
  font-weight: 400;
}

a.context-link:hover {
  text-decoration: none;
}

/* Segundo acceso (tramo en curso de un rally): sin doble borde y con el nombre recortado si no entra. */
a.context-link + a.context-link {
  border-top: none;
}

.stage-live-link .context-link-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stage-live-link .context-link-hint {
  flex: none;
}

.live-card {
  margin: 0 0 0.85rem;
  overflow: hidden;
}
</style>
