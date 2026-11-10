<template>
  <span class="crest" :style="{ background: color, width: `${size}px`, height: `${size}px`, fontSize: `${size * fontScale}px` }" aria-hidden="true">
    {{ initials }}
  </span>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import type { Series } from '@dm/shared';
import { seriesColor } from '../lib/grid.ts';

/** Distintivo de una categoría: su color con la sigla (en lugar del logo oficial). */
export default defineComponent({
  name: 'SeriesCrest',
  props: {
    series: { type: Object as PropType<Pick<Series, 'id' | 'color' | 'shortName' | 'name'>>, required: true },
    size: { type: Number, default: 28 },
  },
  computed: {
    color(): string {
      return seriesColor(this.series);
    },
    initials(): string {
      const short = (this.series.shortName || this.series.name).trim();
      if (short.length <= 4 || (!/\s/.test(short) && short.length <= 6)) return short;
      const words = short.split(/[\s-]+/).filter((w) => /[A-Za-z0-9]/.test(w));
      return words.map((w) => (/^\d/.test(w) ? w : w[0])).join('').slice(0, 4).toUpperCase();
    },
    fontScale(): number {
      const n = this.initials.length;
      return n <= 2 ? 0.42 : n === 3 ? 0.34 : n === 4 ? 0.27 : n === 5 ? 0.23 : 0.2;
    },
  },
});
</script>

<style>
.crest {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  border-radius: 28%;
  color: #fff;
  font-weight: 800;
  letter-spacing: -0.02em;
  text-shadow: 0 1px 1px rgba(0, 0, 0, 0.35);
}
</style>
