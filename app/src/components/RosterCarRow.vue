<template>
  <div class="list-row roster-car">
    <span class="car-number roster-number">{{ car.number ? `#${car.number}` : '–' }}</span>
    <span class="grow">
      <span v-for="d in car.drivers" :key="d.name" class="roster-driver">
        <RouterLink v-if="d.id" :to="`/piloto/${d.id}`" class="driver-link">{{ d.name }}</RouterLink>
        <template v-else>{{ d.name }}</template>
        <span v-if="d.country" class="small dim" :title="name(d.country)"> {{ flag(d.country) || d.country }}</span>
      </span>
      <span v-if="detail" class="block small dim">{{ detail }}</span>
    </span>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { countryFlag, countryName, type RosterCar } from '../lib/roster.ts';

/** Un auto del plantel: número, tripulación (con link a cada piloto), modelo y clase. */
export default defineComponent({
  name: 'RosterCarRow',
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
  display: block;
  font-weight: 600;
  line-height: 1.35;
}
</style>
