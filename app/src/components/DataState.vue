<template>
  <div v-if="!hasData" class="data-state card">
    <template v-if="loading">
      <p><strong>Cargando datos…</strong></p>
    </template>
    <template v-else-if="missing">
      <p><strong>Todavía no hay datos publicados.</strong></p>
      <p class="small dim">
        La primera actualización automática genera la grilla. Si sos el dueño del repo, podés lanzarla desde
        Ajustes → "Forzar actualización".
      </p>
    </template>
    <template v-else-if="error">
      <p><strong>No se pudieron cargar los datos.</strong></p>
      <p class="small dim">{{ error }}</p>
      <button type="button" class="btn" @click="load({ force: true })">Reintentar</button>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import { useScheduleStore } from '../stores/schedule.ts';

/** Estado vacío / error compartido por las pantallas que dependen de schedule.json. */
export default defineComponent({
  name: 'DataState',
  computed: {
    ...mapState(useScheduleStore, ['hasData', 'loading', 'missing', 'error']),
  },
  methods: {
    ...mapActions(useScheduleStore, ['load']),
  },
});
</script>

<style>
.data-state {
  text-align: center;
  padding: 1.5rem 1rem;
}
</style>
