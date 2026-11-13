<template>
  <div class="driver-view">
    <DataState />
    <div v-if="loading" class="driver-skeleton" aria-busy="true" aria-label="Cargando piloto…">
      <section class="hero">
        <div class="hero-top">
          <div class="hero-series big">
            <span class="skel skel-avatar" />
            <div class="grow">
              <span class="skel skel-line wide" />
              <span class="skel skel-line" />
            </div>
          </div>
        </div>
      </section>
      <div class="page">
        <section class="card">
          <span v-for="i in 3" :key="i" class="skel skel-line wide" />
        </section>
      </div>
    </div>
    <div v-else-if="failed" class="page">
      <div class="notice notice-error">
        No se pudo cargar el piloto ({{ failMessage }}).
        <button type="button" class="btn btn-small" @click="retry">Reintentar</button>
      </div>
    </div>
    <NotFoundCard v-else-if="!driver" kind="piloto" :slug="driverId" />

    <template v-if="driver">
      <section class="hero" :style="{ '--series-color': color }">
        <div class="hero-top">
          <div class="hero-series big">
            <DriverAvatar :name="driver.name" :color="color" :number="mainNumber" :size="58" />
            <div>
              <h1 class="hero-title tight">{{ driver.name }}</h1>
              <p class="hero-sub">
                <span v-if="mainNumber" class="car-number hero-number">#{{ mainNumber }}</span>
                {{ subtitle }}
              </p>
              <p v-if="driver.country" class="hero-sub">
                <span v-if="flag" class="hero-flag" aria-hidden="true">{{ flag }}</span> {{ country }}
              </p>
            </div>
          </div>
        </div>
        <div class="hero-actions">
          <FollowButton :driver="followRef" :name="driver.name" />
        </div>
      </section>

      <div class="page">
        <section v-if="entries.length" class="card flush">
          <h3 class="card-title">{{ season ? `Campeonato ${season}` : 'Campeonato' }}</h3>
          <ul class="list-card inset">
            <li v-for="e in entries" :key="`${e.seriesId}-${e.table ?? ''}`" class="stretch">
              <div class="list-row">
                <SeriesCrest v-if="e.series" :series="e.series" :size="30" />
                <span class="grow">
                  <RouterLink :to="tableLink(e.seriesId, e.table)" class="stretch-link">
                    {{ e.series?.shortName ?? e.seriesId }}<template v-if="e.table"> · {{ e.table }}</template>
                  </RouterLink>
                  <span class="block small dim">
                    {{ !season && e.season ? `${e.season} · ` : '' }}{{ fmt(e.points) }} pts<template v-if="e.wins"> · {{ e.wins }} {{ e.wins === 1 ? 'victoria' : 'victorias' }}</template><template v-if="e.team"> · <RouterLink :to="teamLink(e.team)" class="team-link tap-inline">{{ e.team }}</RouterLink></template>
                  </span>
                </span>
                <span class="pos-badge" :class="{ top: e.pos <= 3 }">P{{ e.pos }}</span>
              </div>
            </li>
          </ul>
        </section>

        <!-- Viene solo en la ficha completa: mientras llega no se reserva lugar (la mayoría de los pilotos no tiene). -->
        <SeasonStatsCard v-if="seasonStats.length" :stats="seasonStats" />

        <section v-if="lineups.length" class="card flush">
          <h3 class="card-title">Inscripto en</h3>
          <ul class="list-card inset">
            <li v-for="l in lineups" :key="`${l.seriesId}-${l.number ?? ''}-${l.team ?? ''}`" class="stretch">
              <div class="list-row">
                <SeriesCrest v-if="l.series" :series="l.series" :size="30" />
                <span class="grow">
                  <RouterLink :to="`/categoria/${l.seriesId}?tab=plantel`" class="stretch-link">
                    {{ l.series?.shortName ?? l.seriesId }}<template v-if="l.class"> · {{ l.class }}</template>
                  </RouterLink>
                  <span v-if="l.team" class="block small">
                    <RouterLink :to="teamLink(l.team)" class="team-link tap-inline">{{ l.team }}</RouterLink>
                  </span>
                  <span v-if="l.vehicle" class="block small dim">{{ l.vehicle }}</span>
                </span>
                <span v-if="l.number" class="car-number">#{{ l.number }}</span>
              </div>
            </li>
          </ul>
        </section>

        <p v-if="!entries.length && !lineups.length" class="card empty dim">
          {{ driver.name }} no figura en tablas de campeonato ni en listas de inscriptos publicadas.
        </p>

        <UpcomingList :series-ids="seriesIds" />

        <section class="card flush">
          <h3 class="card-title">Últimas carreras</h3>
          <ul v-if="recentPending" class="list-card inset" aria-busy="true">
            <li v-for="i in 3" :key="i" class="list-row"><span class="skel skel-line wide" /></li>
          </ul>
          <p v-else-if="recentFailed" class="card-foot small dim">
            No se pudieron cargar las últimas carreras.
            <button type="button" class="btn btn-small" @click="retry">Reintentar</button>
          </p>
          <p v-else-if="!recent.length" class="card-foot small dim">
            Todavía no hay resultados de carrera publicados para {{ driver.name }}.
          </p>
          <ul v-else class="list-card inset">
            <li v-for="r in recent" :key="r.sessionId">
              <RouterLink :to="`/evento/${r.eventId}?tab=resultados&session=${r.sessionId}`" class="list-row">
                <SeriesCrest v-if="r.series" :series="r.series" :size="30" />
                <span class="grow">
                  {{ r.eventName }}
                  <span class="block small dim">{{ r.sessionName }} · {{ r.date }}</span>
                </span>
                <span class="pos-badge" :class="{ top: r.pos !== null && r.pos <= 3, out: r.pos === null }">
                  {{ r.pos !== null ? `P${r.pos}` : r.status ?? '—' }}
                </span>
              </RouterLink>
            </li>
          </ul>
        </section>

        <section v-if="driverNews.length" class="card">
          <h3>Noticias</h3>
          <NewsList :items="driverNews" :featured="false" />
        </section>

        <p class="small dim center">
          Datos de las tablas de campeonato, listas de inscriptos y resultados oficiales de cada categoría.
        </p>
      </div>
    </template>
  </div>
</template>

<script lang="ts">
import { fixMonthAbbr } from '../lib/format.ts';
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import { DateTime } from 'luxon';
import { teamId, type Driver, type DriverDetail, type DriverEntry, type DriverLineup, type DriverSeasonStats, type Series } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import DataState from '../components/DataState.vue';
import DriverAvatar from '../components/DriverAvatar.vue';
import FollowButton from '../components/FollowButton.vue';
import SeriesCrest from '../components/SeriesCrest.vue';
import NewsList from '../components/NewsList.vue';
import NotFoundCard from '../components/NotFoundCard.vue';
import SeasonStatsCard from '../components/SeasonStatsCard.vue';
import UpcomingList from '../components/UpcomingList.vue';
import { newsForDriver, useNewsStore } from '../stores/news.ts';
import { useDriversStore } from '../stores/drivers.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore, type FollowedDriver } from '../stores/settings.ts';
import { seriesColor } from '../lib/grid.ts';
import { countryFlag, countryName } from '../lib/roster.ts';
import { driverSeriesIds } from '../lib/teams.ts';
import { commonSeason, standingsSeason } from '../lib/season.ts';
import { useResultsStore } from '../stores/results.ts';

/** Ficha de un piloto (como la de un jugador en FotMob). */
export default defineComponent({
  name: 'DriverView',
  components: { AppIcon, DataState, DriverAvatar, FollowButton, NewsList, NotFoundCard, SeasonStatsCard, SeriesCrest, UpcomingList },
  computed: {
    ...mapState(useDriversStore, { driversStatus: 'status', driversError: 'error', driversById: 'byId', details: 'details', detailStatus: 'detailStatus' }),
    ...mapState(useScheduleStore, ['schedule', 'now', 'seriesById']),
    ...mapState(useSettingsStore, ['timeZone']),
    ...mapState(useNewsStore, { newsItems: 'items' }),
    ...mapState(useResultsStore, ['standings']),
    driverNews() {
      if (!this.driver) return [];
      return newsForDriver(this.newsItems, this.driver.name, this.seriesIds).slice(0, 5);
    },
    driverId(): string {
      return String(this.$route.params.driverId);
    },
    /** Ficha completa si ya llegó; si no, la línea del índice (si ya se había descargado, p. ej. desde Buscar). */
    driver(): DriverDetail | Driver | undefined {
      return this.details[this.driverId] ?? this.driversById.get(this.driverId);
    },
    /** Estado de la ficha completa (data/drivers/{shard}.json). */
    detailState(): string {
      return this.detailStatus(this.driverId);
    },
    /** Todavía no hay nada que mostrar: esqueleto. */
    loading(): boolean {
      if (this.driver) return false;
      return this.detailState === 'idle' || this.detailState === 'loading' || this.driversStatus === 'loading';
    },
    /** No se pudo leer ni la ficha ni el índice (sin conexión y sin copia guardada). */
    failed(): boolean {
      if (this.driver || this.loading) return false;
      return this.detailState === 'error' && this.driversStatus === 'error';
    },
    /** No está en su grupo de fichas (ni en el índice): link viejo o mal escrito. */
    notFound(): boolean {
      return !this.driver && !this.loading && !this.failed;
    },
    failMessage(): string {
      return this.driversError ?? 'sin conexión';
    },
    /** Las últimas carreras vienen solo en la ficha completa. */
    recentPending(): boolean {
      return !!this.driver && !this.driver.recent && (this.detailState === 'loading' || this.detailState === 'idle');
    },
    recentFailed(): boolean {
      return !!this.driver && !this.driver.recent && this.detailState === 'error';
    },
    /** Categorías del piloto: las de sus campeonatos y las de sus inscripciones. */
    seriesIds(): string[] {
      return this.driver ? driverSeriesIds(this.driver) : [];
    },
    entries(): Array<DriverEntry & { series?: Series; season: number | null }> {
      return (this.driver?.entries ?? []).map((e) => ({
        ...e,
        series: this.seriesById.get(e.seriesId),
        season: standingsSeason(this.schedule, e.seriesId, this.now, this.standings[e.seriesId]?.data?.season),
      }));
    },
    /** La temporada en números, por categoría (solo en la ficha completa; el índice no la trae). */
    seasonStats(): DriverSeasonStats[] {
      return (this.driver as DriverDetail | undefined)?.stats ?? [];
    },
    lineups(): Array<DriverLineup & { series?: Series }> {
      return (this.driver?.lineups ?? []).map((l) => ({ ...l, series: this.seriesById.get(l.seriesId) }));
    },
    color(): string {
      return seriesColor(this.seriesById.get(this.seriesIds[0] ?? ''));
    },
    mainNumber(): string {
      return this.entries.find((e) => e.number)?.number ?? this.lineups.find((l) => l.number)?.number ?? '';
    },
    subtitle(): string {
      const team = this.entries.find((e) => e.team)?.team ?? this.lineups.find((l) => l.team)?.team;
      const series = this.seriesIds.map((id) => this.seriesById.get(id)?.shortName ?? id).join(' · ');
      return team ? `${team} · ${series}` : series;
    },
    flag(): string {
      return countryFlag(this.driver?.country);
    },
    country(): string {
      return countryName(this.driver?.country);
    },
    /** Año del título: el de las tablas (no el de los datos); se omite si son de temporadas distintas o no se sabe. */
    season(): number | null {
      return commonSeason(this.entries.map((e) => e.season));
    },
    followRef(): FollowedDriver | null {
      if (!this.driver) return null;
      return { id: this.driver.id, name: this.driver.name, seriesIds: this.seriesIds };
    },
    recent() {
      // Son pocas (6): se buscan una por una en vez de indexar toda la agenda.
      const events = this.schedule?.events ?? [];
      const sessions = this.schedule?.sessions ?? [];
      return (this.driver?.recent ?? []).map((r) => ({
        ...r,
        series: this.seriesById.get(r.seriesId),
        eventName: events.find((e) => e.id === r.eventId)?.name ?? 'Evento',
        sessionName: sessions.find((x) => x.id === r.sessionId)?.name ?? 'Carrera',
        date: fixMonthAbbr(DateTime.fromISO(r.startUtc, { zone: 'utc' }).setZone(this.timeZone).setLocale('es-AR').toFormat('d LLL yyyy')),
      }));
    },
  },
  watch: {
    // Las sugerencias de nombres parecidos (NotFoundCard) buscan en el índice: solo entonces se pide.
    notFound(value: boolean) {
      if (value) void this.loadIndex();
    },
    // Solo se pide la ficha de este piloto (unos pocos KB), no el índice de todos.
    '$route.params.driverId': {
      immediate: true,
      handler(id: unknown) {
        if (typeof id !== 'string' || !id) return;
        void this.loadDetail(id);
        void this.loadNews();
      },
    },
  },
  methods: {
    ...mapActions(useDriversStore, { loadDetail: 'loadDetail', loadIndex: 'load' }),
    retry() {
      void this.loadDetail(this.driverId, true);
    },
    ...mapActions(useNewsStore, { loadNews: 'load' }),
    fmt(n: number): string {
      return n.toLocaleString('es-AR');
    },
    teamLink(name: string): string {
      return `/equipo/${teamId(name)}`;
    },
    /** Tabla del campeonato, abierta en la del piloto si la categoría tiene varias. */
    tableLink(seriesId: string, table?: string): string {
      return `/categoria/${seriesId}?tab=tabla${table ? `&tabla=${encodeURIComponent(table)}` : ''}`;
    },
  },
});
</script>

<style>
.hero-number {
  display: inline-block;
  margin-right: 0.3rem;
  color: var(--text);
  border: 1px solid var(--series-color, var(--border));
}

.skel {
  display: block;
  border-radius: 6px;
  background: var(--border);
  animation: pulse 1.4s ease-in-out infinite;
}

.skel-avatar {
  width: 58px;
  height: 58px;
  flex: none;
  border-radius: 50%;
}

.skel-line {
  width: 40%;
  height: 0.9rem;
  margin: 0.35rem 0;
}

.skel-line.wide {
  width: 75%;
}

@media (prefers-reduced-motion: reduce) {
  .skel {
    animation: none;
  }
}
</style>
