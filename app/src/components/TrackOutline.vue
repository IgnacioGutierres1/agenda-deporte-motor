<template>
  <!-- Miniatura (listas, bloque del evento): solo el dibujo, del tamaño que le dé quien la usa. -->
  <span v-if="mini" class="track-outline mini" :style="rootStyle">
    <svg class="track-svg" :viewBox="viewBox" role="img" :aria-label="label">
      <path v-for="(d, i) in secondary" :key="`s${i}`" class="track-secondary" :d="d" />
      <path v-for="(d, i) in paths" :key="`p${i}`" class="track-main" :d="d" />
    </svg>
  </span>
  <figure v-else class="track-outline" :style="rootStyle">
    <div class="track-stage" :class="{ 'with-scale': !!scale }">
      <div class="track-fit">
        <svg class="track-svg" :viewBox="viewBox" role="img" :aria-label="label">
          <path v-for="(d, i) in secondary" :key="`s${i}`" class="track-secondary" :d="d" />
          <path v-for="(d, i) in paths" :key="`p${i}`" class="track-main" :d="d" />
        </svg>
        <div v-if="scale" class="track-scale" :style="{ width: scaleWidth }">
          <span><span class="sr-only">Escala: </span>{{ scale.label }}</span>
        </div>
      </div>
    </div>
    <figcaption class="track-credit small dim">
      Trazado:
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer" class="tap-inline">{{ credit }}</a><template v-if="track.license"> · {{ track.license }}</template>
      · Norte arriba
    </figcaption>
  </figure>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import type { CircuitTrackFile } from '@dm/shared';
import { trackScale, type TrackScale } from '../lib/circuitInfo.ts';

/**
 * Dibujo del trazado de un circuito (data/tracks/{id}.json, geometría de OpenStreetMap) como SVG propio:
 * la pista con trazo grueso en el color de acento (o el que se pase), boxes y variantes finos y atenuados,
 * barra de escala y crédito. El grosor del trazo no depende del tamaño del lienzo (non-scaling-stroke).
 */
export default defineComponent({
  name: 'TrackOutline',
  props: {
    track: { type: Object as PropType<CircuitTrackFile>, required: true },
    /** Nombre del circuito, para el texto alternativo. */
    name: { type: String, default: '' },
    /** Solo el dibujo, sin escala ni crédito (el crédito lo muestra la pantalla que la usa). */
    mini: { type: Boolean, default: false },
    /** Color del trazo principal; por defecto el de acento. */
    color: { type: String, default: '' },
  },
  computed: {
    viewBox(): string {
      return `0 0 ${this.track.width} ${this.track.height}`;
    },
    paths(): string[] {
      return this.track.paths.filter((d) => typeof d === 'string' && d.trim());
    },
    secondary(): string[] {
      return (this.track.secondary ?? []).filter((d) => typeof d === 'string' && d.trim());
    },
    label(): string {
      return this.name ? `Trazado de ${this.name}` : 'Trazado del circuito';
    },
    credit(): string {
      return this.track.credit?.trim() || '© Colaboradores de OpenStreetMap';
    },
    scale(): TrackScale | null {
      return trackScale(this.track);
    },
    /** La barra se mide contra el ancho del dibujo: el mismo porcentaje vale a cualquier tamaño. */
    scaleWidth(): string {
      return this.scale ? `${((this.scale.units / this.track.width) * 100).toFixed(2)}%` : '0';
    },
    rootStyle(): Record<string, string> {
      return {
        '--track-ar': String(Number((this.track.width / this.track.height).toFixed(4))),
        ...(this.color ? { '--track-color': this.color } : {}),
      };
    },
  },
});
</script>

<style>
.track-outline {
  --track-color: var(--accent);
  --track-scale-h: 0px;
  display: block;
  margin: 0;
}

.track-svg {
  display: block;
  /* El trazo se dibuja centrado en el borde del lienzo: que no se recorte. */
  overflow: visible;
}

.track-svg path {
  fill: none;
  stroke-linecap: round;
  stroke-linejoin: round;
  vector-effect: non-scaling-stroke;
}

.track-main {
  stroke: var(--track-color);
  stroke-width: 4px;
}

.track-secondary {
  stroke: var(--text-dim);
  stroke-width: 1.5px;
  opacity: 0.7;
}

/* El dibujo entra entero (ancho o alto, lo que limite) en un escenario de alto fijo: no hay saltos al cargar. */
.track-stage {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: var(--track-h, 230px);
  container-type: size;
}

.track-stage.with-scale {
  --track-scale-h: 22px;
}

.track-fit {
  width: 100%;
  width: min(100cqw, calc((100cqh - var(--track-scale-h)) * var(--track-ar)));
}

.track-fit .track-svg {
  width: 100%;
  aspect-ratio: var(--track-ar);
}

.track-scale {
  position: relative;
  height: 6px;
  margin-top: 14px;
  border: solid var(--text-dim);
  border-width: 0 1.5px 1.5px;
}

.track-scale > span {
  position: absolute;
  left: calc(100% + 0.4rem);
  bottom: -0.25rem;
  font-size: 0.72rem;
  line-height: 1;
  color: var(--text-dim);
  white-space: nowrap;
}

.track-credit {
  margin-top: 0.6rem;
}

/* Sin unidades de contenedor (navegadores viejos): el SVG se acomoda solo al escenario y no se dibuja la escala. */
@supports not (width: 1cqw) {
  .track-fit {
    height: 100%;
  }

  .track-fit .track-svg {
    height: 100%;
    aspect-ratio: auto;
  }

  .track-scale {
    display: none;
  }
}

.track-outline.mini {
  display: block;
  padding: 3px;
}

.track-outline.mini .track-svg {
  width: 100%;
  height: 100%;
}

.track-outline.mini .track-main {
  stroke-width: 2.25px;
}

.track-outline.mini .track-secondary {
  stroke-width: 1px;
}
</style>
