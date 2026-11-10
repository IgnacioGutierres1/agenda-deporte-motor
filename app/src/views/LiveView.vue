<template>
  <div class="page live-view">
    <DataState />
    <template v-if="hasData">
      <h2 class="section-title">En vivo ahora</h2>
      <p v-if="!liveItems.length" class="card empty dim">
        No hay sesiones en curso.
        <template v-if="upcoming.length">La próxima: <strong>{{ upcoming[0]!.series.shortName }} · {{ upcoming[0]!.session.name }}</strong> {{ inText(upcoming[0]!.session.startUtc) }}.</template>
      </p>
      <LiveSessionCard v-for="item in liveItems" :key="item.session.id" :item="item" :now="now" />

      <template v-if="upcoming.length">
        <h2 class="section-title">Próximas 24 horas</h2>
        <ul class="list-card">
          <li v-for="item in upcoming" :key="item.session.id">
            <RouterLink :to="`/evento/${item.session.eventId}`" class="list-row">
              <SeriesCrest :series="item.series" :size="30" />
              <span class="grow">
                <strong>{{ item.series.shortName }}</strong> · {{ item.session.name }}
                <span class="block small dim">{{ item.event?.name }}</span>
              </span>
              <span class="small upcoming-time">
                <strong>{{ time(item.session.startUtc) }}</strong>
                <span class="block dim">{{ inText(item.session.startUtc) }}</span>
              </span>
            </RouterLink>
          </li>
        </ul>
      </template>

      <p class="small dim center">
        Tablas en vivo cuando el cronometraje oficial las publica abiertas (NASCAR y categorías con Speedhive); para el
        resto, el link al cronometraje oficial.
      </p>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapState } from 'pinia';
import { DateTime } from 'luxon';
import DataState from '../components/DataState.vue';
import LiveSessionCard from '../components/LiveSessionCard.vue';
import SeriesCrest from '../components/SeriesCrest.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { sessionsInPeriod, type GridItem } from '../lib/grid.ts';

/** Sesiones en curso con sus tiempos en vivo, y las próximas 24 horas (como el filtro "En vivo" de FotMob). */
export default defineComponent({
  name: 'LiveView',
  components: { DataState, LiveSessionCard, SeriesCrest },
  computed: {
    ...mapState(useScheduleStore, ['schedule', 'hasData', 'now', 'visibleSeriesPredicate']),
    ...mapState(useSettingsStore, ['timeZone', 'followedSeries', 'followedDrivers']),
    window(): GridItem[] {
      const now = Date.parse(this.now);
      const period = {
        startUtc: new Date(now - 12 * 3_600_000).toISOString(),
        endUtc: new Date(now + 24 * 3_600_000).toISOString(),
      };
      return sessionsInPeriod(this.schedule, period, this.visibleSeriesPredicate, this.now);
    },
    followedIds(): Set<string> {
      return new Set([...this.followedSeries, ...this.followedDrivers.flatMap((d) => d.seriesIds)]);
    },
    /** En curso, primero lo que sigue el usuario. */
    liveItems(): GridItem[] {
      return this.window
        .filter((i) => i.live)
        .sort((a, b) => Number(this.followedIds.has(b.series.id)) - Number(this.followedIds.has(a.series.id)));
    },
    upcoming(): GridItem[] {
      return this.window.filter((i) => !i.live && !i.finished).slice(0, 15);
    },
  },
  methods: {
    time(iso: string): string {
      return DateTime.fromISO(iso, { zone: 'utc' }).setZone(this.timeZone).toFormat('HH:mm');
    },
    inText(iso: string): string {
      const min = Math.round((Date.parse(iso) - Date.parse(this.now)) / 60_000);
      if (min < 60) return `en ${Math.max(min, 0)} min`;
      const h = Math.floor(min / 60);
      return `en ${h} h ${String(min % 60).padStart(2, '0')} min`;
    },
  },
});
</script>

<style>
.upcoming-time {
  text-align: right;
}
</style>
