import { defineStore } from 'pinia';
import { markRaw } from 'vue';
import { clearWeatherCache, getForecast, weatherKey, type Forecast } from '../lib/weather.ts';

/**
 * Pronósticos ya descargados, por punto ("lat,lon" redondeadas). Los comparten la tarjeta del circuito, las
 * marcas de cada sesión y la hoja de la sesión: todos piden el mismo punto y se hace una sola descarga.
 * Solo se pide clima al abrir un evento, una sesión o un circuito (nunca desde la Agenda ni los listados).
 */
export const useWeatherStore = defineStore('weather', {
  state: () => ({
    forecasts: {} as Record<string, Forecast>,
    /** 'none' = se pidió y no hay clima (sin conexión, sin datos). */
    status: {} as Record<string, 'loading' | 'ok' | 'none'>,
  }),
  actions: {
    /** Pide (o renueva, pasada una hora) el pronóstico del punto. No falla nunca: sin conexión queda 'none'. */
    async ensure(lat: number, lon: number): Promise<void> {
      const key = weatherKey(lat, lon);
      if (!this.forecasts[key]) this.status[key] = 'loading';
      const forecast = await getForecast(lat, lon);
      if (forecast) {
        if (this.forecasts[key] !== forecast) this.forecasts[key] = markRaw(forecast);
        this.status[key] = 'ok';
      } else if (!this.forecasts[key]) {
        this.status[key] = 'none';
      }
    },
    forecastFor(lat: number, lon: number): Forecast | undefined {
      return this.forecasts[weatherKey(lat, lon)];
    },
    /** Al desactivar "Mostrar clima": no queda nada guardado. */
    clear() {
      this.forecasts = {};
      this.status = {};
      clearWeatherCache();
    },
  },
});
