<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    :fill="filled ? 'currentColor' : 'none'"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path v-for="(d, i) in paths" :key="i" :d="d" />
  </svg>
</template>

<script lang="ts">
import { defineComponent } from 'vue';

const ICONS: Record<string, string[]> = {
  calendar: ['M8 2v4', 'M16 2v4', 'M3 10h18', 'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z'],
  trophy: [
    'M8 21h8',
    'M12 17v4',
    'M7 4h10v5a5 5 0 0 1-10 0V4z',
    'M17 5h3v2a3 3 0 0 1-3 3',
    'M7 5H4v2a3 3 0 0 0 3 3',
  ],
  check: ['M9 11l3 3 8-8', 'M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9'],
  gear: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  ],
  refresh: ['M21 12a9 9 0 1 1-2.6-6.4', 'M21 3v6h-6'],
  filter: ['M3 5h18', 'M6 12h12', 'M10 19h4'],
  share: ['M12 3v12', 'M7 8l5-5 5 5', 'M5 14v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  external: ['M14 4h6v6', 'M20 4l-9 9', 'M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  chevron: ['M9 6l6 6-6 6'],
  download: ['M12 3v12', 'M7 10l5 5 5-5', 'M5 21h14'],
  star: ['M12 3l2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2l1.1-6.2L3 9.6l6.2-.9L12 3z'],
  live: ['M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2z', 'M8.5 8.5a5 5 0 0 0 0 7', 'M15.5 8.5a5 5 0 0 1 0 7', 'M5.6 5.6a9 9 0 0 0 0 12.8', 'M18.4 5.6a9 9 0 0 1 0 12.8'],
  menu: ['M4 6h16', 'M4 12h16', 'M4 18h16'],
  back: ['M15 6l-6 6 6 6'],
  search: ['M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z', 'M21 21l-4.3-4.3'],
  plus: ['M12 5v14', 'M5 12h14'],
  flag: ['M5 21V4', 'M5 4h11l-2 4 2 4H5'],
  news: ['M4 5h13v14H6a2 2 0 0 1-2-2V5z', 'M17 9h3v8a2 2 0 0 1-2 2', 'M7 9h7', 'M7 13h7', 'M7 17h4'],
  grid: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'],
  moon: ['M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z'],
  clock: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M12 7v5l3 2'],
  globe: ['M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z', 'M3 12h18', 'M12 3a14 14 0 0 1 0 18', 'M12 3a14 14 0 0 0 0 18'],
  pin: ['M12 21s-7-6.1-7-11a7 7 0 0 1 14 0c0 4.9-7 11-7 11z', 'M12 12.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'],
  // Rally y rally raid: superficies (asfalto, tierra, nieve, arena, mixto) y recorrido.
  road: ['M8 21L10.5 3', 'M16 21L13.5 3', 'M12 5v2', 'M12 11v2.5', 'M12 17.5V20'],
  terrain: ['M2.5 19l6.5-11 4 6.5 2.5-3.5 6 8h-19z'],
  snow: ['M12 3v18', 'M4.2 7.5l15.6 9', 'M19.8 7.5l-15.6 9', 'M9.5 4.5L12 7l2.5-2.5', 'M9.5 19.5L12 17l2.5 2.5'],
  dunes: ['M2 19c3-6 6.5-6 9.5 0', 'M8 19c3.5-9 9-9 14 0', 'M19 6.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0z'],
  layers: ['M12 4l9 4.5-9 4.5-9-4.5L12 4z', 'M3 13l9 4.5 9-4.5'],
  route: ['M6 20a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M18 8a2 2 0 1 0 0-4 2 2 0 0 0 0 4z', 'M8 18h7.5a3 3 0 0 0 0-6h-7a3 3 0 0 1 0-6H16'],
  expand: ['M15 3h6v6', 'M9 21H3v-6', 'M21 3l-7 7', 'M3 21l7-7'],
  bolt: ['M13 2L4.5 13.5H11L10 22l8.5-11.5H12L13 2z'],
};

export default defineComponent({
  name: 'AppIcon',
  props: {
    name: { type: String, required: true },
    size: { type: [Number, String], default: 22 },
    /** Relleno sólido (estrella de "siguiendo"). */
    filled: { type: Boolean, default: false },
  },
  computed: {
    paths(): string[] {
      return ICONS[this.name] ?? [];
    },
  },
});
</script>
