<template>
  <span class="surface-badge" :class="`s-${surface}`" :title="title">
    <AppIcon :name="icon" :size="13" />
    <span class="sr-only">Superficie: </span>{{ text }}
  </span>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { SURFACE_LABELS, type Surface } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import { SURFACE_ICONS, SURFACE_SHORT } from '../lib/stages.ts';

/**
 * Distintivo de la superficie de un rally o de un tramo (asfalto, tierra, nieve, arena, mixto): un ícono y un
 * color por superficie, con el nombre siempre escrito (no depende solo del color).
 */
export default defineComponent({
  name: 'SurfaceBadge',
  components: { AppIcon },
  props: {
    surface: { type: String as PropType<Surface>, required: true },
    /** Nombre completo ("Arena y desierto", "Mixto (asfalto y tierra)") en lugar del corto. */
    long: { type: Boolean, default: false },
  },
  computed: {
    icon(): string {
      return SURFACE_ICONS[this.surface] ?? 'route';
    },
    text(): string {
      return (this.long ? SURFACE_LABELS[this.surface] : SURFACE_SHORT[this.surface]) ?? this.surface;
    },
    title(): string {
      return `Superficie: ${SURFACE_LABELS[this.surface] ?? this.surface}`;
    },
  },
});
</script>

<style>
/*
 * Un tono por superficie. El texto mezcla ese tono con el color del texto del tema (blanco en el oscuro, casi
 * negro en el claro), así contrasta en los dos sin definir cada color dos veces.
 */
.surface-badge {
  --surface-hue: #7d8a9c;
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.08rem 0.45rem 0.08rem 0.35rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--surface-hue) 18%, transparent);
  color: color-mix(in srgb, var(--surface-hue) 60%, var(--text));
  font-size: 0.72rem;
  font-weight: 700;
  line-height: 1.4;
  letter-spacing: 0.01em;
  white-space: nowrap;
  vertical-align: middle;
}

.surface-badge svg {
  flex: none;
}

.surface-badge.s-asfalto {
  --surface-hue: #7d8a9c;
}

.surface-badge.s-tierra {
  --surface-hue: #b5743a;
}

.surface-badge.s-nieve {
  --surface-hue: #3aa0e0;
}

.surface-badge.s-arena {
  --surface-hue: #d99a1c;
}

.surface-badge.s-mixto {
  --surface-hue: #9b6ad6;
}
</style>
