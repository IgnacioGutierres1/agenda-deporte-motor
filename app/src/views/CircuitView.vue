<template>
  <div class="circuit-view">
    <DataState />
    <p v-if="hasData && !circuit" class="page card empty">No encontramos este circuito en el calendario publicado.</p>

    <template v-if="circuit">
      <section class="hero" :style="{ '--series-color': color }">
        <div class="hero-top">
          <div class="hero-series big">
            <span class="circuit-badge" aria-hidden="true"><AppIcon name="flag" :size="28" /></span>
            <div>
              <h1 class="hero-title tight">{{ circuit.name }}</h1>
              <p class="hero-sub">{{ subtitle }}</p>
            </div>
          </div>
        </div>
        <p v-if="otherNames.length" class="hero-sub small circuit-aka">También figura como {{ otherNames.join(' · ') }}</p>
      </section>

      <div class="page">
        <div class="session-chips">
          <RouterLink v-for="s in seriesList" :key="s.id" :to="`/categoria/${s.id}`" class="pill">
            <SeriesCrest :series="s" :size="20" />
            {{ s.shortName }}
          </RouterLink>
        </div>

        <section class="card flush">
          <h3 class="card-title">Próximos eventos</h3>
          <p v-if="!upcoming.length" class="card-foot small dim">No hay fechas próximas publicadas en este circuito.</p>
          <ul v-else class="list-card inset">
            <li v-for="h in upcoming" :key="h.event.id">
              <RouterLink :to="`/evento/${h.event.id}`" class="list-row">
                <span class="date-box small-box">
                  <span class="date-day">{{ dayNum(h.event.dateStart) }}</span>
                  <span class="date-month">{{ monthShort(h.event.dateStart) }}</span>
                </span>
                <span class="grow">
                  {{ h.event.name }}
                  <span class="block small dim">{{ h.series?.shortName ?? h.event.seriesId }} · {{ dateRange(h.event.dateStart, h.event.dateEnd) }}</span>
                </span>
                <SeriesCrest v-if="h.series" :series="h.series" :size="26" />
              </RouterLink>
            </li>
          </ul>
        </section>

        <section v-if="past.length" class="card flush">
          <h3 class="card-title">Ya disputados</h3>
          <ul class="list-card inset">
            <li v-for="h in past" :key="h.event.id">
              <RouterLink :to="`/evento/${h.event.id}${h.hasResults ? '?tab=resultados' : ''}`" class="list-row">
                <span class="date-box small-box">
                  <span class="date-day">{{ dayNum(h.event.dateStart) }}</span>
                  <span class="date-month">{{ monthShort(h.event.dateStart) }}</span>
                </span>
                <span class="grow">
                  {{ h.event.name }}
                  <span class="block small dim">{{ h.series?.shortName ?? h.event.seriesId }} · {{ dateRange(h.event.dateStart, h.event.dateEnd) }}</span>
                </span>
                <span v-if="h.hasResults" class="badge badge-ok">Resultados</span>
                <SeriesCrest v-else-if="h.series" :series="h.series" :size="26" />
              </RouterLink>
            </li>
          </ul>
        </section>

        <p class="small dim center">Eventos de todas las categorías del calendario en este circuito.</p>
      </div>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapState } from 'pinia';
import { DateTime } from 'luxon';
import type { MotorEvent, Series } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import DataState from '../components/DataState.vue';
import SeriesCrest from '../components/SeriesCrest.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import type { Circuit } from '../lib/circuits.ts';
import { formatDateRange } from '../lib/format.ts';
import { seriesColor, seriesSort } from '../lib/grid.ts';
import { todayIn } from '../lib/agenda.ts';

interface Row {
  event: MotorEvent;
  series?: Series;
  hasResults: boolean;
}

/** Página de un circuito: todo lo que se corre (y se corrió) ahí, de todas las categorías. */
export default defineComponent({
  name: 'CircuitView',
  components: { AppIcon, DataState, SeriesCrest },
  computed: {
    ...mapState(useScheduleStore, ['schedule', 'hasData', 'now', 'seriesById', 'circuits']),
    circuit(): Circuit | undefined {
      const id = String(this.$route.params.circuitId);
      return this.circuits.find((c) => c.id === id);
    },
    seriesList(): Series[] {
      return (this.circuit?.seriesIds ?? [])
        .map((id) => this.seriesById.get(id))
        .filter((s): s is Series => !!s)
        .sort(seriesSort);
    },
    color(): string {
      return seriesColor(this.seriesList[0]);
    },
    subtitle(): string {
      const n = this.seriesList.length;
      const parts = [this.circuit?.country, `${n} ${n === 1 ? 'categoría' : 'categorías'}`];
      return parts.filter(Boolean).join(' · ');
    },
    otherNames(): string[] {
      return (this.circuit?.names ?? []).filter((n) => n !== this.circuit?.name).slice(0, 4);
    },
    rows(): Row[] {
      const withResults = new Set((this.schedule?.sessions ?? []).filter((s) => s.hasResults).map((s) => s.eventId));
      return (this.circuit?.events ?? []).map((event) => ({
        event,
        series: this.seriesById.get(event.seriesId),
        hasResults: withResults.has(event.id),
      }));
    },
    upcoming(): Row[] {
      return this.rows.filter((r) => r.event.dateEnd >= todayIn(this.now, r.event.tz));
    },
    past(): Row[] {
      return this.rows.filter((r) => r.event.dateEnd < todayIn(this.now, r.event.tz)).reverse();
    },
  },
  methods: {
    dayNum(date: string): string {
      return String(Number(date.slice(8, 10)));
    },
    monthShort(date: string): string {
      return DateTime.fromISO(date).setLocale('es-AR').toFormat('LLL').replace('.', '');
    },
    dateRange: formatDateRange,
  },
});
</script>

<style>
.circuit-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 58px;
  height: 58px;
  flex: none;
  border-radius: 50%;
  background: var(--series-color);
  color: #fff;
}

.circuit-aka {
  margin-top: 0.6rem;
}
</style>
