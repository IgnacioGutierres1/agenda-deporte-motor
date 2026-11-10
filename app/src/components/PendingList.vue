<template>
  <section class="card flush pending-card">
    <h3 class="card-title">Horarios a confirmar</h3>
    <ul class="pending-rows">
      <li v-for="p in items" :key="p.event.id">
        <RouterLink :to="`/evento/${p.event.id}`" class="pending-row">
          <SeriesCrest :series="p.series" :size="24" />
          <span class="grow">
            <strong>{{ p.series.shortName || p.series.name }}</strong>
            <span class="dim"> · {{ p.event.name }}</span>
            <span class="block small dim">{{ dateRange(p.event.dateStart, p.event.dateEnd) }} · {{ p.event.circuit }}</span>
          </span>
          <AppIcon name="chevron" :size="16" class="dim" />
        </RouterLink>
      </li>
    </ul>
  </section>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import AppIcon from './AppIcon.vue';
import SeriesCrest from './SeriesCrest.vue';
import { formatDateRange } from '../lib/format.ts';
import type { PendingItem } from '../lib/grid.ts';

/** Eventos con fecha pero sin cronograma publicado todavía. */
export default defineComponent({
  name: 'PendingList',
  components: { AppIcon, SeriesCrest },
  props: {
    items: { type: Array as PropType<PendingItem[]>, required: true },
  },
  methods: {
    dateRange: formatDateRange,
  },
});
</script>

<style>
.pending-card {
  margin-bottom: 0.75rem;
}

.pending-rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.pending-rows li + li {
  border-top: 1px solid var(--border);
}

.pending-row {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  min-height: 56px;
  padding: 0.5rem 0.85rem;
  color: var(--text);
}

.pending-row:hover {
  text-decoration: none;
}
</style>
