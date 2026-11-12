<template>
  <section v-if="visible" class="starter-pack" :class="`starter-${variant}`">
    <template v-if="variant === 'chips'">
      <p class="small dim starter-hint">{{ title }}</p>
      <div class="starter-chips" role="group" aria-label="Empezá por acá">
        <button
          v-for="it in shown"
          :key="`${it.kind}:${it.id}`"
          type="button"
          class="pill starter-chip"
          :class="{ active: isOn(it) }"
          :aria-pressed="isOn(it)"
          :title="it.reason"
          @click="toggle(it)"
        >
          <AppIcon name="star" :size="15" :filled="isOn(it)" />
          {{ chipLabel(it) }}
        </button>
      </div>
    </template>

    <template v-else>
      <div class="section-head">
        <h2 class="section-title">{{ title }}</h2>
        <span class="small dim">{{ progress }}</span>
      </div>
      <ul class="list-card">
        <li v-for="it in shown" :key="`${it.kind}:${it.id}`">
          <SeriesRow v-if="it.kind === 'series' && seriesOf(it)" :series="seriesOf(it)!" :subtitle="it.reason" />
          <div v-else class="series-row">
            <RouterLink :to="`/piloto/${it.id}`" class="list-row grow">
              <DriverAvatar :name="it.title" :color="colorOf(it)" :size="30" />
              <span class="grow">
                {{ it.title }}
                <span class="block small dim one-line">{{ it.reason }}</span>
              </span>
            </RouterLink>
            <FollowButton :driver="driverRef(it)" :name="it.title" compact />
          </div>
        </li>
      </ul>
    </template>
  </section>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapActions, mapState } from 'pinia';
import { eventInPeriod, resolvePeriod, type Series, type StandingsFile } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import DriverAvatar from './DriverAvatar.vue';
import FollowButton from './FollowButton.vue';
import SeriesRow from './SeriesRow.vue';
import { useDriversStore } from '../stores/drivers.ts';
import { useResultsStore } from '../stores/results.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore, type FollowedDriver } from '../stores/settings.ts';
import { followCount, starterPack, STARTER_HIDE_AT, STARTER_LEADERS, type StarterItem } from '../lib/onboarding.ts';
import { seriesColor } from '../lib/grid.ts';

/**
 * "Empezá por acá" (ver lib/onboarding.ts): categorías y pilotos para seguir de un toque mientras
 * se siguen menos de 3 cosas. En lista (Buscar, Siguiendo) o en pastillas (Agenda).
 */
export default defineComponent({
  name: 'StarterPack',
  components: { AppIcon, DriverAvatar, FollowButton, SeriesRow },
  props: {
    title: { type: String, default: 'Empezá por acá' },
    variant: { type: String as PropType<'list' | 'chips'>, default: 'list' },
    /** Qué mostrar: categorías, pilotos o ambos. */
    kinds: { type: Array as PropType<Array<StarterItem['kind']>>, default: () => ['series', 'driver'] },
  },
  computed: {
    ...mapState(useScheduleStore, ['schedule', 'now', 'seriesById']),
    ...mapState(useSettingsStore, ['followedSeries', 'followedDrivers', 'followedTeams', 'timeZone']),
    ...mapState(useDriversStore, { driversById: 'byId', driversStatus: 'status' }),
    ...mapState(useResultsStore, { standingsMap: 'standings' }),
    count(): number {
      return followCount(this);
    },
    racing(): string[] {
      if (!this.schedule) return [];
      const weekend = resolvePeriod('este-finde', this.now, { zone: this.timeZone });
      return this.schedule.events.filter((e) => eventInPeriod(weekend, e.dateStart, e.dateEnd, e.tz)).map((e) => e.seriesId);
    },
    items(): StarterItem[] {
      const standings: Record<string, StandingsFile | undefined> = {};
      for (const id of STARTER_LEADERS) standings[id] = this.standingsMap[id]?.data;
      return starterPack({
        series: this.schedule?.series ?? [],
        standings,
        // Mientras no se descargó el índice, los pilotos fijos se muestran por su id.
        drivers: this.driversStatus === 'ok' ? this.driversById : null,
        racingThisWeekend: this.racing,
      });
    },
    shown(): StarterItem[] {
      return this.items.filter((it) => this.kinds.includes(it.kind));
    },
    visible(): boolean {
      return this.count < STARTER_HIDE_AT && this.shown.length > 0;
    },
    progress(): string {
      return this.count ? `Seguís ${this.count} de ${STARTER_HIDE_AT}` : 'Tocá ★ para seguir';
    },
  },
  mounted() {
    if (this.count >= STARTER_HIDE_AT) return;
    for (const id of STARTER_LEADERS) void this.loadStandings(id);
    // En la Agenda no se baja el índice de pilotos solo para esto.
    if (this.variant === 'list' && this.kinds.includes('driver')) void this.loadDrivers();
  },
  methods: {
    ...mapActions(useResultsStore, ['loadStandings']),
    ...mapActions(useDriversStore, { loadDrivers: 'load' }),
    ...mapActions(useSettingsStore, ['toggleFollow', 'toggleFollowDriver']),
    seriesOf(it: StarterItem): Series | undefined {
      return this.seriesById.get(it.id);
    },
    colorOf(it: StarterItem): string {
      return seriesColor(this.seriesById.get(it.seriesId));
    },
    driverRef(it: StarterItem): FollowedDriver {
      return { id: it.id, name: it.title, seriesIds: it.seriesIds };
    },
    isOn(it: StarterItem): boolean {
      return it.kind === 'series' ? this.followedSeries.includes(it.id) : this.followedDrivers.some((d) => d.id === it.id);
    },
    toggle(it: StarterItem) {
      if (it.kind === 'series') this.toggleFollow(it.id);
      else this.toggleFollowDriver(this.driverRef(it));
    },
    chipLabel(it: StarterItem): string {
      return it.kind === 'series' ? (this.seriesOf(it)?.shortName ?? it.title) : it.title;
    },
  },
});
</script>

<style>
.starter-pack.starter-list {
  margin-top: 1rem;
}

.starter-hint {
  margin: 0.6rem 0 0.4rem;
  text-align: center;
  font-weight: 700;
}

.starter-chips {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.4rem;
}

.starter-chip.active {
  background: color-mix(in srgb, var(--warn) 22%, var(--bg-elev-2));
  color: var(--text);
}

.starter-chip svg {
  color: var(--warn);
}
</style>
