<template>
  <div class="series-row">
    <RouterLink :to="`/categoria/${series.id}`" class="list-row grow">
      <SeriesCrest :series="series" :size="30" />
      <span class="grow">
        {{ series.name }}
        <span v-if="subtitle" class="block small dim">{{ subtitle }}</span>
      </span>
    </RouterLink>
    <FollowButton :series-id="series.id" :name="series.name" compact />
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import type { Series } from '@dm/shared';
import FollowButton from './FollowButton.vue';
import SeriesCrest from './SeriesCrest.vue';

/** Fila de una categoría con link a su página y estrella para seguirla. */
export default defineComponent({
  name: 'SeriesRow',
  components: { FollowButton, SeriesCrest },
  props: {
    series: { type: Object as PropType<Series>, required: true },
    subtitle: { type: String, default: '' },
  },
});
</script>

<style>
.series-row {
  display: flex;
  align-items: center;
  padding-right: 0.25rem;
}

.series-row .list-row {
  min-width: 0;
}
</style>
