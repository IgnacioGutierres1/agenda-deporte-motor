<template>
  <div class="page search-view">
    <label class="search-box">
      <AppIcon name="search" :size="18" />
      <input
        ref="input"
        v-model="query"
        type="search"
        class="search-input"
        placeholder="Categorías, pilotos, equipos, circuitos…"
        aria-label="Buscar"
        enterkeyhint="search"
      />
    </label>

    <template v-if="q.length < 2">
      <p class="small dim">Escribí al menos 2 letras. Por ejemplo: «Canapino», «Rafaela», «MotoGP», «WRT», «#7».</p>
      <template v-if="recent.length">
        <div class="section-head">
          <h2 class="section-title">Búsquedas recientes</h2>
          <button type="button" class="link-btn" @click="clearRecent">Borrar</button>
        </div>
        <div class="session-chips wrap-chips">
          <button v-for="r in recent" :key="r" type="button" class="pill" @click="query = r">{{ r }}</button>
        </div>
      </template>
      <StarterPack />
      <RecommendationsCard />
    </template>

    <template v-else>
      <p v-if="!total && !peopleLoading" class="card empty dim">Sin resultados para «{{ query }}».</p>
      <p v-else-if="suggestion" class="did-you-mean">
        ¿Quisiste decir <button type="button" class="link-btn tap-inline" @click="query = suggestion">{{ suggestion }}</button>?
      </p>

      <template v-if="seriesHits.length">
        <h2 class="section-title">Categorías</h2>
        <ul class="list-card">
          <li v-for="s in seriesHits" :key="s.id"><SeriesRow :series="s" /></li>
        </ul>
      </template>

      <template v-if="driverHits.length || driversStatus === 'loading'">
        <h2 class="section-title">Pilotos</h2>
        <p v-if="driversStatus === 'loading'" class="small dim">Cargando pilotos…</p>
        <ul v-else class="list-card">
          <li v-for="d in driverHits" :key="d.id">
            <RouterLink :to="`/piloto/${d.id}`" class="list-row" @click="remember">
              <DriverAvatar :name="d.name" :color="driverColor(d)" :size="34" />
              <span class="grow">
                {{ d.name }}
                <span class="block small dim one-line">{{ entrySummary(d) }}</span>
              </span>
              <AppIcon name="chevron" :size="16" class="dim" />
            </RouterLink>
          </li>
        </ul>
      </template>

      <template v-if="teamHits.length">
        <h2 class="section-title">Equipos</h2>
        <ul class="list-card">
          <li v-for="t in teamHits" :key="t.id">
            <RouterLink :to="`/equipo/${t.id}`" class="list-row" @click="remember">
              <DriverAvatar :name="t.name" :color="teamColor(t)" :size="34" />
              <span class="grow">
                {{ t.name }}
                <span class="block small dim one-line">{{ teamSummary(t) }}</span>
              </span>
              <AppIcon name="chevron" :size="16" class="dim" />
            </RouterLink>
          </li>
        </ul>
      </template>

      <template v-if="circuitHits.length">
        <h2 class="section-title">Circuitos</h2>
        <ul class="list-card">
          <li v-for="c in circuitHits" :key="c.id">
            <RouterLink :to="`/circuito/${c.id}`" class="list-row" @click="remember">
              <span class="rec-circuit" :style="{ background: circuitColor(c) }"><AppIcon name="flag" :size="16" /></span>
              <span class="grow">
                {{ c.name }}
                <span class="block small dim one-line">{{ circuitSummary(c) }}</span>
              </span>
              <AppIcon name="chevron" :size="16" class="dim" />
            </RouterLink>
          </li>
          <li>
            <RouterLink to="/circuitos" class="list-row see-all">
              <span class="grow">Ver todos los circuitos</span>
              <AppIcon name="chevron" :size="16" />
            </RouterLink>
          </li>
        </ul>
      </template>

      <template v-if="eventHits.length">
        <h2 class="section-title">Eventos</h2>
        <ul class="list-card">
          <li v-for="h in eventHits" :key="h.event.id">
            <RouterLink :to="`/evento/${h.event.id}`" class="list-row" :class="{ past: h.past }" @click="remember">
              <SeriesCrest :series="h.series" :size="30" />
              <span class="grow">
                {{ h.event.name }}
                <span class="block small dim one-line">{{ h.series.shortName }} · {{ dateRange(h.event.dateStart, h.event.dateEnd) }} · {{ h.event.circuit }}</span>
              </span>
              <AppIcon name="chevron" :size="16" class="dim" />
            </RouterLink>
          </li>
        </ul>
      </template>

      <template v-if="newsHits.length">
        <h2 class="section-title">Noticias</h2>
        <NewsList :items="newsHits" :featured="false" />
      </template>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import type { Driver, MotorEvent, NewsItem, Series, Team } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import DriverAvatar from '../components/DriverAvatar.vue';
import NewsList from '../components/NewsList.vue';
import SeriesCrest from '../components/SeriesCrest.vue';
import SeriesRow from '../components/SeriesRow.vue';
import RecommendationsCard from '../components/RecommendationsCard.vue';
import StarterPack from '../components/StarterPack.vue';
import { useDriversStore } from '../stores/drivers.ts';
import { useTeamsStore } from '../stores/teams.ts';
import { useNewsStore } from '../stores/news.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { formatDateRange } from '../lib/format.ts';
import { seriesColor } from '../lib/grid.ts';
import { todayIn } from '../lib/agenda.ts';
import { readJsonStorage, writeJsonStorage } from '../lib/storage.ts';
import {
  carNumberQuery,
  driverSubtitle,
  matchesAll,
  matchText,
  normalize as norm,
  numberSeriesOf,
  rankSeries,
  searchCircuits,
  type SearchContext,
  type TextMatch,
} from '../lib/search.ts';
import { searchContext } from '../lib/searchContext.ts';
import { driverSeriesIds } from '../lib/teams.ts';
import type { Circuit } from '../lib/circuits.ts';
const RECENT_KEY = 'search-recent';

/** Buscador general (como "Buscar" en FotMob): categorías, pilotos, equipos, circuitos, eventos y noticias. */
export default defineComponent({
  name: 'SearchView',
  components: { AppIcon, DriverAvatar, NewsList, RecommendationsCard, SeriesCrest, SeriesRow, StarterPack },
  data() {
    return {
      query: (this.$route.query.q as string | undefined) ?? '',
      recent: readJsonStorage<string[]>(RECENT_KEY) ?? [],
    };
  },
  computed: {
    ...mapState(useScheduleStore, ['schedule', 'now', 'seriesById', 'circuits']),
    ...mapState(useDriversStore, { driversStatus: 'status' }),
    ...mapState(useTeamsStore, { teamsPending: 'pending' }),
    peopleLoading(): boolean {
      return this.driversStatus === 'loading' || this.teamsPending;
    },
    ...mapState(useNewsStore, { newsItems: 'items' }),
    q(): string {
      return norm(this.query.trim());
    },
    words(): string[] {
      return this.q.split(/\s+/).filter(Boolean);
    },
    ...mapState(useSettingsStore, ['followedSeriesIds', 'followedDrivers', 'followedTeams']),
    /** Relevancia: lo seguido, las principales y las argentinas primero (depende de lo seguido). */
    ctx(): SearchContext {
      // Se lee lo seguido para que el orden se actualice al tocar ★.
      void [this.followedSeriesIds, this.followedDrivers, this.followedTeams];
      return searchContext();
    },
    /** Número de auto buscado ("#43" o "43"). */
    carNumber(): string {
      return carNumberQuery(this.query);
    },
    seriesHits(): Series[] {
      return rankSeries((this.schedule?.series ?? []).filter((s) => s.enabled), this.query, this.ctx, 8).map((h) => h.item);
    },
    driverHits(): Driver[] {
      return useDriversStore().search(this.query, 10);
    },
    teamHits(): Team[] {
      return useTeamsStore().search(this.query, 8);
    },
    circuitHits(): Circuit[] {
      return searchCircuits(this.circuits, this.query, 6, this.ctx);
    },
    eventHits(): Array<{ event: MotorEvent; series: Series; past: boolean }> {
      const out: Array<{ event: MotorEvent; series: Series; past: boolean }> = [];
      for (const e of this.schedule?.events ?? []) {
        const series = this.seriesById.get(e.seriesId);
        if (!series?.enabled || !matchesAll(`${e.name} ${e.circuit} ${e.country} ${series.shortName}`, this.words)) continue;
        out.push({ event: e, series, past: e.dateEnd < todayIn(this.now, e.tz) });
      }
      // Primero los próximos (por fecha), después los pasados (más recientes primero).
      return out
        .sort((a, b) =>
          a.past !== b.past ? Number(a.past) - Number(b.past) : a.past ? b.event.dateStart.localeCompare(a.event.dateStart) : a.event.dateStart.localeCompare(b.event.dateStart),
        )
        .slice(0, 12);
    },
    /**
     * "¿Quisiste decir…?": si nada coincide exacto ni por prefijo (solo con errores de tipeo), el nombre
     * del mejor resultado aproximado.
     */
    suggestion(): string {
      if (this.carNumber || this.eventHits.length || this.newsHits.length) return '';
      const names = [
        ...this.seriesHits.map((s) => s.name),
        ...this.driverHits.map((d) => d.name),
        ...this.teamHits.map((t) => t.name),
        ...this.circuitHits.map((c) => c.name),
      ];
      let best: { name: string; m: TextMatch } | null = null;
      for (const name of names) {
        const m = matchText(name, this.query);
        if (!m) continue;
        if (m.kind !== 'fuzzy') return '';
        if (!best || m.dist < best.m.dist) best = { name, m };
      }
      return best?.name ?? '';
    },
    newsHits(): NewsItem[] {
      return this.newsItems.filter((n) => matchesAll(n.title, this.words)).slice(0, 6);
    },
    total(): number {
      return (
        this.seriesHits.length +
        this.driverHits.length +
        this.teamHits.length +
        this.circuitHits.length +
        this.eventHits.length +
        this.newsHits.length
      );
    },
  },
  watch: {
    '$route.query.q'(value: unknown) {
      const next = typeof value === 'string' ? value : '';
      if (next !== this.query.trim()) this.query = next;
    },
    q(value: string) {
      if (value.length >= 2) {
        void this.loadDrivers();
        void this.loadTeams();
        void this.loadNews();
      }
      void this.$router.replace({ query: this.query.trim() ? { q: this.query.trim() } : {} });
    },
  },
  mounted() {
    if (this.q.length >= 2) {
      void this.loadDrivers();
      void this.loadTeams();
      void this.loadNews();
    }
    (this.$refs.input as HTMLInputElement | undefined)?.focus();
  },
  methods: {
    ...mapActions(useDriversStore, { loadDrivers: 'load' }),
    ...mapActions(useTeamsStore, { loadTeams: 'load' }),
    ...mapActions(useNewsStore, { loadNews: 'load' }),
    remember() {
      const term = this.query.trim();
      if (term.length < 2) return;
      this.recent = [term, ...this.recent.filter((r) => r.toLowerCase() !== term.toLowerCase())].slice(0, 8);
      writeJsonStorage(RECENT_KEY, this.recent);
    },
    clearRecent() {
      this.recent = [];
      writeJsonStorage(RECENT_KEY, []);
    },
    driverColor(d: Driver): string {
      return seriesColor(this.seriesById.get(driverSeriesIds(d)[0] ?? ''));
    },
    /** Campeonatos e inscripciones; si se buscó un número, primero ese auto ("#43 · F1 · P12"). */
    entrySummary(d: Driver): string {
      const short = (id: string) => this.seriesById.get(id)?.shortName ?? id;
      return driverSubtitle(d, short, this.carNumber, this.carNumber ? numberSeriesOf(d, this.carNumber, this.ctx) : '');
    },
    teamColor(t: Team): string {
      return seriesColor(this.seriesById.get(t.entries[0]?.seriesId ?? t.drivers[0]?.seriesId ?? ''));
    },
    teamSummary(t: Team): string {
      // Una línea por categoría: la posición de la primera tabla (la general) y todos sus números de auto.
      const bySeries = new Map<string, { pos?: number; numbers: Set<string> }>();
      for (const e of t.entries) {
        const s = bySeries.get(e.seriesId) ?? { numbers: new Set<string>() };
        if (s.pos === undefined && e.pos) s.pos = e.pos;
        e.numbers?.forEach((n) => s.numbers.add(n));
        bySeries.set(e.seriesId, s);
      }
      return [...bySeries]
        .map(([id, s]) => `${this.seriesById.get(id)?.shortName ?? id}${s.pos ? ' P' + s.pos : ''}${s.numbers.size ? ' ' + [...s.numbers].map((n) => '#' + n).join(' ') : ''}`)
        .join(' · ');
    },
    circuitColor(c: Circuit): string {
      return seriesColor(this.seriesById.get(c.seriesIds[0] ?? ''));
    },
    circuitSummary(c: Circuit): string {
      const series = c.seriesIds.slice(0, 4).map((id) => this.seriesById.get(id)?.shortName ?? id);
      const more = c.seriesIds.length > 4 ? ` +${c.seriesIds.length - 4}` : '';
      return [c.country, series.join(', ') + more].filter(Boolean).join(' · ');
    },
    dateRange: formatDateRange,
  },
});
</script>

<style>
.wrap-chips {
  flex-wrap: wrap;
}

.did-you-mean {
  margin: 0.5rem 0 0;
}

/* Última fila de un grupo de resultados: lleva a la lista completa. */
a.list-row.see-all {
  color: var(--link);
  font-weight: 700;
}

.did-you-mean .link-btn {
  min-height: 0;
  /* Área de toque de 44 px sin correr el texto de la línea. */
  padding: 0.7rem 0;
  margin: -0.7rem 0;
  font-size: inherit;
}
</style>
