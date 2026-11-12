<template>
  <div class="page export-view">
    <PeriodPicker />

    <DataState />

    <template v-if="hasData">
      <div class="row export-head">
        <span class="grow small dim">{{ exportItems.length }} de {{ items.length }} sesiones seleccionadas</span>
        <button type="button" class="btn btn-small btn-ghost" @click="setAllExcluded(false)">Todas</button>
        <button type="button" class="btn btn-small btn-ghost" @click="setAllExcluded(true)">Ninguna</button>
      </div>

      <p v-if="!items.length" class="card empty">No hay sesiones con horario en este período.</p>

      <div v-for="day in days" :key="day.date" class="export-day">
        <div class="section-title">{{ day.label }}</div>
        <label v-for="item in day.items" :key="item.session.id" class="check export-item">
          <input
            type="checkbox"
            :aria-label="`Exportar ${item.series.shortName || item.series.name} · ${item.session.name}, ${day.label} ${time(item.session.startUtc)}`"
            :checked="!excludedIds.includes(item.session.id)"
            @change="setExcluded(item.session.id, !($event.target as HTMLInputElement).checked)"
          />
          <span class="export-time">{{ time(item.session.startUtc) }}</span>
          <span class="chip" :style="{ background: color(item) }" />
          <span class="grow">
            <strong>{{ item.series.shortName || item.series.name }}</strong> · {{ item.session.name }}
            <span class="dim small">({{ item.event?.circuit }})</span>
          </span>
        </label>
      </div>

      <div class="export-actions stack">
        <button type="button" class="btn btn-primary btn-block" :disabled="!exportItems.length" @click="download">
          <AppIcon name="download" :size="18" /> Descargar .ics
        </button>
        <button v-if="shareSupported" type="button" class="btn btn-block" :disabled="!exportItems.length" @click="share">
          <AppIcon name="share" :size="18" /> Compartir archivo .ics
        </button>
        <template v-if="effectiveClientId">
          <button type="button" class="btn btn-block" :disabled="!exportItems.length || busy" @click="loadToGoogle">
            <AppIcon name="calendar" :size="18" /> Cargar en Google Calendar
          </button>
          <button type="button" class="btn btn-block btn-ghost btn-small" :disabled="!exportItems.length || busy" @click="auditOnly">
            Solo auditar el calendario
          </button>
        </template>
        <p v-if="icsNote" class="small dim">{{ icsNote }}</p>
        <p class="small dim">
          Horarios del .ics en UTC (tu calendario los muestra en tu hora).
          <template v-if="effectiveClientId">
            En Google Calendar se cargan en hora argentina en el calendario "Deporte Motor", con aviso 30 minutos antes.
          </template>
        </p>
      </div>

      <!-- Sin Client ID de Google la carga directa no funciona: la suscripción hace lo mismo y se actualiza sola. -->
      <section class="card subscribe-card">
        <h2 class="subscribe-title">{{ effectiveClientId ? 'O suscribite al calendario' : '¿Usás Google Calendar o el del iPhone?' }}</h2>
        <p class="small">
          <template v-if="!effectiveClientId">
            La carga directa en Google Calendar no está configurada en esta app.
          </template>
          Suscribite al calendario de la agenda: se actualiza solo cuando cambian los horarios (próximos 60 días).
        </p>
        <a :href="webcal" class="btn btn-primary btn-block">
          <AppIcon name="calendar" :size="18" /> Suscribirse al calendario
        </a>
        <RouterLink to="/ajustes" class="btn btn-block btn-ghost btn-small">Cómo agregarlo en Google Calendar</RouterLink>
      </section>

      <section v-if="gcalLog.length || audit" class="gcal-section">
        <h2 class="section-title">Google Calendar</h2>
        <div v-if="gcalLog.length" class="notice" :class="gcalError ? 'notice-error' : ''">
          <div v-for="(line, i) in gcalLog" :key="i">{{ line }}</div>
          <div v-if="progress" class="small dim">{{ progress }}</div>
        </div>

        <template v-if="audit">
          <h2 class="section-title">Auditoría post-carga</h2>
          <p class="small">
            En la grilla: <strong>{{ audit.counts.expected }}</strong> · En el calendario:
            <strong>{{ audit.counts.found }}</strong> ·
            <span class="ok-text">{{ audit.counts.OK }} OK</span> ·
            <span class="err-text">{{ audit.counts.ERROR }} ERROR</span> ·
            <span class="err-text">{{ audit.counts.DESFASADO }} DESFASADO</span> ·
            <span class="warn-text">{{ audit.counts.FALTANTE }} FALTANTE</span>
          </p>
          <div class="table-wrap">
            <table class="data audit-table">
              <thead>
                <tr>
                  <th>Categoría y Sesión</th>
                  <th>Horario Oficial (ARG)</th>
                  <th>Horario en Calendar</th>
                  <th>Estado</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="row in audit.rows" :key="row.expected.sessionId">
                  <td class="wrap-cell">{{ row.expected.label }}</td>
                  <td>{{ range(row.expected.startUtc, row.expected.endUtc) }}</td>
                  <td>{{ actualRange(row) }}</td>
                  <td class="wrap-cell">
                    <span class="badge" :class="statusClass(row.status)">{{ row.status }}</span>
                    <div v-if="row.issues.length && row.status !== 'OK'" class="small dim">{{ row.issues.join(' · ') }}</div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <div class="stack gcal-fix">
            <button v-if="fixCount" type="button" class="btn btn-primary btn-block" :disabled="busy" @click="fixAll">
              Corregir automáticamente ({{ fixCount }})
            </button>
            <p v-else class="notice notice-ok">Todo coincide con la agenda.</p>
            <div v-if="audit.extras.length" class="card">
              <strong>Eventos sobrantes creados por la app ({{ audit.extras.length }})</strong>
              <p class="small dim">Están en el calendario pero ya no figuran en la agenda para esta selección.</p>
              <ul class="small extras">
                <li v-for="e in audit.extras" :key="e.id">{{ e.summary || e.id }} — {{ extraTime(e) }}</li>
              </ul>
              <button type="button" class="btn btn-danger btn-block" :disabled="busy" @click="removeExtras">
                Borrar sobrantes…
              </button>
            </div>
          </div>
        </template>
      </section>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import { AR_TZ, ICS_FILENAME, buildIcs, formatTime, type IcsEventInput } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import DataState from '../components/DataState.vue';
import PeriodPicker from '../components/PeriodPicker.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { seriesColor, type GridItem } from '../lib/grid.ts';
import { formatDateTime } from '../lib/format.ts';
import { webcalUrl } from '../lib/data.ts';
import { canShareFile, downloadIcs, icsFile, shareIcs } from '../lib/download.ts';
import { toExpectedEvent, type ExpectedEvent } from '../gcal/mapping.ts';
import { eventInstant, planFixes, type CalendarAuditResult, type CalendarAuditRow, type CalendarAuditStatus, type CalendarEvent } from '../gcal/audit.ts';
import { CalendarApi } from '../gcal/api.ts';
import { getAccessToken, preloadGis } from '../gcal/gis.ts';
import { applyFixes, auditCalendarRemote, deleteExtras, uploadEvents } from '../gcal/sync.ts';

export default defineComponent({
  name: 'ExportView',
  components: { AppIcon, DataState, PeriodPicker },
  data() {
    return {
      icsNote: '',
      shareSupported: false,
      busy: false,
      gcalLog: [] as string[],
      gcalError: false,
      progress: '',
      audit: null as CalendarAuditResult | null,
      calendarId: '',
    };
  },
  computed: {
    ...mapState(useScheduleStore, ['items', 'days', 'exportItems', 'excludedIds', 'hasData', 'period']),
    ...mapState(useSettingsStore, ['timeZone', 'effectiveClientId']),
    expected(): ExpectedEvent[] {
      return this.exportItems.map((i) => toExpectedEvent(i));
    },
    webcal(): string {
      return webcalUrl('feeds/deporte-motor.ics');
    },
    fixCount(): number {
      return this.audit ? planFixes(this.audit).length : 0;
    },
  },
  watch: {
    // Si cambia la selección, la auditoría anterior deja de ser válida.
    exportItems() {
      this.audit = null;
    },
  },
  mounted() {
    this.shareSupported = canShareFile(icsFile('', ICS_FILENAME));
    if (this.effectiveClientId && navigator.onLine) preloadGis();
  },
  methods: {
    ...mapActions(useScheduleStore, ['setExcluded', 'setAllExcluded']),
    color(item: GridItem): string {
      return seriesColor(item.series);
    },
    time(iso: string): string {
      return formatTime(iso, this.timeZone);
    },
    range(start: string, end: string): string {
      return `${formatDateTime(start, AR_TZ)}–${formatTime(end, AR_TZ)}`;
    },
    actualRange(row: CalendarAuditRow): string {
      if (!row.actual) return '—';
      const s = eventInstant(row.actual.start);
      const e = eventInstant(row.actual.end);
      if (!s) return '—';
      return e ? `${formatDateTime(s, AR_TZ)}–${formatTime(e, AR_TZ)}` : formatDateTime(s, AR_TZ);
    },
    extraTime(e: CalendarEvent): string {
      const s = eventInstant(e.start);
      return s ? formatDateTime(s, AR_TZ) : '';
    },
    statusClass(s: CalendarAuditStatus): string {
      return { OK: 'badge-ok', ERROR: 'badge-error', DESFASADO: 'badge-error', FALTANTE: 'badge-warn' }[s];
    },
    icsContent(): string {
      const events: IcsEventInput[] = this.exportItems.map((i) => ({
        id: i.session.id,
        startUtc: i.session.startUtc,
        endUtc: i.session.endUtc,
        seriesName: i.series.name,
        circuit: i.event?.circuit ?? '',
        country: i.event?.country ?? '',
        sessionName: i.session.name,
        broadcast: i.session.broadcast,
        broadcastIsDefault: i.session.broadcastIsDefault,
        sourceUrl: i.session.source.url,
        fromImage: i.session.source.kind === 'image',
      }));
      return buildIcs(events, { calendarName: 'Deporte Motor' });
    },
    download() {
      const mode = downloadIcs(this.icsContent(), ICS_FILENAME);
      this.icsNote =
        mode === 'ios'
          ? 'En iPhone se abre el archivo: tocá "Agregar todo" para sumarlo al Calendario. Si no aparece, usá "Compartir archivo .ics".'
          : `Se descargó ${ICS_FILENAME}. Abrilo para importarlo en tu calendario.`;
    },
    async share() {
      const ok = await shareIcs(this.icsContent(), ICS_FILENAME);
      if (!ok) this.icsNote = 'No se pudo compartir el archivo. Probá con "Descargar .ics".';
    },
    log(line: string, isError = false) {
      this.gcalLog.push(line);
      if (isError) this.gcalError = true;
    },
    async connect(): Promise<CalendarApi> {
      const token = await getAccessToken(this.effectiveClientId);
      const api = new CalendarApi(token);
      if (!this.calendarId) {
        const cal = await api.findCalendar();
        this.calendarId = cal.id;
        this.log('Calendario "Deporte Motor" encontrado.');
      }
      return api;
    },
    async run(task: (api: CalendarApi) => Promise<void>) {
      if (this.busy) return;
      this.busy = true;
      this.gcalLog = [];
      this.gcalError = false;
      this.progress = '';
      try {
        const api = await this.connect();
        await task(api);
      } catch (e) {
        this.log((e as Error).message, true);
      } finally {
        this.busy = false;
        this.progress = '';
      }
    },
    async doAudit(api: CalendarApi) {
      this.progress = 'Auditando el calendario…';
      const expected = this.expected;
      this.audit = await auditCalendarRemote(api, this.calendarId, expected, this.period);
      this.log(`Auditoría: ${this.audit.counts.OK} de ${expected.length} OK.`);
    },
    loadToGoogle() {
      return this.run(async (api) => {
        const expected = this.expected;
        const report = await uploadEvents(api, this.calendarId, expected, (d, t) => {
          this.progress = `Cargando ${d} de ${t}…`;
        });
        this.log(`Cargados: ${report.inserted} nuevos, ${report.updated} actualizados.`);
        for (const f of report.failed) this.log(`No se pudo cargar ${f.expected.label}: ${f.error}`, true);
        await this.doAudit(api);
      });
    },
    auditOnly() {
      return this.run((api) => this.doAudit(api));
    },
    fixAll() {
      const audit = this.audit;
      if (!audit) return;
      return this.run(async (api) => {
        const r = await applyFixes(api, this.calendarId, audit, (d, t) => {
          this.progress = `Corrigiendo ${d} de ${t}…`;
        });
        this.log(`Corregidos: ${r.fixed}.`);
        for (const f of r.failed) this.log(f, true);
        await this.doAudit(api);
      });
    },
    removeExtras() {
      const extras = this.audit?.extras ?? [];
      if (!extras.length) return;
      const ok = window.confirm(
        `¿Borrar ${extras.length} evento(s) del calendario "Deporte Motor"? Fueron creados por la app y ya no están en la agenda. No se puede deshacer.`,
      );
      if (!ok) return;
      return this.run(async (api) => {
        const r = await deleteExtras(api, this.calendarId, extras);
        this.log(`Borrados: ${r.deleted}.`);
        for (const f of r.failed) this.log(f, true);
        await this.doAudit(api);
      });
    },
  },
});
</script>

<style>
.export-head {
  margin-top: 0.5rem;
}

.export-item {
  gap: 0.5rem;
  border-bottom: 1px solid var(--border);
}

.export-time {
  font-variant-numeric: tabular-nums;
  font-weight: 700;
  width: 3rem;
  flex: none;
}

.export-actions {
  margin-top: 1rem;
}

.subscribe-card {
  margin-top: 1rem;
}

.subscribe-card .subscribe-title {
  margin: 0 0 0.3rem;
  font-size: 1.05rem;
}

.subscribe-card .btn + .btn {
  margin-top: 0.4rem;
}

.ok-text {
  color: var(--ok);
}

.err-text {
  color: var(--error);
}

.warn-text {
  color: var(--warn);
}

.gcal-fix {
  margin-top: 0.75rem;
}

.extras {
  padding-left: 1.1rem;
}
</style>
