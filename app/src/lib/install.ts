import { reactive } from 'vue';

export interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
}

/** Evento "beforeinstallprompt" de Chrome/Android, capturado al arrancar (llega antes de abrir Ajustes). */
export const installState = reactive({ event: null as BeforeInstallPromptEvent | null });

export function listenInstallPrompt(): void {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installState.event = e as BeforeInstallPromptEvent;
  });
  window.addEventListener('appinstalled', () => {
    installState.event = null;
  });
}

export async function promptInstall(): Promise<void> {
  const e = installState.event;
  if (!e) return;
  installState.event = null;
  await e.prompt();
}
