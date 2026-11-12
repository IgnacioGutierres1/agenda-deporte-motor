<template>
  <div class="driver-view">
    <DataState />
    <p v-if="driversStatus === 'loading' && !driver" class="page dim">Cargando piloto…</p>
    <div v-else-if="driversStatus === 'error'" class="page">
      <div class="notice notice-error">
        No se pudieron cargar los pilotos ({{ driversError }}).
        <button type="button" class="btn btn-small" @click="loadDrivers(true)">Reintentar</button>
      </div>
    </div>
    <NotFoundCard v-else-if="(driversStatus === 'ok' || driversStatus === 'missing') && !driver" kind="piloto" :slug="String($route.params.driverId ?? '')" />

    <template v-if="driver">
      <section class="hero" :style="{ '--series-color': color }">
        <div class="hero-top">
          <div class="hero-series big">
            <DriverAvatar :name="driver.name" :color="color" :number="mainNumber" :size="58" />
            <div>
              <h1 class="hero-title tight">{{ driver.name }}</h1>
              <p class="hero-sub">{{ subtitle }}</p>
              <p v-if="driver.country" class="hero-sub">{{ flag }} {{ country }}</p>
            </div>
          </div>
        </div>
        <div class="hero-actions">
          <FollowButton :driver="followRef" :name="driver.name" />
        </div>
      </section>

      <div class="page">
        <section v-if="entries.length" class="card flush">
          <h3 class="card-title">Campeonato {{ season }}</h3>
          <ul class="list-card inset">
            <li v-for="e in entries" :key="`${e.seriesId}-${e.table ?? ''}`" class="stretch">
              <div class="list-row">
                <SeriesCrest v-if="e.series" :series="e.series" :size="30" />
                <span class="grow">
                  <RouterLink :to="tableLink(e.seriesId, e.table)" class="stretch-link">
                    {{ e.series?.shortName ?? e.seriesId }}<template v-if="e.table"> · {{ e.table }}</template>
                  </RouterLink>
                  <span class="block small dim">
                    {{ fmt(e.points) }} pts<template v-if="e.wins"> · {{ e.wins }} {{ e.wins === 1 ? 'victoria' : 'victorias' }}</template><template v-if="e.team"> · <RouterLink :to="teamLink(e.team)" class="team-link">{{ e.team }}</RouterLink></template>
                  </span>
                </span>
                <span class="pos-badge" :class="{ top: e.pos <= 3 }">P{{ e.pos }}</span>
              </div>
            </li>
          </ul>
        </section>

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
                    <RouterLink :to="teamLink(l.team)" class="team-link">{{ l.team }}</RouterLink>
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
          <p v-if="!recent.length" class="card-foot small dim">
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
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import { DateTime } from 'luxon';
import { teamId, type Driver, type DriverEntry, type DriverLineup, type Series } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import DataState from '../components/DataState.vue';
import DriverAvatar from '../components/DriverAvatar.vue';
import FollowButton from '../components/FollowButton.vue';
import SeriesCrest from '../components/SeriesCrest.vue';
import NewsList from '../components/NewsList.vue';
import NotFoundCard from '../components/NotFoundCard.vue';
import UpcomingList from '../components/UpcomingList.vue';
import { newsForDriver, useNewsStore } from '../stores/news.ts';
import { useDriversStore } from '../stores/drivers.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore, type FollowedDriver } from '../stores/settings.ts';
import { seriesColor } from '../lib/grid.ts';
import { countryFlag, countryName } from '../lib/roster.ts';
import { driverSeriesIds } from '../lib/teams.ts';

/** Ficha de un piloto (como la de un jugador en FotMob). */
export default defineComponent({
  name: 'DriverView',
  components: { AppIcon, DataState, DriverAvatar, FollowButton, NewsList, NotFoundCard, SeriesCrest, UpcomingList },
  computed: {
    ...mapState(useDriversStore, { driversStatus: 'status', driversError: 'error', driversById: 'byId', driversFile: 'file' }),
    ...mapState(useScheduleStore, ['schedule', 'now', 'seriesById']),
    ...mapState(useSettingsStore, ['timeZone']),
    ...mapState(useNewsStore, { newsItems: 'items' }),
    driverNews() {
      if (!this.driver) return [];
      return newsForDriver(this.newsItems, this.driver.name, this.seriesIds).slice(0, 5);
    },
    driver(): Driver | undefined {
      return this.driversById.get(String(this.$route.params.driverId));
    },
    /** Categorías del piloto: las de sus campeonatos y las de sus inscripciones. */
    seriesIds(): string[] {
      return this.driver ? driverSeriesIds(this.driver) : [];
    },
    entries(): Array<DriverEntry & { series?: Series }> {
      return (this.driver?.entries ?? []).map((e) => ({ ...e, series: this.seriesById.get(e.seriesId) }));
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
    season(): string {
      return this.driversFile ? this.driversFile.generatedAt.slice(0, 4) : '';
    },
    followRef(): FollowedDriver | null {
      if (!this.driver) return null;
      return { id: this.driver.id, name: this.driver.name, seriesIds: this.seriesIds };
    },
    recent() {
      const events = new Map((this.schedule?.events ?? []).map((e) => [e.id, e]));
      const sessions = new Map((this.schedule?.sessions ?? []).map((s) => [s.id, s]));
      return (this.driver?.recent ?? []).map((r) => ({
        ...r,
        series: this.seriesById.get(r.seriesId),
        eventName: events.get(r.eventId)?.name ?? 'Evento',
        sessionName: sessions.get(r.sessionId)?.name ?? 'Carrera',
        date: DateTime.fromISO(r.startUtc, { zone: 'utc' }).setZone(this.timeZone).setLocale('es-AR').toFormat('d LLL yyyy'),
      }));
    },
  },
  watch: {
    // Si se abre directo el link de un piloto que no está en el índice en memoria, se vuelve a pedir.
    '$route.params.driverId': {
      immediate: true,
      handler() {
        void this.loadDrivers();
        void this.loadNews();
      },
    },
  },
  methods: {
    ...mapActions(useDriversStore, { loadDrivers: 'load' }),
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
