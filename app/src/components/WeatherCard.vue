<template>
  <section v-if="wanted && forecast && (current || days.length || hasRange)" class="card flush weather-card" data-test="weather-card">
    <h3 class="card-title">{{ title }}</h3>
    <p v-if="approx" class="wx-approx small dim" data-test="weather-approx">
      Clima de la zona: no tenemos la ubicación exacta del circuito.
    </p>

    <template v-if="current">
      <div class="wx-now">
        <WeatherIcon :name="currentLook.icon" :size="46" />
        <span class="wx-now-temp">{{ temp(current.tempC) }}</span>
        <span class="wx-now-text">
          <strong>{{ currentLook.text }}</strong>
          <span class="small dim">Ahora · {{ localTime }} en el circuito</span>
        </span>
      </div>
      <WeatherStats :stats="currentStats" class="wx-now-stats" />
    </template>

    <ul v-if="days.length" class="wx-days" :class="{ 'with-now': !!current }">
      <li v-for="d in days" :key="d.date" class="wx-day" :class="{ past: d.past }">
        <span class="wx-day-name">{{ d.label }}</span>
        <WeatherIcon :name="d.icon" :size="26" />
        <span class="wx-day-text">
          <span>{{ d.text }}</span>
          <span v-if="d.rain" class="small wx-day-rain">{{ d.rain }}</span>
        </span>
        <span class="wx-day-temps" :aria-label="`máxima ${d.max}, mínima ${d.min}`">
          <strong>{{ d.max }}</strong>
          <span class="dim">{{ d.min }}</span>
        </span>
      </li>
    </ul>
    <!-- El evento cae justo en el borde del pronóstico: puede haber clima de alguna sesión, pero de ningún día entero. -->
    <p v-else-if="!current" class="wx-edge small dim" data-test="weather-edge">
      El pronóstico (16 días) no llega a cubrir un día completo de este evento.
    </p>

    <div class="wx-foot small dim">
      <p v-if="current && current.trackC !== null">{{ trackNote }}</p>
      <p>
        <a :href="source.url" target="_blank" rel="noopener noreferrer" class="tap-inline" data-test="weather-source">{{ source.label }}</a>
        <template v-if="updatedText"> · actualizado {{ updatedText }}</template>
      </p>
    </div>
  </section>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import { DateTime } from 'luxon';
import WeatherIcon from './WeatherIcon.vue';
import WeatherStats from './WeatherStats.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { useWeatherStore } from '../stores/weather.ts';
import { fixMonthAbbr, timeAgo } from '../lib/format.ts';
import {
  TRACK_NOTE,
  WEATHER_SOURCE,
  currentWeather,
  dailyForecast,
  describeWeather,
  forecastReach,
  formatMm,
  formatTemp,
  rainChance,
  validCoords,
  weatherKey,
  type Forecast,
  type WeatherIconName,
  type WeatherStat,
  type WeatherSummary,
} from '../lib/weather.ts';

interface DayRow {
  date: string;
  label: string;
  icon: WeatherIconName;
  text: string;
  /** "Lluvia 60 % · 2,4 mm" ('' si no se espera). */
  rain: string;
  max: string;
  min: string;
  past: boolean;
}

/** Un día cuenta si el pronóstico lo cubre casi entero (los bordes del pronóstico quedan cortados). */
const MIN_HOURS = 20;

/**
 * Clima de un circuito: ahora y los próximos días (o solo los días de un evento, con dateStart/dateEnd).
 * Pide el pronóstico al mostrarse; si no hay conexión o "Mostrar clima" está apagado, no dibuja nada.
 */
export default defineComponent({
  name: 'WeatherCard',
  components: { WeatherIcon, WeatherStats },
  props: {
    lat: { type: Number, required: true },
    lon: { type: Number, required: true },
    /** Zona horaria del circuito (IANA): define dónde empieza y termina cada día. */
    tz: { type: String, required: true },
    /** Coordenadas de la ciudad, no del circuito: se aclara "clima de la zona". */
    approx: { type: Boolean, default: false },
    title: { type: String, default: 'Clima en el circuito' },
    /** Fechas locales (YYYY-MM-DD) de un evento: la tarjeta muestra solo esos días. */
    dateStart: { type: String, default: '' },
    dateEnd: { type: String, default: '' },
    /** Sin fechas de evento: cuántos días mostrar desde hoy. */
    dayCount: { type: Number, default: 7 },
  },
  data() {
    return { source: WEATHER_SOURCE, trackNote: TRACK_NOTE };
  },
  computed: {
    ...mapState(useScheduleStore, ['now']),
    ...mapState(useSettingsStore, ['showWeather']),
    ...mapState(useWeatherStore, ['forecasts']),
    forecast(): Forecast | undefined {
      return validCoords(this.lat, this.lon) ? this.forecasts[weatherKey(this.lat, this.lon)] : undefined;
    },
    /** Hoy en el circuito. */
    today(): string {
      return this.localNow.toISODate()!;
    },
    localNow(): DateTime {
      const utc = DateTime.fromISO(this.now, { zone: 'utc' });
      const local = utc.setZone(this.tz);
      return local.isValid ? local : utc;
    },
    localTime(): string {
      return this.localNow.toFormat('HH:mm');
    },
    hasRange(): boolean {
      return !!this.dateStart && !!this.dateEnd;
    },
    /** Con fechas de evento, solo se pide clima si algún día del evento entra en el pronóstico. */
    wanted(): boolean {
      if (!this.showWeather || !validCoords(this.lat, this.lon)) return false;
      if (!this.hasRange) return true;
      const reach = forecastReach(this.now);
      const from = DateTime.fromISO(this.dateStart, { zone: this.tz }).startOf('day').toMillis();
      const to = DateTime.fromISO(this.dateEnd, { zone: this.tz }).endOf('day').toMillis();
      return Number.isFinite(from) && Number.isFinite(to) && to >= reach.from && from <= reach.to;
    },
    /** "Ahora" se muestra en la ficha del circuito y, en un evento, desde el día anterior hasta que termina. */
    current(): WeatherSummary | null {
      if (!this.forecast) return null;
      if (this.hasRange) {
        const dayBefore = DateTime.fromISO(this.dateStart).minus({ days: 1 }).toISODate()!;
        if (this.today < dayBefore || this.today > this.dateEnd) return null;
      }
      return currentWeather(this.forecast, this.now);
    },
    currentLook(): { text: string; icon: WeatherIconName } {
      return describeWeather(this.current?.code, this.current?.isDay ?? true);
    },
    currentStats(): WeatherStat[] {
      const c = this.current;
      if (!c) return [];
      const stats: WeatherStat[] = [];
      if (c.apparentC !== null) stats.push({ label: 'Sensación', value: formatTemp(c.apparentC) });
      if (c.trackC !== null) stats.push({ label: 'Pista (estimada)', value: formatTemp(c.trackC), test: 'track-temp' });
      if (c.windKmh !== null) stats.push({ label: 'Viento', value: `${Math.round(c.windKmh)} km/h` });
      if (c.humidity !== null) stats.push({ label: 'Humedad', value: `${Math.round(c.humidity)} %` });
      return stats;
    },
    /** "hace 12 minutos": cuándo se descargó el pronóstico que se está mostrando. */
    updatedText(): string {
      return this.forecast ? timeAgo(new Date(this.forecast.fetchedAt).toISOString(), this.now) : '';
    },
    days(): DayRow[] {
      if (!this.forecast) return [];
      const today = this.today;
      const tomorrow = DateTime.fromISO(today).plus({ days: 1 }).toISODate()!;
      const lastDay = DateTime.fromISO(today).plus({ days: this.dayCount - 1 }).toISODate()!;
      return dailyForecast(this.forecast, this.tz)
        .filter((d) => d.hours >= MIN_HOURS)
        .filter((d) => (this.hasRange ? d.date >= this.dateStart && d.date <= this.dateEnd : d.date >= today && d.date <= lastDay))
        .map((d) => {
          const look = describeWeather(d.code, true);
          // De un día que ya pasó no tiene sentido una probabilidad: solo lo que el modelo dice que llovió.
          const chance = d.date < today ? null : rainChance(d);
          const mm = d.precipMm !== null && d.precipMm >= 0.1 ? formatMm(d.precipMm) : '';
          return {
            date: d.date,
            label: d.date === today ? 'Hoy' : d.date === tomorrow ? 'Mañana' : this.dayLabel(d.date),
            icon: look.icon,
            text: look.text,
            rain: chance !== null ? `Lluvia ${chance} %${mm ? ` · ${mm}` : ''}` : mm ? `Lluvia ${mm}` : '',
            max: formatTemp(d.maxC),
            min: formatTemp(d.minC),
            past: d.date < today,
          };
        });
    },
  },
  watch: {
    /** Pide el pronóstico al mostrarse, al cambiar de circuito y, con la pantalla abierta, cuando vence (1 hora). */
    wanted: {
      immediate: true,
      handler(v: boolean) {
        if (v) void this.ensure(this.lat, this.lon);
      },
    },
    lat() {
      if (this.wanted) void this.ensure(this.lat, this.lon);
    },
    lon() {
      if (this.wanted) void this.ensure(this.lat, this.lon);
    },
    now() {
      if (this.wanted) void this.ensure(this.lat, this.lon);
    },
  },
  methods: {
    ...mapActions(useWeatherStore, ['ensure']),
    temp: formatTemp,
    /** "vie 13" */
    dayLabel(date: string): string {
      return fixMonthAbbr(DateTime.fromISO(date).setLocale('es-AR').toFormat('ccc d').replace(/\./g, ''));
    },
  },
});
</script>

<style>
.wx-approx {
  margin: 0;
  padding: 0 0.85rem 0.35rem;
}

.wx-now {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  padding: 0.15rem 0.85rem 0.5rem;
}

.wx-now-temp {
  font-size: 2.2rem;
  font-weight: 900;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.wx-now-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.wx-now-stats {
  padding: 0 0.85rem 0.75rem;
}

.wx-days {
  list-style: none;
  margin: 0;
  padding: 0;
}

.wx-days.with-now {
  border-top: 1px solid var(--border);
}

.wx-day {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  min-height: 48px;
  padding: 0.35rem 0.85rem;
}

.wx-day + .wx-day {
  border-top: 1px solid var(--border);
}

.wx-day.past {
  opacity: 0.6;
}

.wx-day-name {
  width: 3.9rem;
  flex: none;
  font-weight: 700;
  text-transform: capitalize;
}

.wx-day-text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  line-height: 1.25;
}

.wx-day-rain {
  color: var(--info);
}

.wx-day-temps {
  display: flex;
  gap: 0.5rem;
  flex: none;
  font-variant-numeric: tabular-nums;
}

.wx-day-temps > * {
  min-width: 2.1rem;
  text-align: right;
}

.wx-edge {
  margin: 0;
  padding: 0 0.85rem 0.6rem;
}

.wx-foot {
  padding: 0.55rem 0.85rem 0.7rem;
  border-top: 1px solid var(--border);
}

.wx-foot p {
  margin: 0;
}

.wx-foot p + p {
  margin-top: 0.3rem;
}
</style>
