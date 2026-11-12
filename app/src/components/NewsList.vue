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
        <img
          v-if="hero.image && !broken.includes(hero.id)"
          :src="hero.image"
          alt=""
          width="640"
          height="360"
          decoding="async"
          fetchpriority="high"
          referrerpolicy="no-referrer"
          @error="broken.push(hero.id)"
        />
        <span class="news-hero-title">{{ hero.title }}</span>
        <span class="news-meta">
          <span class="news-kind" :class="hero.sourceKind">{{ hero.source }}</span> · {{ ago(hero.publishedAt) }}
        </span>
      </a>
      <p v-if="featured && hero && hero.alsoIn && hero.alsoIn.length" class="news-also news-also-hero">
        También en:
        <template v-for="(a, k) in hero.alsoIn" :key="a.url">
          <a :href="a.url" target="_blank" rel="noopener noreferrer">{{ alsoLabel(hero, a) }}</a><template v-if="k < hero.alsoIn.length - 1">, </template>
        </template>
      </p>
      <ul class="news-rows">
        <li v-for="n in visible" :key="n.id">
          <a :href="n.url" target="_blank" rel="noopener noreferrer" class="news-row">
            <span class="news-thumb">
              <img
                v-if="n.image && !broken.includes(n.id)"
                :src="n.image"
                alt=""
                width="108"
                height="72"
                loading="lazy"
                decoding="async"
                referrerpolicy="no-referrer"
                @error="broken.push(n.id)"
              />
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
          <!-- Fuera del link de la nota: cada versión es su propio link. -->
          <p v-if="n.alsoIn && n.alsoIn.length" class="news-also">
            También en:
            <template v-for="(a, k) in n.alsoIn" :key="a.url">
              <a :href="a.url" target="_blank" rel="noopener noreferrer">{{ alsoLabel(n, a) }}</a><template v-if="k < n.alsoIn.length - 1">, </template>
            </template>
          </p>
        </li>
      </ul>
      <button v-if="hidden > 0" type="button" class="btn btn-block news-more" @click="shown += pageSize">
        Ver más <span class="dim">({{ hidden }})</span>
      </button>
      <p class="small dim center">Las notas se leen en el sitio de cada medio. Oficial = sitio de la categoría u organizador.</p>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapActions, mapState } from 'pinia';
import type { NewsAlternate, NewsItem, Series } from '@dm/shared';
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
    /** Notas por tanda: el resto aparece con "Ver más" (la lista completa son cientos de notas con foto). */
    pageSize: { type: Number, default: 20 },
  },
  data() {
    return { broken: [] as string[], shown: this.pageSize };
  },
  computed: {
    ...mapState(useNewsStore, ['status', 'error']),
    ...mapState(useScheduleStore, ['now', 'seriesById']),
    /** Nota destacada: la primera con foto entre las 15 más recientes (como FotMob, siempre con imagen). */
    hero(): NewsItem | undefined {
      if (!this.featured) return undefined;
      return this.items.slice(0, 15).find((n) => n.image && !this.broken.includes(n.id));
    },
    rest(): NewsItem[] {
      const hero = this.hero;
      return hero ? this.items.filter((n) => n.id !== hero.id) : this.items;
    },
    visible(): NewsItem[] {
      return this.rest.slice(0, this.shown);
    },
    hidden(): number {
      return Math.max(0, this.rest.length - this.shown);
    },
  },
  watch: {
    // Otra lista (otra pestaña o categoría): vuelve a la primera tanda.
    items() {
      this.shown = this.pageSize;
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
    /** "Motorsport.com (EN)": el idioma solo si es distinto del de la nota principal. */
    alsoLabel(n: NewsItem, a: NewsAlternate): string {
      return a.lang && a.lang !== n.lang ? `${a.source} (${a.lang.toUpperCase()})` : a.source;
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
  height: auto;
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

/* Alineado con el texto de la fila (miniatura de 108px + separación). */
.news-also {
  margin: -0.35rem 0 0.6rem calc(108px + 0.8rem);
  font-size: 0.78rem;
  color: var(--text-dim);
  line-height: 1.35;
}

.news-also-hero {
  margin: -0.5rem 0 0.9rem;
}

.news-also a {
  color: var(--text-dim);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.news-more {
  margin: 0.4rem 0 0.9rem;
}
</style>
