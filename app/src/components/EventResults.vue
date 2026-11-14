<template>
  <div class="event-results">
    <p v-if="!hasAnyResult && !finishedWithout.length" class="card empty dim">
      Todavía no hay resultados de este evento. Aparecen unas horas después de cada sesión.
    </p>
    <template v-else>
      <p v-if="hasAnyResult && (!state || state.status === 'loading')" class="dim">Cargando resultados…</p>
      <div v-else-if="hasAnyResult && state?.status === 'error'" class="notice notice-error">
        No se pudieron cargar los resultados ({{ state.error }}).
        <button type="button" class="btn btn-small" @click="load(true)">Reintentar</button>
      </div>
      <p v-else-if="!chips.length" class="card empty dim">Sin datos todavía.</p>
      <template v-else>
        <div v-tab-strip class="session-chips" role="tablist" aria-label="Sesión">
          <button
            v-for="c in chips"
            :key="c.sessionId"
            type="button"
            role="tab"
            class="pill"
            :class="{ active: c.sessionId === currentId, unavailable: !c.result }"
            :aria-selected="c.sessionId === currentId"
            :title="c.result ? undefined : 'Resultado todavía no disponible en la app'"
            @click="selectSession(c.sessionId)"
          >
            {{ sessionName(c.sessionId) }}
          </button>
        </div>

        <!-- Sesión terminada sin resultado en la app: se dice y se manda a la fuente oficial (no se oculta). -->
        <section v-if="!current && currentId" class="card results-unavailable">
          <h3>{{ sessionName(currentId) }}</h3>
          <p>Resultado todavía no disponible en la app.</p>
          <a v-if="officialUrl" :href="officialUrl" target="_blank" rel="noopener noreferrer" class="btn btn-small">
            Ver en el sitio oficial ({{ officialHost }}) <AppIcon name="external" :size="14" />
          </a>
        </section>

        <!-- Categorías con clases: General y cada clase, en el orden en que aparecen en la general. -->
        <div v-if="current && classes.length" v-tab-strip class="session-chips class-chips" role="tablist" aria-label="Clase">
          <button
            type="button"
            role="tab"
            class="pill pill-small"
            :class="{ active: !activeClass }"
            :aria-selected="!activeClass"
            @click="selectedClass = ''"
          >
            General
          </button>
          <button
            v-for="c in classes"
            :key="c"
            type="button"
            role="tab"
            class="pill pill-small"
            :class="{ active: activeClass === c }"
            :aria-selected="activeClass === c"
            @click="selectedClass = c"
          >
            <span class="class-dot" :class="`tone-${toneOf(c)}`" aria-hidden="true" />{{ c }}
          </button>
        </div>

        <!-- Podio de un vistazo (solo en carreras): P2 · P1 · P3, con equipo y tiempo o diferencia -->
        <section v-if="current && showPodium" class="card podium-card" aria-label="Podio">
          <h3 class="podium-title">
            Podio · {{ sessionName(current.sessionId) }}<template v-if="activeClass"> · {{ activeClass }}</template>
          </h3>
          <ol class="podium-steps">
            <li v-for="row in podiumSteps" :key="`${row.pos}-${row.driver}`" class="podium-step" :class="`p${placeOf(row)}`">
              <span class="podium-pos">{{ placeOf(row) }}</span>
              <span class="podium-name">
                <template v-for="(m, j) in membersOf(row.driver)" :key="j">
                  <template v-if="j > 0">/</template>
                  <RouterLink v-if="m.link" :to="m.link" class="podium-member">{{ m.short }}</RouterLink>
                  <span v-else class="podium-member">{{ m.short }}</span>
                </template>
              </span>
              <span v-if="row.team || row.vehicle" class="podium-team small dim">{{ row.team ?? row.vehicle }}</span>
              <span v-if="row.time || row.gap" class="podium-time small">{{ row.time ?? row.gap }}</span>
            </li>
          </ol>
          <!-- En la general de una carrera con clases: el ganador de cada clase. -->
          <ul v-if="!activeClass && winners.length" class="class-winners">
            <li v-for="w in winners" :key="w.class" class="class-winner">
              <button type="button" class="class-chip as-button" :class="`tone-${toneOf(w.class)}`" @click="selectedClass = w.class">{{ w.class }}</button>
              <span class="grow">
                <template v-for="(m, j) in membersOf(w.row.driver)" :key="j">
                  <template v-if="j > 0"> / </template>
                  <RouterLink v-if="m.link" :to="m.link" class="tap-inline">{{ m.short }}</RouterLink>
                  <template v-else>{{ m.short }}</template>
                </template>
                <span v-if="w.row.team || w.row.vehicle" class="dim"> · {{ w.row.team ?? w.row.vehicle }}</span>
              </span>
            </li>
          </ul>
          <p v-if="fastest" class="podium-fastest small">
            <AppIcon name="clock" :size="14" />
            <span>Vuelta rápida: <strong>{{ shortName(fastest.row.driver) }}</strong> · {{ fastest.time }}</span>
          </p>
        </section>

        <div v-if="current" :id="`res-${current.sessionId}`" class="card flush">
          <h3 class="card-title">{{ sessionName(current.sessionId) }}<template v-if="activeClass"> · {{ activeClass }}</template></h3>
          <!-- Condiciones que midió la organización durante la sesión (no es el pronóstico) -->
          <p v-if="conditionsLine && current.conditions" class="session-conditions small">
            <svg
              class="session-conditions-icon"
              width="15"
              height="15"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z" />
              <path d="M12 9v7" />
            </svg>
            <span class="session-conditions-text">
              <!-- Cada dato no se parte y el "·" queda al final del renglón, nunca al principio del siguiente -->
              <span class="session-conditions-values">
                <template v-for="(part, i) in conditionsItems" :key="i">
                  <span class="session-conditions-part">{{ part }}<template v-if="i < conditionsItems.length - 1"> ·</template></span>{{ ' ' }}
                </template>
              </span>
              <span class="session-conditions-label dim">
                {{ conditionsLabel }}
                <template v-if="current.conditions.source">
                  ·
                  <a
                    :href="current.conditions.source.url"
                    :title="current.conditions.source.title"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="tap-inline"
                  >
                    {{ conditionsSourceName }}
                  </a>
                </template>
              </span>
            </span>
          </p>
          <table class="data results" :class="{ 'with-classes': classes.length }">
            <thead>
              <tr>
                <th class="num" :title="activeClass ? `Puesto en ${activeClass}` : undefined">#</th>
                <th class="name-col">{{ crews ? 'Pilotos' : 'Piloto' }}</th>
                <th v-if="activeClass" class="num" title="Puesto en la general">Gral.</th>
                <th v-if="hasCol(viewRows, 'laps')" class="num">V</th>
                <th class="num">Tiempo</th>
                <th v-if="hasCol(viewRows, 'points')" class="num">Pts</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="(row, i) in viewRows"
                :key="i"
                :class="{ podium: isTop(row), linked: !!singleLink(row.driver) }"
                @click="openRow($event, row.driver)"
              >
                <td class="num pos">{{ activeClass ? (row.classPos ?? row.status ?? '—') : (row.pos ?? row.status ?? '—') }}</td>
                <td class="name-td">
                  <RouterLink v-if="singleLink(row.driver)" :to="singleLink(row.driver)" class="name-cell row-link">
                    <span v-if="row.number" class="car-number">{{ row.number }}</span>
                    <span class="grow">
                      <span class="row-name">{{ row.driver }}</span>
                      <span v-if="row.team || row.vehicle" class="small dim team">{{ row.team ?? row.vehicle }}</span>
                      <span v-if="!activeClass && row.class && classes.length" class="class-chip" :class="`tone-${toneOf(row.class)}`" :title="classTitle(row)">{{ row.class }}</span>
                    </span>
                  </RouterLink>
                  <div v-else class="name-cell row-link">
                    <span v-if="row.number" class="car-number">{{ row.number }}</span>
                    <span class="grow">
                      <span class="row-name crew-names">
                        <template v-for="(m, j) in membersOf(row.driver)" :key="j">
                          <template v-if="j > 0"> / </template>
                          <RouterLink v-if="m.link" :to="m.link" class="crew-member">{{ m.name }}</RouterLink>
                          <template v-else>{{ m.name }}</template>
                        </template>
                      </span>
                      <span v-if="row.team || row.vehicle" class="small dim team">{{ row.team ?? row.vehicle }}</span>
                      <span v-if="!activeClass && row.class && classes.length" class="class-chip" :class="`tone-${toneOf(row.class)}`" :title="classTitle(row)">{{ row.class }}</span>
                    </span>
                  </div>
                </td>
                <td v-if="activeClass" class="num small dim">{{ row.pos ?? '' }}</td>
                <td v-if="hasCol(viewRows, 'laps')" class="num">{{ row.laps ?? '' }}</td>
                <td class="num small">{{ row.time ?? row.gap ?? (row.pos === null ? row.status ?? '' : '') }}</td>
                <td v-if="hasCol(viewRows, 'points')" class="num">{{ row.points ?? '' }}</td>
              </tr>
            </tbody>
          </table>
          <div class="card-foot"><SourceLink :source="current.source" /></div>
        </div>
      </template>
    </template>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapActions, mapState } from 'pinia';
import {
  driverDisplayName,
  isSingleDriverName,
  type EventResultsFile,
  type MotorEvent,
  type ResultRow,
  type Session,
  type SessionResult,
} from '@dm/shared';
import AppIcon from './AppIcon.vue';
import SourceLink from './SourceLink.vue';
import { useDriversStore } from '../stores/drivers.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { useResultsStore, type Loaded } from '../stores/results.ts';
import { tabStrip } from '../lib/tabStrip.ts';
import { conditionsLabel, conditionsParts, conditionsSourceName, conditionsText } from '../lib/conditions.ts';
import { fastestLap, isRaceType, mainResultSession, orderResultSessions, podium, shortDriverName } from '../lib/podium.ts';
import {
  classPodium,
  classPosOf,
  classRows,
  classTone,
  classWinners,
  crewMembers,
  resultClasses,
  type ClassRow,
} from '../lib/classes.ts';
import { finishedWithoutResults, officialResultsUrl } from '../lib/resultsInfo.ts';
import { hostOf } from '../lib/bios.ts';

interface Chip {
  sessionId: string;
  result?: SessionResult;
}

interface MemberView {
  name: string;
  short: string;
  link: string;
}

/**
 * Resultados de las sesiones de un evento, una tabla por vez (chips por sesión). Las sesiones terminadas sin
 * resultado en la app también tienen chip, con el enlace a la fuente oficial. En categorías con clases, un segundo
 * selector filtra la tabla y el podio por clase.
 */
export default defineComponent({
  name: 'EventResults',
  components: { AppIcon, SourceLink },
  directives: { tabStrip },
  props: {
    event: { type: Object as PropType<MotorEvent>, required: true },
    /** Sesión a mostrar primero (si tiene resultado). */
    focusSession: { type: String, default: '' },
  },
  data() {
    return { selected: '', selectedClass: '' };
  },
  computed: {
    ...mapState(useScheduleStore, ['schedule', 'now', 'seriesById']),
    ...mapState(useResultsStore, { resultsMap: 'results' }),
    ...mapState(useDriversStore, { driversById: 'byId', driversStatus: 'status' }),
    eventSessions(): Session[] {
      return (this.schedule?.sessions ?? []).filter((s) => s.eventId === this.event.id);
    },
    hasAnyResult(): boolean {
      return this.eventSessions.some((s) => s.hasResults);
    },
    state(): Loaded<EventResultsFile> | undefined {
      return this.resultsMap[`${this.event.seriesId}/${this.event.id}`];
    },
    /** Carreras primero (carrera, sprint, clasificatorias); después el resto, por hora. */
    sessions(): SessionResult[] {
      return orderResultSessions(this.state?.data?.sessions ?? [], this.eventSessions);
    },
    /** Sesiones que ya terminaron y no tienen resultado en la app. */
    finishedWithout(): Session[] {
      // Archivo no publicado (404): ninguna sesión tiene resultado, aunque el calendario diga lo contrario.
      const file = this.state?.status === 'missing' ? { sessions: [] } : this.state?.data;
      return finishedWithoutResults(this.eventSessions, file, this.now);
    },
    /** Chips: sesiones con resultado y terminadas sin resultado, en el orden de los resultados. */
    chips(): Chip[] {
      const results = new Map(this.sessions.map((s) => [s.sessionId, s]));
      const all = [...this.sessions.map((s) => ({ sessionId: s.sessionId })), ...this.finishedWithout.map((s) => ({ sessionId: s.id }))];
      return orderResultSessions(all, this.eventSessions).map((c) => {
        const result = results.get(c.sessionId);
        return result ? { sessionId: c.sessionId, result } : { sessionId: c.sessionId };
      });
    },
    /**
     * Sesión elegida: la del chip tocado o la pedida en la ruta; si no, la carrera principal con resultado (no la
     * primera práctica) y, sin ningún resultado, la última sesión terminada.
     */
    currentId(): string {
      const pick = this.selected || this.focusSession;
      if (pick && this.chips.some((c) => c.sessionId === pick)) return pick;
      const main = mainResultSession(this.sessions, this.eventSessions) ?? this.sessions[0];
      if (main) return main.sessionId;
      const last = [...this.finishedWithout].sort((a, b) => a.startUtc.localeCompare(b.startUtc)).pop();
      return last?.id ?? '';
    },
    current(): SessionResult | undefined {
      return this.chips.find((c) => c.sessionId === this.currentId)?.result;
    },
    currentIsRace(): boolean {
      const id = this.current?.sessionId;
      return isRaceType(this.eventSessions.find((s) => s.id === id)?.type);
    },
    /** Clases de la sesión en el orden en que aparecen en la general (vacío si tiene una sola o ninguna). */
    classes(): string[] {
      const list = resultClasses(this.current?.rows ?? []);
      return list.length > 1 ? list : [];
    },
    activeClass(): string {
      return this.classes.includes(this.selectedClass) ? this.selectedClass : '';
    },
    viewRows(): ClassRow[] {
      const rows = this.current?.rows ?? [];
      return this.activeClass ? classRows(rows, this.activeClass) : rows;
    },
    /** Hay tripulaciones (resistencia): cada integrante va con su enlace. */
    crews(): boolean {
      return (this.current?.rows ?? []).some((r) => !isSingleDriverName(r.driver));
    },
    podiumRows(): ClassRow[] {
      const rows = this.current?.rows ?? [];
      return this.activeClass ? classPodium(rows, this.activeClass) : podium(rows);
    },
    showPodium(): boolean {
      return this.currentIsRace && this.podiumRows.length > 0;
    },
    /** Orden visual del podio: 2.º, 1.º, 3.º (el ganador en el centro y más alto). */
    podiumSteps(): ClassRow[] {
      const [p1, p2, p3] = this.podiumRows;
      return [p2, p1, p3].filter((r): r is ClassRow => !!r);
    },
    winners(): Array<{ class: string; row: ClassRow }> {
      return this.classes.length && this.currentIsRace ? classWinners(this.current?.rows ?? []) : [];
    },
    fastest(): { row: ResultRow; time: string } | null {
      return this.currentIsRace ? fastestLap(this.viewRows) : null;
    },
    officialUrl(): string {
      return officialResultsUrl(this.seriesById.get(this.event.seriesId));
    },
    officialHost(): string {
      return hostOf(this.officialUrl);
    },
    /** "Aire 24° · Pista 38° · Humedad 45 % · Pista seca": solo con lo que la fuente midió; vacío si no hay nada. */
    conditionsLine(): string {
      return conditionsText(this.current?.conditions);
    },
    conditionsItems(): string[] {
      return conditionsParts(this.current?.conditions);
    },
    conditionsLabel(): string {
      return this.current?.conditions ? conditionsLabel(this.current.conditions) : '';
    },
    conditionsSourceName(): string {
      return this.current?.conditions ? conditionsSourceName(this.current.conditions) : '';
    },
  },
  watch: {
    'event.id': {
      immediate: true,
      handler() {
        this.selected = '';
        this.selectedClass = '';
        void this.load();
      },
    },
    /** Con tripulaciones hace falta el índice de pilotos para enlazar solo a quien tiene ficha. */
    crews: {
      immediate: true,
      handler(value: boolean) {
        if (value) void this.loadDrivers();
      },
    },
  },
  methods: {
    ...mapActions(useResultsStore, ['loadResults']),
    ...mapActions(useDriversStore, { loadDrivers: 'load' }),
    load(force = false) {
      if (!this.hasAnyResult) return;
      return this.loadResults(this.event.seriesId, this.event.id, force);
    },
    selectSession(id: string) {
      this.selected = id;
    },
    /** Toque en cualquier parte de la fila (posición, tiempo): lleva al piloto, como el link. */
    openRow(e: MouseEvent, driver: string) {
      const link = this.singleLink(driver);
      if (!link || (e.target as Element | null)?.closest?.('a')) return;
      void this.$router.push(link);
    },
    /**
     * Ficha de un piloto en la app. Con el índice de pilotos cargado, solo si figura; sin índice, un piloto solo se
     * enlaza siempre (como antes) y un integrante de tripulación, solo si el índice no se pudo leer.
     */
    linkFor(id: string, single: boolean): string {
      if (!id) return '';
      if (this.driversStatus === 'ok') return this.driversById.has(id) ? `/piloto/${id}` : '';
      if (single || this.driversStatus === 'missing' || this.driversStatus === 'error') return `/piloto/${id}`;
      return '';
    },
    /** Enlace de la fila entera ('' si es una tripulación: ahí cada integrante tiene el suyo). */
    singleLink(raw: string): string {
      if (!isSingleDriverName(raw)) return '';
      return this.linkFor(crewMembers(raw, this.event.seriesId)[0]?.id ?? '', true);
    },
    membersOf(raw: string): MemberView[] {
      const single = isSingleDriverName(raw);
      return crewMembers(raw, this.event.seriesId).map((m) => ({
        name: m.name,
        short: single ? driverDisplayName(m.name) : shortDriverName(m.name),
        link: this.linkFor(m.id, single),
      }));
    },
    shortName(raw: string): string {
      return isSingleDriverName(raw) ? driverDisplayName(raw) : shortDriverName(raw);
    },
    /** Puesto en el podio: el de la clase si hay una elegida. */
    placeOf(row: ClassRow): number | null {
      return this.activeClass ? (row.classPos ?? null) : row.pos;
    },
    isTop(row: ClassRow): boolean {
      const p = this.placeOf(row);
      return p !== null && p !== undefined && p <= 3;
    },
    toneOf(cls: string): number {
      return classTone(this.classes, cls);
    },
    classTitle(row: ResultRow): string {
      const p = classPosOf(this.current?.rows ?? [], row);
      return p ? `${p}.º en ${row.class}` : (row.class ?? '');
    },
    sessionName(sessionId: string): string {
      return this.eventSessions.find((s) => s.id === sessionId)?.name ?? 'Sesión';
    },
    hasCol(rows: object[], key: string): boolean {
      return rows.some((r) => (r as Record<string, unknown>)[key] !== undefined && (r as Record<string, unknown>)[key] !== null);
    },
  },
});
</script>

<style>
/* Sesión terminada sin resultado en la app */
.session-chips .pill.unavailable {
  background: transparent;
  box-shadow: inset 0 0 0 1px var(--border);
  color: var(--text-dim);
}

.session-chips .pill.unavailable.active {
  box-shadow: inset 0 0 0 2px var(--text);
  color: var(--text);
}

.results-unavailable h3 {
  margin: 0 0 0.35rem;
  font-size: 1rem;
}

.results-unavailable p {
  margin: 0 0 0.7rem;
}

.class-chips {
  margin-top: 0.5rem;
}

.class-chips .pill {
  min-height: 30px;
}

table.data.results .class-chip {
  margin-top: 0.2rem;
}

.crew-names .crew-member {
  color: var(--text);
  text-decoration: underline;
  text-decoration-color: var(--border);
  text-underline-offset: 2px;
}

.crew-names .crew-member:hover {
  color: var(--accent);
}

.podium-member {
  color: var(--text);
}

.class-winners {
  display: grid;
  gap: 0.35rem;
  margin: 0.7rem 0.25rem 0;
  padding: 0.6rem 0 0;
  border-top: 1px solid var(--border);
  list-style: none;
  font-size: 0.85rem;
}

.class-winner {
  display: flex;
  align-items: baseline;
  gap: 0.5rem;
  min-width: 0;
  overflow-wrap: anywhere;
}

.class-chip.as-button {
  flex: none;
  min-width: 3.4rem;
  justify-content: center;
  cursor: pointer;
  font: inherit;
  font-size: 0.7rem;
  font-weight: 800;
}

table.data.results tr.podium td.pos {
  color: var(--accent);
  font-weight: 800;
}

/* Línea de condiciones medidas, bajo el título de la sesión */
.session-conditions {
  display: flex;
  align-items: flex-start;
  gap: 0.4rem;
  margin: 0;
  padding: 0 0.85rem 0.6rem;
  line-height: 1.35;
}

.session-conditions-icon {
  flex: none;
  margin-top: 0.12em;
  color: var(--text-dim);
}

.session-conditions-text {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.session-conditions-values {
  color: var(--text);
  font-variant-numeric: tabular-nums;
}

.session-conditions-part {
  white-space: nowrap;
}

.podium-card {
  padding: 0.75rem 0.6rem 0.65rem;
}

.podium-title {
  margin: 0 0.25rem 0.6rem;
  font-size: 0.95rem;
  font-weight: 800;
}

.podium-steps {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  align-items: end;
  gap: 0.4rem;
  margin: 0;
  padding: 0;
  list-style: none;
}

.podium-step {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.15rem;
  min-width: 0;
  padding: 0.55rem 0.35rem 0.6rem;
  border-radius: 12px;
  background: var(--bg-elev-2);
  text-align: center;
}

.podium-step.p1 {
  padding-top: 0.95rem;
  background: color-mix(in srgb, var(--accent) 16%, var(--bg-elev-2));
}

.podium-pos {
  font-size: 1.15rem;
  font-weight: 900;
  font-variant-numeric: tabular-nums;
  color: var(--text-dim);
}

.podium-step.p1 .podium-pos {
  font-size: 1.45rem;
  color: var(--accent);
}

a.podium-name,
.podium-name {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  align-content: center;
  justify-content: center;
  min-height: 2.4em;
  max-width: 100%;
  color: var(--text);
  font-weight: 700;
  font-size: 0.9rem;
  line-height: 1.2;
  overflow-wrap: anywhere;
}

.podium-team {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.podium-time {
  font-variant-numeric: tabular-nums;
}

.podium-fastest {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin: 0.6rem 0.25rem 0;
  color: var(--text-dim);
}

.podium-fastest strong {
  color: var(--text);
}
</style>
