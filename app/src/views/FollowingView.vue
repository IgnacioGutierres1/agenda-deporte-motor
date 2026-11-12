<template>
  <div class="following-view">
    <nav v-tab-strip class="underline-tabs page-tabs" role="tablist" aria-label="Siguiendo">
      <button
        v-for="t in tabs"
        :key="t.id"
        type="button"
        role="tab"
        class="underline-tab"
        :class="{ active: tab === t.id }"
        :aria-selected="tab === t.id"
        @click="tab = t.id"
      >
        {{ t.label }}
      </button>
      <span class="grow" />
      <RouterLink to="/categorias" class="icon-btn" aria-label="Agregar categorías" title="Agregar categorías">
        <AppIcon name="plus" />
      </RouterLink>
    </nav>

    <div class="page">
      <DataState />

      <template v-if="tab === 'categorias' && hasData">
        <div v-if="!cards.length" class="card empty center">
          <p>Todavía no seguís ninguna categoría.</p>
          <RouterLink to="/categorias" class="btn btn-primary">Elegir categorías</RouterLink>
        </div>
        <div v-else class="follow-grid">
          <RouterLink
            v-for="c in cards"
            :key="c.series.id"
            :to="`/categoria/${c.series.id}`"
            class="follow-card"
            :style="{ '--card-color': c.color }"
          >
            <SeriesCrest :series="c.series" :size="34" />
            <span class="follow-card-name">{{ c.series.shortName || c.series.name }}</span>
            <span class="follow-card-next">
              <template v-if="c.next">
                <span class="follow-card-event">{{ c.next.event.name }}</span>
                <span :class="{ 'live-chip': c.next.live }">{{ c.when }}</span>
              </template>
              <template v-else>Sin fechas próximas</template>
            </span>
          </RouterLink>
          <RouterLink to="/categorias" class="follow-card add-card">
            <AppIcon name="plus" :size="30" />
            <span>Agregar</span>
          </RouterLink>
        </div>
        <StarterPack :kinds="['series']" />
        <RecommendationsCard title="Para vos" />
      </template>

      <template v-else-if="tab === 'pilotos'">
        <label class="search-box">
          <AppIcon name="search" :size="18" />
          <input v-model="driverQuery" type="search" class="search-input" placeholder="Buscar pilotos" aria-label="Buscar pilotos" />
        </label>

        <div v-if="driversStatus === 'error'" class="notice notice-error">
          No se pudieron cargar los pilotos ({{ driversError }}).
          <button type="button" class="btn btn-small" @click="loadDrivers(true)">Reintentar</button>
        </div>

        <template v-if="driverQuery.trim().length >= 2">
          <p v-if="driversStatus === 'loading'" class="dim">Cargando pilotos…</p>
          <ul v-else-if="driverMatches.length" class="list-card">
            <li v-for="d in driverMatches" :key="d.id" class="series-row">
              <RouterLink :to="`/piloto/${d.id}`" class="list-row grow">
                <DriverAvatar :name="d.name" :color="driverColor(d)" :size="34" />
                <span class="grow">
                  {{ d.name }}
                  <span class="block small dim">{{ entrySummary(d) }}</span>
                </span>
              </RouterLink>
              <FollowButton :driver="refOf(d)" :name="d.name" compact />
            </li>
          </ul>
          <p v-else class="card empty dim">No hay pilotos que coincidan con "{{ driverQuery }}".</p>
        </template>

        <template v-else>
          <div v-if="!followedDrivers.length" class="card empty center">
            <p>Todavía no seguís ningún piloto.</p>
            <p class="small dim">Buscalo arriba o tocá su nombre en una tabla de campeonato o de resultados.</p>
          </div>
          <StarterPack v-if="!followedDrivers.length" :kinds="['driver']" title="Pilotos para empezar" />
          <div v-else class="follow-grid">
            <RouterLink
              v-for="c in driverCards"
              :key="c.id"
              :to="`/piloto/${c.id}`"
              class="follow-card"
              :style="{ '--card-color': c.color }"
            >
              <DriverAvatar :name="c.name" color="rgba(255,255,255,0.18)" :size="38" />
              <span class="follow-card-name">{{ c.name }}</span>
              <span class="follow-card-next">
                <span v-if="c.standing" class="follow-card-standing">{{ c.standing }}</span>
                <span>{{ c.next }}</span>
              </span>
            </RouterLink>
          </div>
        </template>
      </template>

      <template v-else-if="tab === 'equipos'">
        <label class="search-box">
          <AppIcon name="search" :size="18" />
          <input v-model="teamQuery" type="search" class="search-input" placeholder="Buscar equipos" aria-label="Buscar equipos" />
        </label>

        <div v-if="teamsStatus === 'error' && driversStatus === 'error'" class="notice notice-error">
          No se pudieron cargar los equipos ({{ teamsError }}).
          <button type="button" class="btn btn-small" @click="loadTeams(true)">Reintentar</button>
        </div>

        <template v-if="teamQuery.trim().length >= 2">
          <p v-if="teamsPending" class="dim">Cargando equipos…</p>
          <ul v-else-if="teamMatches.length" class="list-card">
            <li v-for="t in teamMatches" :key="t.id" class="series-row">
              <RouterLink :to="`/equipo/${t.id}`" class="list-row grow">
                <DriverAvatar :name="t.name" :color="teamColor(t)" :size="34" />
                <span class="grow">
                  {{ t.name }}
                  <span class="block small dim">{{ teamSummary(t) }}</span>
                </span>
              </RouterLink>
              <FollowButton :team="teamRefOf(t)" :name="t.name" compact />
            </li>
          </ul>
          <p v-else class="card empty dim">No hay equipos que coincidan con "{{ teamQuery }}".</p>
        </template>

        <template v-else>
          <div v-if="!followedTeams.length" class="card empty center">
            <p>Todavía no seguís ningún equipo.</p>
            <p class="small dim">Buscalo arriba o tocá ★ Seguir en la ficha del equipo.</p>
          </div>
          <div v-else class="follow-grid">
            <RouterLink
              v-for="c in teamCards"
              :key="c.id"
              :to="`/equipo/${c.id}`"
              class="follow-card"
              :style="{ '--card-color': c.color }"
            >
              <DriverAvatar :name="c.name" color="rgba(255,255,255,0.18)" :size="38" />
              <span class="follow-card-name">{{ c.name }}</span>
              <span class="follow-card-next">
                <span v-if="c.standing" class="follow-card-standing">{{ c.standing }}</span>
                <span v-if="c.numbers" class="follow-card-numbers">{{ c.numbers }}</span>
                <span>{{ c.next }}</span>
              </span>
            </RouterLink>
          </div>
        </template>
      </template>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState } from 'pinia';
import { DateTime } from 'luxon';
import type { Driver, Series, Team } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import DriverAvatar from '../components/DriverAvatar.vue';
import FollowButton from '../components/FollowButton.vue';
import DataState from '../components/DataState.vue';
import SeriesCrest from '../components/SeriesCrest.vue';
import RecommendationsCard from '../components/RecommendationsCard.vue';
import StarterPack from '../components/StarterPack.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore, type FollowedDriver, type FollowedTeam } from '../stores/settings.ts';
import { useDriversStore } from '../stores/drivers.ts';
import { useTeamsStore } from '../stores/teams.ts';
import { seriesColor } from '../lib/grid.ts';
import { driverSeriesIds, isGenericTeamTable, teamMainEntry, teamNumbers, teamSeriesIds } from '../lib/teams.ts';
import { nextEventOf, type NextEvent } from '../lib/agenda.ts';
import { tabStrip } from '../lib/tabStrip.ts';

type Tab = 'categorias' | 'pilotos' | 'equipos';

/** Tarjeta de un piloto o equipo seguido. */
interface PersonCard {
  id: string;
  name: string;
  color: string;
  standing: string;
  numbers?: string;
  next: string;
}

interface FollowCard {
  series: Series;
  color: string;
  next: NextEvent | null;
  when: string;
}

/** Lo que sigue el usuario (como "Siguiendo" en FotMob): tarjetas con la próxima fecha. */
export default defineComponent({
  name: 'FollowingView',
  components: { AppIcon, DataState, DriverAvatar, FollowButton, RecommendationsCard, SeriesCrest, StarterPack },
  directives: { tabStrip },
  data() {
    return {
      tab: (['pilotos', 'equipos'].includes(String(this.$route.query.tab)) ? this.$route.query.tab : 'categorias') as Tab,
      driverQuery: '',
      teamQuery: '',
      tabs: [
        { id: 'categorias' as Tab, label: 'Categorías' },
        { id: 'pilotos' as Tab, label: 'Pilotos' },
        { id: 'equipos' as Tab, label: 'Equipos' },
      ],
    };
  },
  computed: {
    ...mapState(useScheduleStore, ['schedule', 'hasData', 'now', 'seriesById']),
    ...mapState(useSettingsStore, ['followedSeries', 'followedDrivers', 'followedTeams', 'timeZone']),
    ...mapState(useDriversStore, { driversStatus: 'status', driversError: 'error', driversById: 'byId' }),
    ...mapState(useTeamsStore, { teamsStatus: 'status', teamsError: 'error', teamsById: 'byId', teamsPending: 'pending' }),
    driverMatches(): Driver[] {
      return useDriversStore().search(this.driverQuery);
    },
    teamMatches(): Team[] {
      return useTeamsStore().search(this.teamQuery, 30);
    },
    driverCards(): PersonCard[] {
      return this.followedDrivers.map((f) => {
        const d = this.driversById.get(f.id);
        const main = d?.entries[0];
        const lineup = d?.lineups?.[0];
        const series = this.seriesById.get(main?.seriesId ?? lineup?.seriesId ?? f.seriesIds[0] ?? '');
        let standing = '';
        if (main) standing = `P${main.pos} · ${series?.shortName ?? main.seriesId}${main.table ? ' ' + main.table : ''} · ${main.points.toLocaleString('es-AR')} pts`;
        else if (lineup) standing = `${series?.shortName ?? lineup.seriesId}${lineup.number ? ' #' + lineup.number : ''}${lineup.team ? ' · ' + lineup.team : ''}`;
        return { id: f.id, name: d?.name ?? f.name, color: seriesColor(series), standing, next: this.nextText(f.seriesIds) };
      });
    },
    teamCards(): PersonCard[] {
      return this.followedTeams.map((f) => {
        const t = this.teamsById.get(f.id);
        const main = t ? teamMainEntry(t) : undefined;
        const seriesId = main?.seriesId ?? f.seriesIds[0] ?? '';
        const series = this.seriesById.get(seriesId);
        const short = series?.shortName ?? seriesId;
        let standing = '';
        if (main?.pos !== undefined) {
          const table = isGenericTeamTable(main.table) ? '' : ` ${main.table}`;
          standing = `P${main.pos} · ${short}${table}${main.points !== undefined ? ` · ${main.points.toLocaleString('es-AR')} pts` : ''}`;
        } else if (seriesId) {
          standing = short;
        }
        const numbers = t && seriesId ? teamNumbers(t, seriesId).map((n) => `#${n}`).join(' ') : '';
        return { id: f.id, name: t?.name ?? f.name, color: seriesColor(series), standing, numbers, next: this.nextText(f.seriesIds) };
      });
    },
    cards(): FollowCard[] {
      const out: FollowCard[] = [];
      for (const id of this.followedSeries) {
        const series = this.seriesById.get(id);
        if (!series) continue;
        const next = nextEventOf(this.schedule, id, this.now);
        out.push({ series, color: seriesColor(series), next, when: this.whenText(next) });
      }
      return out;
    },
  },
  watch: {
    tab: {
      immediate: true,
      handler(tab: Tab) {
        if (tab === 'pilotos') void this.loadDrivers();
        if (tab === 'equipos') void this.loadTeams();
        void this.$router.replace({ query: tab === 'categorias' ? {} : { tab } });
      },
    },
  },
  methods: {
    ...mapActions(useDriversStore, { loadDrivers: 'load' }),
    ...mapActions(useTeamsStore, { loadTeams: 'load' }),
    refOf(d: Driver): FollowedDriver {
      return { id: d.id, name: d.name, seriesIds: driverSeriesIds(d) };
    },
    teamRefOf(t: Team): FollowedTeam {
      return { id: t.id, name: t.name, seriesIds: teamSeriesIds(t) };
    },
    teamColor(t: Team): string {
      return seriesColor(this.seriesById.get(teamSeriesIds(t)[0] ?? ''));
    },
    /** Una parte por categoría: posición en la primera tabla (la general) y números de auto. */
    teamSummary(t: Team): string {
      return teamSeriesIds(t)
        .map((id) => {
          const pos = t.entries.find((e) => e.seriesId === id && e.pos !== undefined)?.pos;
          const nums = teamNumbers(t, id);
          return `${this.seriesById.get(id)?.shortName ?? id}${pos ? ' P' + pos : ''}${nums.length ? ' ' + nums.map((n) => '#' + n).join(' ') : ''}`;
        })
        .join(' · ');
    },
    /** Próxima carrera entre todas las categorías de un piloto o equipo. */
    nextText(seriesIds: string[]): string {
      let next: NextEvent | null = null;
      for (const id of seriesIds) {
        const n = nextEventOf(this.schedule, id, this.now);
        if (n && (!next || n.event.dateStart < next.event.dateStart)) next = n;
      }
      return next ? `${next.event.name} · ${this.whenText(next)}` : 'Sin carreras próximas';
    },
    driverColor(d: Driver): string {
      return seriesColor(this.seriesById.get(driverSeriesIds(d)[0] ?? ''));
    },
    entrySummary(d: Driver): string {
      const short = (id: string) => this.seriesById.get(id)?.shortName ?? id;
      const inTable = new Set(d.entries.map((e) => e.seriesId));
      return [
        ...d.entries.map((e) => `${short(e.seriesId)}${e.table ? ' ' + e.table : ''} P${e.pos}`),
        ...(d.lineups ?? []).filter((l) => !inTable.has(l.seriesId)).map((l) => `${short(l.seriesId)}${l.number ? ' #' + l.number : ''}`),
      ].join(' · ');
    },
    whenText(next: NextEvent | null): string {
      if (!next) return '';
      if (next.live) return 'En vivo';
      if (next.nextSession) {
        return DateTime.fromISO(next.nextSession.startUtc, { zone: 'utc' })
          .setZone(this.timeZone)
          .setLocale('es-AR')
          .toFormat("ccc d LLL, HH:mm")
          .replace(/\./g, '');
      }
      return DateTime.fromISO(next.event.dateStart).setLocale('es-AR').toFormat('ccc d LLL').replace(/\./g, '') + ' · a confirmar';
    },
  },
});
</script>

<style>
.follow-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.6rem;
}

.follow-card {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  min-height: 150px;
  padding: 0.85rem;
  border-radius: var(--radius);
  background: color-mix(in srgb, var(--card-color) 78%, #000);
  color: #fff;
  text-decoration: none;
}

.follow-card:hover {
  text-decoration: none;
}

.follow-card .crest {
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.35);
}

.follow-card-name {
  font-weight: 900;
  font-size: 1.15rem;
  line-height: 1.15;
}

.follow-card-next {
  margin-top: auto;
  display: flex;
  flex-direction: column;
  font-size: 0.78rem;
  opacity: 0.92;
}

.follow-card-event {
  font-weight: 700;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Posición en el campeonato: puede ocupar dos líneas para no cortar los puntos. */
.follow-card-standing {
  font-weight: 700;
  overflow-wrap: anywhere;
}

.follow-card-numbers {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live-chip {
  color: #fff;
  font-weight: 800;
}

.add-card {
  align-items: center;
  justify-content: center;
  background: var(--bg-elev);
  color: var(--text-dim);
  border: 2px dashed var(--border);
}
</style>
