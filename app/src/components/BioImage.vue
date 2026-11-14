<template>
  <figure v-if="!failed" class="bio-image" :class="`bio-image-${variant}`" :style="{ width: `${width}px` }">
    <span class="bio-image-frame" :style="{ height: `${height}px` }">
      <img
        :src="image.url"
        :alt="alt"
        loading="lazy"
        decoding="async"
        :width="width"
        :height="height"
        @error="onError"
      />
    </span>
    <figcaption class="bio-image-credit">
      <a :href="image.page" target="_blank" rel="noopener noreferrer" :title="`${credit} (abre la página del archivo)`">{{ credit }}</a>
    </figcaption>
  </figure>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import type { CreditedImage } from '@dm/shared';
import { imageCredit } from '../lib/bios.ts';

/**
 * Foto de un piloto o logo de un equipo o categoría, siempre con su crédito y licencia visibles y el enlace a la
 * página del archivo (Commons o el sitio oficial). Si la imagen no carga, no se muestra nada (emite `failed`).
 */
export default defineComponent({
  name: 'BioImage',
  props: {
    image: { type: Object as PropType<CreditedImage>, required: true },
    alt: { type: String, required: true },
    /** 'photo': retrato recortado (3:4); 'logo': entero sobre fondo claro. */
    variant: { type: String as PropType<'photo' | 'logo'>, default: 'photo' },
    width: { type: Number, default: 112 },
  },
  emits: ['failed'],
  data() {
    return { failed: false };
  },
  computed: {
    height(): number {
      return this.variant === 'photo' ? Math.round((this.width * 4) / 3) : Math.round(this.width * 0.75);
    },
    credit(): string {
      return imageCredit(this.image, this.variant === 'photo' ? 'Foto' : 'Logo');
    },
  },
  watch: {
    'image.url'() {
      this.failed = false;
    },
  },
  methods: {
    onError() {
      this.failed = true;
      this.$emit('failed');
    },
  },
});
</script>

<style>
.bio-image {
  flex: none;
  margin: 0;
  max-width: 100%;
}

.bio-image-frame {
  display: block;
  overflow: hidden;
  border-radius: 12px;
  background: var(--bg-elev-2);
}

.bio-image img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: 50% 20%;
}

/* Los logos van enteros y sobre fondo claro en los dos temas (muchos son oscuros sobre transparente). */
.bio-image-logo .bio-image-frame {
  padding: 0.5rem;
  background: #fff;
  border: 1px solid var(--border);
}

.bio-image-logo img {
  object-fit: contain;
  object-position: center;
}

.bio-image-credit {
  margin-top: 0.3rem;
  font-size: 0.7rem;
  line-height: 1.25;
  color: var(--text-dim);
  overflow-wrap: anywhere;
}

.bio-image-credit a {
  color: inherit;
  text-decoration: underline;
  text-decoration-color: var(--border);
}
</style>
