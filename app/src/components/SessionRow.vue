<template>
  <li class="session-row" :class="{ live: item.live, finished: item.finished, changed: !!item.session.changedAt }">
    <button type="button" class="session-main" @click="$emit('select', item)">
      <div class="session-time">
        <span class="t-start">{{ start }}</span>
        <span class="t-end">{{ end }}</span>
        <span v-if="item.session.endEstimated" class="t-approx">fin aprox.</span>
      </div>
      <span class="session-bar" :style="{ background: color }" />
      <div class="session-info grow">
        <div class="session-title">
          <span class="series-name">{{ item.series.shortName || item.series.name }}</span>
          <span class="session-name">{{ item.session.name }}</span>
        </div>
        <div class="session-meta small dim">
          {{ circuitText }}
        </div>
        <div class="session-meta small">
          <span class="dim">TV:</span> {{ broadcast }}
          <span v-if="item.session.broadcastIsDefault && item.session.broadcast.length" class="dim">(habitual)</span>
        </div>
        <div v-if="hasBadges" class="session-badges">
          <span v-if="item.live" class="badge badge-live">En vivo</span>
          <span v-if="item.series.origin === 'discovered'" class="badge badge-info">Descubierta</span>
          <span v-if="item.session.source.kind === 'image'" class="badge badge-dim">Leído de imagen</span>
          <span v-else-if="item.session.source.method === 'ia'" class="badge badge-dim">IA</span>
          <span v-if="previousStart" class="badge badge-warn" :title="`Antes: ${previousStart}`">
            Cambió · antes {{ previousStart }}
          </span>
        </div>
      </div>
    </button>
    <RouterLink v-if="item.finished && item.session.hasResults" :to="resultsLink" class="results-link small">
      Ver resultado
    </RouterLink>
  </li>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { formatTime, localDate } from '@dm/shared';
import type { GridItem } from '../lib/grid.ts';
import { seriesColor } from '../lib/grid.ts';
import { formatDateTime } from '../lib/format.ts';

export default defineComponent({
  name: 'SessionRow',
  props: {
    item: { type: Object as PropType<GridItem>, required: true },
    timeZone: { type: String, required: true },
  },
  emits: ['select'],
  computed: {
    start(): string {
      return formatTime(this.item.session.startUtc, this.timeZone);
    },
    end(): string {
      return formatTime(this.item.session.endUtc, this.timeZone);
    },
    color(): string {
      return seriesColor(this.item.series);
    },
    circuitText(): string {
      const e = this.item.event;
      return e ? [e.circuit, e.country].filter(Boolean).join(', ') : '';
    },
    broadcast(): string {
      return this.item.session.broadcast.length ? this.item.session.broadcast.join(', ') : 'A confirmar';
    },
    previousStart(): string | null {
      const prev = this.item.session.previousStartUtc;
      if (!this.item.session.changedAt || !prev) return null;
      // Si cambió de día, se muestra también la fecha.
      const sameDay = localDate(prev, this.timeZone) === localDate(this.item.session.startUtc, this.timeZone);
      return sameDay ? formatTime(prev, this.timeZone) : formatDateTime(prev, this.timeZone);
    },
    hasBadges(): boolean {
      return (
        this.item.live ||
        this.item.series.origin === 'discovered' ||
        this.item.session.source.method === 'ia' ||
        !!this.previousStart
      );
    },
    resultsLink() {
      return {
        name: 'campeonatos',
        params: { seriesId: this.item.series.id },
        query: { tab: 'resultados', event: this.item.session.eventId, session: this.item.session.id },
      };
    },
  },
});
</script>

<style>
.session-row {
  list-style: none;
  border-bottom: 1px solid var(--border);
}

.session-main {
  display: flex;
  align-items: stretch;
  gap: 0.7rem;
  width: 100%;
  text-align: left;
  background: transparent;
  border: none;
  padding: 0.7rem 0;
  min-height: var(--tap);
}

.session-time {
  flex: none;
  width: 3.4rem;
  display: flex;
  flex-direction: column;
  font-variant-numeric: tabular-nums;
}

.t-start {
  font-weight: 800;
  font-size: 1.05rem;
}

.t-end {
  font-size: 0.85rem;
  color: var(--text-dim);
}

.t-approx {
  font-size: 0.65rem;
  color: var(--text-dim);
  line-height: 1.1;
}

.session-bar {
  flex: none;
  width: 4px;
  border-radius: 2px;
}

.session-title {
  display: flex;
  flex-wrap: wrap;
  gap: 0 0.45rem;
  align-items: baseline;
}

.series-name {
  font-weight: 800;
}

.session-name {
  font-weight: 500;
}

.session-meta {
  margin-top: 0.1rem;
}

.session-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.35rem;
}

.session-row.finished .session-main {
  opacity: 0.6;
}

.session-row.changed {
  background: var(--changed-bg);
  margin: 0 -0.5rem;
  padding: 0 0.5rem;
  border-radius: 8px;
}

.session-row.live .t-start {
  color: var(--live);
}

.results-link {
  display: inline-flex;
  align-items: center;
  min-height: 36px;
  margin: -0.4rem 0 0.4rem calc(3.4rem + 1.4rem + 4px);
  font-weight: 600;
}
</style>
