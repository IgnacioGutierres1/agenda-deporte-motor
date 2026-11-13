<template>
  <div v-if="summary" class="session-weather" data-test="session-weather">
    <div class="section-title">{{ title }}</div>
    <div class="card wx-session">
      <div class="wx-session-head">
        <WeatherIcon :name="look.icon" :size="36" />
        <div class="wx-session-sky">
          <strong>{{ look.text }}</strong>
          <span v-if="coords && coords.approx" class="small dim" data-test="weather-approx">
            Clima de la zona: no tenemos la ubicación exacta del circuito.
          </span>
        </div>
      </div>
      <WeatherStats :stats="stats" />
      <p v-if="summary.trackC !== null" class="small dim wx-session-note">{{ trackNote }}</p>
      <p class="small dim wx-session-note">
        <a :href="source.url" target="_blank" rel="noopener noreferrer" class="tap-inline" data-test="weather-source">{{ source.label }}</a>
        <template v-if="updatedText"> · actualizado {{ updatedText }}</template>
      </p>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapActions, mapState } from 'pinia';
import WeatherIcon from './WeatherIcon.vue';
import WeatherStats from './WeatherStats.vue';
import { useCircuitInfoStore } from '../stores/circuitInfo.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { useWeatherStore } from '../stores/weather.ts';
import type { GridItem } from '../lib/grid.ts';
import { timeAgo } from '../lib/format.ts';
import {
  TRACK_NOTE,
  WEATHER_SOURCE,
  circuitCoords,
  describeWeather,
  formatMm,
  formatTemp,
  sessionWeather,
  weatherKey,
  withinReach,
  type Forecast,
  type WeatherIconName,
  type WeatherStat,
  type WeatherSummary,
} from '../lib/weather.ts';

/**
 * Clima de una sesión en su hoja: "Clima previsto" si todavía no terminó, o "Clima durante la sesión (según
 * modelo)" si se corrió en los últimos 2 días. Fuera del alcance del pronóstico, o sin coordenadas, no hay bloque.
 */
export default defineComponent({
  name: 'SessionWeather',
  components: { WeatherIcon, WeatherStats },
  props: {
    item: { type: Object as PropType<GridItem>, required: true },
    now: { type: String, required: true },
  },
  data() {
    return { source: WEATHER_SOURCE, trackNote: TRACK_NOTE };
  },
  computed: {
    ...mapState(useSettingsStore, ['showWeather']),
    ...mapState(useWeatherStore, ['forecasts']),
    wanted(): boolean {
      const s = this.item.session;
      return this.showWeather && !!this.item.event && withinReach(s.startUtc, s.endUtc, this.now);
    },
    coords(): { lat: number; lon: number; approx: boolean } | null {
      return this.wanted && this.item.event ? circuitCoords(this.infoFor(this.item.event.circuit)) : null;
    },
    forecast(): Forecast | undefined {
      return this.coords ? this.forecasts[weatherKey(this.coords.lat, this.coords.lon)] : undefined;
    },
    summary(): WeatherSummary | null {
      const s = this.item.session;
      return sessionWeather(this.forecast, s.startUtc, s.endUtc);
    },
    /** La sesión ya terminó: lo que se muestra es lo que calculó el modelo para esas horas, no un pronóstico. */
    past(): boolean {
      return this.item.session.endUtc <= this.now;
    },
    title(): string {
      return this.past ? 'Clima durante la sesión (según modelo)' : 'Clima previsto';
    },
    look(): { text: string; icon: WeatherIconName } {
      return describeWeather(this.summary?.code, this.summary?.isDay ?? true);
    },
    stats(): WeatherStat[] {
      const s = this.summary;
      if (!s) return [];
      const stats: WeatherStat[] = [{ label: 'Aire', value: this.range(s.tempC, s.tempMinC, s.tempMaxC), test: 'air-temp' }];
      if (s.apparentC !== null) stats.push({ label: 'Sensación', value: formatTemp(s.apparentC) });
      stats.push({ label: 'Lluvia', value: this.rainText, test: 'rain' });
      if (s.windKmh !== null) {
        // Las ráfagas se nombran solo si agregan algo: claramente por encima del viento medio.
        const gusts = s.gustsKmh !== null && s.gustsKmh >= s.windKmh + 10 ? `ráfagas ${Math.round(s.gustsKmh)}` : undefined;
        stats.push({ label: 'Viento', value: `${Math.round(s.windKmh)} km/h`, extra: gusts, test: 'wind' });
      }
      if (s.humidity !== null) stats.push({ label: 'Humedad', value: `${Math.round(s.humidity)} %` });
      if (s.trackC !== null) {
        stats.push({ label: 'Pista (estimada)', value: this.range(s.trackC, s.trackMinC, s.trackMaxC), test: 'track-temp' });
      }
      return stats;
    },
    rainText(): string {
      const s = this.summary;
      if (!s) return '';
      const mm = s.precipMm !== null && s.precipMm >= 0.05 ? formatMm(s.precipMm) : '';
      // De lo ya corrido no tiene sentido una probabilidad: se informa lo que el modelo dice que cayó.
      if (this.past) return mm || 'Sin lluvia';
      if (s.precipProb === null) return mm || 'Sin dato';
      return `${Math.round(s.precipProb)} %${mm ? ` · ${mm}` : ''}`;
    },
    updatedText(): string {
      return this.forecast ? timeAgo(new Date(this.forecast.fetchedAt).toISOString(), this.now) : '';
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
      handler(c: { lat: number; lon: number } | null) {
        if (c) void this.ensure(c.lat, c.lon);
      },
    },
    /** Con la hoja abierta, el pronóstico se renueva cuando vence (1 hora). */
    now() {
      if (this.coords) void this.ensure(this.coords.lat, this.coords.lon);
    },
  },
  methods: {
    ...mapActions(useCircuitInfoStore, { loadCircuits: 'load', infoFor: 'infoFor' }),
    ...mapActions(useWeatherStore, ['ensure']),
    /** "18°", o "16° a 21°" si a lo largo de la sesión cambia 3 °C o más (carreras largas). */
    range(mean: number | null, min: number | null, max: number | null): string {
      if (min !== null && max !== null && Math.round(max) - Math.round(min) >= 3) return `${formatTemp(min)} a ${formatTemp(max)}`;
      return formatTemp(mean);
    },
  },
});
</script>

<style>
.wx-session {
  margin: 0;
}

.wx-session-head {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  margin-bottom: 0.6rem;
}

.wx-session-sky {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.wx-session-note {
  margin: 0.5rem 0 0;
}
</style>
