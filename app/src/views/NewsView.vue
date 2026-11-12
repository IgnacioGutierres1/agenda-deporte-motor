<template>
  <div class="news-view">
    <nav v-tab-strip class="underline-tabs page-tabs" role="tablist" aria-label="Noticias">
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
      <!-- Para ti -->
      <template v-if="tab === 'para-ti'">
        <p v-if="!followedIds.length" class="small dim">
          Seguí categorías o pilotos para ver acá sus noticias. Mientras tanto, las últimas de todas.
        </p>
        <NewsList :items="forYou" empty-text="No hay noticias recientes de lo que seguís. Mirá «Últimas»." />
      </template>

      <!-- Últimas -->
      <NewsList v-else-if="tab === 'ultimas'" :items="items" />

      <!-- Por categoría -->
      <template v-else>
        <div v-tab-strip class="session-chips" role="tablist" aria-label="Categoría">
          <button
            v-for="s in seriesWithNews"
            :key="s.series.id"
            type="button"
            role="tab"
            class="pill"
            :class="{ active: s.series.id === currentSeries }"
            :aria-selected="s.series.id === currentSeries"
            @click="pickSeries(s.series.id)"
          >
            {{ s.series.shortName || s.series.name }} <span class="dim small">{{ s.count }}</span>
          </button>
        </div>
        <NewsList :items="bySeries" :featured="false" empty-text="Elegí una categoría." />
      </template>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import type { NewsItem, Series } from '@dm/shared';
import NewsList from '../components/NewsList.vue';
import { newsForSeries, useNewsStore } from '../stores/news.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { seriesSort } from '../lib/grid.ts';
import { tabStrip } from '../lib/tabStrip.ts';

type Tab = 'para-ti' | 'ultimas' | 'categorias';

/** Noticias de fuentes oficiales y medios especializados (como "Noticias" en FotMob). */
export default defineComponent({
  name: 'NewsView',
  components: { NewsList },
  directives: { tabStrip },
  data() {
    return {
      tabs: [
        { id: 'para-ti' as Tab, label: 'Para ti' },
        { id: 'ultimas' as Tab, label: 'Últimas' },
        { id: 'categorias' as Tab, label: 'Por categoría' },
      ],
    };
  },
  computed: {
    ...mapState(useNewsStore, ['items']),
    ...mapState(useScheduleStore, ['seriesById']),
    /** Categorías seguidas + las de los pilotos y equipos seguidos. */
    ...mapState(useSettingsStore, { followedIds: 'followedSeriesIds' }),
    tab(): Tab {
      const q = this.$route.query.tab;
      return q === 'ultimas' || q === 'categorias' ? q : 'para-ti';
    },
    forYou(): NewsItem[] {
      return this.followedIds.length ? newsForSeries(this.items, this.followedIds) : this.items;
    },
    seriesWithNews(): Array<{ series: Series; count: number }> {
      const counts = new Map<string, number>();
      for (const n of this.items) for (const id of n.seriesIds) counts.set(id, (counts.get(id) ?? 0) + 1);
      return [...counts]
        .map(([id, count]) => ({ series: this.seriesById.get(id)!, count }))
        .filter((x) => x.series)
        .sort((a, b) => seriesSort(a.series, b.series));
    },
    currentSeries(): string {
      const q = this.$route.query.serie;
      return typeof q === 'string' ? q : (this.seriesWithNews[0]?.series.id ?? '');
    },
    bySeries(): NewsItem[] {
      return this.currentSeries ? newsForSeries(this.items, [this.currentSeries]) : [];
    },
  },
  mounted() {
    void this.load();
  },
  methods: {
    ...mapActions(useNewsStore, ['load']),
    setTab(tab: Tab) {
      void this.$router.replace({ query: tab === 'para-ti' ? {} : { tab } });
    },
    pickSeries(id: string) {
      void this.$router.replace({ query: { tab: 'categorias', serie: id } });
    },
  },
});
</script>
