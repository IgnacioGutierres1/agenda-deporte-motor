<template>
  <section class="card flush career-card">
    <h3 class="card-title">Trayectoria<span v-if="span" class="dim career-span"> · {{ span }}</span></h3>
    <table class="data career-table">
      <thead>
        <tr>
          <th class="num career-year">Año</th>
          <th class="name-col">Categoría</th>
          <th class="num" title="Puesto final en el campeonato">Pos.</th>
          <th v-if="hasWins" class="num" title="Victorias">Vic.</th>
          <th v-if="hasPodiums" class="num" title="Podios">Pod.</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(c, i) in shown" :key="i" :class="{ champion: c.champion, 'season-start': c.firstOfSeason && i > 0 }">
          <td class="num career-year">{{ c.firstOfSeason ? c.season : '' }}</td>
          <td class="career-series">
            <RouterLink v-if="c.link" :to="c.link" class="tap-inline career-series-name">{{ c.series }}</RouterLink>
            <span v-else class="career-series-name">{{ c.series }}</span>
            <span v-if="c.team || c.numbers" class="block small dim">
              {{ c.team }}<template v-if="c.team && c.numbers"> · </template>{{ c.numbers }}
            </span>
          </td>
          <td class="num career-pos">
            <span v-if="c.champion" class="career-champ" title="Campeón">
              <AppIcon name="trophy" :size="13" /><span class="sr-only">Campeón</span>
            </span>
            <template v-else>{{ c.pos ? `${c.pos}.º` : '—' }}</template>
          </td>
          <td v-if="hasWins" class="num">{{ c.wins ?? '' }}</td>
          <td v-if="hasPodiums" class="num">{{ c.podiums ?? '' }}</td>
        </tr>
      </tbody>
    </table>
    <div v-if="rows.length > limit" class="card-foot">
      <button type="button" class="link-btn small" :aria-expanded="all" @click="all = !all">
        {{ all ? 'Ver menos' : `Ver toda la trayectoria (${seasonCount} temporadas)` }}
      </button>
    </div>
    <p class="card-foot small dim">Fuente: {{ sources }}. Puede estar incompleta.</p>
  </section>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapState } from 'pinia';
import type { CareerSeason } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { careerNumbers, careerRows, careerSpan, type CareerRow } from '../lib/bios.ts';

interface CareerView extends CareerRow {
  link: string;
  numbers: string;
}

const SOURCE_NAMES: Record<CareerSeason['source'], string> = {
  wikidata: 'Wikidata',
  wikipedia: 'Wikipedia',
  oficial: 'sitios oficiales',
  app: 'resultados oficiales leídos por la app',
};

/**
 * Trayectoria de un piloto por temporada (de la más reciente a la más vieja): categoría, equipo, puesto final,
 * victorias y podios; los campeonatos, resaltados. Compacta para el celular: el año va solo en el primer renglón
 * de cada temporada y, si es larga, se muestran las últimas temporadas con "Ver toda la trayectoria".
 */
export default defineComponent({
  name: 'CareerTable',
  components: { AppIcon },
  props: {
    career: { type: Array as PropType<CareerSeason[]>, required: true },
    limit: { type: Number, default: 10 },
  },
  data() {
    return { all: false };
  },
  computed: {
    ...mapState(useScheduleStore, ['seriesById']),
    rows(): CareerView[] {
      return careerRows(this.career).map((c) => ({
        ...c,
        link: c.seriesId && this.seriesById.has(c.seriesId) ? `/categoria/${c.seriesId}` : '',
        numbers: careerNumbers(c),
      }));
    },
    shown(): CareerView[] {
      if (this.all || this.rows.length <= this.limit) return this.rows;
      // No se corta una temporada por la mitad.
      const cut = this.rows.findIndex((r, i) => i >= this.limit && r.firstOfSeason);
      return cut < 0 ? this.rows : this.rows.slice(0, cut);
    },
    hasWins(): boolean {
      return this.career.some((c) => c.wins !== undefined);
    },
    hasPodiums(): boolean {
      return this.career.some((c) => c.podiums !== undefined);
    },
    seasonCount(): number {
      return new Set(this.career.map((c) => c.season)).size;
    },
    span(): string {
      return careerSpan(this.career);
    },
    sources(): string {
      const names = [...new Set(this.career.map((c) => SOURCE_NAMES[c.source]))];
      return names.join(', ');
    },
  },
});
</script>

<style>
.career-span {
  font-weight: 400;
}

.career-table td {
  vertical-align: top;
}

.career-table .career-year {
  width: 3.2rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.career-table tr.season-start td {
  border-top: 1px solid var(--border);
}

.career-table td.career-series {
  min-width: 0;
  white-space: normal;
  overflow-wrap: anywhere;
}

.career-series-name {
  font-weight: 600;
}

.career-table tr.champion td {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
}

.career-table tr.champion .career-series-name {
  color: var(--accent);
}

.career-champ {
  display: inline-flex;
  align-items: center;
  color: var(--accent);
  font-weight: 800;
}

.career-pos {
  font-weight: 700;
  white-space: nowrap;
}
</style>
