<template>
  <div class="page circuits-view">
    <label class="search-box">
      <AppIcon name="search" :size="18" />
      <input v-model="query" type="search" class="search-input" placeholder="Buscar circuitos" aria-label="Buscar circuitos" />
    </label>

    <DataState />

    <template v-if="hasData">
      <template v-if="searching">
        <ul v-if="matches.length" class="list-card">
          <li v-for="r in matches" :key="r.circuit.id">
            <CircuitRow :circuit="r.circuit" :info="r.info" :summary="summary(r, true)" :detail="nextText(r)" :pending="infoPending" />
          </li>
        </ul>
        <p v-else class="card empty dim">No hay circuitos que coincidan con «{{ query }}».</p>
      </template>

      <template v-else>
        <p v-if="!groups.length" class="card empty dim">Todavía no hay circuitos en el calendario publicado.</p>
        <p v-else class="small dim circuits-count">{{ countText }}</p>
        <section v-for="g in groups" :key="g.country" class="circuits-group">
          <h2 class="section-title">{{ g.label }} <span class="circuits-n">{{ g.rows.length }}</span></h2>
          <ul class="list-card">
            <li v-for="r in g.rows" :key="r.circuit.id">
              <CircuitRow :circuit="r.circuit" :info="r.info" :summary="summary(r)" :detail="nextText(r)" :pending="infoPending" />
            </li>
          </ul>
        </section>
      </template>

      <p v-if="hasInfo" class="small dim center circuits-credits">
        Trazados: © Colaboradores de OpenStreetMap (ODbL). Planos: Wikimedia Commons; el autor y la licencia de cada uno
        están en la página del circuito.
      </p>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import type { MotorEvent } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import CircuitRow from '../components/CircuitRow.vue';
import DataState from '../components/DataState.vue';
import { useCircuitInfoStore } from '../stores/circuitInfo.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { todayIn } from '../lib/agenda.ts';
import { circuitsByCountry, dateRangeWithYear, type CircuitCountryGroup, type CircuitListRow } from '../lib/circuitInfo.ts';
import { searchCircuits } from '../lib/search.ts';
import { searchContext } from '../lib/searchContext.ts';

/**
 * Todos los circuitos del calendario, agrupados por país: miniatura del trazado (o del plano), cuántas
 * categorías corren ahí y la próxima fecha. Con el buscador, la lista pasa a ser la de coincidencias.
 */
export default defineComponent({
  name: 'CircuitsView',
  components: { AppIcon, CircuitRow, DataState },
  data() {
    return {
      query: '',
    };
  },
  computed: {
    ...mapState(useScheduleStore, ['hasData', 'now', 'seriesById', 'circuits']),
    ...mapState(useCircuitInfoStore, { infoById: 'byId', infoPending: 'pending', infoStatus: 'status' }),
    /** El buscador necesita al menos 2 letras (como en Buscar). */
    searching(): boolean {
      return this.query.trim().length >= 2;
    },
    /** "Hoy" en la zona de cada evento (una sola cuenta por zona). */
    todayByZone(): (tz: string) => string {
      const cache = new Map<string, string>();
      const now = this.now;
      return (tz: string) => {
        let day = cache.get(tz);
        if (!day) cache.set(tz, (day = todayIn(now, tz)));
        return day;
      };
    },
    groups(): CircuitCountryGroup[] {
      const today = this.todayByZone;
      return circuitsByCountry(this.circuits, this.infoById, (e: MotorEvent) => e.dateEnd >= today(e.tz));
    },
    total(): number {
      return this.groups.reduce((n, g) => n + g.rows.length, 0);
    },
    countText(): string {
      const countries = this.groups.filter((g) => g.country).length;
      const c = `${this.total} ${this.total === 1 ? 'circuito' : 'circuitos'}`;
      return countries > 1 ? `${c} en ${countries} países` : c;
    },
    matches(): CircuitListRow[] {
      const rows = new Map(this.groups.flatMap((g) => g.rows).map((r) => [r.circuit.id, r]));
      return searchCircuits(this.circuits, this.query.trim(), 30, searchContext())
        .map((c) => rows.get(c.id))
        .filter((r): r is CircuitListRow => !!r);
    },
    hasInfo(): boolean {
      return this.infoStatus === 'ok';
    },
  },
  created() {
    void this.loadInfo();
  },
  methods: {
    ...mapActions(useCircuitInfoStore, { loadInfo: 'load' }),
    /** "2 categorías"; en los resultados del buscador, con el país adelante ("Qatar · 2 categorías"). */
    summary(r: CircuitListRow, withCountry = false): string {
      const n = r.circuit.seriesIds.length;
      const parts = [`${n} ${n === 1 ? 'categoría' : 'categorías'}`];
      if (withCountry && r.circuit.country) parts.unshift(r.circuit.country);
      return parts.join(' · ');
    },
    /** "Próxima: 27–29/11 · F1", "Ahora: 13–15/11 · MotoGP" o "Sin fechas próximas" (renglón aparte: no se corta). */
    nextText(r: CircuitListRow): string {
      const next = r.next;
      if (!next) return 'Sin fechas próximas';
      const today = this.todayByZone(next.tz);
      const series = this.seriesById.get(next.seriesId)?.shortName ?? next.seriesId;
      const dates = dateRangeWithYear(next.dateStart, next.dateEnd, today.slice(0, 4));
      return `${next.dateStart <= today ? 'Ahora' : 'Próxima'}: ${dates} · ${series}`;
    },
  },
});
</script>

<style>
.circuits-count {
  margin: 0 0 -0.5rem;
}

.circuits-n {
  margin-left: 0.25rem;
  font-weight: 400;
}

.circuits-credits {
  margin-top: 1rem;
}
</style>
