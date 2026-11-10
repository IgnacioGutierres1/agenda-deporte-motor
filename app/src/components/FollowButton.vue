<template>
  <button
    type="button"
    class="follow-btn"
    :class="{ following, compact }"
    :aria-pressed="following"
    :aria-label="following ? `Dejar de seguir ${name}` : `Seguir ${name}`"
    @click.stop.prevent="toggle"
  >
    <AppIcon name="star" :size="compact ? 20 : 16" :filled="following" />
    <span v-if="!compact">{{ following ? 'Siguiendo' : 'Seguir' }}</span>
  </button>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapActions, mapState } from 'pinia';
import AppIcon from './AppIcon.vue';
import { useSettingsStore, type FollowedDriver } from '../stores/settings.ts';

/** Seguir / dejar de seguir una categoría o un piloto (se guarda en este dispositivo). */
export default defineComponent({
  name: 'FollowButton',
  components: { AppIcon },
  props: {
    seriesId: { type: String, default: '' },
    /** Si se pasa, el botón sigue a este piloto en lugar de a una categoría. */
    driver: { type: Object as PropType<FollowedDriver | null>, default: null },
    name: { type: String, default: '' },
    /** Solo la estrella (listas). */
    compact: { type: Boolean, default: false },
  },
  computed: {
    ...mapState(useSettingsStore, ['followedSeries', 'followedDrivers']),
    following(): boolean {
      if (this.driver) return this.followedDrivers.some((d) => d.id === this.driver!.id);
      return this.followedSeries.includes(this.seriesId);
    },
  },
  methods: {
    ...mapActions(useSettingsStore, ['toggleFollow', 'toggleFollowDriver']),
    toggle() {
      if (this.driver) this.toggleFollowDriver(this.driver);
      else this.toggleFollow(this.seriesId);
    },
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
