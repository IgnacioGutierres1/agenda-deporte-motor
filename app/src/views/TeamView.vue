<template>
  <div class="team-view">
    <DataState />
    <p v-if="!team && pending" class="page dim">Cargando equipo…</p>
    <div v-else-if="!team && teamsStatus === 'error' && driversStatus === 'error'" class="page">
      <div class="notice notice-error">
        No se pudieron cargar los equipos ({{ teamsError }}).
        <button type="button" class="btn btn-small" @click="loadTeams(true)">Reintentar</button>
      </div>
    </div>
    <p v-else-if="!team" class="page card empty">
      No encontramos este equipo en las tablas de campeonato ni en las listas de inscriptos publicadas.
    </p>

    <template v-if="team">
      <section class="hero" :style="{ '--series-color': color }">
        <div class="hero-top">
          <div class="hero-series big">
            <DriverAvatar :name="team.name" :color="color" :size="58" />
            <div>
              <h1 class="hero-title tight">{{ team.name }}</h1>
              <p class="hero-sub">{{ subtitle }}</p>
            </div>
          </div>
        </div>
      </section>

      <div class="page">
        <section class="card flush">
          <h3 class="card-title">Categorías</h3>
          <ul class="list-card inset">
            <li v-for="e in entries" :key="`${e.seriesId}-${e.table ?? ''}`" class="stretch">
              <div class="list-row">
                <SeriesCrest v-if="e.series" :series="e.series" :size="30" />
                <span class="grow">
                  <RouterLink :to="`/categoria/${e.seriesId}?tab=${e.pos ? 'tabla' : 'plantel'}`" class="stretch-link">
                    {{ e.series?.shortName ?? e.seriesId }}<template v-if="e.table"> · {{ e.table }}</template>
                  </RouterLink>
                  <span v-if="e.detail" class="block small dim">{{ e.detail }}</span>
                  <span v-if="e.vehicleText" class="block small dim">{{ e.vehicleText }}</span>
                </span>
                <span v-if="e.pos" class="pos-badge" :class="{ top: e.pos <= 3 }">P{{ e.pos }}</span>
              </div>
            </li>
          </ul>
        </section>

        <section v-if="driverGroups.length" class="card flush">
          <h3 class="card-title">Pilotos</h3>
          <template v-for="g in driverGroups" :key="g.seriesId">
            <p v-if="driverGroups.length > 1" class="team-group-title small dim">{{ g.label }}</p>
            <ul class="list-card inset">
              <li v-for="d in g.drivers" :key="`${g.seriesId}-${d.id}`">
                <RouterLink :to="`/piloto/${d.id}`" class="list-row">
                  <DriverAvatar :name="d.name" :color="g.color" :size="34" />
                  <span class="grow">{{ d.name }}</span>
                  <span v-if="d.number" class="car-number">#{{ d.number }}</span>
                  <AppIcon name="chevron" :size="16" class="dim" />
                </RouterLink>
              </li>
            </ul>
          </template>
        </section>

        <UpcomingList :series-ids="seriesIds" />

        <section v-if="teamNews.length" class="card">
          <h3>Noticias</h3>
          <NewsList :items="teamNews" :featured="false" />
        </section>

        <p class="small dim center">
          <template v-if="derived">Armado con las tablas de pilotos publicadas (todavía no hay índice de equipos).</template>
          <template v-else>Datos de las tablas de equipos y listas de inscriptos oficiales de cada categoría.</template>
        </p>
      </div>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import type { NewsItem, Series, Team, TeamDriver, TeamEntry } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import DataState from '../components/DataState.vue';
import DriverAvatar from '../components/DriverAvatar.vue';
import NewsList from '../components/NewsList.vue';
import SeriesCrest from '../components/SeriesCrest.vue';
import UpcomingList from '../components/UpcomingList.vue';
import { useDriversStore } from '../stores/drivers.ts';
import { useNewsStore } from '../stores/news.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { useTeamsStore } from '../stores/teams.ts';
import { seriesColor } from '../lib/grid.ts';
import { newsForTeam } from '../lib/teams.ts';

interface EntryRow extends TeamEntry {
  series?: Series;
  detail: string;
  vehicleText: string;
}

const byNumber = (a: TeamDriver, b: TeamDriver) =>
  (Number.parseInt(a.number ?? '', 10) || 9999) - (Number.parseInt(b.number ?? '', 10) || 9999) || a.name.localeCompare(b.name, 'es');

/** Ficha de un equipo: categorías en las que corre, pilotos, próximas carreras y noticias. */
export default defineComponent({
  name: 'TeamView',
  components: { AppIcon, DataState, DriverAvatar, NewsList, SeriesCrest, UpcomingList },
  computed: {
    ...mapState(useTeamsStore, { teamsById: 'byId', teamsStatus: 'status', teamsError: 'error', pending: 'pending', derived: 'derived', allTeams: 'teams' }),
    ...mapState(useDriversStore, { driversStatus: 'status' }),
    ...mapState(useScheduleStore, ['seriesById']),
    ...mapState(useNewsStore, { newsItems: 'items' }),
    team(): Team | undefined {
      return this.teamsById.get(String(this.$route.params.teamId));
    },
    seriesIds(): string[] {
      return [...new Set([...(this.team?.entries ?? []).map((e) => e.seriesId), ...(this.team?.drivers ?? []).map((d) => d.seriesId)])];
    },
    color(): string {
      return seriesColor(this.seriesById.get(this.seriesIds[0] ?? ''));
    },
    subtitle(): string {
      return this.seriesIds.map((id) => this.seriesById.get(id)?.shortName ?? id).join(' · ');
    },
    entries(): EntryRow[] {
      return (this.team?.entries ?? []).map((e) => {
        const parts: string[] = [];
        if (e.points !== undefined) parts.push(`${e.points.toLocaleString('es-AR')} pts`);
        if (e.numbers?.length) parts.push(e.numbers.map((n) => `#${n}`).join(' '));
        if (e.classes?.length) parts.push(e.classes.join(', '));
        return { ...e, series: this.seriesById.get(e.seriesId), detail: parts.join(' · '), vehicleText: (e.vehicles ?? []).join(' · ') };
      });
    },
    driverGroups(): Array<{ seriesId: string; label: string; color: string; drivers: TeamDriver[] }> {
      return this.seriesIds
        .map((id) => {
          const series = this.seriesById.get(id);
          return {
            seriesId: id,
            label: series?.name ?? id,
            color: seriesColor(series),
            drivers: (this.team?.drivers ?? []).filter((d) => d.seriesId === id).sort(byNumber),
          };
        })
        .filter((g) => g.drivers.length);
    },
    teamNews(): NewsItem[] {
      return this.team ? newsForTeam(this.newsItems, this.team, this.allTeams).slice(0, 5) : [];
    },
  },
  watch: {
    '$route.params.teamId': {
      immediate: true,
      handler() {
        void this.loadTeams();
        void this.loadNews();
      },
    },
  },
  methods: {
    ...mapActions(useTeamsStore, { loadTeams: 'load' }),
    ...mapActions(useNewsStore, { loadNews: 'load' }),
  },
});
</script>

<style>
.team-group-title {
  margin: 0;
  padding: 0.5rem 0.85rem 0.15rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  font-size: 0.72rem;
}
</style>
