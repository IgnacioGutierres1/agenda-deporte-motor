<template>
  <div class="list-row roster-car">
    <span class="car-number roster-number">{{ car.number ? `#${car.number}` : '–' }}</span>
    <span class="grow">
      <template v-for="d in car.drivers" :key="d.name">
        <RouterLink v-if="d.id" :to="`/piloto/${d.id}`" class="roster-driver roster-driver-link">
          <span class="grow">{{ d.name }}<span v-if="d.country" class="small dim" :title="name(d.country)"> {{ flag(d.country) || d.country }}</span></span>
          <AppIcon name="chevron" :size="14" class="dim" />
        </RouterLink>
        <span v-else class="roster-driver">
          {{ d.name }}<span v-if="d.country" class="small dim" :title="name(d.country)"> {{ flag(d.country) || d.country }}</span>
        </span>
      </template>
      <span v-if="detail" class="block small dim">{{ detail }}</span>
    </span>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import AppIcon from './AppIcon.vue';
import { countryFlag, countryName, type RosterCar } from '../lib/roster.ts';

/** Un auto del plantel: número, tripulación (con link a cada piloto), modelo y clase. */
export default defineComponent({
  name: 'RosterCarRow',
  components: { AppIcon },
  props: {
    car: { type: Object as PropType<RosterCar>, required: true },
    showClass: { type: Boolean, default: false },
  },
  computed: {
    detail(): string {
      return [this.car.vehicle, this.showClass ? this.car.class : ''].filter(Boolean).join(' · ');
    },
  },
  methods: {
    flag: countryFlag,
    name: countryName,
  },
});
</script>

<style>
.roster-car {
  align-items: flex-start;
}

.roster-number {
  margin-top: 0.1rem;
  min-width: 2.6rem;
}

.roster-driver {
  display: flex;
  align-items: center;
  min-height: 44px;
  font-weight: 600;
  line-height: 1.35;
}

a.roster-driver-link {
  gap: 0.4rem;
  margin-right: -0.35rem;
  padding-right: 0.35rem;
  border-radius: 8px;
  color: var(--text);
}

a.roster-driver-link:hover {
  text-decoration: none;
  color: var(--accent);
}

a.roster-driver-link + a.roster-driver-link,
a.roster-driver-link + .roster-driver,
.roster-driver + a.roster-driver-link {
  border-top: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
}

.roster-car.list-row {
  padding-top: 0;
  padding-bottom: 0.35rem;
}

.roster-number {
  margin-top: 0.7rem;
}
</style>
