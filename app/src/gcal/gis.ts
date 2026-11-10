/** Inicio de sesión con Google Identity Services (modelo de token, solo en el navegador). */

export const GCAL_SCOPES = [
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

const GIS_SRC = 'https://accounts.google.com/gsi/client';

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

interface TokenClient {
  requestAccessToken(overrides?: { prompt?: string }): void;
}

interface GoogleOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (resp: TokenResponse) => void;
    error_callback?: (err: { type?: string; message?: string }) => void;
  }): TokenClient;
}

declare global {
  interface Window {
    google?: { accounts?: { oauth2?: GoogleOAuth2 } };
  }
}

let loader: Promise<GoogleOAuth2> | null = null;

function loadGis(): Promise<GoogleOAuth2> {
  if (window.google?.accounts?.oauth2) return Promise.resolve(window.google.accounts.oauth2);
  if (loader) return loader;
  loader = new Promise<GoogleOAuth2>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const oauth2 = window.google?.accounts?.oauth2;
      if (oauth2) resolve(oauth2);
      else reject(new Error('No se pudo iniciar el servicio de Google.'));
    };
    script.onerror = () => {
      loader = null;
      reject(new Error('No se pudo cargar el inicio de sesión de Google. ¿Hay conexión?'));
    };
    document.head.appendChild(script);
  });
  return loader;
}

/** Precarga el script de Google para que la ventana de permisos se abra directo al tocar el botón. */
export function preloadGis(): void {
  loadGis().catch(() => {
    /* se reintenta al tocar el botón */
  });
}

let cached: { token: string; clientId: string; expiresAt: number } | null = null;

/** Pide un token de acceso (reutiliza el anterior mientras no venza). Debe llamarse desde un toque del usuario. */
export async function getAccessToken(clientId: string): Promise<string> {
  if (!clientId) {
    throw new Error('Falta el Client ID de Google. Cargalo en Ajustes → Google Calendar.');
  }
  if (cached && cached.clientId === clientId && cached.expiresAt > Date.now() + 60_000) return cached.token;
  const oauth2 = await loadGis();
  return new Promise<string>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: clientId,
      scope: GCAL_SCOPES,
      callback: (resp) => {
        if (resp.error || !resp.access_token) {
          reject(new Error(resp.error_description ?? 'Google no autorizó el acceso al calendario.'));
          return;
        }
        cached = {
          token: resp.access_token,
          clientId,
          expiresAt: Date.now() + (resp.expires_in ?? 3600) * 1000,
        };
        resolve(resp.access_token);
      },
      error_callback: (err) => {
        reject(
          new Error(
            err.type === 'popup_closed'
              ? 'Se cerró la ventana de Google antes de terminar.'
              : (err.message ?? 'No se pudo iniciar sesión con Google.'),
          ),
        );
      },
    });
    client.requestAccessToken({ prompt: cached ? '' : 'consent' });
  });
}

export function forgetAccessToken(): void {
  cached = null;
}
