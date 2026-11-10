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

    <template v-if="target.feed">
      <p v-if="!board && !error" class="small dim live-empty">Conectando con el cronometraje oficial…</p>
      <p v-else-if="error && !board" class="small live-empty">
        <span class="warn-text">No se pudieron leer los tiempos ({{ error }}).</span>
      </p>
      <LiveBoardTable v-if="board" :board="board" :now="now" />
    </template>
    <div v-if="!board" class="card-foot">
      <a v-if="target.officialUrl" :href="target.officialUrl" target="_blank" rel="noopener noreferrer" class="btn btn-small">
        Ver tiempos en vivo oficiales <AppIcon name="external" :size="14" />
      </a>
      <span v-else class="small dim">Esta categoría no publica tiempos en vivo abiertos.</span>
    </div>
  </section>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import type { LiveBoard } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import LiveBoardTable from './LiveBoardTable.vue';
import SeriesCrest from './SeriesCrest.vue';
import { fetchBoard, liveTargetFor, type LiveTarget } from '../lib/live.ts';
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
    if (this.target.feed) {
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
      const feed = this.target.feed;
      if (!feed) return;
      try {
        const board = await fetchBoard(feed, new Date().toISOString());
        // Si la fuente muestra otra categoría o sesión (p. ej. la anterior), no se mezcla.
        this.board = board && (!board.seriesId || board.seriesId === this.item.series.id) ? board : null;
        this.error = '';
      } catch (e) {
        this.error = (e as Error).message;
      }
      // Solo se consulta con la pantalla visible (cuida el cupo de las fuentes y la batería).
      if (document.visibilityState === 'visible') this.timer = window.setTimeout(() => void this.poll(), feed.intervalMs);
    },
    onVisibility() {
      if (document.visibilityState === 'visible') void this.poll();
      else window.clearTimeout(this.timer);
    },
  },
});
</script>

<style>
.live-card {
  margin: 0 0 0.85rem;
  overflow: hidden;
}
</style>
