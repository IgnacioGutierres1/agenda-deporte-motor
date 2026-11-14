<template>
  <div class="context-panel">
    <!-- Encabezado -->
    <section class="card ctx-head">
      <div class="row">
        <SeriesCrest :series="series" :size="26" />
        <strong class="grow">{{ series.name }}</strong>
        <span v-if="seriesFollowed" class="badge badge-ok">La seguís</span>
      </div>
      <p class="ctx-event">{{ event.name }}</p>
      <p v-if="round" class="ctx-round">
        Fecha {{ round.n }} de {{ round.of }}<template v-if="racesHere.length > 1"> · {{ racesHere.length }} carreras</template>
        <span v-if="round.byCalendar" class="small dim"> (orden en el calendario)</span>
      </p>
      <p v-else-if="racesHere.length > 1" class="ctx-round">{{ racesHere.length }} carreras</p>
      <p class="small dim ctx-where">
        {{ dateRange(event.dateStart, event.dateEnd) }} ·
        <RouterLink v-if="circuitLink" :to="circuitLink" class="circuit-link tap-inline">{{ event.circuit }}</RouterLink><template v-else>{{ event.circuit }}</template><template v-if="event.country">, {{ event.country }}</template>
      </p>
    </section>

    <p v-if="loadingSomething" class="small dim">Cargando datos oficiales…</p>

    <!-- Qué se juega -->
    <section v-if="mainTable || round" class="card flush">
      <h3 class="card-title">Qué se juega</h3>
      <div class="ctx-pad">
        <p v-if="round" class="ctx-strong" :class="{ 'accent-text': round.after.length <= 1 }">
          {{ racesAfterText ? `${remaining} ${racesAfterText}` : remaining }}
        </p>
        <p v-if="standings" class="small dim">
          {{ timingLabel }} · leída {{ ago(standings.updatedAt) }}
        </p>
      </div>
      <template v-if="mainTable">
        <p v-if="driverTablesList.length > 1" class="ctx-subtitle small dim">{{ mainTable.title }}</p>
        <ul class="list-card inset ctx-gaps">
          <li v-for="r in mainTable.rows" :key="`${r.pos}-${r.name}`" :class="{ followed: r.followed }">
            <component :is="r.driverId ? 'RouterLink' : 'div'" :to="r.driverId ? `/piloto/${r.driverId}` : undefined" class="list-row">
              <span class="pos-badge" :class="{ top: r.pos === 1 }">{{ r.pos }}</span>
              <span class="grow">
                {{ r.name }}
                <AppIcon v-if="r.followed" name="star" :size="13" filled class="accent-text ctx-star" />
                <span v-if="r.team" class="block small dim">{{ r.team }}</span>
              </span>
              <span class="ctx-points">
                <strong>{{ num(r.points) }}</strong>
                <span class="block small dim">{{ r.gap ? `−${num(r.gap)}` : 'Líder' }}</span>
              </span>
            </component>
          </li>
        </ul>
        <div v-if="math" class="ctx-math">
          <p v-if="math.clinched"><strong>{{ math.leader.name }}</strong> ya no puede ser alcanzado: tiene el título asegurado.</p>
          <template v-else>
            <p v-if="timing === 'after'">
              Quedan {{ num(math.afterEvent) }} puntos en juego: siguen con chances
              <strong>{{ math.contenders.length + 1 }}</strong> {{ math.contenders.length ? 'pilotos' : 'piloto' }}.
            </p>
            <template v-else>
              <p>
                En esta fecha hay {{ num(math.thisEvent) }} puntos en juego y después {{ num(math.afterEvent) }}. Pueden ser
                campeones <strong>{{ math.contenders.length + 1 }}</strong> pilotos.
              </p>
              <p v-if="math.canClinchHere">
                <strong>{{ math.leader.name }}</strong> puede ser campeón acá. Le alcanza con
                <template v-for="(n, i) in math.needs" :key="n.rival.name">{{ i ? (i === math.needs.length - 1 ? ' y ' : ', ') : '' }}{{ margin(n.margin, n.rival.name) }}</template>.
              </p>
              <p v-else-if="round && round.after.length">{{ math.leader.name }} no puede asegurarse el título en esta fecha.</p>
            </template>
          </template>
          <p class="small dim">Puntaje máximo: {{ math.note }}. Empate en puntos: se define por victorias.</p>
        </div>
        <template v-for="t in otherTables" :key="t.title">
          <p class="ctx-subtitle small dim">{{ t.title }}</p>
          <ul class="list-card inset ctx-gaps compact">
            <li v-for="r in t.rows" :key="`${r.pos}-${r.name}`" :class="{ followed: r.followed }">
              <component :is="r.driverId ? 'RouterLink' : 'div'" :to="r.driverId ? `/piloto/${r.driverId}` : undefined" class="list-row">
                <span class="pos-badge" :class="{ top: r.pos === 1 }">{{ r.pos }}</span>
                <span class="grow">
                  {{ r.name }}
                  <AppIcon v-if="r.followed" name="star" :size="13" filled class="accent-text ctx-star" />
                </span>
                <span class="ctx-points small">
                  <strong>{{ num(r.points) }}</strong>
                  <span class="dim"> {{ r.gap ? `−${num(r.gap)}` : '' }}</span>
                </span>
              </component>
            </li>
          </ul>
        </template>
        <RouterLink :to="{ query: { ...$route.query, tab: 'tabla' } }" class="ctx-more small">Ver tabla completa</RouterLink>
      </template>
    </section>

    <!-- Formato -->
    <section v-if="counts || roster" class="card flush">
      <h3 class="card-title">Formato</h3>
      <div class="ctx-pad">
        <p v-if="counts">{{ counts }}</p>
        <p v-else class="small dim">El organizador todavía no publicó el cronograma.</p>
      </div>
      <ul v-if="raceRows.length" class="list-card inset">
        <li v-for="r in raceRows" :key="r.id">
          <div class="list-row">
            <AppIcon name="flag" :size="18" class="dim" />
            <span class="grow">
              {{ r.name }}
              <span class="block small dim">{{ r.duration }}</span>
            </span>
            <span class="ctx-time">
              <strong>{{ r.day }} {{ r.time }}</strong> <span class="small dim">{{ zoneText }}</span>
              <span v-if="r.arTime" class="block small dim">{{ r.arTime }} ARG</span>
              <span class="block small dim">{{ r.local }} hora local</span>
            </span>
          </div>
        </li>
      </ul>
      <div v-if="roster" class="ctx-pad ctx-roster">
        <p>
          <strong>{{ roster.cars }}</strong> {{ roster.cars === 1 ? 'auto' : 'autos' }} ·
          <strong>{{ roster.drivers }}</strong> pilotos inscriptos en la temporada
        </p>
        <div v-if="roster.classes.length > 1" class="ctx-classes">
          <span v-for="c in roster.classes" :key="c.name" class="pill pill-small">{{ c.name }} · {{ c.cars }}</span>
        </div>
        <RouterLink :to="`/categoria/${series.id}?tab=plantel`" class="ctx-more small">Ver plantel</RouterLink>
      </div>
    </section>

    <!-- El circuito (solo si tiene ficha con algo para mostrar) -->
    <section v-if="circuitInfo" class="card flush ctx-circuit">
      <h3 class="card-title">El circuito</h3>
      <RouterLink :to="circuitLink" class="list-row ctx-circuit-row">
        <CircuitFigure :info="circuitInfo" :name="event.circuit" mini :img-width="250" class="ctx-circuit-fig" @kind="circuitFigureKind = $event" />
        <span class="grow">
          {{ circuitInfo.name }}
          <span v-if="circuitFacts" class="block small dim">{{ circuitFacts }}</span>
          <span v-if="circuitRecord" class="block small dim">Récord: {{ circuitRecord }}</span>
          <span class="block small ctx-circuit-go">Ver el circuito</span>
        </span>
        <AppIcon name="chevron" :size="16" class="dim" />
      </RouterLink>
      <p v-if="circuitCredit" class="card-foot small dim ctx-circuit-credit">{{ circuitCredit }}</p>
    </section>

    <!-- A quién mirar -->
    <section v-if="watch.length" class="card flush">
      <h3 class="card-title">A quién mirar</h3>
      <ul class="list-card inset">
        <li v-for="w in watch" :key="`${w.kind}-${w.id}`">
          <RouterLink :to="`/${w.kind}/${w.id}`" class="list-row">
            <DriverAvatar :name="w.name" :color="color" :size="34" />
            <span class="grow">
              {{ w.name }}
              <AppIcon v-if="w.followed" name="star" :size="13" filled class="accent-text ctx-star" />
              <span class="block small dim">{{ w.reason }}<template v-if="w.detail"> · {{ w.detail }}</template></span>
            </span>
            <AppIcon name="chevron" :size="16" class="dim" />
          </RouterLink>
        </li>
      </ul>
    </section>

    <!-- Ya pasó -->
    <section v-if="doneHere.length || previous" class="card flush">
      <h3 class="card-title">Ya pasó</h3>
      <template v-if="doneHere.length">
        <p class="ctx-subtitle small dim">{{ rally ? 'En este rally' : 'Este fin de semana' }}</p>
        <ul class="list-card inset">
          <li v-for="h in doneHere" :key="`${h.sessionId}-${h.class ?? ''}`">
            <RouterLink :to="{ query: { ...$route.query, tab: 'resultados', session: h.sessionId } }" class="list-row">
              <span class="grow">
                <span class="small dim">{{ h.sessionName }} · {{ h.label }}{{ h.class ? ` en ${h.class}` : '' }}</span>
                <span class="block">{{ h.driver }}<span v-if="h.team" class="small dim"> · {{ h.team }}</span></span>
              </span>
              <AppIcon name="chevron" :size="16" class="dim" />
            </RouterLink>
          </li>
        </ul>
      </template>
      <template v-if="previous">
        <p class="ctx-subtitle small dim">Fecha anterior</p>
        <ul class="list-card inset">
          <li>
            <RouterLink :to="`/evento/${previous.id}${winnersBefore.length ? '?tab=resultados' : ''}`" class="list-row">
              <span class="grow">
                {{ previous.name }}
                <span class="block small dim">
                  <template v-if="previous.round">Fecha {{ previous.round }} · </template>{{ dateRange(previous.dateStart, previous.dateEnd) }} · {{ previous.circuit }}
                </span>
                <span v-for="w in winnersBefore" :key="`${w.sessionId}-${w.class ?? ''}`" class="block small">
                  <AppIcon name="trophy" :size="13" class="accent-text" />
                  {{ winnerPrefix(w) }}{{ w.driver }}<span v-if="w.team" class="dim"> · {{ w.team }}</span>
                </span>
                <span v-if="!winnersBefore.length" class="block small dim">Sin resultados publicados en la app.</span>
              </span>
              <AppIcon name="chevron" :size="16" class="dim" />
            </RouterLink>
          </li>
        </ul>
      </template>
    </section>

    <!-- Notas recientes -->
    <section v-if="news.length" class="card">
      <h3 class="ctx-news-title">Notas recientes</h3>
      <NewsList :items="news" :featured="false" />
    </section>

    <!-- Fuentes -->
    <section class="ctx-sources">
      <p class="section-title">Fuentes</p>
      <div v-for="s in sources" :key="s.label + s.source.url" class="ctx-source">
        <span class="small dim">{{ s.label }}</span>
        <SourceLink :source="s.source" />
      </div>
    </section>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { mapActions, mapState } from 'pinia';
import { DateTime } from 'luxon';
import {
  AR_TZ,
  isDriverTable,
  type CircuitInfo,
  type EventResultsFile,
  type MotorEvent,
  type NewsItem,
  type RosterFile,
  type Series,
  type Session,
  type Source,
  type StandingsFile,
  type StandingsTable,
} from '@dm/shared';
import AppIcon from './AppIcon.vue';
import CircuitFigure from './CircuitFigure.vue';
import DriverAvatar from './DriverAvatar.vue';
import NewsList from './NewsList.vue';
import SeriesCrest from './SeriesCrest.vue';
import SourceLink from './SourceLink.vue';
import { useCircuitInfoStore } from '../stores/circuitInfo.ts';
import { useNewsStore } from '../stores/news.ts';
import { useResultsStore } from '../stores/results.ts';
import { useRostersStore } from '../stores/rosters.ts';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore, type FollowedTeam } from '../stores/settings.ts';
import { circuitId } from '../lib/circuits.ts';
import { circuitShortFacts, hasCircuitHighlights, imageCredit, lapRecordShort, type CircuitFigureKind } from '../lib/circuitInfo.ts';
import { formatDateRange, timeAgo, zoneLabel } from '../lib/format.ts';
import { seriesColor } from '../lib/grid.ts';
import { teamNeedles } from '../lib/teams.ts';
import {
  driverTables,
  durationMinutes,
  durationText,
  eventFormatText,
  eventNeedles,
  gapTable,
  highlights,
  isRace,
  isRallyEvent,
  marginText,
  newsReference,
  pickNews,
  raceSessions,
  racesAfter,
  remainingText,
  rosterSummary,
  roundInfo,
  standingsTiming,
  surnameNeedles,
  timingLabel,
  titleMath,
  whoToWatch,
  type ChampionshipTable,
  type Followed,
  type RosterSummary,
  type RoundInfo,
  type SessionHighlight,
  type StandingsTiming,
  type TitleMath,
  type WatchItem,
} from '../lib/context.ts';

/** Equipo seguido (con lo mínimo que hace falta acá). */
type FollowedTeamRef = Pick<FollowedTeam, 'id' | 'name'>;

interface RaceRow {
  id: string;
  name: string;
  day: string;
  time: string;
  arTime: string;
  local: string;
  duration: string;
}

/** Ficha "Contexto" de un evento: todo lo que hace falta saber para engancharse con una carrera. */
export default defineComponent({
  name: 'ContextPanel',
  components: { AppIcon, CircuitFigure, DriverAvatar, NewsList, SeriesCrest, SourceLink },
  props: {
    event: { type: Object as PropType<MotorEvent>, required: true },
    series: { type: Object as PropType<Series>, required: true },
    /** Equipos seguidos; si no se pasan, los de Ajustes. */
    teamsOverride: { type: Array as PropType<FollowedTeamRef[] | null>, default: null },
  },
  data() {
    return {
      /** Qué muestra la miniatura del circuito (trazado, plano o nada): lo avisa CircuitFigure. */
      circuitFigureKind: 'none' as CircuitFigureKind,
    };
  },
  computed: {
    ...mapState(useScheduleStore, ['schedule', 'now', 'status']),
    ...mapState(useSettingsStore, ['timeZone', 'followedDrivers', 'followedSeries', 'followedTeams']),
    ...mapState(useResultsStore, { standingsMap: 'standings', resultsMap: 'results' }),
    ...mapState(useRostersStore, { rostersMap: 'rosters' }),
    ...mapState(useNewsStore, { newsItems: 'items', newsStatus: 'status' }),
    ...mapState(useCircuitInfoStore, { circuitInfoById: 'byId', circuitTracks: 'tracks' }),
    color(): string {
      return seriesColor(this.series);
    },
    circuitLink(): string {
      const id = circuitId(this.event.circuit);
      return id ? `/circuito/${id}` : '';
    },

    // ── El circuito ──
    /** Ficha del circuito, si existe y tiene algo para este bloque (dibujo, longitud, curvas o récord). */
    circuitInfo(): CircuitInfo | null {
      const info = this.circuitInfoById.get(circuitId(this.event.circuit));
      return info && hasCircuitHighlights(info) ? info : null;
    },
    circuitFacts(): string {
      return this.circuitInfo ? circuitShortFacts(this.circuitInfo) : '';
    },
    circuitRecord(): string {
      const record = this.circuitInfo?.lapRecord;
      return record?.time ? lapRecordShort(record) : '';
    },
    /** Atribución de la miniatura (el trazado es de OpenStreetMap; el plano, de Commons). */
    circuitCredit(): string {
      const info = this.circuitInfo;
      if (!info) return '';
      if (this.circuitFigureKind === 'track') return `Trazado: ${this.circuitTracks[info.id]?.data?.credit || '© Colaboradores de OpenStreetMap'}`;
      if (this.circuitFigureKind === 'map' && info.map) return `Plano: ${imageCredit(info.map)} · Wikimedia Commons`;
      return '';
    },
    seriesFollowed(): boolean {
      return this.followedSeries.includes(this.series.id);
    },
    teams(): FollowedTeamRef[] {
      return this.teamsOverride ?? this.followedTeams;
    },
    followed(): Followed {
      return { driverIds: this.followedDrivers.map((d) => d.id), teamIds: this.teams.map((t) => t.id) };
    },
    allSessions(): Session[] {
      return this.schedule?.sessions ?? [];
    },
    eventSessions(): Session[] {
      return this.allSessions.filter((s) => s.eventId === this.event.id).sort((a, b) => a.startUtc.localeCompare(b.startUtc));
    },
    racesHere(): Session[] {
      return raceSessions(this.allSessions, this.event.id);
    },
    round(): RoundInfo | null {
      return roundInfo(this.schedule?.events ?? [], this.event);
    },
    remaining(): string {
      return this.round ? remainingText(this.round.after.length) : '';
    },
    racesAfterText(): string {
      if (!this.round || !this.round.after.length) return '';
      const n = racesAfter(this.allSessions, this.round.after);
      // Solo si alguna fecha tiene más de una carrera (si no, "fechas" ya lo dice).
      if (n === null || n === this.round.after.length) return '';
      return `(${n} carreras)`;
    },
    previous(): MotorEvent | undefined {
      return this.round?.previous;
    },

    // ── Campeonato ──
    standingsAvailable(): boolean {
      const st = this.status?.series.find((s) => s.seriesId === this.series.id);
      return st ? st.standingsAvailable : true;
    },
    standings(): StandingsFile | undefined {
      return this.standingsMap[this.series.id]?.data;
    },
    timing(): StandingsTiming {
      return this.standings ? standingsTiming(this.standings.updatedAt, this.event, this.eventSessions) : 'before';
    },
    /** Rally o rally raid: cambian algunos textos ("el rally" en lugar de "la carrera" o "el fin de semana"). */
    rally(): boolean {
      return isRallyEvent(this.event, this.eventSessions, this.series.group);
    },
    timingLabel(): string {
      return timingLabel(this.timing, this.rally);
    },
    driverTablesList(): StandingsTable[] {
      return this.standings ? driverTables(this.standings) : [];
    },
    mainTable(): ChampionshipTable | null {
      const t = this.driverTablesList[0];
      return t ? gapTable(t, 5, this.followed) : null;
    },
    /** Las demás tablas de pilotos (clases, copas), compactas. */
    otherTables(): ChampionshipTable[] {
      return this.driverTablesList.slice(1, 6).map((t) => gapTable(t, 3, this.followed));
    },
    math(): TitleMath | null {
      const t = this.driverTablesList[0];
      if (!t || !this.standings || !this.round || this.timing === 'unknown') return null;
      return titleMath(this.series.id, t, this.event, this.round.after, this.allSessions, this.standings.updatedAt);
    },

    // ── Formato ──
    counts(): string {
      return eventFormatText(this.event, this.eventSessions, this.series.group);
    },
    zoneText(): string {
      return zoneLabel(this.timeZone);
    },
    raceRows(): RaceRow[] {
      return this.racesHere.map((s) => {
        const start = DateTime.fromISO(s.startUtc, { zone: 'utc' });
        const user = start.setZone(this.timeZone).setLocale('es-AR');
        const min = durationMinutes(s);
        return {
          id: s.id,
          name: s.name,
          day: user.toFormat('ccc d/L'),
          time: user.toFormat('HH:mm'),
          arTime: this.timeZone === AR_TZ ? '' : start.setZone(AR_TZ).toFormat('HH:mm'),
          local: s.localStartText ?? start.setZone(this.event.tz).toFormat('HH:mm'),
          duration: min > 0 ? `${durationText(min)}${s.endEstimated ? ' (duración estimada)' : ''}` : '',
        };
      });
    },
    rosterFile(): RosterFile | undefined {
      return this.rostersMap[this.series.id]?.data;
    },
    roster(): RosterSummary | null {
      const rows = this.rosterFile?.rows ?? [];
      return rows.length ? rosterSummary(rows) : null;
    },

    // ── Resultados ──
    resultsHere(): EventResultsFile | undefined {
      return this.resultsMap[`${this.series.id}/${this.event.id}`]?.data;
    },
    doneHere(): SessionHighlight[] {
      return highlights(this.resultsHere, this.eventSessions);
    },
    previousSessions(): Session[] {
      const id = this.previous?.id;
      return id ? this.allSessions.filter((s) => s.eventId === id) : [];
    },
    previousResults(): EventResultsFile | undefined {
      return this.previous ? this.resultsMap[`${this.series.id}/${this.previous.id}`]?.data : undefined;
    },
    winnersBefore(): SessionHighlight[] {
      return highlights(this.previousResults, this.previousSessions, true);
    },
    /** Carreras distintas de la fecha anterior con ganador (con clases hay un ganador por clase). */
    racesBefore(): number {
      return new Set(this.winnersBefore.map((w) => w.sessionId)).size;
    },
    watch(): WatchItem[] {
      const names = new Map<string, string>([
        ...this.followedDrivers.map((d) => [d.id, d.name] as [string, string]),
        ...this.teams.map((t) => [t.id, t.name] as [string, string]),
      ]);
      return whoToWatch({
        followed: this.followed,
        followedNames: names,
        tables: this.driverTablesList,
        teamTables: (this.standings?.tables ?? []).filter((t) => !isDriverTable(t.title)),
        roster: this.rosterFile?.rows ?? [],
        winnersHere: this.doneHere.filter((h) => h.label === 'Ganador'),
        winnersBefore: this.winnersBefore,
        ...(this.previous ? { previousName: this.previous.name } : {}),
        rally: this.rally,
      });
    },

    // ── Notas ──
    news(): NewsItem[] {
      const drivers = this.followedDrivers.filter((d) => d.seriesIds.includes(this.series.id)).map((d) => d.name);
      const teams = this.teamsOverride ?? this.followedTeams.filter((t) => t.seriesIds.includes(this.series.id));
      return pickNews(this.newsItems, this.series.id, newsReference(this.event, this.now), {
        eventWords: eventNeedles(this.event),
        followedWords: [...surnameNeedles(drivers), ...teams.flatMap((t) => teamNeedles(t.name))],
      });
    },

    sources(): Array<{ label: string; source: Source }> {
      const out: Array<{ label: string; source: Source }> = [{ label: 'Calendario', source: this.event.source }];
      const timetable = this.eventSessions[0]?.source;
      if (timetable && timetable.url !== this.event.source.url) out.push({ label: 'Cronograma', source: timetable });
      if (this.standings) out.push({ label: 'Campeonato', source: this.standings.source });
      if (this.rosterFile && this.roster) out.push({ label: 'Inscriptos', source: this.rosterFile.source });
      const res = this.resultsHere?.sessions[0]?.source;
      if (res && this.doneHere.length) out.push({ label: 'Resultados', source: res });
      const prev = this.previousResults?.sessions[0]?.source;
      if (prev && this.winnersBefore.length && prev.url !== res?.url) out.push({ label: 'Resultados de la fecha anterior', source: prev });
      return out;
    },
    loadingSomething(): boolean {
      const st = this.standingsMap[this.series.id]?.status;
      return st === 'loading' || this.rostersMap[this.series.id]?.status === 'loading';
    },
  },
  watch: {
    'event.id': { immediate: true, handler() { void this.loadAll(); } },
    /** La fecha anterior se conoce recién con el calendario cargado. */
    'previous.id'() {
      void this.loadPrevious();
    },
  },
  methods: {
    /** "Carrera 1 · LMP2: ", "LMP2: ", "Carrera 1: " o nada. */
    winnerPrefix(w: SessionHighlight): string {
      const parts = [this.racesBefore > 1 ? w.sessionName : '', w.class ?? ''].filter(Boolean);
      return parts.length ? `${parts.join(' · ')}: ` : '';
    },
    ...mapActions(useResultsStore, ['loadStandings', 'loadResults']),
    ...mapActions(useRostersStore, ['loadRoster']),
    ...mapActions(useNewsStore, { loadNews: 'load' }),
    ...mapActions(useCircuitInfoStore, { loadCircuitInfo: 'load' }),
    async loadAll() {
      // Las fichas de circuito son opcionales: si el archivo no existe, el bloque "El circuito" no aparece.
      const jobs: Array<Promise<unknown>> = [this.loadNews(), this.loadCircuitInfo()];
      if (this.standingsAvailable) jobs.push(this.loadStandings(this.series.id));
      if (this.series.rosterUrls?.length) jobs.push(this.loadRoster(this.series.id));
      if (this.eventSessions.some((s) => s.hasResults)) jobs.push(this.loadResults(this.series.id, this.event.id));
      jobs.push(this.loadPrevious());
      await Promise.all(jobs);
    },
    async loadPrevious() {
      const prev = this.previous;
      if (!prev) return;
      if (this.allSessions.some((s) => s.eventId === prev.id && s.hasResults && isRace(s))) await this.loadResults(this.series.id, prev.id);
    },
    dateRange: formatDateRange,
    ago(iso: string): string {
      return timeAgo(iso, this.now);
    },
    num(n: number): string {
      return n.toLocaleString('es-AR');
    },
    margin: marginText,
  },
});
</script>

<style>
.context-panel .ctx-head {
  margin-top: 0;
}

.ctx-event {
  margin: 0.5rem 0 0.15rem;
  font-size: 1.05rem;
  font-weight: 800;
}

.ctx-round {
  margin: 0;
  font-weight: 700;
  color: var(--accent);
}

.ctx-where {
  margin: 0.2rem 0 0;
}

.ctx-pad {
  padding: 0 0.85rem 0.6rem;
}

.ctx-pad p {
  margin: 0 0 0.25rem;
}

.ctx-strong {
  font-weight: 700;
}

.ctx-subtitle {
  margin: 0.35rem 0 0;
  padding: 0 0.85rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.72rem;
}

.ctx-gaps .list-row {
  min-height: 48px;
}

.ctx-gaps.compact .list-row {
  min-height: 40px;
  padding-top: 0.3rem;
  padding-bottom: 0.3rem;
}

.ctx-gaps li.followed {
  background: color-mix(in srgb, var(--accent) 10%, transparent);
}

.ctx-gaps .pos-badge {
  min-width: 2.1rem;
  font-size: 0.85rem;
}

.ctx-points {
  text-align: right;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.ctx-star {
  margin-left: 0.25rem;
  vertical-align: -1px;
}

.ctx-math {
  margin: 0.25rem 0.85rem 0.5rem;
  padding: 0.6rem 0.75rem;
  border-radius: 10px;
  background: var(--bg-elev-2);
  font-size: 0.92rem;
}

.ctx-math p {
  margin: 0 0 0.35rem;
}

.ctx-math p:last-child {
  margin-bottom: 0;
}

a.ctx-more {
  display: inline-flex;
  align-items: center;
  min-height: 44px;
  margin: 0 0.85rem 0.25rem;
  font-weight: 700;
}

.ctx-roster a.ctx-more {
  margin-left: 0;
  margin-bottom: 0.1rem;
}

.ctx-time {
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.ctx-classes {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin: 0.4rem 0 0.2rem;
}

.ctx-classes .pill-small {
  margin: 0;
}

/* Miniatura del trazado (o del plano) a la izquierda; sin dibujo, queda solo el texto. */
.ctx-circuit-row {
  align-items: center;
  padding-bottom: 0.7rem;
}

.ctx-circuit-fig {
  flex: none;
  width: 104px;
  height: 78px;
}

.ctx-circuit-fig.is-none {
  display: none;
}

.ctx-circuit-go {
  margin-top: 0.15rem;
  color: var(--link);
  font-weight: 700;
}

.ctx-circuit-credit {
  margin: 0;
  padding-top: 0;
  overflow-wrap: anywhere;
}

.ctx-news-title {
  margin: 0 0 0.25rem;
  font-size: 0.95rem;
  font-weight: 800;
}

.ctx-sources .ctx-source + .ctx-source {
  margin-top: 0.4rem;
}

.ctx-sources .source-link {
  margin-top: 0;
}

.context-panel .block {
  display: block;
}
</style>
