<template>
  <div class="page grid-view">
    <PeriodPicker />

    <div class="row grid-toolbar">
      <button type="button" class="btn btn-small" @click="filterOpen = true">
        <AppIcon name="filter" :size="18" />
        Categorías<span v-if="hiddenCount" class="dim">&nbsp;({{ hiddenCount }} ocultas)</span>
      </button>
      <span class="grow" />
      <RouterLink to="/exportar" class="btn btn-small">
        <AppIcon name="share" :size="18" />
        Exportar
      </RouterLink>
    </div>

    <DataState />

    <template v-if="hasData">
      <section v-if="pendingEvents.length" class="pending">
        <h2 class="section-title">Horarios a confirmar</h2>
        <ul class="pending-list">
          <li v-for="p in pendingEvents" :key="p.event.id" class="pending-item">
            <span class="chip" :style="{ background: color(p.series) }" />
            <div class="grow">
              <div>
                <strong>{{ p.series.shortName || p.series.name }}</strong> · {{ p.event.name }}
                <span v-if="p.series.origin === 'discovered'" class="badge badge-info">Descubierta</span>
              </div>
              <div class="small dim">
                {{ dateRange(p.event.dateStart, p.event.dateEnd) }} · {{ p.event.circuit }}, {{ p.event.country }} ·
                <a :href="p.event.source.url" target="_blank" rel="noopener noreferrer">fuente</a>
              </div>
            </div>
          </li>
        </ul>
      </section>

      <p v-if="!days.length" class="empty card">
        No hay sesiones con horario en este período{{ hiddenCount ? ' para las categorías visibles' : '' }}.
        <span class="small dim">Probá con un período más largo.</span>
      </p>

      <section v-for="day in days" :key="day.date" class="day">
        <h2 class="day-header">{{ capitalize(day.label) }}</h2>
        <ul class="day-list">
          <SessionRow
            v-for="item in day.items"
            :key="item.session.id"
            :item="item"
            :time-zone="timeZone"
            @select="selectedId = $event.session.id"
          />
        </ul>
      </section>

      <p v-if="days.length" class="small dim tz-note">
        Horarios en {{ zoneName }}. Tocá una sesión para ver la fuente oficial.
      </p>
    </template>

    <BottomSheet :open="filterOpen" title="Categorías" @close="filterOpen = false">
      <CategoryFilter />
    </BottomSheet>

    <SessionSheet :item="selected" :time-zone="timeZone" :now="now" @close="selectedId = null" />
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapState } from 'pinia';
import type { Series } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import BottomSheet from '../components/BottomSheet.vue';
import CategoryFilter from '../components/CategoryFilter.vue';
import DataState from '../components/DataState.vue';
import PeriodPicker from '../components/PeriodPicker.vue';
import SessionRow from '../components/SessionRow.vue';
import SessionSheet from '../components/SessionSheet.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { seriesColor, type GridItem } from '../lib/grid.ts';
import { ZONE_OPTIONS, formatDateRange, zoneLabel } from '../lib/format.ts';

export default defineComponent({
  name: 'GridView',
  components: { AppIcon, BottomSheet, CategoryFilter, DataState, PeriodPicker, SessionRow, SessionSheet },
  data() {
    return {
      filterOpen: false,
      selectedId: null as string | null,
    };
  },
  computed: {
    ...mapState(useScheduleStore, ['days', 'items', 'pendingEvents', 'hasData', 'now', 'schedule']),
    ...mapState(useSettingsStore, ['timeZone', 'hiddenSeries']),
    selected(): GridItem | null {
      return this.items.find((i) => i.session.id === this.selectedId) ?? null;
    },
    hiddenCount(): number {
      const enabled = new Set((this.schedule?.series ?? []).filter((s) => s.enabled).map((s) => s.id));
      return this.hiddenSeries.filter((id) => enabled.has(id)).length;
    },
    zoneName(): string {
      return ZONE_OPTIONS.find((z) => z.value === this.timeZone)?.label ?? zoneLabel(this.timeZone);
    },
  },
  methods: {
    color(s: Series): string {
      return seriesColor(s);
    },
    dateRange: formatDateRange,
    capitalize(s: string): string {
      return s.charAt(0).toUpperCase() + s.slice(1);
    },
  },
});
</script>

<style>
.grid-toolbar {
  margin: 0.4rem 0 0.2rem;
}

.pending-list,
.day-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.pending-item {
  display: flex;
  gap: 0.6rem;
  align-items: flex-start;
  padding: 0.55rem 0;
  border-bottom: 1px solid var(--border);
}

.pending-item .chip {
  margin-top: 0.4rem;
}

.day-header {
  position: sticky;
  top: calc(var(--header-h) + var(--safe-top));
  z-index: 5;
  margin: 1rem -1rem 0;
  padding: 0.45rem 1rem;
  font-size: 0.95rem;
  background: var(--bg-elev-2);
  border-bottom: 1px solid var(--border);
}

.empty {
  text-align: center;
}

.tz-note {
  margin-top: 1rem;
  text-align: center;
}
</style>
