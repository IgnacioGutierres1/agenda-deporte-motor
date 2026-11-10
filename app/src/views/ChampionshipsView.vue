<template>
  <div class="page champs-view">
    <DataState />

    <template v-if="hasData">
      <label class="field">
        <span>Categoría</span>
        <select class="input" :value="seriesId" @change="selectSeries(($event.target as HTMLSelectElement).value)">
          <option value="" disabled>Elegí una categoría</option>
          <optgroup v-for="g in seriesGroups" :key="g.group" :label="g.label">
            <option v-for="i in g.items" :key="i.series.id" :value="i.series.id">{{ i.series.name }}</option>
          </optgroup>
        </select>
      </label>

      <p v-if="!series" class="card empty dim">Elegí una categoría para ver el campeonato y los resultados.</p>

      <template v-else>
        <div class="tabs" role="tablist">
          <button
            v-for="t in tabs"
            :key="t.id"
            type="button"
            role="tab"
            class="tab"
            :class="{ active: tab === t.id }"
            :aria-selected="tab === t.id"
            @click="setTab(t.id)"
          >
            {{ t.label }}
          </button>
        </div>

        <!-- Campeonato -->
        <section v-if="tab === 'campeonato'">
          <p v-if="!standings || standings.status === 'loading'" class="dim">Cargando campeonato…</p>
          <p v-else-if="standings.status === 'missing'" class="card empty">
            Sin datos todavía para {{ series.name }}.
            <span v-if="series.officialUrls[0]" class="small">
              Mientras tanto, mirá el
              <a :href="series.officialUrls[0]" target="_blank" rel="noopener noreferrer">sitio oficial</a>.
            </span>
          </p>
          <div v-else-if="standings.status === 'error'" class="notice notice-error">
            {{ standings.error }}
            <button type="button" class="btn btn-small" @click="loadStandings(series.id, true)">Reintentar</button>
          </div>
          <template v-else-if="standings.data">
            <p class="small dim">
              Temporada {{ standings.data.season }} · actualizado {{ ago(standings.data.updatedAt) }}
            </p>
            <div v-for="table in standings.data.tables" :key="table.title" class="standings-table">
              <h2 class="section-title">{{ table.title }}</h2>
              <div class="table-wrap">
                <table class="data">
                  <thead>
                    <tr>
                      <th class="num">Pos</th>
                      <th v-if="hasCol(table.rows, 'number')" class="num">N°</th>
                      <th class="name-col">Nombre</th>
                      <th v-if="hasCol(table.rows, 'team')">Equipo</th>
                      <th class="num">Pts</th>
                      <th v-if="hasCol(table.rows, 'wins')" class="num">Victorias</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr v-for="row in table.rows" :key="`${row.pos}-${row.name}`">
                      <td class="num">{{ row.pos }}</td>
                      <td v-if="hasCol(table.rows, 'number')" class="num">{{ row.number ?? '' }}</td>
                      <td>{{ row.name }}</td>
                      <td v-if="hasCol(table.rows, 'team')">{{ row.team ?? '' }}</td>
                      <td class="num"><strong>{{ fmtNum(row.points) }}</strong></td>
                      <td v-if="hasCol(table.rows, 'wins')" class="num">{{ row.wins ?? '' }}</td>
                    </tr>
                  </tbody>
                </table>
              </div>
              <SourceLink :source="standings.data.source" />
            </div>
          </template>
        </section>

        <!-- Resultados -->
        <section v-else>
          <p v-if="!pastEvents.length" class="card empty dim">Todavía no hay eventos disputados de {{ series.name }}.</p>
          <div v-for="ev in pastEvents" :key="ev.id" class="result-event">
            <button type="button" class="result-event-head" :aria-expanded="isOpen(ev.id)" @click="toggleEvent(ev.id)">
              <span class="grow">
                <strong>{{ ev.name }}</strong>
                <span class="small dim"> · {{ dateRange(ev.dateStart, ev.dateEnd) }} · {{ ev.circuit }}</span>
              </span>
              <AppIcon name="chevron" :size="18" class="chev" :class="{ open: isOpen(ev.id) }" />
            </button>
            <div v-if="isOpen(ev.id)" class="result-event-body">
              <template v-for="state in [resultsFor(ev.id)]" :key="ev.id">
                <p v-if="!state || state.status === 'loading'" class="dim small">Cargando resultados…</p>
                <p v-else-if="state.status === 'missing'" class="dim small">Sin datos todavía.</p>
                <div v-else-if="state.status === 'error'" class="notice notice-error small">
                  {{ state.error }}
                  <button type="button" class="btn btn-small" @click="loadResults(series.id, ev.id, true)">Reintentar</button>
                </div>
                <template v-else-if="state.data">
                  <p v-if="!state.data.sessions.length" class="dim small">Sin datos todavía.</p>
                  <div
                    v-for="sr in sortedSessions(state.data.sessions)"
                    :id="`res-${sr.sessionId}`"
                    :key="sr.sessionId"
                    class="result-session"
                    :class="{ highlight: sr.sessionId === focusSession }"
                  >
                    <h3>{{ sessionName(sr.sessionId) }}</h3>
                    <div class="table-wrap">
                      <table class="data">
                        <thead>
                          <tr>
                            <th class="num">Pos</th>
                            <th class="num">N°</th>
                            <th class="name-col">Piloto</th>
                            <th v-if="hasCol(sr.rows, 'team') || hasCol(sr.rows, 'vehicle')">Equipo</th>
                            <th v-if="hasCol(sr.rows, 'laps')" class="num">Vueltas</th>
                            <th class="num">Tiempo / Dif.</th>
                            <th v-if="hasCol(sr.rows, 'points')" class="num">Pts</th>
                          </tr>
                        </thead>
                        <tbody>
                          <tr v-for="(row, i) in sr.rows" :key="i">
                            <td class="num">{{ row.pos ?? row.status ?? '—' }}</td>
                            <td class="num">{{ row.number ?? '' }}</td>
                            <td>{{ row.driver }}</td>
                            <td v-if="hasCol(sr.rows, 'team') || hasCol(sr.rows, 'vehicle')">
                              {{ row.team ?? row.vehicle ?? '' }}
                            </td>
                            <td v-if="hasCol(sr.rows, 'laps')" class="num">{{ row.laps ?? '' }}</td>
                            <td class="num">{{ row.time ?? row.gap ?? (row.pos === null ? row.status ?? '' : '') }}</td>
                            <td v-if="hasCol(sr.rows, 'points')" class="num">{{ row.points ?? '' }}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                    <SourceLink :source="sr.source" />
                  </div>
                </template>
              </template>
            </div>
          </div>
        </section>
      </template>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import { DateTime } from 'luxon';
import type { EventResultsFile, MotorEvent, Series, SessionResult, StandingsFile } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import DataState from '../components/DataState.vue';
import SourceLink from '../components/SourceLink.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { useResultsStore, type Loaded } from '../stores/results.ts';
import { groupSeries, seriesSort } from '../lib/grid.ts';
import { formatDateRange, timeAgo } from '../lib/format.ts';

type Tab = 'campeonato' | 'resultados';

export default defineComponent({
  name: 'ChampionshipsView',
  components: { AppIcon, DataState, SourceLink },
  data() {
    return {
      tabs: [
        { id: 'campeonato' as Tab, label: 'Campeonato' },
        { id: 'resultados' as Tab, label: 'Resultados' },
      ],
      openEvents: [] as string[],
    };
  },
  computed: {
    ...mapState(useScheduleStore, ['schedule', 'hasData', 'now', 'seriesById']),
    ...mapState(useResultsStore, { standingsMap: 'standings', resultsMap: 'results' }),
    seriesId(): string {
      return (this.$route.params.seriesId as string | undefined) ?? '';
    },
    tab(): Tab {
      return this.$route.query.tab === 'resultados' ? 'resultados' : 'campeonato';
    },
    focusEvent(): string {
      return (this.$route.query.event as string | undefined) ?? '';
    },
    focusSession(): string {
      return (this.$route.query.session as string | undefined) ?? '';
    },
    series(): Series | undefined {
      return this.seriesById.get(this.seriesId);
    },
    seriesGroups() {
      const list = (this.schedule?.series ?? []).filter((s) => s.enabled).sort(seriesSort);
      return groupSeries(list.map((series) => ({ series })));
    },
    standings(): Loaded<StandingsFile> | undefined {
      return this.standingsMap[this.seriesId];
    },
    /** Eventos ya empezados, del más reciente al más viejo. */
    pastEvents(): MotorEvent[] {
      const events = (this.schedule?.events ?? []).filter((e) => e.seriesId === this.seriesId);
      return events
        .filter((e) => {
          const today = DateTime.fromISO(this.now, { zone: 'utc' }).setZone(e.tz).toISODate()!;
          return e.dateStart <= today;
        })
        .sort((a, b) => b.dateStart.localeCompare(a.dateStart));
    },
  },
  watch: {
    seriesId: {
      immediate: true,
      handler() {
        this.openEvents = this.focusEvent ? [this.focusEvent] : [];
        this.ensureLoaded();
      },
    },
    tab() {
      this.ensureLoaded();
    },
    focusEvent(id: string) {
      if (id && !this.openEvents.includes(id)) this.openEvents.push(id);
      this.ensureLoaded();
    },
    hasData() {
      this.ensureLoaded();
    },
  },
  methods: {
    ...mapActions(useResultsStore, ['loadStandings', 'loadResults']),
    selectSeries(id: string) {
      void this.$router.push({ name: 'campeonatos', params: { seriesId: id }, query: { tab: this.tab } });
    },
    setTab(tab: Tab) {
      void this.$router.replace({ query: { ...this.$route.query, tab } });
    },
    async ensureLoaded() {
      if (!this.seriesId) return;
      if (this.tab === 'campeonato') {
        await this.loadStandings(this.seriesId);
      } else {
        await Promise.all(this.openEvents.map((id) => this.loadResults(this.seriesId, id)));
        this.scrollToFocus();
      }
    },
    scrollToFocus() {
      if (!this.focusSession) return;
      this.$nextTick(() => {
        document.getElementById(`res-${this.focusSession}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
      });
    },
    isOpen(eventId: string): boolean {
      return this.openEvents.includes(eventId);
    },
    toggleEvent(eventId: string) {
      if (this.isOpen(eventId)) {
        this.openEvents = this.openEvents.filter((id) => id !== eventId);
      } else {
        this.openEvents.push(eventId);
        void this.loadResults(this.seriesId, eventId);
      }
    },
    resultsFor(eventId: string): Loaded<EventResultsFile> | undefined {
      return this.resultsMap[`${this.seriesId}/${eventId}`];
    },
    sessionName(sessionId: string): string {
      return this.schedule?.sessions.find((s) => s.id === sessionId)?.name ?? 'Sesión';
    },
    sortedSessions(list: SessionResult[]): SessionResult[] {
      const start = new Map((this.schedule?.sessions ?? []).map((s) => [s.id, s.startUtc]));
      return [...list].sort((a, b) => (start.get(a.sessionId) ?? '').localeCompare(start.get(b.sessionId) ?? ''));
    },
    hasCol(rows: object[], key: string): boolean {
      return rows.some((r) => (r as Record<string, unknown>)[key] !== undefined && (r as Record<string, unknown>)[key] !== null);
    },
    fmtNum(n: number): string {
      return n.toLocaleString('es-AR');
    },
    ago(iso: string): string {
      return timeAgo(iso, this.now);
    },
    dateRange: formatDateRange,
  },
});
</script>

<style>
.tabs {
  display: flex;
  border-bottom: 1px solid var(--border);
  margin: 0.5rem 0 0.75rem;
}

.tab {
  flex: 1;
  min-height: var(--tap);
  background: transparent;
  border: none;
  border-bottom: 3px solid transparent;
  font-weight: 700;
  color: var(--text-dim);
}

.tab.active {
  color: var(--text);
  border-bottom-color: var(--accent);
}

.result-event {
  border-bottom: 1px solid var(--border);
}

.result-event-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  min-height: 52px;
  background: transparent;
  border: none;
  text-align: left;
  padding: 0.4rem 0;
}

.chev {
  transition: transform 0.15s;
}

.chev.open {
  transform: rotate(90deg);
}

.result-event-body {
  padding-bottom: 0.75rem;
}

.result-session {
  margin: 0.6rem 0 1rem;
  scroll-margin-top: calc(var(--header-h) + var(--safe-top) + 8px);
}

.result-session h3 {
  margin-bottom: 0.4rem;
}

.result-session.highlight h3 {
  color: var(--accent);
}
</style>
