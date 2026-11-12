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
    <NotFoundCard v-else-if="!team" kind="equipo" :slug="String($route.params.teamId ?? '')" />

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
        <div class="hero-actions">
          <FollowButton :team="followRef" :name="team.name" />
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
                  <RouterLink :to="`/categoria/${e.seriesId}?tab=${e.pos ? 'tabla' : 'plantel'}${e.pos && e.table ? `&tabla=${encodeURIComponent(e.table)}` : ''}`" class="stretch-link">
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

        <UpcomingList :series-ids="seriesIds" />

        <section v-if="rosterGroups.length" class="card flush team-roster">
          <h3 class="card-title">Pilotos</h3>
          <div v-for="g in rosterGroups" :key="g.seriesId" class="roster-group">
            <!-- Con una sola categoría no hace falta desplegar nada. -->
            <button
              v-if="rosterGroups.length > 1"
              type="button"
              class="list-row roster-head"
              :aria-expanded="isOpen(g.seriesId)"
              :aria-controls="`roster-${g.seriesId}`"
              @click="toggleGroup(g.seriesId)"
            >
              <SeriesCrest v-if="g.series" :series="g.series" :size="30" />
              <span class="grow">
                {{ g.label }}
                <span class="block small dim">{{ g.drivers.length }} {{ g.drivers.length === 1 ? 'piloto' : 'pilotos' }}</span>
              </span>
              <AppIcon name="chevron" :size="18" class="roster-chev" :class="{ open: isOpen(g.seriesId) }" />
            </button>
            <ul v-if="rosterGroups.length === 1 || isOpen(g.seriesId)" :id="`roster-${g.seriesId}`" class="list-card inset roster-list">
              <li v-for="d in g.drivers" :key="d.id">
                <RouterLink :to="`/piloto/${d.id}`" class="list-row">
                  <DriverAvatar :name="d.name" :color="g.color" :size="34" />
                  <span class="grow">{{ d.name }}</span>
                  <span v-for="n in d.numbers" :key="n" class="car-number">#{{ n }}</span>
                  <AppIcon name="chevron" :size="16" class="dim" />
                </RouterLink>
              </li>
            </ul>
          </div>
        </section>

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
import type { NewsItem, Series, Team, TeamEntry } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import DataState from '../components/DataState.vue';
import DriverAvatar from '../components/DriverAvatar.vue';
import FollowButton from '../components/FollowButton.vue';
import NewsList from '../components/NewsList.vue';
import NotFoundCard from '../components/NotFoundCard.vue';
import SeriesCrest from '../components/SeriesCrest.vue';
import UpcomingList from '../components/UpcomingList.vue';
import { useDriversStore } from '../stores/drivers.ts';
import { useNewsStore } from '../stores/news.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { useTeamsStore } from '../stores/teams.ts';
import type { FollowedTeam } from '../stores/settings.ts';
import { seriesColor } from '../lib/grid.ts';
import { newsForTeam, teamRoster, teamSeriesIds, type TeamRosterDriver } from '../lib/teams.ts';

interface EntryRow extends TeamEntry {
  series?: Series;
  detail: string;
  vehicleText: string;
}

interface RosterGroupView {
  seriesId: string;
  series?: Series;
  label: string;
  color: string;
  drivers: TeamRosterDriver[];
}

/** Ficha de un equipo: categorías en las que corre, pilotos, próximas carreras y noticias. */
export default defineComponent({
  name: 'TeamView',
  components: { AppIcon, DataState, DriverAvatar, FollowButton, NewsList, NotFoundCard, SeriesCrest, UpcomingList },
  data() {
    return {
      /** Categorías del plantel abiertas a mano; null = la predeterminada (solo la primera). */
      openRoster: null as string[] | null,
    };
  },
  computed: {
    ...mapState(useTeamsStore, { teamsById: 'byId', teamsStatus: 'status', teamsError: 'error', pending: 'pending', derived: 'derived', allTeams: 'teams' }),
    ...mapState(useDriversStore, { driversStatus: 'status' }),
    ...mapState(useScheduleStore, ['seriesById']),
    ...mapState(useNewsStore, { newsItems: 'items' }),
    team(): Team | undefined {
      return this.teamsById.get(String(this.$route.params.teamId));
    },
    seriesIds(): string[] {
      return this.team ? teamSeriesIds(this.team) : [];
    },
    followRef(): FollowedTeam | null {
      if (!this.team) return null;
      return { id: this.team.id, name: this.team.name, seriesIds: this.seriesIds };
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
    /** Plantel por categoría, sin pilotos repetidos (antes era una lista de ~50 renglones seguidos). */
    rosterGroups(): RosterGroupView[] {
      if (!this.team) return [];
      return teamRoster(this.team, this.seriesIds).map((g) => {
        const series = this.seriesById.get(g.seriesId);
        return { seriesId: g.seriesId, series, label: series?.name ?? g.seriesId, color: seriesColor(series), drivers: g.drivers };
      });
    },
    teamNews(): NewsItem[] {
      return this.team ? newsForTeam(this.newsItems, this.team, this.allTeams).slice(0, 5) : [];
    },
  },
  watch: {
    '$route.params.teamId': {
      immediate: true,
      handler() {
        this.openRoster = null;
        void this.loadTeams();
        void this.loadNews();
      },
    },
  },
  methods: {
    ...mapActions(useTeamsStore, { loadTeams: 'load' }),
    isOpen(seriesId: string): boolean {
      return this.openRoster ? this.openRoster.includes(seriesId) : this.rosterGroups[0]?.seriesId === seriesId;
    },
    toggleGroup(seriesId: string) {
      const current = this.openRoster ?? this.rosterGroups.slice(0, 1).map((g) => g.seriesId);
      this.openRoster = current.includes(seriesId) ? current.filter((id) => id !== seriesId) : [...current, seriesId];
    },
    ...mapActions(useNewsStore, { loadNews: 'load' }),
  },
});
</script>

<style>
.roster-group + .roster-group {
  border-top: 1px solid var(--border);
}

.roster-head {
  width: 100%;
  border: none;
  background: none;
  text-align: left;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

.roster-chev {
  flex: none;
  transition: transform 0.15s;
}

.roster-chev.open {
  transform: rotate(90deg);
}

.roster-list .car-number + .car-number {
  margin-left: -0.35rem;
}

/* En pantallas anchas el plantel va en dos columnas en vez de una lista larga. */
@media (min-width: 900px) {
  .roster-list {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .list-card.roster-list > li {
    border-top: 1px solid var(--border);
  }
}
</style>
