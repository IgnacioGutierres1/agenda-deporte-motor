<template>
  <div class="standings-panel">
    <div v-if="!available" class="card empty">
      <p>Todavía no hay tabla de campeonato de {{ series.name }}.</p>
      <p v-if="officialUrl" class="small dim">
        Se va a mostrar cuando el pipeline pueda leerla del sitio oficial. Mientras tanto:
        <a :href="officialUrl" target="_blank" rel="noopener noreferrer">sitio oficial</a>.
      </p>
    </div>
    <template v-else>
      <p v-if="!state || state.status === 'loading'" class="dim">Cargando campeonato…</p>
      <div v-else-if="state.status === 'missing'" class="card empty">
        <p>Sin datos todavía para {{ series.name }}.</p>
      </div>
      <div v-else-if="state.status === 'error'" class="notice notice-error">
        No se pudo cargar la tabla ({{ state.error }}).
        <button type="button" class="btn btn-small" @click="load(true)">Reintentar</button>
      </div>
      <template v-else-if="state.data">
        <p class="small dim">
          Temporada {{ state.data.season }} · actualizado {{ ago(state.data.updatedAt) }}<template v-if="chips"> · {{ titles.length }} tablas</template>
        </p>
        <template v-if="chips">
          <div
            v-for="row in chipRows"
            :key="row.key"
            v-tab-strip="`${series.id}-${row.key}`"
            class="session-chips standings-chips"
            role="tablist"
            :aria-label="row.label"
          >
            <button
              v-for="o in row.options"
              :key="o.label"
              type="button"
              role="tab"
              class="pill"
              :class="{ active: o.active }"
              :aria-selected="o.active"
              @click="selectTable(o.index)"
            >
              {{ o.label }}
            </button>
          </div>
        </template>
        <div v-for="table in shownTables" :key="table.title" class="standings-table card flush">
          <h3 class="card-title">{{ table.title }}</h3>
          <table class="data standings">
            <thead>
              <tr>
                <th class="num">#</th>
                <th class="name-col">{{ isTeams(table.title) ? 'Equipo' : 'Piloto' }}</th>
                <th v-if="hasCol(table.rows, 'wins')" class="num">V</th>
                <th class="num">Pts</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in table.rows"
                :key="`${row.pos}-${row.name}`"
                :class="{ leader: row.pos === 1, linked: !!rowLink(table.title, row) }"
                @click="openRow($event, rowLink(table.title, row))"
              >
                <td class="num pos">{{ row.pos }}</td>
                <td class="name-td">
                  <RouterLink v-if="rowLink(table.title, row)" :to="rowLink(table.title, row)" class="name-cell row-link">
                    <span v-if="row.number" class="car-number">{{ row.number }}</span>
                    <span class="grow">
                      <span class="row-name">{{ row.name }}</span>
                      <span v-if="row.team" class="small dim team">{{ row.team }}</span>
                    </span>
                  </RouterLink>
                  <div v-else class="name-cell row-link">
                    <span v-if="row.number" class="car-number">{{ row.number }}</span>
                    <span class="grow">
                      {{ row.name }}
                      <span v-if="row.team" class="small dim team">{{ row.team }}</span>
                    </span>
                  </div>
                </td>
                <td v-if="hasCol(table.rows, 'wins')" class="num">{{ row.wins ?? '' }}</td>
                <td class="num"><strong>{{ fmtNum(row.points) }}</strong></td>
              </tr>
            </tbody>
          </table>
        </div>
        <SourceLink :source="state.data.source" />
      </template>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapActions, mapState } from 'pinia';
import { driverId, isDriverTable, isSingleDriverName, teamId, type Series, type StandingsFile, type StandingsTable } from '@dm/shared';
import SourceLink from './SourceLink.vue';
import { initialTableIndex, tableChipRows, useTableChips, type ChipRow } from '../lib/standingsTables.ts';
import { tabStrip } from '../lib/tabStrip.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { useResultsStore, type Loaded } from '../stores/results.ts';
import { timeAgo } from '../lib/format.ts';

/**
 * Tablas del campeonato de una categoría (pilotos, equipos, marcas…). Con muchas tablas o clases
 * (24H Series, GTWC, Super Taikyu…) se muestra una por vez con pastillas para elegirla; la elegida
 * queda en el link (?tabla=…), así las fichas de pilotos y equipos pueden abrir la suya.
 */
export default defineComponent({
  name: 'StandingsPanel',
  components: { SourceLink },
  directives: { tabStrip },
  props: {
    series: { type: Object as PropType<Series>, required: true },
  },
  computed: {
    ...mapState(useScheduleStore, ['status', 'now']),
    ...mapState(useResultsStore, { standingsMap: 'standings' }),
    /** El pipeline informa si publicó la tabla; sin esa info (datos viejos) se intenta igual. */
    available(): boolean {
      const st = this.status?.series.find((s) => s.seriesId === this.series.id);
      return st ? st.standingsAvailable : true;
    },
    state(): Loaded<StandingsFile> | undefined {
      return this.standingsMap[this.series.id];
    },
    officialUrl(): string {
      return this.series.officialUrls[0] ?? '';
    },
    titles(): string[] {
      return (this.state?.data?.tables ?? []).map((t) => t.title);
    },
    chips(): boolean {
      return useTableChips(this.titles);
    },
    selectedIndex(): number {
      const q = this.$route?.query.tabla;
      return initialTableIndex(this.titles, typeof q === 'string' ? q : null);
    },
    chipRows(): ChipRow[] {
      return tableChipRows(this.titles, this.selectedIndex);
    },
    shownTables(): StandingsTable[] {
      const tables = this.state?.data?.tables ?? [];
      if (!this.chips) return tables;
      const t = tables[this.selectedIndex];
      return t ? [t] : [];
    },
  },
  watch: {
    'series.id': { immediate: true, handler() { void this.load(); } },
    available() {
      void this.load();
    },
  },
  methods: {
    ...mapActions(useResultsStore, ['loadStandings']),
    selectTable(index: number) {
      const title = this.titles[index];
      if (title === undefined) return;
      void this.$router.replace({ query: { ...this.$route.query, tabla: title } });
    },
    load(force = false) {
      if (!this.available) return;
      return this.loadStandings(this.series.id, force);
    },
    hasCol(rows: object[], key: string): boolean {
      return rows.some((r) => (r as Record<string, unknown>)[key] !== undefined && (r as Record<string, unknown>)[key] !== null);
    },
    /** Link a la ficha del piloto (solo en tablas de pilotos y nombres de un solo piloto). */
    driverLink(title: string, name: string): string {
      return isDriverTable(title) && isSingleDriverName(name) ? `/piloto/${driverId(name, this.series.id)}` : '';
    },
    /** Link a la ficha del equipo (no para tablas de marcas ni de propietarios). */
    teamTableLink(title: string, name: string): string {
      if (!/equipo|team|constructor|escuder/i.test(title) || /marca|manufacturer|fabricante|propietario|owner/i.test(title)) return '';
      return this.teamLink(name);
    },
    teamLink(name: string): string {
      const id = teamId(name);
      return id ? `/equipo/${id}` : '';
    },
    /**
     * A dónde lleva la fila: al piloto; si el nombre no es de un piloto solo (dupla, marca), al equipo.
     * El equipo de un piloto queda a un toque desde su ficha.
     */
    rowLink(title: string, row: { name: string; team?: string }): string {
      return this.driverLink(title, row.name) || this.teamTableLink(title, row.name) || (isDriverTable(title) && row.team ? this.teamLink(row.team) : '');
    },
    /** Toque en cualquier parte de la fila (posición, puntos): misma navegación que el link. */
    openRow(e: MouseEvent, to: string) {
      if (!to || (e.target as Element | null)?.closest?.('a')) return;
      void this.$router.push(to);
    },
    isTeams(title: string): boolean {
      return /equipo|team|marca|constructor|manufacturer|fabricante/i.test(title);
    },
    fmtNum(n: number): string {
      return n.toLocaleString('es-AR');
    },
    ago(iso: string): string {
      return timeAgo(iso, this.now);
    },
  },
});
</script>

<style>
.standings-table {
  margin: 0.75rem 0;
}

table.data.standings td,
table.data.standings th {
  padding: 0.55rem 0.6rem;
}

.standings-chips {
  padding-bottom: 0.4rem;
}

.standings-chips + .standings-chips {
  padding-top: 0;
}

table.data.standings tr.leader td.pos {
  color: var(--accent);
  font-weight: 800;
}

</style>
