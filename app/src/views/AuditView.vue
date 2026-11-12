<template>
  <div class="page audit-view">
    <PeriodPicker />
    <DataState />

    <template v-if="hasData">
      <p class="small dim">
        Datos generados el {{ generatedText }} ({{ ago(generatedAt) }}).
        <template v-if="statusGeneratedAt && statusGeneratedAt !== generatedAt">
          Estado de fuentes: {{ ago(statusGeneratedAt) }}.
        </template>
      </p>

      <div class="audit-summary">
        <div v-for="s in summary" :key="s.state" class="audit-count" :class="`st-${s.state}`">
          <strong>{{ s.count }}</strong>
          <span>{{ s.label }}</span>
        </div>
      </div>

      <section v-for="g in groups" :key="g.group">
        <h2 class="section-title">{{ g.label }}</h2>
        <ul class="audit-list">
          <li v-for="row in g.items" :key="row.series.id" class="audit-row">
            <div class="row wrap">
              <span class="chip" :style="{ background: color(row.series) }" />
              <strong class="grow">{{ row.series.name }}</strong>
              <span class="badge" :class="stateClass(row.state)">{{ stateLabel(row.state) }}</span>
            </div>
            <div class="row wrap audit-badges">
              <span v-if="row.stale" class="badge badge-warn">DESACTUALIZADA</span>
              <span v-if="row.series.origin === 'discovered'" class="badge badge-info">Descubierta</span>
              <span v-if="row.series.origin === 'user'" class="badge badge-dim">Agregada</span>
              <span v-if="row.series.checklistItem" class="badge badge-dim">Ítem {{ row.series.checklistItem }}</span>
            </div>
            <div class="small audit-detail">
              <div v-if="row.state === 'activa'">
                {{ row.sessionCount }} {{ row.sessionCount === 1 ? 'sesión' : 'sesiones' }} en el período
                <template v-if="row.eventsInPeriod.length"> · {{ row.eventsInPeriod.map((e) => e.name).join(', ') }}</template>
              </div>
              <div v-for="e in row.pendingEvents" :key="e.id">
                {{ e.name }} ({{ dateRange(e.dateStart, e.dateEnd) }}): horarios a confirmar
              </div>
              <div v-if="row.state === 'receso'" class="dim">
                <template v-if="row.nextEvent">
                  Próxima fecha: {{ dateRange(row.nextEvent.dateStart, row.nextEvent.dateEnd) }} – {{ row.nextEvent.name }}
                </template>
                <template v-else>Sin fechas próximas publicadas.</template>
              </div>
              <div v-if="row.status?.message && row.status.state !== 'ok'" class="audit-msg">
                {{ row.status.message }}
              </div>
              <div v-if="row.status" class="dim">
                Última verificación {{ ago(row.status.lastAttempt) }}
                <template v-if="row.status.state !== 'ok' && row.status.state !== 'disabled'">
                  · última lectura buena {{ row.status.lastSuccess ? ago(row.status.lastSuccess) : 'nunca' }}
                </template>
              </div>
              <a v-if="row.officialUrl" :href="row.officialUrl" target="_blank" rel="noopener noreferrer" class="tap-inline">Sitio oficial</a>
            </div>
          </li>
        </ul>
      </section>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapState } from 'pinia';
import type { Series } from '@dm/shared';
import DataState from '../components/DataState.vue';
import PeriodPicker from '../components/PeriodPicker.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { AUDIT_STATE_LABELS, groupSeries, seriesColor, type AuditState } from '../lib/grid.ts';
import { formatDateRange, formatDateTime, timeAgo } from '../lib/format.ts';

const ORDER: AuditState[] = ['activa', 'pendiente', 'receso', 'error', 'desactivada'];

export default defineComponent({
  name: 'AuditView',
  components: { DataState, PeriodPicker },
  computed: {
    ...mapState(useScheduleStore, ['auditRows', 'hasData', 'generatedAt', 'now', 'status']),
    ...mapState(useSettingsStore, ['timeZone']),
    statusGeneratedAt(): string | null {
      return this.status?.generatedAt ?? null;
    },
    generatedText(): string {
      return this.generatedAt ? formatDateTime(this.generatedAt, this.timeZone) : '—';
    },
    groups() {
      return groupSeries(this.auditRows);
    },
    summary() {
      return ORDER.map((state) => ({
        state,
        label: AUDIT_STATE_LABELS[state],
        count: this.auditRows.filter((r) => r.state === state).length,
      })).filter((s) => s.count > 0 || s.state !== 'desactivada');
    },
  },
  methods: {
    color(s: Series): string {
      return seriesColor(s);
    },
    stateLabel(s: AuditState): string {
      return AUDIT_STATE_LABELS[s];
    },
    stateClass(s: AuditState): string {
      return {
        activa: 'badge-ok',
        pendiente: 'badge-warn',
        receso: 'badge-dim',
        error: 'badge-error',
        desactivada: 'badge-dim',
      }[s];
    },
    ago(iso: string | null | undefined): string {
      return timeAgo(iso, this.now);
    },
    dateRange: formatDateRange,
  },
});
</script>

<style>
.audit-summary {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  gap: 0.5rem;
  margin: 0.75rem 0;
}

.audit-count {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.5rem;
  display: flex;
  flex-direction: column;
  font-size: 0.68rem;
  font-weight: 700;
  color: var(--text-dim);
}

.audit-count strong {
  font-size: 1.3rem;
  color: var(--text);
}

.audit-count.st-activa strong {
  color: var(--ok);
}

.audit-count.st-pendiente strong {
  color: var(--warn);
}

.audit-count.st-error strong {
  color: var(--error);
}

.audit-list {
  list-style: none;
  margin: 0;
  padding: 0;
}

.audit-row {
  padding: 0.65rem 0;
  border-bottom: 1px solid var(--border);
}

.audit-badges {
  margin: 0.25rem 0 0;
  gap: 0.3rem;
}

.audit-detail {
  margin-top: 0.3rem;
}

.audit-msg {
  color: var(--error);
}
</style>
