<template>
  <div v-if="failing" class="source-problem" :class="{ 'notice notice-warn': mode === 'full', compact: mode === 'compact' }">
    <template v-if="mode === 'full'">
      <p class="source-problem-title">
        No pudimos leer el calendario oficial <span class="dim">({{ lastRead }})</span>.
      </p>
      <p class="small dim">{{ reason }} Mientras tanto, las fechas están en el sitio oficial.</p>
      <a v-if="url" :href="url" target="_blank" rel="noopener noreferrer" class="pill source-problem-link">
        Ver calendario oficial <AppIcon name="external" :size="14" />
      </a>
    </template>
    <p v-else-if="mode === 'note'" class="small warn-text source-problem-note">
      Datos de {{ savedAgo }}: no pudimos actualizar el calendario oficial.
      <a v-if="url" :href="url" target="_blank" rel="noopener noreferrer">Ver sitio oficial</a>
    </p>
    <p v-else class="small">{{ reason }}</p>
    <details v-if="status?.message" class="source-details small dim">
      <summary>Detalles</summary>
      <p>{{ status.message }}</p>
      <p>Último intento {{ ago(status.lastAttempt) }}<template v-if="status.lastSuccess"> · última lectura buena {{ ago(status.lastSuccess) }}</template>.</p>
    </details>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapState } from 'pinia';
import type { Series, SeriesStatus } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { friendlySourceError } from '../lib/sources.ts';
import { timeAgo } from '../lib/format.ts';

/**
 * Error de la fuente oficial de una categoría, en palabras: en lugar de "HTTP 403 en https://…" y
 * "Sin fechas próximas", "No pudimos leer el calendario oficial" con el detalle técnico plegado.
 *  - full: sin fechas guardadas (con link al calendario oficial).
 *  - note: hay fechas guardadas y se muestran igual, con "Datos de hace X".
 *  - compact: una línea con el motivo (Auditoría, Fuente de los datos).
 * Si no se elige, full o note según haya eventos guardados.
 */
export default defineComponent({
  name: 'SourceProblem',
  components: { AppIcon },
  props: {
    status: { type: Object as PropType<SeriesStatus | null | undefined>, default: null },
    series: { type: Object as PropType<Series | null | undefined>, default: null },
    /** Hay fechas guardadas de lecturas anteriores. */
    hasEvents: { type: Boolean, default: false },
    variant: { type: String as PropType<'' | 'full' | 'note' | 'compact'>, default: '' },
  },
  computed: {
    ...mapState(useScheduleStore, ['now']),
    failing(): boolean {
      return this.status?.state === 'error' || this.status?.state === 'stale';
    },
    mode(): 'full' | 'note' | 'compact' {
      return this.variant || (this.hasEvents ? 'note' : 'full');
    },
    reason(): string {
      return this.status?.state === 'stale' && !this.status.message
        ? 'Hace rato que no se actualiza la fuente oficial.'
        : friendlySourceError(this.status?.message);
    },
    lastRead(): string {
      return this.status?.lastSuccess ? `última lectura: ${this.ago(this.status.lastSuccess)}` : 'todavía no se pudo leer';
    },
    /** Antigüedad de los datos guardados ("hace 3 días"). */
    savedAgo(): string {
      return this.status?.lastSuccess ? this.ago(this.status.lastSuccess) : 'una lectura anterior';
    },
    url(): string {
      return this.series?.officialUrls[0] ?? this.status?.sourceUrl ?? '';
    },
  },
  methods: {
    ago(iso: string): string {
      return timeAgo(iso, this.now);
    },
  },
});
</script>

<style>
.source-problem-title {
  margin: 0 0 0.35rem;
  font-weight: 700;
}

.source-problem .small {
  margin: 0.25rem 0;
}

.source-problem-link {
  margin-top: 0.4rem;
}

.source-problem-note {
  margin: 0;
}

.source-details summary {
  cursor: pointer;
  min-height: 32px;
  display: flex;
  align-items: center;
  color: var(--text-dim);
  font-weight: 700;
}

.source-details p {
  margin: 0.2rem 0;
  overflow-wrap: anywhere;
}
</style>
