<template>
  <div class="bio-summary">
    <p v-for="(p, i) in shown" :key="i" class="bio-text">{{ p }}</p>
    <button v-if="long && !open" type="button" class="link-btn small" @click="open = true">Ver más</button>
    <p class="bio-source small">
      <a :href="summary.url" target="_blank" rel="noopener noreferrer" class="tap-inline">
        {{ readMore }} <AppIcon name="external" :size="12" />
      </a>
    </p>
    <p v-if="wikipedia" class="bio-license small dim">
      Texto de Wikipedia<template v-if="summary.lang === 'en'"> en inglés</template>, bajo licencia
      <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.es" target="_blank" rel="noopener noreferrer license" class="tap-inline">CC BY-SA 4.0</a>.
    </p>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import type { BioSummary } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import { isWikipedia, paragraphs, readMoreLabel } from '../lib/bios.ts';

/** Resumen del historial (Wikipedia u oficial) con el enlace "Leer más" y la atribución CC BY-SA. */
export default defineComponent({
  name: 'BioSummary',
  components: { AppIcon },
  props: {
    summary: { type: Object as PropType<BioSummary>, required: true },
  },
  data() {
    return { open: false };
  },
  computed: {
    all(): string[] {
      return paragraphs(this.summary.text);
    },
    /** Más de un párrafo largo: se muestra el primero y "Ver más". */
    long(): boolean {
      return this.all.length > 1 && this.summary.text.length > 420;
    },
    shown(): string[] {
      return this.long && !this.open ? this.all.slice(0, 1) : this.all;
    },
    readMore(): string {
      return readMoreLabel(this.summary);
    },
    wikipedia(): boolean {
      return isWikipedia(this.summary);
    },
  },
  watch: {
    'summary.url'() {
      this.open = false;
    },
  },
});
</script>

<style>
.bio-text {
  margin: 0 0 0.6rem;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

.bio-source {
  margin: 0.2rem 0 0;
}

.bio-source a {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-weight: 600;
}

.bio-license {
  margin: 0.35rem 0 0;
}
</style>
