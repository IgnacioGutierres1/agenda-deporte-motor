<template>
  <BottomSheet :open="!!item" :title="title" :inline="inline" @close="$emit('close')">
    <div v-if="item" class="session-sheet stack">
      <div class="row wrap">
        <span class="chip" :style="{ background: color }" />
        <strong>{{ item.series.name }}</strong>
        <span v-if="item.live" class="badge badge-live">En vivo</span>
        <span v-if="item.series.origin === 'discovered'" class="badge badge-info">Descubierta</span>
      </div>
      <div v-if="item.event" class="dim">
        {{ item.event.name }} · {{ item.event.circuit }}, {{ item.event.country }}
      </div>

      <div class="card">
        <div class="big-time">
          {{ dayText }} · {{ startText }}–{{ endText }} <span class="dim small">{{ zone }}</span>
        </div>
        <div v-if="item.session.endEstimated" class="small dim">
          La hora de fin es aproximada: la fuente solo publica el inicio.
        </div>
        <div class="conversion" data-test="conversion">
          {{ localText }} en {{ circuitName }} → {{ startText }} {{ zone }}
        </div>
        <div v-if="changedText" class="changed-note small">{{ changedText }}</div>
      </div>

      <SessionWeather :item="item" :now="now" />

      <div>
        <div class="section-title">Transmisión</div>
        <BroadcastLinks :names="item.session.broadcast" :series-name="item.series.name" />
        <div v-if="item.session.broadcastIsDefault" class="small dim">
          Canal habitual de la categoría en Argentina: el cronograma oficial no lo informa.
        </div>
      </div>

      <div>
        <div class="section-title">Fuente del horario</div>
        <div class="card source-card">
          <a :href="item.session.source.url" target="_blank" rel="noopener noreferrer" class="source-title" data-test="source-link">
            {{ item.session.source.title || host }}
            <AppIcon name="external" :size="16" />
          </a>
          <div class="small dim source-url">{{ item.session.source.url }}</div>
          <dl class="source-meta small">
            <dt>Método</dt>
            <dd>{{ methodLabel }}</dd>
            <dt>Tipo</dt>
            <dd>{{ kindLabel }}</dd>
            <dt>Leído</dt>
            <dd>{{ fetchedText }}</dd>
          </dl>
          <p v-if="item.session.source.kind === 'image'" class="small dim">
            Horario leído de una imagen oficial: la IA primero transcribió el texto de la imagen y la hora tiene que
            figurar en esa transcripción. Conviene comprobarlo abriendo la imagen con el link de arriba.
          </p>
          <p v-else-if="item.session.source.method === 'ia'" class="small dim">
            La IA solo transcribe el documento oficial descargado; la hora local tiene que figurar textual en ese
            documento o la sesión se descarta.
          </p>
        </div>
        <div v-if="eventSourceDifferent && item.event" class="small">
          Calendario del evento:
          <a :href="item.event.source.url" target="_blank" rel="noopener noreferrer">{{ item.event.source.title }}</a>
        </div>
        <div v-if="officialUrl" class="small">
          Sitio oficial: <a :href="officialUrl" target="_blank" rel="noopener noreferrer">{{ officialHost }}</a>
        </div>
      </div>

      <RouterLink v-if="item.finished && item.session.hasResults" :to="resultsLink" class="btn btn-primary btn-block">
        Ver resultado
      </RouterLink>
      <RouterLink :to="`/evento/${item.session.eventId}?tab=contexto`" class="btn btn-block">Ponerme en contexto</RouterLink>
      <RouterLink :to="`/evento/${item.session.eventId}`" class="btn btn-block">Ver evento completo</RouterLink>
    </div>
  </BottomSheet>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import { DateTime } from 'luxon';
import { formatTime } from '@dm/shared';
import BottomSheet from './BottomSheet.vue';
import BroadcastLinks from './BroadcastLinks.vue';
import AppIcon from './AppIcon.vue';
import SessionWeather from './SessionWeather.vue';
import { seriesColor, type GridItem } from '../lib/grid.ts';
import { KIND_LABELS, METHOD_LABELS, hostOf } from '../lib/sources.ts';
import { formatDateTime, timeAgo, zoneLabel } from '../lib/format.ts';

export default defineComponent({
  name: 'SessionSheet',
  components: { BottomSheet, BroadcastLinks, AppIcon, SessionWeather },
  props: {
    item: { type: Object as PropType<GridItem | null>, default: null },
    timeZone: { type: String, required: true },
    now: { type: String, required: true },
    inline: { type: Boolean, default: false },
  },
  emits: ['close'],
  computed: {
    title(): string {
      return this.item ? this.item.session.name : '';
    },
    color(): string {
      return seriesColor(this.item?.series);
    },
    zone(): string {
      return zoneLabel(this.timeZone);
    },
    dayText(): string {
      if (!this.item) return '';
      const text = DateTime.fromISO(this.item.session.startUtc, { zone: 'utc' })
        .setZone(this.timeZone)
        .setLocale('es-AR')
        .toFormat("cccc d 'de' LLLL");
      return text.charAt(0).toUpperCase() + text.slice(1);
    },
    startText(): string {
      return this.item ? formatTime(this.item.session.startUtc, this.timeZone) : '';
    },
    endText(): string {
      return this.item ? formatTime(this.item.session.endUtc, this.timeZone) : '';
    },
    circuitName(): string {
      return this.item?.event?.circuit || 'el circuito';
    },
    /** Hora local del circuito: la textual de la fuente o, si no está, la convertida con la zona del circuito. */
    localText(): string {
      if (!this.item) return '';
      const s = this.item.session;
      if (s.localStartText) return s.localStartText;
      return this.item.event ? formatTime(s.startUtc, this.item.event.tz) : formatTime(s.startUtc, 'UTC');
    },
    changedText(): string | null {
      const s = this.item?.session;
      if (!s?.changedAt) return null;
      const prev = s.previousStartUtc ? ` Antes: ${formatDateTime(s.previousStartUtc, this.timeZone)}.` : '';
      return `Horario modificado ${timeAgo(s.changedAt, this.now)}.${prev}`;
    },
    host(): string {
      return this.item ? hostOf(this.item.session.source.url) : '';
    },
    methodLabel(): string {
      return this.item ? METHOD_LABELS[this.item.session.source.method] : '';
    },
    kindLabel(): string {
      return this.item ? KIND_LABELS[this.item.session.source.kind] : '';
    },
    fetchedText(): string {
      if (!this.item) return '';
      const at = this.item.session.source.fetchedAt;
      return `${formatDateTime(at, this.timeZone)} (${timeAgo(at, this.now)})`;
    },
    eventSourceDifferent(): boolean {
      return !!this.item?.event && this.item.event.source.url !== this.item.session.source.url;
    },
    officialUrl(): string | undefined {
      return this.item?.series.officialUrls[0];
    },
    officialHost(): string {
      return this.officialUrl ? hostOf(this.officialUrl) : '';
    },
    resultsLink() {
      if (!this.item) return '/';
      return {
        name: 'evento',
        params: { eventId: this.item.session.eventId },
        query: { tab: 'resultados', session: this.item.session.id },
      };
    },
  },
});
</script>

<style>
.big-time {
  font-size: 1.1rem;
  font-weight: 700;
}

.conversion {
  margin-top: 0.4rem;
  font-variant-numeric: tabular-nums;
}

.changed-note {
  margin-top: 0.4rem;
  padding: 0.35rem 0.5rem;
  border-radius: 8px;
  background: var(--changed-bg);
}

.source-title {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-weight: 700;
  min-height: 32px;
}

.source-url {
  overflow-wrap: anywhere;
}

.source-meta {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.2rem 0.75rem;
  margin: 0.5rem 0 0;
}

.source-meta dt {
  color: var(--text-dim);
}

.source-meta dd {
  margin: 0;
}
</style>
