<template>
  <div class="shell">
    <header class="app-header">
      <div class="app-header-inner">
        <button v-if="!isRoot" class="icon-btn" type="button" aria-label="Volver" @click="back">
          <AppIcon name="back" />
        </button>
        <div class="grow header-titles">
          <div v-if="isHome" class="brand" aria-label="Deporte Motor">DEPORTE<span>MOTOR</span></div>
          <div v-else class="app-title" :class="{ big: isRoot }">{{ title }}</div>
          <div v-if="loading" class="app-sub">Actualizando…</div>
        </div>
        <RouterLink
          v-if="isHome"
          to="/exportar"
          class="icon-btn"
          aria-label="Exportar o cargar en el calendario"
          title="Exportar / calendario"
        >
          <AppIcon name="calendar" />
        </RouterLink>
        <button class="icon-btn" type="button" aria-label="Menú" title="Menú" @click="menuOpen = true">
          <AppIcon name="menu" />
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
        :class="{ active: isActive(item) }"
      >
        <AppIcon :name="item.icon" :filled="item.icon === 'star' && isActive(item)" />
        <span>{{ item.label }}</span>
      </RouterLink>
    </nav>

    <BottomSheet :open="menuOpen" title="Menú" @close="menuOpen = false">
      <ul class="list-card menu-list">
        <li>
          <button type="button" class="list-row menu-row" :disabled="loading" @click="refresh">
            <AppIcon name="refresh" :class="{ spin: loading }" />
            <span class="grow">
              Actualizar datos
              <span class="block small dim">{{ generatedAt ? `Datos de ${dataAge}` : 'Sin datos todavía' }}</span>
            </span>
          </button>
        </li>
        <li v-for="m in menu" :key="m.to">
          <RouterLink :to="m.to" class="list-row menu-row" @click="menuOpen = false">
            <AppIcon :name="m.icon" />
            <span class="grow">
              {{ m.label }}
              <span class="block small dim">{{ m.hint }}</span>
            </span>
            <AppIcon name="chevron" :size="16" class="dim" />
          </RouterLink>
        </li>
        <li v-if="canInstall">
          <button type="button" class="list-row menu-row" @click="install">
            <AppIcon name="download" />
            <span class="grow">Instalar la app</span>
          </button>
        </li>
      </ul>
    </BottomSheet>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import AppIcon from './components/AppIcon.vue';
import BottomSheet from './components/BottomSheet.vue';
import { useScheduleStore } from './stores/schedule.ts';
import { useResultsStore } from './stores/results.ts';
import { timeAgo } from './lib/format.ts';
import { installState, promptInstall } from './lib/install.ts';

interface NavItem {
  to: string;
  label: string;
  icon: string;
  /** Rutas (prefijos) que marcan esta pestaña como activa. */
  match: string[];
}

export default defineComponent({
  name: 'App',
  components: { AppIcon, BottomSheet },
  data() {
    return {
      timer: 0 as number,
      menuOpen: false,
      nav: [
        { to: '/', label: 'Agenda', icon: 'calendar', match: ['/evento', '/exportar'] },
        { to: '/categorias', label: 'Categorías', icon: 'trophy', match: ['/categoria'] },
        { to: '/siguiendo', label: 'Siguiendo', icon: 'star', match: ['/piloto'] },
      ] as NavItem[],
      menu: [
        { to: '/exportar', label: 'Exportar y Google Calendar', icon: 'share', hint: '.ics, carga directa y suscripción' },
        { to: '/auditoria', label: 'Auditoría de fuentes', icon: 'check', hint: 'Estado de cada categoría y su fuente oficial' },
        { to: '/ajustes', label: 'Ajustes', icon: 'gear', hint: 'Tema, zona horaria, categorías y cuentas' },
      ],
    };
  },
  computed: {
    ...mapState(useScheduleStore, ['loading', 'error', 'missing', 'generatedAt', 'hasData', 'now', 'fetchedAt']),
    title(): string {
      return (this.$route.meta.title as string | undefined) ?? 'Deporte Motor';
    },
    isRoot(): boolean {
      return this.$route.meta.root === true;
    },
    isHome(): boolean {
      return this.$route.path === '/';
    },
    dataAge(): string {
      return timeAgo(this.generatedAt, this.now);
    },
    canInstall(): boolean {
      return installState.event !== null;
    },
  },
  watch: {
    title: {
      immediate: true,
      handler(t: string) {
        document.title = t === 'Agenda' ? 'Deporte Motor' : `${t} · Deporte Motor`;
      },
    },
    $route() {
      this.menuOpen = false;
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
    async install() {
      this.menuOpen = false;
      await promptInstall();
    },
    back() {
      if (window.history.length > 1) this.$router.back();
      else void this.$router.push('/');
    },
    onVisibility() {
      if (document.visibilityState !== 'visible') return;
      this.tick();
      // Al volver a la app, refresca si la última descarga tiene más de 10 minutos.
      const last = this.fetchedAt ? Date.parse(this.fetchedAt) : 0;
      if (Date.now() - last > 10 * 60_000) void this.load();
    },
    isActive(item: NavItem): boolean {
      const path = this.$route.path;
      if (item.to === '/' ? path === '/' : path.startsWith(item.to)) return true;
      return item.match.some((m) => path.startsWith(m));
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
  background: var(--bg-header);
  padding-top: var(--safe-top);
}

.app-header-inner {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  height: var(--header-h);
  padding: 0 calc(0.4rem + var(--safe-right)) 0 calc(0.6rem + var(--safe-left));
  max-width: 760px;
  margin: 0 auto;
}

.header-titles {
  min-width: 0;
  padding-left: 0.4rem;
}

.brand {
  font-weight: 900;
  font-style: italic;
  font-size: 1.25rem;
  letter-spacing: 0.02em;
}

.brand span {
  color: var(--accent);
  margin-left: 0.25rem;
}

.app-title {
  font-weight: 800;
  font-size: 1.1rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.app-title.big {
  font-size: 1.6rem;
}

.app-sub {
  font-size: 0.75rem;
  color: var(--text-dim);
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
  width: 100%;
  max-width: 760px;
  margin: 0 auto;
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
  background: var(--bg-header);
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
  gap: 3px;
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

.menu-list {
  margin: 0;
}

.menu-row {
  width: 100%;
  background: transparent;
  border: none;
  text-align: left;
  font: inherit;
}
</style>
