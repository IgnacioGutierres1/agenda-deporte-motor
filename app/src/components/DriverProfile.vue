<template>
  <section class="card bio-card driver-profile" aria-label="Perfil">
    <h3>Perfil</h3>
    <div class="bio-profile">
      <BioImage v-if="bio.photo" :image="bio.photo" :alt="`Foto de ${name}`" :width="104" />
      <dl v-if="facts.length" class="bio-facts">
        <div v-for="f in facts" :key="f.label" class="bio-fact">
          <dt>{{ f.label }}</dt>
          <dd>
            {{ f.value }}
            <span v-if="f.extra" class="block small dim">{{ f.extra }}</span>
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

    <div v-if="bio.links?.length" class="bio-links">
      <a v-for="l in bio.links" :key="l.url" :href="l.url" target="_blank" rel="noopener noreferrer" class="pill pill-small">
        {{ l.label }} <AppIcon name="external" :size="12" />
      </a>
    </div>
  </section>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapState } from 'pinia';
import type { DriverBio } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import BioImage from './BioImage.vue';
import BioSummary from './BioSummary.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { ageOn, groupTitles, longDate } from '../lib/bios.ts';

interface Fact {
  label: string;
  value: string;
  extra?: string;
}

/** Ficha de historial de un piloto: foto, datos personales, títulos, resumen y enlaces. */
export default defineComponent({
  name: 'DriverProfile',
  components: { AppIcon, BioImage, BioSummary },
  props: {
    bio: { type: Object as PropType<DriverBio>, required: true },
    name: { type: String, required: true },
  },
  computed: {
    ...mapState(useScheduleStore, ['now', 'seriesById']),
    age(): number | null {
      return ageOn(this.bio.birthDate, this.now.slice(0, 10));
    },
    facts(): Fact[] {
      const out: Fact[] = [];
      if (this.age !== null) out.push({ label: 'Edad', value: `${this.age} años` });
      const born = longDate(this.bio.birthDate);
      if (born || this.bio.birthPlace) {
        out.push({ label: 'Nació', value: born || this.bio.birthPlace!, ...(born && this.bio.birthPlace ? { extra: this.bio.birthPlace } : {}) });
      }
      if (this.bio.nationality) out.push({ label: 'Nacionalidad', value: this.bio.nationality });
      return out;
    },
    titles() {
      return groupTitles(this.bio.titles).map((t) => ({
        ...t,
        link: t.seriesId && this.seriesById.has(t.seriesId) ? `/categoria/${t.seriesId}?tab=historia` : '',
      }));
    },
  },
});
</script>
