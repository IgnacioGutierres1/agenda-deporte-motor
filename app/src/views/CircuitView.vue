<template>
  <div class="circuit-view">
    <DataState />
    <p v-if="hasData && !circuit" class="page card empty">No encontramos este circuito en el calendario publicado.</p>

    <template v-if="circuit">
      <section class="hero" :style="{ '--series-color': color }">
        <div class="hero-top">
          <div class="hero-series big">
            <span class="circuit-badge" aria-hidden="true"><AppIcon name="flag" :size="28" /></span>
            <div>
              <h1 class="hero-title tight">{{ circuit.name }}</h1>
              <p class="hero-sub">{{ subtitle }}</p>
            </div>
          </div>
        </div>
        <p v-if="otherNames.length" class="hero-sub small circuit-aka">También figura como {{ otherNames.join(' · ') }}</p>
      </section>

      <div class="page">
        <div class="session-chips">
          <RouterLink v-for="s in seriesList" :key="s.id" :to="`/categoria/${s.id}`" class="pill">
            <SeriesCrest :series="s" :size="20" />
            {{ s.shortName }}
          </RouterLink>
        </div>

        <!-- Ficha del circuito (data/circuits.json). Si no hay archivo o el circuito no tiene ficha, la página queda como antes. -->
        <template v-if="info">
          <section v-show="figureKind !== 'none'" class="card circuit-figure-card">
            <h3 class="circuit-card-title">{{ figureKind === 'map' ? 'Plano del circuito' : 'Trazado' }}</h3>
            <CircuitFigure :info="info" :name="circuit.name" @kind="figureKind = $event" />
          </section>

          <section v-if="facts.length" class="card flush circuit-facts">
            <h3 class="card-title">Ficha técnica</h3>
            <dl class="fact-grid">
              <div v-for="f in facts" :key="f.key" class="fact" :class="{ wide: f.wide }">
                <dt>{{ f.label }}</dt>
                <dd>
                  {{ f.value }}
                  <span v-if="f.detail" class="fact-detail">{{ f.detail }}</span>
                </dd>
              </div>
            </dl>
          </section>
        </template>
        <div v-else-if="infoPending" class="circuit-skeleton" aria-busy="true" aria-label="Cargando la ficha del circuito…">
          <section class="card circuit-figure-card"><span class="circuit-skel circuit-skel-figure" /></section>
          <section class="card circuit-skel-grid">
            <span v-for="i in 6" :key="i" class="circuit-skel circuit-skel-cell" />
          </section>
        </div>

        <WeatherCard v-if="weather" :lat="weather.lat" :lon="weather.lon" :tz="weather.tz" :approx="weather.approx" />

        <section class="card flush">
          <h3 class="card-title">Próximos eventos</h3>
          <p v-if="!upcoming.length" class="card-foot small dim">No hay fechas próximas publicadas en este circuito.</p>
          <ul v-else class="list-card inset">
            <li v-for="h in upcoming" :key="h.event.id">
              <RouterLink :to="`/evento/${h.event.id}`" class="list-row">
                <span class="date-box small-box">
                  <span class="date-day">{{ dayNum(h.event.dateStart) }}</span>
                  <span class="date-month">{{ monthShort(h.event.dateStart) }}</span>
                </span>
                <span class="grow">
                  {{ h.event.name }}
                  <span class="block small dim">{{ h.series?.shortName ?? h.event.seriesId }} · {{ dateRange(h.event.dateStart, h.event.dateEnd) }}</span>
                </span>
                <SeriesCrest v-if="h.series" :series="h.series" :size="26" />
              </RouterLink>
            </li>
          </ul>
        </section>

        <section v-if="info && hasAbout" class="card flush circuit-about">
          <figure v-if="photo" class="circuit-photo">
            <!-- La caja reserva el lugar de la foto (sin saltos al cargar); si la imagen falla, se oculta entera. -->
            <div class="circuit-photo-frame" :style="{ '--photo-ar': photoRatio }">
              <img
                :src="photo.url"
                :alt="`Foto de ${info.name}`"
                :class="{ loaded: photoLoaded }"
                loading="lazy"
                decoding="async"
                referrerpolicy="no-referrer"
                @load="photoLoaded = true"
                @error="photoFailed = true"
              />
            </div>
            <figcaption class="small dim">
              Foto:
              <a v-if="photoPage" :href="photoPage" target="_blank" rel="noopener noreferrer" class="tap-inline">{{ photoCredit }}</a><template v-else>{{ photoCredit }}</template>
              · Wikimedia Commons
            </figcaption>
          </figure>
          <h3 class="card-title">{{ info.name }}</h3>
          <div class="circuit-about-body">
            <!-- Con link a Wikipedia, un extracto demasiado largo se corta (sigue allá); sin link se muestra entero. -->
            <p v-if="summary" class="circuit-summary" :class="{ clamp: !!wikipediaUrl }" :lang="info.summaryLang || undefined">{{ summary }}</p>
            <p v-if="summary && info.summaryLang === 'en'" class="small dim">Texto de Wikipedia en inglés.</p>
            <a v-if="wikipediaUrl" :href="wikipediaUrl" target="_blank" rel="noopener noreferrer" class="circuit-more">
              Leer más en Wikipedia
              <AppIcon name="external" :size="14" />
            </a>
            <div v-if="website || maps" class="circuit-links">
              <a v-if="website" :href="website" target="_blank" rel="noopener noreferrer" class="btn">
                <AppIcon name="globe" :size="18" />
                Sitio oficial
              </a>
              <a v-if="maps" :href="maps.directions" target="_blank" rel="noopener noreferrer" class="btn">
                <AppIcon name="pin" :size="18" />
                Cómo llegar
              </a>
            </div>
            <p v-if="maps" class="small dim circuit-where">
              <template v-if="info.coordsApprox">
                Ubicación aproximada: es la de {{ info.city || 'la ciudad' }}, no la del circuito.
              </template>
              <a :href="maps.map" target="_blank" rel="noopener noreferrer" class="tap-inline">Ver en OpenStreetMap</a>
            </p>
          </div>
        </section>

        <section v-if="past.length" class="card flush">
          <h3 class="card-title">Ya disputados</h3>
          <ul class="list-card inset">
            <li v-for="h in past" :key="h.event.id">
              <RouterLink :to="`/evento/${h.event.id}${h.hasResults ? '?tab=resultados' : ''}`" class="list-row">
                <span class="date-box small-box">
                  <span class="date-day">{{ dayNum(h.event.dateStart) }}</span>
                  <span class="date-month">{{ monthShort(h.event.dateStart) }}</span>
                </span>
                <span class="grow">
                  {{ h.event.name }}
                  <span class="block small dim">{{ h.series?.shortName ?? h.event.seriesId }} · {{ dateRange(h.event.dateStart, h.event.dateEnd) }}</span>
                </span>
                <span v-if="h.hasResults" class="badge badge-ok">Resultados</span>
                <SeriesCrest v-else-if="h.series" :series="h.series" :size="26" />
              </RouterLink>
            </li>
          </ul>
        </section>

        <p class="small dim center">
          Eventos de todas las categorías del calendario en este circuito.
          <template v-if="info">Datos del circuito: Wikidata y Wikipedia.</template>
        </p>
        <p class="center circuit-all">
          <RouterLink to="/circuitos" class="circuit-more">Todos los circuitos</RouterLink>
        </p>
      </div>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import type { CircuitImage, CircuitInfo, MotorEvent, Series } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import CircuitFigure from '../components/CircuitFigure.vue';
import DataState from '../components/DataState.vue';
import SeriesCrest from '../components/SeriesCrest.vue';
import WeatherCard from '../components/WeatherCard.vue';
import { useCircuitInfoStore } from '../stores/circuitInfo.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import type { Circuit } from '../lib/circuits.ts';
import { circuitFacts, httpUrl, imageCredit, mapLinks, type CircuitFact, type CircuitFigureKind, type MapLinks } from '../lib/circuitInfo.ts';
import { formatDateRange, monthShort } from '../lib/format.ts';
import { seriesColor, seriesSort } from '../lib/grid.ts';
import { todayIn } from '../lib/agenda.ts';
import { circuitCoords } from '../lib/weather.ts';

interface Row {
  event: MotorEvent;
  series?: Series;
  hasResults: boolean;
}

/**
 * Página de un circuito: trazado (o plano), ficha técnica, foto y extracto, y todo lo que se corre (y se
 * corrió) ahí, de todas las categorías.
 */
export default defineComponent({
  name: 'CircuitView',
  components: { AppIcon, CircuitFigure, DataState, SeriesCrest, WeatherCard },
  data() {
    return {
      /** Qué terminó mostrando el dibujo (trazado, plano o nada): lo avisa CircuitFigure. */
      figureKind: 'none' as CircuitFigureKind,
      photoFailed: false,
      photoLoaded: false,
    };
  },
  computed: {
    ...mapState(useScheduleStore, ['schedule', 'hasData', 'now', 'seriesById', 'circuits']),
    ...mapState(useCircuitInfoStore, { infoById: 'byId', infoPending: 'pending' }),
    circuit(): Circuit | undefined {
      const id = String(this.$route.params.circuitId);
      return this.circuits.find((c) => c.id === id);
    },
    /** Coordenadas y zona del circuito para el pronóstico (null si la ficha no tiene ubicación). */
    weather(): { lat: number; lon: number; approx: boolean; tz: string } | null {
      const coords = circuitCoords(this.info);
      const tz = this.circuit?.events[0]?.tz;
      return coords && tz ? { ...coords, tz } : null;
    },
    info(): CircuitInfo | undefined {
      return this.circuit ? this.infoById.get(this.circuit.id) : undefined;
    },
    facts(): CircuitFact[] {
      return this.info ? circuitFacts(this.info) : [];
    },
    photo(): CircuitImage | null {
      const photo = this.info?.photo;
      return photo && httpUrl(photo.url) && !this.photoFailed ? photo : null;
    },
    /** Proporción de la caja de la foto: la de la imagen, sin pasarse de apaisada ni de alta. */
    photoRatio(): string {
      const width = this.photo?.width ?? 0;
      const height = this.photo?.height ?? 0;
      const ratio = width > 0 && height > 0 ? width / height : 16 / 9;
      return String(Number(Math.min(21 / 9, Math.max(4 / 3, ratio)).toFixed(4)));
    },
    photoCredit(): string {
      return this.photo ? imageCredit(this.photo) : '';
    },
    photoPage(): string {
      return httpUrl(this.photo?.page);
    },
    summary(): string {
      return this.info?.summary?.trim() ?? '';
    },
    wikipediaUrl(): string {
      return httpUrl(this.info?.wikipediaUrl);
    },
    website(): string {
      return httpUrl(this.info?.website);
    },
    maps(): MapLinks | null {
      return this.info ? mapLinks(this.info) : null;
    },
    hasAbout(): boolean {
      return !!(this.photo || this.summary || this.wikipediaUrl || this.website || this.maps);
    },
    seriesList(): Series[] {
      return (this.circuit?.seriesIds ?? [])
        .map((id) => this.seriesById.get(id))
        .filter((s): s is Series => !!s)
        .sort(seriesSort);
    },
    color(): string {
      return seriesColor(this.seriesList[0]);
    },
    subtitle(): string {
      const n = this.seriesList.length;
      const parts = [this.circuit?.country, `${n} ${n === 1 ? 'categoría' : 'categorías'}`];
      return parts.filter(Boolean).join(' · ');
    },
    otherNames(): string[] {
      return (this.circuit?.names ?? []).filter((n) => n !== this.circuit?.name).slice(0, 4);
    },
    rows(): Row[] {
      const withResults = new Set((this.schedule?.sessions ?? []).filter((s) => s.hasResults).map((s) => s.eventId));
      return (this.circuit?.events ?? []).map((event) => ({
        event,
        series: this.seriesById.get(event.seriesId),
        hasResults: withResults.has(event.id),
      }));
    },
    upcoming(): Row[] {
      return this.rows.filter((r) => r.event.dateEnd >= todayIn(this.now, r.event.tz));
    },
    past(): Row[] {
      return this.rows.filter((r) => r.event.dateEnd < todayIn(this.now, r.event.tz)).reverse();
    },
  },
  watch: {
    '$route.params.circuitId': {
      immediate: true,
      handler() {
        this.photoFailed = false;
        this.photoLoaded = false;
        // En paralelo con el calendario: cuando llega el circuito, la ficha suele estar lista.
        void this.loadInfo();
      },
    },
  },
  methods: {
    ...mapActions(useCircuitInfoStore, { loadInfo: 'load' }),
    dayNum(date: string): string {
      return String(Number(date.slice(8, 10)));
    },
    monthShort,
    dateRange: formatDateRange,
  },
});
</script>

<style>
.circuit-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 58px;
  height: 58px;
  flex: none;
  border-radius: 50%;
  background: var(--series-color);
  color: #fff;
}

.circuit-aka {
  margin-top: 0.6rem;
}

/* ── Trazado o plano ── */
.circuit-figure-card {
  padding: 0.75rem 0.85rem 0.7rem;
}

.circuit-card-title {
  margin: 0 0 0.6rem;
  font-size: 0.95rem;
  font-weight: 800;
}

/* ── Ficha técnica ── */
.fact-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(8.5rem, 1fr));
  gap: 0.85rem 0.75rem;
  margin: 0;
  padding: 0.1rem 0.85rem 0.9rem;
}

.fact dt {
  font-size: 0.72rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-dim);
}

.fact dd {
  margin: 0.1rem 0 0;
  font-size: 1.05rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  overflow-wrap: anywhere;
}

.fact.wide {
  grid-column: 1 / -1;
}

.fact + .fact.wide {
  padding-top: 0.8rem;
  border-top: 1px solid var(--border);
}

.fact-detail {
  display: block;
  font-size: 0.88rem;
  font-weight: 400;
  color: var(--text-dim);
}

/* ── Esqueleto mientras llega la ficha (aparece con un instante de demora: si la ficha llega enseguida, no parpadea) ── */
.circuit-skeleton {
  animation: circuit-skel-in 0.2s ease 0.15s both;
}

@keyframes circuit-skel-in {
  from {
    opacity: 0;
  }
}

.circuit-skel {
  display: block;
  border-radius: 10px;
  background: var(--border);
  animation: pulse 1.4s ease-in-out infinite;
}

/* Mismo alto que la tarjeta del trazado: título + dibujo + crédito. */
.circuit-skel-figure {
  height: calc(var(--track-h, 230px) + 4.3rem);
}

.circuit-skel-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.85rem 0.75rem;
}

.circuit-skel-cell {
  height: 2.6rem;
}

/* ── Foto, extracto y links ── */
.circuit-about {
  overflow: hidden;
}

.circuit-photo {
  margin: 0;
}

.circuit-photo-frame {
  position: relative;
  aspect-ratio: var(--photo-ar, 16 / 9);
  max-height: 420px;
  background: var(--bg-elev-2);
  overflow: hidden;
}

.circuit-photo-frame img {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0;
  transition: opacity 0.25s;
}

.circuit-photo-frame img.loaded {
  opacity: 1;
}

.circuit-photo figcaption {
  padding: 0.4rem 0.85rem 0;
  overflow-wrap: anywhere;
}

.circuit-about-body {
  padding: 0 0.85rem 0.85rem;
}

.circuit-summary {
  margin: 0 0 0.35rem;
  line-height: 1.5;
}

.circuit-summary.clamp {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 10;
  line-clamp: 10;
  overflow: hidden;
}

a.circuit-more {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-height: 44px;
  font-weight: 700;
}

.circuit-links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.35rem;
}

.circuit-links .btn {
  flex: 1 1 9rem;
}

.circuit-where {
  margin: 0.7rem 0 0;
}

.circuit-all {
  margin: 0;
}

@media (min-width: 1024px) {
  .circuit-figure-card {
    --track-h: 320px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .circuit-skel,
  .circuit-skeleton {
    animation: none;
  }

  .circuit-photo-frame img {
    transition: none;
  }
}
</style>
