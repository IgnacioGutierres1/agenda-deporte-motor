<template>
  <div class="page settings-view">
    <!-- Actualizar -->
    <section class="card">
      <h2>Datos</h2>
      <p class="small">
        Datos actualizados: <strong>{{ generatedAt ? ago(generatedAt) : 'sin datos' }}</strong>
        <span v-if="fetchedAt" class="dim"> · descargados en este dispositivo {{ ago(fetchedAt) }}</span>
      </p>
      <p class="small dim">Se actualizan solos una vez por día y cada 3 horas de jueves a lunes.</p>
      <div class="stack">
        <button type="button" class="btn btn-block" :disabled="loading" @click="refresh">
          <AppIcon name="refresh" :size="18" /> {{ loading ? 'Actualizando…' : 'Actualizar ahora' }}
        </button>
        <button v-if="canWriteRepo" type="button" class="btn btn-block" :disabled="busy" @click="forceUpdate">
          Forzar actualización
        </button>
        <p v-else class="small dim">
          "Forzar actualización" vuelve a leer todas las fuentes oficiales. Está disponible para el dueño del repo con su
          token de GitHub (más abajo).
        </p>
      </div>
      <p v-if="updateMsg" class="notice" :class="updateErr ? 'notice-error' : 'notice-ok'">{{ updateMsg }}</p>
    </section>

    <!-- Zona horaria -->
    <section class="card">
      <h2>Zona horaria</h2>
      <label class="field">
        <span>Mostrar los horarios en</span>
        <select v-model="timeZone" class="input">
          <option v-for="z in zoneOptions" :key="z.value" :value="z.value">{{ z.label }}</option>
        </select>
      </label>
      <p class="small dim">La carga en Google Calendar siempre usa la hora de Argentina.</p>
    </section>

    <!-- Categorías -->
    <section class="card">
      <h2>Categorías</h2>
      <p class="small dim">
        La casilla elige qué ves en este dispositivo.
        <template v-if="canWriteRepo">
          Los botones cambian la lista compartida del repo (para todos) y lanzan una actualización.
        </template>
        <template v-else>
          Para agregar, desactivar o fijar categorías de la lista compartida, cargá el token de GitHub (abajo).
        </template>
      </p>
      <p v-if="repoMsg" class="notice" :class="repoErr ? 'notice-error' : 'notice-ok'">{{ repoMsg }}</p>

      <div v-for="g in seriesGroups" :key="g.group" class="settings-group">
        <div class="section-title">{{ g.label }}</div>
        <div v-for="i in g.items" :key="i.series.id" class="settings-series">
          <label class="check grow">
            <input
              type="checkbox"
              :checked="!hiddenSeries.includes(i.series.id)"
              :disabled="!i.series.enabled"
              @change="setSeriesVisible(i.series.id, ($event.target as HTMLInputElement).checked)"
            />
            <span class="chip" :style="{ background: color(i.series) }" />
            <span class="grow" :class="{ dim: !i.series.enabled }">
              {{ i.series.name }}
              <span v-if="i.series.origin === 'discovered'" class="badge badge-info">Descubierta</span>
              <span v-else-if="i.series.origin === 'user'" class="badge badge-dim">Agregada</span>
              <span v-if="!effectiveEnabled(i.series)" class="badge badge-dim">Desactivada</span>
            </span>
          </label>
          <div v-if="canWriteRepo" class="row series-actions">
            <template v-if="i.series.origin === 'discovered'">
              <button type="button" class="btn btn-small" :disabled="busy" @click="pin(i.series)">Fijar</button>
              <button type="button" class="btn btn-small" :disabled="busy" @click="hide(i.series)">Ocultar</button>
            </template>
            <template v-else-if="isAdded(i.series.id)">
              <button type="button" class="btn btn-small btn-danger" :disabled="busy" @click="removeAdded(i.series)">Quitar</button>
            </template>
            <template v-else-if="isPinned(i.series.id)">
              <button type="button" class="btn btn-small" :disabled="busy" @click="hide(i.series)">Ocultar</button>
            </template>
            <button
              v-if="!isAdded(i.series.id)"
              type="button"
              class="btn btn-small"
              :disabled="busy"
              @click="toggleDisabled(i.series)"
            >
              {{ effectiveEnabled(i.series) ? 'Desactivar' : 'Activar' }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="canWriteRepo && userConfig?.hidden.length" class="settings-group">
        <div class="section-title">Descubiertas ocultas</div>
        <div v-for="id in userConfig.hidden" :key="id" class="row settings-series">
          <span class="grow">{{ id }}</span>
          <button type="button" class="btn btn-small" :disabled="busy" @click="unhide(id)">Volver a mostrar</button>
        </div>
      </div>

      <form v-if="canWriteRepo" class="add-series" @submit.prevent="addCategory">
        <div class="section-title">Agregar categoría</div>
        <label class="field">
          <span>Nombre</span>
          <input v-model="newName" class="input" type="text" required placeholder="p. ej. Fórmula Nacional" />
        </label>
        <label class="field">
          <span>Sitio oficial (opcional)</span>
          <input v-model="newUrl" class="input" type="url" inputmode="url" placeholder="https://…" />
        </label>
        <label class="field">
          <span>Grupo</span>
          <select v-model="newGroup" class="input">
            <option v-for="(label, key) in groupLabels" :key="key" :value="key">{{ label }}</option>
          </select>
        </label>
        <p class="small dim">Si no ponés la URL, el descubrimiento automático busca el sitio oficial.</p>
        <button type="submit" class="btn btn-primary btn-block" :disabled="busy || !newName.trim()">Agregar</button>
      </form>
    </section>

    <!-- Suscripción -->
    <section class="card">
      <h2>Suscribirse al calendario</h2>
      <p class="small">
        Con la suscripción, tu calendario se actualiza solo con la grilla (próximos 60 días, todas las categorías activas).
      </p>
      <div class="copy-row">
        <code>{{ webcal }}</code>
        <button type="button" class="btn btn-small" @click="copy(webcal)">{{ copied === webcal ? 'Copiado' : 'Copiar' }}</button>
      </div>
      <a :href="webcal" class="btn btn-block">Abrir en la app de Calendario</a>
      <details class="small">
        <summary>Cómo agregarlo en Google Calendar</summary>
        <ol>
          <li>Desde una computadora, abrí calendar.google.com.</li>
          <li>En "Otros calendarios" tocá <strong>+</strong> → <strong>Desde URL</strong>.</li>
          <li>
            Pegá esta dirección:
            <code>{{ httpsFeed }}</code>
            <button type="button" class="btn btn-small" @click="copy(httpsFeed)">
              {{ copied === httpsFeed ? 'Copiado' : 'Copiar' }}
            </button>
          </li>
          <li>Google lo refresca cada varias horas (no al instante).</li>
        </ol>
      </details>
      <details class="small">
        <summary>Cómo agregarlo en el iPhone</summary>
        <ol>
          <li>Tocá "Abrir en la app de Calendario" y confirmá <strong>Suscribirse</strong>.</li>
          <li>
            O bien: Ajustes → Calendario → Cuentas → Agregar cuenta → Otra → <strong>Agregar calendario suscrito</strong>
            y pegá la dirección copiada.
          </li>
        </ol>
      </details>
    </section>

    <!-- Google Calendar -->
    <section class="card">
      <h2>Google Calendar</h2>
      <p class="small dim">
        Para "Cargar en Google Calendar" hace falta un Client ID OAuth (tipo "Aplicación web") de Google Cloud con la
        Calendar API habilitada y este sitio como origen autorizado. El calendario "Deporte Motor" tiene que existir.
      </p>
      <label class="field">
        <span>Client ID de Google</span>
        <input
          v-model.trim="googleClientId"
          class="input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          :placeholder="envClientId || '1234-abc.apps.googleusercontent.com'"
        />
      </label>
      <button type="button" class="btn btn-small" @click="logoutGoogle">Cerrar sesión de Google en la app</button>
      <p v-if="googleMsg" class="small dim">{{ googleMsg }}</p>
    </section>

    <!-- GitHub -->
    <section class="card">
      <h2>GitHub (solo para el dueño)</h2>
      <p class="small dim">
        Solo lo necesita quien administra el repo: sirve para cambiar la lista compartida de categorías y para "Forzar
        actualización". El token se guarda <strong>solo en este dispositivo</strong> y se usa únicamente contra
        api.github.com.
      </p>
      <label class="field">
        <span>Repositorio (owner/repo)</span>
        <input
          v-model.trim="githubRepo"
          class="input"
          type="text"
          autocomplete="off"
          spellcheck="false"
          autocapitalize="off"
          :placeholder="envRepo || 'owner/repo'"
        />
      </label>
      <label class="field">
        <span>Token de acceso (fine-grained)</span>
        <input
          v-model.trim="githubToken"
          class="input"
          type="password"
          autocomplete="off"
          spellcheck="false"
          placeholder="github_pat_…"
        />
      </label>
      <details class="small">
        <summary>Cómo crear el token</summary>
        <ol>
          <li>GitHub → Settings → Developer settings → Personal access tokens → <strong>Fine-grained tokens</strong>.</li>
          <li>Repository access: <strong>Only select repositories</strong> → este repo.</li>
          <li>Permisos: <strong>Contents: Read and write</strong> y <strong>Actions: Read and write</strong>.</li>
          <li>Ponele vencimiento y pegalo acá.</li>
        </ol>
      </details>
      <p v-if="githubToken && !repoRef" class="small" style="color: var(--error)">Falta el repositorio en formato owner/repo.</p>
      <button v-if="githubToken" type="button" class="btn btn-small btn-danger" @click="githubToken = ''">Borrar token</button>
    </section>

    <!-- Instalación -->
    <section class="card">
      <h2>Instalar la app</h2>
      <button v-if="canInstall" type="button" class="btn btn-primary btn-block" @click="install">Instalar ahora</button>
      <p class="small"><strong>Android (Chrome):</strong> menú ⋮ → <strong>Instalar app</strong> (o "Agregar a la pantalla principal").</p>
      <p class="small"><strong>iPhone (Safari):</strong> botón Compartir → <strong>Agregar a inicio</strong>.</p>
      <p class="small dim">Instalada funciona sin conexión con la última copia de los datos.</p>
    </section>
  </div>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import { mapActions, mapState, mapWritableState } from 'pinia';
import { GROUP_LABELS, type Series, type SeriesGroup, type UserSeriesConfig } from '@dm/shared';
import AppIcon from '../components/AppIcon.vue';
import { useScheduleStore } from '../stores/schedule.ts';
import { useSettingsStore } from '../stores/settings.ts';
import { useResultsStore } from '../stores/results.ts';
import { groupSeries, seriesColor, seriesSort } from '../lib/grid.ts';
import { ZONE_OPTIONS, deviceZone, timeAgo, zoneLabel } from '../lib/format.ts';
import { absoluteDataUrl, webcalUrl } from '../lib/data.ts';
import { copyText } from '../lib/download.ts';
import { installState, promptInstall } from '../lib/install.ts';
import { forgetAccessToken } from '../gcal/gis.ts';
import { GitHubClient } from '../github/client.ts';
import {
  WORKFLOW_FILE,
  WORKFLOW_REF,
  addSeries,
  commitUserConfig,
  hideDiscovered,
  pinDiscovered,
  readUserConfig,
  removeAddedSeries,
  setSeriesDisabled,
  unhideDiscovered,
  type UserConfigChange,
} from '../github/user-config.ts';

const FEED = 'feeds/deporte-motor.ics';

export default defineComponent({
  name: 'SettingsView',
  components: { AppIcon },
  data() {
    return {
      busy: false,
      updateMsg: '',
      updateErr: false,
      repoMsg: '',
      repoErr: false,
      googleMsg: '',
      copied: '',
      userConfig: null as UserSeriesConfig | null,
      newName: '',
      newUrl: '',
      newGroup: 'otros' as SeriesGroup,
      groupLabels: GROUP_LABELS,
      envClientId: import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '',
      envRepo: import.meta.env.VITE_GITHUB_REPO ?? '',
    };
  },
  computed: {
    ...mapState(useScheduleStore, ['schedule', 'generatedAt', 'fetchedAt', 'loading', 'now']),
    ...mapState(useSettingsStore, ['hiddenSeries', 'canWriteRepo', 'repoRef']),
    ...mapWritableState(useSettingsStore, ['timeZone', 'googleClientId', 'githubRepo', 'githubToken']),
    zoneOptions(): Array<{ value: string; label: string }> {
      const list = [...ZONE_OPTIONS];
      for (const z of [deviceZone(), this.timeZone]) {
        if (!list.some((o) => o.value === z)) list.push({ value: z, label: `${zoneLabel(z)} (${z})` });
      }
      return list;
    },
    seriesGroups() {
      const list = [...(this.schedule?.series ?? [])].sort(seriesSort);
      return groupSeries(list.map((series) => ({ series })));
    },
    webcal(): string {
      return webcalUrl(FEED);
    },
    canInstall(): boolean {
      return installState.event !== null;
    },
    httpsFeed(): string {
      return absoluteDataUrl(FEED);
    },
  },
  watch: {
    canWriteRepo: {
      immediate: true,
      handler(v: boolean) {
        if (v) void this.loadUserConfig();
        else this.userConfig = null;
      },
    },
  },
  methods: {
    ...mapActions(useScheduleStore, ['load']),
    ...mapActions(useSettingsStore, ['setSeriesVisible']),
    ...mapActions(useResultsStore, { clearResults: 'clear' }),
    color(s: Series): string {
      return seriesColor(s);
    },
    ago(iso: string | null): string {
      return timeAgo(iso, this.now);
    },
    async refresh() {
      this.clearResults();
      await this.load({ force: true });
    },
    client(): GitHubClient {
      const ref = this.repoRef;
      if (!ref) throw new Error('Falta el repositorio (owner/repo).');
      return new GitHubClient({ ...ref, token: this.githubToken });
    },
    async forceUpdate() {
      this.busy = true;
      this.updateMsg = '';
      this.updateErr = false;
      try {
        await this.client().dispatchWorkflow(WORKFLOW_FILE, WORKFLOW_REF);
        this.updateMsg =
          'Listo: se lanzó la actualización. Tarda unos minutos; después tocá "Actualizar ahora" para ver los datos nuevos.';
      } catch (e) {
        this.updateErr = true;
        this.updateMsg = (e as Error).message;
      } finally {
        this.busy = false;
      }
    },
    async loadUserConfig() {
      try {
        this.userConfig = (await readUserConfig(this.client())).config;
      } catch (e) {
        this.repoErr = true;
        this.repoMsg = `No se pudo leer la configuración del repo: ${(e as Error).message}`;
      }
    },
    async repoChange(change: (c: UserSeriesConfig) => UserConfigChange, okMsg: string): Promise<boolean> {
      this.busy = true;
      this.repoMsg = '';
      this.repoErr = false;
      try {
        const r = await commitUserConfig(this.client(), change);
        this.userConfig = r.config;
        this.repoMsg = r.workflowTriggered
          ? `${okMsg} Se lanzó la actualización: el cambio se ve en unos minutos.`
          : `${okMsg} Pero no se pudo lanzar la actualización (${r.workflowError}). Se aplicará en la próxima automática.`;
        return true;
      } catch (e) {
        this.repoErr = true;
        this.repoMsg = (e as Error).message;
        return false;
      } finally {
        this.busy = false;
      }
    },
    isAdded(id: string): boolean {
      return this.userConfig?.added.some((a) => a.id === id) ?? false;
    },
    isPinned(id: string): boolean {
      return this.userConfig?.pinned.includes(id) ?? false;
    },
    effectiveEnabled(s: Series): boolean {
      if (this.userConfig) return !this.userConfig.disabled.includes(s.id);
      return s.enabled;
    },
    toggleDisabled(s: Series) {
      const disable = this.effectiveEnabled(s);
      return this.repoChange(
        (c) => setSeriesDisabled(c, s.id, disable, s.name),
        disable ? `"${s.name}" desactivada.` : `"${s.name}" reactivada.`,
      );
    },
    pin(s: Series) {
      return this.repoChange((c) => pinDiscovered(c, s.id, s.name), `"${s.name}" quedó fijada como categoría permanente.`);
    },
    hide(s: Series) {
      if (!window.confirm(`¿Ocultar "${s.name}"? No va a volver a aparecer en la grilla de nadie.`)) return;
      return this.repoChange((c) => hideDiscovered(c, s.id, s.name), `"${s.name}" oculta.`);
    },
    unhide(id: string) {
      return this.repoChange((c) => unhideDiscovered(c, id), `"${id}" vuelve a mostrarse.`);
    },
    removeAdded(s: Series) {
      if (!window.confirm(`¿Quitar "${s.name}" de la lista compartida?`)) return;
      return this.repoChange((c) => removeAddedSeries(c, s.id, s.name), `"${s.name}" quitada.`);
    },
    async addCategory() {
      const existing = (this.schedule?.series ?? []).map((s) => s.id);
      const input = { name: this.newName, url: this.newUrl, group: this.newGroup };
      // Valida antes de pedir nada a GitHub para mostrar el error enseguida.
      try {
        addSeries(this.userConfig ?? { added: [], disabled: [], pinned: [], hidden: [] }, input, existing);
      } catch (e) {
        this.repoErr = true;
        this.repoMsg = (e as Error).message;
        return;
      }
      const ok = await this.repoChange((c) => addSeries(c, input, existing), `"${this.newName.trim()}" agregada.`);
      if (ok) {
        this.newName = '';
        this.newUrl = '';
      }
    },
    async copy(text: string) {
      if (await copyText(text)) {
        this.copied = text;
        setTimeout(() => {
          if (this.copied === text) this.copied = '';
        }, 2000);
      }
    },
    logoutGoogle() {
      forgetAccessToken();
      this.googleMsg = 'Listo. La próxima carga te va a pedir permiso de nuevo.';
    },
    install() {
      return promptInstall();
    },
  },
});
</script>

<style>
.settings-view .card h2 {
  margin-bottom: 0.4rem;
}

.settings-group .section-title {
  margin-top: 0.9rem;
}

.settings-series {
  border-bottom: 1px solid var(--border);
  padding: 0.1rem 0 0.35rem;
}

.series-actions {
  gap: 0.4rem;
  padding-left: 1.9rem;
  flex-wrap: wrap;
}

.add-series {
  margin-top: 1rem;
}

.copy-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0.5rem 0;
}

.copy-row code {
  flex: 1;
  min-width: 0;
}

details {
  margin-top: 0.6rem;
}

details summary {
  min-height: var(--tap);
  display: flex;
  align-items: center;
  cursor: pointer;
  font-weight: 600;
}

details ol {
  padding-left: 1.2rem;
  margin: 0.25rem 0;
}

details li {
  margin: 0.3rem 0;
}
</style>
