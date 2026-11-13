<template>
  <svg
    class="weather-icon"
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke-width="1.8"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(p, i) in parts" :key="i" :d="p[1]" :class="`wx-${p[0]}`" />
  </svg>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import type { WeatherIconName } from '../lib/weather.ts';

/** Color de cada trazo: sol, luna, nube, lluvia, nieve (puntos), rayo. */
type Tone = 'sun' | 'moon' | 'cloud' | 'rain' | 'snow' | 'bolt';
type Part = [tone: Tone, d: string];

const SUN: Part[] = [
  ['sun', 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
  ['sun', 'M12 2.5v2'],
  ['sun', 'M12 19.5v2'],
  ['sun', 'M2.5 12h2'],
  ['sun', 'M19.5 12h2'],
  ['sun', 'M5.3 5.3l1.4 1.4'],
  ['sun', 'M17.3 17.3l1.4 1.4'],
  ['sun', 'M5.3 18.7l1.4-1.4'],
  ['sun', 'M17.3 6.7l1.4-1.4'],
];
const MOON: Part[] = [['moon', 'M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z']];
/** Sol chico arriba a la izquierda (asoma detrás de la nube). */
const SMALL_SUN: Part[] = [
  ['sun', 'M8 5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z'],
  ['sun', 'M8 1.6v1.4'],
  ['sun', 'M1.6 8H3'],
  ['sun', 'M3.5 3.5l1 1'],
  ['sun', 'M12.5 3.5l-1 1'],
  ['sun', 'M3.5 12.5l1-1'],
];
const SMALL_MOON: Part[] = [['moon', 'M11.5 8.2A4.6 4.6 0 1 1 6.3 3a3.7 3.7 0 0 0 5.2 5.2z']];
/** Nube sola, centrada. */
const CLOUD: Part = ['cloud', 'M6.5 19a4.5 4.5 0 0 1-.5-8.97A6.5 6.5 0 0 1 18.4 11.5 3.8 3.8 0 0 1 17.5 19h-11z'];
/** Nube más arriba: deja lugar para la lluvia, la nieve o el rayo. */
const HIGH_CLOUD: Part = ['cloud', 'M6.5 15.5a4.5 4.5 0 0 1-.5-8.97A6.5 6.5 0 0 1 18.4 8a3.8 3.8 0 0 1-.9 7.5h-11z'];
/** Nube chica abajo a la derecha (con el sol o la luna arriba). */
const LOW_CLOUD: Part = ['cloud', 'M10 20a3.6 3.6 0 0 1-.4-7.18 5.2 5.2 0 0 1 9.9.98 3.15 3.15 0 0 1-.7 6.2H10z'];
/** Chaparrones: sol más chico, la nube un poco más arriba y gotas. */
const SHOWER_SUN: Part[] = [
  ['sun', 'M7.5 4.4a2.6 2.6 0 1 0 0 5.2 2.6 2.6 0 0 0 0-5.2z'],
  ['sun', 'M7.5 1.3v1.2'],
  ['sun', 'M1.8 7H3'],
  ['sun', 'M3.4 2.9l.9.9'],
  ['sun', 'M11.6 2.9l-.9.9'],
  ['sun', 'M3.4 11.1l.9-.9'],
];
const MID_CLOUD: Part = ['cloud', 'M10 18.5a3.6 3.6 0 0 1-.4-7.18 5.2 5.2 0 0 1 9.9.98 3.15 3.15 0 0 1-.7 6.2H10z'];

const ICONS: Record<WeatherIconName, Part[]> = {
  despejado: SUN,
  'despejado-noche': MOON,
  'algo-nublado': [...SMALL_SUN, LOW_CLOUD],
  'algo-nublado-noche': [...SMALL_MOON, LOW_CLOUD],
  nublado: [CLOUD],
  niebla: [HIGH_CLOUD, ['cloud', 'M5 18.7h14'], ['cloud', 'M7.5 21.7h9']],
  llovizna: [HIGH_CLOUD, ['rain', 'M8.6 18.6l-.5 1.5'], ['rain', 'M12.6 19.9l-.5 1.5'], ['rain', 'M16.2 18.6l-.5 1.5']],
  lluvia: [HIGH_CLOUD, ['rain', 'M8.6 18.4l-1 3'], ['rain', 'M12.6 18.4l-1 3'], ['rain', 'M16.6 18.4l-1 3']],
  'lluvia-fuerte': [
    HIGH_CLOUD,
    ['rain', 'M7.2 18.2l-1.3 4'],
    ['rain', 'M10.8 18.2l-1.3 4'],
    ['rain', 'M14.4 18.2l-1.3 4'],
    ['rain', 'M18 18.2l-1.3 4'],
  ],
  chaparrones: [...SHOWER_SUN, MID_CLOUD, ['rain', 'M12 20.7l-.6 1.9'], ['rain', 'M16.4 20.7l-.6 1.9']],
  nieve: [
    HIGH_CLOUD,
    ['snow', 'M8 18.8v.01'],
    ['snow', 'M12 18.8v.01'],
    ['snow', 'M16 18.8v.01'],
    ['snow', 'M10 21.8v.01'],
    ['snow', 'M14 21.8v.01'],
  ],
  aguanieve: [HIGH_CLOUD, ['rain', 'M8.6 18.4l-1 3'], ['snow', 'M12.2 20v.01'], ['rain', 'M16.6 18.4l-1 3']],
  tormenta: [HIGH_CLOUD, ['bolt', 'M12.8 14.2l-2.6 4h3.4l-2 3.6'], ['rain', 'M7.4 18.4l-.7 2.1'], ['rain', 'M17.4 18.4l-.7 2.1']],
};

/** Ícono del estado del cielo, dibujado en línea (sin imágenes ni fuentes externas). */
export default defineComponent({
  name: 'WeatherIcon',
  props: {
    name: { type: String as PropType<WeatherIconName>, required: true },
    size: { type: [Number, String], default: 22 },
  },
  computed: {
    parts(): Part[] {
      return ICONS[this.name] ?? ICONS.nublado;
    },
  },
});
</script>

<style>
.weather-icon {
  flex: none;
  --wx-sun: #ffc233;
  --wx-moon: #cfd6e6;
  --wx-cloud: #c2c9d2;
  --wx-rain: #5aa9ff;
  --wx-snow: #d6ecff;
  --wx-bolt: #ffd84d;
}

:root[data-theme='light'] .weather-icon {
  --wx-sun: #dd8a00;
  --wx-moon: #5f6b85;
  --wx-cloud: #6b7683;
  --wx-rain: #0969da;
  --wx-snow: #3c95cc;
  --wx-bolt: #c58600;
}

@media (prefers-color-scheme: light) {
  :root[data-theme='system'] .weather-icon {
    --wx-sun: #dd8a00;
    --wx-moon: #5f6b85;
    --wx-cloud: #6b7683;
    --wx-rain: #0969da;
    --wx-snow: #3c95cc;
    --wx-bolt: #c58600;
  }
}

.wx-sun {
  stroke: var(--wx-sun);
}

.wx-moon {
  stroke: var(--wx-moon);
}

.wx-cloud {
  stroke: var(--wx-cloud);
}

.wx-rain {
  stroke: var(--wx-rain);
}

/* Copos: puntos (trazos de largo casi nulo con punta redonda). */
.wx-snow {
  stroke: var(--wx-snow);
  stroke-width: 2.6;
}

.wx-bolt {
  stroke: var(--wx-bolt);
}
</style>
