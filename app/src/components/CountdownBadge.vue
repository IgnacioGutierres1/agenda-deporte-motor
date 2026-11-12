<template>
  <span v-if="info.text" class="countdown-badge" :class="[info.state, { plain }]" :title="title">{{ text }}</span>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapState } from 'pinia';
import { useScheduleStore } from '../stores/schedule.ts';
import { countdown, type Countdown } from '../lib/countdown.ts';

/**
 * Cuenta regresiva de una sesión ("Empieza en 2 h 15 min", "en 12 min", "En curso", "Terminó").
 * No tiene temporizador propio: se recalcula con el "ahora" del store, que actualiza el reloj compartido
 * (lib/clock.ts) al empezar cada minuto.
 */
export default defineComponent({
  name: 'CountdownBadge',
  props: {
    startUtc: { type: String, required: true },
    endUtc: { type: String, default: undefined },
    /** "Empieza en …" en lugar de "en …". */
    long: { type: Boolean, default: false },
    /** Solo texto (sin fondo de chip). */
    plain: { type: Boolean, default: false },
  },
  computed: {
    ...mapState(useScheduleStore, ['now']),
    info(): Countdown {
      return countdown(this.startUtc, this.endUtc, this.now);
    },
    text(): string {
      return this.long && this.info.state === 'upcoming' ? `Empieza ${this.info.text}` : this.info.text;
    },
    title(): string {
      return this.info.state === 'upcoming' ? 'Cuenta regresiva hasta el inicio' : '';
    },
  },
});
</script>

<style>
.countdown-badge {
  display: inline-flex;
  align-items: center;
  width: fit-content;
  padding: 0.1rem 0.5rem;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 16%, transparent);
  color: var(--accent);
  font-size: 0.78rem;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.countdown-badge.live {
  background: color-mix(in srgb, var(--live) 16%, transparent);
  color: var(--live);
}

.countdown-badge.finished {
  background: var(--bg-elev-2);
  color: var(--text-dim);
}

.countdown-badge.plain {
  padding: 0;
  background: transparent;
}
</style>
