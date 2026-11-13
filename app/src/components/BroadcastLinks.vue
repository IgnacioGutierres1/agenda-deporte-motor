<template>
  <div class="broadcast-links">
    <span v-if="!items.length" data-test="broadcast-empty">A confirmar</span>
    <ul v-else class="broadcast-list">
      <li v-for="it in items" :key="it.name">
        <a
          v-if="it.link"
          :href="it.link.url"
          target="_blank"
          rel="noopener noreferrer"
          class="broadcast-link"
          :class="{ 'is-search': it.link.kind === 'search' }"
          :aria-label="label(it)"
          :title="label(it)"
          data-test="broadcast-link"
        >
          <AppIcon v-if="it.link.kind === 'search'" name="search" :size="16" />
          <span>{{ it.name }}</span>
          <AppIcon name="external" :size="16" />
        </a>
        <span v-else class="broadcast-link is-text" data-test="broadcast-text">{{ it.name }}</span>
      </li>
    </ul>
    <p v-if="hasSearch" class="small dim broadcast-note">
      La lupa abre una búsqueda en YouTube: todavía no confirmamos cuál es el canal oficial.
    </p>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import AppIcon from './AppIcon.vue';
import { broadcastItems, type BroadcastItem } from '../lib/broadcast.ts';

/**
 * Canales de transmisión de una sesión ("dónde verlo"): los que tienen sitio, app o canal oficial verificado
 * van como botones que abren en otra pestaña; el resto queda como texto.
 */
export default defineComponent({
  name: 'BroadcastLinks',
  components: { AppIcon },
  props: {
    /** Session.broadcast. */
    names: { type: Array as PropType<string[]>, required: true },
    /** Nombre de la categoría: se usa en la búsqueda cuando el canal viene solo como "YouTube". */
    seriesName: { type: String, default: '' },
  },
  computed: {
    items(): BroadcastItem[] {
      return broadcastItems(this.names, this.seriesName);
    },
    hasSearch(): boolean {
      return this.items.some((i) => i.link?.kind === 'search');
    },
  },
  methods: {
    label(it: BroadcastItem): string {
      return it.link?.kind === 'search'
        ? `${it.name}: buscar en YouTube (se abre en otra pestaña)`
        : `${it.name}: abrir el sitio oficial (se abre en otra pestaña)`;
    },
  },
});
</script>

<style>
.broadcast-links {
  margin-bottom: 0.4rem;
}

.broadcast-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.broadcast-link {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  min-height: var(--tap);
  padding: 0 0.85rem;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-elev-2);
  color: var(--text);
  font-weight: 600;
}

a.broadcast-link:hover {
  text-decoration: none;
  border-color: var(--link);
}

.broadcast-link svg {
  flex: none;
  color: var(--link);
}

/* Sin enlace confirmado: mismo alto, pero sin aspecto de botón (no se puede tocar). */
.broadcast-link.is-text {
  background: transparent;
  border-color: transparent;
  padding: 0 0.6rem 0 0;
  font-weight: 400;
}

.broadcast-note {
  margin: 0.4rem 0 0;
}
</style>
