<template>
  <div v-if="series.enabled" class="calendar-subscribe" :class="{ compact }">
    <button
      v-if="compact"
      type="button"
      class="btn btn-small"
      :aria-label="`Suscribirme al calendario de ${series.name}`"
      data-test="calendar-subscribe"
      @click="show"
    >
      <AppIcon name="calendar" :size="16" /> Suscribirme
    </button>
    <button v-else type="button" class="calendar-subscribe-row" data-test="calendar-subscribe" @click="show">
      <span class="calendar-subscribe-icon"><AppIcon name="calendar" :size="20" /></span>
      <span class="grow">
        <strong>Suscribirme al calendario de esta categoría</strong>
        <span class="calendar-subscribe-sub small dim">En Google Calendar, iPhone u Outlook. Se actualiza solo.</span>
      </span>
      <AppIcon name="chevron" :size="16" class="dim" />
    </button>

    <BottomSheet :open="open" :title="`Calendario de ${series.shortName || series.name}`" :inline="inline" @close="open = false">
      <div class="calendar-subscribe-sheet stack">
        <p>
          Las fechas y horarios de <strong>{{ series.name }}</strong> en tu calendario. Se actualiza solo cuando cambia
          un horario (próximos 60 días).
        </p>
        <p v-if="missing" class="notice notice-warn" data-test="feed-missing">
          Este calendario todavía no está publicado: va a estar disponible con la próxima actualización de datos.
        </p>

        <div>
          <div class="section-title">iPhone, Mac u Outlook</div>
          <a :href="webcal" class="btn btn-primary btn-block" data-test="webcal-link">
            <AppIcon name="calendar" :size="18" /> Suscribirme
          </a>
          <p class="small dim">Se abre tu app de calendario: confirmá «Suscribirse».</p>
        </div>

        <div>
          <div class="section-title">Google Calendar</div>
          <code class="feed-url" data-test="feed-url">{{ httpsUrl }}</code>
          <button type="button" class="btn btn-block" data-test="copy-link" @click="copy">
            <AppIcon :name="copied ? 'check' : 'copy'" :size="18" /> {{ copied ? 'Enlace copiado' : 'Copiar enlace' }}
          </button>
          <p v-if="copyFailed" class="small warn-text" role="status">
            No se pudo copiar: mantené apretado el enlace de arriba y elegí «Copiar».
          </p>
          <ol class="small calendar-steps">
            <li>Abrí calendar.google.com en una computadora (desde la app del celular no se puede).</li>
            <li>Al lado de <strong>Otros calendarios</strong> tocá <strong>+</strong> → <strong>Desde URL</strong>.</li>
            <li>Pegá el enlace y tocá <strong>Agregar calendario</strong>.</li>
          </ol>
          <p class="small dim">Google actualiza los calendarios suscriptos cada varias horas, no al instante.</p>
        </div>
      </div>
    </BottomSheet>
  </div>
</template>

<script lang="ts">
import { defineComponent, type PropType } from 'vue';
import type { Series } from '@dm/shared';
import AppIcon from './AppIcon.vue';
import BottomSheet from './BottomSheet.vue';
import { absoluteDataUrl, dataFileExists, seriesFeedPath, webcalUrl } from '../lib/data.ts';
import { copyText } from '../lib/download.ts';

/**
 * Suscripción al calendario de una categoría (data/feeds/{seriesId}.ics): el acceso y la hoja con el enlace
 * webcal (iPhone, Mac, Outlook) y la URL https para pegar en Google Calendar.
 * Las categorías deshabilitadas no tienen calendario publicado: no muestra nada.
 */
export default defineComponent({
  name: 'CalendarSubscribe',
  components: { AppIcon, BottomSheet },
  props: {
    series: { type: Object as PropType<Series>, required: true },
    /** Botón chico "Suscribirme" (listas) en lugar del acceso a todo el ancho. */
    compact: { type: Boolean, default: false },
    /** Renderiza la hoja en el lugar (sin Teleport); útil en pruebas. */
    inline: { type: Boolean, default: false },
  },
  data() {
    return {
      open: false,
      copied: false,
      copyFailed: false,
      /** El .ics de la categoría todavía no existe en data/ (categoría recién agregada). */
      missing: false,
      copiedTimer: 0,
    };
  },
  computed: {
    feedPath(): string {
      return seriesFeedPath(this.series.id);
    },
    webcal(): string {
      return webcalUrl(this.feedPath);
    },
    httpsUrl(): string {
      return absoluteDataUrl(this.feedPath);
    },
  },
  beforeUnmount() {
    window.clearTimeout(this.copiedTimer);
  },
  methods: {
    async show() {
      this.open = true;
      this.copied = false;
      this.copyFailed = false;
      this.missing = (await dataFileExists(this.feedPath)) === false;
    },
    async copy() {
      // copyText prueba el portapapeles y después execCommand; si el navegador no tiene ninguno de los dos, falla.
      const ok = await copyText(this.httpsUrl).catch(() => false);
      this.copied = ok;
      this.copyFailed = !ok;
      window.clearTimeout(this.copiedTimer);
      if (ok) this.copiedTimer = window.setTimeout(() => (this.copied = false), 2500);
    },
  },
});
</script>

<style>
.calendar-subscribe:not(.compact) {
  margin: 0 0 0.75rem;
}

.calendar-subscribe.compact {
  flex: none;
}

/* Zona táctil de 44 px aunque el botón sea "chico". */
.calendar-subscribe.compact .btn {
  min-height: var(--tap);
}

.calendar-subscribe-row {
  display: flex;
  align-items: center;
  gap: 0.7rem;
  width: 100%;
  min-height: 54px;
  padding: 0.6rem 0.6rem 0.6rem 0.85rem;
  border: none;
  border-radius: var(--radius);
  background: var(--bg-elev);
  color: var(--text);
  text-align: left;
}

.calendar-subscribe-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 10px;
  background: var(--bg-elev-2);
  color: var(--accent);
}

.calendar-subscribe-sub {
  display: block;
}

.calendar-subscribe-sheet .section-title {
  margin-top: 0.5rem;
}

.calendar-subscribe-sheet .feed-url {
  display: block;
  margin-bottom: 0.5rem;
  padding: 0.6rem 0.7rem;
  border-radius: 10px;
  user-select: all;
  -webkit-user-select: all;
}

.calendar-steps {
  margin: 0.6rem 0 0.4rem;
  padding-left: 1.3rem;
}

.calendar-steps li + li {
  margin-top: 0.25rem;
}
</style>
