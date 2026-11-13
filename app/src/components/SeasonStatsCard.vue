<template>
  <section v-if="groups.length" class="card flush season-stats">
    <h3 class="card-title">La temporada en números</h3>
    <div v-for="g in groups" :key="g.seriesId" class="stats-group">
      <RouterLink :to="`/categoria/${g.seriesId}?tab=resultados`" class="list-row stats-head">
        <SeriesCrest v-if="g.series" :series="g.series" :size="30" />
        <span class="grow">
          {{ g.name }}
          <span class="block small dim">{{ g.caption }}</span>
        </span>
        <AppIcon name="chevron" :size="16" class="dim" />
      </RouterLink>
      <dl class="stat-tiles">
        <div v-for="t in g.tiles" :key="t.key" class="stat-tile">
          <dt>{{ t.label }}</dt>
          <dd class="stat-value">{{ t.value }}</dd>
          <dd v-if="t.sub" class="stat-sub">{{ t.sub }}</dd>
        </div>
      </dl>
      <p v-if="g.overall" class="stats-note small dim">
        Categoría con clases: los resultados publicados traen el puesto en la general, no en la clase. Por eso no se muestran victorias ni podios.
      </p>
    </div>
    <p class="card-foot small dim">
      {{ footnote }}
    </p>
  </section>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapState } from 'pinia';
import type { Series } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import SeriesCrest from './SeriesCrest.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { coverageText, statTiles, type SeasonNumbers, type StatTile } from '../lib/seasonStats.ts';

interface GroupView {
  seriesId: string;
  series?: Series;
  name: string;
  caption: string;
  tiles: StatTile[];
  overall: boolean;
}

/**
 * Tarjeta "La temporada en números" de la ficha de un piloto o de un equipo: un bloque por categoría con sus
 * números en mosaicos. Los calcula el pipeline con los resultados publicados; acá solo se muestran.
 */
export default defineComponent({
  name: 'SeasonStatsCard',
  components: { AppIcon, SeriesCrest },
  props: {
    stats: { type: Array as PropType<SeasonNumbers[]>, required: true },
    /** De quién son los números: cambia la aclaración del pie. */
    kind: { type: String as PropType<'piloto' | 'equipo'>, default: 'piloto' },
  },
  computed: {
    ...mapState(useScheduleStore, ['seriesById']),
    groups(): GroupView[] {
      return this.stats
        .filter((s) => s.races > 0)
        .map((s) => {
          const series = this.seriesById.get(s.seriesId);
          return {
            seriesId: s.seriesId,
            series,
            name: series?.name ?? s.seriesId,
            caption: `${s.season ? `Temporada ${s.season} · ` : ''}${coverageText(s.races)}`,
            tiles: statTiles(s),
            overall: !!s.overall,
          };
        });
    },
    footnote(): string {
      const what =
        this.kind === 'equipo'
          ? 'Lo que hicieron sus autos según los resultados publicados en la app (podios y abandonos cuentan autos).'
          : 'Calculado con los resultados publicados en la app.';
      return `${what} Si falta el resultado de alguna carrera, no cubre toda la temporada.`;
    },
  },
});
</script>

<style>
.stats-group + .stats-group {
  border-top: 1px solid var(--border);
}

.stats-head {
  font-weight: 600;
  text-decoration: none;
}

.stat-tiles {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 0.5rem;
  margin: 0;
  padding: 0.15rem 0.85rem 0.8rem;
}

/* Valor, etiqueta y aclaración; en el HTML la etiqueta va primero (se lee "Carreras 20"). */
.stat-tile {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 0.55rem 0.6rem 0.6rem;
  border-radius: 10px;
  background: var(--bg-elev-2);
}

.stat-tile dd {
  margin: 0;
}

.stat-value {
  order: -1;
  font-size: 1.4rem;
  font-weight: 800;
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
}

.stat-tile dt {
  margin-top: 0.15rem;
  font-size: 0.75rem;
  line-height: 1.25;
  color: var(--text-dim);
  overflow-wrap: break-word;
}

.stat-sub {
  font-size: 0.72rem;
  font-weight: 600;
  line-height: 1.3;
  color: var(--text-dim);
}

.stats-note {
  margin: 0;
  padding: 0 0.85rem 0.8rem;
}

.season-stats > .card-foot {
  margin: 0;
  padding-top: 0.6rem;
  border-top: 1px solid var(--border);
}
</style>
