<template>
  <section v-if="items.length" class="card flush">
    <h3 class="card-title">{{ title }}</h3>
    <ul class="list-card inset">
      <li v-for="u in items" :key="u.event.id">
        <RouterLink :to="`/evento/${u.event.id}`" class="list-row">
          <SeriesCrest :series="u.series" :size="30" />
          <span class="grow">
            {{ u.event.name }}
            <span class="block small" :class="u.live ? 'live-text' : u.when.includes('confirmar') ? 'warn-text' : 'dim'">{{ u.when }}</span>
          </span>
          <AppIcon name="chevron" :size="16" class="dim" />
        </RouterLink>
      </li>
    </ul>
  </section>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapState } from 'pinia';
import { DateTime } from 'luxon';
import type { MotorEvent, Series } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import SeriesCrest from './SeriesCrest.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { nextEventOf } from '../lib/agenda.ts';

interface Upcoming {
  event: MotorEvent;
  series: Series;
  live: boolean;
  when: string;
}

/** Próximo evento de cada una de estas categorías (fichas de piloto y de equipo). */
export default defineComponent({
  name: 'UpcomingList',
  components: { AppIcon, SeriesCrest },
  props: {
    seriesIds: { type: Array as PropType<string[]>, required: true },
    title: { type: String, default: 'Próximas carreras' },
  },
  computed: {
    ...mapState(useScheduleStore, ['schedule', 'now', 'seriesById']),
    ...mapState(useSettingsStore, ['timeZone']),
    items(): Upcoming[] {
      const out: Upcoming[] = [];
      for (const id of new Set(this.seriesIds)) {
        const series = this.seriesById.get(id);
        const next = series ? nextEventOf(this.schedule, id, this.now) : null;
        if (!series || !next) continue;
        let when: string;
        if (next.live) when = `En vivo: ${next.nextSession!.name}`;
        else if (next.nextSession) {
          when =
            next.nextSession.name +
            ' · ' +
            DateTime.fromISO(next.nextSession.startUtc, { zone: 'utc' }).setZone(this.timeZone).setLocale('es-AR').toFormat("ccc d 'de' LLL, HH:mm");
        } else when = DateTime.fromISO(next.event.dateStart).setLocale('es-AR').toFormat("ccc d 'de' LLL") + ' · horarios a confirmar';
        out.push({ event: next.event, series, live: next.live, when });
      }
      return out.sort((a, b) => a.event.dateStart.localeCompare(b.event.dateStart));
    },
  },
});
</script>
