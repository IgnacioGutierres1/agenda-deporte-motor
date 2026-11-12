<template>
  <div class="page not-found">
    <div class="card empty center not-found-card">
      <p class="not-found-title">{{ kind === 'piloto' ? 'No encontramos a este piloto' : 'No encontramos este equipo' }}</p>
      <p class="small dim">No figura en las tablas de campeonato ni en las listas de inscriptos publicadas.</p>
      <div class="not-found-actions">
        <RouterLink :to="searchLink" class="btn btn-primary">Buscar {{ kind }}</RouterLink>
        <RouterLink to="/" class="btn">Ir a la agenda</RouterLink>
      </div>
    </div>

    <template v-if="suggestions.length">
      <h2 class="section-title">¿Buscabas…?</h2>
      <ul class="list-card">
        <li v-for="s in suggestions" :key="s.id">
          <RouterLink :to="`/${kind}/${s.id}`" class="list-row">
            <DriverAvatar :name="s.name" :color="s.color" :size="34" />
            <span class="grow">
              {{ s.name }}
              <span class="block small dim one-line">{{ s.detail }}</span>
            </span>
            <AppIcon name="chevron" :size="16" class="dim" />
          </RouterLink>
        </li>
      </ul>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapState } from 'pinia';
import AppIcon from './AppIcon.vue';
import DriverAvatar from './DriverAvatar.vue';
import { useDriversStore } from '../stores/drivers.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { useTeamsStore } from '../stores/teams.ts';
import { driverSeriesIds, teamSeriesIds } from '../lib/teams.ts';
import { seriesColor } from '../lib/grid.ts';
import { navState } from '../lib/navState.ts';

interface Suggestion {
  id: string;
  name: string;
  detail: string;
  color: string;
}

/**
 * Ficha de un piloto o equipo que no existe (link viejo o mal escrito): botones para buscar o volver
 * a la agenda y nombres parecidos (búsqueda con errores de tipeo sobre el id del link).
 */
export default defineComponent({
  name: 'NotFoundCard',
  components: { AppIcon, DriverAvatar },
  props: {
    kind: { type: String as PropType<'piloto' | 'equipo'>, required: true },
    /** Id del link ("colapnto-franco"). */
    slug: { type: String, default: '' },
  },
  computed: {
    ...mapState(useScheduleStore, ['seriesById']),
    /** El id del link como búsqueda: "colapnto-franco" -> "colapnto franco". */
    guess(): string {
      return this.slug.replace(/[-_]+/g, ' ').trim();
    },
    suggestions(): Suggestion[] {
      if (this.guess.length < 2) return [];
      const short = (ids: string[]) => ids.slice(0, 3).map((id) => this.seriesById.get(id)?.shortName ?? id).join(' · ');
      // Primero con todas las palabras; si no aparece nada, con la más larga.
      const longest = [...this.guess.split(' ')].sort((a, b) => b.length - a.length)[0] ?? '';
      const queries = longest.length >= 4 && longest !== this.guess ? [this.guess, longest] : [this.guess];
      for (const q of queries) {
        if (this.kind === 'piloto') {
          const hits = useDriversStore().search(q, 5);
          if (hits.length) {
            return hits.map((d) => {
              const ids = driverSeriesIds(d);
              return { id: d.id, name: d.name, detail: short(ids), color: seriesColor(this.seriesById.get(ids[0] ?? '')) };
            });
          }
        } else {
          const hits = useTeamsStore().search(q, 5);
          if (hits.length) {
            return hits.map((t) => {
              const ids = teamSeriesIds(t);
              return { id: t.id, name: t.name, detail: short(ids), color: seriesColor(this.seriesById.get(ids[0] ?? '')) };
            });
          }
        }
      }
      return [];
    },
    searchLink(): { path: string; query?: Record<string, string> } {
      return this.suggestions.length ? { path: '/buscar', query: { q: this.guess } } : { path: '/buscar' };
    },
  },
  mounted() {
    navState.notFound = true;
  },
  beforeUnmount() {
    navState.notFound = false;
  },
});
</script>

<style>
.not-found-card {
  padding: 1.25rem 1rem;
}

.not-found-title {
  margin: 0 0 0.35rem;
  font-size: 1.1rem;
  font-weight: 800;
}

.not-found-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.5rem;
  margin-top: 0.85rem;
}
</style>
