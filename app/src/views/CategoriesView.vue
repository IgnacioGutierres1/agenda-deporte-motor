<template>
  <div class="page categories-view">
    <label class="search-box">
      <AppIcon name="search" :size="18" />
      <input v-model="query" type="search" class="search-input" placeholder="Buscar categorías" aria-label="Buscar categorías" />
    </label>

    <DataState />

    <template v-if="hasData">
      <template v-if="query">
        <ul v-if="matches.length" class="list-card">
          <li v-for="s in matches" :key="s.id">
            <SeriesRow :series="s" />
          </li>
        </ul>
        <p v-else class="card empty dim">No hay categorías que coincidan con "{{ query }}".</p>
      </template>

      <template v-else>
        <div class="section-head">
          <h2 class="section-title">Siguiendo</h2>
          <button v-if="followed.length" type="button" class="link-btn" @click="editing = !editing">
            {{ editing ? 'Listo' : 'Editar' }}
          </button>
        </div>
        <p v-if="!followed.length" class="card empty small dim">
          Tocá la ★ de una categoría para seguirla: aparece primero en la Agenda y en Siguiendo.
        </p>
        <ul v-else class="list-card">
          <li v-for="s in followed" :key="s.id">
            <div v-if="editing" class="list-row">
              <SeriesCrest :series="s" :size="30" />
              <span class="grow">{{ s.name }}</span>
              <button type="button" class="btn btn-small btn-danger" @click="toggleFollow(s.id)">Quitar</button>
            </div>
            <SeriesRow v-else :series="s" />
          </li>
        </ul>

        <h2 class="section-title">Todas las categorías</h2>
        <div v-for="g in groups" :key="g.group" class="group-block">
          <button type="button" class="list-row group-head" :aria-expanded="isOpen(g.group)" @click="toggleGroup(g.group)">
            <span class="grow"><strong>{{ g.label }}</strong> <span class="small dim">{{ g.items.length }}</span></span>
            <AppIcon name="chevron" :size="18" class="chev" :class="{ open: isOpen(g.group) }" />
          </button>
          <ul v-if="isOpen(g.group)" class="list-card group-list">
            <li v-for="i in g.items" :key="i.series.id">
              <SeriesRow :series="i.series" />
            </li>
          </ul>
        </div>
      </template>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import type { Series, SeriesGroup } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import DataState from '../components/DataState.vue';
import SeriesCrest from '../components/SeriesCrest.vue';
import SeriesRow from '../components/SeriesRow.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { groupSeries, seriesSort } from '../lib/grid.ts';

const normalize = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Todas las categorías (como "Ligas" en FotMob): búsqueda, seguidas y agrupadas. */
export default defineComponent({
  name: 'CategoriesView',
  components: { AppIcon, DataState, SeriesCrest, SeriesRow },
  data() {
    return {
      query: '',
      editing: false,
      openGroups: [] as SeriesGroup[],
    };
  },
  computed: {
    ...mapState(useScheduleStore, ['schedule', 'hasData', 'seriesById']),
    ...mapState(useSettingsStore, ['followedSeries']),
    all(): Series[] {
      return (this.schedule?.series ?? []).filter((s) => s.enabled).sort(seriesSort);
    },
    followed(): Series[] {
      return this.followedSeries.map((id) => this.seriesById.get(id)).filter((s): s is Series => !!s);
    },
    groups() {
      return groupSeries(this.all.map((series) => ({ series })));
    },
    matches(): Series[] {
      const q = normalize(this.query.trim());
      return this.all.filter((s) => normalize(`${s.name} ${s.shortName}`).includes(q));
    },
  },
  watch: {
    followed(list: Series[]) {
      if (!list.length) this.editing = false;
    },
  },
  methods: {
    ...mapActions(useSettingsStore, ['toggleFollow']),
    isOpen(group: SeriesGroup): boolean {
      return this.openGroups.includes(group);
    },
    toggleGroup(group: SeriesGroup) {
      this.openGroups = this.isOpen(group) ? this.openGroups.filter((g) => g !== group) : [...this.openGroups, group];
    },
  },
});
</script>

<style>
.group-block {
  margin-bottom: 0.5rem;
}

.group-head {
  width: 100%;
  border: none;
  border-radius: var(--radius);
  background: var(--bg-elev);
  text-align: left;
  font: inherit;
}

.group-list {
  margin-top: 0.35rem;
}
</style>
