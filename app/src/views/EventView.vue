<template>
  <div class="event-view">
    <DataState />
    <p v-if="hasData && !event" class="page card empty">No se encontró el evento. Puede que el calendario oficial haya cambiado.</p>

    <template v-if="event && series">
      <section class="hero" :style="{ '--series-color': color }">
        <div class="hero-top">
          <RouterLink :to="`/categoria/${series.id}`" class="hero-series">
            <SeriesCrest :series="series" :size="30" />
            <span>{{ series.name }}</span>
          </RouterLink>
          <FollowButton :series-id="series.id" :name="series.name" compact />
        </div>
        <h1 class="hero-title">{{ event.name }}</h1>
        <p class="hero-sub">
          <span v-if="event.round" class="pill pill-small">Fecha {{ event.round }}</span>
          {{ dateRange(event.dateStart, event.dateEnd) }} ·
          <RouterLink v-if="circuitLink" :to="circuitLink" class="circuit-link">{{ event.circuit }}</RouterLink><template v-else>{{ event.circuit }}</template><template v-if="event.country">, {{ event.country }}</template>
        </p>
        <p class="hero-status" :class="state.kind">{{ state.text }}</p>
      </section>

      <nav v-tab-strip="$route.path" class="underline-tabs page-tabs" role="tablist" aria-label="Secciones del evento">
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
        <!-- Horarios -->
        <section v-if="tab === 'horarios'">
          <div v-if="!items.length" class="card empty">
            <p><strong>Horarios a confirmar.</strong> El organizador todavía no publicó el cronograma.</p>
            <p class="small dim">Se revisa cada 3 horas de jueves a lunes y aparece acá apenas se publica.</p>
          </div>
          <p v-if="items.length" class="zone-note small dim">
            <AppIcon name="clock" :size="14" />
            <span>Horarios en {{ zoneName.charAt(0).toLowerCase() + zoneName.slice(1) }}</span>
          </p>
          <div v-for="d in days" :key="d.date" class="card flush day-card">
            <h3 class="card-title">{{ capitalize(d.label) }}</h3>
            <ul class="event-card-rows">
              <li v-for="item in d.items" :key="item.session.id" class="session-line" :class="{ live: item.live, finished: item.finished }">
                <button type="button" class="session-line-btn" @click="selected = item">
                  <span
                    class="session-time range"
                    :aria-label="item.live ? undefined : `de ${time(item.session.startUtc)} a ${time(item.session.endUtc)}`"
                  >
                    <template v-if="item.live"><span class="live-dot" />En vivo</template>
                    <template v-else>
                      <strong>{{ time(item.session.startUtc) }}</strong>
                      <span class="range-end" :title="item.session.endEstimated ? 'Hora de fin estimada' : undefined">–{{ time(item.session.endUtc) }}</span>
                    </template>
                  </span>
                  <span class="session-info grow">
                    <span class="session-name">{{ item.session.name }}</span>
                    <span class="session-sub small dim">
                      <span v-if="lateNight(item.session.startUtc)" class="late-tag" title="De madrugada en tu zona horaria">
                        <AppIcon name="moon" :size="12" />madrugada
                      </span>
                      <template v-if="lateNight(item.session.startUtc)"> · </template>{{ item.session.broadcast.length ? item.session.broadcast.join(', ') : 'TV a confirmar' }}
                    </span>
                  </span>
                  <span class="session-flags">
                    <span v-if="item.session.source.kind === 'image'" class="badge badge-dim">Imagen</span>
                    <span v-if="item.finished && item.session.hasResults" class="results-dot" title="Con resultados" />
                  </span>
                </button>
              </li>
            </ul>
          </div>
          <div class="card source-box">
            <div class="small dim">Fuente del calendario</div>
            <SourceLink :source="event.source" />
            <div v-if="timetableSource && timetableSource.url !== event.source.url">
              <div class="small dim">Fuente del cronograma</div>
              <SourceLink :source="timetableSource" />
            </div>
          </div>
        </section>

        <!-- Contexto -->
        <ContextPanel v-else-if="tab === 'contexto'" :event="event" :series="series" />

        <!-- Resultados -->
        <EventResults v-else-if="tab === 'resultados'" :event="event" :focus-session="focusSession" />

        <!-- Tabla -->
        <StandingsPanel v-else :series="series" />
      </div>

      <SessionSheet :item="selected" :time-zone="timeZone" :now="now" @close="selected = null" />
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapState } from 'pinia';
import { DateTime } from 'luxon';
import type { MotorEvent, Series, Source } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import ContextPanel from '../components/ContextPanel.vue';
import DataState from '../components/DataState.vue';
import EventResults from '../components/EventResults.vue';
import FollowButton from '../components/FollowButton.vue';
import SeriesCrest from '../components/SeriesCrest.vue';
import SessionSheet from '../components/SessionSheet.vue';
import SourceLink from '../components/SourceLink.vue';
import StandingsPanel from '../components/StandingsPanel.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { formatDateRange, zoneDisplayName } from '../lib/format.ts';
import { tabStrip } from '../lib/tabStrip.ts';
import { groupByDay, seriesColor, type GridDay, type GridItem } from '../lib/grid.ts';
import { isLateNight, todayIn } from '../lib/agenda.ts';
import { circuitId } from '../lib/circuits.ts';

type Tab = 'horarios' | 'contexto' | 'resultados' | 'tabla';

/** Página de un evento (como la de un partido en FotMob). */
export default defineComponent({
  name: 'EventView',
  components: { AppIcon, ContextPanel, DataState, EventResults, FollowButton, SeriesCrest, SessionSheet, SourceLink, StandingsPanel },
  directives: { tabStrip },
  data() {
    return { selected: null as GridItem | null };
  },
  computed: {
    ...mapState(useScheduleStore, ['schedule', 'hasData', 'now', 'seriesById']),
    ...mapState(useSettingsStore, ['timeZone']),
    event(): MotorEvent | undefined {
      return this.schedule?.events.find((e) => e.id === this.$route.params.eventId);
    },
    series(): Series | undefined {
      return this.event ? this.seriesById.get(this.event.seriesId) : undefined;
    },
    /** Página del circuito (todo lo que se corre ahí), si el nombre corresponde a un circuito. */
    circuitLink(): string {
      const id = this.event ? circuitId(this.event.circuit) : '';
      return id ? `/circuito/${id}` : '';
    },
    color(): string {
      return seriesColor(this.series);
    },
    zoneName(): string {
      return zoneDisplayName(this.timeZone);
    },
    items(): GridItem[] {
      if (!this.event || !this.series) return [];
      const ev = this.event;
      const series = this.series;
      return (this.schedule?.sessions ?? [])
        .filter((s) => s.eventId === ev.id)
        .sort((a, b) => a.startUtc.localeCompare(b.startUtc))
        .map((session) => ({
          session,
          event: ev,
          series,
          live: session.startUtc <= this.now && this.now < session.endUtc,
          finished: session.endUtc <= this.now,
        }));
    },
    days(): GridDay[] {
      return groupByDay(this.items, this.timeZone);
    },
    timetableSource(): Source | undefined {
      return this.items[0]?.session.source;
    },
    hasResults(): boolean {
      return this.items.some((i) => i.session.hasResults);
    },
    tabs(): Array<{ id: Tab; label: string }> {
      return [
        { id: 'horarios', label: 'Horarios' },
        { id: 'contexto', label: 'Contexto' },
        { id: 'resultados', label: 'Resultados' },
        { id: 'tabla', label: 'Tabla' },
      ];
    },
    tab(): Tab {
      const q = this.$route.query.tab;
      // Horarios queda por defecto; "Ponerme en contexto" (En vivo, ficha de la sesión) abre ?tab=contexto.
      return q === 'contexto' || q === 'resultados' || q === 'tabla' ? q : 'horarios';
    },
    focusSession(): string {
      return (this.$route.query.session as string | undefined) ?? '';
    },
    /** Estado del evento: en vivo, próxima sesión, finalizado o a confirmar. */
    state(): { kind: string; text: string } {
      const ev = this.event!;
      const live = this.items.find((i) => i.live);
      if (live) return { kind: 'live', text: `En vivo: ${live.session.name}` };
      const next = this.items.find((i) => !i.finished);
      if (next) {
        const when = DateTime.fromISO(next.session.startUtc, { zone: 'utc' }).setZone(this.timeZone).setLocale('es-AR');
        return { kind: 'next', text: `Próxima: ${next.session.name} · ${when.toFormat("ccc d 'de' LLL, HH:mm")}` };
      }
      if (ev.dateEnd < todayIn(this.now, ev.tz)) return { kind: 'done', text: 'Finalizado' };
      if (!this.items.length) return { kind: 'pending', text: 'Horarios a confirmar' };
      return { kind: 'done', text: 'Sesiones terminadas' };
    },
  },
  watch: {
    /** Al cambiar de pestaña (p. ej. "Ponerme en contexto" desde la ficha de la sesión) se cierra la ficha. */
    tab() {
      this.selected = null;
    },
  },
  methods: {
    setTab(tab: Tab) {
      void this.$router.replace({ query: { ...this.$route.query, tab } });
    },
    time(iso: string): string {
      return DateTime.fromISO(iso, { zone: 'utc' }).setZone(this.timeZone).toFormat('HH:mm');
    },
    lateNight(iso: string): boolean {
      return isLateNight(iso, this.timeZone);
    },
    capitalize(s: string): string {
      return s.charAt(0).toUpperCase() + s.slice(1);
    },
    dateRange: formatDateRange,
  },
});
</script>

<style>
a.circuit-link {
  color: var(--text);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--text) 40%, transparent);
  text-underline-offset: 2px;
}

.day-card {
  margin: 0 0 0.75rem;
}

/* "21:30–22:30" en una línea: inicio en negrita, fin atenuado. */
.session-time.range {
  flex-direction: row;
  align-items: baseline;
  justify-content: flex-start;
  width: auto;
  min-width: 5.6rem;
  white-space: nowrap;
}

.session-time.range .range-end {
  color: var(--text-dim);
  font-size: 0.88rem;
}

.source-box > div + div {
  margin-top: 0.5rem;
}
</style>
