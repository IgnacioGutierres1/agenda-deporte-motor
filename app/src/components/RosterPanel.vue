<template>
  <div class="roster-panel">
    <p v-if="!roster || roster.status === 'loading' || (fallbackPending && !rows.length)" class="dim">Cargando plantel…</p>
    <div v-else-if="roster.status === 'error'" class="notice notice-error">
      No se pudo cargar la lista de inscriptos ({{ roster.error }}).
      <button type="button" class="btn btn-small" @click="load(true)">Reintentar</button>
    </div>
    <div v-else-if="!rows.length && !fallbackTeams.length" class="card empty">
      <p>Todavía no hay lista de inscriptos de {{ series.name }}.</p>
      <p v-if="officialUrl" class="small dim">
        Se va a mostrar cuando el pipeline la publique. Mientras tanto:
        <a :href="officialUrl" target="_blank" rel="noopener noreferrer">sitio oficial</a>.
      </p>
    </div>

    <template v-else>
      <p class="small dim">
        <template v-if="roster.data">Temporada {{ roster.data.season }} · actualizado {{ ago(roster.data.updatedAt) }} · </template>
        {{ summary }}
      </p>
      <p v-if="!roster.data" class="notice notice-warn small">
        Todavía no hay lista oficial de inscriptos: estos son los pilotos y equipos de la tabla del campeonato.
      </p>

      <div v-if="classes.length > 1" v-tab-strip="series.id" class="session-chips" role="tablist" aria-label="Clases">
        <button type="button" class="pill" :class="{ active: !selectedClass }" @click="selectedClass = ''">Todas</button>
        <button
          v-for="c in classes"
          :key="c"
          type="button"
          class="pill"
          :class="{ active: selectedClass === c }"
          @click="selectedClass = c"
        >
          {{ c }}
        </button>
      </div>

      <section v-for="t in namedTeams" :key="t.key" class="card flush roster-team">
        <h3 class="card-title roster-team-title">
          <RouterLink :to="`/equipo/${t.teamId}`" class="driver-link">{{ t.name }}</RouterLink>
          <AppIcon name="chevron" :size="14" class="dim" />
        </h3>
        <ul class="list-card inset">
          <li v-for="car in t.cars" :key="car.key">
            <RosterCarRow :car="car" :show-class="!selectedClass && classes.length > 1" />
          </li>
        </ul>
      </section>

      <ul v-if="loneCars.length" class="list-card">
        <li v-for="car in loneCars" :key="car.key">
          <RosterCarRow :car="car" :show-class="!selectedClass && classes.length > 1" />
        </li>
      </ul>

      <section v-if="fallbackTeams.length" class="card flush">
        <h3 class="card-title">Equipos</h3>
        <ul class="list-card inset">
          <li v-for="t in fallbackTeams" :key="t.id">
            <RouterLink :to="`/equipo/${t.id}`" class="list-row">
              <DriverAvatar :name="t.name" :color="color" :size="30" />
              <span class="grow">{{ t.name }}</span>
              <AppIcon name="chevron" :size="16" class="dim" />
            </RouterLink>
          </li>
        </ul>
      </section>

      <SourceLink v-if="roster.data" :source="roster.data.source" />
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapActions, mapState } from 'pinia';
import { teamId, type RosterFile, type RosterRow, type Series, type StandingsFile } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import DriverAvatar from './DriverAvatar.vue';
import RosterCarRow from './RosterCarRow.vue';
import SourceLink from './SourceLink.vue';
import { useRostersStore } from '../stores/rosters.ts';
import { useResultsStore, type Loaded } from '../stores/results.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { groupRoster, rosterClasses, rosterFromStandings, type RosterCar, type RosterTeam } from '../lib/roster.ts';
import { seriesColor } from '../lib/grid.ts';
import { timeAgo } from '../lib/format.ts';
import { tabStrip } from '../lib/tabStrip.ts';

/** Plantel de una categoría: inscriptos agrupados por equipo y auto, con filtro por clase. */
export default defineComponent({
  name: 'RosterPanel',
  components: { AppIcon, DriverAvatar, RosterCarRow, SourceLink },
  directives: { tabStrip },
  props: {
    series: { type: Object as PropType<Series>, required: true },
  },
  data() {
    return { selectedClass: '' };
  },
  computed: {
    ...mapState(useRostersStore, ['rosters']),
    ...mapState(useResultsStore, { standingsMap: 'standings' }),
    ...mapState(useScheduleStore, ['status', 'now']),
    roster(): Loaded<RosterFile> | undefined {
      return this.rosters[this.series.id];
    },
    /** Sin lista de inscriptos se usa la tabla del campeonato. */
    useFallback(): boolean {
      return this.roster?.status === 'missing';
    },
    standingsAvailable(): boolean {
      const st = this.status?.series.find((s) => s.seriesId === this.series.id);
      return st ? st.standingsAvailable : true;
    },
    standings(): Loaded<StandingsFile> | undefined {
      return this.standingsMap[this.series.id];
    },
    fallbackPending(): boolean {
      return this.useFallback && this.standingsAvailable && (!this.standings || this.standings.status === 'loading');
    },
    fallback(): { rows: RosterRow[]; teams: string[] } {
      return this.useFallback && this.standings?.data ? rosterFromStandings(this.standings.data) : { rows: [], teams: [] };
    },
    rows(): RosterRow[] {
      return this.roster?.data?.rows ?? this.fallback.rows;
    },
    classes(): string[] {
      return rosterClasses(this.rows);
    },
    groups(): RosterTeam[] {
      return groupRoster(this.rows, this.classes.includes(this.selectedClass) ? this.selectedClass : '');
    },
    namedTeams(): RosterTeam[] {
      return this.groups.filter((g) => g.name);
    },
    loneCars(): RosterCar[] {
      return this.groups.filter((g) => !g.name).flatMap((g) => g.cars);
    },
    /** Equipos de las tablas de equipos, solo si los pilotos no traen su equipo. */
    fallbackTeams(): Array<{ id: string; name: string }> {
      if (this.namedTeams.length) return [];
      return this.fallback.teams.map((name) => ({ id: teamId(name), name })).filter((t) => t.id);
    },
    summary(): string {
      const drivers = this.groups.reduce((n, g) => n + g.cars.reduce((m, c) => m + c.drivers.length, 0), 0);
      const teams = this.namedTeams.length || this.fallbackTeams.length;
      const parts = [`${drivers} ${drivers === 1 ? 'piloto' : 'pilotos'}`];
      if (teams) parts.push(`${teams} ${teams === 1 ? 'equipo' : 'equipos'}`);
      return parts.join(' · ');
    },
    color(): string {
      return seriesColor(this.series);
    },
    officialUrl(): string {
      return this.series.rosterUrls?.[0] ?? this.series.officialUrls[0] ?? '';
    },
  },
  watch: {
    'series.id': {
      immediate: true,
      handler() {
        this.selectedClass = '';
        void this.load();
      },
    },
    useFallback(value: boolean) {
      if (value && this.standingsAvailable) void this.loadStandings(this.series.id);
    },
  },
  methods: {
    ...mapActions(useRostersStore, ['loadRoster']),
    ...mapActions(useResultsStore, ['loadStandings']),
    async load(force = false) {
      await this.loadRoster(this.series.id, force);
      if (this.useFallback && this.standingsAvailable) void this.loadStandings(this.series.id);
    },
    ago(iso: string): string {
      return timeAgo(iso, this.now);
    },
  },
});
</script>

<style>
.roster-team {
  margin: 0 0 0.75rem;
}

.roster-team-title {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}
</style>
