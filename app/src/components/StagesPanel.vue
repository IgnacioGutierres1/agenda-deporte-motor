<template>
  <div class="stages-panel" :class="[surfaceClass, { 'by-date': byDate }]">
    <p v-if="!state || state.status === 'loading'" class="dim">Cargando el recorrido…</p>
    <div v-else-if="state.status === 'error'" class="notice notice-error">
      <p>No se pudo cargar el recorrido ({{ state.error }}).</p>
      <button type="button" class="btn" @click="load(true)">Reintentar</button>
    </div>
    <p v-else-if="!file || !file.stages.length" class="card empty dim">
      El recorrido de este rally todavía no está publicado en la app. Aparece acá apenas el organizador lo publica.
    </p>

    <template v-else>
      <!-- Resumen: superficie, kilómetros, cantidad de tramos y mapa general -->
      <section class="card stages-summary" aria-label="Resumen del recorrido">
        <p v-if="summary.surface || summary.surfaceNote" class="stages-surface">
          <SurfaceBadge v-if="summary.surface" :surface="summary.surface" long />
          <span v-if="summary.surfaceNote" class="small dim">{{ summary.surfaceNote }}</span>
        </p>
        <dl class="stat-tiles">
          <div v-for="t in tiles" :key="t.label" class="stat-tile">
            <dt class="stat-label">{{ t.label }}</dt>
            <dd class="stat-value">{{ t.value }}</dd>
          </div>
        </dl>
        <p v-if="summary.cancelled" class="small warn-text stages-cancelled">
          {{ summary.cancelled === 1 ? `1 ${unit} cancelad${gender}` : `${summary.cancelled} ${units} cancelad${gender}s` }}: no
          {{ summary.cancelled === 1 ? 'cuenta' : 'cuentan' }} en la cantidad.
        </p>
        <button v-if="nowRow" type="button" class="stage-now" :class="nowRow.state" @click="scrollToRow(nowRow.anchor)">
          <span v-if="nowRow.state === 'live'" class="live-dot" />
          <span class="grow">
            <span class="stage-now-label">{{ nowLabel }}</span>
            <strong>{{ nowRow.code }}</strong><template v-if="nowRow.name"> · {{ nowRow.name }}</template>
          </span>
          <CountdownBadge v-if="nowRow.state === 'next' && nowRow.startUtc" :start-utc="nowRow.startUtc" />
          <AppIcon name="chevron" :size="16" class="dim stage-now-chev" />
        </button>
        <StageMap v-if="file.routeMapUrl" :url="file.routeMapUrl" :alt="`Mapa del recorrido de ${event.name}`" :credit="file.routeMapCredit ?? ''" />
      </section>

      <p class="zone-note small dim">
        <AppIcon :name="timed ? 'clock' : 'calendar'" :size="14" />
        <span v-if="timed">Largada del primer auto en {{ zoneText }}<template v-if="hasLocalTimes">; debajo, la hora del rally</template></span>
        <span v-else>El organizador no publica la hora de largada: las {{ units }} van por fecha</span>
      </p>

      <!-- Itinerario: un bloque por día (rally por tramos) o una sola lista con la fecha de cada etapa (rally raid) -->
      <section v-for="block in blocks" :key="block.key" class="card flush stage-day">
        <header v-if="block.title" class="stage-day-head">
          <h3 class="card-title">{{ block.title }}</h3>
          <span v-if="block.meta" class="small dim stage-day-meta">{{ block.meta }}</span>
        </header>
        <ul class="stage-rows">
          <li
            v-for="row in block.rows"
            :id="row.anchor"
            :key="row.key"
            class="stage-row"
            :class="[row.state, { cancelled: row.cancelled }]"
            :aria-current="row.state === 'live' || row.state === 'today' ? 'true' : undefined"
          >
            <!-- Izquierda: la fecha (etapas) o la hora en la zona del usuario (tramos) -->
            <div v-if="byDate" class="date-box small-box stage-date" :title="row.dateTitle">
              <span class="date-month">{{ row.weekday }}</span>
              <span class="date-day">{{ row.day }}</span>
            </div>
            <div v-else class="stage-time">
              <span v-if="row.time?.userDay" class="stage-time-day">{{ row.time.userDay }}</span>
              <strong v-if="row.time?.user">{{ row.time.user }}</strong>
              <span v-else class="dim" title="Sin hora de largada publicada">—</span>
              <span v-if="row.state === 'past' && row.time" class="stage-time-note">Largó</span>
            </div>

            <div class="stage-info">
              <p class="stage-title">
                <strong class="stage-code">{{ row.code }}</strong>
                <span v-if="row.name" class="stage-name">{{ row.name }}</span>
              </p>
              <p v-if="row.sub" class="stage-sub small dim">{{ row.sub }}</p>
              <p v-if="row.badges" class="stage-badges">
                <span v-if="row.state === 'live'" class="badge badge-live">En curso</span>
                <span v-if="row.state === 'today'" class="badge badge-today">Hoy</span>
                <CountdownBadge v-if="row.state === 'next' && row.startUtc" :start-utc="row.startUtc" />
                <span v-else-if="row.state === 'next'" class="badge badge-ok">{{ nextWord }}</span>
                <span v-if="row.cancelled" class="badge badge-error">Cancelad{{ gender }}</span>
                <span v-if="row.power" class="badge badge-warn"><AppIcon name="bolt" :size="11" />Power Stage</span>
                <span v-else-if="row.kindBadge" class="badge badge-info">{{ row.kindBadge }}</span>
                <SurfaceBadge v-if="row.surface" :surface="row.surface" />
              </p>

              <!-- Terreno: una barra por tipo, de mayor a menor, con su porcentaje escrito -->
              <ul v-if="row.terrain.length" class="terrain-bars" aria-label="Terreno de la etapa">
                <li v-for="t in row.terrain" :key="t.label" class="terrain-row" :title="terrainTitle(t)">
                  <span class="terrain-label">{{ t.label }}</span>
                  <span class="terrain-track" aria-hidden="true"><span class="terrain-fill" :style="{ width: `${t.percent}%` }" /></span>
                  <span class="terrain-value">{{ t.text }}</span>
                </li>
              </ul>

              <details v-if="row.note || row.mapUrl" class="stage-more">
                <summary>
                  <AppIcon name="chevron" :size="14" class="stage-more-chev" />
                  {{ row.moreLabel }}
                </summary>
                <p v-if="row.note" class="stage-note">{{ row.note }}</p>
                <StageMap v-if="row.mapUrl" :url="row.mapUrl" :alt="`Mapa de ${row.code}`" />
              </details>
            </div>

            <div v-if="row.kmMain" class="stage-km">
              <strong>{{ row.kmMain }}</strong>
              <span v-if="row.kmSub" class="small dim">{{ row.kmSub }}</span>
            </div>
          </li>
        </ul>
      </section>

      <div class="card source-box">
        <div class="small dim">Fuente del recorrido</div>
        <SourceLink :source="file.source" />
      </div>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapActions, mapState } from 'pinia';
import { DateTime } from 'luxon';
import { STAGE_KIND_LABELS, type EventStagesFile, type MotorEvent, type RallyStage, type Surface } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import CountdownBadge from './CountdownBadge.vue';
import SourceLink from './SourceLink.vue';
import StageMap from './StageMap.vue';
import SurfaceBadge from './SurfaceBadge.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { stagesKey, useStagesStore } from '../stores/stages.ts';
import type { Loaded } from '../stores/results.ts';
import { zoneDisplayName } from '../lib/format.ts';
import {
  formatKm,
  groupStagesByDay,
  stageCountText,
  stageExtraKmText,
  stageStates,
  stageTime,
  stagesSummary,
  terrainBars,
  type ItineraryKind,
  type StageState,
  type StageTime,
  type StagesSummary,
  type TerrainBar,
} from '../lib/stages.ts';

interface RowView {
  key: string;
  /** Id del renglón en la página (para saltar al tramo en curso). */
  anchor: string;
  state: StageState;
  cancelled: boolean;
  code: string;
  name: string;
  weekday: string;
  day: string;
  dateTitle: string;
  time: StageTime | null;
  startUtc?: string;
  sub: string;
  power: boolean;
  kindBadge: string;
  surface?: Surface;
  /** Hay algún distintivo para mostrar (evita un renglón vacío). */
  badges: boolean;
  kmMain: string;
  kmSub: string;
  terrain: TerrainBar[];
  note: string;
  mapUrl: string;
  moreLabel: string;
}

interface BlockView {
  key: string;
  title: string;
  meta: string;
  rows: RowView[];
}

/**
 * Pestaña "Tramos" (rally) o "Etapas" (rally raid) de un evento: resumen del recorrido y el itinerario día por
 * día, con el tramo en curso, los que ya largaron y el próximo cuando la fuente publica horas, o la etapa de hoy
 * cuando solo publica fechas (Dakar). La lógica está en lib/stages.ts.
 */
export default defineComponent({
  name: 'StagesPanel',
  components: { AppIcon, CountdownBadge, SourceLink, StageMap, SurfaceBadge },
  props: {
    event: { type: Object as PropType<MotorEvent>, required: true },
  },
  computed: {
    ...mapState(useScheduleStore, ['now', 'today']),
    ...mapState(useSettingsStore, ['timeZone']),
    ...mapState(useStagesStore, { stageFiles: 'files' }),
    state(): Loaded<EventStagesFile> | undefined {
      return this.stageFiles[stagesKey(this.event.seriesId, this.event.id)];
    },
    file(): EventStagesFile | undefined {
      return this.state?.data;
    },
    summary(): StagesSummary {
      return stagesSummary(this.file ?? { stages: [] }, this.event);
    },
    kind(): ItineraryKind {
      return this.summary.kind;
    },
    /** Rally raid: una etapa por día, así que la lista va por fecha (sin un bloque por día). */
    byDate(): boolean {
      return this.kind === 'etapas';
    },
    unit(): string {
      return this.kind === 'tramos' ? 'tramo' : 'etapa';
    },
    units(): string {
      return `${this.unit}s`;
    },
    /** "cancelado" (tramo) o "cancelada" (etapa). */
    gender(): string {
      return this.kind === 'tramos' ? 'o' : 'a';
    },
    nextWord(): string {
      return this.kind === 'tramos' ? 'Próximo' : 'Próxima';
    },
    surfaceClass(): string {
      return this.summary.surface ? `surface-${this.summary.surface}` : '';
    },
    zoneText(): string {
      const name = zoneDisplayName(this.timeZone);
      return name.charAt(0).toLowerCase() + name.slice(1);
    },
    tiles(): Array<{ label: string; value: string }> {
      const s = this.summary;
      const out: Array<{ label: string; value: string }> = [];
      if (s.competitiveKm !== undefined) out.push({ label: 'Cronometrados', value: formatKm(s.competitiveKm) });
      if (s.totalKm !== undefined) out.push({ label: 'Con enlaces', value: formatKm(s.totalKm) });
      out.push({ label: this.kind === 'tramos' ? 'Tramos' : 'Etapas', value: String(s.count) });
      if (s.days > 1) out.push({ label: 'Días', value: String(s.days) });
      return out;
    },
    blocks(): BlockView[] {
      if (!this.file) return [];
      const days = groupStagesByDay(this.file.stages);
      const flat = days.flatMap((d) => d.stages);
      const states = stageStates(flat, this.now, this.today);
      const eventSurface = this.summary.surface;
      let i = 0;
      const dayBlocks = days.map((d) => ({
        key: d.date,
        title: d.label,
        meta: d.count ? [stageCountText(d.count, 'tramos'), d.competitiveKm !== undefined ? formatKm(d.competitiveKm) : ''].filter(Boolean).join(' · ') : '',
        rows: d.stages.map((stage) => this.rowView(stage, i, states[i++]!, eventSurface)),
      }));
      if (!this.byDate) return dayBlocks;
      return [{ key: 'etapas', title: '', meta: '', rows: dayBlocks.flatMap((b) => b.rows) }];
    },
    rows(): RowView[] {
      return this.blocks.flatMap((b) => b.rows);
    },
    /** Algún renglón tiene hora de largada. */
    timed(): boolean {
      return this.rows.some((r) => !!r.time);
    },
    hasLocalTimes(): boolean {
      return this.rows.some((r) => !!r.time?.local && !!r.time.user);
    },
    /** Renglón a destacar arriba: el tramo en curso, la etapa de hoy o lo próximo. */
    nowRow(): RowView | undefined {
      return this.rows.find((r) => r.state === 'live') ?? this.rows.find((r) => r.state === 'today') ?? this.rows.find((r) => r.state === 'next');
    },
    nowLabel(): string {
      const s = this.nowRow?.state;
      return s === 'live' ? 'En curso: ' : s === 'today' ? 'Hoy: ' : `${this.nextWord}: `;
    },
  },
  watch: {
    'event.id': {
      immediate: true,
      handler() {
        void this.load();
      },
    },
  },
  methods: {
    ...mapActions(useStagesStore, { loadStages: 'load' }),
    load(force = false) {
      return this.loadStages(this.event.seriesId, this.event.id, force);
    },
    rowView(stage: RallyStage, index: number, state: StageState, eventSurface: Surface | undefined): RowView {
      const time = stageTime(stage, this.event.tz, this.timeZone);
      const date = DateTime.fromISO(stage.date).setLocale('es-AR');
      const timedKm = stage.distanceKm !== undefined && stage.kind !== 'enlace';
      const liaison = stage.liaisonKm ?? stage.totalKm;
      const code = stage.kind === 'descanso' ? STAGE_KIND_LABELS.descanso : stage.code.trim();
      const name = stage.name.trim();
      // El código ya suele decir "Shakedown" o "Prólogo": el distintivo solo si no lo dice.
      const kindLabel = STAGE_KIND_LABELS[stage.kind];
      const kindBadge =
        stage.kind === 'superespecial' || stage.kind === 'enlace' || ((stage.kind === 'shakedown' || stage.kind === 'prologo') && !code.toLowerCase().includes(kindLabel.toLowerCase()))
          ? kindLabel
          : '';
      const surface = stage.surface && stage.surface !== eventSurface ? stage.surface : undefined;
      const power = stage.kind === 'power';
      const cancelled = !!stage.cancelled;
      const sub: string[] = [];
      if (time) {
        if (this.byDate && time.user) sub.push(`Larga a las ${time.user}${time.userDay ? ` del ${time.userDay}` : ''}`);
        if (time.local) sub.push(`${time.local} hora local`);
      }
      const extra = stageExtraKmText(stage);
      if (extra) sub.push(extra);
      return {
        key: `${stage.date}-${index}-${stage.code}`,
        anchor: `tramo-${index}`,
        state,
        cancelled,
        code,
        name: name.toLowerCase() === code.toLowerCase() ? '' : name,
        weekday: date.toFormat('ccc').replace('.', ''),
        day: date.toFormat('d'),
        dateTitle: date.toFormat("cccc d 'de' LLLL"),
        time,
        ...(stage.startUtc ? { startUtc: stage.startUtc } : {}),
        sub: sub.join(' · '),
        power,
        kindBadge,
        ...(surface ? { surface } : {}),
        badges: state === 'live' || state === 'today' || state === 'next' || cancelled || power || !!kindBadge || !!surface,
        kmMain: timedKm ? formatKm(stage.distanceKm!) : liaison !== undefined && stage.kind !== 'descanso' ? formatKm(liaison) : '',
        kmSub: timedKm ? (this.byDate ? 'especial' : '') : liaison !== undefined && stage.kind !== 'descanso' ? 'enlace' : '',
        terrain: terrainBars(stage),
        note: stage.note?.trim() ?? '',
        mapUrl: stage.mapUrl ?? '',
        moreLabel: stage.note && stage.mapUrl ? 'Descripción y mapa' : stage.note ? 'Descripción' : `Mapa de${this.byDate ? ' la etapa' : 'l tramo'}`,
      };
    },
    terrainTitle(t: TerrainBar): string {
      return `${t.label}: ${t.text}${t.km ? ` (${formatKm(t.km)})` : ''}`;
    },
    /** Lleva al renglón destacado (el itinerario de un rally puede tener más de veinte tramos). */
    scrollToRow(anchor: string) {
      const el = document.getElementById(anchor);
      if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    },
  },
});
</script>

<style>
/* Tono de la superficie del rally: lo usan las barras de terreno (una sola familia de color). */
.stages-panel {
  --surface-hue: var(--accent);
}

.stages-panel.surface-asfalto {
  --surface-hue: #7d8a9c;
}

.stages-panel.surface-tierra {
  --surface-hue: #b5743a;
}

.stages-panel.surface-nieve {
  --surface-hue: #3aa0e0;
}

.stages-panel.surface-arena {
  --surface-hue: #d99a1c;
}

.stages-panel.surface-mixto {
  --surface-hue: #9b6ad6;
}

.stages-summary {
  margin-top: 0;
}

.stages-surface {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem 0.6rem;
  margin: 0 0 0.7rem;
}

/* Cifras del recorrido: el número grande y, arriba, qué es. */
.stat-tiles {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(5.2rem, 1fr));
  gap: 0.5rem;
  margin: 0;
}

/* Con cuatro cifras, en el celular van de a dos (si no, la cuarta queda sola en otro renglón). */
.stat-tiles:has(> :nth-child(4)) {
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

@media (min-width: 560px) {
  .stat-tiles:has(> :nth-child(4)) {
    grid-template-columns: repeat(4, minmax(0, 1fr));
  }
}

.stat-tile {
  display: flex;
  flex-direction: column;
  padding: 0.5rem 0.6rem;
  border-radius: 10px;
  background: var(--bg-elev-2);
}

.stat-label {
  color: var(--text-dim);
  font-size: 0.72rem;
  font-weight: 700;
}

.stat-value {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 800;
  white-space: nowrap;
}

.stages-cancelled {
  margin: 0.5rem 0 0;
}

/* "En curso: SS4 · …": lleva al renglón. */
.stage-now {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  min-height: 44px;
  margin-top: 0.7rem;
  padding: 0.4rem 0.5rem 0.4rem 0.75rem;
  border: none;
  border-radius: 10px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  box-shadow: inset 3px 0 0 var(--accent);
  color: var(--text);
  text-align: left;
}

.stage-now.live {
  background: color-mix(in srgb, var(--live) 12%, transparent);
  box-shadow: inset 3px 0 0 var(--live);
}

.stage-now-label {
  color: var(--text-dim);
  font-size: 0.85rem;
}

.stage-now-chev {
  flex: none;
  transform: rotate(90deg);
}

.stage-day {
  margin: 0 0 0.75rem;
  overflow: hidden;
}

.stage-day-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.5rem;
  padding-right: 0.85rem;
}

.stage-day-meta {
  white-space: nowrap;
}

.stage-rows {
  list-style: none;
  margin: 0;
  padding: 0;
}

.stage-row {
  display: flex;
  align-items: flex-start;
  gap: 0.7rem;
  padding: 0.6rem 0.85rem;
  /* Al saltar a un renglón no queda tapado por la cabecera y las pestañas fijas. */
  scroll-margin-top: calc(var(--header-h) + var(--safe-top) + 56px);
}

.stage-row + .stage-row,
.stage-day-head + .stage-rows > .stage-row:first-child {
  border-top: 1px solid var(--border);
}

.stage-row.live {
  box-shadow: inset 3px 0 0 var(--live);
  background: color-mix(in srgb, var(--live) 7%, transparent);
}

.stage-row.today,
.stage-row.next {
  box-shadow: inset 3px 0 0 var(--accent);
  background: color-mix(in srgb, var(--accent) 7%, transparent);
}

.stage-time {
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 3.4rem;
  flex: none;
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
}

.stage-time-day,
.stage-time-note {
  color: var(--text-dim);
  font-size: 0.72rem;
  font-weight: 700;
}

.stage-row.live .stage-time strong {
  color: var(--live);
}

.stage-row.next .stage-time strong {
  color: var(--accent);
}

.stage-row.today .stage-date .date-day {
  color: var(--accent);
}

.stage-info {
  flex: 1;
  min-width: 0;
}

.stage-info p {
  margin: 0;
}

.stage-title {
  overflow-wrap: anywhere;
}

.stage-code {
  margin-right: 0.4rem;
  font-weight: 800;
}

.stage-name {
  font-weight: 600;
}

/* Ya largado o ya corrido: atenuado. Cancelado: tachado. */
.stage-row.past .stage-time strong,
.stage-row.past .stage-code,
.stage-row.past .stage-name,
.stage-row.past .stage-km strong,
.stage-row.past .stage-date .date-day {
  color: var(--text-dim);
}

.stage-row.cancelled .stage-name,
.stage-row.cancelled .stage-km strong {
  color: var(--text-dim);
  text-decoration: line-through;
}

.stage-sub {
  margin-top: 0.1rem;
}

.stage-info .stage-badges {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.3rem;
  margin-top: 0.35rem;
}

.badge-today {
  color: var(--accent);
}

.stage-km {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  flex: none;
  font-variant-numeric: tabular-nums;
  line-height: 1.25;
  white-space: nowrap;
}

/* Barras de terreno: una por tipo, todas del tono de la superficie; el porcentaje va escrito al lado. */
.terrain-bars {
  list-style: none;
  margin: 0.5rem 0 0;
  padding: 0;
  display: grid;
  grid-template-columns: max-content minmax(3rem, 1fr) max-content;
  gap: 0.3rem 0.6rem;
  align-items: center;
  font-size: 0.8rem;
}

.terrain-row {
  display: contents;
}

.terrain-label {
  color: var(--text);
}

.terrain-track {
  height: 8px;
  border-radius: 0 4px 4px 0;
  background: var(--bg-elev-2);
  overflow: hidden;
}

.terrain-fill {
  display: block;
  height: 100%;
  min-width: 2px;
  border-radius: 0 4px 4px 0;
  background: color-mix(in srgb, var(--surface-hue) 78%, var(--text));
}

.terrain-value {
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
  text-align: right;
}

.stage-more {
  margin-top: 0.25rem;
}

.stage-more summary {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  width: fit-content;
  min-height: 44px;
  padding-right: 0.75rem;
  color: var(--link);
  font-size: 0.85rem;
  font-weight: 700;
  cursor: pointer;
  list-style: none;
}

.stage-more summary::-webkit-details-marker {
  display: none;
}

.stage-more-chev {
  transition: transform 0.15s;
}

.stage-more[open] .stage-more-chev {
  transform: rotate(90deg);
}

.stage-info .stage-note {
  margin: 0 0 0.4rem;
  font-size: 0.9rem;
}

.stage-more .stage-map {
  margin: 0 0 0.4rem;
}

@media (prefers-reduced-motion: reduce) {
  .stage-more-chev {
    transition: none;
  }
}

/* Escritorio: un día del rally por tarjeta, en grilla (como los Horarios del evento). */
@media (min-width: 1024px) {
  .stages-panel {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
    column-gap: 0.75rem;
    align-items: start;
  }

  .stages-panel > :not(.stage-day),
  .stages-panel.by-date > .stage-day {
    grid-column: 1 / -1;
  }
}
</style>
