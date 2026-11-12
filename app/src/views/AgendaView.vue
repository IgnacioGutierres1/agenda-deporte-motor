<template>
  <div class="agenda-view">
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
    <nav ref="strip" class="day-strip" aria-label="Día">
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
        <!-- Siguiendo -->
        <section class="following-block">
          <h2 class="block-title">Siguiendo</h2>
          <template v-if="followedIds.length === 0">
            <p class="center small dim">
              Tocá ★ en una categoría, un piloto o un equipo para verlo primero acá.
              <RouterLink to="/categorias">Elegir categorías</RouterLink>
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
          <PendingList v-if="followedPending.length" :items="followedPending" />
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
          <PendingList v-if="otherPending.length" :items="otherPending" />
        </template>

        <p v-if="!agendaCards.length && !agendaPending.length" class="card empty center dim">
          No hay sesiones {{ isWeekend ? 'este fin de semana' : 'este día' }}.
        </p>
      </template>
    </div>

    <button v-if="!dayIsToday" type="button" class="today-fab" @click="goToday">Hoy</button>

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
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { WEEKEND, nextEventOf, splitFollowed, type AgendaCard } from '../lib/agenda.ts';
import type { GridItem, PendingItem } from '../lib/grid.ts';

/** Pantalla principal: franja de días y sesiones agrupadas por evento (estilo FotMob). */
export default defineComponent({
  name: 'AgendaView',
  components: { AppIcon, DataState, EventCard, PendingList, SeriesCrest, SessionSheet },
  data() {
    return {
      selected: null as GridItem | null,
      allCollapsed: false,
      /** Tarjetas plegadas/desplegadas a mano (invierte el estado por defecto). */
      toggled: [] as string[],
    };
  },
  computed: {
    ...mapState(useScheduleStore, ['hasData', 'strip', 'selectedDay', 'today', 'agendaCards', 'agendaPending', 'schedule', 'now', 'seriesById']),
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
      this.setAgendaDay(this.today);
    },
    /** Centra el día elegido en la franja. */
    scrollStrip(smooth: boolean) {
      this.$nextTick(() => {
        const strip = this.$refs.strip as HTMLElement | undefined;
        const el = strip?.querySelector<HTMLElement>(`[data-day="${this.selectedDay}"]`);
        if (!strip || !el || typeof strip.scrollTo !== 'function') return;
        strip.scrollTo({ left: el.offsetLeft - strip.clientWidth / 2 + el.clientWidth / 2, behavior: smooth ? 'smooth' : 'auto' });
      });
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
