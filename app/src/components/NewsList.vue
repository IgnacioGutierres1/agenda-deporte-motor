<template>
  <div class="news-list">
    <p v-if="status === 'loading' || status === 'idle'" class="dim">Cargando noticias…</p>
    <div v-else-if="status === 'error'" class="notice notice-error">
      No se pudieron cargar las noticias ({{ error }}).
      <button type="button" class="btn btn-small" @click="load(true)">Reintentar</button>
    </div>
    <p v-else-if="status === 'missing'" class="card empty dim">Todavía no hay noticias publicadas.</p>
    <p v-else-if="!items.length" class="card empty dim">{{ emptyText }}</p>
    <template v-else>
      <a v-if="featured && hero" :href="hero.url" target="_blank" rel="noopener noreferrer" class="news-hero">
        <img v-if="hero.image && !broken.includes(hero.id)" :src="hero.image" alt="" loading="lazy" referrerpolicy="no-referrer" @error="broken.push(hero.id)" />
        <span class="news-hero-title">{{ hero.title }}</span>
        <span class="news-meta">
          <span class="news-kind" :class="hero.sourceKind">{{ hero.source }}</span> · {{ ago(hero.publishedAt) }}
        </span>
      </a>
      <ul class="news-rows">
        <li v-for="n in rest" :key="n.id">
          <a :href="n.url" target="_blank" rel="noopener noreferrer" class="news-row">
            <span class="news-thumb">
              <img v-if="n.image && !broken.includes(n.id)" :src="n.image" alt="" loading="lazy" referrerpolicy="no-referrer" @error="broken.push(n.id)" />
              <SeriesCrest v-else-if="crestFor(n)" :series="crestFor(n)!" :size="40" />
              <AppIcon v-else name="flag" :size="26" class="dim" />
            </span>
            <span class="grow news-text">
              <span class="news-title">{{ n.title }}</span>
              <span class="news-meta">
                <span class="news-kind" :class="n.sourceKind">{{ n.source }}</span> · {{ ago(n.publishedAt) }}
              </span>
            </span>
          </a>
        </li>
      </ul>
      <p class="small dim center">Las notas se leen en el sitio de cada medio. Oficial = sitio de la categoría u organizador.</p>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapActions, mapState } from 'pinia';
import type { NewsItem, Series } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import SeriesCrest from './SeriesCrest.vue';
import { useNewsStore } from '../stores/news.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { timeAgo } from '../lib/format.ts';

/** Lista de notas al estilo FotMob: una destacada con foto y el resto con miniatura. */
export default defineComponent({
  name: 'NewsList',
  components: { AppIcon, SeriesCrest },
  props: {
    items: { type: Array as PropType<NewsItem[]>, required: true },
    /** La primera nota se muestra grande. */
    featured: { type: Boolean, default: true },
    emptyText: { type: String, default: 'No hay noticias recientes.' },
  },
  data() {
    return { broken: [] as string[] };
  },
  computed: {
    ...mapState(useNewsStore, ['status', 'error']),
    ...mapState(useScheduleStore, ['now', 'seriesById']),
    hero(): NewsItem | undefined {
      return this.items[0];
    },
    rest(): NewsItem[] {
      return this.featured ? this.items.slice(1) : this.items;
    },
  },
  mounted() {
    void this.load();
  },
  methods: {
    ...mapActions(useNewsStore, ['load']),
    ago(iso: string): string {
      return timeAgo(iso, this.now);
    },
    crestFor(n: NewsItem): Series | undefined {
      return n.seriesIds.map((id) => this.seriesById.get(id)).find(Boolean);
    },
  },
});
</script>

<style>
.news-hero {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  margin: 0.25rem 0 0.9rem;
  color: var(--text);
}

.news-hero:hover {
  text-decoration: none;
}

.news-hero img {
  width: 100%;
  aspect-ratio: 16 / 9;
  object-fit: cover;
  border-radius: var(--radius);
  background: var(--bg-elev);
}

.news-hero-title {
  font-size: 1.15rem;
  font-weight: 800;
  line-height: 1.25;
}

.news-rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.news-row {
  display: flex;
  gap: 0.8rem;
  padding: 0.7rem 0;
  color: var(--text);
  border-top: 1px solid var(--border);
}

.news-row:hover {
  text-decoration: none;
}

.news-thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 108px;
  height: 72px;
  flex: none;
  border-radius: 10px;
  overflow: hidden;
  background: var(--bg-elev);
}

.news-thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.news-text {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  min-width: 0;
}

.news-title {
  font-weight: 700;
  line-height: 1.25;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.news-meta {
  font-size: 0.78rem;
  color: var(--text-dim);
}

.news-kind {
  font-weight: 700;
}

.news-kind.oficial {
  color: var(--accent);
}
</style>
