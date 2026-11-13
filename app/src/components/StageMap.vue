<template>
  <figure class="stage-map">
    <a :href="url" target="_blank" rel="noopener noreferrer" class="stage-map-link" :class="{ broken: failed }" :aria-label="`${alt}: abrir en grande`">
      <img v-if="!failed" :src="url" :alt="alt" loading="lazy" decoding="async" referrerpolicy="no-referrer" @error="failed = true" />
      <span class="stage-map-open">
        <AppIcon :name="failed ? 'external' : 'expand'" :size="15" />
        {{ failed ? 'Ver el mapa en el sitio oficial' : 'Ver en grande' }}
      </span>
    </a>
    <figcaption v-if="credit && !failed" class="small dim">Mapa: {{ credit }}</figcaption>
  </figure>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import AppIcon from './AppIcon.vue';

/**
 * Mapa oficial de un recorrido o de una etapa. La imagen se enlaza (no se copia): al tocarla se abre en grande en
 * otra pestaña, donde se puede hacer zoom. Si el sitio oficial no deja mostrarla acá, queda el link.
 */
export default defineComponent({
  name: 'StageMap',
  components: { AppIcon },
  props: {
    url: { type: String, required: true },
    alt: { type: String, default: 'Mapa del recorrido' },
    credit: { type: String, default: '' },
  },
  data() {
    return { failed: false };
  },
  watch: {
    url() {
      this.failed = false;
    },
  },
});
</script>

<style>
.stage-map {
  margin: 0.6rem 0 0;
}

a.stage-map-link {
  position: relative;
  display: block;
  overflow: hidden;
  border-radius: 10px;
  background: var(--bg-elev-2);
  color: var(--text);
}

a.stage-map-link:hover {
  text-decoration: none;
}

.stage-map-link img {
  display: block;
  width: 100%;
  max-height: 320px;
  object-fit: contain;
  /* Los mapas oficiales suelen venir con fondo claro o transparente. */
  background: #fff;
}

.stage-map-open {
  position: absolute;
  right: 0.5rem;
  bottom: 0.5rem;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  min-height: 32px;
  padding: 0 0.7rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  color: var(--text);
  font-size: 0.8rem;
  font-weight: 700;
}

/* Sin imagen: queda un botón de 44 px con el link al mapa. */
.stage-map-link.broken {
  display: flex;
  align-items: center;
  min-height: 44px;
  padding: 0 0.6rem;
}

.stage-map-link.broken .stage-map-open {
  position: static;
  padding: 0;
  background: transparent;
  color: var(--link);
}

.stage-map figcaption {
  margin-top: 0.25rem;
}
</style>
