<template>
  <WeatherCard
    v-if="coords"
    :lat="coords.lat"
    :lon="coords.lon"
    :tz="event.tz"
    :approx="coords.approx"
    :date-start="event.dateStart"
    :date-end="event.dateEnd"
  />
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapActions, mapState } from 'pinia';
import type { MotorEvent } from '@dm/shared';
import WeatherCard from './WeatherCard.vue';
import { useCircuitInfoStore } from '../stores/circuitInfo.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { circuitCoords } from '../lib/weather.ts';

/**
 * "Clima en el circuito" para los días de un evento (pestaña Horarios). Las coordenadas salen de la ficha del
 * circuito; si no las tiene, o "Mostrar clima" está apagado, no se dibuja nada.
 */
export default defineComponent({
  name: 'EventWeather',
  components: { WeatherCard },
  props: {
    event: { type: Object as PropType<MotorEvent>, required: true },
  },
  computed: {
    ...mapState(useSettingsStore, ['showWeather']),
    coords(): { lat: number; lon: number; approx: boolean } | null {
      return this.showWeather ? circuitCoords(this.infoFor(this.event.circuit)) : null;
    },
  },
  watch: {
    showWeather: {
      immediate: true,
      handler(v: boolean) {
        if (v) void this.loadCircuits();
      },
    },
  },
  methods: {
    ...mapActions(useCircuitInfoStore, { loadCircuits: 'load', infoFor: 'infoFor' }),
  },
});
</script>
