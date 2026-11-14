<template>
  <div class="series-history">
    <section v-if="hasProfile" class="card bio-card">
      <h3>Historia</h3>
      <div v-if="history.logo || facts.length" class="bio-profile">
        <BioImage v-if="history.logo" :image="history.logo" :alt="`Logo de ${series.name}`" variant="logo" :width="112" />
        <dl v-if="facts.length" class="bio-facts">
          <div v-for="f in facts" :key="f.label" class="bio-fact">
            <dt>{{ f.label }}</dt>
            <dd>{{ f.value }}</dd>
          </div>
        </dl>
      </div>
      <BioSummary v-if="history.summary" :summary="history.summary" class="bio-summary-block" />
    </section>

    <section v-if="history.records?.length" class="card flush">
      <h3 class="card-title">Récords</h3>
      <dl class="list-card inset series-records">
        <div v-for="r in history.records" :key="r.label" class="list-row series-record">
          <dt class="small dim">{{ r.label }}</dt>
          <dd>{{ r.value }}</dd>
        </div>
      </dl>
    </section>

    <section v-if="champions.length" class="card flush">
      <h3 class="card-title">Campeones</h3>
      <table class="data champions-table">
        <thead>
          <tr>
            <th class="num">Año</th>
            <th class="name-col">Campeón</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(c, i) in shown" :key="i" :class="{ 'season-start': c.firstOfSeason && i > 0 }">
            <td class="num champions-year">{{ c.firstOfSeason ? c.season : '' }}</td>
            <td class="champions-cell">
              <span v-if="c.note" class="block small dim">{{ c.note }}</span>
              <span v-if="c.members.length" class="champions-driver">
                <template v-for="(m, j) in c.members" :key="j">
                  <template v-if="j > 0"> / </template>
                  <RouterLink v-if="m.link" :to="m.link" class="tap-inline">{{ m.name }}</RouterLink>
                  <template v-else>{{ m.name }}</template>
                </template>
              </span>
              <span v-if="c.team || c.vehicle" class="block small">
                <RouterLink v-if="c.teamLink" :to="c.teamLink" class="tap-inline team-link">{{ c.team }}</RouterLink>
                <span v-else-if="c.team" :class="{ 'champions-team-only': !c.members.length }">{{ c.team }}</span>
                <span v-if="c.vehicle" class="dim"><template v-if="c.team"> · </template>{{ c.vehicle }}</span>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      <div v-if="champions.length > limit" class="card-foot">
        <button type="button" class="link-btn small" :aria-expanded="all" @click="all = !all">
          {{ all ? 'Ver menos' : `Ver todos los campeones (${seasonCount} temporadas)` }}
        </button>
      </div>
      <p v-if="history.championsSource" class="card-foot small dim">
        Fuente:
        <a :href="history.championsSource.url" target="_blank" rel="noopener noreferrer" class="tap-inline">{{ history.championsSource.title }}</a>
      </p>
    </section>

    <p v-if="!hasProfile && !champions.length && !history.records?.length" class="card empty dim">
      Todavía no hay datos de la historia de {{ series.name }}.
    </p>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapActions, mapState } from 'pinia';
import { teamId, type Series, type SeriesChampion, type SeriesHistory } from '@dm/shared';
import BioImage from './BioImage.vue';
import BioSummary from './BioSummary.vue';
import { useDriversStore } from '../stores/drivers.ts';
import { useTeamsStore } from '../stores/teams.ts';
import { crewMembers } from '../lib/classes.ts';

interface ChampionView extends SeriesChampion {
  firstOfSeason: boolean;
  members: Array<{ name: string; link: string }>;
  teamLink: string;
}

/**
 * Pestaña "Historia" de una categoría: resumen, fundación, organizador, logo, récords y campeones por temporada
 * (con enlaces a los pilotos y equipos que están en la app).
 */
export default defineComponent({
  name: 'SeriesHistoryPanel',
  components: { BioImage, BioSummary },
  props: {
    series: { type: Object as PropType<Series>, required: true },
    history: { type: Object as PropType<SeriesHistory>, required: true },
    limit: { type: Number, default: 15 },
  },
  data() {
    return { all: false };
  },
  computed: {
    ...mapState(useDriversStore, { driversById: 'byId', driversStatus: 'status' }),
    ...mapState(useTeamsStore, { teamsById: 'byId', teamsStatus: 'status' }),
    hasProfile(): boolean {
      const h = this.history;
      return !!(h.logo || h.summary || h.founded || h.organizer);
    },
    facts(): Array<{ label: string; value: string }> {
      const out: Array<{ label: string; value: string }> = [];
      if (this.history.founded) out.push({ label: 'Primera temporada', value: String(this.history.founded) });
      if (this.history.organizer) out.push({ label: 'Organiza', value: this.history.organizer });
      const titles = new Set(this.history.champions.map((c) => c.season)).size;
      if (titles) out.push({ label: 'Campeones registrados', value: `${titles} ${titles === 1 ? 'temporada' : 'temporadas'}` });
      return out;
    },
    champions(): ChampionView[] {
      const sorted = [...this.history.champions].sort((a, b) => b.season - a.season);
      return sorted.map((c, i) => ({
        ...c,
        firstOfSeason: i === 0 || sorted[i - 1]!.season !== c.season,
        members: this.membersOf(c),
        teamLink: this.teamLinkOf(c),
      }));
    },
    shown(): ChampionView[] {
      if (this.all || this.champions.length <= this.limit) return this.champions;
      const cut = this.champions.findIndex((c, i) => i >= this.limit && c.firstOfSeason);
      return cut < 0 ? this.champions : this.champions.slice(0, cut);
    },
    seasonCount(): number {
      return new Set(this.history.champions.map((c) => c.season)).size;
    },
    /** Hay tripulaciones campeonas sin id (resistencia): hace falta el índice para saber quién tiene ficha. */
    needsIndex(): boolean {
      return this.history.champions.some((c) => !c.driverId && !!c.driver && crewMembers(c.driver).length > 1);
    },
  },
  watch: {
    needsIndex: {
      immediate: true,
      handler(value: boolean) {
        if (value) void this.loadDrivers();
      },
    },
  },
  methods: {
    ...mapActions(useDriversStore, { loadDrivers: 'load' }),
    /** Un piloto con ficha en la app lleva enlace; en una tripulación, cada integrante por separado. */
    membersOf(c: SeriesChampion): Array<{ name: string; link: string }> {
      if (!c.driver) return [];
      // driverId viene solo si el piloto figura en la app.
      if (c.driverId) return [{ name: c.driver, link: `/piloto/${c.driverId}` }];
      return crewMembers(c.driver, this.series.id).map((m) => ({
        name: m.name,
        link: m.id && this.hasDriver(m.id) ? `/piloto/${m.id}` : '',
      }));
    },
    /** Integrantes de tripulaciones: se enlazan solo si el índice de pilotos (que se pide si hace falta) los tiene. */
    hasDriver(id: string): boolean {
      return this.driversStatus === 'ok' && this.driversById.has(id);
    },
    /** teamId viene solo si el equipo figura en la app; si no, se prueba con el índice de equipos si ya está. */
    teamLinkOf(c: SeriesChampion): string {
      if (c.teamId) return `/equipo/${c.teamId}`;
      if (!c.team || this.teamsStatus !== 'ok') return '';
      const id = teamId(c.team);
      return this.teamsById.has(id) ? `/equipo/${id}` : '';
    },
  },
});
</script>

<style>
.series-records {
  margin: 0;
}

.series-record {
  flex-direction: column;
  align-items: flex-start;
  gap: 0.1rem;
}

.series-record dd {
  margin: 0;
  font-weight: 600;
  overflow-wrap: anywhere;
}

.champions-table td {
  vertical-align: top;
}

.champions-table .champions-year {
  width: 3.2rem;
  font-weight: 700;
}

.champions-table tr.season-start td {
  border-top: 1px solid var(--border);
}

.champions-table td.champions-cell {
  white-space: normal;
  overflow-wrap: anywhere;
}

.champions-driver,
.champions-team-only {
  font-weight: 700;
}
</style>
