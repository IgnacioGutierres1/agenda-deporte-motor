<template>
  <section class="card bio-card team-profile" aria-label="Historia del equipo">
    <h3>Historia</h3>
    <div v-if="bio.logo || facts.length" class="bio-profile">
      <BioImage v-if="bio.logo" :image="bio.logo" :alt="`Logo de ${name}`" variant="logo" :width="112" />
      <dl v-if="facts.length" class="bio-facts">
        <div v-for="f in facts" :key="f.label" class="bio-fact">
          <dt>{{ f.label }}</dt>
          <dd>
            <a v-if="f.url" :href="f.url" target="_blank" rel="noopener noreferrer" class="tap-inline">{{ f.value }}</a>
            <template v-else>{{ f.value }}</template>
          </dd>
        </div>
      </dl>
    </div>

    <div v-if="titles.length" class="bio-titles">
      <p class="bio-subtitle small dim">Títulos</p>
      <ul class="bio-title-list">
        <li v-for="t in titles" :key="t.series" class="bio-title">
          <AppIcon name="trophy" :size="15" class="accent-text" />
          <span class="grow">
            <RouterLink v-if="t.link" :to="t.link" class="tap-inline bio-title-name">{{ t.series }}</RouterLink>
            <span v-else class="bio-title-name">{{ t.series }}</span>
            <span v-if="t.seasons.length > 1" class="bio-title-count">×{{ t.seasons.length }}</span>
            <span class="block small dim">{{ t.seasons.join(', ') }}</span>
          </span>
        </li>
      </ul>
    </div>

    <BioSummary v-if="bio.summary" :summary="bio.summary" class="bio-summary-block" />

    <div v-if="history.length" class="bio-titles">
      <p class="bio-subtitle small dim">Categorías en las que corrió</p>
      <ol class="team-history">
        <li v-for="h in history" :key="`${h.series}-${h.from}`" class="team-history-item">
          <span class="team-history-years">{{ h.years }}</span>
          <RouterLink v-if="h.link" :to="h.link" class="tap-inline team-history-series">{{ h.series }}</RouterLink>
          <span v-else class="team-history-series">{{ h.series }}</span>
        </li>
      </ol>
    </div>
  </section>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapState } from 'pinia';
import type { TeamBio } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import BioImage from './BioImage.vue';
import BioSummary from './BioSummary.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { groupTitles, hostOf, yearsText } from '../lib/bios.ts';

interface Fact {
  label: string;
  value: string;
  url?: string;
}

/** Historial de un equipo: logo, fundación, sede, país, director, sitio web, títulos, resumen y categorías. */
export default defineComponent({
  name: 'TeamProfile',
  components: { AppIcon, BioImage, BioSummary },
  props: {
    bio: { type: Object as PropType<TeamBio>, required: true },
    name: { type: String, required: true },
  },
  computed: {
    ...mapState(useScheduleStore, ['now', 'seriesById']),
    currentYear(): number {
      return Number(this.now.slice(0, 4));
    },
    facts(): Fact[] {
      const b = this.bio;
      const out: Fact[] = [];
      if (b.founded) out.push({ label: 'Fundación', value: String(b.founded) });
      if (b.base) out.push({ label: 'Sede', value: b.base });
      if (b.country && !b.base?.includes(b.country)) out.push({ label: 'País', value: b.country });
      if (b.principal) out.push({ label: 'Director', value: b.principal });
      if (b.website) out.push({ label: 'Sitio web', value: hostOf(b.website) || b.website, url: b.website });
      return out;
    },
    titles() {
      return groupTitles(this.bio.titles).map((t) => ({
        ...t,
        link: t.seriesId && this.seriesById.has(t.seriesId) ? `/categoria/${t.seriesId}?tab=historia` : '',
      }));
    },
    /** De lo más reciente a lo más viejo (lo que sigue corriendo, primero). */
    history() {
      return [...(this.bio.history ?? [])]
        .sort((a, b) => (b.to ?? 9999) - (a.to ?? 9999) || b.from - a.from)
        .map((h) => ({
          ...h,
          years: yearsText(h.from, h.to, this.currentYear),
          link: h.seriesId && this.seriesById.has(h.seriesId) ? `/categoria/${h.seriesId}` : '',
        }));
    },
  },
});
</script>

<style>
.team-history {
  display: grid;
  gap: 0.4rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.team-history-item {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
  min-width: 0;
}

.team-history-years {
  flex: none;
  min-width: 5.6rem;
  font-size: 0.82rem;
  font-weight: 700;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}

.team-history-series {
  font-weight: 600;
  overflow-wrap: anywhere;
}
</style>
