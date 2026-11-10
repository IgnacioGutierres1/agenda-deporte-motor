<template>
  <div class="following-view">
    <nav class="underline-tabs page-tabs" role="tablist">
      <button
        v-for="t in tabs"
        :key="t.id"
        type="button"
        role="tab"
        class="underline-tab"
        :class="{ active: tab === t.id }"
        :aria-selected="tab === t.id"
        @click="tab = t.id"
      >
        {{ t.label }}
      </button>
      <span class="grow" />
      <RouterLink to="/categorias" class="icon-btn" aria-label="Agregar categorías" title="Agregar categorías">
        <AppIcon name="plus" />
      </RouterLink>
    </nav>

    <div class="page">
      <DataState />

      <template v-if="tab === 'categorias' && hasData">
        <div v-if="!cards.length" class="card empty center">
          <p>Todavía no seguís ninguna categoría.</p>
          <RouterLink to="/categorias" class="btn btn-primary">Elegir categorías</RouterLink>
        </div>
        <div v-else class="follow-grid">
          <RouterLink
            v-for="c in cards"
            :key="c.series.id"
            :to="`/categoria/${c.series.id}`"
            class="follow-card"
            :style="{ '--card-color': c.color }"
          >
            <SeriesCrest :series="c.series" :size="34" />
            <span class="follow-card-name">{{ c.series.shortName || c.series.name }}</span>
            <span class="follow-card-next">
              <template v-if="c.next">
                <span class="follow-card-event">{{ c.next.event.name }}</span>
                <span :class="{ 'live-chip': c.next.live }">{{ c.when }}</span>
              </template>
              <template v-else>Sin fechas próximas</template>
            </span>
          </RouterLink>
          <RouterLink to="/categorias" class="follow-card add-card">
            <AppIcon name="plus" :size="30" />
            <span>Agregar</span>
          </RouterLink>
        </div>
      </template>

      <div v-else-if="tab === 'pilotos'" class="card empty center">
        <p><strong>Seguimiento de pilotos</strong></p>
        <p class="small dim">Próximamente: vas a poder seguir pilotos y ver sus resultados y su posición en el campeonato.</p>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapState } from 'pinia';
import { DateTime } from 'luxon';
import type { Series } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import DataState from '../components/DataState.vue';
import SeriesCrest from '../components/SeriesCrest.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { seriesColor } from '../lib/grid.ts';
import { nextEventOf, type NextEvent } from '../lib/agenda.ts';

interface FollowCard {
  series: Series;
  color: string;
  next: NextEvent | null;
  when: string;
}

/** Lo que sigue el usuario (como "Siguiendo" en FotMob): tarjetas con la próxima fecha. */
export default defineComponent({
  name: 'FollowingView',
  components: { AppIcon, DataState, SeriesCrest },
  data() {
    return {
      tab: 'categorias' as 'categorias' | 'pilotos',
      tabs: [
        { id: 'categorias' as const, label: 'Categorías' },
        { id: 'pilotos' as const, label: 'Pilotos' },
      ],
    };
  },
  computed: {
    ...mapState(useScheduleStore, ['schedule', 'hasData', 'now', 'seriesById']),
    ...mapState(useSettingsStore, ['followedSeries', 'timeZone']),
    cards(): FollowCard[] {
      const out: FollowCard[] = [];
      for (const id of this.followedSeries) {
        const series = this.seriesById.get(id);
        if (!series) continue;
        const next = nextEventOf(this.schedule, id, this.now);
        out.push({ series, color: seriesColor(series), next, when: this.whenText(next) });
      }
      return out;
    },
  },
  methods: {
    whenText(next: NextEvent | null): string {
      if (!next) return '';
      if (next.live) return 'En vivo';
      if (next.nextSession) {
        return DateTime.fromISO(next.nextSession.startUtc, { zone: 'utc' })
          .setZone(this.timeZone)
          .setLocale('es-AR')
          .toFormat("ccc d LLL, HH:mm")
          .replace(/\./g, '');
      }
      return DateTime.fromISO(next.event.dateStart).setLocale('es-AR').toFormat('ccc d LLL').replace(/\./g, '') + ' · a confirmar';
    },
  },
});
</script>

<style>
.follow-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.6rem;
}

.follow-card {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  min-height: 150px;
  padding: 0.85rem;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--card-color) 78%, #000);
  color: #fff;
  text-decoration: none;
}

.follow-card:hover {
  text-decoration: none;
}

.follow-card .crest {
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.35);
}

.follow-card-name {
  font-weight: 900;
  font-size: 1.15rem;
  line-height: 1.15;
}

.follow-card-next {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  font-size: 0.78rem;
  opacity: 0.92;
}

.follow-card-event {
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live-chip {
  color: #fff;
  font-weight: 800;
}

.add-card {
  align-items: center;
  justify-content: center;
  background: var(--bg-elev);
  color: var(--text-dim);
  border: 2px dashed var(--border);
}
</style>
