<template>
  <span v-if="summary" class="wx-mark" :title="label" data-test="weather-mark">
    <WeatherIcon :name="look.icon" :size="18" />
    <span class="wx-mark-temp" aria-hidden="true">{{ temp }}</span>
    <span v-if="rain !== null" class="wx-mark-rain" aria-hidden="true">{{ rain }} %</span>
    <span class="sr-only">{{ label }}</span>
  </span>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapActions, mapState } from 'pinia';
import WeatherIcon from './WeatherIcon.vue';
import { useCircuitInfoStore } from '../stores/circuitInfo.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { useWeatherStore } from '../stores/weather.ts';
import type { GridItem } from '../lib/grid.ts';
import {
  circuitCoords,
  describeWeather,
  formatTemp,
  rainChance,
  sessionWeather,
  weatherKey,
  withinReach,
  type WeatherIconName,
  type WeatherSummary,
} from '../lib/weather.ts';

/**
 * Marca chica del clima previsto para una sesión (ícono + temperatura, y % de lluvia desde 20 %) en la lista de
 * horarios de un evento. Solo para sesiones que no terminaron y que entran en el pronóstico (16 días).
 */
export default defineComponent({
  name: 'SessionWeatherMark',
  components: { WeatherIcon },
  props: {
    item: { type: Object as PropType<GridItem>, required: true },
  },
  computed: {
    ...mapState(useScheduleStore, ['now']),
    ...mapState(useSettingsStore, ['showWeather']),
    ...mapState(useWeatherStore, ['forecasts']),
    /** Sesión futura (o en curso) y dentro del alcance del pronóstico. */
    wanted(): boolean {
      const s = this.item.session;
      return this.showWeather && !this.item.finished && !!this.item.event && withinReach(s.startUtc, s.endUtc, this.now);
    },
    coords(): { lat: number; lon: number; approx: boolean } | null {
      return this.wanted && this.item.event ? circuitCoords(this.infoFor(this.item.event.circuit)) : null;
    },
    summary(): WeatherSummary | null {
      if (!this.coords) return null;
      const s = this.item.session;
      return sessionWeather(this.forecasts[weatherKey(this.coords.lat, this.coords.lon)], s.startUtc, s.endUtc);
    },
    look(): { text: string; icon: WeatherIconName } {
      return describeWeather(this.summary?.code, this.summary?.isDay ?? true);
    },
    temp(): string {
      return formatTemp(this.summary?.tempC);
    },
    rain(): number | null {
      return rainChance(this.summary);
    },
    label(): string {
      const rain = this.rain !== null ? `, ${this.rain} % de probabilidad de lluvia` : '';
      return `Clima previsto: ${this.look.text.toLowerCase()}, ${this.temp}${rain}`;
    },
  },
  watch: {
    wanted: {
      immediate: true,
      handler(v: boolean) {
        if (v) void this.loadCircuits();
      },
    },
    coords: {
      immediate: true,
      handler(c: { lat: number; lon: number } | null, old?: { lat: number; lon: number } | null) {
        if (c && (c.lat !== old?.lat || c.lon !== old?.lon)) void this.ensure(c.lat, c.lon);
      },
    },
  },
  methods: {
    ...mapActions(useCircuitInfoStore, { loadCircuits: 'load', infoFor: 'infoFor' }),
    ...mapActions(useWeatherStore, ['ensure']),
  },
});
</script>

<style>
.wx-mark {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  flex: none;
  font-size: 0.85rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.wx-mark-temp {
  font-weight: 700;
}

.wx-mark-rain {
  color: var(--info);
  font-weight: 600;
}
</style>
