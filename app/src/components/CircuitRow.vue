<template>
  <RouterLink :to="`/circuito/${circuit.id}`" class="list-row circuit-row">
    <span class="circuit-thumb" :class="{ pending }">
      <!-- El trazado se pide recién cuando la fila entra en pantalla. -->
      <CircuitFigure v-if="info" :info="info" :name="circuit.name" mini lazy :img-width="120">
        <span class="circuit-thumb-none"><AppIcon name="flag" :size="18" /></span>
      </CircuitFigure>
      <span v-else-if="!pending" class="circuit-thumb-none"><AppIcon name="flag" :size="18" /></span>
    </span>
    <span class="grow">
      {{ circuit.name }}
      <span v-if="summary" class="block small dim one-line">{{ summary }}</span>
      <span v-if="detail" class="block small dim one-line">{{ detail }}</span>
    </span>
    <AppIcon name="chevron" :size="16" class="dim" />
  </RouterLink>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import type { CircuitInfo } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import CircuitFigure from './CircuitFigure.vue';
import type { Circuit } from '../lib/circuits.ts';

/** Fila de un circuito en una lista: miniatura del trazado (o del plano, o una banderita), nombre y resumen. */
export default defineComponent({
  name: 'CircuitRow',
  components: { AppIcon, CircuitFigure },
  props: {
    circuit: { type: Object as PropType<Circuit>, required: true },
    /** Ficha del circuito, si tiene. */
    info: { type: Object as PropType<CircuitInfo | undefined>, default: undefined },
    summary: { type: String, default: '' },
    /** Segundo renglón (la próxima fecha). */
    detail: { type: String, default: '' },
    /** Todavía no se sabe si hay fichas: la miniatura queda como esqueleto. */
    pending: { type: Boolean, default: false },
  },
});
</script>

<style>
.circuit-thumb {
  display: block;
  flex: none;
  width: 58px;
  height: 44px;
  border-radius: 8px;
  overflow: hidden;
}

.circuit-thumb.pending {
  background: var(--border);
  animation: pulse 1.4s ease-in-out infinite;
}

.circuit-thumb > .circuit-figure {
  width: 100%;
  height: 100%;
}

/* Sin dibujo: una banderita. */
.circuit-thumb-none {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: var(--bg-elev-2);
  color: var(--text-dim);
}

@media (prefers-reduced-motion: reduce) {
  .circuit-thumb.pending {
    animation: none;
  }
}
</style>
