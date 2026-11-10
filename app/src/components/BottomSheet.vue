<template>
  <Teleport to="body" :disabled="inline">
    <div v-if="open" class="sheet-backdrop" @click.self="$emit('close')">
      <section class="sheet" role="dialog" aria-modal="true" :aria-label="title">
        <header class="sheet-header">
          <h2 class="grow">{{ title }}</h2>
          <button class="icon-btn" type="button" aria-label="Cerrar" @click="$emit('close')">
            <AppIcon name="close" />
          </button>
        </header>
        <div class="sheet-body">
          <slot />
        </div>
      </section>
    </div>
  </Teleport>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import AppIcon from './AppIcon.vue';

/** Hoja inferior modal (en pantallas anchas se muestra centrada). */
export default defineComponent({
  name: 'BottomSheet',
  components: { AppIcon },
  props: {
    open: { type: Boolean, default: false },
    title: { type: String, default: '' },
    /** Renderiza en el lugar (sin Teleport); útil en pruebas. */
    inline: { type: Boolean, default: false },
  },
  emits: ['close'],
  watch: {
    open: {
      immediate: true,
      handler(v: boolean) {
        if (typeof document === 'undefined') return;
        document.body.style.overflow = v ? 'hidden' : '';
        if (v) document.addEventListener('keydown', this.onKey);
        else document.removeEventListener('keydown', this.onKey);
      },
    },
  },
  beforeUnmount() {
    document.body.style.overflow = '';
    document.removeEventListener('keydown', this.onKey);
  },
  methods: {
    onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') this.$emit('close');
    },
  },
});
</script>

<style>
.sheet-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: flex-end;
  justify-content: center;
}

.sheet {
  width: 100%;
  max-width: 640px;
  max-height: 88vh;
  max-height: 88dvh;
  display: flex;
  flex-direction: column;
  background: var(--bg-elev);
  border-radius: 18px 18px 0 0;
  border: 1px solid var(--border);
  border-bottom: none;
  animation: sheet-in 0.18s ease-out;
}

.sheet-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.6rem 0.5rem 0.4rem 1rem;
  border-bottom: 1px solid var(--border);
}

.sheet-body {
  overflow-y: auto;
  -webkit-overflow-scrolling: touch;
  padding: 0.75rem calc(1rem + var(--safe-right)) calc(1rem + var(--safe-bottom)) calc(1rem + var(--safe-left));
}

@media (min-width: 700px) {
  .sheet-backdrop {
    align-items: center;
  }

  .sheet {
    border-radius: 18px;
    border-bottom: 1px solid var(--border);
  }
}

@keyframes sheet-in {
  from {
    transform: translateY(40px);
    opacity: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sheet {
    animation: none;
  }
}
</style>
