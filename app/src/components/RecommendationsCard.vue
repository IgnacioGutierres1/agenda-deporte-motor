<template>
  <section v-if="items.length" class="recommendations">
    <h2 class="section-title">{{ title }}</h2>
    <ul class="list-card">
      <li v-for="r in items" :key="`${r.kind}:${r.id}`">
        <SeriesRow v-if="r.kind === 'series' && seriesOf(r)" :series="seriesOf(r)!" :subtitle="r.reason" />
        <div v-else class="series-row">
          <RouterLink :to="r.to" class="list-row grow">
            <DriverAvatar v-if="r.kind === 'driver' || r.kind === 'team'" :name="r.title" :color="colorOf(r)" :size="30" />
            <span v-else class="rec-circuit" :style="{ background: colorOf(r) }"><AppIcon name="flag" :size="16" /></span>
            <span class="grow">
              {{ r.title }}
              <span class="block small dim">{{ r.reason }}</span>
            </span>
            <AppIcon v-if="r.kind === 'circuit'" name="chevron" :size="16" class="dim" />
          </RouterLink>
          <FollowButton v-if="r.kind === 'driver'" :driver="driverRef(r)" :name="r.title" compact />
          <FollowButton v-else-if="r.kind === 'team'" :team="teamRef(r)" :name="r.title" compact />
        </div>
      </li>
    </ul>
  </section>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import type { Series } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import DriverAvatar from './DriverAvatar.vue';
import FollowButton from './FollowButton.vue';
import SeriesRow from './SeriesRow.vue';
import { useDriversStore } from '../stores/drivers.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore, type FollowedDriver, type FollowedTeam } from '../stores/settings.ts';
import { useTeamsStore } from '../stores/teams.ts';
import { recommend, type Recommendation } from '../lib/recommend.ts';
import { seriesColor } from '../lib/grid.ts';
import { driverSeriesIds, teamSeriesIds } from '../lib/teams.ts';

/**
 * "Te puede interesar": sugerencias armadas en el dispositivo con lo que sigue el usuario
 * (ver lib/recommend.ts). Si no sigue nada, muestra lo que corre este finde.
 */
export default defineComponent({
  name: 'RecommendationsCard',
  components: { AppIcon, DriverAvatar, FollowButton, SeriesRow },
  props: {
    title: { type: String, default: 'Te puede interesar' },
    limit: { type: Number, default: 8 },
  },
  computed: {
    ...mapState(useScheduleStore, ['schedule', 'now', 'seriesById']),
    ...mapState(useSettingsStore, ['followedSeries', 'followedDrivers', 'followedTeams', 'hiddenSeries', 'timeZone']),
    ...mapState(useDriversStore, { driversFile: 'file', driversById: 'byId' }),
    ...mapState(useTeamsStore, { teams: 'teams', teamsById: 'byId' }),
    followsSomething(): boolean {
      return this.followedSeries.length > 0 || this.followsPeople;
    },
    /** Sigue pilotos o equipos: hacen falta los equipos. */
    followsPeople(): boolean {
      return this.followedDrivers.length > 0 || this.followedTeams.length > 0;
    },
    items(): Recommendation[] {
      return recommend({
        schedule: this.schedule,
        now: this.now,
        zone: this.timeZone,
        followedSeries: this.followedSeries,
        followedDrivers: this.followedDrivers,
        followedTeams: this.followedTeams,
        hiddenSeries: this.hiddenSeries,
        drivers: this.driversFile?.drivers ?? [],
        teams: this.followsPeople ? this.teams : [],
        limit: this.limit,
      });
    },
  },
  mounted() {
    // Pilotos y equipos solo hacen falta para las sugerencias basadas en pilotos, equipos y líderes.
    if (this.followsSomething) void this.loadDrivers();
    if (this.followsPeople) void this.loadTeams();
  },
  methods: {
    ...mapActions(useDriversStore, { loadDrivers: 'load' }),
    ...mapActions(useTeamsStore, { loadTeams: 'load' }),
    seriesOf(r: Recommendation): Series | undefined {
      return this.seriesById.get(r.id);
    },
    colorOf(r: Recommendation): string {
      return seriesColor(this.seriesById.get(r.seriesId ?? ''));
    },
    driverRef(r: Recommendation): FollowedDriver {
      const d = this.driversById.get(r.id);
      return { id: r.id, name: r.title, seriesIds: d ? driverSeriesIds(d) : r.seriesId ? [r.seriesId] : [] };
    },
    teamRef(r: Recommendation): FollowedTeam {
      const t = this.teamsById.get(r.id);
      return { id: r.id, name: r.title, seriesIds: t ? teamSeriesIds(t) : r.seriesId ? [r.seriesId] : [] };
    },
  },
});
</script>

<style>
.recommendations {
  margin-top: 1rem;
}

.rec-circuit {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  flex: none;
  border-radius: 50%;
  color: #fff;
}
</style>
