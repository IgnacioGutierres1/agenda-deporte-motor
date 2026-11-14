<template>
  <div class="category-view">
    <DataState />
    <p v-if="hasData && !series" class="page card empty">No se encontró la categoría.</p>

    <template v-if="series">
      <section class="hero" :style="{ '--series-color': color }">
        <div class="hero-top">
          <div class="hero-series big">
            <SeriesCrest :series="series" :size="52" />
            <div>
              <h1 class="hero-title tight">{{ series.name }}</h1>
              <p class="hero-sub">{{ groupLabel }}<template v-if="series.origin === 'discovered'"> · Descubierta</template></p>
            </div>
          </div>
        </div>
        <div class="hero-actions">
          <FollowButton :series-id="series.id" :name="series.name" />
          <a v-if="officialUrl" :href="officialUrl" target="_blank" rel="noopener noreferrer" class="pill">
            Sitio oficial <AppIcon name="external" :size="14" />
          </a>
        </div>
      </section>

      <nav v-tab-strip="$route.path" class="underline-tabs page-tabs" role="tablist" aria-label="Secciones de la categoría">
        <button
          v-for="t in tabs"
          :key="t.id"
          type="button"
          role="tab"
          class="underline-tab"
          :class="{ active: tab === t.id }"
          :aria-selected="tab === t.id"
          @click="setTab(t.id)"
        >
          {{ t.label }}
        </button>
      </nav>

      <div class="page">
        <!-- Resumen -->
        <template v-if="tab === 'resumen'">
          <!-- Sin fechas guardadas y la fuente falla: se explica en lugar de "Sin fechas próximas". -->
          <SourceProblem v-if="sourceFailing && !events.length" :status="seriesStatus" :series="series" />
          <section v-else class="card flush">
            <h3 class="card-title">Próximo evento</h3>
            <RouterLink v-if="next" :to="`/evento/${next.event.id}`" class="list-row next-event">
              <span class="date-box">
                <span class="date-day">{{ dayNum(next.event.dateStart) }}</span>
                <span class="date-month">{{ monthShort(next.event.dateStart) }}</span>
              </span>
              <span class="grow">
                <strong>{{ next.event.name }}</strong>
                <span class="block small dim">{{ next.event.circuit }}</span>
                <span class="block small" :class="next.live ? 'live-text' : next.nextSession || next.event.stageCount ? 'accent-text' : 'warn-text'">
                  {{ nextText }}
                </span>
                <span v-if="next.nextSession && !next.live" class="block countdown-line">
                  <CountdownBadge :start-utc="next.nextSession.startUtc" long />
                </span>
              </span>
              <AppIcon name="chevron" :size="16" class="dim" />
            </RouterLink>
            <p v-else class="card-foot dim">
              {{ sourceFailing ? 'Sin fechas próximas en los datos guardados.' : 'Sin fechas próximas publicadas.' }}
            </p>
            <div v-if="sourceFailing && events.length" class="card-foot">
              <SourceProblem :status="seriesStatus" :series="series" has-events />
            </div>
          </section>

          <CalendarSubscribe :series="series" />

          <section v-if="recent.length" class="card flush">
            <h3 class="card-title">Últimos eventos</h3>
            <ul class="list-card inset">
              <li v-for="ev in recent" :key="ev.id">
                <RouterLink :to="`/evento/${ev.id}${eventHasResults(ev.id) ? '?tab=resultados' : ''}`" class="list-row">
                  <span class="grow">
                    {{ ev.name }}
                    <span class="block small dim">{{ dateRange(ev.dateStart, ev.dateEnd) }} · {{ ev.circuit }}</span>
                    <PodiumLine v-if="eventHasResults(ev.id)" :series-id="ev.seriesId" :event-id="ev.id" />
                  </span>
                  <span v-if="eventHasResults(ev.id)" class="badge badge-ok">Resultados</span>
                  <AppIcon name="chevron" :size="16" class="dim" />
                </RouterLink>
              </li>
            </ul>
          </section>

          <section class="card desk-side">
            <h3>Fuente de los datos</h3>
            <p class="small">
              <span class="badge" :class="statusBadge.cls">{{ statusBadge.label }}</span>
              <span v-if="seriesStatus" class="dim"> · última verificación {{ ago(seriesStatus.lastAttempt) }}</span>
            </p>
            <SourceProblem v-if="sourceFailing" :status="seriesStatus" :series="series" variant="compact" />
            <p v-else-if="seriesStatus?.message" class="small dim">{{ seriesStatus.message }}</p>
            <p v-if="seriesStatus?.state === 'ok' && seriesStatus.timetables" class="small dim">{{ timetablesLine }}</p>
            <p class="small dim">
              {{ series.strategy === 'adapter' ? 'Lectura directa de la fuente oficial.' : 'Leído del sitio oficial (con IA cuando el documento no tiene estructura).' }}
            </p>
          </section>
        </template>

        <!-- Calendario -->
        <template v-else-if="tab === 'calendario'">
          <CalendarSubscribe :series="series" />
          <SourceProblem v-if="sourceFailing" :status="seriesStatus" :series="series" :has-events="events.length > 0" />
          <ul v-if="events.length || !sourceFailing" class="list-card">
            <li v-if="!events.length" class="list-row dim">Sin eventos publicados.</li>
            <li v-for="ev in events" :key="ev.id">
              <RouterLink :to="`/evento/${ev.id}`" class="list-row" :class="{ past: isPast(ev) }">
                <span class="date-box small-box">
                  <span class="date-day">{{ dayNum(ev.dateStart) }}</span>
                  <span class="date-month">{{ monthShort(ev.dateStart) }}</span>
                </span>
                <span class="grow">
                  <span v-if="showRound(ev)" class="dim small">Fecha {{ ev.round }} · </span>{{ ev.name }}
                  <span class="block small dim">{{ ev.circuit }}<SurfaceBadge v-if="ev.surface" :surface="ev.surface" class="cal-surface" /></span>
                </span>
                <span v-if="isPast(ev)" class="small dim">Final</span>
                <span v-else-if="ev.sessionsStatus === 'pending' && !ev.stageCount" class="small warn-text">A confirmar</span>
                <AppIcon name="chevron" :size="16" class="dim" />
              </RouterLink>
            </li>
          </ul>
        </template>

        <!-- Tabla -->
        <StandingsPanel v-else-if="tab === 'tabla'" :series="series" />

        <!-- Plantel (pilotos y equipos inscriptos) -->
        <RosterPanel v-else-if="tab === 'plantel'" :series="series" />

        <!-- Noticias -->
        <NewsList
          v-else-if="tab === 'noticias'"
          :items="seriesNews"
          :empty-text="`No hay noticias recientes de ${series.name}.`"
        />

        <!-- Historia (data/bios/series.json): solo si hay datos de esta categoría -->
        <template v-else-if="tab === 'historia'">
          <SeriesHistoryPanel v-if="history" :series="series" :history="history" />
          <p v-else-if="historyStatus === 'loading' || historyStatus === 'idle'" class="dim">Cargando historia…</p>
          <p v-else class="card empty dim">Todavía no hay datos de la historia de {{ series.name }}.</p>
        </template>

        <!-- Resultados -->
        <template v-else>
          <p v-if="!withResults.length" class="card empty dim">Todavía no hay resultados de {{ series.name }}.</p>
          <ul v-else class="list-card">
            <li v-for="ev in withResults" :key="ev.id">
              <RouterLink :to="`/evento/${ev.id}?tab=resultados`" class="list-row">
                <span class="grow">
                  {{ ev.name }}
                  <span class="block small dim">{{ dateRange(ev.dateStart, ev.dateEnd) }} · {{ ev.circuit }}</span>
                  <PodiumLine :series-id="ev.seriesId" :event-id="ev.id" />
                </span>
                <AppIcon name="chevron" :size="16" class="dim" />
              </RouterLink>
            </li>
          </ul>
        </template>
      </div>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import { DateTime } from 'luxon';
import { GROUP_LABELS, type MotorEvent, type Series, type SeriesHistory, type SeriesStatus } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import CalendarSubscribe from '../components/CalendarSubscribe.vue';
import CountdownBadge from '../components/CountdownBadge.vue';
import DataState from '../components/DataState.vue';
import FollowButton from '../components/FollowButton.vue';
import SeriesCrest from '../components/SeriesCrest.vue';
import SourceProblem from '../components/SourceProblem.vue';
import StandingsPanel from '../components/StandingsPanel.vue';
import RosterPanel from '../components/RosterPanel.vue';
import NewsList from '../components/NewsList.vue';
import PodiumLine from '../components/PodiumLine.vue';
import SurfaceBadge from '../components/SurfaceBadge.vue';
import SeriesHistoryPanel from '../components/SeriesHistoryPanel.vue';
import { useBiosStore } from '../stores/bios.ts';
import { hasStages, stagesEventStatus } from '../lib/stages.ts';
import { newsForSeries, useNewsStore } from '../stores/news.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { formatDateRange, monthShort, timeAgo, timetablesText } from '../lib/format.ts';
import { tabStrip } from '../lib/tabStrip.ts';
import { seriesColor } from '../lib/grid.ts';
import { nextEventOf, pastEventsOf, todayIn, type NextEvent } from '../lib/agenda.ts';

type Tab = 'resumen' | 'calendario' | 'tabla' | 'plantel' | 'resultados' | 'historia' | 'noticias';

/** Página de una categoría (como la de un equipo en FotMob). */
export default defineComponent({
  name: 'CategoryView',
  components: { AppIcon, CalendarSubscribe, CountdownBadge, DataState, FollowButton, NewsList, PodiumLine, RosterPanel, SeriesCrest, SeriesHistoryPanel, SourceProblem, StandingsPanel, SurfaceBadge },
  directives: { tabStrip },
  computed: {
    ...mapState(useScheduleStore, ['schedule', 'status', 'hasData', 'now', 'seriesById']),
    ...mapState(useSettingsStore, ['timeZone']),
    ...mapState(useNewsStore, { newsItems: 'items' }),
    ...mapState(useBiosStore, { histories: 'seriesById', historyStatus: 'seriesStatus' }),
    /** Historia de la categoría (campeones, récords): llega aparte y puede no estar. */
    history(): SeriesHistory | undefined {
      return this.series ? this.histories.get(this.series.id) : undefined;
    },
    seriesNews() {
      return this.series ? newsForSeries(this.newsItems, [this.series.id]) : [];
    },
    series(): Series | undefined {
      return this.seriesById.get(String(this.$route.params.seriesId));
    },
    color(): string {
      return seriesColor(this.series);
    },
    groupLabel(): string {
      return this.series ? GROUP_LABELS[this.series.group] : '';
    },
    officialUrl(): string {
      return this.series?.officialUrls[0] ?? '';
    },
    tabs(): Array<{ id: Tab; label: string }> {
      return [
        { id: 'resumen', label: 'Resumen' },
        { id: 'calendario', label: 'Calendario' },
        { id: 'tabla', label: 'Tabla' },
        { id: 'plantel', label: 'Plantel' },
        { id: 'resultados', label: 'Resultados' },
        // La pestaña aparece cuando hay historia (o si se entró directo con ?tab=historia).
        ...(this.history || this.$route.query.tab === 'historia' ? [{ id: 'historia' as Tab, label: 'Historia' }] : []),
        { id: 'noticias', label: 'Noticias' },
      ];
    },
    tab(): Tab {
      const q = this.$route.query.tab;
      return q === 'calendario' || q === 'tabla' || q === 'plantel' || q === 'resultados' || q === 'historia' || q === 'noticias' ? q : 'resumen';
    },
    events(): MotorEvent[] {
      return (this.schedule?.events ?? [])
        .filter((e) => e.seriesId === this.series?.id)
        .sort((a, b) => a.dateStart.localeCompare(b.dateStart));
    },
    next(): NextEvent | null {
      return this.series ? nextEventOf(this.schedule, this.series.id, this.now) : null;
    },
    nextText(): string {
      const n = this.next;
      if (!n) return '';
      // Rally con el recorrido publicado pero sin horas de largada (Dakar): no es "a confirmar".
      if (!n.nextSession && hasStages(n.event)) return stagesEventStatus(n.event, todayIn(this.now, this.timeZone)).text;
      if (!n.nextSession) return 'Horarios a confirmar';
      const when = DateTime.fromISO(n.nextSession.startUtc, { zone: 'utc' }).setZone(this.timeZone).setLocale('es-AR');
      return `${n.live ? 'En vivo' : 'Próxima'}: ${n.nextSession.name} · ${when.toFormat("ccc d, HH:mm")}`;
    },
    past(): MotorEvent[] {
      return this.series ? pastEventsOf(this.schedule, this.series.id, this.now) : [];
    },
    recent(): MotorEvent[] {
      return this.past.filter((e) => e.id !== this.next?.event.id).slice(0, 3);
    },
    withResults(): MotorEvent[] {
      return this.past.filter((e) => this.eventHasResults(e.id));
    },
    seriesStatus(): SeriesStatus | undefined {
      return this.status?.series.find((s) => s.seriesId === this.series?.id);
    },
    timetablesLine(): string {
      return this.seriesStatus?.timetables ? timetablesText(this.seriesStatus.timetables) : '';
    },
    /** La última lectura de la fuente oficial falló (o está vieja). */
    sourceFailing(): boolean {
      return this.seriesStatus?.state === 'error' || this.seriesStatus?.state === 'stale';
    },
    statusBadge(): { label: string; cls: string } {
      switch (this.seriesStatus?.state) {
        case 'ok':
          return { label: 'Fuente OK', cls: 'badge-ok' };
        case 'stale':
          return { label: 'Desactualizada', cls: 'badge-warn' };
        case 'error':
          return { label: 'Error de fuente', cls: 'badge-error' };
        case 'disabled':
          return { label: 'Desactivada', cls: 'badge-dim' };
        default:
          return { label: 'Sin verificar', cls: 'badge-dim' };
      }
    },
  },
  created() {
    // Un solo archivo para todas las categorías: se pide una vez.
    void this.loadHistory();
  },
  methods: {
    ...mapActions(useBiosStore, { loadHistory: 'loadSeries' }),
    setTab(tab: Tab) {
      void this.$router.replace({ query: { ...this.$route.query, tab } });
    },
    eventHasResults(eventId: string): boolean {
      return (this.schedule?.sessions ?? []).some((s) => s.eventId === eventId && s.hasResults);
    },
    /** "Fecha N ·" solo si el nombre del evento no lo dice ya. */
    showRound(ev: MotorEvent): boolean {
      return !!ev.round && !/^(fechas?|ronda|round)\s/i.test(ev.name);
    },
    isPast(ev: MotorEvent): boolean {
      return ev.dateEnd < todayIn(this.now, ev.tz);
    },
    dayNum(date: string): string {
      return String(Number(date.slice(8, 10)));
    },
    monthShort,
    ago(iso: string): string {
      return timeAgo(iso, this.now);
    },
    dateRange: formatDateRange,
  },
});
</script>

<style>
.countdown-line {
  margin-top: 0.3rem;
}

.cal-surface {
  margin-left: 0.4rem;
}
</style>
