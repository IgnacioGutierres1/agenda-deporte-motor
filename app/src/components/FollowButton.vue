<template>
  <button
    type="button"
    class="follow-btn"
    :class="{ following, compact }"
    :aria-pressed="following"
    :aria-label="following ? `Dejar de seguir ${name}` : `Seguir ${name}`"
    @click.stop.prevent="toggleFollow(seriesId)"
  >
    <AppIcon name="star" :size="compact ? 20 : 16" :filled="following" />
    <span v-if="!compact">{{ following ? 'Siguiendo' : 'Seguir' }}</span>
  </button>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import AppIcon from './AppIcon.vue';
import { useSettingsStore } from '../stores/settings.ts';

/** Seguir / dejar de seguir una categoría (se guarda en este dispositivo). */
export default defineComponent({
  name: 'FollowButton',
  components: { AppIcon },
  props: {
    seriesId: { type: String, required: true },
    name: { type: String, default: '' },
    /** Solo la estrella (listas). */
    compact: { type: Boolean, default: false },
  },
  computed: {
    ...mapState(useSettingsStore, ['followedSeries']),
    following(): boolean {
      return this.followedSeries.includes(this.seriesId);
    },
  },
  methods: {
    ...mapActions(useSettingsStore, ['toggleFollow']),
  },
});
</script>

<style>
.follow-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  min-height: 34px;
  padding: 0 0.85rem;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  font-weight: 700;
  font-size: 0.9rem;
}

.follow-btn.following {
  background: var(--text);
  color: var(--bg);
  border-color: var(--text);
}

.follow-btn.compact {
  min-height: var(--tap);
  min-width: var(--tap);
  padding: 0;
  justify-content: center;
  border: none;
  color: var(--text-dim);
}

.follow-btn.compact.following {
  background: transparent;
  color: var(--warn);
}
</style>
