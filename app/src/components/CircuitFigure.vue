<template>
  <component :is="mini ? 'span' : 'div'" class="circuit-figure" :class="[`is-${kind}`, { mini }]">
    <TrackOutline v-if="kind === 'track' && track" :track="track" :name="label" :mini="mini" />
    <span v-else-if="kind === 'loading' && mini" class="circuit-figure-skel" aria-busy="true" aria-label="Cargando trazado…" />
    <div v-else-if="kind === 'loading'" aria-busy="true" aria-label="Cargando trazado…">
      <span class="circuit-figure-skel" />
      <!-- Reserva el renglón del crédito: cuando llega el trazado no se mueve nada. -->
      <div class="track-credit small circuit-figure-ghost" aria-hidden="true">Trazado: © Colaboradores de OpenStreetMap · ODbL · Norte arriba</div>
    </div>
    <template v-else-if="kind === 'map' && map">
      <!-- Fondo claro en los dos temas: muchos planos son líneas negras sobre transparente. -->
      <span v-if="mini" class="circuit-map-stage">
        <img :src="mapSrc" :alt="`Plano de ${label}`" loading="lazy" decoding="async" referrerpolicy="no-referrer" @error="mapFailed = true" />
      </span>
      <figure v-else class="circuit-map">
        <div class="circuit-map-stage">
          <img
            :src="mapSrc"
            :alt="`Plano de ${label}`"
            :width="map.width || undefined"
            :height="map.height || undefined"
            loading="lazy"
            decoding="async"
            referrerpolicy="no-referrer"
            @error="mapFailed = true"
          />
        </div>
        <figcaption class="small dim">
          Plano:
          <a v-if="mapPage" :href="mapPage" target="_blank" rel="noopener noreferrer" class="tap-inline">{{ mapCredit }}</a><template v-else>{{ mapCredit }}</template>
          · Wikimedia Commons
        </figcaption>
      </figure>
    </template>
    <slot v-else />
  </component>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapActions, mapState } from 'pinia';
import type { CircuitImage, CircuitInfo, CircuitTrackFile } from '@dm/shared';
import TrackOutline from './TrackOutline.vue';
import { useCircuitInfoStore } from '../stores/circuitInfo.ts';
import type { Loaded } from '../stores/results.ts';
import { commonsThumb, httpUrl, imageCredit, trackDrawable, type CircuitFigureKind } from '../lib/circuitInfo.ts';
import { whenVisible } from '../lib/visible.ts';

/**
 * Dibujo de un circuito: el trazado propio (data/tracks/{id}.json, que se pide recién acá) y, si no hay,
 * el plano de Wikimedia Commons sobre fondo claro con su atribución. Mientras llega el trazado muestra un
 * esqueleto del mismo tamaño. Si no hay nada para mostrar, deja el contenido del slot y avisa con `kind`.
 */
export default defineComponent({
  name: 'CircuitFigure',
  components: { TrackOutline },
  props: {
    info: { type: Object as PropType<CircuitInfo>, required: true },
    /** Nombre para el texto alternativo (por defecto el de la ficha). */
    name: { type: String, default: '' },
    /** Miniatura: solo el dibujo, sin escala ni atribución (la muestra la pantalla que la usa). */
    mini: { type: Boolean, default: false },
    /** Pide el trazado recién cuando entra en pantalla (listas largas). */
    lazy: { type: Boolean, default: false },
    /** Ancho en píxeles con que se va a ver el plano: si alcanza, se pide una miniatura más liviana. */
    imgWidth: { type: Number, default: 0 },
  },
  emits: {
    kind: (kind: CircuitFigureKind) => typeof kind === 'string',
  },
  data() {
    return {
      mapFailed: false,
      visible: !this.lazy,
      stopWatching: null as (() => void) | null,
    };
  },
  computed: {
    ...mapState(useCircuitInfoStore, ['tracks']),
    label(): string {
      return this.name || this.info.name;
    },
    entry(): Loaded<CircuitTrackFile> | undefined {
      return this.info.hasTrack ? this.tracks[this.info.id] : undefined;
    },
    track(): CircuitTrackFile | null {
      const data = this.entry?.data;
      return trackDrawable(data) ? data : null;
    },
    map(): CircuitImage | null {
      const map = this.info.map;
      return map && httpUrl(map.url) && !this.mapFailed ? map : null;
    },
    mapSrc(): string {
      const url = this.map?.url ?? '';
      return this.imgWidth > 0 ? commonsThumb(url, this.imgWidth) : url;
    },
    mapCredit(): string {
      return this.map ? imageCredit(this.map) : '';
    },
    mapPage(): string {
      return httpUrl(this.map?.page);
    },
    kind(): CircuitFigureKind {
      if (this.track) return 'track';
      // Todavía no se pidió (no entró en pantalla) o está en camino.
      if (this.info.hasTrack && (!this.entry || this.entry.status === 'loading')) return 'loading';
      return this.map ? 'map' : 'none';
    },
    /** Id del trazado que hay que pedir ('' si no hay o todavía no se ve). */
    wanted(): string {
      return this.visible && this.info.hasTrack ? this.info.id : '';
    },
  },
  watch: {
    wanted: {
      immediate: true,
      handler(id: string) {
        if (id) void this.loadTrack(id);
      },
    },
    'info.id'() {
      this.mapFailed = false;
    },
    kind: {
      immediate: true,
      handler(kind: CircuitFigureKind) {
        this.$emit('kind', kind);
      },
    },
  },
  mounted() {
    if (!this.visible) {
      this.stopWatching = whenVisible(this.$el as Element, () => {
        this.visible = true;
      });
    }
  },
  beforeUnmount() {
    this.stopWatching?.();
  },
  methods: {
    ...mapActions(useCircuitInfoStore, ['loadTrack']),
  },
});
</script>

<style>
.circuit-figure {
  display: block;
}

.circuit-figure-skel {
  display: block;
  height: var(--track-h, 230px);
  border-radius: 10px;
  background: var(--border);
  animation: pulse 1.4s ease-in-out infinite;
}

.circuit-figure-ghost {
  visibility: hidden;
}

.circuit-map {
  margin: 0;
}

.circuit-map-stage {
  display: block;
  height: var(--track-h, 230px);
  padding: 0.75rem;
  border-radius: 10px;
  /* Siempre claro, también en tema oscuro; el borde lo separa de la tarjeta blanca del tema claro. */
  background: #fff;
  border: 1px solid var(--border);
}

.circuit-map-stage img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.circuit-map figcaption {
  margin-top: 0.6rem;
}

/* Miniatura: ocupa la caja que le dé quien la usa. */
.circuit-figure.mini {
  display: block;
  overflow: hidden;
  border-radius: 8px;
}

.circuit-figure.mini > * {
  width: 100%;
  height: 100%;
}

.circuit-figure.mini .circuit-figure-skel {
  border-radius: 0;
}

.circuit-figure.mini .circuit-map-stage {
  padding: 3px;
  border-radius: inherit;
}

.circuit-figure.mini.is-track {
  background: var(--bg-elev-2);
}

@media (prefers-reduced-motion: reduce) {
  .circuit-figure-skel {
    animation: none;
  }
}
</style>
