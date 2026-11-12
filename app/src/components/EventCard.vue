<template>
  <section class="event-card card flush" :class="{ collapsed }">
    <header class="event-card-head">
      <RouterLink :to="eventLink" class="event-card-title grow">
        <SeriesCrest :series="series" :size="24" />
        <span class="grow">
          <span class="event-card-series">{{ series.shortName || series.name }}</span>
          <span v-if="event" class="event-card-event"> · {{ event.name }}</span>
        </span>
        <span v-if="live" class="badge badge-live">En vivo</span>
      </RouterLink>
      <button
        type="button"
        class="icon-btn collapse-btn"
        :aria-expanded="!collapsed"
        :aria-label="collapsed ? 'Mostrar sesiones' : 'Ocultar sesiones'"
        @click="$emit('toggle')"
      >
        <span v-if="collapsed" class="small dim">{{ items.length }}</span>
        <AppIcon name="chevron" :size="18" class="chev" :class="{ open: !collapsed }" />
      </button>
    </header>
    <ul v-if="!collapsed" class="event-card-rows">
      <template v-for="g in dayGroups" :key="g.date">
      <li v-if="showDayHeaders" class="session-day-head">{{ g.label }}</li>
      <li
        v-for="item in g.items"
        :key="item.session.id"
        class="session-line"
        :class="{ live: item.live, finished: item.finished, next: item.session.id === nextId }"
      >
        <button type="button" class="session-line-btn" @click="$emit('select', item)">
          <span class="session-time">
            <template v-if="item.live"><span class="live-dot" />En vivo</template>
            <template v-else>
              <strong>{{ time(item.session.startUtc) }}</strong>
              <span v-if="item.finished" class="small dim">Final</span>
            </template>
          </span>
          <span class="session-info grow">
            <span class="session-name">{{ item.session.name }}</span>
            <span class="session-sub small dim">
              <span v-if="lateNight(item.session.startUtc)" class="late-tag" title="De madrugada en tu zona horaria">
                <AppIcon name="moon" :size="12" />madrugada
              </span>
              <template v-if="lateNight(item.session.startUtc)"> · </template>{{ broadcast(item) }}
            </span>
          </span>
          <span class="session-flags">
            <CountdownBadge v-if="item.session.id === nextId" :start-utc="item.session.startUtc" :end-utc="item.session.endUtc" />
            <span v-if="item.session.source.kind === 'image'" class="badge badge-dim" title="Horario leído de una imagen oficial">Imagen</span>
            <span v-if="item.session.changedAt" class="badge badge-warn">Cambió</span>
            <span v-if="item.finished && item.session.hasResults" class="results-dot" title="Con resultados" />
          </span>
        </button>
      </li>
      </template>
    </ul>
  </section>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapState } from 'pinia';
import { DateTime } from 'luxon';
import type { MotorEvent, Series } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import CountdownBadge from './CountdownBadge.vue';
import SeriesCrest from './SeriesCrest.vue';
import { useSettingsStore } from '../stores/settings.ts';
import type { GridItem } from '../lib/grid.ts';
import { groupSessionsByDay, isLateNight, type SessionDayGroup } from '../lib/agenda.ts';

/** Tarjeta de un evento en la Agenda (como una competencia en FotMob). */
export default defineComponent({
  name: 'EventCard',
  components: { AppIcon, CountdownBadge, SeriesCrest },
  props: {
    series: { type: Object as PropType<Series>, required: true },
    event: { type: Object as PropType<MotorEvent>, default: undefined },
    items: { type: Array as PropType<GridItem[]>, required: true },
    live: { type: Boolean, default: false },
    collapsed: { type: Boolean, default: false },
    /** Separar las sesiones por día con subtítulos "Viernes 13" (vista "Finde"). */
    showDay: { type: Boolean, default: false },
    /** Sesión a destacar con su cuenta regresiva (la próxima del día o del finde elegido). */
    nextId: { type: String, default: '' },
  },
  emits: ['toggle', 'select'],
  computed: {
    ...mapState(useSettingsStore, ['timeZone']),
    dayGroups(): SessionDayGroup[] {
      return groupSessionsByDay(this.items, this.timeZone);
    },
    /** Subtítulos por día en "Finde" o si la tarjeta cruza la medianoche. */
    showDayHeaders(): boolean {
      return this.showDay || this.dayGroups.length > 1;
    },
    eventLink(): string {
      return this.event ? `/evento/${this.event.id}` : `/categoria/${this.series.id}`;
    },
  },
  methods: {
    time(iso: string): string {
      return DateTime.fromISO(iso, { zone: 'utc' }).setZone(this.timeZone).toFormat('HH:mm');
    },
    lateNight(iso: string): boolean {
      return isLateNight(iso, this.timeZone);
    },
    broadcast(item: GridItem): string {
      return item.session.broadcast.length ? item.session.broadcast.join(', ') : 'TV a confirmar';
    },
  },
});
</script>

<style>
.event-card {
  margin: 0 0 0.75rem;
  overflow: hidden;
}

.event-card-head {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.35rem 0.25rem 0.35rem 0.85rem;
  border-bottom: 1px solid var(--border);
}

.event-card.collapsed .event-card-head {
  border-bottom: none;
}

.event-card-title {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-height: 40px;
  color: var(--text);
  font-size: 0.92rem;
  min-width: 0;
}

.event-card-title:hover {
  text-decoration: none;
}

.event-card-series {
  font-weight: 800;
}

.event-card-event {
  color: var(--text-dim);
  font-weight: 600;
}

.collapse-btn {
  gap: 0.3rem;
}

.chev {
  transition: transform 0.15s;
}

.chev.open {
  transform: rotate(90deg);
}

.event-card-rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.session-line + .session-line,
.session-day-head + .session-line {
  border-top: 1px solid var(--border);
}

.session-day-head {
  padding: 0.45rem 0.85rem 0.3rem;
  background: var(--bg-elev-2);
  color: var(--text);
  font-size: 0.78rem;
  font-weight: 800;
  letter-spacing: 0.02em;
}

.session-line + .session-day-head {
  border-top: 1px solid var(--border);
}

.late-tag {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  color: var(--warn, var(--text-dim));
}

.late-tag svg {
  flex: none;
}

.session-line-btn {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  width: 100%;
  min-height: 58px;
  padding: 0.5rem 0.85rem;
  background: transparent;
  border: none;
  color: var(--text);
  text-align: left;
}

.session-line-btn:active {
  background: var(--bg-elev-2);
}

.session-time {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 3.4rem;
  flex: none;
  font-variant-numeric: tabular-nums;
}

.session-line.live .session-time {
  color: var(--live);
  font-weight: 800;
  font-size: 0.8rem;
  flex-direction: row;
  gap: 0.3rem;
  justify-content: center;
}

.live-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--live);
  animation: pulse 1.4s infinite;
}

@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}

/* Próxima sesión del día elegido: barra de acento a la izquierda y cuenta regresiva. */
.session-line.next {
  box-shadow: inset 3px 0 0 var(--accent);
  background: color-mix(in srgb, var(--accent) 7%, transparent);
}

.session-line.next .session-time strong {
  color: var(--accent);
}

.session-line.finished .session-name {
  color: var(--text-dim);
}

.session-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.session-name {
  font-weight: 600;
}

.session-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-flags {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}

.results-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--accent);
}
</style>
