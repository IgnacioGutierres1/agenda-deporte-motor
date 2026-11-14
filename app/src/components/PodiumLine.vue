<template>
  <span v-if="line" class="podium-line block small" :title="title">{{ line }}</span>
  <span v-else-if="waiting" class="podium-line block small dim" aria-hidden="true">&nbsp;</span>
  <span v-else class="podium-line-anchor" aria-hidden="true" />
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import type { EventResultsFile, SessionResult } from '@dm/shared';
import { useResultsStore, type Loaded } from '../stores/results.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { mainResultSession, podiumLine } from '../lib/podium.ts';
import { hasClasses } from '../lib/classes.ts';

/**
 * Podio en una línea ("1. Norris · 2. Verstappen · 3. Hadjar") de la sesión principal de un evento, para las
 * listas de eventos. Los resultados se descargan recién cuando la fila se ve en pantalla.
 */
export default defineComponent({
  name: 'PodiumLine',
  props: {
    seriesId: { type: String, required: true },
    eventId: { type: String, required: true },
  },
  data() {
    return { visible: false, observer: null as IntersectionObserver | null };
  },
  computed: {
    ...mapState(useResultsStore, { resultsMap: 'results' }),
    ...mapState(useScheduleStore, ['schedule']),
    state(): Loaded<EventResultsFile> | undefined {
      return this.resultsMap[`${this.seriesId}/${this.eventId}`];
    },
    /** Mientras carga se reserva el renglón, para que la lista no salte. */
    waiting(): boolean {
      return this.visible && (!this.state || this.state.status === 'loading');
    },
    eventSessions() {
      return (this.schedule?.sessions ?? []).filter((s) => s.eventId === this.eventId);
    },
    main(): SessionResult | undefined {
      return this.state?.data ? mainResultSession(this.state.data.sessions, this.eventSessions) : undefined;
    },
    line(): string {
      return this.main ? podiumLine(this.main.rows) : '';
    },
    title(): string {
      const name = this.eventSessions.find((s) => s.id === this.main?.sessionId)?.name;
      const what = this.main && hasClasses(this.main.rows) ? 'Ganadores por clase' : 'Podio';
      return name ? `${what} · ${name}` : what;
    },
  },
  watch: {
    eventId() {
      if (this.visible) void this.loadResults(this.seriesId, this.eventId);
    },
  },
  mounted() {
    if (typeof IntersectionObserver === 'undefined') {
      this.show();
      return;
    }
    this.observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) this.show();
      },
      { rootMargin: '200px 0px' },
    );
    this.observer.observe(this.$el as Element);
  },
  beforeUnmount() {
    this.observer?.disconnect();
  },
  methods: {
    ...mapActions(useResultsStore, ['loadResults']),
    show() {
      this.observer?.disconnect();
      this.observer = null;
      this.visible = true;
      void this.loadResults(this.seriesId, this.eventId);
    },
  },
});
</script>

<style>
.podium-line {
  margin-top: 0.15rem;
  color: var(--text);
  font-weight: 600;
  /* Si no entra en un renglón, sigue en el siguiente (no se corta el 3.º). */
  overflow-wrap: anywhere;
}

.podium-line-anchor {
  display: block;
  height: 1px;
}
</style>
