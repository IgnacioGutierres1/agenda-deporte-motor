<template>
  <div class="period-picker">
    <div class="period-tabs" role="tablist" aria-label="Período">
      <button
        v-for="p in presets"
        :key="p"
        type="button"
        role="tab"
        class="period-tab"
        :class="{ active: preset === p }"
        :aria-selected="preset === p"
        @click="setPreset(p)"
      >
        {{ labels[p] }}
      </button>
    </div>
    <div v-if="preset === 'personalizado'" class="row custom-range">
      <label class="field grow">
        <span>Desde</span>
        <input v-model="customFrom" class="input" type="date" />
      </label>
      <label class="field grow">
        <span>Hasta</span>
        <input v-model="customTo" class="input" type="date" :min="customFrom" />
      </label>
    </div>
    <p v-if="periodError" class="small" style="color: var(--error)">{{ periodError }}</p>
    <label v-if="preset !== 'personalizado' && preset !== 'proximo-mes'" class="check small">
      <input v-model="includeThursday" type="checkbox" />
      Incluir jueves
    </label>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState, mapWritableState } from 'pinia';
import { PERIOD_LABELS } from '@dm/shared';
import { PERIOD_PRESETS, useScheduleStore } from '../stores/schedule.ts';

export default defineComponent({
  name: 'PeriodPicker',
  data() {
    return { presets: PERIOD_PRESETS, labels: PERIOD_LABELS };
  },
  computed: {
    ...mapState(useScheduleStore, ['preset', 'periodError']),
    ...mapWritableState(useScheduleStore, ['includeThursday', 'customFrom', 'customTo']),
  },
  methods: {
    ...mapActions(useScheduleStore, ['setPreset']),
  },
});
</script>

<style>
.period-tabs {
  display: flex;
  gap: 0.4rem;
  overflow-x: auto;
  scrollbar-width: none;
  padding: 0.1rem 0 0.3rem;
  margin: 0 -1rem;
  padding-left: 1rem;
  padding-right: 1rem;
}

.period-tabs::-webkit-scrollbar {
  display: none;
}

.period-tab {
  flex: none;
  min-height: 38px;
  padding: 0 0.85rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--bg-elev);
  font-size: 0.88rem;
  font-weight: 600;
  white-space: nowrap;
}

.period-tab.active {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--accent-text);
}

.custom-range .field {
  margin: 0.4rem 0 0;
}
</style>
