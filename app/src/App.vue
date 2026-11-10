<template>
  <div class="shell">
    <header class="app-header">
      <div class="app-header-inner">
        <div class="grow">
          <div class="app-title">{{ title }}</div>
          <div class="app-sub" :title="generatedAt ?? ''">
            <template v-if="loading">Actualizando…</template>
            <template v-else-if="generatedAt">Datos actualizados {{ dataAge }}</template>
            <template v-else-if="missing">Todavía no hay datos publicados</template>
            <template v-else-if="error">Sin datos</template>
          </div>
        </div>
        <button
          class="icon-btn"
          type="button"
          :disabled="loading"
          aria-label="Actualizar datos"
          title="Actualizar datos"
          @click="refresh"
        >
          <AppIcon name="refresh" :class="{ spin: loading }" />
        </button>
      </div>
    </header>

    <div v-if="error && hasData" class="offline-banner" role="status">
      No se pudo actualizar: {{ error }} Se muestra la última copia guardada.
    </div>

    <main class="app-main">
      <RouterView />
    </main>

    <nav class="bottom-nav" aria-label="Secciones">
      <RouterLink
        v-for="item in nav"
        :key="item.to"
        :to="item.to"
        class="nav-item"
        :class="{ active: isActive(item.to) }"
      >
        <AppIcon :name="item.icon" />
        <span>{{ item.label }}</span>
      </RouterLink>
    </nav>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import AppIcon from './components/AppIcon.vue';
import { useScheduleStore } from './stores/schedule.ts';
import { useResultsStore } from './stores/results.ts';
import { timeAgo } from './lib/format.ts';

export default defineComponent({
  name: 'App',
  components: { AppIcon },
  data() {
    return {
      timer: 0 as number,
      nav: [
        { to: '/', label: 'Grilla', icon: 'calendar' },
        { to: '/campeonatos', label: 'Campeonatos', icon: 'trophy' },
        { to: '/auditoria', label: 'Auditoría', icon: 'check' },
        { to: '/ajustes', label: 'Ajustes', icon: 'gear' },
      ],
    };
  },
  computed: {
    ...mapState(useScheduleStore, ['loading', 'error', 'missing', 'generatedAt', 'hasData', 'now', 'fetchedAt']),
    title(): string {
      return (this.$route.meta.title as string | undefined) ?? 'Deporte Motor';
    },
    dataAge(): string {
      return timeAgo(this.generatedAt, this.now);
    },
  },
  watch: {
    title: {
      immediate: true,
      handler(t: string) {
        document.title = t === 'Grilla' ? 'Deporte Motor' : `${t} · Deporte Motor`;
      },
    },
  },
  mounted() {
    void this.load();
    this.timer = window.setInterval(() => this.tick(), 30_000);
    document.addEventListener('visibilitychange', this.onVisibility);
  },
  beforeUnmount() {
    window.clearInterval(this.timer);
    document.removeEventListener('visibilitychange', this.onVisibility);
  },
  methods: {
    ...mapActions(useScheduleStore, ['load', 'tick']),
    ...mapActions(useResultsStore, { clearResults: 'clear' }),
    async refresh() {
      this.clearResults();
      await this.load({ force: true });
    },
    onVisibility() {
      if (document.visibilityState !== 'visible') return;
      this.tick();
      // Al volver a la app, refresca si la última descarga tiene más de 10 minutos.
      const last = this.fetchedAt ? Date.parse(this.fetchedAt) : 0;
      if (Date.now() - last > 10 * 60_000) void this.load();
    },
    isActive(to: string): boolean {
      if (to === '/') return this.$route.path === '/' || this.$route.path === '/exportar';
      return this.$route.path.startsWith(to);
    },
  },
});
</script>

<style>
.shell {
  min-height: 100vh;
  min-height: 100dvh;
  display: flex;
  flex-direction: column;
}

.app-header {
  position: sticky;
  top: 0;
  z-index: 20;
  background: color-mix(in srgb, var(--bg) 92%, transparent);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  border-bottom: 1px solid var(--border);
  padding-top: var(--safe-top);
}

.app-header-inner {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  height: var(--header-h);
  padding: 0 calc(0.5rem + var(--safe-right)) 0 calc(1rem + var(--safe-left));
  max-width: 760px;
  margin: 0 auto;
}

.app-title {
  font-weight: 800;
  font-size: 1.1rem;
}

.app-sub {
  font-size: 0.75rem;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.spin {
  animation: spin 0.9s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.offline-banner {
  background: var(--changed-bg);
  color: var(--text);
  font-size: 0.85rem;
  padding: 0.5rem 1rem;
  text-align: center;
}

.app-main {
  flex: 1;
  padding-bottom: calc(var(--nav-h) + var(--safe-bottom) + 0.5rem);
}

.bottom-nav {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 30;
  display: flex;
  justify-content: space-around;
  background: var(--bg-elev);
  border-top: 1px solid var(--border);
  padding: 0 var(--safe-right) var(--safe-bottom) var(--safe-left);
}

.nav-item {
  flex: 1;
  max-width: 160px;
  height: var(--nav-h);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--text-dim);
  text-decoration: none;
}

.nav-item:hover {
  text-decoration: none;
}

.nav-item.active {
  color: var(--accent);
}
</style>
