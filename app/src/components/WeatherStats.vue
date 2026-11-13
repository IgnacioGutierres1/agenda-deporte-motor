<template>
  <dl class="wx-stats">
    <div v-for="s in stats" :key="s.label" :data-test="s.test">
      <dt>{{ s.label }}</dt>
      <dd>{{ s.value }} <span v-if="s.extra" class="small dim wx-stat-extra">{{ s.extra }}</span></dd>
    </div>
  </dl>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import type { WeatherStat } from '../lib/weather.ts';

/** Datos del clima en celdas (aire, sensación, lluvia, viento, humedad, pista estimada). */
export default defineComponent({
  name: 'WeatherStats',
  props: {
    stats: { type: Array as PropType<WeatherStat[]>, required: true },
  },
});
</script>

<style>
/* De a dos en el celular; en una fila si hay lugar. */
.wx-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
  gap: 0.4rem;
  margin: 0;
}

.wx-stats > div {
  padding: 0.45rem 0.6rem;
  border-radius: 10px;
  background: var(--bg-elev-2);
}

.wx-stats dt {
  color: var(--text-dim);
  font-size: 0.78rem;
}

.wx-stats dd {
  margin: 0;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.wx-stat-extra {
  font-weight: 400;
  white-space: nowrap;
}
</style>
