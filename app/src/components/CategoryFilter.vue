<template>
  <div class="category-filter">
    <p class="small dim">
      Elegí qué categorías ver en este dispositivo. Se recuerda en este teléfono; no cambia la lista compartida.
    </p>
    <div class="row wrap">
      <button type="button" class="btn btn-small" @click="showAll">Mostrar todas</button>
      <button type="button" class="btn btn-small" @click="setManyVisible(allIds, false)">Ocultar todas</button>
    </div>
    <div v-for="g in groups" :key="g.group" class="filter-group">
      <label class="check group-check">
        <input
          type="checkbox"
          :checked="groupState(g.ids) === 'all'"
          :indeterminate.prop="groupState(g.ids) === 'some'"
          @change="setManyVisible(g.ids, ($event.target as HTMLInputElement).checked)"
        />
        <strong>{{ g.label }}</strong>
      </label>
      <label v-for="item in g.items" :key="item.series.id" class="check series-check">
        <input
          type="checkbox"
          :checked="!hiddenSeries.includes(item.series.id)"
          @change="setSeriesVisible(item.series.id, ($event.target as HTMLInputElement).checked)"
        />
        <span class="chip" :style="{ background: color(item.series) }" />
        <span class="grow">{{ item.series.name }}</span>
        <span v-if="item.series.origin === 'discovered'" class="badge badge-info">Descubierta</span>
      </label>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import type { Series } from '@dm/shared';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { groupSeries, seriesColor, seriesSort } from '../lib/grid.ts';

export default defineComponent({
  name: 'CategoryFilter',
  computed: {
    ...mapState(useScheduleStore, ['schedule']),
    ...mapState(useSettingsStore, ['hiddenSeries']),
    enabledSeries(): Series[] {
      return (this.schedule?.series ?? []).filter((s) => s.enabled).sort(seriesSort);
    },
    allIds(): string[] {
      return this.enabledSeries.map((s) => s.id);
    },
    groups() {
      return groupSeries(this.enabledSeries.map((series) => ({ series }))).map((g) => ({
        ...g,
        ids: g.items.map((i) => i.series.id),
      }));
    },
  },
  methods: {
    ...mapActions(useSettingsStore, ['setSeriesVisible', 'setManyVisible', 'showAll']),
    color: seriesColor,
    groupState(ids: string[]): 'all' | 'some' | 'none' {
      const hidden = ids.filter((id) => this.hiddenSeries.includes(id)).length;
      if (hidden === 0) return 'all';
      if (hidden === ids.length) return 'none';
      return 'some';
    },
  },
});
</script>

<style>
.filter-group {
  margin-top: 0.75rem;
  border-top: 1px solid var(--border);
  padding-top: 0.25rem;
}

.series-check {
  padding-left: 1.6rem;
}
</style>
