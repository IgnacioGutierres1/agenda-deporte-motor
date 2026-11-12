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
import type { LiveBoard } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import LiveBoardTable from './LiveBoardTable.vue';
import SeriesCrest from './SeriesCrest.vue';
import { liveTargetFor, type LiveTarget } from '../lib/live.ts';
import type { GridItem } from '../lib/grid.ts';

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
    target(): LiveTarget {
      return liveTargetFor(this.item.series.id);
    },
  },
  mounted() {
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

.live-card {
  margin: 0 0 0.85rem;
  overflow: hidden;
}
</style>
