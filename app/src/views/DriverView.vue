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
    <p v-else-if="(driversStatus === 'ok' || driversStatus === 'missing') && !driver" class="page card empty">
      No encontramos a este piloto en las tablas de campeonato publicadas.
    </p>

    <template v-if="driver">
      <section class="hero" :style="{ '--series-color': color }">
        <div class="hero-top">
          <div class="hero-series big">
            <DriverAvatar :name="driver.name" :color="color" :number="mainNumber" :size="58" />
            <div>
              <h1 class="hero-title tight">{{ driver.name }}</h1>
              <p class="hero-sub">{{ subtitle }}</p>
            </div>
          </div>
        </div>
        <div class="hero-actions">
          <FollowButton :driver="followRef" :name="driver.name" />
        </div>
      </section>

      <div class="page">
        <section class="card flush">
          <h3 class="card-title">Campeonato {{ season }}</h3>
          <ul class="list-card inset">
            <li v-for="e in entries" :key="`${e.seriesId}-${e.table ?? ''}`">
              <RouterLink :to="`/categoria/${e.seriesId}?tab=tabla`" class="list-row">
                <SeriesCrest v-if="e.series" :series="e.series" :size="30" />
                <span class="grow">
                  {{ e.series?.shortName ?? e.seriesId }}<template v-if="e.table"> · {{ e.table }}</template>
                  <span class="block small dim">
                    {{ fmt(e.points) }} pts<template v-if="e.wins"> · {{ e.wins }} {{ e.wins === 1 ? 'victoria' : 'victorias' }}</template><template v-if="e.team"> · {{ e.team }}</template>
                  </span>
                </span>
                <span class="pos-badge" :class="{ top: e.pos <= 3 }">P{{ e.pos }}</span>
              </RouterLink>
            </li>
          </ul>
        </section>

        <section v-if="upcoming.length" class="card flush">
          <h3 class="card-title">Próximas carreras</h3>
          <ul class="list-card inset">
            <li v-for="u in upcoming" :key="u.event.id">
              <RouterLink :to="`/evento/${u.event.id}`" class="list-row">
                <SeriesCrest :series="u.series" :size="30" />
                <span class="grow">
                  {{ u.event.name }}
                  <span class="block small" :class="u.live ? 'live-text' : u.when.includes('confirmar') ? 'warn-text' : 'dim'">{{ u.when }}</span>
                </span>
                <AppIcon name="chevron" :size="16" class="dim" />
              </RouterLink>
            </li>
          </ul>
        </section>

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

        <p class="small dim center">
          Datos de las tablas de campeonato y resultados oficiales de cada categoría.
        </p>
      </div>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import { DateTime } from 'luxon';
import type { Driver, DriverEntry, MotorEvent, Series } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import DataState from '../components/DataState.vue';
import DriverAvatar from '../components/DriverAvatar.vue';
import FollowButton from '../components/FollowButton.vue';
import SeriesCrest from '../components/SeriesCrest.vue';
import { useDriversStore } from '../stores/drivers.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore, type FollowedDriver } from '../stores/settings.ts';
import { seriesColor } from '../lib/grid.ts';
import { nextEventOf } from '../lib/agenda.ts';

interface Upcoming {
  event: MotorEvent;
  series: Series;
  live: boolean;
  when: string;
}

/** Ficha de un piloto (como la de un jugador en FotMob). */
export default defineComponent({
  name: 'DriverView',
  components: { AppIcon, DataState, DriverAvatar, FollowButton, SeriesCrest },
  computed: {
    ...mapState(useDriversStore, { driversStatus: 'status', driversError: 'error', driversById: 'byId', driversFile: 'file' }),
    ...mapState(useScheduleStore, ['schedule', 'now', 'seriesById']),
    ...mapState(useSettingsStore, ['timeZone']),
    driver(): Driver | undefined {
      return this.driversById.get(String(this.$route.params.driverId));
    },
    entries(): Array<DriverEntry & { series?: Series }> {
      return (this.driver?.entries ?? []).map((e) => ({ ...e, series: this.seriesById.get(e.seriesId) }));
    },
    color(): string {
      return seriesColor(this.entries[0]?.series);
    },
    mainNumber(): string {
      return this.entries.find((e) => e.number)?.number ?? '';
    },
    subtitle(): string {
      const team = this.entries.find((e) => e.team)?.team;
      const series = [...new Set(this.entries.map((e) => e.series?.shortName ?? e.seriesId))].join(' · ');
      return team ? `${team} · ${series}` : series;
    },
    season(): string {
      return this.driversFile ? this.driversFile.generatedAt.slice(0, 4) : '';
    },
    followRef(): FollowedDriver | null {
      if (!this.driver) return null;
      return { id: this.driver.id, name: this.driver.name, seriesIds: [...new Set(this.driver.entries.map((e) => e.seriesId))] };
    },
    upcoming(): Upcoming[] {
      const out: Upcoming[] = [];
      for (const id of new Set(this.entries.map((e) => e.seriesId))) {
        const series = this.seriesById.get(id);
        const next = series ? nextEventOf(this.schedule, id, this.now) : null;
        if (!series || !next) continue;
        let when: string;
        if (next.live) when = `En vivo: ${next.nextSession!.name}`;
        else if (next.nextSession) {
          when =
            next.nextSession.name +
            ' · ' +
            DateTime.fromISO(next.nextSession.startUtc, { zone: 'utc' }).setZone(this.timeZone).setLocale('es-AR').toFormat("ccc d 'de' LLL, HH:mm");
        } else when = DateTime.fromISO(next.event.dateStart).setLocale('es-AR').toFormat("ccc d 'de' LLL") + ' · horarios a confirmar';
        out.push({ event: next.event, series, live: next.live, when });
      }
      return out.sort((a, b) => a.event.dateStart.localeCompare(b.event.dateStart));
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
      },
    },
  },
  methods: {
    ...mapActions(useDriversStore, { loadDrivers: 'load' }),
    fmt(n: number): string {
      return n.toLocaleString('es-AR');
    },
  },
});
</script>

<style>
.pos-badge {
  min-width: 2.6rem;
  padding: 0.2rem 0.5rem;
  border-radius: 8px;
  background: var(--bg-elev-2);
  font-weight: 800;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.pos-badge.top {
  background: var(--accent);
  color: var(--accent-text);
}

.pos-badge.out {
  color: var(--text-dim);
  font-size: 0.8rem;
}
</style>
