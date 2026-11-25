/// <reference types="vite/client" />

declare module '*.vue' {
  import type { DefineComponent } from 'vue';
  const component: DefineComponent<object, object, unknown>;
  export default component;
}

interface ImportMetaEnv {
  /** Ruta base de la app; por defecto relativa ("./"). Vite la expone como BASE_URL. */
  readonly VITE_BASE?: string;
  /** Dirección propia de los datos (p. ej. "https://data.gridagenda.com/"); vacío = data/ junto a la app. */
  readonly VITE_DATA_BASE?: string;
  /** Dirección principal de la app (p. ej. "https://gridagenda.com"): en cualquier otra se ofrece la mudanza. */
  readonly VITE_APP_ORIGIN?: string;
  /** Repositorio "owner/repo" por defecto para las acciones de GitHub. */
  readonly VITE_GITHUB_REPO?: string;
  /** Client ID OAuth de Google (tipo "Aplicación web") por defecto. */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
  /** URL del Cloudflare Worker (avisos push y proxy de tiempos en vivo). */
  readonly VITE_WORKER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
