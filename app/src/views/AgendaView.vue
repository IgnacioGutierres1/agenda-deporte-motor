<template>
  <div class="agenda-view" :class="{ 'has-fab': showFab }">
    <div class="strip-bar">
    <button
      type="button"
      class="day-tab weekend-tab"
      :class="{ active: isWeekend }"
      :aria-current="isWeekend ? 'date' : undefined"
      @click="setAgendaDay('finde')"
    >
      Finde
    </button>
    <nav ref="strip" v-tab-strip.nocenter class="day-strip" aria-label="Día" @scroll.passive="checkTodayTab">
      <button
        v-for="d in days"
        :key="d.value"
        type="button"
        class="day-tab"
        :class="{ active: d.value === selectedDay, weekend: d.value === 'finde' }"
        :data-day="d.value"
        :aria-current="d.value === selectedDay ? 'date' : undefined"
        @click="setAgendaDay(d.value)"
      >
        {{ d.label }}
      </button>
    </nav>
    </div>

    <div class="page">
      <DataState />

      <template v-if="hasData">
        <p class="zone-note small dim">
          <AppIcon name="clock" :size="14" />
          <span>Horarios en {{ zoneName.charAt(0).toLowerCase() + zoneName.slice(1) }}</span>
        </p>

        <!-- Día sin sesiones: que quede claro, con la próxima sesión -->
        <section v-if="!agendaCards.length" class="card flush empty-day" role="status">
          <p class="empty-day-title">{{ emptyText }}</p>
          <RouterLink v-if="agendaNext" :to="nextLink" class="list-row empty-day-next">
            <SeriesCrest :series="agendaNext.series" :size="26" />
            <span class="grow">
              <span class="block small dim">Próxima</span>
              <strong>{{ agendaNext.series.shortName || agendaNext.series.name }}</strong>
              <span> · {{ agendaNext.session.name }}</span>
              <span class="block small accent-text">{{ nextWhen }}</span>
            </span>
            <AppIcon name="chevron" :size="16" class="dim" />
          </RouterLink>
          <p v-else class="card-foot small dim">No hay sesiones publicadas más adelante.</p>
        </section>

        <!-- Siguiendo -->
        <section class="following-block">
          <h2 class="block-title">Siguiendo</h2>
          <template v-if="followedIds.length === 0">
            <p class="center small dim">
              Tocá ★ en una categoría, un piloto o un equipo para verlo primero acá.
            </p>
          </template>
          <template v-else-if="followedCards.length === 0 && followedPending.length === 0">
            <p class="center dim">{{ dayIsToday ? 'Hoy' : 'Este día' }} no corren tus categorías</p>
            <RouterLink v-if="nextFollowed" :to="`/evento/${nextFollowed.event.id}`" class="next-pill">
              <SeriesCrest :series="nextFollowed.series" :size="22" />
              <span>
                <strong>{{ nextFollowed.series.shortName }}</strong>
                <span class="small dim"> · {{ nextFollowed.event.name }}</span>
                <span class="block small">{{ nextFollowedWhen }}</span>
              </span>
            </RouterLink>
          </template>
          <EventCard
            v-for="c in followedCards"
            :key="c.key"
            :series="c.series"
            :event="c.event"
            :items="c.items"
            :live="c.live"
            :show-day="isWeekend"
            :collapsed="isCollapsed(c.key, false)"
            @toggle="toggle(c.key, false)"
            @select="selected = $event"
          />
          <PendingList v-if="followedPending.length" :items="followedPending" :title="pendingTitle" />
          <StarterPack variant="chips" />
          <p v-if="followedIds.length === 0" class="center">
            <RouterLink to="/categorias" class="pill choose-pill">Elegir categorías</RouterLink>
          </p>
        </section>

        <div class="center">
          <button v-if="otherCards.length || otherPending.length" type="button" class="pill toggle-all" @click="toggleAll">
            {{ allCollapsed ? 'Mostrar todas' : 'Ocultar todas' }}
            <AppIcon name="chevron" :size="16" class="chev" :class="{ up: !allCollapsed, down: allCollapsed }" />
          </button>
        </div>

        <p v-if="allCollapsed && otherCards.length" class="center small dim">
          {{ summary }}
        </p>

        <template v-if="!allCollapsed">
          <EventCard
            v-for="c in otherCards"
            :key="c.key"
            :series="c.series"
            :event="c.event"
            :items="c.items"
            :live="c.live"
            :show-day="isWeekend"
            :collapsed="isCollapsed(c.key, true)"
            @toggle="toggle(c.key, true)"
            @select="selected = $event"
          />
          <PendingList v-if="otherPending.length" :items="otherPending" :title="pendingTitle" />
        </template>
      </template>
    </div>

    <button v-if="showFab" type="button" class="today-fab" @click="goToday">Hoy</button>

    <SessionSheet :item="selected" :time-zone="timeZone" :now="now" @close="selected = null" />
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import { DateTime } from 'luxon';
import type { MotorEvent, Series } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import DataState from '../components/DataState.vue';
import EventCard from '../components/EventCard.vue';
import PendingList from '../components/PendingList.vue';
import SeriesCrest from '../components/SeriesCrest.vue';
import SessionSheet from '../components/SessionSheet.vue';
import StarterPack from '../components/StarterPack.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import {
  WEEKEND,
  emptyDayText,
  nextEventOf,
  pendingTitle,
  relativeDay,
  splitFollowed,
  type AgendaCard,
  type NextSession,
} from '../lib/agenda.ts';
import { zoneDisplayName } from '../lib/format.ts';
import { centerChild, tabStrip } from '../lib/tabStrip.ts';
import type { GridItem, PendingItem } from '../lib/grid.ts';

/** Pantalla principal: franja de días y sesiones agrupadas por evento (estilo FotMob). */
export default defineComponent({
  name: 'AgendaView',
  components: { AppIcon, DataState, EventCard, PendingList, SeriesCrest, SessionSheet, StarterPack },
  directives: { tabStrip },
  data() {
    return {
      /** La pestaña "Hoy" de la franja quedó fuera de la vista (por el scroll horizontal). */
      todayTabHidden: false,
      selected: null as GridItem | null,
      allCollapsed: false,
      /** Tarjetas plegadas/desplegadas a mano (invierte el estado por defecto). */
      toggled: [] as string[],
    };
  },
  computed: {
    ...mapState(useScheduleStore, ['hasData', 'strip', 'selectedDay', 'today', 'agendaCards', 'agendaPending', 'agendaNext', 'schedule', 'now', 'seriesById']),
    ...mapState(useSettingsStore, { followedIds: 'followedSeriesIds', timeZone: 'timeZone' }),
    /** Días de la franja (el "Finde" va fijo a la izquierda). */
    days() {
      return this.strip.filter((d) => d.value !== WEEKEND);
    },
    isWeekend(): boolean {
      return this.selectedDay === WEEKEND;
    },
    dayIsToday(): boolean {
      return this.selectedDay === this.today;
    },
    /**
     * Botón flotante "Hoy": si se eligió otro día, o si la pestaña "Hoy" quedó fuera de la franja.
     * En "Finde" no aparece salvo que "Hoy" no se vea (ahí sería ambiguo).
     */
    showFab(): boolean {
      return (!this.isWeekend && !this.dayIsToday) || this.todayTabHidden;
    },
    zoneName(): string {
      return zoneDisplayName(this.timeZone);
    },
    emptyText(): string {
      return emptyDayText(this.selectedDay, this.today, this.timeZone);
    },
    pendingTitle(): string {
      return pendingTitle(this.selectedDay, this.now, this.timeZone);
    },
    nextLink(): string {
      const n = this.agendaNext as NextSession | null;
      if (!n) return '';
      return n.event ? `/evento/${n.event.id}` : `/categoria/${n.series.id}`;
    },
    /** "Mañana a las 06:10 (madrugada)", "El viernes 20 a las 21:30". */
    nextWhen(): string {
      const n = this.agendaNext as NextSession | null;
      if (!n) return '';
      const start = DateTime.fromISO(n.session.startUtc, { zone: 'utc' }).setZone(this.timeZone);
      const rel = relativeDay(start.toISODate()!, this.today, this.timeZone);
      const late = start.hour < 7 ? ' (madrugada)' : '';
      return `${rel.charAt(0).toUpperCase()}${rel.slice(1)} a las ${start.toFormat('HH:mm')}${late}`;
    },
    cardsSplit(): { followed: AgendaCard[]; rest: AgendaCard[] } {
      return splitFollowed(this.agendaCards, this.followedIds);
    },
    pendingSplit(): { followed: PendingItem[]; rest: PendingItem[] } {
      return splitFollowed(this.agendaPending, this.followedIds);
    },
    followedCards(): AgendaCard[] {
      return this.cardsSplit.followed;
    },
    otherCards(): AgendaCard[] {
      return this.cardsSplit.rest;
    },
    followedPending(): PendingItem[] {
      return this.pendingSplit.followed;
    },
    otherPending(): PendingItem[] {
      return this.pendingSplit.rest;
    },
    /** Próximo evento de las categorías seguidas (cuando hoy no corren). */
    nextFollowed(): { series: Series; event: MotorEvent; startUtc?: string } | null {
      let best: { series: Series; event: MotorEvent; startUtc?: string } | null = null;
      for (const id of this.followedIds) {
        const series = this.seriesById.get(id);
        const next = series ? nextEventOf(this.schedule, id, this.now) : null;
        if (!series || !next) continue;
        if (!best || next.event.dateStart < best.event.dateStart) {
          best = { series, event: next.event, ...(next.nextSession ? { startUtc: next.nextSession.startUtc } : {}) };
        }
      }
      return best;
    },
    nextFollowedWhen(): string {
      const n = this.nextFollowed;
      if (!n) return '';
      if (n.startUtc) {
        return DateTime.fromISO(n.startUtc, { zone: 'utc' }).setZone(this.timeZone).setLocale('es-AR').toFormat("cccc d 'de' LLL · HH:mm");
      }
      return DateTime.fromISO(n.event.dateStart).setLocale('es-AR').toFormat("cccc d 'de' LLL") + ' · horarios a confirmar';
    },
    summary(): string {
      const names = [...new Set(this.otherCards.map((c) => c.series.shortName || c.series.name))];
      const when = this.isWeekend ? 'Este finde corren' : this.dayIsToday ? 'Hoy corren' : 'Ese día corren';
      if (names.length <= 2) return `${when} ${names.join(' y ')}`;
      return `${when} ${names.slice(0, 2).join(', ')} y ${names.length - 2} categorías más`;
    },
  },
  watch: {
    selectedDay() {
      this.toggled = [];
      this.scrollStrip(true);
    },
  },
  mounted() {
    this.scrollStrip(false);
    window.addEventListener('resize', this.checkTodayTab, { passive: true });
  },
  beforeUnmount() {
    window.removeEventListener('resize', this.checkTodayTab);
  },
  methods: {
    ...mapActions(useScheduleStore, ['setAgendaDay']),
    isCollapsed(key: string, _other: boolean): boolean {
      return this.toggled.includes(key);
    },
    toggle(key: string, _other: boolean) {
      this.toggled = this.toggled.includes(key) ? this.toggled.filter((k) => k !== key) : [...this.toggled, key];
    },
    toggleAll() {
      this.allCollapsed = !this.allCollapsed;
    },
    goToday() {
      if (this.dayIsToday) this.scrollStrip(true);
      else this.setAgendaDay(this.today);
    },
    /** Centra el día elegido en la franja (en "Finde", el día de hoy). */
    scrollStrip(smooth: boolean) {
      this.$nextTick(() => {
        const strip = this.$refs.strip as HTMLElement | undefined;
        const day = this.isWeekend ? this.today : this.selectedDay;
        const el = strip?.querySelector<HTMLElement>(`[data-day="${day}"]`);
        if (strip && el) centerChild(strip, el, smooth);
        // Con scroll suave la posición final se conoce al terminar: se revisa también un rato después.
        this.checkTodayTab();
        if (smooth) setTimeout(() => this.checkTodayTab(), 450);
      });
    },
    /** ¿La pestaña "Hoy" se ve en la franja? (si no, aparece el botón flotante). */
    checkTodayTab() {
      const strip = this.$refs.strip as HTMLElement | undefined;
      const el = strip?.querySelector<HTMLElement>(`[data-day="${this.today}"]`);
      if (!strip || !el) return;
      const s = strip.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      if (!s.width) return;
      this.todayTabHidden = r.right <= s.left + r.width / 2 || r.left >= s.right - r.width / 2;
    },
  },
});
</script>

<style>
.strip-bar {
  position: sticky;
  top: calc(var(--header-h) + var(--safe-top));
  z-index: 5;
  display: flex;
  background: var(--bg-header);
  border-bottom: 1px solid var(--border);
}

.weekend-tab {
  border-right: 1px solid var(--border) !important;
}

.day-strip {
  display: flex;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.day-strip::-webkit-scrollbar {
  display: none;
}

.day-tab {
  flex: none;
  min-height: 44px;
  padding: 0 0.85rem;
  background: transparent;
  border: none;
  border-bottom: 3px solid transparent;
  color: var(--text-dim);
  font-weight: 600;
  font-size: 0.92rem;
  white-space: nowrap;
}

.day-tab.active {
  color: var(--text);
  font-weight: 800;
  border-bottom-color: var(--accent);
}

.weekend-tab:not(.active) {
  color: var(--accent);
}

.following-block {
  margin-bottom: 0.75rem;
}

.block-title {
  text-align: center;
  font-size: 1rem;
  font-weight: 800;
  margin: 0.5rem 0 0.35rem;
}

.center {
  text-align: center;
}

.block {
  display: block;
}

.next-pill {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: fit-content;
  max-width: 100%;
  margin: 0.6rem auto 0.25rem;
  padding: 0.5rem 0.9rem;
  border-radius: 14px;
  background: var(--bg-elev);
  color: var(--text);
}

.next-pill:hover {
  text-decoration: none;
}

.toggle-all {
  margin: 0.25rem auto 0.75rem;
}

.chev.up {
  transform: rotate(-90deg);
}

.chev.down {
  transform: rotate(90deg);
}

.empty-day {
  margin-bottom: 0.75rem;
}

.empty-day-title {
  margin: 0;
  padding: 0.85rem 0.85rem 0.35rem;
  font-weight: 800;
  font-size: 1rem;
}

.empty-day-next {
  border-top: 1px solid var(--border);
}

a.choose-pill {
  color: var(--accent);
  border: 1px solid color-mix(in srgb, var(--accent) 55%, transparent);
  background: transparent;
  text-decoration: none;
}

a.choose-pill:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  text-decoration: none;
}

/* Con el botón "Hoy" visible, la lista deja lugar para que no tape la última sesión. */
.agenda-view.has-fab .page {
  padding-bottom: calc(1.5rem + 40px + 14px);
}

.today-fab {
  position: fixed;
  left: 50%;
  bottom: calc(var(--nav-h) + var(--safe-bottom) + 14px);
  transform: translateX(-50%);
  z-index: 20;
  min-height: 40px;
  padding: 0 1.3rem;
  border: none;
  border-radius: 999px;
  background: var(--accent);
  color: var(--accent-text);
  font-weight: 800;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.45);
}
</style>
