<template>
  <section class="card notifications-card">
    <h2>Avisos</h2>

    <p v-if="support === 'no-worker'" class="small dim">
      Los avisos todavía no están configurados en esta publicación de la app.
    </p>
    <p v-else-if="support === 'ios-install'" class="small">
      En iPhone los avisos funcionan solo con la app instalada: Safari → Compartir → <strong>Agregar a inicio</strong>,
      y activalos desde la app instalada (iOS 16.4 o posterior).
    </p>
    <p v-else-if="support === 'unsupported'" class="small dim">Este navegador no permite avisos.</p>
    <p v-else-if="support === 'denied'" class="small">
      Los avisos están bloqueados para esta app. Habilitalos en los permisos del navegador (ícono del candado o ajustes del sitio).
    </p>

    <template v-else>
      <label class="check">
        <input type="checkbox" aria-label="Avisarme antes de cada sesión de lo que sigo" :checked="notifyEnabled" :disabled="busy" @change="toggle(($event.target as HTMLInputElement).checked)" />
        Avisarme antes de cada sesión de lo que sigo
      </label>

      <label class="field">
        <span>Anticipación</span>
        <select v-model.number="notifyLead" class="input" :disabled="busy">
          <option v-for="m in leads" :key="m" :value="m">{{ leadLabel(m) }}</option>
        </select>
      </label>

      <p class="small dim">
        <template v-if="notifySeriesIds.length">
          Categorías: {{ seriesNames }}.
        </template>
        <template v-else>
          Todavía no seguís ninguna categoría, piloto ni equipo: tocá ★ en uno para recibir sus avisos.
        </template>
      </p>

      <div v-if="notifyEnabled" class="row wrap">
        <button type="button" class="btn btn-small" :disabled="busy" @click="test">Enviar aviso de prueba</button>
      </div>
    </template>

    <p v-if="message" class="small" :class="messageError ? 'error-text' : 'accent-text'" role="status">{{ message }}</p>
  </section>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapState, mapWritableState } from 'pinia';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { disablePush, enablePush, pushSupport, testPush, type PushSupport } from '../lib/push.ts';

/** Ajustes de avisos push (sesiones de las categorías, pilotos y equipos seguidos). */
export default defineComponent({
  name: 'NotificationsCard',
  data() {
    return {
      support: pushSupport() as PushSupport,
      busy: false,
      message: '',
      messageError: false,
      leads: [5, 15, 30, 60, 120],
    };
  },
  computed: {
    ...mapState(useSettingsStore, ['notifySeriesIds', 'timeZone']),
    ...mapWritableState(useSettingsStore, ['notifyEnabled', 'notifyLead']),
    ...mapState(useScheduleStore, ['seriesById']),
    seriesNames(): string {
      const names = this.notifySeriesIds.map((id) => this.seriesById.get(id)?.shortName ?? id);
      return names.length > 8 ? `${names.slice(0, 8).join(', ')} y ${names.length - 8} más` : names.join(', ');
    },
  },
  methods: {
    leadLabel(m: number): string {
      return m >= 60 ? (m === 60 ? '1 hora antes' : `${m / 60} horas antes`) : `${m} minutos antes`;
    },
    say(text: string, error = false) {
      this.message = text;
      this.messageError = error;
    },
    async toggle(on: boolean) {
      this.busy = true;
      this.say('');
      try {
        if (on) {
          await enablePush({ seriesIds: this.notifySeriesIds, leadMinutes: this.notifyLead, timeZone: this.timeZone });
          this.notifyEnabled = true;
          this.say('Avisos activados en este dispositivo.');
        } else {
          await disablePush();
          this.notifyEnabled = false;
          this.say('Avisos desactivados.');
        }
      } catch (e) {
        this.notifyEnabled = false;
        this.say((e as Error).message, true);
      } finally {
        this.support = pushSupport();
        this.busy = false;
      }
    },
    async test() {
      this.busy = true;
      try {
        await testPush();
        this.say('Aviso de prueba enviado: debería llegar en unos segundos.');
      } catch (e) {
        this.say((e as Error).message, true);
      } finally {
        this.busy = false;
      }
    },
  },
});
</script>

