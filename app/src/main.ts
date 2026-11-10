import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { createAppRouter } from './router.ts';
import { persistStore } from './lib/storage.ts';
import { listenInstallPrompt } from './lib/install.ts';
import { useSettingsStore } from './stores/settings.ts';
import { useScheduleStore } from './stores/schedule.ts';
import './styles.css';

const pinia = createPinia();
const app = createApp(App);
app.use(pinia);
app.use(createAppRouter());

persistStore(useSettingsStore(pinia), ['timeZone', 'hiddenSeries', 'googleClientId', 'githubRepo', 'githubToken']);
persistStore(useScheduleStore(pinia), ['preset', 'includeThursday', 'customFrom', 'customTo', 'excludedIds']);

listenInstallPrompt();
app.mount('#app');

// Service worker (PWA). Se actualiza solo cuando hay una versión nueva publicada.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }));
}
