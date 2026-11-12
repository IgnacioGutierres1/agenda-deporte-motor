<template>
  <div class="source-link small">
    <span class="dim">Fuente: </span>
    <a :href="source.url" target="_blank" rel="noopener noreferrer" class="tap-inline">{{ source.title || host }}</a>
    <span class="dim" :title="fullMethod"> · {{ methodLabel }} · leído {{ fetchedText }}</span>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapState } from 'pinia';
import type { Source } from '@dm/shared';
import { METHOD_LABELS, hostOf, shortMethodLabel } from '../lib/sources.ts';
import { formatDateTime } from '../lib/format.ts';
import { useSettingsStore } from '../stores/settings.ts';

/** Línea compacta con el link a la fuente oficial (para tablas de resultados y campeonatos). */
export default defineComponent({
  name: 'SourceLink',
  props: {
    source: { type: Object as PropType<Source>, required: true },
  },
  computed: {
    ...mapState(useSettingsStore, ['timeZone']),
    host(): string {
      return hostOf(this.source.url);
    },
    methodLabel(): string {
      return shortMethodLabel(this.source);
    },
    fetchedText(): string {
      return formatDateTime(this.source.fetchedAt, this.timeZone);
    },
    fullMethod(): string {
      return METHOD_LABELS[this.source.method];
    },
  },
});
</script>

<style>
.source-link {
  margin: 0.4rem 0 0.2rem;
  overflow-wrap: anywhere;
}
</style>
